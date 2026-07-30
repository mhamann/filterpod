import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import Dexie from 'dexie'
import { db } from '@/data/db'
import { Artwork, Button, Pill } from '@/ui/components'
import { EpisodeRow } from '@/ui/EpisodeRow'
import { Icon } from '@/ui/Icon'
import { PullToRefresh } from '@/ui/PullToRefresh'
import { subscribeToFeed, unsubscribeFromFeed } from '@/features/subscriptions/service'
import { fetchFeed } from '@/features/feeds/refresh'

const PAGE_SIZE = 30

/** How long a feed must fail before the show page says so. One flaky refresh is not news. */
const STALE_FEED_MS = 24 * 60 * 60 * 1000

export function PodcastDetail() {
  const { podcastId = '' } = useParams()
  const navigate = useNavigate()
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [busy, setBusy] = useState(false)
  /**
   * A failure from a refresh the user asked for, shown immediately. Distinct from
   * podcast.lastFetchError, which background refreshes also write and which only earns
   * the banner after a day of failures — someone who just pulled to refresh deserves to
   * know it did not work, right now, not in 24 hours.
   */
  const [manualError, setManualError] = useState<string | null>(null)

  const podcast = useLiveQuery(() => db.podcasts.get(podcastId), [podcastId])
  const subscription = useLiveQuery(() => db.subscriptions.get(podcastId), [podcastId])
  const episodes = useLiveQuery(
    () =>
      db.episodes
        .where('[podcastId+publishedAt]')
        .between([podcastId, Dexie.minKey], [podcastId, Dexie.maxKey])
        .reverse()
        .limit(limit)
        .toArray(),
    [podcastId, limit],
    [],
  )
  const totalEpisodes = useLiveQuery(
    () => db.episodes.where('podcastId').equals(podcastId).count(),
    [podcastId],
    0,
  )

  if (!podcast) {
    return (
      <div className="p-8 text-center text-ink-600">
        <p>This show is not in your library.</p>
        <Link to="/discover" className="mt-3 inline-block text-ember-400">
          Search for it
        </Link>
      </div>
    )
  }

  const isSubscribed = Boolean(subscription)

  return (
    <PullToRefresh
      onRefresh={async () => {
        const result = await fetchFeed(podcast.feedUrl)
        setManualError(result.error ?? null)
      }}
    >
    <div className="animate-rise pb-6">
      <div className="rack-texture flex items-center gap-1 border-b border-panel-800 px-2 py-2">
        <button
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="focus-ring rotate-180 rounded-full p-2 text-ink-300"
        >
          <Icon name="chevronRight" size={20} />
        </button>
        <span className="silkscreen truncate">{podcast.author}</span>
      </div>

      <header className="px-4 pt-5 pb-4">
        <div className="flex gap-4">
          <Artwork
            src={podcast.artworkUrl}
            alt={podcast.title}
            className="h-[104px] w-[104px] shadow-xl shadow-black/50"
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl leading-tight">{podcast.title}</h1>
            <p className="mt-1 truncate text-[13px] text-ink-500">{podcast.author}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Pill tone="neutral">{totalEpisodes} episodes</Pill>
              {podcast.explicit && <Pill tone="ember">Explicit feed</Pill>}
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          {isSubscribed ? (
            <Button
              variant="secondary"
              icon="check"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await unsubscribeFromFeed(podcastId)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Subscribed
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="plus"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await subscribeToFeed(podcast.feedUrl)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Subscribe
            </Button>
          )}
        </div>

        {/*
          Two tiers. A failure from a pull the user just made is answered immediately —
          they asked, so they get told. Background failures stay quiet: a single blip is
          usually transient and the cached episodes on screen are still perfectly good,
          so alarming on every one trained people to ignore the banner. Only a feed that
          has gone a day without a single successful fetch earns the persistent version.
          Rows that predate lastSuccessAt stay quiet until a success stamps them.
        */}
        {manualError ? (
          <p className="mt-3 rounded-lg bg-alarm-500/10 px-3 py-2 text-[12px] text-alarm-400 ring-1 ring-alarm-500/25">
            Refresh failed: {manualError}
          </p>
        ) : (
          podcast.lastFetchError &&
          podcast.lastSuccessAt &&
          Date.now() - podcast.lastSuccessAt > STALE_FEED_MS && (
            <p className="mt-3 rounded-lg bg-alarm-500/10 px-3 py-2 text-[12px] text-alarm-400 ring-1 ring-alarm-500/25">
              This feed has not refreshed successfully since{' '}
              {new Date(podcast.lastSuccessAt).toLocaleDateString()}: {podcast.lastFetchError}
            </p>
          )
        )}

        <Description text={podcast.description} />
      </header>

      {isSubscribed && (
        <>
          <NewEpisodeControls
            podcastId={podcastId}
            autoDownload={subscription!.autoDownload}
            downloadLimit={subscription!.autoDownloadLimit}
            autoQueue={Boolean(subscription!.autoQueue)}
          />
          <FilteringControl podcastId={podcastId} overrideId={subscription!.filterProfileId} />
        </>
      )}

      <div className="border-t border-panel-800">
        {episodes.map((episode) => (
          <EpisodeRow key={episode.id} episode={episode} />
        ))}
      </div>

      {episodes.length < totalEpisodes && (
        <div className="px-4 pt-4">
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show more
          </Button>
        </div>
      )}
    </div>
    </PullToRefresh>
  )
}

