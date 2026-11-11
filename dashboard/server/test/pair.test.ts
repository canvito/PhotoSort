import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { PairLog, parseLine, targetClass, type PairAlert } from '../src/pairlog.ts';
import { classifyConn, expandWinVars } from '../src/privacy.ts';
import { findPython, photosortDir } from './helpers.ts';

const PY = findPython();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'psdash-pair-'));
const NODE = 'a0000000-0000-4000-8000-00000000000a';
const SELF = 'd0000000-0000-4000-8000-00000000000d';

let n = 0;
/** A request the way PAIR logs it: once with `data`, once as a JSON-RPC string in `message`. */
function request(target: string, opts: { node?: string; path?: string; t?: Date; status?: number; ms?: number } = {}): string[] {
  const params = {
    duration_ms: opts.ms ?? 1000, id: `req-${++n}`, method: 'POST', node_id: opts.node ?? NODE, path: opts.path ?? '/api/chat',
    status: opts.status ?? 200, target, ttfb_ms: 100,
  };
  const time = (opts.t ?? new Date()).toISOString();
  return [
    JSON.stringify({ time, level: 'debug', message: 'ollama-proxy:proxy/request-started', data: { id: params.id, target } }),
    JSON.stringify({ time, level: 'info', message: 'ollama-proxy:proxy/request', source: 'pair', data: params }),
    JSON.stringify({ time, level: 'info', message: JSON.stringify({ jsonrpc: '2.0', method: 'ollama-proxy:proxy/request', params }) }),
  ];
}

function pairDir(name: string, members: object[] = []): string {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, 'logs'), { recursive: true });
  mkdirSync(path.join(dir, 'cluster'), { recursive: true });
  writeFileSync(path.join(dir, 'cluster', 'members.json'), JSON.stringify(members));
  return dir;
}

const member = (name: string, uuid: string, ip: string) =>
  ({ id: `peer-${uuid.slice(0, 8)}`, nodeUuid: uuid, name, ipAddress: ip, port: 1, state: 'member', lastSeen: new Date().toISOString() });

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('PAIR log parsing', () => {
  it('reads both log formats, ignores request-started lines and classifies targets', () => {
    const [started, data, legacy] = request('192.168.1.20:11434');
    expect(parseLine(started)).toBeUndefined();
    const a = parseLine(data);
    const b = parseLine(legacy);
    expect(a).toMatchObject({ kind: 'request', ev: { node: NODE, cls: 'lan', path: '/api/chat', status: 200, ms: 1000 } });
    expect(b).toEqual(a);
    expect(parseLine('{"time":"2026-01-01T00:00:00Z","message":"engine:settings-changed","data":{}}')).toBeUndefined();
    expect(parseLine('not json at all proxy/request')).toBeUndefined();
    const polled = parseLine(JSON.stringify({ time: new Date().toISOString(), message: `remote engine status polled for ${NODE}`,
      data: { engines: [{ engine: 'ollama', healthy: true, running: true }] } }));
    expect(polled).toMatchObject({ kind: 'engine', ev: { node: NODE, healthy: true, running: true } });

    expect(targetClass('cluster')).toBe('cluster');
    expect(targetClass('')).toBe('blank');
    expect(targetClass('127.0.0.1:11435')).toBe('loopback');
    expect(targetClass('[::1]:11434')).toBe('loopback');
    for (const lan of ['10.5.1.2:1', '172.16.0.1:1', '172.31.255.1:1', '192.168.0.9:1', '169.254.3.3:1', '[fe80::1]:1', '[fd12::3]:1']) {
      expect(targetClass(lan), lan).toBe('lan');
    }
    for (const pub of ['8.8.8.8:443', '172.32.0.1:1', '[2001:db8::1]:1', 'ollama.com:443']) expect(targetClass(pub), pub).toBe('public');
  });

  it('counts a request logged in both formats once, and raises live alerts for public targets and this PC', async () => {
    const dir = pairDir('alerts', [member('node-a', NODE, '192.168.1.20'), member('my-pc', SELF, '192.168.1.10')]);
    const alerts: PairAlert[] = [];
    const log = new PairLog({ dir, selfName: 'MY-PC', onAlert: (a) => alerts.push(a) });
    await log.loadMembers();
    log.ingestLines([...request('192.168.1.20:11434'), ...request('cluster', { path: '/api/tags', node: '' })], false);
    expect(log.audit().all.counts).toMatchObject({ lan: 1, cluster: 1, public: 0 });
    expect(alerts).toEqual([]);

    log.ingestLines([
      ...request('203.0.113.9:11434'),
      ...request('127.0.0.1:11435', { node: '' }),
      ...request('192.168.1.10:11434', { node: SELF }),
      ...request('127.0.0.1:11435', { node: '', path: '/api/tags' }), // a model list from this PC is not inference
    ]);
    expect(alerts.map((a) => a.kind)).toEqual(['public_target', 'this_pc', 'this_pc']);
    const audit = log.audit();
    expect(audit.all.counts).toMatchObject({ lan: 2, cluster: 1, loopback: 2, public: 1 });
    expect(audit.all.alerts).toBe(3);
    expect(audit.recentAlerts[0]).toMatchObject({ kind: 'this_pc', node: SELF });
  });

  it('tails the log across partial lines and a rotation without losing or repeating requests', async () => {
    const dir = pairDir('rotation');
    const file = path.join(dir, 'logs', 'nvpair.jsonl');
    const one = [...request('192.168.1.20:1'), ...request('192.168.1.21:1')].join('\n') + '\n';
    const next = request('192.168.1.22:1')[1];
    writeFileSync(file, one + next.slice(0, 40));
    const log = new PairLog({ dir });
    await log.refresh(0);
    expect(log.audit().all.counts.lan).toBe(2);
    appendFileSync(file, next.slice(40) + '\n');
    await log.refresh(0);
    expect(log.audit().all.counts.lan).toBe(3);

    // PAIR appends one more request, then rotates before we look again.
    appendFileSync(file, request('192.168.1.23:1').join('\n') + '\n');
    renameSync(file, path.join(dir, 'logs', 'nvpair.1.jsonl'));
    writeFileSync(file, request('192.168.1.24:1').join('\n') + '\n');
    await log.refresh(0);
    expect(log.audit().all.counts.lan).toBe(5);
    await log.refresh(0);
    expect(log.audit().all.counts.lan).toBe(5);
  });

  it('reports a missing log, and a log in a format it does not know', async () => {
    const missing = new PairLog({ dir: path.join(tmp, 'nope') });
    await missing.refresh(0);
    expect(missing.audit()).toMatchObject({ found: false });
    const dir = pairDir('odd');
    writeFileSync(path.join(dir, 'logs', 'nvpair.jsonl'), '{"when":"x","message":"ollama-proxy:proxy/request","data":{}}\n');
    const odd = new PairLog({ dir });
    await odd.refresh(0);
    expect(odd.audit()).toMatchObject({ found: true, format: 'unrecognized' });
  });
});

