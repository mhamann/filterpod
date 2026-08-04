import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import clsx from 'clsx'
import { db, type WordOverride } from '@/data/db'
import { DEFAULT_PROFILES } from '@/data/defaults'
import { updateSettings } from '@/data/repo'
import { exportLibraryBackup, importLibraryBackup } from '@/data/backup'
import { getPlatform } from '@/platform'
import { useModelStore } from '@/features/filter/modelStore'
import { refreshAndAutoDownload } from '@/features/subscriptions/service'
import { Button, Pill, ProgressBar } from '@/ui/components'
import { Icon } from '@/ui/Icon'
import { bytes } from '@/ui/format'
import { Header } from './Library'
import { Toggle } from './PodcastDetail'
import type { Settings as SettingsType } from '@/core/types'

/** Where the source lives, offered from inside the app — see the About group. */
const SOURCE_URL = 'https://github.com/mhamann/filterpod'

/**
 * Deliberately worded without examples.
 *
 * An app whose whole job is removing this language should not print it on its own
 * settings screen, so the levels are described by strength and category instead.
 */
const PROFILE_BLURBS: Record<string, string> = {
  family: 'The strictest setting. Cuts mild words and casual religious exclamations as well as everything stronger.',
  standard: 'Cuts strong and moderate language. Milder words and exclamations are left in.',
  'strong-only': 'Cuts only the harshest language. Everything milder plays through.',
  off: 'No filtering. Episodes play exactly as published.',
}

/** Speeds measured on a Pixel 7 Pro, so the trade-off is concrete rather than vague. */
const MODEL_BLURBS: Record<string, string> = {
  'tiny.en': 'Fastest by a wide margin, and misses more. Worth switching to if filtering struggles to keep up on your phone.',
  'base.en': 'Balanced, and about three times faster than playback — it stays ahead comfortably. The default.',
  'small.en': 'The most accurate, and slow enough that playback may pause to wait for it.',
}

