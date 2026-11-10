// The only module in the server that opens network connections. It mirrors local_only.require_loopback and
// allows just two read-only PAIR endpoints, so the server can never send anything off this PC.
import http from 'node:http';
import { isIP } from 'node:net';

export class LocalOnlyError extends Error {}

export const ALLOWED_PATHS: ReadonlySet<string> = new Set(['/api/tags', '/api/ps']);

export function requireLoopback(url: string): URL {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new LocalOnlyError(`refusing ${u.protocol} endpoint; only local http is allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' ||
    (isIP(host) === 4 && host.startsWith('127.'));
  if (!loopback) throw new LocalOnlyError(`refusing non-loopback endpoint ${u.host}; the dashboard only talks to this PC`);
  return u;
}

/** Ollama marks cloud models with a `cloud` / `*-cloud` tag, or remote_host / remote_model in /api/tags. */
export function isCloudModel(name: string, entry?: { remote_host?: unknown; remote_model?: unknown }): boolean {
  const tag = name.trim().toLowerCase().split(':').pop() ?? '';
  return tag === 'cloud' || tag.endsWith('-cloud') || Boolean(entry?.remote_host) || Boolean(entry?.remote_model);
}

export async function localGetJson(baseUrl: string, path: string, timeoutMs = 3000): Promise<unknown> {
  if (!ALLOWED_PATHS.has(path)) throw new LocalOnlyError(`path ${path} is not on the dashboard allowlist`);
  const u = requireLoopback(new URL(path, baseUrl).href);
  return new Promise((resolve, reject) => {
    // node:http has no proxy support, so HTTP(S)_PROXY settings cannot reroute this request.
    const req = http.get(u, { agent: false, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
