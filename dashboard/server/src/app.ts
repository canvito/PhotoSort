import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { installSecurity, requireAuthClass, type AuthClass } from './security.ts';
import { SseHub } from './sse.ts';
import { pairHealth } from './health.ts';
import { DirRegistry } from './dirs.ts';
import { JobManager } from './jobs.ts';
import { registerJobRoutes } from './routes.ts';
import { cachedProbe } from './pyinfo.ts';
import { Sidecar } from './sidecar.ts';
import { registerGalleryRoutes } from './gallery.ts';
import { registerRunRoutes } from './runs.ts';
import { registerPairRoutes } from './cluster.ts';
import { registerPrivacyRoutes } from './privacy.ts';
import type { PairLog } from './pairlog.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthClass;
  }
}

export type Mode = 'real' | 'fixture';

export interface LineLogger {
  info(o: object): void;
  error(o: object): void;
}

export interface AppOptions {
  port: number;
  token: string;
  mode: Mode;
  version: string;
  configPath: string;
  /** The dashboard's own data folder (jobs live in <dataDir>\jobs). */
  dataDir: string;
  /** The Python that runs photosort.py. */
  python: string;
  photosortDir: string;
  /** Fixture mode: the only folders the UI may use. */
  fixtureRoots?: string[];
  /** Folders that may never be a job's source or destination. */
  protectedDirs?: string[];
  webDist?: string;
  logger?: LineLogger;
  onShutdown?: (job: string) => void;
  /** Tests: a stand-in for photosort.py, and how a reattached process is recognised. */
  jobScript?: string;
  isOurProcess?: (pid: number, jobId: string) => Promise<boolean>;
  /** How long a "cancel the job, then stop" request waits for the job (dashboard.ps1 waits 180 s). */
  shutdownWaitMs?: number;
  /** PAIR's data folder (logs\nvpair.jsonl, cluster\members.json); default <dataDir>\pair. */
  pairDir?: string;
  /** This PC's name in PAIR's member list (default: the computer name). */
  selfName?: string;
  /** Tests: stand-in for Get-NetTCPConnection. */
  listConnections?: Parameters<typeof registerPrivacyRoutes>[1]['listConnections'];
}

export interface App {
  app: FastifyInstance;
  hub: SseHub;
  jobs: JobManager;
  dirs: DirRegistry;
  sidecar: Sidecar;
  pair: PairLog;
}

const startedAt = new Date().toISOString();

export async function buildApp(opts: AppOptions): Promise<App> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    return503OnClosing: true,
    // Reject unexpected input instead of silently stripping or coercing it.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  if (opts.logger) {
    const log = opts.logger;
    // Log the route pattern only, never the URL: queries and ids stay out of log files.
    app.addHook('onResponse', async (req, reply) => {
      log.info({ m: req.method, r: req.routeOptions.url ?? '404', s: reply.statusCode, ms: Math.round(reply.elapsedTime) });
    });
  }
  requireAuthClass(app);
  installSecurity(app, { port: opts.port, token: opts.token });
  const hub = new SseHub();
  const dirs = new DirRegistry({ fixtureRoots: opts.fixtureRoots, protectedDirs: opts.protectedDirs });
  const jobs = new JobManager({
    dataDir: opts.dataDir, python: opts.python, photosortDir: opts.photosortDir, configPath: opts.configPath, hub,
    log: opts.logger, script: opts.jobScript, isOurProcess: opts.isOurProcess,
  });
  await jobs.init();
  registerJobRoutes(app, jobs, dirs);
  const sidecar = new Sidecar({ ...opts, hub });
  registerGalleryRoutes(app, sidecar, dirs);
  await registerRunRoutes(app, opts.dataDir, dirs, jobs, sidecar);
  const pair = registerPairRoutes(app, {
    pairDir: opts.pairDir ?? path.join(opts.dataDir, 'pair'), configPath: opts.configPath, hub, selfName: opts.selfName,
  });
  registerPrivacyRoutes(app, { configPath: opts.configPath, dataDir: opts.dataDir, pair, jobs, sidecar, listConnections: opts.listConnections });
  const pythonInfo = cachedProbe(opts.python, opts.photosortDir);

  app.get('/healthz', { config: { auth: 'public' } }, async () => ({ ok: true, version: opts.version, mode: opts.mode }));

  app.get('/api/meta', { config: { auth: 'read' } }, async () => ({
    version: opts.version,
    mode: opts.mode,
    node: process.versions.node,
    pid: process.pid,
    startedAt,
    uptimeS: Math.round(process.uptime()),
  }));

  app.get('/api/health', { config: { auth: 'read' } }, async () => {
    const [pair, python] = await Promise.all([pairHealth(opts.configPath), pythonInfo()]);
    return { pair, python };
  });

  app.get('/api/stream', { config: { auth: 'read' } }, (req, reply) => {
    reply.hijack();
    hub.attach(reply.raw, String(req.headers['last-event-id'] ?? ''));
  });

  app.post<{ Body: { job?: string } }>('/api/shutdown', {
    config: { auth: 'mutate' },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { job: { type: 'string', enum: ['refuse', 'cancel', 'leave'] } },
      },
    },
  }, async (req, reply) => {
    const job = req.body?.job ?? 'refuse';
    const active = jobs.active().sort((a, b) => Number(b.heavy) - Number(a.heavy));
    if (job === 'refuse' && active.length) {
      const j = active[0];
      return reply.code(409).send({ error: 'a job is running', job: { kind: j.kind, done: j.done, total: j.total ?? '?' } });
    }
    // Jobs that have not started yet never outlive the dashboard.
    for (const q of jobs.list().filter((j) => j.status === 'queued')) jobs.remove(q.id);
    let finished = true;
    if (job === 'cancel' && active.length) {
      for (const j of active) jobs.cancel(j.id);
      const wait = opts.shutdownWaitMs ?? 170_000;
      finished = (await Promise.all(active.map((j) => jobs.waitFor(j.id, wait)))).every(Boolean);
    }
    hub.send('sys', { type: 'shutdown' });
    setImmediate(() => opts.onShutdown?.(job));
    return { stopping: true, jobsFinished: finished };
  });

  const distDir = opts.webDist ? path.resolve(opts.webDist) : undefined;
  const dist = distDir && existsSync(path.join(distDir, 'index.html')) ? distDir : undefined;
  if (dist) {
    await app.register(fastifyStatic, { root: dist, serve: false });
  }
  app.get('/*', { config: { auth: 'public' } }, async (req, reply) => {
    const rel = (req.params as { '*': string })['*'] ?? '';
    if (rel.startsWith('api/')) return reply.code(404).send({ error: 'not found' });
    if (!dist) return reply.type('text/plain').send('PhotoSort dashboard: the web app is not built. Run dashboard.ps1 setup.');
    const file = path.resolve(dist, rel);
    const inside = file.startsWith(dist + path.sep) && existsSync(file) && statSync(file).isFile();
    if (inside && rel.startsWith('assets/')) {
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.sendFile(rel, { cacheControl: false });
    }
    reply.header('cache-control', 'no-cache');
    return reply.sendFile(inside ? rel : 'index.html', { cacheControl: false });
  });

  app.addHook('onClose', async () => { await Promise.all([jobs.close(), sidecar.close()]); });
  return { app, hub, jobs, dirs, sidecar, pair };
}
