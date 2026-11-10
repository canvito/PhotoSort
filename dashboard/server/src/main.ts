// Dashboard server entry point. Started (hidden, detached) by ..\..\..\dashboard.ps1 through start.mjs.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp, type LineLogger, type Mode } from './app.ts';
import { isUnderOneDrive } from './paths.ts';

// No proxy may ever reroute a request; node:http ignores these anyway, this keeps child processes clean too.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
  delete process.env[k];
  delete process.env[k.toLowerCase()];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dashDir = path.resolve(here, '..', '..');
const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'real' },
    port: { type: 'string' },
    'data-dir': { type: 'string' },
    config: { type: 'string' },
    python: { type: 'string' },
    'photosort-dir': { type: 'string' },
    nonce: { type: 'string', default: '' },
  },
  strict: true,
});

function fail(msg: string): never {
  process.stderr.write(`photosort-dashboard: ${msg}\n`);
  process.exit(2);
}

const mode = values.mode as Mode;
if (mode !== 'real' && mode !== 'fixture') fail('--mode must be real or fixture');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port must be 1024-65535');
const dataDir = values['data-dir'] ? path.resolve(values['data-dir']) : fail('--data-dir is required');
const configPath = values.config ? path.resolve(values.config) : fail('--config is required');
const photosortDir = path.resolve(values['photosort-dir'] ?? path.join(dashDir, '..'));
if (isUnderOneDrive(dataDir)) fail('the dashboard data folder must not be inside OneDrive');

const version = (JSON.parse(readFileSync(path.join(dashDir, 'package.json'), 'utf8')) as { version: string }).version;
mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
const logFile = path.join(dataDir, 'logs', `server-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.log`);
const logger: LineLogger = {
  info: (o) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), l: 'info', ...o }) + '\n'),
  error: (o) => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), l: 'error', ...o }) + '\n'),
};

const statePath = path.join(dataDir, 'state.json');
function writeState(state: object): void {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, statePath);
}

let fakePair: ChildProcess | undefined;
if (mode === 'fixture') {
  // Fixture mode never touches the real PAIR cluster: a deterministic fake Ollama answers instead.
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as { base_url: string };
  const fakePort = new URL(cfg.base_url).port;
  const python = values.python ?? fail('--python is required in fixture mode');
  fakePair = spawn(python, [path.join(photosortDir, 'tests', 'fake_pair.py'), '--port', fakePort, '--parent-pid', String(process.pid)],
    { stdio: 'ignore', windowsHide: true, shell: false });
  fakePair.on('error', (e) => logger.error({ msg: 'fake PAIR failed to start', err: e.message }));
}

const token = randomBytes(32).toString('base64url');
let stopping = false;

async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ msg: 'stopping', reason });
  setTimeout(() => process.exit(0), 5000).unref();
  hub.close();
  await app.close().catch(() => undefined);
  fakePair?.kill();
  writeState({ running: false, mode, port, version, stoppedAt: new Date().toISOString() });
  process.exit(0);
}

const { app, hub } = await buildApp({
  port,
  token,
  mode,
  version,
  configPath,
  webDist: path.join(dashDir, 'web', 'dist'),
  logger,
  onShutdown: (job) => void shutdown(`api (job=${job})`),
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
process.on('uncaughtException', (e) => {
  logger.error({ msg: 'uncaught', err: e.stack ?? String(e) });
  process.exit(1);
});

await app.listen({ host: '127.0.0.1', port });
writeState({
  running: true,
  pid: process.pid,
  nodePath: process.execPath,
  startTimeUtc: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  port,
  token,
  nonce: values.nonce,
  mode,
  version,
});
logger.info({ msg: 'listening', mode, port, version, node: process.versions.node });
