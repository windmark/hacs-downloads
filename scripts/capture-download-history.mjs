import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsPath = path.join(projectRoot, 'src', 'projects.json');
const historyPath = path.join(projectRoot, 'public', 'download-history.json');
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

async function fetchProject(project) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hacs-downloads-history',
    'X-GitHub-Api-Version': githubApiVersion,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

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