describe('the fixture cluster (fake_pair.py --pair-dir)', () => {
  const dir = path.join(tmp, 'fixture-pair');
  beforeAll(() => {
    execFileSync(PY, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); '
      + 'from fake_pair import FakePairLog; FakePairLog(Path(sys.argv[2]))', path.join(photosortDir, 'tests'), dir], { stdio: 'ignore' });
  }, 60000);

  it('shows three busy LAN nodes, this PC serving nothing and a stale member, with no alerts', async () => {
    const log = new PairLog({ dir, selfName: 'this-pc' });
    await log.refresh(0);
    await log.loadMembers();
    const nodes = log.nodes(24 * 3600_000);
    const by = Object.fromEntries(nodes.map((x) => [x.name, x]));
    for (const name of ['fixture-node-a', 'fixture-node-b', 'fixture-node-c']) {
      expect(by[name], name).toMatchObject({ stale: false, engineHealthy: true, self: false });
      expect(by[name].requests, name).toBeGreaterThan(10);
      expect(by[name].p95!).toBeGreaterThanOrEqual(by[name].p50!);
    }
    expect(by['this-pc']).toMatchObject({ self: true, requests: 0, stale: false });
    expect(by['fixture-old-node']).toMatchObject({ stale: true, requests: 0 });
    const audit = log.audit();
    expect(audit).toMatchObject({ found: true, format: 'ok' });
    expect(audit.all.counts.public + audit.all.counts.loopback).toBe(0);
    expect(audit.all.alerts).toBe(0);
    // Each request is in the log twice (both formats); it is counted once.
    const logged = ['nvpair.jsonl', 'nvpair.1.jsonl'].flatMap((f) => readFileSync(path.join(dir, 'logs', f), 'utf8').split('\n'))
      .filter((l) => l.includes('"message": "ollama-proxy:proxy/request"')).length;
    expect(audit.all.counts.lan + audit.all.counts.cluster).toBe(logged);
    const stats = log.stats('24h');
    expect(stats.series.map((s) => s.name).sort()).toEqual(['fixture-node-a', 'fixture-node-b', 'fixture-node-c']);
    expect(stats.series[0].counts).toHaveLength(96);
  });
});

