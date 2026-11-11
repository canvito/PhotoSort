// Faces: who is in which photo and video. "Tag faces" runs a job that matches every face in a folder against a
// people folder (one subfolder of reference photos per person) on the face workers: this PC ("local") or LAN
// machines over SSH, never a cloud service. "Results" browses what the last run in a folder found, by person,
// with each face boxed in the preview. Names and file names are rendered as plain text.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearch } from 'wouter';
import { api, errorText, useJobEvents, usePoll, when, type DirInfo, type DirListing, type JobView } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { compact, folderOf, RecentJobs, usePrefill, useRecentFolders, useStart } from '../components/forms.tsx';
import { Gallery } from '../components/Gallery.tsx';
import { Viewer } from '../components/MediaDetail.tsx';
import { CliBox, CopyButton, Field, NumberInput, Row } from '../components/ui.tsx';
import { bytes, mediaUrl, usePaged, viewable, type MediaItem } from '../gallery.ts';
import { Icon } from '../icons.tsx';
import { useCliPreview, useJobs } from '../jobs.ts';

type Tab = 'results' | 'tag';
type FaceStatus = 'named' | 'unknown' | 'none' | 'error';

interface FaceItem extends MediaItem {
  status: FaceStatus;
  people: string[];
  faces: number;
  unknown: number;
  frames: number | null;
  error: string | null;
}

interface Detection {
  person: string | null;
  similarity?: number;
  /** [x1, y1, x2, y2] in the upright picture's (or video frame's) pixels. */
  bbox?: number[];
  time_s?: number;
}

interface FaceDetail extends FaceItem {
  path: string;
  width: number | null;
  height: number | null;
  detections: Detection[];
}

interface FaceSummary {
  generation: number;
  counts: { all: number; people: Record<string, number>; unknown: number; none: number; errors: number };
  skipped: number;
  model?: string;
  provider?: string;
  threshold?: number;
  margin?: number;
  people?: string[];
  finished_at?: string;
  duration_s?: number;
  summary?: Record<string, number>;
}

interface Person {
  name: string;
  count: number;
  samples: MediaItem[];
}

interface WorkerCheck {
  host: string;
  threads: number;
  state: 'ready' | 'needs_setup' | 'refused' | 'unreachable' | 'skipped';
  detail: string;
}

interface WorkersInfo {
  configured: string[];
  effective: string[];
  fixture: boolean;
}

const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'results', label: 'Results', icon: 'faces' },
  { value: 'tag', label: 'Tag faces', icon: 'play' },
];
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,62}(:\d{1,3})?$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const STATE: Record<WorkerCheck['state'], { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'ok' },
  needs_setup: { label: 'Needs setup', tone: 'warn' },
  refused: { label: 'Refused', tone: 'bad' },
  unreachable: { label: 'Unreachable', tone: 'bad' },
  skipped: { label: 'Not checked', tone: '' },
};

const savedTab = (): Tab | undefined => {
  const t = sessionStorage.getItem('faces.tab');
  return t === 'results' || t === 'tag' ? t : undefined;
};

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The line under a tile: who is in it. */
function faceLine(it: MediaItem): string {
  const f = it as FaceItem;
  if (f.status === 'error') return 'Could not be read';
  if (f.people?.length) return `${f.people.join(', ')}${f.unknown ? ' + unknown' : ''}`;
  if (f.faces) return it.kind === 'video' ? 'Unknown faces' : `${f.faces} unknown ${f.faces === 1 ? 'face' : 'faces'}`;
  return 'No faces';
}

/** Folders a face tagging run used (newest first), for quick picks. */
function useFaceFolders(role: 'source' | 'people'): DirInfo[] {
  const { list } = useJobs();
  return useMemo(() => {
    const seen = new Set<string>();
    const out: DirInfo[] = [];
    for (const j of list?.jobs ?? []) {
      const f = j.kind === 'faces' ? folderOf(j, role) : undefined;
      if (f && !seen.has(f.path.toLowerCase())) {
        seen.add(f.path.toLowerCase());
        out.push(f);
      }
    }
    return out.slice(0, 6);
  }, [list, role]);
}

// ---------- results ----------

