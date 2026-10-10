export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** Snapshots further apart than this are not interpolated; the curve is treated as unknown. */
const MAX_INTERPOLATION_GAP_MS = 36 * HOUR_MS;
export const FIRST_WEEK_DAYS = 7;

export type SnapshotProject = {
  total: number;
  releases: Record<string, number>;
  prereleases?: string[];
  assets?: Record<string, number>;
  releaseAssets?: Record<string, Record<string, number>>;
};

export type SnapshotHistory = {
  snapshots: Array<{ capturedAt: string; projects: Record<string, SnapshotProject> }>;
};

export type TimelineEntry = { t: number; project: SnapshotProject };
export type Point = { t: number; v: number };

export function projectTimeline(history: SnapshotHistory | null, projectId: string): TimelineEntry[] {
  return (history?.snapshots ?? []).flatMap((snapshot) => {
    const project = snapshot.projects[projectId];
    const t = Date.parse(snapshot.capturedAt);
    return project && Number.isFinite(t) ? [{ t, project }] : [];
  }).sort((a, b) => a.t - b.t);
}

/**
 * Cumulative downloads of one release across snapshots. GitHub counters only grow,
 * so a drop means the asset was replaced; the running maximum keeps curves sane.
 */
export function releasePoints(timeline: readonly TimelineEntry[], version: string): Point[] {
  let max = 0;
  return timeline.flatMap(({ t, project }) => {
    const value = project.releases[version];
    if (typeof value !== 'number' || !Number.isFinite(value)) return [];
    max = Math.max(max, value);
    return [{ t, v: max }];
  });
}

/** Counter resets (asset re-uploads) detected in the raw history. */
export function countResets(timeline: readonly TimelineEntry[], version: string) {
  let previous: number | null = null;
  let resets = 0;
  for (const { project } of timeline) {
    const value = project.releases[version];
    if (typeof value !== 'number') continue;
    if (previous !== null && value < previous) resets += 1;
    previous = value;
  }
  return resets;
}

function anchored(points: readonly Point[], publishedAt: number): Point[] {
  return [{ t: publishedAt, v: 0 }, ...points.filter((point) => point.t > publishedAt)];
}

/** Interpolated cumulative downloads at time t. The count is zero at publish time by definition. */
export function cumulativeAt(points: readonly Point[], publishedAt: number, t: number): number | null {
  if (t <= publishedAt) return 0;
  const series = anchored(points, publishedAt);
  for (let index = 1; index < series.length; index += 1) {
    const a = series[index - 1];
    const b = series[index];
    if (t > b.t) continue;
    if (b.t - a.t > MAX_INTERPOLATION_GAP_MS) return null;
    return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
  }
  return null;
}

export function hasLaunchCoverage(points: readonly Point[], publishedAt: number) {
  const first = points.find((point) => point.t > publishedAt);
  return Boolean(first && first.t - publishedAt <= MAX_INTERPOLATION_GAP_MS);
}

export const LAUNCH_BUCKETS = [
  { id: 'd0', label: 'Day 0', from: 0, to: 1 },
  { id: 'd1', label: 'Day 1', from: 1, to: 2 },
  { id: 'd2', label: 'Day 2', from: 2, to: 3 },
  { id: 'd3', label: 'Days 3–6', from: 3, to: 7 },
  { id: 'rest', label: 'Day 7+', from: 7, to: null },
] as const;

export type LaunchBucket = { id: string; label: string; downloads: number | null; partial: boolean };
export type LaunchCurve = {
  available: boolean;
  buckets: LaunchBucket[];
  firstWeek: number | null;
  latest: number;
  ageDays: number;
};

export function launchCurve(points: readonly Point[], publishedAt: number): LaunchCurve {
  const last = points.at(-1);
  const latest = last?.v ?? 0;
  const lastTime = last?.t ?? publishedAt;
  const ageDays = Math.max(0, (lastTime - publishedAt) / DAY_MS);
  const available = hasLaunchCoverage(points, publishedAt);
  const at = (days: number) => cumulativeAt(points, publishedAt, publishedAt + days * DAY_MS);
  const buckets = LAUNCH_BUCKETS.map((bucket): LaunchBucket => {
    if (!available || ageDays <= bucket.from) return { id: bucket.id, label: bucket.label, downloads: null, partial: false };
    const start = at(bucket.from);
    const complete = bucket.to !== null && ageDays >= bucket.to;
    const end = complete ? at(bucket.to as number) : latest;
    if (start === null || end === null) return { id: bucket.id, label: bucket.label, downloads: null, partial: false };
    return { id: bucket.id, label: bucket.label, downloads: Math.max(0, Math.round(end - start)), partial: !complete };
  });
  const weekValue = available && ageDays >= FIRST_WEEK_DAYS ? at(FIRST_WEEK_DAYS) : null;
  return {
    available,
    buckets,
    firstWeek: weekValue === null ? null : Math.round(weekValue),
    latest,
    ageDays,
  };
}

