// The job runner: PhotoSort CLI runs started from the dashboard. One heavy job (anything that reads many files or
// moves them) runs at a time; the rest wait in a queue. Each job lives in <dataDir>\jobs\<id>\ (job.json,
// events.jsonl, cancel, stdout.txt, stderr.txt), so it survives a server restart: the Python process is
// detached, writes to files rather than pipes, and a restarted server reattaches to it by PID and command line.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { SseHub } from './sse.ts';

export const JOB_KINDS = ['sort', 'group', 'index', 'undo', 'apply'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = 'queued' | 'running' | 'cancelling' | 'ok' | 'errors' | 'failed' | 'cancelled' | 'interrupted' | 'removed';
const TERMINAL: ReadonlySet<JobStatus> = new Set(['ok', 'errors', 'failed', 'cancelled', 'interrupted', 'removed']);
const EXIT_STATUS: Record<number, JobStatus> = { 0: 'ok', 1: 'errors', 2: 'failed', 130: 'cancelled' };
export const FORCE_GRACE_S = 10;
const KEEP_DAYS = 90;
const KEEP_JOBS = 1000;
const ITEM_BATCH = 50;
const ITEM_FLUSH_MS = 250;
const POLL_MS = 100;

export interface JobMessage {
  level: 'warning' | 'error';
  text: string;
  kind?: string;
}

export interface JobItem {
  seq: number;
  n?: number;
  phase: string;
  path: string;
  name: string;
  result?: Record<string, unknown>;
  error?: string;
}

/** What job.json holds. Folder paths are stored as paths; the API turns them into ids. */
export interface JobRecord {
  v: 1;
  id: string;
  kind: JobKind;
  params: Record<string, unknown>;
  folders: Record<string, string>;
  argv: string[];
  cli: string;
  heavy: boolean;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationS?: number;
  pid?: number;
  exitCode?: number | null;
  cancelRequestedAt?: string;
  forced?: boolean;
  note?: string;
  phase?: string;
  phaseStartedAt?: string;
  done: number;
  total?: number;
  errors: number;
  counts: Record<string, number>;
  runId?: string;
  journal?: string;
  appliedFrom?: string;
  understood?: Record<string, unknown>;
  messages: JobMessage[];
  summary?: Record<string, unknown>;
  report?: string;
  seq: number;
}

export interface JobSpec {
  kind: JobKind;
  params: Record<string, unknown>;
  folders: Record<string, string>;
  /** CLI arguments after the global options, starting with the subcommand. */
  args: string[];
  heavy: boolean;
}

export interface JobManagerOptions {
  dataDir: string;
  python: string;
  photosortDir: string;
  configPath: string;
  hub: SseHub;
  log?: { info(o: object): void; error(o: object): void };
  /** Tests point this at a stand-in script; the default is photosort.py. */
  script?: string;
  /** Tests: how a reattached process is checked (default: its command line names the job). */
  isOurProcess?: (pid: number, jobId: string) => Promise<boolean>;
}

class EventTail {
  private fh?: FileHandle;
  private pos = 0;
  private rest: Buffer = Buffer.alloc(0);
  private file: string;
  constructor(file: string) {
    this.file = file;
  }

  /** New complete lines since the last call, parsed. Lines that are not JSON are skipped. */
  async read(): Promise<Record<string, unknown>[]> {
    if (!this.fh) {
      if (!existsSync(this.file)) return [];
      this.fh = await open(this.file, 'r');
    }
    const out: Record<string, unknown>[] = [];
    for (;;) {
      const buf = Buffer.alloc(256 * 1024);
      const { bytesRead } = await this.fh.read(buf, 0, buf.length, this.pos);
      if (bytesRead === 0) break;
      this.pos += bytesRead;
      let data = Buffer.concat([this.rest, buf.subarray(0, bytesRead)]);
      let nl: number;
      while ((nl = data.indexOf(10)) >= 0) {
        const line = data.subarray(0, nl).toString('utf8').trim();
        data = data.subarray(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as unknown;
          if (ev && typeof ev === 'object' && !Array.isArray(ev)) out.push(ev as Record<string, unknown>);
        } catch {
          /* a stray line: ignored, as the schema says */
        }
      }
      this.rest = Buffer.from(data);
      if (bytesRead < buf.length) break;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.fh?.close().catch(() => undefined);
    this.fh = undefined;
  }
}

interface Live {
  tail: EventTail;
  timer?: NodeJS.Timeout;
  busy?: boolean;
  child?: ChildProcess;
  exited?: { code: number | null };
  pending: JobItem[];
  lastFlush: number;
  finishing?: Promise<void>;
  finishEvent?: Record<string, unknown>;
  waiters: (() => void)[];
}

const now = (): string => new Date().toISOString();
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A summary without its file lists (a large run lists thousands of paths); the job's own page loads those. */
export function lightSummary(s: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return s && Object.fromEntries(Object.entries(s).filter(([, v]) => !Array.isArray(v)));
}

export function newJobId(): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `j_${t}_${randomBytes(4).toString('hex')}`;
}

export function isJobId(id: unknown): id is string {
  return typeof id === 'string' && /^j_\d{14}_[0-9a-f]{8}$/.test(id);
}

/** PowerShell quoting, so "Copy CLI command" pastes into a terminal as-is. */
export function psQuote(a: string): string {
  return /^[A-Za-z0-9_\-.:=\\/]+$/.test(a) ? a : `'${a.replaceAll("'", "''")}'`;
}

export function cliText(args: string[], configPath: string, defaultConfig: string): string {
  const parts = ['.\\photosort.cmd'];
  if (path.resolve(configPath).toLowerCase() !== path.resolve(defaultConfig).toLowerCase()) parts.push('--config', psQuote(configPath));
  const sep = args.indexOf('--');
  const opts = sep < 0 ? args : args.slice(0, sep);
  const pos = sep < 0 ? [] : args.slice(sep + 1);
  parts.push(...opts.map((a) => {
    const eq = a.indexOf('=');
    // A value that starts with "-" stays attached ("--name=-x"), or argparse would read it as an option.
    return a.startsWith('--') && eq > 0 && !a.slice(eq + 1).startsWith('-') ? `${a.slice(0, eq)} ${psQuote(a.slice(eq + 1))}` : psQuote(a);
  }));
  if (pos.some((p) => p.startsWith('-'))) parts.push('--');
  parts.push(...pos.map(psQuote));
  return parts.join(' ');
}

async function commandLineOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CommandLine`],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    ps.on('error', () => resolve(undefined));
    ps.on('close', () => resolve(out.trim() || undefined));
    setTimeout(() => { ps.kill(); resolve(undefined); }, 15000).unref();
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private live = new Map<string, Live>();
  private queue: string[] = [];
  private dir: string;
  private script: string;
  readonly defaultConfig: string;
  readonly configPath: string;
  private closed = false;
  private opts: JobManagerOptions;

  constructor(opts: JobManagerOptions) {
    this.opts = opts;
    this.configPath = opts.configPath;
    this.dir = path.join(opts.dataDir, 'jobs');
    this.script = opts.script ?? path.join(opts.photosortDir, 'photosort.py');
    this.defaultConfig = path.join(opts.photosortDir, 'config.json');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Loads earlier jobs, reattaches to ones still running, and drops old job folders. */
  async init(): Promise<void> {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    const found: JobRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!isJobId(name)) continue;
      const file = path.join(this.dir, name, 'job.json');
      let rec: JobRecord;
      try {
        rec = JSON.parse(readFileSync(file, 'utf8')) as JobRecord;
        if (rec.v !== 1 || rec.id !== name) continue;
      } catch {
        continue;
      }
      if (TERMINAL.has(rec.status) && Date.parse(rec.createdAt) < cutoff) {
        rmSync(path.join(this.dir, name), { recursive: true, force: true });
        continue;
      }
      found.push(rec);
    }
    found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const old of found.splice(0, Math.max(0, found.length - KEEP_JOBS))) {
      if (TERMINAL.has(old.status)) rmSync(path.join(this.dir, old.id), { recursive: true, force: true });
    }
    for (const rec of found) {
      this.jobs.set(rec.id, rec);
      if (rec.status === 'queued') {
        this.finalize(rec, 'removed', 'The dashboard restarted before this job started; start it again if you still want it.');
      } else if (rec.status === 'running' || rec.status === 'cancelling') {
        const ours = rec.pid !== undefined && alive(rec.pid)
          && (await (this.opts.isOurProcess ?? this.cmdlineMatches)(rec.pid, rec.id));
        await this.attach(rec, ours);
      }
    }
  }

  private cmdlineMatches = async (pid: number, jobId: string): Promise<boolean> => {
    const cmd = await commandLineOf(pid);
    return Boolean(cmd && cmd.includes(jobId) && cmd.toLowerCase().includes(path.basename(this.script).toLowerCase()));
  };

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  position(id: string): number {
    const i = this.queue.indexOf(id);
    return i < 0 ? 0 : i + 1;
  }

  running(): JobRecord | undefined {
    return [...this.jobs.values()].find((j) => j.heavy && (j.status === 'running' || j.status === 'cancelling'));
  }

  active(): JobRecord[] {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'cancelling');
  }

  jobDir(id: string): string {
    return path.join(this.dir, id);
  }

  submit(spec: JobSpec): JobRecord {
    if (this.closed) throw new Error('the dashboard is stopping');
    const id = newJobId();
    const rec: JobRecord = {
      v: 1, id, kind: spec.kind, params: spec.params, folders: spec.folders, argv: [], heavy: spec.heavy,
      cli: cliText(spec.args, this.opts.configPath, this.defaultConfig),
      status: 'queued', createdAt: now(), done: 0, errors: 0, counts: {}, messages: [], seq: 0,
    };
    const dir = this.jobDir(id);
    mkdirSync(dir, { recursive: true });
    rec.argv = ['-X', 'utf8', this.script, '--config', this.opts.configPath, '--events', path.join(dir, 'events.jsonl'),
      '--cancel-file', path.join(dir, 'cancel'), ...spec.args];
    this.jobs.set(id, rec);
    this.save(rec);
    if (spec.heavy) this.queue.push(id);
    this.send(rec, 'queued', { position: this.position(id) });
    if (spec.heavy) this.pump();
    else this.start(rec);
    return rec;
  }

  /** Removes a job that has not started yet. */
  remove(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec || rec.status !== 'queued') return false;
    this.queue = this.queue.filter((q) => q !== id);
    this.finalize(rec, 'removed', 'Removed from the queue.');
    return true;
  }

  /** Asks the run to stop safely (it finishes the files in progress). `force` ends the process at once; it is
   * allowed only after the grace period, because a forced stop can interrupt a file move. */
  cancel(id: string, force = false): { ok: boolean; error?: string; retryAfterS?: number } {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, error: 'no such job' };
    if (rec.status === 'queued') {
      this.remove(id);
      return { ok: true };
    }
    if (rec.status !== 'running' && rec.status !== 'cancelling') return { ok: false, error: 'the job is not running' };
    if (!force) {
      if (!rec.cancelRequestedAt) {
        writeFileSync(path.join(this.jobDir(id), 'cancel'), now());
        rec.cancelRequestedAt = now();
        rec.status = 'cancelling';
        this.save(rec);
        this.send(rec, 'cancelling', {});
      }
      return { ok: true };
    }
    const waited = rec.cancelRequestedAt ? (Date.now() - Date.parse(rec.cancelRequestedAt)) / 1000 : 0;
    if (!rec.cancelRequestedAt || waited < FORCE_GRACE_S) {
      return { ok: false, error: `ask the job to stop first, then wait ${FORCE_GRACE_S} s before forcing it`,
        retryAfterS: Math.ceil(FORCE_GRACE_S - waited) };
    }
    rec.forced = true;
    this.save(rec);
    if (rec.pid !== undefined) {
      spawn('taskkill.exe', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
        .on('error', () => { try { process.kill(rec.pid!); } catch { /* already gone */ } });
    }
    return { ok: true };
  }

  /** Resolves when the job has reached a final state (or after `timeoutMs`). */
  waitFor(id: string, timeoutMs: number): Promise<boolean> {
    const rec = this.jobs.get(id);
    if (!rec || TERMINAL.has(rec.status)) return Promise.resolve(true);
    const lv = this.live.get(id);
    if (!lv) return Promise.resolve(TERMINAL.has(rec.status));
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      lv.waiters.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /** Per-file results of a job, read from its events file (`after` is an event sequence number). With `tail`, the
   * newest `limit` results instead, and `older` says how many earlier ones were left out. */
  async items(id: string, after = 0, limit = 500, tail = false): Promise<{ items: JobItem[]; next: number; more: boolean; older: number }> {
    const events = new EventTail(path.join(this.jobDir(id), 'events.jsonl'));
    let out: JobItem[] = [];
    let more = false;
    let older = 0;
    try {
      for (const ev of await events.read()) {
        if (ev.type !== 'item' || (num(ev.seq) ?? 0) <= after) continue;
        if (!tail && out.length >= limit) { more = true; break; }
        out.push(toItem(ev));
      }
    } finally {
      await events.close();
    }
    if (tail && out.length > limit) {
      older = out.length - limit;
      out = out.slice(older);
    }
    return { items: out, next: out.length ? out[out.length - 1].seq : after, more, older };
  }

  /** Stops watching (server shutdown). Running jobs keep going and are reattached on the next start. */
  async close(): Promise<void> {
    this.closed = true;
    for (const [id, lv] of this.live) {
      if (lv.timer) clearInterval(lv.timer);
      await lv.tail.close();
      this.live.delete(id);
    }
  }

  // ---------- internals ----------

  private pump(): void {
    if (this.closed || this.running()) return;
    const next = this.queue.shift();
    if (!next) return;
    const rec = this.jobs.get(next);
    if (rec?.status === 'queued') this.start(rec);
    else this.pump();
  }

  private start(rec: JobRecord): void {
    const dir = this.jobDir(rec.id);
    const out = openSync(path.join(dir, 'stdout.txt'), 'a');
    const err = openSync(path.join(dir, 'stderr.txt'), 'a');
    let child: ChildProcess;
    try {
      // Detached: a server crash or stop must not end a run in the middle of a move. Output goes to files,
      // never pipes, for the same reason. No shell: arguments go to the process as they are.
      child = spawn(this.opts.python, rec.argv, {
        cwd: this.opts.photosortDir,
        stdio: ['ignore', out, err],
        windowsHide: true,
        shell: false,
        detached: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
    } catch (e) {
      closeSync(out);
      closeSync(err);
      rec.messages.push({ level: 'error', text: `Python could not start: ${(e as Error).message}` });
      this.finalize(rec, 'failed');
      this.pump();
      return;
    }
    closeSync(out);
    closeSync(err);
    rec.status = 'running';
    rec.startedAt = now();
    rec.pid = child.pid;
    this.save(rec);
    const lv: Live = { tail: new EventTail(path.join(dir, 'events.jsonl')), child, pending: [], lastFlush: Date.now(), waiters: [] };
    this.live.set(rec.id, lv);
    child.on('error', (e) => {
      rec.messages.push({ level: 'error', text: `Python could not start: ${e.message}` });
      lv.exited = { code: -1 };
    });
    child.on('exit', (code) => { lv.exited = { code }; });
    this.send(rec, 'started', { cli: rec.cli });
    lv.timer = setInterval(() => void this.tick(rec, lv), POLL_MS);
  }

  private async attach(rec: JobRecord, ours: boolean): Promise<void> {
    const lv: Live = { tail: new EventTail(path.join(this.jobDir(rec.id), 'events.jsonl')), pending: [], lastFlush: Date.now(), waiters: [] };
    // Rebuild the live counters from the start of the events file.
    Object.assign(rec, { done: 0, errors: 0, counts: {}, messages: [], seq: 0 });
    for (const ev of await lv.tail.read()) this.apply(rec, ev, lv, false);
    lv.pending = [];
    if (!ours) {
      await lv.tail.close();
      this.finishFrom(rec, lv, null, 'The dashboard was not running when this job ended.');
      return;
    }
    this.live.set(rec.id, lv);
    this.opts.log?.info({ msg: 'reattached to a running job', kind: rec.kind });
    lv.timer = setInterval(() => {
      if (!lv.exited && rec.pid !== undefined && !alive(rec.pid)) lv.exited = { code: null };
      void this.tick(rec, lv);
    }, POLL_MS);
  }

  private async tick(rec: JobRecord, lv: Live): Promise<void> {
    if (lv.finishing || lv.busy) return;
    lv.busy = true;
    const exited = lv.exited;
    let events: Record<string, unknown>[] = [];
    try {
      events = await lv.tail.read();
    } catch (e) {
      this.opts.log?.error({ msg: 'events read failed', err: (e as Error).message });
    } finally {
      lv.busy = false;
    }
    for (const ev of events) this.apply(rec, ev, lv, true);
    if (lv.pending.length >= ITEM_BATCH || (lv.pending.length && Date.now() - lv.lastFlush >= ITEM_FLUSH_MS)) this.flush(rec, lv);
    if (exited) {
      lv.finishing = (async () => {
        if (lv.timer) clearInterval(lv.timer);
        for (const ev of await lv.tail.read().catch(() => [])) this.apply(rec, ev, lv, true);
        this.flush(rec, lv);
        await lv.tail.close();
        this.finishFrom(rec, lv, exited.code);
      })();
    }
  }

  private apply(rec: JobRecord, ev: Record<string, unknown>, lv: Live, live: boolean): void {
    const seq = num(ev.seq);
    if (seq !== undefined) rec.seq = Math.max(rec.seq, seq);
    switch (ev.type) {
      case 'run_start':
        if (num(ev.pid)) rec.pid = num(ev.pid);
        break;
      case 'phase': {
        rec.phase = str(ev.name) ?? rec.phase;
        rec.phaseStartedAt = str(ev.ts) ?? now();
        rec.total = num(ev.total);
        // Tallies are per phase: group reports each file in "check" and again in "move".
        rec.done = 0;
        rec.errors = 0;
        rec.counts = {};
        if (str(ev.run_id)) rec.runId = str(ev.run_id);
        if (str(ev.journal)) rec.journal = str(ev.journal);
        if (str(ev.applied_from)) rec.appliedFrom = str(ev.applied_from);
        if (live) {
          this.flush(rec, lv);
          this.send(rec, 'phase', { reused: num(ev.reused), unchanged: num(ev.unchanged), files: num(ev.files) });
        }
        break;
      }
      case 'item': {
        const item = toItem(ev);
        rec.done = Math.max(rec.done + 1, item.n ?? 0);
        if (item.error) rec.errors++;
        const r = item.result ?? {};
        const bucket = str(r.bucket)
          ?? (r.match === true ? (str(r.matched_by) ?? 'match') : r.match === false ? 'no match' : undefined)
          ?? str(r.status) ?? (str(r.from) ? 'restored' : str(r.dst) ? 'applied' : undefined);
        if (bucket && !item.error) rec.counts[bucket] = (rec.counts[bucket] ?? 0) + 1;
        if (live) lv.pending.push(item);
        break;
      }
      case 'understood':
        rec.understood = { topic: ev.topic, media: ev.media, dates: ev.dates, peopleIgnored: ev.people_ignored, group: ev.group };
        if (live) this.send(rec, 'understood', { understood: rec.understood });
        break;
      case 'warning':
      case 'error': {
        const text = str(ev.message) ?? '';
        rec.messages.push({ level: ev.type, text, kind: str(ev.kind) });
        if (rec.messages.length > 20) rec.messages.splice(0, rec.messages.length - 20);
        if (live) this.send(rec, 'warning', { message: { level: ev.type, text, kind: str(ev.kind) } });
        break;
      }
      case 'finish':
        lv.finishEvent = ev;
        if (ev.summary && typeof ev.summary === 'object') {
          rec.summary = ev.summary as Record<string, unknown>;
          // An undo preview has no phase event: its summary names the run it would undo.
          rec.runId ??= str(rec.summary.run_id);
          rec.journal ??= str(rec.summary.journal);
        }
        if (str(ev.report)) rec.report = str(ev.report);
        break;
      default:
        break;
    }
  }

  private flush(rec: JobRecord, lv: Live): void {
    lv.lastFlush = Date.now();
    while (lv.pending.length) this.send(rec, 'items', { items: lv.pending.splice(0, ITEM_BATCH) });
  }

  private finishFrom(rec: JobRecord, lv: Live, code: number | null, unknownNote?: string): void {
    const fin = lv.finishEvent;
    let status: JobStatus;
    let endedAt: string | undefined;
    if (fin) {
      const s = str(fin.status) as JobStatus | undefined;
      status = s && ['ok', 'errors', 'failed', 'cancelled'].includes(s) ? s : 'failed';
      rec.exitCode = num(fin.exit_code) ?? code;
      // It ended while the dashboard was away: its own clock is the best end time we have.
      const t = str(fin.ts) ? Date.parse(str(fin.ts)!) : NaN;
      if (!lv.child && Number.isFinite(t)) endedAt = new Date(t).toISOString();
    } else if (rec.forced) {
      status = 'cancelled';
      rec.exitCode = code;
      rec.messages.push({ level: 'warning', text: 'Stopped by force: a file that was being moved may need checking (see the journal).' });
    } else if (code !== null) {
      status = EXIT_STATUS[code] ?? 'failed';
      rec.exitCode = code;
      if (code !== 0) this.stderrHint(rec);
    } else {
      status = 'interrupted';
      rec.exitCode = null;
    }
    this.finalize(rec, status, !fin && code === null ? unknownNote : undefined, endedAt);
    this.live.delete(rec.id);
    for (const w of lv.waiters.splice(0)) w();
    this.pump();
  }

  /** When Python stops before it could write events (bad arguments, missing module), show its last stderr line. */
  private stderrHint(rec: JobRecord): void {
    if (rec.messages.some((m) => m.level === 'error')) return;
    try {
      const file = path.join(this.jobDir(rec.id), 'stderr.txt');
      const size = statSync(file).size;
      const text = readFileSync(file, 'utf8').slice(Math.max(0, size - 4000));
      const last = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (last) rec.messages.push({ level: 'error', text: last.slice(0, 500) });
    } catch {
      /* no stderr */
    }
  }

  private finalize(rec: JobRecord, status: JobStatus, note?: string, endedAt?: string): void {
    rec.status = status;
    rec.finishedAt = endedAt ?? now();
    if (rec.startedAt) rec.durationS = Math.round((Date.parse(rec.finishedAt) - Date.parse(rec.startedAt)) / 100) / 10;
    if (note) rec.note = note;
    this.save(rec);
    this.send(rec, 'finished', {
      status, exitCode: rec.exitCode, summary: lightSummary(rec.summary), startedAt: rec.startedAt,
      finishedAt: rec.finishedAt, durationS: rec.durationS, note: rec.note, runId: rec.runId,
    });
  }

  private send(rec: JobRecord, type: string, extra: Record<string, unknown>): void {
    this.opts.hub.send('job', {
      type, job: rec.id, kind: rec.kind, status: rec.status, ts: now(), seq: rec.seq, phase: rec.phase,
      done: rec.done, total: rec.total, errors: rec.errors, counts: rec.counts, ...extra,
    });
  }

  private save(rec: JobRecord): void {
    const file = path.join(this.jobDir(rec.id), 'job.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 1), 'utf8');
    for (let i = 0; ; i++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (e) {
        if (i >= 5) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // a virus scanner may hold the file briefly
      }
    }
  }
}

function toItem(ev: Record<string, unknown>): JobItem {
  const p = str(ev.path) ?? '';
  return {
    seq: num(ev.seq) ?? 0,
    n: num(ev.n),
    phase: str(ev.phase) ?? '',
    path: p,
    name: path.basename(p),
    result: ev.result && typeof ev.result === 'object' ? (ev.result as Record<string, unknown>) : undefined,
    error: str(ev.error),
  };
}
