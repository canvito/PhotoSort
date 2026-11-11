// Settings: the config.json editor. A save is checked by PhotoSort's own Python rules (the CLI's, plus stricter ones
// for bucket names, which become folder names), shown as a list of changes first, then written atomically with a
// config.json.bak copy. The Python helper restarts afterwards so browsing and search use the new values.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isCloudModel, localGetJson, requireLoopback } from './localfetch.ts';
import type { Sidecar } from './sidecar.ts';

export interface ConfigChange {
  key: string;
  before?: string;
  after?: string;
}

export interface ModelInfo {
  name: string;
  cloud: boolean;
  size?: number;
  params?: string;
  family?: string;
}

interface TagEntry {
  name?: string;
  size?: number;
  remote_host?: unknown;
  remote_model?: unknown;
  details?: { family?: string; parameter_size?: string };
}

type Json = Record<string, unknown>;

const MODEL_KEYS = ['model', 'caption_model', 'embed_model'] as const;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const etagOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

function show(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ') : '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** What a save would change: one entry per top-level setting and per bucket, plus a reordering of buckets. */
export function diffConfig(before: Json, after: Json): ConfigChange[] {
  const out: ConfigChange[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k !== 'buckets' && JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push({ key: k, before: show(before[k]), after: show(after[k]) });
  }
  const b = isRecord(before.buckets) ? before.buckets : {};
  const a = isRecord(after.buckets) ? after.buckets : {};
  for (const n of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (JSON.stringify(b[n]) !== JSON.stringify(a[n])) out.push({ key: `buckets.${n}`, before: show(b[n]), after: show(a[n]) });
  }
  const kept = (x: Json, y: Json) => Object.keys(x).filter((n) => n in y).join(', ');
  if (kept(b, a) !== kept(a, b)) out.push({ key: 'bucket order', before: kept(b, a), after: kept(a, b) });
  return out;
}

/** JSON with two-space indents and short lists of plain values on one line, like the hand-written config.json. */
export function formatConfig(v: unknown, indent = ''): string {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    const inner = indent + '  ';
    return `[\n${v.map((x) => inner + formatConfig(x, inner)).join(',\n')}\n${indent}]`;
  }
  if (isRecord(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return '{}';
    const inner = indent + '  ';
    return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${formatConfig(x, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

/** Runs `dashboard_sidecar.py --check-config`: a short-lived Python that needs neither the index nor PAIR. */
export function checkInPython(python: string, photosortDir: string, cfg: Json): Promise<{ errors: string[]; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [path.join(photosortDir, 'dashboard_sidecar.py'), '--check-config'], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONUTF8: '1' },
    });
    let out = '';
    const timer = setTimeout(() => proc.kill(), 60_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => { out += c; });
    proc.stdin.on('error', () => undefined);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out) as { errors?: unknown; warnings?: unknown };
        if (code === 0 && Array.isArray(r.errors) && Array.isArray(r.warnings)) {
          return resolve({ errors: r.errors.map(String), warnings: r.warnings.map(String) });
        }
      } catch { /* reported below */ }
      reject(new Error('PhotoSort could not check the config (its Python did not answer).'));
    });
    proc.stdin.end(JSON.stringify(cfg));
  });
}

/** The models PAIR offers now, each marked cloud or local. Names only: nothing about photos. */
async function pairModels(baseUrl: unknown): Promise<{ reachable: boolean; models: ModelInfo[]; entries: Map<string, TagEntry> }> {
  try {
    requireLoopback(String(baseUrl ?? ''));
    const tags = (await localGetJson(String(baseUrl), '/api/tags')) as { models?: TagEntry[] };
    const entries = new Map((tags.models ?? []).filter((m) => typeof m.name === 'string' && m.name).map((m) => [m.name!, m]));
    const models = [...entries].map(([name, m]) => ({
      name, cloud: isCloudModel(name, m), size: typeof m.size === 'number' ? m.size : undefined,
      params: m.details?.parameter_size, family: m.details?.family,
    })).sort((x, y) => Number(x.cloud) - Number(y.cloud) || x.name.localeCompare(y.name));
    return { reachable: true, models, entries };
  } catch {
    return { reachable: false, models: [], entries: new Map() };
  }
}

