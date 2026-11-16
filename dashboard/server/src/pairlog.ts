// The PAIR cluster monitor and routing audit, read from PAIR's own log (logs\nvpair.jsonl, rotated to
// nvpair.1.jsonl) and its member list (cluster\members.json). The log holds request routing only (node, target
// address, path, status, timings), never prompts or images. Nothing here opens a network connection.
import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type TargetClass = 'lan' | 'loopback' | 'cluster' | 'blank' | 'public';

export interface ProxyEvent {
  t: number;
  id: string;
  node: string;
  target: string;
  cls: TargetClass;
  path: string;
  status: number;
  ms: number;
  ttfb?: number;
}

export interface EngineStatus {
  t: number;
  node: string;
  healthy: boolean;
  running: boolean;
}

export interface NodeInfo {
  t: number;
  node: string;
  host?: string;
  ip?: string;
  models?: string[];
}

export type Parsed = { kind: 'request'; ev: ProxyEvent } | { kind: 'engine'; ev: EngineStatus } | { kind: 'node'; ev: NodeInfo };

export interface PairAlert {
  t: number;
  kind: 'public_target' | 'this_pc';
  node: string;
  target: string;
  path: string;
}

const INFERENCE = /^\/(api\/(chat|generate|embed|embeddings)|v1\/)/;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Splits "host:port", "[v6]:port" or a bare host. */
export function hostOf(target: string): string {
  const t = target.trim();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(t);
  if (v6) return v6[1];
  if (isIP(t) === 6) return t;
  return t.replace(/:\d+$/, '');
}

export function addressClass(host: string): 'loopback' | 'lan' | 'public' {
  const h = host.toLowerCase().replace(/^::ffff:/, '');
  if (h === 'localhost' || h === '::1' || (isIP(h) === 4 && h.startsWith('127.'))) return 'loopback';
  if (isIP(h) === 4) return privateV4(h) ? 'lan' : 'public';
  if (isIP(h) === 6) return /^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/.test(h) ? 'lan' : 'public';
  return 'public';
}

/** RFC 1918 or link-local: lan; this PC: loopback; "cluster" (PAIR's own fan-out) or no target: their own class. */
export function targetClass(target: string | undefined | null): TargetClass {
  const t = (target ?? '').trim();
  if (!t) return 'blank';
  if (t === 'cluster') return 'cluster';
  return addressClass(hostOf(t));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One log line, in either format PAIR writes: `{time, message: "ollama-proxy:proxy/request", data}`, or the
 * older JSON-RPC copy with the JSON in `message` (`{method, params}`). Unknown lines give undefined. */
export function parseLine(line: string): Parsed | undefined {
  const request = line.includes('proxy/request') && !line.includes('request-started');
  if (!request && !line.includes('engine status polled') && !line.includes('node/updated') && !line.includes('node/discovered')) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(o)) return undefined;
  const t = Date.parse(str(o.time) ?? '');
  if (!Number.isFinite(t)) return undefined;
  let msg = str(o.message) ?? '';
  let data: unknown = o.data;
  if (msg.startsWith('{')) {
    try {
      const inner = JSON.parse(msg) as Record<string, unknown>;
      msg = str(inner.method) ?? str(inner.msg) ?? str(inner.message) ?? '';
      data = inner.params ?? inner.data;
    } catch {
      return undefined;
    }
  }
  if (!isObj(data)) return undefined;
  if (msg === 'ollama-proxy:proxy/request') {
    const target = str(data.target) ?? '';
    return {
      kind: 'request',
      ev: {
        t, id: str(data.id) ?? String(num(data.id) ?? ''), node: str(data.node_id) ?? '', target, cls: targetClass(target),
        path: str(data.path) ?? '', status: num(data.status) ?? 0, ms: num(data.duration_ms) ?? 0, ttfb: num(data.ttfb_ms),
      },
    };
  }
  const polled = /^remote engine status polled for ([0-9a-fA-F-]{8,})/.exec(msg);
  if (polled && Array.isArray(data.engines)) {
    const engines = data.engines.filter(isObj);
    const ollama = engines.filter((e) => /ollama/i.test(str(e.engine) ?? ''));
    const pick = ollama.length ? ollama : engines;
    return { kind: 'engine', ev: { t, node: polled[1], healthy: pick.some((e) => e.healthy === true), running: pick.some((e) => e.running === true) } };
  }
  if (msg === 'ollama-proxy:node/updated' || msg === 'ollama-proxy:node/discovered') {
    const models = Array.isArray(data.models)
      ? data.models.map((m) => (isObj(m) ? str(m.name) ?? str(m.model) : str(m))).filter((m): m is string => Boolean(m)) : undefined;
    const id = str(data.id);
    if (!id) return undefined;
    return { kind: 'node', ev: { t, node: id, host: str(data.host), ip: str(data.ip), models } };
  }
  return undefined;
}

