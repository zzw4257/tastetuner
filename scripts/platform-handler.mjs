/**
 * 平台入口（Vercel Function）：只处理 `/api/*`。
 *
 * 三条硬规矩，**在任何一个接口被调用之前**就要检查（不是靠注释）：
 * 1. **必须是生产环境**。预览没有 store 凭据、也没有评审用的凭据：预览一律拒绝服务，
 *    更不能自己另起一份预算。
 * 2. **必须用共享预算**。服务器没有本地文件系统，文件账本在每次调用里都是一份从零开始的
 *    副本，"全局最多 N 次"根本守不住——所以缺 `QLOO_DURABLE_BUDGET` 就拒绝服务，
 *    绝不悄悄退回文件账本。
 * 3. **必须匹配这一轮批准的 campaign**（phase id / 上限 / 截止时间）。少一个、对一个，
 *    都拒绝服务：宁可整个实例不可用，也不要在一个说不清上限的实例上发真实请求。
 *
 * 静态资源交给平台（构建产物由平台托管），函数只管接口。
 * 凭据只在服务端读：平台环境变量或私有文件，都不会进前端、不进日志。
 */
import { createServiceContext, handleApi } from './serve.mjs';

/**
 * 这一轮 campaign 的约定值。平台入口**只认这一份**：环境变量与它不一致就拒绝服务。
 * 换一轮 campaign 就是改这里（phase id 变了 = 另起一份计数，不会重置旧的）。
 */
export const CAMPAIGN = Object.freeze({
  phaseId: 'public-20261029',
  limit: 500,
  cutoff: '2026-11-06T04:45:00Z',
});

function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', data.length);
  res.end(data);
}

/** 返回"这个环境能不能服务"的结论；能服务就是空数组。 */
export function checkPlatformEnv(env = process.env) {
  const problems = [];
  if (env.VERCEL_ENV !== 'production') {
    problems.push('only production deployments are served (previews neither serve nor create a budget)');
  }
  if (String(env.QLOO_DURABLE_BUDGET ?? '').trim() !== '1') {
    problems.push('the shared budget must be enabled (QLOO_DURABLE_BUDGET=1)');
  }
  if (String(env.QLOO_DURABLE_PHASE_ID ?? '').trim() !== CAMPAIGN.phaseId) {
    problems.push(`the phase id does not match the approved one (must be ${CAMPAIGN.phaseId})`);
  }
  if (String(env.QLOO_REQUEST_BUDGET ?? '').trim() !== String(CAMPAIGN.limit)) {
    problems.push(`the cap does not match the approved one (must be ${CAMPAIGN.limit})`);
  }
  if (String(env.QLOO_REQUEST_BUDGET_CUTOFF ?? '').trim() !== CAMPAIGN.cutoff) {
    problems.push(`the cutoff does not match the approved one (must be ${CAMPAIGN.cutoff})`);
  }
  if (String(env.QLOO_API_KEY ?? '').trim() === '') {
    problems.push('the server-side credential is missing (QLOO_API_KEY)');
  }
  return problems;
}

/**
 * 建平台处理器。
 *
 * 服务端起不来时（配置不全、campaign 不匹配、存储连不上）也要给一个**说人话**的响应，
 * 而不是把内部报错甩给浏览器；细节只进服务端日志。
 */
export async function createPlatformHandler(env = process.env) {
  const problems = checkPlatformEnv(env);
  let context;
  if (problems.length > 0) {
    console.error(`Platform handler refused to start: ${problems.join('；')}`);
  } else {
    try {
      context = await createServiceContext(env);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Platform handler failed to start: ${detail}`);
    }
  }
  if (context === undefined) {
    return async function unavailable(req, res) {
      sendJson(res, 503, {
        status: 'upstream_error',
        message: 'The server is not ready: the configuration or the shared storage is unavailable, so no live request is sent.',
        retryable: false,
      });
    };
  }
  const { adapter, budget, credentialPresent } = context;
  return async function handle(req, res) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    await handleApi(req, res, path, adapter, budget, credentialPresent);
  };
}
