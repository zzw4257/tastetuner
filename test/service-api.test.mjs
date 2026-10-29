// 真实服务 HTTP 接口的检查。
//
// 服务端注入的是 test/helpers/qloo-fixtures.mjs 里的**假适配器**：它不发任何
// 网络请求，也不代表真实 Qloo 的行为。这里验证的是接口契约、状态码、
// 输入校验与"不回退到合成数据"，不是与真实服务联通的证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';
import { createRequestBudget } from '../scripts/request-budget.mjs';
import {
  createFixtureAdapter,
  insightsPayload,
  searchAmbiguousPayload,
  searchResolvedPayload,
} from './helpers/qloo-fixtures.mjs';

const distRoot = new URL('../dist', import.meta.url).pathname;

async function withServer(adapter, run) {
  // 接口层的测试要给足额度；预算本身另有专门用例。
  const budget = createRequestBudget({
    enabled: true,
    limit: 100,
    stateDir: mkdtempSync(join(tmpdir(), 'taste-tuner-api-')),
  });
  const server = createStaticServer(
    distRoot,
    adapter === undefined ? { budget } : { adapter, budget },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(port, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

test('状态接口报告是否配置，不回显任何凭据', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const result = await call(port, '/api/status');
    assert.equal(result.status, 200);
    assert.equal(result.json.configured, true);
    assert.equal(result.json.provider, 'fixture');
    assert.equal(result.json.accessSurface, 'fixture');
    assert.equal(result.json.accessSurfaceConfirmed, true);
    assert.deepEqual(result.json.entityTypes, ['movie']);
    assert.equal(result.json.maxCandidates, 50);
    assert.doesNotMatch(result.text, /api[-_]?key|authorization|bearer|secret/i);
  });
});

test('没有注入适配器时明确报"未配置"，而不是返回空结果', async () => {
  await withServer(undefined, async (port) => {
    const status = await call(port, '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, false);
    assert.deepEqual(status.json.missing, ['QLOO_API_KEY', 'QLOO_BASE_URL']);

    const resolve = await call(port, '/api/resolve', 'POST', {
      seed: '星际穿越',
      entityType: 'movie',
    });
    assert.equal(resolve.status, 503);
    assert.equal(resolve.json.status, 'not_configured');
    assert.deepEqual(resolve.json.missing, ['QLOO_API_KEY', 'QLOO_BASE_URL']);
  });
});

test('公开边界只给解析后的字段：上游原始载荷（raw）不过界', async () => {
  // 哨兵：把一个只有内部才知道的标记放进适配器的 raw 里。
  // 只要它出现在响应体里，就说明原始载荷漏出去了。
  const SENTINEL = 'SENTINEL-INTERNAL-RAW-7f3c9a';
  const adapter = {
    provider: 'fixture',
    configuration: () => ({
      configured: true,
      missing: [],
      accessSurface: 'fixture',
      accessSurfaceConfirmed: true,
    }),
    async resolveSeed() {
      return {
        status: 'resolved',
        entity: {
          id: 'entity-1',
          name: 'Sample Film',
          type: 'movie',
          year: 2010,
          details: { releaseYear: 2010 },
        },
        raw: { sentinel: SENTINEL, entities: [{ entity_id: 'x' }] },
      };
    },
    async fetchCandidates() {
      return {
        status: 'ok',
        candidates: [
          {
            id: 'candidate-1',
            name: 'Candidate A',
            affinity: 0.92,
            affinityRaw: 0.92,
            popularity: 0.9,
            trend: 0.4,
            details: { releaseYear: 2012 },
            contributions: [],
          },
        ],
        raw: { sentinel: SENTINEL, entities: [{ entity_id: 'y' }] },
      };
    },
  };

  await withServer(adapter, async (port) => {
    const resolved = await (
      await fetch(`http://127.0.0.1:${port}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed: 'Sample Film', entityType: 'movie' }),
      })
    ).json();
    assert.equal(resolved.entity.name, 'Sample Film', '解析后的字段照常给');
    assert.equal(resolved.raw, undefined, '原始载荷不过界');
    assert.ok(!JSON.stringify(resolved).includes(SENTINEL), '响应里没有内部哨兵');

    const candidates = await (
      await fetch(`http://127.0.0.1:${port}/api/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId: 'entity-1', limit: 20 }),
      })
    ).json();
    assert.equal(candidates.candidates.length, 1, '解析后的候选照常给');
    assert.equal(candidates.raw, undefined, '原始载荷不过界');
    assert.ok(!JSON.stringify(candidates).includes(SENTINEL), '响应里没有内部哨兵');
  });
});