/** Hours from publish until each threshold was crossed, interpolated between snapshots. */
export function milestoneHours(points: readonly Point[], publishedAt: number, thresholds: readonly number[]) {
  const series = anchored(points, publishedAt);
  return thresholds.map((threshold) => {
    for (let index = 1; index < series.length; index += 1) {
      const a = series[index - 1];
      const b = series[index];
      if (b.v < threshold) continue;
      if (b.t - a.t > MAX_INTERPOLATION_GAP_MS || b.v === a.v) return { threshold, hours: null };
      const t = a.t + ((threshold - a.v) / (b.v - a.v)) * (b.t - a.t);
      return { threshold, hours: (t - publishedAt) / HOUR_MS };
    }
    return { threshold, hours: null };
  });
}

function median(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export { median };

export type ReleaseCurveInput = { version: string; publishedAt: number; points: Point[] };

/**
 * Projects a young release's first-week total from how earlier releases accumulated:
 * if references had on average 60% of their first week by this age, divide by 0.6.
 */
export function forecastFirstWeek(target: ReleaseCurveInput, references: readonly ReleaseCurveInput[]) {
  const curve = launchCurve(target.points, target.publishedAt);
  if (!curve.available || curve.latest === 0) return null;
  if (curve.firstWeek !== null) return { value: curve.firstWeek, projected: false, references: 0 };
  const age = curve.ageDays;
  if (age < 0.25) return null;
  const ratios = references.flatMap((reference) => {
    if (reference.version === target.version) return [];
    const referenceCurve = launchCurve(reference.points, reference.publishedAt);
    if (!referenceCurve.firstWeek) return [];
    const atAge = cumulativeAt(reference.points, reference.publishedAt, reference.publishedAt + age * DAY_MS);
    return atAge && atAge > 0 ? [Math.min(1, atAge / referenceCurve.firstWeek)] : [];
  });
  const ratio = median(ratios);
  if (!ratio) return null;
  return { value: Math.round(curve.latest / ratio), projected: true, references: ratios.length };
}

export type MixDay = { t: number; label: string; total: number; byVersion: Record<string, number> };

/** New downloads per version for each day-long gap between consecutive snapshots. */
export function versionMix(timeline: readonly TimelineEntry[], days = 14): MixDay[] {
  const result: MixDay[] = [];
  for (let index = 1; index < timeline.length; index += 1) {
    const a = timeline[index - 1];
    const b = timeline[index];
    const gap = b.t - a.t;
    if (gap < 12 * HOUR_MS || gap > 36 * HOUR_MS) continue;
    const byVersion: Record<string, number> = {};
    let total = 0;
    for (const [version, downloads] of Object.entries(b.project.releases)) {
      const delta = Math.max(0, downloads - (a.project.releases[version] ?? 0));
      if (delta > 0) {
        byVersion[version] = delta;
        total += delta;
      }
    }
    result.push({
      t: b.t,
      label: new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(b.t)),
      total,
      byVersion,
    });
  }
  return result.slice(-days);
}

/** Days after publish until the release took more than half of that day's new downloads. */
export function daysToMajority(mix: readonly MixDay[], version: string, publishedAt: number) {
  const day = mix.find((entry) => entry.t > publishedAt && entry.total > 0 && (entry.byVersion[version] ?? 0) / entry.total > 0.5);
  return day ? Math.max(0, (day.t - publishedAt) / DAY_MS) : null;
}

