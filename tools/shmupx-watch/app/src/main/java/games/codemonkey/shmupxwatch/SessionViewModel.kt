package games.codemonkey.shmupxwatch

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import games.codemonkey.shmupxwatch.bridge.AgentBridge
import games.codemonkey.shmupxwatch.bridge.AgentCommand
import games.codemonkey.shmupxwatch.bridge.AgentState
import games.codemonkey.shmupxwatch.bridge.ConnectionState
import games.codemonkey.shmupxwatch.bridge.QuickReply
import games.codemonkey.shmupxwatch.bridge.Utterance
import games.codemonkey.shmupxwatch.session.SessionService
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SessionViewModel(app: Application) : AndroidViewModel(app) {

    /**
     * The shared bridge — see [AppGraph]. The launcher half of the app uses the
     * same instance, so both halves agree about what the desktop is doing and
     * only one SSE stream is open.
     */
    private val bridge: AgentBridge = AppGraph.bridge

    val agents = bridge.agents
    val preview = bridge.preview
    val connection = bridge.connection

    /**
     * The ongoing activity's status line. Recomputed whenever agents or the
     * connection change so the watch face indicator stays honest.
     */
    private val sessionSummary = combine(bridge.agents, bridge.connection) { agents, conn ->
        val blocked = agents.count { it.state == AgentState.BLOCKED }
        val label = when {
            conn == ConnectionState.DISCONNECTED -> "offline"
            blocked > 0 -> "$blocked waiting"
            agents.any { it.state == AgentState.WORKING } -> "working"
            else -> "idle"
        }
        agents.size to label
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0 to "idle")

    init {
        bridge.start(viewModelScope)

        viewModelScope.launch {
            sessionSummary.collect { (count, label) ->
                if (sessionActive) {
                    SessionService.start(getApplication(), count, label)
                }
            }
        }
    }

    private var sessionActive = false

    /**
     * Start this when the user actually begins editing, not on app launch.
     * A permanently running ongoing activity is a permanently running
     * foreground service, and the battery cost is real.
     */
    fun startSession() {
        if (sessionActive) return
        sessionActive = true
        val (count, label) = sessionSummary.value
        SessionService.start(getApplication(), count, label)
    }

    fun stopSession() {
        if (!sessionActive) return
        sessionActive = false
        SessionService.stop(getApplication())
    }

    fun onDictated(text: String, agentId: String? = null) {
        // Dictation is the trigger for a session: if you're talking to it,
        // you don't want the watch face stealing the screen mid-thought.
        startSession()
        viewModelScope.launch {
            bridge.sendUtterance(Utterance(text = text, agentId = agentId))
        }
    }

    fun onQuickReply(agentId: String, reply: QuickReply) {
        viewModelScope.launch {
            bridge.sendCommand(agentId, AgentCommand(kind = reply.wire))
        }
    }

    override fun onCleared() {
        bridge.stop()
        stopSession()
        super.onCleared()
    }
}
