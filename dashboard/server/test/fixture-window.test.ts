import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect as browserExpect, type ElectronApplication, type Page } from '@playwright/test';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { findPython, photosortDir } from './helpers.ts';

// Checks in a separate fixture-mode Electron window running the current UI build: the folder picker inside the
// Sort form, and the Search page staying on screen. Only empty synthetic folders and mocked index replies;
// never attaches to the user's running window or reads its state.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ps-window-'));
const library = path.join(tmp, 'library');
const first = path.join(library, 'First folder');
const second = path.join(library, 'Second folder');
let built: App;
let electron: ElectronApplication;
let page: Page;
let origin: string;
let submissions = 0;
const pageErrors: string[] = [];

beforeAll(async () => {
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const dashboard = path.join(photosortDir, 'dashboard');
  const dist = path.join(tmp, 'web');
  await build({ configFile: path.join(dashboard, 'web', 'vite.config.ts'), logLevel: 'silent', build: { outDir: dist } });
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  const token = 'f'.repeat(43);
  const configPath = path.join(dashboard, 'fixtures', 'config.fixture.json');
  built = await buildApp({ port, token, mode: 'fixture', version: 'test', configPath, dataDir: path.join(tmp, 'data'),
    python: findPython(), photosortDir, fixtureRoots: [library], webDist: dist });
  await built.app.listen({ host: '127.0.0.1', port });
  const statePath = path.join(tmp, 'state.json');
  writeFileSync(statePath, JSON.stringify({ running: true, mode: 'fixture', port, token }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: path.join(dashboard, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [path.join(dashboard, 'shell'), '--state', statePath],
    env: env as Record<string, string>,
  });
  page = await electron.firstWindow();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await electron.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false);
      window.removeAllListeners('ready-to-show');
      window.hide();
    }
  });
  await page.route('**/api/jobs', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions++;
    // A folder-picker regression must never start a real CLI job, even against these empty folders.
    return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Unexpected test submission"}' });
  });
}, 60000);

// Clicks in the hidden window take about 2 s each (Playwright waits for frames a hidden window rarely paints), so
// these multi-step tests get more than the default 15 s.

afterAll(async () => {
  await electron?.close();
  built?.hub.close();
  await built?.app.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('folder picker in the actual Sort form', { timeout: 30000 }, () => {
  beforeEach(async () => {
    submissions = 0;
    await page.goto(`${origin}/sort`);
    await browserExpect(page.getByRole('heading', { name: 'Sort a folder into buckets' })).toBeVisible();
  });

  it('Go opens a quoted path and changing folders never submits the job form', async () => {
    const picker = page.locator('.field.wide').first();
    await picker.getByRole('button', { name: 'Choose…' }).click();
    await picker.getByRole('textbox', { name: 'Folder path' }).fill(`"${first}"`);
    await picker.getByRole('button', { name: 'Go', exact: true }).click();
    await browserExpect(picker.locator('.picker-path')).toHaveText(first);
    await browserExpect(page.locator('form form')).toHaveCount(0);
    await picker.getByRole('button', { name: 'Use this folder' }).click();
    await browserExpect(picker.locator('.picker-chosen')).toContainText(first);
    await browserExpect(page.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled();

    await picker.getByRole('button', { name: 'Change…' }).click();
    await picker.getByRole('textbox', { name: 'Folder path' }).fill(second);
    await picker.getByRole('button', { name: 'Go', exact: true }).click();
    await browserExpect(picker.locator('.picker-path')).toHaveText(second);
    expect(submissions).toBe(0);
    await picker.getByRole('button', { name: 'Use this folder' }).click();
    await browserExpect(picker.locator('.picker-chosen')).toContainText(second);
  });

  it('Enter opens a path and invalid paths display an error without selecting or starting a job', async () => {
    const picker = page.locator('.field.wide').first();
    await picker.getByRole('button', { name: 'Choose…' }).click();
    const input = picker.getByRole('textbox', { name: 'Folder path' });
    await input.fill(first);
    await input.press('Enter');
    await browserExpect(picker.locator('.picker-path')).toHaveText(first);
    await input.fill(path.join(library, 'Does not exist'));
    await input.press('Enter');
    await browserExpect(picker.getByRole('alert')).toContainText('No folder exists');
    await browserExpect(input).toHaveValue(path.join(library, 'Does not exist'));
    await browserExpect(picker.locator('.picker-chosen')).toHaveCount(0);
    expect(submissions).toBe(0);
  });

  it('shows progress while opening a folder and explains how to select it', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/fs/resolve', async (route) => {
      await pending;
      await route.continue();
    });
    try {
      const picker = page.locator('.field.wide').first();
      await picker.getByRole('button', { name: 'Choose…' }).click();
      await picker.getByRole('textbox', { name: 'Folder path' }).fill(first);
      await picker.getByRole('button', { name: 'Go', exact: true }).click();
      await browserExpect(picker.getByRole('status')).toHaveText('Opening folder…');
      await browserExpect(picker.getByRole('button', { name: 'Opening…' })).toBeDisabled();
      release();
      await browserExpect(picker.locator('.picker-path')).toHaveText(first);
      await browserExpect(picker.getByRole('status')).toHaveText('Choose Use this folder to select it.');
      expect(submissions).toBe(0);
    } finally {
      release();
      await page.unroute('**/api/fs/resolve');
    }
  });
});

describe('Search page stays on screen', { timeout: 30000 }, () => {
  const stats = { ready: true, total: 3, photos: 2, videos: 1, generation: 1,
    matrix: { loaded: false, rows: 0, bytes: 0 }, cache: { bytes: 0, files: 0, limitBytes: 1024 } };

  beforeEach(() => {
    pageErrors.length = 0;
  });

  afterEach(async () => {
    await page.unroute('**/api/index/stats');
  });

  it('when a stats reply is aborted while its body is still arriving', async () => {
    // After indexing, opening Search reads the stats while the index "changed" event reloads them, which aborts
    // the first reply mid-body. Hold that first body open (headers already in) until the abort, like the race.
    await page.addInitScript({ content: `(() => {
      if (!location.search.includes('holdStats')) return;
      const realFetch = window.fetch.bind(window);
      let held = false;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (held || !url.includes('/api/index/stats')) return realFetch(input, init);
        held = true;
        const body = new ReadableStream({ start(c) {
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')));
        } });
        window.__statsHeld = true;
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      };
    })();` });
    await page.route('**/api/index/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stats) }));
    await page.goto(`${origin}/search?holdStats=1`);
    await browserExpect.poll(() => page.evaluate('window.__statsHeld === true')).toBe(true);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await browserExpect(page.locator('.index-stats')).toContainText('3 indexed');
    await browserExpect(page.getByRole('searchbox', { name: 'Search' })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  it('a page that fails to render shows a message and keeps the navigation working', async () => {
    await page.route('**/api/index/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.goto(`${origin}/search`);
    await browserExpect(page.locator('main').getByRole('alert')).toContainText('This page hit a problem');
    await page.locator('nav.nav').getByRole('link', { name: 'Sort' }).click();
    await browserExpect(page.getByRole('heading', { name: 'Sort a folder into buckets' })).toBeVisible();
  });
});
