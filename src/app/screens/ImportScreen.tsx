import { useEffect, useRef, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { getPlatform } from '@/platform'
import { subscribeToFeed } from '@/features/subscriptions/service'
import { parseOpml, type OpmlFeed } from '@/features/import/opml'
import {
  SPOTIFY_REDIRECT_NATIVE,
  SPOTIFY_REDIRECT_WEB,
  beginAuth,
  completeAuth,
  fetchSavedShows,
  matchShow,
  parseSpotifyExport,
  spotifyConfigured,
  type ShowMatch,
} from '@/features/import/spotify'
import { Button, SectionLabel } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { Header } from './Library'
import {
  ApplePodcastsLogo,
  OvercastLogo,
  PocketCastsLogo,
  SpotifyLogo,
} from '@/ui/AppLogos'

type ItemState = 'pending' | 'importing' | 'done' | 'failed'

interface ImportItem {
  title: string
  feedUrl: string
  state: ItemState
}

/** How many feeds import at once. Feed fetches are network-bound; three keeps it moving. */
const CONCURRENCY = 3

export function ImportScreen() {
  const [items, setItems] = useState<ImportItem[]>([])
  const [running, setRunning] = useState(false)
  const [spotifyBusy, setSpotifyBusy] = useState(false)
  const [unmatched, setUnmatched] = useState<ShowMatch[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const spotifyFileRef = useRef<HTMLInputElement>(null)

  const redirectUri =
    getPlatform().name === 'android' ? SPOTIFY_REDIRECT_NATIVE : SPOTIFY_REDIRECT_WEB

  /** Both callback legs (custom scheme on Android, sessionStorage relay on web). */
  useEffect(() => {
    const stored = sessionStorage.getItem('spotify_code')
    if (stored) {
      sessionStorage.removeItem('spotify_code')
      void handleSpotifyCode(stored)
    }
    const listener = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      const code = new URL(url).searchParams.get('code')
      if (code) void handleSpotifyCode(code)
    })
    return () => {
      void listener.then((l) => l.remove())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function matchAndQueue(shows: Awaited<ReturnType<typeof fetchSavedShows>>) {
    const matches: ShowMatch[] = []
    for (const show of shows) matches.push(await matchShow(show))
    setUnmatched(matches.filter((match) => !match.feedUrl))
    queueFeeds(
      matches
        .filter((match): match is ShowMatch & { feedUrl: string } => Boolean(match.feedUrl))
        .map((match) => ({ title: match.matchedTitle ?? match.show.name, feedUrl: match.feedUrl })),
    )
  }

  async function handleSpotifyCode(code: string) {
    setSpotifyBusy(true)
    setError(null)
    try {
      const token = await completeAuth(code, redirectUri)
      await matchAndQueue(await fetchSavedShows(token))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSpotifyBusy(false)
    }
  }

  async function onSpotifyExportPicked(file: File) {
    setSpotifyBusy(true)
    setError(null)
    try {
      await matchAndQueue(await parseSpotifyExport(file))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSpotifyBusy(false)
    }
  }

  function queueFeeds(feeds: OpmlFeed[]) {
    setItems(feeds.map((feed) => ({ ...feed, state: 'pending' as ItemState })))
  }

  async function onOpmlPicked(file: File) {
    setError(null)
    try {
      const feeds = parseOpml(await file.text())
      if (feeds.length === 0) throw new Error('no feeds found in that file')
      queueFeeds(feeds)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function runImport() {
    setRunning(true)
    const queue = [...items.keys()].filter((index) => items[index].state !== 'done')
    const mark = (index: number, state: ItemState) =>
      setItems((current) => current.map((item, i) => (i === index ? { ...item, state } : item)))

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const index = queue.shift()
          if (index === undefined) return
          mark(index, 'importing')
          try {
            await subscribeToFeed(items[index].feedUrl)
            mark(index, 'done')
          } catch {
            mark(index, 'failed')
          }
        }
      }),
    )
    setRunning(false)
  }

  const doneCount = items.filter((item) => item.state === 'done').length
  const failedCount = items.filter((item) => item.state === 'failed').length

  return (
    <div className="animate-rise pb-8">
      <Header title="Import" />

      <section className="px-4 pt-4">
        <div className="mb-1 flex items-center gap-2">
          <span className="flex items-center">
            {[PocketCastsLogo, OvercastLogo, ApplePodcastsLogo].map((Logo, index) => (
              <span
                key={index}
                className="rounded-full ring-2 ring-panel-950"
                style={{ width: 22, height: 22, marginLeft: index === 0 ? 0 : -6 }}
              >
                <Logo />
              </span>
            ))}
          </span>
          <SectionLabel>From Pocket Casts and others</SectionLabel>
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-500">
          Export an OPML file from your old app — in Pocket Casts that is Settings, then
          Import &amp; Export — and open it here. Subscriptions transfer; queues and
          listening history are not in the file, because no app exports them.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".opml,.xml,text/xml,text/x-opml"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void onOpmlPicked(file)
            event.target.value = ''
          }}
        />
        <Button variant="primary" icon="plus" onClick={() => fileRef.current?.click()}>
          Choose OPML file
        </Button>
      </section>

      <section className="px-4 pt-7">
        <div className="mb-1 flex items-center gap-2">
          <span className="rounded-full" style={{ width: 22, height: 22 }}>
            <SpotifyLogo />
          </span>
          <SectionLabel>From Spotify</SectionLabel>
        </div>
        <p className="mb-3 text-[13px] leading-relaxed text-ink-500">
          Request your data from Spotify (Account, then Privacy, then &ldquo;Download your
          data&rdquo;) — the file arrives by email in a day or two. Open it here and each
          saved show is matched to its real podcast feed. Shows without a clean match are
          listed rather than guessed at, since a wrong guess would subscribe you to the
          wrong podcast.
        </p>
        <input
          ref={spotifyFileRef}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void onSpotifyExportPicked(file)
            event.target.value = ''
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon="plus"
            disabled={spotifyBusy}
            onClick={() => spotifyFileRef.current?.click()}
          >
            {spotifyBusy ? 'Matching shows…' : 'Open data export'}
          </Button>
          {spotifyConfigured() && (
            <Button
              variant="secondary"
              icon="search"
              disabled={spotifyBusy}
              onClick={async () => {
                location.href = await beginAuth(redirectUri)
              }}
            >
              Connect Spotify
            </Button>
          )}
        </div>
      </section>

      {error && (
        <p className="mx-4 mt-4 rounded-lg bg-alarm-500/10 px-3 py-2 text-[13px] text-alarm-400 ring-1 ring-alarm-500/25">
          {error}
        </p>
      )}

      {unmatched.length > 0 && (
        <section className="px-4 pt-6">
          <SectionLabel>No clean match — add these by hand</SectionLabel>
          {unmatched.map((match) => (
            <p key={match.show.name} className="py-1 text-[13px] text-ink-500">
              {match.show.name}
              <span className="text-ink-600"> · {match.show.publisher}</span>
            </p>
          ))}
        </section>
      )}

      {items.length > 0 && (
        <section className="px-4 pt-6">
          <div className="mb-2 flex items-center justify-between">
            <SectionLabel>
              {doneCount + failedCount === items.length && !running
                ? `Imported ${doneCount} of ${items.length}`
                : `${items.length} shows found`}
            </SectionLabel>
            <Button size="sm" variant="primary" disabled={running} onClick={() => void runImport()}>
              {running ? 'Importing…' : doneCount > 0 ? 'Retry failed' : 'Import all'}
            </Button>
          </div>
          <ol className="overflow-hidden rounded-xl ring-1 ring-panel-800">
            {items.map((item) => (
              <li
                key={item.feedUrl}
                className="flex items-center gap-2.5 border-b border-panel-800 bg-panel-900/60 px-3 py-2 last:border-b-0"
              >
                <span className="w-4 shrink-0 text-center">
                  {item.state === 'done' && <Icon name="check" size={13} className="text-sage-400" />}
                  {item.state === 'failed' && <Icon name="close" size={13} className="text-alarm-400" />}
                  {item.state === 'importing' && (
                    <Icon name="refresh" size={13} className="animate-spin text-ink-500" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-300">{item.title}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}
