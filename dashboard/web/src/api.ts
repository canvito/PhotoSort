// Talking to the local dashboard server. In the PhotoSort window the access token is added by the window
// itself (Electron main process), so the page never holds it.
import { useEffect, useRef, useState } from 'react';

export interface Meta {
  version: string;
  mode: 'real' | 'fixture';
  node: string;
  pid: number;
  startedAt: string;
  uptimeS: number;
}

export interface PairHealth {
  reachable: boolean;
  ms: number;
  models: number;
  required: { name: string; role: string; present: boolean; cloud: boolean }[];
  cloudModelsListed: number;
  error?: string;
}

export interface ShellInfo {
  mode: string;
  electron: string;
  chrome: string;
  gpuChoice: string;
  gpuDevice?: { vendor: string; deviceId: string };
  gpuFeatures: Record<string, string>;
  protection: boolean;
  blockedRequests: number;
  /** The window's own processes, for the open-connections check. */
  pids?: number[];
}

export interface PythonInfo {
  ok: boolean;
  version?: string;
  heic?: boolean;
  video?: boolean;
  error?: string;
  ms: number;
}

export interface DirInfo {
  dirId: string;
  name: string;
  path: string;
}

export interface DirListing extends DirInfo {
  parent?: DirInfo;
  media: number;
  dirs: (DirInfo & { hasChildren: boolean; media: number })[];
  truncated: boolean;
}

export type JobKind = 'sort' | 'group' | 'index' | 'undo' | 'apply';
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'ok' | 'errors' | 'failed' | 'cancelled' | 'interrupted' | 'removed';
export const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running', 'cancelling']);

export interface JobMessage {
  level: 'warning' | 'error';
  text: string;
  kind?: string;
}

export interface JobItem {
  seq: number;
  n?: number;
  phase: string;
  path: string;
  name: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface Understood {
  topic?: string;
  media?: string;
  dates?: unknown;
  peopleIgnored?: unknown;
  group?: string;
}

export interface JobView {
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  folders: Record<string, DirInfo | { dirId?: undefined; name: string; path: string }>;
  journalDir?: DirInfo;
  cli: string;
  heavy: boolean;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationS?: number;
  exitCode?: number | null;
  cancelRequestedAt?: string;
  forced?: boolean;
  note?: string;
  phase?: string;
  phaseStartedAt?: string;
  done: number;
  total?: number;
  errors: number;
  counts: Record<string, number>;
  runId?: string;
  appliedFrom?: string;
  understood?: Understood;
  messages: JobMessage[];
  summary?: Record<string, unknown>;
  report?: string;
  seq: number;
  position: number;
}

/** What the server sends on the "job" stream. */
export interface JobEvent {
  type: string;
  job: string;
  kind: JobKind;
  status: JobStatus;
  ts: string;
  seq: number;
  phase?: string;
  done: number;
  total?: number;
  errors: number;
  counts: Record<string, number>;
  items?: JobItem[];
  message?: JobMessage;
  understood?: Understood;
  summary?: Record<string, unknown>;
  durationS?: number;
  startedAt?: string;
  finishedAt?: string;
  note?: string;
  runId?: string;
  position?: number;
}

export interface JobList {
  jobs: JobView[];
  running?: string;
  queued: number;
}

/** A run from a folder's journal (made by the dashboard or from a terminal), or a dashboard job with no run. */
export interface RunRow {
  /** `<dirId>~<runId>` for journal runs, `job~<id>` for jobs; dir ids change when the dashboard restarts. */
  key: string;
  origin: 'journal' | 'job';
  folder?: DirInfo;
  runId?: string;
  kind: string;
  of?: string | null;
  action?: string;
  model?: string | null;
  startedAt?: string;
  endedAt?: string;
  files: number;
  done: number;
  errors: number;
  matched: number;
  buckets: Record<string, number>;
  group?: string | null;
  request?: string | null;
  appliedFrom?: string | null;
  restored: number;
  undone?: { at?: string; restored?: number; problems?: number } | null;
  appliedBy: string[];
  canUndo: boolean;
  canApply: boolean;
  durationS?: number | null;
  durationExact: boolean;
  jobId?: string;
  jobStatus?: JobStatus;
  terminal: boolean;
}

export interface FolderRow extends DirInfo {
  registered: boolean;
  fromJobs: boolean;
  journal: boolean;
  runs: number;
  conflicts: { name: string; runs: number }[];
  error?: string;
}

export interface RunItem {
  n: number;
  src: string;
  name: string;
  dst?: string | null;
  bucket?: string | null;
  group?: string | null;
  match?: boolean | null;
  confidence?: number | null;
  error?: string | null;
  restored: boolean;
}

export interface RunItems {
  run_id: string;
  total: number;
  offset: number;
  items: RunItem[];
}

export type TargetClass = 'lan' | 'loopback' | 'cluster' | 'blank' | 'public';

export interface PairNode {
  id: string;
  name: string;
  ip?: string;
  state?: string;
  lastSeen?: string;
  self: boolean;
  member: boolean;
  stale: boolean;
  lastActivity?: string;
  engineHealthy?: boolean;
  engineRunning?: boolean;
  engineCheckedAt?: string;
  models?: string[];
  requests: number;
  perMin: number;
  p50?: number;
  p95?: number;
  ttfbP50?: number;
  errors: number;
  errorRate?: number;
  share: number;
}

export interface PairLogStatus {
  found: boolean;
  format: 'ok' | 'unrecognized' | 'empty';
  lines: number;
}

export interface PairNodes {
  status: PairLogStatus;
  window: string;
  nodes: PairNode[];
}

export interface PairStats {
  window: string;
  start: string;
  binS: number;
  series: { name: string; counts: number[] }[];
  p50: (number | null)[];
  p95: (number | null)[];
  total: number;
  errors: number;
  overallP50?: number;
  overallP95?: number;
}

export interface PairAlert {
  t: string;
  kind: 'public_target' | 'this_pc';
  node: string;
  target: string;
  path: string;
}

export interface PairAudit extends PairLogStatus {
  firstT?: string;
  lastT?: string;
  day: { counts: Record<TargetClass, number>; alerts: number };
  all: { counts: Record<TargetClass, number>; alerts: number };
  recentAlerts: PairAlert[];
}

export interface PairModels {
  reachable: boolean;
  error?: string;
  models: { name: string; size?: number; cloud: boolean; used: boolean; family?: string; parameterSize?: string; quantization?: string }[];
  loaded: { name: string; size?: number; sizeVram?: number; expiresAt?: string }[];
}

export interface PrivacyCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'bad' | 'unknown';
  detail: string;
}

