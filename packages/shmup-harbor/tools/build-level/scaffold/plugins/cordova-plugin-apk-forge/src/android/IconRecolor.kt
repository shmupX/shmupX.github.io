package com.easierbycode.apkforge

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipFile

/**
 * Re-colors the launcher icons inside the shell APK so that different forged
 * apps look distinct on the launcher even though their icons share a source
 * image. Hue rotation is derived from the slug hash so the same level always
 * renders the same way.
 */
object IconRecolor {

    private val ICON_PATHS = listOf(
        "res/mipmap-ldpi-v4/ic_launcher.png",
        "res/mipmap-mdpi-v4/ic_launcher.png",
        "res/mipmap-hdpi-v4/ic_launcher.png",
        "res/mipmap-xhdpi-v4/ic_launcher.png",
        "res/mipmap-xxhdpi-v4/ic_launcher.png",
        "res/mipmap-xxxhdpi-v4/ic_launcher.png",
        "res/mipmap-ldpi/ic_launcher.png",
        "res/mipmap-mdpi/ic_launcher.png",
        "res/mipmap-hdpi/ic_launcher.png",
        "res/mipmap-xhdpi/ic_launcher.png",
        "res/mipmap-xxhdpi/ic_launcher.png",
        "res/mipmap-xxxhdpi/ic_launcher.png"
    )

    fun recolorAll(apk: File, slug: String, iconBase64Override: String) {
        val present = listEntries(apk).filter { ICON_PATHS.contains(it) }
        if (present.isEmpty()) return

        if (iconBase64Override.isNotEmpty()) {
            val bytes = Base64.decode(iconBase64Override, Base64.DEFAULT)
            val rw = ZipRewriter(apk)
            for (path in present) {
                rw.removeEntry(path)
                rw.addFile(path, bytes)
            }
            rw.finish()
            return
        }

        val hue = (Math.abs(slug.hashCode()) % 360).toFloat()
        val rw = ZipRewriter(apk)
        for (path in present) {
            val original = ZipRewriter.readEntry(apk, path) ?: continue
            val recolored = applyHueShift(original, hue) ?: continue
            rw.removeEntry(path)
            rw.addFile(path, recolored)
        }
        rw.finish()
    }

    private fun listEntries(apk: File): List<String> {
        val out = ArrayList<String>()
        ZipFile(apk).use { z ->
            val es = z.entries()
            while (es.hasMoreElements()) out.add(es.nextElement().name)
        }
        return out
    }

    private fun applyHueShift(pngBytes: ByteArray, degrees: Float): ByteArray? {
        val src = android.graphics.BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.size) ?: return null
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        val matrix = ColorMatrix()
        applyHueToMatrix(matrix, degrees)
        paint.colorFilter = ColorMatrixColorFilter(matrix)
        canvas.drawBitmap(src, 0f, 0f, paint)
        val baos = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.PNG, 100, baos)
        src.recycle()
        out.recycle()
        return baos.toByteArray()
    }

    private fun applyHueToMatrix(matrix: ColorMatrix, degrees: Float) {
        val cos = Math.cos(Math.toRadians(degrees.toDouble())).toFloat()
        val sin = Math.sin(Math.toRadians(degrees.toDouble())).toFloat()
        val lumR = 0.213f
        val lumG = 0.715f
        val lumB = 0.072f
        val mat = floatArrayOf(
            lumR + cos * (1 - lumR) + sin * (-lumR),     lumG + cos * (-lumG) + sin * (-lumG),     lumB + cos * (-lumB) + sin * (1 - lumB), 0f, 0f,
            lumR + cos * (-lumR) + sin * (0.143f),       lumG + cos * (1 - lumG) + sin * (0.140f), lumB + cos * (-lumB) + sin * (-0.283f),  0f, 0f,
            lumR + cos * (-lumR) + sin * (-(1 - lumR)),  lumG + cos * (-lumG) + sin * (lumG),      lumB + cos * (1 - lumB) + sin * (lumB),  0f, 0f,
            0f, 0f, 0f, 1f, 0f
        )
        matrix.set(mat)
    }
}
