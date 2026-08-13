package app.filterpod.shared.data

import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.Progress
import app.filterpod.shared.model.QueueItem
import app.filterpod.shared.model.Settings
import app.filterpod.shared.model.Subscription
import app.filterpod.shared.model.WordOverride
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Reads the Capacitor app's library backup, ported from src/data/backup.ts.
 *
 * This is the cutover path: the old app continuously snapshots every irreplaceable
 * table (subscriptions, progress, queue, settings, profiles, word overrides) to
 * files/filterpod/backup/library.json, and because the KMP app ships under the same
 * applicationId, that file is simply *there* on first launch after the upgrade.
 * Episode metadata, audio, models and filter maps are deliberately absent — feeds,
 * downloads and filtering rebuild those, and episode ids are deterministic
 * (see Ids.kt) so rebuilt rows reattach to imported history.
 *
 * Merge semantics are identical to applyLibraryBackup in TS: existing subscriptions
 * win, newer progress wins, the queue is only adopted when the local queue is empty.
 * That makes importing safe not just at cutover but for user-initiated restores later.
 */

@Serializable
data class LibraryBackup(
    val version: Int,
    val savedAt: Long,
    val podcasts: List<Podcast> = emptyList(),
    val subscriptions: List<Subscription> = emptyList(),
    val progress: List<Progress> = emptyList(),
    val queue: List<QueueItem> = emptyList(),
    val settings: List<SettingsRow> = emptyList(),
    val filterProfiles: List<FilterProfile> = emptyList(),
    val wordOverrides: List<WordOverride> = emptyList(),
) {
    /** The TS row carries a Dexie primary key the Settings model does not. */
    @Serializable
    data class SettingsRow(
        val id: String = "singleton",
        val activeFilterProfileId: String = "standard",
        val playbackRate: Double = 1.0,
        val skipForwardSec: Int = 30,
        val skipBackSec: Int = 15,
        val completionThresholdSec: Int = 30,
        val autoDownloadOnWifiOnly: Boolean = true,
        val maxStorageBytes: Long = 4L * 1024 * 1024 * 1024,
        val whisperModel: String = "base.en",
        val theme: String = "dark",
    ) {
        fun toSettings() = Settings(
            activeFilterProfileId, playbackRate, skipForwardSec, skipBackSec,
            completionThresholdSec, autoDownloadOnWifiOnly, maxStorageBytes,
            whisperModel, theme,
        )
    }
}

data class ImportResult(
    val subscriptions: Int,
    val progress: Int,
    val queue: Int,
)

class BackupImporter(private val repo: Repo) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun parse(contents: String): LibraryBackup {
        val backup = try {
            json.decodeFromString(LibraryBackup.serializer(), contents)
        } catch (error: Exception) {
            throw IllegalArgumentException("That is not a supported FilterPod backup.", error)
        }
        require(backup.version == 1) { "That is not a supported FilterPod backup." }
        return backup
    }

    /**
     * Merges a backup into the store. Never clears: current per-show choices and
     * newer progress are retained, so importing an old file onto a phone in use
     * is safe.
     */
    suspend fun apply(backup: LibraryBackup): ImportResult {
        var subscriptions = 0
        var progressCount = 0
        var queueCount = 0

        for (podcast in backup.podcasts) repo.upsertPodcast(podcast)

        for (subscription in backup.subscriptions) {
            if (repo.getSubscription(subscription.podcastId) == null) {
                repo.putSubscription(subscription)
                subscriptions++
            }
        }

        for (incoming in backup.progress) {
            val current = repo.getProgress(incoming.episodeId)
            if (current == null || incoming.lastPlayedAt >= current.lastPlayedAt) {
                repo.putProgress(incoming)
                progressCount++
            }
        }

        if (repo.listQueue().isEmpty()) {
            for (item in backup.queue.sortedBy { it.position }) {
                repo.putQueueItemRaw(item)
                queueCount++
            }
        }

        backup.settings.firstOrNull()?.let { row ->
            repo.updateSettings { row.toSettings() }
        }
        for (profile in backup.filterProfiles) repo.putFilterProfile(profile)
        for (override in backup.wordOverrides) repo.putWordOverride(override)

        return ImportResult(subscriptions, progressCount, queueCount)
    }

    /**
     * The first-launch cutover: import once, stamp, never again. An empty backup is
     * meaningful — the user deliberately emptied their library — and is not imported,
     * mirroring restoreLibraryBackupIfEmpty in TS.
     */
    suspend fun importAtFirstLaunch(contents: String?, now: Long): ImportResult? {
        if (repo.getKv(Repo.KEY_IMPORTED_AT) != null) return null
        val backup = contents?.let { runCatching { parse(it) }.getOrNull() }
        val result = if (backup != null && backup.subscriptions.isNotEmpty()) {
            apply(backup)
        } else {
            null
        }
        repo.putKv(Repo.KEY_IMPORTED_AT, now.toString())
        return result
    }

    companion object {
        /** Where the Capacitor app keeps its snapshot, relative to the app files dir. */
        const val BACKUP_RELATIVE_PATH = "filterpod/backup/library.json"
    }
}
