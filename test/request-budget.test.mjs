// 请求预算的规矩：**默认拒绝**、累计、持久化、阶段只是上限不是开关、未知阶段失败关闭。
// 全部在本地跑，不发任何网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REQUEST_BUDGET,
  createRequestBudget,
  describeBudget,
  readBudgetLimitFromEnv,
  resolvePhaseBudget,
} from '../scripts/request-budget.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), 'taste-tuner-budget-'));
}

test('预算默认拒绝：没显式开启就一次都不许发', () => {
  const budget = createRequestBudget({ enabled: false });
  assert.equal(budget.enabled(), false);
  assert.equal(budget.limit(), 0);
  assert.equal(budget.consume(), false);
  assert.equal(budget.used(), 0);
  assert.match(describeBudget(budget), /off/);
});

test('预扣在请求发出之前，且用完就挡住：累计上限', () => {
  const stateDir = tempStateDir();
  try {
    const budget = createRequestBudget({ enabled: true, limit: 2, stateDir });
    assert.equal(budget.consume(), true);
    assert.equal(budget.consume(), true);
    assert.equal(budget.used(), 2);
    // 第三次：额度用尽，明确拒绝，不计数。
    assert.equal(budget.consume(), false);
    assert.equal(budget.used(), 2);
    assert.equal(budget.remaining(), 0);
    assert.equal(budget.state(), 'exhausted');
    assert.match(describeBudget(budget), /used up/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('额度是累计的：新进程读回旧账本，不会从头再来', () => {
  const stateDir = tempStateDir();
  try {
    const first = createRequestBudget({ enabled: true, limit: 5, stateDir });
    assert.equal(first.consume(), true);
    const second = createRequestBudget({ enabled: true, limit: 5, stateDir });
    assert.equal(second.used(), 1, '重启不能把已用额度清零');
    assert.equal(second.remaining(), 4);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('阶段只是上限，不是开关：公开阶段不写死数字', () => {
  const phase = resolvePhaseBudget('public');
  assert.notEqual(phase, undefined, '公开阶段要认识');
  assert.equal(phase.limit, undefined, '上限由环境变量给，不写死');
  assert.equal(resolvePhaseBudget('not-a-phase'), undefined, '不认识的阶段要失败关闭');
});

test('环境变量读数：没给数字就是没给', () => {
  assert.equal(readBudgetLimitFromEnv({}), undefined);
  assert.equal(readBudgetLimitFromEnv({ QLOO_REQUEST_BUDGET: '' }), undefined);
  assert.equal(readBudgetLimitFromEnv({ QLOO_REQUEST_BUDGET: 'abc' }), undefined);
  assert.equal(readBudgetLimitFromEnv({ QLOO_REQUEST_BUDGET: '25' }), 25);
  assert.equal(DEFAULT_REQUEST_BUDGET > 0, true);
});

/** 起一个真服务端：cwd 指到临时目录，账本不会落到项目里。 */
async function startServer(env) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
    cwd: env.cwd,
    env: { ...process.env, PORT: String(port), ...env.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('request budget:')) resolve(buffer);
    });
    child.stderr.on('data', (chunk) => {
      buffer += String(chunk);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error(`服务端十秒内没起来：${buffer}`)), 10_000);
  });
  return { child, port, line };
}

test('只设阶段名不发额度：阶段是上限，不是开关', async () => {
  const cwd = tempStateDir();
  const { child, port, line } = await startServer({
    cwd,
    env: { QLOO_REQUEST_BUDGET_PHASE: 'public', QLOO_REQUEST_BUDGET: '' },
  });
  try {
    assert.match(line, /request budget: off, no live requests/);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.budget.enabled, false);
    assert.equal(status.budget.limit, 0);
  } finally {
    child.kill('SIGTERM');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('服务端走阶段账本：账本另起一份文件，上限取环境变量给的数', async () => {
  const cwd = tempStateDir();
  const { child, port, line } = await startServer({
    cwd,
    env: { QLOO_REQUEST_BUDGET_PHASE: 'public', QLOO_REQUEST_BUDGET: '25' },
  });
  try {
    assert.match(line, /request budget: 25 requests \(used 0\)/);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(status.budget.limit, 25);
    assert.equal(status.budget.used, 0);
    // 账本路径打在启动日志里：不然没人能确认用的是哪一份账。
    assert.ok(
      line.includes(join('.taste-tuner', 'public', 'request-budget.json')),
      '阶段账本要另起一份文件',
    );
    assert.ok(!line.includes(root), '账本不能落在项目目录里——测试用的是临时目录');
  } finally {
    child.kill('SIGTERM');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('阶段只允许赛事 host：别的 host 拒绝启动', async () => {
  const cwd = tempStateDir();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [join(root, 'scripts', 'serve.mjs')], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      QLOO_REQUEST_BUDGET_PHASE: 'public',
      QLOO_REQUEST_BUDGET: '5',
      QLOO_BASE_URL: 'https://example.invalid',
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
  try {
    assert.notEqual(result.code, 0, '非赛事 host 必须起不来');
    assert.match(result.stderr, /Only the event host https:\/\/hackathon\.api\.qloo\.com/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
