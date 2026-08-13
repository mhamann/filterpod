package app.filterpod

import app.filterpod.shared.net.Http
import app.filterpod.shared.net.HttpResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runInterruptible
import java.net.HttpURLConnection
import java.net.URL

/**
 * The shared module's one HTTP seam, implemented with HttpURLConnection — the same
 * client the transcription core already uses, so the app carries exactly one HTTP
 * stack. Redirects are followed across scheme upgrades (feed URLs are full of
 * http->https hops that HttpURLConnection refuses to follow on its own).
 */
class AndroidHttp : Http {

    override suspend fun get(url: String, headers: Map<String, String>): HttpResponse =
        runInterruptible(Dispatchers.IO) {
            var current = url
            var redirects = 0
            while (true) {
                val connection = (URL(current).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = false
                    for ((name, value) in headers) setRequestProperty(name, value)
                    setRequestProperty("User-Agent", "FilterPod/1.0 (Android)")
                }
                try {
                    val status = connection.responseCode
                    if (status in 301..308 && redirects < 5) {
                        val location = connection.getHeaderField("Location")
                        if (location != null) {
                            redirects++
                            current = URL(URL(current), location).toString()
                            continue
                        }
                    }
                    val body = (if (status >= 400) connection.errorStream else connection.inputStream)
                        ?.use { it.readBytes() } ?: ByteArray(0)
                    val responseHeaders = buildMap {
                        for ((name, values) in connection.headerFields) {
                            if (name != null && values.isNotEmpty()) put(name.lowercase(), values.last())
                        }
                    }
                    return@runInterruptible HttpResponse(status, responseHeaders, body)
                } finally {
                    connection.disconnect()
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }
}
