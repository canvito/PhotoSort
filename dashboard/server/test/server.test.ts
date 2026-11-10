import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { isCloudModel, localGetJson, LocalOnlyError, requireLoopback } from '../src/localfetch.ts';
import { isUnderOneDrive } from '../src/paths.ts';
import { requireAuthClass } from '../src/security.ts';

const PORT = 47990;
const TOKEN = 'x'.repeat(43);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'psdash-test-'));
const configPath = path.join(tmp, 'config.json');
writeFileSync(configPath, JSON.stringify({ base_url: 'http://127.0.0.1:9', model: 'm', embed_model: 'e' }));
const dist = path.join(tmp, 'dist');
mkdirSync(path.join(dist, 'assets'), { recursive: true });
writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>spa</title>');
writeFileSync(path.join(dist, 'assets', 'app-1234.js'), 'console.log(1)');
writeFileSync(path.join(tmp, 'secret.txt'), 'top secret');

let built: App;
let shutdownJob: string | undefined;

beforeAll(async () => {
  built = await buildApp({
    port: PORT, token: TOKEN, mode: 'fixture', version: 't', configPath, webDist: dist,
    dataDir: path.join(tmp, 'data'), python: process.execPath, photosortDir: tmp, fixtureRoots: [path.join(tmp, 'library')],
    onShutdown: (job) => { shutdownJob = job; },
  });
});
afterAll(async () => {
  built.hub.close();
  await built.app.close();
});

const inject = (o: InjectOptions) => built.app.inject(o);
const auth = { host: HOST, 'x-photosort-token': TOKEN };

describe('host, address and token guards', () => {
  it('accepts its own host names and refuses others (DNS rebinding)', async () => {
    expect((await inject({ url: '/healthz', headers: { host: HOST } })).statusCode).toBe(200);
    expect((await inject({ url: '/healthz', headers: { host: `localhost:${PORT}` } })).statusCode).toBe(200);
    expect((await inject({ url: '/healthz', headers: { host: 'evil.example:47990' } })).statusCode).toBe(421);
    expect((await inject({ url: '/healthz', headers: { host: `127.0.0.1:${PORT + 1}` } })).statusCode).toBe(421);
  });

  it('refuses non-loopback peers even with a valid token', async () => {
    const r = await inject({ url: '/api/meta', headers: auth, remoteAddress: '192.168.0.5' });
    expect(r.statusCode).toBe(403);
  });

  it('needs the token for read routes', async () => {
    expect((await inject({ url: '/api/meta', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await inject({ url: '/api/meta', headers: { host: HOST, 'x-photosort-token': 'y'.repeat(43) } })).statusCode).toBe(401);
    expect((await inject({ url: '/api/meta', headers: { host: HOST, 'x-photosort-token': 'short' } })).statusCode).toBe(401);
    const ok = await inject({ url: '/api/meta', headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().mode).toBe('fixture');
  });

  it('refuses cross-site fetches', async () => {
    const r = await inject({ url: '/api/meta', headers: { ...auth, 'sec-fetch-site': 'cross-site' } });
    expect(r.statusCode).toBe(403);
  });

  it('treats unknown routes as read routes', async () => {
    expect((await inject({ method: 'POST', url: '/api/nope', headers: { host: HOST } })).statusCode).toBe(401);
  });
});

describe('mutating routes', () => {
  const post = (headers: Record<string, string>, payload: unknown = { job: 'refuse' }) =>
    inject({ method: 'POST', url: '/api/shutdown', headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });

  it('refuses a foreign Origin even with the token', async () => {
    expect((await post({ ...auth, origin: 'http://evil.example' })).statusCode).toBe(403);
    expect((await post({ ...auth, origin: `http://localhost:${PORT + 1}` })).statusCode).toBe(403);
  });

  it('refuses text/plain bodies (simple-request CSRF)', async () => {
    const r = await inject({ method: 'POST', url: '/api/shutdown', headers: { ...auth, 'content-type': 'text/plain' }, payload: '{}' });
    expect(r.statusCode).toBe(415);
  });

  it('refuses unknown body fields', async () => {
    expect((await post(auth, { job: 'refuse', extra: 1 })).statusCode).toBe(400);
    expect((await post(auth, { job: 'explode' })).statusCode).toBe(400);
  });

  it('runs with the token and its own Origin', async () => {
    const r = await post({ ...auth, origin: ORIGIN });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setImmediate(res));
    expect(shutdownJob).toBe('refuse');
  });

  it('every registered route declares an auth class', () => {
    const app = Fastify();
    requireAuthClass(app);
    expect(() => app.get('/x', async () => 1)).toThrow(/no auth class/);
  });
});

describe('response headers and static files', () => {
  it('sends a strict CSP and no-store on API routes, including errors', async () => {
    for (const r of [await inject({ url: '/healthz', headers: { host: HOST } }), await inject({ url: '/api/meta', headers: { host: HOST } })]) {
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });

  it('serves the SPA, hashed assets and never files outside dist', async () => {
    const page = await inject({ url: '/sort', headers: { host: HOST } });
    expect(page.body).toContain('<title>spa</title>');
    const asset = await inject({ url: '/assets/app-1234.js', headers: { host: HOST } });
    expect(asset.headers['cache-control']).toContain('immutable');
    for (const url of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await inject({ url, headers: { host: HOST } });
      expect(r.body).not.toContain('top secret');
    }
  });

  it('does not answer API paths with the SPA', async () => {
    const r = await inject({ url: '/api/does-not-exist', headers: auth });
    expect(r.statusCode).toBe(404);
  });
});

describe('server-sent events', () => {
  it('streams events and replays after Last-Event-ID', async () => {
    await built.app.listen({ host: '127.0.0.1', port: PORT });
    const first = built.hub.send('sys', { type: 'a' });
    built.hub.send('sys', { type: 'b' });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stream', headers: { ...auth, 'last-event-id': String(first) } }, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        let text = '';
        res.on('data', (c: Buffer) => {
          text += c.toString();
          if (text.includes('"type":"c"')) { req.destroy(); resolve(text); }
        });
        setTimeout(() => built.hub.send('sys', { type: 'c' }), 50);
      });
      req.on('error', reject);
    });
    expect(body).not.toContain('"type":"a"');
    expect(body).toContain('"type":"b"');
    expect(body).toContain('"type":"c"');
  });
});

