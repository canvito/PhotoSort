// Face-tagging results and workers. The sidecar reads the photosort_faces.json a faces job writes into its folder;
// files in it get the same opaque media ids as the index, so thumbnails and previews use the /media routes.
import type { FastifyInstance } from 'fastify';
import type { DirRegistry } from './dirs.ts';
import { error } from './gallery.ts';
import { WORKERS } from './routes.ts';
import type { Sidecar } from './sidecar.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const dir = { type: 'string', pattern: '^d_[A-Za-z0-9_-]{22}$' };
const id = { type: 'string', pattern: '^m_[a-f0-9]{32}$' };
const filter = { type: 'string', maxLength: 200, pattern: '^(all|unknown|none|errors|person:[^\\u0000-\\u001f\\\\/]{1,120})$' };

export function registerFaceRoutes(app: FastifyInstance, sidecar: Sidecar, dirs: DirRegistry): void {
  app.get<{ Querystring: { folder: string } }>('/api/faces', {
    config: { auth: 'read' }, schema: { querystring: obj({ folder: dir }, ['folder']) },
  }, async (req, reply) => {
    try { return await sidecar.call('faces.read', { folder: dirs.pathOf(req.query.folder) }); } catch (e) { return error(reply, e); }
  });
  app.get<{ Querystring: { folder: string; filter?: string; cursor?: string; limit?: string } }>('/api/faces/items', {
    config: { auth: 'read' }, schema: { querystring: obj({
      folder: dir, filter, cursor: { type: 'string', pattern: '^\\d{1,8}$' }, limit: { type: 'string', pattern: '^\\d{1,3}$' },
    }, ['folder']) },
  }, async (req, reply) => {
    try {
      return await sidecar.call('faces.items', { folder: dirs.pathOf(req.query.folder), filter: req.query.filter ?? 'all',
        cursor: Number(req.query.cursor ?? 0), limit: Math.min(500, Math.max(1, Number(req.query.limit ?? 200))) });
    } catch (e) { return error(reply, e); }
  });
  app.get<{ Params: { id: string }; Querystring: { folder: string } }>('/api/faces/items/:id', {
    config: { auth: 'read' }, schema: { params: obj({ id }, ['id']), querystring: obj({ folder: dir }, ['folder']) },
  }, async (req, reply) => {
    try { return await sidecar.call('faces.item', { folder: dirs.pathOf(req.query.folder), id: req.params.id }); } catch (e) { return error(reply, e); }
  });
  app.get<{ Querystring: { dir: string } }>('/api/faces/people', {
    config: { auth: 'read' }, schema: { querystring: obj({ dir }, ['dir']) },
  }, async (req, reply) => {
    try { return await sidecar.call('faces.people', { dir: dirs.pathOf(req.query.dir) }); } catch (e) { return error(reply, e); }
  });
  app.get('/api/faces/workers', { config: { auth: 'read' } }, async (_req, reply) => {
    try { return await sidecar.call('faces.workers'); } catch (e) { return error(reply, e); }
  });
  // POST: checking an SSH worker contacts that machine (only after the same LAN-only check a real run makes).
  app.post<{ Body: { workers?: string } }>('/api/faces/check-workers', {
    config: { auth: 'mutate' }, schema: { body: obj({ workers: WORKERS }) },
  }, async (req, reply) => {
    try {
      return await sidecar.call('faces.check_workers', { workers: req.body.workers?.split(',') });
    } catch (e) { return error(reply, e); }
  });
}
