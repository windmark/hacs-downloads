'use client';

import {
  Activity,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  GitBranch,
  Info,
  Layers3,
  Package,
  RefreshCw,
  Sparkles,
  Star,
  TrendingUp,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import projectConfigs from './projects.json';
import { formatGitHubStarCount, parseGitHubStarCount } from './github';
import { buildReleaseComparison, formatReleaseAge } from './releaseComparison';

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
  assets?: Record<string, {
    downloads: number;
    size: number;
  }>;
};

type GitHubRelease = {
  tag_name: string;
  published_at: string | null;
  html_url: string;
  draft: boolean;
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
  return `hacs-downloads-snapshot-${projectId}-v2`;
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
  const [range, setRange] = useState<'all' | 'recent'>('recent');
  const [growthRange, setGrowthRange] = useState<'daily' | 'weekly'>('daily');
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
          ...(project.assets ? { assets } : {}),
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

  const selectProject = (nextProjectId: string) => {
    const nextProject = getProject(nextProjectId);
    const cachedSnapshot = readCachedSnapshot(nextProject.id);
    requestSequence.current += 1;
    setProjectId(nextProject.id);
    setSnapshot(cachedSnapshot);
    setLastUpdated(cachedSnapshot ? new Date(cachedSnapshot.updatedAt) : null);
    setStatus(rateLimitResetRef.current && rateLimitResetRef.current > Date.now() ? 'limited' : 'loading');
    setRefreshState('idle');
    setRange('recent');
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, nextProject.id);
      const url = new URL(window.location.href);
      url.searchParams.set('project', nextProject.id);
      window.history.replaceState({}, '', url);
    } catch {
      // Selection remains functional without storage or history access.
    }
  };

  const releases = snapshot?.releases ?? [];
  const trackedAssets = useMemo(() => projectAssets(project), [project]);
  const hasAssetBreakdown = project.assets !== undefined;
  const assetTotals = useMemo(() => Object.fromEntries(trackedAssets.map((asset) => [
    asset.id,
    releases.reduce((sum, release) => sum + (release.assets?.[asset.id]?.downloads ?? 0), 0),
  ])), [releases, trackedAssets]);

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
    const snapshotTotal = (projectSnapshot: HistoryProjectSnapshot) => {
      if (!hasAssetBreakdown) return projectSnapshot.total;
      if (!projectSnapshot.assets) return Number.NaN;
      return trackedAssets.reduce((sum, asset) => sum + (projectSnapshot.assets?.[asset.id] ?? 0), 0);
    };
    const snapshotReleaseTotal = (projectSnapshot: HistoryProjectSnapshot, version: string) => {
      if (!hasAssetBreakdown) return projectSnapshot.releases[version] ?? 0;
      const releaseAssets = projectSnapshot.releaseAssets?.[version];
      if (!releaseAssets) return Number.NaN;
      return trackedAssets.reduce((sum, asset) => sum + (releaseAssets[asset.id] ?? 0), 0);
    };
    const activeReleaseAverage = (projectSnapshot: HistoryProjectSnapshot) => {
      if (!hasAssetBreakdown) {
        const downloadedReleases = Object.values(projectSnapshot.releases).filter((downloads) => downloads > 0);
        return downloadedReleases.length ? Math.round(projectSnapshot.total / downloadedReleases.length) : 0;
      }
      if (!projectSnapshot.releaseAssets) return Number.NaN;
      const downloadedReleases = Object.values(projectSnapshot.releaseAssets)
        .map((releaseAssets) => trackedAssets.reduce((sum, asset) => sum + (releaseAssets[asset.id] ?? 0), 0))
        .filter((downloads) => downloads > 0);
      const total = downloadedReleases.reduce((sum, downloads) => sum + downloads, 0);
      return downloadedReleases.length ? Math.round(total / downloadedReleases.length) : 0;
    };
    return {
      total: calculateMetricGrowth(history, project.id, snapshotTotal),
      latest: calculateMetricGrowth(history, project.id, (projectSnapshot) => snapshotReleaseTotal(projectSnapshot, summary.latest.version)),
      leader: calculateMetricGrowth(history, project.id, (projectSnapshot) => snapshotReleaseTotal(projectSnapshot, summary.leader.version)),
      average: calculateMetricGrowth(history, project.id, activeReleaseAverage),
      assets: Object.fromEntries(trackedAssets.map((asset) => [
        asset.id,
        calculateMetricGrowth(history, project.id, (projectSnapshot) => projectSnapshot.assets?.[asset.id] ?? Number.NaN),
      ])),
    };
  }, [hasAssetBreakdown, history, project.id, summary, trackedAssets]);

  const growthSeries = useMemo(() => buildGrowthSeries(
    history,
    project.id,
    growthRange,
    (projectSnapshot) => {
      if (!hasAssetBreakdown) return projectSnapshot.total;
      if (!projectSnapshot.assets) return Number.NaN;
      return trackedAssets.reduce((sum, asset) => sum + (projectSnapshot.assets?.[asset.id] ?? 0), 0);
    },
    hasAssetBreakdown
      ? (projectSnapshot) => projectSnapshot.assets
        ? Object.fromEntries(trackedAssets.map((asset) => [asset.id, projectSnapshot.assets?.[asset.id] ?? 0]))
        : undefined
      : undefined,
  ), [growthRange, hasAssetBreakdown, history, project.id, trackedAssets]);
  const maxGrowth = Math.max(1, ...growthSeries.map((point) => Math.abs(point.value)));
  const latestGrowth = growthSeries.at(-1) ?? null;
  const previousGrowth = growthSeries.at(-2) ?? null;
  const growthComparison = latestGrowth && previousGrowth && previousGrowth.value > 0
    ? ((latestGrowth.value - previousGrowth.value) / previousGrowth.value) * 100
    : null;

  const chartReleases = useMemo(() => {
    const selected = range === 'recent' ? releases.slice(0, 5) : releases;
    return [...selected].reverse();
  }, [range, releases]);
  const latestChartVersion = chartReleases.at(-1)?.version;

  const releaseComparison = useMemo(() => buildReleaseComparison(releases), [releases]);

  useLayoutEffect(() => {
    const chartArea = chartAreaRef.current;
    if (chartArea) chartArea.scrollLeft = chartArea.scrollWidth;
  }, [latestChartVersion, project.id, range]);

  const maxDownloads = Math.max(
    1,
    releaseComparison?.previousBest.downloads ?? 0,
    ...chartReleases.map((release) => release.downloads),
  );
  const benchmarkLineTop = releaseComparison
    ? 20 + (1 - (releaseComparison.previousBest.downloads / maxDownloads)) * 236
    : null;
  const benchmarkRecordPosition = releaseComparison?.state === 'ahead'
    ? (releaseComparison.previousBest.downloads / releaseComparison.latest.downloads) * 100
    : null;
  const isInitialLoad = !summary && status === 'loading';
  const emptyNote = isInitialLoad
    ? 'Loading live GitHub data…'
    : status === 'limited'
      ? 'GitHub rate limit reached; retry is automatic'
      : status === 'ready' && releases.length === 0
        ? 'This repository has no release assets to count'
        : 'GitHub data is temporarily unavailable';
  const repositoryUrl = `https://github.com/${project.owner}/${project.repo}`;
  const stargazersUrl = `${repositoryUrl}/stargazers`;
  const stars = snapshot?.stars;
  const primaryAsset = trackedAssets[0];
  const secondaryAsset = trackedAssets[1];
  const primaryAssetDownloads = assetTotals[primaryAsset.id] ?? 0;
  const secondaryAssetDownloads = secondaryAsset ? assetTotals[secondaryAsset.id] ?? 0 : 0;
  const primaryAssetShare = summary?.total ? Math.round((primaryAssetDownloads / summary.total) * 100) : 0;

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
      </section>

      <section className="stats-grid" aria-label={`${project.name} release download summary`}>
        {hasAssetBreakdown && secondaryAsset ? <>
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.total} label="Tracked downloads" value={summary ? formatNumber(summary.total) : '—'} icon={<Download size={18} />} note={summary ? <>Across {releases.length} tracked releases</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.assets[primaryAsset.id]} label={`${primaryAsset.label} downloads`} value={summary ? formatNumber(assetTotals[primaryAsset.id] ?? 0) : '—'} icon={<Package size={18} />} note={summary ? <>GitHub release asset requests</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.assets[secondaryAsset.id]} label={`${secondaryAsset.label} downloads`} value={summary ? formatNumber(assetTotals[secondaryAsset.id] ?? 0) : '—'} icon={<RefreshCw size={18} />} note={summary ? <>GitHub release asset requests</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.latest} label="Latest release" value={summary ? formatNumber(summary.latest.downloads) : '—'} icon={<Activity size={18} />} note={summary ? <><span className="version-chip">{summary.latest.version}</span> tracked downloads</> : emptyNote} />
        </> : <>
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.total} label="Release downloads" value={summary ? formatNumber(summary.total) : '—'} icon={<Download size={18} />} note={summary ? <>Across {releases.length} tracked releases</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.latest} label="Latest release" value={summary ? formatNumber(summary.latest.downloads) : '—'} icon={<Activity size={18} />} note={summary ? <><span className="version-chip">{summary.latest.version}</span> asset downloads</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.leader} label="Most downloaded" value={summary ? formatNumber(summary.leader.downloads) : '—'} icon={<TrendingUp size={18} />} note={summary ? <><span className="version-chip">{summary.leader.version}</span> · {summary.leaderShare}% of total</> : emptyNote} />
          <StatCard loading={isInitialLoad} historyStatus={historyStatus} growth={metricGrowth?.average} label="Active-release avg." value={summary ? formatNumber(summary.average) : '—'} icon={<BarChart3 size={18} />} note={summary ? <>Average among downloaded versions</> : emptyNote} />
        </>}
      </section>

      <section className="panel growth-panel" aria-labelledby="growth-title">
        <div className="card-heading growth-heading">
          <div>
            <p className="eyebrow">Growth</p>
            <h2 id="growth-title">Download velocity</h2>
            {hasAssetBreakdown && secondaryAsset && <AssetLegend assets={[primaryAsset, secondaryAsset]} />}
          </div>
          <div className="segmented-control" aria-label="Growth interval">
            <button className={growthRange === 'daily' ? 'active' : ''} onClick={() => setGrowthRange('daily')} type="button">Daily</button>
            <button className={growthRange === 'weekly' ? 'active' : ''} onClick={() => setGrowthRange('weekly')} type="button">Weekly</button>
          </div>
        </div>
        <div className="growth-layout">
          <div
            className="velocity-chart"
            role="img"
            aria-label={`${growthRange === 'daily' ? 'Daily' : 'Weekly'} new ${hasAssetBreakdown ? 'tracked downloads' : 'downloads'} for ${project.name}`}
          >
            {growthSeries.length === 0
              ? <div className="growth-placeholder">
                  <CalendarDays size={18} aria-hidden="true" />
                  <strong>{historyStatus === 'loading' ? 'Loading growth history…' : historyStatus === 'error' ? 'Growth history is unavailable' : `Collecting ${growthRange} history`}</strong>
                  <span>{historyStatus === 'error' ? 'Live totals remain available; growth will return when the history file can be loaded.' : growthRange === 'daily' ? 'The first daily increase appears after the next snapshot.' : 'Weekly increases appear after seven days of snapshots.'}</span>
                </div>
              : growthSeries.map((point, index) => {
                const primaryDownloads = point.assets?.[primaryAsset.id] ?? 0;
                const secondaryDownloads = secondaryAsset ? point.assets?.[secondaryAsset.id] ?? 0 : 0;
                const showAssetStack = hasAssetBreakdown && secondaryAsset && primaryDownloads >= 0 && secondaryDownloads >= 0;
                return (
                <div className="velocity-column" key={point.capturedAt} aria-label={`${point.label}: ${point.value} new ${hasAssetBreakdown ? `tracked downloads, ${primaryDownloads} ${primaryAsset.label}, ${secondaryDownloads} ${secondaryAsset?.label}` : 'downloads'}`}>
                  <span className="velocity-value">{formatSignedNumber(point.value)}</span>
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
            <p>History is captured daily at approximately 04:17 UTC.</p>
          </aside>
        </div>
      </section>

      <section className="analytics-grid">
        <article className="panel chart-card" aria-labelledby="release-performance-title">
          <div className="card-heading">
            <div>
              <p className="eyebrow">Release performance</p>
              <h2 id="release-performance-title">Release downloads by version</h2>
              {hasAssetBreakdown && secondaryAsset && <AssetLegend assets={[primaryAsset, secondaryAsset]} />}
            </div>
            <div className="segmented-control" aria-label="Chart range">
              <button className={range === 'recent' ? 'active' : ''} onClick={() => setRange('recent')} type="button">Recent 5</button>
              <button className={range === 'all' ? 'active' : ''} onClick={() => setRange('all')} type="button">All</button>
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
                  : `${formatNumber(Math.abs(releaseComparison.difference))} to match ${releaseComparison.previousBest.version}`}</span>
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
                const primaryDownloads = release.assets?.[primaryAsset.id]?.downloads ?? 0;
                const secondaryDownloads = secondaryAsset ? release.assets?.[secondaryAsset.id]?.downloads ?? 0 : 0;
                return (
                <a className={`bar-column${isLatest ? ' is-latest' : ''}`} href={release.url} target="_blank" rel="noreferrer" key={release.version} aria-label={`${release.version}: ${release.downloads} downloads${hasAssetBreakdown && secondaryAsset ? `, ${primaryDownloads} ${primaryAsset.label}, ${secondaryDownloads} ${secondaryAsset.label}` : ''}${isLatest && releaseComparison ? `, ${formatReleaseAge(releaseComparison.ageDays).toLowerCase()}` : ''}`}>
                  <span className="bar-value">{release.downloads || '–'}</span>
                  <div className="bar-track">
                    {hasAssetBreakdown && secondaryAsset
                      ? <span className="bar-stack" style={{ height: `${Math.max((release.downloads / maxDownloads) * 100, release.downloads ? 7 : 0)}%` }}>
                          {secondaryDownloads > 0 && <i className="bar-segment asset-secondary" style={{ flexGrow: secondaryDownloads }} />}
                          {primaryDownloads > 0 && <i className="bar-segment asset-primary" style={{ flexGrow: primaryDownloads }} />}
                        </span>
                      : <span className="bar-fill" style={{ height: `${Math.max((release.downloads / maxDownloads) * 100, release.downloads ? 7 : 0)}%` }} />}
                  </div>
                  <span className={`bar-label${isLatest ? ' is-latest' : ''}`}>{release.version}</span>
                </a>
                );
              })}
            </div>
          </div>
          <p className="chart-caption">{hasAssetBreakdown ? 'Stacked bars separate each tracked asset. ' : ''}New releases may need time to catch up. Select a bar to open it on GitHub.</p>
        </article>

        <aside className="panel insight-card" aria-labelledby="distribution-title">
          <div className="card-heading compact">
            <div>
              <p className="eyebrow">Distribution</p>
              <h2 id="distribution-title">{hasAssetBreakdown ? 'Asset download share' : 'Release download share'}</h2>
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
              <strong>{formatNumber(primaryAssetDownloads)}</strong>
            </div>
            <div className="leader-row secondary">
              <span><i /> {secondaryAsset.label}s</span>
              <strong>{formatNumber(secondaryAssetDownloads)}</strong>
            </div>
            <div className="insight-note">
              <TrendingUp size={16} />
              <p><strong>{primaryAsset.label} downloads</strong> account for {primaryAssetShare}% of tracked download activity.</p>
            </div>
          </> : summary ? <>
            <div className="donut-wrap">
              <div className="donut" style={{ '--share': `${summary.leaderShare * 3.6}deg` } as CSSProperties}>
                <div><strong>{summary.leaderShare}%</strong><span>top version</span></div>
              </div>
            </div>
            <div className="leader-row">
              <span><i /> {summary.leader.version}</span>
              <strong>{formatNumber(summary.leader.downloads)}</strong>
            </div>
            <div className="leader-row secondary">
              <span><i /> Other releases</span>
              <strong>{formatNumber(summary.total - summary.leader.downloads)}</strong>
            </div>
            <div className="insight-note">
              <TrendingUp size={16} />
              <p><strong>{summary.leader.version}</strong> currently drives most tracked download activity.</p>
            </div>
          </> : <div className={`insight-placeholder${isInitialLoad ? ' is-loading' : ''}`}>{emptyNote}</div>}
        </aside>
      </section>

      <section className="panel releases-panel" aria-labelledby="release-table-title">
        <div className="card-heading table-heading">
          <div>
            <p className="eyebrow">Detailed breakdown</p>
            <h2 id="release-table-title">Tracked releases</h2>
          </div>
          <span className="asset-pill"><Package size={13} /> {displayAssetName(project)}</span>
        </div>
        <div className="table-scroll">
          <table>
            {hasAssetBreakdown && secondaryAsset ? <>
              <thead>
                <tr><th>Version</th><th>Published</th><th className="align-right">{primaryAsset.label} downloads</th><th className="align-right">{secondaryAsset.label} downloads</th><th>Share</th><th className="align-right">Release downloads</th><th><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {!summary && <tr className="empty-row"><td colSpan={7}>{emptyNote}</td></tr>}
                {releases.map((release, index) => {
                  const share = summary?.total ? Math.round((release.downloads / summary.total) * 100) : 0;
                  return (
                    <tr key={release.version}>
                      <td><span className="release-version">{release.version}</span>{index === 0 && <span className="latest-tag">Latest</span>}</td>
                      <td><span className="date-cell"><CalendarDays size={14} /> {formatDate(release.publishedAt)}</span></td>
                      <td className="align-right"><strong className="download-count">{formatNumber(release.assets?.[primaryAsset.id]?.downloads ?? 0)}</strong></td>
                      <td className="align-right"><strong className="download-count">{formatNumber(release.assets?.[secondaryAsset.id]?.downloads ?? 0)}</strong></td>
                      <td><span className="share-cell"><i><b style={{ width: `${share}%` }} /></i>{share}%</span></td>
                      <td className="align-right"><strong className="download-count">{formatNumber(release.downloads)}</strong></td>
                      <td><a className="row-link" href={release.url} target="_blank" rel="noreferrer" aria-label={`Open ${release.version} release`}><ExternalLink size={14} /></a></td>
                    </tr>
                  );
                })}
              </tbody>
            </> : <>
              <thead>
                <tr><th>Version</th><th>Published</th><th>Asset size</th><th>Share</th><th className="align-right">Release downloads</th><th><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {!summary && <tr className="empty-row"><td colSpan={6}>{emptyNote}</td></tr>}
                {releases.map((release, index) => {
                  const share = summary?.total ? Math.round((release.downloads / summary.total) * 100) : 0;
                  return (
                    <tr key={release.version}>
                      <td><span className="release-version">{release.version}</span>{index === 0 && <span className="latest-tag">Latest</span>}</td>
                      <td><span className="date-cell"><CalendarDays size={14} /> {formatDate(release.publishedAt)}</span></td>
                      <td>{Math.round(release.size / 1024)} KB</td>
                      <td><span className="share-cell"><i><b style={{ width: `${share}%` }} /></i>{share}%</span></td>
                      <td className="align-right"><strong className="download-count">{formatNumber(release.downloads)}</strong></td>
                      <td><a className="row-link" href={release.url} target="_blank" rel="noreferrer" aria-label={`Open ${release.version} release`}><ExternalLink size={14} /></a></td>
                    </tr>
                  );
                })}
              </tbody>
            </>}
          </table>
        </div>
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