interface SummaryState {
  folder?: string;
  data?: FaceSummary;
  error?: string;
  status?: number;
}

/** The chosen folder's results file, read again when `epoch` changes. Nothing from another folder is kept. */
function useFaceSummary(folder: string | undefined, epoch: number): SummaryState & { loading: boolean } {
  const [state, setState] = useState<SummaryState>({});
  useEffect(() => {
    if (!folder) return;
    const ctrl = new AbortController();
    api<FaceSummary>(`/api/faces?folder=${encodeURIComponent(folder)}`, { signal: ctrl.signal })
      .then((data) => setState({ folder, data }), (e: unknown) => {
        if (!ctrl.signal.aborted) setState({ folder, error: errorText(e), status: (e as { status?: number }).status });
      });
    return () => ctrl.abort();
  }, [folder, epoch]);
  const mine = state.folder === folder ? state : {};
  return { ...mine, loading: !!folder && !mine.data && !mine.error };
}

function useFaceDetail(folder: string, item: FaceItem, epoch: number): { detail?: FaceDetail; error?: string } {
  const [state, setState] = useState<{ detail?: FaceDetail; error?: string }>({});
  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => (s.detail?.id === item.id ? s : {}));
    // Arrowing through the grid with the pane open does not fetch every file on the way.
    const t = setTimeout(() => {
      api<FaceDetail>(`/api/faces/items/${encodeURIComponent(item.id)}?folder=${encodeURIComponent(folder)}`, { signal: ctrl.signal })
        .then((detail) => setState({ detail }), (e: unknown) => {
          if (!ctrl.signal.aborted) setState({ error: errorText(e) });
        });
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [folder, item.id, epoch]);
  return state;
}

/** Boxes and names over the picture, in its own pixels: the SVG fits the box the way the picture does. */
function FaceBoxes({ w, h, faces, hover }: { w: number; h: number; faces: [number, Detection][]; hover?: number }) {
  const font = Math.max(w, h) * 0.03;
  return (
    <svg className="faces-overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {faces.map(([i, d]) => {
        const [x1, y1, x2, y2] = (d.bbox ?? []).map((v, k) => Math.min(k % 2 ? h : w, Math.max(0, Number(v) || 0)));
        if (!(x2 > x1 && y2 > y1)) return null;
        return (
          <g key={i} className={`face-box${d.person ? ' named' : ''}${hover === i ? ' hover' : ''}`}>
            <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} vectorEffect="non-scaling-stroke" />
            <text x={x1} y={y1 > font * 1.3 ? y1 - font * 0.3 : Math.min(h, y2 + font)} fontSize={font}>{d.person ?? 'Unknown'}</text>
          </g>
        );
      })}
    </svg>
  );
}

