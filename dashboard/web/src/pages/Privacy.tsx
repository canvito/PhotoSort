// Privacy: what keeps photos on your own machines, checked live. The server checks the config, PAIR, the network
// allowlist, where the index lives and PAIR's routing log; the window checks itself; and on request Windows lists
// every network connection the dashboard's own processes have open.
import { useState } from 'react';
import { Link } from 'wouter';
import { api, errorText, usePoll, type ConnClass, type Connections, type PairAudit, type PrivacyReport } from '../api.ts';
import type { Ctx } from '../App.tsx';
import { Icon } from '../icons.tsx';
import { AuditCounts } from './Cluster.tsx';

type Tone = 'ok' | 'warn' | 'bad' | 'unknown';

interface Check {
  id: string;
  label: string;
  status: Tone;
  detail: string;
}

const CONN: Record<ConnClass, { label: string; why: string; tone: 'ok' | 'bad' | '' }> = {
  loopback: { label: 'Inside this PC', why: 'window ↔ server ↔ Python, and the PAIR proxy on 127.0.0.1', tone: 'ok' },
  lan: { label: 'Your LAN', why: 'your own machines, such as face workers', tone: 'ok' },
  listening: { label: 'Listening (this PC only)', why: 'waits for connections from this PC only', tone: '' },
  exposed: { label: 'Listening on the network', why: 'other machines could connect: should never happen', tone: 'bad' },
  bad: { label: 'Off your network', why: 'a connection outside your LAN: should never happen', tone: 'bad' },
};
const CONN_ORDER: ConnClass[] = ['bad', 'exposed', 'lan', 'loopback', 'listening'];

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.status}>
          <span className={`dot ${c.status === 'unknown' ? '' : c.status}`} role="img" aria-label={c.status} />
          <div>
            <b>{c.label}</b>
            <p className="muted small">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ConnectionsCheck({ ctx }: { ctx: Ctx }) {
  const [result, setResult] = useState<Connections>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const pids = ctx.shell?.pids;
      setResult(await api<Connections>('/api/privacy/connections', { method: 'POST', body: pids?.length ? { shellPids: pids } : {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const worst = result ? (result.summary.bad || result.summary.exposed ? 'bad' : 'ok') : undefined;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Open connections</h2>
        <button type="button" className="primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Asking Windows…' : result ? 'Check again' : 'Check open connections'}
        </button>
      </div>
      <p className="muted small">Windows lists every network connection of the dashboard server, its Python helper and running
        jobs{ctx.shell ? ', and of this window' : ''}. Nothing is sent anywhere.</p>
      {!ctx.shell && <p className="warn small">Open the dashboard with dashboard.ps1 so this window’s own connections are included.</p>}
      {error && <p className="bad small">{error}</p>}
      {result && (
        <>
          <p className={worst}>
            <span className={`dot ${worst}`} /> {worst === 'ok'
              ? `All ${result.connections.length} connections stay on this PC or your LAN.`
              : 'A connection leaves your network or listens on it: see the rows marked red.'}
          </p>
          <div className="stats">
            {CONN_ORDER.map((c) => (
              <div key={c} className="stat" title={CONN[c].why}>
                <span className="k">{CONN[c].label}</span>
                <span className={`v${result.summary[c] && CONN[c].tone === 'bad' ? ' bad' : ''}`}>{result.summary[c]}</span>
              </div>
            ))}
          </div>
          {result.connections.length > 0 && (
            <div className="runs conn-table" role="table" aria-label="Open connections">
              <div className="runs-row thead" role="row">
                <span role="columnheader">Process</span><span role="columnheader">Local</span><span role="columnheader">Remote</span>
                <span role="columnheader">State</span><span role="columnheader">Kind</span>
              </div>
              {result.connections.map((c, i) => (
                <div key={`${c.pid}|${c.local}|${c.remote}|${i}`} className={`runs-row${CONN[c.cls].tone === 'bad' ? ' err' : ''}`} role="row">
                  <span role="cell" className="name">{c.role} <span className="muted small">pid {c.pid}</span></span>
                  <span role="cell" className="name mono">{c.local}</span>
                  <span role="cell" className="name mono">{c.state === 'Listen' ? '—' : c.remote}</span>
                  <span role="cell" className="muted">{c.state}</span>
                  <span role="cell" className={CONN[c.cls].tone || 'muted'} title={CONN[c.cls].why}>{CONN[c.cls].label}</span>
                </div>
              ))}
            </div>
          )}
          <p className="muted small">Checked {new Date(result.checkedAt).toLocaleTimeString()} · {result.processes.map((p) => `${p.role} (pid ${p.pid})`).join(', ')}.</p>
        </>
      )}
    </section>
  );
}

export function Privacy({ ctx }: { ctx: Ctx }) {
  const { shell, meta } = ctx;
  const report = usePoll<PrivacyReport>('/api/privacy');
  const audit = usePoll<PairAudit>('/api/pair/audit', 30000);
  const windowChecks: Check[] = [
    {
      id: 'shell_guard',
      label: 'Window network guard',
      status: shell ? 'ok' : 'bad',
      detail: shell
        ? `Only this dashboard’s own address is reachable from the window; ${shell.blockedRequests} other request(s) blocked since it opened.`
        : 'Not in the PhotoSort window: open it with dashboard.ps1 open.',
    },
    {
      id: 'protection',
      label: 'Content protection',
      status: !shell ? 'bad' : shell.protection ? 'ok' : meta?.mode === 'fixture' ? 'warn' : 'bad',
      detail: 'Screenshots, screen sharing and recording see a black window. It cannot stop a phone camera.',
    },
  ];
  const all: Check[] = [...(report.data?.checks ?? []), ...windowChecks];
  const bad = all.filter((c) => c.status === 'bad').length;
  const warn = all.filter((c) => c.status === 'warn').length;
  return (
    <div className="stack wide">
      <section className="card">
        <div className="card-head">
          <h2>Privacy checks</h2>
          <button type="button" className="ghost" onClick={report.reload} disabled={report.loading}>
            <Icon name="refresh" size={14} /> Check again
          </button>
        </div>
        {report.data && (
          <p className={bad ? 'bad' : warn ? 'warn' : 'ok'}>
            {bad ? `${bad} problem${bad === 1 ? '' : 's'} to fix.` : warn ? `No problems; ${warn} thing${warn === 1 ? '' : 's'} to look at.` : 'Everything checks out.'}
            <span className="muted small"> Checked {new Date(report.data.checkedAt).toLocaleTimeString()} on {report.data.host}.</span>
          </p>
        )}
        {report.error && <p className="bad small">{report.error}</p>}
        {!report.data && !report.error && <p className="muted small">Checking…</p>}
        <CheckList checks={all} />
      </section>
      <ConnectionsCheck ctx={ctx} />
      <section className="card">
        <div className="card-head"><h2>Where PAIR sent requests</h2><Link href="/cluster" className="small">Cluster</Link></div>
        {audit.error && <p className="bad small">{audit.error}</p>}
        {audit.data && !audit.data.found && <p className="muted small">PAIR’s log was not found on this PC, so routing cannot be audited.</p>}
        {audit.data?.found && audit.data.format === 'unrecognized' && <p className="warn small">PAIR’s log is in a format this version cannot read.</p>}
        {audit.data?.found && audit.data.format !== 'unrecognized' && <AuditCounts audit={audit.data} />}
        <p className="muted small">From PAIR’s own log on this PC: every request it routed, and to which kind of address.</p>
      </section>
      <section className="card">
        <h2>Standing rules</h2>
        <ul className="plain">
          <li>Photos, videos and anything made from them (frames, captions, text, embeddings, file names) go only to models on your own machines, through the PAIR proxy on this PC.</li>
          <li>This PC runs no inference; its own Ollama stays off.</li>
          <li>Coding agents work in fixture mode only and never read your library, thumbnails, logs or this window.</li>
        </ul>
      </section>
    </div>
  );
}
