// 端到端跑一遍"服务端 → 官方工具 → 解析 → 界面"这条链，用**假的 qloo 可执行文件**。
//
// 这个假程序会真的被 spawn 起来：进程启动、argv 传递、标准输出解析、退出码，
// 这些全都真的走一遍——但它不发任何请求，也不读任何凭据。
// 所以它证明的是**机械链路通不通**，不是"已与 Qloo 联通"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../scripts/serve.mjs';
import { createHarnessAdapter } from '../scripts/qloo-cli.mjs';
import { createRequestBudget } from '../scripts/request-budget.mjs';

const distRoot = new URL('../dist', import.meta.url).pathname;

/** 造一个假的 qloo：记录 argv，然后按子命令打印夹具 JSON。 */
function createFakeQloo(dir, searchJson, insightsJson) {
  const argvLog = join(dir, 'argv.log');
  const binary = join(dir, 'qloo');
  const source = `#!/usr/bin/env node
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
const search = ${JSON.stringify(searchJson)};
const insights = ${JSON.stringify(insightsJson)};
const command = args[1];
if (command === 'search') process.stdout.write(JSON.stringify(search));
else if (command === 'insights') process.stdout.write(JSON.stringify(insights));
else {
  process.stdout.write(JSON.stringify({ error: true, code: 'BAD_USAGE', message: 'unexpected command' }));
  process.exit(2);
}
`;
  writeFileSync(binary, source);
  chmodSync(binary, 0o755);
  return { binary, argvLog };
}

test('服务端真的把命令交给了官方工具，工具的输出也被正确解析', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taste-tuner-fake-qloo-'));
  const searchJson = [
    {
      entity_id: 'uuid-seed-1',
      name: 'Sample Film',
      subtype: 'urn:entity:movie',
      properties: { release_year: 2010 },
      tags: [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }],
    },
  ];
  const insightsJson = [
    {
      entity_id: 'uuid-candidate-1',
      name: 'Candidate A',
      subtype: 'urn:entity:movie',
      affinity: 0.92,
      popularity: 0.94,
      properties: { release_year: 2012, content_rating: 'PG-13' },
      tags: [{ id: 'urn:tag:keyword:media:sample', name: 'Sample' }],
      query: {
        explainability: {
          entities: [{ entity_id: 'uuid-seed-1', name: 'Sample Film', score: 0.82 }],
        },
      },
    },
  ];
  const { binary, argvLog } = createFakeQloo(dir, searchJson, insightsJson);

  const budget = createRequestBudget({
    enabled: true,
    limit: 2,
    stateDir: mkdtempSync(join(tmpdir(), 'taste-tuner-budget-')),
  });
  const adapter = createHarnessAdapter({ binaryPath: binary });
  const server = createStaticServer(distRoot, { adapter, budget });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const resolved = await (
      await fetch(`http://127.0.0.1:${port}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed: 'Sample Film', entityType: 'movie' }),
      })
    ).json();
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.entity.id, 'uuid-seed-1');
    assert.equal(resolved.entity.name, 'Sample Film');
    assert.equal(resolved.entity.year, 2010);

    const candidates = await (
      await fetch(`http://127.0.0.1:${port}/api/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entityId: 'uuid-seed-1', entityType: 'movie', limit: 5 }),
      })
    ).json();
    assert.equal(candidates.status, 'ok');
    assert.equal(candidates.candidates.length, 1);
    assert.equal(candidates.candidates[0].name, 'Candidate A');
    close(candidates.candidates[0].affinity, 0.92);
    assert.equal(candidates.candidates[0].details.contentRating, 'PG-13');
    assert.equal(candidates.candidates[0].contributions.length, 1);

    // 两次调用 = 两次额度，用完即止。
    assert.equal(budget.used(), 2);
    assert.equal(budget.state(), 'exhausted');

    // 命令确实是按核实过的形状发出去的。
    const calls = readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], [
      'api',
      'search',
      '--query',
      'Sample Film',
      '--type',
      'urn:entity:movie',
      '--take',
      '20',
      '--json',
    ]);
    const insightsCall = calls[1];
    assert.equal(insightsCall[0], 'api');
    assert.equal(insightsCall[1], 'insights');
    assert.equal(insightsCall[insightsCall.indexOf('--signal-entities') + 1], 'uuid-seed-1');
    // 输出领域固定是电影。
    assert.equal(insightsCall[insightsCall.indexOf('--type') + 1], 'urn:entity:movie');
    assert.ok(!insightsCall.includes('--signal-query'));
    const params = JSON.parse(insightsCall[insightsCall.indexOf('--params') + 1]);
    assert.equal(params['filter.exclude.entities'], 'uuid-seed-1');
    assert.equal(params['feature.explainability'], 'true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('官方工具报错时，服务端把原因如实送出，不回退成合成结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taste-tuner-fake-qloo-'));
  const { binary } = createFakeQloo(dir, [], []);
  const budget = createRequestBudget({
    enabled: true,
    limit: 2,
    stateDir: mkdtempSync(join(tmpdir(), 'taste-tuner-budget-')),
  });
  const adapter = createHarnessAdapter({ binaryPath: binary });
  const server = createStaticServer(distRoot, { adapter, budget });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await (
      await fetch(`http://127.0.0.1:${port}/api/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed: 'Sample Film', entityType: 'movie' }),
      })
    ).json();
    assert.equal(result.status, 'empty');
    assert.match(result.message, /did not match/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}
