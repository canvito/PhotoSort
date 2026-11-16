import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseHub } from '../src/sse.ts';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const photosortDir = path.resolve(here, '..', '..', '..');
export const FAKE_CLI = path.join(here, 'fake_cli.py');

/** The Python dashboard.ps1 would use: PHOTOSORT_PYTHON, else the one photosort.cmd names, else miniconda's. */
export function findPython(): string {
  if (process.env.PHOTOSORT_PYTHON) return process.env.PHOTOSORT_PYTHON;
  const cmd = path.join(photosortDir, 'photosort.cmd');
  if (existsSync(cmd)) {
    for (const line of readFileSync(cmd, 'utf8').split(/\r?\n/)) {
      const m = /^\s*set\s+"PY=(.+)"\s*$/i.exec(line);
      if (m) return m[1].replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? '');
    }
  }
  return path.join(process.env.USERPROFILE ?? '', 'miniconda3', 'envs', 'utils', 'python.exe');
}

/** An SSE hub that also remembers what it sent. */
export class RecordingHub extends SseHub {
  sent: { event: string; data: Record<string, unknown> }[] = [];
  send(event: string, data: unknown): number {
    this.sent.push({ event, data: data as Record<string, unknown> });
    return super.send(event, data);
  }
  jobEvents(id: string): Record<string, unknown>[] {
    return this.sent.filter((s) => s.event === 'job' && s.data.job === id).map((s) => s.data);
  }
}

export async function until(cond: () => boolean, timeoutMs = 10000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
