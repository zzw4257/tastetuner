// 真实响应的**离线回放**回归：不发任何网络请求。
//
// 两组，分开记账：
// - A · 精简派生形状（`test/helpers/live-shape.fixture.mjs`）——永远跑，用假值。
// - B · 本机保存的**真实脱敏响应**——**显式 opt-in**：只有设置 TASTE_TUNER_REPLAY_DIR
//   指向私密目录（`<dir>/first/search.json`、`<dir>/first/insights.json`）时才跑；
//   没设置就清楚 skip。原始响应不入 Git（.gitignore 里的 artifacts/）。
//
// B 组里的一切期望值都在运行时从**保存的响应**里读出来：公开树里不写死任何片名、
// 年份、简介或 id——那些是响应派生记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootApp } from './helpers/app-harness.mjs';
import { parseInsightsResponse, parseSearchResponse } from '../dist/assets/core/qloo.js';
import {
  slimCliError,
  slimInsightsResponse,
  slimSearchResponse,
} from './helpers/live-shape.fixture.mjs';

/** 把 CLI 保存下来的 `{exit, stdout, stderr}` 变成界面用的状态对象。 */
function replay(cli) {
  if (cli.exit !== 0) {
    return { status: 'upstream_error', message: cli.stderr, retryable: false };
  }
  return JSON.parse(cli.stdout);
}

/* ------------------------------ A · 精简形状（永远跑） ------------------------------ */

test('精简形状：/search 的实体类别靠 types 数组，标签靠 tag_id', () => {
  const outcome = parseSearchResponse(slimSearchResponse);
  assert.equal(outcome.status, 'ambiguous');
  assert.equal(outcome.candidates.length, 2);
  // 关键：真实响应里没有 subtype/type，只有 types。
  assert.equal(outcome.candidates[0].type, 'urn:entity:movie');
  assert.equal(outcome.candidates[0].year, 2030);
  assert.equal(outcome.candidates[0].disambiguation, '2030');
  // 标签在 /search 里用 tag_id。
  assert.equal(outcome.candidates[0].tags.length, 1);
  assert.equal(outcome.candidates[0].tags[0].id, 'urn:tag:keyword:media:fixture');
});

test('精简形状：关联分在 query.affinity，归因在 query.explainability["signal.interests.entities"]', () => {
  const outcome = parseInsightsResponse(slimInsightsResponse);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.candidates.length, 2);
  const first = outcome.candidates[0];
  // 合成夹具的值：明确是假的。
  assert.ok(Math.abs((first.affinity ?? 0) - 0.8) < 1e-12);
  // 归因：真实结构是 [{entity_id, score}]，之前按 entities/contributions 找都找不到。
  assert.equal(first.contributions.length, 1);
  assert.equal(first.contributions[0].entityId, '90000000-0000-0000-0000-000000000001');
  assert.equal(first.contributions[0].score, 1);
});

test('精简形状：详情、外部标识、去向与相关链接都能读出来', () => {
  const outcome = parseInsightsResponse(slimInsightsResponse);
  const details = outcome.candidates[0].details;
  assert.equal(details.releaseYear, 2031);
  assert.equal(details.duration, 90);
  assert.equal(details.contentRating, 'PG');
  // 别名外面带一对引号，要去掉。
  assert.equal(details.alsoKnownAs, 'Fixture Alias B');
  // 外部标识在实体顶层。
  assert.equal(details.externalIds?.imdb, 'tt9000002');
  // 带 streaming_service 前缀的标签就是"在哪看"的一个信号。
  assert.deepEqual(details.streamingServices, ['ExamplePlus']);
  // websites 是数组，不是一条。
  assert.equal(details.relatedLinks?.length, 2);
});

test('精简形状：CLI 报错时如实报出来，不回退成合成结果', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo-cli',
            configured: true,
            missing: [],
            accessSurface: 'qloo-cli',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 502, body: replay(slimCliError) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Fixture Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.service-error'), /synthetic auth failure/);
  assert.equal(app.queryAll('.service-list .service-item').length, 0, '不能拿合成候选顶上');
});

