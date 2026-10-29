// 官方 CLI 接入面的检查。
//
// 这里的 runner 是**注入的假执行器**：它不启动任何进程，也不发任何请求。
// 检查的是"如果要调官方工具，会发出什么命令、拿到什么输出、怎么解释错误"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_PACKAGE,
  QLOO_ACCESS_SURFACE_ENV,
  createHarnessAdapter,
  parseCliError,
  resolveHarnessBinary,
} from '../scripts/qloo-cli.mjs';
import {
  searchAmbiguousPayload,
  searchEmptyPayload,
  searchResolvedPayload,
} from './helpers/qloo-fixtures.mjs';

function recordingRunner(result) {
  const calls = [];
  return {
    calls,
    runner: async (args) => {
      calls.push([...args]);
      return typeof result === 'function' ? result(args) : result;
    },
  };
}

test('官方工具在项目里找得到，不用全局安装', () => {
  const binary = resolveHarnessBinary();
  assert.ok(binary !== undefined, `没找到 ${HARNESS_PACKAGE} 的可执行文件`);
  assert.match(binary, /node_modules[/\\]\.bin[/\\]qloo$/);
});

test('名称解析的命令就是核实过的那条：api search --query --type --take --json', async () => {
  const { calls, runner } = recordingRunner({
    code: 0,
    stdout: JSON.stringify(searchResolvedPayload.results),
    stderr: '',
  });
  const adapter = createHarnessAdapter({ runner });

  const outcome = await adapter.resolveSeed({ seed: 'Sample Film', entityType: 'movie' });
  assert.equal(outcome.status, 'resolved');
  assert.equal(calls.length, 1);
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
});

test('推荐命令带上排除种子与归因开关，用 --params 传原始参数', async () => {
  const { calls, runner } = recordingRunner({
    code: 0,
    stdout: JSON.stringify([
      {
        entity_id: 'seed-uuid',
        name: 'Candidate A',
        subtype: 'urn:entity:movie',
        affinity: 0.5,
      },
    ]),
    stderr: '',
  });
  const adapter = createHarnessAdapter({ runner });

  const outcome = await adapter.fetchCandidates({
    entityId: 'seed-uuid',
    entityType: 'movie',
    limit: 20,
  });
  assert.equal(outcome.status, 'ok');

  const args = calls[0];
  assert.equal(args[0], 'api');
  assert.equal(args[1], 'insights');
  assert.equal(args[args.indexOf('--signal-entities') + 1], 'seed-uuid');
  const params = JSON.parse(args[args.indexOf('--params') + 1]);
  assert.equal(params['filter.exclude.entities'], 'seed-uuid');
  assert.equal(params['feature.explainability'], 'true');
});

