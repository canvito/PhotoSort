import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SseHub } from './sse.ts';

export class SidecarError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Sidecar {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private closed = false;
  private retryAt = 0;
  private opts: { python: string; photosortDir: string; configPath: string; dataDir: string; fixtureRoots?: string[]; hub: SseHub };

  constructor(opts: Sidecar['opts']) { this.opts = opts; }

  private start(): void {
    if (this.closed || Date.now() < this.retryAt) throw new SidecarError('unavailable');
    const o = this.opts;
    const args = [path.join(o.photosortDir, 'dashboard_sidecar.py'), '--config', o.configPath, '--data-dir', o.dataDir];
    for (const root of o.fixtureRoots ?? []) args.push('--fixture-root', root);
    const proc = spawn(o.python, args, {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
    });
    this.proc = proc;
    // Never copy interpreter/decoder stderr into logs: a native error can include a media path.
    proc.stderr.resume();
    proc.stdin.on('error', () => this.fail('unavailable'));
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code?: string }; method?: string; params?: unknown };
        if (msg.method === 'index') { o.hub.send('index', msg.params); return; }
        const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id!);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new SidecarError(msg.error.code ?? 'failed'));
        else p.resolve(msg.result);
      } catch { this.fail('invalid_response'); }
    });
    const ended = () => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.retryAt = Date.now() + 1000;
      this.fail('unavailable');
      lines.close();
    };
    proc.on('error', ended);
    proc.on('exit', ended);
  }

  private fail(code: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new SidecarError(code)); }
    this.pending.clear();
  }

  call<T>(method: string, params: object = {}): Promise<T> {
    try {
      if (!this.proc) this.start();
      if (this.pending.size >= 64) throw new SidecarError('busy');
    } catch (e) { return Promise.reject(e); }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SidecarError('timeout'));
      }, 120000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  get pid(): number | undefined { return this.proc?.pid; }

  async close(): Promise<void> {
    this.closed = true;
    this.fail('closed');
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.pid) {
          if (process.platform === 'win32') {
            execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          } else { proc.kill(); resolve(); }
        } else resolve();
      }, 2500);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.stdin.end(JSON.stringify({ jsonrpc: '2.0', method: 'sys.shutdown' }) + '\n');
    });
  }
}
