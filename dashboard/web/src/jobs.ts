// Jobs in the page: the job list (dock, Runs, Overview), one job with its live results, and starting jobs.
// The server pushes progress on the single SSE stream; these hooks merge it into what they fetched.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  api, errorText, useJobEvents, type JobEvent, type JobItem, type JobKind, type JobList, type JobStatus, type JobView,
} from './api.ts';

export const KIND_LABEL: Record<JobKind, string> = { sort: 'Sort', group: 'Group', index: 'Index', undo: 'Undo', apply: 'Apply preview' };

export const STATUS: Record<JobStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'run' }> = {
  queued: { label: 'Waiting', tone: 'muted' },
  running: { label: 'Running', tone: 'run' },
  cancelling: { label: 'Stopping…', tone: 'warn' },
  ok: { label: 'Done', tone: 'ok' },
  errors: { label: 'Done with errors', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  interrupted: { label: 'Interrupted', tone: 'bad' },
  removed: { label: 'Removed', tone: 'muted' },
};

/** "Sort preview", "Group (move)", "Undo preview", … */
export function jobTitle(j: Pick<JobView, 'kind' | 'params'>): string {
  const a = j.params.action;
  if (j.kind === 'undo') return j.params.dryRun ? 'Undo preview' : 'Undo';
  if (j.kind === 'apply') return a === 'copy' ? 'Apply preview (copy)' : 'Apply preview';
  if (j.kind === 'index') return 'Index';
  return a === 'report' ? `${KIND_LABEL[j.kind]} preview` : `${KIND_LABEL[j.kind]} (${String(a)})`;
}

export function jobFolder(j: Pick<JobView, 'folders'>): { name: string; path: string } | undefined {
  return j.folders.source ?? j.folders.folder;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The same outcome label the server tallies in `counts`. */
export function itemLabel(it: JobItem): string {
  if (it.error) return 'error';
  const r = it.result ?? {};
  return str(r.bucket)
    ?? (r.match === true ? (str(r.matched_by) ?? 'match') : r.match === false ? 'no match' : undefined)
    ?? str(r.status) ?? (str(r.from) ? 'restored' : str(r.dst) ? 'applied' : '—');
}

/** A job event applied to a job view. Older events (a fetch already saw them) are ignored. */
export function mergeEvent(v: JobView, ev: JobEvent): JobView {
  if (ev.job !== v.id || ev.seq < v.seq) return v;
  const n: JobView = { ...v, status: ev.status, phase: ev.phase, done: ev.done, total: ev.total, errors: ev.errors, counts: ev.counts, seq: ev.seq };
  switch (ev.type) {
    case 'queued':
      n.position = ev.position ?? n.position;
      break;
    case 'started':
      n.startedAt ??= ev.ts;
      n.position = 0;
      break;
    case 'phase':
      n.phaseStartedAt = ev.ts;
      break;
    case 'cancelling':
      n.cancelRequestedAt ??= ev.ts;
      break;
    case 'understood':
      n.understood = ev.understood;
      break;
    case 'warning':
      if (ev.message) n.messages = [...v.messages, ev.message].slice(-20);
      break;
    case 'finished':
      Object.assign(n, { durationS: ev.durationS, finishedAt: ev.finishedAt, note: ev.note, summary: ev.summary ?? v.summary,
        runId: ev.runId ?? v.runId, startedAt: ev.startedAt ?? v.startedAt });
      break;
    default:
      break;
  }
  return n;
}

/** Seconds since the job started, files per minute and seconds left, from the browser's clock. */
export function pace(j: JobView): { elapsedS?: number; perMin?: number; etaS?: number } {
  if (!j.startedAt) return {};
  const end = j.finishedAt ? Date.parse(j.finishedAt) : Date.now();
  const elapsedS = Math.max(0, (end - Date.parse(j.startedAt)) / 1000);
  if (j.finishedAt || !j.phaseStartedAt || j.done <= 0) return { elapsedS };
  const s = (Date.now() - Date.parse(j.phaseStartedAt)) / 1000;
  if (s <= 0) return { elapsedS };
  const perMin = (j.done / s) * 60;
  return { elapsedS, perMin, etaS: j.total ? Math.max(0, ((j.total - j.done) / j.done) * s) : undefined };
}

export async function startJob(kind: JobKind, params: Record<string, unknown>): Promise<string> {
  return (await api<{ jobId: string }>('/api/jobs', { method: 'POST', body: { kind, params } })).jobId;
}

/** The command a form would run (the server checks the input the same way it would for a job). */
export function useCliPreview(kind: JobKind, params: Record<string, unknown> | undefined): { cli?: string; error?: string } {
  const [out, setOut] = useState<{ cli?: string; error?: string }>({});
  const key = params ? JSON.stringify(params) : '';
  useEffect(() => {
    if (!key) {
      setOut({});
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ cli: string }>('/api/jobs/cli', { method: 'POST', body: { kind, params: JSON.parse(key) }, signal: ctrl.signal })
        .then((r) => setOut({ cli: r.cli }), (e: unknown) => { if (!ctrl.signal.aborted) setOut({ error: errorText(e) }); });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [kind, key]);
  return out;
}

// ---------- the job list, shared by the dock, Runs and Overview ----------

export interface Jobs {
  list?: JobList;
  error?: string;
  reload(): void;
}

export const JobsContext = createContext<Jobs>({ reload: () => undefined });
export const useJobs = (): Jobs => useContext(JobsContext);

const RELIST = new Set(['queued', 'started', 'finished', 'cancelling', 'reconnected']);

export function useJobListSource(): Jobs {
  const [list, setList] = useState<JobList>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(() => {
    api<JobList>('/api/jobs').then((l) => { setList(l); setError(undefined); }, (e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useJobEvents((ev) => {
    if (RELIST.has(ev.type)) {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 200);
    }
    if (ev.job) setList((l) => (l ? { ...l, jobs: l.jobs.map((j) => mergeEvent(j, ev)) } : l));
  });
  return { list, error, reload: load };
}

// ---------- one job ----------

const MAX_ROWS = 5000;

export interface JobRows {
  items: JobItem[];
  /** Earlier results that are not kept in the page (only the newest MAX_ROWS are). */
  older: number;
  lastSeq: number;
}

const NO_ROWS: JobRows = { items: [], older: 0, lastSeq: 0 };

function addRows(prev: JobRows, add: JobItem[]): JobRows {
  const fresh = add.filter((i) => i.seq > prev.lastSeq);
  if (!fresh.length) return prev;
  const items = prev.items.concat(fresh);
  const cut = Math.max(0, items.length - MAX_ROWS);
  return { items: cut ? items.slice(cut) : items, older: prev.older + cut, lastSeq: fresh[fresh.length - 1].seq };
}

export function useJob(id: string): { job?: JobView; rows: JobRows; error?: string; reload(): void } {
  const [job, setJob] = useState<JobView>();
  const [rows, setRows] = useState<JobRows>(NO_ROWS);
  const [error, setError] = useState<string>();
  // Events that arrive while a fetch is in flight wait here, then are merged.
  const sync = useRef<{ busy: boolean; buffer: JobEvent[]; gen: number }>({ busy: true, buffer: [], gen: 0 });

  const load = useCallback(async () => {
    const s = sync.current;
    const gen = ++s.gen;
    s.busy = true;
    s.buffer = [];
    try {
      const [view, page] = await Promise.all([
        api<JobView>(`/api/jobs/${id}`),
        api<{ items: JobItem[]; older: number }>(`/api/jobs/${id}/items?tail=1&limit=${MAX_ROWS}`),
      ]);
      if (gen !== s.gen) return;
      let r = addRows({ ...NO_ROWS, older: page.older }, page.items);
      let v = view;
      for (const ev of s.buffer) {
        v = mergeEvent(v, ev);
        if (ev.items) r = addRows(r, ev.items);
      }
      s.buffer = [];
      s.busy = false;
      setJob(v);
      setRows(r);
      setError(undefined);
    } catch (e) {
      if (gen === s.gen) {
        s.busy = false;
        setError(errorText(e));
      }
    }
  }, [id]);

  useJobEvents((ev) => {
    if (ev.type === 'reconnected') {
      void load();
      return;
    }
    if (ev.job !== id) return;
    if (sync.current.busy) {
      sync.current.buffer.push(ev);
      return;
    }
    setJob((v) => (v ? mergeEvent(v, ev) : v));
    if (ev.items) setRows((r) => addRows(r, ev.items!));
    // The finished event is light; the report and file lists come with the full job.
    if (ev.type === 'finished') {
      api<JobView>(`/api/jobs/${id}`).then(setJob, () => undefined);
    }
  });

  useEffect(() => {
    setJob(undefined);
    setRows(NO_ROWS);
    void load();
  }, [load]);

  return { job, rows, error, reload: () => void load() };
}
