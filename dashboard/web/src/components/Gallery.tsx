// A virtualized grid of fixed-size tiles: only the rows in view (plus a few) are in the DOM, placed with
// transform, so 31k+ items scroll smoothly and nothing shifts when thumbnails arrive. While scrolling fast, tiles
// whose thumbnail was not seen yet wait for the scroll to settle, so a fling does not queue thousands of
// thumbnail requests. Keyboard: arrows, Page Up/Down, Home/End, Enter opens, Escape closes.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { mediaUrl, viewable, type GallerySource, type MediaItem } from '../gallery.ts';
import { Icon } from '../icons.tsx';

export const TILE_W = 172;
export const THUMB_H = 172;
export const TILE_H = 216;
const GAP = 12;
const PAD = 6;
const STRIDE = TILE_H + GAP;
const OVERSCAN = 2;
const SETTLE_MS = 140;

const savedScroll = new Map<string, number>();
const seenThumbs = new Set<string>();
const failedThumbs = new Set<string>();

function Thumb({ item, eager }: { item: MediaItem; eager: boolean }) {
  const url = mediaUrl(item, 'thumb');
  const [failed, setFailed] = useState(() => failedThumbs.has(url));
  if (!item.exists) return <span className="thumb-state bad"><Icon name="alert" size={22} />Missing</span>;
  if (item.placeholder) return <span className="thumb-state"><Icon name="cloud" size={22} />Cloud only</span>;
  if (failed) return <span className="thumb-state"><Icon name={item.kind === 'video' ? 'video' : 'image'} size={22} />No preview</span>;
  if (!eager && !seenThumbs.has(url)) return null;
  return (
    <img className="media" src={url} alt="" width={TILE_W} height={THUMB_H} decoding="async" draggable={false}
      onLoad={() => seenThumbs.add(url)}
      onError={() => {
        failedThumbs.add(url);
        setFailed(true);
      }} />
  );
}

function Tile({ item, index, count, x, y, active, opened, showScore, eager, idBase, sub, onPick }: {
  item?: MediaItem; index: number; count: number; x: number; y: number; active: boolean; opened: boolean;
  showScore: boolean; eager: boolean; idBase: string; sub?: string; onPick(i: number): void;
}) {
  const subText = sub ?? item?.folder;
  return (
    <div role="option" id={`${idBase}-${index}`} aria-selected={active} aria-posinset={index + 1} aria-setsize={count}
      aria-label={item ? `${item.name}${item.kind === 'video' ? ', video' : ''}${sub ? `, ${sub}` : ''}${item.placeholder ? ', cloud only' : ''}${item.exists ? '' : ', missing'}` : 'Loading'}
      className={`tile${active ? ' active' : ''}${opened ? ' opened' : ''}${item && !viewable(item) ? ' dim' : ''}`}
      style={{ transform: `translate(${x}px, ${y}px)`, width: TILE_W, height: TILE_H }}
      onClick={() => onPick(index)}>
      <div className="thumb" style={{ height: THUMB_H }}>
        {item ? <Thumb key={mediaUrl(item, 'thumb')} item={item} eager={eager} /> : <span className="thumb-skeleton" />}
        {item?.kind === 'video' && <span className="tile-badge" title="Video"><Icon name="video" size={14} /></span>}
        {showScore && item?.score !== undefined && <span className="tile-score" title="Match score">{item.score.toFixed(3)}</span>}
      </div>
      <div className="tile-name" title={item?.name}>{item?.name ?? '\u00a0'}</div>
      <div className="tile-sub" title={subText}>{subText ?? '\u00a0'}</div>
    </div>
  );
}

