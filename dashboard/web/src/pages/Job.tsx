// One job: live progress, safe stop, what it found, and the next step (apply a preview, undo a run).
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { ACTIVE, api, duration, errorText, useTick, when, type JobKind, type JobView } from '../api.ts';
import { CliBox, CopyButton, CountBars, Progress, Row, StatusBadge } from '../components/ui.tsx';
import { ItemTable } from '../components/ItemTable.tsx';
import { Icon } from '../icons.tsx';
import { jobFolder, jobTitle, pace, startJob, useJob, type JobRows } from '../jobs.ts';

const FORCE_GRACE_S = 10;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function Controls({ job, onError }: { job: JobView; onError(e: string | undefined): void }) {
  useTick(job.status === 'cancelling');
  const call = (path: string, init: Parameters<typeof api>[1]) => {
    onError(undefined);
    api(path, init).catch((e: unknown) => onError(errorText(e)));
  };
  if (job.status === 'queued') {
    return <button type="button" className="ghost" onClick={() => call(`/api/jobs/${job.id}`, { method: 'DELETE' })}><Icon name="x" size={14} /> Remove from queue</button>;
  }
  if (job.status === 'running') {
    return (
      <button type="button" className="ghost" onClick={() => call(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: {} })}
        title="Finishes the file in progress, then stops. Every moved file is journaled, so undo still works.">
        <Icon name="stop" size={14} /> Stop safely
      </button>
    );
  }
  if (job.status !== 'cancelling') return null;
  const waited = job.cancelRequestedAt ? (Date.now() - Date.parse(job.cancelRequestedAt)) / 1000 : 0;
  const left = Math.ceil(FORCE_GRACE_S - waited);
  return (
    <span className="controls">
      <span className="muted small">Stopping after the file in progress…</span>
      <button type="button" className="ghost danger" disabled={left > 0}
        onClick={() => {
          if (confirm('Force stop ends PhotoSort at once. A file being moved at that moment may need checking in the journal.\n\nForce stop now?')) {
            call(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: { force: true } });
          }
        }}>
        Force stop{left > 0 ? ` (in ${left} s)` : ''}
      </button>
    </span>
  );
}

function Stat({ k, v }: { k: string; v: ReactNode }) {
  return <div className="stat"><span className="k">{k}</span><span className="v">{v}</span></div>;
}

/** Buttons for the step after a job: apply a preview, undo a run, or try again with changes. */
function NextSteps({ job, start, busy }: { job: JobView; start(kind: JobKind, params: Record<string, unknown>, ask?: string): void; busy: boolean }) {
  const [, navigate] = useLocation();
  const s = job.summary ?? {};
  const finished = job.status === 'ok' || job.status === 'errors';
  const steps: ReactNode[] = [];
  const editable = job.kind === 'sort' || job.kind === 'group' || job.kind === 'index';

  if ((job.kind === 'sort' || job.kind === 'group') && job.params.action === 'report' && finished && job.runId) {
    const n = job.kind === 'sort' ? num(s.sorted) : num(s.matched);
    if (n > 0) {
      steps.push(
        <button type="button" key="apply" className="primary" disabled={busy}
          onClick={() => start('apply', { job: job.id, action: 'move' },
            `Move these ${n} files exactly as the preview found them?\n\nThe model is not asked again. A file that changed since the preview is left where it is and reported.`)}>
          <Icon name="play" size={14} /> Move these {n} files
        </button>,
        <button type="button" key="copy" className="ghost" disabled={busy}
          onClick={() => start('apply', { job: job.id, action: 'copy' }, `Copy these ${n} files exactly as the preview found them? The originals stay where they are.`)}>
          Copy instead
        </button>,
      );
    }
  }
  const moved = (job.kind === 'sort' || job.kind === 'group' || job.kind === 'apply') && job.params.action === 'move';
  if (moved && job.runId && !ACTIVE.has(job.status)) {
    steps.push(
      <button type="button" key="undo" className="ghost" disabled={busy} onClick={() => start('undo', { job: job.id, dryRun: true })}
        title="First shows what would be moved back; nothing moves until you confirm">
        <Icon name="undo" size={14} /> Undo this run…
      </button>,
    );
  }
  if (job.kind === 'undo' && job.params.dryRun && finished && num(s.restored) > 0) {
    steps.push(
      <button type="button" key="undo-now" className="primary" disabled={busy}
        onClick={() => start('undo', { job: job.id }, `Move ${num(s.restored)} files back to where they were?`)}>
        <Icon name="undo" size={14} /> Move {num(s.restored)} files back now
      </button>,
    );
  }
  if (editable && !ACTIVE.has(job.status)) {
    steps.push(<button type="button" key="edit" className="ghost" onClick={() => navigate(`/${job.kind === 'index' ? 'search' : job.kind}?job=${job.id}`)}>Edit and run again</button>);
  }
  return steps.length ? <div className="actions">{steps}</div> : null;
}

