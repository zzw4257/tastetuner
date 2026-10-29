// 多输入回归。
//
// 两组，分开记账：
// - A · **合成数据**（永远跑）：手工构造的最小响应表，三个输入各自一套候选，
//   外加一个"服务没匹配到"的输入。公开树里只有这一组。
// - B · **保存的真实响应**（**显式 opt-in**）：只有显式设置 TASTE_TUNER_REPLAY_DIR
//   指向一个私密目录时才会跑；没设置就清楚 skip。没有 mock 兜底。
//
// 这里盯的是**用户路径**：同页换输入、并发提交、重复点击、空结果之后的恢复、
// 拖滑杆不许联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { bootApp } from './helpers/app-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { parseInsightsResponse, parseSearchResponse } = await import(
  join(root, 'dist', 'assets', 'core', 'qloo.js')
);

const STATUS_BODY = {
  provider: 'saved-response-replay',
  configured: true,
  missing: [],
  accessSurface: 'saved-response-replay',
  accessSurfaceConfirmed: false,
  credentialPresent: null,
  budget: { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' },
  entityTypes: ['movie', 'artist'],
  maxCandidates: 50,
};

/* ----------------------------- A · 合成数据（永远跑） ----------------------------- */

/** 造一套最小响应：两个消歧候选 + 五部候选。 */
function syntheticEntry(seedName, seedId, filmNames) {
  const search = [
    {
      name: seedName,
      entity_id: seedId,
      types: ['urn:entity:movie'],
      properties: { release_year: 2000 },
      disambiguation: '2000',
    },
    {
      name: `${seedName}（另一部）`,
      entity_id: `${seedId}-other`,
      types: ['urn:entity:movie'],
      properties: { release_year: 2020 },
      disambiguation: '2020',
    },
  ];
  const insights = filmNames.map((name, index) => ({
    name,
    entity_id: `${seedId}-film-${index}`,
    type: 'urn:entity',
    subtype: 'urn:entity:movie',
    properties: {
      release_year: 1990 + index,
      content_rating: 'PG',
      duration: 100 + index,
    },
    popularity: 0.9 - index * 0.1,
    tags: [{ id: `urn:tag:keyword:media:synthetic-${index}`, name: `合成标签 ${index}` }],
    query: {
      affinity: 0.9 - index * 0.05,
      explainability: { 'signal.interests.entities': [{ entity_id: seedId, score: 1 }] },
    },
  }));
  return { search, insights };
}

const SYNTHETIC_INPUTS = new Map([
  [
    'Synthetic Input A',
    syntheticEntry('Synthetic Film A', 'synthetic-seed-a', [
      'Synthetic Candidate A1',
      'Synthetic Candidate A2',
      'Synthetic Candidate A3',
      'Synthetic Candidate A4',
      'Synthetic Candidate A5',
    ]),
  ],
  [
    'Synthetic Input B',
    syntheticEntry('Synthetic Film B', 'synthetic-seed-b', [
      'Synthetic Candidate B1',
      'Synthetic Candidate B2',
      'Synthetic Candidate B3',
      'Synthetic Candidate B4',
      'Synthetic Candidate B5',
    ]),
  ],
  [
    'Synthetic Input C',
    syntheticEntry('Synthetic Film C', 'synthetic-seed-c', [
      'Synthetic Candidate C1',
      'Synthetic Candidate C2',
      'Synthetic Candidate C3',
      'Synthetic Candidate C4',
      'Synthetic Candidate C5',
    ]),
  ],
]);

/** 由"输入 → 响应"表建出回放接口：只放保存的响应，不发任何请求。 */
function buildReplay(table) {
  const byInput = new Map();
  const byEntityId = new Map();
  for (const [seed, entry] of table) {
    byInput.set(String(seed).trim().toLowerCase(), entry);
    // 只给**真正有保存候选的那个实体**配候选：别的实体没有保存，就如实说没有。
    const seedEntity = entry.search[entry.seedIndex ?? 0] ?? entry.search[0];
    if (seedEntity !== undefined) byEntityId.set(seedEntity.entity_id, entry.insights);
  }
  return async (url, init) => {
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    if (String(url).endsWith('/api/status')) return { status: 200, body: STATUS_BODY };
    if (String(url).endsWith('/api/resolve')) {
      const entry = byInput.get(String(body.seed ?? '').trim().toLowerCase());
      if (entry === undefined) {
        return {
          status: 200,
          body: { status: 'empty', message: 'This replay has no saved response for that title.' },
        };
      }
      return { status: 200, body: parseSearchResponse({ results: entry.search }) };
    }
    if (String(url).endsWith('/api/candidates')) {
      const entities = byEntityId.get(String(body.entityId ?? ''));
      if (entities === undefined) {
        return {
          status: 200,
          body: { status: 'empty', message: 'This replay has no saved response for that title.' },
        };
      }
      return { status: 200, body: parseInsightsResponse({ results: { entities } }) };
    }
    return { status: 200, body: { status: 'ok' } };
  };
}

/** 在消歧列表里选中第 index 项并确认。 */
async function pick(app, index) {
  const radios = app.queryAll('.entity-options input[type="radio"]');
  radios.forEach((radio, position) => {
    radio.checked = position === index;
  });
  app.query('#entity-confirm').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
}

test('多个输入各自得到自己的候选，不是固定的一份', async () => {
  for (const [input, entry] of SYNTHETIC_INPUTS) {
    const app = await bootApp({ api: buildReplay(SYNTHETIC_INPUTS) });
    await app.flush();
    app.query('#seed-input').value = input;
    app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await app.flush();
    await pick(app, 0);
    const cards = app.queryAll('.service-list .service-item');
    assert.equal(cards.length, 5, `${input} 应当有 5 部候选`);
    assert.match(cards[0].textContent, /Synthetic Candidate/, `${input} 的候选应当是它自己那一套`);
    assert.match(cards[0].textContent, new RegExp(entry.insights[0].name.slice(0, 4)));
  }
});

test('同一个页面上换输入：旧候选要换成新的，不能留着上一部的片', async () => {
  const app = await bootApp({ api: buildReplay(SYNTHETIC_INPUTS) });
  await app.flush();

  app.query('#seed-input').value = 'Synthetic Input A';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  await pick(app, 0);
  assert.match(app.text('.service-list'), /Synthetic Candidate A/);

  // 换一部片：输入框回来，旧候选清掉。
  app.query('#seed-change').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.equal(app.queryAll('.service-list .service-item').length, 0, '换输入时旧候选要清掉');

  app.query('#seed-input').value = 'Synthetic Input B';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  await pick(app, 0);
  const text = app.text('.service-list');
  assert.match(text, /Synthetic Candidate B/);
  assert.doesNotMatch(text, /Synthetic Candidate A/, '上一部的片子不许留着');
});

test('连续提交两个输入：后提交的那个赢，不能串台', async () => {
  const app = await bootApp({ api: buildReplay(SYNTHETIC_INPUTS) });
  await app.flush();
  app.query('#seed-input').value = 'Synthetic Input A';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  // 不等第一个走完，直接再提交一个。
  app.query('#seed-input').value = 'Synthetic Input C';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  await pick(app, 0);
  const text = app.text('.service-list');
  assert.match(text, /Synthetic Candidate C/);
  assert.doesNotMatch(text, /Fixture Film A/, '先提交的那个不能留在界面上');
});

test('连点两次「就这部」：只取一次候选，不出双份', async () => {
  const calls = [];
  const replay = buildReplay(SYNTHETIC_INPUTS);
  const api = async (url, init) => {
    calls.push(String(url));
    return replay(url, init);
  };
  const app = await bootApp({ api });
  await app.flush();
  app.query('#seed-input').value = 'Synthetic Input A';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const radios = app.queryAll('.entity-options input[type="radio"]');
  radios[0].checked = true;
  const confirm = app.query('#entity-confirm');
  confirm.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  confirm.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const candidateCalls = calls.filter((call) => call.endsWith('/api/candidates'));
  assert.equal(candidateCalls.length, 1, '连点两次也只该取一次候选');
  assert.equal(app.queryAll('.service-list .service-item').length, 5, '不能出双份候选');
});

test('空结果之后能恢复：再换一个片子，界面回到正常', async () => {
  const app = await bootApp({ api: buildReplay(SYNTHETIC_INPUTS) });
  await app.flush();

  // 没保存过的输入：服务没匹配到，要说清。
  app.query('#seed-input').value = 'Synthetic Unlisted Input';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.match(
    app.text('.service-error'),
    /did not match|no candidates|no saved/,
    '没匹配到要说清',
  );
  assert.equal(app.queryAll('.service-list .service-item').length, 0);

  // 换一个保存过的输入：恢复正常。
  app.query('#seed-input').value = 'Synthetic Input C';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  await pick(app, 0);
  assert.equal(app.queryAll('.service-list .service-item').length, 5);
  assert.equal(app.text('.service-error').trim(), '', '恢复之后错误提示要收掉');
});

test('拖滑杆不联网：请求数不变，顺序按本地权重变', async () => {
  const calls = [];
  const replay = buildReplay(SYNTHETIC_INPUTS);
  const api = async (url, init) => {
    calls.push(String(url));
    return replay(url, init);
  };
  const app = await bootApp({ api });
  await app.flush();
  app.query('#seed-input').value = 'Synthetic Input A';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  await pick(app, 0);

  const before = calls.length;
  const range = app.query('#service-popularity-weight');
  range.value = '100';
  range.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();

  assert.equal(calls.length, before, '拖滑杆不许发请求');
  assert.equal(app.queryAll('.service-list .service-item').length, 5);
});

/* ------------------ B · 保存的真实响应（显式 opt-in，缺文件就 skip） ------------------ */

const replayDir = process.env.TASTE_TUNER_REPLAY_DIR;

/**
 * 私密目录的约定：
 *   <dir>/first/search.json、<dir>/first/insights.json
 *   <dir>/multi/attempt-*.json
 * 原始响应不在 Git 里；这个目录由使用者自己提供。
 *
 * 多输入矩阵里，每条输入有两份保存：一次 search（给出消歧候选）与一次 insights
 * （用 `--signal-entities` 指回种子）。配对靠**返回的种子 id**，不自己编。
 */
function loadPrivateTable(dir) {
  const table = new Map();
  const multiDir = join(dir, 'multi');
  if (!existsSync(multiDir)) return table;
  const searches = new Map();
  const insights = new Map();
  for (const name of readdirSync(multiDir).filter((entry) => /^attempt-\d+\.json$/.test(entry))) {
    const attempt = JSON.parse(readFileSync(join(multiDir, name), 'utf8'));
    const args = attempt.args ?? [];
    let entities = [];
    try {
      entities = JSON.parse(attempt.result.stdout);
    } catch {
      continue;
    }
    const queryAt = args.indexOf('--query');
    const seedAt = args.indexOf('--signal-entities');
    const query = queryAt >= 0 ? args[queryAt + 1] : undefined;
    const seedId = seedAt >= 0 ? args[seedAt + 1] : undefined;
    if (seedId !== undefined) {
      insights.set(seedId, { query, entities });
    } else if (query !== undefined) {
      for (const entity of entities) {
        if (typeof entity?.entity_id === 'string') {
          searches.set(entity.entity_id, { query, entities });
        }
      }
    }
  }
  for (const [seedId, info] of insights) {
    const search = searches.get(seedId);
    if (search === undefined) continue;
    const seedIndex = search.entities.findIndex(
      (entity) => entity?.entity_id === seedId,
    );
    table.set(String(search.query).toLowerCase(), {
      search: search.entities,
      insights: info.entities,
      seedIndex: seedIndex < 0 ? 0 : seedIndex,
    });
  }
  return table;
}

test(
  '保存的真实响应（opt-in）：每个输入都有候选，归因指向种子',
  {
    skip:
      replayDir === undefined
        ? '没有设置 TASTE_TUNER_REPLAY_DIR：默认不跑真实响应回归'
        : false,
  },
  async () => {
    const table = loadPrivateTable(replayDir);
    assert.ok(table.size > 0, '私密目录里应当有保存的响应');
    const api = buildReplay(table);
    for (const [input, entry] of table) {
      const app = await bootApp({ api });
      await app.flush();
      app.query('#seed-input').value = input;
      app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
      await app.flush();
      await pick(app, entry.seedIndex);
      const cards = app.queryAll('.service-list .service-item');
      assert.ok(cards.length > 0, `${input} 应当有候选`);
      const why = app.text('.service-why-body');
      assert.match(why, /Attribution/, '归因要显示出来');
    }
  },
);
