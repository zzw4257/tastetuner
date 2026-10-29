/**
 * 真实业务请求的硬预算（持久化）。
 *
 * 要求：
 * - **默认拒绝**：没有显式开启就一个业务请求都不许发。
 * - **跨重启有效**：计数写在文件里，进程重启不会把它清零——否则"总共最多 2 次"
 *   就只是嘴上说说。
 * - **独占**：同一时刻只允许一个进程扣额度，两个探路进程不会各花一份。
 * - **所有尝试预扣**：在**发出之前**就扣，失败、超时、被限流同样计入，不退还。
 *
 * 额度不是"速率限制"，是"总共最多几次"。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const QLOO_REQUEST_BUDGET_ENV = 'QLOO_REQUEST_BUDGET';

/** 指定用哪一份阶段账本；名字必须在下面那张表里。 */
export const QLOO_REQUEST_BUDGET_PHASE_ENV = 'QLOO_REQUEST_BUDGET_PHASE';

/** 默认上限：首个真实闭环只要 2 次（搜索 + 取推荐）。 */
export const DEFAULT_REQUEST_BUDGET = 2;

/**
 * 阶段预算：**每一轮由用户明确授权的上限写死在代码里**。
 *
 * 为什么不靠环境变量说了算：环境变量是执行时给的，谁都能写大。
 * 授权是用户给的，所以上限住在代码里；环境变量只能把它调**小**。
 *
 * 历史那 2 次的账本（`request-budget.json`）**原样保留**，
 * 阶段账本另起一个文件，两份互不干扰。
 */
export const PHASE_BUDGETS = Object.freeze({
  /**
   * 公开实例的账本名。上限**不写死**：必须由环境变量显式给数字，
   * 阶段只负责把账本分开，不是发请求的开关。
   */
  public: Object.freeze({ limit: undefined, stateDir: 'public' }),
});

/** 取阶段预算；阶段名不认识就返回 undefined——调用方要失败关闭，不能猜。 */
export function resolvePhaseBudget(phase) {
  if (typeof phase !== 'string') return undefined;
  return PHASE_BUDGETS[phase];
}

/** 锁超过这个时间就算陈旧（上次进程崩了留下的），可以被接管。 */
export const STALE_LOCK_MS = 5 * 60 * 1000;

/** 项目内的私有目录：放凭据与预算状态，不进 Git。 */
export const PRIVATE_DIR = '.taste-tuner';

function ensurePrivateDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (info.isSymbolicLink()) throw new Error(`The private directory is a symlink; refusing to use it: ${dir}`);
  chmodSyncQuiet(dir, 0o700);
}

function chmodSyncQuiet(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // 某些文件系统不支持改权限；不因此中断，但要记下来。
  }
}

/**
 * 读环境变量里的预算上限。
 * 变量缺失或不是非负整数 → **保持默认拒绝**，不猜、不放宽。
 */
export function readBudgetLimitFromEnv(env) {
  const raw = env?.[QLOO_REQUEST_BUDGET_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function readState(statePath) {
  if (!existsSync(statePath)) return { version: 1, used: 0, attempts: [] };
  const info = lstatSync(statePath);
  if (info.isSymbolicLink()) throw new Error(`The budget state file is a symlink; refusing to use it: ${statePath}`);
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      version: 1,
      used: typeof parsed.used === 'number' ? parsed.used : 0,
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    };
  } catch {
    // 状态文件坏了不能当成"还没用过"——那等于白送额度。
    throw new Error(`The budget state file cannot be read; check it by hand: ${statePath}`);
  }
}

function writeState(statePath, state) {
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, statePath);
  chmodSyncQuiet(statePath, 0o600);
}

/**
 * 拿到独占锁。拿不到就返回 null——调用方应当**失败关闭**，而不是继续扣。
 */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, String(Date.now()));
      return fd;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // 锁可能是上次进程崩下留下的；太旧就当陈旧锁接管。
      try {
        const age = Date.now() - Number(readFileSync(lockPath, 'utf8'));
        if (Number.isFinite(age) && age > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // 读不到锁内容就当它还活着。
      }
      return null;
    }
  }
  return null;
}

function releaseLock(lockPath, fd) {
  try {
    closeSync(fd);
  } catch {
    // 已经关了就算了。
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // 别人接管了就算了。
  }
}

/**
 * 造一个持久化的预算。
 *
 * - `enabled` 为假时完全不落盘，也不计数：一个真实请求都发不出去。
 * - `consume()` 成功返回 true，失败返回 false；失败时**不**计数。
 */
export function createRequestBudget(options = {}) {
  const raw = options.limit;
  const limit =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_REQUEST_BUDGET;
  const enabled = options.enabled === true;
  const baseDir = options.stateDir ?? join(process.cwd(), PRIVATE_DIR);
  const statePath = options.statePath ?? join(baseDir, 'request-budget.json');
  // 锁跟着状态文件走：不同阶段的账本不能抢同一把锁。
  const lockPath =
    options.lockPath ?? statePath.replace(/\.json$/, '') + '.lock';

  const read = () => {
    if (!enabled) return { used: 0, attempts: [] };
    if (!existsSync(statePath)) return { used: 0, attempts: [] };
    return readState(statePath);
  };

  return {
    limit: () => (enabled ? limit : 0),
    used: () => read().used,
    remaining: () => Math.max(0, (enabled ? limit : 0) - read().used),
    enabled: () => enabled,
    state: () => {
      if (!enabled) return 'disabled';
      return read().used >= limit ? 'exhausted' : 'available';
    },
    /**
     * 扣一次额度。返回 false 表示这次请求不许发。
     * 扣在**请求发出之前**，所以失败、超时、被限流同样计入。
     */
    consume: (op = 'unknown') => {
      if (!enabled) return false;
      ensurePrivateDir(baseDir);
      const fd = acquireLock(lockPath);
      if (fd === null) return false; // 拿不到独占锁就失败关闭。
      try {
        const state = readState(statePath);
        if (state.used >= limit) return false;
        state.used += 1;
        state.attempts.push({ at: new Date().toISOString(), op });
        writeState(statePath, state);
        return true;
      } finally {
        releaseLock(lockPath, fd);
      }
    },
  };
}

/** 预算用尽或未开启时，给界面与服务端共用的说法。 */
export function describeBudget(budget) {
  switch (budget.state()) {
    case 'disabled':
      return `The live request budget is off: no live request is sent. It is enabled once ${QLOO_REQUEST_BUDGET_ENV} is set (the first closed-loop cap is ${DEFAULT_REQUEST_BUDGET} requests).`;
    case 'exhausted':
      return `The live request budget is used up (${budget.limit()} requests). Nothing is retried automatically and the budget is never renewed automatically.`;
    default:
      return '';
  }
}