/** For a refused group request or a locked folder: the CLI's message plus the fixes it suggests. */
function Fixes({ job }: { job: JobView }) {
  const [, navigate] = useLocation();
  const errs = job.messages.filter((m) => m.level === 'error');
  if (!errs.length || ACTIVE.has(job.status)) return null;
  const page = `/${job.kind === 'index' ? 'search' : job.kind}`;
  const fixes: ReactNode[] = [];
  const text = errs.map((m) => m.text).join('\n');
  if (job.kind === 'group') {
    for (const m of new Set([...text.matchAll(/--media (photos|videos|both)/g)].map((x) => x[1]))) {
      fixes.push(<button type="button" key={m} className="ghost" onClick={() => navigate(`${page}?job=${job.id}&media=${m}`)}>Retry with {m} only</button>);
    }
    if (/--from|dates/.test(text)) {
      fixes.push(<button type="button" key="dates" className="ghost" onClick={() => navigate(`${page}?job=${job.id}&advanced=1`)}>Set the dates…</button>);
    }
  }
  if (errs.some((m) => m.kind === 'locked') && (job.kind === 'sort' || job.kind === 'group' || job.kind === 'index')) {
    fixes.push(<button type="button" key="force" className="ghost" onClick={() => navigate(`${page}?job=${job.id}&force=1`)}>Run anyway…</button>);
  }
  return fixes.length ? <div className="actions">{fixes}</div> : null;
}

function Understood({ job }: { job: JobView }) {
  const u = job.understood;
  if (!u) return null;
  const people = Array.isArray(u.peopleIgnored) ? (u.peopleIgnored as string[]) : [];
  return (
    <section className="card">
      <h2>What PhotoSort understood</h2>
      <Row k="Looking for" v={u.topic || <span className="muted">anything (dates only)</span>} />
      <Row k="Files" v={String(u.media ?? 'both')} />
      <Row k="Dates" v={String(u.dates ?? 'any')} />
      {u.group && <Row k="Folder" v={<span title={u.group}>{u.group.split(/[\\/]/).at(-1)}</span>} />}
      {people.length > 0 && <Row k="Names ignored" v={people.join(', ')} tone="warn" />}
      <p className="muted small">The request is read by the local model on your PAIR nodes; nothing leaves your network.</p>
    </section>
  );
}

function Results({ job, rows }: { job: JobView; rows: JobRows }) {
  const [filter, setFilter] = useState<string>();
  const s = job.summary ?? {};
  const facts: [string, ReactNode][] = [];
  if (job.kind === 'group' && job.summary) {
    facts.push(['Matched', num(s.matched)], ['In the date range', num(s.in_range)], ['Other dates', num(s.other_dates)],
      ['No date', num(s.no_date)]);
    if (num(s.same_event_found)) facts.push(['Same event', num(s.same_event_found)]);
    if (num(s.already_in_group)) facts.push(['Already in the folder', num(s.already_in_group)]);
  }
  if (job.kind === 'index' && job.summary) {
    facts.push(['Files found', num(s.images)], ['Described now', num(s.captioned)], ['Reused (moved or duplicate)', num(s.reused)],
      ['Unchanged, skipped', num(s.unchanged)], ['Errors', num(s.errors)]);
  }
  if (job.kind === 'undo' && job.summary) {
    facts.push([job.params.dryRun ? 'Would move back' : 'Moved back', num(s.restored)], ['Problems', num(s.problems)]);
    if (num(s.already_restored)) facts.push(['Moved back earlier', num(s.already_restored)]);
  }
  if (job.kind === 'apply' && job.summary) {
    facts.push(['Planned', num(s.planned)], [job.params.action === 'copy' ? 'Copied' : 'Moved', num(s.applied)],
      ['Changed since the preview', num(s.changed)], ['Errors', num(s.errors)]);
  }
  const problems = Array.isArray(s.problem_files) ? (s.problem_files as [string, string, string][]) : [];
  const restorable = Array.isArray(s.restored_files) ? (s.restored_files as [string, string][]) : [];
  const showBars = Object.keys(job.counts).length > 0;
  if (!facts.length && !showBars && !rows.items.length && !problems.length && !restorable.length) return null;
  return (
    <section className="card">
      <h2>{job.kind === 'sort' ? 'Buckets' : job.kind === 'group' ? 'Matches' : 'Results'}</h2>
      {facts.length > 0 && <div className="stats">{facts.map(([k, v]) => <Stat key={k} k={k} v={v} />)}</div>}
      {showBars && <CountBars counts={job.counts} selected={filter} onSelect={rows.items.length ? setFilter : undefined} />}
      {rows.items.length > 0 && <ItemTable items={rows.items} older={rows.older} filter={filter} />}
      {job.kind === 'undo' && job.params.dryRun === true && restorable.length > 0 && (
        <details>
          <summary>{restorable.length} files would move back</summary>
          <ul className="paths">{restorable.slice(0, 500).map(([src, dst]) => <li key={dst} title={`${dst} → ${src}`}>{src}</li>)}</ul>
        </details>
      )}
      {problems.length > 0 && (
        <details open>
          <summary className="warn">{problems.length} files cannot be moved back</summary>
          <ul className="paths">{problems.slice(0, 500).map(([, dst, reason]) => <li key={dst}><span title={dst}>{dst.split(/[\\/]/).at(-1)}</span> <span className="muted">— {reason}</span></li>)}</ul>
        </details>
      )}
    </section>
  );
}

