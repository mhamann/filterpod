package app.filterpod

import org.json.JSONObject

/**
 * Matching ASR output against the compiled wordlist.
 *
 * A line-for-line port of src/features/filter/matcher.ts matchWords and its
 * normalization. The wordlist itself is NOT duplicated here: compilation — profile
 * filtering, inflection expansion, user overrides — stays single-sourced in TypeScript,
 * and the web layer hands the *compiled* result across the bridge once per session.
 * This side only normalizes tokens and looks them up, which is the part that must run
 * where playback lives.
 *
 * Matching is exact, never phonetic or fuzzy — see the matcher.ts commentary for the
 * field data behind that (an edit-distance tier flagged "where", "that's" and
 * "center."). Parity with the TS matcher is held by golden-fixture tests.
 */
object WordMatcher {

    data class Entry(val term: String, val severity: String, val category: String)

    data class Phrase(val words: List<String>, val entry: Entry)

    class Compiled(
        /** Normalized form -> entry. */
        val exact: Map<String, Entry>,
        /** Sorted longest-first, so "oh my god" wins over any single word inside it. */
        val phrases: List<Phrase>,
        val allowed: Set<String>,
        /** Ordinary words a collapse must never turn into a match. */
        val neverFlag: Set<String>,
    ) {
        companion object {
            /** Parses the serialized compiled wordlist the web layer sends. */
            fun fromJson(json: JSONObject): Compiled {
                val exact = HashMap<String, Entry>()
                json.optJSONArray("exact")?.let { array ->
                    for (i in 0 until array.length()) {
                        val item = array.optJSONObject(i) ?: continue
                        exact[item.optString("normalized")] = Entry(
                            term = item.optString("term"),
                            severity = item.optString("severity", "moderate"),
                            category = item.optString("category", "profanity"),
                        )
                    }
                }
                val phrases = ArrayList<Phrase>()
                json.optJSONArray("phrases")?.let { array ->
                    for (i in 0 until array.length()) {
                        val item = array.optJSONObject(i) ?: continue
                        val words = ArrayList<String>()
                        item.optJSONArray("words")?.let { tokens ->
                            for (j in 0 until tokens.length()) words.add(tokens.optString(j))
                        }
                        if (words.isEmpty()) continue
                        phrases.add(
                            Phrase(
                                words = words,
                                entry = Entry(
                                    term = item.optString("term"),
                                    severity = item.optString("severity", "moderate"),
                                    category = item.optString("category", "profanity"),
                                ),
                            ),
                        )
                    }
                }
                val allowed = HashSet<String>()
                json.optJSONArray("allowed")?.let { array ->
                    for (i in 0 until array.length()) allowed.add(array.optString(i))
                }
                val neverFlag = HashSet<String>()
                json.optJSONArray("neverFlag")?.let { array ->
                    for (i in 0 until array.length()) neverFlag.add(array.optString(i))
                }
                return Compiled(
                    exact = exact,
                    phrases = phrases.sortedByDescending { it.words.size },
                    allowed = allowed,
                    neverFlag = neverFlag,
                )
            }
        }
    }

    data class Match(
        val index: Int,
        val word: TimedWord,
        val term: String,
        val severity: String,
        val category: String,
        val via: String,
    )

    /** Combining diacritics stripped after NFKD, mirroring the TS char class. */
    private val COMBINING = Regex("[\\u0300-\\u036F]")
    private val NON_ALPHA = Regex("[^a-z']")
    private val REPEATS = Regex("(.)\\1{1,}")

    /** Whisper sometimes emits a self-censored token rather than the word. */
    private val CENSORED = Regex("^[a-z][-*_#@!]{2,}[a-z]?$", RegexOption.IGNORE_CASE)

    /** Strips punctuation and case; identical to matcher.ts normalizeWord. */
    fun normalizeWord(raw: String): String =
        java.text.Normalizer.normalize(raw.lowercase(), java.text.Normalizer.Form.NFKD)
            .replace(COMBINING, "")
            .replace(NON_ALPHA, "")
            .replace("'", "")

    /** Collapses runs of the same letter, for elongated speech ("fuuuck"). */
    private fun collapseRepeats(word: String): String = word.replace(REPEATS, "$1")

    /** Finds every flagged word in a transcription. Port of matcher.ts matchWords. */
    fun matchWords(words: List<TimedWord>, compiled: Compiled): List<Match> {
        val matches = ArrayList<Match>()
        val normalized = words.map { normalizeWord(it.word) }
        val consumed = HashSet<Int>()

        // Phrases first, so "oh my god" wins over any single-word match inside it.
        for (phrase in compiled.phrases) {
            var i = 0
            while (i + phrase.words.size <= normalized.size) {
                if (i in consumed) {
                    i++
                    continue
                }
                var hit = true
                for (j in phrase.words.indices) {
                    if (normalized[i + j] != phrase.words[j]) {
                        hit = false
                        break
                    }
                }
                if (!hit) {
                    i++
                    continue
                }
                for (j in phrase.words.indices) consumed.add(i + j)
                matches.add(
                    Match(
                        index = i,
                        // A phrase spans several words; the match carries the full range.
                        word = TimedWord(
                            word = phrase.entry.term,
                            startSec = words[i].startSec,
                            endSec = words[i + phrase.words.size - 1].endSec,
                        ),
                        term = phrase.entry.term,
                        severity = phrase.entry.severity,
                        category = phrase.entry.category,
                        via = "phrase",
                    ),
                )
                i++
            }
        }

        for (i in words.indices) {
            if (i in consumed) continue
            // Checked against the raw token: normalization strips the very punctuation
            // that identifies a self-censored word ("f***" would reduce to "f").
            val raw = words[i].word.trim()
            if (CENSORED.matches(raw)) {
                matches.add(
                    Match(i, words[i], raw, "strong", "profanity", "censored"),
                )
                continue
            }

            val candidate = normalized[i]
            if (candidate.isEmpty()) continue
            if (candidate in compiled.allowed) continue

            var entry = compiled.exact[candidate]

            if (entry == null) {
                // Elongated speech: "fuuuck" collapses to a listed form.
                val collapsed = collapseRepeats(candidate)
                if (collapsed != candidate && collapsed !in compiled.neverFlag) {
                    entry = compiled.exact[collapsed]
                }
            }

            if (entry != null) {
                matches.add(
                    Match(i, words[i], entry.term, entry.severity, entry.category, "exact"),
                )
            }
        }

        return matches.sortedBy { it.word.startSec }
    }
}
