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
class FilterPodApp : Application(), coil3.SingletonImageLoader.Factory {

    /**
     * Explicit Coil configuration, with a real User-Agent on every image request.
     *
     * Some podcast CDNs blocklist the default `okhttp/x` UA outright — Buzzsprout
     * answers it with a plain 403 (verified: same URL, curl 200, okhttp-UA 403) —
     * which rendered every Buzzsprout show artless with not one log line to say why.
     * The debug logger stays on in debug builds for exactly that class of silence.
     */
    override fun newImageLoader(context: coil3.PlatformContext): coil3.ImageLoader {
        val client = okhttp3.OkHttpClient.Builder()
            .addInterceptor { chain ->
                chain.proceed(
                    chain.request().newBuilder()
                        .header("User-Agent", "FilterPod/1.0 (Android)")
                        .build(),
                )
            }
            .build()
        return coil3.ImageLoader.Builder(context)
            .components {
                add(coil3.network.okhttp.OkHttpNetworkFetcherFactory(callFactory = { client }))
            }
            .apply { if (BuildConfig.DEBUG) logger(coil3.util.DebugLogger()) }
            .build()
    }

    lateinit var repo: Repo
        private set
    lateinit var http: Http
        private set
    lateinit var controller: PlaybackController
        private set
    lateinit var downloader: Downloader
        private set
    lateinit var prefilter: Prefilter
        private set
    lateinit var refresher: app.filterpod.shared.feeds.FeedRefresher
        private set
    lateinit var subscriptions: app.filterpod.shared.feeds.SubscriptionService
        private set
    lateinit var notifier: NewEpisodeNotifier
        private set

    /**
     * Show to open because a notification was tapped; the UI consumes and clears it.
     */
    val pendingPodcastId = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onCreate() {
        super.onCreate()
        instance = this

        repo = Repo(createDatabase(DriverFactory(this)), Dispatchers.IO)
        http = AndroidHttp()
        prefilter = Prefilter(this, repo)
        controller = PlaybackController(
            this, repo, TranscriptSeeding(http),
            onLiveSessionStarting = { prefilter.cancelActive() },
        )
        downloader = Downloader(this, repo, onDownloaded = { prefilter.prefilterEpisode(it) })
        notifier = NewEpisodeNotifier(this)
        refresher = app.filterpod.shared.feeds.FeedRefresher(
            http, repo, app.filterpod.shared.feeds.XmlFeedReader(),
        ) { System.currentTimeMillis() }
        subscriptions = app.filterpod.shared.feeds.SubscriptionService(
            repo = repo,
            refresher = refresher,
            downloads = { episodeId, auto ->
                repo.getEpisode(episodeId)?.let { downloader.start(episodeId, it.audioUrl, auto) }
            },
            downloadDeleter = { episodeId -> downloader.delete(episodeId) },
            now = { System.currentTimeMillis() },
            newEpisodes = { subscription, episodes ->
                val show = repo.getPodcast(subscription.podcastId)?.title ?: "New episode"
                notifier.notifyNewEpisodes(subscription, episodes, show)
            },
        )

        // The UI's refresh seam, pointed at the real feed layer (the UI was built
        // against a stub while the feeds port was still in flight).
        app.filterpod.ui.FeedRefresh.delegate = { _, _, podcast ->
            refresher.fetchFeed(podcast.feedUrl)
        }

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

            // Background startup work, ordered cheapest-first: refresh feeds (new
            // episodes apply auto-queue/auto-download rules), then sweep the
            // downloaded backlog for missing filter maps.
            runCatching { subscriptions.refreshAndAutoDownload() }
            prefilter.prefilterDownloadedBacklog()
        }
    }

    companion object {
        lateinit var instance: FilterPodApp
            private set
    }
}
