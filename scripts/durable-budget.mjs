/**
 * 持久预算（durable budget）：把"全局最多 N 次"落到一个**共享、可原子更新**的存储上。
 *
 * 为什么不能继续用文件账本：文件账本每个实例/每次冷启动都是一份独立副本，
 * 多实例各记各的 → "最多 N 次"会变成"N × 实例数"。无状态平台上更糟：
 * 临时文件会被回收，计数直接归零。**全局上限必须是共享的一份状态。**
 *
 * 存储形态：Vercel Blob（private）。父任务核实过的契约：
 * - 读：`get(path, { access: 'private', useCache: false })` → 读最新，返回 body 流与
 *   `blob.etag`；同一份状态重复读，etag 不变。
 * - 写：`put(path, body, { access: 'private', allowOverwrite: true, addRandomSuffix: false,
 *   ifMatch: etag })` → 原子 CAS；etag 不匹配就失败，不会覆盖别人的写入。
 *
 * 本模块**不绑定 SDK**：适配器由调用方注入（本地测试用假适配器，部署用真适配器）。
 *
 * 全部 fail closed —— 任何不确定都拒绝发请求：
 * - 额度在发 Qloo 请求**之前**预扣（调用方 `await budget.consume()` 之后才去发）。
 * - 冲突（别的部署同时改过）→ 拒绝，**不重试、不重建**。
 * - 读不到 / 读不出来 / 存储报错 / 配额耗尽 → 拒绝，不发 Qloo、不退还、不重试。
 * - 初始化只做一次：显式 phaseId；同一 phaseId 的所有部署与环境共用一份计数；
 *   重新部署**不会**把计数清零（已存在就不覆盖）。
 * - 过了截止时间（cutoff）一律拒绝。
 */

/** 共享预算的 phase id：所有部署与环境共用同一个，计数因此是全局的。 */
// **静态引入**打包进来的适配器：打包器（Vercel）靠静态 import 决定哪些文件进函数包，
// 动态 import 的模块它追不到——第一次部署就是这样起不来的
// （`Cannot find module '/var/task/scripts/vercel-blob-adapter.mjs'`）。
// 所以默认适配器是**静态**引进来的；环境变量里的路径只是给本地测试换假适配器用的。
import { createBlobStore } from './vercel-blob-adapter.mjs';

export const DURABLE_BUDGET_PHASE_ID_ENV = 'QLOO_DURABLE_PHASE_ID';
/** 服务端存储适配器模块的路径（部署方提供；只有服务端能读到）。 */
export const DURABLE_BUDGET_ADAPTER_ENV = 'QLOO_BLOB_ADAPTER';
/** 截止时间（ISO）。过了这一刻一律拒绝发请求。 */
export const DURABLE_BUDGET_CUTOFF_ENV = 'QLOO_REQUEST_BUDGET_CUTOFF';

/** phase id 只会进文件路径，所以只允许安全字符。 */
const PHASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 共享预算的状态文件路径：同一个 phase id → 同一个文件 → 所有部署共用。 */
export function durableBudgetPath(phaseId) {
  if (typeof phaseId !== 'string' || !PHASE_ID_PATTERN.test(phaseId)) {
    throw new Error('The shared budget phase id is invalid: letters, digits, . _ and - only, 1–64 characters.');
  }
  return `taste-tuner/phase/${phaseId}/budget.json`;
}

/**
 * 存储报错的归类。只分三类，因为处理方式不同：
 * conflict（别人改过）、quota_exhausted（额度/配额用尽）、store_error（其他）。
 */
export function classifyStoreError(error) {
  const status = error?.status ?? error?.statusCode;
  const code = String(error?.code ?? '').toLowerCase();
  if (status === 412 || code === 'conflict' || code === 'precondition_failed') return 'conflict';
  if (status === 429 || code.includes('quota') || code.includes('storage_limit')) {
    return 'quota_exhausted';
  }
  return 'store_error';
}

/** 把 get 返回的 body 读成文本：流、字符串、带 .text() 的对象都认。 */
async function readBodyText(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (typeof body.text === 'function') return await body.text();
  if (typeof body.getReader === 'function') return await new Response(body).text();
  return String(body);
}

/** 共享状态必须是"读得懂的账本"：读不出来就当状态不可知 → 拒绝。 */
function parseState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.version !== undefined && raw.version !== 1) return null;
  if (typeof raw.phaseId !== 'string' || raw.phaseId.length === 0) return null;
  // used 必须是**安全整数**：超出安全整数范围就当读坏了，不给它参与比较的机会。
  if (!Number.isSafeInteger(raw.used) || raw.used < 0) return null;
  // 存下来的上限与截止时间也要可信：它们是这份 campaign 的约定，不能被忽略。
  if (!Number.isSafeInteger(raw.limit) || raw.limit < 0) return null;
  if (typeof raw.cutoff !== 'string' || raw.cutoff.length === 0) return null;
  if (Number.isNaN(Date.parse(raw.cutoff))) return null;
  return raw;
}

