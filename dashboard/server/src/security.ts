// Request guards for the dashboard server. The server only ever listens on 127.0.0.1, and every request must
// also pass these checks, so a web page in another browser, another device or another local origin cannot
// read or change anything (DNS rebinding, CSRF, cross-origin reads).
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type AuthClass = 'public' | 'read' | 'mutate';

export const TOKEN_HEADER = 'x-photosort-token';

export interface SecurityOptions {
  port: number;
  token: string;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=()',
  'x-frame-options': 'DENY',
};

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function ownOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(reply: FastifyReply, code: number, error: string): FastifyReply {
  return reply.code(code).header('cache-control', 'no-store').send({ error });
}

/** Every route must declare `config.auth`; registering one without it fails at startup (and in tests). */
export function requireAuthClass(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const auth = (route.config as { auth?: AuthClass } | undefined)?.auth;
    if (auth !== 'public' && auth !== 'read' && auth !== 'mutate') {
      throw new Error(`route ${String(route.method)} ${route.url} has no auth class`);
    }
  });
}

export function installSecurity(app: FastifyInstance, opts: SecurityOptions): void {
  const hosts = allowedHosts(opts.port);
  const origin = ownOrigin(opts.port);
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return deny(reply, 403, 'loopback only');
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return deny(reply, 421, 'unexpected host');
    const auth = (req.routeOptions.config as { auth?: AuthClass } | undefined)?.auth ?? 'read';
    if (auth === 'public') return;
    if (!tokenMatches(opts.token, req.headers[TOKEN_HEADER])) return deny(reply, 401, 'missing or wrong token');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return deny(reply, 403, 'cross-site request');
    if (auth === 'mutate') {
      if (req.method === 'GET' || req.method === 'HEAD') return deny(reply, 405, 'mutating route needs POST');
      const o = req.headers.origin;
      if (o !== undefined && o !== origin) return deny(reply, 403, 'cross-origin request');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith('/api/') || req.url === '/healthz') reply.header('cache-control', 'no-store');
    return payload;
  });
}
