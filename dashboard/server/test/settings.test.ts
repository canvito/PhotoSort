import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { diffConfig, formatConfig } from '../src/settings.ts';
import { findPython, photosortDir } from './helpers.ts';

const PORT = 47994;
const TOKEN = 's'.repeat(43);
const auth = { host: `127.0.0.1:${PORT}`, 'x-photosort-token': TOKEN };
const tmp = mkdtempSync(path.join(os.tmpdir(), 'psdash-settings-'));
const configPath = path.join(tmp, 'config.json');

type Check = { ok: boolean; errors: string[]; warnings: string[]; changes: { key: string; before?: string; after?: string }[];
  saved: boolean; etag: string };

describe('settings', () => {
  let built: App;
  let pair: http.Server;
  let base: Record<string, unknown>;

  beforeAll(async () => {
    pair = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/tags' ? { models: [
        { name: 'gemma4:12b', size: 8e9, details: { family: 'gemma3', parameter_size: '12B' } },
        { name: 'qwen3-embedding:8b', size: 4e9 },
        { name: 'qwen2.5vl:7b', size: 5e9 },
        { name: 'gpt-oss:120b-cloud' },
        { name: 'kimi:latest', remote_host: 'https://ollama.com' },
      ] } : {}));
    });
    await new Promise<void>((r) => pair.listen(0, '127.0.0.1', r));
    base = JSON.parse(readFileSync(path.join(photosortDir, 'dashboard', 'fixtures', 'config.fixture.json'), 'utf8'));
    base.base_url = `http://127.0.0.1:${(pair.address() as AddressInfo).port}`;
    base.index_path = path.join(tmp, 'index.sqlite');
    writeFileSync(configPath, JSON.stringify(base, null, 2).replaceAll('\n', '\r\n') + '\r\n');
    built = await buildApp({
      port: PORT, token: TOKEN, mode: 'real', version: 't', configPath, dataDir: path.join(tmp, 'data'),
      python: findPython(), photosortDir, pairDir: path.join(tmp, 'pair'),
    });
  });
  afterAll(async () => {
    built.hub.close();
    await built.app.close();
    pair.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = async () => {
    const r = await built.app.inject({ url: '/api/config', headers: auth });
    expect(r.statusCode).toBe(200);
    return r.json() as { config: Record<string, unknown>; etag: string; pairReachable: boolean; models: { name: string; cloud: boolean }[] };
  };
  const put = (config: object, etag: string, save = false) =>
    built.app.inject({ method: 'PUT', url: '/api/config', headers: auth, payload: { config, etag, save } });

  it('shows the config and the models PAIR offers, cloud ones marked', async () => {
    const g = await get();
    expect(g.config).toEqual(base);
    expect(g.pairReachable).toBe(true);
    const cloud = Object.fromEntries(g.models.map((m) => [m.name, m.cloud]));
    expect(cloud).toMatchObject({ 'gemma4:12b': false, 'qwen2.5vl:7b': false, 'gpt-oss:120b-cloud': true, 'kimi:latest': true });
    expect(g.models.at(-1)?.cloud).toBe(true);
  });

  it('checks a change without saving and lists what it would change', async () => {
    const { etag } = await get();
    const buckets = { pets: 'Photos of pets.', ...(base.buckets as object) };
    const r = await put({ ...base, model: 'qwen2.5vl:7b', concurrency: 8, buckets }, etag);
    expect(r.statusCode).toBe(200);
    const c = r.json() as Check;
    expect(c).toMatchObject({ ok: true, errors: [], saved: false });
    expect(c.changes).toEqual([
      { key: 'model', before: 'gemma4:12b', after: 'qwen2.5vl:7b' },
      { key: 'concurrency', before: '4', after: '8' },
      { key: 'buckets.pets', after: 'Photos of pets.' },
    ]);
    expect(readFileSync(configPath, 'utf8')).toContain('"model": "gemma4:12b"');
  });

  it('refuses cloud models, bad values and models PAIR does not have', async () => {
    const { etag } = await get();
    const buckets = { ...(base.buckets as object), 'Bad Name': 'x', con: 'y' };
    const r = await put({ ...base, model: 'kimi:latest', caption_model: 'gpt-oss:120b-cloud', embed_model: 'nope:1b', concurrency: 0,
      index_path: path.join(os.homedir(), 'OneDrive', 'index.sqlite'), buckets }, etag, true);
    const c = r.json() as Check;
    expect(c.ok).toBe(false);
    expect(c.saved).toBe(false);
    const all = c.errors.join('\n');
    for (const bit of ['kimi:latest', 'gpt-oss:120b-cloud', 'concurrency', 'OneDrive', 'Bad Name', 'con']) expect(all).toContain(bit);
    expect(c.warnings.join('\n')).toContain('nope:1b');
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('saves atomically with a backup, keeps CRLF, and refuses a stale page', async () => {
    const before = readFileSync(configPath, 'utf8');
    const { etag } = await get();
    const next = { ...base, concurrency: 6, face_workers: ['gpu-a:8', 'gpu-b'] };
    const r = await put(next, etag, true);
    const c = r.json() as Check;
    expect(c).toMatchObject({ ok: true, saved: true });
    expect(c.etag).not.toBe(etag);
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe(before);
    const text = readFileSync(configPath, 'utf8');
    expect(JSON.parse(text)).toEqual(next);
    expect(text).toContain('"face_workers": ["gpu-a:8", "gpu-b"],\r\n');
    expect(text.replaceAll('\r\n', '')).not.toContain('\n');
    expect((await get()).etag).toBe(c.etag);

    const stale = await put({ ...next, concurrency: 7 }, etag, true);
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).concurrency).toBe(6);
  });

  it('needs the token, and a body with only config, etag and save', async () => {
    const { etag } = await get();
    expect((await built.app.inject({ method: 'PUT', url: '/api/config', headers: { host: auth.host }, payload: { config: base, etag } }))
      .statusCode).toBe(401);
    expect((await built.app.inject({ method: 'PUT', url: '/api/config', headers: auth, payload: { config: base, etag, extra: 1 } }))
      .statusCode).toBe(400);
  });
});

describe('config helpers', () => {
  it('formats like the hand-written file and diffs bucket order', () => {
    expect(formatConfig({ a: [1, 'x'], b: { c: [] }, d: [{ e: 1 }] })).toBe(
      '{\n  "a": [1, "x"],\n  "b": {\n    "c": []\n  },\n  "d": [\n    {\n      "e": 1\n    }\n  ]\n}');
    expect(diffConfig({ buckets: { a: '1', b: '2' } }, { buckets: { b: '2', a: '1' } }))
      .toEqual([{ key: 'bucket order', before: 'a, b', after: 'b, a' }]);
  });
});
