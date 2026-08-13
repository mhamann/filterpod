package app.filterpod.shared.data

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import app.filterpod.shared.db.FilterPodDb
import app.filterpod.shared.model.Progress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BackupImportTest {

    private fun repo(): Repo {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        FilterPodDb.Schema.create(driver)
        return Repo(FilterPodDb(driver), Dispatchers.Unconfined)
    }

    /** A backup exactly as the Capacitor app writes it — extra fields and all. */
    private val tsBackup = """
    {
      "version": 1,
      "savedAt": 1785873165189,
      "podcasts": [
        {"id":"p_1lo13p1","feedUrl":"https://verge.supportingcast.fm/decoder.rss",
         "title":"Decoder: Ad-Free Edition","author":"The Verge","description":"d",
         "artworkUrl":"https://a.example/art.jpg","categories":["Technology"],
         "explicit":false,"etag":"\"abc\"","lastFetchedAt":1785873164186,
         "lastSuccessAt":1785862082832}
      ],
      "subscriptions": [
        {"podcastId":"p_1lo13p1","subscribedAt":1780000000000,"autoDownload":true,
         "autoDownloadLimit":3,"notifyOnNew":true,"sortOrder":0,"autoQueue":true,
         "filterProfileId":"off"}
      ],
      "progress": [
        {"episodeId":"e_p_1lo13p1_1d145i7","positionSec":121.5,"durationSec":2480.0,
         "played":false,"lastPlayedAt":1785873000000},
        {"episodeId":"e_p_1lo13p1_1fd096g","positionSec":2480.0,"durationSec":2480.0,
         "played":true,"completedAt":1785872000000,"lastPlayedAt":1785872000000}
      ],
      "queue": [
        {"episodeId":"e_p_1lo13p1_1d145i7","position":0,"addedAt":1785870000000},
        {"episodeId":"e_other","position":1,"addedAt":1785871000000}
      ],
      "settings": [
        {"id":"singleton","activeFilterProfileId":"standard","playbackRate":1.2,
         "skipForwardSec":30,"skipBackSec":15,"completionThresholdSec":30,
         "autoDownloadOnWifiOnly":true,"maxStorageBytes":4294967296,
         "whisperModel":"base.en","theme":"dark"}
      ],
      "filterProfiles": [
        {"id":"custom-1","name":"My profile","severities":["strong"],
         "categories":["profanity"],"padBeforeSec":0.2,"padAfterSec":0.3,
         "mergeGapSec":0.45}
      ],
      "wordOverrides": [
        {"term":"frak","action":"block","severity":"moderate","category":"custom",
         "createdAt":1785000000000}
      ]
    }
    """.trimIndent()

    @Test
    fun firstLaunchImportAdoptsEverything() = runTest {
        val repo = repo()
        repo.initialize()
        val result = BackupImporter(repo).importAtFirstLaunch(tsBackup, now = 99)

        assertNotNull(result)
        assertEquals(1, result.subscriptions)
        assertEquals(2, result.progress)
        assertEquals(2, result.queue)

        // The per-show filtering-off choice survived — the religious-show setting.
        assertEquals("off", repo.getSubscription("p_1lo13p1")!!.filterProfileId)
        // Playback position survives to the half-second.
        assertEquals(121.5, repo.getProgress("e_p_1lo13p1_1d145i7")!!.positionSec)
        // Played history survives.
        assertTrue(repo.getProgress("e_p_1lo13p1_1fd096g")!!.played)
        // Queue order survives.
        assertEquals(listOf("e_p_1lo13p1_1d145i7", "e_other"), repo.listQueue().map { it.episodeId })
        // Settings, custom profile, custom word survive.
        assertEquals(1.2, repo.getSettings().playbackRate)
        assertNotNull(repo.getFilterProfile("custom-1"))
        assertEquals(listOf("frak"), repo.listWordOverrides().map { it.term })
    }

    @Test
    fun importRunsExactlyOnce() = runTest {
        val repo = repo()
        repo.initialize()
        val importer = BackupImporter(repo)
        assertNotNull(importer.importAtFirstLaunch(tsBackup, now = 1))
        // A second launch — even with a backup present — must not re-import.
        assertNull(importer.importAtFirstLaunch(tsBackup, now = 2))
    }

    @Test
    fun newerLocalProgressAndExistingSubscriptionsWin() = runTest {
        val repo = repo()
        repo.initialize()
        // Local state newer than the backup's.
        repo.putProgress(Progress("e_p_1lo13p1_1d145i7", 500.0, 2480.0, false, null, 1785999999999))
        repo.subscribe("p_1lo13p1", now = 5)

        val result = BackupImporter(repo).apply(BackupImporter(repo).parse(tsBackup))
        assertEquals(0, result.subscriptions)
        // Newer local progress kept.
        assertEquals(500.0, repo.getProgress("e_p_1lo13p1_1d145i7")!!.positionSec)
        // The backup's older subscription must not overwrite the local one (which has
        // no filterProfileId override).
        assertNull(repo.getSubscription("p_1lo13p1")!!.filterProfileId)
    }

    @Test
    fun emptyOrMissingBackupImportsNothingButStillStamps() = runTest {
        val repo = repo()
        repo.initialize()
        val importer = BackupImporter(repo)
        // A backup with no subscriptions is a deliberate empty library, not a restore.
        val empty = """{"version":1,"savedAt":1,"subscriptions":[]}"""
        assertNull(importer.importAtFirstLaunch(empty, now = 1))
        // Stamped: later launches skip even if a fuller backup appears.
        assertNull(importer.importAtFirstLaunch(tsBackup, now = 2))
        assertEquals(0, repo.listSubscriptions().size)
    }

    @Test
    fun garbageBackupDoesNotCrashTheFirstLaunch() = runTest {
        val repo = repo()
        repo.initialize()
        assertNull(BackupImporter(repo).importAtFirstLaunch("not json {", now = 1))
        assertNull(BackupImporter(repo).importAtFirstLaunch(null, now = 1))
    }
}
