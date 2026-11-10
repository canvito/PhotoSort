import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { duration, when, type DirInfo, type JobKind, type JobView } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { useRecentFolders, useStart } from '../components/forms.tsx';
import { Segmented, StatusBadge } from '../components/ui.tsx';
import { jobFolder, jobTitle, KIND_LABEL, useJobs } from '../jobs.ts';

type Filter = '' | JobKind;
const FILTERS: { value: Filter; label: string }[] = [
  { value: '', label: 'All' },
  ...(Object.keys(KIND_LABEL) as JobKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
];

const n = (v: unknown): number => (typeof v === 'number' ? v : 0);

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

function UndoFolder() {
  const recent = useRecentFolders();
  const [folder, setFolder] = useState<DirInfo>();
  const { start, busy, error } = useStart();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (folder) void start('undo', { folder: folder.dirId, dryRun: true });
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>Undo a folder’s last run</h2>
      <p className="muted small">Also for runs made from a terminal. First shows what would move back; nothing moves until you
        confirm on the next page.</p>
      <FolderPicker label="Folder with the run" value={folder} onChange={setFolder} recent={recent}
        hint="The folder that holds _photosort_journal.jsonl: the folder that was sorted or grouped (for a sort with a separate destination, that destination)." />
      {error && <p className="bad">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={!folder || busy}>Preview undo</button>
      </div>
    </form>
  );
}

export function RunsPage() {
  const { list, error } = useJobs();
  const [filter, setFilter] = useState<Filter>('');
  const jobs = useMemo(() => (list?.jobs ?? []).filter((j) => !filter || j.kind === filter), [list, filter]);
  return (
    <div className="stack wide">
      <section className="card">
        <div className="card-head">
          <h2>Dashboard runs</h2>
          <Segmented<Filter> label="Kind" value={filter} onChange={setFilter} options={FILTERS} />
        </div>
        {error && <p className="bad small">{error}</p>}
        {!list && !error && <p className="muted small">Loading…</p>}
        {list && !jobs.length && <p className="muted small">No runs yet.</p>}
        {jobs.length > 0 && (
          <div className="runs" role="table" aria-label="Runs">
            <div className="runs-row thead" role="row">
              <span role="columnheader">Run</span><span role="columnheader">Folder</span><span role="columnheader">Started</span>
              <span role="columnheader">Duration</span><span role="columnheader">Status</span><span role="columnheader">Result</span>
            </div>
            {jobs.map((j) => {
              const f = jobFolder(j);
              return (
                <Link key={j.id} href={`/jobs/${j.id}`} className="runs-row" role="row">
                  <span role="cell" className="name">{jobTitle(j)}</span>
                  <span role="cell" className="name" title={f?.path}>{f?.name ?? ''}</span>
                  <span role="cell" className="muted">{when(j.startedAt ?? j.createdAt)}</span>
                  <span role="cell">{j.durationS !== undefined ? duration(j.durationS) : '—'}</span>
                  <span role="cell"><StatusBadge status={j.status} /></span>
                  <span role="cell" className="name">{outcome(j)}{j.errors > 0 ? <span className="bad"> · {j.errors} errors</span> : null}</span>
                </Link>
              );
            })}
          </div>
        )}
        <p className="muted small">The last 100 dashboard runs. Runs made from a terminal appear here in a later update; undo them below.</p>
      </section>
      <UndoFolder />
    </div>
  );
}
