/**
 * 单请求闸门：预加载进**官方 CLI 子进程**，管住它自己那一层的 fetch。
 *
 * 为什么需要它：请求预算原先是在**服务端外层**扣的。一次操作 = 扣一次额度 = 调一次
 * CLI。但 CLI 子进程自己发 HTTP：默认 **fetch 会跟随 302**，一次操作就可能变成
 * 两次 HTTP 尝试；它要是还有 health/重试调用，外层那 1 次额度根本拦不住。
 * 所以真正的硬上限必须在 **fetch 层**。
 *
 * 闸门规矩：
 * - 一个子进程**最多一次** HTTP 请求（第二次直接拒，不发）；
 * - 只允许 GET；只允许 `/search` 与 `/v2/insights`；只允许配置的基址那个 origin；
 * - `redirect: 'error'`：**不跟随跳转**，一次操作就是一次 HTTP 尝试；
 * - **不扣账本**：额度由服务端预扣时算过一次，这里再扣就是同一笔账扣两次。
 *   闸门只管"At most one HTTP attempt per operation"，账本管"How many operations in total"。
 *
 * 预加载方式：`NODE_OPTIONS=--import=<本文件>`（只影响那一个子进程，不改全局环境）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_PATHS = ['/search', '/v2/insights'];

function readOrigin() {
  const base = process.env.QLOO_BASE_URL;
  if (base === undefined || base.trim().length === 0) return undefined;
  try {
    return new URL(base).origin;
  } catch {
    return undefined;
  }
}

function install() {
  const origin = readOrigin();
  if (origin === undefined) {
    // 没有基址就不设闸：让上层按"未配置"报错，别在这里造一个假的 origin。
    return;
  }
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (used >= 1) {
      throw new Error('Single-request gate: this process already sent one request; no second request');
    }
    const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
    // 方法可能写在 init 里，也可能写在传入的 Request 对象**自身**上：
    // fetch(new Request(url, { method: 'POST' })) 里 init.method 是 undefined。
    const method = String(
      init.method ??
        (typeof input === 'object' && input !== null ? input.method : undefined) ??
        'GET',
    ).toUpperCase();
    if (method !== 'GET') throw new Error(`Single-request gate: ${method} is not allowed`);
    if (url.origin !== origin) {
      throw new Error(`Single-request gate: only ${origin} is allowed, not ${url.origin}`);
    }
    if (!ALLOWED_PATHS.includes(url.pathname)) {
      throw new Error(`Single-request gate: only ${ALLOWED_PATHS.join(' / ')} is allowed, not ${url.pathname}`);
    }
    used += 1;
    // redirect: 'error' —— 不跟随跳转。
    return original(input, { ...init, redirect: 'error' });
  };
}

install();

export { ALLOWED_PATHS, install };
