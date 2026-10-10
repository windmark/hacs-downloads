import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  activeUserEstimate,
  assetShareTrend,
  betaPool,
  countResets,
  cumulativeAt,
  daysToMajority,
  deltaSince,
  detectSpikes,
  dailySeries,
  findHotfix,
  forecastFirstWeek,
  issuesAfterRelease,
  launchCurve,
  milestoneHours,
  nextMilestone,
  olderVersionShare,
  projectTimeline,
  recentDownloadsByVersion,
  releaseCadence,
  releasePoints,
  versionMix,
} from './insights';
import type { SnapshotHistory } from './insights';

const snap = (capturedAt: string, releases: Record<string, number>, assets?: Record<string, number>) => ({
  capturedAt,
  projects: { p: { total: Object.values(releases).reduce((a, b) => a + b, 0), releases, ...(assets ? { assets } : {}) } },
});

// Real EF-PowerOcean snapshots around the v2.8.1 (5 Oct 14:40) and v2.8.2 (7 Oct 19:59) launches.
const history: SnapshotHistory = {
  snapshots: [
    snap('2026-10-04T10:33:00Z', { 'v2.8.0': 0 }),
    snap('2026-10-05T15:15:00Z', { 'v2.8.1': 3, 'v2.8.0': 0 }),
    snap('2026-10-06T11:14:00Z', { 'v2.8.1': 24, 'v2.8.0': 0 }),
    snap('2026-10-07T11:02:00Z', { 'v2.8.1': 51, 'v2.8.0': 0 }),
    snap('2026-10-08T11:19:00Z', { 'v2.8.2': 18, 'v2.8.1': 70, 'v2.8.0': 0 }),
    snap('2026-10-09T11:17:00Z', { 'v2.8.2': 46, 'v2.8.1': 72, 'v2.8.0': 0 }),
    snap('2026-10-10T10:34:00Z', { 'v2.8.2': 72, 'v2.8.1': 73, 'v2.8.0': 0 }),
  ],
};
const timeline = projectTimeline(history, 'p');
const v281 = { version: 'v2.8.1', publishedAt: Date.parse('2026-10-05T14:40:31Z'), points: releasePoints(timeline, 'v2.8.1') };
const v282 = { version: 'v2.8.2', publishedAt: Date.parse('2026-10-07T19:59:29Z'), points: releasePoints(timeline, 'v2.8.2') };

describe('launch curves', () => {
  it('interpolates from zero at publish time', () => {
    expect(cumulativeAt(v281.points, v281.publishedAt, v281.publishedAt)).toBe(0);
    const dayOne = cumulativeAt(v281.points, v281.publishedAt, v281.publishedAt + DAY_MS);
    expect(dayOne).toBeGreaterThan(24);
    expect(dayOne).toBeLessThan(51);
  });

  it('splits downloads into launch buckets and marks the running bucket as partial', () => {
    const curve = launchCurve(v281.points, v281.publishedAt);
    expect(curve.available).toBe(true);
    const [d0, d1, d2, d3, rest] = curve.buckets;
    expect(d0.downloads).toBeGreaterThan(20);
    expect(d0.partial).toBe(false);
    expect((d0.downloads ?? 0) + (d1.downloads ?? 0) + (d2.downloads ?? 0) + (d3.downloads ?? 0)).toBe(73);
    expect(d3.partial).toBe(true);
    expect(rest.downloads).toBeNull();
    expect(curve.firstWeek).toBeNull();
  });

  it('refuses to guess when tracking started long after publish', () => {
    const old = { publishedAt: Date.parse('2026-09-01T00:00:00Z') };
    const curve = launchCurve(releasePoints(timeline, 'v2.8.0'), old.publishedAt);
    expect(curve.available).toBe(false);
    expect(curve.buckets.every((bucket) => bucket.downloads === null)).toBe(true);
  });

  it('finds milestone crossing times', () => {
    const [ten, fifty, hundred] = milestoneHours(v281.points, v281.publishedAt, [10, 50, 100]);
    expect(ten.hours).toBeGreaterThan(0.5);
    expect(ten.hours).toBeLessThan(21);
    expect(fifty.hours).toBeGreaterThan(20);
    expect(hundred.hours).toBeNull();
  });

  it('keeps the running maximum when an asset counter resets', () => {
    const reset = projectTimeline({ snapshots: [snap('2026-10-01T00:00:00Z', { a: 10 }), snap('2026-10-02T00:00:00Z', { a: 2 })] }, 'p');
    expect(releasePoints(reset, 'a').map((point) => point.v)).toEqual([10, 10]);
    expect(countResets(reset, 'a')).toBe(1);
  });

  it('projects a first-week total from earlier releases', () => {
    const reference = {
      version: 'ref',
      publishedAt: Date.parse('2026-09-20T00:00:00Z'),
      points: [
        { t: Date.parse('2026-09-21T00:00:00Z'), v: 50 },
        { t: Date.parse('2026-09-22T00:00:00Z'), v: 75 },
        { t: Date.parse('2026-09-23T00:00:00Z'), v: 85 },
        { t: Date.parse('2026-09-24T00:00:00Z'), v: 90 },
        { t: Date.parse('2026-09-25T00:00:00Z'), v: 94 },
        { t: Date.parse('2026-09-26T00:00:00Z'), v: 97 },
        { t: Date.parse('2026-09-27T00:00:00Z'), v: 100 },
      ],
    };
    const young = {
      version: 'young',
      publishedAt: Date.parse('2026-10-01T00:00:00Z'),
      points: [{ t: Date.parse('2026-10-02T00:00:00Z'), v: 40 }],
    };
    expect(forecastFirstWeek(young, [reference])).toEqual({ value: 80, projected: true, references: 1 });
    expect(forecastFirstWeek(reference, [])).toEqual({ value: 100, projected: false, references: 0 });
  });
});

