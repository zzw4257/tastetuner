/**
 * Qloo 适配器：把官方公开文档核实过的接口翻译成 `service.ts` 的内部契约。
 *
 * 核实过的契约（2026-10-28 只读公开文档，**没有发出任何业务请求**）：
 * - 名称解析：`GET {base}/search?query=<title>&types=urn:entity:movie&take=…`
 *   → 200 / **404 No results** / 429
 *   （docs-public/reference/get-search.md）
 * - 推荐：`GET {base}/v2/insights?filter.type=…&signal.interests.entities=<UUID>
 *   &filter.exclude.entities=<UUID>&feature.explainability=true&take=…`
 *   → `success` / `results.entities[]`
 *   （docs-public/reference/insights-api-deep-dive.md、basic-insights-use-case.md）
 * - 实体详情：`GET {base}/entities?entity_ids=<UUID>`
 *   （docs-public/reference/get-entities.md）
 * - 鉴权头是 `X-Api-Key`，公共 API 基址是 `https://api.qloo.com`
 *   （docs-public/reference/api-onboarding.md）
 *
 * 接入面（2026-10-29 按官方 CURRENT 开发者指南修订）：
 * - 官方指南 https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
 *   （updatedAt 2026-10-07）自己给出的就是 `GET /search` 与 `GET /v2/insights` 的
 *   curl / Python 直连示例，**CLI 不是必须**——所以直连 HTTP 是官方允许的接入面。
 * - 但"官方允许"不等于"本地实测过"：这条路径**从未对真实 API 跑过**，
 *   只对着本机假服务验过。界面上这两件事分开说，不混成一句"已验证"。
 *
 * 刻意不做的事：
 * - **不设默认基址**。基址必须显式配置，没有配置就报"未配置"；
 *   api.qloo.com 与赛事地址之间**绝不静默切换**。
 *   赛事基址 `https://hackathon.api.qloo.com` 已在 scripts/qloo-cli.mjs 里核实，
 *   但这个模块自己不知道它，所以不写死在这里。
 * - **不自动重试**。默认 0 次；探路期间任何一次尝试都计入请求预算。
 */

import type {
  AdapterConfiguration,
  CandidateOutcome,
  ResolveOutcome,
  SeedEntityType,
  ServiceAdapter,
  ServiceCandidate,
  ServiceContribution,
  ServiceDetails,
  ServiceEntity,
  ServiceTag,
} from './service.js';
import { ENTITY_TYPE_URN, MAX_CANDIDATES, OUTPUT_ENTITY_TYPE_URN } from './service.js';

export const QLOO_API_KEY_ENV = 'QLOO_API_KEY';
export const QLOO_BASE_URL_ENV = 'QLOO_BASE_URL';

/** 官方文档给出的取回条数上限。 */
const SEARCH_TAKE_MAX = 100;
const INSIGHTS_TAKE_MAX = 50;
/** 官方默认返回 20 条；5 只是当初探路时的探针上限，不是产品要求。 */
const SEARCH_TAKE_DEFAULT = 20;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface QlooAdapterOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** 测试可注入；生产走全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 读环境变量。浏览器里没有 process，所以这里拿到 undefined——正好就是"未配置"。
 * 刻意不引 @types/node：这个包要在浏览器里也能安全加载。
 */
function readEnv(name: string): string | undefined {
  const runtime = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return runtime?.env?.[name];
}

/**
 * 关联分在官方文档里有 0–100 与 0–+1 两种表述，归一到 0–1；两种都认，
 * 超出范围的值不认。
 */
export function normalizeAffinity(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined || raw < 0) return undefined;
  if (raw <= 1) return raw;
  if (raw <= 100) return raw / 100;
  return undefined;
}

function normalizePercentile(value: unknown): number | undefined {
  const raw = asNumber(value);
  if (raw === undefined) return undefined;
  if (raw >= 0 && raw <= 1) return raw;
  if (raw > 1 && raw <= 100) return raw / 100;
  return undefined;
}

/** 实体的稳定标识：官方字段名是 `entity_id`。 */
function readEntityId(source: JsonRecord): string | undefined {
  return (
    asString(source['entity_id']) ??
    asString(source['entityId']) ??
    asString(source['qloo_id']) ??
    asString(source['id'])
  );
}

