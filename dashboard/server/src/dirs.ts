// Folders the UI may use, as opaque ids. The page never sends a raw path to a job: it browses from the roots,
// or pastes a path once (validated here), and gets back an id the server issued. In fixture mode only the
// synthetic library is reachable.
import { createHmac, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isUnderOneDrive } from './paths.ts';

export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.heic', '.heif'];
export const VIDEO_EXTS = ['.mov', '.mp4', '.m4v', '.3gp', '.avi', '.mkv', '.webm', '.wmv', '.mts', '.m2ts', '.mpg', '.mpeg'];
const MEDIA = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const MAX_CHILDREN = 2000;

export class DirError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DirInfo {
  dirId: string;
  name: string;
  path: string;
}

export interface DirListing extends DirInfo {
  parent?: DirInfo;
  media: number;
  dirs: (DirInfo & { hasChildren: boolean; media: number })[];
  truncated: boolean;
}

export const isMedia = (name: string): boolean => MEDIA.has(path.extname(name).toLowerCase());

function key(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

function inside(child: string, parent: string): boolean {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Why a typed path cannot be used, or undefined. Only plain local drive paths: no UNC or device paths (D9),
 * no alternate data streams, no reserved device names. */
export function pastedPathProblem(raw: string): string | undefined {
  const p = raw.trim().replace(/^"(.*)"$/, '$1');
  if (!p) return 'Type or paste a folder path.';
  if (p.length > 32000) return 'The path is too long.';
  if (/[\x00-\x1f]/.test(p)) return 'The path contains control characters.';
  if (/^[\\/]{2}/.test(p)) return 'Network (UNC) and device paths are not supported; use a folder on a local drive.';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return 'Use a full path that starts with a drive letter, like C:\\Users\\you\\Pictures.';
  const rest = p.slice(2);
  if (rest.includes(':')) return 'The path contains ":" (alternate data streams are not supported).';
  if (/[<>"|?*]/.test(rest)) return 'The path contains characters Windows does not allow in folder names.';
  for (const seg of rest.split(/[\\/]+/).filter(Boolean)) {
    if (seg === '..' || seg === '.') return 'Use a path without "." or ".." parts.';
    if (RESERVED.test(seg.replace(/[ .]+$/, ''))) return `"${seg}" is a reserved Windows device name.`;
  }
  return undefined;
}

export interface DirRegistryOptions {
  /** Fixture mode: the only folders that exist for the UI. */
  fixtureRoots?: string[];
  /** Folders that are never job sources (the dashboard's own data, the app). */
  protectedDirs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class DirRegistry {
  private secret = randomBytes(32);
  private byId = new Map<string, string>();
  private fixtureRoots?: string[];
  private protectedDirs: string[];
  private env: NodeJS.ProcessEnv;

  constructor(opts: DirRegistryOptions = {}) {
    this.fixtureRoots = opts.fixtureRoots?.map((r) => path.resolve(r));
    this.protectedDirs = (opts.protectedDirs ?? []).map((d) => path.resolve(d));
    this.env = opts.env ?? process.env;
  }

  get fixture(): boolean {
    return this.fixtureRoots !== undefined;
  }

  /** In fixture mode only the fixture roots; in real mode any local folder. */
  allowed(p: string): boolean {
    if (/^[\\/]{2}/.test(p)) return false;
    if (this.fixtureRoots) return this.fixtureRoots.some((r) => inside(p, r));
    return /^[A-Za-z]:[\\/]/.test(path.resolve(p));
  }

  idFor(p: string): string {
    const abs = path.resolve(p);
    if (!this.allowed(abs)) throw new DirError(403, 'This folder is outside what the dashboard may use.');
    const id = 'd_' + createHmac('sha256', this.secret).update(key(abs)).digest('base64url').slice(0, 22);
    this.byId.set(id, abs);
    return id;
  }

  info(p: string): DirInfo {
    const abs = path.resolve(p);
    return { dirId: this.idFor(abs), name: path.basename(abs) || abs, path: abs };
  }

  pathOf(id: unknown): string {
    const p = typeof id === 'string' ? this.byId.get(id) : undefined;
    if (!p) throw new DirError(404, 'Unknown folder; pick it again.');
    if (!this.allowed(p)) throw new DirError(403, 'This folder is outside what the dashboard may use.');
    return p;
  }

  /** Extra checks for a folder a job will read or change. */
  jobFolderProblem(p: string): string | undefined {
    if (!this.allowed(p)) return 'This folder is outside what the dashboard may use.';
    if (this.fixtureRoots) return undefined;
    const abs = path.resolve(p);
    if (key(abs) === key(path.parse(abs).root)) return 'Pick a folder, not a whole drive.';
    const home = os.homedir();
    const sys = [this.env.WINDIR, this.env.ProgramFiles, this.env['ProgramFiles(x86)'], this.env.ProgramData,
      this.env.APPDATA, path.join(home, 'AppData')].filter((d): d is string => Boolean(d));
    if (key(abs) === key(home)) return 'Pick a folder inside your user folder, not the whole user folder.';
    if (sys.some((d) => inside(abs, d))) return 'System and app-data folders cannot be sorted.';
    if (this.protectedDirs.some((d) => inside(abs, d) || inside(d, abs))) {
      return "This folder holds PhotoSort's own files; pick another one.";
    }
    return undefined;
  }

  async roots(): Promise<DirInfo[]> {
    if (this.fixtureRoots) return this.fixtureRoots.map((r) => this.info(r));
    const home = os.homedir();
    const known = [path.join(home, 'Pictures'), path.join(home, 'Videos')];
    for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const od = this.env[k];
      if (od) known.push(path.join(od, 'Pictures'));
    }
    known.push(path.join(home, 'Desktop'), path.join(home, 'Downloads'));
    const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`);
    const seen = new Set<string>();
    const out: DirInfo[] = [];
    // A disconnected drive can make stat hang; it runs off the event loop, and we stop waiting after 1.5 s.
    const checks = await Promise.all([...known, ...drives].map((d) => isDir(d, 1500).then((ok) => [d, ok] as const)));
    for (const [d, ok] of checks) {
      if (!ok || seen.has(key(d))) continue;
      seen.add(key(d));
      const info = this.info(d);
      if (/^[A-Z]:\\$/i.test(d)) info.name = d;
      else if (isUnderOneDrive(d, this.env)) info.name = `${path.basename(d)} (OneDrive)`;
      out.push(info);
    }
    return out;
  }

  async list(id: string): Promise<DirListing> {
    const dir = this.pathOf(id);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new DirError(404, 'This folder cannot be read (moved, deleted or no permission).');
    }
    const subdirs = entries.filter(isPlainDir).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const shown = subdirs.slice(0, MAX_CHILDREN);
    const dirs = await Promise.all(shown.map(async (d) => {
      const p = path.join(dir, d.name);
      let media = 0;
      let hasChildren = false;
      try {
        for (const e of await readdir(p, { withFileTypes: true })) {
          if (e.isFile() && isMedia(e.name)) media++;
          else if (isPlainDir(e)) hasChildren = true;
        }
      } catch {
        /* unreadable: shown with no counts */
      }
      return { ...this.info(p), hasChildren, media };
    }));
    const parentPath = path.dirname(dir);
    const parent = parentPath !== dir && this.allowed(parentPath) ? this.info(parentPath) : undefined;
    return {
      ...this.info(dir),
      parent,
      media: entries.filter((e) => e.isFile() && isMedia(e.name)).length,
      dirs,
      truncated: subdirs.length > shown.length,
    };
  }

  /** A pasted path → id, or a DirError with the reason. */
  async resolve(raw: string): Promise<DirInfo> {
    const problem = pastedPathProblem(raw);
    if (problem) throw new DirError(400, problem);
    const typed = path.resolve(raw.trim().replace(/^"(.*)"$/, '$1'));
    if (!(await isDir(typed, 3000))) throw new DirError(400, 'No folder exists at that path.');
    let real: string;
    try {
      real = await realpath(typed);
    } catch {
      throw new DirError(400, 'That folder cannot be read.');
    }
    if (/^[\\/]{2}/.test(real)) throw new DirError(400, 'That folder is on a network share; use a folder on a local drive.');
    if (!this.allowed(real)) {
      throw new DirError(403, this.fixtureRoots ? 'Fixture mode only works inside the synthetic library.' : 'This folder cannot be used.');
    }
    return this.info(typed);
  }
}

function isPlainDir(e: Dirent): boolean {
  // Junctions and links are left out (they can loop or point anywhere), as are hidden system folders.
  return e.isDirectory() && !e.isSymbolicLink() && !/^[.$]/.test(e.name) && e.name !== 'System Volume Information';
}

async function isDir(p: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((res) => { timer = setTimeout(() => res(false), timeoutMs); });
  try {
    return await Promise.race([stat(p).then((s) => s.isDirectory(), () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
