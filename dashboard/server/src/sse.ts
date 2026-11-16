// One multiplexed Server-Sent Events stream for the whole UI (Chromium allows only 6 connections per host).
import type { ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from './security.ts';

interface Stored {
  id: number;
  event: string;
  data: string;
}

export class SseHub {
  private clients: Set<ServerResponse> = new Set();
  private ring: Stored[] = [];
  private nextId = 1;
  private max: number;
  private heartbeat: NodeJS.Timeout;

  constructor(max = 2000, heartbeatMs = 15000) {
    this.max = max;
    this.heartbeat = setInterval(() => this.writeAll(': hb\n\n'), heartbeatMs);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  attach(res: ServerResponse, lastEventId?: string): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const after = Number(lastEventId);
    if (Number.isFinite(after) && after > 0) {
      for (const m of this.ring) if (m.id > after) res.write(format(m));
    }
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  send(event: string, data: unknown): number {
    const m = { id: this.nextId++, event, data: JSON.stringify(data) };
    this.ring.push(m);
    if (this.ring.length > this.max) this.ring.splice(0, this.ring.length - this.max);
    this.writeAll(format(m));
    return m.id;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  private writeAll(chunk: string): void {
    for (const c of this.clients) c.write(chunk);
  }
}

function format(m: Stored): string {
  return `id: ${m.id}\nevent: ${m.event}\ndata: ${m.data}\n\n`;
}