function FaceDetailPane({ folder, item, epoch, onClose }: { folder: string; item: FaceItem; epoch: number; onClose(): void }) {
  const { detail, error } = useFaceDetail(folder, item, epoch);
  const d = detail?.id === item.id ? detail : undefined;
  const cur: FaceItem = d ?? item;
  const [hover, setHover] = useState<number>();
  const [at, setAt] = useState<number>();
  const [size, setSize] = useState<{ w: number; h: number }>();
  const [reveal, setReveal] = useState<{ id: string; text: string; bad?: boolean }>();
  const video = useRef<HTMLVideoElement | null>(null);
  // The video element goes away when the viewer shows frames instead; moments then cannot be shown on it.
  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    video.current = el;
    if (!el) setSize(undefined);
  }, []);
  const isVideo = cur.kind === 'video';

  useEffect(() => {
    setAt(undefined);
    setSize(undefined);
    setHover(undefined);
  }, [item.id]);

  const detections = useMemo(() => (d?.detections ?? []).map((x, i) => [i, x] as [number, Detection]), [d]);
  // A video's faces, by the sampled frame they were seen in.
  const moments = useMemo(() => {
    const m = new Map<number, Detection[]>();
    for (const [, x] of detections) if (typeof x.time_s === 'number') m.set(x.time_s, [...(m.get(x.time_s) ?? []), x]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [detections]);

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = t;
    setAt(t);
  };

  let overlay = null;
  if (!isVideo && d?.width && d.height) overlay = <FaceBoxes w={d.width} h={d.height} faces={detections} hover={hover} />;
  if (isVideo && size && at !== undefined) overlay = <FaceBoxes w={size.w} h={size.h} faces={detections.filter(([, x]) => x.time_s === at)} />;

  const doReveal = () => {
    const id = cur.id;
    api<{ ok: boolean }>(`/api/media/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: {} })
      .then(() => setReveal({ id, text: 'Shown in Explorer' }), (e: unknown) => setReveal({ id, text: errorText(e), bad: true }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <aside className="detail" aria-label="Faces in this file" onKeyDown={onKeyDown}>
      <div className="detail-head">
        <Icon name={isVideo ? 'video' : 'image'} size={16} />
        <h2 title={cur.name}>{cur.name}</h2>
        <button type="button" className="ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close details"><Icon name="x" size={14} /></button>
      </div>
      <Viewer key={`${cur.id}:${cur.revision}:${epoch}`} item={cur} overlay={overlay} videoRef={videoRef}
        videoEvents={{
          onLoadedMetadata: (e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight }),
          onPlay: () => setAt(undefined),
          onSeeked: (e) => {
            const now = e.currentTarget.currentTime;
            setAt((t) => (t !== undefined && Math.abs(now - t) > 0.3 ? undefined : t));
          },
        }} />
      <div className="actions">
        <button type="button" className="ghost" onClick={doReveal} disabled={!cur.exists} title="Open File Explorer with this file selected">
          <Icon name="folder" size={14} /> Reveal in Explorer
        </button>
        {reveal?.id === cur.id && <span className={`small ${reveal.bad ? 'bad' : 'muted'}`}>{reveal.text}</span>}
      </div>
      {error && <p className="bad small">{error}</p>}
      {cur.error && <p className="bad small">This file could not be read: {cur.error}</p>}
      {d && !isVideo && detections.length > 0 && (
        <section className="detail-text">
          <h3>Faces</h3>
          <ul className="face-list">
            {detections.map(([i, x]) => (
              <li key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)}>
                <span className={`dot ${x.person ? 'ok' : 'warn'}`} />
                <span className="name">{x.person ?? 'Unknown'}</span>
                {typeof x.similarity === 'number' && <span className="muted small" title="Similarity to the closest reference photo (0 to 1)">{x.similarity.toFixed(2)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {d && isVideo && moments.length > 0 && (
        <section className="detail-text">
          <h3>Faces by moment</h3>
          <p className="muted small">{size ? 'Pick a moment to pause the video there with the faces boxed.'
            : 'Moments in the video where faces were seen. Boxes are shown when the video can play here.'}</p>
          <ul className="face-list">
            {moments.map(([t, xs]) => (
              <li key={t}>
                <button type="button" className={`ghost${at === t ? ' on' : ''}`} onClick={() => seek(t)} disabled={!size}
                  aria-label={`Show the faces at ${clock(t)}`}>{clock(t)}</button>
                <span className="name">{xs.map((x) => x.person ?? 'Unknown').join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {d && !detections.length && !cur.error && <p className="muted small">No faces were found in this file.</p>}
      <div className="detail-rows">
        <Row k="People" v={cur.people.length ? cur.people.join(', ') : '—'} />
        <Row k={isVideo ? 'Face sightings' : 'Faces'} v={cur.faces} />
        {cur.unknown > 0 && <Row k="Unknown" v={cur.unknown} />}
        {isVideo && cur.frames !== null && <Row k="Frames checked" v={cur.frames} />}
        <Row k="Size" v={bytes(cur.size)} />
        <Row k="Folder" v={cur.folder} />
      </div>
      {d && (
        <div className="detail-text">
          <section>
            <div className="detail-path-head"><h3>Path</h3><CopyButton text={d.path} label="Copy path" /></div>
            <p className="detail-path">{d.path}</p>
          </section>
        </div>
      )}
    </aside>
  );
}

/** The folder whose results are shown: a chip that opens the folder picker, plus recent face tagging folders. */
function ResultsFolder({ value, recent, onChange }: { value?: DirInfo; recent: DirInfo[]; onChange(d: DirInfo): void }) {
  const [open, setOpen] = useState(!value);
  const others = recent.filter((r) => r.path !== value?.path);
  // A folder that arrives later (from the address or the last run) closes the picker.
  useEffect(() => {
    if (value) setOpen(false);
  }, [value?.dirId]);
  return (
    <>
      <div className="folder-filter">
        <button type="button" className={`chip small${value ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}
          title={value?.path ?? 'Choose a folder that face tagging ran on'}>
          <Icon name="folder" size={14} /> {value ? value.name : 'Choose a folder…'}
        </button>
        {others.map((r) => (
          <button type="button" key={r.dirId} className="chip small" title={r.path} onClick={() => onChange(r)}>{r.name}</button>
        ))}
      </div>
      {open && (
        <div className="folder-filter-panel">
          <FolderPicker label="Show the face results of this folder" value={value} recent={recent}
            onChange={(d) => {
              if (!d) return;
              onChange(d);
              setOpen(false);
            }} />
        </div>
      )}
    </>
  );
}

function ResultsView({ folder, onFolder, onTag }: { folder?: DirInfo; onFolder(d: DirInfo): void; onTag(d?: DirInfo): void }) {
  const recent = useFaceFolders('source');
  const [epoch, setEpoch] = useState(0);
  const [seenGen, setSeenGen] = useState<number>();
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<{ active: number; opened?: FaceItem }>({ active: -1 });
  const grid = useRef<HTMLDivElement>(null);
  const dir = folder?.dirId;
  const summary = useFaceSummary(dir, epoch);
  const data = summary.data;

  useEffect(() => {
    setFilter('all');
    setSel({ active: -1 });
  }, [dir]);

  // A face tagging run that finishes may have rewritten this folder's results.
  useJobEvents((ev) => {
    if (ev.type === 'finished' && ev.kind === 'faces') setEpoch((n) => n + 1);
  });

  // The sidecar's generation only grows, so the larger one seen is the current one.
  const generation = data ? Math.max(data.generation, seenGen ?? -1) : undefined;
  const onGeneration = useCallback((g: number) => {
    setSeenGen(g);
    setEpoch((n) => n + 1);
  }, []);
  const query = useMemo(() => ({ folder: dir ?? '', filter }), [dir, filter]);
  const paged = usePaged<FaceItem>('/api/faces/items', query, generation, !!dir && !!data, onGeneration);

  const close = useCallback(() => {
    setSel((s) => ({ ...s, opened: undefined }));
    grid.current?.focus();
  }, []);
  useEffect(() => {
    if (!sel.opened) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);
      if (e.key === 'Escape' && !typing && !e.defaultPrevented) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel.opened, close]);

  const onActive = (i: number) => setSel((s) => ({ active: i, opened: s.opened ? (paged.get(i) ?? s.opened) : undefined }));
  const onOpen = (i: number) => {
    const it = paged.get(i);
    if (it) setSel({ active: i, opened: it });
  };

  const c = data?.counts;
  const chips = c ? [
    { value: 'all', label: 'Everything', n: c.all },
    ...[...new Set([...(data.people ?? []), ...Object.keys(c.people)])]
      .map((name) => ({ value: `person:${name}`, label: name, n: c.people[name] ?? 0 }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    { value: 'unknown', label: 'Unknown faces', n: c.unknown },
    { value: 'none', label: 'No faces', n: c.none },
    { value: 'errors', label: 'Errors', n: c.errors },
  ] : [];
  const chosen = chips.find((x) => x.value === filter);

  return (
    <>
      <div className="search-toolbar">
        <div className="filters">
          <ResultsFolder value={folder} recent={recent} onChange={onFolder} />
          {folder && (
            <button type="button" className="ghost" onClick={() => setEpoch((n) => n + 1)} title="Read the results file again">
              <Icon name="refresh" size={14} /> Refresh
            </button>
          )}
        </div>
        {chips.length > 0 && (
          <div className="chips" role="group" aria-label="Show">
            {chips.map((x) => (
              <button type="button" key={x.value} className={`chip small${filter === x.value ? ' on' : ''}${x.value === 'errors' && x.n ? ' bad' : ''}`}
                aria-pressed={filter === x.value} disabled={!x.n && x.value !== 'all'}
                onClick={() => {
                  setFilter(x.value);
                  setSel({ active: -1 });
                }}>
                {x.value.startsWith('person:') && <Icon name="faces" size={12} />}{x.label} <span className="muted">{x.n.toLocaleString()}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!folder && (
        <section className="card empty-state">
          <Icon name="faces" size={28} />
          <h2>See who is in your photos and videos</h2>
          <p className="muted">Choose a folder that face tagging ran on, or tag the faces in a folder first. Faces are matched on this
            PC or your LAN machines; no picture goes to a cloud service.</p>
          <button type="button" className="primary" onClick={() => onTag()}>Tag faces in a folder</button>
        </section>
      )}
      {folder && summary.status === 404 && (
        <section className="card empty-state">
          <Icon name="faces" size={28} />
          <h2>No face results in {folder.name} yet</h2>
          <p className="muted">Face tagging writes its results into the folder it ran on (photosort_faces.json).</p>
          <button type="button" className="primary" onClick={() => onTag(folder)}>Tag the faces in this folder</button>
        </section>
      )}
      {folder && summary.error && summary.status !== 404 && (
        <section className="card"><p className="bad">{summary.error}</p>
          <button type="button" className="ghost" onClick={() => setEpoch((n) => n + 1)}>Try again</button></section>
      )}

      {folder && data && (
        <>
          <div className="search-status" aria-live="polite">
            {paged.loading && <span className="status run"><span className="spinner" aria-hidden="true" />Loading…</span>}
            {paged.error && <><span className="bad">{paged.error}</span><button type="button" className="ghost" onClick={paged.retry}>Retry</button></>}
            {!paged.loading && !paged.error && (
              <span><b>{paged.count.toLocaleString()}</b> {paged.count === 1 ? 'file' : 'files'}
                {chosen && chosen.value !== 'all' ? <span className="muted"> · {chosen.label}</span> : null}</span>
            )}
            <span className="muted small">
              Tagged {when(data.finished_at)}{data.provider ? ` on ${data.provider}` : ''}
              {typeof data.threshold === 'number' ? ` · threshold ${data.threshold}` : ''}
              {typeof data.margin === 'number' ? ` · margin ${data.margin}` : ''}
              {data.skipped ? ` · ${data.skipped} entries outside the folder ignored` : ''}
            </span>
          </div>
          <div className={`gallery-wrap${sel.opened ? ' with-detail' : ''}`}>
            <Gallery source={paged} active={sel.active} openedId={sel.opened?.id} onActive={onActive} onOpen={onOpen} onClose={close}
              scrollKey={`faces:${dir}`} resetKey={JSON.stringify([dir, filter])} label="Face results" gridRef={grid} subtitle={faceLine}
              empty={!paged.loading && !paged.error ? <div className="empty-hint"><p>No files here.</p><p className="muted small">Pick another filter above.</p></div> : null} />
            {sel.opened && dir && <FaceDetailPane folder={dir} item={sel.opened} epoch={epoch} onClose={close} />}
          </div>
        </>
      )}
    </>
  );
}

// ---------- tagging ----------

/** A decimal in [min, max], or empty for the default; keeps what is typed until it is a valid number. */
function DecimalInput({ value, onChange, min, max, step, placeholder, label }: {
  value?: number; onChange(v: number | undefined): void; min: number; max: number; step: number; placeholder: string; label: string;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== '' ? t : value === undefined ? '' : String(value)));
  }, [value]);
  return (
    <input type="number" inputMode="decimal" step={step} min={min} max={max} placeholder={placeholder} value={text} aria-label={label}
      onChange={(e) => {
        const t = e.target.value.trim();
        setText(e.target.value);
        const n = Number(t);
        if (t === '') onChange(undefined);
        else if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
      }} />
  );
}

function PersonThumb({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  if (!viewable(item) || failed) return <span className="person-thumb empty" title={item.placeholder ? 'Only in OneDrive (not downloaded)' : item.name}><Icon name="image" size={14} /></span>;
  return <img className="person-thumb" src={mediaUrl(item, 'thumb')} alt="" title={item.name} loading="lazy" draggable={false} onError={() => setFailed(true)} />;
}

function PeopleCard({ dir }: { dir?: DirInfo }) {
  const [state, setState] = useState<{ dir?: string; people?: Person[]; problems?: string[]; error?: string }>({});
  useEffect(() => {
    if (!dir) return;
    const ctrl = new AbortController();
    api<{ people: Person[]; problems: string[] }>(`/api/faces/people?dir=${encodeURIComponent(dir.dirId)}`, { signal: ctrl.signal })
      .then((r) => setState({ dir: dir.dirId, ...r }), (e: unknown) => {
        if (!ctrl.signal.aborted) setState({ dir: dir.dirId, error: errorText(e) });
      });
    return () => ctrl.abort();
  }, [dir?.dirId]);
  const s = state.dir === dir?.dirId ? state : {};
  return (
    <section className="card">
      <div className="card-head"><h2>People</h2>{dir && <span className="muted small" title={dir.path}>{dir.name}</span>}</div>
      {!dir && <p className="muted small">Choose the people folder: one subfolder per person, named after them, holding a few clear photos of
        their face. Those are the only pictures a face is compared with.</p>}
      {dir && !s.people && !s.error && <p className="muted small">Loading…</p>}
      {s.error && <p className="bad small">{s.error}</p>}
      {s.people && !s.people.length && <p className="warn small">No person subfolders with photos in this folder yet.</p>}
      {s.people && s.people.length > 0 && (
        <ul className="people">
          {s.people.map((p) => (
            <li key={p.name}>
              <span className="person-thumbs">{p.samples.map((it) => <PersonThumb key={it.id} item={it} />)}</span>
              <span className="name" title={p.name}>{p.name}</span>
              <span className="muted small">{p.count} {p.count === 1 ? 'photo' : 'photos'}</span>
            </li>
          ))}
        </ul>
      )}
      {s.problems && s.problems.length > 0 && (
        <ul className="messages">{s.problems.map((m) => <li key={m} className="warn">{m}</li>)}</ul>
      )}
    </section>
  );
}

function WorkersCard({ workers }: { workers: string }) {
  const info = usePoll<WorkersInfo>('/api/faces/workers');
  const [check, setCheck] = useState<{ busy?: boolean; rows?: WorkerCheck[]; error?: string }>({});
  const [host, setHost] = useState('');
  const { start, busy, error } = useStart();
  const list = workers.trim();
  const fixture = info.data?.fixture === true;
  const effective = list ? list.split(',') : info.data?.effective ?? [];

  useEffect(() => setCheck({}), [list]);

  const runCheck = () => {
    setCheck({ busy: true });
    api<{ workers: WorkerCheck[] }>('/api/faces/check-workers', { method: 'POST', body: list ? { workers: list } : {} })
      .then((r) => setCheck({ rows: r.workers }), (e: unknown) => setCheck({ error: errorText(e) }));
  };
  const setUp = (h: string) => {
    if (!confirm(`Install the face worker (Python packages and the buffalo_l model, a few hundred MB) on ${h} over SSH?\n\nIt runs as a job; you can follow it on its page.`)) return;
    void start('faces-setup', { hosts: [h] });
  };
  const hostOk = HOST.test(host.trim());

  return (
    <section className="card">
      <div className="card-head">
        <h2>Face workers</h2>
        <button type="button" className="ghost" onClick={runCheck} disabled={check.busy || !!(list && list.split(',').some((w) => !WORKER.test(w.trim())))}>
          {check.busy ? 'Checking…' : 'Check'}
        </button>
      </div>
      <p className="muted small">Faces are found {effective.length ? <>on <b>{effective.join(', ')}</b></> : '…'}
        {list ? ' (set in the form)' : info.data?.configured.length ? ' (face_workers in config.json)' : ' (this PC; add LAN machines under Face workers in Settings)'}.
        Pictures go only to these machines, and SSH machines must be on your local network.</p>
      {info.error && <p className="bad small">{info.error}</p>}
      {check.error && <p className="bad small">{check.error}</p>}
      {check.rows && (
        <ul className="checks">
          {check.rows.map((r) => (
            <li key={`${r.host}:${r.threads}`}>
              <span className={`dot ${STATE[r.state].tone}`} />
              <div>
                <b>{r.host}</b>{r.threads > 1 ? <span className="muted"> · {r.threads} threads</span> : null} <span className={`small ${STATE[r.state].tone}`}>{STATE[r.state].label}</span>
                <p className="muted small">{r.detail}</p>
                {r.state === 'needs_setup' && r.host !== 'local' && !fixture && (
                  <button type="button" className="ghost" disabled={busy} onClick={() => setUp(r.host)}>Set up {r.host}…</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <details className="advanced">
        <summary>Set up another machine</summary>
        <div className="picker-paste">
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="SSH host alias, like gpu-box" aria-label="SSH host"
            spellCheck={false} disabled={fixture} />
          <button type="button" className="ghost" disabled={fixture || busy || !hostOk} onClick={() => setUp(host.trim())}>Set up…</button>
        </div>
        <p className="muted small">{fixture ? 'Fixture mode never contacts other machines.'
          : 'Uses your SSH config (key login). Then add the machine to Face workers in Settings, or to Workers in the form.'}</p>
        {error && <p className="bad small">{error}</p>}
      </details>
    </section>
  );
}

function TagPanel({ preset }: { preset?: { source: DirInfo; n: number } }) {
  const { from, query } = usePrefill();
  const recent = useRecentFolders();
  const recentPeople = useFaceFolders('people');
  const [source, setSource] = useState<DirInfo>();
  const [people, setPeople] = useState<DirInfo>();
  const [threshold, setThreshold] = useState<number>();
  const [margin, setMargin] = useState<number>();
  const [recursive, setRecursive] = useState(false);
  const [limit, setLimit] = useState<number>();
  const [workers, setWorkers] = useState('');
  const [force, setForce] = useState(false);
  const { start, busy, error } = useStart();
  // Until one is chosen, the people folder of the last run.
  const peopleDir = people ?? recentPeople[0];

  useEffect(() => {
    if (from?.kind !== 'faces') return;
    const p = from.params;
    setSource(folderOf(from, 'source'));
    setPeople(folderOf(from, 'people'));
    setThreshold(typeof p.threshold === 'number' ? p.threshold : undefined);
    setMargin(typeof p.margin === 'number' ? p.margin : undefined);
    setRecursive(p.recursive === true);
    setLimit(typeof p.limit === 'number' ? p.limit : undefined);
    setWorkers(typeof p.workers === 'string' ? p.workers : '');
    setForce(query.get('force') === '1' || p.force === true);
  }, [from, query]);

  useEffect(() => {
    if (preset) setSource(preset.source);
  }, [preset]);

  const badWorkers = workers.trim() !== '' && workers.split(',').some((w) => !WORKER.test(w.trim()));
  const params = source && peopleDir && !badWorkers ? {
    ...compact({ source: source.dirId, people: peopleDir.dirId, recursive, limit, workers: workers.replace(/\s+/g, ''), force }),
    // 0 is a real threshold or margin, so these are not compacted away.
    ...(threshold !== undefined ? { threshold } : {}),
    ...(margin !== undefined ? { margin } : {}),
  } : undefined;
  const preview = useCliPreview('faces', params);
  const same = !!source && !!peopleDir && (source.path.toLowerCase() + '\\').startsWith(peopleDir.path.toLowerCase() + '\\');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (params) void start('faces', params);
  };

  return (
    <div className="page-grid">
      <div className="stack">
        <form className="card form" onSubmit={submit}>
          <h2>Tag the faces in a folder</h2>
          <p className="muted small">Each face is compared with the reference photos in the people folder and named when it is close
            enough. Photos and videos are only read; the results go into <code>photosort_faces.json</code> in the folder.</p>
          <FolderPicker label="Photos and videos" value={source} onChange={setSource} recent={recent} />
          <FolderPicker label="People folder" value={peopleDir} onChange={setPeople} recent={recentPeople}
            hint="One subfolder per person, named after them, with a few clear photos of their face." />
          {same && <p className="warn small">Pick a folder of photos outside the people folder.</p>}
          <label className="check">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            <span>Include subfolders</span>
          </label>
          <details className="advanced">
            <summary>Advanced</summary>
            <div className="fields">
              <Field label="Threshold" hint="How alike a face must be to be named (0 to 1). Default 0.45; higher names fewer, more surely.">
                <DecimalInput label="Threshold" value={threshold} onChange={setThreshold} min={0} max={1} step={0.01} placeholder="0.45" />
              </Field>
              <Field label="Margin" hint="How much closer to one person than the next (0 to 2). Default 0.05; a tie stays unknown.">
                <DecimalInput label="Margin" value={margin} onChange={setMargin} min={0} max={2} step={0.01} placeholder="0.05" />
              </Field>
              <Field label="Only the first" hint="0 or empty: all files">
                <NumberInput label="Limit" value={limit} onChange={setLimit} min={0} max={10_000_000} placeholder="all" />
              </Field>
              <Field label="Workers" hint={badWorkers ? <span className="bad">Use HOST or HOST:THREADS, separated by commas.</span> : 'Like local or gpu-box:4,local. Default: face_workers in config.json.'}>
                <input type="text" value={workers} onChange={(e) => setWorkers(e.target.value)} placeholder="from config.json" spellCheck={false} />
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
            <button type="submit" className="primary" disabled={!params || busy || !!preview.error}>Tag faces</button>
            {!source && <span className="muted small">Choose a folder first.</span>}
            {source && !peopleDir && <span className="muted small">Choose the people folder.</span>}
          </div>
        </form>
        <PeopleCard dir={peopleDir} />
      </div>
      <div className="stack">
        <WorkersCard workers={badWorkers ? '' : workers} />
        <RecentJobs kinds={['faces', 'faces-setup']} />
      </div>
    </div>
  );
}

// ---------- the page ----------

export function FacesPage() {
  const search = useSearch();
  const qs = useMemo(() => new URLSearchParams(search), [search]);
  const jobId = qs.get('job');
  const folderId = qs.get('folder');
  const [tab, setTabState] = useState<Tab>(() => (jobId ? 'tag' : folderId ? 'results' : savedTab() ?? 'results'));
  const [folder, setFolder] = useState<DirInfo>();
  const [preset, setPreset] = useState<{ source: DirInfo; n: number }>();
  const { list } = useJobs();

  const setTab = (t: Tab) => {
    setTabState(t);
    sessionStorage.setItem('faces.tab', t);
  };

  useEffect(() => {
    if (jobId) setTabState('tag');
  }, [jobId]);
  useEffect(() => {
    if (!folderId) return;
    setTabState('results');
    const ctrl = new AbortController();
    api<DirListing>(`/api/fs/dirs?dir=${encodeURIComponent(folderId)}`, { signal: ctrl.signal })
      .then((d) => setFolder({ dirId: d.dirId, name: d.name, path: d.path }), () => undefined);
    return () => ctrl.abort();
  }, [folderId]);

  // Until a folder is chosen: the folder of the last face tagging run that finished.
  const last = useMemo(() => {
    const j = list?.jobs.find((x: JobView) => x.kind === 'faces' && (x.status === 'ok' || x.status === 'errors'));
    return folderOf(j, 'source');
  }, [list]);
  const shown = folder ?? (folderId ? undefined : last);

  const tag = (d?: DirInfo) => {
    if (d) setPreset((p) => ({ source: d, n: (p?.n ?? 0) + 1 }));
    setTab('tag');
  };

  return (
    <div className={`search-page${tab === 'results' && shown ? ' fill' : ''}`}>
      <div className="search-head">
        <div className="tabs page-tabs" role="tablist" aria-label="Faces views">
          {TABS.map((t) => (
            <button type="button" role="tab" key={t.value} aria-selected={tab === t.value} className={tab === t.value ? 'on' : ''}
              onClick={() => setTab(t.value)}>
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'results' && <ResultsView folder={shown} onFolder={setFolder} onTag={tag} />}
      <div hidden={tab !== 'tag'}><TagPanel preset={preset} /></div>
    </div>
  );
}
