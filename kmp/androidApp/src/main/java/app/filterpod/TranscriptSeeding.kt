package app.filterpod

import app.filterpod.shared.filter.compileWordlist
import app.filterpod.shared.filter.fetchTranscript
import app.filterpod.shared.model.AnalyzedRange
import app.filterpod.shared.model.Episode
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.WordOverride
import app.filterpod.shared.net.Http

/**
 * What a publisher transcript settles before any ASR runs — the Kotlin home of
 * computeTranscriptSeed from liveFilter.ts.
 *
 * Word-level transcripts settle the episode outright. Cue-level ones can prove it
 * clean — the best possible outcome: no ASR, no wait, no battery — or narrow the
 * ASR to just the suspect windows. The engine only ever runs ASR chunks; this is
 * the piece that decides how few of them are needed.
 */
class TranscriptSeeding(private val http: Http) : PlaybackController.TranscriptSeeder {

    override suspend fun seed(
        episode: Episode,
        profile: FilterProfile,
        overrides: List<WordOverride>,
        durationSec: Double,
    ): PlaybackController.TranscriptSeed? {
        if (episode.transcripts.isEmpty()) return null
        val transcript = fetchTranscript(http, episode.transcripts) ?: return null

        val compiled = compileWordlist(profile, overrides).toMatcher()
        val fullRange = AnalyzedRange(0.0, if (durationSec > 0) durationSec else MAX_SEC)

        transcript.words?.takeIf { it.isNotEmpty() }?.let { words ->
            val timed = words.map { TimedWord(it.word, it.startSec, it.endSec) }
            val matches = WordMatcher.matchWords(SpanMath.sortAndDedupe(timed), compiled)
            val spans = SpanMath.spansFromMatches(
                matches, profile.padBeforeSec, profile.padAfterSec, profile.mergeGapSec,
                durationSec.takeIf { it > 0 },
            )
            return PlaybackController.TranscriptSeed(
                spans = spans.map { it.toModel() },
                ranges = listOf(fullRange),
                source = "transcript-only",
                complete = true,
            )
        }

        if (transcript.cues.isEmpty()) return null

        // Cue timing is far too coarse to cut a single word, but it is plenty to tell
        // which stretches are worth transcribing.
        val flagged = transcript.cues.filter { cue ->
            val tokens = cue.text.split(WHITESPACE).filter { it.isNotEmpty() }
            val timed = tokens.mapIndexed { index, token ->
                TimedWord(token, cue.startSec + index * 0.1, cue.startSec + (index + 1) * 0.1)
            }
            WordMatcher.matchWords(timed, compiled).isNotEmpty()
        }

        if (flagged.isEmpty()) {
            return PlaybackController.TranscriptSeed(
                spans = emptyList(), ranges = listOf(fullRange),
                source = "transcript-only", complete = true,
            )
        }

        // Cues do not tile the timeline exactly; small gaps between them are silence,
        // not unexamined audio.
        val covered = SpanMath.mergeRanges(
            transcript.cues.map { Range(it.startSec, it.endSec + CUE_GAP_TOLERANCE_SEC) },
        )
        val suspect = SpanMath.mergeRanges(
            flagged.map {
                Range(maxOf(0.0, it.startSec - CUE_WINDOW_PAD_SEC), it.endSec + CUE_WINDOW_PAD_SEC)
            },
        )

        // Analyzed = vouched for by the transcript, minus the bits needing a closer look.
        return PlaybackController.TranscriptSeed(
            spans = emptyList(),
            ranges = SpanMath.subtractRanges(covered, suspect).map { it.toModel() },
            source = "transcript-narrowed-asr",
            complete = false,
        )
    }

    companion object {
        private val WHITESPACE = Regex("\\s+")
        private const val CUE_WINDOW_PAD_SEC = 4.0
        private const val CUE_GAP_TOLERANCE_SEC = 3.0
        private const val MAX_SEC = 9.0e15
    }
}
