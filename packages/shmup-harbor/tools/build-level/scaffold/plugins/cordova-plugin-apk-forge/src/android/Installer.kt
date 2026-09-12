package com.easierbycode.apkforge

import android.app.Activity
import android.content.Intent
import android.net.Uri

object Installer {

    fun installApk(activity: Activity?, uri: Uri) {
        val act = activity ?: throw IllegalStateException("no activity")
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        act.startActivity(intent)
    }
}
