// Runs: every sort, group and apply recorded in the PhotoSort journals of the folders the dashboard knows, so runs
// started from a terminal show up too, joined to the dashboard job that ran them when there is one. Journals are
// read by the sidecar (journal.runs / journal.items); undo and apply still go through /api/jobs.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { DirError, type DirInfo, type DirRegistry } from './dirs.ts';
import type { JobManager, JobRecord } from './jobs.ts';
import { JOURNAL_NAME } from './routes.ts';
import { SidecarError, type Sidecar } from './sidecar.ts';

const key = (p: string): string => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const MAX_FOLDERS = 50;
const DIR_ID = { type: 'string', pattern: '^d_[A-Za-z0-9_-]{22}$' };
const RUN_KEY = { type: 'string', pattern: '^d_[A-Za-z0-9_-]{22}~\\d{8}-\\d{6}-[0-9a-f]{6}$' };

/** The folders the user added on the Runs page, by path (folder ids only last one session). */
export class FolderRegistry {
  private file: string;
  private folders: string[] = [];
  private saving: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'folders.json');
  }

  async load(): Promise<void> {
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8')) as { folders?: unknown };
      if (Array.isArray(j.folders)) this.folders = j.folders.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f));
    } catch {
      this.folders = [];
    }
  }

  list(): string[] {
    return [...this.folders];
  }

  has(p: string): boolean {
    return this.folders.some((f) => key(f) === key(p));
  }

  add(p: string): Promise<void> {
    if (this.has(p)) return this.saving;
    this.folders.push(path.resolve(p));
    return this.save();
  }

  remove(p: string): Promise<void> {
    const before = this.folders.length;
    this.folders = this.folders.filter((f) => key(f) !== key(p));
    return before === this.folders.length ? this.saving : this.save();
  }

  private save(): Promise<void> {
    const body = JSON.stringify({ v: 1, folders: this.folders }, null, 2);
    this.saving = this.saving.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.file);
    });
    return this.saving;
  }
}

/** One run as photosort.journal_runs reports it. */
interface JournalRun {
  run_id: string;
  kind: 'sort' | 'group' | 'apply';
  of: 'sort' | 'group' | null;
  action: string;
  model?: string | null;
  started?: string | null;
  ended?: string | null;
  files: number;
  done: number;
  errors: number;
  matched: number;
  buckets: Record<string, number>;
  group?: string | null;
  request?: string | null;
  applied_from?: string | null;
  restored: number;
  undone?: { ts?: string; restored?: number; problems?: number } | null;
  applied_by: string[];
  can_undo: boolean;
  can_apply: boolean;
  duration_s?: number | null;
}

export interface RunRow {
  key: string;
  origin: 'journal' | 'job';
  folder?: DirInfo;
  runId?: string;
  kind: string;
  of?: string | null;
  action?: string;
  model?: string | null;
  /** UTC ISO (journal times are local; converted here). */
  startedAt?: string;
  endedAt?: string;
  files: number;
  done: number;
  errors: number;
  matched: number;
  buckets: Record<string, number>;
  group?: string | null;
  request?: string | null;
  appliedFrom?: string | null;
  restored: number;
  undone?: { at?: string; restored?: number; problems?: number } | null;
  appliedBy: string[];
  canUndo: boolean;
  canApply: boolean;
  durationS?: number | null;
  /** True when the duration came from the dashboard job (the journal only has whole seconds). */
  durationExact: boolean;
  jobId?: string;
  jobStatus?: string;
  /** A run with no dashboard job: started from a terminal (or by a dashboard that was since reset). */
  terminal: boolean;
}

export interface FolderRow extends DirInfo {
  registered: boolean;
  fromJobs: boolean;
  journal: boolean;
  runs: number;
  conflicts: { name: string; runs: number }[];
  error?: string;
}

