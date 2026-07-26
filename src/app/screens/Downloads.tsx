import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/data/db'
import { getPlatform } from '@/platform'
import { Button, EmptyState, FilterStatus, ProgressBar, StorageMeter } from '@/ui/components'
import { bytes, duration } from '@/ui/format'
import { Icon } from '@/ui/Icon'
import { Header } from './Library'
import {
  cancelDownload,
  deleteDownload,
  enforceStorageBudget,
} from '@/features/downloads/downloadManager'
import { usePlayerStore } from '@/features/player/playerStore'

/** Everything taking up space, and what stage it is at. */
export function Downloads() {
  const [usage, setUsage] = useState(0)

  const settings = useLiveQuery(() => db.settings.get('singleton'), [])
  const rows = useLiveQuery(
    async () => {
      const downloads = await db.downloads.orderBy('startedAt').reverse().toArray()
      const episodes = await db.episodes.bulkGet(downloads.map((d) => d.episodeId))
      const maps = await db.filterMaps.bulkGet(downloads.map((d) => d.episodeId))
      return downloads
        .map((download, index) => ({
          download,
          episode: episodes[index],
          map: maps[index],
        }))
        .filter((row) => row.episode)
    },
    [],
    [],
  )

  useEffect(() => {
    void getPlatform().files.usageBytes().then(setUsage)
  }, [rows])

  const open = usePlayerStore((state) => state.open)
  const active = rows.filter(
    (row) => row.download.state === 'downloading' || row.download.state === 'queued',
  )
  const stored = rows.filter((row) => row.download.state === 'downloaded')
  const failed = rows.filter(
    (row) => row.download.state === 'failed' || row.download.state === 'cancelled',
  )

  return (
    <div className="animate-rise pb-6">
      <Header title="Downloads" />

      <div className="px-4 py-4">
        <StorageMeter used={usage} total={settings?.maxStorageBytes ?? 0} />
        {usage > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            className="mt-2 px-0"
            onClick={() => void enforceStorageBudget().then(() => getPlatform().files.usageBytes().then(setUsage))}
          >
            Free up space
          </Button>
        )}
      </div>

      {rows.length === 0 && (
        <EmptyState
          icon="download"
          title="No downloads"
          body="Episodes have to be downloaded before they can be filtered — that all happens on your device."
        />
      )}

      {active.length > 0 && (
        <Section title={`In progress · ${active.length}`}>
          {active.map(({ download, episode, map }) => (
            <div key={download.episodeId} className="border-b border-panel-800 px-4 py-3">
              <p className="mb-2 line-clamp-1 text-[13px] font-medium">{episode!.title}</p>
              <ProgressBar
                value={
                  download.bytesTotal > 0 ? download.bytesDownloaded / download.bytesTotal : 0
                }
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="tabular text-[11px] text-ink-600">
                  {bytes(download.bytesDownloaded)}
                  {download.bytesTotal > 0 && ` / ${bytes(download.bytesTotal)}`}
                </span>
                <div className="flex items-center gap-2">
                  <FilterStatus map={map} download={download} compact />
                  <button
                    onClick={() => void cancelDownload(download.episodeId)}
                    aria-label="Cancel download"
                    className="focus-ring rounded-full p-1 text-ink-600"
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </Section>
      )}

      {stored.length > 0 && (
        <Section title={`On device · ${stored.length}`}>
          {stored.map(({ download, episode, map }) => (
            <div
              key={download.episodeId}
              className="flex items-center gap-3 border-b border-panel-800 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-[13px] font-medium">{episode!.title}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="tabular text-[11px] text-ink-600">
                    {bytes(download.bytesTotal || download.bytesDownloaded)}
                  </span>
                  <span className="text-panel-600">·</span>
                  <span className="tabular text-[11px] text-ink-600">
                    {duration(episode!.durationSec)}
                  </span>
                  <FilterStatus map={map} compact />
                </div>
              </div>

              {/* Downloaded is enough to play — filtering starts from wherever you
                  press play, so there is no separate step to perform here. */}
              <button
                onClick={() => void open(download.episodeId)}
                aria-label="Play"
                className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ember-500 text-panel-950"
              >
                <Icon name="play" size={16} />
              </button>

              <button
                onClick={() => void deleteDownload(download.episodeId)}
                aria-label="Delete download"
                className="focus-ring shrink-0 rounded-full p-1.5 text-ink-600"
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </Section>
      )}

      {failed.length > 0 && (
        <Section title={`Failed · ${failed.length}`}>
          {failed.map(({ download, episode }) => (
            <div key={download.episodeId} className="border-b border-panel-800 px-4 py-3">
              <p className="line-clamp-1 text-[13px] font-medium">{episode!.title}</p>
              <p className="mt-0.5 text-[11px] text-alarm-400">
                {download.error ?? 'Cancelled'}
              </p>
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h2 className="silkscreen px-4 pb-2">{title}</h2>
      <div className="border-t border-panel-800">{children}</div>
    </section>
  )
}
