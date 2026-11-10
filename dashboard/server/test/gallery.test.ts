import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { byteRange } from '../src/gallery.ts';
import { findPython, photosortDir } from './helpers.ts';

const PY = findPython();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ps-gallery-'));
const root = path.join(tmp, 'fixture');
const token = 'g'.repeat(43);
const PORT = 47988;
const headers = { host: `127.0.0.1:${PORT}`, 'x-photosort-token': token };
let built: App;
let fake: ChildProcess;
const logs: object[] = [];
type Item = { id: string; name: string; revision: string; kind: string; exists: boolean };

function jsonGet(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/fake/stats' }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
}
const get = (url: string) => built.app.inject({ url, headers });
const post = (url: string, payload: object = {}) => built.app.inject({ method: 'POST', url, headers, payload });

beforeAll(async () => {
  execFileSync(PY, [path.join(photosortDir, 'dashboard', 'fixtures', 'make_search_fixture.py'),
    '--out', root, '--count', '64', '--dims', '256'], { stdio: 'ignore' });
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  fake = spawn(PY, [path.join(photosortDir, 'tests', 'fake_pair.py'), '--port', String(port), '--parent-pid', String(process.pid)],
    { stdio: 'ignore', windowsHide: true });
  for (let i = 0; ; i++) {
    try { await jsonGet(port); break; }
    catch { if (i > 100) throw new Error('fake PAIR not ready'); await new Promise((r) => setTimeout(r, 50)); }
  }
  const configPath = path.join(root, 'config.json');
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  cfg.base_url = `http://127.0.0.1:${port}`;
  writeFileSync(configPath, JSON.stringify(cfg));
  built = await buildApp({ port: PORT, token, mode: 'fixture', version: 'test', configPath, dataDir: path.join(root, 'app'),
    python: PY, photosortDir, fixtureRoots: [path.join(root, 'library')],
    logger: { info: (o) => logs.push(o), error: (o) => logs.push(o) } });
});

afterAll(async () => {
  built?.hub.close();
  await built?.app.close();
  fake?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

describe('local search and gallery through the persistent Python sidecar', () => {
  it('requires auth and refuses arbitrary paths and forged media ids', async () => {
    for (const url of ['/api/index/stats', '/api/index/items', '/media/m_' + 'a'.repeat(32) + '/thumb']) {
      expect((await built.app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(401);
    }
    expect((await get('/api/index/items?path=C%3A%5CWindows')).statusCode).toBe(400);
    expect((await get('/api/index/items/m_' + 'a'.repeat(32))).statusCode).toBe(404);
    expect((await get('/media/..%2f..%2fsecret/thumb')).statusCode).toBe(400);
    expect((await post('/api/search', { query: 'synthetic', path: 'C:\\Windows' })).statusCode).toBe(400);
    expect((await built.app.inject({ method: 'POST', url: '/api/search', headers: { ...headers, origin: 'https://example.com' },
      payload: { query: 'synthetic' } })).statusCode).toBe(403);
  });

  it('browses all indexed rows with paging and filters, details only on demand', async () => {
    const stats = await get('/api/index/stats');
    expect(stats.json()).toMatchObject({ ready: true, total: 64, photos: 62, videos: 2 });
    const first = (await get('/api/index/items?limit=10')).json() as { items: Item[]; nextCursor: number; total: number };
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBe(10);
    expect(first.items.every((r) => !('caption' in r))).toBe(true);
    const next = (await get('/api/index/items?cursor=10&limit=10')).json() as { items: Item[] };
    expect(next.items.map((r) => r.id).some((id) => first.items.some((r) => r.id === id))).toBe(false);
    const videos = (await get('/api/index/items?media=videos')).json() as { items: Item[] };
    expect(videos.items).toHaveLength(2);
    const detail = await get(`/api/index/items/${first.items[0].id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().caption).toContain('Synthetic');
    expect(detail.headers['cache-control']).toBe('no-store');
  });

  it('warms once, searches with local embeddings, and reports timings without query text', async () => {
    expect((await post('/api/search/warm')).json().rows).toBe(64);
    const r = await post('/api/search', { query: 'private synthetic query', top: 7, media: 'photos', minScore: -1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().results).toHaveLength(7);
    expect(r.json().searched).toBe(62);
    expect(r.json().results.every((r: Item) => r.kind === 'photo')).toBe(true);
    expect((await get('/api/index/stats')).json().matrix.loaded).toBe(true);
    const metrics = (await get('/api/metrics')).json();
    expect(metrics.search.count).toBeGreaterThan(0);
    expect(JSON.stringify(metrics)).not.toContain('query');
    expect(JSON.stringify(logs)).not.toMatch(/private synthetic query|generated_.*\.jpg|Synthetic geometric/);
  });

  it('serves WebP thumbnails and local video ranges/strip, invalidates changed revisions', async () => {
    const items = (await get('/api/index/items')).json().items as Item[];
    const photo = items.find((r) => r.kind === 'photo')!;
    const thumb = await get(`/media/${photo.id}/thumb?v=${photo.revision}`);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/webp');
    expect(thumb.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect((await get(`/media/${photo.id}/thumb?v=0-0`)).statusCode).toBe(409);
    const video = items.find((r) => r.kind === 'video')!;
    const partial = await built.app.inject({ url: `/media/${video.id}/original`, headers: { ...headers, range: 'bytes=0-31' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload.length).toBe(32);
    expect(partial.headers['content-range']).toMatch(/^bytes 0-31\//);
    expect((await get(`/media/${video.id}/strip`)).headers['content-type']).toContain('image/webp');
    expect((await post(`/api/media/${photo.id}/reveal`)).statusCode).toBe(200);
    expect((await post('/api/cache/clear')).statusCode).toBe(200);
    expect((await get('/api/index/stats')).json().cache.files).toBe(0);
  });

  it('notices CLI index moves on its persistent connection', async () => {
    const before = (await get('/api/index/stats')).json().generation;
    execFileSync(PY, ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE photos SET caption='Fixture changed',indexed_at='later'\"); c.commit(); c.close()",
      path.join(root, 'search_index.sqlite')], { stdio: 'ignore' });
    const after = (await get('/api/index/stats')).json();
    expect(after.generation).toBeGreaterThan(before);
    expect(after.matrix.loaded).toBe(false);
    const first = (await get('/api/index/items?limit=1')).json().items[0] as Item;
    expect((await get(`/api/index/items/${first.id}`)).json().caption).toBe('Fixture changed');
  });
});

it('handles suffix/open byte ranges and rejects unsatisfiable/multi ranges', () => {
  expect(byteRange('bytes=-10', 100)).toEqual([90, 99]);
  expect(byteRange('bytes=10-', 100)).toEqual([10, 99]);
  for (const invalid of ['bytes=100-', 'bytes=4-3', 'bytes=1-2,3-4', 'bytes=-0', 'bytes=-']) {
    expect(byteRange(invalid, 100)).toBeNull();
  }
});