export interface PrivacyReport {
  checkedAt: string;
  host: string;
  checks: PrivacyCheck[];
}

export type ConnClass = 'loopback' | 'lan' | 'listening' | 'exposed' | 'bad';

export interface Connections {
  checkedAt: string;
  processes: { pid: number; role: string }[];
  connections: { pid: number; role: string; local: string; remote: string; state: string; cls: ConnClass }[];
  summary: Record<ConnClass, number>;
}

/** What the server sends on the "pair" stream. */
export interface PairEvent {
  type: 'alert' | 'reconnected';
  alert?: PairAlert;
}

declare global {
  interface Window {
    photosort?: {
      info(): Promise<ShellInfo>;
      setProtection(on: boolean): Promise<ShellInfo>;
    };
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: { method?: 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
    cache: 'no-store',
  });
  if (r.status === 401) throw new ApiError(401, 'Open the dashboard with dashboard.ps1: its window adds the access token.');
  let data: unknown;
  try {
    data = await r.json();
  } catch (e) {
    // An abort while the body is read stays an abort; it must never turn into an empty reply that callers use.
    if (init?.signal?.aborted) throw e;
    if (r.ok) throw new ApiError(r.status, 'The dashboard server sent an unreadable reply. Try again.');
    data = {};
  }
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload(): void;
}

