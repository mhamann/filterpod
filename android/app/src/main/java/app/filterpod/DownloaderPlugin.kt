package app.filterpod

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Episode downloads.
 *
 * Streams straight to app-private storage rather than buffering, since episodes run to
 * tens of megabytes. Partial files are resumed with a Range request where the server
 * supports it, so a dropped connection does not cost the whole download.
 */
@CapacitorPlugin(name = "Downloader")
class DownloaderPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = ConcurrentHashMap<String, Job>()

    private fun targetFile(fileKey: String): File {
        val file = File(context.filesDir, "filterpod/$fileKey")
        file.parentFile?.mkdirs()
        return file
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val episodeId = call.getString("episodeId")
        val url = call.getString("url")
        val fileKey = call.getString("fileKey")
        if (episodeId == null || url == null || fileKey == null) {
            call.reject("episodeId, url and fileKey are required")
            return
        }
        if (jobs.containsKey(episodeId)) {
            call.resolve()
            return
        }

        jobs[episodeId] = scope.launch {
            try {
                download(episodeId, url, targetFile(fileKey))
            } catch (error: Throwable) {
                // Throwable so an Error never escapes the coroutine and kills the process.
                emit(episodeId, 0, 0, "failed", error.message ?: "download failed")
            } finally {
                jobs.remove(episodeId)
            }
        }
        call.resolve()
    }

    private suspend fun download(episodeId: String, url: String, target: File) {
        val partial = File(target.path + ".part")
        val existingBytes = if (partial.exists()) partial.length() else 0L

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "FilterPod/0.1")
            // Resume where we left off, if the server honours ranges.
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
            java.io.FileOutputStream(partial, resuming).use { output ->
                val buffer = ByteArray(64 * 1024)
                var written = alreadyHave
                var lastEmit = 0L

                while (scope.isActive) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    output.write(buffer, 0, read)
                    written += read

                    // Throttled: one bridge message per 64KB chunk would flood the WebView.
                    if (written - lastEmit > 512 * 1024) {
                        lastEmit = written
                        emit(episodeId, written, total, "downloading", null)
                    }
                }
            }
        }

        if (!scope.isActive) return

        partial.renameTo(target)
        val size = target.length()
        // bytesDownloaded == bytesTotal is how the web layer recognises completion.
        emit(episodeId, size, size, "downloaded", null)
    }

    private fun emit(
        episodeId: String,
        bytesDownloaded: Long,
        bytesTotal: Long,
        state: String,
        error: String?,
    ) {
        notifyListeners(
            "progress",
            JSObject()
                .put("episodeId", episodeId)
                .put("bytesDownloaded", bytesDownloaded)
                .put("bytesTotal", bytesTotal)
                .put("state", state)
                .also { if (error != null) it.put("error", error) },
        )
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val episodeId = call.getString("episodeId")
        if (episodeId != null) {
            jobs.remove(episodeId)?.cancel()
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }
}
