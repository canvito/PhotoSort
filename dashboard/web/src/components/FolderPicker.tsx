// Choosing a folder: browse from the roots (or recent job folders), or paste a path once. The server answers
// with opaque folder ids; the page never sends a raw path to a job.
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText, type DirInfo, type DirListing } from '../api.ts';
import { Icon } from '../icons.tsx';

export function FolderPicker({ label, value, onChange, optional, recent = [], hint }: {
  label: string;
  value?: DirInfo;
  onChange(d: DirInfo | undefined): void;
  optional?: boolean;
  recent?: DirInfo[];
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<DirInfo[]>();
  const [listing, setListing] = useState<DirListing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [pasted, setPasted] = useState('');

  const browse = async (dirId: string) => {
    setBusy(true);
    setError(undefined);
    setProblem(undefined);
    try {
      setListing(await api<DirListing>(`/api/fs/dirs?dir=${encodeURIComponent(dirId)}`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!roots) api<{ roots: DirInfo[] }>('/api/fs/roots').then((r) => setRoots(r.roots), (e: unknown) => setError(errorText(e)));
    if (value && !listing) void browse(value.dirId);
  }, [open]); // only when the panel opens

  const paste = async (e: FormEvent) => {
    e.preventDefault();
    if (!pasted.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<DirInfo & { problem?: string }>('/api/fs/resolve', { method: 'POST', body: { path: pasted } });
      setListing(await api<DirListing>(`/api/fs/dirs?dir=${encodeURIComponent(r.dirId)}`));
      setProblem(r.problem);
      setPasted('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const use = (d: DirInfo) => {
    onChange({ dirId: d.dirId, name: d.name, path: d.path });
    setOpen(false);
  };

  const shortcuts = [...(roots ?? []), ...recent.filter((r) => !roots?.some((x) => x.path === r.path))];

  return (
    <div className="field wide">
      <span className="field-label">{label}{optional && <span className="muted"> (optional)</span>}</span>
      <div className="picker-value">
        <Icon name="folder" size={16} />
        {value ? (
          <span className="picker-chosen" title={value.path}><b>{value.name}</b> <span className="muted small">{value.path}</span></span>
        ) : <span className="muted">{optional ? 'None' : 'No folder chosen'}</span>}
        <span className="spacer" />
        {optional && value && <button type="button" className="ghost" onClick={() => onChange(undefined)}>Clear</button>}
        <button type="button" className="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Close' : value ? 'Change…' : 'Choose…'}
        </button>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
      {open && (
        <div className="picker">
          <div className="picker-roots">
            {shortcuts.map((r) => (
              <button type="button" key={r.dirId} className="chip small" title={r.path} onClick={() => void browse(r.dirId)}>{r.name}</button>
            ))}
            {!roots && !error && <span className="muted small">Loading…</span>}
          </div>
          {listing && (
            <>
              <div className="picker-head">
                <button type="button" className="ghost icon" disabled={!listing.parent || busy} title="Up one folder"
                  onClick={() => listing.parent && void browse(listing.parent.dirId)}><Icon name="up" size={14} /></button>
                <span className="picker-path" title={listing.path}>{listing.path}</span>
                <span className="muted small">{listing.media} photos and videos here</span>
                <button type="button" className="primary" disabled={busy || !!problem} onClick={() => use(listing)}>Use this folder</button>
              </div>
              {problem && <p className="warn small">This folder cannot be used for a job: {problem}</p>}
              <ul className="picker-list" aria-busy={busy}>
                {listing.dirs.map((d) => (
                  <li key={d.dirId}>
                    <button type="button" onClick={() => void browse(d.dirId)} onDoubleClick={() => use(d)} title="Open (double-click to use)">
                      <Icon name="folder" size={15} />
                      <span className="name">{d.name}</span>
                      <span className="muted small">{d.media ? `${d.media} files` : ''}</span>
                      {d.hasChildren && <Icon name="chevron" size={14} />}
                    </button>
                  </li>
                ))}
                {!listing.dirs.length && <li className="muted small empty">No subfolders.</li>}
              </ul>
              {listing.truncated && <p className="muted small">Only the first 2000 subfolders are shown.</p>}
            </>
          )}
          <form className="picker-paste" onSubmit={(e) => void paste(e)}>
            <input type="text" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="…or paste a folder path, like C:\Users\you\Pictures"
              aria-label="Folder path" spellCheck={false} />
            <button type="submit" className="ghost" disabled={busy || !pasted.trim()}>Go</button>
          </form>
          {error && <p className="bad small">{error}</p>}
        </div>
      )}
    </div>
  );
}
