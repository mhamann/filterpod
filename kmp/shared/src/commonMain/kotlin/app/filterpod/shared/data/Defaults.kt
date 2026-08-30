package app.filterpod.shared.data

import app.filterpod.shared.model.Category
import app.filterpod.shared.model.FilterProfile
import app.filterpod.shared.model.Settings
import app.filterpod.shared.model.Severity

/**
 * Built-in filter profiles, ported from src/data/defaults.ts.
 *
 * Padding is deliberately asymmetric and generous: whisper word timestamps carry
 * roughly 100-400ms of error, and the failure that matters is clipping the front of a
 * flagged word — so more pad after than before, accepting a sliver of clean audio lost
 * around each skip.
 */
val DEFAULT_PROFILES: List<FilterProfile> = listOf(
    FilterProfile(
        id = "family",
        name = "Family",
        severities = listOf(Severity.MILD, Severity.MODERATE, Severity.STRONG),
        categories = listOf(
            Category.PROFANITY, Category.SEXUAL, Category.SLUR,
            Category.BLASPHEMY, Category.SCATOLOGICAL, Category.CUSTOM,
        ),
        padBeforeSec = 0.22,
        padAfterSec = 0.32,
        mergeGapSec = 0.6,
    ),
    FilterProfile(
        id = "standard",
        name = "Standard",
        // `scatological` belongs here: it covers the most
        // common moderate profanity in podcast speech. Only `blasphemy` is left to
        // Family.
        severities = listOf(Severity.MODERATE, Severity.STRONG),
        categories = listOf(
            Category.PROFANITY, Category.SEXUAL, Category.SLUR,
            Category.SCATOLOGICAL, Category.CUSTOM,
        ),
        padBeforeSec = 0.2,
        padAfterSec = 0.3,
        mergeGapSec = 0.45,
    ),
    FilterProfile(
        id = "strong-only",
        name = "Strong only",
        severities = listOf(Severity.STRONG),
        categories = listOf(
            Category.PROFANITY, Category.SEXUAL, Category.SLUR,
            Category.SCATOLOGICAL, Category.CUSTOM,
        ),
        padBeforeSec = 0.18,
        padAfterSec = 0.28,
        mergeGapSec = 0.35,
    ),
    FilterProfile(
        id = "off",
        name = "Off",
        severities = emptyList(),
        categories = emptyList(),
        padBeforeSec = 0.0,
        padAfterSec = 0.0,
        mergeGapSec = 0.0,
    ),
)

val DEFAULT_SETTINGS = Settings()

/**
 * Bumping either constant invalidates existing filter maps so they regenerate.
 * Values match the TypeScript app: maps imported at cutover must stay valid.
 *
 * 4: every map before this one was timed against a decode that could start seconds
 * away from where it claimed. Their spans point at the wrong audio — the word plays
 * and clean speech just after it is cut instead — so they cannot be trusted as a head
 * start, however complete they look.
 */
const val ENGINE_VERSION = "4"
const val WORDLIST_VERSION = "1"
