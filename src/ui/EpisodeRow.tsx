import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import type { Episode } from '@/core/types'
import { db } from '@/data/db'
import { duration, relativeDate, timecode } from './format'
import { Button, FilterStatus, ProgressBar } from './components'
import { Icon } from './Icon'
import { enqueueDownload } from '@/features/downloads/downloadManager'
import { usePlayerStore } from '@/features/player/playerStore'

/**
 * One episode in a list.
 *
 * Shows three coupled states that the no-server design makes user-visible: downloaded,
 * filtered, and listening progress. The primary action changes to match whichever step
 * the episode is actually waiting on.
 */
export function EpisodeRow({ episode }: { episode: Episode }) {
  const download = useLiveQuery(() => db.downloads.get(episode.id), [episode.id])
  const filterMap = useLiveQuery(() => db.filterMaps.get(episode.id), [episode.id])
  const progress = useLiveQuery(() => db.progress.get(episode.id), [episode.id])

  const open = usePlayerStore((state) => state.open)
  const playingId = usePlayerStore((state) => state.episode?.id)
  const isCurrent = playingId === episode.id

  const isDownloaded = download?.state === 'downloaded'
  const isDownloading = download?.state === 'downloading' || download?.state === 'queued'

  const listened =
    progress && progress.durationSec > 0 ? progress.positionSec / progress.durationSec : 0

  /**
   * Play is always the primary action; downloading is a separate, optional one.
   *
   * Episodes stream, so being on disk is no longer a precondition for playing one — it
   * only decides whether it will still be there without a connection. Filtering starts on
   * its own from wherever you press play, so there is no "prepare this first" step of any
   * kind between wanting to listen and listening.
   */
  const primaryAction = () => void open(episode.id)

  return (
    <article
      className={clsx(
        'group relative border-b border-panel-800 px-4 py-3.5 transition-colors',
        isCurrent && 'bg-ember-500/[0.04]',
      )}
    >
      {isCurrent && <span className="absolute inset-y-0 left-0 w-[2px] bg-ember-500" />}

      <div className="mb-1.5 flex items-center gap-2">
        <time className="silkscreen">{relativeDate(episode.publishedAt)}</time>
        <span className="text-panel-600">·</span>
        <span className="tabular text-[11px] text-ink-600">{duration(episode.durationSec)}</span>
        {progress?.played && (
          <>
            <span className="text-panel-600">·</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-sage-400">
              <Icon name="check" size={11} /> Played
            </span>
          </>
        )}
      </div>

      <h3 className="mb-2 text-[15px] leading-snug font-medium text-ink-100">{episode.title}</h3>

      <p className="mb-3 line-clamp-2 text-[13px] leading-relaxed text-ink-500">
        {episode.description}
      </p>

      {/* Resume indicator, only once there is something to resume. */}
      {!progress?.played && listened > 0.01 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1">
            <ProgressBar value={listened} tone="sage" />
          </div>
          <span className="tabular text-[11px] text-ink-600">
            {timecode(progress!.durationSec - progress!.positionSec)} left
          </span>
        </div>
      )}

      {isDownloading && download.bytesTotal > 0 && (
        <div className="mb-3">
          <ProgressBar value={download.bytesDownloaded / download.bytesTotal} />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" icon="play" onClick={primaryAction}>
          Play
        </Button>

        {/* Keeping an episode offline is now a deliberate extra, not a prerequisite. */}
        {!isDownloaded && (
          <Button
            size="sm"
            variant="secondary"
            icon="download"
            onClick={() => void enqueueDownload(episode.id)}
            disabled={isDownloading}
          >
            {isDownloading ? 'Downloading' : 'Get'}
          </Button>
        )}

        <FilterStatus map={filterMap} download={download} compact />

        {filterMap?.status === 'ready' && filterMap.skippedSec > 0 && (
          <span className="tabular text-[11px] text-ink-600">
            −{timecode(filterMap.skippedSec)}
          </span>
        )}
      </div>
    </article>
  )
}