/**
 * 细分类 URN。
 *
 * 真实响应里两种形状都有：
 * - `/v2/insights`：`type` = "urn:entity"，`subtype` = "urn:entity:movie"；
 * - `/search`：**没有** `subtype`/`type`，只有 `types: ["urn:entity:movie"]`。
 * 所以顺序是 subtype → types[0] → type。
 */
function readEntityType(source: JsonRecord): string {
  const subtype = asString(source['subtype']);
  if (subtype !== undefined) return subtype;
  const types = source['types'];
  if (Array.isArray(types)) {
    for (const item of types) {
      const value = asString(item);
      if (value !== undefined) return value;
    }
  }
  return asString(source['type']) ?? 'urn:entity:unknown';
}

/**
 * 实体自带的标签集合。
 *
 * 真实响应里两种形状都有：`/search` 用 `tag_id`，`/v2/insights` 用 `id`。
 */
function readTags(source: JsonRecord): readonly ServiceTag[] {
  const raw = source['tags'];
  if (!Array.isArray(raw)) return [];
  const tags: ServiceTag[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item['id']) ?? asString(item['tag_id']);
    if (id === undefined) continue;
    tags.push({ id, name: asString(item['name']) ?? id });
  }
  return Object.freeze(tags);
}

/**
 * 可选详情。官方实体示例里有 release_year / description / image.url 等，
 * 但它们是**可选**的——响应没带就是没有，不补默认值。
 */
/**
 * 别名与本地化短描述。
 * 官方样例里 `akas` 是 `[{value, languages}]`，`short_descriptions` 同构。
 * 中文界面优先取带 zh 的那条，取不到再退回第一条。
 */
function readLocalized(list: unknown): { value?: string; chinese?: string } {
  if (!Array.isArray(list)) return {};
  let first;
  let chinese;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const raw = asString(item['value']);
    if (raw === undefined) continue;
    // 实测别名值外面带一对对称的双引号（"\"示例别名\""），去掉它。
    const value =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    if (first === undefined) first = value;
    const languages = Array.isArray(item['languages']) ? item['languages'] : [];
    if (chinese === undefined && languages.includes('zh')) chinese = value;
  }
  return {
    ...(first === undefined ? {} : { value: first }),
    ...(chinese === undefined ? {} : { chinese }),
  };
}

/**
 * 外部标识。官方样例里是 `external`，形如
 * `{ imdb: [{id, user_rating}], wikidata: [{id}], … }`——不是 `external_ids`。
 * 这里压成"Source → identifier"；评分等其余字段保留在原始载荷里。
 */
function readExternalIds(entity: JsonRecord): Record<string, string> {
  // 真实响应里 `/v2/insights` 把 external 放在实体顶层，`/search` 放在 properties 里。
  const properties = isRecord(entity['properties']) ? entity['properties'] : {};
  const external = isRecord(entity['external'])
    ? entity['external']
    : isRecord(properties['external'])
      ? properties['external']
      : undefined;
  if (external === undefined) return {};
  const result: Record<string, string> = {};
  for (const [provider, value] of Object.entries(external)) {
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      const id = isRecord(item) ? asString(item['id']) : asString(item);
      if (id !== undefined) {
        result[provider] = id;
        break;
      }
    }
  }
  return result;
}

/**
 * 官方实体样例里，流媒体是以实体层 `tags[]` 的形式给的：
 * `{ id: "urn:tag:streaming_service:media:directv", name: "Directv", … }`。
 * 这就是"去向"在官方数据里的样子。
 */
/**
 * 已知会出现在 `external` 里的流媒体键。
 *
 * 只列**真实响应里确实出现过**的键——目前是 netflix。别的键等真实响应里出现再补，
 * 不凭空猜。
 */
const KNOWN_STREAMING_KEYS: Readonly<Record<string, string>> = Object.freeze({
  netflix: 'Netflix',
});

function readStreamingServices(entity: JsonRecord): readonly string[] {
  const fromTags = readTags(entity)
    .filter((tag) => tag.id.startsWith('urn:tag:streaming_service:'))
    .map((tag) => tag.name);
  const fromExternal = Object.entries(KNOWN_STREAMING_KEYS)
    .filter(([key]) => readExternalIds(entity)[key] !== undefined)
    .map(([, label]) => label);
  return Object.freeze([...new Set([...fromTags, ...fromExternal])]);
}

