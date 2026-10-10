'use client';

import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bug,
  CalendarDays,
  ChevronRight,
  Clock3,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FileDown,
  FlaskConical,
  GitBranch,
  Heart,
  Info,
  Layers3,
  Link2,
  Package,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Star,
  Target,
  TrendingUp,
  Users,
  Wrench,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import projectConfigs from './projects.json';
import { formatGitHubStarCount, parseGitHubStarCount } from './github';
import { buildReleaseComparison, filterPrereleases, formatReleaseAge } from './releaseComparison';
import {
  RECENT_RELEASE_COUNT,
  applyReleaseWindow,
  buildShareSegments,
  conicGradient,
  daysToRecord,
  downloadsPerDay,
  formatRate,
  isPrerelease,
  isPrereleaseTag,
  releaseAgeDays,
  sortReleases,
  toCsv,
} from './analytics';
import type { ReleaseWindow, SortDirection, SortKey } from './analytics';
import {
  DAY_MS as INSIGHT_DAY_MS,
  activeUserEstimate,
  assetShareTrend,
  betaPool,
  countResets,
  dailySeries,
  daysToMajority,
  deltaSince,
  detectSpikes,
  findHotfix,
  forecastFirstWeek,
  issuesAfterRelease,
  launchCurve,
  median,
  milestoneHours,
  nextMilestone,
  olderVersionShare,
  projectTimeline,
  recentDownloadsByVersion,
  releaseCadence,
  releasePoints,
  versionMix,
} from './insights';
import type { ActiveUserItem, ReleaseCurveInput } from './insights';
import { latestInstalls, parseProjectMeta } from './meta';
import type { ProjectMetaFile } from './meta';
import { InsightTile, LaunchHeatmap, LineChart, PortfolioTable, ReleaseDetail, formatDays } from './Lifecycle';

type AssetMatcher =
  | { assetName: string; assetNameTemplate?: never }
  | { assetName?: never; assetNameTemplate: string };

type TrackedAssetConfig = AssetMatcher & {
  id: string;
  label: string;
};

type ProjectAsset = AssetMatcher & { assets?: never };
type ProjectAssets = { assetName?: never; assetNameTemplate?: never; assets: [TrackedAssetConfig, TrackedAssetConfig] };

type ProjectConfig = (ProjectAsset | ProjectAssets) & {
  id: string;
  name: string;
  owner: string;
  repo: string;
  mark: string;
  description: string;
};

type ReleaseMetric = {
  version: string;
  downloads: number;
  publishedAt: string;
  size: number;
  url: string;
  prerelease: boolean;
  assets?: Record<string, {
    downloads: number;
    size: number;
  }>;
  reactions?: { total: number; positive: number; negative: number };
};

type GitHubRelease = {
  tag_name: string;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  reactions?: Partial<Record<'total_count' | '+1' | '-1' | 'laugh' | 'hooray' | 'confused' | 'heart' | 'rocket' | 'eyes', number>>;
  assets: Array<{
    name: string;
    download_count: number;
    size: number;
  }>;
};

type GitHubRepository = {
  stargazers_count: number;
};

type DashboardSnapshot = {
  releases: ReleaseMetric[];
  stars?: number;
  updatedAt: string;
};

type HistoryProjectSnapshot = {
  total: number;
  releases: Record<string, number>;
  prereleases?: string[];
  assets?: Record<string, number>;
  releaseAssets?: Record<string, Record<string, number>>;
};

type HistorySnapshot = {
  capturedAt: string;
  projects: Record<string, HistoryProjectSnapshot>;
};

type DownloadHistory = {
  schemaVersion: 1;
  snapshots: HistorySnapshot[];
};

type GrowthDelta = {
  absolute: number;
  percentage: number | null;
};

type MetricGrowth = {
  day: GrowthDelta | null;
  week: GrowthDelta | null;
  capturedAt: string | null;
};

type GrowthSeriesPoint = {
  capturedAt: string;
  label: string;
  value: number;
  assets?: Record<string, number>;
};

type GrowthHistoryPoint = {
  capturedAt: string;
  total: number;
  assets?: Record<string, number>;
};

const PROJECTS = projectConfigs as readonly ProjectConfig[];

const DEFAULT_PROJECT_ID = PROJECTS[0].id;
const LAST_PROJECT_KEY = 'hacs-downloads-selected-project-v1';
const RATE_LIMIT_RESET_KEY = 'hacs-downloads-rate-limit-reset-v1';
const FILTERS_KEY = 'hacs-downloads-filters-v1';
const SHARE_COLORS = ['#19c6ad', '#0b8e81', '#7adccd', '#16526b', '#b4ece2'];
const SHARE_OTHER_COLOR = '#cbd7df';
const SHARE_TRACK_COLOR = '#e8eef2';

type ScopeKind = 'channel' | 'window';
type Filters = { releaseWindow: ReleaseWindow; includePrereleases: boolean };

function getInitialFilters(): Filters {
  const filters: Filters = { releaseWindow: 'recent', includePrereleases: false };
  try {
    const stored = JSON.parse(window.localStorage.getItem(FILTERS_KEY) ?? 'null') as Partial<Filters> | null;
    if (stored?.releaseWindow === 'all' || stored?.releaseWindow === 'recent') filters.releaseWindow = stored.releaseWindow;
    if (typeof stored?.includePrereleases === 'boolean') filters.includePrereleases = stored.includePrereleases;
    const params = new URLSearchParams(window.location.search);
    const queryWindow = params.get('releases');
    if (queryWindow === 'all' || queryWindow === 'recent') filters.releaseWindow = queryWindow;
    const queryPrereleases = params.get('prereleases');
    if (queryPrereleases === '1' || queryPrereleases === '0') filters.includePrereleases = queryPrereleases === '1';
  } catch {
    // Defaults apply when URL or storage access is unavailable.
  }
  return filters;
}
const REFRESH_INTERVAL_MS = 300_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getProject(projectId: string) {
  return PROJECTS.find((candidate) => candidate.id === projectId) ?? PROJECTS[0];
}

function resolveAssetName(asset: AssetMatcher, tag: string) {
  if (asset.assetName !== undefined) return asset.assetName;
  const version = tag.replace(/^v/i, '');
  return asset.assetNameTemplate
    .replaceAll('{tag}', tag)
    .replaceAll('{version}', version);
}

function projectAssets(project: ProjectConfig): TrackedAssetConfig[] {
  if (project.assets) return project.assets;
  return [{
    id: 'release',
    label: 'Release asset',
    ...(project.assetName !== undefined
      ? { assetName: project.assetName }
      : { assetNameTemplate: project.assetNameTemplate }),
  }];
}

function displayAssetName(project: ProjectConfig) {
  if (project.assets) return `${project.assets.length} tracked assets`;
  return project.assetName ?? project.assetNameTemplate;
}

function getInitialProjectId() {
  try {
    const queryProject = new URLSearchParams(window.location.search).get('project');
    if (queryProject && PROJECTS.some((project) => project.id === queryProject)) return queryProject;
    const storedProject = window.localStorage.getItem(LAST_PROJECT_KEY);
    if (storedProject && PROJECTS.some((project) => project.id === storedProject)) return storedProject;
  } catch {
    // The default project works when URL or storage access is unavailable.
  }
  return DEFAULT_PROJECT_ID;
}

function snapshotCacheKey(projectId: string) {
  return `hacs-downloads-snapshot-${projectId}-v4`;
}

function readRateLimitReset(): number | null {
  try {
    const resetAt = Number(window.localStorage.getItem(RATE_LIMIT_RESET_KEY));
    if (Number.isFinite(resetAt) && resetAt > Date.now()) return resetAt;
    window.localStorage.removeItem(RATE_LIMIT_RESET_KEY);
  } catch {
    // Rate-limit backoff still works for the current page without storage.
  }
  return null;
}

function readCachedSnapshot(projectId: string): DashboardSnapshot | null {
  try {
    const cached = window.localStorage.getItem(snapshotCacheKey(projectId));
    if (!cached) return null;
    const snapshot = JSON.parse(cached) as DashboardSnapshot;
    if (!Array.isArray(snapshot.releases) || Number.isNaN(Date.parse(snapshot.updatedAt))) return null;
    if (snapshot.stars !== undefined && parseGitHubStarCount({ stargazers_count: snapshot.stars }) === null) return null;
    const isValid = snapshot.releases.every((release) => (
      typeof release.version === 'string'
      && typeof release.downloads === 'number'
      && typeof release.publishedAt === 'string'
      && typeof release.size === 'number'
      && typeof release.url === 'string'
      && typeof release.prerelease === 'boolean'
      && (release.assets === undefined || (
        release.assets !== null
        && typeof release.assets === 'object'
        && Object.values(release.assets).every((asset) => (
          typeof asset.downloads === 'number'
          && typeof asset.size === 'number'
        ))
      ))
    ));
    return isValid ? snapshot : null;
  } catch {
    return null;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en').format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    month: 'short',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function timeAgo(date: Date | null) {
  if (!date) return 'Waiting for GitHub';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function isDownloadHistory(value: unknown): value is DownloadHistory {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DownloadHistory>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.snapshots)) return false;
  return candidate.snapshots.every((snapshot) => (
    snapshot
    && typeof snapshot === 'object'
    && typeof snapshot.capturedAt === 'string'
    && !Number.isNaN(Date.parse(snapshot.capturedAt))
    && snapshot.projects
    && typeof snapshot.projects === 'object'
  ));
}

function calculateMetricGrowth(
  history: DownloadHistory | null,
  projectId: string,
  getValue: (snapshot: HistoryProjectSnapshot) => number,
): MetricGrowth {
  const points = (history?.snapshots ?? []).flatMap((snapshot) => {
    const projectSnapshot = snapshot.projects[projectId];
    if (!projectSnapshot) return [];
    const value = getValue(projectSnapshot);
    return Number.isFinite(value) ? [{ capturedAt: snapshot.capturedAt, value }] : [];
  }).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

  const latest = points.at(-1);
  if (!latest) return { day: null, week: null, capturedAt: null };
  const latestTime = Date.parse(latest.capturedAt);

  const calculateDelta = (days: number): GrowthDelta | null => {
    const targetTime = latestTime - days * DAY_MS;
    const baseline = points.slice(0, -1).reduce<(typeof points)[number] | null>((closest, point) => {
      if (Math.abs(Date.parse(point.capturedAt) - targetTime) > 18 * 60 * 60 * 1000) return closest;
      if (!closest) return point;
      return Math.abs(Date.parse(point.capturedAt) - targetTime) < Math.abs(Date.parse(closest.capturedAt) - targetTime) ? point : closest;
    }, null);
    if (!baseline) return null;
    const absolute = latest.value - baseline.value;
    return {
      absolute,
      percentage: baseline.value > 0 ? (absolute / baseline.value) * 100 : null,
    };
  };

  return {
    day: calculateDelta(1),
    week: calculateDelta(7),
    capturedAt: latest.capturedAt,
  };
}

