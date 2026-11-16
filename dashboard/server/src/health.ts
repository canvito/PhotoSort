// Health of the local PAIR proxy as counts and model names only (no paths, no media).
import { readFile } from 'node:fs/promises';
import { isCloudModel, localGetJson, requireLoopback } from './localfetch.ts';

export interface PairHealth {
  reachable: boolean;
  ms: number;
  models: number;
  required: { name: string; role: string; present: boolean; cloud: boolean }[];
  cloudModelsListed: number;
  error?: string;
}

interface TagEntry {
  name?: string;
  remote_host?: unknown;
  remote_model?: unknown;
}

export async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
}

export async function pairHealth(configPath: string): Promise<PairHealth> {
  const started = performance.now();
  const out: PairHealth = { reachable: false, ms: 0, models: 0, required: [], cloudModelsListed: 0 };
  try {
    const cfg = await readConfig(configPath);
    const base = String(cfg.base_url ?? '');
    requireLoopback(base);
    const roles: [string, unknown][] = [
      ['sort', cfg.model],
      ['caption', cfg.caption_model ?? cfg.model],
      ['embed', cfg.embed_model],
    ];
    const tags = (await localGetJson(base, '/api/tags')) as { models?: TagEntry[] };
    const entries = new Map((tags.models ?? []).map((m) => [String(m.name ?? ''), m]));
    out.reachable = true;
    out.models = entries.size;
    out.cloudModelsListed = [...entries].filter(([n, e]) => isCloudModel(n, e)).length;
    const seen = new Set<string>();
    for (const [role, name] of roles) {
      if (typeof name !== 'string' || !name) continue;
      const key = `${role}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.required.push({ name, role, present: entries.has(name), cloud: isCloudModel(name, entries.get(name)) });
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  out.ms = Math.round(performance.now() - started);
  return out;
}
