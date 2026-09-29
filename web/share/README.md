# FilterPod share pages

A Cloudflare Worker that turns a shared podcast or episode into a page styled like
FilterPod's Now Playing sheet. The page shows the show, offers "open in your app"
links, and points visitors to the latest FilterPod release.

```
/                        what FilterPod is
/privacy                 PRIVACY.md from the repo root, bundled at build time
/p/<feed>                a podcast
/e/<feed>/<episode>?t=90 an episode, optionally from a position (seconds or 1:30)
```

`<feed>` is the feed URL, base64url-encoded without padding. `<episode>` is FNV-1a of
the episode's guid, the same hash that ends the app's episode ids (see
`kmp/shared/.../data/Ids.kt`). The app can build a link from what it already stores:
`encodeFeed(podcast.feedUrl)` plus the part of `episode.id` after the last `_`.

## How a page is built

- **Feed** (`src/feed.ts`): the feed is streamed and dropped once the show header
  and the wanted episode have arrived. The guid rule copies `ParseFeed.kt`
  exactly, because the link's hash depends on it.
- **Apple** (`src/apple.ts`): searches the iTunes directory by title and keeps the
  result whose `feedUrl` matches. It falls back to an exact title and author
  match. The episode comes from `lookup?entity=podcastEpisode` by `episodeGuid`,
  which only covers recent episodes.
- **Other apps** (`src/apps.ts`): only link formats checked against each app's
  source code or live redirects. Pocket Casts and Castro need Apple's id.
  AntennaPod and Podcast Addict take the feed. Overcast gets its iOS scheme.
  Spotify only gets a search link, since its ids can't be derived from a feed.
- **Release** (`src/release.ts`): the APK on the latest GitHub release. Switch this
  to Google Play once the app is listed there.

Rendered pages are cached at the edge for 10 minutes, keyed by deployed version.
Workers observability is off, so no request logs are kept (see PRIVACY.md).

## Develop and deploy

```bash
npm install
npm test
npm run dev      # http://localhost:8787
npm run deploy   # needs `wrangler login`; serves https://filterpod.app
```
