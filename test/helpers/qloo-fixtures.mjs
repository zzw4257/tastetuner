// ============================================================================
// 测试夹具：手写的假上游响应与假适配器。
//
// 这些**不是**真实 Qloo 响应，也**不是** live evidence。它们按 2026-10-28
// 只读官方公开文档核实过的字段名与信封手写，用来验证解析与状态处理。
//
// 依据：
// - 名称解析 GET /search → 200 / 404 No results / 429
//   https://github.com/qloo/docs-public/blob/main/reference/get-search.md
// - 推荐 GET /v2/insights → success + results.entities[]
//   https://github.com/qloo/docs-public/blob/main/reference/basic-insights-use-case.md
// - 鉴权头 X-Api-Key
//   https://github.com/qloo/docs-public/blob/main/reference/api-onboarding.md
//
// 在真正拿到一份真实响应之前，任何"已与真实服务联通"的说法都不成立。
// ============================================================================

export const FIXTURE_NOTICE =
  'Test fixture: hand-written fake responses. Not a live service response, and not live evidence.';

/** /search 命中一个实体。 */
export const searchResolvedPayload = {
  success: true,
  results: [
    {
      entity_id: '11111111-2222-3333-4444-555555555555',
      name: 'Sample Film',
      subtype: 'urn:entity:movie',
      properties: { release_year: 2010 },
      tags: [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }],
    },
  ],
};

/** /search 命中多个实体：必须让用户确认。 */
/**
 * 音乐人形状的搜索结果。
 *
 * 形状照真实 /search 响应：实体类别在 `types` 里、没有上映年份、消歧串在顶层。
 * 音乐人那条路**从未对真实 API 跑过**（预算耗尽），这里至少把本地这一段钉住：
 * 解析 → 消歧 → 选中 → 取回**电影**候选（输出领域固定）。
 */
export const searchArtistPayload = {
  success: true,
  results: [
    {
      entity_id: 'cccccccc-1111-2222-3333-444444444444',
      name: 'Radiohead',
      types: ['urn:entity:artist'],
      popularity: 0.98,
      disambiguation: 'English rock band from Abingdon',
      properties: {
        image: { url: 'https://images.qloo.com/i/cccccccc-1111-2222-3333-444444444444-420x-auto.jpg' },
      },
      tags: [{ id: 'urn:tag:keyword:music:rock', name: 'rock' }],
    },
  ],
};

export const searchAmbiguousPayload = {
  success: true,
  results: [
    {
      entity_id: '11111111-2222-3333-4444-555555555555',
      name: 'Sample Film',
      subtype: 'urn:entity:movie',
      properties: { release_year: 2010 },
      tags: [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }],
    },
    {
      entity_id: '99999999-8888-7777-6666-555555555555',
      name: 'Sample Film',
      subtype: 'urn:entity:movie',
      properties: { release_year: 2013 },
      tags: [],
    },
  ],
};

/** /search 一个都没中。 */
export const searchEmptyPayload = { success: true, results: [] };

/** 形状对不上：解析必须报上游错误，不能当成"没有结果"。 */
export const malformedPayload = { unexpected: true };

/** /v2/insights 的正常信封：success + results.entities[]。 */
export const insightsPayload = {
  success: true,
  results: {
    entities: [
      {
        entity_id: 'aaaaaaaa-0000-0000-0000-000000000001',
        name: 'Candidate A',
        subtype: 'urn:entity:movie',
        affinity: 0.92,
        popularity: 0.94,
        trend: 0.61,
        properties: {
          release_year: 2010,
          release_date: '2010-07-16',
          content_rating: 'PG-13',
          description: 'Fixture description field.',
          image: { url: 'https://images.example.invalid/a.jpg' },
          // 官方形状的别名数组：中文原名 + 语言标记。
          akas: [
            { value: 'Sample Film', languages: ['en'] },
            { value: '示例影片', languages: ['zh'] },
          ],
        },
        tags: [
          { id: 'urn:tag:keyword:media:sample', name: 'Sample' },
          { id: 'urn:tag:keyword:media:another', name: 'Another' },
        ],
        query: {
          explainability: {
            entities: [
              {
                entity_id: '11111111-2222-3333-4444-555555555555',
                name: 'Sample Film',
                score: 0.82,
              },
            ],
          },
        },
      },
      {
        entity_id: 'aaaaaaaa-0000-0000-0000-000000000002',
        name: 'Candidate B',
        subtype: 'urn:entity:movie',
        affinity: 0.715,
        popularity: 0.55,
        trend: 0.42,
        properties: { release_year: 2013 },
        tags: [{ id: 'urn:tag:keyword:media:another', name: 'Another' }],
      },
      {
        // 服务没给流行度、趋势与标签：字段必须是 null / 空，不能补 0 冒充。
        entity_id: 'aaaaaaaa-0000-0000-0000-000000000004',
        name: 'Candidate D',
        subtype: 'urn:entity:movie',
        affinity: 0.4,
      },
      {
        // 关联分比乙低、流行度比乙高：混入流行度权重后应当上升。
        // 服务默认按关联分排序，所以它的原始名次在最后。
        entity_id: 'aaaaaaaa-0000-0000-0000-000000000003',
        name: 'Candidate C',
        subtype: 'urn:entity:movie',
        affinity: 0.3,
        popularity: 0.99,
        trend: 0.2,
        properties: { release_year: 2015 },
        tags: [],
      },
    ],
  },
};

