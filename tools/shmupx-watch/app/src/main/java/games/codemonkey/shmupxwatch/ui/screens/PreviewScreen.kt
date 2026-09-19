package games.codemonkey.shmupxwatch.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import games.codemonkey.shmupxwatch.bridge.PreviewFrame
import games.codemonkey.shmupxwatch.ui.SpriteCanvas
import games.codemonkey.shmupxwatch.ui.theme.LocalStateColors

/**
 * On a 456x456 panel the safe square inside the circle is roughly 160dp on a
 * side. A 16x16 sprite at 8x lands at 128dp, which leaves room for a label
 * without anything clipping at the corners.
 */
@Composable
fun PreviewScreen(
    frame: PreviewFrame?,
    onDictate: () -> Unit,
) {
    val stateColors = LocalStateColors.current

    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 18.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (frame == null) {
                Text(
                    text = "No object selected. Say what you want to build.",
                    textAlign = TextAlign.Center,
                    color = stateColors.detail,
                    style = MaterialTheme.typography.bodyMedium,
                )
            } else {
                Text(
                    text = frame.label,
                    color = stateColors.label,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleSmall,
                )

                Box(
                    modifier = Modifier
                        .fillMaxWidth(0.8f)
                        .aspectRatio(1f)
                        .padding(vertical = 6.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    SpriteCanvas(
                        frame = frame,
                        modifier = Modifier.fillMaxSize(),
                    )
                }

                val caption = frame.note
                    ?: "${frame.widthPx}x${frame.heightPx} · rev ${frame.revision}"
                Text(
                    text = caption,
                    textAlign = TextAlign.Center,
                    color = stateColors.detail,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Button(
                onClick = onDictate,
                label = { Text("Speak") },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 10.dp),
            )
        }
    }
}
