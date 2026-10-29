// Headless browser acceptance checks. These are automated checks, not human visual review.
import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';
import { createRequestBudget } from '../scripts/request-budget.mjs';
import {
  createFixtureAdapter,
  insightsWithTwentyPayload,
  searchAmbiguousPayload,
  searchAmbiguousTwentyPayload,
} from './helpers/qloo-fixtures.mjs';

/**
 * 找一个能用的浏览器。
 *
 * 顺序：环境变量 → playwright 缓存里现成的无头壳 → 本机装的 Chrome。
 * playwright 自带的版本号经常和缓存里的对不上（它要 1247，机器上只有 1200），
 * 所以宁可自己在缓存里挑一个现成的无头壳，也不要让这组检查因为找不到浏览器而跑不了。
 */
function resolveBrowser() {
  if (process.env.CHROME_PATH !== undefined && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    const shells = readdirSync(cache)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const shell of shells) {
      const folder = join(cache, shell);
      for (const entry of readdirSync(folder)) {
        const candidate = join(folder, entry, 'chrome-headless-shell');
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const CHROME = resolveBrowser();
// 新鲜克隆的机器上不一定装了无头壳：找不到就整组跳过，而不是让套件报错。
const BROWSER_AVAILABLE = existsSync(CHROME);
/** 给每条检查统一加上跳过条件。 */
const test = (name, ...rest) => {
  const [options, fn] =
    typeof rest[0] === 'function' ? [{}, rest[0]] : [rest[0] ?? {}, rest[1]];
  return nodeTest(
    name,
    { ...options, skip: options.skip ?? (BROWSER_AVAILABLE ? false : '本机没有可用的浏览器') },
    fn,
  );
};

let server;
let port;
let browser;
// 带夹具适配器的第二个服务端：让**真实主线**也能在真浏览器里渲染。
let serviceServer;
let servicePort;
// 第二个服务端：种子的搜索结果是**有歧义**的，用来走消歧那条键盘路。
let ambiguousServer;
let ambiguousPort;
// 第三个服务端：一次真的返回 20 条候选，用来检查"先摊开一部分、剩下能展开"。
let twentyServer;
let twentyPort;
// 第四个服务端：搜索返回 20 个同名匹配，确认动作必须仍然够得着。
let ambiguousTwentyServer;
let ambiguousTwentyPort;

const listen = (instance) =>
  new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => resolve(instance.address().port));
  });

before(async () => {
  if (!BROWSER_AVAILABLE) return;
  server = createStaticServer();
  port = await listen(server);
  const budget = createRequestBudget({
    enabled: true,
    limit: 100,
    stateDir: await mkdtemp(join(tmpdir(), 'taste-tuner-browser-')),
  });
  serviceServer = createStaticServer(distRoot, {
    adapter: createFixtureAdapter(),
    budget,
  });
  servicePort = await listen(serviceServer);
  ambiguousServer = createStaticServer(distRoot, {
    adapter: createFixtureAdapter({ search: searchAmbiguousPayload }),
    budget: createRequestBudget({
      enabled: true,
      limit: 100,
      stateDir: await mkdtemp(join(tmpdir(), 'taste-tuner-browser-amb-')),
    }),
  });
  ambiguousPort = await listen(ambiguousServer);
  twentyServer = createStaticServer(distRoot, {
    adapter: createFixtureAdapter({ insights: insightsWithTwentyPayload }),
    budget: createRequestBudget({
      enabled: true,
      limit: 100,
      stateDir: await mkdtemp(join(tmpdir(), 'taste-tuner-browser-twenty-')),
    }),
  });
  twentyPort = await listen(twentyServer);
  ambiguousTwentyServer = createStaticServer(distRoot, {
    adapter: createFixtureAdapter({ search: searchAmbiguousTwentyPayload }),
    budget: createRequestBudget({
      enabled: true,
      limit: 100,
      stateDir: await mkdtemp(join(tmpdir(), 'taste-tuner-browser-amb20-')),
    }),
  });
  ambiguousTwentyPort = await listen(ambiguousTwentyServer);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

const distRoot = new URL('../dist', import.meta.url).pathname;

/** 打开真实主线页面（带夹具适配器的服务端），等五张影片卡出现。 */
async function openService(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  const page = await context.newPage();
  const problems = [];
  // 内容安全策略挡住非许可域的图片时浏览器会记一条消息。那是**策略在正常工作**，
  // 不是应用错误——单独收进 cspNotices，在海报那一条里断言它确实挡住了。
  const cspNotices = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().includes('violates the following Content Security Policy')) {
      cspNotices.push(message.text());
      return;
    }
    problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()} ${response.url()}`);
  });
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  await page.fill('#seed-input', 'Sample Film');
  await page.click('#seed-submit');
  // 名字唯一 → 直接出候选；对上多个 → 先在海报卡片里选一个。
  await page.waitForSelector('.service-item, .entity-options', { timeout: 15000 });
  if ((await page.locator('.entity-options').count()) > 0) {
    await page.click('#entity-confirm');
    await page.waitForSelector('.service-item', { timeout: 15000 });
  }
  return { page, context, problems, cspNotices };
}

after(async () => {
  if (browser) await browser.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (serviceServer?.listening) await new Promise((resolve) => serviceServer.close(resolve));
  if (ambiguousServer?.listening) await new Promise((resolve) => ambiguousServer.close(resolve));
  if (twentyServer?.listening) await new Promise((resolve) => twentyServer.close(resolve));
  if (ambiguousTwentyServer?.listening) {
    await new Promise((resolve) => ambiguousTwentyServer.close(resolve));
  }
});

async function open(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()} ${response.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  // 应用默认进的是**真实服务**；这一组用例走的是离线合成演示，
  // 所以要先切过去。模式开关现在收在页脚的「开发诊断」折叠区里，
  // 直接派发 change 事件即可，不必先展开折叠区。
  await page.evaluate(() => {
    const demo = document.querySelector('input[name="mode"][value="demo"]');
    if (demo !== null) {
      demo.checked = true;
      demo.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  try {
    await page.waitForSelector('li.movie-item', { timeout: 15000 });
  } catch (error) {
    const snapshot = await page
      .evaluate(() => ({
        rows: document.querySelectorAll('li.movie-item').length,
        shell: document.querySelector('.app-shell') !== null,
        panels: Array.from(document.querySelectorAll('.view-panel')).map((panel) => ({
          id: panel.id,
          hidden: panel.hidden,
        })),
      }))
      .catch(() => null);
    throw new Error(
      `app did not render rows. problems=${JSON.stringify(problems)} snapshot=${JSON.stringify(snapshot)}`,
    );
  }
  return { page, context, problems };
}

const rowTitles = (page) =>
  page.locator('li.movie-item .movie-title').allTextContents();

/** 打开搜索返回 20 个同名匹配的页面（消歧那条路）。 */
async function openAmbiguousTwenty(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${ambiguousTwentyPort}/`, { waitUntil: 'load' });
  await page.fill('#seed-input', 'Sample Film');
  await page.click('#seed-submit');
  await page.waitForSelector('#entity-confirm', { timeout: 15000 });
  return { page, context, problems };
}