export function Settings() {
  const settings = useLiveQuery(() => db.settings.get('singleton'), [])
  const overrides = useLiveQuery(() => db.wordOverrides.toArray(), [], [])
  const platform = getPlatform()

  if (!settings) return null

  return (
    <div className="animate-rise pb-8">
      <Header title="Settings" />

      <Group label="Filtering">
        <div className="space-y-2 px-4 py-3">
          {DEFAULT_PROFILES.map((profile) => {
            const active = settings.activeFilterProfileId === profile.id
            return (
              <button
                key={profile.id}
                onClick={() => void updateSettings({ activeFilterProfileId: profile.id })}
                className={clsx(
                  'focus-ring block w-full rounded-xl px-4 py-3 text-left ring-1 transition',
                  active
                    ? 'bg-ember-500/10 ring-ember-500/40'
                    : 'bg-panel-850 ring-panel-700 active:scale-[0.99]',
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      'text-[14px] font-medium',
                      active ? 'text-ember-300' : 'text-ink-100',
                    )}
                  >
                    {profile.name}
                  </span>
                  {active && <Icon name="check" size={16} className="text-ember-400" />}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                  {PROFILE_BLURBS[profile.id]}
                </p>
              </button>
            )
          })}
        </div>

        <p className="px-4 pb-3 text-[12px] leading-relaxed text-ink-600">
          Episodes are filtered as you listen, starting from wherever you press play.
          Playback never runs past the part that has been checked, so nothing is ever
          played unfiltered.
        </p>
      </Group>

      <WordOverrides overrides={overrides} />

      <Group label="Transcription">
        <div className="space-y-2 px-4 py-3">
          {(['tiny.en', 'base.en', 'small.en'] as const).map((model) => {
            const active = settings.whisperModel === model
            return (
              <button
                key={model}
                onClick={() => void updateSettings({ whisperModel: model })}
                className={clsx(
                  'focus-ring block w-full rounded-xl px-4 py-3 text-left ring-1 transition',
                  active
                    ? 'bg-ember-500/10 ring-ember-500/40'
                    : 'bg-panel-850 ring-panel-700 active:scale-[0.99]',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="tabular text-[13px] font-medium">{model}</span>
                  {active && <Icon name="check" size={16} className="text-ember-400" />}
                </div>
                <p className="mt-0.5 text-[12px] text-ink-500">{MODEL_BLURBS[model]}</p>
              </button>
            )
          })}
        </div>
        <ModelReadiness model={settings.whisperModel} />

        <p className="px-4 pb-3 text-[12px] leading-relaxed text-ink-600">
          Filtering runs on this device. Audio and transcripts never leave it. If Android
          backup is enabled, an encrypted copy of your library, settings and listening
          progress can be stored in your Google account; FilterPod has no server.
        </p>
      </Group>

      <Group label="Playback">
        <StepperRow
          title="Skip forward"
          value={settings.skipForwardSec}
          options={[15, 30, 45, 60]}
          onChange={(value) => void updateSettings({ skipForwardSec: value })}
          suffix="s"
        />
        <StepperRow
          title="Skip back"
          value={settings.skipBackSec}
          options={[5, 10, 15, 30]}
          onChange={(value) => void updateSettings({ skipBackSec: value })}
          suffix="s"
        />
      </Group>

      <Group label="Storage & network">
        <StepperRow
          title="Storage limit"
          value={settings.maxStorageBytes}
          options={[
            1024 ** 3,
            2 * 1024 ** 3,
            4 * 1024 ** 3,
            8 * 1024 ** 3,
          ]}
          format={bytes}
          onChange={(value) => void updateSettings({ maxStorageBytes: value })}
        />
        <Row title="Download on Wi-Fi only">
          <Toggle
            checked={settings.autoDownloadOnWifiOnly}
            onChange={(next) => void updateSettings({ autoDownloadOnWifiOnly: next })}
          />
        </Row>
      </Group>

      <Group label="Import">
        <div className="px-4 py-3">
          <p className="mb-2.5 text-[13px] leading-relaxed text-ink-500">
            Moving from another app? Bring your subscriptions across.
          </p>
          <a
            href="#/import"
            className="focus-ring inline-flex items-center gap-2 rounded-full bg-panel-800 px-4 py-2 text-sm font-medium text-ink-100 ring-1 ring-panel-700"
          >
            <Icon name="plus" size={15} /> Import subscriptions
          </a>
        </div>
      </Group>

      <BackupAndRestore />

      <Group label="About">
        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-300">Platform</span>
            <Pill tone="neutral">{platform.name}</Pill>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-ink-300">Background playback</span>
            <Pill tone={platform.supportsBackgroundPlayback ? 'sage' : 'ember'}>
              {platform.supportsBackgroundPlayback ? 'Supported' : 'Foreground only'}
            </Pill>
          </div>
          {!platform.supportsBackgroundPlayback && (
            <p className="pt-1 text-[12px] leading-relaxed text-ink-600">
              In a browser, skipping stops working once the screen turns off. Install the
              Android app for background playback.
            </p>
          )}

          {/*
            Not decoration. FilterPod is under the AGPL, whose §13 entitles anyone using a
            modified version over a network to its source — and the browser build is
            exactly that case. Linking it from inside the app is the honest way to offer
            it, and it is the right thing to show regardless: an app that decides what you
            are allowed to hear should be one you can go and read.
          */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[13px] text-ink-300">Source</span>
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded-full text-[12px] text-ember-400 underline underline-offset-2"
            >
              AGPL v3 · GitHub
            </a>
          </div>
        </div>
      </Group>
    </div>
  )
}

function BackupAndRestore() {
  const platform = getPlatform()
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  const exportBackup = async () => {
    setBusy('export')
    setMessage(null)
    try {
      const saved = await exportLibraryBackup()
      setMessage(saved ? { text: 'Backup saved.' } : null)
    } catch (error) {
      setMessage({ text: messageFor(error, 'Could not export the backup.'), error: true })
    } finally {
      setBusy(null)
    }
  }

  const importBackup = async () => {
    setBusy('import')
    setMessage(null)
    try {
      const result = await importLibraryBackup()
      if (result.cancelled) return
      // Imported subscriptions carry stable feed URLs. Refresh immediately so their
      // episode and podcast rows are usable without requiring an app restart.
      const refreshed = await refreshAndAutoDownload().then(
        () => true,
        () => false,
      )
      setMessage({
        text: `Restored ${result.subscriptions} ${result.subscriptions === 1 ? 'subscription' : 'subscriptions'} and ${result.progress} listening ${result.progress === 1 ? 'position' : 'positions'}.${refreshed ? '' : ' Feed refresh will retry when you are online.'}`,
      })
    } catch (error) {
      setMessage({ text: messageFor(error, 'Could not import the backup.'), error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Group label="Backup & restore">
      <div className="px-4 py-3">
        <p className="text-[13px] leading-relaxed text-ink-500">
          {platform.name === 'android'
            ? 'Android automatically backs up the compact library snapshot when system backup is enabled. Audio, speech models and generated filter data are rebuilt instead.'
            : 'Save a portable copy of your library, listening progress and settings.'}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-600">
          Export creates a JSON file you control and can keep in Drive. Import merges
          subscriptions, keeps newer progress already on this device, and restores the
          saved queue only when the current queue is empty.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon="upload"
            disabled={busy !== null}
            onClick={() => void exportBackup()}
          >
            {busy === 'export' ? 'Saving…' : 'Export backup'}
          </Button>
          <Button
            variant="secondary"
            icon="download"
            disabled={busy !== null}
            onClick={() => void importBackup()}
          >
            {busy === 'import' ? 'Restoring…' : 'Import backup'}
          </Button>
        </div>
        {message && (
          <p
            className={clsx(
              'mt-3 rounded-lg px-3 py-2 text-[12px] ring-1',
              message.error
                ? 'bg-alarm-500/10 text-alarm-400 ring-alarm-500/25'
                : 'bg-sage-500/10 text-sage-300 ring-sage-500/25',
            )}
          >
            {message.text}
          </p>
        )}
      </div>
    </Group>
  )
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Model download state.
 *
 * This is the *only* thing filtering needs the network for. Downloaded episodes are
 * already local and transcription runs on-device, so once the model is cached the whole
 * pipeline works offline — no need to process episodes in advance. Fetching it is
 * therefore what "getting ready to go offline" actually means.
 */
function ModelReadiness({ model }: { model: string }) {
  const state = useModelStore((s) => s.state)
  const fraction = useModelStore((s) => s.fraction)
  const ensure = useModelStore((s) => s.ensure)
  const refresh = useModelStore((s) => s.refresh)

  // Reflects the background download started at startup, rather than tracking a
  // separate one — otherwise switching models here could run two at once.
  useEffect(() => {
    void refresh(model)
  }, [model, refresh])

  // The manual button ignores the Wi-Fi-only preference: an explicit tap is consent.
  const fetchModel = () => void ensure(model).catch(() => {})

  return (
    <div className="border-t border-panel-800 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">Ready for offline</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-600">
            Filtering only needs the network once, to fetch the speech model. After that
            it works with no connection at all.
          </p>
        </div>
        <Button
          size="sm"
          variant={state === 'ready' ? 'ghost' : 'secondary'}
          icon={state === 'ready' ? 'check' : 'download'}
          disabled={state === 'downloading'}
          onClick={() => void fetchModel()}
        >
          {state === 'downloading'
            ? `${Math.round(fraction * 100)}%`
            : state === 'ready'
              ? 'Ready'
              : 'Get model'}
        </Button>
      </div>

      {state === 'downloading' && (
        <div className="mt-2">
          <ProgressBar value={fraction} />
        </div>
      )}
      {state === 'failed' && (
        <p className="mt-2 text-[12px] text-alarm-400">
          Could not download the model. Check your connection and try again.
        </p>
      )}
    </div>
  )
}

function WordOverrides({ overrides }: { overrides: WordOverride[] }) {
  const [term, setTerm] = useState('')
  const [action, setAction] = useState<'block' | 'allow'>('block')

  const add = async () => {
    const value = term.trim().toLowerCase()
    if (!value) return
    await db.wordOverrides.put({
      term: value,
      action,
      severity: 'moderate',
      category: 'custom',
      createdAt: Date.now(),
    })
    setTerm('')
  }

  return (
    <Group label="Your words">
      <div className="px-4 py-3">
        <div className="mb-2 flex gap-2">
          {(['block', 'allow'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setAction(option)}
              className={clsx(
                'focus-ring flex-1 rounded-full py-2 text-[13px] font-medium capitalize ring-1 transition',
                action === option
                  ? 'bg-panel-700 text-ink-100 ring-panel-600'
                  : 'bg-panel-850 text-ink-600 ring-panel-800',
              )}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void add()}
            placeholder={action === 'block' ? 'Word or phrase to cut' : 'Word to leave alone'}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-w-0 flex-1 rounded-full bg-panel-850 px-4 py-2 text-[14px] ring-1 ring-panel-700 outline-none placeholder:text-ink-600 focus:ring-ember-500/50"
          />
          <Button variant="secondary" icon="plus" onClick={() => void add()}>
            Add
          </Button>
        </div>

        {overrides.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {overrides.map((override) => (
              <button
                key={override.term}
                onClick={() => void db.wordOverrides.delete(override.term)}
                className={clsx(
                  'focus-ring inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] ring-1',
                  override.action === 'block'
                    ? 'bg-ember-500/10 text-ember-300 ring-ember-500/25'
                    : 'bg-sage-500/10 text-sage-300 ring-sage-500/25',
                )}
              >
                {override.term}
                <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}

        <p className="mt-3 text-[12px] leading-relaxed text-ink-600">
          Blocked words are cut in addition to the built-in list. Allowed words are never
          cut, even if the built-in list contains them.
        </p>
      </div>
    </Group>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h2 className="silkscreen px-4 pb-1">{label}</h2>
      <div className="border-y border-panel-800 bg-panel-900/40">{children}</div>
    </section>
  )
}

function Row({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-panel-800 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        {detail && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-600">{detail}</p>}
      </div>
      {children}
    </div>
  )
}

function StepperRow<T extends number>({
  title,
  value,
  options,
  onChange,
  suffix = '',
  format,
}: {
  title: string
  value: T
  options: readonly T[]
  onChange(value: T): void
  suffix?: string
  format?(value: T): string
}) {
  return (
    <div className="border-t border-panel-800 px-4 py-3">
      <p className="mb-2 text-[13px] font-medium">{title}</p>
      <div className="flex gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            onClick={() => onChange(option)}
            className={clsx(
              'tabular focus-ring flex-1 rounded-full py-1.5 text-[12px] ring-1 transition',
              option === value
                ? 'bg-ember-500 text-panel-950 ring-ember-500'
                : 'bg-panel-850 text-ink-500 ring-panel-700',
            )}
          >
            {format ? format(option) : `${option}${suffix}`}
          </button>
        ))}
      </div>
    </div>
  )
}

export type { SettingsType }
