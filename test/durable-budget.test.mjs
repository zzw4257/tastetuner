import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyStoreError,
  createDurableBudget,
  durableBudgetPath,
  initializeDurableBudget,
  loadBlobStore,
} from '../scripts/durable-budget.mjs';

/**
 * 假存储：本地内存里的 blob 表，带 etag 与 CAS 语义。
 * 它**不是**真存储——只用来验证本模块的判定与调用形状。
 */
function createFakeBlobStore() {
  const blobs = new Map();
  const calls = { get: [], put: [] };
  let counter = 0;
  let pendingPutError = null;
  let failAfterWrite = false;
  let getShape = null;

  const conflict = () => Object.assign(new Error('conflict'), { status: 412 });

  return {
    blobs,
    calls,
    failNextPut(error) {
      pendingPutError = error;
      failAfterWrite = false;
    },
    /** 写已经落地，但调用方拿到的是错误：这次写入的结果**未知**。 */
    failNextPutAfterWrite(error) {
      pendingPutError = error;
      failAfterWrite = true;
    },
    /** 覆盖读到的样子：比如没有 etag、或者返回 304。 */
    setGetShape(shape) {
      getShape = shape;
    },
    resetCalls() {
      calls.get.length = 0;
      calls.put.length = 0;
    },
    async get(path, options) {
      calls.get.push({ path, options });
      const blob = blobs.get(path);
      if (blob === undefined) return null;
      // 真存储返回的是 body 流 + etag；这里照着来，另外带上状态码。
      const shape = getShape ?? { status: 200, etag: blob.etag };
      return { body: new Response(blob.body).body, status: shape.status, etag: shape.etag };
    },
    async put(path, body, options) {
      calls.put.push({ path, body, options });
      if (pendingPutError !== null && !failAfterWrite) {
        const error = pendingPutError;
        pendingPutError = null;
        throw error;
      }
      const existing = blobs.get(path);
      if (options.ifMatch !== undefined) {
        if (existing === undefined) throw conflict();
        if (existing.etag !== options.ifMatch) throw conflict();
      }
      if (existing !== undefined && options.allowOverwrite === false) {
        throw Object.assign(new Error('already exists'), { status: 409 });
      }
      counter += 1;
      const etag = `etag-${counter}`;
      blobs.set(path, { body: String(body), etag });
      if (pendingPutError !== null && failAfterWrite) {
        const error = pendingPutError;
        pendingPutError = null;
        failAfterWrite = false;
        throw error;
      }
      return { etag };
    },
  };
}

const PHASE = 'public-20261029';
const CUTOFF = '2026-11-06T04:45:00Z';

async function seeded(overrides = {}) {
  const adapter = createFakeBlobStore();
  await initializeDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF, ...overrides });
  // 初始化那一下不算在后面的断言里：只看"初始化之后"的调用。
  adapter.resetCalls();
  return adapter;
}

test('同一个 phase id 的所有部署共用同一份计数', async () => {
  const adapter = await seeded();
  const first = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });
  const second = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await first.consume(), true);
  assert.equal(await second.consume(), true);

  const snapshot = await first.snapshot();
  assert.equal(snapshot.used, 2, '第二个部署看到的是同一份计数');
});

test('预扣在发请求之前，且失败也不退还', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), true);
  // 假装后面的真实调用失败了：额度不退还，也不重试。
  assert.equal(await budget.consume(), true);
  assert.equal((await budget.snapshot()).used, 2);
  assert.equal(adapter.calls.put.length, 2, '每次预扣写一次，没有额外的重试写');
});

test('CAS 冲突 → 拒绝：不重试、不重建、不发请求', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  adapter.failNextPut(Object.assign(new Error('conflict'), { status: 412 }));
  assert.equal(await budget.consume(), false);
  assert.equal(adapter.calls.put.length, 1, '冲突后不重试');
  assert.equal(budget.state(), 'conflict');
  assert.equal((await budget.snapshot()).used, 0, '冲突没有把计数写进去');
});

test('存储报错 → 拒绝；配额耗尽 → 拒绝', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  adapter.failNextPut(new Error('network down'));
  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'store_error');

  adapter.failNextPut(Object.assign(new Error('quota'), { status: 429 }));
  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'quota_exhausted');
  assert.equal(adapter.calls.put.length, 2, '两种失败都没有重试');
});