/* ------------------ B · 保存的真实脱敏响应（显式 opt-in，缺文件就 skip） ------------------ */

const replayDir = process.env.TASTE_TUNER_REPLAY_DIR;
const liveDir = replayDir === undefined ? '' : join(replayDir, 'first');
const hasLive =
  replayDir !== undefined &&
  existsSync(join(liveDir, 'search.json')) &&
  existsSync(join(liveDir, 'insights.json'));
const skipReason = '没有设置 TASTE_TUNER_REPLAY_DIR（或目录里没有保存的响应）：默认不跑真实响应回归';

/** 保存下来的搜索/推荐响应，以及从它们读出来的期望值。 */
function loadSaved() {
  const search = JSON.parse(JSON.parse(readFileSync(join(liveDir, 'search.json'), 'utf8')).stdout);
  const insights = JSON.parse(
    JSON.parse(readFileSync(join(liveDir, 'insights.json'), 'utf8')).stdout,
  );
  const seed = search[0];
  const first = insights[0];
  // 别名值外面带一对对称的双引号（实测如此），界面显示的是去掉引号后的值。
  const rawAlias = (first.properties?.akas ?? []).find((item) =>
    (item.languages ?? []).includes('zh'),
  )?.value;
  const alias =
    typeof rawAlias === 'string' && rawAlias.startsWith('"') && rawAlias.endsWith('"')
      ? rawAlias.slice(1, -1)
      : rawAlias;
  const rawDescription = first.properties?.short_descriptions?.[0]?.value;
  // 卡面上是简介的前半句；只取前缀来断言，句子多长都不影响。
  const description =
    typeof rawDescription === 'string' ? rawDescription.slice(0, 30) : undefined;
  return { search, insights, seed, first, alias, description };
}

/** 把字符串安全地变成正则（片名里有括号与撇号）。 */
function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test(
  '真实响应回放：搜索给出多个候选，类型是 urn:entity:movie，年份与消歧串都读出来',
  { skip: hasLive ? false : skipReason },
  () => {
    const { search } = loadSaved();
    const outcome = parseSearchResponse({ results: search });
    assert.equal(outcome.status, 'ambiguous');
    assert.ok(outcome.candidates.length > 1, '多个真实候选才需要消歧');
    for (const candidate of outcome.candidates) {
      assert.equal(candidate.type, 'urn:entity:movie', `${candidate.name} 的类别没读出来`);
      assert.ok(candidate.year !== undefined, `${candidate.name} 缺年份`);
      assert.ok(candidate.disambiguation !== undefined, `${candidate.name} 缺消歧串`);
    }
  },
);

test(
  '真实响应回放：推荐的关联分在 0–1 之间，归因指向种子且分数为 1',
  { skip: hasLive ? false : skipReason },
  () => {
    const { insights, seed } = loadSaved();
    const outcome = parseInsightsResponse({ results: { entities: insights } });
    assert.equal(outcome.status, 'ok');
    assert.ok(outcome.candidates.length > 0);
    for (const candidate of outcome.candidates) {
      const affinity = candidate.affinity ?? 0;
      assert.ok(affinity > 0 && affinity <= 1, '关联分应当是 0–1 的数');
      assert.equal(candidate.contributions.length, 1, '归因应当只有一条');
      // 归因指向**种子**：用保存响应里的 id 对，不写死字面量。
      assert.equal(candidate.contributions[0].entityId, seed.entity_id);
      assert.equal(candidate.contributions[0].score, 1);
      assert.ok(candidate.details.releaseYear !== undefined);
      assert.ok(candidate.details.externalIds !== undefined);
    }
  },
);