const localIso = (ts: string | null | undefined): string | undefined => {
  if (!ts) return undefined;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

const RUN_JOB_KINDS = new Set(['sort', 'group', 'apply']);

function sidecarMessage(e: unknown): string {
  if (e instanceof SidecarError) {
    if (e.code === 'local_only') return 'This journal cannot be read here.';
    if (e.code === 'timeout') return 'Reading the journal timed out.';
    if (e.code === 'missing') return 'The journal is gone.';
  }
  return 'The journal could not be read.';
}

export class RunsService {
  private registry: FolderRegistry;
  private dirs: DirRegistry;
  private jobs: JobManager;
  private sidecar: Sidecar;

  constructor(registry: FolderRegistry, dirs: DirRegistry, jobs: JobManager, sidecar: Sidecar) {
    this.registry = registry;
    this.dirs = dirs;
    this.jobs = jobs;
    this.sidecar = sidecar;
  }

  /** Registered folders plus every folder a dashboard job wrote a journal in, that still exist and may be used. */
  folders(): { path: string; registered: boolean; fromJobs: boolean }[] {
    const out = new Map<string, { path: string; registered: boolean; fromJobs: boolean }>();
    for (const f of this.registry.list()) out.set(key(f), { path: f, registered: true, fromJobs: false });
    for (const j of this.jobs.list()) {
      if (!j.journal) continue;
      const d = path.dirname(j.journal);
      const k = key(d);
      const prev = out.get(k);
      if (prev) prev.fromJobs = true;
      else out.set(k, { path: d, registered: false, fromJobs: true });
    }
    return [...out.values()].filter((f) => this.dirs.allowed(f.path) && existsSync(f.path)).slice(0, MAX_FOLDERS);
  }

  private jobsByRun(): Map<string, JobRecord> {
    const m = new Map<string, JobRecord>();
    for (const j of this.jobs.list()) {
      if (j.journal && j.runId && RUN_JOB_KINDS.has(j.kind)) m.set(`${key(path.dirname(j.journal))}|${j.runId}`, j);
    }
    return m;
  }

  private row(folder: DirInfo, r: JournalRun, job: JobRecord | undefined): RunRow {
    const exact = job?.durationS !== undefined && job.status !== 'running';
    return {
      key: `${folder.dirId}~${r.run_id}`,
      origin: 'journal',
      folder,
      runId: r.run_id,
      kind: r.kind,
      of: r.of,
      action: r.action,
      model: r.model,
      startedAt: localIso(r.started) ?? job?.startedAt,
      endedAt: localIso(r.ended),
      files: r.files,
      done: r.done,
      errors: r.errors,
      matched: r.matched,
      buckets: r.buckets ?? {},
      group: r.group,
      request: r.request,
      appliedFrom: r.applied_from,
      restored: r.restored,
      undone: r.undone ? { at: localIso(r.undone.ts), restored: r.undone.restored, problems: r.undone.problems } : null,
      appliedBy: r.applied_by ?? [],
      canUndo: r.can_undo,
      canApply: r.can_apply,
      durationS: exact ? job!.durationS : r.duration_s,
      durationExact: exact,
      jobId: job?.id,
      jobStatus: job?.status,
      terminal: !job,
    };
  }

  private async readFolder(dir: string): Promise<{ runs: JournalRun[]; conflicts: { name: string; runs: number }[] }> {
    return this.sidecar.call('journal.runs', { journal: path.join(dir, JOURNAL_NAME) });
  }

  async all(): Promise<{ runs: RunRow[]; folders: FolderRow[] }> {
    const byRun = this.jobsByRun();
    const used = new Set<string>();
    const folders: FolderRow[] = [];
    const runs: RunRow[] = [];
    const listed = this.folders();
    const results = await Promise.all(listed.map((f) => this.readFolder(f.path).then((r) => ({ r }), (e: unknown) => ({ e }))));
    listed.forEach((f, i) => {
      const info = this.dirs.info(f.path);
      const res = results[i];
      const journal = existsSync(path.join(f.path, JOURNAL_NAME));
      if ('e' in res) {
        folders.push({ ...info, registered: f.registered, fromJobs: f.fromJobs, journal, runs: 0, conflicts: [], error: sidecarMessage(res.e) });
        return;
      }
      folders.push({ ...info, registered: f.registered, fromJobs: f.fromJobs, journal, runs: res.r.runs.length, conflicts: res.r.conflicts ?? [] });
      for (const r of res.r.runs) {
        const job = byRun.get(`${key(f.path)}|${r.run_id}`);
        if (job) used.add(job.id);
        runs.push(this.row(info, r, job));
      }
    });
    // Dashboard jobs with no journal run of their own: index and undo jobs, and runs that failed before writing.
    for (const j of this.jobs.list()) {
      if (used.has(j.id) || j.status === 'removed') continue;
      runs.push(this.jobRow(j));
    }
    runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || b.key.localeCompare(a.key));
    return { runs, folders };
  }

  private jobRow(j: JobRecord): RunRow {
    const where = j.folders.source ?? j.folders.folder ?? (j.journal ? path.dirname(j.journal) : undefined);
    const folder = where && this.dirs.allowed(where) ? this.dirs.info(where) : undefined;
    const s = j.summary ?? {};
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    return {
      key: `job~${j.id}`,
      origin: 'job',
      folder,
      runId: j.runId,
      kind: j.kind,
      of: null,
      action: typeof j.params.action === 'string' ? j.params.action : j.kind === 'undo' && j.params.dryRun ? 'preview' : undefined,
      startedAt: j.startedAt ?? j.createdAt,
      endedAt: j.finishedAt,
      files: j.total ?? j.done,
      done: j.done,
      errors: j.errors,
      matched: n(s.matched),
      buckets: {},
      request: typeof j.params.request === 'string' ? j.params.request : null,
      restored: 0,
      appliedBy: [],
      canUndo: false,
      canApply: false,
      durationS: j.durationS,
      durationExact: j.durationS !== undefined,
      jobId: j.id,
      jobStatus: j.status,
      terminal: false,
    };
  }

  /** The folder and run id a run key names, or a 404. */
  resolve(runKey: string): { dir: string; folder: DirInfo; runId: string } {
    const [dirId, runId] = runKey.split('~');
    const dir = this.dirs.pathOf(dirId);
    return { dir, folder: this.dirs.info(dir), runId };
  }

  async one(runKey: string): Promise<RunRow | undefined> {
    const { dir, folder, runId } = this.resolve(runKey);
    const res = await this.readFolder(dir);
    const r = res.runs.find((x) => x.run_id === runId);
    return r ? this.row(folder, r, this.jobsByRun().get(`${key(dir)}|${runId}`)) : undefined;
  }

  async items(runKey: string, offset: number, limit: number): Promise<unknown> {
    const { dir, runId } = this.resolve(runKey);
    return this.sidecar.call('journal.items', { journal: path.join(dir, JOURNAL_NAME), runId, offset, limit });
  }
}