describe('version mix and upgrade speed', () => {
  const mix = versionMix(timeline);
  it('derives new downloads per version per day', () => {
    expect(mix.at(-1)?.byVersion).toEqual({ 'v2.8.2': 26, 'v2.8.1': 1 });
    expect(mix.at(-1)?.total).toBe(27);
  });
  it('measures days until a release takes most daily downloads', () => {
    expect(daysToMajority(mix, 'v2.8.2', v282.publishedAt)).toBeCloseTo(1.64, 1);
    // The first snapshot after v2.8.1 (35 minutes later) already had it as the only downloaded version.
    expect(daysToMajority(mix, 'v2.8.1', v281.publishedAt)).toBeLessThan(0.05);
  });
  it('reports how much recent activity is on older versions', () => {
    const recent = recentDownloadsByVersion(timeline, 2);
    expect(recent).toEqual({ 'v2.8.2': 54, 'v2.8.1': 3, 'v2.8.0': 0 });
    expect(olderVersionShare({ a: 6, b: 2, c: 2 }, ['a', 'b', 'c'])?.share).toBe(20);
  });
});

describe('release habits', () => {
  const stable = [
    { version: 'v2.8.2', publishedAt: '2026-10-07T19:59:29Z', downloads: 78 },
    { version: 'v2.8.1', publishedAt: '2026-10-05T14:40:31Z', downloads: 74 },
    { version: 'v2.8.0', publishedAt: '2026-10-04T06:56:41Z', downloads: 0 },
  ];
  it('summarises cadence', () => {
    const cadence = releaseCadence(stable, Date.parse('2026-10-10T00:00:00Z'));
    expect(cadence.releasesLast30Days).toBe(3);
    expect(cadence.medianGapDays).toBeCloseTo(1.77, 1);
  });
  it('detects hotfixes within 48 hours', () => {
    expect(findHotfix(stable, 'v2.8.0')?.version).toBe('v2.8.1');
    expect(findHotfix(stable, 'v2.8.1')).toBeNull();
    expect(findHotfix(stable, 'v2.8.2')).toBeNull();
  });
  it('estimates active users from typical first-week downloads', () => {
    expect(activeUserEstimate([
      { version: 'a', value: 70, kind: 'so-far' },
      { version: 'b', value: 80, kind: 'first-week' },
      { version: 'c', value: 0, kind: 'first-week' },
      { version: 'd', value: 60, kind: 'first-week' },
    ])).toMatchObject({ value: 70, lowerBound: true });
  });
  it('summarises beta testers', () => {
    expect(betaPool([{ downloads: 1 }, { downloads: 2 }, { downloads: 1 }])).toEqual({ typical: 1, max: 2, count: 3 });
  });
});

describe('forecasting and annotations', () => {
  it('picks the next round milestone and its ETA', () => {
    expect(nextMilestone(158, 25)).toEqual({ target: 250, remaining: 92, days: 4 });
    expect(nextMilestone(3, null)).toEqual({ target: 10, remaining: 7, days: null });
    expect(nextMilestone(1000, 10).target).toBe(2500);
  });
  it('flags unusually busy days', () => {
    expect(detectSpikes([3, 4, 2, 30, 3])).toEqual([false, false, false, true, false]);
    expect(detectSpikes([21, 27, 37, 30])).toEqual([false, false, false, false]);
  });
  it('finds issues opened shortly after a release', () => {
    const issues = [{ createdAt: '2026-10-05T17:36:04Z' }, { createdAt: '2026-10-05T11:20:21Z' }, { createdAt: '2026-10-09T00:00:00Z' }];
    expect(issuesAfterRelease(issues, '2026-10-05T14:40:31Z')).toHaveLength(1);
  });
  it('tracks asset share week over week', () => {
    const assetTimeline = projectTimeline({
      snapshots: [
        snap('2026-09-26T00:00:00Z', { v: 0 }, { factory: 0, ota: 0 }),
        snap('2026-10-03T00:00:00Z', { v: 10 }, { factory: 5, ota: 5 }),
        snap('2026-10-10T00:00:00Z', { v: 30 }, { factory: 10, ota: 20 }),
      ],
    }, 'p');
    expect(assetShareTrend(assetTimeline, 'factory')).toEqual({ current: 25, previous: 50 });
  });
  it('reads daily cumulative maps', () => {
    const series = dailySeries({ '2026-10-01': 5, '2026-10-08': 9, nonsense: 3 });
    expect(series).toHaveLength(2);
    expect(deltaSince(series, 7, Date.parse('2026-10-09T00:00:00Z'))).toBe(4);
  });
});

import { latestInstalls, parseProjectMeta } from './meta';

describe('project metadata', () => {
  it('drops malformed parts instead of failing', () => {
    const meta = parseProjectMeta({
      schemaVersion: 1,
      projects: {
        p: {
          stars: { total: 3, history: { '2026-10-01': 3 } },
          issues: [{ number: 1, title: 'Bug', createdAt: '2026-10-01T00:00:00Z', url: 'u' }, { number: 'x' }],
          installs: { domain: 'd', history: { '2026-10-01': { total: 40, versions: { '1.0': 30 } }, '2026-10-08': { total: 52 }, bad: { total: 'x' } } },
        },
        q: 'nonsense',
      },
    });
    expect(meta?.projects.p.issues).toHaveLength(1);
    expect(meta?.projects.q).toEqual({});
    expect(latestInstalls(meta?.projects.p)).toMatchObject({ total: 52, weekDelta: 12 });
    expect(parseProjectMeta({ schemaVersion: 2, projects: {} })).toBeNull();
  });
});
