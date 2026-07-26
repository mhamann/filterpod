import type { Category, Severity } from '@/core/types'

/**
 * The bundled wordlist.
 *
 * Entries are base forms only — inflections (-s, -ing, -ed, -er, -y) are generated at
 * load time by `expandVariants`, so this table stays readable and a new term only needs
 * one line.
 *
 * Severity drives which profiles skip a term:
 *   strong   — skipped by every profile that filters at all
 *   moderate — skipped by Standard and Family
 *   mild     — skipped only by Family
 */

export interface WordEntry {
  term: string
  severity: Severity
  category: Category
  /** Suppresses inflection generation where it would produce real, innocent words. */
  noVariants?: boolean
}

export const WORDLIST: WordEntry[] = [
  // --- strong profanity ---
  { term: 'shpx', severity: 'strong', category: 'profanity' },
  { term: 'mothershpxer', severity: 'strong', category: 'profanity' },
  { term: 'clustershpx', severity: 'strong', category: 'profanity' },
  { term: 'phag', severity: 'strong', category: 'profanity' },
  { term: 'pbpxfhpxre', severity: 'strong', category: 'profanity' },

  // --- moderate profanity ---
  { term: 'fuvg', severity: 'moderate', category: 'scatological' },
  { term: 'bullfuvg', severity: 'moderate', category: 'scatological' },
  { term: 'horsefuvg', severity: 'moderate', category: 'scatological' },
  { term: 'dipfuvg', severity: 'moderate', category: 'scatological' },
  { term: 'ovgpu', severity: 'moderate', category: 'profanity' },
  { term: 'onfgneq', severity: 'moderate', category: 'profanity' },
  { term: 'nffubyr', severity: 'moderate', category: 'profanity' },
  { term: 'qvpxurnq', severity: 'moderate', category: 'profanity' },
  { term: 'cevpx', severity: 'moderate', category: 'profanity', noVariants: true },
  { term: 'gjng', severity: 'moderate', category: 'profanity' },
  { term: 'jnaxre', severity: 'moderate', category: 'profanity' },
  { term: 'obyybpxf', severity: 'moderate', category: 'profanity', noVariants: true },
  { term: 'cvff', severity: 'moderate', category: 'scatological' },
  { term: 'cvffed', severity: 'moderate', category: 'scatological', noVariants: true },
  { term: 'tbqqnza', severity: 'moderate', category: 'blasphemy' },
  { term: 'tbqqnzait', severity: 'moderate', category: 'blasphemy', noVariants: true },

  // --- mild ---
  { term: 'qnza', severity: 'mild', category: 'profanity' },
  { term: 'dammit', severity: 'mild', category: 'profanity', noVariants: true },
  { term: 'uryy', severity: 'mild', category: 'profanity', noVariants: true },
  { term: 'penc', severity: 'mild', category: 'scatological' },
  { term: 'nff', severity: 'mild', category: 'profanity', noVariants: true },
  { term: 'nefr', severity: 'mild', category: 'profanity' },
  { term: 'wnpxnff', severity: 'mild', category: 'profanity' },
  { term: 'qhzonff', severity: 'mild', category: 'profanity' },
  { term: 'qbhpuront', severity: 'mild', category: 'profanity' },
  { term: 'bloody', severity: 'mild', category: 'profanity', noVariants: true },
  { term: 'bugger', severity: 'mild', category: 'profanity' },
  { term: 'git', severity: 'mild', category: 'profanity', noVariants: true },

  // --- sexual ---
  { term: 'oybjwbo', severity: 'strong', category: 'sexual' },
  { term: 'unaqwbo', severity: 'strong', category: 'sexual' },
  { term: 'qvyqb', severity: 'moderate', category: 'sexual' },
  { term: 'obare', severity: 'moderate', category: 'sexual' },
  { term: 'ubeal', severity: 'mild', category: 'sexual', noVariants: true },
  { term: 'fyhg', severity: 'moderate', category: 'sexual' },
  { term: 'juber', severity: 'moderate', category: 'sexual' },
  { term: 'cbea', severity: 'mild', category: 'sexual' },
  { term: 'wrexbss', severity: 'moderate', category: 'sexual' },

  // --- blasphemy ---
  // Only skipped by the Family profile, which is the profile whose users ask for it.
  { term: 'jesus christ', severity: 'mild', category: 'blasphemy', noVariants: true },
  { term: 'christ almighty', severity: 'mild', category: 'blasphemy', noVariants: true },
  { term: 'oh my god', severity: 'mild', category: 'blasphemy', noVariants: true },
]

