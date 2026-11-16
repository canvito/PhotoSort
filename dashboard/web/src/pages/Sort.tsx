import { useEffect, useState, type FormEvent } from 'react';
import type { DirInfo } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { compact, folderOf, RecentJobs, usePrefill, useRecentFolders, useStart } from '../components/forms.tsx';
import { CliBox, Field, NumberInput, Segmented } from '../components/ui.tsx';
import { useCliPreview } from '../jobs.ts';

type Action = 'report' | 'move' | 'copy';

export const ACTIONS: { value: Action; label: string; title: string }[] = [
  { value: 'report', label: 'Preview', title: 'Nothing moves. You then move exactly what the preview found, without asking the model again.' },
  { value: 'move', label: 'Move', title: 'Move the files now (undo is available afterwards)' },
  { value: 'copy', label: 'Copy', title: 'Copy the files now; the originals stay' },
];

export function SortPage() {
  const { from, query } = usePrefill();
  const recent = useRecentFolders();
  const [source, setSource] = useState<DirInfo>();
  const [dest, setDest] = useState<DirInfo>();
  const [action, setAction] = useState<Action>('report');
  const [recursive, setRecursive] = useState(false);
  const [limit, setLimit] = useState<number>();
  const [concurrency, setConcurrency] = useState<number>();
  const [model, setModel] = useState('');
  const [force, setForce] = useState(false);
  const { start, busy, error } = useStart();

  useEffect(() => {
    if (from?.kind !== 'sort') return;
    const p = from.params;
    setSource(folderOf(from, 'source'));
    setDest(folderOf(from, 'dest'));
    setAction((p.action as Action) ?? 'report');
    setRecursive(p.recursive === true);
    setLimit(typeof p.limit === 'number' ? p.limit : undefined);
    setConcurrency(typeof p.concurrency === 'number' ? p.concurrency : undefined);
    setModel(typeof p.model === 'string' ? p.model : '');
    setForce(query.get('force') === '1' || p.force === true);
  }, [from, query]);

  const params = source ? compact({
    source: source.dirId, action, dest: dest?.dirId, recursive, limit, concurrency, model: model.trim(), force,
  }) : undefined;
  const preview = useCliPreview('sort', params);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!params) return;
    if (action !== 'report' && !confirm(`${action === 'move' ? 'Move' : 'Copy'} the photos and videos of "${source!.name}" into bucket folders now?${action === 'move' ? '\n\nYou can undo it from the job page.' : ''}`)) return;
    void start('sort', params);
  };

  return (
    <div className="page-grid">
      <form className="card form" onSubmit={submit}>
        <h2>Sort a folder into buckets</h2>
        <p className="muted small">Each photo and video goes to a local vision model on your PAIR nodes, which picks a bucket
          (people, food, screenshots, …). Nothing is sent to a cloud model.</p>
        <FolderPicker label="Folder" value={source} onChange={setSource} recent={recent} />
        <FolderPicker label="Put the buckets in" value={dest} onChange={setDest} optional recent={recent}
          hint="Default: bucket folders inside the folder itself." />
        <Field label="What to do">
          <Segmented<Action> label="What to do" value={action} onChange={setAction} options={ACTIONS} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          <span>Include subfolders
            <span className="field-hint">Files from every subfolder go into one set of buckets at the top; subfolders do not get buckets of
              their own. Group folders are skipped.</span>
          </span>
        </label>
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="fields">
            <Field label="Only the first" hint="0 or empty: all files">
              <NumberInput label="Limit" value={limit} onChange={setLimit} min={0} max={10_000_000} placeholder="all" />
            </Field>
            <Field label="Parallel requests" hint={concurrency && concurrency > 12 ? <span className="warn">More than 12 measured slower on PAIR.</span> : 'Default from config.json (12).'}>
              <NumberInput label="Concurrency" value={concurrency} onChange={setConcurrency} min={1} max={64} placeholder="12" />
            </Field>
            <Field label="Model" hint="A local model on PAIR; cloud models are refused.">
              <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="from config.json" spellCheck={false} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            <span>Run even if another run is using these folders</span>
          </label>
        </details>
        <CliBox cli={preview.cli} error={preview.error} />
        {error && <p className="bad">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!params || busy || !!preview.error}>
            {action === 'report' ? 'Preview' : action === 'move' ? 'Sort and move' : 'Sort and copy'}
          </button>
          {!source && <span className="muted small">Choose a folder first.</span>}
        </div>
      </form>
      <RecentJobs kinds={['sort', 'apply']} />
    </div>
  );
}
