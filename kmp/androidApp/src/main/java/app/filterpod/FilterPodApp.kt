package app.filterpod

import android.app.Application
import app.filterpod.shared.data.BackupImporter
import app.filterpod.shared.data.Repo
import app.filterpod.shared.db.DriverFactory
import app.filterpod.shared.db.createDatabase
import app.filterpod.shared.net.Http
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

/**
 * Application-scoped object graph. Deliberately hand-wired — the app has one graph,
 * assembled once, and a DI framework would be more code than the graph itself.
 */
class FilterPodApp : Application() {

    lateinit var repo: Repo
        private set
    lateinit var http: Http
        private set
    lateinit var controller: PlaybackController
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        instance = this

        repo = Repo(createDatabase(DriverFactory(this)), Dispatchers.IO)
        http = AndroidHttp()
        controller = PlaybackController(this, repo, TranscriptSeeding(http))

        appScope.launch {
            repo.initialize()

            // The cutover: same applicationId as the Capacitor app, so its continuous
            // full-state backup is simply present in our files dir on first launch
            // after the upgrade. Runs once, stamps, and never again.
            val backupFile = File(filesDir, BackupImporter.BACKUP_RELATIVE_PATH)
            val imported = BackupImporter(repo).importAtFirstLaunch(
                contents = backupFile.takeIf { it.exists() }?.readText(),
                now = System.currentTimeMillis(),
            )
            if (imported != null) {
                android.util.Log.i(
                    "FilterPod",
                    "imported Capacitor state: ${imported.subscriptions} subscription(s), " +
                        "${imported.progress} progress row(s), ${imported.queue} queued",
                )
            }

            controller.start()
        }
    }

    companion object {
        lateinit var instance: FilterPodApp
            private set
    }
}
