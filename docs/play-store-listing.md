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
| `Skips swearing locally. Your podcast audio never leaves your phone.` | 67 |

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

There is no FilterPod server. No account, no sign-up. Audio and transcripts never leave
your device: speech recognition runs locally using Whisper. Once the speech model is
downloaded, filtering works with no connection at all.

Android can keep an encrypted backup of your subscriptions, settings and listening
progress in your Google account, without uploading audio, transcripts or downloads. You
can also export a portable backup file you control.

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

**"Audio and transcripts never leave your device"** is literally true — there is no
filtering backend. Do not broaden that to "nothing leaves": Android's optional encrypted
backup contains library choices, settings and listening progress, and users can explicitly
export the same data to a document provider.

**"Before you hear it"** holds because cuts are decided ahead of the playhead rather than
on reaching the word. It is not a guarantee of perfection, and the listing should never
claim one. Speech recognition mishears things, and the wordlist will miss words. If the
copy ever implies that nothing will ever get through, a single slip makes the whole listing
look dishonest. "Skips swearing" is a description of what it does; "never miss a word" would
be a lie.

## Assets

All current as of v1.0.0, regenerated from the Kotlin app — the v0.3.0 set showed the
old React interface and no longer resembles what installs.

- **Feature graphic**, 1024×500 — `docs/store/feature-graphic.png`, rasterised from
  `assets/feature-graphic.svg` (`rsvg-convert -w 1024 -h 500`). The mark has not changed;
  only the file was regenerated, since the web build that used to hold the PNGs is gone.
- **App icon**, 512×512 — `docs/store/icon-512.png`, from `assets/icon-store.svg`. This
  used to point at `public/icon-512.png`, which left the repo with the Capacitor app.
- **Phone screenshots**, six, 1440×2880 — captured from the Compose UI on a Pixel 7 Pro
  emulator with the system UI in demo mode (fixed clock, full battery, no notification
  clutter), then trimmed from 1440×3120 to satisfy Play's 2:1 limit. The trim takes the
  status bar off the top and the gesture pill off the bottom.

  | File | Shows |
  |---|---|
  | `01-nowplaying.png` | The player: artwork glow, cut readout, skip controls |
  | `02-library.png` | Library grid and Continue listening |
  | `03-shownotes.png` | Show notes in the player, links intact |
  | `04-show.png` | A show page: episodes, played hidden, subscribe |
  | `05-showsettings.png` | Per-show settings: speed, intro/outro trims, notifications |
  | `06-settings.png` | Filter profiles and custom words |

  Regenerating them means driving the UI by element bounds rather than guessed
  coordinates — `adb shell uiautomator dump` gives the centres to tap.

- **Privacy policy URL** — required field. `PRIVACY.md` in the repo root; use the GitHub
  URL: `https://github.com/mhamann/filterpod/blob/main/PRIVACY.md`.

## Data safety form

There is still no data collected or shared by the developer: no backend or analytics
receives it. Android Auto Backup is an operating-system service, and a manual export is a
user-directed transfer to a document provider the user chooses. The privacy policy must
nevertheless disclose both clearly. Recheck the current Play Console wording when filing
the form; searches go to Apple's public podcast directory and audio comes from podcast
hosts directly, neither of which is collection by the developer.

## Release checklist

Done in the repo:

- [x] Upload keystore (`keystore/`, gitignored — **back it up**); the certificate is the
      same one v0.3.0 shipped with, so installs upgrade in place
- [x] `signingConfigs.release` wired into `kmp/androidApp/build.gradle.kts`, gated on the
      keystore being present so a fresh checkout still builds
- [x] `versionCode 4` / `versionName "1.0.0"`
- [x] Signed release APK builds and verifies (`assembleRelease`)
- [x] Feature graphic, app icon, six screenshots — all regenerated for the Kotlin UI
- [x] Privacy policy
- [x] GitHub release v1.0.0 published with the signed APK

Only the account owner can do:

- [ ] Play Console developer account ($25 one-time)
- [ ] Create the app entry and paste this copy
- [ ] Upload the AAB (`bundleRelease`) — Play wants a bundle, not the APK the GitHub
      release carries
- [ ] Complete the Data safety form (see above)
- [ ] Content rating questionnaire
- [ ] Choose countries and roll out
