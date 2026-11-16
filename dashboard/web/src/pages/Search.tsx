// Index & Search: search the index in plain language, browse the whole index, and index folders (a job).
// Search and Browse share one virtualized grid and a detail pane; captions and visible text appear only in that
// pane. The page uses the app's single event stream: "index" events report the vectors loading into memory and
// index changes (then the lists reload).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearch } from 'wouter';
import { api, errorText, useIndexEvents, usePoll, type DirInfo } from '../api.ts';
import { FolderPicker } from '../components/FolderPicker.tsx';
import { compact, folderOf, RecentJobs, usePrefill, useRecentFolders, useStart } from '../components/forms.tsx';
import { Gallery } from '../components/Gallery.tsx';
import { MediaDetail } from '../components/MediaDetail.tsx';
import { CliBox, Field, NumberInput, Progress, Segmented } from '../components/ui.tsx';
import {
  bytes, quick, useBrowse, useSearchIndex, type BrowseSort, type GallerySource, type IndexStats, type MediaFilter, type MediaItem,
} from '../gallery.ts';
import { Icon } from '../icons.tsx';
import { useCliPreview } from '../jobs.ts';

type Tab = 'search' | 'browse' | 'index';
type GridTab = Exclude<Tab, 'index'>;

const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'search', label: 'Search', icon: 'search' },
  { value: 'browse', label: 'Browse', icon: 'browse' },
  { value: 'index', label: 'Index', icon: 'index' },
];
const MEDIA: { value: MediaFilter; label: string }[] = [
  { value: 'both', label: 'All' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
];
const SORTS: { value: BrowseSort; label: string; title: string }[] = [
  { value: 'folder', label: 'Folder', title: 'Folder, then name' },
  { value: 'name', label: 'Name', title: 'File name' },
  { value: 'indexed', label: 'Indexed', title: 'Most recently indexed first' },
];
const TOPS = [50, 100, 200, 500];
const MAX_SIMILAR_CHARS = 1000;

/** The index form (a job); the same as in P1, now in its own tab. */
function IndexPanel() {
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
          <h2>Search from a terminal</h2>
          <p className="muted small">The same index can also be searched from a terminal in the PhotoSort folder:</p>
          <CliBox cli={'.\\photosort.cmd search "kids at the beach"'} hint="Search the index (only on this PC):" />
        </section>
      </div>
      <RecentJobs kinds={['index']} title="Recent indexing" />
    </div>
  );
}

function StatsBar({ stats, error, onRefresh, onClearCache, note, busy }: {
  stats?: IndexStats; error?: string; onRefresh(): void; onClearCache(): void; note?: string; busy: boolean;
}) {
  return (
    <div className="index-stats">
      {stats ? (
        <>
          <span><b>{stats.total.toLocaleString()}</b> indexed</span>
          <span className="muted">{stats.photos.toLocaleString()} photos · {stats.videos.toLocaleString()} videos</span>
          <span className="muted" title={`${stats.cache.files.toLocaleString()} thumbnails and previews on this PC`}>
            Cache {bytes(stats.cache.bytes)} of {bytes(stats.cache.limitBytes)}
          </span>
          {stats.matrix.loaded && (
            <span className="badge" title={`${stats.matrix.rows.toLocaleString()} search vectors (${bytes(stats.matrix.bytes)}) in memory`}>IN MEMORY</span>
          )}
        </>
      ) : error ? <span className="bad small">{error}</span> : <span className="muted small">Loading the index…</span>}
      {note && <span className="muted small">{note}</span>}
      <span className="spacer" />
      <button type="button" className="ghost" onClick={onRefresh} title="Reload the index counts, the lists and the open file">
        <Icon name="refresh" size={14} /> Refresh
      </button>
      <button type="button" className="ghost" onClick={onClearCache} disabled={busy || !stats?.cache.files}
        title="Delete the thumbnails and previews made for the dashboard; they are made again when shown">
        Clear cache
      </button>
    </div>
  );
}