test('读不到共享状态 → 拒绝，且不重建', async () => {
  const adapter = createFakeBlobStore();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'not_initialized');
  assert.equal(adapter.calls.put.length, 0, '没有状态时绝不自己建一份');
});

test('状态损坏 → 拒绝', async () => {
  const adapter = await seeded();
  adapter.blobs.set(durableBudgetPath(PHASE), { body: '{ 这不是 JSON', etag: 'etag-x' });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'unknown_state');
});

test('phase 对不上 → 拒绝（不拿别的 phase 的计数凑数）', async () => {
  const adapter = await seeded();
  // 同一个文件里写着别的 phase：不能拿它凑数。
  adapter.blobs.set(durableBudgetPath(PHASE), {
    body: JSON.stringify({
      version: 1,
      phaseId: 'some-other-phase',
      used: 3,
      limit: 500,
      cutoff: CUTOFF,
    }),
    etag: 'etag-mismatch',
  });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'phase_mismatch');
});

test('额度用尽 → 拒绝', async () => {
  const adapter = await seeded({ limit: 1 });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 1, cutoff: CUTOFF });

  assert.equal(await budget.consume(), true);
  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'exhausted');
});

test('过了截止时间 → 拒绝，而且不碰存储', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({
    adapter,
    phaseId: PHASE,
    limit: 500,
    cutoff: CUTOFF,
    now: () => Date.parse('2026-11-06T04:45:00Z'),
  });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'cutoff');
  assert.equal(adapter.calls.get.length, 0, '过期后连读都不读');
});

test('没给上限 → 不发请求', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 0, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.enabled(), false);
});

test('初始化只做一次：已有状态不覆盖、不重置', async () => {
  const adapter = createFakeBlobStore();
  const first = await initializeDurableBudget({
    adapter,
    phaseId: PHASE,
    limit: 500,
    cutoff: CUTOFF,
  });
  assert.equal(first.created, true);

  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });
  await budget.consume();

  const second = await initializeDurableBudget({
    adapter,
    phaseId: PHASE,
    limit: 500,
    cutoff: CUTOFF,
  });
  assert.equal(second.created, false);
  assert.equal(second.state.used, 1, '重新部署不会把计数清零');
});

test('初始化并发时用别人建好的那份，不覆盖', async () => {
  const adapter = createFakeBlobStore();
  adapter.blobs.set(durableBudgetPath(PHASE), {
    body: JSON.stringify({ version: 1, phaseId: PHASE, used: 7, limit: 500, cutoff: CUTOFF }),
    etag: 'etag-existing',
  });

  const result = await initializeDurableBudget({
    adapter,
    phaseId: PHASE,
    limit: 500,
    cutoff: CUTOFF,
  });
  assert.equal(result.created, false);
  assert.equal(result.state.used, 7);
  assert.equal(adapter.calls.put.length, 0, '已存在就不写');
});

test('读写形状：私有、固定路径、CAS 条件写', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  await budget.consume();

  const read = adapter.calls.get[0];
  assert.equal(read.options.access, 'private');
  assert.equal(read.options.useCache, false);
  assert.equal(read.path, 'taste-tuner/phase/public-20261029/budget.json');

  const write = adapter.calls.put[0];
  assert.equal(write.options.access, 'private');
  assert.equal(write.options.allowOverwrite, true);
  assert.equal(write.options.addRandomSuffix, false);
  assert.equal(typeof write.options.ifMatch, 'string', '写必须带 etag 做 CAS');
});

test('phase id 不合法 → 直接拒绝，不拼路径', () => {
  assert.throws(() => durableBudgetPath('../escape'), /phase id/);
  assert.throws(() => durableBudgetPath('a/b'), /phase id/);
  assert.throws(() => durableBudgetPath(''), /phase id/);
});

/* ------------------------- 评审指出的那几个洞 ------------------------- */

test('读到没有 etag 的状态 → 拒绝（ifMatch 会退化成无条件覆盖）', async () => {
  const adapter = await seeded();
  adapter.setGetShape({ status: 200, etag: '' });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'unknown_state');
  assert.equal(adapter.calls.put.length, 0, '没有可信 etag 就不许写');
});

test('读到 304（没改动）→ 拒绝，不拿它当账本', async () => {
  const adapter = await seeded();
  adapter.setGetShape({ status: 304, etag: 'etag-1' });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(adapter.calls.put.length, 0);
});

