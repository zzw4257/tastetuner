// 真实服务这条主线的纯逻辑检查。
//
// 注意：这里的响应全是 test/helpers/qloo-fixtures.mjs 里手写的夹具，
// **不是**真实 Qloo 响应，也不构成 live evidence。真实调用一次都没有发生。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SERVICE_CONTROLS,
  NO_CONSTRAINT,
  applyServiceConstraint,
  availableKnobs,
  rankServiceCandidates,
  tagSimilarity,
  validateCandidateRequest,
  validateSeedInput,
  validateServiceControls,
} from '../dist/assets/core/service.js';
import {
  createQlooAdapter,
  extractEntities,
  mapHttpStatus,
  normalizeAffinity,
  parseInsightsResponse,
  parseSearchResponse,
} from '../dist/assets/core/qloo.js';
import {
  FIXTURE_NOTICE,
  insightsPayload,
  insightsWithWarningPayload,
  insightsWithoutPopularityPayload,
  malformedPayload,
  searchAmbiguousPayload,
  searchEmptyPayload,
  searchArtistPayload,
  searchResolvedPayload,
} from './helpers/qloo-fixtures.mjs';

const close = (actual, expected, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test('夹具本身被明确标注为假数据，不冒充 live evidence', () => {
  assert.match(FIXTURE_NOTICE, /Not a live service response/);
  assert.match(FIXTURE_NOTICE, /not live evidence/);
});

test('种子输入校验：空、超长、控制字符、错类别都被挡下', () => {
  assert.equal(validateSeedInput('  星际穿越  ', 'movie').ok, true);
  assert.equal(validateSeedInput('  星际穿越  ', 'movie').seed, '星际穿越');

  assert.deepEqual(validateSeedInput('', 'movie').issues, ['The seed must not be empty']);
  assert.deepEqual(validateSeedInput('   ', 'movie').issues, ['The seed must not be empty']);
  assert.equal(validateSeedInput(123, 'movie').ok, false);
  assert.match(validateSeedInput('x'.repeat(121), 'movie').issues[0], /not exceed 120/);
  assert.match(validateSeedInput('a\u0000b', 'movie').issues[0], /control characters/);
  assert.match(validateSeedInput('x', 'place').issues[0], /The entity type must be/);
});

test('候选请求校验：实体 ID 的形状与数量上限', () => {
  assert.equal(validateCandidateRequest('urn:entity:movie:1', 20).ok, true);
  assert.equal(validateCandidateRequest('urn:entity:movie:1', undefined).limit, 20);
  assert.match(validateCandidateRequest('', 20).issues[0], /must not be empty/);
  assert.match(validateCandidateRequest('a b', 20).issues[0], /disallowed characters/);
  assert.match(validateCandidateRequest('id', 51).issues[0], /between 1 and 50/);
  assert.match(validateCandidateRequest('id', 0).issues[0], /between 1 and 50/);
});

test('候选请求只要 entityId 与 limit：输出领域是固定的，调用方不必再传类别', () => {
  // 前端发的是 {entityId, limit}，服务端要是还要求 entityType，
  // 每一次点「用这个继续」都会被"The entity type must be a string"挡下。
  const outcome = validateCandidateRequest('urn:entity:movie:1', 20);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.issues, []);
  assert.equal(outcome.entityId, 'urn:entity:movie:1');
  assert.equal(outcome.limit, 20);
});

test('关联分归一：0–100 与 0–1 两种写法都认，越界不认', () => {
  close(normalizeAffinity(92), 0.92);
  close(normalizeAffinity(0.92), 0.92);
  close(normalizeAffinity(0), 0);
  close(normalizeAffinity(100), 1);
  assert.equal(normalizeAffinity(101), undefined);
  assert.equal(normalizeAffinity(-1), undefined);
  assert.equal(normalizeAffinity('92'), undefined);
});