export interface Member {
  id: string;
  nodeUuid?: string;
  name: string;
  ip?: string;
  port?: number;
  state?: string;
  lastSeen?: string;
}

export function parseMembers(raw: unknown): Member[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw).find(Array.isArray) ?? [] : [];
  return (list as unknown[]).filter(isObj).map((m) => ({
    id: str(m.id) ?? str(m.nodeUuid) ?? '',
    nodeUuid: str(m.nodeUuid),
    name: str(m.name) ?? str(m.id) ?? '?',
    ip: str(m.ipAddress) ?? str(m.ip),
    port: num(m.port),
    state: str(m.state),
    lastSeen: typeof m.lastSeen === 'number' ? new Date(m.lastSeen).toISOString() : str(m.lastSeen),
  })).filter((m) => m.id);
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

interface Tracked {
  ino: string;
  offset: number;
  decoder: StringDecoder;
  rest: string;
}

export interface PairLogOptions {
  /** PAIR's data folder: logs\nvpair.jsonl and cluster\members.json are inside. */
  dir: string;
  /** This PC's name in members.json (default: the computer name). */
  selfName?: string;
  now?: () => number;
  onAlert?: (a: PairAlert) => void;
  /** The most read from each log file the first time (older lines are skipped). */
  maxInitialBytes?: number;
}

export const WINDOWS: Record<string, { ms: number; bins: number }> = {
  '15m': { ms: 15 * 60_000, bins: 30 },
  '1h': { ms: 60 * 60_000, bins: 60 },
  '24h': { ms: 24 * 60 * 60_000, bins: 96 },
};
const KEEP_MS = WINDOWS['24h'].ms + 60_000;
const CLASSES: TargetClass[] = ['lan', 'cluster', 'blank', 'loopback', 'public'];
const zero = (): Record<TargetClass, number> => ({ lan: 0, cluster: 0, blank: 0, loopback: 0, public: 0 });