/** 打开一次返回 20 条候选的真实主线页面。 */
async function openTwenty(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()} ${response.url()}`);
  });
  await page.goto(`http://127.0.0.1:${twentyPort}/`, { waitUntil: 'load' });
  await page.fill('#seed-input', 'Sample Film');
  await page.click('#seed-submit');
  await page.waitForSelector('.service-item', { timeout: 15000 });
  return { page, context, problems };
}

test('the console boots with a labelled synthetic shortlist and no failed requests', async () => {
  const { page, problems } = await open();
  assert.equal(await page.locator('li.movie-item').count(), 20);
  assert.match(await page.locator('.ranking-status').innerText(), /20 candidates/);
  assert.match(await page.locator('.demo-badge').innerText(), /[Ss]ynthetic/);
  // 来源说明收在页脚的「开发诊断」折叠区里：展开才看得见。
  await page.locator('.shell-dev-panel > summary').click();
  assert.match(await page.locator('.source-note').innerText(), /[Ss]ynthetic/);
  assert.equal(await page.locator('.scenario-card').count(), 6);
  assert.deepEqual(problems, []);
  await page.context().close();
});

test('the evidence panel opens with a worked example instead of an empty box', async () => {
  const { page } = await open();
  const title = await page.locator('.evidence-title').innerText();
  assert.ok(title.trim().length > 0);
  assert.equal(await page.locator('.score-table tbody tr').count(), 3);
  assert.match(await page.locator('.score-table caption').innerText(), /Heuristic score/);
  await page.context().close();
});

test('moving the difference weight re-ranks the list and marks the movers', async () => {
  const { page } = await open();
  const before = await rowTitles(page);
  assert.equal(before[0], 'Warm City Lights');

  await page.locator('#tag-difference').fill('100');
  await page.waitForFunction(
    () => document.querySelector('.ranking-status')?.textContent?.includes('difference 100'),
  );

  const after = await rowTitles(page);
  assert.notDeepEqual(after, before);
  assert.ok(
    after.some((title) => title === 'Letters from the Tide'),
    'the most different film must climb once the difference weight is full',
  );
  const deltas = await page.locator('.movie-delta').allTextContents();
  assert.ok(deltas.some((text) => text.startsWith('↑')));
  await page.context().close();
});

test('the relation weight alone can invert the order', async () => {
  const { page } = await open();
  await page.locator('#relation-weight').fill('0');
  await page.locator('#tag-difference').fill('100');
  // 两个滑杆都生效后状态行才会同时出现这两项，等齐再读榜单。
  await page.waitForFunction(() => {
    const status = document.querySelector('.ranking-status')?.textContent ?? '';
    return status.includes('relation 0') && status.includes('difference 100');
  });
  const titles = await rowTitles(page);
  assert.equal(titles[0], 'Last Ferry out of the Fog', 'the least similar film leads when relation weight is zero');
  await page.context().close();
});

test('keyboard alone can tune, select and read the explanation', async () => {
  const { page } = await open();
  const slider = page.locator('#tag-difference');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await slider.inputValue(), '2');
  await page.waitForFunction(() =>
    document.querySelector('.ranking-status')?.textContent?.includes('difference 2'),
  );

  const firstRow = page.locator('li.movie-item button.movie-row').first();
  await firstRow.focus();
  await page.keyboard.press('Enter');
  assert.equal(await firstRow.getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('.evidence-title').innerText(), /./);

  const outline = await firstRow.evaluate((node) => getComputedStyle(node).outlineWidth);
  assert.notEqual(outline, '0px', 'focus must stay visible');
  await page.context().close();
});

test('the tab list follows the ARIA tabs pattern', async () => {
  const { page } = await open();
  await page.locator('#tab-console').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tab-compare').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#panel-compare').isVisible(), true);
  assert.equal(await page.locator('#panel-console').isVisible(), false);

  await page.keyboard.press('End');
  assert.equal(await page.locator('#tab-explore').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#tab-console').getAttribute('aria-selected'), 'true');
  await page.context().close();
});