export function Gallery({ source, active, openedId, onActive, onOpen, onClose, showScore = false, scrollKey, resetKey, label, empty, gridRef, subtitle }: {
  source: GallerySource;
  active: number;
  openedId?: string;
  onActive(i: number): void;
  /** Click or Enter on a tile. */
  onOpen(i: number): void;
  /** Escape. */
  onClose(): void;
  showScore?: boolean;
  /** Where to keep the scroll position while the grid is not shown (per tab). */
  scrollKey: string;
  /** A new value scrolls back to the top (new search results, other filters). */
  resetKey: string;
  label: string;
  empty?: ReactNode;
  gridRef?: Ref<HTMLDivElement>;
  /** The line under the name (default: the folder). */
  subtitle?(item: MediaItem): string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [top, setTop] = useState(0);
  const [scrolling, setScrolling] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const range = useRef<[number, number]>([0, 0]);
  const src = useRef(source);
  src.current = source;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setSize({ w: el.clientWidth, h: el.clientHeight });
    el.scrollTop = savedScroll.get(scrollKey) ?? 0;
    setTop(el.scrollTop);
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(settle.current);
      clearTimeout(fetchTimer.current);
      fetchTimer.current = undefined;
    };
  }, [scrollKey]);

  const firstReset = useRef(true);
  useLayoutEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    const el = box.current;
    if (!el) return;
    el.scrollTop = 0;
    setTop(0);
    savedScroll.set(scrollKey, 0);
  }, [resetKey]); // only when the results are new

  const cols = Math.max(1, Math.floor((size.w - 2 * PAD + GAP) / (TILE_W + GAP)));
  const rows = Math.ceil(source.count / cols);
  const firstRow = Math.max(0, Math.floor((top - PAD) / STRIDE) - OVERSCAN);
  const lastRow = Math.min(rows - 1, Math.ceil((top + size.h) / STRIDE) + OVERSCAN);
  const first = firstRow * cols;
  const last = Math.min(source.count, (lastRow + 1) * cols) - 1;
  const pageRows = Math.max(1, Math.floor(size.h / STRIDE));

  // Ask for missing items in (and just below) the view, at most every 80 ms while scrolling.
  useEffect(() => {
    range.current = [first, last + cols * OVERSCAN * 2];
    if (!src.current.ensure || fetchTimer.current) return;
    fetchTimer.current = setTimeout(() => {
      fetchTimer.current = undefined;
      src.current.ensure?.(range.current[0], range.current[1]);
    }, 80);
  });

  useEffect(() => {
    const el = box.current;
    if (!el || active < 0 || !size.h) return;
    const y = PAD + Math.floor(active / cols) * STRIDE;
    if (y < el.scrollTop) el.scrollTop = y - PAD;
    else if (y + TILE_H > el.scrollTop + el.clientHeight) el.scrollTop = y + TILE_H - el.clientHeight + PAD;
  }, [active]); // only when the selection moves

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setTop(el.scrollTop);
    savedScroll.set(scrollKey, el.scrollTop);
    setScrolling(true);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setScrolling(false), SETTLE_MS);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = source.count;
    const at = active < 0 ? -1 : active;
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowRight': next = at + 1; break;
      case 'ArrowLeft': next = at < 0 ? 0 : at - 1; break;
      case 'ArrowDown': next = at < 0 ? 0 : at + cols; break;
      case 'ArrowUp': next = at < 0 ? 0 : at - cols; break;
      case 'PageDown': next = Math.max(0, at) + cols * pageRows; break;
      case 'PageUp': next = Math.max(0, at) - cols * pageRows; break;
      case 'Home': next = 0; break;
      case 'End': next = n - 1; break;
      case 'Enter':
      case ' ':
        if (at >= 0) onOpen(at);
        e.preventDefault();
        return;
      case 'Escape':
        onClose();
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (!n) return;
    // Down from the last row stays put; down into a shorter last row lands on its last item.
    if (e.key === 'ArrowDown' && Math.floor(Math.max(0, at) / cols) === Math.floor((n - 1) / cols) && at >= 0) return;
    onActive(Math.min(n - 1, Math.max(0, next)));
  };

  const tiles: ReactNode[] = [];
  for (let i = Math.max(0, first); i <= last; i++) {
    const item = source.get(i);
    const r = Math.floor(i / cols);
    const c = i % cols;
    tiles.push(
      <Tile key={item?.id ?? `i${i}`} item={item} index={i} count={source.count} x={PAD + c * (TILE_W + GAP)} y={PAD + r * STRIDE}
        active={i === active} opened={!!item && item.id === openedId} showScore={showScore} eager={!scrolling} idBase={idBase}
        sub={item && subtitle ? subtitle(item) : undefined}
        onPick={(k) => {
          onActive(k);
          onOpen(k);
        }} />,
    );
  }

  const setRefs = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    if (typeof gridRef === 'function') gridRef(el);
    else if (gridRef) (gridRef as { current: HTMLDivElement | null }).current = el;
  }, [gridRef]);

  return (
    <div className={`vgrid${scrolling ? ' scrolling' : ''}`} ref={setRefs} tabIndex={0} role="listbox" aria-label={label}
      aria-activedescendant={active >= first && active <= last ? `${idBase}-${active}` : undefined}
      onScroll={onScroll} onKeyDown={onKeyDown}>
      <div className="vspace" style={{ height: rows ? PAD * 2 + rows * STRIDE - GAP : 0 }}>{tiles}</div>
      {!source.count && empty && <div className="vgrid-empty">{empty}</div>}
    </div>
  );
}
