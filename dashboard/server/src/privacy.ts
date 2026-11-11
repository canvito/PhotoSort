// The Privacy page's live checks: a checklist of the settings that keep media on this PC and the PAIR LAN, and a
// snapshot of the TCP connections the dashboard's own processes have open right now.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readConfig } from './health.ts';
import type { JobManager } from './jobs.ts';
import { isCloudModel, localGetJson, LocalOnlyError, requireLoopback } from './localfetch.ts';
import { addressClass } from './pairlog.ts';
import type { PairLog } from './pairlog.ts';
import { isUnderOneDrive } from './paths.ts';
import type { Sidecar } from './sidecar.ts';

export type CheckStatus = 'ok' | 'warn' | 'bad' | 'unknown';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** %VAR% expansion like Python's os.path.expandvars on Windows (unknown names stay as they are). */
export function expandWinVars(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(/%([^%]+)%/g, (m, name: string) => {
    const hit = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return hit ? env[hit] ?? m : m;
  });
}

async function allowlistSelfTest(base: string): Promise<boolean> {
  const refused = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return false;
    } catch (e) {
      return e instanceof LocalOnlyError;
    }
  };
  // Documentation-range address (never routed) and a path that is not on the allowlist: both must be refused
  // before any connection is attempted.
  const [remote, chat] = await Promise.all([
    refused(() => localGetJson('http://192.0.2.1:11434', '/api/tags', 500)),
    refused(() => localGetJson(base, '/api/chat', 500)),
  ]);
  return remote && chat;
}

