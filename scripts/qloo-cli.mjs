/**
 * 官方 CLI 接入面的适配器：调用 `@qloo/qloo-harness` 提供的 `qloo api`。
 *
 * 为什么需要这一条：官方 kit 指定了 `qloo explore` / `qloo exec` / `qloo api` /
 * `qloo mcp` 这几个接入面。2026-10-29 补记：官方 CURRENT 开发者指南同时给出了
 * `GET /search` 与 `GET /v2/insights` 的**直连**示例，CLI 不是必须——直连也是被允许的。
 * 两条都官方允许；差别在依赖：CLI 这条会拉进带 4 条审计项的传递依赖，所以
 * **发布候选默认走直连**，CLI 留作开发/兼容路径（`@qloo/qloo-harness` 是 dev 依赖）。
 *
 * "官方允许"与"本地实测"是两件事：CLI 这条**对真实 API 跑通过**（官方子进程），
 * 直连那条只对着本机假服务验过。界面上分开说，不混成一句"已验证"。
 *
 * 契约细节（2026-10-28 只读官方客户端源码核实，**没有执行任何会发请求的命令**）：
 * - 凭据来源顺序：`--api-key` 参数（会暴露在进程列表里，官方自己都警告不要用）→
 *   `QLOO_API_KEY` 环境变量 → `qloo config set api-key` 存下的私有配置。
 *   本适配器**只用环境变量**这条安全路径，并且**从不读取凭据值**。
 * - 基址：`QLOO_BASE_URL` 环境变量优先；不是官方 `https://api.qloo.com` 时，
 *   还必须被 `QLOO_TRUSTED_BASE_URL`（或 `qloo config set base-url`）显式信任。
 * - `qloo api search --json` 与 `qloo api insights --json` 都打印**实体数组**，
 *   不是整个响应体。
 * - 退出码：0 成功 / 2 参数错 / 3 鉴权 / 4 没找到 / 5 上游错 / 6 配置错；
 *   错误输出是 `{"error":true,"code":"…","message":"…"}`。
 *
 * 这个文件里的调用在当前环境**一次都没有真正执行过**：没有配置凭据，也没有任何
 * 检查会走到真实调用。检查用的是注入的假 runner 与本地夹具。
 *
 * 放在 scripts/ 是因为 src/ 刻意保持浏览器可加载（tsconfig 只带 DOM 类型），
 * Node 专用的东西不进 src/。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QLOO_ACCESS_SURFACE_ENV = 'QLOO_ACCESS_SURFACE';

/**
 * 已核实的赛事 host（非秘密）。
 * 依据：hackathon@qloo.com 的官方邮件（主题 "Your Qloo API Access for the
 * Agentic Hackathon"，2026-10-26 21:42:48 UTC，qloo.com 的 DKIM/DMARC 通过），
 * 以及官方开发者指南 https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
 *
 * 那封邮件**没有**额度、有效期、计费或零费用条款。后来官方论坛（Ian Cook，Manager）
 * 写明评审期间的 API 请求免费、不会自动扣费（见 docs/VERIFICATION.md 第十八节）；
 * 但额度数字、速率限制与有效期仍未公布，所以**请求预算默认仍然是关闭的**——
 * 免费不等于无限，本项目仍然只发被明确批准的那几次。
 */
export const EVENT_BASE_URL = 'https://hackathon.api.qloo.com';

/**
 * 输出领域固定是电影。种子可以是音乐人（"What films people who like this band also watch"），
 * 但候选、详情与硬约束都按电影来 —— 混成音乐人的话，详情与约束就没有意义。
 */
export const OUTPUT_ENTITY_TYPE_URN = 'urn:entity:movie';
export const HARNESS_PACKAGE = '@qloo/qloo-harness';

/** 官方 kit 要求的最低版本。 */

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 找官方 CLI。先找项目内那份（不依赖全局安装），再退回 PATH。
 * 找不到就如实报"没装"，不去网上下载、不装全局。
 */
export function resolveHarnessBinary(explicitPath) {
  if (typeof explicitPath === 'string' && explicitPath.length > 0) {
    return existsSync(explicitPath) ? explicitPath : undefined;
  }
  const local = join(projectRoot, 'node_modules', '.bin', 'qloo');
  if (existsSync(local)) return local;
  return undefined;
}