test('名称解析：唯一匹配、歧义、空、形状不对是四种不同结果', () => {
  const resolved = parseSearchResponse(searchResolvedPayload);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.entity.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(resolved.entity.type, 'urn:entity:movie');
  assert.equal(resolved.entity.year, 2010);

  const ambiguous = parseSearchResponse(searchAmbiguousPayload);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.candidates[1].year, 2013);

  assert.equal(parseSearchResponse(searchEmptyPayload).status, 'empty');

  // 形状对不上时必须报上游错误，不能当成"没找到"。
  const malformed = parseSearchResponse(malformedPayload);
  assert.equal(malformed.status, 'upstream_error');
  assert.equal(malformed.retryable, false);
});

test('结果信封：insights 用 results.entities[]，search 用 results[]', () => {
  assert.equal(extractEntities(insightsPayload).length, 4);
  assert.equal(extractEntities(searchResolvedPayload).length, 1);
  assert.deepEqual(extractEntities(malformedPayload), []);
});

test('候选解析：只保留服务真的给过的字段', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.candidates.length, 4);

  const first = outcome.candidates[0];
  close(first.affinity, 0.92);
  assert.equal(first.affinityRaw, 0.92);
  close(first.popularity, 0.94);
  close(first.trend, 0.61);
  assert.equal(first.serviceRank, 1);
  assert.equal(first.details.releaseYear, 2010);
  assert.equal(first.details.releaseDate, '2010-07-16');
  assert.equal(first.details.contentRating, 'PG-13');
  assert.equal(first.details.description, 'Fixture description field.');
  assert.equal(first.details.imageUrl, 'https://images.example.invalid/a.jpg');
  assert.equal(first.tags.length, 2);
  assert.equal(first.contributions.length, 1);
  close(first.contributions[0].score, 0.82);

  // Candidate D没有流行度、趋势、标签、详情：必须是 null / 空，不能补 0 冒充。
  const last = outcome.candidates[2];
  assert.equal(last.popularity, null);
  assert.equal(last.trend, null);
  assert.equal(last.tags.length, 0);
  assert.equal(last.details.releaseYear, undefined);
  assert.equal(last.details.imageUrl, undefined);
  // Candidate C：关联分最低但流行度最高。
  close(outcome.candidates[3].affinity, 0.3);
  close(outcome.candidates[3].popularity, 0.99);
});

test('候选解析：形状对不上时报上游错误，不返回空列表冒充没有候选', () => {
  const outcome = parseInsightsResponse(malformedPayload);
  assert.equal(outcome.status, 'upstream_error');
  assert.match(outcome.message, /no results field/);
});

test('两个接口对"信封长什么样"的判断必须一致', () => {
  // results 是数组时，extractEntities 认得，守卫也得认得。
  // 之前 insights 那边的守卫只认 results 是对象，于是同一份数据，
  // 解析器能解出实体、守卫却说"形状不符"。
  const asArray = parseInsightsResponse({ results: [] });
  assert.equal(asArray.status, 'empty', 'results 是空数组是"没有候选"，不是"形状不符"');
  assert.equal(parseSearchResponse({ results: [] }).status, 'empty');

  // results 整个没有：两个接口都说形状不符，且说同一句。
  const noResults = parseInsightsResponse({ nope: true });
  assert.equal(noResults.status, 'upstream_error');
  const noResultsSearch = parseSearchResponse({ nope: true });
  assert.equal(noResultsSearch.status, 'upstream_error');
  assert.equal(noResults.message, noResultsSearch.message);
});

test('归因无法计算时上游会给 warning，结果照常返回', () => {
  const outcome = parseInsightsResponse(insightsWithWarningPayload);
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.candidates.length, 1);
  assert.equal(outcome.explainabilityWarning, 'Attribution could not be computed; results only.');
});

test('旋钮只按实际返回的字段出现', () => {
  const withPopularity = parseInsightsResponse(insightsPayload);
  assert.deepEqual(availableKnobs(withPopularity.candidates), {
    affinity: true,
    popularity: true,
    tagSimilarity: false,
  });

  const without = parseInsightsResponse(insightsWithoutPopularityPayload);
  assert.deepEqual(availableKnobs(without.candidates), {
    affinity: true,
    popularity: false,
    tagSimilarity: false,
  });
});

