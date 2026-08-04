package app.filterpod

import com.getcapacitor.JSArray
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
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Bridge surface for on-device transcription.
 *
 * Thin since the driver port: the actual work — model management, decode, whisper,
 * wakelocks, the serialized lane, the interruption-enforced deadlines — lives in
 * [TranscriptionCore], shared with the native LiveFilterEngine. This class only
 * adapts Capacitor calls to it, for the callers that still arrive over the bridge:
 * the download prefilter and browser-driven work.
 *
 * The window mechanic matters as much as the model: when the caller supplies
 * `windows` — a publisher transcript said where the suspect audio is — only those
 * seconds are transcribed, routinely the difference between minutes and seconds.
 */
@CapacitorPlugin(name = "Transcriber")
class TranscriberPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cancelled = ConcurrentHashMap<String, AtomicBoolean>()

    /** In-flight transcriptions by requestId, so cancel can interrupt, not just flag. */
    private val jobs = ConcurrentHashMap<String, Job>()

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
        call.resolve(JSObject().put("ready", TranscriptionCore.modelReady(context, model)))
    }

    @PluginMethod
    fun ensureModel(call: PluginCall) {
        val model = call.getString("model") ?: "base.en"
        scope.launch {
            try {
                TranscriptionCore.ensureModel(context, model) { fraction ->
                    notifyListeners("modelProgress", JSObject().put("fraction", fraction))
                }
                call.resolve()
            } catch (error: Throwable) {
                call.reject(error.message ?: "model download failed")
            }
        }
    }

    @PluginMethod
    fun transcribe(call: PluginCall) {
        val requestId = call.getString("requestId") ?: return call.reject("requestId is required")
        val fileKey = call.getString("fileKey") ?: return call.reject("fileKey is required")
        val model = call.getString("model") ?: "base.en"
        val streamUrl = call.getString("url")
        val windows = parseWindows(call.getArray("windows"))

        val flag = AtomicBoolean(false)
        cancelled[requestId] = flag

        val job = scope.launch {
            try {
                android.util.Log.i("FilterPod", "transcribe $requestId: start, ${windows.size} window(s)")
                val words = JSArray()
                // A null window means "the whole file"; the decoder treats it that way.
                val ranges = windows.ifEmpty { listOf(null to null) }

                ranges.forEachIndexed { index, (startSec, endSec) ->
                    if (flag.get()) return@launch

                    val chunk = TranscriptionCore.transcribeWindow(
                        context, fileKey, streamUrl, model, startSec, endSec,
                    )
                    for (word in chunk) {
                        words.put(
                            JSObject()
                                .put("word", word.word)
                                .put("startSec", word.startSec)
                                .put("endSec", word.endSec),
                        )
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
                // Throwable, not Exception: decode can raise OutOfMemoryError, and a
                // failed chunk must degrade to a rejected call, never take the app down.
                android.util.Log.e("FilterPod", "transcribe $requestId failed", error)
                call.reject(error.message ?: "transcription failed")
            } finally {
                cancelled.remove(requestId)
                jobs.remove(requestId)
            }
        }
        jobs[requestId] = job
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
        call.getString("requestId")?.let { requestId ->
            cancelled[requestId]?.set(true)
            // The flag is only consulted between windows; a wedged decode never gets
            // there. Cancelling the job interrupts the worker thread, which is what
            // actually unblocks a dead socket read or an untimed cache-lock wait.
            jobs.remove(requestId)?.cancel()
        }
        call.resolve()
    }

    override fun handleOnDestroy() {
        scope.cancel()
        TranscriptionCore.release()
        super.handleOnDestroy()
    }
}