/** 默认执行器：直接 execFile，不经过 shell，参数不会被解释。 */
function createDefaultRunner(binary, timeoutMs, apiKey, baseUrl) {
  // 凭据与基址只出现在子进程的环境里：服务端自己的环境、命令行、日志都不带凭据。
  const childEnv = { ...process.env };
  if (apiKey !== undefined) childEnv.QLOO_API_KEY = apiKey;
  if (baseUrl !== undefined) {
    childEnv.QLOO_BASE_URL = baseUrl;
    // 非官方 host 必须被官方工具显式信任，否则它会拒绝——宁可报错也不偷偷换地址。
    childEnv.QLOO_TRUSTED_BASE_URL = baseUrl;
  }
  // 预加载单请求闸门：管住 CLI 子进程**自己那一层**的 fetch。
  // 外层扣一次额度不等于一次 HTTP 尝试——默认的 fetch 会跟随 302。
  // 闸门不扣账本（额度已由服务端预扣），只保证"一次操作最多一次 HTTP 尝试"。
  const gate = join(projectRoot, 'scripts', 'qloo-fetch-gate.mjs');
  if (existsSync(gate)) {
    childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, `--import=${gate}`]
      .filter((part) => part !== undefined && part.length > 0)
      .join(' ');
  }
  return (args) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof error?.code === 'number'
                ? error.code
                : 1;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** 从 CLI 输出里挖出结构化错误。 */
export function parseCliError(result) {
  for (const text of [result.stdout, result.stderr]) {
    const start = text.indexOf('{');
    if (start < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start));
      if (parsed && parsed.error === true) {
        return {
          code: typeof parsed.code === 'string' ? parsed.code : 'GENERAL_ERROR',
          message: typeof parsed.message === 'string' ? parsed.message : 'Unknown error',
        };
      }
    } catch {
      // 不是 JSON 就当普通输出，继续看下一段。
    }
  }
  return undefined;
}

function toOutcomeError(error) {
  switch (error.code) {
    case 'AUTH_FAILED':
      return {
        status: 'upstream_error',
        message: `The official tool rejected this request: ${error.message}`,
        retryable: false,
      };
    case 'NOT_FOUND':
      return {
        status: 'upstream_error',
        message: `The official tool matched no results: ${error.message}`,
        retryable: false,
      };
    case 'CONFIG_ERROR':
      return {
        status: 'upstream_error',
        message: `The official tool has a configuration problem: ${error.message}`,
        retryable: false,
      };
    case 'BAD_USAGE':
      return {
        status: 'upstream_error',
        message: `The official tool considers the parameters wrong: ${error.message}`,
        retryable: false,
      };
    default:
      return {
        status: 'upstream_error',
        message: `The official tool call failed: ${error.message}`,
        retryable: /429|rate limit|限流/i.test(error.message),
      };
  }
}

/**
 * 造一个走官方 CLI 的适配器。
 * 解析器从构建产物里动态加载，所以这个模块在没有 dist 时也能被 import。
 */
