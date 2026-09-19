package games.codemonkey.shmupxwatch

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import games.codemonkey.shmupxwatch.bridge.AgentBridge
import games.codemonkey.shmupxwatch.bridge.BuilderCode
import games.codemonkey.shmupxwatch.bridge.FakeBridge
import games.codemonkey.shmupxwatch.bridge.FirebaseRestBridge
import games.codemonkey.shmupxwatch.catalog.CatalogClient

/**
 * The one bridge and the one catalog client, shared by both view models.
 *
 * This exists because there are now two: [SessionViewModel] owns the agent side
 * and [LauncherViewModel] owns the launcher, and both need to talk to the same
 * desktop. Letting each construct its own bridge would open two SSE streams
 * against the same database node and give the two halves of the app separate,
 * silently diverging opinions about whether a game is running.
 *
 * Deliberately not a DI framework. Two singletons and a factory is the whole
 * requirement, and Hilt on a watch is an annotation processor and a startup cost
 * for that.
 */
object AppGraph {

    /**
     * Live when a database is configured, canned when it is not.
     *
     * The fallback is what lets a fresh clone run on the emulator with nothing
     * set up — [FakeBridge] plays the desktop's part convincingly enough to walk
     * every screen, including LAUNCHING → NOW PLAYING.
     */
    val bridge: AgentBridge by lazy {
        if (BuildConfig.RTDB_URL.isNotBlank()) {
            FirebaseRestBridge(
                databaseUrl = BuildConfig.RTDB_URL,
                builderCode = BuildConfig.BUILDER_CODE.ifBlank { "default" },
                authToken = BuildConfig.RTDB_AUTH.takeIf { it.isNotBlank() },
            )
        } else {
            FakeBridge()
        }
    }

    val catalog: CatalogClient by lazy {
        CatalogClient(
            catalogOrigin = BuildConfig.CATALOG_ORIGIN,
            // The shelf lives on the same database the bridge uses when one is
            // configured, so a checkout pointed at a copy gets a matching shelf
            // rather than production's.
            rtdbUrl = BuildConfig.RTDB_URL.ifBlank { CatalogClient.DEFAULT_RTDB },
        )
    }

    /** Shown on the tile. The code, formatted for humans, or how to get one. */
    val hostLabel: String
        get() = when {
            BuildConfig.RTDB_URL.isBlank() -> "NO HOST"
            BuildConfig.BUILDER_CODE.isBlank() -> "NO CODE"
            !BuilderCode.isValid(BuildConfig.BUILDER_CODE) -> "BAD CODE"
            else -> BuilderCode.format(BuildConfig.BUILDER_CODE)
        }

    /** Builds [LauncherViewModel], which needs more than an Application. */
    fun launcherFactory(app: Application): ViewModelProvider.Factory =
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T =
                LauncherViewModel(app, bridge, catalog) as T
        }
}