test('存下来的上限或截止时间坏了 → 拒绝', async () => {
  const adapter = await seeded();
  const path = durableBudgetPath(PHASE);
  adapter.blobs.set(path, {
    body: JSON.stringify({ version: 1, phaseId: PHASE, used: 1, limit: '很多', cutoff: CUTOFF }),
    etag: 'etag-bad-limit',
  });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });
  assert.equal(await budget.consume(), false);

  adapter.blobs.set(path, {
    body: JSON.stringify({ version: 1, phaseId: PHASE, used: 1, limit: 500, cutoff: '不是时间' }),
    etag: 'etag-bad-cutoff',
  });
  assert.equal(await budget.consume(), false);
  assert.equal(adapter.calls.put.length, 0, '账本读不出来就不许写');
});

test('存下来的上限比配置更宽松 → 拒绝（状态被改过）', async () => {
  const adapter = await seeded();
  const path = durableBudgetPath(PHASE);
  adapter.blobs.set(path, {
    body: JSON.stringify({ version: 1, phaseId: PHASE, used: 0, limit: 100000, cutoff: CUTOFF }),
    etag: 'etag-wider',
  });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'state_mismatch');
});

test('存下来的截止时间比配置更晚 → 拒绝', async () => {
  const adapter = await seeded();
  const path = durableBudgetPath(PHASE);
  adapter.blobs.set(path, {
    body: JSON.stringify({
      version: 1,
      phaseId: PHASE,
      used: 0,
      limit: 500,
      cutoff: '2026-12-31T00:00:00Z',
    }),
    etag: 'etag-later',
  });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), false);
  assert.equal(budget.state(), 'state_mismatch');
});

test('配置比存下来的更宽松 → 按存的来（额度只能调小、调早）', async () => {
  const adapter = await seeded();
  // 存的：上限 300、截止 2026-11-01；配置给的是 500 与 11-06。
  const path = durableBudgetPath(PHASE);
  adapter.blobs.set(path, {
    body: JSON.stringify({
      version: 1,
      phaseId: PHASE,
      used: 0,
      limit: 300,
      cutoff: '2026-11-01T00:00:00Z',
    }),
    etag: 'etag-stricter',
  });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  assert.equal(await budget.consume(), true);
  const snapshot = await budget.snapshot();
  assert.equal(snapshot.limit, 300, '生效上限取更严的那个');
});

test('写入结果未知（写进去了但报错）→ 拒绝，且不重试、不退还', async () => {
  const adapter = await seeded();
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 500, cutoff: CUTOFF });

  adapter.failNextPutAfterWrite(new Error('connection reset'));
  assert.equal(await budget.consume(), false);
  assert.equal(adapter.calls.put.length, 1, '结果未知时不重试');

  const stored = JSON.parse(adapter.blobs.get(durableBudgetPath(PHASE)).body);
  assert.equal(stored.used, 1, '那一次写入已经落地，额度算掉了，不退还');
});

test('并发预扣：不会丢更新，也不会超过上限', async () => {
  const adapter = await seeded();
  const limit = 5;
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit, cutoff: CUTOFF });

  const results = await Promise.all(
    Array.from({ length: 8 }, () => budget.consume()),
  );
  const allowed = results.filter((ok) => ok === true).length;

  const stored = JSON.parse(adapter.blobs.get(durableBudgetPath(PHASE)).body);
  assert.ok(allowed <= limit, `放行数不能超过上限：${allowed} > ${limit}`);
  assert.equal(stored.used, allowed, '共享计数正好等于放行数：没有丢更新，也没有重复计数');
});

test('并发预扣：只剩一格时只放行一个', async () => {
  const adapter = await seeded({ limit: 1 });
  const budget = createDurableBudget({ adapter, phaseId: PHASE, limit: 1, cutoff: CUTOFF });

  const results = await Promise.all([budget.consume(), budget.consume()]);
  assert.equal(results.filter((ok) => ok === true).length, 1);
  const stored = JSON.parse(adapter.blobs.get(durableBudgetPath(PHASE)).body);
  assert.equal(stored.used, 1);
});