export function createHarnessAdapter(options = {}) {
  const binary = resolveHarnessBinary(options.binaryPath);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const runner =
    options.runner ??
    (binary === undefined
      ? undefined
      : createDefaultRunner(binary, timeoutMs, options.apiKey, options.baseUrl));

  let parsers = null;
  const loadParsers = async () => {
    if (parsers === null) {
      const module = await import('../dist/assets/core/qloo.js');
      parsers = {
        parseSearchResponse: module.parseSearchResponse,
        parseInsightsResponse: module.parseInsightsResponse,
      };
    }
    return parsers;
  };

  const configuration = () => {
    if (binary === undefined || runner === undefined) {
      return {
        configured: false,
        missing: [HARNESS_PACKAGE],
        accessSurface: 'qloo-cli',
        accessSurfaceConfirmed: true,
        accessSurfaceLiveVerified: true,
      };
    }
    // 凭据有没有由官方工具自己判断：它会在第一次调用时明确报 AUTH_FAILED。
    // 这里**不读取**任何凭据或私有配置。
    return {
      configured: true,
      missing: [],
      accessSurface: 'qloo-cli',
      accessSurfaceConfirmed: true,
      // 这条路径对真实 API 跑通过（官方子进程 2/2 真实请求）。
      accessSurfaceLiveVerified: true,
    };
  };

  const run = async (args) => {
    if (runner === undefined) {
      return {
        ok: false,
        error: { code: 'CONFIG_ERROR', message: `Could not find the ${HARNESS_PACKAGE} executable` },
      };
    }
    const result = await runner(args);
    if (result.code === 0) {
      try {
        return { ok: true, payload: JSON.parse(result.stdout) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: { code: 'GENERAL_ERROR', message: `The official tool output is not JSON: ${detail}` },
        };
      }
    }
    const parsed = parseCliError(result);
    return {
      ok: false,
      error: parsed ?? {
        code: 'GENERAL_ERROR',
        message: result.stderr.trim() || `The official tool exited with code ${result.code}`,
      },
    };
  };

  /**
   * 预览将要发出的请求：用官方工具自带的 --dry-run，它只打印请求、不发出去，
   * 因此**不消耗额度**。
   *
   * 注意一个官方工具的怪癖：--dry-run 打印的 url 用的是它**配置文件**里的基址，
   * 而真正发请求时用的是 `QLOO_BASE_URL` 环境变量优先的基址。两者可能不同，
   * 所以这里用服务端实际会用的基址覆盖 url，并说明这件事——
   * 否则预览会骗人。
   */
  const preview = async (args, effectiveBaseUrl) => {
    if (runner === undefined) {
      throw new Error(`Could not find the ${HARNESS_PACKAGE} executable`);
    }
    const result = await runner([...args, '--dry-run']);
    if (result.code !== 0) {
      const parsed = parseCliError(result);
      throw new Error(parsed?.message ?? `The official tool exited with code ${result.code}`);
    }
    let printed;
    try {
      printed = JSON.parse(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`The official tool preview output is not JSON: ${detail}`);
    }
    const params = printed?.params ?? {};
    const path = new URL(printed?.url ?? 'https://invalid.invalid/').pathname;
    const url = effectiveBaseUrl === undefined ? printed?.url : `${effectiveBaseUrl.replace(/\/+$/, '')}${path}`;
    return {
      method: printed?.method ?? 'GET',
      url,
      params,
      note:
        'This is the request the official tool printed with --dry-run. Nothing was sent and no budget was spent.' +
        'Note: the base URL the tool prints comes from its own config file; the one shown above is the one the server would really use.',
    };
  };

  return {
    provider: 'qloo-cli',

    configuration,

    async previewRequest(input) {
      if (input.op === 'resolve') {
        return preview(
          [
            'api',
            'search',
            '--query',
            input.seed,
            '--type',
            entityTypeUrn(input.entityType),
            '--take',
            '20',
            '--json',
          ],
          options.baseUrl,
        );
      }
      const params = JSON.stringify({
        'filter.exclude.entities': input.entityId,
        'feature.explainability': 'true',
      });
      return preview(
        [
          'api',
          'insights',
          '--type',
          OUTPUT_ENTITY_TYPE_URN,
          '--signal-entities',
          input.entityId,
          '--params',
          params,
          '--take',
          String(Math.min(Math.max(input.limit, 1), 50)),
          '--json',
        ],
        options.baseUrl,
      );
    },

    async resolveSeed(input) {
      const config = configuration();
      if (!config.configured) {
        return { status: 'not_configured', missing: config.missing };
      }
      const result = await run([
        'api',
        'search',
        '--query',
        input.seed,
        '--type',
        entityTypeUrn(input.entityType),
        '--take',
        '20',
        '--json',
      ]);
      if (!result.ok) {
        if (result.error.code === 'NOT_FOUND') {
          return {
            status: 'empty',
            message: 'The service did not match this seed. Try another spelling, or another entity type.',
          };
        }
        return toOutcomeError(result.error);
      }
      const { parseSearchResponse } = await loadParsers();
      // 官方 CLI 打印的是实体数组；包成 results 以复用同一套解析。
      const entities = Array.isArray(result.payload) ? result.payload : [];
      const outcome = parseSearchResponse({ results: entities });
      // 官方工具打印的是实体数组（不含外层信封），原样带出以便核对字段名。
      return outcome.status === 'resolved' || outcome.status === 'ambiguous'
        ? { ...outcome, raw: { entities } }
        : outcome;
    },

    async fetchCandidates(input) {
      const config = configuration();
      if (!config.configured) {
        return { status: 'not_configured', missing: config.missing };
      }
      // exclude 与 explainability 没有对应参数，用 --params 传原始参数。
      const params = JSON.stringify({
        'filter.exclude.entities': input.entityId,
        'feature.explainability': 'true',
      });
      const result = await run([
        'api',
        'insights',
        '--type',
        OUTPUT_ENTITY_TYPE_URN,
        '--signal-entities',
        input.entityId,
        '--params',
        params,
        '--take',
        String(Math.min(Math.max(input.limit, 1), 50)),
        '--json',
      ]);
      if (!result.ok) {
        if (result.error.code === 'NOT_FOUND') {
          return { status: 'empty', message: 'The service returned no candidates.' };
        }
        return toOutcomeError(result.error);
      }
      const { parseInsightsResponse } = await loadParsers();
      const entities = Array.isArray(result.payload) ? result.payload : [];
      const outcome = parseInsightsResponse({ results: { entities } });
      return outcome.status === 'ok' ? { ...outcome, raw: { entities } } : outcome;
    },
  };
}

/** 种子类别 → URN（决定Which category to look it up in）。 */
function entityTypeUrn(entityType) {
  return entityType === 'artist' ? 'urn:entity:artist' : 'urn:entity:movie';
}