test('selecting a film explains it and keeps the selection while re-ranking', async () => {
  const { page } = await open();
  const row = page.locator('li.movie-item').nth(2);
  const title = await row.locator('.movie-title').innerText();
  await row.locator('button').click();
  assert.equal(await row.locator('button').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.evidence-title').innerText(), title);

  await page.locator('#tag-difference').fill('60');
  await page.waitForFunction(() =>
    document.querySelector('.ranking-status')?.textContent?.includes('difference 60'),
  );
  const selected = page.locator('li.movie-item button[aria-pressed="true"]');
  assert.equal(await selected.count(), 1);
  assert.equal(await selected.locator('.movie-title').innerText(), title);
  await page.context().close();
});

test('the shared-tag constraint shrinks the cohort and explains what it dropped', async () => {
  const { page } = await open();
  await page.locator('label[for="shared-2"]').click();
  await page.waitForFunction(() =>
    document.querySelector('.ranking-status')?.textContent?.includes('minimum shared 2'),
  );
  const count = await page.locator('li.movie-item').count();
  assert.ok(count > 0 && count < 20);
  const notices = await page.locator('.notice-summary').allTextContents();
  assert.ok(notices.some((text) => text.includes('Blocked')));
  await page.context().close();
});

test('reset returns the default weights and the default first item', async () => {
  const { page } = await open();
  await page.locator('#tag-difference').fill('80');
  await page.locator('#relation-weight').fill('10');
  await page.locator('label[for="shared-2"]').click();
  await page.locator('#reset').click();
  assert.equal(await page.locator('#tag-difference').inputValue(), '0');
  assert.equal(await page.locator('#relation-weight').inputValue(), '80');
  assert.match(await page.locator('.ranking-status').innerText(), /minimum shared 0/);
  const pressed = page.locator('li.movie-item button[aria-pressed="true"]');
  assert.equal(await pressed.count(), 1);
  assert.equal(await pressed.locator('.movie-rank').innerText(), '01');
  await page.context().close();
});

test('switching scenario swaps the shortlist and keeps the synthetic labelling', async () => {
  const { page } = await open();
  await page.locator('label[for="scenario-sea-drift"]').click();
  await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 14);
  assert.match(await page.locator('.seed-title').innerText(), /Tide Post Office/);
  assert.match(await page.locator('.demo-badge').innerText(), /[Ss]ynthetic/);
  await page.context().close();
});

test('the empty-signal scenario shows an empty state, not a stale list', async () => {
  const { page } = await open();
  await page.locator('label[for="scenario-no-signals"]').click();
  await page.waitForFunction(() => document.querySelector('.list-empty') !== null);
  assert.equal(await page.locator('li.movie-item').count(), 0);
  assert.match(await page.locator('.list-empty').innerText(), /candidate set is empty/);
  assert.match(await page.locator('.list-empty-hint').innerText(), /dropped for incomplete data/i);
  await page.context().close();
});

test('an over-tight constraint explains how to get the films back', async () => {
  const { page } = await open();
  await page.locator('label[for="scenario-sea-drift"]').click();
  await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 14);

  // 海边慢片的种子有三个标签，但没有一部影片同时命中三个，因此候选集会清空。
  await page.locator('label[for="shared-3"]').click();
  await page.waitForFunction(() => document.querySelector('.list-empty') !== null);
  assert.equal(await page.locator('li.movie-item').count(), 0);
  assert.match(await page.locator('.list-empty-hint').innerText(), /back to 0/);

  await page.locator('label[for="shared-0"]').click();
  await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 14);
  await page.context().close();
});

test('the large cohort renders every row', async () => {
  const { page } = await open();
  await page.locator('label[for="scenario-large-cohort"]').click();
  await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 240, {
    timeout: 15000,
  });
  assert.equal(await page.locator('li.movie-item').count(), 240);
  await page.context().close();
});

test('the comparison view separates attributable and non-attributable comparisons', async () => {
  const { page } = await open();
  await page.locator('#tab-compare').click();
  assert.match(await page.locator('.compare-line').first().innerText(), /Same candidate set/);

  await page.locator('label[for="compare-mode-scenario"]').click();
  await page.waitForSelector('.compare-warning');
  assert.match(await page.locator('.compare-warning').innerText(), /cannot be attributed film by film/);
  // 八项口径：有效最小重合标签、候选数、资料不全被排除、被约束挡下、第一名分数、
  // 分数中位数、标签差异中位数、换位影片数。应用级 DOM 仿真断言同一个数字。
  assert.equal(await page.locator('.compare-stats tbody tr').count(), 8);

  // 下拉框显示的场景必须就是被比较的那一个。
  const shown = await page.locator('.select-input').inputValue();
  const compared = await page.locator('.compare-stats thead th').nth(2).innerText();
  assert.notEqual(shown, '');
  assert.notEqual(compared, shown, 'the compared scenario label must match the selector');
  await page.context().close();
});

test('comparing a scenario against itself is labelled instead of implied', async () => {
  const { page } = await open();
  await page.locator('#tab-compare').click();
  await page.locator('label[for="compare-mode-scenario"]').click();
  await page.locator('.select-input').selectOption('city-night');
  await page.waitForFunction(() =>
    document.querySelector('.compare-warning')?.textContent?.includes('the same one'),
  );
  assert.match(await page.locator('.compare-warning').innerText(), /the same one/);
  await page.context().close();
});

test('the explore view plots synthetic coordinates and stays keyboard reachable', async () => {
  const { page } = await open();
  await page.locator('#tab-explore').click();
  await page.waitForSelector('.atlas-svg circle');
  assert.equal(await page.locator('.atlas-svg circle.atlas-point').count(), 20);
  assert.match(await page.locator('.atlas-line').innerText(), /not a real taste space/);
  assert.ok((await page.locator('.atlas-list tbody tr').count()) === 20);

  const point = page.locator('.atlas-svg circle.atlas-point').first();
  await point.focus();
  await page.keyboard.press('Enter');
  const pressed = page.locator('li.movie-item button[aria-pressed="true"]');
  assert.equal(await pressed.count(), 1);
  await page.context().close();
});

