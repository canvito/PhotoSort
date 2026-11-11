// Runs & Undo: every run in the journals of known folders (from the dashboard or a terminal alike), plus the
// dashboard jobs that leave no run of their own (index, undo). A run opens with its files and its next steps.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  ACTIVE, api, duration, errorText, useJobEvents, usePoll, when,
  type DirInfo, type FolderRow, type JobView, type RunItem, type RunItems, type RunRow,
} from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { useRecentFolders, useStart } from '../components/forms.tsx';
import { CountBars, Row, Segmented, StatusBadge } from '../components/ui.tsx';
import { Icon } from '../icons.tsx';
import { jobTitle, useJobs } from '../jobs.ts';

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
const LABEL: Record<string, string> = { sort: 'Sort', group: 'Group', apply: 'Apply', index: 'Index', undo: 'Undo' };

/** One short line about what a finished job did. */
export function outcome(j: JobView): string {
  const s = j.summary;
  if (!s) return j.status === 'queued' ? `#${j.position || 1} in the queue` : `${j.done.toLocaleString()} files`;
  switch (j.kind) {
    case 'sort': return `${n(s.sorted).toLocaleString()} ${j.params.action === 'report' ? 'would be sorted' : 'sorted'}`;
    case 'group': return `${n(s.matched).toLocaleString()} matched`;
    case 'index': return `${n(s.captioned).toLocaleString()} described, ${n(s.unchanged).toLocaleString()} unchanged`;
    case 'undo': return `${n(s.restored).toLocaleString()} ${j.params.dryRun ? 'would move back' : 'moved back'}${n(s.problems) ? `, ${n(s.problems)} problems` : ''}`;
    case 'apply': return `${n(s.applied).toLocaleString()} ${j.params.action === 'copy' ? 'copied' : 'moved'}${n(s.changed) ? `, ${n(s.changed)} changed` : ''}`;
  }
}

/** "Sort (move)", "Group preview", "Apply sort preview (copy)", "Undo preview", … */
export function runTitle(r: RunRow): string {
  if (r.kind === 'undo') return r.action === 'preview' ? 'Undo preview' : 'Undo';
  if (r.kind === 'index') return 'Index';
  if (r.kind === 'apply') return `Apply${r.of ? ` ${r.of}` : ''} preview (${r.action ?? 'move'})`;
  const k = LABEL[r.kind] ?? r.kind;
  return r.action === 'report' ? `${k} preview` : r.action ? `${k} (${r.action})` : k;
}

/** Files a preview picked (what an apply would move). */
const picked = (r: RunRow): number => (r.kind === 'group' ? r.matched : sum(r.buckets));

function runResult(r: RunRow, job?: JobView): string {
  if (r.origin === 'job') return job ? outcome(job) : `${r.done.toLocaleString()} files`;
  const parts: string[] = [];
  if (r.action === 'report') parts.push(r.kind === 'group' ? `${r.matched.toLocaleString()} matched` : `${picked(r).toLocaleString()} would be sorted`);
  else {
    if (r.kind === 'group') parts.push(`${r.matched.toLocaleString()} matched`);
    parts.push(`${r.done.toLocaleString()} ${r.action === 'copy' ? 'copied' : 'moved'}`);
  }
  if (r.undone) parts.push(`undone, ${n(r.undone.restored ?? r.restored).toLocaleString()} moved back`);
  else if (r.restored) parts.push(`${r.restored.toLocaleString()} moved back`);
  if (r.appliedBy.length) parts.push('applied');
  return parts.join(' · ');
}

function RunState({ r, job }: { r: RunRow; job?: JobView }) {
  const status = job?.status ?? r.jobStatus;
  if (status && ACTIVE.has(status)) return <StatusBadge status={status} />;
  if (r.undone) return <span className="status muted">Undone</span>;
  if (status) return <StatusBadge status={status} />;
  return r.errors ? <span className="status warn">Done with errors</span> : <span className="status ok">Done</span>;
}

const runDuration = (r: RunRow): string =>
  r.durationS === undefined || r.durationS === null ? '—' : `${r.durationExact ? '' : '≈ '}${duration(r.durationS)}`;

const runHref = (r: RunRow): string => (r.origin === 'job' ? `/jobs/${r.jobId}` : `/runs/${r.key}`);

interface RunList {
  runs: RunRow[];
  folders: FolderRow[];
}

