# FilterPod

A podcast player that automatically skips foul language. Everything runs on your device —
there is no server, and no audio, transcript or listening history ever leaves the phone.

## Why

Nothing on Android combines a real podcast client with automatic profanity filtering.
[Earmuffs](https://earmuffs.app/) and [BetterCast](https://apps.apple.com/us/app/bettercast-podcast-player/id6759830475)
are iOS-only; [Bleeped](https://bleepedapp.com/) is on Android but is a walled garden with
no RSS subscriptions. FilterPod is a full podcast client — subscriptions, resume, offline
downloads — with the filtering built in.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the reasoning behind it.

## How it works

```
subscribe → press play → analyze a short lead-in → play, filtering ahead as you listen
```

Filtering needs word-level timings, which means transcribing the episode — the most
expensive thing the app does. Rather than transcribing everything up front (which would
burn CPU and battery on episodes you may never play), it runs **just-in-time**: pressing
play analyzes a short lead-in, playback starts, and transcription keeps running ahead of
the playhead while you listen, then idles once it is comfortably in front. The lead-in is
sized as a latency budget rather than an accuracy one — about fifteen seconds of audio,
which a Pixel 7 Pro transcribes in three or four. Jumping to a new spot re-targets the
pipeline there and costs the same few seconds again.

Playback never runs past the part that has been checked — unanalyzed audio is *unknown*,
not clean — so if it ever catches up, the player pauses and says so. Feeds that publish a
`podcast:transcript` skip most of this work entirely: a transcript can prove an episode
clean outright, or mark the clean stretches as checked so transcription only ever touches
the handful of suspect windows.

Episodes **stream by default**; downloading is how you keep one for offline, not a step
you have to take before listening. That works because playback and transcription read the
same bytes through one shared cache, so an episode is fetched once no matter how many
things want it.

Downloaded episodes then work **entirely offline**: the audio is local and transcription
runs on-device, so the only thing filtering ever needs the network for is fetching the
speech model once — Settings has a "Ready for offline" action that does exactly that.

The player then seeks past each flagged span, deciding slightly ahead of the playhead so
the cut lands before the word rather than after it — audio already handed to the output,
or sitting in a Bluetooth headset, cannot be recalled. On Android this runs in a Media3
foreground service, so it keeps working with the screen off.

## Running it

```bash
pnpm install
```

```bash
pnpm dev
```

The browser build is the development target. It is fully functional — search, subscribe,
download, transcribe (via WebGPU/WASM Whisper), play — with two caveats: RSS fetching goes
through a dev-only proxy that never ships, and skipping stops when the tab is backgrounded.

```bash
pnpm test
```

There is also an opt-in integration test that runs the real Whisper model over real
audio and pushes the result through the matcher. It is excluded by default because it
downloads model weights and takes minutes, but it is the only check that catches
problems in Whisper's actual output — chunk-seam duplicates, inverted word timings,
and matcher false positives on real speech. It needs `ffmpeg` on PATH:

```bash
FILTERPOD_ASR_AUDIO=/path/to/episode.mp3 pnpm test
```

## Building the Android app

Requires the Android SDK with NDK, and **JDK 21** — Capacitor 8 will not build on 17. If
you have Android Studio installed, its bundled runtime works:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Vendor whisper.cpp first:

```bash
./scripts/vendor-whisper.sh
```

Then build the web assets and sync them into the native project:

```bash
pnpm android:sync
```

Then open `android/` in Android Studio, or build from the command line:

```bash
cd android && ./gradlew assembleDebug
```

whisper.cpp is vendored rather than pulled from a package repository — there is no
maintained Android artifact, and the token-timestamp behaviour the JNI bridge depends on
moves between releases, so it is pinned to a tag.

**16 KB page size.** Android 15+ devices (Pixel 7 Pro included) use 16 KB memory pages,
and Play requires 16 KB-aligned native libraries for apps targeting Android 15+. Two
things in [CMakeLists.txt](android/app/src/main/cpp/CMakeLists.txt) handle this and must
stay: the `max-page-size=16384` link options, and `GGML_OPENMP=OFF` — ggml's OpenMP path
pulls in the NDK's prebuilt `libomp.so`, which is not aligned and cannot be relinked.
Verify after any NDK or whisper.cpp bump:

```bash
llvm-readelf -l android/app/build/intermediates/stripped_native_libs/debug/stripDebugDebugSymbols/out/lib/arm64-v8a/libfilterpod_whisper.so | grep LOAD
```

Every `LOAD` segment must show alignment `0x4000`.

## Filter profiles

| Profile | Cuts | Notes |
|---|---|---|
| Family | strong + moderate + mild | Includes casual blasphemy |
| Standard | strong + moderate | Leaves "qnza" and "uryy" alone. The default |
| Strong only | strong | |
| Off | nothing | |

You can add your own words to cut, or exempt words from the built-in list, in Settings.

## Contributing

Bug reports are welcome, and a filtering miss reported with an episode and a timestamp is
worth more than most patches — see [CONTRIBUTING.md](CONTRIBUTING.md), which also covers
the few invariants the codebase will not bend on.

## License

[GNU AGPL v3](LICENSE). Copyleft, including over a network: if you run a modified version
where people can reach it, they are entitled to its source. That is the point — a filter
you cannot inspect is a filter you are taking on trust, and this one decides what you do
and do not get to hear.

Copyright is held by Michael Hamann, and contributors are asked to sign a
[CLA](CLA.md) granting the right to relicense. Stated plainly, because it should not be
a surprise: **this project may also be released under other terms in future, including a
proprietary build.** The reason is specific rather than commercial ambition — Apple's App
Store terms are incompatible with the AGPL, so an iOS release is impossible without it.
Contributors keep copyright in their own work and can do whatever they like with it; what
the CLA grants is permission for the project to do the same.

The AGPL release is not going anywhere. Relicensing adds a way to ship; it does not take
this one away.

## Layout

```
src/
  core/          domain types, span math
  data/          Dexie schema, repositories, defaults
  platform/      the abstraction seam — web/ and native/ implementations
  features/      discovery, feeds, subscriptions, player, downloads, filter
  ui/            components, including the cut timeline
  app/           shell, screens, bootstrap
android/
  app/src/main/java/app/filterpod/   Kotlin plugins + Media3 playback service
  app/src/main/cpp/                  whisper.cpp JNI bridge
```

`platform/` is the load-bearing part: every capability that differs between browser and
device sits behind an interface with two implementations, which is what makes the whole
app developable in a browser with hot reload.
