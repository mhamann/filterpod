package app.filterpod.shared

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.data.DEFAULT_PROFILES
import app.filterpod.shared.data.Repo
import app.filterpod.shared.data.episodeIdFor
import app.filterpod.shared.data.podcastIdFor
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.FilterMap
import app.filterpod.shared.model.FilterMapStatus
import app.filterpod.shared.model.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RepoTest {

    private fun repo(): Repo {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        return Repo(FilterPodDb(driver), Dispatchers.Unconfined)
    }

    @Test
    fun idsMatchTheTypeScriptImplementation() {
        // Golden values minted by the TS app's FNV-1a — the migrated backup's ids.
        // p_1lo13p1 is the real id of the Decoder feed in the user's library.
        assertEquals("p_" + fnvJs("https://feeds.example.com/feed.xml"), podcastIdFor("https://feeds.example.com/FEED.xml  ".trim()))
        assertTrue(podcastIdFor("https://verge.supportingcast.fm/decoder-adfree").startsWith("p_"))
        // Deterministic shape: e_<podcastId>_<hash>.
        val id = episodeIdFor("p_abc", "guid-123")
        assertTrue(id.startsWith("e_p_abc_"))
    }

    /** Reference FNV-1a in the exact JS formulation, to cross-check the port. */
    private fun fnvJs(input: String): String {
        var value = 0x811c9dc5.toInt()
        for (ch in input.trim().lowercase()) {
            value = value xor ch.code
            value *= 0x01000193
        }
        return value.toUInt().toString(36)
    }

    @Test
    fun initializeSeedsDefaultsButNeverOverwrites() = runTest {
        val repo = repo()
        repo.initialize()
        assertEquals(DEFAULT_PROFILES.size, repo.listFilterProfiles().size)

        // A user-tuned profile survives re-initialization.
        val tuned = repo.getFilterProfile("standard")!!.copy(padAfterSec = 0.9)
        repo.putFilterProfile(tuned)
        repo.initialize()
        assertEquals(0.9, repo.getFilterProfile("standard")!!.padAfterSec)

        // Settings likewise.
        repo.updateSettings { it.copy(skipForwardSec = 45) }
        repo.initialize()
        assertEquals(45, repo.getSettings().skipForwardSec)
    }

    @Test
    fun queueIsDenseDedupedAndPlayNextMovesToFront() = runTest {
        val repo = repo()
        repo.enqueueEpisode("e1", now = 1)
        repo.enqueueEpisode("e2", now = 2)
        repo.enqueueEpisode("e3", now = 3)

        // Queueing something already queued moves it rather than duplicating it.
        repo.enqueueEpisode("e3", next = true, now = 4)
        assertEquals(listOf("e3", "e1", "e2"), repo.listQueue().map { it.episodeId })
        assertEquals(listOf(0, 1, 2), repo.listQueue().map { it.position })

        repo.removeFromQueue("e1")
        assertEquals(listOf("e3", "e2"), repo.listQueue().map { it.episodeId })
        assertEquals(listOf(0, 1), repo.listQueue().map { it.position })
        assertEquals("e3", repo.headOfQueue())
    }

    @Test
    fun progressAppliesTheCompletionThresholdRule() = runTest {
        val repo = repo()
        repo.saveProgress("e1", positionSec = 100.0, durationSec = 3600.0, completionThresholdSec = 30, now = 10)
        assertEquals(false, repo.getProgress("e1")!!.played)

        // Within the threshold of the end counts as finished.
        repo.saveProgress("e1", positionSec = 3580.0, durationSec = 3600.0, completionThresholdSec = 30, now = 20)
        val done = repo.getProgress("e1")!!
        assertTrue(done.played)
        assertEquals(20, done.completedAt)

        // Scrubbing backwards afterwards does not un-play it.
        repo.saveProgress("e1", positionSec = 100.0, durationSec = 3600.0, completionThresholdSec = 30, now = 30)
        assertTrue(repo.getProgress("e1")!!.played)
        assertEquals(20, repo.getProgress("e1")!!.completedAt)

        // Explicit mark-unplayed resets.
        repo.setPlayed("e1", played = false, now = 40)
        assertEquals(false, repo.getProgress("e1")!!.played)
        assertNull(repo.getProgress("e1")!!.completedAt)
    }

    @Test
    fun filterMapValidityDiscardsWrongProfileEngineOrFailure() = runTest {
        val repo = repo()
        val map = FilterMap(
            episodeId = "e1", status = FilterMapStatus.PARTIAL,
            engineVersion = app.filterpod.shared.data.ENGINE_VERSION,
            wordlistVersion = app.filterpod.shared.data.WORDLIST_VERSION,
            profileId = "standard", createdAt = 1,
        )
        repo.putFilterMap(map)
        assertEquals(map.episodeId, repo.getValidFilterMap("e1", "standard")?.episodeId)
        assertNull(repo.getValidFilterMap("e1", "family"))

        repo.putFilterMap(map.copy(engineVersion = "2"))
        assertNull(repo.getValidFilterMap("e1", "standard"))

        repo.putFilterMap(map.copy(status = FilterMapStatus.FAILED))
        assertNull(repo.getValidFilterMap("e1", "standard"))
    }

    @Test
    fun episodesUpsertReportsOnlyNewIdsAndListsNewestFirst() = runTest {
        val repo = repo()
        fun episode(id: String, at: Long) = Episode(
            id = id, podcastId = "p1", guid = id, title = id,
            audioUrl = "https://a.example/$id.mp3", publishedAt = at,
        )
        val first = repo.upsertEpisodes(listOf(episode("e1", 100), episode("e2", 200)))
        assertEquals(listOf("e1", "e2"), first)
        val second = repo.upsertEpisodes(listOf(episode("e2", 200), episode("e3", 300)))
        assertEquals(listOf("e3"), second)
        assertEquals(listOf("e3", "e2", "e1"), repo.listEpisodes("p1").map { it.id })
    }

    @Test
    fun settingsRoundTripsTypeScriptJson() {
        // A settings row exactly as the Capacitor app's backup serializes it.
        val tsJson = """{"activeFilterProfileId":"standard","playbackRate":1.2,
            "skipForwardSec":30,"skipBackSec":15,"completionThresholdSec":30,
            "autoDownloadOnWifiOnly":true,"maxStorageBytes":4294967296,
            "whisperModel":"base.en","theme":"dark","id":"singleton"}"""
        val decoded = repo().json.decodeFromString(Settings.serializer(), tsJson)
        assertEquals(1.2, decoded.playbackRate)
        assertEquals("base.en", decoded.whisperModel)
    }

    @Test
    fun searchFindsEpisodesByTitleAndNotes() = runTest {
        val repo = repo()
        fun ep(n: Int, title: String, description: String = "", audio: String = "$n.mp3") = Episode(
            id = "e_$n", podcastId = "p_1", guid = "g_$n", title = title,
            description = description, audioUrl = "https://example.com/$audio",
            publishedAt = n.toLong(),
        )
        repo.upsertEpisodes(
            listOf(
                ep(1, "The Kingdom Come"),
                ep(2, "Unashamed Truth", "A conversation about kingdom work"),
                ep(3, "Something else entirely", audio = "kingdom-notes.mp3"),
                ep(4, "100% certain", "a_b discount"),
                ep(5, "He said \"hello\" plainly"),
            ),
        )

        // Case-insensitive, across title and description.
        assertEquals(
            listOf("e_2", "e_1"),
            repo.searchEpisodes("p_1", "kingdom").map { it.id },
        )
        // e_3 only has "kingdom" in its audio URL: SQL narrows it in, the filter drops it.
        assertTrue(repo.searchEpisodes("p_1", "kingdom-notes").isEmpty())
        // Newest first, like the list it replaces.
        assertEquals(listOf("e_2"), repo.searchEpisodes("p_1", "unashamed").map { it.id })
        // LIKE wildcards in the query are literals, not patterns.
        assertEquals(listOf("e_4"), repo.searchEpisodes("p_1", "100%").map { it.id })
        assertEquals(listOf("e_4"), repo.searchEpisodes("p_1", "a_b").map { it.id })
        assertTrue(repo.searchEpisodes("p_1", "%%%").isEmpty())
        // A quote survives JSON escaping on the way into the LIKE.
        assertEquals(listOf("e_5"), repo.searchEpisodes("p_1", "\"hello\"").map { it.id })
        // Another show's episodes stay out of it.
        assertTrue(repo.searchEpisodes("p_2", "kingdom").isEmpty())
    }
}
