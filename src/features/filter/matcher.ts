import type { Category, FilterProfile, Severity, TimedWord } from '@/core/types'
import type { WordOverride } from '@/data/db'
import { NEVER_FLAG, WORDLIST, expandVariants, type WordEntry } from './wordlist'

/**
 * Matching ASR output against the wordlist.
 *
 * A note on why this is exact-match rather than phonetic: phonetic matching is the
 * obvious first instinct, and it is wrong here. Whisper emits well-spelled real words,
 * so there is no leetspeak to defeat — and the near-homophones of profanity are almost
 * all innocent high-frequency words (duck, ship, sheet, fork, puck, witch). A Soundex or
 * Metaphone tier would flag those constantly, and a podcast player that randomly eats
 * the word "duck" is worse than one that misses an occasional swear.
 *
 * So matching is: normalize -> exact lookup over generated inflections -> phrases,
 * with an optional tightly-guarded edit-distance tier for the aggressive profile.
 */

export interface MatchedWord {
  index: number
  word: TimedWord
  term: string
  severity: Severity
  category: Category
  /** How the match was made, surfaced in the review UI. */
  via: 'exact' | 'phrase' | 'fuzzy' | 'censored'
}

interface CompiledEntry {
  term: string
  severity: Severity
  category: Category
}

export interface CompiledWordlist {
  /** Normalized form -> entry. */
  exact: Map<string, CompiledEntry>
  phrases: Array<{ words: string[]; entry: CompiledEntry }>
  allowed: Set<string>
}

/**
 * Strips punctuation, lowercases, and collapses letters repeated three or more times
 * ("fuuuuck" -> "fuuck" -> handled by the repeat pass below).
 */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z']/g, '')
    .replace(/'/g, '')
}

/** Collapses runs of the same letter to a single one, for elongated speech. */
function collapseRepeats(word: string): string {
  return word.replace(/(.)\1{1,}/g, '$1')
}