export class PairLog {
  private opts: PairLogOptions;
  private file: string;
  private rotated: string;
  private tracked?: Tracked;
  private events: ProxyEvent[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private engines = new Map<string, EngineStatus>();
  private nodeInfo = new Map<string, NodeInfo>();
  private allTime = zero();
  private allAlerts = 0;
  private firstT?: number;
  private lastT?: number;
  private alerts: PairAlert[] = [];
  private unrecognized = 0;
  private lines = 0;
  private busy?: Promise<void>;
  private lastRefresh = 0;
  private initial = true;
  private membersCache?: { mtime: number; members: Member[] };
  found = false;

  constructor(opts: PairLogOptions) {
    this.opts = opts;
    this.file = path.join(opts.dir, 'logs', 'nvpair.jsonl');
    this.rotated = path.join(opts.dir, 'logs', 'nvpair.1.jsonl');
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private get selfName(): string {
    return (this.opts.selfName ?? os.hostname()).toLowerCase();
  }

  /** Reads what PAIR appended since the last call (at most every `minGapMs`). */
  refresh(minGapMs = 1000): Promise<void> {
    if (this.busy) return this.busy;
    if (Date.now() - this.lastRefresh < minGapMs) return Promise.resolve();
    this.busy = this.doRefresh().finally(() => {
      this.lastRefresh = Date.now();
      this.busy = undefined;
    });
    return this.busy;
  }

  private async doRefresh(): Promise<void> {
    let st: Stats & { ino: number | bigint };
    try {
      st = await stat(this.file, { bigint: true }) as unknown as Stats & { ino: bigint };
    } catch {
      this.found = false;
      return;
    }
    this.found = true;
    const ino = String(st.ino);
    const size = Number(st.size);
    const t = this.tracked;
    if (!t) {
      // First read: the rotated file (older) first, then the current one.
      const cap = this.opts.maxInitialBytes ?? 128 * 1024 * 1024;
      try {
        const r = await stat(this.rotated, { bigint: true });
        const rsize = Number(r.size);
        await this.readRange(this.rotated, Math.max(0, rsize - cap), rsize, { ino: String(r.ino), offset: 0, decoder: new StringDecoder('utf8'), rest: '' }, true);
      } catch {
        /* no rotated file */
      }
      const fresh: Tracked = { ino, offset: 0, decoder: new StringDecoder('utf8'), rest: '' };
      await this.readRange(this.file, Math.max(0, size - cap), size, fresh, true);
      this.tracked = fresh;
      this.initial = false;
      return;
    }
    if (t.ino !== ino || size < t.offset) {
      // Rotated: finish the old file (now nvpair.1.jsonl), then start the new one from its beginning.
      try {
        const r = await stat(this.rotated, { bigint: true });
        if (String(r.ino) === t.ino && Number(r.size) > t.offset) await this.readRange(this.rotated, t.offset, Number(r.size), t, false);
      } catch {
        /* gone */
      }
      const fresh: Tracked = { ino, offset: 0, decoder: new StringDecoder('utf8'), rest: '' };
      await this.readRange(this.file, 0, size, fresh, false);
      this.tracked = fresh;
      return;
    }
    if (size > t.offset) await this.readRange(this.file, t.offset, size, t, false);
  }

  private async readRange(file: string, start: number, end: number, t: Tracked, skipFirst: boolean): Promise<void> {
    if (end <= start) return;
    let first = skipFirst && start > 0;
    const stream = createReadStream(file, { start, end: end - 1, highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) {
      const text = t.rest + t.decoder.write(chunk as Buffer);
      const parts = text.split('\n');
      t.rest = parts.pop() ?? '';
      for (const line of parts) {
        if (first) { first = false; continue; } // a partial line where the read began
        this.ingest(line);
      }
    }
    t.offset = end;
  }

  /** One complete log line (exported for tests through `ingestLines`). */
  private ingest(line: string): void {
    if (!line.trim()) return;
    this.lines++;
    const p = parseLine(line);
    if (!p) {
      if (line.includes('proxy/request') && !line.includes('request-started')) this.unrecognized++;
      return;
    }
    if (p.kind === 'engine') {
      const prev = this.engines.get(p.ev.node);
      if (!prev || prev.t <= p.ev.t) this.engines.set(p.ev.node, p.ev);
      return;
    }
    if (p.kind === 'node') {
      const prev = this.nodeInfo.get(p.ev.node);
      if (!prev || prev.t <= p.ev.t) this.nodeInfo.set(p.ev.node, { ...prev, ...p.ev, models: p.ev.models ?? prev?.models });
      return;
    }
    const ev = p.ev;
    // PAIR logs each request twice (both formats); count it once.
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      this.seenOrder.push(ev.id);
      if (this.seenOrder.length > 50_000) {
        for (const old of this.seenOrder.splice(0, 10_000)) this.seen.delete(old);
      }
    }
    this.allTime[ev.cls]++;
    this.firstT = Math.min(this.firstT ?? ev.t, ev.t);
    this.lastT = Math.max(this.lastT ?? ev.t, ev.t);
    const alert = this.alertFor(ev);
    if (alert) {
      this.allAlerts++;
      this.alerts.push(alert);
      if (this.alerts.length > 50) this.alerts.splice(0, this.alerts.length - 50);
      if (!this.initial) this.opts.onAlert?.(alert);
    }
    if (ev.t >= this.now() - KEEP_MS) {
      this.events.push(ev);
      if (this.events.length > 20_000 && this.events[0].t < this.now() - KEEP_MS) {
        const cut = this.events.findIndex((e) => e.t >= this.now() - KEEP_MS);
        this.events.splice(0, cut < 0 ? this.events.length : cut);
      }
    }
  }

  /** Tests: feed lines as if PAIR had written them. */
  ingestLines(lines: string[], live = true): void {
    const was = this.initial;
    this.initial = !live;
    for (const l of lines) this.ingest(l);
    this.initial = was;
  }

  private selfIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of this.members()) {
      if (m.name.toLowerCase() === this.selfName) {
        ids.add(m.id);
        if (m.nodeUuid) ids.add(m.nodeUuid);
      }
    }
    return ids;
  }

