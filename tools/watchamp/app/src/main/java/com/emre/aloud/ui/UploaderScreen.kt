package com.emre.aloud.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Text
import com.emre.aloud.R
import com.emre.aloud.upload.UploadServer
import com.emre.aloud.upload.UploadServerService

@Composable
fun UploaderScreen() {
    val context = LocalContext.current
    val running by UploadServerService.running.collectAsState()
    val pin by UploadServerService.pin.collectAsState()
    val ip = remember { UploadServer.watchIpv4() ?: "?" }

    /**
     * Android 17 blocks inbound local-network traffic unless this is granted,
     * but the server still binds to 8080 perfectly happily — so without this
     * check the screen advertises an address that nothing on the WiFi can
     * reach, and the failure looks like a broken app rather than a permission.
     */
    fun localNetworkAllowed(): Boolean =
        Build.VERSION.SDK_INT < 37 ||
            context.checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) ==
            PackageManager.PERMISSION_GRANTED

    var denied by remember { mutableStateOf(false) }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        // The result was previously discarded, so granting the permission did
        // nothing until the user happened to press Start a second time.
        // Re-reading the live state also covers "don't ask again".
        if (localNetworkAllowed()) {
            denied = false
            UploadServerService.start(context)
        } else {
            denied = true
        }
    }

    fun ensurePermissionsAndStart() {
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            if (Build.VERSION.SDK_INT >= 37) add(Manifest.permission.ACCESS_LOCAL_NETWORK)
        }.filter { context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isEmpty()) {
            denied = !localNetworkAllowed()
            if (!denied) UploadServerService.start(context)
        } else {
            permLauncher.launch(wanted.toTypedArray())
        }
    }

    // Covers a server started some other way (the debug hook) while the
    // permission is missing, not just a fresh denial.
    val unreachable = denied || (running && !localNetworkAllowed())

    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = when {
                unreachable -> stringResource(R.string.uploader_needs_local_network)
                running -> "http://$ip:${UploadServerService.PORT}"
                else -> stringResource(R.string.uploader_off)
            },
            textAlign = TextAlign.Center,
        )
        if (running && !unreachable) {
            Text(
                text = stringResource(R.string.uploader_pin, pin ?: "…"),
                textAlign = TextAlign.Center,
            )
        }
        Button(
            onClick = { if (running) UploadServerService.stop(context) else ensurePermissionsAndStart() },
            modifier = Modifier.padding(top = 8.dp),
        ) { Text(stringResource(if (running) R.string.action_stop else R.string.action_start)) }
    }
}