/**
 * 加载部署方提供的存储适配器。
 * 适配器模块必须导出 `createBlobStore()`，返回 `{ get(path, options), put(path, body, options) }`。
 */
export async function loadBlobStore(adapterPath) {
  // 没给路径就用**打包进来的那个**（静态引入，保证它在函数包里）。
  if (adapterPath === undefined || adapterPath.trim() === '') {
    return createBlobStore();
  }
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  // 相对路径按**本模块所在目录**解析，不按 cwd——部署时的 cwd 不是脚本目录。
  const here = dirname(fileURLToPath(import.meta.url));
  const module = await import(pathToFileURL(resolve(here, adapterPath)).href);
  if (typeof module.createBlobStore !== 'function') {
    throw new Error(`The storage adapter module does not export createBlobStore: ${adapterPath}`);
  }
  return await module.createBlobStore();
}

/**
 * 建一个持久预算。
 *
 * @param {{adapter: object, phaseId: string, limit: number, cutoff?: string,
 *          path?: string, now?: () => number}} options
 */
export function createDurableBudget(options = {}) {
  const {
    adapter,
    phaseId,
    limit: rawLimit,
    cutoff,
    path = durableBudgetPath(phaseId),
    now = () => Date.now(),
  } = options;
  if (adapter === undefined || adapter === null) {
    throw new Error('The shared budget needs a storage adapter.');
  }
  const limit = Number.isInteger(rawLimit) && rawLimit >= 0 ? rawLimit : 0;
  const cutoffMs = cutoff === undefined || cutoff === null ? undefined : Date.parse(cutoff);
  if (cutoffMs !== undefined && Number.isNaN(cutoffMs)) {
    throw new Error(`The cutoff is not a valid timestamp: ${String(cutoff)}`);
  }
  // 本地只留一份"上次已知"的镜像，用来在状态接口里显示；**判定永远以共享存储为准**。
  let mirror = { used: 0, state: limit > 0 ? 'available' : 'disabled' };

  const deny = (state) => {
    mirror = { ...mirror, state };
    return false;
  };

  /**
   * 读共享状态。
   *
   * missing = 没有这个文件；unreadable = 在，但**不能证明**这是一份没被别人改过的账本；
   * ok = 读到了状态与**同一次读**带来的 etag。
   *
   * 为什么 etag 这么严：写要用 ifMatch 做原子 CAS。etag 缺失/为空时 ifMatch 会变成
   * "无条件覆盖"——那等于把 CAS 悄悄关掉，两个人同时写就会互相覆盖，计数会丢。
   * 所以读不到可信 etag（或者读到的不是 200，而是 304 这类"没改动"）一律当读失败处理。
   */
  async function readShared() {
    const result = await adapter.get(path, { access: 'private', useCache: false });
    if (result === undefined || result === null) return { kind: 'missing' };
    if (result.status !== 200) return { kind: 'unreadable', reason: 'bad_status' };
    if (typeof result.etag !== 'string' || result.etag.trim().length === 0) {
      return { kind: 'unreadable', reason: 'missing_etag' };
    }
    const state = parseState(await readBodyText(result.body));
    if (state === null) return { kind: 'unreadable', reason: 'unreadable_state' };
    return { kind: 'ok', state, etag: result.etag };
  }

  /**
   * 扣一次额度。返回 false 表示这次请求不许发。
   * 扣在**请求发出之前**（调用方 await 之后才去发），所以失败、超时、被限流同样计入。
   * 冲突、报错、状态不可知 → 一律 false：**不重试、不重建、不退还**。
   */
  async function consume() {
    if (limit <= 0) return deny('disabled');
    if (cutoffMs !== undefined && now() >= cutoffMs) return deny('cutoff');

    let read;
    try {
      read = await readShared();
    } catch (error) {
      const kind = classifyStoreError(error);
      return deny(kind === 'conflict' ? 'conflict' : kind === 'quota_exhausted' ? 'quota_exhausted' : 'store_error');
    }
    if (read.kind === 'missing') return deny('not_initialized');
    if (read.kind === 'unreadable') return deny('unknown_state');
    // 计数必须属于这个 phase：别的 phase 的计数不能拿来用。
    if (read.state.phaseId !== phaseId) return deny('phase_mismatch');

    // **存下来的上限与截止时间是这份 campaign 的约定**，不能被环境变量放宽：
    // 存的上限比配置更宽松、或存的截止时间更晚 → 当成状态被改过，直接拒绝。
    // 存的更严格时按存的来（min）：环境变量只能把额度调小、调早，不能调大、调晚。
    if (read.state.limit > limit) return deny('state_mismatch');
    const storedCutoffMs = Date.parse(read.state.cutoff);
    const configuredCutoffMs = cutoffMs ?? Number.POSITIVE_INFINITY;
    if (storedCutoffMs > configuredCutoffMs) return deny('state_mismatch');
    const effectiveLimit = Math.min(limit, read.state.limit);
    const effectiveCutoffMs = Math.min(storedCutoffMs, configuredCutoffMs);
    if (now() >= effectiveCutoffMs) return deny('cutoff');

    if (read.state.used >= effectiveLimit) {
      mirror = { used: read.state.used, state: 'exhausted' };
      return false;
    }

    const next = {
      ...read.state,
      used: read.state.used + 1,
      updatedAt: new Date(now()).toISOString(),
    };
    try {
      // CAS：etag 对不上就说明有人同时改过 —— 这一下不会写进去，也不重试。
      await adapter.put(path, JSON.stringify(next), {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        ifMatch: read.etag,
      });
    } catch (error) {
      const kind = classifyStoreError(error);
      return deny(
        kind === 'conflict'
          ? 'conflict'
          : kind === 'quota_exhausted'
            ? 'quota_exhausted'
            : 'store_error',
      );
    }
    mirror = { used: next.used, state: next.used >= effectiveLimit ? 'exhausted' : 'available' };
    return true;
  }

  /** 读一次共享状态。只读，不参与判定。 */
  async function snapshot() {
    let read;
    try {
      read = await readShared();
    } catch {
      return {
        enabled: limit > 0,
        limit,
        used: mirror.used,
        remaining: Math.max(0, limit - mirror.used),
        state: 'unavailable',
      };
    }
    if (read.kind === 'ok') {
      const effectiveLimit = Math.min(limit, read.state.limit);
      mirror = {
        used: read.state.used,
        state: read.state.used >= effectiveLimit ? 'exhausted' : 'available',
      };
      return {
        enabled: true,
        limit: effectiveLimit,
        used: read.state.used,
        remaining: Math.max(0, effectiveLimit - read.state.used),
        state: mirror.state,
      };
    }
    return {
      enabled: limit > 0,
      limit,
      used: mirror.used,
      remaining: Math.max(0, limit - mirror.used),
      state: read.kind === 'missing' ? 'not_initialized' : 'unknown_state',
    };
  }

  return {
    enabled: () => limit > 0,
    limit: () => limit,
    used: () => mirror.used,
    remaining: () => Math.max(0, limit - mirror.used),
    state: () => mirror.state,
    consume,
    snapshot,
    path,
    phaseId,
    cutoff: cutoff ?? null,
  };
}

