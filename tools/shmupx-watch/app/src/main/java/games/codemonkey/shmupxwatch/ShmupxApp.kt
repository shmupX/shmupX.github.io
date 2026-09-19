package games.codemonkey.shmupxwatch

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import games.codemonkey.shmupxwatch.ambient.AmbientState
import games.codemonkey.shmupxwatch.ambient.LocalAmbientState
import games.codemonkey.shmupxwatch.bridge.ControlCommand
import games.codemonkey.shmupxwatch.ui.LauncherApp
import games.codemonkey.shmupxwatch.ui.screens.AgentsScreen
import games.codemonkey.shmupxwatch.ui.screens.AmbientScreen
import games.codemonkey.shmupxwatch.ui.screens.PreviewScreen
import games.codemonkey.shmupxwatch.ui.theme.ShmupxTheme
import games.codemonkey.shmupxwatch.voice.rememberDictation

object Routes {
    /** The game launcher — the eight screens of the design. */
    const val LAUNCHER = "launcher"
    const val AGENTS = "agents"
    const val PREVIEW = "preview"
}

/**
 * Two apps sharing a wrist.
 *
 * The **launcher** is the start destination and what the watch is for most of
 * the time: browse the catalog, send a game to the desktop, drive it. The
 * **agent** screens are the original build of this app — dictate a change to a
 * sprite and watch the preview come back — and are still here, one swipe away,
 * because they talk to the same daemon over the same database.
 *
 * Only the launcher's own screens live inside one destination; its back is
 * handled there. The two halves are separate destinations so swipe-to-dismiss
 * does the obvious thing between them.
 */
@Composable
fun ShmupxApp(
    ambientState: AmbientState,
    viewModel: SessionViewModel = viewModel(),
) {
    CompositionLocalProvider(LocalAmbientState provides ambientState) {
        ShmupxTheme(ambientState = ambientState) {
            val agents by viewModel.agents.collectAsStateWithLifecycle()
            val preview by viewModel.preview.collectAsStateWithLifecycle()
            val connection by viewModel.connection.collectAsStateWithLifecycle()

            // Created ABOVE the ambient branch, and that placement is the whole
            // point. `rememberSwipeDismissableNavController` is a
            // `rememberSaveable`: created inside the Interactive arm it is
            // forgotten every time the watch dims, and waking builds a new
            // controller with new back stack entries — so the launcher's
            // ViewModel, which is scoped to an entry, is rebuilt with them. You
            // would launch a game, let the screen dim for fifteen seconds, raise
            // your wrist, and be back on the tile with the game still running
            // and no way to reach its controls. The old ViewModel is never
            // cleared either, so every dim leaks one, still collecting and still
            // driving the foreground service.
            val navController = rememberSwipeDismissableNavController()

            // "Cover the screen and the game pauses", decided here rather than
            // inside the launcher — the launcher is exactly what ambient
            // unmounts, so an effect in there could observe the screen dimming
            // only by being torn down, which is to say never. This composable
            // survives the swap, so it can.
            AmbientPause(isAmbient = ambientState.isAmbient)

            // In ambient the interactive tree is swapped out rather than
            // restyled: dimming a live UI in place leaks bright pixels from
            // components you forgot about, and keeps them animating. The nav
            // controller above outlives the swap, so nothing is lost by it.
            when (ambientState) {
                is AmbientState.Ambient -> AmbientScreen(ambient = ambientState, agents = agents)

                AmbientState.Interactive -> {
                    // No TimeText. `AppScaffold` draws the clock in a curved
                    // strip across the top, which is exactly where the design
                    // puts its own status line — on the device the two
                    // overprinted. The launcher is a full-bleed custom UI and
                    // carries its own header, so the system one is suppressed
                    // rather than fought with.
                    AppScaffold(timeText = {}) {
                        InteractiveNav(
                            navController = navController,
                            viewModel = viewModel,
                            agents = agents,
                            preview = preview,
                            connection = connection,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Pause a running game when the screen dims.
 *
 * The design says "cover the screen to stop it". A Pixel Watch has no proximity
 * sensor and palm-cover is already the system's own sleep gesture — but sleeping
 * is what raises ambient, so the intent survives even though the mechanism does
 * not. Pause rather than stop: the screen also dims because you stopped looking
 * at your wrist, and losing a run to that would be unforgivable.
 */
@Composable
private fun AmbientPause(isAmbient: Boolean) {
    val playing by AppGraph.bridge.playing.collectAsStateWithLifecycle()
    LaunchedEffect(isAmbient, playing.state) {
        if (isAmbient && playing.state == "playing") {
            AppGraph.bridge.sendControl(ControlCommand(action = "pause"))
        }
    }
}

@Composable
private fun InteractiveNav(
    navController: NavHostController,
    viewModel: SessionViewModel,
    agents: List<games.codemonkey.shmupxwatch.bridge.AgentSnapshot>,
    preview: games.codemonkey.shmupxwatch.bridge.PreviewFrame?,
    connection: games.codemonkey.shmupxwatch.bridge.ConnectionState,
) {
    val dictate = rememberDictation(prompt = "Describe the change") { text ->
        viewModel.onDictated(text)
    }

    SwipeDismissableNavHost(
        navController = navController,
        startDestination = Routes.LAUNCHER,
    ) {
        composable(Routes.LAUNCHER) {
            val application = LocalContext.current.applicationContext as android.app.Application
            val launcher: LauncherViewModel = viewModel(
                factory = AppGraph.launcherFactory(application),
            )
            LauncherApp(
                viewModel = launcher,
                client = AppGraph.catalog,
                connection = connection,
                hostLabel = AppGraph.hostLabel,
                onOpenAgents = { navController.navigate(Routes.AGENTS) },
            )
        }

        composable(Routes.AGENTS) {
            AgentsScreen(
                agents = agents,
                connection = connection,
                onQuickReply = viewModel::onQuickReply,
                onDictate = dictate,
                onOpenPreview = { navController.navigate(Routes.PREVIEW) },
            )
        }

        composable(Routes.PREVIEW) {
            PreviewScreen(
                frame = preview,
                onDictate = dictate,
            )
        }
    }
}
