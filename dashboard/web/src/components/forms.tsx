// What the Sort, Group and Index forms share: pre-filling from an earlier job ("Edit and run again"), recent
// folders, starting the job, and the list of recent jobs of that kind.
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { api, duration, errorText, when, type DirInfo, type JobKind, type JobView } from '../api.ts';
import { jobFolder, jobTitle, startJob, useJobs } from '../jobs.ts';
import { StatusBadge } from './ui.tsx';

/** Job parameters without the empty ones (unset, unchecked, blank or 0 mean "the default"). */
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && v !== '' && v !== 0));
}

/** The job named by `?job=` (to edit and run again), and the other query values. */
export function usePrefill(): { from?: JobView; query: URLSearchParams; loading: boolean } {
  const search = useSearch();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const id = query.get('job');
  const [from, setFrom] = useState<JobView>();
  const [loading, setLoading] = useState(!!id);
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api<JobView>(`/api/jobs/${encodeURIComponent(id)}`).then(setFrom, () => undefined).finally(() => setLoading(false));
  }, [id]);
  return { from, query, loading };
}

/** A folder of an earlier job, if the server still knows it. */
export function folderOf(j: JobView | undefined, role: string): DirInfo | undefined {
  const f = j?.folders[role];
  return f?.dirId ? (f as DirInfo) : undefined;
}

export function useRecentFolders(): DirInfo[] {
  const { list } = useJobs();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: DirInfo[] = [];
    for (const j of list?.jobs ?? []) {
      const f = j.folders.source;
      if (f?.dirId && !seen.has(f.path.toLowerCase())) {
        seen.add(f.path.toLowerCase());
        out.push(f as DirInfo);
      }
    }
    return out.slice(0, 6);
  }, [list]);
}

/** Starts the job and opens its page; returns the error text, if any. */
export function useStart(): { start(kind: JobKind, params: Record<string, unknown>): Promise<void>; busy: boolean; error?: string } {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return {
    busy,
    error,
    start: async (kind, params) => {
      setBusy(true);
      setError(undefined);
      try {
        navigate(`/jobs/${await startJob(kind, params)}`);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

export function RecentJobs({ kinds, title = 'Recent runs' }: { kinds: JobKind[]; title?: string }) {
  const { list } = useJobs();
  const jobs = (list?.jobs ?? []).filter((j) => kinds.includes(j.kind)).slice(0, 6);
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2><Link href="/runs" className="small">All runs</Link></div>
      {!list && <p className="muted small">Loading…</p>}
      {list && !jobs.length && <p className="muted small">None yet.</p>}
      <ul className="joblist">
        {jobs.map((j) => (
          <li key={j.id}>
            <Link href={`/jobs/${j.id}`}>
              <span className="jl-title">{jobTitle(j)}<span className="muted"> · {jobFolder(j)?.name ?? ''}</span></span>
              <StatusBadge status={j.status} />
              <span className="muted small">{when(j.startedAt ?? j.createdAt)}{j.durationS !== undefined ? ` · ${duration(j.durationS)}` : ''}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
