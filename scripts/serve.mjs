import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectDist = join(projectRoot, 'dist');

const routes = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
]);

// 构建产物里的脚本按固定命名规则放行；源码、配置和任意路径穿越都不在允许范围内。
const ASSET_PATTERN = /^\/assets\/[a-z0-9-]+\/[a-z0-9-]+\.js$/;

function routeFor(path) {
  const known = routes.get(path);
  if (known !== undefined) return known;
  if (ASSET_PATTERN.test(path)) return path.slice(1);
  return undefined;
}

// connect-src 只放开同源：页面可以调用本机的 /api，但不能连任何外部地址。
// img-src 只多放行一个 host：海报的地址是**响应自己给的**（Qloo 自己的图片域），
// 就只放行那一个域，不为好看放开任意外链。别的域的图片一律加载不出来，
// 界面会换成诚实的文字卡。
const securityHeaders = {
  'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://images.qloo.com; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** 没有注入适配器时对外报告的缺失配置项。只给变量名，不给值。 */
const DEFAULT_MISSING_CONFIG = ['QLOO_API_KEY', 'QLOO_BASE_URL'];

/**
 * 实例形态。内部开发树与发布候选只有三处不同，集中在这里——
 * 导出脚本只改这一块，别的逻辑两边共用。
 *
 * - defaultSurface：默认接入面。内部开发树走官方 CLI（真实请求走的都是它）；
 *   发布候选走原生 HTTP 适配器——官方 CURRENT 指南允许 GET 直连，而且这样生产依赖树
 *   里就没有带审计项的 CLI 依赖。
 * - alwaysConstrain：授权范围（电影类别、候选条数上限）是否恒定生效。发布候选是公开实例，
 *   范围恒定；内部开发树里它跟阶段走。
 * - alwaysEventHost：赛事 host 守卫是否恒定生效。发布候选恒定；内部开发树跟阶段走。
 */
const INSTANCE = Object.freeze({
  // 公开实例默认走原生 HTTP 适配器：官方 CURRENT 指南允许 GET 直连，
  // 而且这样生产依赖树里就没有带审计项的官方 CLI。
  defaultSurface: 'http',
  // 公开实例的授权范围恒定：电影类别、候选条数上限 20（官方 Insights 默认值），不看阶段。
  alwaysConstrain: true,
  // 公开实例只允许赛事 host，恒定生效。
  alwaysEventHost: true,
});

function isWithin(root, file) {
  const rest = relative(root, file);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function rawPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  const path = url.split('?', 1)[0];
  if (path.includes('\\') || path.includes('\0')) return null;
  if (/%(?![0-9a-f]{2})/i.test(path)) return null;

  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }

  if (decoded.includes('\\') || decoded.includes('\0') || decoded.startsWith('//')) return null;
  if (decoded.split('/').some((part) => part === '.' || part === '..')) return null;
  return path;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'text/javascript; charset=utf-8';
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', data.length);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (req.method === 'HEAD') res.end();
  else res.end(data);
}

