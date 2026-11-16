// Bootstrap: records startup failures (bad install, syntax errors) in the data folder's log, because the
// server runs hidden and has no console. Usage: node server/start.mjs --data-dir DIR ... (see main.ts).
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

try {
  await import('./src/main.ts');
} catch (err) {
  const e = /** @type {Error} */ (err);
  const i = process.argv.indexOf('--data-dir');
  if (i > 0 && process.argv[i + 1]) {
    const dir = path.join(process.argv[i + 1], 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'server-crash.log'), `${new Date().toISOString()} ${e?.stack ?? e}\n`);
  }
  process.stderr.write(`photosort-dashboard failed to start: ${e?.message ?? e}\n`);
  process.exit(1);
}
