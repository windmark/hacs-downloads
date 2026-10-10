import { describe, expect, it } from 'vitest';
import {
  applyReleaseWindow,
  buildShareSegments,
  conicGradient,
  daysToRecord,
  downloadsPerDay,
  formatRate,
  isPrerelease,
  isPrereleaseTag,
  sortReleases,
  toCsv,
} from './analytics';

describe('isPrereleaseTag', () => {
  it.each(['v2.9.0-beta.9', '2.5.2-beta.5', 'v1.0.0-rc.1', 'v1.0.0-alpha', 'v0.7.34b5', '1.4.0rc1', 'v3.0.0-dev'])(
    'flags %s',
    (tag) => expect(isPrereleaseTag(tag)).toBe(true),
  );
  it.each(['v2.8.2', '1.27.1', 'v0.7.35', 'v2024.10.1', 'beta-channel-v1'])(
    'keeps %s stable',
    (tag) => expect(isPrereleaseTag(tag)).toBe(false),
  );
  it('trusts the GitHub flag', () => {
    expect(isPrerelease({ version: 'v2.0.0', prerelease: true })).toBe(true);
  });
});

describe('applyReleaseWindow', () => {
  it('keeps the newest five releases or everything', () => {
    const releases = [1, 2, 3, 4, 5, 6, 7];
    expect(applyReleaseWindow(releases, 'recent')).toEqual([1, 2, 3, 4, 5]);
    expect(applyReleaseWindow(releases, 'all')).toEqual(releases);
  });
});

describe('downloadsPerDay', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  it('normalises downloads by release age', () => {
    expect(downloadsPerDay({ downloads: 70, publishedAt: '2026-10-03T12:00:00Z' }, now)).toBe(10);
  });
  it('does not inflate releases younger than a day', () => {
    expect(downloadsPerDay({ downloads: 6, publishedAt: '2026-10-10T11:00:00Z' }, now)).toBe(6);
  });
  it('formats small and large rates', () => {
    expect(formatRate(0)).toBe('0');
    expect(formatRate(0.04)).toBe('<0.1');
    expect(formatRate(3.456)).toBe('3.5');
    expect(formatRate(42.6)).toBe('43');
  });
});

describe('daysToRecord', () => {
  it('projects the remaining gap at the current pace', () => {
    expect(daysToRecord(30, 4)).toBe(8);
    expect(daysToRecord(0, 4)).toBe(0);
    expect(daysToRecord(30, 0)).toBeNull();
    expect(daysToRecord(30, null)).toBeNull();
  });
});

describe('buildShareSegments', () => {
  it('ranks releases and groups the long tail', () => {
    const segments = buildShareSegments([
      { version: 'v6', downloads: 10 },
      { version: 'v5', downloads: 40 },
      { version: 'v4', downloads: 20 },
      { version: 'v3', downloads: 10 },
      { version: 'v2', downloads: 10 },
      { version: 'v1', downloads: 10 },
      { version: 'v0', downloads: 0 },
    ], 4);
    expect(segments.map((segment) => segment.label)).toEqual(['v5', 'v4', 'v6', '3 other releases']);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(100);
  });
  it('returns nothing without downloads', () => {
    expect(buildShareSegments([{ version: 'v1', downloads: 0 }])).toEqual([]);
  });
  it('builds a conic gradient that closes the circle', () => {
    expect(conicGradient([{ share: 50 }, { share: 50 }], ['red', 'blue'], 'grey'))
      .toBe('conic-gradient(red 0.00deg 180.00deg, blue 180.00deg 360.00deg)');
  });
});

describe('sortReleases', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const releases = [
    { version: 'new', downloads: 10, publishedAt: '2026-10-09T00:00:00Z' },
    { version: 'old', downloads: 100, publishedAt: '2026-09-10T00:00:00Z' },
  ];
  it('sorts by downloads, rate and date', () => {
    expect(sortReleases(releases, 'downloads', 'desc', now)[0].version).toBe('old');
    expect(sortReleases(releases, 'rate', 'desc', now)[0].version).toBe('new');
    expect(sortReleases(releases, 'published', 'asc', now)[0].version).toBe('old');
  });
});

describe('toCsv', () => {
  it('escapes values that need quoting', () => {
    expect(toCsv([['a', 'b,c'], [1, 'say "hi"']])).toBe('a,"b,c"\n1,"say ""hi"""\n');
  });
});
