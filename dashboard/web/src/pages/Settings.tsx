// Settings: config.json with the checks PhotoSort itself applies (cloud models are refused), reviewed as a list of
// changes before it is saved, and the switches of this window.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, errorText, usePoll, type ConfigCheck, type ConfigReply } from '../api.ts';
import type { Ctx } from '../App.tsx';
import { Field, NumberInput, Row, Segmented } from '../components/ui.tsx';
import { bytes, type IndexStats } from '../gallery.ts';
import { Icon } from '../icons.tsx';

type Json = Record<string, unknown>;
interface Bucket { id: number; name: string; desc: string; locked: boolean }

// photo_search.DEFAULTS: what PhotoSort uses for a setting that config.json leaves out.
const DEFAULTS = {
  caption_model: 'gemma4:12b', embed_model: 'qwen3-embedding:8b', index_concurrency: 12,
  index_path: '%LOCALAPPDATA%\\PhotoSort\\search_index.sqlite',
};
const MAX_BUCKETS = 60;

let lastId = 0;
const bucketsOf = (b: unknown): Bucket[] => Object.entries(b && typeof b === 'object' ? (b as Json) : {})
  .map(([name, desc]) => ({ id: ++lastId, name, desc: typeof desc === 'string' ? desc : '', locked: name === 'other' }));
const workersOf = (w: unknown): string => (Array.isArray(w) ? w.map(String).join('\n') : '');
const listOf = (text: string): string[] => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

/** The config a save would write: the loaded file with the edits, unknown keys kept in place. */
function buildConfig(loaded: Json, draft: Json, buckets: Bucket[], workers: string): Json {
  const merged: Json = { ...draft, buckets: Object.fromEntries(buckets.map((b) => [b.name.trim(), b.desc])) };
  const w = listOf(workers);
  merged.face_workers = w.length || 'face_workers' in loaded ? w : undefined;
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined && v !== ''));
}

