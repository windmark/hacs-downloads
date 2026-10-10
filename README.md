# HACS Download Analytics

[![Deploy dashboard](https://github.com/thomasgregg/hacs-downloads/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/thomasgregg/hacs-downloads/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)

A fast, privacy-friendly dashboard for exploring GitHub release-asset downloads across Home Assistant and ESPHome projects.

HACS Download Analytics turns the download counters exposed by GitHub Releases into a clear, responsive overview of total downloads, daily and weekly growth, distribution, and per-version performance. Projects can track either one release asset or a labeled pair, with combined totals and separate asset-level results shown in the same dashboard. The site remains fully static: no database or always-on backend is required. A scheduled GitHub Action records one compact history snapshot per day.

[View the live dashboard](https://thomasgregg.github.io/hacs-downloads/) · [Report an issue](https://github.com/thomasgregg/hacs-downloads/issues)

![HACS Download Analytics dashboard](docs/dashboard.png)

## Highlights

- Monitor multiple public GitHub repositories from one dashboard.
- Track integration `.zip` archives, frontend card `.js` bundles, firmware images, or other release assets with fixed or version-derived filenames.
- Configure a labeled pair of assets when a project needs separate download counts, such as Factory and OTA firmware images.
- Review combined totals, asset-level summaries, download share, and individual releases without switching dashboard views.
- Filter every view from one sticky filter bar: stable releases only (the default) or with pre-releases, and the last 5 or all releases for the chart, share and table. Hovering a filter highlights the sections it changes, and filters are kept in the URL.
- Pre-releases are detected from GitHub's flag and from common tag patterns such as `-beta.3`, `rc1` or `b5`.
- Compare releases fairly with downloads per day since release, see a multi-version share donut, and track how much of the past week's downloads went to the latest release.
- Sort the release table, export the current view as CSV, and see when the latest release is projected to pass the previous record at its current pace.
- See each selected repository's GitHub star count beside its repository link.
- Compare 24-hour and 7-day growth for totals, latest releases, leading releases, and active-release averages.
- Explore daily and weekly download velocity as snapshot history accumulates, with stacked asset sections for multi-asset projects.
- Compare the latest release with the strongest earlier version, including release age and progress toward the previous combined download record.
- Switch projects without reloading and share the selected project through the URL.
- Cache successful responses locally to reduce GitHub API usage.
- Preserve cached data and retry automatically when GitHub rate limits are reached.
- Deploy as a fully static site with the included GitHub Pages workflow.

## How it works

GitHub records a `download_count` for every file uploaded to a release. For each configured project, the dashboard requests up to 100 published releases, selects the configured asset or assets, and aggregates their download counts. A multi-asset project's total is the sum of both asset counters; the separate values are retained for summary cards, distribution, stacked release and velocity charts, and the release table.

These counters measure asset requests rather than people or installations. If one person downloads both tracked files, GitHub records two downloads and the combined project total increases by two.

```text
GitHub Releases API → matching release assets → browser-side aggregation → dashboard
                    ↘ daily GitHub Action → download-history.json ↗
```

A repository is compatible when it:

1. Is publicly accessible.
2. Publishes GitHub releases.
3. Uploads at least one configured release asset to each relevant release.
4. Uses consistent, case-sensitive filenames or filenames derived from the release tag.

GitHub's automatically generated source archives are not release assets and do not expose the counter used by this dashboard. Draft releases and releases without any configured asset are ignored. For a multi-asset project, a release remains visible when only one tracked asset exists; the missing asset is shown as zero.

## Quick start

### Requirements

- Node.js 22.13 or newer
- npm

### Run locally

```bash
git clone https://github.com/thomasgregg/hacs-downloads.git
cd hacs-downloads
npm ci
npm run dev
```

Vite prints the local development URL in the terminal. To verify the production build:

```bash
npm run build
npm run preview
```

The optimized site is written to `dist/`.

## Configure projects

Projects are defined in [`src/projects.json`](src/projects.json). The dashboard and history collector share this file, so each repository only needs to be configured once. A standard entry connects one GitHub repository to one release asset:

```json
{
  "id": "example-integration",
  "name": "Example Integration",
  "owner": "github-owner",
  "repo": "example-integration",
  "assetName": "example_integration.zip",
  "mark": "EI",
  "description": "the Example Home Assistant integration"
}
```

Frontend cards use the same structure; only the asset filename changes:

```json
{
  "id": "example-card",
  "name": "Example Card",
  "owner": "github-owner",
  "repo": "example-card",
  "assetName": "example-card.js",
  "mark": "EC",
  "description": "the Example Home Assistant dashboard card"
}
```

Versioned assets can use `{version}`, which is the release tag with one leading
`v` removed, or `{tag}`, which preserves the complete release tag:

```json
{
  "id": "example-firmware",
  "name": "Example Firmware",
  "owner": "github-owner",
  "repo": "example-firmware",
  "assetNameTemplate": "example-{version}.factory.bin",
  "mark": "EF",
  "description": "the Example ESPHome firmware"
}
```

A project that publishes two meaningful assets can define an `assets` array. The dashboard keeps the existing layout while adding separate summary cards, asset distribution, stacked release and velocity bars, and table columns for that project. The combined total remains visible throughout:

```json
{
  "id": "example-firmware",
  "name": "Example Firmware",
  "owner": "github-owner",
  "repo": "example-firmware",
  "assets": [
    {
      "id": "factory",
      "label": "Factory image",
      "assetNameTemplate": "example-{version}.factory.bin"
    },
    {
      "id": "ota",
      "label": "OTA image",
      "assetNameTemplate": "example-{version}.ota.bin"
    }
  ],
  "mark": "EF",
  "description": "the Example firmware"
}
```

| Field | Description |
| --- | --- |
| `id` | Unique, URL-safe identifier used in links and browser cache keys. |
| `name` | Human-readable project name shown in the interface and page title. |
| `owner` | GitHub user or organization that owns the repository. |
| `repo` | Repository name without the owner or URL. |
| `assetName` | Exact, case-sensitive filename of the release asset to count. Use this or `assetNameTemplate`. |
| `assetNameTemplate` | Case-sensitive filename template supporting `{version}` and `{tag}`. Use this or `assetName`. |
| `assets` | Optional two-item array of labeled release assets to count together and break down separately. Each item needs a unique `id`, a `label`, and either `assetName` or `assetNameTemplate`. |
| `mark` | Short initials displayed in the project mark. |
| `description` | Project description used in page metadata. |

### Add, edit, or remove a project

To add a project, confirm that at least one published release contains the asset, add an entry with a unique `id`, and run the dashboard locally to verify its totals and links.

Edit an existing entry to update its presentation or repository details. Avoid changing its `id` unless necessary because existing shared URLs and local cache entries use it.

Remove a project by deleting its entry. If a URL references an unknown project, the dashboard safely falls back to the default project.

The first entry in `src/projects.json` is the default. The selector follows the array order.

## Shareable links

Selecting a project updates the query string without reloading the page:

```text
https://example.github.io/repository-name/?project=project-id
```

When the query parameter is missing or invalid, the dashboard restores the most recently selected project from browser storage, then falls back to the first configured project.

## Deployment

The included [GitHub Pages workflow](.github/workflows/deploy-pages.yml) builds and deploys the dashboard after every push to `main`. It also supports manual runs from the repository's **Actions** tab.

At 04:17 UTC each day, the same workflow captures current download counters, replaces that day's entry in `public/download-history.json`, commits the updated file, and deploys the refreshed dashboard. Manual workflow runs also capture a snapshot.

1. Open the repository on GitHub.
2. Go to **Settings → Pages**.
3. Set **Source** to **GitHub Actions**.
4. Push to `main` or run the workflow manually.

For a repository site, the `base` value in [`vite.config.ts`](vite.config.ts) must match the repository name:

```ts
export default defineConfig({
  base: '/repository-name/',
  plugins: [react()],
});
```

Use `/` for a user or organization site served from the domain root.

## Download history, caching, and API limits

`public/download-history.json` keeps up to 400 days of daily snapshots. Each snapshot stores the total and per-release counters for every configured project. Multi-asset snapshots additionally store totals by asset and asset counters by release so growth and velocity can use the same breakdown as the live dashboard. The dashboard calculates 24-hour and 7-day changes from snapshots taken at approximately the same UTC time.

The first snapshot establishes the baseline. Daily changes become available after the second snapshot, weekly changes after seven days, and period comparisons after two complete periods. Missing intervals are shown as collecting rather than estimated.

When an existing project changes from one tracked asset to a labeled pair, older snapshots do not contain a compatible asset breakdown and are intentionally excluded from the new growth calculation. The first multi-asset snapshot establishes a fresh baseline; stacked velocity appears after a compatible comparison snapshot is available.

The dashboard uses GitHub's unauthenticated public API for release assets and public repository metadata such as the star count. Each project's most recent successful response is stored in `localStorage` and reused for five minutes. If GitHub's rate limit is reached, cached data remains visible and the dashboard retries after the reset time reported by GitHub.

For a high-traffic deployment, use a server-side proxy with appropriate authentication and caching. Never place a GitHub access token in client-side code.

## Limitations

- Only public repositories are supported by the client-side implementation.
- Each project tracks either one release asset or a configured pair of labeled release assets.
- The dashboard reads the first 100 releases returned by GitHub.
- Counts represent GitHub release-asset downloads, not unique users or confirmed installations; downloads served elsewhere are excluded.
- Multi-asset totals add the tracked asset counters together, so downloading both assets produces two counted downloads rather than one installation.
- Live totals can be newer than the most recent daily growth snapshot.
- Replacing or deleting a release asset can produce a negative interval because GitHub resets or removes that asset's cumulative counter.

## Technology

- [React](https://react.dev/) and [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/)
- [GitHub REST API](https://docs.github.com/en/rest/releases/releases)
- GitHub Actions and GitHub Pages

## Contributing

Bug reports and focused pull requests are welcome. Before opening a pull request, run `npm run build` and confirm that the dashboard works at both desktop and mobile widths.

## License

HACS Download Analytics is available under the [MIT License](LICENSE). Copyright © 2026 Thomas Gregg.

This project is independent and is not affiliated with or endorsed by HACS, Home Assistant, or GitHub.
