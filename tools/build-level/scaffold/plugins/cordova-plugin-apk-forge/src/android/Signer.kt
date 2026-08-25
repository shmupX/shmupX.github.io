package com.easierbycode.apkforge

import android.content.Context
import com.android.apksig.ApkSigner
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Date

/**
 * Wraps com.android.apksig to produce v1 + v2 signed APKs. The signing key
 * is generated lazily on first call and persisted to app-private storage so
 * subsequent forges (and re-forges of the same level) use a stable identity.
 */
object Signer {

    private const val KEY_ALIAS = "forge"
    private const val KS_PASSWORD = "apkforge"
    private const val KEY_PASSWORD = "apkforge"
    private const val KEY_FILENAME = "apkforge/keystore.p12"

    fun sign(ctx: Context, inApk: File, outApk: File) {
        val (privateKey, cert) = loadOrCreateKey(ctx)
        val signerConfig = ApkSigner.SignerConfig.Builder(
            "forge", privateKey, listOf(cert)
        ).build()

        val builder = ApkSigner.Builder(listOf(signerConfig))
            .setInputApk(inApk)
            .setOutputApk(outApk)
            .setV1SigningEnabled(true)
            .setV2SigningEnabled(true)
            .setV3SigningEnabled(false)
            .setMinSdkVersion(21)
        builder.build().sign()
    }

    private fun loadOrCreateKey(ctx: Context): Pair<PrivateKey, X509Certificate> {
        val ksFile = File(ctx.filesDir, KEY_FILENAME)
        val ks = KeyStore.getInstance("PKCS12")
        if (ksFile.exists()) {
            try {
                FileInputStream(ksFile).use { ks.load(it, KS_PASSWORD.toCharArray()) }
                val key = ks.getKey(KEY_ALIAS, KEY_PASSWORD.toCharArray()) as PrivateKey
                val cert = ks.getCertificate(KEY_ALIAS) as X509Certificate
                return key to cert
            } catch (e: Exception) {
                ksFile.delete()
            }
        }

        val keyPair = generateKeyPair()
        val cert = selfSign(keyPair)
        ks.load(null, null)
        ks.setKeyEntry(KEY_ALIAS, keyPair.private,
            KEY_PASSWORD.toCharArray(), arrayOf(cert))
        ksFile.parentFile?.mkdirs()
        FileOutputStream(ksFile).use { ks.store(it, KS_PASSWORD.toCharArray()) }
        return keyPair.private to cert
    }

    private fun generateKeyPair(): KeyPair {
        val gen = KeyPairGenerator.getInstance("RSA")
        gen.initialize(2048, SecureRandom())
        return gen.generateKeyPair()
    }

    private fun selfSign(keyPair: KeyPair): X509Certificate {
        val now = System.currentTimeMillis()
        val notBefore = Date(now - 24L * 60 * 60 * 1000)
        val notAfter = Date(now + 30L * 365 * 24 * 60 * 60 * 1000)
        val subject = X500Name("CN=APK Forge, OU=easierbycode, O=easierbycode, C=US")
        val serial = BigInteger.valueOf(now)

        val builder = JcaX509v3CertificateBuilder(
            subject, serial, notBefore, notAfter, subject, keyPair.public
        )
        val signer = JcaContentSignerBuilder("SHA256withRSA")
            .build(keyPair.private)
        val holder = builder.build(signer)
        return JcaX509CertificateConverter().getCertificate(holder)
    }
}
