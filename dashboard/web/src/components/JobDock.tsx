// The bar at the bottom: the running job's progress, with Stop and the queue count; and a toast with the
// duration when a job finishes. File names and captions never appear here.
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, duration, useJobEvents, useTick, type JobStatus } from '../api.ts';
import { Icon } from '../icons.tsx';
import { jobFolder, jobTitle, KIND_LABEL, pace, STATUS, useJobs } from '../jobs.ts';
import { Progress, StatusBadge } from './ui.tsx';

interface Toast {
  id: string;
  title: string;
  status: JobStatus;
  durationS?: number;
}

export function JobDock() {
  const { list } = useJobs();
  const [location, navigate] = useLocation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const active = list?.jobs.find((j) => j.status === 'running' || j.status === 'cancelling');
  const queued = list?.queued ?? 0;
  useTick(!!active);

  useJobEvents((ev) => {
    if (ev.type !== 'finished' || ev.status === 'removed' || location === `/jobs/${ev.job}`) return;
    const j = list?.jobs.find((x) => x.id === ev.job);
    const t: Toast = { id: ev.job, title: j ? jobTitle(j) : KIND_LABEL[ev.kind], status: ev.status, durationS: ev.durationS };
    setToasts((all) => [...all.filter((x) => x.id !== t.id), t].slice(-3));
    setTimeout(() => setToasts((all) => all.filter((x) => x !== t)), 10000);
  });

  const p = active ? pace(active) : {};
  const folder = active ? jobFolder(active) : undefined;
  return (
    <>
      {(active || queued > 0) && (
        <div className="dock" role="status" aria-live="polite">
          {active ? (
            <>
              <StatusBadge status={active.status} />
              <Link href={`/jobs/${active.id}`} className="dock-title">{jobTitle(active)}{folder && <span className="muted"> · {folder.name}</span>}</Link>
              <span className="dock-stats">
                {active.phase && <span>{active.phase}</span>}
                <span>{active.done.toLocaleString()}{active.total ? ` / ${active.total.toLocaleString()}` : ''}</span>
                {active.errors > 0 && <span className="bad">{active.errors} errors</span>}
                {p.elapsedS !== undefined && <span>{duration(p.elapsedS)}</span>}
                {p.perMin !== undefined && <span>{Math.round(p.perMin)}/min</span>}
                {p.etaS !== undefined && <span>about {duration(p.etaS)} left</span>}
              </span>
              <div className="dock-progress"><Progress done={active.done} total={active.total} active /></div>
              {active.status === 'running' && (
                <button type="button" className="ghost" title="Stop safely: files already moved stay journaled; nothing is half-moved"
                  onClick={() => void api(`/api/jobs/${active.id}/cancel`, { method: 'POST', body: {} }).catch(() => undefined)}>
                  <Icon name="stop" size={14} /> Stop
                </button>
              )}
            </>
          ) : <span className="muted">Starting the next job…</span>}
          {queued > 0 && <Link href="/runs" className="muted small">{queued} waiting</Link>}
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <button type="button" key={t.id} className={`toast ${STATUS[t.status].tone}`} onClick={() => {
            setToasts((all) => all.filter((x) => x !== t));
            navigate(`/jobs/${t.id}`);
          }}>
            <b>{t.title}</b> {STATUS[t.status].label.toLowerCase()}
            {t.durationS !== undefined && <> in {duration(t.durationS)}</>}
            <span className="muted small"> · Open</span>
          </button>
        ))}
      </div>
    </>
  );
}