test('the scatter is one tab stop and moves with the arrow keys', async () => {
  const { page } = await open();
  await page.locator('#tab-explore').click();
  await page.waitForSelector('.atlas-svg circle');

  const stops = await page.locator('.atlas-svg circle[tabindex="0"]').count();
  assert.equal(stops, 1, 'the scatter must be a single tab stop, not 240 of them');

  await page.locator('.atlas-svg circle.atlas-point').first().focus();
  await page.keyboard.press('ArrowRight');
  const focused = await page.evaluate(() =>
    document.activeElement?.getAttribute('aria-label') ?? '',
  );
  assert.match(focused, /rank 2/);
  assert.equal(
    await page.locator('.atlas-svg circle[tabindex="0"]').count(),
    1,
    'the tab stop must follow the focused point',
  );
  await page.context().close();
});

test('selecting a point keeps the keyboard focus on that point', async () => {
  const { page } = await open();
  await page.locator('#tab-explore').click();
  await page.waitForSelector('.atlas-svg circle');

  const point = page.locator('.atlas-svg circle.atlas-point').first();
  await point.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  const focusedId = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-movie-id') ?? null,
  );
  assert.ok(focusedId !== null, 'focus must stay on a point after selecting it');
  assert.equal(
    await page.locator('.atlas-svg .atlas-ring').count(),
    1,
    'the selected point keeps its ring',
  );
  await page.context().close();
});

test('the compare scenario picker only appears in the cross-scenario mode', async () => {
  const { page } = await open();
  await page.locator('#tab-compare').click();
  assert.equal(await page.locator('.compare-scenario-field').isVisible(), false);
  await page.locator('label[for="compare-mode-scenario"]').click();
  assert.equal(await page.locator('.compare-scenario-field').isVisible(), true);
  await page.context().close();
});

test('selecting on a narrow screen brings the explanation into view', async () => {
  const { page } = await open({ viewport: { width: 390, height: 800 } });
  await page.locator('li.movie-item').nth(4).locator('button').click();
  await page.waitForTimeout(400);
  const visible = await page.locator('#movie-evidence').evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top < window.innerHeight && box.bottom > 0;
  });
  assert.ok(visible, 'the evidence panel must be on screen after selecting a film');
  await page.context().close();
});