function fail(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof DirError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof SidecarError) return reply.code(e.code === 'local_only' ? 403 : e.code === 'timeout' ? 504 : 503).send({ error: sidecarMessage(e) });
  throw e;
}

export async function registerRunRoutes(app: FastifyInstance, dataDir: string, dirs: DirRegistry, jobs: JobManager, sidecar: Sidecar): Promise<RunsService> {
  const registry = new FolderRegistry(dataDir);
  await registry.load();
  const runs = new RunsService(registry, dirs, jobs, sidecar);
  const keyParams = { type: 'object', additionalProperties: false, required: ['key'], properties: { key: RUN_KEY } };

  app.get('/api/runs', { config: { auth: 'read' } }, async () => runs.all());

  app.get<{ Params: { key: string } }>('/api/runs/:key', { config: { auth: 'read' }, schema: { params: keyParams } }, async (req, reply) => {
    try {
      const run = await runs.one(req.params.key);
      return run ? { run } : reply.code(404).send({ error: 'That run is no longer in its journal.' });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { key: string }; Querystring: { offset?: string; limit?: string } }>('/api/runs/:key/items', {
    config: { auth: 'read' },
    schema: {
      params: keyParams,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { offset: { type: 'string', pattern: '^\\d{1,9}$' }, limit: { type: 'string', pattern: '^\\d{1,4}$' } },
      },
    },
  }, async (req, reply) => {
    try {
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 500)));
      return await runs.items(req.params.key, Number(req.query.offset ?? 0), limit);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post<{ Body: { dir: string } }>('/api/folders', {
    config: { auth: 'mutate' },
    schema: { body: { type: 'object', additionalProperties: false, required: ['dir'], properties: { dir: DIR_ID } } },
  }, async (req, reply) => {
    try {
      const dir = dirs.pathOf(req.body.dir);
      if (!existsSync(dir)) return reply.code(404).send({ error: 'That folder no longer exists.' });
      await registry.add(dir);
      return { folder: dirs.info(dir) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete<{ Params: { dirId: string } }>('/api/folders/:dirId', {
    config: { auth: 'mutate' },
    schema: { params: { type: 'object', additionalProperties: false, required: ['dirId'], properties: { dirId: DIR_ID } } },
  }, async (req, reply) => {
    try {
      await registry.remove(dirs.pathOf(req.params.dirId));
      return { ok: true };
    } catch (e) {
      return fail(reply, e);
    }
  });

  return runs;
}
