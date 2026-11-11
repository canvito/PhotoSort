// PhotoSort dashboard window (Electron main process). Started by dashboard.ps1:
//   electron.exe <dashboard>\shell --state <dataDir>\state.json [--gpu rtx|igpu|auto] [--self-test <out.json>]
// The renderer is the SPA served by the local dashboard server. This process:
//  - cancels every request that is not to the server's own http://127.0.0.1:<port> origin (and resolves no
//    host names at all), so no page content can reach the internet or the LAN;
//  - adds the API token to requests for that origin, so the page itself never sees the token;
//  - blocks navigation, new windows, downloads, permissions, spell-check dictionaries and WebRTC UDP;
//  - turns on content protection in real mode (screenshots and screen sharing see a black window);
//  - quits when the server stops.
import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} name */
function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** @param {string} msg @returns {never} */
function die(msg) {
  process.stderr.write(`photosort-shell: ${msg}\n`);
  process.exit(2);
}

const statePath = arg('--state') ?? die('--state is required');
const gpu = arg('--gpu') ?? 'auto';
const selfTestOut = arg('--self-test');
const logDir = path.join(path.dirname(statePath), 'logs');

/** Event names only: never URLs, paths or page content. @param {string} event @param {Record<string, unknown>} [extra] */
function log(event, extra = {}) {
  try {
    mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    appendFileSync(path.join(logDir, `shell-${day}.log`), `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...extra })}\n`);
  } catch { /* logging must never stop the window */ }
}
log('start', { gpu, selfTest: Boolean(selfTestOut) });

/** @type {{running?: boolean, port: number, token: string, mode: 'real' | 'fixture'}} */
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (!state.running || !Number.isInteger(state.port) || typeof state.token !== 'string') die('the dashboard server is not running');
const fixture = state.mode === 'fixture';
if (selfTestOut && !fixture) die('--self-test runs in fixture mode only');
const origin = `http://127.0.0.1:${state.port}`;

app.setPath('userData', path.join(path.dirname(statePath), selfTestOut ? 'shell-selftest' : 'shell'));
// --gpu is informational: on Windows the GPU comes from the per-app preference dashboard.ps1 sets before launch
// (Chromium's force_*_gpu switches only work on macOS).
// Defense in depth behind the request guard: no host name resolves, no background or WebRTC traffic.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,DialMediaRouteProvider,AutofillServerCommunication');

if (!app.requestSingleInstanceLock()) process.exit(0); // the running window is focused instead
app.setAppUserModelId('PhotoSort.Dashboard');

/** @type {BrowserWindow | undefined} */
let win;
let protection = !fixture;
let blocked = 0;
/** @type {Map<string, number>} fixture mode only: which hosts were blocked (real mode keeps counts only) */
const blockedHosts = new Map();
/** @type {{vendor: string, deviceId: string} | undefined} */
let activeGpu;

/** @param {string} url */
function ownOrigin(url) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** @param {string} url */
function allowedRequest(url) {
  if (ownOrigin(url)) return true;
  // data: and blob: never touch the network; devtools only exists in fixture mode.
  return url.startsWith('data:') || url.startsWith('blob:') || (fixture && url.startsWith('devtools://'));
}

const VENDORS = /** @type {Record<number, string>} */ ({ 0x10de: 'NVIDIA', 0x8086: 'Intel', 0x1002: 'AMD', 0x1414: 'Microsoft (software)' });

function info() {
  return {
    mode: state.mode,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    gpuChoice: gpu,
    gpuDevice: activeGpu,
    gpuFeatures: app.getGPUFeatureStatus(),
    protection,
    blockedRequests: blocked,
    // The window's own processes, for the Privacy page's open-connections check.
    pids: app.getAppMetrics().map((m) => m.pid).slice(0, 16),
  };
}

/** @param {Electron.IpcMainInvokeEvent} e */
function fromOurPage(e) {
  if (!e.senderFrame || !ownOrigin(e.senderFrame.url)) throw new Error('refused: not the dashboard page');
}

function quit(/** @type {string} */ why) {
  log('quit', { why });
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  app.quit();
}

/** Follows the server's event stream; quits on its shutdown event, or when it has been gone for ~6 s. */
function watchServer() {
  let failures = 0;
  const probe = () => {
    const req = http.get({ host: '127.0.0.1', port: state.port, path: '/healthz', agent: false, timeout: 1500 }, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        failures = 0;
        connect();
      } else retry();
    });
    req.on('timeout', () => req.destroy());
    req.on('error', retry);
  };
  const retry = () => {
    failures += 1;
    if (failures >= 4) quit('server gone');
    else setTimeout(probe, 1500);
  };
  const connect = () => {
    const req = http.get({
      host: '127.0.0.1', port: state.port, path: '/api/stream', agent: false,
      headers: { 'x-photosort-token': state.token },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return retry();
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (/** @type {string} */ chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: sys$/m.test(block) && block.includes('"type":"shutdown"')) quit('server stopped');
        }
      });
      res.on('close', () => setTimeout(probe, 500));
    });
    req.on('error', () => setTimeout(probe, 500));
  };
  probe();
}

app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!ownOrigin(url)) e.preventDefault(); });
  wc.on('will-redirect', (e, url) => { if (!ownOrigin(url)) e.preventDefault(); });
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.on('window-all-closed', () => app.quit());