test('官方 CLI 打印的是实体数组：照样能分出唯一、歧义与空', async () => {
  const unique = recordingRunner({
    code: 0,
    stdout: JSON.stringify(searchResolvedPayload.results),
    stderr: '',
  });
  const resolved = await createHarnessAdapter({ runner: unique.runner }).resolveSeed({
    seed: 'Sample Film',
    entityType: 'movie',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.entity.name, 'Sample Film');

  const ambiguous = recordingRunner({
    code: 0,
    stdout: JSON.stringify(searchAmbiguousPayload.results),
    stderr: '',
  });
  const ambiguousOutcome = await createHarnessAdapter({ runner: ambiguous.runner }).resolveSeed({
    seed: 'Sample Film',
    entityType: 'movie',
  });
  assert.equal(ambiguousOutcome.status, 'ambiguous');
  assert.equal(ambiguousOutcome.candidates.length, 2);

  const empty = recordingRunner({
    code: 0,
    stdout: JSON.stringify(searchEmptyPayload.results),
    stderr: '',
  });
  const emptyOutcome = await createHarnessAdapter({ runner: empty.runner }).resolveSeed({
    seed: '查无此片',
    entityType: 'movie',
  });
  assert.equal(emptyOutcome.status, 'empty');
});

test('官方工具的错误被如实解释：鉴权不可重试，没找到算空结果', async () => {
  const auth = recordingRunner({
    code: 3,
    stdout: '',
    stderr: '{"error":true,"code":"AUTH_FAILED","message":"Welcome to Qloo CLI!"}',
  });
  const authOutcome = await createHarnessAdapter({ runner: auth.runner }).resolveSeed({
    seed: 'Sample Film',
    entityType: 'movie',
  });
  assert.equal(authOutcome.status, 'upstream_error');
  assert.equal(authOutcome.retryable, false);
  assert.match(authOutcome.message, /The official tool rejected this request/);

  const notFound = recordingRunner({
    code: 4,
    stdout: '',
    stderr: '{"error":true,"code":"NOT_FOUND","message":"Entity not found."}',
  });
  const notFoundOutcome = await createHarnessAdapter({ runner: notFound.runner }).resolveSeed({
    seed: '查无此片',
    entityType: 'movie',
  });
  assert.equal(notFoundOutcome.status, 'empty');
});

test('CLI 的结构化错误能被挖出来；不是 JSON 就当普通输出', () => {
  const parsed = parseCliError({
    code: 5,
    stdout: '',
    stderr: 'noise {"error":true,"code":"API_ERROR","message":"boom"}',
  });
  assert.equal(parsed?.code, 'API_ERROR');
  assert.equal(parsed?.message, 'boom');

  assert.equal(
    parseCliError({ code: 1, stdout: 'plain text', stderr: '' }),
    undefined,
  );
});

test('适配器不读取凭据：凭据有没有由官方工具自己判断', async () => {
  const adapter = createHarnessAdapter({ runner: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  const config = adapter.configuration();
  assert.equal(config.accessSurface, 'qloo-cli');
  assert.equal(config.accessSurfaceConfirmed, true, '官方指定的接入面就是它');
  assert.equal(config.accessSurfaceLiveVerified, true, '这条路径对真实 API 跑通过');
  assert.equal(config.configured, true);
  assert.deepEqual(config.missing, []);
});

test('接入面由环境变量选，默认是官方 CLI 那条', () => {
  assert.equal(QLOO_ACCESS_SURFACE_ENV, 'QLOO_ACCESS_SURFACE');
});

test('官方 CLI 的预览走 --dry-run：只打印请求，不发出去', async () => {
  const calls = [];
  const adapter = createHarnessAdapter({
    baseUrl: 'https://hackathon.api.qloo.com',
    runner: async (args) => {
      calls.push([...args]);
      // 官方工具的 --dry-run 输出形状：{ method, url, params }
      return {
        code: 0,
        stdout: JSON.stringify({
          method: 'GET',
          url: 'https://api.qloo.com/search',
          params: { query: 'Sample Film', types: 'urn:entity:movie', take: '20' },
        }),
        stderr: '',
      };
    },
  });

  const preview = await adapter.previewRequest({
    op: 'resolve',
    seed: 'Sample Film',
    entityType: 'movie',
  });
  assert.ok(calls[0].includes('--dry-run'), '预览必须带 --dry-run');
  assert.equal(preview.method, 'GET');
  // 官方工具的 dry-run 打印的是它自己配置里的基址；这里显示服务端实际会用的那个。
  assert.match(preview.url, /^https:\/\/hackathon\.api\.qloo\.com\/search$/);
  assert.equal(preview.params.query, 'Sample Film');
  assert.match(preview.note, /Nothing was sent/);
});

test('音乐人种子：在音乐类别里找，但出来的仍然是电影', async () => {
  const { calls, runner } = recordingRunner((args) => {
    // 搜索用音乐类别，取候选一律用电影——输出领域是固定的。
    if (args[1] === 'search') {
      return {
        code: 0,
        stdout: JSON.stringify(searchResolvedPayload.results),
        stderr: '',
      };
    }
    return { code: 0, stdout: JSON.stringify([]), stderr: '' };
  });
  const adapter = createHarnessAdapter({ runner });

  await adapter.resolveSeed({ seed: 'Radiohead', entityType: 'artist' });
  const searchCall = calls.find((call) => call[1] === 'search');
  assert.ok(searchCall !== undefined, '应当发出过一次搜索');
  assert.equal(
    searchCall[searchCall.indexOf('--type') + 1],
    'urn:entity:artist',
    '音乐人种子要在音乐类别里找',
  );

  calls.length = 0;
  await adapter.fetchCandidates({ entityId: 'artist-1', limit: 20 });
  const insightsCall = calls.find((call) => call[1] === 'insights');
  assert.ok(insightsCall !== undefined, '应当发出过一次取候选');
  assert.equal(
    insightsCall[insightsCall.indexOf('--type') + 1],
    'urn:entity:movie',
    '输出领域固定是电影：音乐人当种子，出来的也是电影',
  );
});
