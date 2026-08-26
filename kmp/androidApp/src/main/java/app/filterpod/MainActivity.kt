package app.filterpod

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.filterpod.ui.AppRoot

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        consumeNotificationIntent(intent)
        setContent { AppRoot() }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        consumeNotificationIntent(intent)
    }

    /** A tapped new-episode notification is a request to see that show. */
    private fun consumeNotificationIntent(intent: android.content.Intent?) {
        val podcastId = intent?.getStringExtra(NewEpisodeNotifier.EXTRA_PODCAST_ID) ?: return
        FilterPodApp.instance.pendingPodcastId.value = podcastId
        intent.removeExtra(NewEpisodeNotifier.EXTRA_PODCAST_ID)
    }

    override fun onStart() {
        super.onStart()
        // Coming back hours later, the playback service the controller remembers may
        // long since have been stopped by the OS; reconcile before the user taps play.
        FilterPodApp.instance.controller.ensureSessionAlive()
    }
}