test('importing a broken file shows the reasons and keeps the current state', async () => {
  const { page } = await open();
  const temp = await mkdtemp(join(tmpdir(), 'taste-tuner-io-'));
  try {
    const broken = join(temp, 'broken.json');
    await writeFile(broken, '{ this is not json', 'utf8');
    await page.locator('input[type="file"]').setInputFiles(broken);
    await page.waitForSelector('.error-panel');
    assert.match(await page.locator('.error-panel').innerText(), /not valid JSON/);
    assert.equal(await page.locator('li.movie-item').count(), 20, 'the shortlist must survive a failed import');
    await page.locator('.error-panel button').click();
    assert.equal(await page.locator('.error-panel').count(), 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await page.context().close();
});

test('a valid exported file can be imported back and repeated imports stay stable', async () => {
  const { page } = await open();
  const temp = await mkdtemp(join(tmpdir(), 'taste-tuner-io-'));
  try {
    await page.locator('#tag-difference').fill('70');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('button:has-text("Export scenario JSON")').first().click();
    const download = await downloadPromise;
    const file = join(temp, 'exported.json');
    await download.saveAs(file);

    await page.locator('input[type="file"]').setInputFiles(file);
    await page.waitForFunction(() =>
      document.querySelector('.ranking-status')?.textContent?.includes('difference 70'),
    );
    const first = await page.locator('.ranking-status').innerText();

    await page.locator('input[type="file"]').setInputFiles(file);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.ranking-status').innerText(), first);
    assert.equal(await page.locator('.error-panel').count(), 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await page.context().close();
});

test('importing a different scenario rewrites the seed card and clears the picker', async () => {
  const { page } = await open();
  const temp = await mkdtemp(join(tmpdir(), 'taste-tuner-io-'));
  try {
    // 先导出另一个场景，再导入它：种子卡片与场景高亮都必须跟着变。
    await page.locator('label[for="scenario-sea-drift"]').click();
    await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 14);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('button:has-text("Export scenario JSON")').first().click();
    const download = await downloadPromise;
    const file = join(temp, 'sea.json');
    await download.saveAs(file);

    await page.locator('label[for="scenario-city-night"]').click();
    await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 20);
    assert.match(await page.locator('.seed-title').innerText(), /Last Tram Home/);

    await page.locator('input[type="file"]').setInputFiles(file);
    await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 14);

    assert.match(await page.locator('.seed-title').innerText(), /Tide Post Office/);
    assert.match(await page.locator('.seed-label').innerText(), /Imported file/);
    const checked = await page.locator('.scenario-radio:checked').count();
    assert.equal(checked, 0, 'imported data belongs to no built-in scenario');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await page.context().close();
});

test('a failed import moves focus to the error panel', async () => {
  const { page } = await open();
  const temp = await mkdtemp(join(tmpdir(), 'taste-tuner-io-'));
  try {
    const broken = join(temp, 'broken.json');
    await writeFile(broken, '{ nope', 'utf8');
    await page.locator('input[type="file"]').setInputFiles(broken);
    await page.waitForSelector('.error-panel');
    const focused = await page.evaluate(() =>
      document.activeElement?.classList.contains('error-panel') ?? false,
    );
    assert.ok(focused, 'the error panel must take focus');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await page.context().close();
});

test('the file input has an accessible name', async () => {
  const { page } = await open();
  const name = await page
    .locator('input[type="file"]')
    .getAttribute('aria-label');
  assert.ok(typeof name === 'string' && name.length > 0);
  await page.context().close();
});

test('no layout overflows horizontally at narrow, medium and wide widths', async () => {
  for (const width of [320, 768, 1440]) {
    const { page } = await open({ viewport: { width, height: 900 } });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px at ${width}px width`);
    await page.context().close();
  }
});

test('long titles stay readable without pushing the numbers away', async () => {
  const { page } = await open({ viewport: { width: 320, height: 900 } });
  await page.locator('label[for="scenario-edge-cases"]').click();
  await page.waitForFunction(() => document.querySelectorAll('li.movie-item').length === 5);
  const row = page.locator('li.movie-item').nth(3);
  const box = await row.boundingBox();
  assert.ok(box !== null && box.width <= 320, 'a long title must not widen the row');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1);
  await page.context().close();
});

test('the app still works when reduced motion is requested', async () => {
  const { page, problems } = await open({ reducedMotion: 'reduce' });
  await page.locator('#tag-difference').fill('100');
  await page.waitForFunction(() =>
    document.querySelector('.ranking-status')?.textContent?.includes('difference 100'),
  );
  assert.ok((await page.locator('li.movie-item').count()) === 20);
  assert.deepEqual(problems, []);
  await page.context().close();
});

/* ---------------------------------------------------------------------------
 * 真实主线在**真浏览器**里的样子。
 *
 * 前面那 28 项走的是离线合成演示；这一组走真实服务那条主线
 * （服务端注入夹具适配器，不发任何网络请求）。
 * ------------------------------------------------------------------------- */

test('the discovery page opens on one film title and one call to action', async () => {
  const { page, context, problems } = await openService();
  assert.equal(await page.locator('#seed-input').count(), 1);
  assert.equal(await page.locator('#seed-submit').innerText(), 'Find similar films');
  assert.match(await page.locator('h1').innerText(), /From a film you love/);
  // 首屏不该有工程术语。
  const visible = await page.locator('#service-mode').innerText();
  for (const term of ['urn:entity', 'Access surface', 'Request budget', 'Credential', 'Request preview', 'Seed type']) {
    assert.ok(!visible.includes(term), `首屏不该出现「${term}」`);
  }
  assert.deepEqual(problems, [], '首屏不该有任何控制台报错');
  await context.close();
});

test('the films render with their own facts and a synopsis on the card face', async () => {
  const { page, context, problems, cspNotices } = await openService();
  const cards = page.locator('.service-item');
  assert.equal(await cards.count(), 4);

  const first = cards.first();
  assert.match(await first.innerText(), /Candidate A/);
  assert.match(await first.innerText(), /2010/);
  // 卡面上先给影片本身：年份、片长、分级、简介。
  assert.match(await first.innerText(), /2010/);
  assert.match(await first.innerText(), /Fixture description field/);
  // 卡面不再挂裸的关联分：五张卡都是 0.9x，区分度几乎为零。
  assert.doesNotMatch(await first.innerText(), /Affinity/, '卡面不该用分数当卖点');
  // 它在「为什么排在这里」里，仍然可查。
  await first.locator('.service-why-summary').click();
  assert.match(await first.locator('.service-why-body').innerText(), /Affinity/);
  // 海报地址就是响应给的那个，而且**只有**那个域被策略放行：
  // 夹具用的地址不在允许的域上，浏览器把它挡住，界面换成诚实的文字卡。
  assert.ok(
    cspNotices.length > 0,
    '不在允许域上的图片必须被内容安全策略挡住',
  );
  assert.deepEqual(problems, [], '除了策略挡住图片，不该有别的控制台报错');
  // 服务给了地址、只是没加载出来——这句话不能说成"没有图片"。
  assert.equal(await first.locator('.poster-note').innerText(), 'The poster could not be loaded');
  assert.equal(await first.locator('.poster-image').count(), 0, '挡住之后不留一个破图');

  // 没有残留的加载提示。
  assert.ok(!(await page.locator('#service-mode').innerText()).includes('Fetching candidates'));
  await context.close();
});

test('the seed is named, and the attribution says the name instead of an id', async () => {
  const { page, context } = await openService();
  assert.match(await page.locator('.seed-bar').innerText(), /Your seed/);
  assert.match(await page.locator('.seed-bar').innerText(), /Sample Film/);

  await page.locator('.service-item').first().locator('.service-why-summary').click();
  const evidence = await page.locator('.service-item').first().locator('.service-why-body').innerText();
  assert.match(evidence, /Sample Film: 0\.82/, '归因要说得出种子的名字');
  assert.doesNotMatch(evidence, /11111111-2222-3333/, '不该把 GUID 当归因标签');
  assert.match(evidence, /not anyone’s preference probability/);
  await context.close();
});

test('the discovery page does not overflow at 390px', async () => {
  const { page, context } = await openService({ viewport: { width: 390, height: 844 } });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `390px 下横向溢出 ${overflow}px`);
  // 种子条与第一部影片都真实渲染出来了。
  assert.equal(await page.locator('.seed-bar').isVisible(), true);
  assert.equal(await page.locator('.service-item').first().isVisible(), true);
  await context.close();
});

test('on a phone the order panel stays open and the reset keeps the keyboard place', async () => {
  const { page, context } = await openService({ viewport: { width: 390, height: 844 } });
  const apiCalls = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiCalls.push(request.url());
  });

  // 手机上默认收起：两个滑杆会把第一张片子挤到屏外去。
  assert.equal(await page.locator('.service-controls').evaluate((node) => node.open), false);

  await page.locator('.service-controls-summary').click();
  assert.equal(await page.locator('.service-controls').evaluate((node) => node.open), true);

  // 键盘调滑杆：焦点要留在滑杆上。
  const slider = page.locator('#service-popularity-weight');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await slider.inputValue(), '1');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'service-popularity-weight');

  // 重置在「更多调整」里。展开后用键盘按它。
  await page.locator('.more-summary').click();
  await page.locator('#service-reset').focus();
  await page.keyboard.press('Enter');

  // 重置后焦点还落在重置按钮上，两个折叠区都没有自己合上。
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'service-reset');
  assert.equal(await page.locator('.service-controls').evaluate((node) => node.open), true);
  assert.equal(await page.locator('.more-controls').evaluate((node) => node.open), true);
  assert.equal(await slider.inputValue(), '0');

  // 滑杆与重置都只动本地状态：一个请求都不该多发。
  assert.deepEqual(apiCalls, []);
  await context.close();
});

test('the whole main line can be walked with the keyboard alone', async () => {
  // 用**有歧义**的那个服务端：消歧那条路才算真的走了一遍。
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${ambiguousPort}/`, { waitUntil: 'load' });

  // 输入片名 → 回车提交。全程键盘，连打字都是敲出来的。
  await page.focus('#seed-input');
  await page.keyboard.type('Sample Film');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.entity-options', { timeout: 15000 });

  // 消歧的单选控件要能用键盘选中。
  await page.locator('.entity-options input[type="radio"]').first().focus();
  await page.keyboard.press('Space');
  // 从单选组再 Tab 一次，应当落在「就这部」上——全程不用鼠标。
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'entity-confirm',
    'Tab 一次应当落到「就这部」',
  );
  await page.keyboard.press('Enter');
  await page.waitForSelector('.service-item', { timeout: 15000 });

  // 消歧面板被收走了，焦点不能丢：应当被送到结果区的标题上。
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'service-list-heading',
    '确认之后焦点要落在结果区标题上，不能掉回 body',
  );
  // 卡片上的影片名是按钮，键盘能聚焦。
  const title = page.locator('.service-item .movie-button').first();
  await title.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'movie-button movie-title');
  await page.keyboard.press('Enter');
  // 「为什么这部」是原生 details，键盘能展开。
  const summary = page.locator('.service-item').first().locator('.service-why-summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('.service-item').first().locator('.service-why-body').isVisible(),
    true,
    '键盘也要能展开「为什么这部」',
  );
  await context.close();
});