/** The run list; reloads when a job starts or finishes (a journal changed). */
function useRunList() {
  const res = usePoll<RunList>('/api/runs', 30000);
  const reload = useRef(res.reload);
  reload.current = res.reload;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useJobEvents((ev) => {
    if (ev.type === 'started' || ev.type === 'finished' || ev.type === 'reconnected') {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => reload.current(), 400);
    }
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  return res;
}

type KindFilter = '' | 'sort' | 'group' | 'apply' | 'index' | 'undo';
type OriginFilter = '' | 'dashboard' | 'terminal';
const KINDS: { value: KindFilter; label: string }[] = [
  { value: '', label: 'All' }, { value: 'sort', label: 'Sort' }, { value: 'group', label: 'Group' },
  { value: 'apply', label: 'Apply' }, { value: 'index', label: 'Index' }, { value: 'undo', label: 'Undo' },
];
const ORIGINS: { value: OriginFilter; label: string }[] = [
  { value: '', label: 'Anywhere' }, { value: 'dashboard', label: 'Dashboard' }, { value: 'terminal', label: 'Terminal' },
];

function Folders({ folders, reload }: { folders: FolderRow[]; reload(): void }) {
  const recent = useRecentFolders();
  const [adding, setAdding] = useState<DirInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-head"><h2>Folders with runs</h2></div>
      <p className="muted small">Runs are read from each folder’s <code>_photosort_journal.jsonl</code>. Folders the dashboard ran in
        are listed on their own; add a folder you sorted or grouped from a terminal to see and undo its runs here.</p>
      {folders.length > 0 && (
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.dirId}>
              <Icon name="folder" size={16} />
              <span className="name" title={f.path}>{f.name}</span>
              <span className="muted small">{f.error ? <span className="bad">{f.error}</span>
                : !f.journal ? 'no journal yet' : `${f.runs.toLocaleString()} run${f.runs === 1 ? '' : 's'}`}</span>
              {f.registered ? (
                <button type="button" className="ghost icon" disabled={busy} title="Stop listing this folder (its journal stays)"
                  aria-label={`Stop listing ${f.name}`}
                  onClick={() => void act(() => api(`/api/folders/${f.dirId}`, { method: 'DELETE' }))}>
                  <Icon name="x" size={14} />
                </button>
              ) : <span className="muted small" title="Listed because a dashboard job ran here">from jobs</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="folder-add">
        <FolderPicker label="Add a folder" value={adding} onChange={setAdding} recent={recent} optional
          hint="The folder that holds the journal: the folder that was sorted or grouped (for a sort with a separate destination, that destination)." />
        <div className="actions">
          <button type="button" className="primary" disabled={!adding || busy}
            onClick={() => void act(async () => {
              await api('/api/folders', { method: 'POST', body: { dir: adding!.dirId } });
              setAdding(undefined);
            })}>Add folder</button>
        </div>
      </div>
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

export function RunsPage() {
  const { data, error, loading, reload } = useRunList();
  const { list } = useJobs();
  const [kind, setKind] = useState<KindFilter>('');
  const [origin, setOrigin] = useState<OriginFilter>('');
  const jobsById = useMemo(() => new Map((list?.jobs ?? []).map((j) => [j.id, j])), [list]);
  const runs = useMemo(() => (data?.runs ?? []).filter((r) =>
    (!kind || r.kind === kind) && (!origin || (origin === 'terminal') === r.terminal)), [data, kind, origin]);
  const conflicts = (data?.folders ?? []).filter((f) => f.conflicts.length);
  return (
    <div className="stack wide">
      {conflicts.map((f) => (
        <div key={f.dirId} className="card notice warn" role="status">
          <Icon name="alert" size={16} />
          <div>
            <b>Another copy of the journal in {f.name}</b>
            <p className="muted small">OneDrive kept {f.conflicts.map((c) => `${c.name} (${c.runs} run${c.runs === 1 ? '' : 's'})`).join(', ')}:
              a journal written on another PC at the same time. Its runs are not listed here. Undo them from a terminal
              with <code>photosort.cmd undo "&lt;that file&gt;"</code>, then delete the copy.</p>
          </div>
        </div>
      ))}
      <section className="card">
        <div className="card-head">
          <h2>All runs</h2>
          <div className="controls">
            <Segmented<KindFilter> label="Kind" value={kind} onChange={setKind} options={KINDS} />
            <Segmented<OriginFilter> label="Started from" value={origin} onChange={setOrigin} options={ORIGINS} />
            <button type="button" className="ghost icon" onClick={reload} disabled={loading} title="Read the journals again" aria-label="Reload">
              <Icon name="refresh" size={14} />
            </button>
          </div>
        </div>
        {error && <p className="bad small">{error}</p>}
        {!data && !error && <p className="muted small">Reading journals…</p>}
        {data && !runs.length && <p className="muted small">{data.runs.length ? 'No runs match.' : 'No runs yet.'}</p>}
        {runs.length > 0 && (
          <div className="runs" role="table" aria-label="Runs">
            <div className="runs-row thead" role="row">
              <span role="columnheader">Run</span><span role="columnheader">Folder</span><span role="columnheader">Started</span>
              <span role="columnheader">Duration</span><span role="columnheader">Status</span><span role="columnheader">Result</span>
            </div>
            {runs.map((r) => {
              const job = r.jobId ? jobsById.get(r.jobId) : undefined;
              return (
                <Link key={r.key} href={runHref(r)} className="runs-row" role="row">
                  <span role="cell" className="name">
                    {r.origin === 'job' && job ? jobTitle(job) : runTitle(r)}
                    {r.terminal && <span className="tag" title="Started from a terminal">terminal</span>}
                  </span>
                  <span role="cell" className="name" title={r.folder?.path}>{r.folder?.name ?? ''}</span>
                  <span role="cell" className="muted">{when(r.startedAt)}</span>
                  <span role="cell" title={r.durationExact ? undefined : 'From the journal’s timestamps (whole seconds)'}>{runDuration(r)}</span>
                  <span role="cell"><RunState r={r} job={job} /></span>
                  <span role="cell" className="name">{runResult(r, job)}{r.errors > 0 ? <span className="bad"> · {r.errors} errors</span> : null}</span>
                </Link>
              );
            })}
          </div>
        )}
        <p className="muted small">Runs from every listed folder’s journal, newest first, plus the dashboard’s index and undo jobs.
          Durations marked ≈ come from the journal (whole seconds).</p>
      </section>
      {data && <Folders folders={data.folders} reload={reload} />}
    </div>
  );
}

function itemResult(it: RunItem): { text: string; tone?: 'bad' | 'muted' } {
  if (it.error) return { text: 'error', tone: 'bad' };
  if (it.bucket) return { text: it.bucket };
  if (it.match === true) return { text: 'match' };
  if (it.match === false) return { text: 'no match', tone: 'muted' };
  return { text: '—', tone: 'muted' };
}

const parentName = (p: string): string => p.split(/[\\/]/).slice(-2, -1)[0] ?? '';

// ---------- one run ----------

const PAGE = 200;

function RunFiles({ runKey, total }: { runKey: string; total: number }) {
  const [offset, setOffset] = useState(0);
  const page = usePoll<RunItems>(`/api/runs/${runKey}/items?offset=${offset}&limit=${PAGE}`);
  const items = page.data?.items ?? [];
  const count = page.data?.total ?? total;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Files</h2>
        {count > PAGE && (
          <div className="controls">
            <button type="button" className="ghost" disabled={offset === 0 || page.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
            <span className="muted small">{(offset + 1).toLocaleString()}–{Math.min(count, offset + PAGE).toLocaleString()} of {count.toLocaleString()}</span>
            <button type="button" className="ghost" disabled={offset + PAGE >= count || page.loading} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        )}
      </div>
      {page.error && <p className="bad small">{page.error}</p>}
      {!page.data && !page.error && <p className="muted small">Loading…</p>}
      {page.data && !items.length && <p className="muted small">No files in this run.</p>}
      {items.length > 0 && (
        <div className="runs run-files" role="table" aria-label="Files of this run" aria-busy={page.loading}>
          <div className="runs-row thead" role="row">
            <span role="columnheader">#</span><span role="columnheader">File</span><span role="columnheader">Result</span>
            <span role="columnheader">Moved to</span><span role="columnheader">Note</span>
          </div>
          {items.map((it) => {
            const res = itemResult(it);
            return (
              <div key={it.n} className={`runs-row${it.error ? ' err' : ''}`} role="row">
                <span role="cell" className="muted">{it.n}</span>
                <span role="cell" className="name" title={it.src}>{it.name}</span>
                <span role="cell" className={`name${res.tone ? ` ${res.tone}` : ''}`}
                  title={typeof it.confidence === 'number' ? `confidence ${it.confidence}` : undefined}>{res.text}</span>
                <span role="cell" className="name" title={it.dst ?? undefined}>{it.dst ? parentName(it.dst) : '—'}</span>
                <span role="cell" className="name" title={it.error ?? undefined}>
                  {it.error ? <span className="bad">{it.error}</span> : it.restored ? <span className="muted">moved back</span> : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RunSteps({ run }: { run: RunRow }) {
  const { start, busy, error } = useStart();
  const folder = run.folder?.dirId;
  const count = picked(run);
  const go = (kind: 'apply' | 'undo', params: Record<string, unknown>, ask?: string) => {
    if (!folder || !run.runId || (ask && !confirm(ask))) return;
    void start(kind, { folder, runId: run.runId, ...params });
  };
  const steps = [];
  if (run.canApply && count > 0) {
    steps.push(
      <button type="button" key="move" className="primary" disabled={busy}
        onClick={() => go('apply', { action: 'move' },
          `Move these ${count} files exactly as the preview found them?\n\nThe model is not asked again. A file that changed since the preview is left where it is and reported.`)}>
        <Icon name="play" size={14} /> Move these {count.toLocaleString()} files
      </button>,
      <button type="button" key="copy" className="ghost" disabled={busy}
        onClick={() => go('apply', { action: 'copy' }, `Copy these ${count} files exactly as the preview found them? The originals stay where they are.`)}>
        Copy instead
      </button>,
    );
  }
  if (run.canUndo) {
    steps.push(
      <button type="button" key="undo" className={steps.length ? 'ghost' : 'primary'} disabled={busy} onClick={() => go('undo', { dryRun: true })}
        title="First shows what would be moved back; nothing moves until you confirm">
        <Icon name="undo" size={14} /> Undo this run…
      </button>,
    );
  }
  if (run.jobId) steps.push(<Link key="job" href={`/jobs/${run.jobId}`} className="ghost">Open the dashboard job</Link>);
  return (
    <>
      {steps.length > 0 && <div className="actions">{steps}</div>}
      {error && <p className="bad small">{error}</p>}
      {!run.canUndo && !run.canApply && run.action === 'move' && !run.undone && run.done <= run.restored && (
        <p className="muted small">Every moved file is already back.</p>
      )}
      {run.action === 'report' && !run.canApply && run.appliedBy.length > 0 && (
        <p className="muted small">This preview was already applied; undo that run to apply it again.</p>
      )}
    </>
  );
}

export function RunPage({ runKey }: { runKey: string }) {
  const [run, setRun] = useState<RunRow>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api<{ run: RunRow }>(`/api/runs/${runKey}`).then((r) => { setRun(r.run); setError(undefined); }, (e: unknown) => setError(errorText(e)));
  }, [runKey]);
  useEffect(load, [load]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useJobEvents((ev) => {
    if (ev.type === 'finished' || ev.type === 'reconnected') {
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 400);
    }
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  if (error && !run) {
    return (
      <section className="card narrow" role="alert">
        <h2>Run not found</h2>
        <p className="bad small">{error}</p>
        <p className="muted small">Run links last until the dashboard restarts, and a run disappears if its journal is edited or moved.</p>
        <Link href="/runs">Back to all runs</Link>
      </section>
    );
  }
  if (!run) return <p className="muted">Loading…</p>;
  return (
    <div className="stack wide">
      <section className="card">
        <div className="card-head">
          <h2>{runTitle(run)}{run.terminal && <span className="tag" title="Started from a terminal">terminal</span>}</h2>
          <RunState r={run} />
        </div>
        <p className="muted small"><Link href="/runs">← All runs</Link></p>
        <div className="stats">
          <div className="stat"><span className="k">Files</span><span className="v">{run.files.toLocaleString()}</span></div>
          {run.action !== 'report' && <div className="stat"><span className="k">{run.action === 'copy' ? 'Copied' : 'Moved'}</span><span className="v">{run.done.toLocaleString()}</span></div>}
          {(run.kind === 'group' || run.of === 'group') && <div className="stat"><span className="k">Matched</span><span className="v">{run.matched.toLocaleString()}</span></div>}
          {run.restored > 0 && <div className="stat"><span className="k">Moved back</span><span className="v">{run.restored.toLocaleString()}</span></div>}
          <div className="stat"><span className="k">Errors</span><span className={`v${run.errors ? ' bad' : ''}`}>{run.errors.toLocaleString()}</span></div>
          <div className="stat"><span className="k">Duration</span><span className="v">{runDuration(run)}</span></div>
        </div>
        <RunSteps run={run} />
        <div className="detail-rows">
          {run.folder && <Row k="Folder" v={<span title={run.folder.path}>{run.folder.path}</span>} />}
          <Row k="Started" v={run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'} />
          {run.endedAt && <Row k="Last file" v={new Date(run.endedAt).toLocaleString()} />}
          {run.model && <Row k="Model" v={run.model} />}
          {run.request && <Row k="Request" v={run.request} />}
          {run.group && <Row k="Group folder" v={run.group} />}
          {run.appliedFrom && <Row k="Applies preview" v={run.appliedFrom} />}
          {run.appliedBy.length > 0 && <Row k="Applied by" v={run.appliedBy.join(', ')} />}
          {run.undone && (
            <Row k="Undone" tone={run.undone.problems ? 'warn' : undefined}
              v={`${run.undone.at ? new Date(run.undone.at).toLocaleString() : ''} · ${n(run.undone.restored).toLocaleString()} moved back${run.undone.problems ? `, ${run.undone.problems} problems` : ''}`} />
          )}
          <Row k="Run id" v={<code>{run.runId}</code>} />
        </div>
        {Object.keys(run.buckets).length > 0 && (
          <>
            <h3 className="sub">Buckets</h3>
            <CountBars counts={run.buckets} />
          </>
        )}
      </section>
      <RunFiles runKey={runKey} total={run.files} />
    </div>
  );
}