function baselineIndex(timeline: readonly TimelineEntry[], days: number) {
  const latest = timeline.at(-1);
  if (!latest) return -1;
  const target = latest.t - days * DAY_MS;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  timeline.forEach((entry, index) => {
    const distance = Math.abs(entry.t - target);
    if (index < timeline.length - 1 && distance <= 18 * HOUR_MS && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** New downloads per version over the last `days` days, from the snapshot closest to that baseline. */
export function recentDownloadsByVersion(timeline: readonly TimelineEntry[], days = 7) {
  const index = baselineIndex(timeline, days);
  const latest = timeline.at(-1);
  if (index < 0 || !latest) return null;
  const baseline = timeline[index].project.releases;
  return Object.fromEntries(Object.entries(latest.project.releases).map(([version, downloads]) => [
    version,
    Math.max(0, downloads - (baseline[version] ?? 0)),
  ]));
}

/** Share of recent downloads that went to stable versions two or more releases behind the newest. */
export function olderVersionShare(recent: Record<string, number> | null, stableNewestFirst: readonly string[]) {
  if (!recent) return null;
  const total = Object.values(recent).reduce((sum, downloads) => sum + downloads, 0);
  if (total === 0) return null;
  const older = stableNewestFirst.slice(2).reduce((sum, version) => sum + (recent[version] ?? 0), 0);
  return { share: (older / total) * 100, downloads: older, total };
}

export type DatedRelease = { version: string; publishedAt: string; downloads: number };

export function releaseCadence(stableNewestFirst: readonly DatedRelease[], now = Date.now()) {
  const times = stableNewestFirst.map((release) => Date.parse(release.publishedAt)).filter(Number.isFinite);
  const gaps = times.slice(0, -1).map((time, index) => (time - times[index + 1]) / DAY_MS);
  return {
    medianGapDays: median(gaps),
    lastGapDays: gaps[0] ?? null,
    releasesLast30Days: times.filter((time) => now - time <= 30 * DAY_MS).length,
    daysSinceLast: times.length ? (now - times[0]) / DAY_MS : null,
  };
}

/** A stable release followed by another stable release within 48 hours was likely hotfixed. */
export function findHotfix(stableNewestFirst: readonly DatedRelease[], version: string) {
  const index = stableNewestFirst.findIndex((release) => release.version === version);
  if (index <= 0) return null;
  const next = stableNewestFirst[index - 1];
  const hours = (Date.parse(next.publishedAt) - Date.parse(stableNewestFirst[index].publishedAt)) / HOUR_MS;
  return hours >= 0 && hours <= 48 ? { version: next.version, hours } : null;
}

/** Days well above the typical value; used to annotate unusual activity. */
export function detectSpikes(values: readonly number[]) {
  const typical = median(values.filter((value) => value > 0)) ?? 0;
  return values.map((value) => values.length >= 4 && value >= 5 && value > typical * 2);
}

export function nextMilestone(total: number, dailyPace: number | null) {
  const ladder = [1, 2.5, 5];
  let target = 0;
  for (let exponent = 1; target <= total; exponent += 1) {
    for (const step of ladder) {
      const candidate = step * 10 ** exponent;
      if (candidate > total) {
        target = candidate;
        break;
      }
    }
    if (exponent > 12) break;
  }
  const days = dailyPace && dailyPace > 0 ? Math.ceil((target - total) / dailyPace) : null;
  return { target, remaining: target - total, days };
}

export function betaPool(prereleasesNewestFirst: readonly { downloads: number }[], limit = 10) {
  const recent = prereleasesNewestFirst.slice(0, limit).map((release) => release.downloads);
  if (!recent.length) return null;
  return { typical: median(recent) ?? 0, max: Math.max(...recent), count: recent.length };
}

export type ActiveUserItem = { version: string; value: number; kind: 'first-week' | 'so-far' | 'lifetime' };

/**
 * Most HACS users update within days of a release, so a typical release's first-week
 * downloads approximate the number of actively updating installations.
 */
export function activeUserEstimate(items: readonly ActiveUserItem[]) {
  const usable = items.filter((item) => item.value > 0).slice(0, 3);
  const value = median(usable.map((item) => item.value));
  if (value === null) return null;
  return {
    value: Math.round(value),
    items: usable,
    lowerBound: usable.some((item) => item.kind === 'so-far'),
    upperBound: usable.some((item) => item.kind === 'lifetime'),
  };
}

/** Share of new downloads that came from one asset, for the latest week and the week before. */
export function assetShareTrend(timeline: readonly TimelineEntry[], assetId: string) {
  const latest = timeline.at(-1);
  const weekIndex = baselineIndex(timeline, 7);
  const twoWeekIndex = baselineIndex(timeline, 14);
  if (!latest?.project.assets || weekIndex < 0) return null;
  const share = (end: SnapshotProject, start: SnapshotProject) => {
    if (!end.assets || !start.assets) return null;
    const totals = Object.keys(end.assets).map((id) => Math.max(0, (end.assets?.[id] ?? 0) - (start.assets?.[id] ?? 0)));
    const total = totals.reduce((sum, value) => sum + value, 0);
    const asset = Math.max(0, (end.assets[assetId] ?? 0) - (start.assets[assetId] ?? 0));
    return total > 0 ? (asset / total) * 100 : null;
  };
  const week = timeline[weekIndex].project;
  return {
    current: share(latest.project, week),
    previous: twoWeekIndex >= 0 ? share(week, timeline[twoWeekIndex].project) : null,
  };
}

export function issuesAfterRelease<T extends { createdAt: string }>(
  issues: readonly T[],
  publishedAt: string,
  hours = 72,
): T[] {
  const start = Date.parse(publishedAt);
  return issues.filter((issue) => {
    const created = Date.parse(issue.createdAt);
    return created >= start && created < start + hours * HOUR_MS;
  });
}

/** Step series of cumulative counts by day, from a {YYYY-MM-DD: count} map. */
export function dailySeries(map: Record<string, number> | undefined) {
  return Object.entries(map ?? {})
    .filter(([date, value]) => !Number.isNaN(Date.parse(date)) && Number.isFinite(value))
    .map(([date, value]) => ({ t: Date.parse(date), v: value }))
    .sort((a, b) => a.t - b.t);
}

export function deltaSince(series: readonly Point[], days: number, now = Date.now()) {
  const latest = series.at(-1);
  if (!latest) return null;
  const cutoff = now - days * DAY_MS;
  const before = [...series].reverse().find((point) => point.t <= cutoff);
  return latest.v - (before?.v ?? 0);
}
