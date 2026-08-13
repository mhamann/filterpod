package app.filterpod

import android.content.Context
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The one place audio becomes words.
 *
 * Extracted from TranscriberPlugin so the native LiveFilterEngine can transcribe
 * without a bridge crossing — the whole point of the driver port is that the pipeline
 * racing the playhead shares the playback service's process and privileges. The plugin
 * keeps its Capacitor surface (prefilter and browser-driven work arrive that way) but
 * delegates here, so both callers share one whisper context, one model store, and one
 * serialized lane.
 *
 * Every hard-won invariant from the streamed-decode saga lives in [transcribeWindow]:
 * the serialized dispatcher (whisper's context has no internal locking), CPU and wifi
 * locks for the duration (doze is indifferent to how important a read is), and the
 * interruption-enforced decode deadline (dead sockets and untimed cache waits are
 * unblocked by exactly one lever, and this is it).
 */
object TranscriptionCore {

    /**
     * One transcription at a time, everywhere. Live chunks, prefilter windows and
     * bridge calls all queue through this single lane.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    val dispatcher = Dispatchers.IO.limitedParallelism(1)

    /** Backstop so an abandoned transcription can never pin the CPU indefinitely. */
    private const val WAKE_LOCK_TIMEOUT_MS = 10 * 60_000L

    /** Hard ceiling on one window's decode, enforced by thread interruption. */
    private const val DECODE_TIMEOUT_MS = 60_000L

    @Volatile private var contextPtr: Long = 0
    @Volatile private var loadedModel: String? = null

    /** ggml weights, quantized (q5_1); see TranscriberPlugin for the why. */
    private fun modelUrl(model: String) =
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$model-q5_1.bin"

    fun modelFile(context: Context, model: String) =
        File(context.filesDir, "filterpod/models/ggml-$model-q5_1.bin")

    fun modelReady(context: Context, model: String): Boolean {
        val file = modelFile(context, model)
        return file.exists() && file.length() > 1_000_000
    }

    /**
     * Threads for whisper.cpp, capped at 4: ggml waits for its slowest thread, so
     * adding little cores makes each step slower, not faster.
     */
    fun threadCount() = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)

    private fun log(message: String) = android.util.Log.i("FilterPod", message)

    /** Downloads the model if missing and loads the whisper context. Serialized. */
    suspend fun ensureModel(
        context: Context,
        model: String,
        onProgress: ((Double) -> Unit)? = null,
    ) = withContext(dispatcher) {
        downloadModelIfNeeded(context, model, onProgress)
        loadContext(context, model)
    }

    private fun downloadModelIfNeeded(
        context: Context,
        model: String,
        onProgress: ((Double) -> Unit)?,
    ) {
        val target = modelFile(context, model)
        if (target.exists() && target.length() > 1_000_000) return
        log("model $model missing (${target.length()} bytes at ${target.path}), downloading…")
        target.parentFile?.mkdirs()

        val connection = (URL(modelUrl(model)).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = true
        }
        val total = connection.contentLengthLong
        val partial = File(target.path + ".part")

        connection.inputStream.use { input ->
            partial.outputStream().use { output ->
                val buffer = ByteArray(256 * 1024)
                var written = 0L
                var lastNotifyAt = 0L

                while (true) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    output.write(buffer, 0, read)
                    written += read

                    // Throttled to ~5/second; per-read events swamped the bridge once.
                    val now = System.currentTimeMillis()
                    if (total > 0 && now - lastNotifyAt >= 200) {
                        lastNotifyAt = now
                        onProgress?.invoke(written.toDouble() / total)
                    }
                }
            }
        }
        partial.renameTo(target)
    }

    private fun loadContext(context: Context, model: String) {
        if (contextPtr != 0L && loadedModel == model) return
        if (contextPtr != 0L) {
            WhisperNative.freeContext(contextPtr)
            contextPtr = 0
        }
        val ptr = WhisperNative.initContext(modelFile(context, model).path)
        if (ptr == 0L) throw IllegalStateException("could not load $model")
        contextPtr = ptr
        loadedModel = model
    }

    /**
     * Transcribes one window of one episode. Suspends through the serialized lane;
     * cancellation of the calling coroutine interrupts a wedged decode.
     *
     * [startSec]/[endSec] of null mean "the whole file". Word timestamps come back on
     * the episode's absolute timeline, in seconds, ready for the matcher.
     */
    suspend fun transcribeWindow(
        context: Context,
        fileKey: String,
        streamUrl: String?,
        model: String,
        startSec: Double?,
        endSec: Double?,
    ): List<TimedWord> = withContext(dispatcher) {
        val powerManager = context.getSystemService(Context.POWER_SERVICE)
            as android.os.PowerManager
        val wakeLock = powerManager.newWakeLock(
            android.os.PowerManager.PARTIAL_WAKE_LOCK, "filterpod:transcribe",
        ).apply {
            setReferenceCounted(false)
            acquire(WAKE_LOCK_TIMEOUT_MS)
        }
        val wifiManager = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
        val wifiLock = wifiManager.createWifiLock(
            android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "filterpod:transcribe-net",
        ).apply {
            setReferenceCounted(false)
            acquire()
        }

        try {
            downloadModelIfNeeded(context, model, null)
            loadContext(context, model)

            val audio = File(context.filesDir, "filterpod/$fileKey")
            if (!audio.exists() && streamUrl.isNullOrEmpty()) {
                throw IllegalStateException("audio file missing and no stream url")
            }
            val streaming = !audio.exists()

            log("chunk ${startSec?.toInt()}-${endSec?.toInt()}s: decoding…")
            val decodeStart = System.currentTimeMillis()
            val pcm = withTimeout(DECODE_TIMEOUT_MS) {
                runInterruptible {
                    if (streaming) {
                        MediaCache.openForDecoding(context, streamUrl!!).use { source ->
                            AudioDecoder.decodeWindow(source, fileKey, startSec, endSec)
                        }
                    } else {
                        AudioDecoder.decodeWindow(audio, startSec, endSec)
                    }
                }
            }
            val decodeMs = System.currentTimeMillis() - decodeStart
            log("chunk ${startSec?.toInt()}s: decoded ${pcm.size / 16000}s in ${decodeMs}ms, running asr on ${threadCount()} threads…")

            val asrStart = System.currentTimeMillis()
            val offsetMs = ((startSec ?: 0.0) * 1000).toLong()
            val flat = WhisperNative.transcribe(contextPtr, pcm, threadCount())
            val asrMs = System.currentTimeMillis() - asrStart

            log(
                "chunk ${startSec?.toInt()}-${endSec?.toInt()}s DONE: " +
                    "decode ${decodeMs}ms, asr ${asrMs}ms, " +
                    "${(flat?.size ?: 0) / 3} words, " +
                    "heap ${Runtime.getRuntime().let { (it.totalMemory() - it.freeMemory()) / 1048576 }}MB",
            )
            if (flat != null) {
                // Transcribed text, truncated, local logcat only — the difference
                // between diagnosing a reported miss from the log and rebuilding the
                // whole scenario to learn what ASR heard.
                val text = StringBuilder()
                var w = 0
                while (w + 2 < flat.size && text.length < 220) {
                    text.append(flat[w].trim()).append(' ')
                    w += 3
                }
                log("chunk ${startSec?.toInt()}s text: ${text.toString().trim()}")
            }

            val words = ArrayList<TimedWord>()
            if (flat != null) {
                var i = 0
                while (i + 2 < flat.size) {
                    val text = flat[i].trim()
                    if (text.isNotEmpty()) {
                        words.add(
                            TimedWord(
                                word = text,
                                startSec = (flat[i + 1].toLong() + offsetMs) / 1000.0,
                                endSec = (flat[i + 2].toLong() + offsetMs) / 1000.0,
                            ),
                        )
                    }
                    i += 3
                }
            }
            words
        } finally {
            if (wakeLock.isHeld) wakeLock.release()
            if (wifiLock.isHeld) wifiLock.release()
        }
    }

    /**
     * Frees the whisper context — from the transcription lane, never directly.
     *
     * Freeing is queued behind whatever window is in flight, because whisper has no
     * internal locking: freeing the context under a running transcription is a straight
     * use-after-free. This was found the hard way — an activity recreate (renderer
     * death) destroyed the Transcriber plugin, its onDestroy freed the context while
     * the service's filter engine was mid-chunk on another thread, and the whole
     * process died of SIGSEGV, audio included.
     *
     * Callers also should not free a context the engine still needs (the reload costs
     * seconds); see TranscriberPlugin.handleOnDestroy for that guard. This method only
     * guarantees the free itself cannot race a transcription.
     */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    fun release() {
        kotlinx.coroutines.GlobalScope.launch(dispatcher) {
            if (contextPtr != 0L) {
                WhisperNative.freeContext(contextPtr)
                contextPtr = 0
                loadedModel = null
            }
        }
    }
}
