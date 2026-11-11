// Small shared pieces: rows, status badges, progress bars, count bars, copy buttons, the CLI box and the page
// error boundary.
import { Component, useState, type ReactNode } from 'react';
import type { JobStatus } from '../api.ts';
import { Icon } from '../icons.tsx';
import { STATUS } from '../jobs.ts';

/** Keeps the window usable when one page throws while rendering: the navigation stays and the page can retry. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card" role="alert">
        <h2>This page hit a problem</h2>
        <p className="muted">Nothing was changed. Try the page again; if it keeps happening, reload the window.</p>
        <div className="actions">
          <button type="button" className="primary" onClick={() => this.setState({ failed: false })}>Try again</button>
          <button type="button" className="ghost" onClick={() => window.location.reload()}>Reload window</button>
        </div>
      </section>
    );
  }
}

export function Row({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="row">
      <span className="k">{k}</span>
      <span className={`v${tone ? ` ${tone}` : ''}`}>{v}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return <span className={`status ${s.tone}`}>{s.tone === 'run' && <span className="spinner" aria-hidden="true" />}{s.label}</span>;
}

/** Determinate when `total` is known; otherwise a moving stripe. Both animate transform only (GPU). */
export function Progress({ done, total, active }: { done: number; total?: number; active: boolean }) {
  const p = total ? Math.min(1, done / total) : undefined;
  return (
    <div className={`progress${p === undefined && active ? ' indeterminate' : ''}`} role="progressbar"
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={total ? done : undefined}>
      <div className="bar" style={{ transform: `scaleX(${p ?? (active ? 1 : 0)})` }} />
    </div>
  );
}

/** Horizontal bars for counts per bucket or outcome; click one to filter by it. */
export function CountBars({ counts, selected, onSelect }: {
  counts: Record<string, number>; selected?: string; onSelect?(k: string | undefined): void;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <p className="muted small">No results yet.</p>;
  const max = entries[0][1];
  return (
    <div className="bars">
      {entries.map(([k, n]) => (
        <button type="button" key={k} className={`bar-row${selected === k ? ' selected' : ''}`} disabled={!onSelect}
          onClick={() => onSelect?.(selected === k ? undefined : k)} title={onSelect ? `Show only "${k}"` : undefined}>
          <span className="bar-label">{k}</span>
          <span className="bar-track"><span className={`bar-fill${k === 'error' ? ' bad' : ''}`} style={{ transform: `scaleX(${n / max})` }} /></span>
          <span className="bar-n">{n}</span>
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="ghost" onClick={() => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }, () => undefined);
    }}>
      <Icon name="copy" size={14} /> {copied ? 'Copied' : label}
    </button>
  );
}

/** The PhotoSort command for a job, to run it from a terminal instead. */
export function CliBox({ cli, error, hint }: { cli?: string; error?: string; hint?: string }) {
  return (
    <div className="cli-box">
      <div className="cli-head">
        <span className="muted small">{hint ?? 'The same run from a terminal, in the PhotoSort folder:'}</span>
        {cli && <CopyButton text={cli} label="Copy CLI command" />}
      </div>
      {error ? <p className="bad small">{error}</p> : <pre className="cli">{cli ?? '…'}</pre>}
    </div>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`field${wide ? ' wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; title?: string }[]; onChange(v: T): void; label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value} title={o.title}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** A number input that may be left empty (then the config default applies). */
export function NumberInput({ value, onChange, min, max, placeholder, label }: {
  value?: number; onChange(v: number | undefined): void; min: number; max: number; placeholder?: string; label: string;
}) {
  return (
    <input type="number" inputMode="numeric" min={min} max={max} step={1} placeholder={placeholder} value={value ?? ''}
      aria-label={label}
      onChange={(e) => {
        const t = e.target.value.trim();
        const n = Number(t);
        onChange(t === '' || !Number.isInteger(n) ? undefined : Math.min(max, Math.max(min, n)));
      }} />
  );
}
