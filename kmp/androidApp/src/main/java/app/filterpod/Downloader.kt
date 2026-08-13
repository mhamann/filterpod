package app.filterpod

import android.content.Context
import app.filterpod.shared.data.Repo
import app.filterpod.shared.model.Download
import app.filterpod.shared.model.DownloadState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Episode downloads — the DownloaderPlugin's logic, minus the bridge; progress
 * lands in the repo (which the UI observes) instead of crossing to a WebView.
 *
 * Streams straight to app-private storage rather than buffering, since episodes run
 * to tens of megabytes. Partial files resume with a Range request where the server
 * supports it, so a dropped connection does not cost the whole download. Completion
 * is only recorded once the final rename lands — a record claiming "downloaded"
 * pointing at a .part file was an ExoPlayer "Source error" in a previous life.
 */
class Downloader(
    private val context: Context,
    private val repo: Repo,
    /** Fired once bytes are durably on disk — the prefilter's cue to build the map. */
    private val onDownloaded: (episodeId: String) -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = ConcurrentHashMap<String, Job>()

    fun fileKeyFor(episodeId: String): String = "audio/$episodeId"

    private fun targetFile(fileKey: String): File =
        File(context.filesDir, "filterpod/$fileKey").also { it.parentFile?.mkdirs() }

    /** Starts (or joins) a download; `auto` marks rule-driven fetches for wifi gating. */
    fun start(episodeId: String, url: String, auto: Boolean = false) {
        if (jobs.containsKey(episodeId)) return
        val fileKey = fileKeyFor(episodeId)

        jobs[episodeId] = scope.launch {
            record(episodeId, fileKey, 0, 0, DownloadState.DOWNLOADING, auto = auto)
            try {
                download(episodeId, fileKey, url, targetFile(fileKey), auto)
            } catch (error: Throwable) {
                // Throwable so an Error never escapes the coroutine and kills the process.
                record(episodeId, fileKey, 0, 0, DownloadState.FAILED, error.message, auto)
            } finally {
                jobs.remove(episodeId)
            }
        }
    }

    fun cancel(episodeId: String) {
        jobs.remove(episodeId)?.cancel()
        scope.launch { repo.patchDownload(episodeId) { it.copy(state = DownloadState.CANCELLED) } }
    }

    suspend fun delete(episodeId: String) {
        cancel(episodeId)
        val fileKey = fileKeyFor(episodeId)
        targetFile(fileKey).delete()
        File(targetFile(fileKey).path + ".part").delete()
        repo.patchDownload(episodeId) { it.copy(state = DownloadState.CANCELLED, fileKey = null) }
    }

    fun isDownloaded(episodeId: String): Boolean = targetFile(fileKeyFor(episodeId)).exists()

    private suspend fun download(
        episodeId: String,
        fileKey: String,
        url: String,
        target: File,
        auto: Boolean,
    ) {
        val partial = File(target.path + ".part")
        val existingBytes = if (partial.exists()) partial.length() else 0L

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "FilterPod/1.0")
            if (existingBytes > 0) setRequestProperty("Range", "bytes=$existingBytes-")
        }

        connection.connect()
        val resuming = connection.responseCode == HttpURLConnection.HTTP_PARTIAL
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException("HTTP ${connection.responseCode}")
        }

        val alreadyHave = if (resuming) existingBytes else 0L
        val total = connection.contentLengthLong.let { if (it > 0) it + alreadyHave else 0L }

        connection.inputStream.use { input ->
            FileOutputStream(partial, resuming).use { output ->
                val buffer = ByteArray(64 * 1024)
                var written = alreadyHave
                var lastRecorded = 0L

                while (scope.isActive) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    output.write(buffer, 0, read)
                    written += read

                    // Throttled: the repo write is cheap but not per-64KB cheap.
                    if (written - lastRecorded > 512 * 1024) {
                        lastRecorded = written
                        record(episodeId, fileKey, written, total, DownloadState.DOWNLOADING, auto = auto)
                    }
                }
            }
        }

        if (!scope.isActive) return

        partial.renameTo(target)
        val size = target.length()
        record(episodeId, fileKey, size, size, DownloadState.DOWNLOADED, auto = auto)
        onDownloaded(episodeId)
    }

    private suspend fun record(
        episodeId: String,
        fileKey: String,
        bytesDownloaded: Long,
        bytesTotal: Long,
        state: DownloadState,
        error: String? = null,
        auto: Boolean,
    ) {
        val existing = repo.getDownload(episodeId)
        repo.putDownload(
            Download(
                episodeId = episodeId,
                state = state,
                fileKey = fileKey,
                bytesDownloaded = bytesDownloaded,
                bytesTotal = bytesTotal,
                error = error,
                startedAt = existing?.startedAt ?: System.currentTimeMillis(),
                completedAt = if (state == DownloadState.DOWNLOADED) System.currentTimeMillis() else existing?.completedAt,
                auto = auto || (existing?.auto ?: false),
            ),
        )
    }
}