export function JobPage({ id }: { id: string }) {
  const { job, rows, error } = useJob(id);
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  useTick(job ? ACTIVE.has(job.status) : false);

  if (!job) {
    return error ? (
      <section className="card narrow"><h2>Job</h2><p className="bad">{error}</p><Link href="/runs">All runs</Link></section>
    ) : <p className="muted">Loading…</p>;
  }

  const start = (kind: JobKind, params: Record<string, unknown>, ask?: string) => {
    if (ask && !confirm(ask)) return;
    setBusy(true);
    setActionError(undefined);
    startJob(kind, params).then((next) => navigate(`/jobs/${next}`), (e: unknown) => setActionError(errorText(e))).finally(() => setBusy(false));
  };
  const active = ACTIVE.has(job.status);
  const p = pace(job);
  const folder = jobFolder(job);
  const preview = (job.kind === 'sort' || job.kind === 'group') && job.params.action === 'report';
  return (
    <div className="stack wide">
      <section className="card">
        <div className="card-head">
          <h2>{jobTitle(job)}{folder && <span className="muted" title={folder.path}> · {folder.name}</span>}</h2>
          <StatusBadge status={job.status} />
        </div>
        <Progress done={job.done} total={job.total} active={active} />
        <div className="stats">
          {job.phase && <Stat k="Step" v={job.phase.replace('_', ' ')} />}
          <Stat k="Files" v={`${job.done.toLocaleString()}${job.total ? ` / ${job.total.toLocaleString()}` : ''}`} />
          {job.errors > 0 && <Stat k="Errors" v={<span className="bad">{job.errors}</span>} />}
          {p.elapsedS !== undefined && <Stat k={active ? 'Elapsed' : 'Duration'} v={duration(job.durationS ?? p.elapsedS)} />}
          {p.perMin !== undefined && <Stat k="Speed" v={`${Math.round(p.perMin)} files/min`} />}
          {p.etaS !== undefined && <Stat k="Left" v={`about ${duration(p.etaS)}`} />}
          {job.status === 'queued' && <Stat k="Queue" v={job.position > 0 ? `#${job.position}` : 'next'} />}
          <Stat k="Started" v={when(job.startedAt ?? job.createdAt)} />
        </div>
        {preview && !active && <p className="muted small">This was a preview: no files were moved.</p>}
        {job.messages.length > 0 && (
          <ul className="messages">
            {job.messages.map((m, i) => <li key={i} className={m.level === 'error' ? 'bad' : 'warn'}>{m.text}</li>)}
          </ul>
        )}
        {job.note && <p className="muted small">{job.note}</p>}
        <div className="actions">
          <Controls job={job} onError={setActionError} />
        </div>
        <NextSteps job={job} start={start} busy={busy} />
        <Fixes job={job} />
        {actionError && <p className="bad small">{actionError}</p>}
        <CliBox cli={job.cli} />
      </section>
      {job.kind === 'group' && <Understood job={job} />}
      <Results job={job} rows={rows} />
      {job.report && (
        <section className="card">
          <div className="card-head"><h2>Report</h2><CopyButton text={job.report} /></div>
          <pre className="report">{job.report}</pre>
        </section>
      )}
    </div>
  );
}
