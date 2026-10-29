// ============================================================================
// 公开树的**合成**夹具：独立手写，只借用字段与嵌套的 **schema**。
//
// 这**不是**任何真实响应的派生：值全是编出来的——虚构年份（2030/2031/2032）、
// 整点日期、整十的片长、两位小数的分数、明显是假的外部标识。
// 不保留任何实测出来的数值组合，也不保留真实片名、真实简介或真实评分统计。
//
// 它要覆盖的是**解析路径**，不是某一次响应的内容：
// - `/search` 的实体没有 subtype/type，只有 types: ["urn:entity:movie"]；
// - `/search` 的标签用 tag_id，`/v2/insights` 的标签用 id；
// - `/search` 的外部标识在 properties.external，`/v2/insights` 在实体顶层；
// - `/search` 的外链是 properties.website（单条），`/v2/insights` 是
//   properties.websites（数组，不止一条）；
// - 关联分在 query.affinity，不在实体顶层；
// - 归因在 query.explainability["signal.interests.entities"]，
//   形如 [{entity_id, score}]；
// - 别名值外面带一对对称的双引号；
// - 流媒体是带 streaming_service 前缀的标签。
// ============================================================================

/** `/search` 的一条实体（形状照 schema，值是编的）。 */
export const slimSearchEntity = {
  name: 'Fixture Film A',
  entity_id: '90000000-0000-0000-0000-000000000001',
  types: ['urn:entity:movie'],
  properties: {
    release_year: 2030,
    release_date: '2030-01-01',
    content_rating: 'PG',
    akas: [
      { value: '"Fixture Alias A"', languages: ['zh'] },
      { value: 'Synthetic Title A', languages: ['en'] },
    ],
    short_descriptions: [{ value: 'Fixture short description.', languages: ['zh'] }],
    website: 'https://example.invalid/a',
    external: { imdb: [{ id: 'tt9000001' }], wikidata: [{ id: 'Q90000001' }] },
  },
  popularity: 0.5,
  disambiguation: '2030',
  tags: [
    {
      name: 'Synthetic Tag',
      tag_id: 'urn:tag:keyword:media:fixture',
      type: 'urn:tag:keyword:media',
    },
  ],
};

/** `/v2/insights` 的一条实体（形状照 schema，值是编的）。 */
export const slimInsightsEntity = {
  name: 'Fixture Film B',
  entity_id: '90000000-0000-0000-0000-000000000002',
  type: 'urn:entity',
  subtype: 'urn:entity:movie',
  properties: {
    release_year: 2031,
    release_date: '2031-01-01',
    content_rating: 'PG',
    duration: 90,
    description: 'Fixture description.',
    image: { url: 'https://images.example.invalid/b.jpg' },
    akas: [{ value: '"Fixture Alias B"', languages: ['zh'] }],
    short_descriptions: [{ value: 'Synthetic short.', languages: ['en'] }],
    websites: ['https://example.invalid/b1', 'https://example.invalid/b2'],
  },
  popularity: 0.4,
  tags: [
    { id: 'urn:tag:genre:media:fixture', name: 'Synthetic', type: 'urn:tag:genre:media' },
    {
      id: 'urn:tag:streaming_service:media:exampleplus',
      name: 'ExamplePlus',
      type: 'urn:tag:streaming_service:media',
    },
  ],
  query: {
    affinity: 0.8,
    measurements: { audience_growth: 0 },
    explainability: {
      'signal.interests.entities': [
        { entity_id: '90000000-0000-0000-0000-000000000001', score: 1 },
      ],
    },
  },
  disambiguation: '2031',
  external: {
    imdb: [{ id: 'tt9000002' }],
    wikidata: [{ id: 'Q90000002' }],
    letterboxd: [{ id: 'fixture-b' }],
  },
};

/** 搜索返回多个候选 —— 就是界面上那份消歧列表。 */
export const slimSearchResponse = {
  results: [
    slimSearchEntity,
    {
      ...slimSearchEntity,
      name: 'Fixture Film A (another one)',
      entity_id: '90000000-0000-0000-0000-000000000003',
      properties: { ...slimSearchEntity.properties, release_year: 2032 },
      disambiguation: '2032',
    },
  ],
};

/** 推荐返回的实体数组。 */
export const slimInsightsResponse = {
  results: {
    entities: [
      slimInsightsEntity,
      {
        ...slimInsightsEntity,
        name: 'Fixture Film C',
        entity_id: '90000000-0000-0000-0000-000000000004',
        query: {
          affinity: 0.6,
          explainability: {
            'signal.interests.entities': [
              { entity_id: '90000000-0000-0000-0000-000000000001', score: 1 },
            ],
          },
        },
      },
    ],
  },
};

/**
 * 官方 CLI 的错误输出**形状**（`{exit, stdout, stderr}`）。
 * 消息是编的，不是任何一次真实调用的输出。
 */
export const slimCliError = {
  exit: 3,
  stdout: '',
  stderr: '{"error":true,"code":"AUTH_FAILED","message":"synthetic auth failure"}',
};
