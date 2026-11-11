// Cluster page routes: PAIR nodes, request charts and the routing audit (from PAIR's log, see pairlog.ts), and the
// models PAIR lists or has loaded (from the loopback proxy). Alerts go out on the SSE "pair" channel.
import type { FastifyInstance } from 'fastify';
import { readConfig } from './health.ts';
import { isCloudModel, localGetJson, requireLoopback } from './localfetch.ts';
import { PairLog, WINDOWS, type PairAlert } from './pairlog.ts';
import type { SseHub } from './sse.ts';

interface TagEntry {
  name?: string;
  size?: number;
  remote_host?: unknown;
  remote_model?: unknown;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

interface PsEntry {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

export function registerPairRoutes(app: FastifyInstance, opts: { pairDir: string; configPath: string; hub: SseHub; selfName?: string; refreshMs?: number }): PairLog {
  const log = new PairLog({
    dir: opts.pairDir,
    selfName: opts.selfName,
    onAlert: (a: PairAlert) => opts.hub.send('pair', { type: 'alert', alert: { ...a, t: new Date(a.t).toISOString() } }),
  });
  const ready = (): Promise<void> => log.refresh(1000).then(() => log.loadMembers()).then(() => undefined);
  const timer = setInterval(() => void ready().catch(() => undefined), opts.refreshMs ?? 5000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  const windowQuery = { type: 'object', additionalProperties: false, properties: { window: { enum: Object.keys(WINDOWS) } } };

  app.get<{ Querystring: { window?: keyof typeof WINDOWS } }>('/api/pair/nodes', {
    config: { auth: 'read' }, schema: { querystring: windowQuery },
  }, async (req) => {
    await ready();
    const w = req.query.window ?? '1h';
    return { status: log.status(), window: w, nodes: log.nodes(WINDOWS[w].ms) };
  });

  app.get<{ Querystring: { window?: keyof typeof WINDOWS } }>('/api/pair/stats', {
    config: { auth: 'read' }, schema: { querystring: windowQuery },
  }, async (req) => {
    await ready();
    return log.stats(req.query.window ?? '1h');
  });

  app.get('/api/pair/audit', { config: { auth: 'read' } }, async () => {
    await ready();
    return log.audit();
  });

  app.get('/api/pair/models', { config: { auth: 'read' } }, async () => {
    try {
      const cfg = await readConfig(opts.configPath);
      const base = String(cfg.base_url ?? '');
      requireLoopback(base);
      const [tags, ps] = await Promise.all([
        localGetJson(base, '/api/tags') as Promise<{ models?: TagEntry[] }>,
        (localGetJson(base, '/api/ps') as Promise<{ models?: PsEntry[] }>).catch(() => ({ models: [] as PsEntry[] })),
      ]);
      const used = new Set([cfg.model, cfg.caption_model ?? cfg.model, cfg.embed_model].filter((m): m is string => typeof m === 'string'));
      return {
        reachable: true,
        models: (tags.models ?? []).map((m) => ({
          name: String(m.name ?? ''), size: m.size, cloud: isCloudModel(String(m.name ?? ''), m), used: used.has(String(m.name ?? '')),
          family: m.details?.family, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level,
        })).sort((a, b) => Number(b.used) - Number(a.used) || a.name.localeCompare(b.name)),
        loaded: (ps.models ?? []).map((m) => ({ name: String(m.name ?? m.model ?? ''), size: m.size, sizeVram: m.size_vram, expiresAt: m.expires_at })),
      };
    } catch (e) {
      return { reachable: false, error: e instanceof Error ? e.message : String(e), models: [], loaded: [] };
    }
  });

  return log;
}
