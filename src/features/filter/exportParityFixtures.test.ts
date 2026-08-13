import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TimedWord } from '@/core/types'
import { DEFAULT_PROFILES } from '@/data/defaults'
import {
  analyzedUntil,
  mergeRanges,
  normalizeSpans,
  subtractRanges,
} from '@/core/filterMath'
import { compileWordlist, matchWords, normalizeWord, serializeCompiledWordlist } from './matcher'
import { sortAndDedupe, spansFromMatches } from './buildFilterMap'

/**
 * Golden-fixture generator for the Kotlin port.
 *
 * The native engine (WordMatcher.kt, SpanMath.kt) is a second implementation of the
 * matcher and span math, and two matchers that drift apart is the port's biggest risk:
 * a word cut on web and missed on device is exactly the kind of bug nobody notices
 * until a listener does. This test writes vectors computed by the TypeScript
 * implementations into the Android unit-test resources; FilterParityTest on the Kotlin
 * side must reproduce them exactly. Regenerate with:
 *
 *   FILTER_FIXTURES=1 npx vitest run exportParityFixtures
 *
 * and commit the JSON alongside any change to either implementation.
 */

const OUT = resolve(__dirname, '../../../android/app/src/test/resources/filter-fixtures.json')
/** The KMP shared module runs its own parity suite against the same vectors. */
const OUT_KMP = resolve(
  __dirname,
  '../../../kmp/shared/src/androidUnitTest/resources/filter-fixtures.json',
)

const words = (...tokens: Array<[string, number, number]>): TimedWord[] =>
  tokens.map(([word, startSec, endSec]) => ({ word, startSec, endSec }))

