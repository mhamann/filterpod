import { describe, expect, it } from 'vitest'
import type { FilterProfile, TimedWord } from '@/core/types'
import { DEFAULT_PROFILES } from '@/data/defaults'
import { compileWordlist, matchWords, normalizeWord } from './matcher'

const family = DEFAULT_PROFILES.find((p) => p.id === 'family')!
const standard = DEFAULT_PROFILES.find((p) => p.id === 'standard')!
const strongOnly = DEFAULT_PROFILES.find((p) => p.id === 'strong-only')!

/** Builds a word sequence at 1 word per second, which keeps assertions readable. */
function words(...tokens: string[]): TimedWord[] {
  return tokens.map((word, index) => ({ word, startSec: index, endSec: index + 0.8 }))
}

function match(profile: FilterProfile, ...tokens: string[]) {
  const compiled = compileWordlist(profile)
  return matchWords(words(...tokens), compiled)
}

describe('normalizeWord', () => {
  it('strips punctuation and casing', () => {
    expect(normalizeWord('Shit,')).toBe('shit')
    expect(normalizeWord('"Damn!"')).toBe('damn')
  })

  it('drops apostrophes so contractions collapse', () => {
    expect(normalizeWord("fuckin'")).toBe('fuckin')
  })
})

describe('matching flagged words', () => {
  it('matches a base term', () => {
    const hits = match(standard, 'what', 'the', 'fuck', 'was', 'that')
    expect(hits).toHaveLength(1)
    expect(hits[0].term).toBe('fuck')
    expect(hits[0].word.startSec).toBe(2)
  })

  it('matches generated inflections', () => {
    for (const form of ['fucking', 'fucked', 'fucker', 'fucks', "fuckin'"]) {
      expect(match(standard, form), form).toHaveLength(1)
    }
  })

  it('matches elongated speech', () => {
    expect(match(standard, 'fuuuuck')).toHaveLength(1)
  })

  it('flags a self-censored token', () => {
    const hits = match(standard, 'oh', 'f***', 'no')
    expect(hits).toHaveLength(1)
    expect(hits[0].via).toBe('censored')
  })
})

describe('avoiding false positives', () => {
  // These are the failures that actually matter. A player that eats "assessment" or
  // "Hello" is worse than one that misses an occasional swear.
  const innocent = [
    'assessment', 'assassin', 'class', 'passage', 'password', 'bass', 'harass',
    'hello', 'shell', 'shelter', 'michelle', 'analysis', 'cocktail', 'peacock',
    'button', 'attribute', 'constitution', 'document', 'duck', 'ship', 'sheet',
    'fork', 'truck', 'pitch', 'which', 'beach', 'grandma', 'amsterdam', 'scrape',
  ]

  it.each(innocent)('does not flag %s under the Family profile', (word) => {
    expect(match(family, word)).toHaveLength(0)
  })

  it('does not flag near-homophones produced by ASR', () => {
    // Whisper mishearing "duck" for a swear is exactly why phonetic matching is not used.
    expect(match(family, 'the', 'duck', 'went', 'in', 'the', 'ship')).toHaveLength(0)
  })

  // Every one of these was a real false positive from an edit-distance tier that used
  // to run under the Family profile, observed over seven minutes of Radiolab. It
  // produced nine matches on that clip and every single one was wrong, which is why
  // there is no fuzzy matching at all now. See the note in matcher.ts.
  it.each([
    ['where', 'whore'],
    ['whole', 'whore'],
    ['shore', 'whore'],
    ["that's", 'twat'],
    ['suckers', 'fuck'],
    ['sucker', 'fuck'],
    ['center', 'cunt'],
    ['count', 'cunt'],
  ])('does not flag %s as %s', (innocent) => {
    expect(match(family, innocent)).toHaveLength(0)
  })
})

describe('severity profiles', () => {
  it('Family skips mild terms', () => {
    expect(match(family, 'damn')).toHaveLength(1)
  })

  it('Standard leaves mild terms alone', () => {
    expect(match(standard, 'damn')).toHaveLength(0)
  })

  it('Strong-only leaves moderate terms alone', () => {
    expect(match(strongOnly, 'shit')).toHaveLength(0)
    expect(match(strongOnly, 'fuck')).toHaveLength(1)
  })

  it('Off matches nothing', () => {
    const off = DEFAULT_PROFILES.find((p) => p.id === 'off')!
    expect(match(off, 'fuck', 'shit', 'damn')).toHaveLength(0)
  })
})

describe('phrases', () => {
  it('matches a multi-word phrase as one span', () => {
    const hits = match(family, 'well', 'oh', 'my', 'god', 'really')
    const phrase = hits.find((hit) => hit.via === 'phrase')
    expect(phrase).toBeDefined()
    expect(phrase!.word.startSec).toBe(1)
    expect(phrase!.word.endSec).toBeCloseTo(3.8)
  })

  it('does not double-report words consumed by a phrase', () => {
    const hits = match(family, 'oh', 'my', 'god')
    expect(hits).toHaveLength(1)
  })
})

describe('user overrides', () => {
  it('allow-listing a term suppresses it', () => {
    const compiled = compileWordlist(standard, [
      { term: 'shit', action: 'allow', severity: 'moderate', category: 'profanity', createdAt: 0 },
    ])
    expect(matchWords(words('shit'), compiled)).toHaveLength(0)
  })

  it('block-listing a custom term flags it', () => {
    const compiled = compileWordlist(standard, [
      { term: 'frak', action: 'block', severity: 'moderate', category: 'custom', createdAt: 0 },
    ])
    // 'custom' is in the Standard profile's categories, so this takes effect.
    expect(matchWords(words('frak'), compiled)).toHaveLength(1)
  })
})
