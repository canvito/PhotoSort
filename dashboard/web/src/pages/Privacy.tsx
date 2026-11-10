import type { Ctx } from '../App.tsx';

interface Check {
  label: string;
  state: 'ok' | 'bad' | 'warn' | 'pending';
  why: string;
}

export function Privacy({ ctx }: { ctx: Ctx }) {
  const { pair, shell, meta } = ctx;
  const nonLoopback = pair?.error?.includes('non-loopback') ?? false;
  const checks: Check[] = [
    {
      label: 'PAIR endpoint is on this PC',
      state: !pair ? 'pending' : nonLoopback ? 'bad' : 'ok',
      why: 'config.json base_url must be 127.0.0.1 or localhost; anything else is refused.',
    },
    {
      label: 'Configured models are local',
      state: !pair?.reachable ? 'pending' : pair.required.some((m) => m.cloud) ? 'bad' : 'ok',
      why: 'Sort, caption and embed models must run on your own machines, never Ollama cloud.',
    },
    {
      label: 'Window network guard',
      state: shell ? 'ok' : 'bad',
      why: shell
        ? `Only this dashboard's own address is reachable; ${shell.blockedRequests} other request(s) blocked since the window opened.`
        : 'Not in the PhotoSort window: open it with dashboard.ps1 open.',
    },
    {
      label: 'Content protection',
      state: !shell ? 'bad' : shell.protection ? 'ok' : meta?.mode === 'fixture' ? 'warn' : 'bad',
      why: 'Screenshots, screen sharing and recording see a black window. It cannot stop a phone camera.',
    },
    {
      label: 'Server talks to PAIR only',
      state: 'ok',
      why: 'The server can only read the model list (/api/tags, /api/ps) on 127.0.0.1; a test enforces it.',
    },
  ];
  return (
    <div className="stack">
      <section className="card">
        <h2>Privacy checks</h2>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.state}>
              <span className={`dot ${c.state === 'pending' ? 'warn' : c.state}`} />
              <div>
                <b>{c.label}</b>
                <p className="muted small">{c.why}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted small">The PAIR routing audit and the live-connections check arrive in P3.</p>
      </section>
      <section className="card">
        <h2>Standing rules</h2>
        <ul className="plain">
          <li>Photos, videos and anything made from them (frames, captions, text, embeddings, file names) go only to models on your own machines, through the PAIR proxy on this PC.</li>
          <li>This PC runs no inference; its own Ollama stays off.</li>
          <li>Coding agents work in fixture mode only and never read your library, thumbnails, logs or this window.</li>
        </ul>
      </section>
    </div>
  );
}