describe('local-only outbound guard', () => {
  it('accepts loopback endpoints only', () => {
    for (const ok of ['http://127.0.0.1:11434', 'http://localhost:1', 'http://[::1]:1', 'http://127.5.5.5:2']) {
      expect(() => requireLoopback(ok)).not.toThrow();
    }
    for (const bad of ['http://192.168.0.2:11434', 'http://example.com', 'https://127.0.0.1:1', 'http://127.0.0.1.evil.example', 'http://10.0.0.1']) {
      expect(() => requireLoopback(bad)).toThrow(LocalOnlyError);
    }
  });

  it('allows only read-only PAIR paths', async () => {
    await expect(localGetJson('http://127.0.0.1:9', '/api/chat')).rejects.toThrow(LocalOnlyError);
    await expect(localGetJson('http://127.0.0.1:9', '/api/embed')).rejects.toThrow(LocalOnlyError);
  });

  it('flags Ollama cloud models like local_only.is_cloud_model', () => {
    expect(isCloudModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isCloudModel('glm-4.6:cloud')).toBe(true);
    expect(isCloudModel('gemma4:12b')).toBe(false);
    expect(isCloudModel('gemma4:12b', { remote_host: 'https://ollama.com' })).toBe(true);
  });

  it('only localfetch.ts opens network connections', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const network = /\b(fetch\(|https?\.(get|request)\(|net\.connect|tls\.connect|dgram|WebSocket|undici|XMLHttpRequest)/;
    const offenders = readdirSync(src).filter((f) => f !== 'localfetch.ts' && network.test(readFileSync(path.join(src, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  it.skipIf(!existsSync(webDist))('the built web app references no outside URLs', () => {
    // XML namespaces are names, not requests; React's error-page link is a string it never fetches.
    const allowed = [/^http:\/\/www\.w3\.org\//, /^https:\/\/react\.dev\/errors\//];
    const files = readdirSync(webDist, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(js|css|html)$/.test(f));
    const found = files.flatMap((f) => readFileSync(path.join(webDist, f), 'utf8').match(/\b(?:https?|wss?):\/\/[^\s"'`)<>\\]+/g) ?? []);
    expect(files.length).toBeGreaterThan(0);
    expect([...new Set(found.filter((u) => !allowed.some((a) => a.test(u))))]).toEqual([]);
  });
});

describe('OneDrive guard', () => {
  it('detects folders inside OneDrive', () => {
    const env = { OneDrive: 'C:\\Users\\u\\OneDrive' };
    expect(isUnderOneDrive('C:\\Users\\u\\OneDrive\\x', env)).toBe(true);
    expect(isUnderOneDrive('c:\\users\\u\\onedrive', env)).toBe(true);
    expect(isUnderOneDrive('C:\\Users\\u\\OneDriveOther\\x', env)).toBe(false);
    expect(isUnderOneDrive('C:\\Users\\u\\AppData\\Local\\PhotoSort', env)).toBe(false);
  });
});
