// The per-file results of a job, newest first. Only the visible rows are in the DOM (fixed row height, rows
// placed with transform), so thousands of results scroll smoothly.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JobItem } from '../api.ts';
import { itemLabel } from '../jobs.ts';

const ROW = 30;
const PHASE_LABEL: Record<string, string> = { check: 'Checked', same_event: 'Same event', move: 'Result', sort: 'Sorted', caption: 'Indexed', undo: 'Moved back', apply: 'Applied' };

const pct = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : '');
const folderOf = (p: string): string => p.split(/[\\/]/).slice(-2, -1)[0] ?? '';

function detail(it: JobItem): string {
  if (it.error) return it.error;
  const r = it.result ?? {};
  if (typeof r.dst === 'string') return `→ ${folderOf(r.dst)}`;
  if (typeof r.from === 'string') return `from ${folderOf(r.from)}`;
  return '';
}

export function ItemTable({ items, older, filter, phase: wanted }: { items: JobItem[]; older: number; filter?: string; phase?: string }) {
  const phases = useMemo(() => [...new Set(items.map((i) => i.phase))], [items]);
  const [picked, setPicked] = useState<string>();
  const phase = picked && phases.includes(picked) ? picked : (wanted && phases.includes(wanted) ? wanted : phases.at(-1));
  const shown = useMemo(() => {
    const out: JobItem[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.phase === phase && (!filter || itemLabel(it) === filter)) out.push(it);
    }
    return out;
  }, [items, phase, filter]);

  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / ROW) - 8);
  const last = Math.min(shown.length, Math.ceil((top + height) / ROW) + 8);

  return (
    <div className="items">
      {phases.length > 1 && (
        <div className="tabs" role="tablist">
          {phases.map((p) => (
            <button type="button" role="tab" key={p} aria-selected={p === phase} className={p === phase ? 'on' : ''} onClick={() => setPicked(p)}>
              {PHASE_LABEL[p] ?? p}
            </button>
          ))}
        </div>
      )}
      <div className="table" role="table" aria-rowcount={shown.length}>
        <div className="tr thead" role="row">
          <span role="columnheader">#</span><span role="columnheader">File</span><span role="columnheader">Result</span>
          <span role="columnheader">Conf.</span><span role="columnheader">Detail</span>
        </div>
        <div className="tbody" ref={box} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
          <div className="tspace" style={{ height: shown.length * ROW }}>
            {shown.slice(first, last).map((it, k) => {
              const label = itemLabel(it);
              return (
                <div className={`tr${it.error ? ' err' : ''}`} role="row" key={it.seq} style={{ transform: `translateY(${(first + k) * ROW}px)` }}>
                  <span className="muted">{it.n ?? ''}</span>
                  <span className="name" title={it.path}>{it.name}</span>
                  <span className={label === 'error' ? 'bad' : ''}>{label}</span>
                  <span className="muted">{pct(it.result?.confidence)}</span>
                  <span className="muted" title={detail(it)}>{detail(it)}</span>
                </div>
              );
            })}
          </div>
          {!shown.length && <p className="muted small empty">{filter ? `No "${filter}" results.` : 'No files yet.'}</p>}
        </div>
      </div>
      {older > 0 && <p className="muted small">Showing the newest {items.length.toLocaleString()} results; {older.toLocaleString()} earlier ones are not listed here.</p>}
    </div>
  );
}
