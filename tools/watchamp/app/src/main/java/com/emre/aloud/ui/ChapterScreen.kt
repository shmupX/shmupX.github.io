package com.emre.aloud.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import com.emre.aloud.R
import com.emre.aloud.playback.PlaybackState
import com.emre.aloud.playback.PlaybackUi
import com.emre.aloud.playback.chapterIndexAt

@Composable
fun ChapterScreen(ui: PlaybackUi) {
    val chapters by PlaybackState.chapters.collectAsState()
    val positionMs by PlaybackState.positionMs.collectAsState()
    val current = chapters.chapterIndexAt(positionMs)
    val listState = rememberTransformingLazyColumnState()

    if (chapters.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.chapters_empty))
        }
        return
    }

    // R31: land on (and keep loosely following) the current chapter.
    LaunchedEffect(current) {
        if (current >= 0) listState.requestScrollToItem((current + 1).coerceAtMost(chapters.size))
    }
    val rotaryBehavior = RotaryScrollableDefaults.behavior(listState)

    Box(Modifier.fillMaxSize()) {
        TimeText(Modifier.align(Alignment.TopCenter))
        TransformingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(top = 32.dp, bottom = 24.dp),
            rotaryScrollableBehavior = rotaryBehavior,
        ) {
            item { ListHeader { Text(stringResource(R.string.chapters_header)) } }
            items(count = chapters.size, key = { it }) { i ->
                Text(
                    text = "${i + 1}. ${chapters[i].title}",
                    color = if (i == current) Color.Cyan else Color.Unspecified,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { ui.skipToChapter(i) }
                        .padding(vertical = 8.dp, horizontal = 16.dp),
                    maxLines = 2,
                )
            }
        }
    }
}
