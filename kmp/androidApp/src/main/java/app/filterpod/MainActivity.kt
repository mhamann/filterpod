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
        setContent { AppRoot() }
    }

    override fun onStart() {
        super.onStart()
        // Coming back hours later, the playback service the controller remembers may
        // long since have been stopped by the OS; reconcile before the user taps play.
        FilterPodApp.instance.controller.ensureSessionAlive()
    }
}
