# FilterPod Privacy Policy

*Last updated: September 29, 2026*

FilterPod does not collect your data. The app never talks to a FilterPod server, and
there is no account, no analytics, no advertising SDK, and no crash reporting. Nothing
you do in the app is transmitted to us — we have no way to receive it.

## What FilterPod stores

FilterPod stores the following in its private application storage:

- Your subscriptions, listening progress, queue, and settings.
- Downloaded and streamed episode audio.
- Episode transcriptions. Filtering works by transcribing audio **on your device**
  using a local speech-recognition model. Audio is never sent anywhere for analysis.

Uninstalling deletes the on-device copy. Downloaded audio, episode transcriptions,
speech-model files, artwork, and generated filtering data are never included in a
FilterPod backup.

## Android backup and device transfer

When Android system backup is enabled and the device supports encrypted backup, Android
may store a compact FilterPod backup in the user's Google account. It contains only:

- Subscriptions and the podcast metadata needed to fetch them again.
- Listening progress and queue.
- Settings, filter profiles, and user-added blocked or allowed words.

Android controls when that backup is made and restored. It is protected by the user's
Google Account credentials and, on supported devices, the device screen lock. FilterPod's
developer cannot access it. Android may restore it when the app is reinstalled or moved
to another Android device.

Settings also offers **Export backup**, which writes the same compact data to a document
location the user chooses, such as Downloads or Google Drive. That document remains under
the user's control and may remain after uninstall. **Import backup** reads only a document
the user explicitly selects.

## Network requests the app makes

FilterPod itself talks to these third parties only to provide requested app functionality:

1. **Apple's public podcast directory** (`itunes.apple.com`,
   `rss.marketingtools.apple.com`) — when you search for or browse podcasts. Your
   search terms are sent to Apple to run the search. Apple's own privacy policy
   applies to those requests.
2. **Podcast publishers' servers** — to fetch the RSS feeds you subscribe to and the
   audio you play. As with every podcast app, the publisher (or their hosting
   provider) sees a standard HTTP request: your IP address and the app's user agent.

3. **GitHub release assets** — to download the speech-recognition model selected in the
   app. The model runs locally after download.

Android's operating-system backup service may separately transfer the compact backup
described above according to the user's Android and Google backup settings.

## Share pages

A shared FilterPod link opens a web page served by a small Cloudflare Worker. The link
contains a podcast's public feed address and, for an episode, a short identifier
derived from that episode — nothing about who shared it or who opens it.

To draw the page, the Worker fetches that public feed, looks the show up in Apple's
public podcast directory (to offer "open in your app" links), and asks GitHub for the
latest FilterPod release. It sets no cookies and keeps no request logs. Cloudflare,
which runs it, handles those requests — including the visitor's IP address — under its
own privacy policy. The page shows the podcast's artwork straight from the publisher's
servers, which see an ordinary image request.

Visits to filterpod.app are counted with Cloudflare Web Analytics. It uses no cookies
and does not identify individual visitors; what reaches us is aggregate — which pages
were viewed (so, which shared shows and episodes), where visits came from, and the
country and type of browser or device.

## Children

FilterPod does not collect data from anyone, including children.

## Changes

If this policy ever changes, the change will appear in this file's git history —
which is public, so nothing can change quietly.

## Contact

Questions: open an issue at <https://github.com/mhamann/filterpod/issues>.
