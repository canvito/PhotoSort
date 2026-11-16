// Job and folder routes. Jobs only accept a fixed set of commands with typed parameters; folders are opaque ids
// from DirRegistry. The argv for Python is built here, with option values attached by "=" and positional values
// after "--", so no user text can ever be read as an option.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { DirError, type DirInfo, type DirRegistry } from './dirs.ts';
import { cliText, isJobId, lightSummary, type JobKind, type JobManager, type JobRecord, type JobSpec } from './jobs.ts';
import { isCloudModel } from './localfetch.ts';

export const JOURNAL_NAME = '_photosort_journal.jsonl';
const DIR_ID = { type: 'string', pattern: '^d_[A-Za-z0-9_-]{22}$' };
const JOB_REF = { type: 'string', pattern: '^j_\\d{14}_[0-9a-f]{8}$' };
const RUN_ID = { type: 'string', pattern: '^\\d{8}-\\d{6}-[0-9a-f]{6}$' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const MODEL = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$' };
const LIMIT = { type: 'integer', minimum: 0, maximum: 10_000_000 };
const CONCURRENCY = { type: 'integer', minimum: 1, maximum: 64 };
const FORCE = { type: 'boolean' };
// "local", "local:4", "lan-box:8,local:2": SSH host aliases or local, each with an optional thread count.
const WORKER = '[A-Za-z0-9][A-Za-z0-9._@-]{0,62}(:\\d{1,3})?';
export const WORKERS = { type: 'string', maxLength: 1000, pattern: `^${WORKER}(,${WORKER}){0,31}$` };
const HOST = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$' };

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });

export const PARAM_SCHEMAS: Record<JobKind, object> = {
  sort: obj({
    source: DIR_ID, dest: DIR_ID, action: { enum: ['report', 'move', 'copy'] }, recursive: { type: 'boolean' },
    limit: LIMIT, concurrency: CONCURRENCY, model: MODEL, force: FORCE,
  }, ['source', 'action']),
  group: obj({
    source: DIR_ID, request: { type: 'string', minLength: 1, maxLength: 500 }, action: { enum: ['report', 'move', 'copy'] },
    name: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[^\\\\/:*?"<>|\\u0000-\\u001f]+$' },
    from: DATE, to: DATE, media: { enum: ['photos', 'videos', 'both'] }, limit: LIMIT, concurrency: CONCURRENCY,
    model: MODEL, force: FORCE,
  }, ['source', 'request', 'action']),
  index: obj({ source: DIR_ID, limit: LIMIT, concurrency: CONCURRENCY, force: FORCE }, ['source']),
  undo: obj({ job: JOB_REF, folder: DIR_ID, runId: RUN_ID, dryRun: { type: 'boolean' }, force: FORCE }),
  apply: obj({ job: JOB_REF, folder: DIR_ID, runId: RUN_ID, action: { enum: ['move', 'copy'] }, force: FORCE }),
  faces: obj({
    source: DIR_ID, people: DIR_ID, threshold: { type: 'number', minimum: 0, maximum: 1 },
    margin: { type: 'number', minimum: 0, maximum: 2 }, recursive: { type: 'boolean' }, limit: LIMIT, workers: WORKERS,
    force: FORCE,
  }, ['source', 'people']),
  'faces-setup': obj({ hosts: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: HOST } }, ['hosts']),
};

export class BadRequest extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type P = Record<string, unknown>;

function opt(args: string[], flag: string, v: unknown): void {
  if (v === undefined || v === null || v === false) return;
  args.push(v === true ? flag : `${flag}=${String(v)}`);
}

