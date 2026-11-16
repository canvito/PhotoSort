import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect as browserExpect, type ElectronApplication, type Page } from '@playwright/test';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.ts';
import { findPython, photosortDir } from './helpers.ts';

// Checks in a separate fixture-mode Electron window running the current UI build: the folder picker inside the
// Sort form, the Faces results page, the Settings editor and the Search page staying on screen. Only empty synthetic
// folders, a temporary config copy and mocked index and face replies; never attaches to the user's running window or
// reads its state.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ps-window-'));
const library = path.join(tmp, 'library');
const first = path.join(library, 'First folder');
const second = path.join(library, 'Second folder');
let built: App;
let electron: ElectronApplication;
let page: Page;
let origin: string;
const token = 'f'.repeat(43);
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
  // A copy: the Settings test saves it.
  const configPath = path.join(tmp, 'config.json');
  copyFileSync(path.join(dashboard, 'fixtures', 'config.fixture.json'), configPath);
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

describe('Faces page', { timeout: 30000 }, () => {
  // A 1x1 PNG stands in for every thumbnail and preview; the boxes are drawn in the reported picture size.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const item = (id: string, name: string, extra: { status: string; people?: string[]; faces?: number; unknown?: number }) => ({ id, name,
    folder: first, kind: 'photo', size: 1000, indexed_at: null, people_count: 0, exists: true, placeholder: false, revision: '1',
    people: [] as string[], faces: 0, unknown: 0, frames: null, error: null, ...extra });
  const items = [
    item('m_two', 'two.jpg', { status: 'named', people: ['Alice'], faces: 2, unknown: 1 }),
    item('m_none', 'none.jpg', { status: 'none' }),
  ];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const at = (pathname: string) => (u: URL) => u.pathname === pathname;
  const summary = at('/api/faces');
  const list = at('/api/faces/items');
  const detail = at('/api/faces/items/m_two');

  beforeEach(async () => {
    pageErrors.length = 0;
    await page.route(summary, (r) => r.fulfill(json({ generation: 1, skipped: 0, people: ['Alice', 'Bob'],
      threshold: 0.45, margin: 0.05, finished_at: new Date().toISOString(), provider: 'local',
      counts: { all: 2, people: { Alice: 1 }, unknown: 1, none: 1, errors: 0 } })));
    await page.route(list, (r) => {
      const filter = new URL(r.request().url()).searchParams.get('filter');
      const shown = filter === 'all' ? items : items.filter((i) => (filter === 'none' ? i.status === 'none' : i.people.includes('Alice')));
      return r.fulfill(json({ items: shown, total: shown.length, nextCursor: null, generation: 1 }));
    });
    await page.route(detail, (r) => r.fulfill(json({ ...items[0], path: path.join(first, 'two.jpg'),
      width: 400, height: 300, detections: [{ person: 'Alice', similarity: 0.71, bbox: [10, 20, 110, 160] },
        { person: null, similarity: 0.2, bbox: [200, 30, 380, 290] }] })));
    await page.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png }));
  });

  afterEach(async () => {
    for (const m of [summary, list, detail]) await page.unroute(m);
    await page.unroute('**/media/**');
  });

  it('filters by person and boxes each face, named or unknown, over the preview', async () => {
    await page.goto(`${origin}/faces?folder=${built.dirs.idFor(first)}`);
    const chips = page.getByRole('group', { name: 'Show' });
    await browserExpect(chips.getByRole('button', { name: /^Alice/ })).toBeEnabled();
    // A person in the people folder who is in none of the files is listed but cannot be picked.
    await browserExpect(chips.getByRole('button', { name: /^Bob/ })).toBeDisabled();
    await browserExpect(page.locator('.tile-sub')).toHaveText(['Alice + unknown', 'No faces']);
    await chips.getByRole('button', { name: /^No faces/ }).click();
    await browserExpect(page.locator('.tile-name')).toHaveText(['none.jpg']);
    await chips.getByRole('button', { name: /^Alice/ }).click();
    await browserExpect(page.locator('.tile-name')).toHaveText(['two.jpg']);
    await page.locator('.tile').first().dblclick();
    const boxes = page.locator('svg.faces-overlay');
    await browserExpect(boxes).toHaveAttribute('viewBox', '0 0 400 300');
    await browserExpect(boxes.locator('text')).toHaveText(['Alice', 'Unknown']);
    await browserExpect(boxes.locator('g.named rect')).toHaveAttribute('width', '100');
    await page.locator('ul.face-list li').nth(1).hover();
    await browserExpect(boxes.locator('g.hover text')).toHaveText('Unknown');
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('aside.detail')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});