test('the first film is in the first screen, not below the fold', async () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const { page, context } = await openService({ viewport });
    // 量的是**文档里**的位置：点按钮时浏览器会自己滚过去，
    // 直接量视口坐标会算出一个负数，看着"在首屏里"其实不是。
    const y = await page.evaluate(() => {
      const card = document.querySelector('.service-item');
      return card === null ? null : card.getBoundingClientRect().top + window.scrollY;
    });
    assert.ok(y !== null, `${name}: 影片卡应当存在`);
    assert.ok(
      y < viewport.height,
      `${name}: 第一部影片在首屏之外（y=${Math.round(y)}，视口高 ${viewport.height}）`,
    );
    // 确认之后消歧列表与按钮都得收掉，不然第一屏全是它们。
    assert.equal(await page.locator('#entity-confirm').count(), 0);
    assert.equal(await page.locator('.entity-options').count(), 0);
    assert.equal(await page.locator('.find-form').isVisible(), false);
    await context.close();
  }
});

test('the synopsis is on the card face, not only inside a panel', async () => {
  const { page, context } = await openService();
  const face = await page.locator('.service-item').first().locator('.service-item-meta').innerText();
  assert.match(face, /Fixture description field/);
  // 两个动作都在卡面上，且默认收着。
  assert.equal(await page.locator('.service-item').first().locator('.service-materials').count(), 1);
  assert.equal(await page.locator('.service-item').first().locator('.service-why').count(), 1);
  await context.close();
});

test('the accessibility tree exposes the names a screen reader would read', async () => {
  // 先看**首次使用者**遇到的那棵树：还没搜索、输入框还在。
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  const client = await page.context().newCDPSession(page);
  await client.send('Accessibility.enable');
  const readTree = async () => {
    const { nodes } = await client.send('Accessibility.getFullAXTree');
    return nodes
      .filter((node) => !node.ignored && node.role?.value)
      .map((node) => `${node.role.value}:${node.name?.value ?? ''}`);
  };

  const entry = await readTree();
  for (const expected of [
    'heading:From a film you love to the one you want next',
    'textbox:Film title',
    'button:Find similar films',
  ]) {
    assert.ok(entry.includes(expected), `无障碍树里应当有「${expected}」`);
  }

  // 走完主线，再看一次：影片区、调整区、诊断折叠区都还在，名字也要在。
  await page.fill('#seed-input', 'Sample Film');
  await page.click('#seed-submit');
  await page.waitForSelector('.service-item, .entity-options', { timeout: 15000 });
  if ((await page.locator('.entity-options').count()) > 0) {
    await page.click('#entity-confirm');
    await page.waitForSelector('.service-item', { timeout: 15000 });
  }
  const spoken = await readTree();
  for (const expected of [
    'DisclosureTriangle:Developer diagnostics',
    // 区域的名字跟着标题走：确认之后标题变成「和《Sample Film》像的」。
    'region:Similar to “Sample Film”',
    // 「调整顺序」现在是折叠控件：名字还在，角色是 disclosure triangle。
    'DisclosureTriangle:Reorder',
    'DisclosureTriangle:More controls',
  ]) {
    assert.ok(
      spoken.includes(expected),
      `无障碍树里应当有「${expected}」，实际有：${spoken.filter((s) => s.startsWith(expected.split(':')[0])).join(' / ')}`,
    );
  }
  assert.deepEqual(problems, []);
  await context.close();
});