test('接口的错误理由必须是真的：未知路径一律 404，方法不对就说这个接口收什么', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    // 未知路径与方法无关：任何方法都是 404。
    for (const method of ['GET', 'POST', 'DELETE', 'PUT']) {
      const unknown = await call(port, '/api/nope', method);
      assert.equal(unknown.status, 404, `${method} /api/nope 应该是 404`);
      assert.deepEqual(unknown.json.issues, ['Unknown endpoint']);
    }

    // /api/resolve 只收 POST：不管用哪种错方法，理由都得是真的。
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const wrong = await call(port, '/api/resolve', method);
      assert.equal(wrong.status, 405);
      assert.deepEqual(wrong.json.issues, ['This endpoint only accepts POST']);
    }

    // /api/status 只收 GET。
    const wrongStatus = await call(port, '/api/status', 'POST');
    assert.equal(wrongStatus.status, 405);
    assert.deepEqual(wrongStatus.json.issues, ['This endpoint only accepts GET']);
  });
});

test('种子解析：唯一匹配、歧义与空结果各有各的形状', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const resolved = await call(port, '/api/resolve', 'POST', {
      seed: 'Sample Film',
      entityType: 'movie',
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.status, 'resolved');
    assert.equal(resolved.json.entity.id, '11111111-2222-3333-4444-555555555555');
    assert.equal(resolved.json.entity.type, 'urn:entity:movie');
    assert.equal(resolved.json.entity.year, 2010);
  });

  await withServer(createFixtureAdapter({ search: searchAmbiguousPayload }), async (port) => {
    const ambiguous = await call(port, '/api/resolve', 'POST', {
      seed: 'Sample Film',
      entityType: 'movie',
    });
    assert.equal(ambiguous.status, 200);
    assert.equal(ambiguous.json.status, 'ambiguous');
    assert.equal(ambiguous.json.candidates.length, 2);
    // 消歧列表必须带上年份，好让人核对是不是那一部。
    assert.equal(ambiguous.json.candidates[1].year, 2013);
  });

  await withServer(createFixtureAdapter({ search: 'empty' }), async (port) => {
    const empty = await call(port, '/api/resolve', 'POST', {
      seed: '查无此片',
      entityType: 'movie',
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.status, 'empty');
  });
});

test('输入校验在服务端就挡下，并给出可读原因', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const empty = await call(port, '/api/resolve', 'POST', { seed: '  ', entityType: 'movie' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.status, 'invalid_input');
    assert.deepEqual(empty.json.issues, ['The seed must not be empty']);

    const wrongType = await call(port, '/api/resolve', 'POST', {
      seed: 'Sample Film',
      entityType: 'place',
    });
    assert.equal(wrongType.status, 400);
    assert.match(wrongType.json.issues[0], /The entity type must be/);

    const badId = await call(port, '/api/candidates', 'POST', {
      entityId: 'not a valid id',
      entityType: 'movie',
      limit: 20,
    });
    assert.equal(badId.status, 400);
    assert.match(badId.json.issues[0], /disallowed characters/);

    const badLimit = await call(port, '/api/candidates', 'POST', {
      entityId: 'fixture-movie-1',
      entityType: 'movie',
      limit: 999,
    });
    assert.equal(badLimit.status, 400);
    assert.match(badLimit.json.issues[0], /between 1 and 50/);
  });
});

test('候选接口返回服务字段，不带凭据，也不带任何合成数据', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const result = await call(port, '/api/candidates', 'POST', {
      entityId: 'fixture-movie-1',
      entityType: 'movie',
      limit: 20,
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.status, 'ok');
    assert.equal(result.json.candidates.length, 4);
    assert.equal(result.json.candidates[0].name, 'Candidate A');
    assert.doesNotMatch(result.text, /api[-_]?key|authorization|bearer/i);
    // 合成场景里的片名不能混进真实接口。
    assert.doesNotMatch(result.text, /Warm City Lights|Last Ferry out of the Fog/);
  });
});