function readDetails(entity: JsonRecord): ServiceDetails {
  const properties = isRecord(entity['properties']) ? entity['properties'] : {};
  const releaseDate = asString(properties['release_date']) ?? undefined;
  const releaseYear = asNumber(properties['release_year']);
  const contentRating = asString(properties['content_rating']) ?? undefined;
  const duration = asNumber(properties['duration']);
  const image = isRecord(properties['image']) ? properties['image'] : undefined;
  const imageUrl = asString(image?.['url']) ?? asString(properties['image']) ?? undefined;

  // 真实响应里两种形状都有：`websites` 是数组（实测是一长串影评链接），
  // `website` 是单条（/search 用）。它们是"相关链接"，不是官方实体页。
  const links: string[] = [];
  const websites = Array.isArray(properties['websites']) ? properties['websites'] : [];
  for (const item of websites) {
    const value = asString(item);
    if (value !== undefined) links.push(value);
  }
  const single = asString(properties['website']) ?? asString(properties['url']);
  if (single !== undefined) links.unshift(single);

  const alias = readLocalized(properties['akas']);
  const shortDescription = readLocalized(properties['short_descriptions']);
  const description =
    shortDescription.chinese ?? shortDescription.value ?? asString(properties['description']);

  const externalIds = readExternalIds(entity);
  const streamingServices = readStreamingServices(entity);

  return Object.freeze({
    ...(releaseDate === undefined ? {} : { releaseDate }),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(contentRating === undefined ? {} : { contentRating }),
    ...(duration === undefined ? {} : { duration }),
    ...(description === undefined ? {} : { description }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
    ...(alias.chinese === undefined ? {} : { alsoKnownAs: alias.chinese }),
    ...(links.length === 0 ? {} : { relatedLinks: Object.freeze(links) }),
    ...(streamingServices.length === 0 ? {} : { streamingServices }),
    ...(Object.keys(externalIds).length === 0 ? {} : { externalIds: Object.freeze(externalIds) }),
  });
}

function toServiceEntity(source: unknown): ServiceEntity | null {
  if (!isRecord(source)) return null;
  const id = readEntityId(source);
  const name = asString(source['name']) ?? asString(source['title']);
  if (id === undefined || name === undefined) return null;
  const properties = isRecord(source['properties']) ? source['properties'] : {};
  const year = asNumber(properties['release_year']);
  const disambiguation = asString(source['disambiguation']);
  // 海报：/search 的实体也带 `properties.image.url`（实测如此）。
  const image = isRecord(properties['image']) ? properties['image'] : undefined;
  const imageUrl = asString(image?.['url']) ?? asString(properties['image']);
  return Object.freeze({
    id,
    name,
    type: readEntityType(source),
    ...(year === undefined ? {} : { year }),
    ...(disambiguation === undefined ? {} : { disambiguation }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
    tags: readTags(source),
  });
}

/* ------------------------------------------------------------ 响应解析 */

/** 从响应里取出实体数组：insights 与 entities 用 `results.entities`，search 用 `results`。 */
/**
 * 两个接口共用的信封判断：`results` 是数组，或 `results.entities` 是数组。
 *
 * extractEntities 认这两种形状，所以判断也得认这两种——之前 insights 那边的守卫
 * 只认 `results` 是对象，于是 `results` 是数组时，明明能解出实体，却被报成
 * "形状不符"。两个兄弟解析器对同一件事该有同一个答案。
 */
function hasResultsEnvelope(payload: JsonRecord): boolean {
  const results = payload['results'];
  return (
    Array.isArray(results) ||
    (isRecord(results) && Array.isArray(results['entities']))
  );
}

/** 信封对不上时，两个接口说同一句实话。 */
const RESULTS_SHAPE_ERROR = 'The upstream response has no results field or results.entities; the shape is not what we expect';

export function extractEntities(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const results = payload['results'];
  if (Array.isArray(results)) return results;
  if (isRecord(results) && Array.isArray(results['entities'])) return results['entities'];
  return [];
}

/**
 * 解析名称解析（/search）的响应。
 * 命中一个 → resolved；命中多个 → ambiguous（必须让用户选）；一个没中 → empty。
 */
export function parseSearchResponse(payload: unknown): ResolveOutcome {
  if (!isRecord(payload)) {
    return {
      status: 'upstream_error',
      message: 'The upstream did not return a JSON object',
      retryable: false,
    };
  }
  if (!hasResultsEnvelope(payload)) {
    // 连 results 都没有：形状不符，不能当成"没找到"。
    return {
      status: 'upstream_error',
      message: RESULTS_SHAPE_ERROR,
      retryable: false,
    };
  }
  const parsed = extractEntities(payload)
    .map(toServiceEntity)
    .filter((item): item is ServiceEntity => item !== null);
  if (parsed.length === 0) {
    return {
      status: 'empty',
      message: 'The service did not match this seed. Try another spelling, or another entity type.',
    };
  }
  if (parsed.length === 1) {
    return { status: 'resolved', entity: parsed[0] as ServiceEntity };
  }
  return { status: 'ambiguous', candidates: parsed };
}

/**
 * 归因元数据：每条结果的 `query.explainability` 说明**各个输入实体各贡献了多少**。
 *
 * 真实响应的结构是
 * `query.explainability["signal.interests.entities"] = [{entity_id, score}]`，
 * score 归一化到 0–1。**只输入一个种子时它的贡献分恒为 1** —— 那是"全部由它贡献"
 * 的归因，**不是**任何人的喜好概率。
 *
 * 另外也接受 `entities` / `contributions` 这两种更泛的形状。
 */
function readContributions(source: JsonRecord): readonly ServiceContribution[] {
  const query = isRecord(source['query']) ? source['query'] : undefined;
  const explainability =
    query !== undefined && isRecord(query['explainability']) ? query['explainability'] : undefined;
  if (explainability === undefined) return [];

  const list = Array.isArray(explainability['signal.interests.entities'])
    ? explainability['signal.interests.entities']
    : Array.isArray(explainability['entities'])
      ? explainability['entities']
      : Array.isArray(explainability['contributions'])
        ? explainability['contributions']
        : undefined;
  if (list !== undefined) {
    const parsed: ServiceContribution[] = [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const score = asNumber(item['score']) ?? asNumber(item['normalized_score']);
      const entityId = readEntityId(item);
      if (score === undefined || entityId === undefined) continue;
      parsed.push({
        entityId,
        entityName: asString(item['name']) ?? entityId,
        score,
      });
    }
    return Object.freeze(parsed);
  }

  const map = isRecord(explainability['entities']) ? explainability['entities'] : undefined;
  if (map === undefined) return [];
  const parsed: ServiceContribution[] = [];
  for (const [entityId, value] of Object.entries(map)) {
    const score = asNumber(value);
    if (score === undefined) continue;
    parsed.push({ entityId, entityName: entityId, score });
  }
  return Object.freeze(parsed);
}

/**
 * 解析推荐（/v2/insights）的响应。
 * 官方样本是 `success` + `results.entities[]`；每条实体有 entity_id / name / subtype，
 * properties 与 tags 是**可选**的，缺了就是没有。
 */
export function parseInsightsResponse(payload: unknown): CandidateOutcome {
  if (!isRecord(payload)) {
    return {
      status: 'upstream_error',
      message: 'The upstream did not return a JSON object',
      retryable: false,
    };
  }

  const raw = extractEntities(payload);
  if (!hasResultsEnvelope(payload)) {
    // 形状对不上：不能当成"没有候选"——那会让界面谎称服务没返回东西。
    return {
      status: 'upstream_error',
      message: RESULTS_SHAPE_ERROR,
      retryable: false,
    };
  }

  const candidates: ServiceCandidate[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) return;
    const id = readEntityId(item);
    const name = asString(item['name']) ?? asString(item['title']);
    if (id === undefined || name === undefined) return;

    const innerQuery = isRecord(item['query']) ? item['query'] : undefined;
    const affinityRaw = asNumber(item['affinity']) ?? asNumber(innerQuery?.['affinity']);
    const popularity = normalizePercentile(item['popularity']);
    const trend = normalizePercentile(item['trend']);
    const serviceRank = asNumber(item['index']) ?? index + 1;

    candidates.push(
      Object.freeze({
        id,
        name,
        type: readEntityType(item),
        affinity: normalizeAffinity(affinityRaw) ?? null,
        affinityRaw: affinityRaw ?? null,
        popularity: popularity ?? null,
        trend: trend ?? null,
        serviceRank,
        contributions: readContributions(item),
        details: readDetails(item),
        tags: readTags(item),
        ...(asString(item['disambiguation']) === undefined
          ? {}
          : { disambiguation: asString(item['disambiguation']) as string }),
      }),
    );
  });

  if (candidates.length === 0) {
    const warning = readExplainabilityWarning(payload);
    return {
      status: 'empty',
      message: warning ?? 'The service returned no candidates. Try another seed or relax the filters.',
    };
  }

  const warning = readExplainabilityWarning(payload);
  return {
    status: 'ok',
    candidates: Object.freeze(candidates),
    ...(warning === undefined ? {} : { explainabilityWarning: warning }),
  };
}

