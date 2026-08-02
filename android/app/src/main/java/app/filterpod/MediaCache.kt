package app.filterpod

import android.content.Context
import android.media.MediaDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.database.StandaloneDatabaseProvider
import java.io.File

/**
 * The one place streamed audio is fetched.
 *
 * Playback and transcription both need the same bytes, and fetching them twice — once for
 * ExoPlayer, once so the filter pipeline has a file to decode — would double every
 * episode's data cost. Instead both read through this cache: ExoPlayer via
 * [dataSourceFactory], the decoder via [openForDecoding]. Whichever asks first pulls the
 * bytes from the network; the other gets them from disk.
 *
 * This is also what makes streaming safe to filter. The decoder cannot fail merely
 * because audio has not arrived yet — a read that misses simply fetches and blocks — so a
 * transcription failure still means a real failure, and the pipeline can keep treating it
 * as one. See MAX_CHUNK_ATTEMPTS in liveFilter.ts for why that distinction matters.
 */
object MediaCache {

    /**
     * Ceiling on cached stream data.
     *
     * Streamed audio is disposable: it exists so the current episode can be played and
     * examined, and re-fetching it later costs only bandwidth. Explicitly downloaded
     * episodes are kept as ordinary files elsewhere and are deliberately *not* stored
     * here, so eviction can never take away something the user asked to keep offline.
     */
    private const val MAX_BYTES = 512L * 1024 * 1024

    @Volatile
    private var cache: SimpleCache? = null

    fun get(context: Context): SimpleCache =
        cache ?: synchronized(this) {
            cache ?: SimpleCache(
                File(context.filesDir, "filterpod/stream-cache"),
                LeastRecentlyUsedCacheEvictor(MAX_BYTES),
                StandaloneDatabaseProvider(context),
            ).also { cache = it }
        }

    /** Upstream fetcher. Redirects are followed because podcast enclosures are full of them. */
    private fun httpFactory() = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        // Explicit and short: a socket that doze killed mid-transfer must become an
        // error the retry machinery can handle, never an indefinite block.
        .setConnectTimeoutMs(10_000)
        .setReadTimeoutMs(10_000)
        .setUserAgent("FilterPod")

    /** Cache-backed source factory, for ExoPlayer and for [openForDecoding] alike. */
    fun dataSourceFactory(context: Context): CacheDataSource.Factory =
        CacheDataSource.Factory()
            .setCache(get(context))
            .setUpstreamDataSourceFactory(httpFactory())
            // Without this a cache write failure would fail playback outright, when
            // carrying on uncached is a perfectly good outcome for the listener.
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    /**
     * What ExoPlayer plays through: cached when streaming, direct when not.
     *
     * A downloaded episode is already a file on disk. Sending it through the cache would
     * copy it into a second, evictable one — paying disk and IO to duplicate bytes that
     * are already there permanently — and the cache's HTTP upstream cannot open a `file://`
     * URI at all, so it would simply fail. The scheme decides.
     */
    fun playbackFactory(context: Context) = androidx.media3.datasource.DataSource.Factory {
        SchemeRoutingSource(
            local = androidx.media3.datasource.DefaultDataSource.Factory(context, httpFactory())
                .createDataSource(),
            remote = dataSourceFactory(context).createDataSource(),
        )
    }

    private class SchemeRoutingSource(
        private val local: androidx.media3.datasource.DataSource,
        private val remote: androidx.media3.datasource.DataSource,
    ) : androidx.media3.datasource.DataSource {

        private var delegate: androidx.media3.datasource.DataSource = local

        override fun open(dataSpec: DataSpec): Long {
            delegate = when (dataSpec.uri.scheme) {
                "http", "https" -> remote
                else -> local
            }
            return delegate.open(dataSpec)
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int) =
            delegate.read(buffer, offset, length)

        override fun getUri() = delegate.uri

        override fun getResponseHeaders() = delegate.responseHeaders

        override fun addTransferListener(transferListener: androidx.media3.datasource.TransferListener) {
            local.addTransferListener(transferListener)
            remote.addTransferListener(transferListener)
        }

        override fun close() = delegate.close()
    }

