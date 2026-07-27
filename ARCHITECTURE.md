# FilterPod — Architecture

A podcast player that automatically skips foul language, with no server component.

## The problem

Nothing on Android combines a real podcast client (RSS subscriptions, resume, offline) with
automatic profanity filtering. The closest prior art:

| App | Filters | Real podcast client | Android |
|---|---|---|---|
| [Earmuffs](https://earmuffs.app/) | yes | yes | **no — iOS only** |
| [Bleeped](https://bleepedapp.com/) | yes | **no — walled garden, no RSS** | yes |
| [BetterCast](https://apps.apple.com/us/app/bettercast-podcast-player/id6759830475) | keyword skip | yes | **no — iOS only** |

FilterPod fills that gap.

## Hard constraints

1. **No server components.** Every network call is a direct fetch of a third-party resource
   (RSS, artwork, audio). All compute — transcription, matching, filtering — runs on device.
2. **Android first**, via a single web codebase packaged with Capacitor.
3. **Skip** is the filter action: flagged spans are seeked past, not muted or bleeped.

## Consequences of "no server"

These follow directly from constraint 1 and shape everything downstream.

**Filtering happens while you listen, not ahead of time.** Producing a filter map means
transcribing the episode, which is by far the most expensive thing the app does. The
obvious design — transcribe every episode as it finishes downloading — is wrong on a
phone: it pins the CPU for episodes that may never be played, and a few auto-downloads
turn into sustained heat and battery drain.

So filtering is driven by the playhead. Pressing play analyzes a short lead-in, starts
playback, and then keeps transcribing ahead of the playhead while the audio plays,
stopping once it is comfortably in front. Nothing is transcribed for an episode nobody
plays, and time-to-play is seconds rather than minutes.

The lead-in is a **latency budget, not an accuracy one**: ~15s of audio, which is three or
four seconds of work. It was 90s originally, which cost about thirty — and since a seek
re-targets the pipeline and pays the same cost again, every jump felt like a hang. Chunk
size scales with the cushion in hand: small when someone is waiting on the result, full
size once playback is comfortably buffered and no single result is holding anything up.

This only works because of one invariant, enforced in the player:

> **Playback never runs past the end of analyzed coverage.**
> Unanalyzed audio is *unknown*, not clean.

A filter map therefore carries `analyzedRanges` alongside its spans, and is normally
incomplete (`status: 'partial'`). If playback ever reaches the frontier — a slow device,
a hard seek, 3× speed — the player pauses and says so rather than playing unchecked
audio. Seeking re-points the pipeline at the new position.

Coverage is also **derived from the playhead rather than carried alongside it**. An
independently advanced cursor could drift: a chunk that failed pushed it past the gap it
had just left, coverage then grew from the cursor, and the playhead stayed pinned in front
of a hole nothing would ever come back to fill — the episode stopping dead while the
pipeline busily transcribed audio nobody could reach. Deriving the next chunk from the
frontier ahead of the listener means the first thing transcribed is always the audio
immediately in front of them, and old holes heal on approach.

There is deliberately **no "process in advance" option**. It looks like it would be
useful for going offline, but it is not: a downloaded episode is local and transcription
runs on-device, so live filtering works with no connection at all. The only thing
filtering ever needs the network for is fetching the speech model once, so *that* — not
pre-processed episodes — is what "ready for offline" actually means, and Settings exposes
it directly.

**Streaming and transcription share one fetch.** Downloading is how an episode is kept for
offline, not a precondition for playing it. The naive way to support that costs every
episode twice — the player streams from the network while a second fetch pulls the file to
disk so there is something to decode. Instead both read through one Media3 `SimpleCache`:
the player via `CacheDataSource`, the decoder via a `MediaDataSource` over the same cache.
Whichever asks for a byte first fetches it; the other reads it from disk. A local proxy
would have achieved the same with a socket and a Range parser of our own; `CacheDataSource`
already is that proxy.

That also removes what made streaming unsafe to filter. A read that misses blocks and
fetches, so a chunk cannot fail merely because its audio has not arrived — failure keeps
meaning failure, which matters because the pipeline gives up on a stretch that fails
repeatedly and marks it analyzed. Walling the playhead in behind an untranscribable
stretch is the worse of the two failures, but it has to be a real one.

**CORS is a real constraint in the browser, not on device.** Podcast CDNs do not send
`Access-Control-Allow-Origin`. On Android, Capacitor's native HTTP bridge bypasses CORS
entirely. In browser dev we stand in a Vite dev-only middleware (`/__passthrough` in
[vite.config.ts](vite.config.ts)); it never ships. The browser PWA build is therefore a
**development and preview target**, not the shipping product.

**Timing precision is bounded by the ASR.** whisper.cpp derives word timestamps by running
DTW over decoder cross-attention, which carries roughly 100–400ms of error. Skip spans are
padded generously and snapped to nearby low-energy boundaries, trading a little extra
audio for never clipping the front of a flagged word.

### Measured throughput

On a Pixel 7 Pro, `base.en` q5_1, 45-second chunks:

| | decode | ASR | total | vs realtime |
|---|---|---|---|---|
| naive first attempt | 2.3s | **79.7s** | 82s | **0.56×** — could never keep up |
| after tuning | 1.6s | **12–16s** | 14–18s | **2.7–3.8×** |

Two changes account for that 4.8×, and neither is the one you would reach for first:

- **Cap whisper at 4 threads, not `cores - 1`.** Phones are big.LITTLE; ggml splits each
  layer evenly and waits for every thread, so the slowest core gates the step. Scheduling
  work onto the little cores makes it *slower*.
- **Quantized (q5_1) weights, not fp16.** Faster integer kernels, and the one-time
  download drops from ~150MB to ~57MB.

A third is a build setting rather than a tuning knob: Gradle passes
`CMAKE_BUILD_TYPE=Debug` for `assembleDebug`, which compiles ggml's inner loops at `-O0`.
`android/app/build.gradle` forces Release for the native build regardless of the Android
build type. Kotlin stays debuggable; only the math is optimized.

The model choice was *not* the lever — `base.en` is fast enough once the above are right,
so the accuracy is free. `tiny.en` remains selectable for slower hardware.

## Layers

```
┌──────────────────────────────────────────────────────────┐
│  UI (React 19 + Tailwind v4)                             │
├──────────────────────────────────────────────────────────┤
│  Features: discovery · subscriptions · player            │
│            downloads · filter                            │
├──────────────────────────────────────────────────────────┤
│  Data: Dexie (IndexedDB) + repositories                  │
├──────────────────────────────────────────────────────────┤
│  Platform abstraction  ◄── the important seam            │
│    http · player · transcriber · files · downloads       │
├────────────────────────────┬─────────────────────────────┤
│  Web impls (browser dev)   │  Native impls (Android)     │
│  fetch + dev passthrough   │  CapacitorHttp              │
│  HTMLAudioElement          │  Media3 / ExoPlayer         │
│  transformers.js Whisper   │  whisper.cpp JNI            │
│  OPFS                      │  Capacitor Filesystem       │
└────────────────────────────┴─────────────────────────────┘
```

The **platform abstraction** is the load-bearing design decision. Every capability that
differs between browser and device sits behind an interface with two implementations,
selected once at startup by capability detection. This means the entire app — feed parsing,
subscription lifecycle, matching, filter-map construction, all UI — is developed and tested
in a browser with hot reload, and only playback, transcription and download *implementations*
require an Android build loop.

## The filter pipeline

```
episode audio
   │
   ├─(a) publisher transcript?  ── podcast:transcript VTT/SRT from the feed
   │        │
   │        ├─ no profanity anywhere → mark clean, skip ASR entirely   ← big win
   │        └─ profanity present → narrow ASR to the suspect cue windows
   │
   └─(b) no transcript → full ASR pass
   │
   ▼
word-level timings  [{ word, start, end, confidence }]
   │
   ▼
matcher — normalize → exact wordlist → phonetic (Double Metaphone) → phrases
   │
   ▼
filter map  [{ start, end, severity, category }]  ← padded, merged, snapped
   │
   ▼
playback engine seeks past each span
```

Step (a) is worth calling out: a publisher transcript is cue-level (2–5s granularity), which
is far too coarse to skip a single word — but it is plenty good enough to prove an episode
contains *no* profanity, or to narrow a 60-minute ASR job down to a handful of 10-second
windows. Where transcripts exist, this turns minutes of compute into seconds.

The **filter map is the only durable artifact** — a compact
`[{start, end, severity, category}]` array. Transcript text is never persisted, which keeps
storage small and avoids retaining a copy of third-party content.

### Matching is exact, and stays exact

Approximate matching is the obvious way to improve recall and it does not survive contact
with real audio. Two variants were tried and rejected:

- **Phonetic (Soundex/Metaphone)** — rejected on inspection. Whisper emits well-spelled
  real words, so there is no leetspeak to defeat, and profanity's near-homophones are
  innocent high-frequency words: duck, ship, sheet, fork, witch.
- **Edit distance ≤ 1, guarded** — implemented, then removed. Over seven minutes of real
  podcast audio it produced nine matches and every one was wrong: *where* and *whole* →
  juber, *that's* → gjng, *Suckers.* → shpx, *center.* → phag. Exact matching over the
  same audio produced zero false positives.

The lesson is that ordinary English sits at edit distance 1 from profanity, so no
exclusion list can enumerate the collisions. Recall is improved by **adding terms and
inflections to the wordlist**, which cannot misfire this way. The false positives above
are pinned as regression tests in `matcher.test.ts`.

## Playback and why it is native

The filter action is "skip", so playback must evaluate position against the filter map
continuously and seek past flagged spans. Doing this in the WebView is not viable:
`requestAnimationFrame` is suspended and timers are throttled when the screen is off, so
flagged spans would sail straight through during exactly the normal listening case.

So on Android, playback lives in a **Media3/ExoPlayer foreground service**. The filter map is
handed to native at load time and evaluated on a native handler at ~20ms, independent of the
WebView's lifecycle. That service also owns the MediaSession, giving lock-screen and Bluetooth
controls for free. The web player implementation (rAF-driven, foreground-only) exists for
browser dev.

Because skips shorten the audio, the player tracks two clocks — **original position** (what
gets persisted for resume, and what the scrubber maps to) and **filtered position** (elapsed
listening time). The mapping between them is derived from the filter map.

## Data model

Dexie/IndexedDB, one store per concern:

- `podcasts` — feed metadata, artwork, feed URL, etag/last-modified for conditional refresh
- `episodes` — enclosure URL, duration, guid, publish date, `podcast:transcript` URLs
- `subscriptions` — subscribed podcasts + per-feed settings (auto-download, filter profile)
- `progress` — position, played/unplayed, completion, last-played timestamp
- `downloads` — local file handle, byte progress, state
- `filterMaps` — the skip spans per episode, plus the engine/model version that produced them
- `queue` — play order, densely numbered; position 0 is whatever is playing
- `settings` — global filter profile, playback defaults, storage policy
- `wordlist` — bundled tiered list plus user allow/block overrides

`filterMaps` records carry the producing model + wordlist version, so bumping either can
invalidate and regenerate maps rather than silently serving stale filtering.

The `queue` holds the playing episode at position 0 rather than starting at what plays
next, so it is one ordered account of what is happening instead of a list that has to be
read alongside a separate "and this is playing". Positions are dense and rewritten on
every change: the queue is a handful of episodes ordered by hand, so renumbering costs
nothing and avoids the fractional drift gap-based schemes decay into.

## Discovery without a server

[iTunes Search API](https://itunes.apple.com/search?media=podcast) is public, requires no key
and no account, and returns `feedUrl` directly — so it satisfies the no-server constraint with
nothing to host or authenticate. Podcast Index would give richer data but requires an API
key/HMAC secret, which cannot be safely embedded in a distributed APK. Direct RSS URL entry
and OPML import cover everything search misses.

## Stack

React 19 · TypeScript · Vite · Tailwind v4 · Dexie · Zustand · fast-xml-parser ·
Capacitor 8 · Media3/ExoPlayer · whisper.cpp

