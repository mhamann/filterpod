import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { Artwork, Button, EmptyState, SectionLabel } from '@/ui/components'
import { timecode } from '@/ui/format'
import { refreshAndAutoDownload } from '@/features/subscriptions/service'
import { PullToRefresh } from '@/ui/PullToRefresh'
import { QueueButton } from '@/ui/QueueButton'
import { usePlayerStore } from '@/features/player/playerStore'
import { Icon } from '@/ui/Icon'

/**
 * Home: pick up where you left off, or pick a show. Nothing else.
 *
 * This screen used to also carry a "Ready to play" list of every downloaded episode,
 * with per-row download, queue and filter chrome. Three sections competing meant none
 * of them read as the point — and that list was the Downloads tab wearing a different
 * label. Episode browsing belongs to the show page; this page is for resuming and for
 * choosing a show.
 */
export function Library() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const subscriptions = useLiveQuery(
    async () => {
      const subs = await db.subscriptions.orderBy('subscribedAt').reverse().toArray()
      const podcasts = await db.podcasts.bulkGet(subs.map((s) => s.podcastId))
      return podcasts.filter((podcast): podcast is NonNullable<typeof podcast> =>
        Boolean(podcast),
      )
    },
    [],
    [],
  )


  const inProgress = useLiveQuery(
    async () => {
      const rows = await db.progress.orderBy('lastPlayedAt').reverse().limit(30).toArray()
      const unfinished = rows.filter((row) => !row.played && row.positionSec > 5)
      const episodes = await db.episodes.bulkGet(unfinished.map((row) => row.episodeId))
      return unfinished
        .map((row, index) => ({ row, episode: episodes[index] }))
        .filter((entry) => entry.episode)
    },
    [],
    [],
  )

  // The mini player already shows what is loaded; repeating it here as the top
  // "Continue" card made the same episode appear twice on one screen.
  const currentId = usePlayerStore((state) => state.episode?.id)
  const continueRows = inProgress
    .filter(({ row }) => row.episodeId !== currentId)
    .slice(0, 2)

  const hasNothing = subscriptions.length === 0

  /**
   * The search filters what is already here; anything else is one tap away.
   * Matching title or author, case-blind — a library search is a recall aid, not a
   * search engine, so substring matching is the right amount of clever.
   */
  const trimmed = query.trim().toLowerCase()
  const visibleShows =
    trimmed === ''
      ? subscriptions
      : subscriptions.filter(
          (podcast) =>
            podcast.title.toLowerCase().includes(trimmed) ||
            podcast.author.toLowerCase().includes(trimmed),
        )

  return (
    <PullToRefresh onRefresh={async () => void (await refreshAndAutoDownload())}>
      <div className="animate-rise pb-6">
        <Header title="Library" action={<QueueButton onClick={() => navigate('/queue')} />} />

        {subscriptions.length > 0 && (
          <div className="px-4 pt-3 pb-1">
            <div className="flex items-center gap-2.5 rounded-full bg-panel-850 px-4 py-2 ring-1 ring-panel-700 focus-within:ring-ember-500/50">
              <Icon name="search" size={15} className="shrink-0 text-ink-600" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a show"
                inputMode="search"
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full bg-transparent text-[14px] text-ink-100 outline-none placeholder:text-ink-600"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Clear"
                  className="focus-ring shrink-0 rounded-full text-ink-600"
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          </div>
        )}

      {hasNothing ? (
        <EmptyState
          icon="library"
          title="Nothing here yet"
          body="Find a show and FilterPod will cut the language before you hear it."
          action={
            <Link to="/discover">
              <Button variant="primary" icon="search">
                Find a podcast
              </Button>
            </Link>
          }
        />
      ) : (
        <>
          {query.trim() === '' && continueRows.length > 0 && (
            <section className="px-4 pt-2 pb-5">
              <SectionLabel>Continue</SectionLabel>
              <div className="space-y-2">
                {continueRows.map(({ row, episode }) => (
                  <ContinueCard
                    key={row.episodeId}
                    episodeId={row.episodeId}
                    title={episode!.title}
                    remainingSec={row.durationSec - row.positionSec}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="px-4 pb-5">
            <SectionLabel>Shows</SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              {visibleShows.map((podcast) => (
                <Link
                  key={podcast.id}
                  to={`/podcast/${podcast.id}`}
                  className="focus-ring group block"
                >
                  <Artwork
                    src={podcast.artworkUrl}
                    alt={podcast.title}
                    className="aspect-square w-full transition group-active:scale-[0.97]"
                  />
                  <p className="mt-1.5 line-clamp-2 text-[12px] leading-tight text-ink-300">
                    {podcast.title}
                  </p>
                </Link>
              ))}
            </div>

            {trimmed !== '' && (
              <div className="pt-3">
                {visibleShows.length === 0 && (
                  <p className="pb-2 text-[13px] text-ink-600">Nothing in your library matches.</p>
                )}
                <Button
                  variant="secondary"
                  icon="search"
                  className="w-full"
                  onClick={() => navigate('/discover', { state: { term: query.trim() } })}
                >
                  Search everywhere for “{query.trim()}”
                </Button>
              </div>
            )}
          </section>
        </>
      )}
      </div>
    </PullToRefresh>
  )
}

function ContinueCard({
  episodeId,
  title,
  remainingSec,
}: {
  episodeId: string
  title: string
  remainingSec: number
}) {
  return (
    <button
      onClick={() => void usePlayerStore.getState().open(episodeId)}
      className="panel focus-ring flex w-full items-center gap-3 px-3.5 py-3 text-left active:scale-[0.99]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ember-500 text-panel-950">
        <Icon name="play" size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        <span className="tabular block text-[11px] text-ink-600">
          {timecode(remainingSec)} left
        </span>
      </span>
    </button>
  )
}

export function Header({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="rack-texture mb-1 flex items-end justify-between border-b border-panel-800 px-4 pt-3 pb-3">
      <h1 className="text-2xl">{title}</h1>
      {action}
    </div>
  )
}
