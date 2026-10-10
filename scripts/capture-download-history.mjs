import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsPath = path.join(projectRoot, 'src', 'projects.json');
const historyPath = path.join(projectRoot, 'public', 'download-history.json');
const metaPath = path.join(projectRoot, 'public', 'project-meta.json');
const haAnalyticsUrl = 'https://analytics.home-assistant.io/custom_integrations.json';
const maxStarPages = 50;
const maxIssuePages = 10;
const githubApiVersion = '2022-11-28';
const retentionDays = 400;

function resolveAssetName(asset, tag) {
  if (asset.assetName) return asset.assetName;
  const version = tag.replace(/^v/i, '');
  return asset.assetNameTemplate
    .replaceAll('{tag}', tag)
    .replaceAll('{version}', version);
}

function projectAssets(project) {
  if (project.assets) return project.assets;
  return [{
    id: 'release',
    label: 'Release asset',
    ...(project.assetName ? { assetName: project.assetName } : { assetNameTemplate: project.assetNameTemplate }),
  }];
}

function githubHeaders(accept = 'application/vnd.github+json') {
  const headers = {
    Accept: accept,
    'User-Agent': 'hacs-downloads-history',
    'X-GitHub-Api-Version': githubApiVersion,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getJson(url, accept) {
  const response = await fetch(url, { headers: githubHeaders(accept) });
  if (!response.ok) throw new Error(`${url}: GitHub returned ${response.status}`);
  return response.json();
}

async function fetchProject(project) {
  const headers = githubHeaders();

  const response = await fetch(`https://api.github.com/repos/${project.owner}/${project.repo}/releases?per_page=100`, { headers });
  if (!response.ok) throw new Error(`${project.owner}/${project.repo}: GitHub returned ${response.status}`);

  const payload = await response.json();
  const trackedAssets = projectAssets(project);
  const releaseEntries = payload.flatMap((release) => {
    if (release.draft || !release.published_at) return [];
    const assets = Object.fromEntries(trackedAssets.flatMap((trackedAsset) => {
      const expectedAssetName = resolveAssetName(trackedAsset, release.tag_name);
      const asset = release.assets.find((candidate) => candidate.name === expectedAssetName);
      return asset ? [[trackedAsset.id, asset.download_count]] : [];
    }));
    if (Object.keys(assets).length === 0) return [];
    return [[release.tag_name, {
      assets,
      total: Object.values(assets).reduce((sum, downloads) => sum + downloads, 0),
      prerelease: release.prerelease === true,
    }]];
  });
  publishedDates.set(project.id, Object.fromEntries(payload.flatMap((release) => (
    !release.draft && release.published_at ? [[release.tag_name, release.published_at]] : []
  ))));
  const releases = Object.fromEntries(releaseEntries.map(([tag, release]) => [tag, release.total]));
  const prereleases = releaseEntries.flatMap(([tag, release]) => release.prerelease ? [tag] : []);
  const total = Object.values(releases).reduce((sum, downloads) => sum + downloads, 0);

  if (!project.assets) return { total, releases, prereleases };

  return {
    total,
    releases,
    prereleases,
    assets: Object.fromEntries(trackedAssets.map((asset) => [
      asset.id,
      releaseEntries.reduce((sum, [, release]) => sum + (release.assets[asset.id] ?? 0), 0),
    ])),
    releaseAssets: Object.fromEntries(releaseEntries.map(([tag, release]) => [tag, release.assets])),
  };
}

const publishedDates = new Map();

/** Daily cumulative star counts, backfilled from starred_at timestamps for repositories up to 5,000 stars. */
async function fetchStars(project, previous) {
  const repository = await getJson(`https://api.github.com/repos/${project.owner}/${project.repo}`);
  const total = repository.stargazers_count;
  const today = new Date().toISOString().slice(0, 10);
  if (total > maxStarPages * 100) {
    return { total, history: { ...(previous?.history ?? {}), [today]: total } };
  }
  const starredAt = [];
  for (let page = 1; page <= maxStarPages; page += 1) {
    const batch = await getJson(
      `https://api.github.com/repos/${project.owner}/${project.repo}/stargazers?per_page=100&page=${page}`,
      'application/vnd.github.star+json',
    );
    starredAt.push(...batch.map((entry) => entry.starred_at).filter(Boolean));
    if (batch.length < 100) break;
  }
  starredAt.sort();
  const history = {};
  starredAt.forEach((timestamp, index) => { history[timestamp.slice(0, 10)] = index + 1; });
  history[today] = total;
  return { total, history };
}

/** Issues (not pull requests) opened in the retention window, used to spot regressions after releases. */
async function fetchIssues(project) {
  const since = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const issues = [];
  for (let page = 1; page <= maxIssuePages; page += 1) {
    const batch = await getJson(
      `https://api.github.com/repos/${project.owner}/${project.repo}/issues?state=all&since=${since}&per_page=100&page=${page}`,
    );
    for (const issue of batch) {
      if (issue.pull_request || Date.parse(issue.created_at) < Date.parse(since)) continue;
      issues.push({ number: issue.number, title: String(issue.title).slice(0, 100), createdAt: issue.created_at, url: issue.html_url });
    }
    if (batch.length < 100) break;
  }
  return issues.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Home Assistant's opt-in analytics publish active installations per custom integration
 * domain. The domain defaults to the integration's zip name and can be set with haDomain.
 */
async function fetchHomeAssistantAnalytics() {
  const response = await fetch(haAnalyticsUrl, { headers: { 'User-Agent': 'hacs-downloads-history' } });
  if (!response.ok) throw new Error(`Home Assistant analytics returned ${response.status}`);
  return response.json();
}

function haDomain(project) {
  if (project.haDomain) return project.haDomain;
  if (typeof project.assetName === 'string' && project.assetName.endsWith('.zip')) return project.assetName.slice(0, -4);
  return null;
}

function readInstalls(analytics, domain) {
  const entry = analytics?.[domain];
  if (!entry || typeof entry !== 'object' || typeof entry.total !== 'number') return null;
  const versions = entry.versions && typeof entry.versions === 'object'
    ? Object.fromEntries(Object.entries(entry.versions).filter(([, count]) => typeof count === 'number'))
    : undefined;
  return { total: entry.total, ...(versions ? { versions } : {}) };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const projects = JSON.parse(await readFile(projectsPath, 'utf8'));
const history = JSON.parse(await readFile(historyPath, 'utf8'));
const capturedAt = new Date().toISOString();
const capturedDate = capturedAt.slice(0, 10);
const projectEntries = await Promise.all(projects.map(async (project) => [project.id, await fetchProject(project)]));
const nextSnapshot = { capturedAt, projects: Object.fromEntries(projectEntries) };
const retentionStart = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const retainedSnapshots = history.snapshots.filter((snapshot) => (
  Date.parse(snapshot.capturedAt) >= retentionStart
  && snapshot.capturedAt.slice(0, 10) !== capturedDate
));

retainedSnapshots.push(nextSnapshot);
retainedSnapshots.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

await writeFile(historyPath, `${JSON.stringify({ schemaVersion: 1, snapshots: retainedSnapshots }, null, 2)}\n`);
console.log(`Captured ${capturedDate}: ${projectEntries.length} projects, ${retainedSnapshots.length} retained snapshots.`);

// Project metadata is best effort: a failing source keeps its previous data.
const previousMeta = await readJson(metaPath, { schemaVersion: 1, projects: {} });
const haAnalytics = await fetchHomeAssistantAnalytics().catch((error) => {
  console.warn(`Skipping Home Assistant analytics: ${error.message}`);
  return null;
});
const metaEntries = await Promise.all(projects.map(async (project) => {
  const previous = previousMeta.projects?.[project.id] ?? {};
  const meta = { ...previous, releases: { ...(previous.releases ?? {}), ...(publishedDates.get(project.id) ?? {}) } };
  try {
    meta.stars = await fetchStars(project, previous.stars);
  } catch (error) {
    console.warn(`${project.id}: keeping previous stars (${error.message})`);
  }
  try {
    meta.issues = await fetchIssues(project);
  } catch (error) {
    console.warn(`${project.id}: keeping previous issues (${error.message})`);
  }
  const domain = haDomain(project);
  const installs = domain ? readInstalls(haAnalytics, domain) : null;
  if (domain && installs) {
    meta.installs = { domain, history: { ...(previous.installs?.history ?? {}), [capturedDate]: installs } };
  }
  return [project.id, meta];
}));
await writeFile(metaPath, `${JSON.stringify({ schemaVersion: 1, updatedAt: capturedAt, projects: Object.fromEntries(metaEntries) }, null, 2)}\n`);
console.log(`Captured project metadata for ${metaEntries.length} projects.`);