/** 顶层 explainability 带 warning：算不出来时上游会说明，但结果照常返回。 */
export const insightsWithWarningPayload = {
  success: true,
  query: { explainability: { warning: 'Attribution could not be computed; results only.' } },
  results: {
    entities: [
      {
        entity_id: 'bbbbbbbb-0000-0000-0000-000000000001',
        name: 'Candidate A',
        subtype: 'urn:entity:movie',
        affinity: 0.5,
      },
    ],
  },
};

/** 服务没返回流行度：流行度旋钮就不该出现。 */
export const insightsWithoutPopularityPayload = {
  success: true,
  results: {
    entities: [
      {
        entity_id: 'cccccccc-0000-0000-0000-000000000001',
        name: 'Candidate A',
        subtype: 'urn:entity:movie',
        affinity: 0.8,
      },
      {
        entity_id: 'cccccccc-0000-0000-0000-000000000002',
        name: 'Candidate B',
        subtype: 'urn:entity:movie',
        affinity: 0.6,
      },
    ],
  },
};

/**
 * 20 条候选的夹具：服务一次真的返回 20 条时，界面要能装下并且还能继续展开。
 * 关系分、流行度、趋势都是固定值——夹具要可复现。
 */
export const insightsWithTwentyPayload = {
  success: true,
  results: {
    entities: Array.from({ length: 20 }, (_, index) => ({
      entity_id: `dddddddd-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
      name: `Candidate ${String.fromCharCode(65 + index)}`,
      subtype: 'urn:entity:movie',
      affinity: Math.round((0.95 - index * 0.03) * 100) / 100,
      popularity: Math.round((0.5 + ((index * 7) % 50) / 100) * 100) / 100,
      trend: Math.round((0.3 + ((index * 11) % 60) / 100) * 100) / 100,
      properties: {
        release_year: 2000 + index,
        release_date: `${2000 + index}-01-01`,
        content_rating: 'PG-13',
        description: `Fixture description ${index + 1}.`,
      },
      tags: [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }],
    })),
  },
};

/**
 * 假适配器：按脚本返回结果，用来驱动 HTTP 接口与界面状态。
 * 它**不会**发出任何网络请求。
 */
export function createFixtureAdapter(overrides = {}) {
  const behaviour = {
    configured: true,
    missing: [],
    search: searchResolvedPayload,
    insights: insightsPayload,
    ...overrides,
  };

  return {
    provider: 'fixture',
    configuration: () => ({
      configured: behaviour.configured,
      missing: behaviour.missing,
      accessSurface: 'fixture',
      accessSurfaceConfirmed: true,
    }),
    async resolveSeed(input) {
      if (!behaviour.configured) {
        return { status: 'not_configured', missing: behaviour.missing };
      }
      if (input.seed.trim() === '') {
        return { status: 'invalid_input', issues: ['The seed must not be empty'] };
      }
      const payload = behaviour.search;
      if (payload === 'error') {
        return { status: 'upstream_error', message: 'The fixture simulated an upstream failure.', retryable: true };
      }
      if (payload === 'empty') {
        return { status: 'empty', message: 'The fixture simulated an empty result.' };
      }
      // 复用真实解析器，避免夹具与解析逻辑各说各话。
      const { parseSearchResponse } = await import('../../dist/assets/core/qloo.js');
      return parseSearchResponse(payload);
    },
    async fetchCandidates(input) {
      if (!behaviour.configured) {
        return { status: 'not_configured', missing: behaviour.missing };
      }
      const payload = behaviour.insights;
      if (payload === 'error') {
        return { status: 'upstream_error', message: 'The fixture simulated an upstream failure.', retryable: true };
      }
      if (payload === 'empty') {
        return { status: 'empty', message: 'The fixture simulated no candidates.' };
      }
      const { parseInsightsResponse } = await import('../../dist/assets/core/qloo.js');
      return parseInsightsResponse(payload);
    },
    // 夹具也实现请求预览，形状跟真适配器一致：
    // 真实 HTTP 回放要能把「预览」这一段也走通。
    async previewRequest(input) {
      return input.op === 'resolve'
        ? {
            method: 'GET',
            url: `https://hackathon.api.qloo.com/search?query=${encodeURIComponent(input.seed)}`,
            params: { query: input.seed, types: 'urn:entity:movie', take: 20 },
            note: 'This is a preview of the request that would be sent. Nothing was sent and no budget was spent.',
          }
        : {
            method: 'GET',
            url: `https://hackathon.api.qloo.com/v2/insights?signal.interests.entities=${encodeURIComponent(input.entityId)}`,
            params: {
              'filter.type': 'urn:entity:movie',
              'signal.interests.entities': input.entityId,
              take: input.limit,
            },
            note: 'This is a preview of the request that would be sent. Nothing was sent and no budget was spent.',
          };
    },
  };
}
