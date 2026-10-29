// Independent HTTP acceptance checks against MiniMax-authored local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../scripts/serve.mjs';

let server, port;
function call(path, method = 'GET', targetPort = port) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: targetPort, path, method, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP test timeout')));
    req.on('error', reject); req.end();
  });
}
const listen = instance => new Promise((resolve, reject) => {
  instance.once('error', reject); instance.listen(0, '127.0.0.1', () => resolve(instance.address().port));
});
const close = instance => new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
before(async () => { server = createStaticServer(); port = await listen(server); });
after(async () => { if (server?.listening) await close(server); });

test('only known built assets return correct MIME and strict headers', async () => {
  const assets = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/styles.css', 'text/css'],
    ['/favicon.svg', 'image/svg+xml'],
    ...[
      'core/types',
      'core/validation',
      'core/ranking',
      'core/scenario-io',
      'adapters/synthetic',
      'adapters/scenarios',
      'ui/app',
      'ui/view',
      'ui/list',
      'ui/evidence',
      'ui/compare',
      'ui/atlas',
      'ui/dom',
    ].map((name) => [`/assets/${name}.js`, 'text/javascript']),
  ];
  for (const [path, type] of assets) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.length > 0, path);
    assert.ok(res.headers['content-type'].startsWith(type), path);
    // connect-src 只放开同源：页面要调本机 /api，但不能连任何外部地址。
    assert.ok(res.headers['content-security-policy'].includes("connect-src 'self'"));
    assert.ok(!res.headers['content-security-policy'].includes("connect-src 'none'"));
    assert.ok(res.headers['content-security-policy'].includes("default-src 'none'"));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('source, credentials, unknown JS and future backend are never published', async () => {
  for (const path of [
    '/.env',
    '/.git/config',
    '/README.md',
    '/src/core/ranking.ts',
    '/assets/core/ranking.ts',
    '/assets/core/Ranking.js',
    '/assets/core/nested/deep.js',
    '/assets/server/contracts.js',
    '/assets/nope.js',
    '/package.json',
    '/favicon.png',
  ]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.headers['content-type'].includes('text/html'), path);
  }
});

test('raw and encoded traversal/malformed paths fail without file access', async () => {
  for (const path of ['/../package.json', '/assets/%2e%2e/package.json', '/%252e%252e/package.json', '/%00', '/bad%zz', '//other/path', '/assets\\core\\ranking.js']) {
    const res = await call(path); assert.ok([400, 404].includes(res.status), `${path}: ${res.status}`);
  }
});

test('HEAD is bodyless, POST cannot mutate and query strings stay static', async () => {
  const head = await call('/', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 0);
  const post = await call('/', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
  assert.equal((await call('/styles.css?v=1')).status, 200);
});

test('海报只放行响应给的那一个图片域，别的一律不放', async () => {
  const response = await call('/', 'GET');
  const csp = response.headers['content-security-policy'];
  assert.ok(typeof csp === 'string');
  // 海报的地址来自响应本身（Qloo 的图片域），所以只多放行这一个 host。
  assert.match(csp, /img-src 'self' https:\/\/images\.qloo\.com/);
  // 连外网仍然只允许同源的 /api。
  assert.match(csp, /connect-src 'self'/);
  // 不许任意外链、不许内联脚本。
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /img-src[^;]*\*/);
});

test('symlink escape is refused even for a named public asset', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'taste-tuner-http-'));
  let isolated;
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(temp, 'dist')); await writeFile(join(temp, 'outside.txt'), 'test-only public canary');
    await symlink(join(temp, 'outside.txt'), join(temp, 'dist', 'index.html'));
    isolated = createStaticServer(join(temp, 'dist')); const isolatedPort = await listen(isolated);
    assert.equal((await call('/', 'GET', isolatedPort)).status, 404);
  } finally {
    if (isolated) await close(isolated);
    await rm(temp, { recursive: true, force: true });
  }
});

test('CLI rejects invalid PORT before listening', () => {
  for (const value of ['0', 'abc', '65536', '4173.5']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))], { env: { ...process.env, PORT: value }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /PORT must be an integer/);
  }
});

test('真实服务那条主线真的在构建产物里，不只是源码里有', async () => {
  // 如果真实主线的代码没被打进包里，页面会只剩离线演示——这里钉住它。
  const built = await Promise.all(
    ['app.js', 'view.js', 'service.js'].map(async (name) =>
      readFile(new URL(`../dist/assets/ui/${name}`, import.meta.url), 'utf8'),
    ),
  );
  const bundle = built.join('\n');
  for (const marker of ['service-mode', 'seed-input', '/api/resolve', '/api/candidates', '/api/preflight']) {
    assert.ok(bundle.includes(marker), `构建产物里找不到 ${marker}`);
  }
});
