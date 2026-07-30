/** Domain types shared across every layer. */

export type EpisodeId = string
export type PodcastId = string

/** Severity tiers let one wordlist serve several strictness profiles. */
export type Severity = 'mild' | 'moderate' | 'strong'

export type Category =
  | 'profanity'
  | 'sexual'
  | 'slur'
  | 'blasphemy'
  | 'scatological'
  | 'custom'

export interface Podcast {
  id: PodcastId
  feedUrl: string
  title: string
  author: string
  description: string
  artworkUrl: string
  link?: string
  categories: string[]
  explicit: boolean
  /** Conditional-request validators so refresh is cheap on unchanged feeds. */
  etag?: string
  lastModified?: string
  lastFetchedAt?: number
  lastFetchError?: string
}

/** A transcript advertised by the feed via the podcast namespace. */
export interface TranscriptRef {
  url: string
  type: 'text/vtt' | 'application/x-subrip' | 'application/json' | 'text/plain'
  language?: string
}

export interface Episode {
  id: EpisodeId
  podcastId: PodcastId
  guid: string
  title: string
  description: string
  /** Audio enclosure. */
  audioUrl: string
  audioType?: string
  audioLength?: number
  durationSec?: number
  publishedAt: number
  episodeNumber?: number
  seasonNumber?: number
  explicit: boolean
  artworkUrl?: string
  transcripts: TranscriptRef[]
  /** Podcasting 2.0 `podcast:chapters` URL — a JSON file, fetched on demand. */
  chaptersUrl?: string
}

/** One chapter marker, from a Podcasting 2.0 chapters file. */
export interface Chapter {
  startSec: number
  title: string
  /** Chapter-specific artwork, when the file provides one. */
  imageUrl?: string
}

export interface Subscription {
  podcastId: PodcastId
  subscribedAt: number
  autoDownload: boolean
  /** How many recent episodes to keep downloaded; 0 means unlimited. */
  autoDownloadLimit: number
  notifyOnNew: boolean
  /**
   * New episodes join the end of the queue when the feed refreshes.
   *
   * This is the "subscribed, not just following" behaviour, expressed as a per-show
   * toggle rather than a second tier of subscription: one concept in every button and
   * import path, with the queue behaviour opted into where someone actually wants it.
   */
  autoQueue?: boolean
  /** Overrides the global filter profile for this feed when set. */
  filterProfileId?: string
}

export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface Progress {
  episodeId: EpisodeId
  /** Position on the ORIGINAL, unfiltered timeline, in seconds. */
  positionSec: number
  durationSec: number
  played: boolean
  completedAt?: number
  lastPlayedAt: number
}

export type DownloadState =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'downloaded'
  | 'failed'
  | 'cancelled'

export interface Download {
  episodeId: EpisodeId
  state: DownloadState
  /** Storage-layer key, resolved to a playable URL by the files platform impl. */
  fileKey?: string
  bytesDownloaded: number
  bytesTotal: number
  error?: string
  startedAt: number
  completedAt?: number
  /**
   * Queued by an auto-download rule rather than by the user tapping Get.
   * Only these are held back on a metered connection — an explicit request should
   * happen regardless of what the user is connected to.
   */
  auto: boolean
}

/** A contiguous stretch of audio to skip, on the original timeline. */
export interface FilterSpan {
  startSec: number
  endSec: number
  severity: Severity
  category: Category
  /** Matched terms, kept for the "why was this skipped" UI. Never the surrounding text. */
  terms: string[]
}

/**
 * There are deliberately no 'queued' or 'transcribing' states.
 *
 * They existed when filtering was a background job with its own queue. Under live
 * filtering the work is owned by the player, and leaving those states in the type meant
 * rows could be written that nothing would ever advance — an episode stuck reading
 * "Filtering 0%" forever. Progress belongs to the in-memory session; what is persisted
 * is only how much has actually been analyzed.
 */
export type FilterMapStatus =
  | 'absent'
  /** Some of the episode is analyzed and playable; the rest is still being worked on. */
  | 'partial'
  | 'ready'
  | 'failed'
  | 'unsupported'

/** A stretch of the episode that has been analyzed. */
export interface AnalyzedRange {
  startSec: number
  endSec: number
}

export interface FilterMap {
  episodeId: EpisodeId
  status: FilterMapStatus
  spans: FilterSpan[]
  /**
   * Which parts of the episode have actually been analyzed.
   *
   * Filtering runs just-in-time while you listen rather than all at once up front, so a
   * map is normally incomplete. Playback must never run past the end of coverage — an
   * unanalyzed stretch is not "clean", it is simply unknown. Empty means nothing has
   * been analyzed; a single range covering the duration means the whole episode has.
   */
  analyzedRanges: AnalyzedRange[]
  /** Where the word timings came from, which sets the confidence in the spans. */
  source: 'asr' | 'transcript-narrowed-asr' | 'transcript-only' | 'none'
  /** Bumping either invalidates the map so it regenerates. */
  engineVersion: string
  wordlistVersion: string
  /**
   * Which profile the spans were built under. Spans are profile-dependent — Family
   * flags words Standard leaves alone — so a map built under one profile is not a head
   * start for another: reusing its coverage would leave newly-flaggable words standing
   * in "analyzed" audio. A mismatch discards the map the same way an engine bump does.
   * Absent on maps from before per-show profiles existed, which discards those too.
   */
  profileId?: string
  /** 0..1 while transcribing. */
  progress: number
  error?: string
  createdAt: number
  /** Total audio removed, for the episode UI. */
  skippedSec: number
}

/** A word with timing, as produced by any transcription backend. */
export interface TimedWord {
  word: string
  startSec: number
  endSec: number
  confidence?: number
}

export interface FilterProfile {
  id: string
  name: string
  /** Severity tiers that get skipped. */
  severities: Severity[]
  categories: Category[]
  /** Seconds of audio kept before/after a flagged word, absorbing ASR timing error. */
  padBeforeSec: number
  padAfterSec: number
  /** Spans closer together than this merge into one skip. */
  mergeGapSec: number
}

/** One episode's place in the play queue. */
export interface QueueItem {
  episodeId: EpisodeId
  /**
   * Sort key, dense and zero-based.
   *
   * Rewritten across the whole queue on every reorder rather than kept sparse. A queue is
   * a handful of episodes someone arranged by hand, so renumbering costs nothing, and it
   * keeps positions from drifting into the fractional soup that gap-based schemes decay
   * into after enough moves.
   */
  position: number
  addedAt: number
}

export interface Settings {
  activeFilterProfileId: string
  playbackRate: number
  skipForwardSec: number
  skipBackSec: number
  /** Mark an episode played once within this many seconds of the end. */
  completionThresholdSec: number
  autoDownloadOnWifiOnly: boolean
  maxStorageBytes: number
  whisperModel: 'tiny.en' | 'base.en' | 'small.en'
  theme: 'dark' | 'light' | 'system'
}
