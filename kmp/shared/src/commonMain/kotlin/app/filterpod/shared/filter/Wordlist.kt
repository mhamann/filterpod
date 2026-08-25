package app.filterpod.shared.filter

import app.filterpod.shared.model.Category
import app.filterpod.shared.model.Severity

/**
 * The bundled wordlist, ported from src/features/filter/wordlist.ts.
 *
 * Terms are stored ROT13-encoded. That is obfuscation, not secrecy — the app needs
 * plaintext at runtime and this repository is public — but it keeps the list from
 * being casually readable: no wall of profanity for someone browsing the source, no
 * hits for someone searching the words, nothing for a kid to stumble across. The
 * matcher's behavior is pinned by the parity fixtures, so an encoding mistake here
 * fails tests rather than slipping through. To add a term, encode it first:
 * `echo word | tr 'A-Za-z' 'N-ZA-Mn-za-m'`.
 *
 * Entries are base forms only — inflections (-s, -ing, -ed, -er, -y) are generated at
 * compile time by [expandVariants], so this table stays readable and a new term only
 * needs one line.
 *
 * Severity drives which profiles skip a term:
 *   STRONG   — skipped by every profile that filters at all
 *   MODERATE — skipped by Standard and Family
 *   MILD     — skipped only by Family
 */
data class WordEntry(
    val term: String,
    val severity: Severity,
    val category: Category,
    /** Suppresses inflection generation where it would produce real, innocent words. */
    val noVariants: Boolean = false,
)

private val S = Severity.STRONG
private val M = Severity.MODERATE
private val L = Severity.MILD

/** ROT13, so the list is not casually readable; see the header note. */
private fun rot13(s: String): String = buildString {
    for (c in s) append(
        when (c) {
            in 'a'..'z' -> 'a' + (c - 'a' + 13) % 26
            in 'A'..'Z' -> 'A' + (c - 'A' + 13) % 26
            else -> c
        },
    )
}

private fun e(term: String, severity: Severity, category: Category, noVariants: Boolean = false) =
    WordEntry(rot13(term), severity, category, noVariants)

val WORDLIST: List<WordEntry> = listOf(
    // --- strong profanity ---
    e("shpx", S, Category.PROFANITY),
    e("zbgureshpxre", S, Category.PROFANITY),
    e("pyhfgreshpx", S, Category.PROFANITY),
    e("phag", S, Category.PROFANITY),
    e("pbpxfhpxre", S, Category.PROFANITY),

    // --- moderate profanity ---
    e("fuvg", M, Category.SCATOLOGICAL),
    e("ohyyfuvg", M, Category.SCATOLOGICAL),
    e("ubefrfuvg", M, Category.SCATOLOGICAL),
    e("qvcfuvg", M, Category.SCATOLOGICAL),
    e("ovgpu", M, Category.PROFANITY),
    e("onfgneq", M, Category.PROFANITY),
    e("nffubyr", M, Category.PROFANITY),
    e("qvpxurnq", M, Category.PROFANITY),
    e("cevpx", M, Category.PROFANITY, noVariants = true),
    e("gjng", M, Category.PROFANITY),
    e("jnaxre", M, Category.PROFANITY),
    e("obyybpxf", M, Category.PROFANITY, noVariants = true),
    e("cvff", M, Category.SCATOLOGICAL),
    e("cvffrq", M, Category.SCATOLOGICAL, noVariants = true),
    e("tbqqnza", M, Category.BLASPHEMY),
    e("tbqqnzavg", M, Category.BLASPHEMY, noVariants = true),

    // --- mild ---
    e("qnza", L, Category.PROFANITY),
    e("qnzzvg", L, Category.PROFANITY, noVariants = true),
    e("uryy", L, Category.PROFANITY, noVariants = true),
    e("penc", L, Category.SCATOLOGICAL),
    e("nff", L, Category.PROFANITY, noVariants = true),
    e("nefr", L, Category.PROFANITY),
    e("wnpxnff", L, Category.PROFANITY),
    e("qhzonff", L, Category.PROFANITY),
    e("qbhpuront", L, Category.PROFANITY),
    e("oybbql", L, Category.PROFANITY, noVariants = true),
    e("ohttre", L, Category.PROFANITY),
    e("tvg", L, Category.PROFANITY, noVariants = true),

    // --- sexual ---
    e("oybjwbo", S, Category.SEXUAL),
    e("unaqwbo", S, Category.SEXUAL),
    e("qvyqb", M, Category.SEXUAL),
    e("obare", M, Category.SEXUAL),
    e("ubeal", L, Category.SEXUAL, noVariants = true),
    e("fyhg", M, Category.SEXUAL),
    e("juber", M, Category.SEXUAL),
    e("cbea", L, Category.SEXUAL),
    e("wrexbss", M, Category.SEXUAL),

    // --- blasphemy ---
    // Only skipped by the Family profile, which is the profile whose users ask for it.
    e("wrfhf puevfg", L, Category.BLASPHEMY, noVariants = true),
    e("puevfg nyzvtugl", L, Category.BLASPHEMY, noVariants = true),
    e("bu zl tbq", L, Category.BLASPHEMY, noVariants = true),
)

