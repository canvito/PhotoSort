import { useEffect, useState, type FormEvent } from 'react';
import type { DirInfo } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { compact, folderOf, RecentJobs, usePrefill, useRecentFolders, useStart } from '../components/forms.tsx';
import { CliBox, Field, NumberInput, Segmented } from '../components/ui.tsx';
import { useCliPreview } from '../jobs.ts';
import { ACTIONS } from './Sort.tsx';

type Action = 'report' | 'move' | 'copy';
type Media = '' | 'photos' | 'videos' | 'both';

const MEDIA: { value: Media; label: string; title: string }[] = [
  { value: '', label: 'From the request', title: 'Read it from the request ("photos", "videos", or both when it does not say)' },
  { value: 'photos', label: 'Photos', title: 'Photos only' },
  { value: 'videos', label: 'Videos', title: 'Videos only' },
  { value: 'both', label: 'Both', title: 'Photos and videos' },
];

const EXAMPLES = [
  'group photos and videos of the birthday party last Sunday',
  'beach photos from summer 2026',
  'videos of the dog in the snow last week',
];

export function GroupPage() {
  const { from, query } = usePrefill();
  const recent = useRecentFolders();
  const [source, setSource] = useState<DirInfo>();
  const [request, setRequest] = useState('');
  const [action, setAction] = useState<Action>('report');
  const [advanced, setAdvanced] = useState(query.get('advanced') === '1');
  const [name, setName] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [media, setMedia] = useState<Media>('');
  const [limit, setLimit] = useState<number>();
  const [concurrency, setConcurrency] = useState<number>();
  const [model, setModel] = useState('');
  const [force, setForce] = useState(false);
  const { start, busy, error } = useStart();

  useEffect(() => {
    if (from?.kind !== 'group') return;
    const p = from.params;
    const s = (k: string) => (typeof p[k] === 'string' ? p[k] : '');
    setSource(folderOf(from, 'source'));
    setRequest(s('request'));
    setAction((p.action as Action) ?? 'report');
    setName(s('name'));
    setDateFrom(s('from'));
    setDateTo(s('to'));
    const m = query.get('media') ?? s('media');
    setMedia(MEDIA.some((o) => o.value === m) ? (m as Media) : '');
    setLimit(typeof p.limit === 'number' ? p.limit : undefined);
    setConcurrency(typeof p.concurrency === 'number' ? p.concurrency : undefined);
    setModel(s('model'));
    setForce(query.get('force') === '1' || p.force === true);
    if (query.get('advanced') === '1' || query.get('media') || s('name') || s('from') || s('media')) setAdvanced(true);
  }, [from, query]);

  const params = source && request.trim() ? compact({
    source: source.dirId, request: request.trim(), action, name: name.trim(), from: dateFrom, to: dateFrom ? dateTo : '', media, limit,
    concurrency, model: model.trim(), force,
  }) : undefined;
  const preview = useCliPreview('group', params);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!params) return;
    if (action !== 'report' && !confirm(`${action === 'move' ? 'Move' : 'Copy'} the matching photos and videos of "${source!.name}" into a new group folder now?${action === 'move' ? '\n\nEverything else stays where it is. You can undo it from the job page.' : ''}`)) return;
    void start('group', params);
  };

  return (
    <div className="page-grid">
      <form className="card form" onSubmit={submit}>
        <h2>Group by a description</h2>
        <p className="muted small">Say what to gather in plain words. The matching photos and videos (from every subfolder too) go
          into one new folder; everything else stays where it is. A local model on your PAIR nodes reads the request and looks at
          each file.</p>
        <FolderPicker label="Folder" value={source} onChange={setSource} recent={recent} />
        <Field label="What to group" wide
          hint={<>Dates like “last Sunday” are read against today. People’s names are ignored: use Faces for that.</>}>
          <textarea rows={3} maxLength={500} value={request} onChange={(e) => setRequest(e.target.value)}
            placeholder={EXAMPLES[0]} spellCheck />
        </Field>
        {!request && (
          <div className="chips">
            {EXAMPLES.map((x) => <button type="button" key={x} className="chip small" onClick={() => setRequest(x)}>{x}</button>)}
          </div>
        )}
        <Field label="What to do">
          <Segmented<Action> label="What to do" value={action} onChange={setAction} options={ACTIONS} />
        </Field>
        <details className="advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
          <summary>Advanced</summary>
          <div className="fields">
            <Field label="Folder name" hint="Default: made from the request and the dates.">
              <input type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="automatic" />
            </Field>
            <Field label="From" hint="Overrides the dates in the request.">
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" />
            </Field>
            <Field label="To" hint="Empty: up to today.">
              <input type="date" value={dateTo} min={dateFrom || undefined} disabled={!dateFrom} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" />
            </Field>
            <Field label="Media" wide>
              <Segmented<Media> label="Media" value={media} onChange={setMedia} options={MEDIA} />
            </Field>
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
            <span>Run even if another run is using this folder</span>
          </label>
        </details>
        <CliBox cli={preview.cli} error={preview.error} />
        {error && <p className="bad">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={!params || busy || !!preview.error}>
            {action === 'report' ? 'Preview' : action === 'move' ? 'Group and move' : 'Group and copy'}
          </button>
          {!source && <span className="muted small">Choose a folder first.</span>}
          {source && !request.trim() && <span className="muted small">Describe what to group.</span>}
        </div>
      </form>
      <RecentJobs kinds={['group', 'apply']} />
    </div>
  );
}