test('上游失败映射成可重试或不可重试的明确错误，不静默换路', async () => {
  await withServer(createFixtureAdapter({ insights: 'error' }), async (port) => {
    const result = await call(port, '/api/candidates', 'POST', {
      entityId: 'fixture-movie-1',
      entityType: 'movie',
      limit: 20,
    });
    assert.equal(result.status, 503);
    assert.equal(result.json.status, 'upstream_error');
    assert.equal(result.json.retryable, true);
  });
});

test('接口只接受该接受的请求方式，Unknown endpoint给出 JSON 错误', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const wrongMethod = await call(port, '/api/resolve');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.status, 'invalid_input');

    const unknown = await call(port, '/api/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.status, 'invalid_input');
  });
});

test('请求体不是 JSON 对象时被挡下', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.status, 'invalid_input');
  });
});

test('页面只允许连同源，外部地址仍然被 CSP 挡住', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /connect-src[^;]*\*/);
    assert.match(csp, /default-src 'none'/);
  });
});

test('接口送出的报文形状与界面那一侧期望的一致（防止两边各说各话）', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const resolved = await call(port, '/api/resolve', 'POST', {
      seed: 'Sample Film',
      entityType: 'movie',
    });
    assert.deepEqual(Object.keys(resolved.json).sort(), ['entity', 'status']);
    assert.deepEqual(
      Object.keys(resolved.json.entity).sort(),
      ['id', 'name', 'tags', 'type', 'year'],
    );

    const candidates = await call(port, '/api/candidates', 'POST', {
      entityId: '11111111-2222-3333-4444-555555555555',
      entityType: 'movie',
      limit: 20,
    });
    assert.deepEqual(Object.keys(candidates.json).sort(), ['candidates', 'status']);
    const first = candidates.json.candidates[0];
    assert.deepEqual(
      Object.keys(first).sort(),
      [
        'affinity',
        'affinityRaw',
        'contributions',
        'details',
        'id',
        'name',
        'popularity',
        'serviceRank',
        'tags',
        'trend',
        'type',
      ],
    );
    assert.deepEqual(
      Object.keys(first.details).sort(),
      ['alsoKnownAs', 'contentRating', 'description', 'imageUrl', 'releaseDate', 'releaseYear'],
    );
  });
});

test('请求预览不消耗额度，也不发任何真实请求', async () => {
  const budget = createRequestBudget({
    enabled: true,
    limit: 2,
    stateDir: mkdtempSync(join(tmpdir(), 'taste-tuner-api-')),
  });
  const adapter = {
    provider: 'fixture',
    configuration: () => ({
      configured: true,
      missing: [],
      accessSurface: 'fixture',
      accessSurfaceConfirmed: true,
    }),
    async resolveSeed() {
      return { status: 'resolved', entity: { id: 'x', name: '夹具', type: 'urn:entity:movie', tags: [] } };
    },
    async fetchCandidates() {
      return { status: 'ok', candidates: [] };
    },
    async previewRequest(input) {
      return {
        method: 'GET',
        url: 'https://hackathon.api.qloo.com/search?query=x',
        params: { query: 'x' },
        note: '预览不消耗额度。',
      };
    },
  };
  const server = createStaticServer(distRoot, { adapter, budget });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await (
      await fetch(`http://127.0.0.1:${port}/api/preflight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'resolve', seed: 'Sample Film', entityType: 'movie' }),
      })
    ).json();
    assert.equal(result.status, 'ok');
    assert.equal(result.preview.method, 'GET');
    assert.match(result.preview.url, /hackathon\.api\.qloo\.com/);
    assert.equal(budget.used(), 0, '预览不消耗额度');
    assert.equal(budget.state(), 'available');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---------------------------------------------------------------------------
 * 真实 HTTP 回放：前端**真的那个**客户端 → 真的服务端 → 真的 HTTP。
 *
 * 前面的用例都是自己拼 body 打服务端；DOM 仿真里的 api 又是替身，
 * 所以"前端发的字段"与"服务端要的字段"对不上时，谁都拦不住——
 * 2026-10-29 的隔离后台实页回放就是这么发现的：点「用这个继续」报
 * "The entity type must be a string"，候选一直出不来。
 *
 * 这里用前端真实产物里的 createServiceApi（相对路径按页面源解析），
 * 打真的监听端口，把 resolve → candidates → preflight 整条走一遍。
 * ------------------------------------------------------------------------- */

const { createServiceApi } = await import('../dist/assets/ui/service.js');

test('真实 HTTP 回放：前端那个客户端打真的服务端，整条主线要通', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const base = `http://127.0.0.1:${port}`;
    // 浏览器把相对路径按页面源解析；这里照做，才和真实页面一样。
    const api = createServiceApi((url, init) => fetch(`${base}${url}`, init));

    const status = await api.status();
    assert.equal(status.configured, true);

    // 解析种子：前端发 {seed, entityType}。
    const resolved = await api.resolve('Sample Film', 'movie');
    assert.ok(
      resolved.status === 'resolved' || resolved.status === 'ambiguous',
      `解析应当成功，却拿到 ${resolved.status}`,
    );

    // 取候选：前端只发 {entityId, limit}——服务端不能反过来要一个前端没发的字段。
    const entityId =
      resolved.status === 'resolved'
        ? resolved.entity.id
        : resolved.candidates[0].id;
    const candidates = await api.candidates(entityId, 20);
    assert.equal(candidates.status, 'ok', `取候选应当成功，却拿到 ${candidates.status}`);
    assert.ok(candidates.candidates.length > 0);

    // 候选请求的预览：同一条契约，预览也必须通。
    const preview = await api.preflight({ op: 'candidates', entityId, limit: 20 });
    assert.equal(preview.status, 'ok');
    assert.ok(preview.preview !== undefined);
  });
});

