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

export async function api<T>(path: string, init?: { method?: 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const r = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
    cache: 'no-store',
  });
  if (r.status === 401) throw new ApiError(401, 'Open the dashboard with dashboard.ps1: its window adds the access token.');
  const data = await r.json().catch(() => ({}));
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
      .then((data) => setState({ data, loading: false }))
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

/** One EventSource for the whole app; reconnects on its own and resumes after the last event id. */
export function useServerEvents(onSys: (e: SysEvent) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onSys);
  handler.current = onSys;
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('sys', (m) => {
      try {
        handler.current(JSON.parse((m as MessageEvent<string>).data) as SysEvent);
      } catch {
        /* ignore malformed events */
      }
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
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