    @Volatile
    private var prefetching: Pair<String, Thread>? = null

    /**
     * Pulls an episode into the cache in the background, at network speed.
     *
     * Without this the decoder is the thing fetching, and it fetches the way MediaExtractor
     * reads: in small pieces, seeking about. Every miss re-opens the stream, and for a
     * typical podcast URL that means walking a chain of analytics redirects again — the
     * first fifteen-second chunk of a streamed episode took 11.4s to decode, against 0.9s
     * for the same audio on disk. Fetching sequentially and ahead turns almost every one of
     * those reads into a local one.
     *
     * Deliberately unbounded: it caches the whole episode rather than a window. The cache
     * has its own size limit, sequential fetching is by far the cheapest way to ask for
     * bytes, and a listener who pressed play will most likely want the rest of it.
     */
    fun prefetch(context: Context, url: String) {
        val current = prefetching
        if (current?.first == url && current.second.isAlive) return
        current?.second?.interrupt()

        val thread = Thread {
            val started = System.currentTimeMillis()
            runCatching {
                CacheWriter(
                    dataSourceFactory(context).createDataSource(),
                    DataSpec.Builder().setUri(url).build(),
                    null,
                ) { requested, cached, _ ->
                    if (Thread.currentThread().isInterrupted) throw InterruptedException()
                    if (requested > 0 && cached == requested) {
                        android.util.Log.i(
                            "FilterPod",
                            "prefetch complete: ${cached / 1048576}MB in " +
                                "${System.currentTimeMillis() - started}ms",
                        )
                    }
                }.cache()
            }.onFailure {
                // Losing the prefetch only costs speed: reads still fetch on demand.
                android.util.Log.i("FilterPod", "prefetch stopped: ${it.message}")
            }
        }
        thread.isDaemon = true
        prefetching = url to thread
        thread.start()
    }

    /**
     * Presents a remote URL to MediaExtractor as a seekable stream.
     *
     * MediaExtractor will seek freely — backwards for headers, forwards to the window
     * being transcribed — and every one of those reads is served from the cache when the
     * bytes are already there, which after read-ahead they usually are.
     */
    fun openForDecoding(context: Context, url: String): MediaDataSource =
        CacheBackedSource(dataSourceFactory(context).createDataSource(), url)

    private class CacheBackedSource(
        private val source: androidx.media3.datasource.DataSource,
        private val url: String,
    ) : MediaDataSource() {

        private var opened = false
        private var openPosition = 0L
        private var length = -1L

        /**
         * MediaExtractor reads at arbitrary offsets, and a DataSource is a one-shot stream
         * from a fixed position. So each jump re-opens at the new offset, while sequential
         * reads — the overwhelming majority — continue on the stream already open.
         */
        @Synchronized
        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            if (size == 0) return 0
            if (!opened || position != openPosition) openAt(position)

            val read = source.read(buffer, offset, size)
            if (read == androidx.media3.common.C.RESULT_END_OF_INPUT) return -1
            openPosition += read
            return read
        }

        private fun openAt(position: Long) {
            close()
            val resolved = source.open(
                DataSpec.Builder().setUri(url).setPosition(position).build(),
            )
            opened = true
            openPosition = position
            if (resolved != androidx.media3.common.C.LENGTH_UNSET.toLong()) {
                length = position + resolved
            }
        }

        @Synchronized
        override fun getSize(): Long {
            // MediaExtractor asks before reading anything; opening at 0 resolves the
            // length from the response, and leaves the stream positioned for the first read.
            if (length < 0 && !opened) {
                runCatching { openAt(0) }
            }
            return length
        }

        @Synchronized
        override fun close() {
            if (!opened) return
            runCatching { source.close() }
            opened = false
        }
    }
}