function buildGrowthSeries(
  history: DownloadHistory | null,
  projectId: string,
  period: 'daily' | 'weekly',
  getValue: (snapshot: HistoryProjectSnapshot) => number,
  getAssets?: (snapshot: HistoryProjectSnapshot) => Record<string, number> | undefined,
): GrowthSeriesPoint[] {
  const points: GrowthHistoryPoint[] = (history?.snapshots ?? []).flatMap((snapshot) => {
    const projectSnapshot = snapshot.projects[projectId];
    if (!projectSnapshot) return [];
    const total = getValue(projectSnapshot);
    if (!Number.isFinite(total)) return [];
    const assets = getAssets?.(projectSnapshot);
    return [{ capturedAt: snapshot.capturedAt, total, ...(assets ? { assets } : {}) }];
  }).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  if (points.length < 2) return [];

  const periodDays = period === 'daily' ? 1 : 7;
  const limit = period === 'daily' ? 14 : 8;
  const series: GrowthSeriesPoint[] = [];
  let endpointIndex = points.length - 1;

  while (endpointIndex > 0 && series.length < limit) {
    const endpoint = points[endpointIndex];
    const targetTime = Date.parse(endpoint.capturedAt) - periodDays * DAY_MS;
    let baselineIndex = -1;
    let baselineDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < endpointIndex; index += 1) {
      const distance = Math.abs(Date.parse(points[index].capturedAt) - targetTime);
      if (distance <= 18 * 60 * 60 * 1000 && distance < baselineDistance) {
        baselineIndex = index;
        baselineDistance = distance;
      }
    }
    if (baselineIndex < 0) break;

    const date = new Date(endpoint.capturedAt);
    const baseline = points[baselineIndex];
    const assets = endpoint.assets && baseline.assets
      ? Object.fromEntries(Object.entries(endpoint.assets).map(([assetId, downloads]) => [
          assetId,
          downloads - (baseline.assets?.[assetId] ?? 0),
        ]))
      : undefined;
    series.unshift({
      capturedAt: endpoint.capturedAt,
      label: new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date),
      value: endpoint.total - baseline.total,
      ...(assets ? { assets } : {}),
    });
    endpointIndex = baselineIndex;
  }

  return series;
}

function AssetLegend({ assets }: { assets: [TrackedAssetConfig, TrackedAssetConfig] }) {
  return (
    <div className="asset-legend" aria-label="Tracked asset key">
      {assets.map((asset, index) => (
        <span key={asset.id}><i className={index === 0 ? 'asset-primary' : 'asset-secondary'} />{asset.label}</span>
      ))}
    </div>
  );
}

