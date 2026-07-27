# Contributing to FilterPod

## Before a first pull request

FilterPod asks contributors to agree to a [Contributor License Agreement](CLA.md). You keep
copyright in your work; you grant the project permission to relicense it, so that a build
can be released under terms the AGPL does not allow — an iOS app store release being the
concrete case.

Add this line to your first pull request:

```
I have read and agree to the FilterPod Contributor License Agreement (CLA.md).
```

and commit with `git commit -s`, which adds a `Signed-off-by` line.

If you would rather not agree to it, please still open an issue. A clear bug report with a
reproduction is worth more than most patches and asks nothing of you.

## Getting it running

```bash
pnpm install
pnpm dev
```

The browser build is the development target and is fully functional — search, subscribe,
stream, transcribe, play. Two caveats: RSS fetching goes through a dev-only proxy that
never ships, and skipping stops when the tab is backgrounded, because a browser throttles
timers there. Both are why the Android build exists.

```bash
pnpm test        # unit tests
pnpm typecheck   # tsc, no emit
pnpm lint
```

For the Android app, see [README.md](README.md#building-the-android-app). It needs the
Android SDK with NDK and **JDK 21**, and whisper.cpp vendored via `./scripts/vendor-whisper.sh`.

## What the code expects of you

**Comments explain why, not what.** The reasoning behind a non-obvious decision is the part
that cannot be recovered from reading the code later. Several comments in this codebase
record a bug that took hours to find; that is deliberate, and it is the standard.

**The filtering invariant is not negotiable.** Playback never runs past the end of analyzed
coverage — unanalyzed audio is *unknown*, not clean. If a change makes it possible for the
playhead to cross into audio nothing has transcribed, that change is wrong, however
convenient. The one place this is deliberately relaxed (a stretch that repeatedly fails to
transcribe) reports an error rather than doing it quietly, and the reasoning is written out
at `MAX_CHUNK_ATTEMPTS` in `src/features/filter/liveFilter.ts`.

**Nothing leaves the device.** There is no server and no telemetry. A change that sends
audio, transcripts or listening history anywhere is out of scope regardless of merit.

**Keep the platform seam honest.** Every capability that differs between browser and device
sits behind an interface in `src/platform/` with two implementations. Reaching for Capacitor
or DOM audio above that layer breaks the browser build, and the browser build is what makes
this developable at all.

**Tests should fail for the right reason.** Several tests here assert on behaviour that a
mock could paper over — the player store's test models the playback service rejecting
commands until it has been started, because a forgiving mock is exactly what hid a bug that
let unfiltered audio through. If a new test would pass against the broken version of the
code, it is not testing anything.

## Wordlist changes

Additions and removals affect what people do and do not hear, so they need more than an
opinion. Say which profile tier it belongs in and why, and be aware that the matcher is
deliberately exact — no fuzzy matching, no edit distance. That was tried, and on real audio
every single near-match it produced was a false positive, cutting words that were fine. The
reasoning is in `src/features/filter/matcher.ts`.

## Reporting a filtering miss

The most useful reports name the episode, the timestamp, and what was said. That makes it
possible to tell the three failure modes apart: the word was not in the list, the
transcription misheard it, or the cut was mistimed. They have completely different fixes,
and without a timestamp it is guesswork.