test(
  '真实响应回放：走完整界面流程——消歧、候选、解释、详情',
  { skip: hasLive ? false : skipReason },
  async () => {
    const { search, insights, seed, first, alias, description } = loadSaved();
    const app = await bootApp({
      api: async (url) => {
        if (url.endsWith('/api/status')) {
          return {
            status: 200,
            body: {
              provider: 'saved-response-replay',
              configured: true,
              missing: [],
              accessSurface: 'saved-response-replay',
              accessSurfaceConfirmed: false,
              credentialPresent: null,
              budget: { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' },
              entityTypes: ['movie', 'artist'],
              maxCandidates: 50,
            },
          };
        }
        if (url.endsWith('/api/resolve')) {
          return { status: 200, body: parseSearchResponse({ results: search }) };
        }
        return {
          status: 200,
          body: parseInsightsResponse({ results: { entities: insights } }),
        };
      },
    });
    await app.flush();

    // 输入用**保存响应里的种子名**：公开树里不写死任何片名。
    app.query('#seed-input').value = seed.name;
    app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await app.flush();

    // 消歧列表：候选数与保存的响应一致。
    const choices = app.queryAll('.entity-options input[type="radio"]');
    assert.equal(choices.length, search.length);
    assert.match(
      app.text('.service-resolution'),
      new RegExp(String(seed.properties?.release_year)),
    );

    app.query('#entity-confirm').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await app.flush();

    const items = app.queryAll('.service-list .service-item');
    assert.equal(items.length, insights.length);
    // 首张卡就是保存响应里的第一部：名字与年份都在卡面上。
    assert.match(items[0].textContent ?? '', new RegExp(escaped(first.name)));
    assert.match(items[0].textContent ?? '', new RegExp(String(first.properties.release_year)));

    // 确认之后消歧列表与「就这部」都收掉了。
    assert.equal(app.query('#entity-confirm'), null, '确认后不该还留着「就这部」');
    assert.equal(app.queryAll('.entity-options').length, 0);
    assert.equal(app.query('.find-form').hidden, true);

    // 种子条说得出种子的名字。
    assert.match(app.text('.seed-bar'), new RegExp(escaped(seed.name)));

    // 卡面：服务给的那个名字（英文）+ 简介。
    // 中文原名**不进卡面**——它在折叠起来的说明面板里（不占标题、不冒充正式名）。
    const face = app.text('.service-item-meta');
    assert.match(face, new RegExp(escaped(first.name)));
    if (alias !== undefined) assert.doesNotMatch(face, new RegExp(escaped(alias)));
    if (description !== undefined) assert.match(face, new RegExp(escaped(description)));

    // 「为什么这部」：服务名次、关联分、归因；中文原名收在这里面。
    const evidence = app.text('.service-why-body');
    if (alias !== undefined) assert.match(evidence, new RegExp(escaped(alias)));
    assert.match(evidence, /Affinity/);
    assert.match(evidence, /Attribution from the service/);
    assert.match(evidence, /not a preference probability|not a natural-language/);
    // 「可用资料」：外部标识与相关链接。
    assert.match(app.text('.service-materials-body'), /Related links|External ID/);

    // 选中的种子带标签，所以标签相似度旋钮必须出现。
    assert.ok(
      app.query('#service-tag-similarity-weight') !== null,
      '选中的种子带标签，标签相似度旋钮就该出现',
    );

    // 归因里说得出种子的名字，而不是甩一串 GUID。
    assert.match(evidence, new RegExp(escaped(seed.name)), '归因里应当说得出种子的名字');
    assert.doesNotMatch(
      evidence,
      new RegExp(escaped(seed.entity_id)),
      '不该把种子的 GUID 当成归因标签甩给用户',
    );

    // 标签相似度不该显示成 0.00（区间是实测值，不写进公开树）。
    const similarity = app
      .queryAll('.service-evidence .score-table tbody tr')
      .find((row) => row.textContent?.includes('Tag similarity'));
    assert.ok(similarity !== undefined, '解释表里要有标签相似度这一行');
    const raw = Array.from(similarity.querySelectorAll('td'))[0]?.textContent ?? '';
    assert.ok(
      Number(raw) > 0 && Number(raw) < 1,
      `未加权的相似度应当是 0 与 1 之间的小数，却显示成 ${raw}`,
    );
  },
);
