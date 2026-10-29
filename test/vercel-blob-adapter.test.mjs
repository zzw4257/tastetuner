import assert from 'node:assert/strict';
import test from 'node:test';

import { createBlobStore } from '../scripts/vercel-blob-adapter.mjs';

/** 假 SDK：只实现我们用到的那几个动作，行为照着官方文档写。 */
function createFakeSdk() {
  const calls = { get: [], put: [] };
  const state = { blob: null, etag: null, putError: null, getError: null, statusCode: 200 };

  class BlobNotFoundError extends Error {}
  class BlobPreconditionFailedError extends Error {}

  return {
    calls,
    state,
    sdk: {
      BlobNotFoundError,
      BlobPreconditionFailedError,
      async get(path, options) {
        calls.get.push({ path, options });
        if (state.getError !== null) throw state.getError;
        if (state.blob === null) return null;
        if (state.statusCode === 304) {
          // SDK 的 get 是按 statusCode 判别的联合：304 = "没改动"，没有内容。
          return {
            statusCode: 304,
            stream: null,
            headers: new Headers(),
            blob: { etag: state.etag, pathname: path, contentType: null, size: null },
          };
        }
        return {
          statusCode: 200,
          stream: new Response(state.blob).body,
          headers: new Headers(),
          blob: { etag: state.etag, pathname: path, contentType: 'application/json', size: 7 },
        };
      },
      async put(path, body, options) {
        calls.put.push({ path, body, options });
        if (state.putError !== null) throw state.putError;
        state.blob = String(body);
        state.etag = `etag-${calls.put.length}`;
        return { etag: state.etag };
      },
    },
  };
}

test('读：私有、绕缓存，带回 body 与 etag', async () => {
  const { sdk, calls, state } = createFakeSdk();
  state.blob = '{"used":1}';
  state.etag = 'etag-1';
  const store = createBlobStore(sdk);

  const result = await store.get('taste-tuner/phase/x/budget.json', {
    access: 'private',
    useCache: false,
  });

  assert.equal(calls.get[0].options.access, 'private');
  assert.equal(calls.get[0].options.useCache, false, '必须读最新，否则 CAS 会拿旧 etag');
  assert.equal(result.etag, 'etag-1');
  assert.equal(result.status, 200);
  assert.equal(await new Response(result.body).text(), '{"used":1}');
});

test('读不到 → 返回 null（"还没初始化"不是错误）', async () => {
  const { sdk } = createFakeSdk();
  const store = createBlobStore(sdk);
  assert.equal(await store.get('missing.json', { access: 'private' }), null);
});

test('SDK resolve 304（没改动）→ 原样带出状态码，不许当成 200', async () => {
  const { sdk, state } = createFakeSdk();
  state.blob = '{"used":1}';
  state.etag = 'etag-1';
  state.statusCode = 304;
  const store = createBlobStore(sdk);

  const result = await store.get('taste-tuner/phase/x/budget.json', { access: 'private' });
  assert.equal(result.status, 304, '状态码原样透出，由上层判断能不能用');
  assert.equal(result.body, null, '304 没有内容可读');
});

test('SDK 抛"没找到" → 也当作 null', async () => {
  const { sdk, state } = createFakeSdk();
  state.getError = new sdk.BlobNotFoundError('not found');
  const store = createBlobStore(sdk);
  assert.equal(await store.get('missing.json', { access: 'private' }), null);
});

test('写：固定路径、不加随机后缀、带 ifMatch 做 CAS', async () => {
  const { sdk, calls } = createFakeSdk();
  const store = createBlobStore(sdk);

  const result = await store.put('taste-tuner/phase/x/budget.json', '{"used":2}', {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    ifMatch: 'etag-1',
  });

  const write = calls.put[0];
  assert.equal(write.options.access, 'private');
  assert.equal(write.options.allowOverwrite, true);
  assert.equal(write.options.addRandomSuffix, false);
  assert.equal(write.options.ifMatch, 'etag-1');
  assert.equal(result.etag, 'etag-1');
});

test('etag 对不上 → 归一成冲突（上层按失败关闭处理）', async () => {
  const { sdk, state } = createFakeSdk();
  state.putError = new sdk.BlobPreconditionFailedError('etag mismatch');
  const store = createBlobStore(sdk);

  await assert.rejects(
    () =>
      store.put('taste-tuner/phase/x/budget.json', '{"used":2}', {
        access: 'private',
        allowOverwrite: true,
        ifMatch: 'etag-stale',
      }),
    (error) => error.status === 412 && error.code === 'conflict',
  );
});

test('其它错误原样抛出（上层当成存储不可达）', async () => {
  const { sdk, state } = createFakeSdk();
  state.putError = new Error('network down');
  const store = createBlobStore(sdk);
  await assert.rejects(
    () =>
      store.put('taste-tuner/phase/x/budget.json', '{}', {
        access: 'private',
        allowOverwrite: true,
      }),
    /network down/,
  );
});