async function replaceFile(target: string, text: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      // An editor or a virus scanner can hold config.json open for a moment.
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

export interface SettingsOptions {
  configPath: string;
  python: string;
  photosortDir: string;
  fixture: boolean;
  sidecar: Sidecar;
}

export function registerSettingsRoutes(app: FastifyInstance, o: SettingsOptions): void {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  app.get('/api/config', { config: { auth: 'read' } }, async (_req, reply) => {
    let text: string;
    try {
      text = await readFile(o.configPath, 'utf8');
    } catch {
      return reply.code(500).send({ error: 'config.json could not be read.' });
    }
    let config: Json | null = null;
    let parseError: string | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) config = parsed;
      else parseError = 'config.json must hold a JSON object.';
    } catch (e) {
      parseError = `config.json is not valid JSON: ${(e as Error).message}`;
    }
    const pair = await pairModels(config?.base_url);
    return {
      config, parseError, etag: etagOf(text), file: path.basename(o.configPath), fixture: o.fixture,
      pairReachable: pair.reachable, models: pair.models,
    };
  });

  app.put<{ Body: { config: Json; etag: string; save?: boolean } }>('/api/config', {
    config: { auth: 'mutate' },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['config', 'etag'],
        properties: { config: { type: 'object' }, etag: { type: 'string', pattern: '^[a-f0-9]{32}$' }, save: { type: 'boolean' } },
      },
    },
  }, (req, reply) => serial(async () => {
    const { config, etag, save } = req.body;
    const text = await readFile(o.configPath, 'utf8');
    if (etagOf(text) !== etag) {
      return reply.code(409).send({ error: 'config.json changed since this page loaded it. Reload to see the current values.' });
    }
    let current: Json = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) current = parsed;
    } catch { /* a broken file is replaced by a checked one */ }
    let checked: { errors: string[]; warnings: string[] };
    try {
      checked = await checkInPython(o.python, o.photosortDir, config);
    } catch (e) {
      return reply.code(503).send({ error: (e as Error).message });
    }
    const errors = [...checked.errors];
    const warnings = [...checked.warnings];
    if (o.fixture) {
      for (const k of ['base_url', 'index_path']) {
        if (JSON.stringify(config[k]) !== JSON.stringify(current[k])) errors.push(`Fixture mode keeps ${k} as it is (it points at the fixture library).`);
      }
    }
    const pair = await pairModels(config.base_url);
    if (pair.reachable) {
      for (const k of MODEL_KEYS) {
        const name = config[k];
        if (typeof name !== 'string' || !name) continue;
        const entry = pair.entries.get(name);
        if (!entry) warnings.push(`${k}: ${name} is not in the PAIR cluster right now.`);
        else if (isCloudModel(name, entry) && !checked.errors.some((e) => e.includes(name))) {
          errors.push(`${k}: ${name} runs in the cloud. Photos and anything made from them only go to your own machines.`);
        }
      }
    } else {
      warnings.push('PAIR is not reachable, so the models could not be checked against the cluster.');
    }
    const changes = diffConfig(current, config);
    const changed = new Set(changes.map((c) => c.key));
    if (changed.has('embed_model')) {
      warnings.push('With a new embed_model, search only finds files indexed with it. Run Index on your folders again; it redoes every file.');
    }
    if (changed.has('caption_model')) warnings.push('With a new caption_model, the next Index run describes every file again.');
    if (changed.has('index_path')) warnings.push('Search and Index switch to the index at the new path; the old index file stays where it is.');
    const ok = errors.length === 0;
    if (!save || !ok || !changes.length) return { ok, errors, warnings, changes, saved: false, etag };
    const next = formatConfig(config) + '\n';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    await copyFile(o.configPath, `${o.configPath}.bak`);
    await replaceFile(o.configPath, eol === '\n' ? next : next.replaceAll('\n', eol));
    await o.sidecar.restart();
    return { ok, errors, warnings, changes, saved: true, etag: etagOf(await readFile(o.configPath, 'utf8')) };
  }));
}
