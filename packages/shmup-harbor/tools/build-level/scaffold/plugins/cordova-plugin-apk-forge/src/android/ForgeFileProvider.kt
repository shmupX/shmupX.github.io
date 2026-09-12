package com.easierbycode.apkforge

import android.content.Context
import android.content.pm.ProviderInfo
import android.util.Log
import androidx.core.content.FileProvider

/**
 * FileProvider subclass that swallows attachInfo() failures so a misconfigured
 * provider can't crash the entire app at launch. The forge plugin uses this in
 * place of androidx.core.content.FileProvider so that even if @xml/apk_forge_paths
 * is missing or malformed, the game APK still boots and surfaces the error
 * via ForgeApplication's crash log instead of dying silently.
 *
 * The on-device APK builder won't work without a valid provider, but everything
 * else (the actual game) does.
 */
class ForgeFileProvider : FileProvider() {
    override fun attachInfo(context: Context, info: ProviderInfo) {
        try {
            super.attachInfo(context, info)
        } catch (t: Throwable) {
            Log.e(TAG, "attachInfo failed; forge installs will not work", t)
        }
    }

    companion object {
        private const val TAG = "ForgeFileProvider"
    }
}
