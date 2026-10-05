import { describe, expect, it } from 'vitest';
import { buildReleaseComparison, filterPrereleases, formatReleaseAge } from './releaseComparison';

const releases = [
  { version: 'v3', downloads: 157, publishedAt: '2026-09-14T08:00:00Z' },
  { version: 'v2', downloads: 3, publishedAt: '2026-09-13T08:00:00Z' },
  { version: 'v1', downloads: 299, publishedAt: '2026-08-01T08:00:00Z' },
];

describe('buildReleaseComparison', () => {
  it('compares the latest release with the strongest earlier release', () => {
    expect(buildReleaseComparison(releases, Date.parse('2026-09-15T12:00:00Z'))).toEqual({
      latest: releases[0],
      previousBest: releases[2],
      ageDays: 1,
      difference: -142,
      progressPercentage: 53,
      state: 'behind',
    });
  });

  it('recognizes a new record without using the latest release as its own benchmark', () => {
    const comparison = buildReleaseComparison([
      { ...releases[0], downloads: 320 },
      ...releases.slice(1),
    ]);
    expect(comparison?.state).toBe('ahead');
    expect(comparison?.difference).toBe(21);
    expect(comparison?.progressPercentage).toBe(107);
    expect(comparison?.previousBest.version).toBe('v1');
  });

  it('returns no comparison until an earlier release exists', () => {
    expect(buildReleaseComparison(releases.slice(0, 1))).toBeNull();
  });
});

describe('filterPrereleases', () => {
  it('keeps prereleases when enabled and excludes them when disabled', () => {
    const releasesWithTypes = [
      { ...releases[0], prerelease: false },
      { ...releases[1], prerelease: true },
    ];

    expect(filterPrereleases(releasesWithTypes, true)).toEqual(releasesWithTypes);
    expect(filterPrereleases(releasesWithTypes, false)).toEqual([releasesWithTypes[0]]);
  });
});

describe('formatReleaseAge', () => {
  it.each([
    [0, 'Released today'],
    [1, 'Released 1 day ago'],
    [12, 'Released 12 days ago'],
  ])('formats %i days', (days, expected) => {
    expect(formatReleaseAge(days)).toBe(expected);
  });
});
