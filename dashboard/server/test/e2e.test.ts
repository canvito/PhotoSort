// End to end: the dashboard server runs the real photosort.py against fake_pair.py (no model, loopback only) on a
// fresh synthetic library, and a real SSE client listens. Covers sort, apply, undo (preview first), group, index,
// a safe stop, and measures M7 (CLI event -> SSE in the page, at most 500 ms).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { JobManager, type JobSpec } from '../src/jobs.ts';
import { findPython, photosortDir, RecordingHub, until } from './helpers.ts';

const PY = findPython();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'psdash-e2e-'));
const lib = path.join(tmp, 'library');
const people = path.join(tmp, 'people'); // make_fixtures puts the reference portraits beside the library
const PHOTOS = 24;
const MEDIA = PHOTOS + 2; // make_fixtures adds two clips
const TOKEN = 'e'.repeat(43);
const MEDIA_EXT = /\.(jpe?g|png|mp4)$/i;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function getJson<T>(port: number, url: string, headers: Record<string, string> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url, headers }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(text) as T);
        } catch (e) {
          reject(e as Error);
        }
      });
    }).on('error', reject);
  });
}

async function startFakePair(delayMs = 0): Promise<{ port: number; proc: ChildProcess; stats(): Promise<Record<string, number>> }> {
  const port = await freePort();
  const proc = spawn(PY, [path.join(photosortDir, 'tests', 'fake_pair.py'), '--port', String(port), '--parent-pid', String(process.pid),
    '--delay-ms', String(delayMs)], { stdio: 'ignore', windowsHide: true });
  const stats = () => getJson<Record<string, number>>(port, '/fake/stats');
  const end = Date.now() + 15000;
  for (;;) {
    try {
      await stats();
      break;
    } catch {
      if (Date.now() > end) throw new Error('fake_pair did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { port, proc, stats };
}

function writeConfig(name: string, fakePort: number): string {
  const cfg = JSON.parse(readFileSync(path.join(photosortDir, 'dashboard', 'fixtures', 'config.fixture.json'), 'utf8')) as Record<string, unknown>;
  cfg.base_url = `http://127.0.0.1:${fakePort}`;
  cfg.index_path = path.join(tmp, 'search_index.sqlite');
  const file = path.join(tmp, name);
  writeFileSync(file, JSON.stringify(cfg, null, 1));
  return file;
}

/** Media files under `dir`, by folder relative to it ('' = the folder itself). */
function mediaByFolder(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (MEDIA_EXT.test(e.name)) {
        const rel = path.relative(dir, d);
        out[rel] = (out[rel] ?? 0) + 1;
      }
    }
  };
  walk(dir);
  return out;
}

const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

function journalLines(dir: string): Record<string, unknown>[] {
  return readFileSync(path.join(dir, '_photosort_journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The page's view of the stream: every SSE event with the time it arrived. */
interface Seen { event: string; data: Record<string, unknown>; at: number }

describe('dashboard jobs against the real CLI and fake PAIR', () => {
  let built: App;
  let fake: Awaited<ReturnType<typeof startFakePair>>;
  let port: number;
  let host: string;
  let configPath: string;
  let stream: http.ClientRequest | undefined;
  const seen: Seen[] = [];
  const auth = () => ({ host, 'x-photosort-token': TOKEN });

  const post = async (url: string, payload: unknown) => {
    const r = await built.app.inject({ method: 'POST', url, headers: { ...auth(), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  const view = async (id: string) => (await built.app.inject({ url: `/api/jobs/${id}`, headers: auth() })).json() as Record<string, unknown> & {
    status: string; summary: Record<string, unknown>; counts: Record<string, number>; runId?: string; durationS?: number;
    understood?: Record<string, unknown>;
  };
  /** Starts a job through the API, waits for it, and returns its full view. */
  const run = async (kind: string, params: Record<string, unknown>) => {
    const r = await post('/api/jobs', { kind, params });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const id = r.body.jobId as string;
    expect(await built.jobs.waitFor(id, 120000)).toBe(true);
    return { id, ...(await view(id)) };
  };

  beforeAll(async () => {
    const t0 = Date.now();
    execFileSync(PY, [path.join(photosortDir, 'dashboard', 'fixtures', 'make_fixtures.py'), '--out', lib, '--count', String(PHOTOS)], { stdio: 'ignore' });
    fake = await startFakePair();
    configPath = writeConfig('config.json', fake.port);
    port = await freePort();
    host = `127.0.0.1:${port}`;
    built = await buildApp({
      port, token: TOKEN, mode: 'fixture', version: 'e2e', configPath, dataDir: path.join(tmp, 'app'), python: PY, photosortDir,
      fixtureRoots: [lib, people], shutdownWaitMs: 10000, onShutdown: () => undefined,
    });
    await built.app.listen({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      stream = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: auth() }, (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => {
          const at = Date.now();
          buf += c.toString();
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) seen.push({ event, data: JSON.parse(data) as Record<string, unknown>, at });
          }
        });
        resolve();
      });
      stream.on('error', reject);
    });
    console.log(`e2e setup (fixtures, fake PAIR, server) took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }, 120000);

  afterAll(async () => {
    stream?.destroy();
    await built?.jobs.close();
    built?.hub.close();
    await built?.app.close();
    fake?.proc.kill();
  });

  it('sorts a preview, applies it without asking the model again, then undoes it after an undo preview', async () => {
    const S = built.dirs.idFor(lib);
    const before = mediaByFolder(lib);
    expect(before).toEqual({ '': MEDIA });

    const preview = await run('sort', { source: S, action: 'report' });
    expect(preview.status).toBe('ok');
    expect(preview.summary).toMatchObject({ sorted: MEDIA, videos: 2, errors: 0 });
    expect(preview.counts).toEqual({ nature: 10, documents_receipts: 4, screenshot_other: 4, food: 4, people: 4 });
    expect(preview.durationS).toBeGreaterThan(0);
    expect(mediaByFolder(lib)).toEqual(before);

    // M7: each file's event reaches the page within 500 ms of the CLI writing it.
    const tsBySeq = new Map<number, number>();
    for (const line of readFileSync(path.join(built.jobs.jobDir(preview.id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const ev = JSON.parse(line) as { seq: number; ts: string };
      tsBySeq.set(ev.seq, Date.parse(ev.ts));
    }
    const itemEvents = () => seen.filter((s) => s.data.job === preview.id && s.data.type === 'items');
    await until(() => itemEvents().reduce((a, s) => a + (s.data.items as unknown[]).length, 0) >= MEDIA, 5000, 'every item on the page');
    const lags = itemEvents()
      .flatMap((s) => (s.data.items as { seq: number }[]).map((it) => s.at - tsBySeq.get(it.seq)!));
    expect(lags).toHaveLength(MEDIA);
    lags.sort((a, b) => a - b);
    const p95 = lags[Math.floor(lags.length * 0.95)];
    console.log(`M7 CLI event -> SSE: median ${lags[lags.length >> 1]} ms, p95 ${p95} ms, max ${lags.at(-1)} ms`);
    expect(p95).toBeLessThanOrEqual(500);

    const asked = await fake.stats();
    const applied = await run('apply', { job: preview.id, action: 'move' });
    expect(applied.status).toBe('ok');
    expect(applied.summary).toMatchObject({ planned: MEDIA, applied: MEDIA, changed: 0, errors: 0 });
    expect(await fake.stats()).toEqual(asked);
    const sorted = mediaByFolder(lib);
    expect(sorted).toEqual({ nature: 10, documents_receipts: 4, screenshot_other: 4, food: 4, people: 4 });
    const moved = journalLines(lib).filter((e) => e.run_id === applied.runId && e.dst);
    expect(moved).toHaveLength(MEDIA);

    const undoPreview = await run('undo', { job: applied.id, dryRun: true });
    expect(undoPreview.status).toBe('ok');
    expect(undoPreview.summary).toMatchObject({ restored: MEDIA, problems: 0, dry_run: true });
    expect(undoPreview.runId).toBe(applied.runId);
    expect(mediaByFolder(lib)).toEqual(sorted);

    const undone = await run('undo', { job: undoPreview.id });
    expect(undone.status).toBe('ok');
    expect(undone.summary).toMatchObject({ restored: MEDIA, problems: 0 });
    expect(mediaByFolder(lib)).toEqual(before);
    const ids = [preview.id, applied.id, undoPreview.id, undone.id];
    await until(() => ids.every((id) => seen.some((s) => s.data.type === 'finished' && s.data.job === id)), 5000,
      'every job to reach the page as finished');
  }, 300000);

  it('groups by a description: shows what it understood, previews, applies, and undoes', async () => {
    const S = built.dirs.idFor(lib);
    const preview = await run('group', { source: S, action: 'report', request: 'sunset photos and videos' });
    expect(preview.status).toBe('ok');
    expect(preview.understood).toMatchObject({ topic: 'a sunset', media: 'both' });
    expect(seen.some((s) => s.data.job === preview.id && s.data.type === 'understood')).toBe(true);
    const matched = preview.summary.matched as number;
    const paths = preview.summary.matched_paths as string[];
    expect(matched).toBe(PHOTOS / 6 + 1);
    expect(paths.every((p) => /sunset_|clip_000/.test(path.basename(p)))).toBe(true);

    const asked = await fake.stats();
    const applied = await run('apply', { job: preview.id, action: 'move' });
    expect(applied.status).toBe('ok');
    expect(applied.summary).toMatchObject({ applied: matched, errors: 0 });
    expect(await fake.stats()).toEqual(asked);
    const after = mediaByFolder(lib);
    const groupDir = Object.keys(after).find((k) => k !== '');
    expect(groupDir).toBeDefined();
    expect(after).toEqual({ '': MEDIA - matched, [groupDir!]: matched });

    const undoPreview = await run('undo', { job: applied.id, dryRun: true });
    expect(undoPreview.summary).toMatchObject({ restored: matched, problems: 0 });
    const undone = await run('undo', { job: undoPreview.id });
    expect(undone.summary).toMatchObject({ restored: matched });
    expect(mediaByFolder(lib)).toEqual({ '': MEDIA });
  }, 300000);

  it('indexes a folder, and the next run skips the files it already did', async () => {
    const S = built.dirs.idFor(lib);
    const first = await run('index', { source: S });
    expect(first.status).toBe('ok');
    expect(first.summary).toMatchObject({ images: MEDIA, captioned: MEDIA, errors: 0 });
    const asked = await fake.stats();
    const again = await run('index', { source: S });
    expect(again.summary).toMatchObject({ images: MEDIA, captioned: 0, unchanged: MEDIA, errors: 0 });
    expect((await fake.stats()).chat).toBe(asked.chat);
  }, 300000);

  it('lists every run: dashboard runs joined to their jobs, and terminal runs from an added folder', async () => {
    const get = async (url: string) => {
      const r = await built.app.inject({ url, headers: auth() });
      return { status: r.statusCode, body: r.json() as Record<string, unknown> };
    };
    type Row = Record<string, unknown> & { kind: string; origin: string; key: string };
    const first = (await get('/api/runs')).body as { runs: Row[]; folders: Record<string, unknown>[] };
    const fromJournal = first.runs.filter((r) => r.origin === 'journal');
    expect(fromJournal.map((r) => `${r.kind}:${r.action}`).sort()).toEqual(['apply:move', 'apply:move', 'group:report', 'sort:report']);
    expect(fromJournal.every((r) => r.jobId && r.terminal === false && r.durationExact === true)).toBe(true);
    const sortPreview = fromJournal.find((r) => r.kind === 'sort')!;
    expect(sortPreview).toMatchObject({ files: MEDIA, canApply: true, buckets: { nature: 10, documents_receipts: 4, screenshot_other: 4, food: 4, people: 4 } });
    for (const a of fromJournal.filter((r) => r.kind === 'apply')) expect(a).toMatchObject({ canUndo: false, undone: { restored: expect.any(Number) } });
    expect(first.runs.filter((r) => r.origin === 'job').map((r) => r.kind).sort()).toEqual(['index', 'index', 'undo', 'undo', 'undo', 'undo']);
    expect(first.folders).toMatchObject([{ path: lib, fromJobs: true, registered: false, journal: true }]);

    // A run made from a terminal in another folder: only its journal knows about it.
    const other = path.join(lib, 'from terminal');
    mkdirSync(other);
    const rid = '20260102-100000-abcdef';
    const line = (name: string, bucket: string, ts: string) => JSON.stringify({ ts, run_id: rid, action: 'move', model: 'm',
      src: path.join(other, name), dst: path.join(other, bucket, name), bucket, confidence: 0.9, fp: 'x' });
    writeFileSync(path.join(other, '_photosort_journal.jsonl'),
      `${line('x.jpg', 'nature', '2026-01-02T10:00:00')}\n${line('y.jpg', 'food', '2026-01-02T10:00:03')}\n{"half a line`);
    writeFileSync(path.join(other, '_photosort_journal-OTHERPC.jsonl'), '');
    const dir = (await post('/api/fs/resolve', { path: other })).body.dirId as string;
    expect((await post('/api/folders', { dir })).status).toBe(200);
    expect(readFileSync(path.join(tmp, 'app', 'folders.json'), 'utf8')).toContain('from terminal');

    const second = (await get('/api/runs')).body as { runs: Row[]; folders: Record<string, unknown>[] };
    const term = second.runs.find((r) => r.runId === rid)!;
    expect(term).toMatchObject({ terminal: true, kind: 'sort', action: 'move', files: 2, canUndo: true, durationS: 3, durationExact: false,
      buckets: { nature: 1, food: 1 }, startedAt: new Date('2026-01-02T10:00:00').toISOString() });
    expect(second.folders.find((f) => f.dirId === dir)).toMatchObject({ registered: true, conflicts: [{ name: '_photosort_journal-OTHERPC.jsonl', runs: 0 }] });
    expect((await get(`/api/runs/${term.key}`)).body).toMatchObject({ run: { runId: rid, terminal: true } });
    const items = (await get(`/api/runs/${term.key}/items?offset=1&limit=5`)).body;
    expect(items).toMatchObject({ total: 2, offset: 1, items: [{ n: 2, name: 'y.jpg', bucket: 'food', restored: false }] });
    expect((await get(`/api/runs/${dir}~20260102-100000-000000`)).status).toBe(404);
    expect((await get(`/api/runs/d_${'A'.repeat(22)}~${rid}`)).status).toBe(404);
    expect((await get('/api/runs/not-a-key')).status).toBe(400);

    const del = await built.app.inject({ method: 'DELETE', url: `/api/folders/${dir}`, headers: { ...auth(), origin: `http://${host}` } });
    expect(del.statusCode).toBe(200);
    expect(((await get('/api/runs')).body.runs as Row[]).some((r) => r.runId === rid)).toBe(false);
    rmSync(other, { recursive: true });
  }, 60000);

  it('tags faces with the stand-in worker (fixture mode never contacts another PC), and the Faces API reads the results', async () => {
    const get = async (url: string) => {
      const r = await built.app.inject({ url, headers: auth() });
      return { status: r.statusCode, body: r.json() as Record<string, any> };
    };
    const S = built.dirs.idFor(lib);
    const P = built.dirs.idFor(people);
    expect((await get(`/api/faces?folder=${S}`)).status).toBe(404);
    const start = (params: Record<string, unknown>, kind = 'faces') => post('/api/jobs', { kind, params });
    expect((await start({ source: P, people: P })).status).toBe(400);
    expect((await start({ source: S, people: P, workers: 'local;calc' })).status).toBe(400);
    expect((await start({ source: S, people: P, workers: 'local:2,lan-box:4' })).status).toBe(403);
    expect((await start({ hosts: ['lan-box'] }, 'faces-setup')).status).toBe(403);

    const job = await run('faces', { source: S, people: P, workers: 'local:2' });
    expect(job.status, JSON.stringify(job)).toBe('ok');
    expect(job.summary).toMatchObject({ images: PHOTOS, videos: 2, errors: 0 });
    expect(total(job.counts)).toBe(MEDIA);
    expect(job.counts.named).toBeGreaterThan(0);
    expect(job.counts['no faces']).toBeGreaterThan(0);
    await until(() => seen.some((s) => s.data.job === job.id && s.data.type === 'progress' && s.data.phase === 'detect'), 5000,
      'detection progress on the page');

    const read = (await get(`/api/faces?folder=${S}`)).body;
    expect(read.counts.all).toBe(MEDIA);
    expect(Object.keys(read.counts.people).sort()).toEqual(['Alice', 'Bob']);
    expect(read).toMatchObject({ people: ['Alice', 'Bob'], provider: expect.any(String), summary: { errors: 0 } });
    const alice = (await get(`/api/faces/items?folder=${S}&filter=person:Alice&limit=500`)).body;
    expect(alice.total).toBe(read.counts.people.Alice);
    expect(new Set(alice.items.map((i: { kind: string }) => i.kind))).toEqual(new Set(['photo', 'video']));
    const photo = alice.items.find((i: { kind: string }) => i.kind === 'photo');
    const detail = (await get(`/api/faces/items/${photo.id}?folder=${S}`)).body;
    expect(detail.detections.length).toBe(photo.faces);
    expect(detail.width).toBeGreaterThan(0);
    expect(detail.detections.some((d: { person: string }) => d.person === 'Alice')).toBe(true);
    expect((await built.app.inject({ url: `/media/${photo.id}/thumb?v=${photo.revision}`, headers: auth() })).statusCode).toBe(200);
    expect((await get(`/api/faces/items?folder=${S}&filter=person:..%5Cx`)).status).toBe(400);

    const ppl = (await get(`/api/faces/people?dir=${P}`)).body;
    expect(ppl.people.map((p: { name: string }) => p.name)).toEqual(['Alice', 'Bob']);
    expect(ppl.people.every((p: { count: number; samples: unknown[] }) => p.count > 0 && p.samples.length > 0)).toBe(true);
    expect((await get('/api/faces/workers')).body).toMatchObject({ effective: ['local'], fixture: true });
    const checked = await post('/api/faces/check-workers', { workers: 'local:2,lan-box' });
    expect(checked.body).toMatchObject({ workers: [{ host: 'local', state: 'ready' }, { host: 'lan-box', state: 'skipped' }] });
  }, 300000);

  it('stops safely: every moved file is journaled and nothing is lost or half-moved', async () => {
    const slow = await startFakePair(150);
    const hub = new RecordingHub();
    const m = new JobManager({ dataDir: path.join(tmp, 'slow'), python: PY, photosortDir, configPath: writeConfig('slow.json', slow.port), hub });
    try {
      await m.init();
      const spec: JobSpec = { kind: 'sort', params: { action: 'move' }, folders: { source: lib }, args: ['sort', '--action=move', '--concurrency=2', '--', lib], heavy: true };
      const rec = m.submit(spec);
      await until(() => rec.done >= 4, 60000, 'some files to move');
      expect(m.cancel(rec.id).ok).toBe(true);
      expect(await m.waitFor(rec.id, 60000)).toBe(true);
      expect(rec.status).toBe('cancelled');
      expect(rec.done).toBeLessThan(MEDIA);
      const now = mediaByFolder(lib);
      expect(total(now)).toBe(MEDIA);
      const inBuckets = MEDIA - (now[''] ?? 0);
      const moved = journalLines(lib).filter((e) => e.run_id === rec.runId && e.dst);
      expect(moved).toHaveLength(inBuckets);
      for (const e of moved) expect(statSync(e.dst as string).isFile()).toBe(true);
      expect(hub.jobEvents(rec.id).some((e) => e.type === 'cancelling')).toBe(true);
    } finally {
      await m.close();
      slow.proc.kill();
    }
  }, 120000);
});
