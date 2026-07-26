package app.filterpod

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device transcription via whisper.cpp.
 *
 * The window mechanic matters as much as the model: when the web layer supplies
 * `windows` — because a publisher transcript already told us where the suspect audio is
 * — only those seconds get transcribed. That is routinely the difference between a
 * multi-minute job and a few seconds of work.
 */
@CapacitorPlugin(name = "Transcriber")
class TranscriberPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cancelled = ConcurrentHashMap<String, AtomicBoolean>()

    @Volatile private var contextPtr: Long = 0
    @Volatile private var loadedModel: String? = null

    /**
     * ggml weights, quantized (q5_1).
     *
     * Quantized rather than fp16 for two reasons: the download drops from ~150MB to
     * ~30-60MB, and integer kernels are materially faster on ARM. Accuracy loss on
     * English speech is small, and the matcher only needs the word right, not the
     * casing or punctuation.
     */
    private fun modelUrl(model: String) =
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$model-q5_1.bin"

    private fun modelFile(model: String) =
        File(context.filesDir, "filterpod/models/ggml-$model-q5_1.bin")

    /**
     * Threads for whisper.cpp. Capped at 4 on purpose.
     *
     * Phone CPUs are big.LITTLE — a Pixel 7 Pro is 2 big + 2 mid + 4 little. ggml splits
     * each layer evenly and waits for every thread, so the slowest core gates the whole
     * step: adding little cores makes it *slower*, not faster. Four keeps the work on
     * the big and mid cores, and leaves the little ones for playback and the UI.
     */
    private fun threadCount() =
        Runtime.getRuntime().availableProcessors().coerceIn(2, 4)

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val available = try {
            // Touching the object runs its initializer, which is where
            // System.loadLibrary happens — a missing .so surfaces as
            // ExceptionInInitializerError wrapping UnsatisfiedLinkError.
            WhisperNative.hashCode()
            true
        } catch (error: Throwable) {
            false
        }
        call.resolve(JSObject().put("available", available))
    }

    /** Cheap on-disk check, so startup can decide whether a background fetch is needed. */
    @PluginMethod
    fun isModelReady(call: PluginCall) {
        val model = call.getString("model") ?: "base.en"
        val file = modelFile(model)
        call.resolve(JSObject().put("ready", file.exists() && file.length() > 1_000_000))
    }

    @PluginMethod
    fun ensureModel(call: PluginCall) {
        val model = call.getString("model") ?: "base.en"
        scope.launch {
            try {
                downloadModelIfNeeded(model)
                loadContext(model)
                call.resolve()
            } catch (error: Throwable) {
                call.reject(error.message ?: "model download failed")
            }
        }
    }

    private fun downloadModelIfNeeded(model: String) {
        val target = modelFile(model)
        if (target.exists() && target.length() > 1_000_000) return
        // Reaching here means a ~150MB fetch is about to happen, which is worth saying
        // out loud — it is minutes of wall time that otherwise looks like a hang.
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

                    // Throttled to ~5/second. Emitting per 256KB read pushed thousands
                    // of events per second across the Capacitor bridge, which costs far
                    // more than the download itself and stalls the WebView.
                    val now = System.currentTimeMillis()
                    if (total > 0 && now - lastNotifyAt >= 200) {
                        lastNotifyAt = now
                        notifyListeners(
                            "modelProgress",
                            JSObject().put("fraction", written.toDouble() / total),
                        )
                    }
                }
            }
        }
        partial.renameTo(target)
    }

    private fun log(message: String) = android.util.Log.i("FilterPod", message)

    private fun loadContext(model: String) {
        if (contextPtr != 0L && loadedModel == model) return
        if (contextPtr != 0L) {
            WhisperNative.freeContext(contextPtr)
            contextPtr = 0
        }
        val ptr = WhisperNative.initContext(modelFile(model).path)
        if (ptr == 0L) throw IllegalStateException("could not load $model")
        contextPtr = ptr
        loadedModel = model
    }

    @PluginMethod
    fun transcribe(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId is required")
        val fileKey = call.getString("fileKey") ?: return call.reject("fileKey is required")
        val model = call.getString("model") ?: "base.en"
        val windows = parseWindows(call.getArray("windows"))

        val flag = AtomicBoolean(false)
        cancelled[requestId] = flag

        scope.launch {
            try {
                // Step-by-step, because a single timing line at the end cannot say which
                // stage is slow — and a stage that never returns logs nothing at all.
                log("transcribe $requestId: start, ${windows.size} window(s)")

                downloadModelIfNeeded(model)
                log("transcribe $requestId: model ready")

                loadContext(model)
                log("transcribe $requestId: whisper context loaded")

                val audio = File(context.filesDir, "filterpod/$fileKey")
                if (!audio.exists()) throw IllegalStateException("audio file missing")

                val words = JSArray()
                // A null window means "the whole file"; the decoder treats it that way.
                val ranges = windows.ifEmpty { listOf(null to null) }

                ranges.forEachIndexed { index, (startSec, endSec) ->
                    if (flag.get()) return@launch

                    // Timed and logged: transcription is the one operation slow enough
                    // that "is it working or wedged?" is a real question, and there is
                    // no way to tell from the outside without this.
                    log("chunk ${startSec?.toInt()}-${endSec?.toInt()}s: decoding…")
                    val decodeStart = System.currentTimeMillis()
                    val pcm = AudioDecoder.decodeWindow(audio, startSec, endSec)
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
                        // Flat triples: word, startMs, endMs.
                        var i = 0
                        while (i + 2 < flat.size) {
                            val text = flat[i].trim()
                            if (text.isNotEmpty()) {
                                words.put(
                                    JSObject()
                                        .put("word", text)
                                        .put("startSec", (flat[i + 1].toLong() + offsetMs) / 1000.0)
                                        .put("endSec", (flat[i + 2].toLong() + offsetMs) / 1000.0)
                                )
                            }
                            i += 3
                        }
                    }

                    notifyListeners(
                        "progress",
                        JSObject()
                            .put("requestId", requestId)
                            .put("fraction", (index + 1).toDouble() / ranges.size),
                    )
                }

                call.resolve(JSObject().put("words", words))
            } catch (error: Throwable) {
                // Throwable, not Exception: decoding large audio buffers can raise
                // OutOfMemoryError, which is an Error. Catching only Exception let it
                // escape the coroutine and kill the whole process — a failed chunk must
                // degrade to a rejected call, never take the app down.
                android.util.Log.e("FilterPod", "transcribe $requestId failed", error)
                call.reject(error.message ?: "transcription failed")
            } finally {
                cancelled.remove(requestId)
            }
        }
    }

    private fun parseWindows(array: JSArray?): List<Pair<Double?, Double?>> {
        if (array == null) return emptyList()
        val windows = ArrayList<Pair<Double?, Double?>>(array.length())
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            windows.add(item.optDouble("startSec", 0.0) to item.optDouble("endSec", 0.0))
        }
        return windows
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        call.getString("requestId")?.let { cancelled[it]?.set(true) }
        call.resolve()
    }

    override fun handleOnDestroy() {
        scope.cancel()
        if (contextPtr != 0L) {
            WhisperNative.freeContext(contextPtr)
            contextPtr = 0
        }
        super.handleOnDestroy()
    }
}