export async function privacyChecklist(opts: { configPath: string; dataDir: string; pair: PairLog; env?: NodeJS.ProcessEnv }): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const checks: Check[] = [];
  let cfg: Record<string, unknown> = {};
  try {
    cfg = await readConfig(opts.configPath);
  } catch {
    checks.push({ id: 'config', label: 'Settings file', status: 'bad', detail: 'config.json could not be read.' });
  }
  const base = String(cfg.base_url ?? '');
  let loopback = false;
  try {
    requireLoopback(base);
    loopback = true;
  } catch {
    /* reported below */
  }
  checks.push({
    id: 'base_url', label: 'Models are reached through PAIR on this PC', status: loopback ? 'ok' : 'bad',
    detail: loopback ? `base_url is ${base} (loopback; PAIR forwards to your LAN nodes).` : `base_url "${base}" is not a loopback address.`,
  });

  let tags: { name?: string; remote_host?: unknown; remote_model?: unknown }[] | undefined;
  if (loopback) {
    try {
      tags = ((await localGetJson(base, '/api/tags', 2000)) as { models?: typeof tags }).models ?? [];
    } catch {
      tags = undefined;
    }
  }
  const byName = new Map((tags ?? []).map((m) => [String(m.name ?? ''), m]));
  const roles: [string, unknown][] = [['sort', cfg.model], ['caption', cfg.caption_model ?? cfg.model], ['embed', cfg.embed_model]];
  const cloudUsed = roles.filter(([, m]) => typeof m === 'string' && isCloudModel(m, byName.get(m)));
  checks.push({
    id: 'models', label: 'Configured models are local', status: cloudUsed.length ? 'bad' : 'ok',
    detail: cloudUsed.length
      ? `Cloud model configured for ${cloudUsed.map(([r]) => r).join(', ')}; PhotoSort refuses to use it.`
      : `${[...new Set(roles.map(([, m]) => m).filter(Boolean))].join(', ')}: none are Ollama cloud models.`,
  });
  const listed = [...byName].filter(([n, e]) => isCloudModel(n, e)).length;
  checks.push({
    id: 'cloud_listed', label: 'Cloud models listed by PAIR', status: tags === undefined ? 'unknown' : listed ? 'warn' : 'ok',
    detail: tags === undefined ? 'PAIR did not answer; the list could not be checked.'
      : listed ? `${listed} cloud model(s) are listed. PhotoSort never uses them (it refuses cloud models), but other apps could.`
        : 'No cloud models are listed.',
  });
  checks.push({
    id: 'proxies', label: 'System proxies are ignored', status: 'ok',
    detail: 'The CLI sets trust_env=False and the dashboard server uses node:http without proxy support, so no proxy can reroute a request.',
  });
  const selfTest = await allowlistSelfTest(loopback ? base : 'http://127.0.0.1:9');
  checks.push({
    id: 'allowlist', label: 'Dashboard server can only reach PAIR read-only endpoints', status: selfTest ? 'ok' : 'bad',
    detail: selfTest ? 'Self-test: a LAN/internet address and a non-allowlisted path were both refused before connecting.'
      : 'Self-test failed: the outbound guard did not refuse a request it should have.',
  });

  const indexPath = expandWinVars(String(cfg.index_path || '%LOCALAPPDATA%\\PhotoSort\\search_index.sqlite'), env);
  const indexInOd = isUnderOneDrive(indexPath, env);
  checks.push({
    id: 'index', label: 'Search index stays out of OneDrive', status: indexInOd ? 'bad' : 'ok',
    detail: indexInOd ? 'The index (captions and embeddings) is inside OneDrive and would sync to the cloud.'
      : `The index is at ${path.dirname(indexPath)}, outside OneDrive.`,
  });
  const dataInOd = isUnderOneDrive(opts.dataDir, env);
  checks.push({
    id: 'data', label: 'Dashboard data (thumbnails, jobs, logs) stays out of OneDrive', status: dataInOd ? 'bad' : 'ok',
    detail: dataInOd ? 'The dashboard data folder is inside OneDrive.' : `Dashboard data is at ${opts.dataDir}.`,
  });

  await opts.pair.refresh(1000);
  await opts.pair.loadMembers();
  const audit = opts.pair.audit();
  if (!audit.found) {
    checks.push({ id: 'pair_audit', label: 'PAIR routed requests only to your LAN', status: 'unknown', detail: 'The PAIR log was not found on this PC.' });
  } else if (audit.format === 'unrecognized') {
    checks.push({ id: 'pair_audit', label: 'PAIR routed requests only to your LAN', status: 'unknown', detail: 'The PAIR log format was not recognized.' });
  } else {
    const c = audit.all.counts;
    const total = c.lan + c.cluster + c.blank + c.loopback + c.public;
    const thisPc = audit.recentAlerts.filter((a) => a.kind === 'this_pc').length;
    checks.push({
      id: 'pair_audit', label: 'PAIR routed requests only to your LAN',
      status: c.public ? 'bad' : thisPc ? 'warn' : 'ok',
      detail: c.public ? `${c.public} of ${total} logged requests went to a non-private address.`
        : `${total} logged requests: ${c.lan} to LAN nodes, ${c.cluster} cluster-wide model lists, ${c.loopback} to this PC; none to the internet.` +
          (thisPc ? ` ${thisPc} recent inference request(s) were served by this PC.` : ''),
    });
  }
  return checks;
}

export type ConnClass = 'loopback' | 'lan' | 'listening' | 'exposed' | 'bad';

export interface Conn {
  pid: number;
  role: string;
  local: string;
  remote: string;
  state: string;
  cls: ConnClass;
}

const bracket = (a: string) => (a.includes(':') ? `[${a}]` : a);

export function classifyConn(local: string, remote: string, state: string): ConnClass {
  if (state === 'Listen' || remote === '0.0.0.0' || remote === '::') {
    return addressClass(local) === 'loopback' ? 'listening' : 'exposed';
  }
  const c = addressClass(remote);
  return c === 'public' ? 'bad' : c;
}

interface RawConn {
  LocalAddress: string;
  LocalPort: number;
  RemoteAddress: string;
  RemotePort: number;
  State: number | string;
  OwningProcess: number;
}

