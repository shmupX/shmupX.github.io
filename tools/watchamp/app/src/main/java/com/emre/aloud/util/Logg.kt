package com.emre.aloud.util

import android.util.Log
import com.emre.aloud.BuildConfig

/**
 * Debug chatter is compiled out of release builds along with its string
 * concatenation. Warnings are not: a failure that only shows up on a real
 * Bluetooth headset, hours into a run, has to leave some trace behind. The
 * first report of playback dying mid-run had nothing to go on but a stale
 * error string in `dumpsys media_session`.
 */
object Logg {
    private const val TAG = "Aloud"

    fun d(message: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, message)
    }

    fun w(message: String) {
        Log.w(TAG, message)
    }
}