/**
 * 一次性初始化共享预算。
 *
 * - 已经有状态 → **不覆盖、不重置**（重新部署不会把计数清零），直接返回现有状态。
 * - 还没有 → 建一份空的（used: 0）。
 * - 并发时另一个部署刚好建好了 → 读回来用它那份，不覆盖。
 */
export async function initializeDurableBudget(options = {}) {
  const {
    adapter,
    phaseId,
    limit = 0,
    cutoff = null,
    path = durableBudgetPath(phaseId),
    now = () => Date.now(),
  } = options;
  if (adapter === undefined || adapter === null) {
    throw new Error('The shared budget needs a storage adapter.');
  }
  // 一份 campaign 必须有**上限**与**截止时间**：没有它们，"用满了怎么办"就没有答案。
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Initialising the shared budget needs a cap greater than 0.');
  }
  if (typeof cutoff !== 'string' || Number.isNaN(Date.parse(cutoff))) {
    throw new Error('Initialising the shared budget needs a valid cutoff (an ISO timestamp).');
  }
  const existing = await adapter.get(path, { access: 'private', useCache: false });
  if (existing !== undefined && existing !== null) {
    const state = parseState(await readBodyText(existing.body));
    if (state === null) {
      throw new Error('The shared budget state exists but cannot be read: nothing is overwritten or reset; check it by hand.');
    }
    return { created: false, state };
  }
  const state = {
    version: 1,
    phaseId,
    used: 0,
    limit,
    cutoff,
    createdAt: new Date(now()).toISOString(),
  };
  try {
    // 建一次：allowOverwrite:false —— 已存在就失败，不会覆盖别人的计数。
    await adapter.put(path, JSON.stringify(state), {
      access: 'private',
      allowOverwrite: false,
      addRandomSuffix: false,
    });
  } catch (error) {
    const after = await adapter.get(path, { access: 'private', useCache: false }).catch(() => null);
    if (after !== undefined && after !== null) {
      const existingState = parseState(await readBodyText(after.body));
      if (existingState !== null) return { created: false, state: existingState };
    }
    throw new Error(`Could not initialise the shared budget: ${classifyStoreError(error)}`);
  }
  return { created: true, state };
}