/** Whisper sometimes emits a self-censored token rather than the word. */
const CENSORED_PATTERN = /^[a-z][-*_#@!]{2,}[a-z]?$/i

export function compileWordlist(
  profile: FilterProfile,
  overrides: WordOverride[] = [],
): CompiledWordlist {
  const exact = new Map<string, CompiledEntry>()
  const phrases: CompiledWordlist['phrases'] = []
  const allowed = new Set<string>()

  const severities = new Set(profile.severities)
  const categories = new Set(profile.categories)
  const inProfile = (entry: WordEntry | WordOverride) =>
    severities.has(entry.severity) && categories.has(entry.category)

  const addEntry = (entry: WordEntry) => {
    if (!inProfile(entry)) return
    const compiled: CompiledEntry = {
      term: entry.term,
      severity: entry.severity,
      category: entry.category,
    }
    if (entry.term.includes(' ')) {
      phrases.push({ words: entry.term.split(' ').map(normalizeWord), entry: compiled })
      return
    }
    for (const variant of expandVariants(entry)) {
      const normalized = normalizeWord(variant)
      // Never let a generated inflection shadow an ordinary English word.
      if (!normalized || NEVER_FLAG.has(normalized)) continue
      exact.set(normalized, compiled)
    }
  }

  for (const entry of WORDLIST) addEntry(entry)

  // User overrides are applied last so they win over the bundled list.
  for (const override of overrides) {
    const normalized = normalizeWord(override.term)
    if (!normalized && !override.term.includes(' ')) continue
    if (override.action === 'allow') {
      allowed.add(normalized)
      exact.delete(normalized)
    } else {
      addEntry({ term: override.term, severity: override.severity, category: override.category })
    }
  }

  phrases.sort((a, b) => b.words.length - a.words.length)
  return { exact, phrases, allowed }
}

/**
 * The compiled wordlist, serialized for the native engine.
 *
 * Compilation stays single-sourced here — profile filtering, inflection expansion,
 * user overrides — and the Kotlin matcher receives only this flat result at session
 * start. NEVER_FLAG rides along because the collapse-repeats fallback consults it at
 * match time. The Kotlin parser (WordMatcher.Compiled.fromJson) and the parity
 * fixtures both depend on this exact shape.
 */
export function serializeCompiledWordlist(compiled: CompiledWordlist): {
  exact: Array<{ normalized: string; term: string; severity: Severity; category: Category }>
  phrases: Array<{ words: string[]; term: string; severity: Severity; category: Category }>
  allowed: string[]
  neverFlag: string[]
} {
  return {
    exact: [...compiled.exact.entries()].map(([normalized, entry]) => ({
      normalized,
      ...entry,
    })),
    phrases: compiled.phrases.map((phrase) => ({ words: phrase.words, ...phrase.entry })),
    allowed: [...compiled.allowed],
    neverFlag: [...NEVER_FLAG],
  }
}

/**
 * There is deliberately no fuzzy/edit-distance tier.
 *
 * An earlier version had one, tightly guarded: candidate at least 5 characters, not on
 * the never-flag list, within edit distance 1 of a listed term of similar length. Run
 * against seven minutes of real podcast audio it produced nine matches, all of them
 * false: "where" and "whole" -> whore, "that's" -> twat, "Suckers." -> fuck,
 * "center." -> cunt. Exact matching over the same audio produced zero.
 *
 * The problem is not the guard being too loose. Ordinary English words sit at edit
 * distance 1 from profanity, so no exclusion list can enumerate the collisions — and a
 * player that randomly deletes the word "where" is worse than one that misses a swear.
 * Recall is instead improved by adding terms and inflections to the wordlist, which
 * cannot misfire this way.
 */

/** Finds every flagged word in a transcription. */
export function matchWords(words: TimedWord[], compiled: CompiledWordlist): MatchedWord[] {
  const matches: MatchedWord[] = []
  const normalized = words.map((word) => normalizeWord(word.word))
  const consumed = new Set<number>()

  // Phrases first, so "oh my god" wins over any single-word match inside it.
  for (const phrase of compiled.phrases) {
    for (let i = 0; i + phrase.words.length <= normalized.length; i++) {
      if (consumed.has(i)) continue
      let hit = true
      for (let j = 0; j < phrase.words.length; j++) {
        if (normalized[i + j] !== phrase.words[j]) {
          hit = false
          break
        }
      }
      if (!hit) continue
      for (let j = 0; j < phrase.words.length; j++) consumed.add(i + j)
      matches.push({
        index: i,
        // A phrase spans several words, so the match carries the full time range.
        word: {
          word: phrase.entry.term,
          startSec: words[i].startSec,
          endSec: words[i + phrase.words.length - 1].endSec,
        },
        term: phrase.entry.term,
        severity: phrase.entry.severity,
        category: phrase.entry.category,
        via: 'phrase',
      })
    }
  }

  for (let i = 0; i < words.length; i++) {
    if (consumed.has(i)) continue
    // Checked against the raw token, since normalization strips the very punctuation
    // that identifies a self-censored word ("f***" would otherwise reduce to "f").
    const raw = words[i].word.trim()
    if (CENSORED_PATTERN.test(raw)) {
      matches.push({
        index: i,
        word: words[i],
        term: raw,
        severity: 'strong',
        category: 'profanity',
        via: 'censored',
      })
      continue
    }

    const candidate = normalized[i]
    if (!candidate) continue
    if (compiled.allowed.has(candidate)) continue

    let entry = compiled.exact.get(candidate)

    if (!entry) {
      // Elongated speech: "fuuuck" collapses to a listed form.
      const collapsed = collapseRepeats(candidate)
      if (collapsed !== candidate && !NEVER_FLAG.has(collapsed)) {
        entry = compiled.exact.get(collapsed)
      }
    }

    if (entry) {
      matches.push({
        index: i,
        word: words[i],
        term: entry.term,
        severity: entry.severity,
        category: entry.category,
        via: 'exact',
      })
    }
  }

  return matches.sort((a, b) => a.word.startSec - b.word.startSec)
}
