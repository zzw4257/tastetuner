import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createImportIntent } from '../dist/assets/core/import-intent.js';
import { updateAtlasSelection } from '../dist/assets/ui/atlas.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('latest import intent wins when B resolves before A', async () => {
  const intent = createImportIntent();
  const a = deferred();
  const b = deferred();

  const aResult = intent.run(() => a.promise);
  const bResult = intent.run(() => b.promise);

  b.resolve('B');
  assert.deepEqual(await bResult, { status: 'current', ok: true, value: 'B' });

  a.resolve('A');
  assert.deepEqual(await aResult, { status: 'stale' });
});

test('invalidating a pending read makes its later success stale', async () => {
  const intent = createImportIntent();
  const pending = deferred();
  const result = intent.run(() => pending.promise);

  intent.invalidate();
  pending.resolve('old');

  assert.deepEqual(await result, { status: 'stale' });
});

test('a stale rejection is silent and carries no error', async () => {
  const intent = createImportIntent();
  const failure = new Error('old read failed');
  const result = intent.run(() => Promise.reject(failure));

  intent.invalidate();

  assert.deepEqual(await result, { status: 'stale' });
});

test('a current read rejection remains reportable', async () => {
  const intent = createImportIntent();
  const failure = new Error('current read failed');
  const outcome = await intent.run(() => Promise.reject(failure));

  assert.equal(outcome.status, 'current');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, failure);
});

test('a newest invalid read cancels an older successful pending read', async () => {
  const intent = createImportIntent();
  const old = deferred();
  const oldResult = intent.run(() => old.promise);

  const newest = await intent.run(() => Promise.reject(new Error('invalid file')));
  assert.equal(newest.status, 'current');
  assert.equal(newest.ok, false);

  old.resolve('must not import');
  assert.deepEqual(await oldResult, { status: 'stale' });
});

test('limited static contract: app uses the tested helper and invalidates intended actions', async () => {
  const appSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

  assert.ok(appSource.includes('createImportIntent'));
  assert.ok(appSource.includes('importIntent.run'));

  const importStart = appSource.indexOf('view.importInput.addEventListener');
  const importEnd = appSource.indexOf('// 首屏', importStart);
  assert.ok(importStart >= 0 && importEnd > importStart);
  const importHandler = appSource.slice(importStart, importEnd);

  assert.ok(importHandler.includes('importIntent.invalidate()'));
  assert.ok(
    importHandler.indexOf('importIntent.invalidate()') <
      importHandler.indexOf('file.size >'),
  );

  const staleAt = importHandler.indexOf(`outcome.status === 'stale'`);
  const failureAt = importHandler.indexOf('if (!outcome.ok)');
  assert.ok(staleAt >= 0 && staleAt < failureAt);
  const staleBranch = importHandler.slice(staleAt, failureAt);
  assert.ok(staleBranch.includes('return;'));
  assert.ok(!staleBranch.includes('showError'));
  assert.ok(importHandler.includes('Could not read the imported file'));
  assert.ok(importHandler.includes('the current scenario is unchanged'));

  const resetAt = appSource.indexOf('view.reset.addEventListener');
  const scenarioAt = appSource.indexOf('for (const input of view.scenarioInputs)');
  const tabsAt = appSource.indexOf('view.tabs.forEach');
  assert.ok(resetAt >= 0 && scenarioAt > resetAt && tabsAt > scenarioAt);
  assert.ok(appSource.slice(resetAt, scenarioAt).includes('importIntent.invalidate()'));
  assert.ok(appSource.slice(scenarioAt, tabsAt).includes('importIntent.invalidate()'));
});

test('limited static contract: export serialization failure is caught before download', async () => {
  const appSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');
  const exportAt = appSource.indexOf('view.exportButton.addEventListener');
  const importButtonAt = appSource.indexOf('view.importButton.addEventListener');
  assert.ok(exportAt >= 0 && importButtonAt > exportAt);

  const exportHandler = appSource.slice(exportAt, importButtonAt);
  assert.ok(exportHandler.includes('try {'));
  assert.ok(exportHandler.includes('catch (error)'));
  assert.ok(exportHandler.includes('Export failed'));
  assert.ok(exportHandler.indexOf('catch (error)') < exportHandler.indexOf('new Blob'));
});

