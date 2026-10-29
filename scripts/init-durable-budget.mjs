#!/usr/bin/env node
/**
 * 一次性初始化共享预算（持久预算）。
 *
 * 为什么要有这一步：共享预算的状态文件**必须显式建一次**。运行时**不会**自动建——
 * 自动建等于"状态丢了就重新开始"，全局上限会被悄悄重置。
 *
 * 语义：
 * - 已经有状态 → **不覆盖、不重置**（重新部署不会把计数清零），只报告现状。
 * - 还没有 → 建一份空的（used: 0），并记下 phase id、上限、截止时间。
 * - 并发（另一个部署刚建好）→ 读回来用那份，不覆盖。
 *
 * 用法（服务端执行；不打印任何凭据）：
 *
 *   QLOO_DURABLE_PHASE_ID=public-20261029 \
 *   QLOO_REQUEST_BUDGET=500 \
 *   QLOO_REQUEST_BUDGET_CUTOFF=2026-11-06T04:45:00Z \
 *   node scripts/init-durable-budget.mjs
 *
 * 预览（preview）部署**不要**跑这一步：预览必须和生产共用同一个 phase id，
 * 不能自己另起一份预算。
 */
import {
  DURABLE_BUDGET_ADAPTER_ENV,
  DURABLE_BUDGET_CUTOFF_ENV,
  DURABLE_BUDGET_PHASE_ID_ENV,
  durableBudgetPath,
  initializeDurableBudget,
  loadBlobStore,
} from './durable-budget.mjs';

async function main() {
  const phaseId = String(process.env[DURABLE_BUDGET_PHASE_ID_ENV] ?? '').trim();
  if (phaseId === '') {
    throw new Error(`Needs ${DURABLE_BUDGET_PHASE_ID_ENV}: every deployment and environment shares one phase id.`);
  }
  // 适配器路径可选：不给就用打包进来的那个（静态引入，在函数包里）。
  const adapterPath = String(process.env[DURABLE_BUDGET_ADAPTER_ENV] ?? '').trim();
  const rawLimit = Number.parseInt(String(process.env.QLOO_REQUEST_BUDGET ?? ''), 10);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 0 ? rawLimit : 0;
  const cutoff = process.env[DURABLE_BUDGET_CUTOFF_ENV] ?? null;

  const adapter = await loadBlobStore(adapterPath);
  const result = await initializeDurableBudget({
    adapter,
    phaseId,
    limit,
    cutoff,
    path: durableBudgetPath(phaseId),
  });

  console.log(
    JSON.stringify({
      created: result.created,
      path: durableBudgetPath(phaseId),
      phaseId: result.state.phaseId,
      used: result.state.used,
      limit: result.state.limit,
      cutoff: result.state.cutoff ?? null,
    }),
  );
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Could not initialise the shared budget: ${detail}`);
  process.exitCode = 1;
});
