package app.filterpod.shared.filter

import app.filterpod.shared.model.Category
import app.filterpod.shared.model.Severity

/**
 * The bundled wordlist, ported from src/features/filter/wordlist.ts.
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

val WORDLIST: List<WordEntry> = listOf(
    // --- strong profanity ---
    WordEntry("shpx", S, Category.PROFANITY),
    WordEntry("mothershpxer", S, Category.PROFANITY),
    WordEntry("clustershpx", S, Category.PROFANITY),
    WordEntry("phag", S, Category.PROFANITY),
    WordEntry("pbpxfhpxre", S, Category.PROFANITY),

    // --- moderate profanity ---
    WordEntry("fuvg", M, Category.SCATOLOGICAL),
    WordEntry("bullfuvg", M, Category.SCATOLOGICAL),
    WordEntry("horsefuvg", M, Category.SCATOLOGICAL),
    WordEntry("dipfuvg", M, Category.SCATOLOGICAL),
    WordEntry("ovgpu", M, Category.PROFANITY),
    WordEntry("onfgneq", M, Category.PROFANITY),
    WordEntry("nffubyr", M, Category.PROFANITY),
    WordEntry("qvpxurnq", M, Category.PROFANITY),
    WordEntry("cevpx", M, Category.PROFANITY, noVariants = true),
    WordEntry("gjng", M, Category.PROFANITY),
    WordEntry("jnaxre", M, Category.PROFANITY),
    WordEntry("obyybpxf", M, Category.PROFANITY, noVariants = true),
    WordEntry("cvff", M, Category.SCATOLOGICAL),
    WordEntry("cvffed", M, Category.SCATOLOGICAL, noVariants = true),
    WordEntry("tbqqnza", M, Category.BLASPHEMY),
    WordEntry("tbqqnzait", M, Category.BLASPHEMY, noVariants = true),

    // --- mild ---
    WordEntry("qnza", L, Category.PROFANITY),
    WordEntry("dammit", L, Category.PROFANITY, noVariants = true),
    WordEntry("uryy", L, Category.PROFANITY, noVariants = true),
    WordEntry("penc", L, Category.SCATOLOGICAL),
    WordEntry("nff", L, Category.PROFANITY, noVariants = true),
    WordEntry("nefr", L, Category.PROFANITY),
    WordEntry("wnpxnff", L, Category.PROFANITY),
    WordEntry("qhzonff", L, Category.PROFANITY),
    WordEntry("qbhpuront", L, Category.PROFANITY),
    WordEntry("bloody", L, Category.PROFANITY, noVariants = true),
    WordEntry("bugger", L, Category.PROFANITY),
    WordEntry("git", L, Category.PROFANITY, noVariants = true),

    // --- sexual ---
    WordEntry("oybjwbo", S, Category.SEXUAL),
    WordEntry("unaqwbo", S, Category.SEXUAL),
    WordEntry("qvyqb", M, Category.SEXUAL),
    WordEntry("obare", M, Category.SEXUAL),
    WordEntry("ubeal", L, Category.SEXUAL, noVariants = true),
    WordEntry("fyhg", M, Category.SEXUAL),
    WordEntry("juber", M, Category.SEXUAL),
    WordEntry("cbea", L, Category.SEXUAL),
    WordEntry("wrexbss", M, Category.SEXUAL),

    // --- blasphemy ---
    // Only skipped by the Family profile, which is the profile whose users ask for it.
    WordEntry("jesus christ", L, Category.BLASPHEMY, noVariants = true),
    WordEntry("christ almighty", L, Category.BLASPHEMY, noVariants = true),
    WordEntry("oh my god", L, Category.BLASPHEMY, noVariants = true),
)

/**
 * Suffix inflections applied to single-word entries.
 * `shpx` alone would miss `shpxing`, `shpxed`, `shpxer`, `shpxs` — far more common in
 * speech than the bare stem.
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
        // fuvg -> fuvgting is handled by the plain concat, but single-consonant-final
        // stems double before a vowel suffix: bug -> bugging.
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