test('limited static contract: compare exposes and discloses per-side effective thresholds', async () => {
  const compareSource = await readFile(new URL('../src/ui/compare.ts', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../src/ui/app.ts', import.meta.url), 'utf8');

  assert.ok(compareSource.includes('readonly effectiveMinSharedTags: number;'));
  assert.ok(compareSource.includes('Effective minimum shared tags'));
  assert.ok(compareSource.includes('different effective minimum shared tags thresholds'));
  assert.ok(compareSource.includes('Both columns use the same scenario'));
  assert.ok(appSource.includes('otherSource.id === source.id'));
  assert.ok(appSource.includes('otherEffectiveMinSharedTags'));
});

test('limited static contract: atlas points initialize and update aria-pressed', async () => {
  const atlasSource = await readFile(new URL('../src/ui/atlas.ts', import.meta.url), 'utf8');

  assert.ok(atlasSource.includes(`'aria-pressed': isSelected`));
  assert.ok(/setAttribute\s*\(\s*'aria-pressed'/.test(atlasSource));
});

test('Node-only behavior: updateAtlasSelection updates circles and fallback rows', () => {
  const makePoint = (id) => {
    const attributes = {
      'data-movie-id': id,
      cx: '10',
      cy: '20',
    };
    return {
      setAttribute(name, value) {
        attributes[name] = String(value);
      },
      getAttribute(name) {
        return name in attributes ? attributes[name] : null;
      },
      before() {},
    };
  };

  const makeRow = (id) => {
    const attributes = { 'data-movie-id': id };
    return {
      getAttribute(name) {
        return name in attributes ? attributes[name] : null;
      },
      classList: {
        values: new Set(),
        toggle(name, force) {
          if (force) this.values.add(name);
          else this.values.delete(name);
        },
        contains(name) {
          return this.values.has(name);
        },
      },
    };
  };

  const points = [makePoint('movie-a'), makePoint('movie-b')];
  const rows = [makeRow('movie-a'), makeRow('movie-b'), makeRow('table-only')];

  // Minimal DOM stub for the APIs used by updateAtlasSelection.
  const svg = {
    querySelectorAll(selector) {
      assert.equal(selector, 'circle[data-movie-id]');
      return points;
    },
    querySelector(selector) {
      if (selector === '.atlas-ring') return null;
      const match = /^circle\[data-movie-id="(.*)"\]$/.exec(selector);
      if (match === null) return null;
      return points.find((point) => point.getAttribute('data-movie-id') === match[1]) ?? null;
    },
  };
  const container = {
    querySelector(selector) {
      assert.equal(selector, 'svg');
      return svg;
    },
  };
  const table = {
    querySelectorAll(selector) {
      assert.equal(selector, 'tr');
      return rows;
    },
  };

  const previousDocument = globalThis.document;
  const previousCSS = globalThis.CSS;

  try {
    globalThis.document = {
      createElementNS(namespace, tag) {
        const attributes = {};
        return {
          namespace,
          tag,
          setAttribute(name, value) {
            attributes[name] = String(value);
          },
          getAttribute(name) {
            return name in attributes ? attributes[name] : null;
          },
        };
      },
    };
    globalThis.CSS = {
      escape: (value) => value,
    };

    updateAtlasSelection(container, table, 'movie-a');
    assert.deepEqual(
      points.map((point) => point.getAttribute('aria-pressed')),
      ['true', 'false'],
    );
    assert.equal(rows[0].classList.contains('is-selected'), true);
    assert.equal(rows[1].classList.contains('is-selected'), false);

    updateAtlasSelection(container, table, 'movie-b');
    assert.deepEqual(
      points.map((point) => point.getAttribute('aria-pressed')),
      ['false', 'true'],
    );
    assert.equal(rows[0].classList.contains('is-selected'), false);
    assert.equal(rows[1].classList.contains('is-selected'), true);

    updateAtlasSelection(container, table, null);
    assert.deepEqual(
      points.map((point) => point.getAttribute('aria-pressed')),
      ['false', 'false'],
    );
    assert.equal(rows[0].classList.contains('is-selected'), false);
    assert.equal(rows[1].classList.contains('is-selected'), false);

    updateAtlasSelection(container, table, 'table-only');
    assert.deepEqual(
      points.map((point) => point.getAttribute('aria-pressed')),
      ['false', 'false'],
    );
    assert.equal(rows[2].classList.contains('is-selected'), true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;

    if (previousCSS === undefined) delete globalThis.CSS;
    else globalThis.CSS = previousCSS;
  }
});

test('limited static contract: the platform config mirrors the app security headers', async () => {
  const serve = await readFile(new URL('../scripts/serve.mjs', import.meta.url), 'utf8');
  // 源码树里在 release/，候选树里在根目录：两处都要能读到。
  const releaseConfig = new URL('../release/vercel.json', import.meta.url);
  const rootConfig = new URL('../vercel.json', import.meta.url);
  const configUrl = existsSync(releaseConfig) ? releaseConfig : rootConfig;
  const vercel = JSON.parse(await readFile(configUrl, 'utf8'));

  // 应用自己的策略（CSP / nosniff / no-referrer）是基准。
  const csp = /'Content-Security-Policy':\s*`([^`]+)`/.exec(serve)?.[1];
  const nosniff = /'X-Content-Type-Options':\s*'([^']+)'/.exec(serve)?.[1];
  const referrer = /'Referrer-Policy':\s*'([^']+)'/.exec(serve)?.[1];
  assert.ok(csp !== undefined && nosniff !== undefined && referrer !== undefined);

  // 平台静态资源必须带**同一套**头——Vercel 不经过应用服务器，那边不设就没有。
  const headers = vercel.headers?.[0]?.headers ?? [];
  const get = (key) => headers.find((item) => item.key === key)?.value;
  assert.equal(get('Content-Security-Policy'), csp, 'CSP 必须与应用一致');
  assert.equal(get('X-Content-Type-Options'), nosniff);
  assert.equal(get('Referrer-Policy'), referrer);
  // 不许放宽：策略里不能出现通配符或多余的外部域。
  assert.doesNotMatch(get('Content-Security-Policy') ?? '', /\*/);
});