function sendJson(req, res, status, payload) {
  send(req, res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

async function resolveFile(distRoot, relativeFile) {
  const root = await realpath(resolve(distRoot));
  const candidate = resolve(root, relativeFile);
  if (!isWithin(root, candidate)) return null;
  const file = await realpath(candidate);
  if (!isWithin(root, file)) return null;
  const info = await stat(file);
  return info.isFile() ? file : null;
}

/* ------------------------------------------------------------ 真实服务接口 */

// 契约模块来自构建产物；懒加载，让"没构建"和"没配置服务"是两种不同的错误。
let contractPromise;
function loadContract() {
  if (contractPromise === undefined) {
    contractPromise = import('../dist/assets/core/service.js').then(
      (module) => module,
      () => undefined,
    );
  }
  return contractPromise;
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJsonObject(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The request body must be a JSON object');
  }
  return parsed;
}

function outcomeStatus(outcome) {
  switch (outcome.status) {
    case 'resolved':
    case 'ambiguous':
    case 'ok':
    case 'empty':
      return 200;
    case 'invalid_input':
      return 400;
    case 'not_configured':
      return 503;
    case 'upstream_error':
      return outcome.retryable ? 503 : 502;
    default:
      return 500;
  }
}

/**
 * 预算状态：文件账本是本地的，直接读；持久预算的计数在共享存储里，要读一次才知道。
 */
async function describeBudgetState(budget) {
  if (typeof budget.snapshot === 'function') return await budget.snapshot();
  return {
    enabled: budget.enabled(),
    limit: budget.limit(),
    used: budget.used(),
    remaining: budget.remaining(),
    state: budget.state(),
  };
}

export async function handleApi(req, res, path, adapter, budget, credentialPresent) {
  const contract = await loadContract();
  if (contract === undefined) {
    return sendJson(req, res, 500, {
      status: 'upstream_error',
      message: 'The server build output is missing; run npm run build first.',
      retryable: false,
    });
  }

  // 先认路径再认方法：未知路径就是 404，与用什么方法无关。
  // 认完路径再按这个路径该收什么方法来——同一个接口不管用哪种错方法，
  // 给出的理由都得是真的（/api/resolve 只收 POST，就不能说"接受 GET 或 POST"）。
  const API_PATHS = ['/api/status', '/api/resolve', '/api/candidates', '/api/preflight'];
  if (!API_PATHS.includes(path)) {
    return sendJson(req, res, 404, { status: 'invalid_input', issues: ['Unknown endpoint'] });
  }

  if (path === '/api/status') {
    if (req.method !== 'GET') {
      return sendJson(req, res, 405, {
        status: 'invalid_input',
        issues: ['This endpoint only accepts GET'],
      });
    }
    const configuration =
      adapter === null
        ? {
            configured: false,
            missing: DEFAULT_MISSING_CONFIG,
            accessSurface: 'raw-http',
            accessSurfaceConfirmed: false,
            accessSurfaceLiveVerified: false,
          }
        : adapter.configuration();
    return sendJson(req, res, 200, {
      provider: adapter === null ? 'qloo' : adapter.provider,
      configured: configuration.configured,
      missing: configuration.missing,
      accessSurface: configuration.accessSurface,
      accessSurfaceConfirmed: configuration.accessSurfaceConfirmed,
      accessSurfaceLiveVerified: configuration.accessSurfaceLiveVerified ?? false,
      credentialPresent,
      budget: budget === null
        ? { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' }
        : await describeBudgetState(budget),
      // 只报这一轮**真支持**的种子类型：公开实例只授权电影，
      // 界面上就不该出现一个会被明确拒绝的音乐人选项。
      entityTypes: INSTANCE.alwaysConstrain ? ['movie'] : contract.SEED_ENTITY_TYPES,
      maxCandidates: contract.MAX_CANDIDATES,
    });
  }

  if (req.method !== 'POST') {
    return sendJson(req, res, 405, {
      status: 'invalid_input',
      issues: ['This endpoint only accepts POST'],
    });
  }

  let body;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sendJson(req, res, 400, { status: 'invalid_input', issues: [detail] });
  }

  if (path === '/api/resolve') {
    const validation = contract.validateSeedInput(body['seed'], body['entityType']);
    if (!validation.ok) {
      return sendJson(req, res, 400, { status: 'invalid_input', issues: validation.issues });
    }
    // 额度在**调用适配器之前**扣：一个操作 = 一次真实请求，失败也计入，
    // 页面刷新、重复点击、自动化轮询都吃同一份额度。
    if (budget === null || !(await budget.consume())) {
      return sendJson(req, res, 503, {
        status: 'upstream_error',
        message:
          budget === null || budget.state() === 'disabled'
            ? 'The live request budget is off: no live request is sent.'
            : budget.state() === 'exhausted'
              ? 'The live request budget is used up: no more live requests are sent, and nothing is retried automatically.'
              : 'The live request budget is temporarily unavailable (storage unreachable or state uncertain): no live request is sent, and nothing is retried.',
        retryable: false,
      });
    }
    if (adapter === null) {
      return sendJson(req, res, 503, {
        status: 'not_configured',
        missing: DEFAULT_MISSING_CONFIG,
      });
    }
    try {
      const outcome = await adapter.resolveSeed({
        seed: validation.seed,
        entityType: validation.entityType,
      });
      // 公开边界：**显式投影**后的解析结果，不带上游原始载荷（几 MB）。
      return sendJson(req, res, outcomeStatus(outcome), contract.toPublicResolveOutcome(outcome));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return sendJson(req, res, 502, {
        status: 'upstream_error',
        message: `Live service call failed: ${detail}`,
        retryable: false,
      });
    }
  }

  if (path === '/api/preflight') {
    // 预览：**不发任何请求，也不消耗额度**。作用是让人在花掉那 2 次之前先看清。
    if (adapter === null || adapter.previewRequest === undefined) {
      return sendJson(req, res, 501, {
        status: 'invalid_input',
        issues: ['This access surface does not support request previews'],
      });
    }
    try {
      const op = body['op'];
      if (op === 'resolve') {
        const validation = contract.validateSeedInput(body['seed'], body['entityType']);
        if (!validation.ok) {
          return sendJson(req, res, 400, { status: 'invalid_input', issues: validation.issues });
        }
        const preview = await adapter.previewRequest({
          op: 'resolve',
          seed: validation.seed,
          entityType: validation.entityType,
        });
        return sendJson(req, res, 200, { status: 'ok', preview });
      }
      if (op === 'candidates') {
        const validation = contract.validateCandidateRequest(
          body['entityId'],
          body['limit'],
        );
        if (!validation.ok) {
          return sendJson(req, res, 400, { status: 'invalid_input', issues: validation.issues });
        }
        const preview = await adapter.previewRequest({
          op: 'candidates',
          entityId: validation.entityId,
          limit: validation.limit,
        });
        return sendJson(req, res, 200, { status: 'ok', preview });
      }
      return sendJson(req, res, 400, {
        status: 'invalid_input',
        issues: ['op must be resolve or candidates'],
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return sendJson(req, res, 502, {
        status: 'upstream_error',
        message: `Could not build the request preview: ${detail}`,
        retryable: false,
      });
    }
  }

  if (path === '/api/candidates') {
    const validation = contract.validateCandidateRequest(
      body['entityId'],
      body['limit'],
    );
    if (!validation.ok) {
      return sendJson(req, res, 400, { status: 'invalid_input', issues: validation.issues });
    }
    if (budget === null || !(await budget.consume())) {
      return sendJson(req, res, 503, {
        status: 'upstream_error',
        message:
          budget === null || budget.state() === 'disabled'
            ? 'The live request budget is off: no live request is sent.'
            : budget.state() === 'exhausted'
              ? 'The live request budget is used up: no more live requests are sent, and nothing is retried automatically.'
              : 'The live request budget is temporarily unavailable (storage unreachable or state uncertain): no live request is sent, and nothing is retried.',
        retryable: false,
      });
    }
    if (adapter === null) {
      return sendJson(req, res, 503, {
        status: 'not_configured',
        missing: DEFAULT_MISSING_CONFIG,
      });
    }
    try {
      const outcome = await adapter.fetchCandidates({
        entityId: validation.entityId,
        limit: validation.limit,
      });
      // 公开边界：同上，原始载荷不过界。
      return sendJson(req, res, outcomeStatus(outcome), contract.toPublicCandidateOutcome(outcome));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return sendJson(req, res, 502, {
        status: 'upstream_error',
        message: `Live service call failed: ${detail}`,
        retryable: false,
      });
    }
  }

  return sendJson(req, res, 404, { status: 'invalid_input', issues: ['Unknown endpoint'] });
}

/**
 * 阶段适配器包装：这一轮只授权**电影类别**与**候选条数上限**。
 *
 * 包装层不改结果、不发请求，只把前端能给的参数钉在授权范围内：
 * 类别不是电影的种子明确报出来（不偷偷改成电影），候选条数一律不超过
 * `PHASE_CANDIDATE_LIMIT`（官方 Insights 的默认值 20），请求预览也按同样的
 * 约束显示，免得预览说 20、实际发 5。
 */
/** 授权的候选条数上限：官方 Insights 默认 20，最多 50。 */
export const PHASE_CANDIDATE_LIMIT = 20;

export function constrainAdapterForPhase(adapter) {
  return {
    provider: adapter.provider,
    configuration: () => adapter.configuration(),
    previewRequest(input) {
      if (input.op === 'resolve') {
        return adapter.previewRequest({ ...input, entityType: 'movie' });
      }
      return adapter.previewRequest({ ...input, limit: PHASE_CANDIDATE_LIMIT });
    },
    async resolveSeed(input) {
      if (input.entityType !== 'movie') {
        return {
          status: 'invalid_input',
          issues: ['This round only authorises movie seeds: the artist entry point is out of scope.'],
        };
      }
      return adapter.resolveSeed(input);
    },
    async fetchCandidates(input) {
      return adapter.fetchCandidates({
        ...input,
        limit: Math.min(Math.max(input.limit, 1), PHASE_CANDIDATE_LIMIT),
      });
    },
  };
}

export function createStaticServer(distRoot = projectDist, options = {}) {
  const adapter = options.adapter ?? null;
  const budget = options.budget ?? null;
  /** 只报"在不在"，绝不报凭据本身。 */
  const credentialPresent = options.credentialPresent ?? null;
  return createServer(async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);

    try {
      const path = rawPath(req.url);
      if (path === null) return send(req, res, 400, 'Bad Request\n');

      if (path.startsWith('/api/')) {
        return await handleApi(req, res, path, adapter, budget, credentialPresent);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, 'Method Not Allowed\n', 'text/plain; charset=utf-8', {
          Allow: 'GET, HEAD',
        });
      }

      const relativeFile = routeFor(path);
      if (relativeFile === undefined) return send(req, res, 404, 'Not Found\n');

      try {
        const file = await resolveFile(distRoot, relativeFile);
        if (!file) return send(req, res, 404, 'Not Found\n');
        const data = await readFile(file);
        return send(req, res, 200, data, contentType(relativeFile));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return send(req, res, 404, 'Not Found\n');
        }
        throw error;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Static file error: ${detail}`);
      if (!res.headersSent) return send(req, res, 500, 'Internal Server Error\n');
      res.destroy();
    }
  });
}

/**
 * 读项目内的私有凭据文件。只在服务端读，永远不打印、不复制到前端。
 * 文件缺失或读不出来就当"没有凭据"，不猜、不报错里带内容。
 */
function readPrivateCredentials(env = process.env) {
  const file = env.QLOO_CREDENTIALS_FILE
    ? resolve(env.QLOO_CREDENTIALS_FILE)
    : join(projectRoot, '.taste-tuner', 'credentials.json');
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey : '';
    return key.length === 0 ? null : { apiKey: key };
  } catch {
    return null;
  }
}

function parsePort(value) {
  if (value === undefined) return 4173;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PORT must be an integer between 1024 and 65535');
  }
  return port;
}

/**
 * 建预算。
 *
 * 默认是**本地文件账本**（单实例形态）：一个 JSON 文件 + 独占锁。
 * 设 `QLOO_DURABLE_BUDGET=1` 就改用共享存储上的**持久预算**：全局上限必须是所有部署
 * 共用的一份计数，文件账本做不到（每个实例一份；无状态平台上临时文件还会被回收）。
 *
 * 这时必须给出服务端存储适配器模块；拿不到就**拒绝启动**——绝不悄悄退回文件账本，
 * 悄悄退回会把"全局上限"悄悄变成"每实例上限"。
 */
async function createBudget({ limit, ledgerPath, env = process.env }) {
  if (String(env.QLOO_DURABLE_BUDGET ?? '').trim() !== '1') {
    const { createRequestBudget } = await import('./request-budget.mjs');
    return createRequestBudget(
      limit === undefined
        ? { enabled: false }
        : { enabled: true, limit, stateDir: dirname(ledgerPath) },
    );
  }
  const {
    createDurableBudget,
    loadBlobStore,
    DURABLE_BUDGET_ADAPTER_ENV,
    DURABLE_BUDGET_PHASE_ID_ENV,
    DURABLE_BUDGET_CUTOFF_ENV,
  } = await import('./durable-budget.mjs');
  const phaseId = String(env[DURABLE_BUDGET_PHASE_ID_ENV] ?? '').trim();
  if (phaseId === '') {
    throw new Error(
      `The shared budget needs ${DURABLE_BUDGET_PHASE_ID_ENV}: every deployment and environment shares one phase id.`,
    );
  }
  // 适配器路径**可选**：不给就用打包进来的那个（静态引入，保证它在函数包里）。
  // 只有本地测试才用这个变量换假适配器。
  const adapterPath = String(env[DURABLE_BUDGET_ADAPTER_ENV] ?? '').trim();
  const adapter = await loadBlobStore(adapterPath);
  return createDurableBudget({
    adapter,
    phaseId,
    limit: limit ?? 0,
    cutoff: env[DURABLE_BUDGET_CUTOFF_ENV],
  });
}

/**
 * 建服务上下文：适配器 + 预算 + 凭据是否就位。
 *
 * CLI 与平台入口（Vercel Function）共用这一份，避免两处各写一套、走出两种行为。
 */
export async function createServiceContext(env = process.env) {
  // 接入面由 QLOO_ACCESS_SURFACE 选，默认值见 INSTANCE.defaultSurface。
  // 凭据只在这里由服务端从环境变量读取：既不进浏览器，也不进日志。
  // 没有配置时适配器会如实报告"未配置"，不会退回任何合成数据。
  const { createHarnessAdapter, QLOO_ACCESS_SURFACE_ENV, EVENT_BASE_URL } = await import(
    './qloo-cli.mjs'
  );
  const { createQlooAdapter } = await import('../dist/assets/core/qloo.js');
  const {
    readBudgetLimitFromEnv,
    resolvePhaseBudget,
    QLOO_REQUEST_BUDGET_PHASE_ENV,
    PRIVATE_DIR,
  } = await import('./request-budget.mjs');

  // 预算默认拒绝：没有显式设置 QLOO_REQUEST_BUDGET 就一个真实请求都不发。
  //
  // 指定阶段时（QLOO_REQUEST_BUDGET_PHASE）：用**阶段账本**（另起一个文件，
  // 历史那 2 次的账本原样保留），上限取阶段授权值与环境变量里的**较小**那个——
  // 环境变量只能把额度调小，不能把它调大。
  //
  // 阶段只是**上限**，不是开关：只设阶段名而不给数字，仍然默认拒绝。
  // 「选一份阶段账本」不等于「授权发请求」。
  const phaseName = env[QLOO_REQUEST_BUDGET_PHASE_ENV];
  const phase = phaseName === undefined ? undefined : resolvePhaseBudget(phaseName);
  if (phaseName !== undefined && phase === undefined) {
    throw new Error(`Unknown request budget phase: ${phaseName}`);
  }
  const envLimit = readBudgetLimitFromEnv(env);
  const limit =
    envLimit === undefined
      ? undefined
      : phase === undefined
        ? envLimit
        : phase.limit === undefined
          ? envLimit
          : Math.min(envLimit, phase.limit);
  // 账本落在哪：阶段账本另起一个文件，历史那 2 次的账本原样保留。
  // 路径打到启动日志里——不然没人能确认这一轮用的是哪一份账。
  const ledgerPath =
    phase === undefined
      ? join(process.cwd(), PRIVATE_DIR, 'request-budget.json')
      : join(process.cwd(), PRIVATE_DIR, phase.stateDir, 'request-budget.json');
  const budget = await createBudget({ limit, ledgerPath, env });

  const surface = String(env[QLOO_ACCESS_SURFACE_ENV] ?? INSTANCE.defaultSurface)
    .trim()
    .toLowerCase();

  // 凭据只从项目内的私有文件读，在服务端内存里，不进日志、不进前端、不进 argv。
  // 平台部署没有这个文件，凭据走服务端环境变量（QLOO_API_KEY）——适配器自己会读。
  const credentials = readPrivateCredentials(env);
  const envKey = String(env.QLOO_API_KEY ?? '').trim();

  // 基址：显式设置优先，否则用已核实的赛事 host。
  const baseUrl = String(env.QLOO_BASE_URL ?? EVENT_BASE_URL).trim();

  // host 守卫：只允许赛事 host，别的 host 一律拒绝启动，不静默换地址。
  // 内部开发树里它跟阶段走；公开实例里它恒定生效（INSTANCE.alwaysEventHost）。
  if (phase !== undefined || INSTANCE.alwaysEventHost) {
    const allowedOrigin = new URL(EVENT_BASE_URL).origin;
    const actualOrigin = new URL(baseUrl).origin;
    if (actualOrigin !== allowedOrigin) {
      throw new Error(
        `Only the event host ${allowedOrigin} is allowed, but the base URL is ${actualOrigin}.` +
          'No silent fallback: set QLOO_BASE_URL to the event host.',
      );
    }
  }

  const baseAdapter =
    surface === 'http'
      ? createQlooAdapter({ apiKey: credentials?.apiKey, baseUrl })
      : createHarnessAdapter({ apiKey: credentials?.apiKey, baseUrl });
  // 阶段授权的是**电影类别、take 5**：包装层只钉参数，不自己发请求。
  // 公开实例的范围恒定生效（INSTANCE.alwaysConstrain），不看阶段。
  const adapter =
    phase === undefined && !INSTANCE.alwaysConstrain
      ? baseAdapter
      : constrainAdapterForPhase(baseAdapter);

  return {
    adapter,
    budget,
    credentialPresent: credentials !== null || envKey.length > 0,
    baseUrl,
    ledgerPath,
    limit,
    phase,
  };
}

async function startCli() {
  const port = parsePort(process.env.PORT);
  // 监听地址：默认只绑本机。对外暴露交给代理/容器网络，别默认开公网。
  const host = String(process.env.HOST ?? '127.0.0.1').trim();
  const { adapter, budget, credentialPresent, baseUrl, ledgerPath } = await createServiceContext(
    process.env,
  );
  const server = createStaticServer(projectDist, { adapter, budget, credentialPresent });
  let closing = false;

  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) {
        console.error(`Failed to stop server: ${error.message}`);
        process.exitCode = 1;
      }
    });
  };

  server.on('error', (error) => {
    console.error(`Failed to start server: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    // 账本位置要打到日志里：不然没人能确认这一轮用的是哪一份计数。
    const ledgerLabel =
      String(process.env.QLOO_DURABLE_BUDGET ?? '').trim() === '1'
        ? `shared storage ${budget.path}`
        : `local ledger ${ledgerPath}`;
    console.log(
      `Serving http://${host}:${port}/ (Ctrl+C to stop) — access surface: ${adapter.configuration().accessSurface}; base: ${baseUrl}; credential: ${credentialPresent ? 'Credential in place (not printed)' : 'Not configured'}; request budget: ${budget.enabled() ? `${budget.limit()} requests (used ${budget.used()})` : 'off, no live requests'}; ledger: ${ledgerLabel}`,
    );
  });
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  startCli().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start server: ${detail}`);
    process.exitCode = 1;
  });
}