// MSFT_NetTCPConnection.State values.
const TCP_STATES: Record<number, string> = {
  1: 'Closed', 2: 'Listen', 3: 'SynSent', 4: 'SynReceived', 5: 'Established', 6: 'FinWait1', 7: 'FinWait2',
  8: 'CloseWait', 9: 'Closing', 10: 'LastAck', 11: 'TimeWait', 12: 'DeleteTCB', 100: 'Bound',
};

function tcpConnections(pids: number[]): Promise<RawConn[]> {
  // The pids are integers we validated; nothing else reaches the command line.
  const script = `$ErrorActionPreference='SilentlyContinue'; @(Get-NetTCPConnection -OwningProcess ${pids.join(',')} | ` +
    'Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,@{n="State";e={[int]$_.State}},OwningProcess) | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error('Windows did not return the connection list.'));
        const text = stdout.trim();
        if (!text) return resolve([]);
        try {
          const v = JSON.parse(text) as RawConn | RawConn[];
          resolve(Array.isArray(v) ? v : [v]);
        } catch {
          reject(new Error('Windows returned an unreadable connection list.'));
        }
      });
  });
}

export function registerPrivacyRoutes(app: FastifyInstance, opts: {
  configPath: string; dataDir: string; pair: PairLog; jobs: JobManager; sidecar: Sidecar;
  listConnections?: (pids: number[]) => Promise<RawConn[]>;
}): void {
  app.get('/api/privacy', { config: { auth: 'read' } }, async () => ({
    checkedAt: new Date().toISOString(),
    host: os.hostname(),
    checks: await privacyChecklist(opts),
  }));

  app.post<{ Body: { shellPids?: number[] } | undefined }>('/api/privacy/connections', {
    config: { auth: 'mutate' },
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: { shellPids: { type: 'array', maxItems: 16, items: { type: 'integer', minimum: 1, maximum: 4_294_967_295 } } },
      },
    },
  }, async (req, reply) => {
    if (process.platform !== 'win32' && !opts.listConnections) return reply.code(501).send({ error: 'This check needs Windows.' });
    const roles = new Map<number, string>([[process.pid, 'dashboard server']]);
    if (opts.sidecar.pid) roles.set(opts.sidecar.pid, 'library sidecar (Python)');
    for (const j of opts.jobs.active()) if (j.pid) roles.set(j.pid, `${j.kind} job (Python)`);
    for (const pid of req.body?.shellPids ?? []) if (!roles.has(pid)) roles.set(pid, 'dashboard window');
    let raw: RawConn[];
    try {
      raw = await (opts.listConnections ?? tcpConnections)([...roles.keys()]);
    } catch (e) {
      return reply.code(503).send({ error: e instanceof Error ? e.message : 'The connection list is unavailable.' });
    }
    const connections: Conn[] = raw.map((c) => {
      const known = typeof c.State === 'number' ? TCP_STATES[c.State] : c.State || undefined;
      // Some Windows builds report no state for listening sockets; the wildcard remote gives them away.
      const unbound = c.RemoteAddress === '0.0.0.0' || c.RemoteAddress === '::';
      const state = known ?? (unbound ? 'Listen' : `Unknown (${String(c.State)})`);
      return {
        pid: c.OwningProcess, role: roles.get(c.OwningProcess) ?? 'other', state,
        local: `${bracket(c.LocalAddress)}:${c.LocalPort}`, remote: `${bracket(c.RemoteAddress)}:${c.RemotePort}`,
        cls: classifyConn(c.LocalAddress, c.RemoteAddress, state),
      };
    }).filter((c) => c.state !== 'TimeWait' || c.cls !== 'loopback')
      .sort((a, b) => a.role.localeCompare(b.role) || a.local.localeCompare(b.local));
    const summary: Record<ConnClass, number> = { loopback: 0, lan: 0, listening: 0, exposed: 0, bad: 0 };
    for (const c of connections) summary[c.cls]++;
    return {
      checkedAt: new Date().toISOString(),
      processes: [...roles].map(([pid, role]) => ({ pid, role })),
      connections,
      summary,
    };
  });
}
