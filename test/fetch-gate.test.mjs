// 单请求闸门的检查：对着**本机假 HTTP**验，不发任何外部请求。
//
// 验的是那几条硬边界：
// - 一个子进程最多一次 HTTP 请求；
// - 只允许 GET、只允许 /search 与 /v2/insights、只允许配置的基址那个 origin；
// - redirect: 'error'：不跟随跳转；
// - 闸门**不扣账本**（额度由服务端预扣时算过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const GATE = join(root, 'scripts', 'qloo-fetch-gate.mjs');

/** 跑一段带闸门的子进程代码，返回它打印的结果。 */
function runGated(code, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', GATE, '-e', code], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('闸门：第二次请求被拒，不发出去', async () => {
  const hits = [];
  const fake = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  try {
    const result = await runGated(
      `const u='${origin}/search?query=x';
       const first=await fetch(u).then(r=>r.status).catch(e=>'ERR:'+e.message);
       const second=await fetch(u).then(r=>r.status).catch(e=>'ERR:'+e.message);
       console.log(JSON.stringify({first,second}));`,
      { QLOO_BASE_URL: origin },
    );
    const out = JSON.parse(result.stdout.trim());
    assert.equal(out.first, 200, '第一次请求应当放行');
    assert.match(out.second, /^ERR:/, '第二次必须被闸门拒掉');
    assert.equal(hits.length, 1, '假服务只该收到一次请求');
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('闸门：只允许 GET、只允许两个路径、只允许配置的基址', async () => {
  const origin = 'http://127.0.0.1:9'; // 不会真的连上：闸门先拒
  const result = await runGated(
    `const attempts={};
     attempts.post=await fetch('${origin}/search',{method:'POST'}).then(r=>r.status).catch(e=>'ERR');
     attempts.other=await fetch('${origin}/v1/other').then(r=>r.status).catch(e=>'ERR');
     attempts.otherHost=await fetch('http://example.invalid/search').then(r=>r.status).catch(e=>'ERR');
     console.log(JSON.stringify(attempts));`,
    { QLOO_BASE_URL: origin },
  );
  const out = JSON.parse(result.stdout.trim());
  assert.match(out.post, /^ERR/, '不许 POST');
  assert.match(out.other, /^ERR/, '不许 /v1/other');
  assert.match(out.otherHost, /^ERR/, '不许别的 host');
});

test('闸门：Request 对象自带的方法也算数（POST 不能藏在 Request 里）', async () => {
  const hits = [];
  const fake = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  try {
    // fetch(new Request(url, {method:'POST'})) 时 init.method 是 undefined：
    // 闸门必须看 Request 自身的方法，不能把它当成 GET 放过去。
    const result = await runGated(
      `const request=new Request('${origin}/search',{method:'POST'});
       const s=await fetch(request).then(r=>r.status).catch(e=>'ERR:'+e.message);
       console.log(JSON.stringify({s}));`,
      { QLOO_BASE_URL: origin },
    );
    const out = JSON.parse(result.stdout.trim());
    assert.match(out.s, /^ERR:/, 'Request 里的 POST 必须被拒');
    assert.deepEqual(hits, [], '一个请求都不该发出去');
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('闸门：不跟随跳转（redirect: error）', async () => {
  const fake = createServer((req, res) => {
    // 注意 req.url 带查询串，要用 startsWith 判断路径。
    if (req.url.startsWith('/search')) {
      res.writeHead(302, { location: '/v2/insights?take=5' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  const hits = [];
  fake.on('request', (req) => hits.push(req.url));
  try {
    const result = await runGated(
      `const s=await fetch('${origin}/search?query=x').then(r=>r.status).catch(e=>'ERR:'+e.message);
       console.log(JSON.stringify({s}));`,
      { QLOO_BASE_URL: origin },
    );
    const out = JSON.parse(result.stdout.trim());
    assert.match(out.s, /^ERR:/, '跳转必须报错，不能悄悄跟过去');
    assert.equal(hits.length, 1, '不能跟到第二个地址');
  } finally {
    await new Promise((resolve) => fake.close(resolve));
  }
});

test('闸门不碰账本：它只管"一次操作最多一次尝试"', () => {
  const source = readFileSync(GATE, 'utf8');
  assert.doesNotMatch(source, /consume\(/, '闸门不许扣额度——额度已由服务端预扣');
  assert.doesNotMatch(source, /request-budget/, '闸门不许碰账本文件');
  assert.ok(existsSync(GATE), '闸门文件要在');
});