/** "All folders" or the chosen one, with the folder picker opening below. */
function FolderFilter({ value, onChange }: { value?: DirInfo; onChange(d: DirInfo | undefined): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="folder-filter">
        <button type="button" className={`chip small${value ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}
          title={value?.path ?? 'Only show files from one folder (and its subfolders)'}>
          <Icon name="folder" size={14} /> {value ? value.name : 'All folders'}
        </button>
        {value && (
          <button type="button" className="ghost icon" onClick={() => onChange(undefined)} title="All folders" aria-label="Clear the folder filter">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {open && (
        <div className="folder-filter-panel">
          <FolderPicker label="Only in this folder (and its subfolders)" optional value={value}
            onChange={(d) => {
              onChange(d);
              if (d) setOpen(false);
            }} />
        </div>
      )}
    </>
  );
}

/** A score from -1 to 1, or empty for no limit; keeps what is typed until it is a valid number. */
function MinScore({ value, onChange }: { value?: number; onChange(v: number | undefined): void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  return (
    <label className="inline-field" title="Hide matches that score below this (-1 to 1; empty: no limit)">
      <span>Min score</span>
      <input type="number" step={0.05} min={-1} max={1} placeholder="any" value={text} aria-label="Minimum score"
        onChange={(e) => {
          const t = e.target.value.trim();
          setText(e.target.value);
          const n = Number(t);
          if (t === '') onChange(undefined);
          else if (Number.isFinite(n) && n >= -1 && n <= 1) onChange(n);
        }} />
    </label>
  );
}

function NoIndex({ onIndex }: { onIndex(): void }) {
  return (
    <section className="card empty-state">
      <Icon name="index" size={28} />
      <h2>No index yet</h2>
      <p className="muted">Index a folder first: a local model describes each photo and video so you can find them by what
        they show. Nothing leaves your PCs.</p>
      <button type="button" className="primary" onClick={onIndex}>Index a folder</button>
    </section>
  );
}

const savedTab = (): GridTab | undefined => {
  const t = sessionStorage.getItem('search.tab');
  return t === 'search' || t === 'browse' ? t : undefined;
};

export function SearchPage() {
  const qs = new URLSearchParams(useSearch());
  const jobId = qs.get('job');
  const [tab, setTabState] = useState<Tab>(() => (jobId || qs.get('tab') === 'index' ? 'index' : savedTab() ?? 'search'));
  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    if (t !== 'index') sessionStorage.setItem('search.tab', t);
  }, []);
  // "Edit and run again" on an index job opens the form.
  useEffect(() => {
    if (jobId) setTab('index');
  }, [jobId, setTab]);

  const [query, setQuery] = useState('');
  const [media, setMedia] = useState<MediaFilter>('both');
  const [folder, setFolder] = useState<DirInfo>();
  const [sort, setSort] = useState<BrowseSort>('folder');
  const [minScore, setMinScore] = useState<number>();
  const [top, setTop] = useState(100);
  const [gen, setGen] = useState<number>();
  const [epoch, setEpoch] = useState(0);
  const [loadingVectors, setLoadingVectors] = useState<{ done: number; total: number }>();
  const [warmNote, setWarmNote] = useState<string>();
  const [cache, setCache] = useState<{ busy: boolean; note?: string }>({ busy: false });
  const [sel, setSel] = useState<Record<GridTab, { active: number; opened?: MediaItem }>>({ search: { active: -1 }, browse: { active: -1 } });
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const warmed = useRef(false);

  const stats = usePoll<IndexStats>('/api/index/stats', 30000);
  const reloadStats = stats.reload;
  useEffect(() => {
    if (stats.data) setGen(stats.data.generation);
  }, [stats.data]);
  const onGeneration = useCallback((g: number) => setGen(g), []);

  useIndexEvents((e) => {
    if (e.type === 'loading' && typeof e.total === 'number') {
      const done = e.done ?? 0;
      setLoadingVectors(done < e.total ? { done, total: e.total } : undefined);
      if (done >= e.total) reloadStats();
    } else if (e.type === 'changed') {
      if (typeof e.generation === 'number') setGen(e.generation);
      reloadStats();
    } else if (e.type === 'reconnected') {
      reloadStats();
    }
  });

  const hasIndex = !!stats.data && (stats.data.ready || stats.data.total > 0);
  const dir = folder?.dirId;
  const browse = useBrowse({ sort, media, dir }, gen, tab === 'browse' && hasIndex, onGeneration);
  const search = useSearchIndex({ query, media, dir, top, minScore }, gen, tab === 'search' && hasIndex, onGeneration);
  const results = search.reply?.results;
  const searchSource = useMemo<GallerySource>(() => ({ count: results?.length ?? 0, get: (i) => results?.[i] }), [results]);

  // New results: nothing is selected until the user moves into the grid; an open pane stays.
  useEffect(() => {
    setSel((s) => ({ ...s, search: { active: -1, opened: s.search.opened } }));
  }, [search.seq]);

  useEffect(() => {
    if (!search.pending) setLoadingVectors(undefined);
  }, [search.pending]);

  const gridTab: GridTab = tab === 'browse' ? 'browse' : 'search';
  const source: GallerySource = gridTab === 'browse' ? browse : searchSource;
  const cur = sel[gridTab];

  const focusSearch = useCallback(() => {
    setTab('search');
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, [setTab]);

  const close = useCallback(() => {
    setSel((s) => ({ ...s, [gridTab]: { ...s[gridTab], opened: undefined } }));
    grid.current?.focus();
  }, [gridTab]);

  useEffect(() => {
    if (tab === 'index') return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        focusSearch();
      } else if (e.key === 'Escape' && !typing && cur.opened && !e.defaultPrevented) {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, cur.opened, focusSearch, close]);

  // With the pane open, moving through the grid shows each item in it.
  const onActive = (i: number) => {
    setSel((s) => {
      const it = s[gridTab].opened ? source.get(i) : undefined;
      return { ...s, [gridTab]: { active: i, opened: it ?? s[gridTab].opened } };
    });
  };
  const onOpen = (i: number) => {
    const it = source.get(i);
    if (it) setSel((s) => ({ ...s, [gridTab]: { active: i, opened: it } }));
  };

  const refresh = () => {
    reloadStats();
    browse.retry();
    if (tab === 'search') search.rerun();
    setEpoch((n) => n + 1);
  };

  const clearCache = () => {
    setCache({ busy: true });
    api<{ ok: boolean }>('/api/cache/clear', { method: 'POST', body: {} })
      .then(() => setCache({ busy: false, note: 'Cache cleared.' }), (e: unknown) => setCache({ busy: false, note: errorText(e) }))
      .finally(reloadStats);
  };

  // Load the search vectors into memory when the search box is first focused, so the first search is quick.
  const warm = () => {
    if (warmed.current || !stats.data || !hasIndex || stats.data.matrix.loaded) return;
    warmed.current = true;
    api<{ rows: number; ms: number }>('/api/search/warm', { method: 'POST', body: {} })
      .then((r) => {
        setWarmNote(`${r.rows.toLocaleString()} items ready in ${quick(r.ms / 1000)}`);
        reloadStats();
      }, () => {
        warmed.current = false;
      })
      .finally(() => setLoadingVectors(undefined));
  };

  const findSimilar = (caption: string) => {
    const opened = cur.opened;
    setQuery(caption.slice(0, MAX_SIMILAR_CHARS));
    setSel((s) => ({ ...s, search: { active: -1, opened } }));
    setTab('search');
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search.now();
    } else if (e.key === 'ArrowDown' && searchSource.count) {
      e.preventDefault();
      if (sel.search.active < 0) setSel((s) => ({ ...s, search: { ...s.search, active: 0 } }));
      grid.current?.focus();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };

  const reply = search.reply;
  const q = query.trim();
  const statusLine = gridTab === 'search' ? (
    <div className="search-status" aria-live="polite">
      {search.pending && <span className="status run"><span className="spinner" aria-hidden="true" />Searching…</span>}
      {search.error && <span className="bad">{search.error}</span>}
      {!search.error && reply && q && (
        <span>
          <b>{reply.results.length.toLocaleString()}</b> {reply.results.length === 1 ? 'match' : 'matches'} in <b>{quick(reply.elapsed_s)}</b>
          <span className="muted"> ({search.roundTripMs} ms round trip) · searched {reply.searched.toLocaleString()}</span>
          {reply.skipped_other_model > 0 && (
            <span className="warn"> · {reply.skipped_other_model.toLocaleString()} skipped (made with another embedding model; index them again)</span>
          )}
        </span>
      )}
      {!q && <span className="muted">Describe what you are looking for, like “kids at the beach” or “a receipt”. <kbd>/</kbd> to type, <kbd>Enter</kbd> to search now.</span>}
      {warmNote && !search.pending && <span className="muted small">{warmNote}</span>}
    </div>
  ) : (
    <div className="search-status" aria-live="polite">
      {browse.loading && <span className="status run"><span className="spinner" aria-hidden="true" />Loading…</span>}
      {browse.error && <><span className="bad">{browse.error}</span><button type="button" className="ghost" onClick={browse.retry}>Retry</button></>}
      {!browse.loading && !browse.error && (
        <span><b>{browse.count.toLocaleString()}</b> {browse.count === 1 ? 'file' : 'files'}{folder ? <span className="muted"> in {folder.name}</span> : null}
          <span className="muted"> · sorted by {SORTS.find((s) => s.value === sort)?.title.toLowerCase()}</span></span>
      )}
    </div>
  );

  const empty = gridTab === 'search'
    ? (!q ? (
      <div className="empty-hint">
        <Icon name="search" size={28} />
        <p>Search your photos and videos in plain language.</p>
        <p className="muted small">The local model embeds the query; results come from the index on this PC.</p>
      </div>
    ) : reply && !search.pending && reply.results.length === 0 ? (
      <div className="empty-hint"><p>No matches.</p><p className="muted small">Try other words, all kinds of files, all folders or a lower minimum score.</p></div>
    ) : null)
    : (!browse.loading && !browse.error
      ? <div className="empty-hint"><p>No files here.</p><p className="muted small">Try all kinds of files or all folders.</p></div>
      : null);

  return (
    <div className={`search-page${tab === 'index' ? '' : ' fill'}`}>
      <div className="search-head">
        <div className="tabs page-tabs" role="tablist" aria-label="Search views">
          {TABS.map((t) => (
            <button type="button" role="tab" key={t.value} aria-selected={tab === t.value} className={tab === t.value ? 'on' : ''}
              onClick={() => setTab(t.value)}>
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </div>
        <StatsBar stats={stats.data} error={stats.error} onRefresh={refresh} onClearCache={clearCache} note={cache.note} busy={cache.busy} />
      </div>

      {tab !== 'index' && !stats.data && stats.error && (
        <section className="card"><p className="bad">{stats.error}</p><button type="button" className="ghost" onClick={reloadStats}>Try again</button></section>
      )}
      {tab !== 'index' && stats.data && !hasIndex && <NoIndex onIndex={() => setTab('index')} />}

      {tab !== 'index' && hasIndex && (
        <>
          <div className="search-toolbar">
            {tab === 'search' && (
              <div className="searchbox">
                <Icon name="search" size={18} />
                <input ref={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onInputKey} onFocus={warm}
                  placeholder="Search photos and videos…" aria-label="Search" maxLength={2000} spellCheck={false} autoComplete="off" />
                {search.pending && <span className="spinner" aria-hidden="true" />}
                <kbd title="Press / to search">/</kbd>
              </div>
            )}
            <div className="filters">
              <Segmented<MediaFilter> label="Kind of files" value={media} options={MEDIA} onChange={setMedia} />
              {tab === 'browse' && <Segmented<BrowseSort> label="Sort by" value={sort} options={SORTS} onChange={setSort} />}
              {tab === 'search' && <MinScore value={minScore} onChange={setMinScore} />}
              {tab === 'search' && (
                <label className="inline-field" title="How many matches to show at most">
                  <span>Show</span>
                  <select value={top} onChange={(e) => setTop(Number(e.target.value))} aria-label="Number of matches">
                    {TOPS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              <FolderFilter value={folder} onChange={setFolder} />
            </div>
          </div>
          {loadingVectors && (
            <div className="vectors-loading">
              <span className="small">Loading {loadingVectors.total.toLocaleString()} items into memory…</span>
              <Progress done={loadingVectors.done} total={loadingVectors.total} active />
            </div>
          )}
          {statusLine}
          <div className={`gallery-wrap${cur.opened ? ' with-detail' : ''}`}>
            <Gallery key={gridTab} source={source} active={cur.active} openedId={cur.opened?.id} onActive={onActive} onOpen={onOpen} onClose={close}
              showScore={gridTab === 'search'} scrollKey={gridTab}
              resetKey={gridTab === 'search' ? String(search.seq ?? 0) : JSON.stringify([sort, media, dir ?? ''])}
              label={gridTab === 'search' ? 'Search results' : 'All indexed files'} empty={empty} gridRef={grid} />
            {cur.opened && (
              <MediaDetail item={cur.opened} generation={gen} epoch={epoch} onClose={close} onFindSimilar={findSimilar} />
            )}
          </div>
        </>
      )}

      <div hidden={tab !== 'index'}><IndexPanel /></div>
    </div>
  );
}
