import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import { CAMPAIGN, checkPlatformEnv, createPlatformHandler } from '../scripts/platform-handler.mjs';

/**
 * 平台入口的本地检查：只跑 HTTP 形状与失败关闭，
 * **不发任何 Qloo 请求**，也不碰任何云存储。
 */

/** 一份"全部正确"的生产环境变量。 */
function approvedEnv(overrides = {}) {
  return {
    VERCEL_ENV: 'production',
    QLOO_ACCESS_SURFACE: 'http',
    QLOO_DURABLE_BUDGET: '1',
    QLOO_DURABLE_PHASE_ID: CAMPAIGN.phaseId,
    QLOO_BLOB_ADAPTER: new URL('./helpers/fake-blob-store.mjs', import.meta.url).pathname,
    QLOO_REQUEST_BUDGET: String(CAMPAIGN.limit),
    QLOO_REQUEST_BUDGET_CUTOFF: CAMPAIGN.cutoff,
    QLOO_API_KEY: 'test-key-not-a-real-credential',
    ...overrides,
  };
}

/** 起一个本地服务，把平台处理器挂在上面，模拟平台的函数调用。 */
async function withPlatform(env, run) {
  const handle = await createPlatformHandler(env);
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('环境齐全时：状态接口返回 JSON，预算显示共享计数', async () => {
  await withPlatform(approvedEnv(), async (origin) => {
    const response = await fetch(`${origin}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'qloo');
    assert.equal(body.accessSurface, 'raw-http');
    assert.equal(body.budget.limit, CAMPAIGN.limit);
    assert.equal(body.budget.state, 'not_initialized', '共享状态还没建 → 拒绝发请求');
  });
});

test('Unknown endpoint 404，不是 500', async () => {
  await withPlatform(approvedEnv(), async (origin) => {
    const response = await fetch(`${origin}/api/does-not-exist`);
    assert.equal(response.status, 404);
  });
});

test('没开共享预算 → 拒绝服务，不退回文件账本', async () => {
  await withPlatform(
    approvedEnv({ QLOO_DURABLE_BUDGET: '', QLOO_REQUEST_BUDGET: '500' }),
    async (origin) => {
      for (const path of ['/api/status', '/api/resolve']) {
        const response = await fetch(`${origin}${path}`, { method: 'POST' });
        assert.equal(response.status, 503, `${path} 必须拒绝服务`);
        const body = await response.json();
        assert.equal(body.status, 'upstream_error');
      }
    },
  );
});

test('预览环境 → 拒绝服务，也不自建预算', async () => {
  await withPlatform(
    approvedEnv({ VERCEL_ENV: 'preview', QLOO_API_KEY: '' }),
    async (origin) => {
      const response = await fetch(`${origin}/api/status`);
      assert.equal(response.status, 503);
      assert.match((await response.json()).message, /not ready/);
    },
  );
});

test('campaign 对不上（phase id / cap / 截止时间）→ 拒绝服务', async () => {
  const mismatches = [
    { QLOO_DURABLE_PHASE_ID: 'someone-elses-phase' },
    { QLOO_REQUEST_BUDGET: '1000' },
    { QLOO_REQUEST_BUDGET_CUTOFF: '2026-12-31T00:00:00Z' },
  ];
  for (const overrides of mismatches) {
    await withPlatform(approvedEnv(overrides), async (origin) => {
      const response = await fetch(`${origin}/api/status`);
      assert.equal(response.status, 503, `campaign 不匹配必须拒绝服务：${JSON.stringify(overrides)}`);
    });
  }
});

test('缺凭据 → 拒绝服务', async () => {
  await withPlatform(approvedEnv({ QLOO_API_KEY: '' }), async (origin) => {
    const response = await fetch(`${origin}/api/status`);
    assert.equal(response.status, 503);
  });
});

test('起不来时给说人话的 503，不把内部报错甩出去', async () => {
  await withPlatform(
    approvedEnv({ QLOO_BLOB_ADAPTER: '../test/helpers/no-create-blob-store.mjs' }),
    async (origin) => {
      const response = await fetch(`${origin}/api/status`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, 'upstream_error');
      assert.doesNotMatch(body.message, /QLOO_BLOB_ADAPTER|Cannot find module/);
    },
  );
});

test('环境检查本身：逐条说出哪里不对', () => {
  assert.deepEqual(checkPlatformEnv(approvedEnv()), []);
  assert.match(checkPlatformEnv(approvedEnv({ VERCEL_ENV: 'preview' })).join(), /production/);
  assert.match(checkPlatformEnv(approvedEnv({ QLOO_DURABLE_BUDGET: '' })).join(), /shared budget/);
  assert.match(checkPlatformEnv(approvedEnv({ QLOO_DURABLE_PHASE_ID: 'x' })).join(), /phase id/);
  assert.match(checkPlatformEnv(approvedEnv({ QLOO_REQUEST_BUDGET: '1' })).join(), /cap/);
  assert.match(checkPlatformEnv(approvedEnv({ QLOO_REQUEST_BUDGET_CUTOFF: 'x' })).join(), /cutoff/);
  assert.match(checkPlatformEnv(approvedEnv({ QLOO_API_KEY: '' })).join(), /credential/);
  // 适配器路径不再必填：打包进来的那个就是默认。
  assert.deepEqual(checkPlatformEnv(approvedEnv({ QLOO_BLOB_ADAPTER: '' })), []);
});
