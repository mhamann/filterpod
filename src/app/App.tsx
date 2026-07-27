import { useEffect, useState } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom'
import clsx from 'clsx'
import { Icon, type IconName } from '@/ui/Icon'
import { ProgressBar } from '@/ui/components'
import { useModelStore } from '@/features/filter/modelStore'
import { bootstrap } from './bootstrap'
import { ErrorBoundary } from './ErrorBoundary'
import { Library } from './screens/Library'
import { Discover } from './screens/Discover'
import { PodcastDetail } from './screens/PodcastDetail'
import { Downloads } from './screens/Downloads'
import { Queue } from './screens/Queue'
import { Settings } from './screens/Settings'
import { MiniPlayer, NowPlaying } from './NowPlaying'
import { usePlayerStore } from '@/features/player/playerStore'

const TABS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/', label: 'Library', icon: 'library' },
  { to: '/discover', label: 'Discover', icon: 'search' },
  { to: '/downloads', label: 'Downloads', icon: 'download' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

export function App() {
  const [ready, setReady] = useState(false)
  const [playerOpen, setPlayerOpen] = useState(false)
  const blockedReason = usePlayerStore((state) => state.blockedReason)

  useEffect(() => {
    void bootstrap().finally(() => setReady(true))
  }, [])

  if (!ready) return <Splash />

  return (
    <HashRouter>
      {/*
        The status-bar inset belongs here, on the non-scrolling shell, not on <main>.
        Padding on a scroll container is part of its scrollable box, so content just
        scrolls up through it and back under the status bar.
      */}
      <div className="safe-top relative z-[2] flex h-full flex-col">
        <main className="flex-1 overflow-y-auto overscroll-contain">
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/podcast/:podcastId" element={<PodcastDetail />} />
              <Route path="/queue" element={<Queue />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </ErrorBoundary>
        </main>

        <ModelBanner />

        {blockedReason && <BlockedBanner reason={blockedReason} />}

        <MiniPlayer onExpand={() => setPlayerOpen(true)} />

        <nav className="safe-bottom rack-texture flex border-t border-panel-800 bg-panel-900">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'focus-ring relative flex flex-1 flex-col items-center gap-1 py-2.5 transition-colors',
                  isActive ? 'text-ember-400' : 'text-ink-600',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute top-0 h-[2px] w-8 rounded-full bg-ember-500" />
                  )}
                  <Icon name={tab.icon} size={20} />
                  <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>

      <NowPlaying open={playerOpen} onClose={() => setPlayerOpen(false)} />
    </HashRouter>
  )
}

/**
 * Speech model download, shown while you browse.
 *
 * It runs in the background from startup so subscribing and downloading are not blocked
 * on it, but it is a ~150MB fetch — leaving it entirely invisible would make the first
 * press of play look broken for no reason.
 */
function ModelBanner() {
  const state = useModelStore((s) => s.state)
  const fraction = useModelStore((s) => s.fraction)
  if (state !== 'downloading') return null

  return (
    <div className="mx-3 mb-2 rounded-xl bg-panel-850 px-3.5 py-2.5 ring-1 ring-panel-700">
      <div className="mb-1.5 flex items-center gap-2.5">
        <Icon name="download" size={15} className="shrink-0 text-ink-500" />
        <p className="flex-1 text-[12px] text-ink-300">Getting the speech model…</p>
        <span className="tabular text-[11px] text-ink-500">
          {Math.round(fraction * 100)}%
        </span>
      </div>
      <ProgressBar value={fraction} />
      <p className="mt-1.5 text-[11px] leading-snug text-ink-600">
        A one-time download. You can keep subscribing and downloading meanwhile.
      </p>
    </div>
  )
}

/** Shown when playback is refused because an episode has not been filtered. */
function BlockedBanner({ reason }: { reason: string }) {
  return (
    <div className="animate-rise mx-3 mb-2 flex items-center gap-2.5 rounded-xl bg-ember-500/10 px-3.5 py-2.5 ring-1 ring-ember-500/30">
      <Icon name="shield" size={17} className="shrink-0 text-ember-400" />
      <p className="text-[12px] leading-snug text-ember-300">{reason}</p>
    </div>
  )
}

function Splash() {
  return (
    <div className="relative z-[2] flex h-full flex-col items-center justify-center gap-4">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ember-500 text-panel-950">
        <Icon name="scissors" size={30} />
      </div>
      <p className="silkscreen animate-pulse-ember">Starting up</p>
    </div>
  )
}