describe('Settings page', { timeout: 60000 }, () => {
  // The real server and Python check the temporary config; only the model list is fixed, so the test does not depend
  // on whether a PAIR (or a fixture dashboard's fake one) is running.
  const models = [{ name: 'gemma4:12b', cloud: false, params: '12B' }, { name: 'qwen3-embedding:8b', cloud: false },
    { name: 'big:cloud', cloud: true }];
  const config = (u: URL) => u.pathname === '/api/config';

  beforeEach(async () => {
    pageErrors.length = 0;
    await page.route(config, async (r) => {
      if (r.request().method() !== 'GET') return r.continue();
      // From Node, with the token the shell would add; route.fetch() would skip the shell's session.
      const real = await (await fetch(`${origin}/api/config`, { headers: { 'x-photosort-token': token } })).json() as object;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...real, pairReachable: true, models }) });
    });
  });

  afterEach(async () => {
    await page.unroute(config);
  });

  it('refuses cloud models, reviews the changes and saves them with a backup', async () => {
    const file = path.join(tmp, 'config.json');
    const before = readFileSync(file, 'utf8');
    await page.goto(`${origin}/settings`);
    const sortModel = page.getByLabel('Sort and group');
    await browserExpect(sortModel.locator('option[value="big:cloud"]')).toBeDisabled();
    await browserExpect(page.getByRole('button', { name: 'Review changes' })).toBeDisabled();
    await browserExpect(page.getByLabel('Bucket 6 name')).toBeDisabled();

    // Typing goes through values below the minimum (1, 10, 102) without being clamped on the way.
    const size = page.getByLabel('Image size');
    await size.fill('');
    await size.pressSequentially('1024');
    await browserExpect(size).toHaveValue('1024');
    await page.getByRole('button', { name: 'Add bucket' }).click();
    await page.getByLabel('Bucket 6 name').fill('Pets');
    await browserExpect(page.getByLabel('Bucket 6 name')).toHaveValue('pets');
    await page.getByLabel('Bucket 6 description').fill('Photos of pets.');
    await browserExpect(page.getByLabel('Bucket 7 name')).toHaveValue('other');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await browserExpect(page.locator('ul.changes code')).toHaveText(['max_side', 'buckets.pets']);
    await page.getByRole('button', { name: 'Save 2 changes' }).click();
    await browserExpect(page.locator('.settings-review p.ok')).toContainText('Saved 2 changes');
    await browserExpect(page.getByRole('button', { name: 'Review changes' })).toBeDisabled();

    const saved = JSON.parse(readFileSync(file, 'utf8')) as { max_side: number; buckets: Record<string, string> };
    expect(saved.max_side).toBe(1024);
    expect(Object.keys(saved.buckets).slice(-2)).toEqual(['pets', 'other']);
    expect(existsSync(`${file}.bak`) && readFileSync(`${file}.bak`, 'utf8')).toBe(before);
    expect(pageErrors).toEqual([]);
  });

  it('shows refusals from the Python check and local problems, and Discard drops the edits', async () => {
    const file = path.join(tmp, 'config.json');
    const before = readFileSync(file, 'utf8');
    await page.goto(`${origin}/settings`);
    const review = page.getByRole('button', { name: 'Review changes' });
    await page.getByRole('button', { name: 'Add bucket' }).click();
    const name = page.getByLabel('Bucket 7 name');
    await name.fill('con');
    await review.click();
    await browserExpect(page.locator('.settings-review ul.bad')).toContainText("'con' is reserved by Windows");
    await browserExpect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);

    await name.fill('pets');
    await browserExpect(page.locator('.settings-review ul.bad')).toContainText('Two buckets are named "pets".');
    await browserExpect(review).toBeDisabled();
    await page.getByRole('button', { name: 'Discard' }).click();
    await browserExpect(page.getByLabel('Bucket 7 name')).toHaveValue('other');
    await browserExpect(page.getByLabel('Bucket 8 name')).toHaveCount(0);
    await browserExpect(review).toBeDisabled();
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(pageErrors).toEqual([]);
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

describe('every page is usable with a screen reader', { timeout: 60000 }, () => {
  // Runs in the page (a string: its CSP blocks injected functions). Lists visible controls that have no name from
  // aria-label, aria-labelledby, a label or their own text; a title alone does not count.
  const UNNAMED = `(() => {
    const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
    const named = (el) => {
      if ((el.getAttribute('aria-label') || '').trim()) return true;
      const by = el.getAttribute('aria-labelledby');
      if (by && by.split(/\\s+/).some((id) => { const n = document.getElementById(id); return n && text(n); })) return true;
      if (el.labels && [...el.labels].some((l) => text(l))) return true;
      return el.matches('button, a, summary, [role]') && Boolean(text(el));
    };
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const controls = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=checkbox], [role=switch]');
    return { unnamed: [...controls].filter((el) => visible(el) && !named(el)).map((el) => el.outerHTML.slice(0, 100)),
      mains: document.querySelectorAll('main').length, h1: [...document.querySelectorAll('h1')].filter(visible).length };
  })()`;

  afterEach(async () => {
    await page.unroute('**/api/index/stats');
  });

  it('names every control and has one main region and one heading, in Sort, Group, Faces, Settings and the rest', async () => {
    await page.route('**/api/index/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ready: true, total: 3, photos: 2, videos: 1, generation: 1, matrix: { loaded: false, rows: 0, bytes: 0 }, cache: { bytes: 0, files: 0, limitBytes: 1024 } }) }));
    const problems: Record<string, unknown> = {};
    for (const route of ['/', '/sort', '/group', '/search', '/faces', '/runs', '/cluster', '/settings', '/privacy']) {
      await page.goto(`${origin}${route}`);
      await browserExpect(page.locator('h1').first()).toBeVisible();
      await page.waitForTimeout(500);
      const r = await page.evaluate(UNNAMED) as { unnamed: string[]; mains: number; h1: number };
      if (r.unnamed.length || r.mains !== 1 || r.h1 !== 1) problems[route] = r;
    }
    expect(problems).toEqual({});
  });
});