function localProblems(buckets: Bucket[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  buckets.forEach((b, i) => {
    const n = b.name.trim();
    if (!n) out.push(`Bucket ${i + 1} needs a name.`);
    else if (seen.has(n)) out.push(`Two buckets are named "${n}".`);
    seen.add(n);
  });
  if (buckets.length > MAX_BUCKETS) out.push(`Use at most ${MAX_BUCKETS} buckets.`);
  return out;
}

function ModelField({ label, hint, value, def, reply, onChange }: {
  label: string; hint: ReactNode; value: unknown; def?: string; reply: ConfigReply; onChange(v: string | undefined): void;
}) {
  const v = typeof value === 'string' ? value : '';
  if (!reply.pairReachable) {
    return (
      <Field label={label} hint={<>{hint} PAIR is not reachable, so type the name.</>}>
        <input type="text" value={v} placeholder={def} spellCheck={false} aria-label={label}
          onChange={(e) => onChange(e.target.value.trim() || undefined)} />
      </Field>
    );
  }
  const local = reply.models.filter((m) => !m.cloud);
  const cloud = reply.models.filter((m) => m.cloud);
  const listed = reply.models.some((m) => m.name === v);
  return (
    <Field label={label} hint={hint}>
      <select value={v} aria-label={label} onChange={(e) => onChange(e.target.value || undefined)}>
        {def !== undefined && <option value="">Default ({def})</option>}
        {def === undefined && !v && <option value="">Choose a model</option>}
        {v && !listed && <option value={v}>{v} (not in PAIR)</option>}
        <optgroup label="On your machines">
          {local.map((m) => <option key={m.name} value={m.name}>{m.name}{m.params ? ` · ${m.params}` : ''}</option>)}
        </optgroup>
        {cloud.length > 0 && (
          <optgroup label="Cloud: never used">
            {cloud.map((m) => <option key={m.name} value={m.name} disabled>{m.name}</option>)}
          </optgroup>
        )}
      </select>
    </Field>
  );
}

function BucketEditor({ buckets, onChange }: { buckets: Bucket[]; onChange(b: Bucket[]): void }) {
  const edit = (id: number, patch: Partial<Bucket>) => onChange(buckets.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const move = (i: number, by: number) => {
    const next = [...buckets];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Buckets</h2>
        <span className="muted small">{buckets.length} of {MAX_BUCKETS}</span>
      </div>
      <p className="muted small">
        Sort puts each photo into one bucket, and the model chooses by these descriptions. Names become folder names: lowercase
        letters, digits, _ and -. <b>other</b> catches everything else and stays.
      </p>
      <ol className="bucket-list">
        {buckets.map((b, i) => (
          <li key={b.id} className="bucket-row">
            <input type="text" className="mono" value={b.name} disabled={b.locked} spellCheck={false} maxLength={48}
              aria-label={`Bucket ${i + 1} name`} placeholder="name"
              onChange={(e) => edit(b.id, { name: e.target.value.toLowerCase().replace(/\s+/g, '_') })} />
            <input type="text" value={b.desc} maxLength={500} aria-label={`Bucket ${i + 1} description`}
              placeholder="What belongs here, in a sentence" onChange={(e) => edit(b.id, { desc: e.target.value })} />
            <span className="bucket-tools">
              <button type="button" className="ghost icon" disabled={i === 0} aria-label={`Move ${b.name || 'bucket'} up`}
                title="Move up" onClick={() => move(i, -1)}><Icon name="up" size={14} /></button>
              <button type="button" className="ghost icon flip" disabled={i === buckets.length - 1}
                aria-label={`Move ${b.name || 'bucket'} down`} title="Move down" onClick={() => move(i, 1)}><Icon name="up" size={14} /></button>
              <button type="button" className="ghost icon danger" disabled={b.locked} aria-label={`Remove ${b.name || 'bucket'}`}
                title={b.locked ? 'other always stays' : 'Remove'} onClick={() => onChange(buckets.filter((x) => x.id !== b.id))}>
                <Icon name="x" size={14} />
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="actions">
        <button type="button" className="ghost" disabled={buckets.length >= MAX_BUCKETS}
          onClick={() => onChange([...buckets.filter((b) => !b.locked), { id: ++lastId, name: '', desc: '', locked: false },
            ...buckets.filter((b) => b.locked)])}>Add bucket</button>
      </div>
    </section>
  );
}

function Review({ dirty, problems, check, fresh, busy, note, conflict, onReview, onSave, onDiscard, onReload }: {
  dirty: boolean; problems: string[]; check?: ConfigCheck; fresh: boolean; busy: boolean; note?: { tone: 'ok' | 'bad'; text: string };
  conflict: boolean; onReview(): void; onSave(): void; onDiscard(): void; onReload(): void;
}) {
  const shown = fresh ? check : undefined;
  const canSave = !!shown && shown.ok && shown.changes.length > 0;
  return (
    <section className="card settings-review" aria-live="polite">
      <h2>Save</h2>
      {!dirty && !note && <p className="muted">No changes yet. Edit a setting, then review and save it here.</p>}
      {dirty && !shown && !problems.length && <p className="muted">Review checks the changes the way PhotoSort will, before anything is saved.</p>}
      {problems.length > 0 && (
        <>
          <h3 className="sub bad">Fix first</h3>
          <ul className="plain bad">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
      {shown && shown.errors.length > 0 && (
        <>
          <h3 className="sub bad">Fix first</h3>
          <ul className="plain bad">{shown.errors.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
      {shown && shown.warnings.length > 0 && (
        <>
          <h3 className="sub">Worth a look</h3>
          <ul className="plain warn">{shown.warnings.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
      {shown && (
        <>
          <h3 className="sub">{shown.changes.length ? `${shown.changes.length} change${shown.changes.length === 1 ? '' : 's'}` : 'Nothing changes'}</h3>
          <ul className="changes">
            {shown.changes.map((c) => (
              <li key={c.key}>
                <code>{c.key}</code>
                <span className="change">
                  {c.before === undefined ? <span className="muted">added</span> : <del>{c.before}</del>}
                  {c.after === undefined ? <span className="muted"> removed</span> : <> → <ins>{c.after}</ins></>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {note && <p className={note.tone}>{note.text}</p>}
      {conflict && <p><button type="button" className="ghost" onClick={onReload}><Icon name="refresh" size={14} /> Reload config.json (drops these edits)</button></p>}
      <div className="actions">
        {canSave ? (
          <button type="button" className="primary" disabled={busy} onClick={onSave}>
            {busy ? 'Saving…' : `Save ${shown.changes.length} change${shown.changes.length === 1 ? '' : 's'}`}
          </button>
        ) : (
          <button type="button" className="primary" disabled={!dirty || busy || problems.length > 0} onClick={onReview}>
            {busy ? 'Checking…' : 'Review changes'}
          </button>
        )}
        <button type="button" className="ghost" disabled={!dirty || busy} onClick={onDiscard}>Discard</button>
      </div>
    </section>
  );
}

function WindowCard({ ctx, blur, onBlur, onProtection }: { ctx: Ctx; blur: boolean; onBlur(on: boolean): void; onProtection(): void }) {
  const stats = usePoll<IndexStats>('/api/index/stats');
  const [cache, setCache] = useState<{ busy: boolean; note?: string }>({ busy: false });
  const { shell } = ctx;
  const clear = () => {
    setCache({ busy: true });
    api<{ ok: boolean }>('/api/cache/clear', { method: 'POST', body: {} })
      .then(() => setCache({ busy: false, note: 'Thumbnail cache cleared.' }), (e: unknown) => setCache({ busy: false, note: errorText(e) }))
      .finally(stats.reload);
  };
  return (
    <section className="card">
      <h2>This window</h2>
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={!!shell?.protection} disabled={!shell} onChange={onProtection} />
          <span>Content protection<span className="field-hint">Screenshots, screen sharing and recordings see a black window.
            {!shell && ' Only in the PhotoSort window (dashboard.ps1 open).'}</span></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={blur} onChange={(e) => onBlur(e.target.checked)} />
          <span>Blur photos and captions<span className="field-hint">Also <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> anywhere.</span></span>
        </label>
      </div>
      <h3 className="sub">Graphics</h3>
      <Row k="GPU" v={shell ? `${shell.gpuDevice?.vendor ?? 'unknown'} · ${shell.gpuChoice}` : 'unknown'} />
      <p className="muted small">Pick one when starting: <code>.\dashboard.ps1 -Gpu rtx</code> (or <code>igpu</code>, <code>auto</code>).</p>
      <h3 className="sub">Thumbnail cache</h3>
      <Row k="Size" v={stats.data ? `${bytes(stats.data.cache.bytes)} of ${bytes(stats.data.cache.limitBytes)} · ${stats.data.cache.files.toLocaleString()} files` : stats.error ? 'unknown' : '…'} />
      <div className="actions">
        <button type="button" className="ghost" disabled={cache.busy} onClick={clear}>{cache.busy ? 'Clearing…' : 'Clear cache'}</button>
        {cache.note && <span className="muted small">{cache.note}</span>}
      </div>
    </section>
  );
}

export function SettingsPage({ ctx, blur, onBlur, onProtection }: { ctx: Ctx; blur: boolean; onBlur(on: boolean): void; onProtection(): void }) {
  const cfg = usePoll<ConfigReply>('/api/config');
  const reply = cfg.data;
  const loaded = useMemo(() => reply?.config ?? {}, [reply]);
  const [draft, setDraft] = useState<Json>({});
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [workers, setWorkers] = useState('');
  const [etag, setEtag] = useState('');
  const [check, setCheck] = useState<{ for: string; result: ConfigCheck }>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string }>();
  const [conflict, setConflict] = useState(false);

  const reset = (r: ConfigReply) => {
    const c = r.config ?? {};
    setDraft(c);
    setBuckets(bucketsOf(c.buckets));
    setWorkers(workersOf(c.face_workers));
    setEtag(r.etag);
    setCheck(undefined);
    setConflict(false);
  };
  useEffect(() => {
    if (reply) reset(reply);
  }, [reply]);

  const config = useMemo(() => buildConfig(loaded, draft, buckets, workers), [loaded, draft, buckets, workers]);
  const key = JSON.stringify(config);
  const dirty = !!reply?.config && key !== JSON.stringify(loaded);
  const problems = useMemo(() => localProblems(buckets), [buckets]);
  const fresh = check?.for === key;
  const set = (k: string, v: unknown) => {
    setNote(undefined);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const send = (save: boolean) => {
    setBusy(true);
    setNote(undefined);
    api<ConfigCheck>('/api/config', { method: 'PUT', body: { config, etag, save } })
      .then((r) => {
        if (r.saved) {
          setCheck(undefined);
          setNote({ tone: 'ok', text: `Saved ${r.changes.length} change${r.changes.length === 1 ? '' : 's'}. The previous file is kept as ${reply?.file ?? 'config.json'}.bak; new jobs use the new settings.` });
          cfg.reload();
        } else setCheck({ for: key, result: r });
      }, (e: unknown) => {
        if (e instanceof ApiError && e.status === 409) setConflict(true);
        setNote({ tone: 'bad', text: errorText(e) });
      })
      .finally(() => setBusy(false));
  };

  if (!reply) {
    return <section className="card narrow">{cfg.error ? <p className="bad">{cfg.error}</p> : <p className="muted">Loading config.json…</p>}</section>;
  }
  if (!reply.config) {
    return (
      <section className="card narrow notice bad" role="alert">
        <Icon name="alert" />
        <div>
          <h2>config.json cannot be read</h2>
          <p>{reply.parseError}</p>
          <p className="muted small">Fix it in a text editor (PhotoSort keeps a copy of the last saved one as config.json.bak), then reload.</p>
          <div className="actions"><button type="button" className="ghost" onClick={cfg.reload}>Reload</button></div>
        </div>
      </section>
    );
  }

  const n = (k: string) => (typeof draft[k] === 'number' ? (draft[k] as number) : undefined);
  return (
    <div className="page-grid settings">
      <div className="stack">
        {reply.fixture && (
          <section className="card notice warn">
            <Icon name="alert" />
            <p>Fixture mode edits a copy of the fixture config in the fixture data folder. Its PAIR address and index stay as they are.</p>
          </section>
        )}
        <section className="card">
          <h2>Models</h2>
          <p className="muted small">Only models on your own machines can be chosen. Cloud models are listed so you can see them, and are refused.</p>
          <div className="fields">
            <ModelField label="Sort and group" value={draft.model} reply={reply} onChange={(v) => set('model', v ?? '')}
              hint="Looks at each photo to pick its bucket." />
            <ModelField label="Index captions" value={draft.caption_model} def={DEFAULTS.caption_model} reply={reply}
              onChange={(v) => set('caption_model', v)} hint="Describes photos for search." />
            <ModelField label="Search embeddings" value={draft.embed_model} def={DEFAULTS.embed_model} reply={reply}
              onChange={(v) => set('embed_model', v)} hint="Turns captions and queries into vectors." />
          </div>
          <Row k="PAIR address" v={<span className="mono">{String(draft.base_url ?? '')}</span>} />
          <p className="muted small">Always this PC; PAIR passes requests on to your machines. Change it in {reply.file} if PAIR moved to another port.</p>
        </section>
        <section className="card">
          <h2>Speed and limits</h2>
          <div className="fields">
            <Field label="Parallel sort requests" hint="1–64. More than PAIR can serve only queues.">
              <NumberInput clampOnBlur label="Parallel sort requests" value={n('concurrency')} min={1} max={64} onChange={(v) => set('concurrency', v)} />
            </Field>
            <Field label="Parallel index requests" hint={`1–64. Empty: ${DEFAULTS.index_concurrency}.`}>
              <NumberInput clampOnBlur label="Parallel index requests" value={n('index_concurrency')} min={1} max={64}
                placeholder={String(DEFAULTS.index_concurrency)} onChange={(v) => set('index_concurrency', v)} />
            </Field>
            <Field label="Image size sent to the model" hint="Longest side in pixels, 256–4096.">
              <NumberInput clampOnBlur label="Image size" value={n('max_side')} min={256} max={4096} onChange={(v) => set('max_side', v)} />
            </Field>
            <Field label="Request timeout" hint="Seconds, 5–3600.">
              <NumberInput clampOnBlur label="Request timeout" value={n('timeout_s')} min={5} max={3600} onChange={(v) => set('timeout_s', v)} />
            </Field>
            <Field label="Tries per photo" hint="1–10.">
              <NumberInput clampOnBlur label="Tries per photo" value={n('retries')} min={1} max={10} onChange={(v) => set('retries', v)} />
            </Field>
            <Field label="Sort default" hint="What a sort does when the job does not say.">
              <Segmented label="Sort default" value={draft.action === 'copy' ? 'copy' : 'move'} onChange={(v) => set('action', v)}
                options={[{ value: 'move', label: 'Move' }, { value: 'copy', label: 'Copy' }]} />
            </Field>
          </div>
        </section>
        <section className="card">
          <h2>Face workers</h2>
          <Field label="Machines on your network" wide
            hint={<>One per line as <code>host</code> or <code>host:processes</code>. Empty: faces run on this PC. They are reached over SSH and must be on your LAN.</>}>
            <textarea className="mono" rows={3} value={workers} spellCheck={false} aria-label="Face workers"
              onChange={(e) => { setNote(undefined); setWorkers(e.target.value); }} />
          </Field>
        </section>
        <section className="card">
          <h2>Search index</h2>
          <Field label="Index file" wide
            hint={<>Empty: <code>{DEFAULTS.index_path}</code>. Never inside OneDrive: the index holds captions and visible text of your photos.</>}>
            <input type="text" className="mono" value={typeof draft.index_path === 'string' ? draft.index_path : ''} spellCheck={false}
              placeholder={DEFAULTS.index_path} disabled={reply.fixture} aria-label="Index file"
              onChange={(e) => set('index_path', e.target.value.trim() || undefined)} />
          </Field>
        </section>
        <BucketEditor buckets={buckets} onChange={(b) => { setNote(undefined); setBuckets(b); }} />
      </div>
      <div className="stack settings-side">
        <Review dirty={dirty} problems={problems} check={check?.result} fresh={fresh} busy={busy} note={note} conflict={conflict}
          onReview={() => send(false)} onSave={() => send(true)} onDiscard={() => { setNote(undefined); reset(reply); }} onReload={cfg.reload} />
        <WindowCard ctx={ctx} blur={blur} onBlur={onBlur} onProtection={onProtection} />
      </div>
    </div>
  );
}