/**
 * Suffix inflections applied to single-word entries.
 *
 * `shpx` alone would miss `shpxing`, `shpxed`, `shpxer`, `shpxs` — which are far more
 * common in speech than the bare stem.
 */
const SUFFIXES = ['s', 'es', 'ed', 'ing', 'er', 'ers', 'y', 'in', "in'"]

/** Generates inflected forms for a base term, handling final-consonant doubling. */
export function expandVariants(entry: WordEntry): string[] {
  if (entry.noVariants || entry.term.includes(' ')) return [entry.term]

  const base = entry.term
  const forms = new Set<string>([base])
  const lastChar = base.at(-1)!
  const isVowel = 'aeiou'.includes(lastChar)

  for (const suffix of SUFFIXES) {
    forms.add(base + suffix)
    // fuvg -> fuvgting, shpx -> shpxing is handled by the plain concat, but
    // single-consonant-final stems double before a vowel suffix: bug -> bugging.
    if (!isVowel && /[aeiou][bcdfgklmnprstz]$/.test(base) && /^[aeiouy]/.test(suffix)) {
      forms.add(base + lastChar + suffix)
    }
    // Terms ending in `e` drop it: `douche` -> `douching`.
    if (lastChar === 'e' && /^[aeiouy]/.test(suffix)) {
      forms.add(base.slice(0, -1) + suffix)
    }
  }
  return [...forms]
}

/**
 * Words that must never be flagged, even if a variant rule produces them.
 * This is the guard rail that keeps the filter from eating ordinary speech.
 */
export const NEVER_FLAG = new Set([
  'assess', 'assessment', 'asset', 'assets', 'assign', 'assignment', 'assist', 'assistant',
  'associate', 'association', 'assume', 'assumption', 'assure', 'class', 'classic', 'glass',
  'grass', 'mass', 'massive', 'pass', 'passage', 'passed', 'passenger', 'password', 'past',
  'brass', 'bypass', 'compass', 'embassy', 'harass', 'molasses', 'sassy', 'bass',
  'hello', 'shell', 'shelter', 'held', 'help', 'helmet', 'michelle', 'rachel', 'shellfish',
  'analysis', 'analyst', 'analyze', 'canal', 'penalty', 'peninsula', 'shuttlecock',
  'cockpit', 'cocktail', 'peacock', 'hitchcock', 'scrap', 'scrape', 'scrapbook',
  'butter', 'button', 'buttress', 'debut', 'tribute', 'attribute', 'distribute',
  'title', 'titan', 'constitution', 'institute', 'substitute',
  'document', 'documentary', 'dock', 'docket', 'duck', 'ducks', 'dual', 'dude',
  'ship', 'shipping', 'sheet', 'sheets', 'shoot', 'shot', 'shut', 'shift', 'chip',
  'fork', 'folk', 'flick', 'frock', 'truck', 'trucks', 'puck', 'luck', 'lucky',
  'pitch', 'ditch', 'witch', 'which', 'batch', 'beach', 'peach', 'rich',
  'bat', 'bad', 'bass', 'bust', 'best', 'blast', 'bastion',
  'grandma', 'grandpa', 'damned', 'damnation', 'amsterdam', 'dame', 'dam', 'dams',
])
