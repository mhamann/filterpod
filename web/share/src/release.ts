/**
 * Where "Get FilterPod" points: the APK on the latest GitHub release.
 *
 * Release assets carry the version in their name (filterpod-v1.0.1.apk), so there is
 * no stable direct-download URL; the release is looked up instead. If GitHub is slow
 * or rate-limits us, the button falls back to the releases page, which always works.
 * When the app lands on Google Play, this is the one place that changes.
 */

export const REPO = "mhamann/filterpod";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export interface Release {
  version: string | null;
  downloadUrl: string;
  sizeBytes: number | null;
}

export async function latestRelease(): Promise<Release> {
  const fallback: Release = { version: null, downloadUrl: RELEASES_URL, sizeBytes: null };
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        "User-Agent": "FilterPodShare/1.0",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(4_000),
      cf: { cacheTtl: 3_600, cacheEverything: true },
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string; size: number }[];
    };
    const apk = body.assets?.find((a) => a.name.endsWith(".apk"));
    return {
      version: body.tag_name ?? null,
      downloadUrl: apk?.browser_download_url ?? RELEASES_URL,
      sizeBytes: apk?.size ?? null,
    };
  } catch {
    return fallback;
  }
}