test('标签相似度要种子与候选都有标签才算得出来', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  const seedTags = [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }];
  assert.equal(availableKnobs(outcome.candidates, seedTags).tagSimilarity, true);

  const first = outcome.candidates[0];
  // Candidate A有 2 个标签，与种子共有 1 个：1 / (1 + 2 - 1) = 0.5
  close(tagSimilarity(first, seedTags), 0.5);

  // 种子没有标签时相似度恒为 0，旋钮也不出现。
  assert.equal(availableKnobs(outcome.candidates, []).tagSimilarity, false);
  close(tagSimilarity(first, []), 0);
});

test('重排结果里带着**未加权**的标签相似度：默认权重为 0 时贡献是 0，相似度不能也是 0', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  const seedTags = [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }];

  // 默认权重把标签相似度权重设成 0，所以"计入分数的部分"确实是 0。
  const rows = rankServiceCandidates(outcome.candidates, DEFAULT_SERVICE_CONTROLS, seedTags);
  const first = rows.find((row) => row.candidate.id === 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.equal(first.tagSimilarityContribution, 0);

  // 但未加权的那个数（0.5）必须还在——界面上要能看见真实的相似度。
  close(first.tagSimilarityRaw, 0.5);

  // 种子没有标签时算不出来，就说算不出来，不拿 0 冒充。
  const blind = rankServiceCandidates(outcome.candidates, DEFAULT_SERVICE_CONTROLS, []);
  assert.equal(blind[0].tagSimilarityRaw, null);
});

test('本地重排：纯关联分时与服务原序一致，混入流行度后才换位', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  const pure = rankServiceCandidates(outcome.candidates, DEFAULT_SERVICE_CONTROLS);
  assert.deepEqual(pure.map((row) => row.candidate.id), [
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003',
  ]);
  assert.ok(pure.every((row) => row.deltaRank === 0), '基线就是服务原序，不应有换位');
  assert.ok(pure.every((row) => row.serviceRank === row.rank));

  const mixed = rankServiceCandidates(outcome.candidates, {
    affinityWeight: 50,
    popularityWeight: 50,
    tagSimilarityWeight: 0,
  });
  const ids = mixed.map((row) => row.candidate.id);
  // Candidate C关联分低但流行度最高，混入流行度后应当越过乙与丁。
  assert.deepEqual(ids, [
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000003',
    'aaaaaaaa-0000-0000-0000-000000000002',
    'aaaaaaaa-0000-0000-0000-000000000004',
  ]);
  assert.ok(mixed.some((row) => row.deltaRank !== 0), '换权重就应该出现换位');
});

test('本地重排是确定性的：同样输入永远同样输出', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  const controls = {
    affinityWeight: 70,
    popularityWeight: 30,
    tagSimilarityWeight: 0,
  };
  assert.deepEqual(
    rankServiceCandidates(outcome.candidates, controls),
    rankServiceCandidates(outcome.candidates, controls),
  );
});

test('重排的三项贡献加起来等于本地分数', () => {
  const outcome = parseInsightsResponse(insightsPayload);
  const controls = {
    affinityWeight: 60,
    popularityWeight: 40,
    tagSimilarityWeight: 30,
  };
  for (const row of rankServiceCandidates(outcome.candidates, controls)) {
    close(
      row.score,
      row.affinityContribution + row.popularityContribution + row.tagSimilarityContribution,
    );
  }
});

test('控制项校验：只接受 0–100 的整数', () => {
  assert.equal(
    validateServiceControls({ affinityWeight: 0, popularityWeight: 0, tagSimilarityWeight: 100 }).ok,
    true,
  );
  assert.equal(
    validateServiceControls({ affinityWeight: -1, popularityWeight: 0, tagSimilarityWeight: 0 }).ok,
    false,
  );
  assert.equal(
    validateServiceControls({ affinityWeight: 101, popularityWeight: 0, tagSimilarityWeight: 0 }).ok,
    false,
  );
  assert.equal(
    validateServiceControls({ affinityWeight: 1.5, popularityWeight: 0, tagSimilarityWeight: 0 }).ok,
    false,
  );
});

