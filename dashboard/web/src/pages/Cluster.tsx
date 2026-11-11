// Cluster: the PAIR nodes, where requests went and how fast, the routing audit and the models PAIR offers. All of
// it comes from PAIR's own log and its loopback proxy on this PC; nothing here contacts the nodes.
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  usePairEvents, usePoll, when,
  type PairAlert, type PairAudit, type PairModels, type PairNode, type PairNodes, type PairStats, type TargetClass,
} from '../api.ts';
import { Segmented } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';

type Win = '15m' | '1h' | '24h';
const WINDOWS: { value: Win; label: string }[] = [{ value: '15m', label: '15 min' }, { value: '1h', label: '1 hour' }, { value: '24h', label: '24 hours' }];
const PALETTE = ['#4c8dff', '#2fbf71', '#f2a93b', '#c06cf0', '#3cc6c6', '#ef7d5d', '#9aa4b2'];

export const ms = (v?: number | null): string =>
  v === undefined || v === null ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;

const gb = (bytes?: number): string => (bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : '—');

export const CLASS_INFO: Record<TargetClass, { label: string; why: string; tone?: 'ok' | 'bad' | 'muted' }> = {
  lan: { label: 'Your LAN', why: 'Sent to a PAIR node on your network', tone: 'ok' },
  cluster: { label: 'Between nodes', why: 'PAIR nodes exchanging model lists and status', tone: 'ok' },
  loopback: { label: 'This PC', why: 'Model lists and health checks on this PC (inference here raises an alert)', tone: 'muted' },
  blank: { label: 'No target', why: 'Requests PAIR answered itself or that never reached a node', tone: 'muted' },
  public: { label: 'Off your network', why: 'Sent outside your LAN: should never happen', tone: 'bad' },
};
const CLASS_ORDER: TargetClass[] = ['lan', 'cluster', 'loopback', 'blank', 'public'];

export const alertText = (a: PairAlert): string => (a.kind === 'public_target'
  ? `${a.path} went to ${a.target || 'an address'} outside your LAN`
  : `${a.path} ran on this PC${a.target ? ` (${a.target})` : ''}`);

function NodeState({ node }: { node: PairNode }) {
  if (node.self) return <span className="status muted" title="This PC routes requests; it runs no models">router (this PC)</span>;
  if (node.stale) return <span className="status muted" title="No activity for over 30 minutes">idle / asleep</span>;
  if (node.engineHealthy === false) return <span className="status bad">engine unhealthy</span>;
  if (node.engineRunning === false) return <span className="status warn">engine stopped</span>;
  if (node.engineHealthy) return <span className="status ok">ready</span>;
  return <span className="status muted">seen</span>;
}

