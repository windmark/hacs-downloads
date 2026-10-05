export type ComparableRelease = {
  version: string;
  downloads: number;
  publishedAt: string;
  prerelease?: boolean;
};

export type ReleaseComparison = {
  latest: ComparableRelease;
  previousBest: ComparableRelease;
  ageDays: number;
  difference: number;
  progressPercentage: number;
  state: 'behind' | 'matched' | 'ahead';
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function filterPrereleases<T extends { prerelease?: boolean }>(
  releases: readonly T[],
  includePrereleases: boolean,
): T[] {
  return includePrereleases ? [...releases] : releases.filter((release) => !release.prerelease);
}

export function buildReleaseComparison(
  releases: readonly ComparableRelease[],
  now = Date.now(),
): ReleaseComparison | null {
  const [latest, ...previousReleases] = releases;
  if (!latest || previousReleases.length === 0) return null;

  const previousBest = previousReleases.reduce((best, release) => (
    release.downloads > best.downloads ? release : best
  ));
  const difference = latest.downloads - previousBest.downloads;
  const publishedAt = Date.parse(latest.publishedAt);
  const ageDays = Number.isNaN(publishedAt)
    ? 0
    : Math.max(0, Math.floor((now - publishedAt) / DAY_MS));

  return {
    latest,
    previousBest,
    ageDays,
    difference,
    progressPercentage: previousBest.downloads > 0
      ? Math.round((latest.downloads / previousBest.downloads) * 100)
      : latest.downloads > 0 ? 100 : 0,
    state: difference > 0 ? 'ahead' : difference === 0 ? 'matched' : 'behind',
  };
}

export function formatReleaseAge(ageDays: number) {
  if (ageDays === 0) return 'Released today';
  if (ageDays === 1) return 'Released 1 day ago';
  return `Released ${ageDays} days ago`;
}