// Not a top-level await: Electron emits 'ready' only after the ESM entry module has finished evaluating.
async function main() {
  log('ready');
  Menu.setApplicationMenu(null);
  const ses = session.defaultSession;
  await ses.setProxy({ mode: 'direct' });
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.webRequest.onBeforeRequest((details, cb) => {
    if (allowedRequest(details.url)) return cb({});
    blocked += 1;
    if (fixture) {
      let host = 'unparsable';
      try { host = new URL(details.url).host || new URL(details.url).protocol; } catch { /* keep */ }
      blockedHosts.set(host, (blockedHosts.get(host) ?? 0) + 1);
    }
    cb({ cancel: true });
  });
  ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, 'X-PhotoSort-Token': state.token } });
  });

  ipcMain.handle('photosort:info', (e) => {
    fromOurPage(e);
    return info();
  });
  ipcMain.handle('photosort:set-protection', (e, on) => {
    fromOurPage(e);
    if (typeof on !== 'boolean') throw new Error('expected true or false');
    protection = on;
    win?.setContentProtection(on);
    return info();
  });

  app.getGPUInfo('basic').then((/** @type {any} */ g) => {
    const d = (g?.gpuDevice ?? []).find((/** @type {any} */ x) => x.active) ?? g?.gpuDevice?.[0];
    if (d) activeGpu = { vendor: VENDORS[d.vendorId] ?? `0x${Number(d.vendorId).toString(16)}`, deviceId: `0x${Number(d.deviceId).toString(16)}` };
  }, () => undefined);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'PhotoSort',
    backgroundColor: '#101217',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: fixture,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  });
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  win.setContentProtection(protection);
  if (!selfTestOut) win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = undefined; });
  win.webContents.on('did-finish-load', () => log('page: loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('page: load failed', { code, desc }));
  win.webContents.on('render-process-gone', (_e, d) => log('page: renderer gone', { reason: d.reason }));
  const loaded = win.loadURL(`${origin}/`);
  watchServer();

  if (selfTestOut) {
    await loaded;
    log('selftest: page loaded');
    const page = await win.webContents.executeJavaScript(`(async () => {
      const r = await fetch('/api/meta');
      const meta = r.ok ? await r.json() : {};
      return { apiStatus: r.status, mode: meta.mode, cookie: document.cookie, bridge: Object.keys(window.photosort || {}).sort(),
               hasRequire: typeof require !== 'undefined', hasProcess: typeof process !== 'undefined' };
    })()`);
    log('selftest: page checked');
    // Every page renders: none falls into the error boundary or stays blank, and none logs an error.
    /** @type {string[]} */
    const consoleErrors = [];
    win.webContents.on('console-message', (/** @type {any} */ e, /** @type {any} */ level, /** @type {any} */ message) => {
      const lvl = e?.level ?? level;
      if (lvl === 'error' || lvl === 3) consoleErrors.push(String(e?.message ?? message).slice(0, 200));
    });
    /** @type {Record<string, unknown>} */
    const pages = {};
    for (const p of ['/', '/sort', '/group', '/search', '/faces', '/runs', '/cluster', '/settings', '/privacy', '/runs/:first']) {
      const before = consoleErrors.length;
      pages[p] = await win.webContents.executeJavaScript(`(async () => {
        let p = ${JSON.stringify(p)};
        if (p === '/runs/:first') {
          const runs = (await (await fetch('/api/runs')).json()).runs.filter((r) => !r.key.startsWith('job~'));
          if (!runs.length) return { skipped: true, text: 1, crashed: false };
          p = '/runs/' + encodeURIComponent(runs[0].key);
        }
        history.pushState(null, '', p);
        await new Promise((r) => setTimeout(r, 1500));
        const content = document.querySelector('.content');
        const bad = new Set(['This page hit a problem', 'Run not found']);
        return { text: (content?.innerText ?? '').trim().length,
                 crashed: [...document.querySelectorAll('.content [role=alert] h2')].some((h) => bad.has(h.textContent ?? '')) };
      })()`);
      Object.assign(/** @type {object} */ (pages[p]), { errors: consoleErrors.slice(before) });
    }
    log('selftest: pages rendered');
    const before = blocked;
    const probeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const html = '<img src="https://example.com/x.png"><img src="http://192.168.0.1/x.png">' +
      '<script>fetch("https://example.com/").catch(()=>{}); try { new WebSocket("ws://10.0.0.1:1/") } catch {}</script>';
    await probeWin.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    probeWin.destroy();
    log('selftest: probe done');
    await win.webContents.executeJavaScript('location.href = "https://example.com/"; 1').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const result = {
      ...info(),
      page,
      pages,
      stayedOnOrigin: ownOrigin(win.webContents.getURL()),
      blockedByProbe: blocked - before,
      blockedHosts: Object.fromEntries(blockedHosts),
      contentProtected: typeof win.isContentProtected === 'function' ? win.isContentProtected() : null,
    };
    writeFileSync(selfTestOut, JSON.stringify(result, null, 2));
    quit('self-test done');
  }
}

app.whenReady().then(main).catch((/** @type {unknown} */ err) => {
  log('failed', { error: err instanceof Error ? err.message : String(err) });
  app.exit(1);
});
