import type { ReactNode } from 'react';
import { duration, type PairHealth } from '../api.ts';
import type { Ctx } from '../App.tsx';

function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={`v${tone ? ` ${tone}` : ''}`}>{v}</span>
    </div>
  );
}

function PairCard({ pair, error, reload }: { pair?: PairHealth; error?: string; reload(): void }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>PAIR proxy</h2>
        <button type="button" className="ghost" onClick={reload}>Check</button>
      </div>
      {!pair && !error && <p className="muted">Checking…</p>}
      {error && <p className="bad">{error}</p>}
      {pair && (
        <>
          <Row k="Proxy" v={pair.reachable ? `reachable in ${pair.ms} ms` : 'not reachable'} tone={pair.reachable ? 'ok' : 'bad'} />
          {pair.error && <p className="bad small">{pair.reachable ? pair.error : 'Start NVIDIA PAIR on this PC. Sort, group, index and search need it; faces does not.'}</p>}
          <Row k="Models listed" v={pair.models} />
          {pair.required.map((m) => (
            <Row key={`${m.role}:${m.name}`} k={`${m.role[0].toUpperCase()}${m.role.slice(1)} model`}
              v={`${m.name}${m.cloud ? ' (cloud: refused)' : m.present ? '' : ' (missing)'}`}
              tone={m.cloud ? 'bad' : m.present ? 'ok' : 'warn'} />
          ))}
          {pair.cloudModelsListed > 0 && (
            <Row k="Cloud models in PAIR" v={`${pair.cloudModelsListed} listed, never used`} tone="warn" />
          )}
        </>
      )}
    </section>
  );
}

const FEATURES: [string, string][] = [
  ['gpu_compositing', 'Compositing'],
  ['rasterization', 'Rasterization'],
  ['video_decode', 'Video decode'],
  ['canvas_oop_rasterization', 'Canvas'],
  ['webgl2', 'WebGL 2'],
];

export function Overview({ ctx, reloadHealth }: { ctx: Ctx; reloadHealth(): void }) {
  const { meta, shell } = ctx;
  return (
    <div className="grid">
      <PairCard pair={ctx.pair} error={ctx.pairError} reload={reloadHealth} />
      <section className="card">
        <h2>Dashboard</h2>
        {meta ? (
          <>
            <Row k="Mode" v={meta.mode === 'fixture' ? 'Fixture (synthetic data)' : 'Your library'} tone={meta.mode === 'fixture' ? 'warn' : undefined} />
            <Row k="Version" v={meta.version} />
            <Row k="Server" v={`Node ${meta.node} · pid ${meta.pid}`} />
            <Row k="Up for" v={duration(meta.uptimeS)} />
            <Row k="Live updates" v={ctx.connected ? 'connected' : 'reconnecting…'} tone={ctx.connected ? 'ok' : 'warn'} />
          </>
        ) : <p className="muted">Loading…</p>}
      </section>
      <section className="card">
        <h2>Window and GPU</h2>
        {shell ? (
          <>
            <Row k="Electron" v={`${shell.electron} (Chromium ${shell.chrome.split('.')[0]})`} />
            <Row k="GPU" v={`${shell.gpuDevice?.vendor ?? 'unknown'} · chosen: ${shell.gpuChoice}`} />
            {FEATURES.map(([key, label]) => {
              const s = shell.gpuFeatures[key];
              return s === undefined ? null : (
                <Row key={key} k={label} v={s.replaceAll('_', ' ')} tone={s.startsWith('enabled') ? 'ok' : 'warn'} />
              );
            })}
          </>
        ) : <p className="muted">Open the dashboard with dashboard.ps1 to see hardware acceleration.</p>}
      </section>
      <section className="card">
        <h2>Coming next</h2>
        <ul className="plain">
          <li><b>P1</b> Sort, Group and Index jobs with live progress, safe cancel, apply-preview and undo</li>
          <li><b>P2</b> Search and a fast gallery with thumbnails and video playback</li>
          <li><b>P3</b> Runs history, PAIR cluster view and the full privacy audit</li>
          <li><b>P4</b> Faces, settings editor and polish</li>
        </ul>
      </section>
    </div>
  );
}