test('真实 HTTP 回放：候选请求不带类别，服务端不许拿这个当理由挡下', async () => {
  await withServer(createFixtureAdapter(), async (port) => {
    const response = await call(port, '/api/candidates', 'POST', {
      entityId: 'urn:entity:movie:1',
      limit: 20,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.status, 'ok');
    assert.ok(!/entity type/.test(response.text), '不该再提实体类别');
  });
});

test('raw HTTP 接入面：对着本机假服务跑通整条路（不碰外部地址）', async () => {
  // 这一条证明"显式 opt-in 的 raw HTTP"不是条死路：真的起一个本机假 Qloo，
  // 让 raw 适配器真的发 HTTP 请求，真的收响应、真的解析。
  // 不联网、不读凭据、不动请求预算账本。
  const { createServer } = await import('node:http');
  const { createQlooAdapter } = await import('../dist/assets/core/qloo.js');

  const seen = [];
  const fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (url.pathname === '/search') {
      res.end(JSON.stringify(searchResolvedPayload));
      return;
    }
    res.end(JSON.stringify(insightsPayload));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const fakePort = fake.address().port;

  const adapter = createQlooAdapter({
    apiKey: 'test-key-not-a-real-credential',
    baseUrl: `http://127.0.0.1:${fakePort}`,
  });
  const budget = createRequestBudget({
    enabled: true,
    limit: 5,
    stateDir: mkdtempSync(join(tmpdir(), 'taste-tuner-raw-')),
  });
  const server = createStaticServer(distRoot, { adapter, budget });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const { createServiceApi } = await import('../dist/assets/ui/service.js');
    const api = createServiceApi((url, init) => fetch(`http://127.0.0.1:${port}${url}`, init));

    const resolved = await api.resolve('Sample Film', 'movie');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.entity.name, 'Sample Film');

    const candidates = await api.candidates(resolved.entity.id, 20);
    assert.equal(candidates.status, 'ok');
    assert.equal(candidates.candidates.length, 4);

    // 假服务真的收到了两个请求，且参数是核实过的那一套。
    const search = seen.find((call) => call.path === '/search');
    assert.ok(search !== undefined, '应当发出过名称解析请求');
    assert.equal(search.params.types, 'urn:entity:movie');
    assert.equal(search.params.query, 'Sample Film');

    const insights = seen.find((call) => call.path === '/v2/insights');
    assert.ok(insights !== undefined, '应当发出过取候选请求');
    assert.equal(insights.params['filter.type'], 'urn:entity:movie');
    assert.equal(insights.params['signal.interests.entities'], resolved.entity.id);
    assert.equal(insights.params['feature.explainability'], 'true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
});