function Nodes({ data, error }: { data?: PairNodes; error?: string }) {
  return (
    <section className="card">
      <div className="card-head"><h2>Nodes</h2></div>
      {error && <p className="bad small">{error}</p>}
      {!data && !error && <p className="muted small">Reading the PAIR log…</p>}
      {data && !data.nodes.length && <p className="muted small">No nodes in PAIR’s log yet.</p>}
      {data && data.nodes.length > 0 && (
        <div className="runs node-table" role="table" aria-label="PAIR nodes">
          <div className="runs-row thead" role="row">
            <span role="columnheader">Node</span><span role="columnheader">State</span><span role="columnheader">Requests</span>
            <span role="columnheader">Per min</span><span role="columnheader">p50 / p95</span><span role="columnheader">First token</span>
            <span role="columnheader">Errors</span><span role="columnheader">Last active</span>
          </div>
          {data.nodes.map((nd) => (
            <div key={nd.id} className={`runs-row${nd.stale ? ' dim' : ''}`} role="row">
              <span role="cell" className="name" title={[nd.ip, nd.models?.join(', ')].filter(Boolean).join(' · ') || undefined}>
                {nd.name}{nd.self && <span className="tag">this PC</span>}{!nd.member && <span className="tag" title="Seen in the log, not in PAIR’s member list">not a member</span>}
                {nd.ip && <span className="muted small"> {nd.ip}</span>}
              </span>
              <span role="cell"><NodeState node={nd} /></span>
              <span role="cell">{nd.requests.toLocaleString()}{nd.requests > 0 && <span className="muted small"> · {nd.share}%</span>}</span>
              <span role="cell">{nd.requests ? nd.perMin : '—'}</span>
              <span role="cell">{nd.requests ? `${ms(nd.p50)} / ${ms(nd.p95)}` : '—'}</span>
              <span role="cell">{ms(nd.ttfbP50)}</span>
              <span role="cell" className={nd.errors ? 'bad' : undefined}>{nd.requests ? `${nd.errors}${nd.errorRate ? ` (${nd.errorRate}%)` : ''}` : '—'}</span>
              <span role="cell" className="muted">{when(nd.lastActivity)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">Inference requests (chat, generate, embed) in the chosen window. Nodes idle for over 30 minutes are dimmed.</p>
    </section>
  );
}

/** Requests per time bin, stacked by node, as plain SVG (scaled by the GPU compositor, no chart library). */
function RequestsChart({ stats }: { stats: PairStats }) {
  const bins = stats.p50.length;
  const totals = Array.from({ length: bins }, (_, i) => stats.series.reduce((a, s) => a + s.counts[i], 0));
  const max = Math.max(1, ...totals);
  const W = bins * 10;
  const H = 100;
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Requests per ${Math.round(stats.binS / 60)} minutes, most ${max}`}>
        {Array.from({ length: bins }, (_, i) => {
          let y = H;
          return stats.series.map((s, k) => {
            const h = (s.counts[i] / max) * (H - 4);
            if (!h) return null;
            y -= h;
            return <rect key={`${i}-${k}`} x={i * 10 + 1} y={y} width={8} height={h} fill={PALETTE[k % PALETTE.length]} />;
          });
        })}
      </svg>
      <figcaption className="chart-axis muted small"><span>{when(stats.start)}</span><span>peak {max} per {Math.round(stats.binS / 60)} min</span><span>now</span></figcaption>
    </figure>
  );
}

/** p50 and p95 latency per bin; gaps where no request finished. */
function LatencyChart({ stats }: { stats: PairStats }) {
  const bins = stats.p95.length;
  const max = Math.max(1, ...stats.p95.filter((v): v is number => v !== null));
  const W = bins * 10;
  const H = 100;
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      const x = i * 10 + 5;
      const y = H - (v / max) * (H - 6) - 3;
      d += `${pen ? 'L' : 'M'}${x} ${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Latency, p95 up to ${ms(max)}`}>
        <path d={path(stats.p95)} fill="none" stroke={PALETTE[2]} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={path(stats.p50)} fill="none" stroke={PALETTE[0]} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="chart-axis muted small"><span>{when(stats.start)}</span><span>top {ms(max)}</span><span>now</span></figcaption>
    </figure>
  );
}

function Charts({ stats }: { stats?: PairStats }) {
  if (!stats) return null;
  return (
    <section className="card">
      <div className="card-head"><h2>Requests and latency</h2></div>
      <div className="stats">
        <div className="stat"><span className="k">Requests</span><span className="v">{stats.total.toLocaleString()}</span></div>
        <div className="stat"><span className="k">Errors</span><span className={`v${stats.errors ? ' bad' : ''}`}>{stats.errors.toLocaleString()}</span></div>
        <div className="stat"><span className="k">p50</span><span className="v">{ms(stats.overallP50)}</span></div>
        <div className="stat"><span className="k">p95</span><span className="v">{ms(stats.overallP95)}</span></div>
      </div>
      {stats.total === 0 ? <p className="muted small">No inference requests in this window.</p> : (
        <div className="chart-pair">
          <div>
            <h3 className="sub">Requests by node</h3>
            <RequestsChart stats={stats} />
            <ul className="legend">
              {stats.series.map((s, k) => (
                <li key={s.name}><span className="swatch" style={{ background: PALETTE[k % PALETTE.length] }} />{s.name}
                  <span className="muted"> {s.counts.reduce((a, b) => a + b, 0).toLocaleString()}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="sub">Latency</h3>
            <LatencyChart stats={stats} />
            <ul className="legend">
              <li><span className="swatch" style={{ background: PALETTE[0] }} />p50 (typical)</li>
              <li><span className="swatch" style={{ background: PALETTE[2] }} />p95 (slowest 5%)</li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

export function AuditCounts({ audit }: { audit: PairAudit }) {
  return (
    <div className="runs audit-table" role="table" aria-label="Where PAIR sent requests">
      <div className="runs-row thead" role="row">
        <span role="columnheader">Destination</span><span role="columnheader">Last 24 h</span><span role="columnheader">In the log</span>
      </div>
      {CLASS_ORDER.map((c) => {
        const info = CLASS_INFO[c];
        const bad = c === 'public' && audit.all.counts.public > 0;
        return (
          <div key={c} className="runs-row" role="row" title={info.why}>
            <span role="cell" className="name"><span className={`dot ${bad ? 'bad' : info.tone === 'ok' ? 'ok' : ''}`} /> {info.label}
              <span className="muted small"> · {info.why}</span></span>
            <span role="cell" className={c === 'public' && audit.day.counts.public ? 'bad' : undefined}>{audit.day.counts[c].toLocaleString()}</span>
            <span role="cell" className={bad ? 'bad' : undefined}>{audit.all.counts[c].toLocaleString()}</span>
          </div>
        );
      })}
      <div className="runs-row" role="row">
        <span role="cell" className="name"><span className={`dot ${audit.all.alerts ? 'bad' : 'ok'}`} /> Alerts
          <span className="muted small"> · inference sent off your LAN or run on this PC</span></span>
        <span role="cell" className={audit.day.alerts ? 'bad' : undefined}>{audit.day.alerts.toLocaleString()}</span>
        <span role="cell" className={audit.all.alerts ? 'bad' : undefined}>{audit.all.alerts.toLocaleString()}</span>
      </div>
    </div>
  );
}

function Audit({ audit, live }: { audit?: PairAudit; live: PairAlert[] }) {
  const alerts = useMemo(() => {
    const seen = new Set<string>();
    return [...live, ...(audit?.recentAlerts ?? [])].filter((a) => {
      const k = `${a.t}|${a.kind}|${a.node}|${a.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 20);
  }, [audit, live]);
  if (!audit) return null;
  return (
    <section className="card">
      <div className="card-head"><h2>Routing audit</h2><Link href="/privacy" className="small">Privacy checks</Link></div>
      <AuditCounts audit={audit} />
      {audit.firstT && <p className="muted small">The log covers {new Date(audit.firstT).toLocaleString()} to {audit.lastT ? new Date(audit.lastT).toLocaleString() : 'now'} ({audit.lines.toLocaleString()} lines).</p>}
      {alerts.length > 0 && (
        <>
          <h3 className="sub bad"><Icon name="alert" size={14} /> Recent alerts</h3>
          <ul className="plain">
            {alerts.map((a) => <li key={`${a.t}|${a.kind}|${a.node}|${a.path}`}><span className="muted small">{new Date(a.t).toLocaleString()}</span> {alertText(a)}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function Models({ data, error }: { data?: PairModels; error?: string }) {
  return (
    <section className="card">
      <div className="card-head"><h2>Models</h2></div>
      {error && <p className="bad small">{error}</p>}
      {!data && !error && <p className="muted small">Asking PAIR…</p>}
      {data && !data.reachable && <p className="bad small">PAIR is not reachable on this PC{data.error ? `: ${data.error}` : ''}.</p>}
      {data?.reachable && (
        <>
          <div className="runs model-table" role="table" aria-label="Models PAIR lists">
            <div className="runs-row thead" role="row">
              <span role="columnheader">Model</span><span role="columnheader">Size</span><span role="columnheader">Details</span><span role="columnheader">Use</span>
            </div>
            {data.models.map((m) => (
              <div key={m.name} className="runs-row" role="row">
                <span role="cell" className="name">{m.name}</span>
                <span role="cell">{gb(m.size)}</span>
                <span role="cell" className="name muted">{[m.family, m.parameterSize, m.quantization].filter(Boolean).join(' · ')}</span>
                <span role="cell">{m.cloud ? <span className="warn" title="PhotoSort refuses cloud models">cloud: never used</span>
                  : m.used ? <span className="ok">used by PhotoSort</span> : ''}</span>
              </div>
            ))}
          </div>
          <h3 className="sub">Loaded now</h3>
          {data.loaded.length ? (
            <ul className="plain">
              {data.loaded.map((m) => (
                <li key={m.name}>{m.name} <span className="muted small">· {gb(m.sizeVram ?? m.size)} in GPU memory{m.expiresAt ? ` · unloads ${when(m.expiresAt)}` : ''}</span></li>
              ))}
            </ul>
          ) : <p className="muted small">No model is loaded right now.</p>}
        </>
      )}
    </section>
  );
}

export function ClusterPage() {
  const [win, setWin] = useState<Win>('1h');
  const nodes = usePoll<PairNodes>(`/api/pair/nodes?window=${win}`, 10000);
  const stats = usePoll<PairStats>(`/api/pair/stats?window=${win}`, 10000);
  const audit = usePoll<PairAudit>('/api/pair/audit', 30000);
  const models = usePoll<PairModels>('/api/pair/models', 30000);
  const [live, setLive] = useState<PairAlert[]>([]);
  usePairEvents((e) => {
    if (e.type === 'alert' && e.alert) setLive((l) => [e.alert!, ...l].slice(0, 20));
    audit.reload();
  });
  const status = nodes.data?.status;
  return (
    <div className="stack wide">
      {live.length > 0 && (
        <div className="card notice bad" role="alert">
          <Icon name="alert" size={16} />
          <div>
            <b>{live.length} routing alert{live.length === 1 ? '' : 's'} since this page opened</b>
            <p className="small">{alertText(live[0])}. Check PAIR’s settings on that node.</p>
          </div>
        </div>
      )}
      <div className="card-head">
        <Segmented<Win> label="Time window" value={win} onChange={setWin} options={WINDOWS} />
        <span className="muted small">From PAIR’s log on this PC; refreshes every 10 s.</span>
      </div>
      {status && !status.found ? (
        <section className="card narrow">
          <h2>PAIR’s log was not found</h2>
          <p className="muted">The cluster view reads NVIDIA PAIR’s own log on this PC. Start PAIR (or sign in to it) and this page fills in.</p>
          <p className="muted small">Models below come from the proxy itself and work without the log.</p>
        </section>
      ) : status?.format === 'unrecognized' ? (
        <section className="card narrow">
          <h2>PAIR’s log is in a new format</h2>
          <p className="muted">The log exists but none of its lines could be read, so nodes, charts and the routing audit are unavailable.
            The other privacy checks still apply.</p>
        </section>
      ) : (
        <>
          <Nodes data={nodes.data} error={nodes.error} />
          <Charts stats={stats.data} />
          <Audit audit={audit.data} live={live} />
        </>
      )}
      <Models data={models.data} error={models.error} />
    </div>
  );
}
