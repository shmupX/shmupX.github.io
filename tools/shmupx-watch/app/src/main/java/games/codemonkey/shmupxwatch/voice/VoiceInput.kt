package games.codemonkey.shmupxwatch.voice

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext

/**
 * System dictation, which on Wear OS 7 runs on-device and needs no permission
 * of its own — the recognizer owns the mic, not you.
 *
 * Requires the `<queries>` entry for android.speech.RecognitionService in the
 * manifest. Without it [isDictationAvailable] returns false on Android 11+ even
 * when a recognizer is installed.
 */
object VoiceInput {

    fun isDictationAvailable(context: Context): Boolean {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        return intent.resolveActivity(context.packageManager) != null
    }

    fun intent(prompt: String): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Keeps recognition on the watch when the model supports it.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
}

/**
 * Returns a lambda that opens the dictation UI and hands the top transcript to
 * [onResult], or calls [onCancelled] when nothing usable came back.
 *
 * [onCancelled] is not decoration. A caller that only hears about success has
 * no way to tell "still listening" from "the user backed out", and a screen
 * that waits forever for a result that is never coming will re-open the
 * recogniser every time it recomposes — which on a watch means every time the
 * screen dims and wakes.
 */
@Composable
fun rememberDictation(
    prompt: String,
    onCancelled: () -> Unit = {},
    onResult: (String) -> Unit,
): () -> Unit {
    val context = LocalContext.current
    // Held in state so the launcher callback always sees the current lambdas
    // without the launcher itself being recreated on every recomposition.
    val currentResult by rememberUpdatedState(onResult)
    val currentCancelled by rememberUpdatedState(onCancelled)

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val heard = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
            ?.takeIf { it.isNotEmpty() }

        if (result.resultCode == Activity.RESULT_OK && heard != null) {
            currentResult(heard)
        } else {
            currentCancelled()
        }
    }

    return remember(launcher, prompt, context) {
        { launcher.launch(VoiceInput.intent(prompt)) }
    }
}