/** Long show descriptions get a clamp with an expander. */
function Description({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  const isLong = text.length > 180
  return (
    <div className="mt-4">
      <p
        className={`text-[13px] leading-relaxed text-ink-500 ${
          expanded || !isLong ? '' : 'line-clamp-3'
        }`}
      >
        {text}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded((open) => !open)}
          className="focus-ring mt-1 text-[12px] text-ember-400"
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

/**
 * What happens when this show publishes: nothing (just listed), download, and/or join
 * the queue. Two toggles rather than a follow/subscribe split — the distinction people
 * mean by those words is exactly the queue behaviour, and a toggle expresses it without
 * a second subscription concept leaking into every button and import path.
 */
function NewEpisodeControls({
  podcastId,
  autoDownload,
  downloadLimit,
  autoQueue,
}: {
  podcastId: string
  autoDownload: boolean
  downloadLimit: number
  autoQueue: boolean
}) {
  return (
    <div className="mx-4 mb-4 rounded-xl bg-panel-850 ring-1 ring-panel-700">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <p className="text-[13px] font-medium">Add new episodes to queue</p>
          <p className="text-[11px] text-ink-600">
            {autoQueue ? 'New episodes join the end of your queue' : 'Off'}
          </p>
        </div>
        <Toggle
          checked={autoQueue}
          onChange={(next) => void db.subscriptions.update(podcastId, { autoQueue: next })}
        />
      </div>
      <div className="flex items-center justify-between border-t border-panel-700/60 px-4 py-3">
        <div>
          <p className="text-[13px] font-medium">Auto-download new episodes</p>
          <p className="text-[11px] text-ink-600">
            {autoDownload ? `Keeps the latest ${downloadLimit} filtered and ready` : 'Off'}
          </p>
        </div>
        <Toggle
          checked={autoDownload}
          onChange={(next) => void db.subscriptions.update(podcastId, { autoDownload: next })}
        />
      </div>
    </div>
  )
}

/**
 * Per-show filter level, overriding the app-wide setting.
 *
 * This exists for shows where the wordlist misfires on context — sermons and Bible
 * podcasts trip the blasphemy category with entirely reverent speech. The override
 * lives on the subscription, so it applies to every episode of the show and survives
 * refreshes; "Default" clears it and the show follows the app setting again.
 *
 * Spans are built per profile, so switching invalidates the show's existing filter
 * maps — episodes re-analyze under the new profile as they play. That is the honest
 * cost: coverage from one profile cannot vouch for another's words.
 */
function FilteringControl({ podcastId, overrideId }: { podcastId: string; overrideId?: string }) {
  // Collapsed by default: this is a set-once escape hatch for shows the wordlist
  // misreads, not a control anyone adjusts weekly. The closed row still names the
  // effective setting, so an active override is never invisible — quiet, not hidden.
  const [open, setOpen] = useState(false)
  const profiles = useLiveQuery(() => db.filterProfiles.toArray(), [], [])
  const settings = useLiveQuery(() => db.settings.get('singleton'), [])

  // Seeded order, not table order: strictest to off, with Default leading.
  const ORDER = ['family', 'standard', 'strong-only', 'off']
  const ordered = [...profiles].sort(
    (a, b) =>
      (ORDER.indexOf(a.id) + 1 || ORDER.length + 1) - (ORDER.indexOf(b.id) + 1 || ORDER.length + 1),
  )
  const appDefault = profiles.find((profile) => profile.id === settings?.activeFilterProfileId)
  const overrideName = ordered.find((profile) => profile.id === overrideId)?.name ?? overrideId

  return (
    <div className="mx-4 mb-4 rounded-xl bg-panel-850 ring-1 ring-panel-700">
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-[13px] font-medium">Filtering</span>
        <span className="flex items-center gap-1.5">
          <span className={`text-[12px] ${overrideId ? 'text-ember-300' : 'text-ink-600'}`}>
            {overrideId ? overrideName : (appDefault?.name ?? 'Default')}
          </span>
          <Icon
            name="chevronDown"
            size={14}
            className={`text-ink-600 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3">
          <p className="text-[11px] text-ink-600">
            {overrideId
              ? overrideId === 'off'
                ? 'Off — episodes of this show play exactly as published.'
                : `This show uses ${overrideName} instead of the app setting.`
              : `Follows the app setting${appDefault ? ` (${appDefault.name})` : ''}.`}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <ProfilePill
              label="Default"
              selected={!overrideId}
              onSelect={() => void db.subscriptions.update(podcastId, { filterProfileId: undefined })}
            />
            {ordered.map((profile) => (
              <ProfilePill
                key={profile.id}
                label={profile.name}
                selected={overrideId === profile.id}
                onSelect={() =>
                  void db.subscriptions.update(podcastId, { filterProfileId: profile.id })
                }
              />
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-ink-600">
            Applies from the next episode you play.
          </p>
        </div>
      )}
    </div>
  )
}

function ProfilePill({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect(): void
}) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      className={`focus-ring rounded-full px-3 py-1.5 text-[12px] ring-1 transition-colors ${
        selected
          ? 'bg-ember-500/15 text-ember-300 ring-ember-500/40'
          : 'bg-panel-900 text-ink-500 ring-panel-700'
      }`}
    >
      {label}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange(next: boolean): void
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-[26px] w-[46px] shrink-0 rounded-full p-0 transition-colors ${
        checked ? 'bg-ember-500' : 'bg-panel-700'
      }`}
    >
      {/*
        `left-0` is load-bearing. Without an inset the knob falls back to its static
        position, and a <button> centres inline content by default — so the knob starts
        mid-track and the transform pushes it out past the right edge.
      */}
      <span
        className={`absolute top-[3px] left-0 h-5 w-5 rounded-full bg-ink-100 shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[23px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  )
}