/**
 * Suffix inflections applied to single-word entries.
 * the bare stem alone would miss the -ing/-ed/-er/-s forms, which are far more
 * common in speech.
 */
private val SUFFIXES = listOf("s", "es", "ed", "ing", "er", "ers", "y", "in", "in'")

private val DOUBLING_STEM = Regex("[aeiou][bcdfgklmnprstz]$")
private val VOWEL_SUFFIX = Regex("^[aeiouy]")

/** Generates inflected forms for a base term, handling final-consonant doubling. */
fun expandVariants(entry: WordEntry): List<String> {
    if (entry.noVariants || entry.term.contains(' ')) return listOf(entry.term)

    val base = entry.term
    val forms = LinkedHashSet<String>()
    forms.add(base)
    val lastChar = base.last()
    val isVowel = lastChar in "aeiou"

    for (suffix in SUFFIXES) {
        forms.add(base + suffix)
        // Plain concatenation covers most stems, but single-consonant-final stems
        // double before a vowel suffix: bug -> bugging.
        if (!isVowel && DOUBLING_STEM.containsMatchIn(base) && VOWEL_SUFFIX.containsMatchIn(suffix)) {
            forms.add(base + lastChar + suffix)
        }
        // Terms ending in `e` drop it: `douche` -> `douching`.
        if (lastChar == 'e' && VOWEL_SUFFIX.containsMatchIn(suffix)) {
            forms.add(base.dropLast(1) + suffix)
        }
    }
    return forms.toList()
}

/**
 * Words that must never be flagged, even if a variant rule produces them.
 * The guard rail that keeps the filter from eating ordinary speech.
 */
val NEVER_FLAG: Set<String> = setOf(
    "assess", "assessment", "asset", "assets", "assign", "assignment", "assist", "assistant",
    "associate", "association", "assume", "assumption", "assure", "class", "classic", "glass",
    "grass", "mass", "massive", "pass", "passage", "passed", "passenger", "password", "past",
    "brass", "bypass", "compass", "embassy", "harass", "molasses", "sassy", "bass",
    "hello", "shell", "shelter", "held", "help", "helmet", "michelle", "rachel", "shellfish",
    "analysis", "analyst", "analyze", "canal", "penalty", "peninsula", "shuttlecock",
    "cockpit", "cocktail", "peacock", "hitchcock", "scrap", "scrape", "scrapbook",
    "butter", "button", "buttress", "debut", "tribute", "attribute", "distribute",
    "title", "titan", "constitution", "institute", "substitute",
    "document", "documentary", "dock", "docket", "duck", "ducks", "dual", "dude",
    "ship", "shipping", "sheet", "sheets", "shoot", "shot", "shut", "shift", "chip",
    "fork", "folk", "flick", "frock", "truck", "trucks", "puck", "luck", "lucky",
    "pitch", "ditch", "witch", "which", "batch", "beach", "peach", "rich",
    "bat", "bad", "bass", "bust", "best", "blast", "bastion",
    "grandma", "grandpa", "damned", "damnation", "amsterdam", "dame", "dam", "dams",
)
