import type { Chapter, Episode } from '@/core/types'
import { getPlatform } from '@/platform'
import { db } from '@/data/db'

/**
 * Podcasting 2.0 chapters (`podcast:chapters`).
 *
 * A chapters file is a small JSON document the publisher hosts next to the audio:
 * `{ "chapters": [ { "startTime": 123, "title": "…" }, … ] }`. Fetched the first time an
 * episode with a chapters URL is opened, then cached in Dexie — chapters describe a
 * published episode and do not meaningfully change, and the cache is what keeps them
 * working offline alongside a downloaded episode.
 */

/** Raw shape per the spec. Everything optional, because the wild is the wild. */
interface RawChapter {
  startTime?: unknown
  title?: unknown
  img?: unknown
  toc?: unknown
}

/**
 * Normalizes a fetched chapters document into clean, ordered markers.
 *
 * Defensive on purpose: chapter files are third-party data. Non-numeric or negative
 * start times are dropped rather than guessed at, entries marked `toc: false` are
 * honoured (the spec uses that for markers that should not appear in a chapter list),
 * and duplicate start times keep only the first — two chapters cannot begin at the
 * same instant, and rendering both would make the seek target ambiguous.
 */
export function normalizeChapters(raw: unknown): Chapter[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { chapters?: unknown }).chapters
  if (!Array.isArray(list)) return []

  const out: Chapter[] = []
  for (const entry of list as RawChapter[]) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.toc === false) continue
    const startSec = Number(entry.startTime)
    if (!Number.isFinite(startSec) || startSec < 0) continue
    out.push({
      startSec,
      title: typeof entry.title === 'string' ? entry.title.trim() : '',
      imageUrl: typeof entry.img === 'string' && entry.img ? entry.img : undefined,
    })
  }

  out.sort((a, b) => a.startSec - b.startSec)
  return out.filter((chapter, index) => index === 0 || chapter.startSec !== out[index - 1].startSec)
}

/**
 * Chapters for an episode: cache first, network second, empty on any failure.
 *
 * Failure is silent by design — chapters are an enhancement, and an unreachable
 * chapters file should cost nothing more than the list not appearing.
 */
export async function getChapters(episode: Episode): Promise<Chapter[]> {
  if (!episode.chaptersUrl) return []

  const cached = await db.chapters.get(episode.id)
  if (cached) return cached.chapters

  try {
    const response = await getPlatform().http.get(episode.chaptersUrl)
    if (response.status !== 200) return []
    const chapters = normalizeChapters(JSON.parse(await response.text()))
    // Empty results are cached too: a chapters URL that yields nothing will keep
    // yielding nothing, and refetching it on every open is pure waste.
    await db.chapters.put({ episodeId: episode.id, chapters, fetchedAt: Date.now() })
    return chapters
  } catch {
    return []
  }
}

/** The chapter the playhead is currently inside, or null before the first marker. */
export function chapterAt(chapters: Chapter[], positionSec: number): Chapter | null {
  let current: Chapter | null = null
  for (const chapter of chapters) {
    if (chapter.startSec <= positionSec) current = chapter
    else break
  }
  return current
}