test('HTTP 状态映射：鉴权与限流必须给出明确原因，不能静默换路', () => {
  assert.equal(mapHttpStatus(401).kind, 'auth');
  assert.equal(mapHttpStatus(401).retryable, false);
  assert.equal(mapHttpStatus(403).kind, 'auth');
  assert.equal(mapHttpStatus(429).kind, 'rate_limited');
  assert.equal(mapHttpStatus(429).retryable, true);
  // 官方文档把 404 定义为"没有结果"，不是故障。
  assert.equal(mapHttpStatus(404).kind, 'not_found');
  assert.equal(mapHttpStatus(400).kind, 'bad_request');
  assert.equal(mapHttpStatus(400).retryable, false);
  assert.equal(mapHttpStatus(503).kind, 'upstream');
  assert.equal(mapHttpStatus(503).retryable, true);
});

/* ---------------- 适配器实际发出的请求形状 ---------------- */

function recordingFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
  return { calls, impl };
}

test('适配器发的名称解析请求就是核实过的那条：GET /search + X-Api-Key', async () => {
  const { calls, impl } = recordingFetch([{ status: 200, body: searchResolvedPayload }]);
  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: 'https://api.qloo.com',
    fetchImpl: impl,
  });

  const outcome = await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  assert.equal(outcome.status, 'resolved');
  assert.equal(calls.length, 1);

  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://api.qloo.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('query'), 'Sample Film');
  assert.equal(url.searchParams.get('types'), 'urn:entity:movie');
  assert.equal(url.searchParams.get('take'), '20');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'test-key-not-a-real-credential');
});

test('适配器发的推荐请求带排除种子与归因开关', async () => {
  const { calls, impl } = recordingFetch([{ status: 200, body: insightsPayload }]);
  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: 'https://api.qloo.com',
    fetchImpl: impl,
  });

  const outcome = await adapter.fetchCandidates({
    entityId: 'seed-uuid',
    entityType: 'movie',
    limit: 20,
  });
  assert.equal(outcome.status, 'ok');

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/v2/insights');
  assert.equal(url.searchParams.get('filter.type'), 'urn:entity:movie');
  assert.equal(url.searchParams.get('signal.interests.entities'), 'seed-uuid');
  assert.equal(url.searchParams.get('filter.exclude.entities'), 'seed-uuid');
  assert.equal(url.searchParams.get('feature.explainability'), 'true');
  assert.equal(url.searchParams.get('take'), '20');
});

test('适配器只发一次请求：429 原样返回，不自己重发（重发会让账本少算）', async () => {
  const { calls, impl } = recordingFetch([
    { status: 429, body: { message: 'rate limited' } },
  ]);
  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: 'https://api.qloo.com',
    fetchImpl: impl,
  });

  const outcome = await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  assert.equal(outcome.status, 'upstream_error');
  assert.equal(outcome.retryable, true);
  assert.equal(calls.length, 1, '默认零重试：每次尝试都计入请求预算');
});

test('没有配置基址与凭据时报未配置，绝不静默换成别的地址', async () => {
  const adapter = createQlooAdapter({ apiKey: undefined, baseUrl: undefined });
  const config = adapter.configuration();
  assert.equal(config.configured, false);
  assert.deepEqual(config.missing, ['QLOO_API_KEY', 'QLOO_BASE_URL']);

  const outcome = await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  assert.equal(outcome.status, 'not_configured');
});

test('适配器不会在两个基址之间静默切换', async () => {
  const { calls, impl } = recordingFetch([{ status: 200, body: searchResolvedPayload }]);
  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: 'https://hackathon.api.qloo.com',
    fetchImpl: impl,
  });
  await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, 'https://hackathon.api.qloo.com');
});

test('未配置的独立路径一个网络请求都不发，也不回退到合成数据', async () => {
  const calls = [];
  const adapter = createQlooAdapter({
    apiKey: undefined,
    baseUrl: undefined,
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('不应该发出请求');
    },
  });

  const resolved = await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  const candidates = await adapter.fetchCandidates({
    entityId: 'seed-uuid',
    entityType: 'movie',
    limit: 20,
  });

  assert.equal(resolved.status, 'not_configured');
  assert.equal(candidates.status, 'not_configured');
  assert.deepEqual(calls, [], '没有配置就不该有任何网络请求');
});

