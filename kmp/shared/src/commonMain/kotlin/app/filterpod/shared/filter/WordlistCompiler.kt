package app.filterpod.shared.filter

import app.filterpod.shared.model.Category
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Severity
import app.filterpod.shared.model.WordOverride
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Wordlist compilation, ported from src/features/filter/matcher.ts.
 *
 * Compilation stays single-sourced here — profile filtering, inflection expansion,
 * user overrides — and the native matcher receives only the flat result at session
 * start, in exactly the JSON shape serializeCompiledWordlist produced in TypeScript.
 * The engine's WordMatcher.Compiled.fromJson parses that shape, so the two apps'
 * filtering decisions stay interchangeable, fixture for fixture.
 */

data class CompiledEntry(val term: String, val severity: Severity, val category: Category)

data class CompiledWordlist(
    /** Normalized form -> entry. Insertion-ordered, like the JS Map it mirrors. */
    val exact: LinkedHashMap<String, CompiledEntry>,
    /** Longest phrases first, as the matcher expects. */
    val phrases: List<Phrase>,
    val allowed: Set<String>,
) {
    data class Phrase(val words: List<String>, val entry: CompiledEntry)
}

private val NOT_LETTER_OR_APOSTROPHE = Regex("[^a-z']")
private val COMBINING_MARKS = Regex("[\\u0300-\\u036F]")

/**
 * Strips punctuation, lowercases, and drops diacritics — identical to the TS
 * normalizeWord and to the match-time normalizer in the engine's WordMatcher.
 */
fun normalizeWord(raw: String): String =
    nfkd(raw.lowercase())
        .replace(COMBINING_MARKS, "")
        .replace(NOT_LETTER_OR_APOSTROPHE, "")
        .replace("'", "")

fun compileWordlist(
    profile: FilterProfile,
    overrides: List<WordOverride> = emptyList(),
): CompiledWordlist {
    val exact = LinkedHashMap<String, CompiledEntry>()
    val phrases = mutableListOf<CompiledWordlist.Phrase>()
    val allowed = mutableSetOf<String>()

    val severities = profile.severities.toSet()
    val categories = profile.categories.toSet()

    fun addEntry(term: String, severity: Severity, category: Category, noVariants: Boolean) {
        if (severity !in severities || category !in categories) return
        val compiled = CompiledEntry(term, severity, category)
        if (term.contains(' ')) {
            phrases += CompiledWordlist.Phrase(term.split(' ').map(::normalizeWord), compiled)
            return
        }
        for (variant in expandVariants(WordEntry(term, severity, category, noVariants))) {
            val normalized = normalizeWord(variant)
            // Never let a generated inflection shadow an ordinary English word.
            if (normalized.isEmpty() || normalized in NEVER_FLAG) continue
            exact[normalized] = compiled
        }
    }

    for (entry in WORDLIST) addEntry(entry.term, entry.severity, entry.category, entry.noVariants)

    // User overrides are applied last so they win over the bundled list.
    for (override in overrides) {
        val normalized = normalizeWord(override.term)
        if (normalized.isEmpty() && !override.term.contains(' ')) continue
        if (override.action == WordOverride.ACTION_ALLOW) {
            allowed += normalized
            exact.remove(normalized)
        } else {
            addEntry(override.term, override.severity, override.category, noVariants = false)
        }
    }

    return CompiledWordlist(
        exact = exact,
        phrases = phrases.sortedByDescending { it.words.size },
        allowed = allowed,
    )
}

private fun Severity.wire(): String = when (this) {
    Severity.MILD -> "mild"; Severity.MODERATE -> "moderate"; Severity.STRONG -> "strong"
}

private fun Category.wire(): String = when (this) {
    Category.PROFANITY -> "profanity"; Category.SEXUAL -> "sexual"; Category.SLUR -> "slur"
    Category.BLASPHEMY -> "blasphemy"; Category.SCATOLOGICAL -> "scatological"
    Category.CUSTOM -> "custom"
}

/**
 * The engine-config JSON: byte-compatible with the TypeScript
 * serializeCompiledWordlist output that WordMatcher.Compiled.fromJson parses.
 * NEVER_FLAG rides along because the collapse-repeats fallback consults it at
 * match time.
 */
fun CompiledWordlist.toEngineJson(): JsonObject = JsonObject(
    mapOf(
        "exact" to JsonArray(
            exact.map { (normalized, entry) ->
                JsonObject(
                    mapOf(
                        "normalized" to JsonPrimitive(normalized),
                        "term" to JsonPrimitive(entry.term),
                        "severity" to JsonPrimitive(entry.severity.wire()),
                        "category" to JsonPrimitive(entry.category.wire()),
                    ),
                )
            },
        ),
        "phrases" to JsonArray(
            phrases.map { phrase ->
                JsonObject(
                    mapOf(
                        "words" to JsonArray(phrase.words.map { JsonPrimitive(it) }),
                        "term" to JsonPrimitive(phrase.entry.term),
                        "severity" to JsonPrimitive(phrase.entry.severity.wire()),
                        "category" to JsonPrimitive(phrase.entry.category.wire()),
                    ),
                )
            },
        ),
        "allowed" to JsonArray(allowed.map { JsonPrimitive(it) }),
        "neverFlag" to JsonArray(NEVER_FLAG.map { JsonPrimitive(it) }),
    ),
)
