import { getPlatform } from '@/platform'
import { searchPodcasts } from '@/features/discovery/search'

/**
 * Spotify import: saved shows out of the walled garden.
 *
 * Spotify exposes no RSS URLs and no OPML, so this works in two hops: OAuth (PKCE — a
 * public client, no secret, no server, which is what keeps it inside the app's
 * architecture) to read the user's saved shows, then a name-and-publisher match against
 * iTunes Search to find each show's real feed. Matching is where the honesty lives:
 * a wrong match subscribes someone to the wrong podcast, so anything short of a clean
 * title match is surfaced as "not found" rather than guessed at.
 *
 * CLIENT_ID is a public identifier, not a secret — normal to ship in an open-source
 * app. It requires a one-time (free) registration at developer.spotify.com with the
 * redirect URIs below; empty means the feature shows setup instructions instead.
 */
export const SPOTIFY_CLIENT_ID = ''

export const SPOTIFY_REDIRECT_NATIVE = 'app.filterpod://spotify-callback'
export const SPOTIFY_REDIRECT_WEB_PATH = '/spotify-callback'

/**
 * The browser-dev redirect. Spotify requires HTTPS for redirect URIs except explicit
 * loopback IPs — `localhost` is rejected, `127.0.0.1` is allowed. That distinction
 * matters beyond the dashboard form: sessionStorage is origin-scoped, so the PKCE
 * verifier stored on a `localhost` page would be invisible to a callback landing on
 * `127.0.0.1`. Dev-testing the Spotify flow therefore means opening the app at
 * http://127.0.0.1:5173 from the start; beginAuth throws early on the wrong origin
 * rather than letting the flow die confusingly at the token exchange.
 *
 * Register in the Spotify dashboard (Web API only, no SDK):
 *   app.filterpod://spotify-callback
 *   http://127.0.0.1:5173/spotify-callback
 */
export const SPOTIFY_REDIRECT_WEB = 'http://127.0.0.1:5173/spotify-callback'

export const spotifyConfigured = (): boolean => SPOTIFY_CLIENT_ID.length > 0

export interface SpotifyShow {
  name: string
  publisher: string
}

export interface ShowMatch {
  show: SpotifyShow
  feedUrl?: string
  matchedTitle?: string
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Builds the authorize URL and stashes the PKCE verifier for the callback leg. */
export async function beginAuth(redirectUri: string): Promise<string> {
  if (redirectUri === SPOTIFY_REDIRECT_WEB && location.hostname === 'localhost') {
    throw new Error('open the app at http://127.0.0.1:5173 to test Spotify import')
  }
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  sessionStorage.setItem('spotify_verifier', verifier)

  return `https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'user-library-read',
    code_challenge_method: 'S256',
    code_challenge: base64Url(new Uint8Array(digest)),
  })}`
}

/** Exchanges the callback code for a token. PKCE means no secret is involved. */
export async function completeAuth(code: string, redirectUri: string): Promise<string> {
  const verifier = sessionStorage.getItem('spotify_verifier')
  if (!verifier) throw new Error('no auth in progress')

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!response.ok) throw new Error(`token exchange failed: HTTP ${response.status}`)
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('no access token in response')
  return body.access_token
}

/** Every saved show, paginated out of /v1/me/shows. */
export async function fetchSavedShows(token: string): Promise<SpotifyShow[]> {
  const shows: SpotifyShow[] = []
  let url: string | null = 'https://api.spotify.com/v1/me/shows?limit=50'
  while (url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`Spotify API: HTTP ${response.status}`)
    const body = (await response.json()) as {
      items?: Array<{ show?: { name?: string; publisher?: string } }>
      next: string | null
    }
    for (const item of body.items ?? []) {
      if (item.show?.name) {
        shows.push({ name: item.show.name, publisher: item.show.publisher ?? '' })
      }
    }
    url = body.next
  }
  return shows
}

/** Loose-but-safe normalization for cross-catalog title comparison. */
export function normalizeTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Finds a show's RSS feed by name, or honestly fails to.
 *
 * Auto-accepts only an exact normalized-title match (publisher agreement breaks ties
 * between same-named shows). Fuzzy acceptance is deliberately absent for the same
 * reason the word matcher has no edit-distance tier: a near-miss here subscribes
 * someone to the wrong show, which is worse than asking them to add it by hand.
 */
export async function matchShow(show: SpotifyShow): Promise<ShowMatch> {
  try {
    const results = await searchPodcasts(show.name, 10)
    const wanted = normalizeTitle(show.name)
    const titleHits = results.filter((result) => normalizeTitle(result.title) === wanted)
    const pick =
      titleHits.length <= 1
        ? titleHits[0]
        : (titleHits.find(
            (result) => normalizeTitle(result.author) === normalizeTitle(show.publisher),
          ) ?? titleHits[0])
    if (!pick) return { show }
    return { show, feedUrl: pick.feedUrl, matchedTitle: pick.title }
  } catch {
    return { show }
  }
}

/**
 * Saved shows out of a Spotify data export — the no-API path.
 *
 * Spotify now requires a Premium account just to register an API app, which walls the
 * OAuth path off from most people. But every account, free included, can request its
 * data from the privacy page, and the standard package's YourLibrary.json lists saved
 * shows with name and publisher — the exact input the matcher needs. Slower (the export
 * takes a day or two to arrive) but universal, and no tokens are involved at all.
 *
 * Accepts the zip as downloaded, or a bare YourLibrary.json for anyone who unzipped.
 */
export async function parseSpotifyExport(file: File): Promise<SpotifyShow[]> {
  let json: string
  if (/\.zip$/i.test(file.name)) {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await file.arrayBuffer())
    const entry = Object.keys(zip.files).find((name) => /YourLibrary\.json$/i.test(name))
    if (!entry) {
      throw new Error(
        'no YourLibrary.json in that zip — request the "Account data" export from Spotify',
      )
    }
    json = await zip.files[entry].async('string')
  } else {
    json = await file.text()
  }

  const body = JSON.parse(json) as { shows?: Array<{ name?: string; publisher?: string }> }
  if (!Array.isArray(body.shows)) throw new Error('no saved shows found in that file')
  return body.shows
    .filter((show): show is { name: string; publisher?: string } => Boolean(show?.name))
    .map((show) => ({ name: show.name, publisher: show.publisher ?? '' }))
}

// getPlatform is unused today but keeps this module on the platform seam if the token
// exchange ever needs to route through native HTTP (Spotify's endpoints are CORS-open,
// so plain fetch works in both the WebView and the browser).
void getPlatform