test('官方赛事工具装在项目里且版本够用（只读版本号，不发请求）', async () => {
  const { execFileSync } = await import('node:child_process');
  const binary = new URL('../node_modules/.bin/qloo', import.meta.url).pathname;
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(
    major > 0 || minor >= 1 || patch >= 26,
    `官方工具版本过低：${version}（kit 要求 0.1.26 或更新）`,
  );
});

test('适配器如实报告：官方允许直连，但这条路径没对真实 API 实测过', () => {
  const adapter = createQlooAdapter({ apiKey: 'x', baseUrl: 'https://api.qloo.com' });
  const config = adapter.configuration();
  assert.equal(config.accessSurface, 'raw-http');
  assert.equal(
    config.accessSurfaceConfirmed,
    true,
    '官方 CURRENT 指南自己给的就是 GET 直连示例，CLI 不是必须',
  );
  assert.equal(
    config.accessSurfaceLiveVerified,
    false,
    '官方允许 ≠ 本地实测过：这条路径只对着本机假服务验过',
  );
});

test('raw HTTP 适配器的预览：拼出请求但不发送', async () => {
  const calls = [];
  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: 'https://hackathon.api.qloo.com',
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('预览不该发请求');
    },
  });

  const preview = await adapter.previewRequest({
    op: 'resolve',
    seed: 'Sample Film',
    entityType: 'movie',
  });
  assert.equal(preview.method, 'GET');
  assert.match(preview.url, /^https:\/\/hackathon\.api\.qloo\.com\/search\?/);
  assert.equal(preview.params.query, 'Sample Film');
  assert.equal(preview.params.types, 'urn:entity:movie');
  assert.deepEqual(calls, [], '预览不发请求');

  const candidates = await adapter.previewRequest({
    op: 'candidates',
    entityId: 'seed-uuid',
    entityType: 'movie',
    limit: 5,
  });
  assert.match(candidates.url, /\/v2\/insights\?/);
  assert.deepEqual(candidates.params['signal.interests.entities'], ['seed-uuid']);
  // 输出领域固定是电影，与种子是什么类别无关。
  assert.equal(candidates.params['filter.type'], 'urn:entity:movie');
  assert.deepEqual(candidates.params['filter.exclude.entities'], ['seed-uuid']);
  assert.equal(candidates.params['feature.explainability'], 'true');
  assert.deepEqual(calls, [], '预览不发请求');
});

test('详情字段按官方样例映射：websites、akas、short_descriptions', () => {
  const outcome = parseInsightsResponse({
    success: true,
    results: {
      entities: [
        {
          entity_id: 'uuid-1',
          name: 'Django Unchained',
          subtype: 'urn:entity:movie',
          affinity: 0.8,
          properties: {
            release_year: 2012,
            release_date: '2012-12-25',
            content_rating: 'R',
            description: 'English description',
            image: { url: 'https://images.example.invalid/a.jpg' },
            akas: [
              { value: '被解放的姜戈', languages: ['zh'] },
              { value: 'Django Unchained', languages: ['en'] },
            ],
            short_descriptions: [
              { value: '一部关于解放与复仇的西部片', languages: ['zh'] },
              { value: 'A western about freedom', languages: ['en'] },
            ],
            websites: ['https://www.example.invalid/django'],
          },
        },
      ],
    },
  });
  assert.equal(outcome.status, 'ok');
  const details = outcome.candidates[0].details;
  // 外链字段是 websites（数组），不是 url；界面上叫"相关链接"。
  assert.deepEqual(details.relatedLinks, ['https://www.example.invalid/django']);
  // 别名取带 zh 的那条。
  assert.equal(details.alsoKnownAs, '被解放的姜戈');
  // 描述优先取中文短描述。
  assert.equal(details.description, '一部关于解放与复仇的西部片');
  assert.equal(details.releaseYear, 2012);
  assert.equal(details.contentRating, 'R');
  assert.equal(details.imageUrl, 'https://images.example.invalid/a.jpg');
});

