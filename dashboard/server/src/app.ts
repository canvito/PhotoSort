import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { installSecurity, requireAuthClass, type AuthClass } from './security.ts';
import { SseHub } from './sse.ts';
import { pairHealth } from './health.ts';

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
  webDist?: string;
  logger?: LineLogger;
  onShutdown?: (job: string) => void;
}

export interface App {
  app: FastifyInstance;
  hub: SseHub;
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

  app.get('/healthz', { config: { auth: 'public' } }, async () => ({ ok: true, version: opts.version, mode: opts.mode }));

  app.get('/api/meta', { config: { auth: 'read' } }, async () => ({
    version: opts.version,
    mode: opts.mode,
    node: process.versions.node,
    pid: process.pid,
    startedAt,
    uptimeS: Math.round(process.uptime()),
  }));

  app.get('/api/health', { config: { auth: 'read' } }, async () => ({ pair: await pairHealth(opts.configPath) }));

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
  }, async (req) => {
    const job = req.body?.job ?? 'refuse';
    hub.send('sys', { type: 'shutdown' });
    setImmediate(() => opts.onShutdown?.(job));
    return { stopping: true };
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

  return { app, hub };
}
