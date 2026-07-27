# Google Play listing

Draft copy for the store entry. Character limits are Play's and are counted here so the
fields can be pasted in without trimming at the console.

## The line the whole thing hangs on

> **Coarse language, filtered out.**

"Coarse" is doing two jobs. It is the ordinary word for the language being removed, and it
is what you call a grind that has not been through the filter yet. The name only pays off
if the coffee reading is available, and this is the phrase that makes it available without
explaining the joke.

## App name

Play allows 30 characters.

| | Chars |
|---|---|
| `FilterPod` | 9 |
| `FilterPod: Clean Podcasts` | 25 |
| `FilterPod — Podcast Filter` | 26 |

Plain `FilterPod` unless the listing needs the keywords to be found at all; the bare name
looks more like a product and less like SEO.

## Short description

Play allows 80 characters. This is what appears under the icon in search results, and it
is the only copy most people will read.

| | Chars |
|---|---|
| `Coarse language, filtered out. Podcasts brewed clean, on your device.` | 68 |
| `Podcasts with the coarse language filtered out — all on your device.` | 67 |
| `Skips the swearing in your podcasts. Nothing ever leaves your phone.` | 67 |

The first leans on the pun and the privacy claim together. The third is the plainest and
would test better with people who have never heard of the app — worth considering if the
listing is not converting.

## Full description

Play allows 4000 characters. This draft is ~1500.

---

**Coarse language, filtered out.**

FilterPod is a full podcast player that skips swearing before you hear it. Subscribe to any
show by RSS, stream or download episodes, and listen without the language.

**How it works**

Press play. FilterPod transcribes a few seconds ahead of you, finds anything on your filter
list, and seeks past it — a fraction of a second before the word, so you never catch the
start of it. Transcription keeps running ahead while you listen, then rests once it is
comfortably in front.

If it ever falls behind, playback pauses and tells you rather than letting audio through
unchecked. Audio nobody has looked at is treated as unknown, not as clean. That rule is the
whole design.

**Everything happens on your phone**

There is no server. No account, no sign-up. No audio, transcript, or listening history
leaves your device, because there is nowhere for it to go. Speech recognition runs locally
using Whisper. Once the speech model is downloaded, filtering works with no connection at
all.

**Choose how much to cut**

Four levels, from cutting only the harshest language to also cutting mild words and casual
blasphemy. Add your own words, or exempt words you would rather keep. Set a different level
per show, so a comedy podcast and something you listen to with children can be treated
differently.

**A real podcast player**

- Subscribe to any podcast by RSS
- Stream instantly, or download for offline
- Resume where you left off, on the original timeline
- A queue you can arrange, playing on to the next episode
- Playback speed, skip forward and back
- Lock-screen and Bluetooth controls, and playback that keeps filtering with the screen off

**Open source**

FilterPod is licensed under the GNU AGPL v3. An app that decides what you are allowed to
hear should be one you can read the source of.

github.com/mhamann/filterpod

---

## Notes on claims

Two things in the copy above are load-bearing and should not be softened into something
untrue:

**"Nothing leaves your device"** is literally true — there is no backend at all. Keep it as
a statement of architecture, not a privacy-policy-shaped promise, because it is stronger
than a promise: there is nowhere for the data to go.

**"Before you hear it"** holds because cuts are decided ahead of the playhead rather than
on reaching the word. It is not a guarantee of perfection, and the listing should never
claim one. Speech recognition mishears things, and the wordlist will miss words. If the
copy ever implies that nothing will ever get through, a single slip makes the whole listing
look dishonest. "Skips swearing" is a description of what it does; "never miss a word" would
be a lie.

## Assets still needed

- **Feature graphic**, 1024×500. Required, and shown at the top of the listing.
- **Phone screenshots**, at least 2, 16:9 or 9:16, min 320px. Now Playing mid-cut, the
  filter levels in Settings, and the queue would show the most.
- **App icon**, 512×512 — `public/icon-512.png` is already this size and correct.

## Content rating

The questionnaire will ask about profanity. The honest answer is that the app's purpose is
removing it and it never displays any: the wordlist is not shown in the UI, and the filter
levels are described by strength and category rather than by example, deliberately.