function ScopeChip({ label }: { label: string }) {
  return <span className="scope-chip"><SlidersHorizontal size={10} aria-hidden="true" />{label}</span>;
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

function formatAge(value: string) {
  const days = Math.floor((Date.now() - Date.parse(value)) / DAY_MS);
  if (Number.isNaN(days)) return '';
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function formatSignedNumber(value: number) {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatNumber(Math.abs(value))}`;
}

function formatGrowthPercentage(value: number | null) {
  if (value === null) return 'New baseline';
  if (value === 0) return '0%';
  const rounded = Math.abs(value) < 10 ? Math.abs(value).toFixed(1) : Math.round(Math.abs(value)).toString();
  return `${value > 0 ? '↑' : '↓'} ${rounded}%`;
}

function GrowthCell({ label, delta, historyStatus }: { label: string; delta: GrowthDelta | null; historyStatus: 'loading' | 'ready' | 'error' }) {
  const direction = delta ? (delta.absolute > 0 ? 'up' : delta.absolute < 0 ? 'down' : 'flat') : 'pending';
  return (
    <div className={`growth-cell direction-${direction}`}>
      <span>{label}</span>
      <strong>{delta ? formatSignedNumber(delta.absolute) : '—'}</strong>
      <small>{delta ? formatGrowthPercentage(delta.percentage) : historyStatus === 'loading' ? 'Loading history' : historyStatus === 'error' ? 'History unavailable' : 'Collecting history'}</small>
    </div>
  );
}

function StatCard({ label, value, note, icon, growth, historyStatus, loading = false }: { label: string; value: string; note: ReactNode; icon: ReactNode; growth?: MetricGrowth; historyStatus: 'loading' | 'ready' | 'error'; loading?: boolean }) {
  return (
    <article className={`stat-card${loading ? ' is-loading' : ''}`} aria-busy={loading}>
      <div className="stat-topline">
        <span className="stat-label">{label}</span>
        <span className="stat-icon" aria-hidden="true">{icon}</span>
      </div>
      <strong>{value}</strong>
      <p>{note}</p>
      {!loading && growth && <div className="growth-deltas" title={growth.capturedAt ? `Growth snapshot captured ${formatDate(growth.capturedAt)}` : 'Growth history is being collected'}>
        <GrowthCell label="24 hours" delta={growth.day} historyStatus={historyStatus} />
        <GrowthCell label="7 days" delta={growth.week} historyStatus={historyStatus} />
      </div>}
    </article>
  );
}

function ProjectSelector({ project, onSelect }: { project: ProjectConfig; onSelect: (projectId: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, PROJECTS.findIndex((candidate) => candidate.id === project.id)));
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, PROJECTS.findIndex((candidate) => candidate.id === project.id));

  const focusOption = (index: number) => {
    const nextIndex = (index + PROJECTS.length) % PROJECTS.length;
    setActiveIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  };

  const closeMenu = (restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openMenu = (index = selectedIndex) => {
    setActiveIndex(index);
    setIsOpen(true);
  };

  const chooseProject = (candidate: ProjectConfig) => {
    if (candidate.id !== project.id) onSelect(candidate.id);
    closeMenu(true);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number, candidate: ProjectConfig) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(PROJECTS.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseProject(candidate);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === 'Tab') {
      setIsOpen(false);
    }
  };

  useLayoutEffect(() => {
    if (isOpen) optionRefs.current[activeIndex]?.focus();
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !selectorRef.current?.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [isOpen]);

  return (
    <div className={`project-selector${isOpen ? ' is-open' : ''}`} ref={selectorRef}>
      <button
        aria-controls={listboxId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Tracked project: ${project.name}`}
        className="project-selector-trigger"
        onClick={() => isOpen ? closeMenu() : openMenu()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <Layers3 size={14} aria-hidden="true" />
        <span>{project.name}</span>
        <ChevronDown className="selector-chevron" size={13} aria-hidden="true" />
      </button>
      {isOpen && (
        <div aria-label="Tracked project" className="project-menu" id={listboxId} role="listbox">
          {PROJECTS.map((candidate, index) => (
            <button
              aria-selected={candidate.id === project.id}
              className="project-option"
              key={candidate.id}
              onClick={() => chooseProject(candidate)}
              onFocus={() => setActiveIndex(index)}
              onKeyDown={(event) => handleOptionKeyDown(event, index, candidate)}
              ref={(element) => { optionRefs.current[index] = element; }}
              role="option"
              tabIndex={index === activeIndex ? 0 : -1}
              type="button"
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [projectId, setProjectId] = useState(getInitialProjectId);
  const project = useMemo(() => getProject(projectId), [projectId]);
  const [initialSnapshot] = useState(() => readCachedSnapshot(projectId));
  const [initialRateLimitReset] = useState(readRateLimitReset);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(initialSnapshot);
  const [status, setStatus] = useState<'limited' | 'loading' | 'ready' | 'stale'>(initialRateLimitReset ? 'limited' : 'loading');
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'updated' | 'error'>('idle');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() => initialSnapshot ? new Date(initialSnapshot.updatedAt) : null);
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(initialRateLimitReset);
  const [initialFilters] = useState(getInitialFilters);
  const [releaseWindow, setReleaseWindowState] = useState<ReleaseWindow>(initialFilters.releaseWindow);
  const [includePrereleases, setIncludePrereleasesState] = useState(initialFilters.includePrereleases);
  const [scopeFocus, setScopeFocus] = useState<ScopeKind | null>(null);
  const [scopeFlash, setScopeFlash] = useState<ScopeKind | null>(null);
  const [chartMetric, setChartMetric] = useState<'total' | 'rate'>('total');
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'published', direction: 'desc' });
  const [linkState, setLinkState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [velocityView, setVelocityView] = useState<'daily' | 'weekly' | 'versions'>('daily');
  const growthRange: 'daily' | 'weekly' = velocityView === 'weekly' ? 'weekly' : 'daily';
  const [meta, setMeta] = useState<ProjectMetaFile | null>(null);
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const [history, setHistory] = useState<DownloadHistory | null>(null);
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const requestSequence = useRef(0);
  const inFlightProject = useRef<string | null>(null);
  const rateLimitResetRef = useRef<number | null>(initialRateLimitReset);
  const chartAreaRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (force = false) => {
    const resetAt = rateLimitResetRef.current;
    if (resetAt && resetAt > Date.now()) {
      setStatus('limited');
      setRefreshState('error');
      return;
    }
    if (resetAt) {
      rateLimitResetRef.current = null;
      setRateLimitReset(null);
      try {
        window.localStorage.removeItem(RATE_LIMIT_RESET_KEY);
      } catch {
        // Continue with the live request when storage is unavailable.
      }
    }

    const cachedSnapshot = readCachedSnapshot(project.id);
    const cacheAge = cachedSnapshot ? Date.now() - Date.parse(cachedSnapshot.updatedAt) : Number.POSITIVE_INFINITY;
    if (!force && cachedSnapshot && cacheAge < REFRESH_INTERVAL_MS && cachedSnapshot.stars !== undefined) {
      setSnapshot(cachedSnapshot);
      setLastUpdated(new Date(cachedSnapshot.updatedAt));
      setStatus('ready');
      setRefreshState('idle');
      return;
    }
    if (inFlightProject.current === project.id) return;

    const requestId = ++requestSequence.current;
    inFlightProject.current = project.id;
    setStatus('loading');
    setRefreshState('refreshing');
    try {
      const requestOptions = {
        cache: 'no-store' as const,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      };
      const [response, repositoryResponse] = await Promise.all([
        fetch(`https://api.github.com/repos/${project.owner}/${project.repo}/releases?per_page=100`, requestOptions),
        fetch(`https://api.github.com/repos/${project.owner}/${project.repo}`, requestOptions),
      ]);
      if (!response.ok) {
        const remaining = response.headers.get('X-RateLimit-Remaining');
        if (response.status === 403 && remaining === '0') {
          const resetSeconds = Number(response.headers.get('X-RateLimit-Reset'));
          const parsedReset = resetSeconds * 1000;
          const nextReset = Number.isFinite(parsedReset) && parsedReset > Date.now() ? parsedReset : Date.now() + REFRESH_INTERVAL_MS;
          rateLimitResetRef.current = nextReset;
          setRateLimitReset(nextReset);
          try {
            window.localStorage.setItem(RATE_LIMIT_RESET_KEY, String(nextReset));
          } catch {
            // The current page still respects the rate-limit reset.
          }
          if (requestId === requestSequence.current) {
            setStatus('limited');
            setRefreshState('error');
          }
          return;
        }
        throw new Error(`GitHub returned ${response.status}`);
      }
      const payload = await response.json() as GitHubRelease[];
      const repositoryPayload: unknown = repositoryResponse.ok ? await repositoryResponse.json() as GitHubRepository : null;
      const stars = parseGitHubStarCount(repositoryPayload) ?? cachedSnapshot?.stars;
      const trackedAssets = projectAssets(project);
      const metrics = payload.flatMap((release) => {
        if (release.draft || !release.published_at) return [];
        const matchedAssets = trackedAssets.flatMap((trackedAsset) => {
          const expectedAssetName = resolveAssetName(trackedAsset, release.tag_name);
          const asset = release.assets.find((candidate) => candidate.name === expectedAssetName);
          return asset ? [[trackedAsset.id, { downloads: asset.download_count, size: asset.size }] as const] : [];
        });
        if (matchedAssets.length === 0) return [];
        const assets = Object.fromEntries(matchedAssets);
        return [{
          version: release.tag_name,
          downloads: Object.values(assets).reduce((sum, asset) => sum + asset.downloads, 0),
          publishedAt: release.published_at,
          size: Object.values(assets).reduce((sum, asset) => sum + asset.size, 0),
          url: release.html_url,
          prerelease: release.prerelease,
          ...(project.assets ? { assets } : {}),
          ...(release.reactions?.total_count ? {
            reactions: {
              total: release.reactions.total_count,
              positive: (release.reactions['+1'] ?? 0) + (release.reactions.laugh ?? 0) + (release.reactions.hooray ?? 0) + (release.reactions.heart ?? 0) + (release.reactions.rocket ?? 0),
              negative: (release.reactions['-1'] ?? 0) + (release.reactions.confused ?? 0),
            },
          } : {}),
        }];
      }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      if (requestId !== requestSequence.current) return;

      const updatedAt = new Date().toISOString();
      const nextSnapshot = { releases: metrics, stars, updatedAt };
      setSnapshot(nextSnapshot);
      setLastUpdated(new Date(updatedAt));
      try {
        window.localStorage.setItem(snapshotCacheKey(project.id), JSON.stringify(nextSnapshot));
      } catch {
        // The live dashboard still works when storage is unavailable.
      }
      setStatus('ready');
      setRefreshState('updated');
    } catch {
      if (requestId !== requestSequence.current) return;
      setStatus('stale');
      setRefreshState('error');
    } finally {
      if (inFlightProject.current === project.id) inFlightProject.current = null;
    }
  }, [project]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    const loadHistory = async () => {
      try {
        const response = await fetch('download-history.json', { cache: 'no-cache', signal: controller.signal });
        if (!response.ok) throw new Error(`History returned ${response.status}`);
        const payload: unknown = await response.json();
        if (!isDownloadHistory(payload)) throw new Error('History file is invalid');
        setHistory(payload);
        setHistoryStatus('ready');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setHistoryStatus('error');
      }
    };
    void loadHistory();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('project-meta.json', { cache: 'no-cache', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => setMeta(parseProjectMeta(payload)))
      .catch(() => {
        // Project metadata is optional; the dashboard works without it.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!rateLimitReset) return;
    const delay = Math.max(0, rateLimitReset - Date.now() + 1_000);
    const timer = window.setTimeout(() => {
      rateLimitResetRef.current = null;
      setRateLimitReset(null);
      try {
        window.localStorage.removeItem(RATE_LIMIT_RESET_KEY);
      } catch {
        // Continue with the automatic retry when storage is unavailable.
      }
      void refresh(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [rateLimitReset, refresh]);

  useEffect(() => {
    if (refreshState !== 'updated') return;
    const timer = window.setTimeout(() => setRefreshState('idle'), 2_400);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  useEffect(() => {
    const title = `${project.name} · HACS Download Analytics`;
    const description = `Live GitHub release download analytics for ${project.description}.`;
    document.title = title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
  }, [project]);

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ releaseWindow, includePrereleases }));
      const url = new URL(window.location.href);
      url.searchParams.set('releases', releaseWindow);
      url.searchParams.set('prereleases', includePrereleases ? '1' : '0');
      window.history.replaceState({}, '', url);
    } catch {
      // Filters still apply for the current page without storage or history access.
    }
  }, [includePrereleases, releaseWindow]);

  useEffect(() => {
    if (!scopeFlash) return;
    const timer = window.setTimeout(() => setScopeFlash(null), 1_100);
    return () => window.clearTimeout(timer);
  }, [scopeFlash]);

  useEffect(() => {
    if (linkState === 'idle') return;
    const timer = window.setTimeout(() => setLinkState('idle'), 1_800);
    return () => window.clearTimeout(timer);
  }, [linkState]);

  // Hover and keyboard focus preview which sections a filter affects. A click only
  // flashes the affected sections, so nothing stays dimmed after a selection.
  const previewScope = (kind: ScopeKind, target: EventTarget) => {
    if (target instanceof HTMLElement && target.matches(':focus-visible')) setScopeFocus(kind);
  };

  const setReleaseWindow = (next: ReleaseWindow) => {
    setScopeFocus(null);
    setReleaseWindowState(next);
    setScopeFlash('window');
  };

  const setIncludePrereleases = (next: boolean) => {
    setScopeFocus(null);
    setIncludePrereleasesState(next);
    setScopeFlash('channel');
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkState('copied');
    } catch {
      setLinkState('error');
    }
  };

  const scopeClass = (...targets: ScopeKind[]) => {
    if (scopeFocus) return targets.includes(scopeFocus) ? ' scope-target' : ' scope-muted';
    if (scopeFlash && targets.includes(scopeFlash)) return ' scope-target scope-flash';
    return '';
  };

  const selectProject = (nextProjectId: string) => {
    const nextProject = getProject(nextProjectId);
    const cachedSnapshot = readCachedSnapshot(nextProject.id);
    requestSequence.current += 1;
    setProjectId(nextProject.id);
    setSnapshot(cachedSnapshot);
    setLastUpdated(cachedSnapshot ? new Date(cachedSnapshot.updatedAt) : null);
    setStatus(rateLimitResetRef.current && rateLimitResetRef.current > Date.now() ? 'limited' : 'loading');
    setRefreshState('idle');
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, nextProject.id);
      const url = new URL(window.location.href);
      url.searchParams.set('project', nextProject.id);
      window.history.replaceState({}, '', url);
    } catch {
      // Selection remains functional without storage or history access.
    }
  };

  const allReleases = useMemo(
    () => (snapshot?.releases ?? []).map((release) => ({ ...release, prerelease: isPrerelease(release) })),
    [snapshot],
  );
  const prereleaseVersions = useMemo(() => new Set([
    ...allReleases.filter((release) => release.prerelease).map((release) => release.version),
    ...(history?.snapshots ?? []).flatMap((historySnapshot) => {
      const projectSnapshot = historySnapshot.projects[project.id];
      if (!projectSnapshot) return [];
      const versions = Array.isArray(projectSnapshot.prereleases)
        ? projectSnapshot.prereleases.filter((version): version is string => typeof version === 'string')
        : [];
      return [...versions, ...Object.keys(projectSnapshot.releases ?? {}).filter(isPrereleaseTag)];
    }),
  ]), [allReleases, history, project.id]);
  const prereleaseCount = allReleases.filter((release) => release.prerelease).length;
  const stableCount = allReleases.length - prereleaseCount;
  const releases = useMemo(
    () => filterPrereleases(allReleases, includePrereleases),
    [allReleases, includePrereleases],
  );
  const trackedAssets = useMemo(() => projectAssets(project), [project]);
  const hasAssetBreakdown = project.assets !== undefined;
  const isIncludedVersion = (version: string) => includePrereleases || !prereleaseVersions.has(version);
  const historyReleaseTotal = (projectSnapshot: HistoryProjectSnapshot) => (
    Object.entries(projectSnapshot.releases).reduce((sum, [version, downloads]) => (
      sum + (isIncludedVersion(version) ? downloads : 0)
    ), 0)
  );
  const historyAssetTotals = (projectSnapshot: HistoryProjectSnapshot) => {
    if (!projectSnapshot.releaseAssets) return undefined;
    return Object.fromEntries(trackedAssets.map((asset) => [
      asset.id,
      Object.entries(projectSnapshot.releaseAssets ?? {}).reduce((sum, [version, assets]) => (
        sum + (isIncludedVersion(version) ? assets[asset.id] ?? 0 : 0)
      ), 0),
    ]));
  };
  const assetTotals = useMemo(() => Object.fromEntries(trackedAssets.map((asset) => [
    asset.id,
    releases.reduce((sum, release) => sum + (release.assets?.[asset.id]?.downloads ?? 0), 0),
  ])), [releases, trackedAssets]);
  const scopedReleases = useMemo(() => applyReleaseWindow(releases, releaseWindow), [releaseWindow, releases]);
  const scopedTotal = scopedReleases.reduce((sum, release) => sum + release.downloads, 0);
  const scopedAssetTotals = useMemo(() => Object.fromEntries(trackedAssets.map((asset) => [
    asset.id,
    scopedReleases.reduce((sum, release) => sum + (release.assets?.[asset.id]?.downloads ?? 0), 0),
  ])), [scopedReleases, trackedAssets]);
  const shareSegments = useMemo(() => buildShareSegments(scopedReleases), [scopedReleases]);
  const shareColors = shareSegments.map((segment, index) => segment.isOther ? SHARE_OTHER_COLOR : SHARE_COLORS[index % SHARE_COLORS.length]);
  const tableReleases = useMemo(() => sortReleases(scopedReleases, sort.key, sort.direction), [scopedReleases, sort]);
  const channelLabel = includePrereleases ? 'releases incl. pre-releases' : 'stable releases';
  const scopeLabel = releaseWindow === 'recent' && releases.length > RECENT_RELEASE_COUNT
    ? `Last ${RECENT_RELEASE_COUNT} ${channelLabel}`
    : `All ${releases.length} ${channelLabel}`;

  const summary = useMemo(() => {
    if (!releases.length) return null;
    const total = releases.reduce((sum, release) => sum + release.downloads, 0);
    const leader = [...releases].sort((a, b) => b.downloads - a.downloads)[0];
    const activeCount = Math.max(1, releases.filter((release) => release.downloads > 0).length);
    return {
      total,
      latest: releases[0],
      leader,
      leaderShare: total ? Math.round((leader.downloads / total) * 100) : 0,
      average: Math.round(total / activeCount),
    };
  }, [releases]);

  const metricGrowth = useMemo(() => {
    if (!summary) return null;
    const snapshotReleaseTotal = (projectSnapshot: HistoryProjectSnapshot, version: string) => {
      if (!hasAssetBreakdown) return projectSnapshot.releases[version] ?? 0;
      const releaseAssets = projectSnapshot.releaseAssets?.[version];
      if (!releaseAssets) return Number.NaN;
      return trackedAssets.reduce((sum, asset) => sum + (releaseAssets[asset.id] ?? 0), 0);
    };
    const activeReleaseAverage = (projectSnapshot: HistoryProjectSnapshot) => {
      if (!hasAssetBreakdown) {
        const downloadedReleases = Object.entries(projectSnapshot.releases)
          .filter(([version, downloads]) => isIncludedVersion(version) && downloads > 0);
        const total = downloadedReleases.reduce((sum, [, downloads]) => sum + downloads, 0);
        return downloadedReleases.length ? Math.round(total / downloadedReleases.length) : 0;
      }
      if (!projectSnapshot.releaseAssets) return Number.NaN;
      const downloadedReleases = Object.entries(projectSnapshot.releaseAssets)
        .filter(([version]) => isIncludedVersion(version))
        .map(([, releaseAssets]) => releaseAssets)
        .map((releaseAssets) => trackedAssets.reduce((sum, asset) => sum + (releaseAssets[asset.id] ?? 0), 0))
        .filter((downloads) => downloads > 0);
      const total = downloadedReleases.reduce((sum, downloads) => sum + downloads, 0);
      return downloadedReleases.length ? Math.round(total / downloadedReleases.length) : 0;
    };
    return {
      total: calculateMetricGrowth(history, project.id, historyReleaseTotal),
      latest: calculateMetricGrowth(history, project.id, (projectSnapshot) => snapshotReleaseTotal(projectSnapshot, summary.latest.version)),
      leader: calculateMetricGrowth(history, project.id, (projectSnapshot) => snapshotReleaseTotal(projectSnapshot, summary.leader.version)),
      average: calculateMetricGrowth(history, project.id, activeReleaseAverage),
      assets: Object.fromEntries(trackedAssets.map((asset) => [
        asset.id,
        calculateMetricGrowth(history, project.id, (projectSnapshot) => historyAssetTotals(projectSnapshot)?.[asset.id] ?? Number.NaN),
      ])),
    };
  }, [hasAssetBreakdown, history, includePrereleases, prereleaseVersions, project.id, summary, trackedAssets]);

  const growthSeries = useMemo(() => buildGrowthSeries(
    history,
    project.id,
    growthRange,
    (projectSnapshot) => {
      if (!hasAssetBreakdown) return historyReleaseTotal(projectSnapshot);
      const assets = historyAssetTotals(projectSnapshot);
      if (!assets) return Number.NaN;
      return trackedAssets.reduce((sum, asset) => sum + (assets[asset.id] ?? 0), 0);
    },
    hasAssetBreakdown
      ? historyAssetTotals
      : undefined,
  ), [growthRange, hasAssetBreakdown, history, includePrereleases, prereleaseVersions, project.id, trackedAssets]);
  const maxGrowth = Math.max(1, ...growthSeries.map((point) => Math.abs(point.value)));
  const latestGrowth = growthSeries.at(-1) ?? null;
  const previousGrowth = growthSeries.at(-2) ?? null;
  const growthComparison = latestGrowth && previousGrowth && previousGrowth.value > 0
    ? ((latestGrowth.value - previousGrowth.value) / previousGrowth.value) * 100
    : null;
  const growthAverage = growthSeries.length
    ? growthSeries.reduce((sum, point) => sum + point.value, 0) / growthSeries.length
    : null;
  const growthPeak = growthSeries.reduce<GrowthSeriesPoint | null>((peak, point) => (
    point.value > 0 && (!peak || point.value > peak.value) ? point : peak
  ), null);

  const chartReleases = useMemo(() => [...scopedReleases].reverse(), [scopedReleases]);
  const latestChartVersion = chartReleases.at(-1)?.version;

  const releaseComparison = useMemo(() => buildReleaseComparison(releases), [releases]);

  useLayoutEffect(() => {
    const chartArea = chartAreaRef.current;
    if (chartArea) chartArea.scrollLeft = chartArea.scrollWidth;
  }, [latestChartVersion, project.id, releaseWindow]);

  const chartValue = (release: ReleaseMetric) => chartMetric === 'rate' ? downloadsPerDay(release) : release.downloads;
  const maxDownloads = Math.max(
    chartMetric === 'rate' ? 0.1 : 1,
    chartMetric === 'total' ? releaseComparison?.previousBest.downloads ?? 0 : 0,
    ...chartReleases.map(chartValue),
  );
  const benchmarkLineTop = releaseComparison && chartMetric === 'total'
    ? 20 + (1 - (releaseComparison.previousBest.downloads / maxDownloads)) * 236
    : null;
  const latestDailyPace = metricGrowth?.latest.week
    ? metricGrowth.latest.week.absolute / 7
    : metricGrowth?.latest.day?.absolute ?? null;
  const recordEta = releaseComparison?.state === 'behind'
    ? daysToRecord(Math.abs(releaseComparison.difference), latestDailyPace)
    : null;
  const timeline = useMemo(() => projectTimeline(history, project.id), [history, project.id]);
  const projectMeta = meta?.projects[project.id];
  const stableReleases = useMemo(() => allReleases.filter((release) => !release.prerelease), [allReleases]);
  const prereleaseList = useMemo(() => allReleases.filter((release) => release.prerelease), [allReleases]);
  const mix = useMemo(() => versionMix(timeline, 14), [timeline]);
  const releaseInsights = useMemo(() => {
    const liveTime = snapshot ? Date.parse(snapshot.updatedAt) : Number.NaN;
    const inputs = new Map<string, ReleaseCurveInput>(allReleases.map((release) => {
      const points = releasePoints(timeline, release.version);
      const last = points.at(-1);
      // The live counter extends the daily history up to the latest refresh.
      if (Number.isFinite(liveTime) && (!last || liveTime > last.t)) points.push({ t: liveTime, v: Math.max(release.downloads, last?.v ?? 0) });
      return [release.version, { version: release.version, publishedAt: Date.parse(release.publishedAt), points }];
    }));
    const stableInputs = stableReleases.flatMap((release) => inputs.get(release.version) ?? []);
    const prereleaseInputs = prereleaseList.flatMap((release) => inputs.get(release.version) ?? []);
    return new Map(allReleases.map((release) => {
      const input = inputs.get(release.version) as ReleaseCurveInput;
      return [release.version, {
        input,
        curve: launchCurve(input.points, input.publishedAt),
        firstWeek: forecastFirstWeek(input, release.prerelease ? prereleaseInputs : stableInputs),
        majorityDays: daysToMajority(mix, release.version, input.publishedAt),
        milestones: milestoneHours(input.points, input.publishedAt, [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]),
        issues: issuesAfterRelease(projectMeta?.issues ?? [], release.publishedAt),
        hotfix: release.prerelease ? null : findHotfix(stableReleases, release.version),
        resets: countResets(timeline, release.version),
      }];
    }));
  }, [allReleases, mix, prereleaseList, projectMeta, snapshot, stableReleases, timeline]);

  const launchRows = scopedReleases.flatMap((release) => {
    const insight = releaseInsights.get(release.version);
    return insight ? [{
      version: release.version,
      url: release.url,
      prerelease: release.prerelease,
      isLatest: release.version === summary?.latest.version,
      curve: insight.curve,
      firstWeek: insight.firstWeek,
      majorityDays: insight.majorityDays,
    }] : [];
  });

  const activeUsers = activeUserEstimate(stableReleases.slice(0, 3).map((release): ActiveUserItem => {
    const curve = releaseInsights.get(release.version)?.curve;
    if (curve?.firstWeek != null) return { version: release.version, value: curve.firstWeek, kind: 'first-week' };
    return { version: release.version, value: release.downloads, kind: releaseAgeDays(release.publishedAt) < 7 ? 'so-far' : 'lifetime' };
  }));
  const latestStable = stableReleases[0];
  const latestMajority = latestStable ? releaseInsights.get(latestStable.version)?.majorityDays ?? null : null;
  const typicalMajority = median(stableReleases.flatMap((release) => {
    const days = releaseInsights.get(release.version)?.majorityDays;
    return days === null || days === undefined ? [] : [days];
  }));
  const olderShare = olderVersionShare(recentDownloadsByVersion(timeline, 7), stableReleases.map((release) => release.version));
  const cadence = releaseCadence(stableReleases);
  const lastHotfix = stableReleases.map((release) => ({ release, hotfix: releaseInsights.get(release.version)?.hotfix })).find((entry) => entry.hotfix);
  const betas = betaPool(prereleaseList);
  const totalPace = metricGrowth?.total.week ? metricGrowth.total.week.absolute / 7 : metricGrowth?.total.day?.absolute ?? null;
  const milestone = summary ? nextMilestone(summary.total, totalPace) : null;
  const assetTrend = hasAssetBreakdown ? assetShareTrend(timeline, trackedAssets[0].id) : null;
  const starSeries = useMemo(() => dailySeries(projectMeta?.stars?.history), [projectMeta]);
  const starsWeek = deltaSince(starSeries, 7);
  const starsMonth = deltaSince(starSeries, 30);
  const installs = latestInstalls(projectMeta);
  const recentIssues = (projectMeta?.issues ?? []).filter((issue) => Date.now() - Date.parse(issue.createdAt) <= 30 * INSIGHT_DAY_MS);
  const issuesPerRelease = median(stableReleases.slice(0, 5)
    .filter((release) => releaseAgeDays(release.publishedAt) >= 3)
    .map((release) => releaseInsights.get(release.version)?.issues.length ?? 0));
  const portfolioRows = PROJECTS.length > 1 ? PROJECTS.map((candidate) => {
    const candidateTimeline = projectTimeline(history, candidate.id);
    const latest = candidateTimeline.at(-1)?.project;
    const growth = calculateMetricGrowth(history, candidate.id, (projectSnapshot) => projectSnapshot.total);
    const firstRelease = Object.values(meta?.projects[candidate.id]?.releases ?? {}).map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const total = candidate.id === project.id && summary ? allReleases.reduce((sum, release) => sum + release.downloads, 0) : latest?.total ?? 0;
    return {
      id: candidate.id,
      name: candidate.name,
      total,
      week: growth.week?.absolute ?? null,
      perDay: firstRelease ? total / Math.max(1, (Date.now() - firstRelease) / INSIGHT_DAY_MS) : null,
      stars: meta?.projects[candidate.id]?.stars?.total ?? null,
      selected: candidate.id === project.id,
    };
  }).sort((a, b) => b.total - a.total) : [];

  const includedMix = mix.map((day) => {
    const byVersion = Object.fromEntries(Object.entries(day.byVersion).filter(([version]) => isIncludedVersion(version)));
    return { ...day, byVersion, total: Object.values(byVersion).reduce((sum, value) => sum + value, 0) };
  });
  const mixTotals = includedMix.reduce<Record<string, number>>((totals, day) => {
    Object.entries(day.byVersion).forEach(([version, value]) => { totals[version] = (totals[version] ?? 0) + value; });
    return totals;
  }, {});
  const mixLeaders = Object.entries(mixTotals)
    .filter(([version]) => !prereleaseVersions.has(version))
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([version]) => version);
  const mixCategories = [
    ...mixLeaders.map((version, index) => ({ id: version, label: version, color: SHARE_COLORS[index], striped: false })),
    { id: 'older', label: 'Older stable', color: SHARE_OTHER_COLOR, striped: false },
    ...(includePrereleases ? [{ id: 'pre', label: 'Pre-releases', color: '#7adccd', striped: true }] : []),
  ];
  const mixCategory = (version: string) => (prereleaseVersions.has(version) ? 'pre' : mixLeaders.includes(version) ? version : 'older');
  const maxMix = Math.max(1, ...includedMix.map((day) => day.total));
  const growthSpikes = detectSpikes(growthSeries.map((point) => point.value));
  const releasesBetween = (start: number, end: number) => releases.filter((release) => {
    const published = Date.parse(release.publishedAt);
    return published > start && published <= end;
  }).map((release) => release.version);

  const latestMomentum = summary && metricGrowth?.latest.week && metricGrowth.total.week && metricGrowth.total.week.absolute > 0
    ? Math.round((metricGrowth.latest.week.absolute / metricGrowth.total.week.absolute) * 100)
    : null;
  const benchmarkRecordPosition = releaseComparison?.state === 'ahead'
    ? (releaseComparison.previousBest.downloads / releaseComparison.latest.downloads) * 100
    : null;
  const isInitialLoad = !summary && status === 'loading';
  const emptyNote = isInitialLoad
    ? 'Loading live GitHub data…'
    : status === 'limited'
      ? 'GitHub rate limit reached; retry is automatic'
      : status === 'ready' && releases.length === 0 && allReleases.length > 0
        ? 'Only pre-releases so far. Switch the release channel to include them.'
        : status === 'ready' && releases.length === 0
        ? 'This repository has no release assets to count'
        : 'GitHub data is temporarily unavailable';
  const repositoryUrl = `https://github.com/${project.owner}/${project.repo}`;
  const stargazersUrl = `${repositoryUrl}/stargazers`;
  const stars = snapshot?.stars;
  const primaryAsset = trackedAssets[0];
  const secondaryAsset = trackedAssets[1];
  const scopedPrimaryDownloads = scopedAssetTotals[primaryAsset.id] ?? 0;
  const scopedSecondaryDownloads = secondaryAsset ? scopedAssetTotals[secondaryAsset.id] ?? 0 : 0;
  const primaryAssetShare = scopedTotal ? Math.round((scopedPrimaryDownloads / scopedTotal) * 100) : 0;

  const toggleSort = (key: SortKey) => setSort((current) => (
    current.key === key ? { key, direction: current.direction === 'desc' ? 'asc' : 'desc' } : { key, direction: 'desc' }
  ));
  const sortIcon = (key: SortKey) => sort.key !== key
    ? <ArrowUpDown size={11} aria-hidden="true" />
    : sort.direction === 'desc' ? <ArrowDown size={11} aria-hidden="true" /> : <ArrowUp size={11} aria-hidden="true" />;
  const ariaSort = (key: SortKey) => sort.key === key ? (sort.direction === 'desc' ? 'descending' : 'ascending') : 'none';

  const exportCsv = () => {
    const assetHeaders = hasAssetBreakdown ? trackedAssets.map((asset) => `${asset.label} downloads`) : [];
    const rows = [
      ['Version', 'Published', 'Pre-release', ...assetHeaders, 'Downloads', 'Downloads per day', 'URL'],
      ...tableReleases.map((release) => [
        release.version,
        release.publishedAt,
        release.prerelease,
        ...(hasAssetBreakdown ? trackedAssets.map((asset) => release.assets?.[asset.id]?.downloads ?? 0) : []),
        release.downloads,
        Number(downloadsPerDay(release).toFixed(2)),
        release.url,
      ]),
    ];
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${project.id}-${releaseWindow === 'recent' ? `last-${RECENT_RELEASE_COUNT}` : 'all'}-releases.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  };

  return (
    <main className="dashboard-shell" id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="HACS Downloads analytics home">
          <span className="brand-mark" aria-hidden="true">{project.mark}</span>
          <span>
            <strong>HACS Downloads</strong>
            <small>{project.name} analytics</small>
          </span>
        </a>
        <div className="header-actions">
          <ProjectSelector project={project} onSelect={selectProject} />
          <span className={`live-pill status-${status}`}>
            <i /> {status === 'limited' ? 'GitHub rate limit' : status === 'stale' ? (summary ? 'Recent snapshot' : 'Data unavailable') : status === 'loading' ? 'Connecting…' : 'Live from GitHub'}
          </span>
          <div className="github-group" aria-label={`${project.name} GitHub links`}>
            <a className="github-button github-repository" href={repositoryUrl} target="_blank" rel="noreferrer" aria-label={`Open ${project.name} GitHub repository`}>
              <GitBranch size={14} aria-hidden="true" /> <span className="github-label">Repository</span> <ExternalLink className="github-external" size={12} aria-hidden="true" />
            </a>
            <a
              className={`github-button github-stars${stars === undefined ? ' is-unavailable' : ''}`}
              href={stargazersUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={stars === undefined ? `${project.name} GitHub stars unavailable` : `${formatNumber(stars)} GitHub stars for ${project.name}`}
            >
              <Star size={14} aria-hidden="true" />
              <span aria-hidden="true">{stars === undefined ? '—' : formatGitHubStarCount(stars)}</span>
            </a>
          </div>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow"><Sparkles size={13} /> Project adoption dashboard</p>
          <h1>HACS downloads,<br />made visible.</h1>
          <p className="hero-copy">A clear, live view of release asset downloads across every tracked release of <strong>{project.name}</strong>.</p>
        </div>
        <div className="hero-actions">
          <div className="hero-refresh">
            <span>Last refreshed</span>
            <strong>{timeAgo(lastUpdated)}</strong>
            <button
              type="button"
              className={`refresh-button state-${refreshState}`}
              onClick={() => void refresh(true)}
              aria-label={`Refresh ${project.name} download data`}
              disabled={refreshState === 'refreshing' || status === 'limited'}
            >
              {refreshState === 'updated'
                ? <Check size={14} aria-hidden="true" />
                : <RefreshCw size={14} className={refreshState === 'refreshing' ? 'is-spinning' : ''} aria-hidden="true" />}
              <span aria-live="polite">
                {status === 'limited' && rateLimitReset
                  ? `Retry at ${formatTime(rateLimitReset)}`
                  : refreshState === 'refreshing'
                  ? 'Refreshing…'
                  : refreshState === 'updated'
                    ? 'Updated'
                    : refreshState === 'error'
                      ? 'Try again'
                      : 'Refresh data'}
              </span>
            </button>
          </div>
        </div>
      </section>

      <section className="scope-bar" aria-label="Release filters">
        <span className="scope-title"><SlidersHorizontal size={14} aria-hidden="true" /> Filters</span>
        <div
          className={`scope-group${(scopeFocus ?? scopeFlash) === 'channel' ? ' is-active' : ''}`}
          onBlur={() => setScopeFocus(null)}
          onFocus={(event) => previewScope('channel', event.target)}
          onPointerEnter={(event) => { if (event.pointerType === 'mouse') setScopeFocus('channel'); }}
          onPointerLeave={() => setScopeFocus(null)}
        >
          <span className="scope-label" id="channel-label"><FlaskConical size={12} aria-hidden="true" /> Release channel</span>
          <div className="segmented-control" role="radiogroup" aria-labelledby="channel-label">
            <button aria-checked={!includePrereleases} className={!includePrereleases ? 'active' : ''} onClick={() => setIncludePrereleases(false)} role="radio" type="button">
              Stable <em>{stableCount}</em>
            </button>
            <button aria-checked={includePrereleases} className={includePrereleases ? 'active' : ''} onClick={() => setIncludePrereleases(true)} role="radio" type="button">
              <span className="label-long">With pre-releases</span><span className="label-short">+ Pre</span> <em>{allReleases.length}</em>
            </button>
          </div>
          <small className="scope-hint">Applies to every section</small>
        </div>
        <div
          className={`scope-group${(scopeFocus ?? scopeFlash) === 'window' ? ' is-active' : ''}`}
          onBlur={() => setScopeFocus(null)}
          onFocus={(event) => previewScope('window', event.target)}
          onPointerEnter={(event) => { if (event.pointerType === 'mouse') setScopeFocus('window'); }}
          onPointerLeave={() => setScopeFocus(null)}
        >
          <span className="scope-label" id="window-label"><Layers3 size={12} aria-hidden="true" /> Compare</span>
          <div className="segmented-control" role="radiogroup" aria-labelledby="window-label">
            <button aria-checked={releaseWindow === 'recent'} className={releaseWindow === 'recent' ? 'active' : ''} onClick={() => setReleaseWindow('recent')} role="radio" type="button">
              Last {RECENT_RELEASE_COUNT}
            </button>
            <button aria-checked={releaseWindow === 'all'} className={releaseWindow === 'all' ? 'active' : ''} onClick={() => setReleaseWindow('all')} role="radio" type="button">
              All <em>{releases.length}</em>
            </button>
          </div>
          <small className="scope-hint">Applies to chart, share, launch curves and table</small>
        </div>
        <div className="scope-summary">
          <span aria-live="polite">{scopeLabel}</span>
          <button className={`scope-link state-${linkState}`} onClick={() => void copyShareLink()} type="button">
            {linkState === 'copied' ? <Check size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
            {linkState === 'copied' ? 'Link copied' : linkState === 'error' ? 'Copy failed' : 'Copy link'}
          </button>
        </div>
      </section>

      <section className={`stats-grid scope-area${scopeClass('channel')}`} aria-label={`${project.name} release download summary`}>
        {hasAssetBreakdown && secondaryAsset ? <>
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.total} label="Tracked downloads" value={summary ? formatNumber(summary.total) : '—'} icon={<Download size={18} />} note={summary ? <>Across {releases.length} tracked releases</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.assets[primaryAsset.id]} label={`${primaryAsset.label} downloads`} value={summary ? formatNumber(assetTotals[primaryAsset.id] ?? 0) : '—'} icon={<Package size={18} />} note={summary ? <>GitHub release asset requests</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.assets[secondaryAsset.id]} label={`${secondaryAsset.label} downloads`} value={summary ? formatNumber(assetTotals[secondaryAsset.id] ?? 0) : '—'} icon={<RefreshCw size={18} />} note={summary ? <>GitHub release asset requests</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.latest} label="Latest release" value={summary ? formatNumber(summary.latest.downloads) : '—'} icon={<Activity size={18} />} note={summary ? <><span className="version-chip">{summary.latest.version}</span> tracked downloads</> : emptyNote} />
        </> : <>
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.total} label="Release downloads" value={summary ? formatNumber(summary.total) : '—'} icon={<Download size={18} />} note={summary ? <>Across {releases.length} tracked releases</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.latest} label="Latest release" value={summary ? formatNumber(summary.latest.downloads) : '—'} icon={<Activity size={18} />} note={summary ? <><span className="version-chip">{summary.latest.version}</span> {formatRate(downloadsPerDay(summary.latest))}/day over {Math.round(releaseAgeDays(summary.latest.publishedAt))}d</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.leader} label="Most downloaded" value={summary ? formatNumber(summary.leader.downloads) : '—'} icon={<TrendingUp size={18} />} note={summary ? <><span className="version-chip">{summary.leader.version}</span> · {summary.leaderShare}% of total</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.average} label="Active-release avg." value={summary ? formatNumber(summary.average) : '—'} icon={<BarChart3 size={18} />} note={summary ? <>Average among downloaded versions</> : emptyNote} />
        </>}
      </section>

      <section className={`panel growth-panel scope-area${scopeClass('channel')}`} aria-labelledby="growth-title">
        <div className="card-heading growth-heading">
          <div>
            <p className="eyebrow">Growth</p>
            <h2 id="growth-title">Download velocity</h2>
            <ScopeChip label={includePrereleases ? 'Including pre-releases' : 'Stable releases'} />
            {velocityView === 'versions'
              ? <div className="asset-legend" aria-label="Version key">{mixCategories.map((category) => (
                  <span key={category.id}><i className={category.striped ? 'is-striped' : ''} style={category.striped ? undefined : { background: category.color }} />{category.label}</span>
                ))}</div>
              : hasAssetBreakdown && secondaryAsset && <AssetLegend assets={[primaryAsset, secondaryAsset]} />}
          </div>
          <div className="segmented-control" role="radiogroup" aria-label="Growth view">
            <button aria-checked={velocityView === 'daily'} className={velocityView === 'daily' ? 'active' : ''} onClick={() => setVelocityView('daily')} role="radio" type="button">Daily</button>
            <button aria-checked={velocityView === 'weekly'} className={velocityView === 'weekly' ? 'active' : ''} onClick={() => setVelocityView('weekly')} role="radio" type="button">Weekly</button>
            <button aria-checked={velocityView === 'versions'} className={velocityView === 'versions' ? 'active' : ''} onClick={() => setVelocityView('versions')} role="radio" type="button" title="Which versions people downloaded each day">By version</button>
          </div>
        </div>
        <div className="growth-layout">
          <div
            className="velocity-chart"
            role="img"
            aria-label={`${growthRange === 'daily' ? 'Daily' : 'Weekly'} new ${hasAssetBreakdown ? 'tracked downloads' : 'downloads'} for ${project.name}`}
          >
            {velocityView === 'versions'
              ? includedMix.length === 0
                ? <div className="growth-placeholder">
                    <CalendarDays size={18} aria-hidden="true" />
                    <strong>{historyStatus === 'loading' ? 'Loading growth history…' : 'Collecting daily history'}</strong>
                    <span>The version split appears after two daily snapshots.</span>
                  </div>
                : includedMix.map((day, index) => {
                  const segments = mixCategories.map((category) => ({
                    ...category,
                    value: Object.entries(day.byVersion).reduce((sum, [version, value]) => sum + (mixCategory(version) === category.id ? value : 0), 0),
                  }));
                  const released = releasesBetween(index > 0 ? includedMix[index - 1].t : day.t - INSIGHT_DAY_MS, day.t);
                  return (
                    <div className="velocity-column" key={day.t} title={`${day.label}: ${segments.filter((segment) => segment.value).map((segment) => `${segment.label} ${segment.value}`).join(', ') || 'no downloads'}${released.length ? `. Released ${released.join(', ')}` : ''}`}>
                      <span className="velocity-value">{released.length > 0 && <i className="release-dot" aria-label={`Released ${released.join(', ')}`} />}{day.total ? `+${formatNumber(day.total)}` : '0'}</span>
                      <span className="velocity-track">
                        <span className="velocity-stack" style={{ height: `${Math.max((day.total / maxMix) * 100, day.total ? 5 : 0)}%` }}>
                          {[...segments].reverse().filter((segment) => segment.value > 0).map((segment) => (
                            <i className={`bar-segment${segment.striped ? ' is-striped' : ''}`} key={segment.id} style={{ flexGrow: segment.value, ...(segment.striped ? {} : { background: segment.color }) }} />
                          ))}
                        </span>
                      </span>
                      <span className="velocity-label">{index % 2 === 0 || index === includedMix.length - 1 ? day.label : ''}</span>
                    </div>
                  );
                })
              : growthSeries.length === 0
              ? <div className="growth-placeholder">
                  <CalendarDays size={18} aria-hidden="true" />
                  <strong>{historyStatus === 'loading' ? 'Loading growth history…' : historyStatus === 'error' ? 'Growth history is unavailable' : `Collecting ${growthRange} history`}</strong>
                  <span>{historyStatus === 'error' ? 'Live totals remain available; growth will return when the history file can be loaded.' : growthRange === 'daily' ? 'The first daily increase appears after the next snapshot.' : 'Weekly increases appear after seven days of snapshots.'}</span>
                </div>
              : growthSeries.map((point, index) => {
                const primaryDownloads = point.assets?.[primaryAsset.id] ?? 0;
                const secondaryDownloads = secondaryAsset ? point.assets?.[secondaryAsset.id] ?? 0 : 0;
                const showAssetStack = hasAssetBreakdown && secondaryAsset && primaryDownloads >= 0 && secondaryDownloads >= 0;
                const pointTime = Date.parse(point.capturedAt);
                const released = releasesBetween(index > 0 ? Date.parse(growthSeries[index - 1].capturedAt) : pointTime - (growthRange === 'daily' ? 1 : 7) * INSIGHT_DAY_MS, pointTime);
                const isSpike = growthSpikes[index];
                return (
                <div
                  className={`velocity-column${growthPeak?.capturedAt === point.capturedAt ? ' is-peak' : ''}${isSpike ? ' is-spike' : ''}`}
                  key={point.capturedAt}
                  title={`${point.label}: ${formatSignedNumber(point.value)} downloads${isSpike ? ' (unusually high)' : ''}${released.length ? `. Released ${released.join(', ')}` : ''}`}
                  aria-label={`${point.label}: ${point.value} new ${hasAssetBreakdown ? `tracked downloads, ${primaryDownloads} ${primaryAsset.label}, ${secondaryDownloads} ${secondaryAsset?.label}` : 'downloads'}${isSpike ? ', unusually high' : ''}${released.length ? `, released ${released.join(', ')}` : ''}`}
                >
                  <span className="velocity-value">{released.length > 0 && <i className="release-dot" aria-hidden="true" />}{formatSignedNumber(point.value)}{isSpike && <b className="spike-flag">Spike</b>}</span>
                  <span className="velocity-track">
                    {showAssetStack
                      ? <span className="velocity-stack" style={{ height: `${Math.max((Math.abs(point.value) / maxGrowth) * 100, point.value ? 5 : 0)}%` }}>
                          {secondaryDownloads > 0 && <i className="bar-segment asset-secondary" style={{ flexGrow: secondaryDownloads }} />}
                          {primaryDownloads > 0 && <i className="bar-segment asset-primary" style={{ flexGrow: primaryDownloads }} />}
                        </span>
                      : <i className="velocity-fill" style={{ height: `${Math.max((Math.abs(point.value) / maxGrowth) * 100, point.value ? 5 : 0)}%` }} />}
                  </span>
                  <span className="velocity-label">{index % 2 === 0 || index === growthSeries.length - 1 ? point.label : ''}</span>
                </div>
                );
              })}
          </div>
          <aside className="growth-summary" aria-live="polite">
            <span>Latest {growthRange === 'daily' ? '24 hours' : '7 days'}</span>
            <strong>{latestGrowth ? formatSignedNumber(latestGrowth.value) : '—'}</strong>
            <small>new {hasAssetBreakdown ? 'tracked downloads' : 'downloads'}</small>
            {latestGrowth?.assets && hasAssetBreakdown && secondaryAsset && (
              <div className="growth-asset-totals">
                <span><i className="asset-primary" />{primaryAsset.label} {formatSignedNumber(latestGrowth.assets[primaryAsset.id] ?? 0)}</span>
                <span><i className="asset-secondary" />{secondaryAsset.label} {formatSignedNumber(latestGrowth.assets[secondaryAsset.id] ?? 0)}</span>
              </div>
            )}
            <div className={`growth-comparison${growthComparison !== null && growthComparison < 0 ? ' is-down' : ''}`}>
              {growthComparison === null ? 'Waiting for a prior period' : `${formatGrowthPercentage(growthComparison)} vs prior period`}
            </div>
            {growthAverage !== null && (
              <dl className="growth-stats">
                <div><dt>Average</dt><dd>{formatSignedNumber(Math.round(growthAverage))}<small>/{growthRange === 'daily' ? 'day' : 'week'}</small></dd></div>
                <div><dt>Peak</dt><dd>{growthPeak ? <>{formatSignedNumber(growthPeak.value)}<small>{growthPeak.label}</small></> : '—'}</dd></div>
              </dl>
            )}
            <p><i className="release-dot" aria-hidden="true" /> marks a day with a release. Hover a bar for details. History is captured daily at approximately 04:17 UTC.</p>
          </aside>
        </div>
      </section>

      <section className="analytics-grid">
        <article className={`panel chart-card scope-area${scopeClass('channel', 'window')}`} aria-labelledby="release-performance-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Release performance</p>
              <h2 id="release-performance-title">{chartMetric === 'total' ? 'Release downloads by version' : 'Downloads per day since release'}</h2>
              <ScopeChip label={scopeLabel} />
              {hasAssetBreakdown && secondaryAsset && <AssetLegend assets={[primaryAsset, secondaryAsset]} />}
            </div>
            <div className="segmented-control" role="radiogroup" aria-label="Chart metric">
              <button aria-checked={chartMetric === 'total'} className={chartMetric === 'total' ? 'active' : ''} onClick={() => setChartMetric('total')} role="radio" type="button">Total</button>
              <button aria-checked={chartMetric === 'rate'} className={chartMetric === 'rate' ? 'active' : ''} onClick={() => setChartMetric('rate')} role="radio" type="button" title="Downloads divided by days since release, for a fair comparison between old and new versions">Per day</button>
            </div>
          </div>
          {releaseComparison && (
            <div className="release-benchmark" aria-label={`Latest release comparison: ${releaseComparison.latest.version} has ${formatNumber(releaseComparison.latest.downloads)} downloads, compared with the previous record of ${formatNumber(releaseComparison.previousBest.downloads)} downloads held by ${releaseComparison.previousBest.version}`}>
              <div className="benchmark-summary">
                <strong>{releaseComparison.state === 'ahead'
                  ? 'New release record'
                  : releaseComparison.state === 'matched'
                    ? 'Previous record matched'
                    : `${releaseComparison.progressPercentage}% of previous record`}</strong>
                <span>{releaseComparison.latest.version} · {formatReleaseAge(releaseComparison.ageDays)}</span>
              </div>
              <div className="benchmark-progress">
                <div className="benchmark-track" aria-hidden="true">
                  <i style={{ width: `${Math.min(releaseComparison.progressPercentage, 100)}%` }} />
                  {benchmarkRecordPosition !== null && (
                    <span className="benchmark-record-marker" style={{ left: `${benchmarkRecordPosition}%` }} />
                  )}
                </div>
              </div>
              <span className="benchmark-result">{releaseComparison.state === 'ahead'
                ? `${formatSignedNumber(releaseComparison.difference)} vs ${releaseComparison.previousBest.version}`
                : releaseComparison.state === 'matched'
                  ? `Matched ${releaseComparison.previousBest.version}`
                  : `${formatNumber(Math.abs(releaseComparison.difference))} to match ${releaseComparison.previousBest.version}${recordEta ? ` · ≈${recordEta} ${recordEta === 1 ? 'day' : 'days'} at current pace` : ''}`}</span>
            </div>
          )}
          <div
            className="chart-area"
            ref={chartAreaRef}
            aria-label="Scrollable release download chart"
            role="region"
          >
            <div className="bar-chart" role="img" aria-label={`Bar chart showing ${project.name} release asset downloads by version`}>
              <span className="grid-line grid-line-100" aria-hidden="true" />
              <span className="grid-line grid-line-50" aria-hidden="true" />
              {releaseComparison && benchmarkLineTop !== null && (
                <span className="benchmark-guide" style={{ top: `${benchmarkLineTop}px` }} aria-hidden="true" />
              )}
              {!summary && <div className={`data-placeholder${isInitialLoad ? ' is-loading' : ''}`}>{emptyNote}</div>}
              {chartReleases.map((release) => {
                const isLatest = release.version === releaseComparison?.latest.version;
                const value = chartValue(release);
                const primaryDownloads = release.assets?.[primaryAsset.id]?.downloads ?? 0;
                const secondaryDownloads = secondaryAsset ? release.assets?.[secondaryAsset.id]?.downloads ?? 0 : 0;
                return (
                <a className={`bar-column${isLatest ? ' is-latest' : ''}${release.prerelease ? ' is-prerelease' : ''}`} href={release.url} target="_blank" rel="noreferrer" key={release.version} title={`${release.version}${release.prerelease ? ' (pre-release)' : ''}: ${formatNumber(release.downloads)} downloads, ${formatRate(downloadsPerDay(release))} per day`} aria-label={`${release.version}${release.prerelease ? ' pre-release' : ''}: ${release.downloads} downloads, ${formatRate(downloadsPerDay(release))} per day${hasAssetBreakdown && secondaryAsset ? `, ${primaryDownloads} ${primaryAsset.label}, ${secondaryDownloads} ${secondaryAsset.label}` : ''}${isLatest && releaseComparison ? `, ${formatReleaseAge(releaseComparison.ageDays).toLowerCase()}` : ''}`}>
                  <span className="bar-value">{value ? (chartMetric === 'rate' ? formatRate(value) : formatNumber(value)) : '–'}</span>
                  <div className="bar-track">
                    {hasAssetBreakdown && secondaryAsset
                      ? <span className="bar-stack" style={{ height: `${Math.max((value / maxDownloads) * 100, value ? 7 : 0)}%` }}>
                          {secondaryDownloads > 0 && <i className="bar-segment asset-secondary" style={{ flexGrow: secondaryDownloads }} />}
                          {primaryDownloads > 0 && <i className="bar-segment asset-primary" style={{ flexGrow: primaryDownloads }} />}
                        </span>
                      : <span className="bar-fill" style={{ height: `${Math.max((value / maxDownloads) * 100, value ? 7 : 0)}%` }} />}
                  </div>
                  <span className={`bar-label${isLatest ? ' is-latest' : ''}`}>{release.version}</span>
                </a>
                );
              })}
            </div>
          </div>
          <p className="chart-caption">
            {hasAssetBreakdown ? 'Stacked bars separate each tracked asset. ' : ''}
            {includePrereleases && <span className="prerelease-key"><i aria-hidden="true" /> Striped bars are pre-releases. </span>}
            {chartMetric === 'total' ? 'New releases may need time to catch up; switch to per day for a fair comparison. ' : 'Per day divides downloads by days since release (minimum one day). '}
            Select a bar to open it on GitHub.
          </p>
        </article>

        <aside className={`panel insight-card scope-area${scopeClass('channel', 'window')}`} aria-labelledby="distribution-title">
          <div className="card-heading compact">
            <div>
              <p className="eyebrow">Distribution</p>
              <h2 id="distribution-title">{hasAssetBreakdown ? 'Asset download share' : 'Release download share'}</h2>
              <ScopeChip label={scopeLabel} />
            </div>
            <Package size={18} aria-hidden="true" />
          </div>
          {summary && hasAssetBreakdown && secondaryAsset ? <>
            <div className="donut-wrap">
              <div className="donut" style={{ '--share': `${primaryAssetShare * 3.6}deg` } as CSSProperties}>
                <div><strong>{primaryAssetShare}%</strong><span>{primaryAsset.label.toLowerCase()}s</span></div>
              </div>
            </div>
            <div className="leader-row">
              <span><i /> {primaryAsset.label}s</span>
              <strong>{formatNumber(scopedPrimaryDownloads)}</strong>
            </div>
            <div className="leader-row secondary">
              <span><i /> {secondaryAsset.label}s</span>
              <strong>{formatNumber(scopedSecondaryDownloads)}</strong>
            </div>
            <div className="insight-note">
              <TrendingUp size={16} />
              <p><strong>{primaryAsset.label} downloads</strong> account for {primaryAssetShare}% of downloads in the {releaseWindow === 'recent' ? `last ${scopedReleases.length}` : 'tracked'} releases.</p>
            </div>
          </> : summary && shareSegments.length ? <>
            <div className="donut-wrap">
              <div className="donut" style={{ background: conicGradient(shareSegments, shareColors, SHARE_TRACK_COLOR) }}>
                <div><strong>{Math.round(shareSegments[0].share)}%</strong><span>{shareSegments[0].label}</span></div>
              </div>
            </div>
            <ul className="share-legend">
              {shareSegments.map((segment, index) => (
                <li key={segment.id} className={segment.id === summary.latest.version ? 'is-latest' : ''}>
                  <span><i style={{ background: shareColors[index] }} />{segment.label}{segment.id === summary.latest.version && <b className="latest-tag">Latest</b>}</span>
                  <strong>{formatNumber(segment.downloads)}</strong>
                  <small>{Math.round(segment.share)}%</small>
                </li>
              ))}
            </ul>
            <div className="insight-note">
              <TrendingUp size={16} />
              {latestMomentum !== null
                ? <p><strong>{latestMomentum}%</strong> of the past 7 days&rsquo; downloads went to <strong>{summary.latest.version}</strong>{latestMomentum >= 60 ? ', so users are moving to it quickly.' : latestMomentum >= 30 ? ', and adoption is building.' : ', so most users are still on older versions.'}</p>
                : <p><strong>{shareSegments[0].label}</strong> leads with {Math.round(shareSegments[0].share)}% of downloads in this view.</p>}
            </div>
          </> : <div className={`insight-placeholder${isInitialLoad ? ' is-loading' : ''}`}>{summary ? 'No downloads recorded in this view yet' : emptyNote}</div>}
        </aside>
      </section>

      <section className={`panel lifecycle-panel scope-area${scopeClass('channel', 'window')}`} aria-labelledby="lifecycle-title">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Release lifecycle</p>
            <h2 id="lifecycle-title">Launch curves</h2>
            <ScopeChip label={scopeLabel} />
          </div>
          <Clock3 size={18} aria-hidden="true" />
        </div>
        <p className="panel-intro">Downloads in each release&rsquo;s first days, reconstructed from daily snapshots. Darker cells mean more downloads; italic numbers are still counting.</p>
        <LaunchHeatmap rows={launchRows} />
      </section>

      <section className="insight-grid" aria-label="Lifecycle insights">
        <InsightTile icon={<Users size={16} />} label="Active installs (estimate)" value={activeUsers ? `≈${formatNumber(activeUsers.value)}${activeUsers.lowerBound ? '+' : ''}` : '—'}>
          {activeUsers
            ? <>Typical first-week downloads of the last {activeUsers.items.length} stable {activeUsers.items.length === 1 ? 'release' : 'releases'}. Most HACS users update within a week{activeUsers.lowerBound ? '; a release under 7 days old makes this a lower bound' : ''}.</>
            : 'Appears once a stable release has downloads.'}
        </InsightTile>
        <InsightTile icon={<Activity size={16} />} label="Upgrade speed" value={latestMajority !== null ? formatDays(latestMajority) : typicalMajority !== null ? formatDays(typicalMajority) : '—'}>
          {latestMajority !== null
            ? <>{latestStable?.version} took over half of daily downloads after {formatDays(latestMajority)}{typicalMajority !== null ? ` (typical: ${formatDays(typicalMajority)})` : ''}.</>
            : typicalMajority !== null
              ? <>Typical time for a release to take over half of daily downloads. {latestStable?.version} hasn&rsquo;t yet.</>
              : 'Needs daily snapshots around a release.'}
        </InsightTile>
        <InsightTile icon={<Layers3 size={16} />} label="On older versions" value={olderShare ? `${Math.round(olderShare.share)}%` : '—'}>
          {olderShare
            ? <>{formatNumber(olderShare.downloads)} of the last 7 days&rsquo; {formatNumber(olderShare.total)} downloads were for versions two or more releases behind, likely pinned installs.</>
            : 'Needs a week of snapshots.'}
        </InsightTile>
        <InsightTile icon={<CalendarDays size={16} />} label="Release cadence" value={cadence.medianGapDays !== null ? `Every ${formatDays(cadence.medianGapDays)}` : '—'}>
          {cadence.releasesLast30Days} stable {cadence.releasesLast30Days === 1 ? 'release' : 'releases'} in 30 days{cadence.daysSinceLast !== null ? `, last one ${formatDays(cadence.daysSinceLast)} ago` : ''}.{lastHotfix?.hotfix ? ` Latest hotfix: ${lastHotfix.release.version} → ${lastHotfix.hotfix.version}.` : ''}
        </InsightTile>
        <InsightTile icon={<FlaskConical size={16} />} label="Beta testers" value={betas ? `≈${formatNumber(betas.typical)}` : '—'}>
          {betas ? <>Typical downloads per pre-release across the last {betas.count} (max {formatNumber(betas.max)}).</> : 'No pre-releases published.'}
        </InsightTile>
        <InsightTile icon={<Target size={16} />} label="Next milestone" value={milestone ? formatNumber(milestone.target) : '—'}>
          {milestone
            ? milestone.days !== null
              ? <>{formatNumber(milestone.remaining)} to go; ≈{new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(Date.now() + milestone.days * INSIGHT_DAY_MS))} at {formatRate(totalPace ?? 0)}/day.</>
              : <>{formatNumber(milestone.remaining)} to go; a forecast needs recent growth history.</>
            : emptyNote}
        </InsightTile>
        {assetTrend && secondaryAsset && (
          <InsightTile icon={<Package size={16} />} label={`${primaryAsset.label} share`} value={assetTrend.current !== null ? `${Math.round(assetTrend.current)}%` : '—'}>
            Of new downloads in the last 7 days{assetTrend.previous !== null ? ` (${Math.round(assetTrend.previous)}% the week before)` : ''}. For firmware, factory images usually mean new devices and OTA means updates.
          </InsightTile>
        )}
      </section>

      <section className="analytics-grid community-grid">
        <article className="panel community-card" aria-labelledby="community-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Community</p>
              <h2 id="community-title">Stars over time</h2>
            </div>
            <Star size={18} aria-hidden="true" />
          </div>
          {starSeries.length >= 2
            ? <>
                <LineChart label={`Cumulative GitHub stars for ${project.name}`} height={130} series={[{ id: 'stars', points: starSeries, color: '#0b8e81' }]} />
                <div className="detail-axis"><span>{formatShortDate(new Date(starSeries[0].t).toISOString())}</span><span>Today</span></div>
              </>
            : <div className="insight-placeholder">Star history appears after the next daily capture.</div>}
          <dl className="community-stats">
            <div><dt>Stars</dt><dd>{stars === undefined ? '—' : formatNumber(stars)}</dd></div>
            <div><dt>Last 7 days</dt><dd>{starsWeek === null ? '—' : formatSignedNumber(starsWeek)}</dd></div>
            <div><dt>Last 30 days</dt><dd>{starsMonth === null ? '—' : formatSignedNumber(starsMonth)}</dd></div>
            <div><dt>Downloads per star</dt><dd>{stars && summary ? (summary.total / stars).toFixed(1) : '—'}</dd></div>
          </dl>
        </article>
        <aside className="panel community-card" aria-labelledby="quality-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Quality and reach</p>
              <h2 id="quality-title">After each release</h2>
            </div>
            <Bug size={18} aria-hidden="true" />
          </div>
          <dl className="community-stats is-stacked">
            <div><dt>Issues opened in the last 30 days</dt><dd>{projectMeta?.issues ? formatNumber(recentIssues.length) : '—'}</dd></div>
            <div><dt>Typical issues within 72 h of a release</dt><dd>{issuesPerRelease === null ? '—' : issuesPerRelease.toFixed(issuesPerRelease % 1 ? 1 : 0)}</dd></div>
            <div><dt>Hotfixed releases (next release within 48 h)</dt><dd>{stableReleases.filter((release) => releaseInsights.get(release.version)?.hotfix).length} of {stableReleases.length}</dd></div>
            <div><dt>Reactions on release notes</dt><dd>{formatNumber(allReleases.reduce((sum, release) => sum + (release.reactions?.total ?? 0), 0))}</dd></div>
            <div>
              <dt>Active installations (Home Assistant analytics)</dt>
              <dd>{installs
                ? <>{formatNumber(installs.total)}{installs.weekDelta !== null ? <small> {formatSignedNumber(installs.weekDelta)} this week</small> : null}</>
                : <small>Not reported yet</small>}</dd>
            </div>
          </dl>
          <p className="panel-intro">{installs
            ? <>Installs that opted in to Home Assistant analytics for <code>{projectMeta?.installs?.domain}</code>; the real number is higher. That&rsquo;s {summary ? (summary.total / Math.max(1, installs.total)).toFixed(1) : '—'} downloads per reported install.</>
            : <>Captured daily from Home Assistant&rsquo;s opt-in analytics when the integration&rsquo;s domain appears there. Set <code>haDomain</code> in <code>projects.json</code> if it differs from the zip name.</>}</p>
        </aside>
      </section>

      {portfolioRows.length > 1 && (
        <section className="panel portfolio-panel" aria-labelledby="portfolio-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Portfolio</p>
              <h2 id="portfolio-title">All tracked projects</h2>
            </div>
            <Layers3 size={18} aria-hidden="true" />
          </div>
          <PortfolioTable rows={portfolioRows} onSelect={selectProject} />
        </section>
      )}

      <section className={`panel releases-panel scope-area${scopeClass('channel', 'window')}`} aria-labelledby="release-table-title">
        <div className="card-heading table-heading">
          <div>
            <p className="eyebrow">Detailed breakdown</p>
            <h2 id="release-table-title">Tracked releases</h2>
            <ScopeChip label={scopeLabel} />
          </div>
          <div className="table-actions">
            <span className="asset-pill"><Package size={13} /> {displayAssetName(project)}</span>
            <button className="ghost-button" disabled={!tableReleases.length} onClick={exportCsv} type="button"><FileDown size={13} aria-hidden="true" /> Export CSV</button>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th aria-sort={ariaSort('published')}><button className="sort-button" onClick={() => toggleSort('published')} type="button">Published {sortIcon('published')}</button></th>
                {hasAssetBreakdown && secondaryAsset
                  ? <>
                      <th className="align-right">{primaryAsset.label}</th>
                      <th className="align-right">{secondaryAsset.label}</th>
                    </>
                  : <th>Asset size</th>}
                <th>Share</th>
                <th className="align-right" aria-sort={ariaSort('rate')}><button className="sort-button" onClick={() => toggleSort('rate')} type="button">Per day {sortIcon('rate')}</button></th>
                <th className="align-right" aria-sort={ariaSort('downloads')}><button className="sort-button" onClick={() => toggleSort('downloads')} type="button">Downloads {sortIcon('downloads')}</button></th>
                <th><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {!summary && <tr className="empty-row"><td colSpan={hasAssetBreakdown ? 8 : 7}>{emptyNote}</td></tr>}
              {tableReleases.map((release) => {
                const share = scopedTotal ? (release.downloads / scopedTotal) * 100 : 0;
                const insight = releaseInsights.get(release.version);
                const isExpanded = expandedVersion === release.version;
                return (
                  <Fragment key={release.version}>
                  <tr className={`${release.prerelease ? 'is-prerelease' : ''}${isExpanded ? ' is-expanded' : ''}`}>
                    <td>
                      <button
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Hide' : 'Show'} details for ${release.version}`}
                        className="expand-button"
                        onClick={() => setExpandedVersion(isExpanded ? null : release.version)}
                        type="button"
                      >
                        <ChevronRight size={13} aria-hidden="true" />
                        <span className="release-version">{release.version}</span>
                      </button>
                      {release.version === summary?.latest.version && <span className="latest-tag">Latest</span>}
                      {release.prerelease && <span className="prerelease-tag">Pre-release</span>}
                      {insight && insight.issues.length > 0 && <span className="mini-badge is-issue" title={`${insight.issues.length} issues opened within 72 hours`}><Bug size={10} aria-hidden="true" />{insight.issues.length}</span>}
                      {insight?.hotfix && <span className="mini-badge is-hotfix" title={`Followed by ${insight.hotfix.version} within 48 hours`}><Wrench size={10} aria-hidden="true" />Hotfixed</span>}
                      {release.reactions && <span className="mini-badge" title={`${release.reactions.total} reactions on the release notes`}><Heart size={10} aria-hidden="true" />{release.reactions.total}</span>}
                    </td>
                    <td><span className="date-cell" title={formatDate(release.publishedAt)}><CalendarDays size={14} /> {formatShortDate(release.publishedAt)}<small>{formatAge(release.publishedAt)}</small></span></td>
                    {hasAssetBreakdown && secondaryAsset
                      ? <>
                          <td className="align-right"><strong className="download-count">{formatNumber(release.assets?.[primaryAsset.id]?.downloads ?? 0)}</strong></td>
                          <td className="align-right"><strong className="download-count">{formatNumber(release.assets?.[secondaryAsset.id]?.downloads ?? 0)}</strong></td>
                        </>
                      : <td>{Math.round(release.size / 1024)} KB</td>}
                    <td><span className="share-cell"><i><b style={{ width: `${share}%` }} /></i>{Math.round(share)}%</span></td>
                    <td className="align-right"><span className="rate-cell">{formatRate(downloadsPerDay(release))}</span></td>
                    <td className="align-right"><strong className="download-count">{formatNumber(release.downloads)}</strong></td>
                    <td><a className="row-link" href={release.url} target="_blank" rel="noreferrer" aria-label={`Open ${release.version} release`}><ExternalLink size={14} /></a></td>
                  </tr>
                  {isExpanded && insight && (
                    <tr className="detail-row">
                      <td colSpan={hasAssetBreakdown ? 8 : 7}>
                        <ReleaseDetail
                          curve={insight.curve}
                          firstWeek={insight.firstWeek}
                          hotfix={insight.hotfix}
                          issues={insight.issues}
                          majorityDays={insight.majorityDays}
                          milestones={insight.milestones}
                          points={insight.input.points}
                          publishedAt={insight.input.publishedAt}
                          reactions={release.reactions}
                          resets={insight.resets}
                          version={release.version}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {releaseWindow === 'recent' && releases.length > RECENT_RELEASE_COUNT && (
          <div className="table-footer">
            <span>{releases.length - scopedReleases.length} older {channelLabel} hidden by the Compare filter</span>
            <button className="ghost-button" onClick={() => setReleaseWindow('all')} type="button">Show all {releases.length}</button>
          </div>
        )}
      </section>

      <section className="method-card">
        <Info size={18} aria-hidden="true" />
        <div><strong>What this measures</strong><p>GitHub counts requests for the tracked release {hasAssetBreakdown ? 'assets' : 'asset'}. These figures are downloads, not unique users or confirmed installations, and they exclude files served through other channels.</p></div>
        <a href="https://docs.github.com/en/rest/releases/assets#about-release-assets" target="_blank" rel="noreferrer">Methodology <ExternalLink size={12} /></a>
      </section>

      <footer>
        <span>HACS Downloads · {project.name}</span>
        <span>Data refreshes automatically every 5 minutes</span>
      </footer>
    </main>
  );
}
