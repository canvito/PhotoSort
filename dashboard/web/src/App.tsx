import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { useServerEvents, usePoll, useShellInfo, type Meta, type PairHealth, type PythonInfo, type ShellInfo } from './api.ts';
import { JobDock } from './components/JobDock.tsx';
import { PageErrorBoundary } from './components/ui.tsx';
import { Icon } from './icons.tsx';
import { JobsContext, useJobListSource } from './jobs.ts';
import { ClusterPage } from './pages/Cluster.tsx';
import { GroupPage } from './pages/Group.tsx';
import { JobPage } from './pages/Job.tsx';
import { Overview } from './pages/Overview.tsx';
import { Placeholder } from './pages/Placeholder.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { RunPage, RunsPage } from './pages/Runs.tsx';
import { SearchPage } from './pages/Search.tsx';
import { SortPage } from './pages/Sort.tsx';

export const NAV = [
  { path: '/', label: 'Overview', icon: 'overview' },
  { path: '/sort', label: 'Sort', icon: 'sort' },
  { path: '/group', label: 'Group', icon: 'group' },
  { path: '/search', label: 'Search', icon: 'search' },
  { path: '/faces', label: 'Faces', icon: 'faces' },
  { path: '/runs', label: 'Runs & Undo', icon: 'runs' },
  { path: '/cluster', label: 'Cluster', icon: 'cluster' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
  { path: '/privacy', label: 'Privacy', icon: 'privacy' },
] as const;

export interface Ctx {
  meta?: Meta;
  pair?: PairHealth;
  pairError?: string;
  python?: PythonInfo;
  shell?: ShellInfo;
  connected: boolean;
}

/** A job or run page (shown under Runs). */
const isRunPage = (location: string): boolean => location.startsWith('/jobs/') || location.startsWith('/runs/');

/** The nav entry a location belongs to; job and run pages belong to Runs. */
function navOf(location: string): (typeof NAV)[number] | undefined {
  if (isRunPage(location)) return NAV.find((n) => n.path === '/runs');
  return NAV.find((n) => n.path === location);
}

function pairState(c: Ctx): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (c.pairError || !c.pair) return { tone: 'bad', text: c.pair ? 'PAIR error' : 'PAIR …' };
  if (!c.pair.reachable) return { tone: 'bad', text: 'PAIR down' };
  if (c.pair.required.some((m) => m.cloud)) return { tone: 'bad', text: 'Cloud model configured' };
  if (c.pair.required.some((m) => !m.present)) return { tone: 'warn', text: 'PAIR: model missing' };
  return { tone: 'ok', text: `PAIR · ${c.pair.models} models` };
}

export function App() {
  const [location] = useLocation();
  const meta = usePoll<Meta>('/api/meta', 30000);
  const health = usePoll<{ pair: PairHealth; python?: PythonInfo }>('/api/health', 10000);
  const jobs = useJobListSource();
  const [shell, setShell] = useShellInfo();
  const [stopped, setStopped] = useState(false);
  const [blur, setBlur] = useState(() => localStorage.getItem('blur') === '1');
  const connected = useServerEvents(useCallback((e) => { if (e.type === 'shutdown') setStopped(true); }, []));

  useEffect(() => {
    document.body.classList.toggle('blur-media', blur);
    localStorage.setItem('blur', blur ? '1' : '0');
  }, [blur]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setBlur((b) => !b);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctx: Ctx = { meta: meta.data, pair: health.data?.pair, pairError: health.error, python: health.data?.python, shell, connected };
  const pill = pairState(ctx);
  const here = navOf(location);
  const fixture = meta.data?.mode === 'fixture';
  const toggleProtection = async () => {
    if (window.photosort && shell) setShell(await window.photosort.setProtection(!shell.protection));
  };

  return (
    <JobsContext value={jobs}>
    <div className="app">
      <nav className="nav" aria-label="Pages">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          PhotoSort
        </div>
        {NAV.map((n) => (
          <Link key={n.path} href={n.path} className={`nav-item${here === n ? ' active' : ''}`}
            aria-current={here === n ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </Link>
        ))}
        <div className="nav-foot">
          {meta.data ? `v${meta.data.version}` : ''}
          <span className={`dot ${connected ? 'ok' : 'bad'}`} title={connected ? 'Live updates connected' : 'Live updates reconnecting'} />
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <h1>{isRunPage(location) ? 'Run' : here?.label ?? 'PhotoSort'}</h1>
          <div className="topbar-right">
            {fixture && <span className="badge fixture" title="Synthetic test data only">FIXTURE</span>}
            <Link href="/" className={`pill ${pill.tone}`} title={ctx.pair?.error ?? ctx.pairError ?? 'Local NVIDIA PAIR proxy'}>
              <span className={`dot ${pill.tone}`} />
              {pill.text}
            </Link>
            {shell && (
              <button type="button" className={`chip ${shell.protection ? 'on' : 'off'}`} onClick={toggleProtection}
                title="Content protection: screenshots, screen sharing and recording see a black window. It cannot stop a phone camera.">
                <Icon name="shield" size={16} />
                {shell.protection ? 'Protected' : 'Not protected'}
              </button>
            )}
            <button type="button" className={`chip ${blur ? 'on' : 'off'}`} onClick={() => setBlur((b) => !b)}
              title="Blur photos and captions (Ctrl+Shift+B)">
              <Icon name="blur" size={16} />
              Blur
            </button>
          </div>
        </header>
        {!window.photosort && <div className="banner warn">Opened outside the PhotoSort window: the network guard and content protection are off. Use dashboard.ps1 open.</div>}
        {stopped && <div className="banner bad">The dashboard server stopped. Start it again with dashboard.ps1.</div>}
        <main className="content">
          <PageErrorBoundary key={location}>
          <Switch>
            <Route path="/"><Overview ctx={ctx} reloadHealth={health.reload} /></Route>
            <Route path="/privacy"><Privacy ctx={ctx} /></Route>
            <Route path="/sort"><SortPage /></Route>
            <Route path="/group"><GroupPage /></Route>
            <Route path="/search"><SearchPage /></Route>
            <Route path="/faces"><Placeholder page="faces" /></Route>
            <Route path="/runs"><RunsPage /></Route>
            <Route path="/runs/:key">{(p) => <RunPage key={p.key} runKey={p.key} />}</Route>
            <Route path="/jobs/:id">{(p) => <JobPage key={p.id} id={p.id} />}</Route>
            <Route path="/cluster"><ClusterPage /></Route>
            <Route path="/settings"><Placeholder page="settings" /></Route>
            <Route><div className="card"><h2>Not found</h2><p>This page does not exist. <Link href="/">Back to Overview</Link></p></div></Route>
          </Switch>
          </PageErrorBoundary>
        </main>
        <JobDock />
      </div>
    </div>
    </JobsContext>
  );
}
