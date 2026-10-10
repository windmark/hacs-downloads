export type MetaIssue = { number: number; title: string; createdAt: string; url: string };
export type InstallSnapshot = { total: number; versions?: Record<string, number> };

export type ProjectMeta = {
  releases?: Record<string, string>;
  stars?: { total: number; history: Record<string, number> };
  issues?: MetaIssue[];
  installs?: { domain: string; history: Record<string, InstallSnapshot> };
};

export type ProjectMetaFile = {
  schemaVersion: 1;
  updatedAt?: string;
  projects: Record<string, ProjectMeta>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNumberMap = (value: unknown): value is Record<string, number> => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number');

function readProject(value: unknown): ProjectMeta {
  if (!isRecord(value)) return {};
  const meta: ProjectMeta = {};
  if (isRecord(value.releases) && Object.values(value.releases).every((entry) => typeof entry === 'string')) {
    meta.releases = value.releases as Record<string, string>;
  }
  if (isRecord(value.stars) && typeof value.stars.total === 'number' && isNumberMap(value.stars.history)) {
    meta.stars = { total: value.stars.total, history: value.stars.history };
  }
  if (Array.isArray(value.issues)) {
    meta.issues = value.issues.filter((issue): issue is MetaIssue => (
      isRecord(issue)
      && typeof issue.number === 'number'
      && typeof issue.title === 'string'
      && typeof issue.createdAt === 'string'
      && typeof issue.url === 'string'
    ));
  }
  if (isRecord(value.installs) && typeof value.installs.domain === 'string' && isRecord(value.installs.history)) {
    const history = Object.fromEntries(Object.entries(value.installs.history).flatMap(([date, entry]) => (
      isRecord(entry) && typeof entry.total === 'number'
        ? [[date, { total: entry.total, ...(isNumberMap(entry.versions) ? { versions: entry.versions } : {}) }]]
        : []
    )));
    if (Object.keys(history).length) meta.installs = { domain: value.installs.domain, history };
  }
  return meta;
}

/** Validates the optional metadata file; unknown or malformed parts are dropped rather than failing the page. */
export function parseProjectMeta(value: unknown): ProjectMetaFile | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.projects)) return null;
  return {
    schemaVersion: 1,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    projects: Object.fromEntries(Object.entries(value.projects).map(([id, project]) => [id, readProject(project)])),
  };
}

export function latestInstalls(meta: ProjectMeta | undefined) {
  const entries = Object.entries(meta?.installs?.history ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const latest = entries.at(-1);
  if (!latest) return null;
  const weekAgo = entries.filter(([date]) => Date.parse(latest[0]) - Date.parse(date) >= 6 * 86_400_000).at(-1);
  return {
    date: latest[0],
    total: latest[1].total,
    versions: latest[1].versions,
    weekDelta: weekAgo ? latest[1].total - weekAgo[1].total : null,
    series: entries.map(([date, entry]) => ({ t: Date.parse(date), v: entry.total })),
  };
}
