import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchPodcasts, type SearchResult } from '@/features/discovery/search'
import { subscribeToFeed } from '@/features/subscriptions/service'
import { Artwork, Button, EmptyState } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { Header } from './Library'
import { db } from '@/data/db'
import { useLiveQuery } from 'dexie-react-hooks'

/** Search by name, or paste a feed URL directly. */
export function Discover() {
  const [term, setTerm] = useState('')
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
        <EmptyState
          icon="search"
          title="Find something to listen to"
          body="Search by show name, or paste an RSS feed URL if you already have one."
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
            <Artwork src={result.artworkUrl} alt={result.title} className="h-14 w-14" />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[14px] font-medium">{result.title}</h3>
              <p className="truncate text-[12px] text-ink-600">{result.author}</p>
            </div>
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
