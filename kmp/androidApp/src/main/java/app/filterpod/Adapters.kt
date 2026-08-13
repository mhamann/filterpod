package app.filterpod

import app.filterpod.shared.filter.CompiledWordlist
import app.filterpod.shared.filter.NEVER_FLAG
import app.filterpod.shared.model.AnalyzedRange
import app.filterpod.shared.model.Category
import app.filterpod.shared.model.Severity
import app.filterpod.shared.model.FilterSpan as ModelSpan

/**
 * Conversions between the shared module's domain types and the engine's wire types.
 *
 * The engine keeps its own small span/range classes (they predate the shared module
 * and are pinned by the parity fixtures); these adapters are the entire boundary. The
 * Capacitor app crossed this boundary by serializing JSON over a bridge — here it is
 * a direct object mapping, and the compiled wordlist never touches JSON at all.
 */

fun CompiledWordlist.toMatcher(): WordMatcher.Compiled = WordMatcher.Compiled(
    exact = exact.mapValues { (_, entry) ->
        WordMatcher.Entry(entry.term, entry.severity.wire(), entry.category.wire())
    },
    phrases = phrases.map { phrase ->
        WordMatcher.Phrase(
            phrase.words,
            WordMatcher.Entry(phrase.entry.term, phrase.entry.severity.wire(), phrase.entry.category.wire()),
        )
    },
    allowed = allowed,
    neverFlag = NEVER_FLAG,
)

fun Severity.wire(): String = when (this) {
    Severity.MILD -> "mild"; Severity.MODERATE -> "moderate"; Severity.STRONG -> "strong"
}

fun Category.wire(): String = when (this) {
    Category.PROFANITY -> "profanity"; Category.SEXUAL -> "sexual"; Category.SLUR -> "slur"
    Category.BLASPHEMY -> "blasphemy"; Category.SCATOLOGICAL -> "scatological"
    Category.CUSTOM -> "custom"
}

private fun severityOf(wire: String): Severity = when (wire) {
    "mild" -> Severity.MILD; "strong" -> Severity.STRONG; else -> Severity.MODERATE
}

private fun categoryOf(wire: String): Category = when (wire) {
    "sexual" -> Category.SEXUAL; "slur" -> Category.SLUR; "blasphemy" -> Category.BLASPHEMY
    "scatological" -> Category.SCATOLOGICAL; "custom" -> Category.CUSTOM
    else -> Category.PROFANITY
}

fun EngineSpan.toModel(): ModelSpan =
    ModelSpan(startSec, endSec, severityOf(severity), categoryOf(category), terms)

fun ModelSpan.toEngine(): EngineSpan =
    EngineSpan(startSec, endSec, severity.wire(), category.wire(), terms)

fun Range.toModel(): AnalyzedRange = AnalyzedRange(startSec, endSec)

fun AnalyzedRange.toEngine(): Range = Range(startSec, endSec)

/** Engine spans in the ms-based form the playback service's skip loop consumes. */
fun EngineSpan.toServiceSpan(): FilterSpan = FilterSpan(
    startMs = (startSec * 1000).toLong(),
    endMs = (endSec * 1000).toLong(),
    severity = severity,
    category = category,
)