/** Fetches `path` now and every `everyMs` (0 = once); keeps the last good value while reloading. */
export function usePoll<T>(path: string, everyMs = 0): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    api<T>(path, { signal: ctrl.signal })
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ data, loading: false });
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false }));
      });
    const t = everyMs > 0 ? setTimeout(() => setTick((n) => n + 1), everyMs) : undefined;
    return () => {
      ctrl.abort();
      if (t) clearTimeout(t);
    };
  }, [path, everyMs, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export interface SysEvent {
  type: string;
  [k: string]: unknown;
}

/** What the server sends on the "index" stream: the search vectors loading into memory, or the index changed. */
export interface IndexEvent {
  type: 'loading' | 'changed' | 'reconnected';
  done?: number;
  total?: number;
  generation?: number;
}

// Job and index events go to whoever listens (job page, dock, lists, gallery) through buses, so the app keeps a
// single stream.
const jobBus = new EventTarget();
const indexBus = new EventTarget();
const pairBus = new EventTarget();

/** Calls `cb` for every PAIR routing alert (a request sent off the LAN or to this PC), and after reconnects. */
export function usePairEvents(cb: (e: PairEvent) => void): void {
  const handler = useRef(cb);
  handler.current = cb;
  useEffect(() => {
    const on = (e: Event) => handler.current((e as CustomEvent<PairEvent>).detail);
    pairBus.addEventListener('pair', on);
    return () => pairBus.removeEventListener('pair', on);
  }, []);
}

/** Calls `cb` for every index event, and with `{type: 'reconnected'}` after the stream reconnects. */
export function useIndexEvents(cb: (e: IndexEvent) => void): void {
  const handler = useRef(cb);
  handler.current = cb;
  useEffect(() => {
    const on = (e: Event) => handler.current((e as CustomEvent<IndexEvent>).detail);
    indexBus.addEventListener('index', on);
    return () => indexBus.removeEventListener('index', on);
  }, []);
}

/** Calls `cb` for every job event, and with `{type: 'reconnected'}` after the stream reconnects (events may have
 * been missed, so listeners reload). */
export function useJobEvents(cb: (e: JobEvent) => void): void {
  const handler = useRef(cb);
  handler.current = cb;
  useEffect(() => {
    const on = (e: Event) => handler.current((e as CustomEvent<JobEvent>).detail);
    jobBus.addEventListener('job', on);
    return () => jobBus.removeEventListener('job', on);
  }, []);
}

/** One EventSource for the whole app; reconnects on its own and resumes after the last event id. */
export function useServerEvents(onSys: (e: SysEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onSys);
  handler.current = onSys;
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let opened = false;
    es.onopen = () => {
      setConnected(true);
      if (opened) {
        jobBus.dispatchEvent(new CustomEvent('job', { detail: { type: 'reconnected' } }));
        indexBus.dispatchEvent(new CustomEvent('index', { detail: { type: 'reconnected' } }));
        pairBus.dispatchEvent(new CustomEvent('pair', { detail: { type: 'reconnected' } }));
      }
      opened = true;
    };
    es.onerror = () => setConnected(false);
    es.addEventListener('sys', (m) => {
      try {
        handler.current(JSON.parse((m as MessageEvent<string>).data) as SysEvent);
      } catch {
        /* ignore malformed events */
      }
    });
    es.addEventListener('job', (m) => {
      let detail: JobEvent;
      try {
        detail = JSON.parse((m as MessageEvent<string>).data) as JobEvent;
      } catch {
        return;
      }
      jobBus.dispatchEvent(new CustomEvent('job', { detail }));
    });
    es.addEventListener('index', (m) => {
      let detail: IndexEvent;
      try {
        detail = JSON.parse((m as MessageEvent<string>).data) as IndexEvent;
      } catch {
        return;
      }
      indexBus.dispatchEvent(new CustomEvent('index', { detail }));
    });
    es.addEventListener('pair', (m) => {
      let detail: PairEvent;
      try {
        detail = JSON.parse((m as MessageEvent<string>).data) as PairEvent;
      } catch {
        return;
      }
      pairBus.dispatchEvent(new CustomEvent('pair', { detail }));
    });
    return () => es.close();
  }, []);
  return connected;
}

export function useShellInfo(everyMs = 5000): [ShellInfo | undefined, (s: ShellInfo) => void] {
  const [info, setInfo] = useState<ShellInfo>();
  useEffect(() => {
    if (!window.photosort) return;
    let alive = true;
    const load = () => window.photosort?.info().then((i) => alive && setInfo(i), () => undefined);
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return [info, setInfo];
}

export function duration(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Re-renders every `ms` while `on` (elapsed times of running jobs). */
export function useTick(on: boolean, ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return n;
}
