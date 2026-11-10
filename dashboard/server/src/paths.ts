import path from 'node:path';

function norm(p: string): string {
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '') + path.sep;
}

/** True when `p` is inside a OneDrive folder; dashboard data (thumbnails, events, logs) must never sync. */
export function isUnderOneDrive(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const target = norm(p);
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key];
    if (root && target.startsWith(norm(root))) return true;
  }
  return false;
}
