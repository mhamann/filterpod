/**
 * Edge caching for the Worker's own requests (feeds, Apple, Castro, GitHub).
 *
 * Only answers worth keeping are cached. A plain cacheTtl caches whatever comes
 * back, so one rate-limited or failed reply from Apple would hide a show's "Open in"
 * links for a day; errors here are always asked again.
 */
export function cacheOk(seconds: number, statuses = "200-299"): RequestInitCfProperties {
  return { cacheEverything: true, cacheTtlByStatus: { [statuses]: seconds, "400-599": 0 } };
}
