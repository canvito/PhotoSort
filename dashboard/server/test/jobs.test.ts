import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { DirError, DirRegistry, pastedPathProblem } from '../src/dirs.ts';
import { cliText, JobManager, type JobRecord } from '../src/jobs.ts';
import { BadRequest, buildSpec, JOURNAL_NAME } from '../src/routes.ts';
import { FAKE_CLI, findPython, photosortDir, RecordingHub, until } from './helpers.ts';

const PY = findPython();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'psdash-jobs-'));
const lib = path.join(tmp, 'library');
const src = path.join(lib, 'camera roll');
mkdirSync(path.join(src, 'trip'), { recursive: true });
writeFileSync(path.join(src, 'a.jpg'), 'x');
writeFileSync(path.join(src, 'b.MOV'), 'x');
writeFileSync(path.join(src, 'notes.txt'), 'x');
writeFileSync(path.join(src, 'trip', 'c.heic'), 'x');
mkdirSync(path.join(lib, 'sorted'));
const configPath = path.join(tmp, 'config.json');
writeFileSync(configPath, JSON.stringify({ base_url: 'http://127.0.0.1:9', model: 'm', embed_model: 'e' }));

const fixtureDirs = () => new DirRegistry({ fixtureRoots: [lib] });
let managerN = 0;
function manager(opts: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) {
  const hub = new RecordingHub();
  const m = new JobManager({
    dataDir: path.join(tmp, `data${managerN++}`), python: PY, photosortDir, configPath, hub, script: FAKE_CLI, ...opts,
  });
  return { m, hub };
}
const fake = (args: string[], heavy = true) => ({ kind: 'sort' as const, params: {}, folders: { source: src }, args, heavy });

describe('pasted folder paths', () => {
  it('accepts plain local drive paths', () => {
    for (const ok of ['C:\\Users\\me\\Pictures', 'D:\\Photos 2026\\Oct', '"C:\\Users\\me\\My Pictures"', 'e:/x/y']) {
      expect(pastedPathProblem(ok)).toBeUndefined();
    }
  });

  it('refuses UNC, device, relative, stream, traversal and reserved-name paths', () => {
    for (const bad of ['\\\\server\\share\\x', '//server/share', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', 'Pictures\\x', '\\x',
      'C:x', 'C:\\x\\file.jpg:secret', 'C:\\x\\..\\Windows', 'C:\\x\\.\\y', 'C:\\x\\CON', 'C:\\nul.txt\\y', 'C:\\COM1 \\y',
      'C:\\a|b', 'C:\\a?', 'C:\\a\u0001b', '   ']) {
      expect(pastedPathProblem(bad), bad).toBeTypeOf('string');
    }
  });
});

