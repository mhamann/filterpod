import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { searchPodcasts, type SearchResult } from '@/features/discovery/search'
import { fetchTopPodcasts, type ChartPodcast } from '@/features/discovery/charts'
import { subscribeToFeed } from '@/features/subscriptions/service'
import { fetchFeed } from '@/features/feeds/refresh'
import { Artwork, Button, EmptyState } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { Header } from './Library'
import { db } from '@/data/db'
import { useLiveQuery } from 'dexie-react-hooks'

/** Search by name, paste a feed URL, or pick from the charts below. */
export function Discover() {
  // A search started on the Library lands here with its term intact, so the user
  // types it once and the two screens behave as one search.
  const handedTerm = (useLocation().state as { term?: string } | null)?.term ?? ''
  const [term, setTerm] = useState(handedTerm)
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const subscribedIds = useLiveQuery(
    async () => new Set((await db.subscriptions.toArray()).map((s) => s.podcastId)),
    [],
    new Set<string>(),
  )

  const looksLikeUrl = /^https?:\/\//i.test(term.trim())

  useEffect(() => {
    if (looksLikeUrl) {
      setResults([])
      return
    }
    const query = term.trim()
    if (query.length < 2) {
      setResults([])
      return
    }

    // Debounced: iTunes Search rate-limits, and typing should not burn that budget.
    const timer = setTimeout(async () => {
      setBusy(true)
      setError(null)
      try {
        setResults(await searchPodcasts(query))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setBusy(false)
      }
    }, 350)

    return () => clearTimeout(timer)
  }, [term, looksLikeUrl])

  const addFeed = async (feedUrl: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await subscribeToFeed(feedUrl)
      navigate(`/podcast/${result.podcastId}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Opens a show without subscribing to it.
   *
   * fetchFeed persists the podcast and its episodes but writes no subscription row, so
   * the show page opens with a Subscribe button and playable episodes — a one-off
   * listen never has to become a commitment. Stale previews are pruned at startup.
   */
  const previewFeed = async (feedUrl: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await fetchFeed(feedUrl, false)
      if (result.error) throw new Error(result.error)
      navigate(`/podcast/${result.podcastId}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animate-rise pb-6">
      <Header title="Discover" />

      <div className="px-4 py-3">
        <div className="flex items-center gap-2.5 rounded-full bg-panel-850 px-4 py-2.5 ring-1 ring-panel-700 focus-within:ring-ember-500/50">
          <Icon name="search" size={17} className="shrink-0 text-ink-600" />
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search shows, or paste an RSS URL"
            inputMode="search"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-600"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              aria-label="Clear search"
              className="focus-ring shrink-0 rounded-full text-ink-600"
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>

        {looksLikeUrl && (
          <Button
            variant="primary"
            icon="plus"
            className="mt-3 w-full"
            disabled={busy}
            onClick={() => void addFeed(term.trim())}
          >
            {busy ? 'Loading feed…' : 'Add this feed'}
          </Button>
        )}

        {error && (
          <p className="mt-3 rounded-lg bg-alarm-500/10 px-3 py-2 text-[13px] text-alarm-400 ring-1 ring-alarm-500/25">
            {error}
          </p>
        )}
      </div>

      {!term && (
        <PopularGrid
          subscribedIds={subscribedIds}
          busy={busy}
          onAdd={addFeed}
          onPreview={(feedUrl) => void previewFeed(feedUrl)}
        />
      )}

      {busy && !looksLikeUrl && (
        <p className="silkscreen animate-pulse-ember px-4 py-3">Searching…</p>
      )}

      <div>
        {results.map((result) => (
          <article
            key={result.id}
            className="flex items-center gap-3 border-b border-panel-800 px-4 py-3"
          >
            <button
              onClick={() => void previewFeed(result.feedUrl)}
              disabled={busy}
              className="focus-ring flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <Artwork src={result.artworkUrl} alt={result.title} className="h-14 w-14" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{result.title}</span>
                <span className="block truncate text-[12px] text-ink-600">{result.author}</span>
              </span>
            </button>
            {subscribedIds.has(result.id) ? (
              <Button
                size="sm"
                variant="ghost"
                icon="check"
                onClick={() => navigate(`/podcast/${result.id}`)}
              >
                Added
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon="plus"
                disabled={busy}
                onClick={() => void addFeed(result.feedUrl)}
              >
                Add
              </Button>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}

/**
 * The charts, shown while the search box is empty.
 *
 * A Discover tab that opens onto an empty prompt asks the user to already know what
 * they want, which is backwards. The chart gives a full screen of shows people have
 * actually heard of, one tap from subscribed.
 */
function PopularGrid({
  subscribedIds,
  busy,
  onAdd,
  onPreview,
}: {
  subscribedIds: Set<string>
  busy: boolean
  onAdd(feedUrl: string): Promise<void>
  onPreview(feedUrl: string): void
}) {
  const navigate = useNavigate()
  const [shows, setShows] = useState<ChartPodcast[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchTopPodcasts()
      .then((results) => {
        if (!cancelled) setShows(results)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed || (shows && shows.length === 0)) {
    // Offline, or the chart is unreachable: fall back to the old prompt quietly
    // rather than parking an error where a browse screen should be.
    return (
      <EmptyState
        icon="search"
        title="Find something to listen to"
        body="Search by show name, or paste an RSS feed URL if you already have one."
      />
    )
  }

  if (!shows) {
    return <p className="silkscreen animate-pulse-ember px-4 py-3">Loading popular shows…</p>
  }

  return (
    <section className="px-4 pb-6">
      <p className="silkscreen mb-2">Popular</p>
      <div className="grid grid-cols-3 gap-3">
        {shows.map((show) => {
          const subscribed = subscribedIds.has(show.id)
          return (
            <button
              key={show.id}
              disabled={busy}
              // The tile is a look, not a commitment: it opens the show's page. The
              // corner badge is the shortcut for people who already know they want it.
              onClick={() => onPreview(show.feedUrl)}
              className="focus-ring group block text-left"
            >
              <span className="relative block">
                <Artwork
                  src={show.artworkUrl}
                  alt={show.title}
                  className="aspect-square w-full transition group-active:scale-[0.97]"
                />
                <span
                  role="button"
                  aria-label={subscribed ? `Open ${show.title}` : `Subscribe to ${show.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (subscribed) navigate(`/podcast/${show.id}`)
                    else void onAdd(show.feedUrl)
                  }}
                  className={
                    subscribed
                      ? 'absolute right-1.5 bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-sage-500 text-panel-950'
                      : 'absolute right-1.5 bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-panel-950/80 text-ink-100 ring-1 ring-panel-600'
                  }
                >
                  <Icon name={subscribed ? 'check' : 'plus'} size={14} />
                </span>
              </span>
              <span className="mt-1.5 line-clamp-2 block text-[12px] leading-tight text-ink-300">
                {show.title}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