describe('parity fixture export', () => {
  it.runIf(process.env.FILTER_FIXTURES === '1')('writes fixtures for the Kotlin tests', () => {
    const standard = DEFAULT_PROFILES.find((p) => p.id === 'standard')!
    const family = DEFAULT_PROFILES.find((p) => p.id === 'family')!

    const overrides = [
      // A custom phrase and a custom word, plus an allow that must suppress a match.
      { term: 'holy guacamole', action: 'block', severity: 'moderate', category: 'custom' },
      { term: 'frak', action: 'block', severity: 'moderate', category: 'custom' },
      { term: 'uryy', action: 'allow', severity: 'mild', category: 'blasphemy' },
    ] as never[]

    const compiledStandard = compileWordlist(standard, overrides)
    const compiledFamily = compileWordlist(family, [])

    // Streams exercising: exact hits, censored tokens, repeats collapse, allowed
    // words, phrases (custom and bundled), punctuation, and near-miss clean words.
    const streams: Record<string, TimedWord[]> = {
      exactAndPunctuation: words(
        ['Total', 0, 0.3],
        ['bullfuvg.', 0.3, 0.9],
        ['honestly', 0.9, 1.4],
      ),
      censored: words(['what', 0, 0.2], ['f***', 0.2, 0.7], ['seriously', 0.7, 1.2]),
      elongated: words(['shiiiit', 0, 0.8], ['happens', 0.8, 1.2]),
      allowedWord: words(['what', 0, 0.2], ['the', 0.2, 0.3], ['uryy', 0.3, 0.7]),
      customPhrase: words(
        ['well', 0, 0.2],
        ['holy', 0.2, 0.5],
        ['guacamole', 0.5, 1.1],
        ['batman', 1.1, 1.5],
      ),
      customWord: words(['oh', 0, 0.2], ['frak', 0.2, 0.6], ['this', 0.6, 0.9]),
      cleanNearMisses: words(
        ['where', 0, 0.3],
        ['ship', 0.3, 0.6],
        ['duck', 0.6, 0.9],
        ['assess', 0.9, 1.4],
        ['Sphaghorpe', 1.4, 2.1],
      ),
      overlappingAsr: words(
        ['qnza', 10.0, 10.4],
        ['qnza', 10.2, 10.5],
        ['inverted', 12.5, 12.1],
      ),
    }

    const matchCases = Object.entries(streams).flatMap(([name, stream]) => [
      {
        name: `${name}:standard`,
        words: stream,
        wordlist: 'standard',
        matches: matchWords(sortAndDedupe(stream), compiledStandard).map((m) => ({
          term: m.term,
          severity: m.severity,
          category: m.category,
          via: m.via,
          startSec: m.word.startSec,
          endSec: m.word.endSec,
        })),
      },
      {
        name: `${name}:family`,
        words: stream,
        wordlist: 'family',
        matches: matchWords(sortAndDedupe(stream), compiledFamily).map((m) => ({
          term: m.term,
          severity: m.severity,
          category: m.category,
          via: m.via,
          startSec: m.word.startSec,
          endSec: m.word.endSec,
        })),
      },
    ])

    // Span pipeline: same matches through padding, capping and merging.
    const spanCase = (() => {
      const stream = words(
        ['utter', 20.0, 20.3],
        ['bullfuvg', 20.3, 20.9],
        ['and', 20.95, 21.1],
        ['fuvg', 21.15, 21.5],
        // A whisper token with an absurd multi-second range, to exercise the cap.
        ['shpx', 100.0, 106.5],
      )
      const matches = matchWords(sortAndDedupe(stream), compiledStandard)
      return {
        words: stream,
        durationSec: 101.0,
        profile: {
          padBeforeSec: standard.padBeforeSec,
          padAfterSec: standard.padAfterSec,
          mergeGapSec: standard.mergeGapSec,
        },
        spans: spansFromMatches(matches, standard, 101.0),
      }
    })()

    const rangeCases = {
      merge: {
        input: [
          { startSec: 30, endSec: 45 },
          { startSec: 0, endSec: 15 },
          { startSec: 15, endSec: 30 },
          { startSec: 100, endSec: 130 },
          { startSec: 110, endSec: 120 },
        ],
        output: mergeRanges([
          { startSec: 30, endSec: 45 },
          { startSec: 0, endSec: 15 },
          { startSec: 15, endSec: 30 },
          { startSec: 100, endSec: 130 },
          { startSec: 110, endSec: 120 },
        ]),
      },
      subtract: {
        ranges: [{ startSec: 0, endSec: 600 }],
        holes: [
          { startSec: 50, endSec: 60 },
          { startSec: 0, endSec: 10 },
          { startSec: 590, endSec: 700 },
        ],
        output: subtractRanges(
          [{ startSec: 0, endSec: 600 }],
          [
            { startSec: 50, endSec: 60 },
            { startSec: 0, endSec: 10 },
            { startSec: 590, endSec: 700 },
          ],
        ),
      },
      analyzedUntil: {
        ranges: mergeRanges([
          { startSec: 0, endSec: 90 },
          { startSec: 120, endSec: 300 },
        ]),
        queries: [0, 45, 89.999, 90, 100, 120, 250].map((positionSec) => ({
          positionSec,
          result: analyzedUntil(
            mergeRanges([
              { startSec: 0, endSec: 90 },
              { startSec: 120, endSec: 300 },
            ]),
            positionSec,
          ),
        })),
      },
      normalizeSpansMergesSeverity: {
        mergeGapSec: 0.45,
        input: [
          { startSec: 10, endSec: 10.5, severity: 'mild', category: 'blasphemy', terms: ['a'] },
          { startSec: 10.8, endSec: 11.2, severity: 'strong', category: 'profanity', terms: ['b'] },
          { startSec: 30, endSec: 30.4, severity: 'moderate', category: 'scatological', terms: ['c'] },
        ],
        output: normalizeSpans(
          [
            { startSec: 10, endSec: 10.5, severity: 'mild', category: 'blasphemy', terms: ['a'] },
            { startSec: 10.8, endSec: 11.2, severity: 'strong', category: 'profanity', terms: ['b'] },
            { startSec: 30, endSec: 30.4, severity: 'moderate', category: 'scatological', terms: ['c'] },
          ] as never[],
          0.45,
        ),
      },
      sortAndDedupe: {
        input: streams.overlappingAsr,
        output: sortAndDedupe(streams.overlappingAsr),
      },
    }

    const normalizeCases = [
      'Bullfuvg.',
      "don't",
      'café',
      'HELLO!!!',
      'f***',
      '---',
      'naïve',
      "it's",
      'FUUUUCK',
    ].map((raw) => ({ raw, normalized: normalizeWord(raw) }))

    const fixtures = {
      note: 'Generated by exportParityFixtures.test.ts — do not edit by hand.',
      wordlists: {
        standard: serializeCompiledWordlist(compiledStandard),
        family: serializeCompiledWordlist(compiledFamily),
      },
      normalizeCases,
      matchCases,
      spanCase,
      rangeCases,
    }

    for (const out of [OUT, OUT_KMP]) {
      mkdirSync(resolve(out, '..'), { recursive: true })
      writeFileSync(out, JSON.stringify(fixtures, null, 2))
    }
    expect(matchCases.some((c) => c.matches.length > 0)).toBe(true)
  })
})