function validDate(s: unknown): void {
  if (s === undefined) return;
  const d = new Date(`${String(s)}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new BadRequest(`${String(s)} is not a real date`);
}

/** Turns validated API parameters into a job: folder paths, CLI arguments and whether it is heavy. */
export function buildSpec(kind: JobKind, p: P, dirs: DirRegistry, jobs: JobManager): JobSpec {
  const folder = (role: string, id: unknown): string => {
    const dir = dirs.pathOf(id);
    const problem = dirs.jobFolderProblem(dir);
    if (problem) throw new BadRequest(`${role}: ${problem}`);
    if (!existsSync(dir)) throw new BadRequest(`${role}: the folder no longer exists.`);
    return dir;
  };
  if (typeof p.model === 'string' && isCloudModel(p.model)) {
    throw new BadRequest(`${p.model} is an Ollama cloud model; PhotoSort only uses models on your own PAIR nodes.`);
  }
  const args: string[] = [kind];
  const folders: Record<string, string> = {};
  const params: P = { ...p };
  switch (kind) {
    case 'sort': {
      folders.source = folder('Folder', p.source);
      if (p.dest !== undefined) folders.dest = folder('Destination', p.dest);
      opt(args, '--action', p.action);
      opt(args, '--recursive', p.recursive);
      opt(args, '--limit', p.limit || undefined);
      opt(args, '--concurrency', p.concurrency);
      opt(args, '--model', p.model);
      if (folders.dest) args.push(`--dest=${folders.dest}`);
      opt(args, '--force', p.force);
      args.push('--', folders.source);
      break;
    }
    case 'group': {
      folders.source = folder('Folder', p.source);
      const request = String(p.request).trim();
      if (!request) throw new BadRequest('Describe what to group.');
      params.request = request;
      validDate(p.from);
      validDate(p.to);
      if (p.to !== undefined && p.from === undefined) throw new BadRequest('"To" needs a "From" date.');
      if (typeof p.from === 'string' && typeof p.to === 'string' && p.from > p.to) throw new BadRequest('"From" is after "To".');
      const name = typeof p.name === 'string' ? p.name.trim() : undefined;
      if (name !== undefined && (!name || /^\.+$/.test(name))) throw new BadRequest('Pick another folder name.');
      opt(args, '--action', p.action);
      opt(args, '--name', name);
      opt(args, '--from', p.from);
      opt(args, '--to', p.to);
      opt(args, '--media', p.media);
      opt(args, '--limit', p.limit || undefined);
      opt(args, '--concurrency', p.concurrency);
      opt(args, '--model', p.model);
      opt(args, '--force', p.force);
      args.push('--', folders.source, request);
      break;
    }
    case 'index': {
      folders.source = folder('Folder', p.source);
      opt(args, '--limit', p.limit || undefined);
      opt(args, '--concurrency', p.concurrency);
      opt(args, '--force', p.force);
      args.push('--', folders.source);
      break;
    }
    case 'undo':
    case 'apply': {
      if ((p.job === undefined) === (p.folder === undefined)) throw new BadRequest('Give either a job or a folder.');
      let journal: string;
      let runId = p.runId as string | undefined;
      if (p.job !== undefined) {
        const from = jobs.get(String(p.job));
        if (!from?.journal || !from.runId) throw new BadRequest('That job has no run to use.', 404);
        journal = from.journal;
        runId ??= from.runId;
        if (!dirs.allowed(journal)) throw new BadRequest('That run is outside what the dashboard may use.', 403);
        folders.folder = path.dirname(journal);
      } else {
        folders.folder = folder('Folder', p.folder);
        journal = path.join(folders.folder, JOURNAL_NAME);
      }
      if (!existsSync(journal)) throw new BadRequest('There is no PhotoSort journal in that folder.');
      params.runId = runId;
      opt(args, '--run-id', runId);
      if (kind === 'undo') opt(args, '--dry-run', p.dryRun);
      else opt(args, '--action', p.action ?? 'move');
      opt(args, '--force', p.force);
      args.push('--', journal);
      break;
    }
    case 'faces': {
      folders.source = folder('Folder', p.source);
      folders.people = folder('People folder', p.people);
      const inside = path.relative(folders.people.toLowerCase(), folders.source.toLowerCase());
      if (!inside || (inside !== '..' && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside))) {
        throw new BadRequest('Pick a folder of photos outside the people folder (it holds only the reference photos).');
      }
      const workers = typeof p.workers === 'string' ? p.workers : undefined;
      // Fixture mode never contacts another machine: only this PC's stand-in worker runs.
      if (dirs.fixture && workers?.split(',').some((w) => w.split(':')[0].toLowerCase() !== 'local')) {
        throw new BadRequest('Fixture mode only runs the local stand-in face worker.', 403);
      }
      args.push(`--people=${folders.people}`);
      opt(args, '--threshold', p.threshold);
      opt(args, '--margin', p.margin);
      opt(args, '--recursive', p.recursive);
      opt(args, '--limit', p.limit || undefined);
      opt(args, '--workers', workers);
      opt(args, '--force', p.force);
      args.push('--', folders.source);
      break;
    }
    case 'faces-setup': {
      if (dirs.fixture) throw new BadRequest('Fixture mode never sets up other machines.', 403);
      args.push('--', ...(p.hosts as string[]));
      break;
    }
  }
  for (const k of ['source', 'dest', 'folder', 'people']) delete params[k];
  return { kind, params, folders, args, heavy: !(kind === 'undo' && p.dryRun === true) };
}

export interface JobView extends Omit<JobRecord, 'argv' | 'folders'> {
  folders: Record<string, DirInfo | { name: string; path: string }>;
  journalDir?: DirInfo;
  position: number;
  elapsedS?: number;
  ratePerMin?: number;
  etaS?: number;
}

export function viewOf(rec: JobRecord, dirs: DirRegistry, jobs: JobManager): JobView {
  const { argv: _argv, folders, ...rest } = rec;
  const info = (p: string) => (dirs.allowed(p) ? dirs.info(p) : { name: path.basename(p), path: p });
  const view: JobView = { ...rest, folders: {}, position: jobs.position(rec.id) };
  for (const [role, p] of Object.entries(folders)) view.folders[role] = info(p);
  if (rec.journal && dirs.allowed(rec.journal)) view.journalDir = dirs.info(path.dirname(rec.journal));
  if (rec.startedAt) {
    const end = rec.finishedAt ? Date.parse(rec.finishedAt) : Date.now();
    view.elapsedS = Math.max(0, Math.round((end - Date.parse(rec.startedAt)) / 100) / 10);
  }
  if (!rec.finishedAt && rec.phaseStartedAt && rec.done > 0) {
    const s = (Date.now() - Date.parse(rec.phaseStartedAt)) / 1000;
    if (s > 0) {
      view.ratePerMin = Math.round((rec.done / s) * 600) / 10;
      if (rec.total) view.etaS = Math.max(0, Math.round(((rec.total - rec.done) / rec.done) * s));
    }
  }
  return view;
}

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof BadRequest || e instanceof DirError) return reply.code(e.status).send({ error: e.message });
  throw e;
}

export function registerJobRoutes(app: FastifyInstance, jobs: JobManager, dirs: DirRegistry): void {
  const idParam = { type: 'object', additionalProperties: false, properties: { id: { type: 'string', maxLength: 40 } }, required: ['id'] };
  const jobBody = {
    type: 'object', additionalProperties: false, required: ['kind', 'params'],
    properties: { kind: { enum: Object.keys(PARAM_SCHEMAS) }, params: { type: 'object' } },
    // Each kind has its own strict parameter schema.
    allOf: Object.entries(PARAM_SCHEMAS).map(([kind, schema]) => ({
      if: { properties: { kind: { const: kind } }, required: ['kind'] },
      then: { properties: { params: schema } },
    })),
  };

  app.post<{ Body: { kind: JobKind; params: P } }>('/api/jobs', {
    config: { auth: 'mutate' },
    schema: { body: jobBody },
  }, async (req, reply) => {
    const { kind, params } = req.body;
    try {
      const rec = jobs.submit(buildSpec(kind, params, dirs, jobs));
      return reply.code(202).send({ jobId: rec.id, position: jobs.position(rec.id), job: viewOf(rec, dirs, jobs) });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: { kind: JobKind; params: P } }>('/api/jobs/cli', {
    config: { auth: 'mutate' },
    schema: { body: jobBody },
  }, async (req, reply) => {
    // The command a job would run, without starting it: forms check their input and offer "Copy CLI command".
    try {
      const spec = buildSpec(req.body.kind, req.body.params, dirs, jobs);
      return { cli: cliText(spec.args, jobs.configPath, jobs.defaultConfig), heavy: spec.heavy };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.get('/api/jobs', { config: { auth: 'read' } }, async () => {
    const all = jobs.list();
    return {
      jobs: all.slice(0, 100).map((j) => ({ ...viewOf(j, dirs, jobs), summary: lightSummary(j.summary), report: undefined })),
      running: jobs.running()?.id,
      queued: all.filter((j) => j.status === 'queued').length,
    };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', { config: { auth: 'read' }, schema: { params: idParam } }, async (req, reply) => {
    const rec = isJobId(req.params.id) ? jobs.get(req.params.id) : undefined;
    return rec ? viewOf(rec, dirs, jobs) : reply.code(404).send({ error: 'no such job' });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; tail?: '1' } }>('/api/jobs/:id/items', {
    config: { auth: 'read' },
    schema: {
      params: idParam,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          after: { type: 'string', pattern: '^\\d{1,12}$' }, limit: { type: 'string', pattern: '^\\d{1,5}$' }, tail: { enum: ['1'] },
        },
      },
    },
  }, async (req, reply) => {
    const rec = isJobId(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!rec) return reply.code(404).send({ error: 'no such job' });
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 500)));
    return jobs.items(rec.id, Number(req.query.after ?? 0), limit, req.query.tail === '1');
  });

  app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>('/api/jobs/:id/cancel', {
    config: { auth: 'mutate' },
    schema: { params: idParam, body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const rec = isJobId(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!rec) return reply.code(404).send({ error: 'no such job' });
    const r = jobs.cancel(rec.id, req.body?.force === true);
    return r.ok ? { ok: true, job: viewOf(rec, dirs, jobs) } : reply.code(409).send(r);
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', { config: { auth: 'mutate' }, schema: { params: idParam } }, async (req, reply) => {
    const rec = isJobId(req.params.id) ? jobs.get(req.params.id) : undefined;
    if (!rec) return reply.code(404).send({ error: 'no such job' });
    return jobs.remove(rec.id) ? { ok: true } : reply.code(409).send({ error: 'only a job that has not started can be removed; cancel a running one' });
  });

  // ---------- folders ----------
  app.get('/api/fs/roots', { config: { auth: 'read' } }, async () => ({ roots: await dirs.roots(), fixture: dirs.fixture }));

  app.get<{ Querystring: { dir: string } }>('/api/fs/dirs', {
    config: { auth: 'read' },
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['dir'], properties: { dir: DIR_ID } } },
  }, async (req, reply) => {
    try {
      return await dirs.list(req.query.dir);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: { path: string } }>('/api/fs/resolve', {
    config: { auth: 'mutate' },
    schema: { body: obj({ path: { type: 'string', minLength: 1, maxLength: 32000 } }, ['path']) },
  }, async (req, reply) => {
    try {
      const info = await dirs.resolve(req.body.path);
      return { ...info, problem: dirs.jobFolderProblem(info.path) };
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
