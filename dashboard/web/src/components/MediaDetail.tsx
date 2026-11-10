// The opened item: a large preview (photos) or the video with Chromium's hardware decoding, falling back to the
// 8-frame strip when the format cannot play; then caption, scene, objects, visible text, people and path.
// Everything from the index is rendered as plain text. Cloud-only files are never downloaded.
import { useState, type KeyboardEvent } from 'react';
import { api, errorText } from '../api.ts';
import { bytes, mediaUrl, useDetail, type MediaItem } from '../gallery.ts';
import { Icon } from '../icons.tsx';
import { CopyButton, Row } from './ui.tsx';

function Strip({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="viewer-state"><Icon name="frames" size={28} /><span>No frames available for this video.</span></div>;
  return <img className="media viewer-strip" src={mediaUrl(item, 'strip')} alt="Frames from the video" draggable={false} onError={() => setFailed(true)} />;
}

function Viewer({ item }: { item: MediaItem }) {
  const [frames, setFrames] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!item.exists) {
    return (
      <div className="viewer-state bad">
        <Icon name="alert" size={28} />
        <b>File missing</b>
        <span>It is no longer where it was indexed (moved, renamed or deleted). Index its folder again to update the index.</span>
      </div>
    );
  }
  if (item.placeholder) {
    return (
      <div className="viewer-state">
        <Icon name="cloud" size={28} />
        <b>Only in OneDrive (cloud-only)</b>
        <span>PhotoSort does not download it to show it. To see it here, right-click it in File Explorer, choose
          <b> Always keep on this device</b>, wait for the download, then press Refresh.</span>
      </div>
    );
  }
  if (item.kind === 'photo') {
    return (
      <div className="viewer">
        {!loaded && <img className="media viewer-low" src={mediaUrl(item, 'thumb')} alt="" draggable={false} />}
        {failed ? (
          <div className="viewer-state"><Icon name="image" size={28} /><span>The preview could not be made. If the file changed, press Refresh.</span></div>
        ) : (
          <img className={`media viewer-img${loaded ? ' loaded' : ''}`} src={mediaUrl(item, 'preview')} alt={item.name} draggable={false}
            onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        )}
      </div>
    );
  }
  const strip = frames || videoFailed;
  return (
    <>
      <div className={`viewer${strip ? ' natural' : ''}`}>
        {strip ? <Strip item={item} /> : (
          <video className="media viewer-video" controls preload="metadata" poster={mediaUrl(item, 'thumb')} src={mediaUrl(item, 'original')}
            onError={() => setVideoFailed(true)} />
        )}
      </div>
      <div className="viewer-bar">
        {videoFailed
          ? <span className="muted small">This video format cannot play here, so its frames are shown.</span>
          : (
            <button type="button" className="ghost" onClick={() => setFrames((f) => !f)} aria-pressed={frames}>
              <Icon name={frames ? 'video' : 'frames'} size={14} /> {frames ? 'Show video' : 'Show frames'}
            </button>
          )}
      </div>
    </>
  );
}

export function MediaDetail({ item, generation, epoch, onClose, onFindSimilar }: {
  item: MediaItem;
  generation?: number;
  /** Bumped by Refresh: fetch the record again. */
  epoch: number;
  onClose(): void;
  onFindSimilar(caption: string): void;
}) {
  const { detail, loading, error, status } = useDetail(item, generation, epoch);
  const d = detail?.id === item.id ? detail : undefined;
  const cur: MediaItem = d ?? item;
  const [revealState, setReveal] = useState<{ id?: string; busy?: boolean; done?: boolean; error?: string }>({});
  const reveal = revealState.id === item.id ? revealState : {};

  const doReveal = () => {
    const id = item.id;
    setReveal({ id, busy: true });
    api<{ ok: boolean }>(`/api/media/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: {} })
      .then(() => setReveal({ id, done: true }), (e: unknown) => setReveal({ id, error: errorText(e) }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const problem = error && (status === 404
    ? 'This file is no longer in the index. Press Refresh.'
    : status === 409 ? 'The index changed since this list was loaded. Press Refresh.' : error);

  return (
    <aside className="detail" aria-label="Details" onKeyDown={onKeyDown}>
      <div className="detail-head">
        <Icon name={cur.kind === 'video' ? 'video' : 'image'} size={16} />
        <h2 title={cur.name}>{cur.name}</h2>
        <button type="button" className="ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close details"><Icon name="x" size={14} /></button>
      </div>
      <Viewer key={`${cur.id}:${cur.revision}:${epoch}`} item={cur} />
      <div className="actions">
        <button type="button" className="ghost" onClick={doReveal} disabled={!cur.exists || reveal.busy}
          title="Open File Explorer with this file selected">
          <Icon name="folder" size={14} /> {reveal.done ? 'Shown in Explorer' : 'Reveal in Explorer'}
        </button>
        <button type="button" className="ghost" disabled={!d?.caption} onClick={() => d && onFindSimilar(d.caption)}
          title="Search with this file's description (the local model embeds it; nothing leaves this PC)">
          <Icon name="similar" size={14} /> Find similar
        </button>
      </div>
      {reveal.error && <p className="bad small">{reveal.error}</p>}
      {problem && <p className="bad small">{problem}</p>}
      <div className="detail-rows">
        {cur.score !== undefined && <Row k="Match score" v={cur.score.toFixed(3)} />}
        <Row k="Kind" v={cur.kind === 'video' ? 'Video' : 'Photo'} />
        <Row k="Size" v={bytes(cur.size)} />
        <Row k="People" v={cur.people_count} />
        <Row k="Indexed" v={cur.indexed_at ? new Date(cur.indexed_at).toLocaleString() : '—'} />
        <Row k="Folder" v={cur.folder} />
      </div>
      {loading && !d && <p className="muted small">Loading the description…</p>}
      {d && (
        <div className="detail-text">
          <section>
            <h3>Description</h3>
            <p className="caption">{d.caption || <span className="muted">None</span>}</p>
          </section>
          {d.scene && (
            <section>
              <h3>Scene</h3>
              <p className="caption">{d.scene}</p>
            </section>
          )}
          {d.objects.length > 0 && (
            <section>
              <h3>Objects</h3>
              <ul className="tags caption">{d.objects.map((o, i) => <li key={`${i}:${o}`}>{o}</li>)}</ul>
            </section>
          )}
          {d.text && (
            <section>
              <h3>Visible text</h3>
              <pre className="caption visible-text">{d.text}</pre>
            </section>
          )}
          <section>
            <div className="detail-path-head"><h3>Path</h3><CopyButton text={d.path} label="Copy path" /></div>
            <p className="detail-path">{d.path}</p>
          </section>
          <p className="muted small">Described by {d.caption_model || 'unknown'} · embedded by {d.embed_model || 'unknown'}</p>
        </div>
      )}
    </aside>
  );
}
