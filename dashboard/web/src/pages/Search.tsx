import { useEffect, useState, type FormEvent } from 'react';
import type { DirInfo } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { compact, folderOf, RecentJobs, usePrefill, useRecentFolders, useStart } from '../components/forms.tsx';
import { CliBox, Field, NumberInput } from '../components/ui.tsx';
import { useCliPreview } from '../jobs.ts';

/** P1: indexing runs as a job here; searching the index comes in P2 (the CLI can search now). */
export function SearchPage() {
  const { from, query } = usePrefill();
  const recent = useRecentFolders();
  const [source, setSource] = useState<DirInfo>();
  const [limit, setLimit] = useState<number>();
  const [concurrency, setConcurrency] = useState<number>();
  const [force, setForce] = useState(false);
  const { start, busy, error } = useStart();

  useEffect(() => {
    if (from?.kind !== 'index') return;
    const p = from.params;
    setSource(folderOf(from, 'source'));
    setLimit(typeof p.limit === 'number' ? p.limit : undefined);
    setConcurrency(typeof p.concurrency === 'number' ? p.concurrency : undefined);
    setForce(query.get('force') === '1' || p.force === true);
  }, [from, query]);

  const params = source ? compact({ source: source.dirId, limit, concurrency, force }) : undefined;
  const preview = useCliPreview('index', params);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (params) void start('index', params);
  };

  return (
    <div className="page-grid">
      <div className="stack">
        <form className="card form" onSubmit={submit}>
          <h2>Index a folder for search</h2>
          <p className="muted small">A local model on your PAIR nodes describes each photo and video (subfolders included) and the
            descriptions are embedded for search. Files are only read, never changed. Files already indexed and unchanged are
            skipped, so running it again only does the new ones. The index stays on this PC
            (<code>%LOCALAPPDATA%\PhotoSort\search_index.sqlite</code> by default).</p>
          <FolderPicker label="Folder" value={source} onChange={setSource} recent={recent} />
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="fields">
              <Field label="Only the first" hint="0 or empty: all files">
                <NumberInput label="Limit" value={limit} onChange={setLimit} min={0} max={10_000_000} placeholder="all" />
              </Field>
              <Field label="Parallel requests" hint={concurrency && concurrency > 12 ? <span className="warn">More than 12 measured slower on PAIR.</span> : 'Default from config.json (12).'}>
                <NumberInput label="Concurrency" value={concurrency} onChange={setConcurrency} min={1} max={64} placeholder="12" />
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>Run even if another run is using this folder</span>
            </label>
          </details>
          <CliBox cli={preview.cli} error={preview.error} />
          {error && <p className="bad">{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={!params || busy || !!preview.error}>Index</button>
            {!source && <span className="muted small">Choose a folder first.</span>}
          </div>
        </form>
        <section className="card">
          <h2>Search</h2>
          <p className="muted small">Searching from the dashboard comes next. Until then, from a terminal in the PhotoSort folder:</p>
          <CliBox cli={'.\\photosort.cmd search "kids at the beach"'} hint="Search the index (only on this PC):" />
        </section>
      </div>
      <RecentJobs kinds={['index']} title="Recent indexing" />
    </div>
  );
}
