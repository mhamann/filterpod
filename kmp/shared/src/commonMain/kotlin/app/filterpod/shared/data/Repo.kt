package app.filterpod.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Chapter
import app.filterpod.shared.model.Download
import app.filterpod.shared.model.DownloadState
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.FilterMap
import app.filterpod.shared.model.FilterMapStatus
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Podcast
import app.filterpod.shared.model.Progress
import app.filterpod.shared.model.QueueItem
import app.filterpod.shared.model.Settings
import app.filterpod.shared.model.Subscription
import app.filterpod.shared.model.WordOverride
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * The data layer, ported from src/data/repo.ts with the same semantics.
 *
 * Rows are stored as JSON documents beside their indexed columns, so every rule that
 * was true in Dexie stays true here: dense queue renumbering, the completion-threshold
 * played rule, newer-progress-wins on import, put-if-absent profile seeding.
 */
class Repo(
    private val db: FilterPodDb,
    private val io: CoroutineDispatcher,
) {
    // Lenient + ignoreUnknownKeys: rows written by future versions (or by the
    // TypeScript app, whose optional fields come and go) must never brick a read.
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val q get() = db.filterPodQueries

    // --- setup ---------------------------------------------------------------

    /** Seeds built-in profiles and settings. Safe to call on every startup. */
    suspend fun initialize() = withContext(io) {
        db.transaction {
            if (q.getKv(KEY_SETTINGS).executeAsOneOrNull() == null) {
                q.putKv(KEY_SETTINGS, json.encodeToString(Settings.serializer(), DEFAULT_SETTINGS))
            }
            for (profile in DEFAULT_PROFILES) {
                // Seed-if-absent: profile tuning ships in updates via migrations, but
                // user-edited rows are left alone.
                if (q.getFilterProfile(profile.id).executeAsOneOrNull() == null) {
                    q.upsertFilterProfile(profile.id, json.encodeToString(FilterProfile.serializer(), profile))
                }
            }
        }
    }

    // --- settings ------------------------------------------------------------

    suspend fun getSettings(): Settings = withContext(io) {
        q.getKv(KEY_SETTINGS).executeAsOneOrNull()
            ?.let { json.decodeFromString(Settings.serializer(), it) }
            ?: DEFAULT_SETTINGS
    }

    suspend fun updateSettings(update: (Settings) -> Settings) = withContext(io) {
        val current = q.getKv(KEY_SETTINGS).executeAsOneOrNull()
            ?.let { json.decodeFromString(Settings.serializer(), it) }
            ?: DEFAULT_SETTINGS
        q.putKv(KEY_SETTINGS, json.encodeToString(Settings.serializer(), update(current)))
    }

    suspend fun getActiveProfile(): FilterProfile {
        val settings = getSettings()
        return getFilterProfile(settings.activeFilterProfileId) ?: DEFAULT_PROFILES[1]
    }

    /** Resolves the profile for an episode, honouring a per-subscription override. */
    suspend fun getProfileForPodcast(podcastId: String): FilterProfile {
        val subscription = getSubscription(podcastId)
        subscription?.filterProfileId?.let { override ->
            getFilterProfile(override)?.let { return it }
        }
        return getActiveProfile()
    }

    // --- podcasts and episodes ----------------------------------------------

    suspend fun upsertPodcast(podcast: Podcast) = withContext(io) {
        val merged = q.getPodcast(podcast.id).executeAsOneOrNull()
            ?.let { json.decodeFromString(Podcast.serializer(), it) }
            ?.let { existing -> mergePodcast(existing, podcast) }
            ?: podcast
        q.upsertPodcast(merged.id, merged.feedUrl, json.encodeToString(Podcast.serializer(), merged))
    }

    suspend fun getPodcast(id: String): Podcast? = withContext(io) {
        q.getPodcast(id).executeAsOneOrNull()?.let { json.decodeFromString(Podcast.serializer(), it) }
    }

    suspend fun listPodcasts(): List<Podcast> = withContext(io) {
        q.listPodcasts().executeAsList().map { json.decodeFromString(Podcast.serializer(), it) }
    }

    /** Writes episodes, returning the ids that were new (drives auto-queue/download). */
    suspend fun upsertEpisodes(episodes: List<Episode>): List<String> = withContext(io) {
        if (episodes.isEmpty()) return@withContext emptyList()
        val fresh = mutableListOf<String>()
        db.transaction {
            for (episode in episodes) {
                val known = q.episodeExists(episode.id).executeAsOne() > 0
                if (!known) fresh += episode.id
                q.upsertEpisode(
                    episode.id, episode.podcastId, episode.publishedAt,
                    json.encodeToString(Episode.serializer(), episode),
                )
            }
        }
        fresh
    }

    suspend fun getEpisode(id: String): Episode? = withContext(io) {
        q.getEpisode(id).executeAsOneOrNull()?.let { json.decodeFromString(Episode.serializer(), it) }
    }

    suspend fun listEpisodes(podcastId: String, limit: Long = 200): List<Episode> = withContext(io) {
        q.listEpisodesForPodcast(podcastId, limit).executeAsList()
            .map { json.decodeFromString(Episode.serializer(), it) }
    }

    fun observeEpisodes(podcastId: String, limit: Long = 200): Flow<List<Episode>> =
        q.listEpisodesForPodcast(podcastId, limit).asFlow().mapToList(io)
            .mapListJson(Episode.serializer())

    /**
     * Records the duration the player actually measured. Feed-declared durations are
     * wrong often enough to matter; measured playback is ground truth once known.
     */
    suspend fun recordMeasuredDuration(episodeId: String, durationSec: Double) = withContext(io) {
        val episode = q.getEpisode(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Episode.serializer(), it) } ?: return@withContext
        val updated = episode.copy(durationSec = kotlin.math.round(durationSec).toInt())
        q.upsertEpisode(updated.id, updated.podcastId, updated.publishedAt,
            json.encodeToString(Episode.serializer(), updated))
    }

    // --- subscriptions -------------------------------------------------------

    suspend fun subscribe(podcastId: String, base: Subscription? = null, now: Long): Subscription =
        withContext(io) {
            val subscription = base ?: Subscription(podcastId = podcastId, subscribedAt = now)
            q.upsertSubscription(subscription.podcastId, subscription.subscribedAt,
                json.encodeToString(Subscription.serializer(), subscription))
            subscription
        }

    suspend fun putSubscription(subscription: Subscription) = withContext(io) {
        q.upsertSubscription(subscription.podcastId, subscription.subscribedAt,
            json.encodeToString(Subscription.serializer(), subscription))
    }

    suspend fun getSubscription(podcastId: String): Subscription? = withContext(io) {
        q.getSubscription(podcastId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Subscription.serializer(), it) }
    }

    suspend fun listSubscriptions(): List<Subscription> = withContext(io) {
        q.listSubscriptions().executeAsList().map { json.decodeFromString(Subscription.serializer(), it) }
    }

    fun observeSubscriptions(): Flow<List<Subscription>> =
        q.listSubscriptions().asFlow().mapToList(io).mapListJson(Subscription.serializer())

    /** Writes the library's arrangement: dense sortOrder in the order given. */
    suspend fun setLibraryOrder(podcastIds: List<String>) = withContext(io) {
        db.transaction {
            podcastIds.forEachIndexed { index, podcastId ->
                val row = q.getSubscription(podcastId).executeAsOneOrNull() ?: return@forEachIndexed
                val updated = json.decodeFromString(Subscription.serializer(), row).copy(sortOrder = index)
                q.upsertSubscription(updated.podcastId, updated.subscribedAt,
                    json.encodeToString(Subscription.serializer(), updated))
            }
        }
    }

    /** Unsubscribes and reclaims storage; listening history is kept. */
    suspend fun unsubscribe(podcastId: String): List<String> = withContext(io) {
        val episodeIds = q.listEpisodeIdsForPodcast(podcastId).executeAsList()
        db.transaction {
            q.deleteSubscription(podcastId)
            for (id in episodeIds) {
                q.deleteDownload(id)
                q.deleteFilterMap(id)
            }
        }
        episodeIds
    }

    // --- progress ------------------------------------------------------------

    suspend fun getProgress(episodeId: String): Progress? = withContext(io) {
        q.getProgress(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Progress.serializer(), it) }
    }

    suspend fun saveProgress(
        episodeId: String,
        positionSec: Double,
        durationSec: Double,
        completionThresholdSec: Int,
        now: Long,
    ) = withContext(io) {
        val nearEnd = durationSec > 0 && positionSec >= durationSec - completionThresholdSec
        val existing = q.getProgress(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Progress.serializer(), it) }
        putProgress(
            Progress(
                episodeId = episodeId,
                positionSec = positionSec,
                durationSec = durationSec,
                played = nearEnd || (existing?.played ?: false),
                completedAt = if (nearEnd) existing?.completedAt ?: now else existing?.completedAt,
                lastPlayedAt = now,
            ),
        )
    }

    suspend fun setPlayed(episodeId: String, played: Boolean, now: Long) = withContext(io) {
        val existing = q.getProgress(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Progress.serializer(), it) }
        putProgress(
            Progress(
                episodeId = episodeId,
                positionSec = if (played) existing?.durationSec ?: 0.0 else 0.0,
                durationSec = existing?.durationSec ?: 0.0,
                played = played,
                completedAt = if (played) now else null,
                lastPlayedAt = now,
            ),
        )
    }

    suspend fun putProgress(progress: Progress) = withContext(io) {
        q.upsertProgress(progress.episodeId, progress.lastPlayedAt,
            if (progress.played) 1 else 0, json.encodeToString(Progress.serializer(), progress))
    }

    /** Most recently played, unfinished episodes — the "continue listening" row. */
    suspend fun listInProgress(limit: Int = 20): List<Progress> = withContext(io) {
        q.listProgressRecent((limit * 3).toLong()).executeAsList()
            .map { json.decodeFromString(Progress.serializer(), it) }
            .filter { !it.played && it.positionSec > 5 }
            .take(limit)
    }

    fun observeProgress(): Flow<List<Progress>> =
        q.listAllProgress().asFlow().mapToList(io).mapListJson(Progress.serializer())

    // --- downloads -----------------------------------------------------------

    suspend fun getDownload(episodeId: String): Download? = withContext(io) {
        q.getDownload(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Download.serializer(), it) }
    }

    suspend fun putDownload(download: Download) = withContext(io) {
        q.upsertDownload(download.episodeId, download.state.name, download.startedAt,
            json.encodeToString(Download.serializer(), download))
    }

    suspend fun patchDownload(episodeId: String, patch: (Download) -> Download) = withContext(io) {
        val existing = q.getDownload(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(Download.serializer(), it) } ?: return@withContext
        val updated = patch(existing)
        q.upsertDownload(updated.episodeId, updated.state.name, updated.startedAt,
            json.encodeToString(Download.serializer(), updated))
    }

    suspend fun listDownloads(state: DownloadState? = null): List<Download> = withContext(io) {
        val rows = if (state != null) q.listDownloadsByState(state.name).executeAsList()
        else q.listDownloads().executeAsList()
        rows.map { json.decodeFromString(Download.serializer(), it) }
    }

    fun observeDownloads(): Flow<List<Download>> =
        q.listDownloads().asFlow().mapToList(io).mapListJson(Download.serializer())

    // --- filter maps ---------------------------------------------------------

    suspend fun getFilterMap(episodeId: String): FilterMap? = withContext(io) {
        q.getFilterMap(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(FilterMap.serializer(), it) }
    }

    suspend fun putFilterMap(map: FilterMap) = withContext(io) {
        q.upsertFilterMap(map.episodeId, map.status.name,
            json.encodeToString(FilterMap.serializer(), map))
    }

    /**
     * The stored map only when it is a valid head start for these rules: same engine,
     * same wordlist, same profile, not failed. Anything else vouches for audio these
     * rules never examined — discarded, exactly as the TypeScript drivers do.
     */
    suspend fun getValidFilterMap(episodeId: String, profileId: String): FilterMap? {
        val stored = getFilterMap(episodeId) ?: return null
        val valid = stored.status != FilterMapStatus.FAILED &&
            stored.engineVersion == ENGINE_VERSION &&
            stored.wordlistVersion == WORDLIST_VERSION &&
            stored.profileId == profileId
        return if (valid) stored else null
    }

    // --- word overrides ------------------------------------------------------

    suspend fun listWordOverrides(): List<WordOverride> = withContext(io) {
        q.listWordOverrides().executeAsList().map { json.decodeFromString(WordOverride.serializer(), it) }
    }

    suspend fun putWordOverride(override: WordOverride) = withContext(io) {
        q.upsertWordOverride(override.term, json.encodeToString(WordOverride.serializer(), override))
    }

    suspend fun deleteWordOverride(term: String) = withContext(io) { q.deleteWordOverride(term) }

    // --- filter profiles -----------------------------------------------------

    suspend fun getFilterProfile(id: String): FilterProfile? = withContext(io) {
        q.getFilterProfile(id).executeAsOneOrNull()
            ?.let { json.decodeFromString(FilterProfile.serializer(), it) }
    }

    suspend fun listFilterProfiles(): List<FilterProfile> = withContext(io) {
        q.listFilterProfiles().executeAsList().map { json.decodeFromString(FilterProfile.serializer(), it) }
    }

    suspend fun putFilterProfile(profile: FilterProfile) = withContext(io) {
        q.upsertFilterProfile(profile.id, json.encodeToString(FilterProfile.serializer(), profile))
    }

    // --- chapters ------------------------------------------------------------

    suspend fun getCachedChapters(episodeId: String): List<Chapter>? = withContext(io) {
        q.getChapterCache(episodeId).executeAsOneOrNull()
            ?.let { json.decodeFromString(ListSerializer(Chapter.serializer()), it) }
    }

    suspend fun putCachedChapters(episodeId: String, chapters: List<Chapter>, now: Long) =
        withContext(io) {
            q.upsertChapterCache(episodeId, now,
                json.encodeToString(ListSerializer(Chapter.serializer()), chapters))
        }

    // --- play queue ----------------------------------------------------------

    suspend fun listQueue(): List<QueueItem> = withContext(io) {
        q.listQueue().executeAsList().map { QueueItem(it.episodeId, it.position.toInt(), it.addedAt) }
    }

    fun observeQueue(): Flow<List<QueueItem>> =
        q.listQueue().asFlow().mapToList(io).let { flow ->
            kotlinx.coroutines.flow.flow {
                flow.collect { rows ->
                    emit(rows.map { QueueItem(it.episodeId, it.position.toInt(), it.addedAt) })
                }
            }
        }

    /**
     * Adds an episode to the queue. Keyed by episode, so queueing something already
     * queued moves it rather than duplicating it.
     */
    suspend fun enqueueEpisode(episodeId: String, next: Boolean = false, now: Long) = withContext(io) {
        db.transaction {
            val items = q.listQueue().executeAsList()
                .map { QueueItem(it.episodeId, it.position.toInt(), it.addedAt) }
                .filter { it.episodeId != episodeId }
            val entry = QueueItem(episodeId, 0, now)
            renumber(if (next) listOf(entry) + items else items + entry)
        }
    }

    suspend fun removeFromQueue(episodeId: String) = withContext(io) {
        db.transaction {
            q.deleteQueueItem(episodeId)
            renumber(q.listQueue().executeAsList().map { QueueItem(it.episodeId, it.position.toInt(), it.addedAt) })
        }
    }

    /** Rewrites the queue to exactly this order. Drag-reorder writes the whole list. */
    suspend fun reorderQueue(episodeIds: List<String>) = withContext(io) {
        db.transaction {
            val byId = q.listQueue().executeAsList()
                .associateBy({ it.episodeId }, { QueueItem(it.episodeId, it.position.toInt(), it.addedAt) })
            renumber(episodeIds.mapNotNull { byId[it] })
        }
    }

    /** Position 0 is whatever is playing; advancing = drop the finished head, read again. */
    suspend fun headOfQueue(): String? = withContext(io) {
        q.listQueue().executeAsList().firstOrNull()?.episodeId
    }

    private fun renumber(items: List<QueueItem>) {
        items.forEachIndexed { index, item ->
            q.upsertQueueItem(item.episodeId, index.toLong(), item.addedAt)
        }
    }

    // --- kv ------------------------------------------------------------------

    suspend fun getKv(key: String): String? = withContext(io) { q.getKv(key).executeAsOneOrNull() }
    suspend fun putKv(key: String, value: String) = withContext(io) { q.putKv(key, value) }

    private fun mergePodcast(existing: Podcast, incoming: Podcast): Podcast = incoming.copy(
        // Refresh must not erase validators or history the incoming row lacks.
        etag = incoming.etag ?: existing.etag,
        lastModified = incoming.lastModified ?: existing.lastModified,
        lastFetchedAt = incoming.lastFetchedAt ?: existing.lastFetchedAt,
        lastSuccessAt = incoming.lastSuccessAt ?: existing.lastSuccessAt,
        lastFetchError = incoming.lastFetchError,
    )

    private fun <T> Flow<List<String>>.mapListJson(
        serializer: kotlinx.serialization.KSerializer<T>,
    ): Flow<List<T>> = kotlinx.coroutines.flow.flow {
        collect { rows -> emit(rows.map { json.decodeFromString(serializer, it) }) }
    }

    companion object {
        const val KEY_SETTINGS = "settings"
        /** Stamp written once the Capacitor app's state has been imported. */
        const val KEY_IMPORTED_AT = "importedAt"
    }
}