/** 顶层聚合解释里可能带 warning：算不出来时上游会说明，但结果照常返回。 */
function readExplainabilityWarning(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const query = isRecord(payload['query']) ? payload['query'] : undefined;
  const explainability =
    query !== undefined && isRecord(query['explainability']) ? query['explainability'] : undefined;
  return asString(explainability?.['warning']);
}

/* ------------------------------------------------------------ 错误映射 */

export type QlooFailureKind =
  | 'auth'
  | 'rate_limited'
  | 'not_found'
  | 'bad_request'
  | 'upstream'
  | 'network'
  | 'shape';

export interface QlooFailure {
  readonly kind: QlooFailureKind;
  readonly message: string;
  readonly retryable: boolean;
}

/** 把 HTTP 状态映射成明确的原因。官方要求鉴权与限流必须给出清楚错误，不能静默换路。 */
export function mapHttpStatus(status: number): QlooFailure {
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: 'The live service rejected this request: the credential is invalid or not permitted. Check the credential configured on the server.',
      retryable: false,
    };
  }
  if (status === 404) {
    // 官方文档把 404 定义为"没有结果"，不是故障。
    return { kind: 'not_found', message: 'The service matched no results.', retryable: false };
  }
  if (status === 429) {
    return {
      kind: 'rate_limited',
      message: 'The live service rate-limited us. Stop and confirm the quota with the organiser; do not retry in a loop.',
      retryable: true,
    };
  }
  if (status === 400) {
    return {
      kind: 'bad_request',
      message: 'The live service considers this request invalid: the parameters were rejected, or the seed did not resolve to an entity.',
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      kind: 'upstream',
      message: `The live service is temporarily unavailable (HTTP ${status}).`,
      retryable: true,
    };
  }
  return {
    kind: 'upstream',
    message: `The live service returned an unexpected status (HTTP ${status}).`,
    retryable: false,
  };
}

