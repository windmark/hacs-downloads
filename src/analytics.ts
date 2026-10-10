const DAY_MS = 24 * 60 * 60 * 1000;

export type ReleaseWindow = 'recent' | 'all';
export const RECENT_RELEASE_COUNT = 5;

/**
 * GitHub's prerelease flag is authoritative, but some projects publish betas
 * as regular releases. Tags such as v2.9.0-beta.3, 1.4.0rc1 or v0.7.34b5 are
 * treated as pre-releases as well.
 */
export function isPrereleaseTag(tag: string) {
  return /-(?:alpha|beta|rc|pre|preview|dev)(?:[.-]?\d+)?$/i.test(tag)
    || /\d(?:a|b|rc|dev)\d+$/i.test(tag);
}

export function isPrerelease(release: { version: string; prerelease?: boolean }) {
  return release.prerelease === true || isPrereleaseTag(release.version);
}

export function applyReleaseWindow<T>(releases: readonly T[], window: ReleaseWindow): T[] {
  return window === 'recent' ? releases.slice(0, RECENT_RELEASE_COUNT) : [...releases];
}

/** Days a release has been public, never less than one so fresh releases are not inflated. */
export function releaseAgeDays(publishedAt: string, now = Date.now()) {
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return 1;
  return Math.max(1, (now - published) / DAY_MS);
}

export function downloadsPerDay(release: { downloads: number; publishedAt: string }, now = Date.now()) {
  return release.downloads / releaseAgeDays(release.publishedAt, now);
}

export function formatRate(value: number) {
  if (value === 0) return '0';
  if (value < 0.1) return '<0.1';
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

/**
 * Estimates how many days the latest release needs to pass the previous record
 * when it keeps gaining `recentDailyRate` downloads per day.
 */
export function daysToRecord(remaining: number, recentDailyRate: number | null) {
  if (remaining <= 0) return 0;
  if (!recentDailyRate || recentDailyRate <= 0) return null;
  return Math.ceil(remaining / recentDailyRate);
}

export type ShareSegment = {
  id: string;
  label: string;
  downloads: number;
  share: number;
  isOther?: boolean;
};

/**
 * Splits the scoped releases into donut segments. The largest releases are shown
 * individually and the remainder is grouped so the chart stays readable.
 */
export function buildShareSegments(
  releases: readonly { version: string; downloads: number }[],
  maxSegments = RECENT_RELEASE_COUNT,
): ShareSegment[] {
  const total = releases.reduce((sum, release) => sum + release.downloads, 0);
  if (total === 0) return [];
  const ranked = [...releases].filter((release) => release.downloads > 0).sort((a, b) => b.downloads - a.downloads);
  const visible = ranked.length > maxSegments ? ranked.slice(0, maxSegments - 1) : ranked;
  const remainder = ranked.slice(visible.length);
  const segments: ShareSegment[] = visible.map((release) => ({
    id: release.version,
    label: release.version,
    downloads: release.downloads,
    share: (release.downloads / total) * 100,
  }));
  if (remainder.length) {
    const downloads = remainder.reduce((sum, release) => sum + release.downloads, 0);
    segments.push({
      id: 'other',
      label: `${remainder.length} other ${remainder.length === 1 ? 'release' : 'releases'}`,
      downloads,
      share: (downloads / total) * 100,
      isOther: true,
    });
  }
  return segments;
}

export function conicGradient(segments: readonly { share: number }[], colors: readonly string[], track: string) {
  if (!segments.length) return `conic-gradient(${track} 0 360deg)`;
  let start = 0;
  const stops = segments.map((segment, index) => {
    const end = start + segment.share * 3.6;
    const stop = `${colors[index % colors.length]} ${start.toFixed(2)}deg ${end.toFixed(2)}deg`;
    start = end;
    return stop;
  });
  if (start < 359.99) stops.push(`${track} ${start.toFixed(2)}deg 360deg`);
  return `conic-gradient(${stops.join(', ')})`;
}

export type SortKey = 'published' | 'downloads' | 'rate';
export type SortDirection = 'asc' | 'desc';

export function sortReleases<T extends { downloads: number; publishedAt: string }>(
  releases: readonly T[],
  key: SortKey,
  direction: SortDirection,
  now = Date.now(),
): T[] {
  const value = (release: T) => {
    if (key === 'downloads') return release.downloads;
    if (key === 'rate') return downloadsPerDay(release, now);
    return Date.parse(release.publishedAt);
  };
  const factor = direction === 'asc' ? 1 : -1;
  return [...releases].sort((a, b) => (value(a) - value(b)) * factor
    || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function csvCell(value: string | number | boolean) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows: readonly (readonly (string | number | boolean)[])[]) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
