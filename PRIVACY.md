# FilterPod Privacy Policy

*Last updated: July 28, 2026*

FilterPod does not collect your data. There is no FilterPod server, no account, no
analytics, no advertising SDK, and no crash reporting. Nothing you do in the app is
transmitted to us — we have no way to receive it.

## What stays on your device

Everything the app knows about you lives only on your device:

- Your subscriptions, listening progress, queue, and settings.
- Downloaded and streamed episode audio.
- Episode transcriptions. Filtering works by transcribing audio **on your device**
  using a local speech-recognition model. Audio is never sent anywhere for analysis.

Uninstalling the app deletes all of it.

## Network requests the app makes

FilterPod talks to exactly two kinds of third parties, both only on your instruction:

1. **Apple's public podcast directory** (`itunes.apple.com`,
   `rss.marketingtools.apple.com`) — when you search for or browse podcasts. Your
   search terms are sent to Apple to run the search. Apple's own privacy policy
   applies to those requests.
2. **Podcast publishers' servers** — to fetch the RSS feeds you subscribe to and the
   audio you play. As with every podcast app, the publisher (or their hosting
   provider) sees a standard HTTP request: your IP address and the app's user agent.

That is the complete list. The speech-recognition model is downloaded once from the
app's own release assets on GitHub.

## Children

FilterPod does not collect data from anyone, including children.

## Changes

If this policy ever changes, the change will appear in this file's git history —
which is public, so nothing can change quietly.

## Contact

Questions: open an issue at <https://github.com/mhamann/filterpod/issues>.