describe('privacy checks', () => {
  const PORT = 47993;
  const TOKEN = 'p'.repeat(43);
  const auth = { host: `127.0.0.1:${PORT}`, 'x-photosort-token': TOKEN };
  let built: App;
  let asked: number[] = [];
  beforeAll(async () => {
    const dir = pairDir('privacy', [member('node-a', NODE, '192.168.1.20')]);
    writeFileSync(path.join(dir, 'logs', 'nvpair.jsonl'), request('192.168.1.20:11434').join('\n') + '\n');
    const configPath = path.join(tmp, 'privacy-config.json');
    writeFileSync(configPath, JSON.stringify({ base_url: 'http://127.0.0.1:9', model: 'gemma4:12b', embed_model: 'qwen3-embedding:8b',
      index_path: path.join(tmp, 'index.sqlite') }));
    built = await buildApp({
      port: PORT, token: TOKEN, mode: 'fixture', version: 't', configPath, dataDir: path.join(tmp, 'privacy-data'),
      python: process.execPath, photosortDir: tmp, fixtureRoots: [path.join(tmp, 'library')], pairDir: dir,
      listConnections: async (pids) => {
        asked = pids;
        return [
          // Windows can report no state (0) for a listening socket.
          { LocalAddress: '127.0.0.1', LocalPort: PORT, RemoteAddress: '0.0.0.0', RemotePort: 0, State: 0, OwningProcess: process.pid },
          { LocalAddress: '127.0.0.1', LocalPort: 50000, RemoteAddress: '127.0.0.1', RemotePort: PORT, State: 5, OwningProcess: 4242 },
          { LocalAddress: '192.168.1.10', LocalPort: 50001, RemoteAddress: '8.8.8.8', RemotePort: 443, State: 5, OwningProcess: 4242 },
        ];
      },
    });
  });
  afterAll(async () => {
    built.hub.close();
    await built.app.close();
  });

  it('lists the checks that keep media local, all green for a local setup', async () => {
    const r = await built.app.inject({ url: '/api/privacy', headers: auth });
    expect(r.statusCode).toBe(200);
    const checks = (r.json() as { checks: { id: string; status: string }[] }).checks;
    const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({ base_url: 'ok', models: 'ok', proxies: 'ok', allowlist: 'ok', index: 'ok', data: 'ok', pair_audit: 'ok' });
    expect(status.cloud_listed).toBe('unknown'); // nothing answers on port 9
  });

  it('classifies the open connections of the dashboard processes', async () => {
    const post = (payload: object) => built.app.inject({ method: 'POST', url: '/api/privacy/connections', payload,
      headers: { ...auth, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' } });
    const r = await post({ shellPids: [4242] });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { summary: Record<string, number>; connections: { role: string; cls: string; state: string }[] };
    expect(asked).toContain(process.pid);
    expect(asked).toContain(4242);
    expect(body.summary).toEqual({ loopback: 1, lan: 0, listening: 1, exposed: 0, bad: 1 });
    expect(body.connections.find((c) => c.cls === 'listening')?.state).toBe('Listen');
    expect(body.connections.find((c) => c.cls === 'bad')?.role).toBe('dashboard window');
    expect((await post({ shellPids: Array.from({ length: 17 }, (_, i) => i + 1) })).statusCode).toBe(400);
    expect((await post({ shellPids: ['1; calc'] })).statusCode).toBe(400);
  });

  it('serves the cluster routes from the PAIR log', async () => {
    const nodes = await built.app.inject({ url: '/api/pair/nodes?window=24h', headers: auth });
    expect(nodes.json()).toMatchObject({ status: { found: true, format: 'ok' }, nodes: [{ name: 'node-a', requests: 1 }] });
    expect((await built.app.inject({ url: '/api/pair/nodes?window=7d', headers: auth })).statusCode).toBe(400);
    const models = await built.app.inject({ url: '/api/pair/models', headers: auth });
    expect(models.json()).toMatchObject({ reachable: false });
  });

  it('helpers: connection classes and %VAR% expansion', () => {
    expect(classifyConn('0.0.0.0', '0.0.0.0', 'Listen')).toBe('exposed');
    expect(classifyConn('::1', '::', 'Listen')).toBe('listening');
    expect(classifyConn('192.168.1.10', '192.168.1.20', 'Established')).toBe('lan');
    expect(expandWinVars('%localappdata%\\x\\%NOPE%', { LOCALAPPDATA: 'C:\\L' })).toBe('C:\\L\\x\\%NOPE%');
  });
});