test('没有 websites / akas 时就不给编造外链与别名', () => {
  const outcome = parseInsightsResponse({
    success: true,
    results: {
      entities: [{ entity_id: 'uuid-2', name: '某片', subtype: 'urn:entity:movie', affinity: 0.5 }],
    },
  });
  const details = outcome.candidates[0].details;
  assert.equal(details.relatedLinks, undefined);
  assert.equal(details.alsoKnownAs, undefined);
  assert.equal(details.description, undefined);
});

test('外部标识按官方样例的 external 读，消歧串也读', () => {
  const outcome = parseInsightsResponse({
    success: true,
    results: {
      entities: [
        {
          entity_id: 'F0D354AA-BA7E-49D2-8ABA-9A8250F5C852',
          name: 'Everything Everywhere All at Once',
          type: 'urn:entity',
          subtype: 'urn:entity:movie',
          disambiguation: '2022, Daniel Scheinert, Daniel Kwan',
          properties: { release_year: 2022 },
          popularity: 0.998,
          external: {
            imdb: [{ id: 'tt6710474', user_rating: 7.8 }],
            wikidata: [{ id: 'q83808444' }],
            letterboxd: [{ id: 'everything-everywhere-all-at-once' }],
          },
        },
      ],
    },
  });
  const candidate = outcome.candidates[0];
  assert.equal(candidate.disambiguation, '2022, Daniel Scheinert, Daniel Kwan');
  // 外部标识在 external 里，不是 external_ids。
  assert.equal(candidate.details.externalIds?.imdb, 'tt6710474');
  assert.equal(candidate.details.externalIds?.wikidata, 'q83808444');
  assert.equal(candidate.details.externalIds?.letterboxd, 'everything-everywhere-all-at-once');
  // 实体类型取 subtype。
  assert.equal(candidate.type, 'urn:entity:movie');
});

test('硬约束按真实字段本地筛选：分级上限与上映年份下限', () => {
  const make = (id, rating, year) => ({
    id,
    name: id,
    type: 'urn:entity:movie',
    affinity: 0.5,
    affinityRaw: 0.5,
    popularity: null,
    trend: null,
    serviceRank: 1,
    contributions: [],
    tags: [],
    details: {
      ...(rating === undefined ? {} : { contentRating: rating }),
      ...(year === undefined ? {} : { releaseYear: year }),
    },
  });

  const candidates = [
    make('g', 'G', 1990),
    make('pg13', 'PG-13', 2005),
    make('r', 'R', 2010),
    make('nc17', 'NC-17', 2020),
    make('unknown-rating', undefined, 2015),
    make('unknown-year', 'PG', undefined),
  ];

  const capped = applyServiceConstraint(candidates, {
    maxContentRating: 'PG-13',
    minReleaseYear: null,
  });
  // 缺分级的那部保留但算"无法核对"；缺年份的那部分级已知，不算。
  assert.deepEqual(capped.kept.map((c) => c.id), [
    'g',
    'pg13',
    'unknown-rating',
    'unknown-year',
  ]);
  assert.deepEqual(capped.violated.map((c) => c.id), ['r', 'nc17']);
  assert.deepEqual(capped.unverifiable.map((c) => c.id), ['unknown-rating']);

  const recent = applyServiceConstraint(candidates, {
    maxContentRating: null,
    minReleaseYear: 2010,
  });
  assert.deepEqual(recent.kept.map((c) => c.id), [
    'r',
    'nc17',
    'unknown-rating',
    'unknown-year',
  ]);
  assert.deepEqual(recent.violated.map((c) => c.id), ['g', 'pg13']);
  assert.deepEqual(recent.unverifiable.map((c) => c.id), ['unknown-year']);
});

test('没有约束时原样保留', () => {
  const one = {
    id: 'a',
    name: 'a',
    type: 'urn:entity:movie',
    affinity: 0.5,
    affinityRaw: 0.5,
    popularity: null,
    trend: null,
    serviceRank: 1,
    contributions: [],
    tags: [],
    details: {},
  };
  const outcome = applyServiceConstraint([one], NO_CONSTRAINT);
  assert.equal(outcome.kept.length, 1);
  assert.equal(outcome.violated.length, 0);
  assert.equal(outcome.unverifiable.length, 0);
});

