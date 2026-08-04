package app.filterpod

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream

/**
 * User-controlled import/export through Android's Storage Access Framework.
 *
 * Files chosen here are documents, not app-private files: they may live in Drive or
 * another document provider and remain available after FilterPod is uninstalled.
 */
@CapacitorPlugin(name = "BackupDocuments")
class BackupDocumentsPlugin : Plugin() {

    @PluginMethod
    fun save(call: PluginCall) {
        val fileName = call.getString("fileName")
        val mimeType = call.getString("mimeType") ?: JSON_MIME
        if (fileName == null || call.getString("contents") == null) {
            call.reject("fileName and contents are required")
            return
        }

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
            putExtra(Intent.EXTRA_TITLE, fileName)
        }
        startActivityForResult(call, intent, "savedDocument")
    }

    @ActivityCallback
    private fun savedDocument(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }

        val uri = requireNotNull(result.data?.data)
        val contents = call.getString("contents") ?: run {
            call.reject("backup contents were lost")
            return
        }
        try {
            val output = context.contentResolver.openOutputStream(uri, "wt")
                ?: throw IllegalStateException("could not open selected document")
            output.use { it.write(contents.toByteArray(Charsets.UTF_8)) }
            call.resolve(JSObject().put("cancelled", false))
        } catch (error: Throwable) {
            call.reject("could not save backup", Exception(error))
        }
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val mimeTypes = call.getArray("mimeTypes")
            ?.toList<String>()
            ?.toTypedArray()
            ?.takeIf { it.isNotEmpty() }
            ?: arrayOf(JSON_MIME)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (mimeTypes.size == 1) mimeTypes[0] else "*/*"
            if (mimeTypes.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
        }
        startActivityForResult(call, intent, "openedDocument")
    }

    @ActivityCallback
    private fun openedDocument(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK || result.data?.data == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }

        try {
            val input = context.contentResolver.openInputStream(requireNotNull(result.data?.data))
                ?: throw IllegalStateException("could not open selected document")
            val bytes = input.use {
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                var total = 0
                while (true) {
                    val read = it.read(buffer)
                    if (read == -1) break
                    total += read
                    if (total > MAX_BACKUP_BYTES) {
                        throw IllegalArgumentException("backup is larger than 5 MB")
                    }
                    output.write(buffer, 0, read)
                }
                output.toByteArray()
            }
            call.resolve(
                JSObject()
                    .put("cancelled", false)
                    .put("contents", String(bytes, Charsets.UTF_8)),
            )
        } catch (error: Throwable) {
            call.reject("could not read backup", Exception(error))
        }
    }

    companion object {
        private const val JSON_MIME = "application/json"
        private const val MAX_BACKUP_BYTES = 5 * 1024 * 1024
    }
}