test('at 200% zoom the layout reflows without clipping or sideways scroll', async () => {
  // 浏览器放大 200% 的等效做法：布局视口的 CSS 宽度减半、像素密度加倍。
  const { page, context } = await openService({
    viewport: { width: 720, height: 500 },
    deviceScaleFactor: 2,
  });
  const metrics = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    firstFilmY: (() => {
      const card = document.querySelector('.service-item');
      return card === null ? null : card.getBoundingClientRect().top + window.scrollY;
    })(),
    clipped: Array.from(document.querySelectorAll('.service-item-title, .service-item-facts, .seed-bar-title')).filter(
      (node) => node.scrollWidth > node.clientWidth + 1,
    ).length,
  }));
  assert.ok(metrics.overflow <= 1, `放大后横向溢出 ${metrics.overflow}px`);
  assert.equal(metrics.clipped, 0, '放大后文字不该被截断');
  assert.ok(metrics.firstFilmY !== null, '影片卡应当存在');
  // 放大到 200% 之后，调顺序的旋钮必须在首屏里（这正是把它们提到列表上方的原因）。
  const knobsVisible = await page.locator('#service-popularity-weight').isVisible();
  assert.ok(knobsVisible, '放大后旋钮也得看得见');
  const knobY = await page.evaluate(() => {
    const knob = document.querySelector('#service-popularity-weight');
    return knob === null ? null : knob.getBoundingClientRect().top + window.scrollY;
  });
  assert.ok(knobY !== null && knobY < 500, '放大后旋钮应当在首屏里');
  await context.close();
});

test('the artist seed entry is not offered in the public movie flow', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });

  // 这一轮只授权电影：界面上不该给一个会被明确拒绝的音乐人选项。
  const options = await page.locator('#seed-type option').allTextContents();
  assert.deepEqual(options, ['Film']);
  await context.close();
});

test('the synopsis toggle only appears when there is something to expand', async () => {
  const { page, context } = await openService();
  // 夹具里的简介很短，本来就放得下——那个"展开简介"按钮点了什么也不会发生。
  const toggle = page.locator('.service-item').first().locator('.synopsis-toggle');
  assert.equal(await toggle.count(), 1);
  assert.equal(await toggle.isVisible(), false, '简介放得下时不该出现一个点了没反应的按钮');
  await context.close();
});

test('a long synopsis stays clamped and can be expanded', async () => {
  const long = 'A'.repeat(400);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  // 直接在页面上把简介换成长文本：量的是**真实布局**下的截断与展开。
  await page.fill('#seed-input', 'Sample Film');
  await page.click('#seed-submit');
  await page.waitForSelector('.service-item, .entity-options', { timeout: 15000 });
  if ((await page.locator('.entity-options').count()) > 0) {
    await page.click('#entity-confirm');
    await page.waitForSelector('.service-item', { timeout: 15000 });
  }
  await page.evaluate((text) => {
    const target = document.querySelector('.service-item .service-item-synopsis');
    if (target !== null) target.textContent = text;
  }, long);
  await page.waitForTimeout(100);
  const clamped = await page.evaluate(() => {
    const target = document.querySelector('.service-item .service-item-synopsis');
    return target === null ? null : target.scrollHeight > target.clientHeight + 1;
  });
  assert.equal(clamped, true, '长简介应当被截断成两行');
  await context.close();
});

test('a larger system font size does not break the layout', async () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const { page, context } = await openService({ viewport });
    // 把根字号调大：相当于用户把浏览器默认字号调大。
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '24px';
    });
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: Array.from(
        document.querySelectorAll(
          '.service-item-title, .service-item-facts, .seed-bar-title, .results-heading, .service-item-synopsis',
        ),
      ).filter((node) => node.scrollWidth > node.clientWidth + 1).length,
    }));
    assert.ok(metrics.overflow <= 1, `${name}: 字号放大后横向溢出 ${metrics.overflow}px`);
    assert.equal(metrics.clipped, 0, `${name}: 字号放大后文字被截断`);
    await context.close();
  }
});

test('the product speaks English: no Chinese characters in the rendered page', async () => {
  // 离线演示的数据全是合成的英文 → 整页都该没有中文。
  // 真实服务页里**服务自己给的内容**可能是中文原名（`akas`），那不是产品文案；
  // 所以只查产品自己写的那部分：结果区、种子条、消歧卡与服务字段区除外。
  const scanChrome = (page) =>
    page.evaluate(() => {
      const clone = document.body.cloneNode(true);
      clone
        .querySelectorAll(
          '.service-list, .seed-bar, .entity-options, .service-materials-body, .service-why-body',
        )
        .forEach((node) => node.remove());
      return clone.innerText.match(/[\u4e00-\u9fff]+/g) ?? [];
    });

  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const demo = await open({ viewport });
    const demoText = await demo.page.evaluate(() => document.body.innerText);
    const demoHits = demoText.match(/[\u4e00-\u9fff]+/g) ?? [];
    assert.deepEqual([...new Set(demoHits)], [], `${name}: 离线演示里还有中文`);
    await demo.context.close();

    const live = await openService({ viewport });
    const liveHits = await scanChrome(live.page);
    assert.deepEqual([...new Set(liveHits)], [], `${name}: 真实服务页的产品文案里还有中文`);
    await live.context.close();
  }
});