test('去向：流媒体从官方实体的 streaming_service 标签里读', () => {
  const outcome = parseInsightsResponse({
    success: true,
    results: {
      entities: [
        {
          entity_id: 'uuid-1',
          name: 'Everything Everywhere All at Once',
          subtype: 'urn:entity:movie',
          affinity: 0.9,
          tags: [
            { id: 'urn:tag:streaming_service:media:neon_tv', name: 'Neon Tv', type: 'urn:tag:streaming_service:media' },
            { id: 'urn:tag:streaming_service:media:directv', name: 'Directv', type: 'urn:tag:streaming_service:media' },
            { id: 'urn:tag:keyword:media:multiverse', name: 'Multiverse', type: 'urn:tag:keyword:media' },
          ],
        },
      ],
    },
  });
  const details = outcome.candidates[0].details;
  // 只有 streaming_service 标签算去向；关键词标签不算。
  assert.deepEqual(details.streamingServices, ['Neon Tv', 'Directv']);
});

test('没有流媒体标签时就不给去向', () => {
  const outcome = parseInsightsResponse({
    success: true,
    results: {
      entities: [
        {
          entity_id: 'uuid-2',
          name: '某片',
          subtype: 'urn:entity:movie',
          affinity: 0.5,
          tags: [{ id: 'urn:tag:keyword:media:x', name: 'X', type: 'urn:tag:keyword:media' }],
        },
      ],
    },
  });
  assert.equal(outcome.candidates[0].details.streamingServices, undefined);
});

test('没有关联分时，以服务自己的名次为准，不退化成按 ID 排', () => {
  const candidates = [
    { id: 'z', name: 'z', type: 'urn:entity:movie', affinity: null, affinityRaw: null, popularity: null, trend: null, serviceRank: 1, contributions: [], tags: [], details: {} },
    { id: 'a', name: 'a', type: 'urn:entity:movie', affinity: null, affinityRaw: null, popularity: null, trend: null, serviceRank: 2, contributions: [], tags: [], details: {} },
    { id: 'm', name: 'm', type: 'urn:entity:movie', affinity: null, affinityRaw: null, popularity: null, trend: null, serviceRank: 3, contributions: [], tags: [], details: {} },
  ];
  const rows = rankServiceCandidates(candidates, DEFAULT_SERVICE_CONTROLS);
  // 按 ID 排会是 a,m,z；服务原序是 z,a,m。界面那句"服务给出的原始顺序"必须是真的。
  assert.deepEqual(rows.map((row) => row.candidate.id), ['z', 'a', 'm']);
  assert.ok(rows.every((row) => row.deltaRank === 0), '没有可依据的分数就不该有名次变化');
});

test('有关联分时，仍然按分数排', () => {
  const candidates = [
    { id: 'z', name: 'z', type: 'urn:entity:movie', affinity: 0.1, affinityRaw: 0.1, popularity: null, trend: null, serviceRank: 1, contributions: [], tags: [], details: {} },
    { id: 'a', name: 'a', type: 'urn:entity:movie', affinity: 0.9, affinityRaw: 0.9, popularity: null, trend: null, serviceRank: 2, contributions: [], tags: [], details: {} },
  ];
  const rows = rankServiceCandidates(candidates, DEFAULT_SERVICE_CONTROLS);
  assert.deepEqual(rows.map((row) => row.candidate.id), ['a', 'z']);
});

test('音乐人种子：解析成音乐人实体，取回的仍然是电影', async () => {
  // 音乐人形状：types 里是 urn:entity:artist，没有上映年份。
  const outcome = parseSearchResponse(searchArtistPayload);
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.entity.type, 'urn:entity:artist');
  assert.equal(outcome.entity.year, undefined, '音乐人没有上映年份');
  assert.equal(outcome.entity.disambiguation, 'English rock band from Abingdon');
  assert.equal(outcome.entity.imageUrl !== undefined, true, '音乐人也有海报');

  // 输出领域固定是电影：用同一个实体取候选，出来的仍然是电影。
  const candidates = parseInsightsResponse(insightsPayload);
  assert.equal(candidates.status, 'ok');
  for (const candidate of candidates.candidates) {
    assert.equal(candidate.type, 'urn:entity:movie', '音乐人当种子，出来的仍然是电影');
  }
});
