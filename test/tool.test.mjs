// 工具面的合约测试：全部用**合成数据**与**本机假服务**，不发任何真实请求。
//
// 这个文件在源码树与发布候选树里是同一份（路径都相对项目根），
// 所以它验的是"工具契约"，不是某一次真实响应。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolRegistry, runTool } from '../scripts/tool.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 往上找构建产物：源码树在 ../../dist，候选树在 ../dist。 */
function findServiceModule() {
  let current = here;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'dist', 'assets', 'core', 'service.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** 合成候选：字段形状照生产契约，值全部是假的。 */
const syntheticCandidates = [
  {
    id: 'synthetic-candidate-1',
    name: 'Synthetic Film A',
    type: 'urn:entity:movie',
    affinity: 0.8,
    affinityRaw: 0.8,
    popularity: 0.4,
    trend: null,
    serviceRank: 1,
    contributions: [],
    details: { releaseYear: 2010, contentRating: 'PG' },
    tags: [{ id: 'urn:tag:keyword:media:synthetic', name: 'Synthetic' }],
  },
  {
    id: 'synthetic-candidate-2',
    name: 'Synthetic Film B',
    type: 'urn:entity:movie',
    affinity: 0.5,
    affinityRaw: 0.5,
    popularity: 0.9,
    trend: null,
    serviceRank: 2,
    contributions: [],
    details: { releaseYear: 1998, contentRating: 'R' },
    tags: [{ id: 'urn:tag:keyword:media:other', name: 'Other' }],
  },
];

test('工具面：三个工具都带输入 schema', async () => {
  const registry = loadToolRegistry();
  assert.equal(registry.tools.length, 3);
  for (const tool of registry.tools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(tool.input_schema.type, 'object');
    assert.ok(Array.isArray(tool.input_schema.required));
  }
  const listed = await runTool(['list-tools']);
  assert.equal(listed.status, 'ok');
  assert.equal(listed.data.tools.length, 3);
});

test('工具面：参数不合法就说清楚，不去猜', async () => {
  const missing = await runTool(['call', 'resolve_seed', '{}']);
  assert.equal(missing.status, 'invalid_input');
  assert.match(missing.message, /Missing required field: seed/);

  const badEnum = await runTool(['call', 'resolve_seed', '{"seed":"x","entity_type":"album"}']);
  assert.equal(badEnum.status, 'invalid_input');

  const unknownTool = await runTool(['call', 'nope', '{}']);
  assert.equal(unknownTool.status, 'invalid_input');

  const badJson = await runTool(['call', 'resolve_seed', '{']);
  assert.equal(badJson.status, 'invalid_input');
});

test('工具面：HTTP 工具打的是应用自己的接口，参数映射正确', async () => {
  const received = [];
  const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/resolve') {
        res.end(
          JSON.stringify({
            status: 'ambiguous',
            candidates: [{ id: 'synthetic-entity-1', name: 'Synthetic Film A', type: 'urn:entity:movie' }],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ status: 'ok', candidates: syntheticCandidates }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${fake.address().port}`;
  try {
    const resolved = await runTool(['call', 'resolve_seed', '{"seed":"Synthetic Film Title"}'], {
      env: { TASTE_TUNER_BASE_URL: baseUrl },
    });
    assert.equal(resolved.status, 'ambiguous');
    assert.equal(resolved.tool, 'resolve_seed');
    assert.equal(received[0].url, '/api/resolve');
    assert.deepEqual(received[0].body, { seed: 'Synthetic Film Title', entityType: 'movie' });

    const candidates = await runTool(
      ['call', 'get_candidates', '{"entity_id":"synthetic-entity-1","limit":5}'],
      { env: { TASTE_TUNER_BASE_URL: baseUrl } },
    );
    assert.equal(candidates.status, 'ok');
    assert.equal(received[1].url, '/api/candidates');
    assert.deepEqual(received[1].body, { entityId: 'synthetic-entity-1', limit: 5 });
    assert.equal(candidates.data.candidates.length, 2);
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('工具面：本地重排用生产重排器，不发请求', async () => {
  const modulePath = findServiceModule();
  assert.ok(modulePath !== undefined, '要先构建：npm run build');
  const result = await runTool(
    [
      'call',
      'reorder_candidates',
      JSON.stringify({
        candidates: syntheticCandidates,
        weights: { affinity: 100, popularity: 100, tag_similarity: 0 },
      }),
    ],
    { env: { TASTE_TUNER_SERVICE_MODULE: modulePath } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'local');
  assert.equal(result.data.candidates.length, 2);
  // 流行度权重拉高了第二部：它靠 popularity 0.9 超过了 0.4。
  assert.equal(result.data.candidates[0].name, 'Synthetic Film B');
  assert.ok(result.data.candidates[0].score > result.data.candidates[1].score);
  assert.ok(typeof result.data.candidates[0].delta_rank === 'number');
});

test('工具面：硬约束挡下的候选要单独说出来', async () => {
  const modulePath = findServiceModule();
  const result = await runTool(
    [
      'call',
      'reorder_candidates',
      JSON.stringify({
        candidates: syntheticCandidates,
        constraint: { max_content_rating: 'PG' },
      }),
    ],
    { env: { TASTE_TUNER_SERVICE_MODULE: modulePath } },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.data.candidates.length, 1);
  assert.equal(result.data.blocked_by_constraint.length, 1);
  assert.equal(result.data.blocked_by_constraint[0].name, 'Synthetic Film B');
});
