import { Bug, ExternalLink, Heart, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { DAY_MS, LAUNCH_BUCKETS } from './insights';
import type { LaunchCurve, Point } from './insights';
import type { MetaIssue } from './meta';

const number = (value: number) => new Intl.NumberFormat('en').format(Math.round(value));

export function formatDuration(hours: number | null) {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

export function formatDays(days: number | null) {
  if (days === null) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} h`;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} d`;
}

/** Minimal multi-series line chart; each series can be scaled to its own peak. */
export function LineChart({
  series,
  height = 120,
  label,
  independentScales = false,
}: {
  series: Array<{ id: string; points: Point[]; color: string; dashed?: boolean }>;
  height?: number;
  label: string;
  independentScales?: boolean;
}) {
  const width = 600;
  const all = series.flatMap((entry) => entry.points);
  if (all.length < 2) return null;
  const minT = Math.min(...all.map((point) => point.t));
  const maxT = Math.max(...all.map((point) => point.t));
  const globalMax = Math.max(1, ...all.map((point) => point.v));
  const x = (t: number) => (maxT === minT ? 0 : ((t - minT) / (maxT - minT)) * width);
  return (
    <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line x1="0" x2={width} y1={height - 1} y2={height - 1} className="line-chart-axis" />
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} className="line-chart-grid" />
      {series.map((entry) => {
        const max = independentScales ? Math.max(1, ...entry.points.map((point) => point.v)) : globalMax;
        const y = (v: number) => height - 4 - (v / max) * (height - 10);
        const path = entry.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`).join(' ');
        return <path d={path} fill="none" key={entry.id} stroke={entry.color} strokeDasharray={entry.dashed ? '6 5' : undefined} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

export type LaunchRow = {
  version: string;
  url: string;
  prerelease: boolean;
  isLatest: boolean;
  curve: LaunchCurve;
  firstWeek: { value: number; projected: boolean } | null;
  majorityDays: number | null;
};

export function LaunchHeatmap({ rows }: { rows: LaunchRow[] }) {
  const max = Math.max(1, ...rows.flatMap((row) => row.curve.buckets.map((bucket) => bucket.downloads ?? 0)));
  const tracked = rows.filter((row) => row.curve.available);
  return (
    <div className="table-scroll">
      <table className="heatmap">
        <thead>
          <tr>
            <th>Version</th>
            {LAUNCH_BUCKETS.map((bucket) => <th className="align-right" key={bucket.id}>{bucket.label}</th>)}
            <th className="align-right" title="Downloads in the first 7 days; ≈ marks a projection from earlier releases">First week</th>
            <th className="align-right" title="Time until the release took more than half of a day's new downloads">Majority</th>
          </tr>
        </thead>
        <tbody>
          {tracked.map((row) => (
            <tr key={row.version}>
              <td>
                <a className="release-version" href={row.url} target="_blank" rel="noreferrer">{row.version}</a>
                {row.isLatest && <span className="latest-tag">Latest</span>}
                {row.prerelease && <span className="prerelease-tag">Pre</span>}
              </td>
              {row.curve.buckets.map((bucket) => {
                const intensity = bucket.downloads === null ? 0 : bucket.downloads / max;
                return (
                  <td
                    className={`heat-cell${bucket.partial ? ' is-partial' : ''}${bucket.downloads === null ? ' is-empty' : ''}${intensity > 0.55 ? ' is-strong' : ''}`}
                    key={bucket.id}
                    style={bucket.downloads ? { background: `rgb(25 198 173 / ${(0.1 + intensity * 0.75).toFixed(2)})` } : undefined}
                    title={bucket.partial ? `${bucket.label}: ${bucket.downloads} so far` : undefined}
                  >
                    {bucket.downloads === null ? '' : number(bucket.downloads)}
                  </td>
                );
              })}
              <td className="align-right">
                {row.firstWeek
                  ? <strong className={`download-count${row.firstWeek.projected ? ' is-projected' : ''}`}>{row.firstWeek.projected ? '≈' : ''}{number(row.firstWeek.value)}</strong>
                  : '—'}
              </td>
              <td className="align-right">{formatDays(row.majorityDays)}</td>
            </tr>
          ))}
          {tracked.length === 0 && (
            <tr className="empty-row"><td colSpan={LAUNCH_BUCKETS.length + 3}>Launch curves appear for releases published after daily tracking started.</td></tr>
          )}
        </tbody>
      </table>
      {rows.length > tracked.length && (
        <p className="heatmap-note">{rows.length - tracked.length} older {rows.length - tracked.length === 1 ? 'release was' : 'releases were'} published before tracking started, so {rows.length - tracked.length === 1 ? 'its' : 'their'} launch can&rsquo;t be reconstructed.</p>
      )}
    </div>
  );
}

export function InsightTile({ icon, label, value, children, tone }: { icon: ReactNode; label: string; value: ReactNode; children: ReactNode; tone?: 'muted' }) {
  return (
    <article className={`insight-tile${tone ? ` tone-${tone}` : ''}`}>
      <div className="insight-tile-top"><span>{label}</span><span aria-hidden="true">{icon}</span></div>
      <strong>{value}</strong>
      <p>{children}</p>
    </article>
  );
}

export function ReleaseDetail({
  version,
  publishedAt,
  points,
  curve,
  milestones,
  firstWeek,
  majorityDays,
  issues,
  hotfix,
  reactions,
  resets,
}: {
  version: string;
  publishedAt: number;
  points: Point[];
  curve: LaunchCurve;
  milestones: Array<{ threshold: number; hours: number | null }>;
  firstWeek: { value: number; projected: boolean } | null;
  majorityDays: number | null;
  issues: MetaIssue[];
  hotfix: { version: string; hours: number } | null;
  reactions?: { total: number; positive: number; negative: number };
  resets: number;
}) {
  const curvePoints = curve.available ? [{ t: publishedAt, v: 0 }, ...points.filter((point) => point.t > publishedAt)] : points;
  return (
    <div className="release-detail">
      <div className="release-detail-chart">
        <span className="detail-label">Cumulative downloads since publish</span>
        {curvePoints.length >= 2
          ? <LineChart height={110} label={`Cumulative downloads of ${version}`} series={[{ id: version, points: curvePoints, color: '#0b8e81' }]} />
          : <p className="detail-empty">Needs at least two daily snapshots.</p>}
        <div className="detail-axis"><span>{curve.available ? 'Publish' : 'Tracking start'}</span><span>{formatDays(curve.ageDays)} old</span></div>
      </div>
      <dl className="release-detail-facts">
        <div><dt>Launch</dt><dd>{curve.available ? curve.buckets.map((bucket) => (bucket.downloads === null ? null : <span key={bucket.id}>{bucket.label} <b>{number(bucket.downloads)}{bucket.partial ? '+' : ''}</b></span>)) : 'Published before tracking started'}</dd></div>
        <div><dt>Milestones</dt><dd>{milestones.some((milestone) => milestone.hours !== null)
          ? milestones.filter((milestone) => milestone.hours !== null).map((milestone) => <span key={milestone.threshold}>{milestone.threshold} in <b>{formatDuration(milestone.hours)}</b></span>)
          : 'No milestone crossings recorded'}</dd></div>
        <div><dt>First week</dt><dd>{firstWeek
          ? <span><b>{firstWeek.projected ? '≈' : ''}{number(firstWeek.value)}</b>{firstWeek.projected ? ' projected from earlier releases' : ''}</span>
          : curve.available && curve.ageDays < 7 ? `Complete in ${formatDays(7 - curve.ageDays)}; a projection needs an earlier release with a full first week` : '—'}</dd></div>
        <div><dt>Took the majority</dt><dd>{majorityDays === null ? 'Not yet, or before tracking' : <span>After <b>{formatDays(majorityDays)}</b></span>}</dd></div>
        <div><dt>Issues within 72 h</dt><dd>{issues.length === 0 ? 'None opened' : issues.map((issue) => (
          <a href={issue.url} key={issue.number} target="_blank" rel="noreferrer"><Bug size={11} aria-hidden="true" /> #{issue.number} {issue.title} <ExternalLink size={10} aria-hidden="true" /></a>
        ))}</dd></div>
        <div><dt>Follow-up</dt><dd>{hotfix ? <span><Wrench size={11} aria-hidden="true" /> Hotfixed by <b>{hotfix.version}</b> after {formatDuration(hotfix.hours)}</span> : 'No hotfix within 48 h'}</dd></div>
        <div><dt>Reactions</dt><dd>{reactions?.total ? <span><Heart size={11} aria-hidden="true" /> <b>{reactions.total}</b> ({reactions.positive} positive{reactions.negative ? `, ${reactions.negative} negative` : ''})</span> : 'None on the release notes'}</dd></div>
        {resets > 0 && <div><dt>Data note</dt><dd>The download counter dropped {resets} {resets === 1 ? 'time' : 'times'}, likely an asset re-upload; the highest value is kept.</dd></div>}
      </dl>
    </div>
  );
}

export function PortfolioTable({ rows, onSelect }: {
  rows: Array<{ id: string; name: string; total: number; week: number | null; perDay: number | null; stars: number | null; selected: boolean }>;
  onSelect: (id: string) => void;
}) {
  const max = Math.max(1, ...rows.map((row) => row.total));
  return (
    <div className="table-scroll">
      <table className="portfolio-table">
        <thead>
          <tr><th>Project</th><th className="align-right">Downloads</th><th className="align-right">Last 7 days</th><th className="align-right" title="Downloads per day since the first tracked release">Per day</th><th className="align-right">Stars</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={row.selected ? 'is-selected' : ''} key={row.id}>
              <td>
                <button className="portfolio-name" onClick={() => onSelect(row.id)} type="button">{row.name}</button>
                <span className="share-cell"><i><b style={{ width: `${(row.total / max) * 100}%` }} /></i></span>
              </td>
              <td className="align-right"><strong className="download-count">{number(row.total)}</strong></td>
              <td className="align-right">{row.week === null ? '—' : `+${number(row.week)}`}</td>
              <td className="align-right">{row.perDay === null ? '—' : row.perDay.toFixed(1)}</td>
              <td className="align-right">{row.stars === null ? '—' : number(row.stars)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const daysBetween = (a: number, b: number) => Math.abs(a - b) / DAY_MS;
