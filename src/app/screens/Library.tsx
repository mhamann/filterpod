import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { Artwork, Button, EmptyState, FilterStatus, SectionLabel } from '@/ui/components'
import { EpisodeRow } from '@/ui/EpisodeRow'
import { timecode } from '@/ui/format'
import { refreshAndAutoDownload } from '@/features/subscriptions/service'
import { usePlayerStore } from '@/features/player/playerStore'
import { useState } from 'react'
import { Icon } from '@/ui/Icon'

/** Home: what is ready to play, and what you subscribe to. */
export function Library() {
  const [refreshing, setRefreshing] = useState(false)

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

  /**
   * Ready-to-play episodes: downloaded and unfinished.
   *
   * Downloaded is the bar now, not filtered — filtering starts when you press play, so
   * gating this on a completed filter map would leave the section permanently empty.
   */
  const readyEpisodes = useLiveQuery(
    async () => {
      const downloads = await db.downloads.where('state').equals('downloaded').toArray()
      if (downloads.length === 0) return []
      const ids = downloads.map((download) => download.episodeId)
      const [episodes, progress] = await Promise.all([
        db.episodes.bulkGet(ids),
        db.progress.bulkGet(ids),
      ])
      return episodes
        .map((episode, index) => ({ episode, played: progress[index]?.played ?? false }))
        .filter((row) => row.episode && !row.played)
        .map((row) => row.episode!)
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 30)
    },
    [],
    [],
  )

  const inProgress = useLiveQuery(
    async () => {
      const rows = await db.progress.orderBy('lastPlayedAt').reverse().limit(30).toArray()
      const unfinished = rows.filter((row) => !row.played && row.positionSec > 5).slice(0, 5)
      const episodes = await db.episodes.bulkGet(unfinished.map((row) => row.episodeId))
      return unfinished
        .map((row, index) => ({ row, episode: episodes[index] }))
        .filter((entry) => entry.episode)
    },
    [],
    [],
  )

  const hasNothing = subscriptions.length === 0

  return (
    <div className="animate-rise pb-6">
      <Header
        title="Library"
        action={
          <button
            aria-label="Refresh feeds"
            onClick={async () => {
              setRefreshing(true)
              try {
                await refreshAndAutoDownload()
              } finally {
                setRefreshing(false)
              }
            }}
            className="focus-ring rounded-full p-2 text-ink-500 disabled:opacity-40"
            disabled={refreshing}
          >
            <Icon name="refresh" size={19} className={refreshing ? 'animate-spin' : ''} />
          </button>
        }
      />

      {hasNothing ? (
        <EmptyState
          icon="library"
          title="Nothing here yet"
          body="Find a show and FilterPod will download it, listen through it, and cut the language before you hear it."
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
          {inProgress.length > 0 && (
            <section className="px-4 pt-2 pb-5">
              <SectionLabel>Continue</SectionLabel>
              <div className="space-y-2">
                {inProgress.map(({ row, episode }) => (
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
            <SectionLabel>
              Shows · {subscriptions.length}
            </SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              {subscriptions.map((podcast) => (
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
          </section>

          <section>
            <div className="px-4">
              <SectionLabel>Ready to play</SectionLabel>
            </div>
            {readyEpisodes.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-ink-600">
                Nothing downloaded yet. Episodes appear here once they finish downloading —
                filtering starts when you press play.
              </p>
            ) : (
              <div className="border-t border-panel-800">
                {readyEpisodes.map((episode) => (
                  <EpisodeRow key={episode.id} episode={episode} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
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
  const filterMap = useLiveQuery(() => db.filterMaps.get(episodeId), [episodeId])
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
      <FilterStatus map={filterMap} compact />
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