  private alertFor(ev: ProxyEvent): PairAlert | undefined {
    if (ev.cls === 'public') return { t: ev.t, kind: 'public_target', node: ev.node, target: ev.target, path: ev.path };
    if (INFERENCE.test(ev.path) && (ev.cls === 'loopback' || (ev.node && this.selfIds().has(ev.node)))) {
      return { t: ev.t, kind: 'this_pc', node: ev.node, target: ev.target, path: ev.path };
    }
    return undefined;
  }

  members(): Member[] {
    return this.membersCache?.members ?? [];
  }

  async loadMembers(): Promise<Member[]> {
    const file = path.join(this.opts.dir, 'cluster', 'members.json');
    try {
      const st = await stat(file);
      if (this.membersCache?.mtime === st.mtimeMs) return this.membersCache.members;
      const members = parseMembers(JSON.parse(await readFile(file, 'utf8')));
      this.membersCache = { mtime: st.mtimeMs, members };
      return members;
    } catch {
      this.membersCache = undefined;
      return [];
    }
  }

  private window(ms: number): ProxyEvent[] {
    const from = this.now() - ms;
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].t < from) lo = mid + 1;
      else hi = mid;
    }
    // Events are appended in log order, which is time order except across the two formats; a few out-of-order
    // lines near the edge do not matter for a monitor.
    return this.events.slice(lo).filter((e) => e.t >= from);
  }

  status(): { found: boolean; format: 'ok' | 'unrecognized' | 'empty'; lines: number; firstT?: number; lastT?: number } {
    const total = CLASSES.reduce((a, c) => a + this.allTime[c], 0);
    return {
      found: this.found,
      format: total ? 'ok' : this.unrecognized ? 'unrecognized' : 'empty',
      lines: this.lines,
      firstT: this.firstT,
      lastT: this.lastT,
    };
  }

  /** Per node: identity from members.json, engine health, models, and request stats over the window. */
  nodes(windowMs: number): NodeRow[] {
    const evs = this.window(windowMs).filter((e) => INFERENCE.test(e.path));
    const byNode = new Map<string, ProxyEvent[]>();
    for (const e of evs) {
      const k = e.node || hostOf(e.target) || '?';
      byNode.set(k, [...(byNode.get(k) ?? []), e]);
    }
    const self = this.selfIds();
    const rows = new Map<string, NodeRow>();
    const now = this.now();
    for (const m of this.members()) {
      const key = m.nodeUuid ?? m.id;
      rows.set(key, { id: key, name: m.name, ip: m.ip, state: m.state, lastSeen: m.lastSeen, self: self.has(m.id) || self.has(key), member: true } as NodeRow);
    }
    for (const k of new Set([...byNode.keys(), ...this.engines.keys(), ...this.nodeInfo.keys()])) {
      if (!rows.has(k) && ![...rows.values()].some((r) => r.id === k)) {
        const memberById = this.members().find((m) => m.id === k);
        if (memberById) continue;
        const info = this.nodeInfo.get(k);
        rows.set(k, { id: k, name: info?.host ?? k.slice(0, 8), ip: info?.ip, self: self.has(k), member: false } as NodeRow);
      }
    }
    const total = evs.length;
    for (const row of rows.values()) {
      const alias = this.members().find((m) => (m.nodeUuid ?? m.id) === row.id);
      const ids = [row.id, alias?.id].filter((x): x is string => Boolean(x));
      const mine = ids.flatMap((id) => byNode.get(id) ?? []);
      const lat = mine.map((e) => e.ms).sort((a, b) => a - b);
      const ttfb = mine.map((e) => e.ttfb).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      const eng = ids.map((id) => this.engines.get(id)).find(Boolean);
      const info = ids.map((id) => this.nodeInfo.get(id)).find(Boolean);
      row.requests = mine.length;
      row.perMin = Math.round((mine.length / (windowMs / 60_000)) * 10) / 10;
      row.p50 = percentile(lat, 0.5);
      row.p95 = percentile(lat, 0.95);
      row.ttfbP50 = percentile(ttfb, 0.5);
      row.errors = mine.filter((e) => e.status === 0 || e.status >= 400).length;
      row.errorRate = mine.length ? Math.round((row.errors / mine.length) * 1000) / 10 : undefined;
      row.share = total ? Math.round((mine.length / total) * 1000) / 10 : 0;
      row.ip ??= info?.ip ?? (mine[0] ? hostOf(mine[0].target) : undefined);
      row.models = info?.models;
      if (eng) {
        row.engineHealthy = eng.healthy;
        row.engineRunning = eng.running;
        row.engineCheckedAt = new Date(eng.t).toISOString();
      }
      const lastActivity = Math.max(eng?.t ?? 0, mine.at(-1)?.t ?? 0, Date.parse(row.lastSeen ?? '') || 0);
      row.stale = !row.self && now - lastActivity > 30 * 60_000;
      row.lastActivity = lastActivity ? new Date(lastActivity).toISOString() : undefined;
    }
    return [...rows.values()].sort((a, b) => Number(a.stale) - Number(b.stale) || b.requests - a.requests || a.name.localeCompare(b.name));
  }

  /** Requests per node and latency per time bin over the window (for the charts). */
  stats(key: keyof typeof WINDOWS): PairStats {
    const w = WINDOWS[key];
    const binMs = w.ms / w.bins;
    const end = Math.ceil(this.now() / binMs) * binMs;
    const start = end - w.ms;
    const evs = this.window(w.ms).filter((e) => INFERENCE.test(e.path));
    const names = new Map(this.nodes(w.ms).map((n) => [n.id, n.name]));
    for (const m of this.members()) names.set(m.id, m.name);
    const series = new Map<string, number[]>();
    const lat: number[][] = Array.from({ length: w.bins }, () => []);
    for (const e of evs) {
      const i = Math.min(w.bins - 1, Math.max(0, Math.floor((e.t - start) / binMs)));
      const name = names.get(e.node) ?? (e.node ? e.node.slice(0, 8) : hostOf(e.target));
      if (!series.has(name)) series.set(name, new Array<number>(w.bins).fill(0));
      series.get(name)![i]++;
      lat[i].push(e.ms);
    }
    const all = evs.map((e) => e.ms).sort((a, b) => a - b);
    return {
      window: key, start: new Date(start).toISOString(), binS: binMs / 1000,
      series: [...series].map(([name, counts]) => ({ name, counts })).sort((a, b) => b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0)),
      p50: lat.map((l) => percentile(l.sort((a, b) => a - b), 0.5) ?? null),
      p95: lat.map((l) => percentile(l, 0.95) ?? null),
      total: evs.length,
      errors: evs.filter((e) => e.status === 0 || e.status >= 400).length,
      overallP50: percentile(all, 0.5),
      overallP95: percentile(all, 0.95),
    };
  }

  /** Where requests went, by target class, over 24 h and over everything in the log files. */
  audit(): PairAudit {
    const day = zero();
    const dayEvents = this.window(WINDOWS['24h'].ms);
    for (const e of dayEvents) day[e.cls]++;
    const dayAlerts = this.alerts.filter((a) => a.t >= this.now() - WINDOWS['24h'].ms);
    return {
      ...this.status(),
      firstT: this.firstT ? new Date(this.firstT).toISOString() : undefined,
      lastT: this.lastT ? new Date(this.lastT).toISOString() : undefined,
      day: { counts: day, alerts: dayAlerts.length },
      all: { counts: { ...this.allTime }, alerts: this.allAlerts },
      recentAlerts: this.alerts.slice(-20).reverse().map((a) => ({ ...a, t: new Date(a.t).toISOString() })),
    } as PairAudit;
  }
}

export interface NodeRow {
  id: string;
  name: string;
  ip?: string;
  state?: string;
  lastSeen?: string;
  self: boolean;
  member: boolean;
  stale: boolean;
  lastActivity?: string;
  engineHealthy?: boolean;
  engineRunning?: boolean;
  engineCheckedAt?: string;
  models?: string[];
  requests: number;
  perMin: number;
  p50?: number;
  p95?: number;
  ttfbP50?: number;
  errors: number;
  errorRate?: number;
  share: number;
}

export interface PairStats {
  window: string;
  start: string;
  binS: number;
  series: { name: string; counts: number[] }[];
  p50: (number | null)[];
  p95: (number | null)[];
  total: number;
  errors: number;
  overallP50?: number;
  overallP95?: number;
}

export interface PairAudit {
  found: boolean;
  format: 'ok' | 'unrecognized' | 'empty';
  lines: number;
  firstT?: string;
  lastT?: string;
  day: { counts: Record<TargetClass, number>; alerts: number };
  all: { counts: Record<TargetClass, number>; alerts: number };
  recentAlerts: (Omit<PairAlert, 't'> & { t: string })[];
}
