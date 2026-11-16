// The search index in the page: stats, paged browsing of the whole index, searching, and media URLs.
// Pages and search results are dropped when the index generation changes, and stale replies are ignored.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, errorText } from './api.ts';

export type MediaFilter = 'both' | 'photos' | 'videos';
export type BrowseSort = 'name' | 'folder' | 'indexed';

export interface MediaItem {
  id: string;
  name: string;
  folder: string;
  kind: 'photo' | 'video';
  size: number;
  /** Null for files outside the index (face results list any file they found). */
  indexed_at: string | null;
  people_count: number;
  exists: boolean;
  /** Cloud-only (OneDrive Files On-Demand): the dashboard never downloads it. */
  placeholder: boolean;
  revision: string;
  score?: number;
}

export interface MediaDetail extends MediaItem {
  indexed_at: string;
  path: string;
  caption: string;
  scene: string;
  objects: string[];
  text: string;
  caption_model: string;
  embed_model: string;
}

export interface IndexStats {
  total: number;
  videos: number;
  photos: number;
  ready: boolean;
  generation: number;
  cache: { bytes: number; files: number; limitBytes: number };
  matrix: { loaded: boolean; rows: number; bytes: number };
}

export interface ItemsPage {
  items: MediaItem[];
  total: number;
  nextCursor: number | null;
  generation: number;
}

export interface SearchReply {
  results: MediaItem[];
  searched: number;
  skipped_other_model: number;
  elapsed_s: number;
  generation: number;
}

export type MediaVariant = 'thumb' | 'preview' | 'original' | 'strip';

/** The server answers 409 for cloud-only files and stale revisions and 404 for missing ones; callers skip those. */
export function mediaUrl(it: Pick<MediaItem, 'id' | 'revision'>, variant: MediaVariant): string {
  return `/media/${encodeURIComponent(it.id)}/${variant}?v=${encodeURIComponent(it.revision)}`;
}