/* -------------------------------------------------------------- 适配器 */

export function createQlooAdapter(options: QlooAdapterOptions = {}): ServiceAdapter {
  const apiKey = options.apiKey ?? readEnv(QLOO_API_KEY_ENV);
  const baseUrl = options.baseUrl ?? readEnv(QLOO_BASE_URL_ENV);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const configuration = (): AdapterConfiguration => {
    const missing: string[] = [];
    if (apiKey === undefined || apiKey.trim().length === 0) missing.push(QLOO_API_KEY_ENV);
    // 没有默认主机：基址必须显式配置，绝不在 api.qloo.com 与赛事地址之间静默切换。
    if (baseUrl === undefined || baseUrl.trim().length === 0) missing.push(QLOO_BASE_URL_ENV);
    return {
      configured: missing.length === 0,
      missing,
      // 公共 API 文档核实过方法与字段；官方 CURRENT 指南自己给的也是直连示例。
      accessSurface: 'raw-http',
      // 官方允许：官方 CURRENT 指南自己就是直连的 curl / Python 示例，CLI 非必须。
      accessSurfaceConfirmed: true,
      // 本地实测：这条路径**从未对真实 API 跑过**，只对着本机假服务验过。
      accessSurfaceLiveVerified: false,
    };
  };

  /**
   * 一次 GET 请求。官方客户端的形状：查询参数拼在 URL 上，数组用逗号连接，
   * 鉴权头是 X-Api-Key。
   */
  /** 拼出将要请求的 URL 与参数——不发，不扣额度。 */
  const buildUrl = (
    path: string,
    params: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  ): URL => {
    const url = new URL(path, `${(baseUrl as string).replace(/\/+$/, '')}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        url.searchParams.set(key, value.join(','));
      } else if (value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  };

  const get = async (
    path: string,
    params: Readonly<Record<string, string | number | readonly string[] | undefined>>,
  ): Promise<
    | { readonly ok: true; readonly payload: unknown }
    | { readonly ok: false; readonly failure: QlooFailure }
  > => {
    const url = buildUrl(path, params);

    // **只发一次**。请求预算的单位就是"一次上游请求"，适配器自己再重试就会
    // 让账本少算——所以这里没有重试循环，也不给"要不要重试"的开关。
    // 想再来一次，是用户自己点「重试取候选」：那是新的一次尝试，新的一笔预算。
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          // 凭据只出现在这一个请求头里，不进日志、不进响应体。
          'X-Api-Key': apiKey as string,
        },
        // **不跟随跳转**：一次尝试就是一次 HTTP 请求。
        // 默认的 'follow' 会让一次操作变成两次尝试——那预算就不作数了。
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        failure: {
          kind: 'network',
          message: `Could not reach the live service: ${detail}`,
          // 可重试：是用户可以自己再试一次，不是适配器替你重发。
          retryable: true,
        },
      };
    }

    if (!response.ok) {
      return { ok: false, failure: mapHttpStatus(response.status) };
    }

    try {
      return { ok: true, payload: (await response.json()) as unknown };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        failure: {
          kind: 'shape',
          message: `The live service did not return parsable JSON: ${detail}`,
          retryable: false,
        },
      };
    }
  };

  return {
    provider: 'qloo',

    configuration,

    async resolveSeed(input): Promise<ResolveOutcome> {
      const config = configuration();
      if (!config.configured) return { status: 'not_configured', missing: config.missing };

      const result = await get('/search', {
        query: input.seed,
        types: ENTITY_TYPE_URN[input.entityType],
        take: SEARCH_TAKE_DEFAULT,
      });
      if (!result.ok) {
        if (result.failure.kind === 'not_found') {
          return {
            status: 'empty',
            message: 'The service did not match this seed. Try another spelling, or another entity type.',
          };
        }
        return {
          status: 'upstream_error',
          message: result.failure.message,
          retryable: result.failure.retryable,
        };
      }
      const outcome = parseSearchResponse(result.payload);
      return outcome.status === 'resolved' || outcome.status === 'ambiguous'
        ? { ...outcome, raw: result.payload }
        : outcome;
    },

    async fetchCandidates(input): Promise<CandidateOutcome> {
      const config = configuration();
      if (!config.configured) return { status: 'not_configured', missing: config.missing };

      const limit = Math.min(Math.max(input.limit, 1), MAX_CANDIDATES);
      const result = await get('/v2/insights', {
        // 输出领域固定是电影：种子是音乐人也返回电影，这样详情与硬约束始终成立。
        'filter.type': OUTPUT_ENTITY_TYPE_URN,
        'signal.interests.entities': [input.entityId],
        // 把种子自己排除掉，否则它会出现在自己的候选里。
        'filter.exclude.entities': [input.entityId],
        'feature.explainability': 'true',
        take: Math.min(limit, INSIGHTS_TAKE_MAX),
      });
      if (!result.ok) {
        if (result.failure.kind === 'not_found') {
          return { status: 'empty', message: 'The service returned no candidates.' };
        }
        return {
          status: 'upstream_error',
          message: result.failure.message,
          retryable: result.failure.retryable,
        };
      }
      const outcome = parseInsightsResponse(result.payload);
      return outcome.status === 'ok' ? { ...outcome, raw: result.payload } : outcome;
    },

    async previewRequest(input) {
      if (input.op === 'resolve') {
        const url = buildUrl('/search', {
          query: input.seed,
          types: ENTITY_TYPE_URN[input.entityType],
          take: SEARCH_TAKE_DEFAULT,
        });
        return {
          method: 'GET',
          url: url.toString(),
          params: {
            query: input.seed,
            types: ENTITY_TYPE_URN[input.entityType],
            take: SEARCH_TAKE_DEFAULT,
          },
          note: 'This is a preview of the request that would be sent. Nothing was sent and no budget was spent.',
        };
      }
      const params = {
        // 输出领域固定是电影：种子是音乐人也返回电影。
        'filter.type': OUTPUT_ENTITY_TYPE_URN,
        'signal.interests.entities': [input.entityId],
        'filter.exclude.entities': [input.entityId],
        'feature.explainability': 'true',
        take: Math.min(Math.max(input.limit, 1), INSIGHTS_TAKE_MAX),
      };
      const url = buildUrl('/v2/insights', params);
      return {
        method: 'GET',
        url: url.toString(),
        params,
        note: 'This is a preview of the request that would be sent. Nothing was sent and no budget was spent.',
      };
    },
  };
}