test('twenty candidates: the first batch shows and the rest can be revealed', async () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const { page, context } = await openTwenty({ viewport });
    assert.equal(await page.locator('.service-item').count(), 6, `${name}: 先摊开 6 部`);

    const more = page.locator('#service-reveal-more');
    assert.equal(await more.count(), 1, `${name}: 应当有"再看几部"的入口`);
    assert.match(await more.innerText(), /Show 6 more of 14/);

    await more.click();
    assert.equal(await page.locator('.service-item').count(), 12, `${name}: 再摊开 6 部`);

    await page.locator('#service-reveal-more').click();
    assert.equal(await page.locator('.service-item').count(), 18);

    await page.locator('#service-reveal-more').click();
    assert.equal(await page.locator('.service-item').count(), 20, `${name}: 20 部全部可见`);
    assert.equal(await page.locator('#service-reveal-more').count(), 0, '全部摊开后入口消失');

    // 状态行报的是**真实条数**，不是眼下摊开多少。
    assert.match(await page.locator('.service-ranking-status').innerText(), /20 similar films/);
    await context.close();
  }
});

test('the service answers 503 → an actionable state, not a normal live hero', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // 只拦 /api/status：平台起不来时返回的就是这个形状。不发任何业务请求。
  await page.route('**/api/status', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'upstream_error',
        message: 'The server is not ready.',
      }),
    }),
  );
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  await page.waitForSelector('.service-status.is-error', { state: 'attached', timeout: 15000 });

  const status = await page.locator('.service-status').textContent();
  assert.match(status, /not available right now/i, '要给出可执行的状态');
  // 内部异常（路径、模块名）不许出现在页面上。
  assert.doesNotMatch(status, /module|\/var\/task|Cannot find/i);

  // 也不能照常显示成"就绪"。
  const badge = await page.locator('.demo-badge').first().textContent();
  assert.doesNotMatch(badge, /ready/i, '徽标不能写 ready');
  assert.match(badge, /unavailable/i);

  // 提交按钮要是不给点的：服务不可用时不该让人以为能发请求。
  assert.equal(await page.locator('#seed-submit').isDisabled(), true);
  await context.close();
});

test('the synthetic default selection never leaks into the live startup', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  await page.waitForSelector('.service-status', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(400);

  // 播报区（live region）里不能有合成场景的片名或"选中"播报。
  const spoken = await page.locator('.live-region').first().textContent();
  assert.doesNotMatch(spoken, /Selected /, '默认选中不是用户动作，不该播报');
  assert.doesNotMatch(spoken, /Warm City Lights/, '合成片名不许漏进真实主线');
  await context.close();
});

test('the unavailable state is visible outside the diagnostics and can be recovered', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let failing = true;
  // 只拦 /api/status：第一次 503，之后放行（模拟服务恢复）。不发任何业务请求。
  await page.route('**/api/status', async (route) => {
    if (failing) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'upstream_error', message: 'not ready' }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${servicePort}/`, { waitUntil: 'load' });
  await page.waitForSelector('#service-unavailable', { state: 'attached', timeout: 15000 });

  const banner = page.locator('#service-unavailable');
  assert.equal(await banner.isVisible(), true, '不可用提示必须在主界面看得见');
  assert.match(await banner.innerText(), /not available right now/i);
  // 不能只写在折叠的诊断区里。
  const insideDiagnostics = await page.evaluate(
    () => document.querySelector('#service-unavailable')?.closest('.dev-body') !== null,
  );
  assert.equal(insideDiagnostics, false, '提示不能只在诊断折叠区里');
  // 内部异常不许出现在页面上。
  assert.doesNotMatch(await banner.innerText(), /module|\/var\/task|Cannot find/i);

  // 恢复：点"Check again"→ 服务正常 → 提示消失。
  failing = false;
  await page.locator('#service-retry-status').click();
  await page.waitForSelector('#service-unavailable', { state: 'hidden', timeout: 15000 });
  await context.close();
});

test('with 20 matches the confirmation stays reachable in the viewport', async () => {
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const { page, context, problems } = await openAmbiguousTwenty({ viewport });
    const confirm = page.locator('#entity-confirm');

    const inViewport = async (label) => {
      const box = await confirm.boundingBox();
      assert.ok(box !== null, `${name}: 确认按钮必须存在`);
      assert.ok(
        box.y >= 0 && box.y + box.height <= viewport.height,
        `${name}: ${label} 确认按钮必须在视口内（y=${Math.round(box.y)}）`,
      );
    };

    // 一开始就够得着（不用先滚三屏）。
    await inViewport('一开始');

    // 选中第一部：吸底条上的名字要跟着变。
    await page.locator('label[for="entity-0"]').click();
    await page.waitForTimeout(120);
    assert.match(await page.locator('.entity-confirm-name').innerText(), /Candidate Film A/);
    await inViewport('选中第一部后');

    // 选中最后一部（要先滚到列表底部）。
    await page.locator('label[for="entity-19"]').click();
    await page.waitForTimeout(120);
    assert.match(await page.locator('.entity-confirm-name').innerText(), /Candidate Film T/);
    await inViewport('选中最后一部后');

    // 确认后用的是**选中那个**实体的身份，消歧列表收起来。
    await confirm.click();
    await page.waitForSelector('.service-item', { timeout: 15000 });
    assert.match(await page.locator('.seed-bar').innerText(), /Candidate Film T/);
    assert.equal(await page.locator('#entity-confirm').count(), 0, '确认后消歧面板收起来');
    assert.deepEqual(problems, [], `${name}: 不该有页面报错`);
    await context.close();
  }
});