describe('folder registry', () => {
  it('in fixture mode only knows the fixture library', async () => {
    const dirs = fixtureDirs();
    const roots = await dirs.roots();
    expect(roots.map((r) => r.path)).toEqual([lib]);
    expect(() => dirs.idFor(tmp)).toThrow(DirError);
    expect(() => dirs.pathOf('d_' + 'A'.repeat(22))).toThrow(/Unknown folder/);
    await expect(dirs.resolve(tmp)).rejects.toMatchObject({ status: 403 });
    await expect(dirs.resolve('\\\\server\\share')).rejects.toMatchObject({ status: 400 });
  });

  it('lists subfolders with media counts, and gives stable opaque ids', async () => {
    const dirs = fixtureDirs();
    const root = (await dirs.roots())[0];
    const listing = await dirs.list(root.dirId);
    expect(listing.dirs.map((d) => d.name)).toEqual(['camera roll', 'sorted']);
    const cam = listing.dirs[0];
    expect(cam).toMatchObject({ media: 2, hasChildren: true });
    expect(cam.dirId).toMatch(/^d_[A-Za-z0-9_-]{22}$/);
    expect(cam.dirId).not.toContain('camera');
    expect(dirs.idFor(src)).toBe(cam.dirId);
    expect(fixtureDirs().idFor(src)).not.toBe(cam.dirId); // per-run secret
    const inner = await dirs.list(cam.dirId);
    expect(inner.media).toBe(2);
    expect(inner.parent?.path).toBe(lib);
    expect((await dirs.list(inner.dirs[0].dirId)).parent?.path).toBe(src);
  });

  it('refuses system, whole-drive, home and its own folders as job folders (real mode)', () => {
    const own = path.join(tmp, 'own');
    const env = { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\x\\Roaming' };
    const dirs = new DirRegistry({ protectedDirs: [own], env });
    for (const bad of ['C:\\', 'D:\\', os.homedir(), 'C:\\Windows\\System32', 'c:\\program files\\x', path.join(os.homedir(), 'AppData', 'Local', 'x'),
      own, path.join(own, 'jobs'), tmp]) {
      expect(dirs.jobFolderProblem(bad), bad).toBeTypeOf('string');
    }
    expect(dirs.jobFolderProblem(path.join(os.homedir(), 'Pictures', '2026'))).toBeUndefined();
    expect(dirs.jobFolderProblem('D:\\Photos')).toBeUndefined();
    expect(dirs.allowed('\\\\server\\share\\x')).toBe(false);
  });
});

describe('job arguments', () => {
  const dirs = fixtureDirs();
  const { m: jobs } = manager();
  const S = dirs.idFor(src);
  const D = dirs.idFor(path.join(lib, 'sorted'));

  it('builds sort arguments with values attached and folders after "--"', () => {
    const s = buildSpec('sort', { source: S, dest: D, action: 'report', limit: 0, concurrency: 4, recursive: true }, dirs, jobs);
    expect(s.args).toEqual(['sort', '--action=report', '--recursive', '--concurrency=4', `--dest=${path.join(lib, 'sorted')}`, '--', src]);
    expect(s.heavy).toBe(true);
    expect(s.folders).toEqual({ source: src, dest: path.join(lib, 'sorted') });
    expect(s.params).not.toHaveProperty('source');
  });

  it('never lets request text or a name be read as an option', () => {
    const s = buildSpec('group', { source: S, request: '  -birthday --force ', action: 'move', name: '-x', from: '2026-10-01', to: '2026-10-08', media: 'both' }, dirs, jobs);
    expect(s.args).toEqual(['group', '--action=move', '--name=-x', '--from=2026-10-01', '--to=2026-10-08', '--media=both', '--', src, '-birthday --force']);
    expect(s.args.filter((a) => a === '--force')).toEqual([]);
  });

  it('refuses cloud models, impossible dates and bad ranges', () => {
    const g = { source: S, request: 'birthday', action: 'report' };
    expect(() => buildSpec('sort', { source: S, action: 'report', model: 'gpt-oss:120b-cloud' }, dirs, jobs)).toThrow(/cloud model/);
    expect(() => buildSpec('group', { ...g, model: 'glm-4.6:cloud' }, dirs, jobs)).toThrow(BadRequest);
    expect(() => buildSpec('group', { ...g, from: '2026-02-30' }, dirs, jobs)).toThrow(/not a real date/);
    expect(() => buildSpec('group', { ...g, to: '2026-10-01' }, dirs, jobs)).toThrow(/needs a "From"/);
    expect(() => buildSpec('group', { ...g, from: '2026-10-09', to: '2026-10-01' }, dirs, jobs)).toThrow(/after/);
    expect(() => buildSpec('group', { ...g, request: '   ' }, dirs, jobs)).toThrow(/Describe/);
    expect(() => buildSpec('group', { ...g, name: '..' }, dirs, jobs)).toThrow(/folder name/);
  });

  it('undo and apply need a journal; an undo preview is light', () => {
    const sorted = path.join(lib, 'sorted');
    expect(() => buildSpec('undo', { folder: D }, dirs, jobs)).toThrow(/no PhotoSort journal/);
    expect(() => buildSpec('undo', { folder: D, job: 'j_20261110120000_abcdef12' }, dirs, jobs)).toThrow(/either/);
    expect(() => buildSpec('undo', { job: 'j_20261110120000_abcdef12' }, dirs, jobs)).toThrow(BadRequest);
    writeFileSync(path.join(sorted, JOURNAL_NAME), '');
    const dry = buildSpec('undo', { folder: D, dryRun: true, runId: '20261110-120000-abcdef' }, dirs, jobs);
    expect(dry.args).toEqual(['undo', '--run-id=20261110-120000-abcdef', '--dry-run', '--', path.join(sorted, JOURNAL_NAME)]);
    expect(dry.heavy).toBe(false);
    expect(buildSpec('undo', { folder: D }, dirs, jobs).heavy).toBe(true);
    expect(buildSpec('apply', { folder: D }, dirs, jobs).args).toEqual(['apply', '--action=move', '--', path.join(sorted, JOURNAL_NAME)]);
  });

  it('shows the same command as PowerShell text', () => {
    const def = path.join(photosortDir, 'config.json');
    expect(cliText(['group', '--name=it\'s', '--name=-x', '--', 'C:\\a b', '-x'], def, def))
      .toBe(".\\photosort.cmd group --name 'it''s' --name=-x -- 'C:\\a b' -x");
    expect(cliText(['index', '--', 'C:\\p'], 'C:\\c.json', def)).toBe(".\\photosort.cmd --config C:\\c.json index C:\\p");
  });
});

describe('job runner', () => {
  it('runs a job, tallies its events and keeps the result', async () => {
    const { m, hub } = manager();
    await m.init();
    const rec = m.submit(fake(['sort', '--items=5', '--delay=0.01']));
    expect(await m.waitFor(rec.id, 15000)).toBe(true);
    expect(rec).toMatchObject({ status: 'errors', exitCode: 1, done: 5, total: 5, errors: 1, counts: { food: 2, people: 2 },
      runId: '20261110-120000-abcdef', report: 'REPORT TEXT', summary: { done: 5 } });
    expect(rec.messages.map((x) => x.text)).toContain('one file was unreadable');
    expect(rec.durationS).toBeGreaterThanOrEqual(0);
    const types = hub.jobEvents(rec.id).map((e) => e.type);
    expect(types[0]).toBe('queued');
    expect(types).toEqual(expect.arrayContaining(['started', 'phase', 'items', 'warning', 'finished']));
    expect(types.at(-1)).toBe('finished');
    const fin = hub.jobEvents(rec.id).at(-1)!;
    expect(fin).toMatchObject({ runId: '20261110-120000-abcdef', summary: { done: 5 } });
    expect(fin).not.toHaveProperty('report');
    const sentItems = hub.jobEvents(rec.id).filter((e) => e.type === 'items').flatMap((e) => e.items as unknown[]);
    expect(sentItems).toHaveLength(5);
    const saved = JSON.parse(readFileSync(path.join(m.jobDir(rec.id), 'job.json'), 'utf8')) as JobRecord;
    expect(saved.status).toBe('errors');
    expect(saved.argv).toContain('--events');
    const out = JSON.parse(readFileSync(path.join(m.jobDir(rec.id), 'stdout.txt'), 'utf8')) as { argv: string[] };
    expect(out.argv).toEqual(['sort', '--items=5', '--delay=0.01']);

    const page1 = await m.items(rec.id, 0, 2);
    expect(page1.items.map((i) => i.name)).toEqual(['img1.jpg', 'img2.jpg']);
    expect(page1.more).toBe(true);
    const page2 = await m.items(rec.id, page1.next, 100);
    expect(page2.items.map((i) => i.n)).toEqual([3, 4, 5]);
    expect(page2.items[0].error).toBe('unreadable');
    expect(page2.more).toBe(false);
    const newest = await m.items(rec.id, 0, 2, true);
    expect(newest.items.map((i) => i.n)).toEqual([4, 5]);
    expect(newest.older).toBe(3);
    await m.close();
  });

  it('runs one heavy job at a time; a light job does not wait', async () => {
    const { m } = manager();
    await m.init();
    const a = m.submit(fake(['sort', '--items=20', '--delay=0.03']));
    const b = m.submit(fake(['sort', '--items=1']));
    expect(b.status).toBe('queued');
    expect(m.position(b.id)).toBe(1);
    const light = m.submit(fake(['undo', '--items=1'], false));
    await m.waitFor(light.id, 15000);
    expect(light.status).toBe('ok');
    expect(a.status).toBe('running');
    expect(b.status).toBe('queued');
    await m.waitFor(a.id, 15000);
    await until(() => b.status !== 'queued', 5000, 'b to start');
    await m.waitFor(b.id, 15000);
    expect(b.status).toBe('ok');
    expect(Date.parse(b.startedAt!)).toBeGreaterThanOrEqual(Date.parse(a.finishedAt!) - 50);
    await m.close();
  });

  it('removes a queued job, cancels a running one safely, and forces only after the grace period', async () => {
    const { m } = manager();
    await m.init();
    const a = m.submit(fake(['sort', '--items=400', '--delay=0.02']));
    const b = m.submit(fake(['sort', '--items=1']));
    expect(m.remove(b.id)).toBe(true);
    expect(b.status).toBe('removed');
    await until(() => a.done >= 2, 10000, 'progress');
    expect(m.cancel(a.id).ok).toBe(true);
    expect(a.status).toBe('cancelling');
    expect(existsSync(path.join(m.jobDir(a.id), 'cancel'))).toBe(true);
    await m.waitFor(a.id, 10000);
    expect(a).toMatchObject({ status: 'cancelled', exitCode: 130 });
    expect(a.done).toBeLessThan(400);

    const stubborn = m.submit(fake(['sort', '--items=2000', '--delay=0.02', '--ignore-cancel']));
    await until(() => stubborn.done >= 1, 10000, 'progress');
    expect(m.cancel(stubborn.id, true)).toMatchObject({ ok: false, retryAfterS: 10 });
    m.cancel(stubborn.id);
    const early = m.cancel(stubborn.id, true);
    expect(early.ok).toBe(false);
    expect(early.retryAfterS).toBeGreaterThan(0);
    stubborn.cancelRequestedAt = new Date(Date.now() - 11000).toISOString();
    expect(m.cancel(stubborn.id, true).ok).toBe(true);
    await m.waitFor(stubborn.id, 10000);
    expect(stubborn).toMatchObject({ status: 'cancelled', forced: true });
    expect(stubborn.messages.at(-1)?.text).toMatch(/Stopped by force/);
    await m.close();
  });

  it('shows why Python failed before it wrote any events', async () => {
    const { m } = manager();
    await m.init();
    const rec = m.submit(fake(['sort', '--crash']));
    await m.waitFor(rec.id, 15000);
    expect(rec).toMatchObject({ status: 'failed', exitCode: 2 });
    expect(rec.messages[0].text).toContain('ValueError: the fake crashed');
    const missing = manager({ python: path.join(tmp, 'no-python.exe') }).m;
    await missing.init();
    const r2 = missing.submit(fake(['sort']));
    await missing.waitFor(r2.id, 5000);
    expect(r2.status).toBe('failed');
    expect(r2.messages[0].text).toMatch(/could not start/);
    await m.close();
    await missing.close();
  });

  it('reattaches to a job that kept running while the dashboard was stopped', async () => {
    const dataDir = path.join(tmp, 'reattach');
    const first = manager({ dataDir }).m;
    await first.init();
    const rec = first.submit(fake(['sort', '--items=40', '--delay=0.03']));
    const other = first.submit(fake(['index', '--items=1'], false));
    const queued = first.submit(fake(['sort', '--items=1']));
    await until(() => rec.done >= 2, 10000, 'progress');
    await first.waitFor(other.id, 10000);
    await first.close();

    const { m: second, hub } = manager({ dataDir, isOurProcess: async () => true });
    await second.init();
    const again = second.get(rec.id)!;
    expect(again.status).toBe('running');
    expect(again.done).toBeGreaterThanOrEqual(2);
    expect(second.get(queued.id)?.status).toBe('removed');
    expect(second.get(other.id)?.status).toBe('ok');
    await second.waitFor(rec.id, 15000);
    expect(again).toMatchObject({ status: 'errors', done: 40, report: 'REPORT TEXT' });
    expect(hub.jobEvents(rec.id).at(-1)?.type).toBe('finished');
    await second.close();
  });

  it('marks a job interrupted when its process is gone or is not ours', async () => {
    const dataDir = path.join(tmp, 'gone');
    const first = manager({ dataDir }).m;
    await first.init();
    const rec = first.submit(fake(['sort', '--items=30', '--delay=0.03']));
    await until(() => rec.done >= 1, 10000, 'progress');
    await first.close();
    const second = manager({ dataDir, isOurProcess: async () => false }).m;
    await second.init();
    expect(second.get(rec.id)).toMatchObject({ status: 'interrupted' });
    expect(second.get(rec.id)?.note).toMatch(/not running/);
    await second.close();
    process.kill(rec.pid!);
  });
});

describe('job and folder routes', () => {
  const PORT = 47991;
  const HOST = `127.0.0.1:${PORT}`;
  const TOKEN = 'z'.repeat(43);
  const auth = { host: HOST, 'x-photosort-token': TOKEN };
  let built: App;
  let shutdown: string | undefined;
  const inject = (o: InjectOptions) => built.app.inject(o);
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
    inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

  beforeAll(async () => {
    built = await buildApp({
      port: PORT, token: TOKEN, mode: 'fixture', version: 't', configPath, dataDir: path.join(tmp, 'app'), python: PY,
      photosortDir, fixtureRoots: [lib], jobScript: FAKE_CLI, shutdownWaitMs: 10000, onShutdown: (j) => { shutdown = j; },
    });
  });
  afterAll(async () => {
    built.hub.close();
    await built.app.close();
  });

  it('browses only the fixture library and refuses outside paths', async () => {
    const roots = (await inject({ url: '/api/fs/roots', headers: auth })).json() as { roots: { dirId: string; path: string }[]; fixture: boolean };
    expect(roots.fixture).toBe(true);
    expect(roots.roots.map((r) => r.path)).toEqual([lib]);
    const listing = await inject({ url: `/api/fs/dirs?dir=${roots.roots[0].dirId}`, headers: auth });
    expect(listing.json().dirs.map((d: { name: string }) => d.name)).toEqual(['camera roll', 'sorted']);
    expect((await inject({ url: `/api/fs/dirs?dir=d_${'B'.repeat(22)}`, headers: auth })).statusCode).toBe(404);
    expect((await inject({ url: '/api/fs/dirs?dir=C:\\Windows', headers: auth })).statusCode).toBe(400);
    expect((await post('/api/fs/resolve', { path: os.homedir() })).statusCode).toBe(403);
    expect((await post('/api/fs/resolve', { path: '\\\\server\\share' })).statusCode).toBe(400);
    const ok = await post('/api/fs/resolve', { path: `"${src}"` });
    expect(ok.json().path).toBe(src);
    expect(ok.json().problem).toBeUndefined();
    expect((await post('/api/fs/resolve', { path: src }, { host: HOST })).statusCode).toBe(401);
  });

  it('validates job requests strictly', async () => {
    const S = built.dirs.idFor(src);
    const bad = [
      { kind: 'faces', params: { source: S } },
      { kind: 'sort', params: { source: S, action: 'report', shell: 'calc' } },
      { kind: 'sort', params: { source: src, action: 'report' } },
      { kind: 'sort', params: { source: S, action: 'delete' } },
      { kind: 'sort', params: { source: S, action: 'report', concurrency: 0 } },
      { kind: 'sort', params: { source: S, action: 'report', limit: '5' } },
      { kind: 'group', params: { source: S, action: 'report' } },
      { kind: 'group', params: { source: S, action: 'report', request: 'x', name: 'a\\b' } },
      { kind: 'undo', params: { runId: '../../x' } },
      { kind: 'sort', params: { source: S, action: 'report' }, extra: 1 },
    ];
    for (const b of bad) expect((await post('/api/jobs', b)).statusCode, JSON.stringify(b)).toBe(400);
    expect((await post('/api/jobs', { kind: 'sort', params: { source: `d_${'C'.repeat(22)}`, action: 'report' } })).statusCode).toBe(404);
    expect((await post('/api/jobs', { kind: 'sort', params: { source: S, action: 'report' } }, { host: HOST })).statusCode).toBe(401);
    expect((await post('/api/jobs', { kind: 'sort', params: { source: S, action: 'report' } }, { ...auth, origin: 'http://evil.example' })).statusCode).toBe(403);
  });

  it('previews the command for a job without starting it', async () => {
    const S = built.dirs.idFor(src);
    const before = built.jobs.list().length;
    const r = await post('/api/jobs/cli', { kind: 'group', params: { source: S, action: 'report', request: '-birthday party' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cli: `.\\photosort.cmd --config ${configPath} group --action report -- '${src}' '-birthday party'`, heavy: true });
    expect((await post('/api/jobs/cli', { kind: 'group', params: { source: S, action: 'report', request: 'x', from: '2026-02-30' } })).statusCode).toBe(400);
    expect((await post('/api/jobs/cli', { kind: 'sort', params: { source: S, action: 'report' } }, { host: HOST })).statusCode).toBe(401);
    expect(built.jobs.list()).toHaveLength(before);
  });

  it('runs a job end to end, refuses to stop while it runs, then cancels it and stops', async () => {
    const S = built.dirs.idFor(src);
    const r = await post('/api/jobs', { kind: 'sort', params: { source: S, action: 'report', limit: 400 } });
    expect(r.statusCode).toBe(202);
    const { jobId, job } = r.json() as { jobId: string; job: Record<string, unknown> };
    expect(job).not.toHaveProperty('argv');
    expect(job.cli).toBe(`.\\photosort.cmd --config ${configPath} sort --action report --limit 400 '${src}'`);
    expect((job.folders as Record<string, { dirId: string }>).source.dirId).toBe(S);
    // The fake treats this real sort as 5 quick items.
    await built.jobs.waitFor(jobId, 15000);
    const done = (await inject({ url: `/api/jobs/${jobId}`, headers: auth })).json();
    expect(done).toMatchObject({ status: 'errors', done: 5, report: 'REPORT TEXT' });
    expect(done.elapsedS).toBeGreaterThanOrEqual(0);
    const items = (await inject({ url: `/api/jobs/${jobId}/items?after=0&limit=3`, headers: auth })).json();
    expect(items.items).toHaveLength(3);
    expect(items.more).toBe(true);
    expect((await inject({ url: '/api/jobs/j_20990101000000_00000000', headers: auth })).statusCode).toBe(404);
    const listed = (await inject({ url: '/api/jobs', headers: auth })).json().jobs[0];
    expect(listed.id).toBe(jobId);
    expect(listed).not.toHaveProperty('report');

    const long = built.jobs.submit({ kind: 'sort', params: {}, folders: { source: src }, args: ['sort', '--items=2000', '--delay=0.02'], heavy: true });
    const waiting = built.jobs.submit({ kind: 'sort', params: {}, folders: { source: src }, args: ['sort', '--items=1'], heavy: true });
    await until(() => long.done >= 1, 10000, 'progress');
    expect((await inject({ method: 'DELETE', url: `/api/jobs/${long.id}`, headers: auth })).statusCode).toBe(409);
    const refused = await post('/api/shutdown', { job: 'refuse' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().job).toMatchObject({ kind: 'sort', total: 2000 });
    expect(shutdown).toBeUndefined();
    const force = await post(`/api/jobs/${long.id}/cancel`, { force: true });
    expect(force.statusCode).toBe(409);
    const stop = await post('/api/shutdown', { job: 'cancel' });
    expect(stop.json()).toMatchObject({ stopping: true, jobsFinished: true });
    expect(long.status).toBe('cancelled');
    expect(waiting.status).toBe('removed');
    await until(() => shutdown !== undefined, 2000, 'shutdown');
    expect(shutdown).toBe('cancel');
  });
});
