package app.filterpod.shared.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Domain types, ported from src/core/types.ts.
 *
 * Serialization names match the TypeScript field names and string unions exactly,
 * because these types round-trip through the same JSON in two load-bearing places:
 * the Capacitor app's full-state backup (which the importer reads on cutover) and the
 * engine-config handoff to the native filter driver.
 */

@Serializable
enum class Severity {
    @SerialName("mild") MILD,
    @SerialName("moderate") MODERATE,
    @SerialName("strong") STRONG,
}

@Serializable
enum class Category {
    @SerialName("profanity") PROFANITY,
    @SerialName("sexual") SEXUAL,
    @SerialName("slur") SLUR,
    @SerialName("blasphemy") BLASPHEMY,
    @SerialName("scatological") SCATOLOGICAL,
    @SerialName("custom") CUSTOM,
}

@Serializable
data class Podcast(
    val id: String,
    val feedUrl: String,
    val title: String,
    val author: String = "",
    val description: String = "",
    val artworkUrl: String = "",
    val link: String? = null,
    val categories: List<String> = emptyList(),
    val explicit: Boolean = false,
    val etag: String? = null,
    val lastModified: String? = null,
    val lastFetchedAt: Long? = null,
    val lastFetchError: String? = null,
    /**
     * When a refresh last actually succeeded (200 or 304). Distinct from lastFetchedAt,
     * which advances on failures too; the error banner keys off this.
     */
    val lastSuccessAt: Long? = null,
)

@Serializable
data class TranscriptRef(
    val url: String,
    val type: String,
    val language: String? = null,
)

@Serializable
data class Episode(
    val id: String,
    val podcastId: String,
    val guid: String,
    val title: String,
    val description: String = "",
    val audioUrl: String,
    val audioType: String? = null,
    val audioLength: Long? = null,
    val durationSec: Int? = null,
    val publishedAt: Long = 0,
    val episodeNumber: Int? = null,
    val seasonNumber: Int? = null,
    val explicit: Boolean = false,
    val artworkUrl: String? = null,
    val transcripts: List<TranscriptRef> = emptyList(),
    val chaptersUrl: String? = null,
)

@Serializable
data class Chapter(
    val startSec: Double,
    val title: String,
    val imageUrl: String? = null,
)

@Serializable
data class Subscription(
    val podcastId: String,
    val subscribedAt: Long,
    val autoDownload: Boolean = true,
    /** How many recent episodes to keep downloaded; 0 means unlimited. */
    val autoDownloadLimit: Int = 3,
    /**
     * Notify when this show publishes. Default off: a podcast app that starts
     * buzzing on its own has decided something for the listener that they never
     * asked for. See [app.filterpod.shared.data.Repo.initialize] for why stored
     * `true` values from before the feature existed are cleared rather than honored.
     */
    val notifyOnNew: Boolean = false,
    /** Position in the library grid, dense from 0. Absent rows sort by recency after ordered ones. */
    val sortOrder: Int? = null,
    /** Playback speed for this show; null means follow the app-wide setting. */
    val playbackRate: Double? = null,
    /** Seconds to skip at the start of an episode — the show's stock intro. */
    val skipIntroSec: Int = 0,
    /** Seconds to drop from the end — outro, credits, the next-week teaser. */
    val skipOutroSec: Int = 0,
    /** New episodes join the end of the queue when the feed refreshes. */
    val autoQueue: Boolean? = null,
    /** Overrides the global filter profile for this feed when set. */
    val filterProfileId: String? = null,
)

@Serializable
data class Progress(
    val episodeId: String,
    /** Position on the ORIGINAL, unfiltered timeline, in seconds. */
    val positionSec: Double,
    val durationSec: Double = 0.0,
    val played: Boolean = false,
    val completedAt: Long? = null,
    val lastPlayedAt: Long,
)

@Serializable
enum class DownloadState {
    @SerialName("queued") QUEUED,
    @SerialName("downloading") DOWNLOADING,
    @SerialName("paused") PAUSED,
    @SerialName("downloaded") DOWNLOADED,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
}

@Serializable
data class Download(
    val episodeId: String,
    val state: DownloadState,
    val fileKey: String? = null,
    val bytesDownloaded: Long = 0,
    val bytesTotal: Long = 0,
    val error: String? = null,
    val startedAt: Long = 0,
    val completedAt: Long? = null,
    /** Queued by an auto-download rule rather than the user tapping Get. */
    val auto: Boolean = false,
)

@Serializable
data class FilterSpan(
    val startSec: Double,
    val endSec: Double,
    val severity: Severity,
    val category: Category,
    /** Matched terms, for the "why was this skipped" UI. Never the surrounding text. */
    val terms: List<String> = emptyList(),
)

@Serializable
data class AnalyzedRange(
    val startSec: Double,
    val endSec: Double,
)

@Serializable
enum class FilterMapStatus {
    @SerialName("absent") ABSENT,
    @SerialName("partial") PARTIAL,
    @SerialName("ready") READY,
    @SerialName("failed") FAILED,
    @SerialName("unsupported") UNSUPPORTED,
}

@Serializable
data class FilterMap(
    val episodeId: String,
    val status: FilterMapStatus,
    val spans: List<FilterSpan> = emptyList(),
    /**
     * Which parts of the episode have actually been analyzed. Playback must never run
     * past the end of coverage — an unanalyzed stretch is unknown, not clean.
     */
    val analyzedRanges: List<AnalyzedRange> = emptyList(),
    val source: String = "asr",
    val engineVersion: String,
    val wordlistVersion: String,
    /** Which profile the spans were built under; a mismatch discards the map. */
    val profileId: String? = null,
    val progress: Double = 0.0,
    val error: String? = null,
    val createdAt: Long,
    val skippedSec: Double = 0.0,
)

@Serializable
data class FilterProfile(
    val id: String,
    val name: String,
    val severities: List<Severity>,
    val categories: List<Category>,
    /** Seconds kept before/after a flagged word, absorbing ASR timing error. */
    val padBeforeSec: Double,
    val padAfterSec: Double,
    /** Spans closer together than this merge into one skip. */
    val mergeGapSec: Double,
)

@Serializable
data class WordOverride(
    val term: String,
    val action: String,
    val severity: Severity = Severity.STRONG,
    val category: Category = Category.CUSTOM,
    val createdAt: Long = 0,
) {
    companion object {
        const val ACTION_BLOCK = "block"
        const val ACTION_ALLOW = "allow"
    }
}

@Serializable
data class QueueItem(
    val episodeId: String,
    /** Sort key, dense and zero-based, rewritten wholesale on every reorder. */
    val position: Int,
    val addedAt: Long,
)

@Serializable
data class Settings(
    val activeFilterProfileId: String = "family",
    val playbackRate: Double = 1.0,
    val skipForwardSec: Int = 30,
    val skipBackSec: Int = 15,
    /** Mark an episode played once within this many seconds of the end. */
    val completionThresholdSec: Int = 30,
    val autoDownloadOnWifiOnly: Boolean = true,
    val maxStorageBytes: Long = 4L * 1024 * 1024 * 1024,
    val whisperModel: String = "base.en",
    val theme: String = "dark",
)