test('存储报错的归类', () => {
  assert.equal(classifyStoreError({ status: 412 }), 'conflict');
  assert.equal(classifyStoreError({ code: 'conflict' }), 'conflict');
  assert.equal(classifyStoreError({ status: 429 }), 'quota_exhausted');
  assert.equal(classifyStoreError({ code: 'storage_limit_exceeded' }), 'quota_exhausted');
  assert.equal(classifyStoreError(new Error('boom')), 'store_error');
});

test('适配器模块必须导出 createBlobStore', async () => {
  await assert.rejects(
    () => loadBlobStore(new URL('./helpers/no-create-blob-store.mjs', import.meta.url).pathname),
    /createBlobStore/,
  );
});

/* ---------------------------- 打包 ---------------------------- */

test('打包用静态引入：动态 import 的模块不会进函数包（第一次部署就是这样起不来的）', async () => {
  const source = await readFile(new URL('../scripts/durable-budget.mjs', import.meta.url), 'utf8');
  // 适配器必须**静态**引入：打包器靠静态 import 决定哪些文件进函数包。
  assert.match(
    source,
    /^import \{ createBlobStore \} from '\.\/vercel-blob-adapter\.mjs';$/m,
    '适配器必须是静态 import，否则打包器追不到它',
  );
  // 适配器自己必须静态引入 SDK：否则 @vercel/blob 也不会进包。
  const adapter = await readFile(
    new URL('../scripts/vercel-blob-adapter.mjs', import.meta.url),
    'utf8',
  );
  assert.match(adapter, /^import \{[^}]*\} from '@vercel\/blob';$/m, 'SDK 必须静态引入');

  // 候选树里也得有这两个文件（发布的是候选树，不是源码树）。
  const candidate = new URL(
    '../../artifacts/release-candidate-20261029/scripts/',
    import.meta.url,
  );
  if (existsSync(candidate)) {
    assert.ok(existsSync(new URL('vercel-blob-adapter.mjs', candidate)), '候选树缺适配器');
    assert.ok(existsSync(new URL('durable-budget.mjs', candidate)), '候选树缺预算模块');
  }
});

/* ---------------------------- 服务端接线 ---------------------------- */

const root = fileURLToPath(new URL('..', import.meta.url));

test('没给适配器路径 → 用打包进来的那个（静态引入，不联网）', async () => {
  const store = await loadBlobStore(undefined);
  assert.equal(typeof store.get, 'function');
  assert.equal(typeof store.put, 'function');
});

test('开了持久预算却拿不到适配器 → 拒绝启动，不悄悄退回文件账本', async () => {
  const child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
    cwd: mkdtempSync(join(tmpdir(), 'taste-tuner-durable-')),
    env: {
      ...process.env,
      PORT: '4198',
      QLOO_DURABLE_BUDGET: '1',
      QLOO_DURABLE_PHASE_ID: 'public-20261029',
      QLOO_BLOB_ADAPTER: '../test/helpers/no-create-blob-store.mjs',
      QLOO_REQUEST_BUDGET: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  // 适配器给错（模块没有 createBlobStore）→ 拒绝启动，绝不悄悄退回文件账本。
  assert.notEqual(result.code, 0, '适配器不可用必须起不来');
  assert.match(result.stderr, /createBlobStore/);
});

test('持久预算模式下：状态接口读的是共享计数，账本位置写在启动日志里', async () => {
  const child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
    cwd: mkdtempSync(join(tmpdir(), 'taste-tuner-durable-')),
    env: {
      ...process.env,
      PORT: '4197',
      QLOO_DURABLE_BUDGET: '1',
      QLOO_DURABLE_PHASE_ID: 'public-20261029',
      QLOO_BLOB_ADAPTER: join(root, 'test', 'helpers', 'fake-blob-store.mjs'),
      QLOO_REQUEST_BUDGET: '500',
      QLOO_REQUEST_BUDGET_CUTOFF: '2026-11-06T04:45:00Z',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const status = await (await fetch('http://127.0.0.1:4197/api/status')).json();
    assert.equal(status.budget.limit, 500, '上限来自环境变量');
    assert.equal(status.budget.enabled, true);
    assert.equal(status.budget.state, 'not_initialized', '共享状态还没建 → 拒绝发请求');
    assert.match(stdout, /shared storage taste-tuner\/phase\/public-20261029\/budget\.json/);
  } finally {
    child.kill('SIGTERM');
  }
});
