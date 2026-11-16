import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { DirError, type DirRegistry } from './dirs.ts';
import { Sidecar, SidecarError } from './sidecar.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const media = { enum: ['both', 'photos', 'videos'] };
const dir = { type: 'string', pattern: '^d_[A-Za-z0-9_-]{22}$' };
const id = { type: 'string', pattern: '^m_[a-f0-9]{32}$' };
const idParams = obj({ id }, ['id']);
const versionQuery = obj({ v: { type: 'string', pattern: '^[a-f0-9]+-[a-f0-9]+$' } });

const ERRORS: Record<string, [number, string]> = {
  missing: [404, 'This file is no longer available. Refresh the library.'],
  placeholder: [409, 'Cloud-only file: choose Always keep on this device in Explorer, then refresh.'],
  changed: [409, 'This file changed. Refresh the library.'],
  no_index: [409, 'No search index yet. Index a folder first.'],
  local_only: [403, 'Local-only privacy guard refused this request. Check the local models and index location.'],
  model_unavailable: [503, 'The local embedding model is unavailable. Check PAIR.'],
  unsupported: [415, 'This media format is not supported for playback. Use the frame preview.'],
  undecodable: [422, 'A preview could not be decoded.'],
  busy: [409, 'Preview work is in progress. Try again shortly.'],
  timeout: [504, 'Local processing timed out. Try again.'],
  no_results: [404, 'No face results in this folder yet. Run face tagging on it first.'],
  bad_results: [422, 'The face results file in this folder could not be read. Run face tagging again.'],
};

export function error(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof DirError) return reply.code(e.status).send({ error: e.message });
  const [status, message] = e instanceof SidecarError ? ERRORS[e.code] ?? [503, 'The local library service is unavailable. Try again.']
    : [500, 'Could not read this local file. Refresh and try again.'];
  return reply.header('cache-control', 'no-store').code(status).send({ error: message });
}

/** Single byte ranges only, including suffixes. Never read the whole video into Node's heap. */
export function byteRange(header: string | undefined, size: number): [number, number] | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] ? (m[2] ? Math.min(Number(m[2]), size - 1) : size - 1) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? [start, end] : null;
}

export function registerGalleryRoutes(app: FastifyInstance, sidecar: Sidecar, dirs: DirRegistry): void {
  const timings: number[] = [];
  const folder = (value?: string) => value ? dirs.pathOf(value) : undefined;
  app.get('/api/index/stats', { config: { auth: 'read' } }, async (_req, reply) => {
    try { return await sidecar.call('index.stats'); } catch (e) { return error(reply, e); }
  });
  app.get<{ Querystring: { cursor?: string; limit?: string; sort?: string; media?: string; dir?: string } }>('/api/index/items', {
    config: { auth: 'read' }, schema: { querystring: obj({
      cursor: { type: 'string', pattern: '^\\d{1,8}$' }, limit: { type: 'string', pattern: '^\\d{1,3}$' },
      sort: { enum: ['name', 'folder', 'indexed'] }, media, dir,
    }) },
  }, async (req, reply) => {
    try {
      return await sidecar.call('index.list', { cursor: Number(req.query.cursor ?? 0),
        limit: Math.min(500, Math.max(1, Number(req.query.limit ?? 200))), sort: req.query.sort ?? 'name',
        media: req.query.media ?? 'both', dir: folder(req.query.dir) });
    } catch (e) { return error(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/api/index/items/:id', {
    config: { auth: 'read' }, schema: { params: idParams },
  }, async (req, reply) => {
    try { return await sidecar.call('index.get', req.params); } catch (e) { return error(reply, e); }
  });
  app.post<{ Body: { query: string; dir?: string; top?: number; media?: string; minScore?: number } }>('/api/search', {
    config: { auth: 'mutate' }, schema: { body: obj({
      query: { type: 'string', minLength: 1, maxLength: 4000 }, dir, media,
      top: { type: 'integer', minimum: 1, maximum: 500 }, minScore: { type: 'number', minimum: -1, maximum: 1 },
    }, ['query']) },
  }, async (req, reply) => {
    try {
      if (!req.body.query.trim()) return reply.code(400).send({ error: 'Enter a search query.' });
      const start = performance.now();
      const result = await sidecar.call('search.query', { ...req.body, dir: folder(req.body.dir) });
      timings.push(performance.now() - start);
      if (timings.length > 100) timings.shift();
      return result;
    } catch (e) { return error(reply, e); }
  });
  for (const [url, method] of [['/api/search/warm', 'search.warm'], ['/api/cache/clear', 'cache.clear']]) {
    app.post(url, { config: { auth: 'mutate' }, schema: { body: obj({}) } }, async (_req, reply) => {
      try { return await sidecar.call(method); } catch (e) { return error(reply, e); }
    });
  }
  for (const kind of ['thumb', 'preview', 'strip']) {
    app.get<{ Params: { id: string }; Querystring: { v?: string } }>(`/media/:id/${kind}`, {
      config: { auth: 'read' }, schema: { params: idParams, querystring: versionQuery },
    }, async (req, reply) => {
      try {
        const result = await sidecar.call<{ path: string; revision: string }>('media.make',
          { id: req.params.id, kind, revision: req.query.v });
        // Revalidate on every display: an edited or newly cloud-only file must not use stale media.
        reply.header('cache-control', 'private, no-cache').type('image/webp');
        return reply.send(createReadStream(result.path));
      } catch (e) { return error(reply, e); }
    });
  }
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/media/:id/original', {
    config: { auth: 'read' }, schema: { params: idParams, querystring: versionQuery },
  }, async (req, reply) => {
    try {
      const result = await sidecar.call<{ path: string; size: number; extension: string }>('media.original',
        { id: req.params.id, revision: req.query.v });
      reply.header('cache-control', 'no-store').header('accept-ranges', 'bytes');
      const range = byteRange(req.headers.range, result.size);
      if (range === null) return reply.code(416).header('content-range', `bytes */${result.size}`).send();
      const mime: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
      reply.type(mime[result.extension] ?? 'application/octet-stream');
      if (range) {
        reply.code(206).header('content-range', `bytes ${range[0]}-${range[1]}/${result.size}`)
          .header('content-length', range[1] - range[0] + 1);
        return reply.send(createReadStream(result.path, { start: range[0], end: range[1] }));
      }
      reply.header('content-length', result.size);
      return reply.send(createReadStream(result.path));
    } catch (e) { return error(reply, e); }
  });
  app.post<{ Params: { id: string } }>('/api/media/:id/reveal', {
    config: { auth: 'mutate' }, schema: { params: idParams, body: obj({}) },
  }, async (req, reply) => {
    try {
      const result = await sidecar.call<{ path: string }>('media.reveal', req.params);
      if (!dirs.fixture) {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(path.join(process.env.WINDIR ?? 'C:\\Windows', 'explorer.exe'),
            [`/select,${result.path}`], { shell: false, stdio: 'ignore', windowsHide: false });
          child.once('error', reject);
          child.once('spawn', () => { child.unref(); resolve(); });
        });
      }
      return { ok: true };
    } catch (e) { return error(reply, e); }
  });
  app.get('/api/metrics', { config: { auth: 'read' } }, async () => {
    const sorted = [...timings].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : 0;
    return { search: { count: timings.length, p50Ms: percentile(.5), p95Ms: percentile(.95) }, sidecarPid: sidecar.pid,
      serverBytes: process.memoryUsage().rss };
  });
}
