// Which optional Python modules the CLI can use (HEIC photos, videos). Checked by running the same Python the
// jobs use; cached, since it takes about a second.
import { spawn } from 'node:child_process';

export interface PythonInfo {
  ok: boolean;
  version?: string;
  heic?: boolean;
  video?: boolean;
  error?: string;
  ms: number;
}

const PROBE = [
  'import json, sys',
  'out = {"version": sys.version.split()[0]}',
  'for key, mod in (("heic", "pillow_heif"), ("video", "av"), ("pil", "PIL"), ("requests", "requests")):',
  '    try:',
  '        __import__(mod)',
  '        out[key] = True',
  '    except Exception:',
  '        out[key] = False',
  'print(json.dumps(out))',
].join('\n');

export function probePython(python: string, cwd: string, timeoutMs = 20000): Promise<PythonInfo> {
  const started = performance.now();
  return new Promise((resolve) => {
    const done = (r: Omit<PythonInfo, 'ms'>) => resolve({ ...r, ms: Math.round(performance.now() - started) });
    let out = '';
    const child = spawn(python, ['-c', PROBE], { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); done({ ok: false, error: 'Python did not answer in time' }); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: `Python could not start: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as { version: string; heic: boolean; video: boolean; pil: boolean; requests: boolean };
        const missing = [!r.pil && 'Pillow', !r.requests && 'requests'].filter(Boolean);
        done({ ok: missing.length === 0, version: r.version, heic: r.heic, video: r.video,
          error: missing.length ? `missing Python packages: ${missing.join(', ')}` : undefined });
      } catch {
        done({ ok: false, error: `Python exited with code ${code}` });
      }
    });
  });
}

export function cachedProbe(python: string, cwd: string, ttlMs = 300000): () => Promise<PythonInfo> {
  let last: { at: number; p: Promise<PythonInfo> } | undefined;
  return () => {
    if (!last || Date.now() - last.at > ttlMs) last = { at: Date.now(), p: probePython(python, cwd) };
    return last.p;
  };
}