/** Whether the server can show this file's pixels (it is on disk and not cloud-only). */
export const viewable = (it: MediaItem): boolean => it.exists && !it.placeholder;

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Short durations for search: milliseconds below one second. */
export function quick(seconds: number): string {
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))} ms`;
  return `${(Math.round(seconds * 100) / 100).toFixed(2)} s`;
}

/** What a grid shows: a count and the items known so far (browse pages load as they scroll into view). */
export interface GallerySource {
  count: number;
  get(i: number): MediaItem | undefined;
  ensure?(first: number, last: number): void;
}

// ---------- browsing the whole index ----------

export const BROWSE_PAGE = 200;
const MAX_INFLIGHT = 3;

export interface BrowseParams {
  sort: BrowseSort;
  media: MediaFilter;
  dir?: string;
}

export interface Browse extends GallerySource {
  loading: boolean;
  error?: string;
  retry(): void;
}

export interface Paged<T extends MediaItem> extends Browse {
  get(i: number): T | undefined;
}

interface BrowseState {
  key: string;
  ctrl: AbortController;
  pages: Map<number, MediaItem[]>;
  inflight: Set<number>;
  failed: Set<number>;
  total?: number;
  gen?: number;
  error?: string;
}

const freshState = (key: string): BrowseState => ({
  key, ctrl: new AbortController(), pages: new Map(), inflight: new Set(), failed: new Set(),
});

/** The whole index as a sparse list: pages of BROWSE_PAGE items are fetched for the visible range only.
 * `generation` is part of the key, so a changed index drops every page; `onGeneration` reports a newer one seen
 * in a reply (the parent then bumps `generation`). Nothing is fetched until `enabled`. */
export function useBrowse(params: BrowseParams, generation: number | undefined, enabled: boolean,
  onGeneration: (g: number) => void): Browse {
  const query: Record<string, string> = { sort: params.sort, media: params.media };
  if (params.dir) query.dir = params.dir;
  return usePaged<MediaItem>('/api/index/items', query, generation, enabled, onGeneration);
}

/** Any paged list the server answers with `{items, total, generation}` (the index, face results), loaded the
 * same way as the index browse: by page, for the visible range only, dropped when the generation changes. */
export function usePaged<T extends MediaItem>(endpoint: string, query: Record<string, string>, generation: number | undefined,
  enabled: boolean, onGeneration: (g: number) => void): Paged<T> {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const [epoch, setEpoch] = useState(0);
  const queryKey = JSON.stringify([endpoint, Object.entries(query).sort()]);
  const key = JSON.stringify([queryKey, generation ?? -1, epoch]);
  const st = useRef<BrowseState>(freshState(key));
  // A new key drops the old pages at once (no frame of old items under new filters); the abort is idempotent.
  if (st.current.key !== key) {
    st.current.ctrl.abort();
    st.current = freshState(key);
  }
  const genCb = useRef(onGeneration);
  genCb.current = onGeneration;

  const fetchPage = useCallback((s: BrowseState, page: number) => {
    s.inflight.add(page);
    const [url, entries] = JSON.parse(queryKey) as [string, [string, string][]];
    const q = new URLSearchParams([...entries, ['cursor', String(page * BROWSE_PAGE)], ['limit', String(BROWSE_PAGE)]]);
    api<ItemsPage>(`${url}?${q}`, { signal: s.ctrl.signal })
      .then((r) => {
        if (st.current !== s) return;
        if (s.gen !== undefined && r.generation !== s.gen) {
          // The index changed between pages: these pages no longer line up, so start over.
          s.pages.clear();
          genCb.current(r.generation);
          setEpoch((n) => n + 1);
          return;
        }
        s.gen = r.generation;
        if (r.generation !== generation) genCb.current(r.generation);
        s.pages.set(page, r.items);
        s.total = r.total;
        s.error = undefined;
      })
      .catch((e: unknown) => {
        if (st.current !== s || s.ctrl.signal.aborted) return;
        s.failed.add(page);
        s.error = errorText(e);
      })
      .finally(() => {
        s.inflight.delete(page);
        if (st.current === s) bump();
      });
  }, [queryKey, generation]);

  // The first page gives the total; the grid asks for the rest as it scrolls. Pages stay while the tab is hidden.
  useEffect(() => {
    const s = st.current;
    if (enabled && generation !== undefined && s.total === undefined && !s.inflight.has(0) && !s.failed.has(0)) fetchPage(s, 0);
  }, [key, enabled, generation, fetchPage, version]);

  useEffect(() => () => {
    st.current.ctrl.abort();
    st.current = freshState(st.current.key);
  }, []);

  const ensure = useCallback((first: number, last: number) => {
    const s = st.current;
    if (!enabled || generation === undefined || s.total === undefined) return;
    const end = Math.min(last, s.total - 1);
    for (let p = Math.floor(Math.max(0, first) / BROWSE_PAGE); p <= Math.floor(end / BROWSE_PAGE); p++) {
      if (s.inflight.size >= MAX_INFLIGHT) break;
      if (!s.pages.has(p) && !s.inflight.has(p) && !s.failed.has(p)) fetchPage(s, p);
    }
  }, [enabled, generation, fetchPage]);

  const s = st.current;
  // `version` changes whenever a page lands, so the grid re-renders with the new items.
  return useMemo(() => ({
    count: s.total ?? 0,
    get: (i: number) => s.pages.get(Math.floor(i / BROWSE_PAGE))?.[i % BROWSE_PAGE] as T | undefined,
    ensure,
    loading: s.total === undefined && !s.error,
    error: s.error,
    retry: () => setEpoch((n) => n + 1),
  }), [s, version, ensure]);
}

// ---------- searching ----------

export interface SearchParams {
  query: string;
  media: MediaFilter;
  dir?: string;
  top: number;
  minScore?: number;
}

export interface SearchState {
  /** The query the results are for. */
  query?: string;
  reply?: SearchReply;
  /** Browser-measured time from request to reply. */
  roundTripMs?: number;
  pending: boolean;
  error?: string;
  /** Changes with every new reply. */
  seq?: number;
}

/** Searches 250 ms after the last change (or at once with `now()`); aborts the request before and ignores
 * replies that are not for the latest one. Runs again when `generation` changes. */
export function useSearchIndex(params: SearchParams, generation: number | undefined, enabled: boolean,
  onGeneration: (g: number) => void): SearchState & { now(): void; clear(): void; rerun(): void } {
  const [state, setState] = useState<SearchState>({ pending: false });
  const ctrl = useRef<AbortController>(undefined);
  const seq = useRef(0);
  const lastKey = useRef('');
  const genCb = useRef(onGeneration);
  genCb.current = onGeneration;
  const query = params.query.trim();
  const key = JSON.stringify([query, params.media, params.dir ?? '', params.top, params.minScore ?? null, generation ?? -1]);

  const run = useCallback(() => {
    if (!query || generation === undefined) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const n = ++seq.current;
    lastKey.current = key;
    setState((s) => ({ ...s, pending: true, error: undefined }));
    const body: Record<string, unknown> = { query, media: params.media, top: params.top };
    if (params.dir) body.dir = params.dir;
    if (params.minScore !== undefined) body.minScore = params.minScore;
    const t0 = performance.now();
    api<SearchReply>('/api/search', { method: 'POST', body, signal: c.signal })
      .then((reply) => {
        if (n !== seq.current) return;
        setState({ query, reply, roundTripMs: Math.round(performance.now() - t0), pending: false, seq: n });
        if (reply.generation !== generation) genCb.current(reply.generation);
      })
      .catch((e: unknown) => {
        if (n !== seq.current || c.signal.aborted) return;
        lastKey.current = '';
        setState((s) => ({ ...s, pending: false, error: errorText(e) }));
      });
  }, [key]); // the key holds every input of the request

  useEffect(() => {
    if (!enabled || generation === undefined) return;
    if (!query) {
      ctrl.current?.abort();
      seq.current++;
      lastKey.current = '';
      setState({ pending: false });
      return;
    }
    if (key === lastKey.current) return;
    const t = setTimeout(run, 250);
    return () => clearTimeout(t);
  }, [key, enabled, run, query, generation]);

  useEffect(() => () => ctrl.current?.abort(), []);

  return {
    ...state,
    now: run,
    rerun: () => {
      lastKey.current = '';
      run();
    },
    clear: () => {
      ctrl.current?.abort();
      seq.current++;
      lastKey.current = '';
      setState({ pending: false });
    },
  };
}

// ---------- one item's details ----------

export interface DetailState {
  detail?: MediaDetail;
  loading: boolean;
  error?: string;
  status?: number;
}

/** The full record of the opened item only (never prefetched); waits 120 ms so arrowing through tiles with the
 * pane open does not fetch every one. */
export function useDetail(item: MediaItem | undefined, generation: number | undefined, epoch: number): DetailState {
  const [state, setState] = useState<DetailState>({ loading: false });
  const id = item?.id;
  useEffect(() => {
    if (!id) {
      setState({ loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ detail: s.detail?.id === id ? s.detail : undefined, loading: true }));
    const t = setTimeout(() => {
      api<MediaDetail>(`/api/index/items/${encodeURIComponent(id)}`, { signal: ctrl.signal })
        .then((detail) => setState({ detail, loading: false }))
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState({ loading: false, error: errorText(e), status: (e as { status?: number }).status });
        });
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [id, generation, epoch]);
  return state;
}
