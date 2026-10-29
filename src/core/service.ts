/**
 * 真实服务的领域契约与本地重排。
 *
 * 这一层不碰网络，也不碰凭据：它定义"What the server adapter has to hand back"，
 * 以及"How the real fields are deterministically reordered and explained locally"。
 *
 * 字段依据（2026-10-28 只读官方公开文档核实，没有发任何业务请求）：
 * - 名称解析：`GET /search?query=<title>&types=urn:entity:movie&take=…`
 *   （docs-public/reference/get-search.md）。返回 200 / **404 No results** / 429。
 * - 推荐：`GET /v2/insights?filter.type=…&signal.interests.entities=<UUID>&take=…`
 *   （docs-public/reference/insights-api-deep-dive.md）。
 * - 实体详情：`GET /entities?entity_ids=<UUID>`（docs-public/reference/get-entities.md）。
 * - 鉴权头是 `X-Api-Key`（docs-public/reference/api-onboarding.md），
 *   公共 API 基址是 `https://api.qloo.com`；赛事基址与额度尚未公布。
 * - 结果里的实体有 `entity_id`、`name`、`type`/`subtype`、`properties`、`popularity`、
 *   `tags`（每部影片确实带自己的标签集合）。
 * - `feature.explainability=true` 时，每条结果带 `query.explainability`——归一化到 0–1
 *   的**输入实体贡献**；顶层是聚合解释，可能带 `query.explainability.warning`。
 *   这是结构化归因元数据，**不保证有自然语言的"理由"字段**。
 *
 * 重要边界：affinity 按 query 归一，同一 query 内比相对位置才有意义；
 * 两次不同 query 的原始分不能相减。本地重排因此永远作用在**同一份冻结候选集**上。
 */

/** 种子可以是电影或音乐人（artist）。 */
export type SeedEntityType = 'movie' | 'artist';

export const ENTITY_TYPE_URN: Readonly<Record<SeedEntityType, string>> = Object.freeze({
  movie: 'urn:entity:movie',
  artist: 'urn:entity:artist',
});

/**
 * **输出领域固定是电影。**
 *
 * 种子类型决定"Which category to look it up in"，输出类型决定"What it shows you"。把两者分开，
 * 是因为：音乐人种子配电影输出才是"What films people who like this band also watch"；而且详情（上映年份、
 * 分级、片长）与硬约束（分级上限、上映年份下限）都只对电影成立 —— 输出要是音乐人，
 * 这些字段就都没有意义。
 */
export const OUTPUT_ENTITY_TYPE_URN = 'urn:entity:movie';

export const SEED_ENTITY_TYPES: readonly SeedEntityType[] = Object.freeze(['movie', 'artist']);

export const MAX_SEED_LENGTH = 120;
export const MAX_CANDIDATES = 50;

/** 实体自带的标签（docs-public 的实体示例里每个实体都有 tags 数组）。 */
export interface ServiceTag {
  readonly id: string;
  readonly name: string;
}

/** 上游实体标识符：Qloo 的稳定 GUID。 */
export interface ServiceEntity {
  readonly id: string;
  readonly name: string;
  /** 实体的细分类 URN，例如 urn:entity:movie。 */
  readonly type: string;
  /** 上映年份。是可选字段，响应没带就是没有。 */
  readonly year?: number;
  /** 官方样例里的消歧串，例如 "2022, Daniel Scheinert, Daniel Kwan"。 */
  readonly disambiguation?: string;
  /** 响应里给的海报地址（`properties.image.url`）。没有就是没有，不补。 */
  readonly imageUrl?: string;
  readonly tags: readonly ServiceTag[];
}

/** 一条候选的原始字段。只有服务真的返回了，字段才有值。 */
export interface ServiceCandidate {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** 归一化到 0–1 的关联分；服务没给就是 null，不补 0。 */
  readonly affinity: number | null;
  /** 服务返回的原始关联分，原样保留以便核对。 */
  readonly affinityRaw: number | null;
  /** 同类目内的流行度百分位，0–1。 */
  readonly popularity: number | null;
  /** 同类目内的趋势百分位，0–1。 */
  readonly trend: number | null;
  /** The original order from the service（从 1 开始）。 */
  readonly serviceRank: number | null;
  /** 贡献解释：哪个输入实体贡献了多少，0–1。 */
  readonly contributions: readonly ServiceContribution[];
  /** 服务返回的可用详情。缺失就是缺失，不编造。 */
  readonly details: ServiceDetails;
  /** 该候选自带的标签集合。 */
  readonly tags: readonly ServiceTag[];
  /** 官方样例里的消歧串，例如 "2022, Daniel Scheinert, Daniel Kwan"。 */
  readonly disambiguation?: string;
}

export interface ServiceContribution {
  readonly entityId: string;
  readonly entityName: string;
  readonly score: number;
}

export interface ServiceDetails {
  readonly releaseDate?: string;
  /** 上映年份。官方实体示例里有，但属可选字段，缺了就是没有。 */
  readonly releaseYear?: number;
  readonly contentRating?: string;
  /** 片长（分钟）。官方样例里有，属可选字段。 */
  readonly duration?: number;
  readonly description?: string;
  readonly imageUrl?: string;
  /** 别名（官方样例里是 `akas`，含语言标记）。中文界面里这条最有用。 */
  readonly alsoKnownAs?: string;
  /**
   * 服务标注的流媒体。
   *
   * 官方实体样例里，每个实体的 `tags[]` 会带
   * `urn:tag:streaming_service:media:*`（Directv、Neon Tv…），那就是"去向"在官方
   * 数据里的样子。这是**服务标注**，不是实时片源可用性检查。
   */
  readonly streamingServices?: readonly string[];
  /**
   * 服务返回的相关链接（影评站、官方页等）。
   *
   * 真实响应里 `properties.websites` 是一长串影评链接（实测不止一条），`properties.website`
   * 是单条。**它们不是"官方实体页"**，所以界面上不能那样叫。
   */
  readonly relatedLinks?: readonly string[];
  readonly externalIds?: Readonly<Record<string, string>>;
}

/* ---------------------------------------------------------------- 状态 */

export type ResolveOutcome =
  | { readonly status: 'resolved'; readonly entity: ServiceEntity; readonly raw?: unknown }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly ServiceEntity[];
      readonly raw?: unknown;
    }
  | { readonly status: 'empty'; readonly message: string }
  | { readonly status: 'not_configured'; readonly missing: readonly string[] }
  | { readonly status: 'invalid_input'; readonly issues: readonly string[] }
  | {
      readonly status: 'upstream_error';
      readonly message: string;
      readonly retryable: boolean;
    };

export type CandidateOutcome =
  | {
      readonly status: 'ok';
      readonly candidates: readonly ServiceCandidate[];
      readonly explainabilityWarning?: string;
      /** 上游返回的原始载荷，原样保留：校字段映射时要用它。 */
      readonly raw?: unknown;
    }
  | { readonly status: 'not_configured'; readonly missing: readonly string[] }
  | { readonly status: 'invalid_input'; readonly issues: readonly string[] }
  | { readonly status: 'empty'; readonly message: string }
  | {
      readonly status: 'upstream_error';
      readonly message: string;
      readonly retryable: boolean;
    };

/* ------------------------------------------------------- 公开边界投影 */

/**
 * 公开边界上的响应形状：**只保留界面与工具真正用到的解析后字段**。
 *
 * 上游原始载荷（适配器 outcome 里的 `raw`）有几 MB——它是校字段用的私有材料，
 * 不进公开响应：既是体积问题，也可能带着服务不打算公开的东西。
 */
export type PublicResolveOutcome =
  | { readonly status: 'resolved'; readonly entity: ServiceEntity }
  | { readonly status: 'ambiguous'; readonly candidates: readonly ServiceEntity[] }
  | { readonly status: 'empty'; readonly message: string }
  | { readonly status: 'not_configured'; readonly missing: readonly string[] }
  | { readonly status: 'invalid_input'; readonly issues: readonly string[] }
  | {
      readonly status: 'upstream_error';
      readonly message: string;
      readonly retryable: boolean;
    };

export type PublicCandidateOutcome =
  | {
      readonly status: 'ok';
      readonly candidates: readonly ServiceCandidate[];
      readonly explainabilityWarning?: string;
    }
  | { readonly status: 'not_configured'; readonly missing: readonly string[] }
  | { readonly status: 'invalid_input'; readonly issues: readonly string[] }
  | { readonly status: 'empty'; readonly message: string }
  | {
      readonly status: 'upstream_error';
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * 投影成公开形状：**显式逐字段挑**，不是"把 raw 删掉"。
 *
 * 显式挑的好处是以后给适配器加内部字段时，它默认不会漏出去——
 * 漏一个字段就是泄一份上游材料，所以这里是白名单式的。
 */
export function toPublicResolveOutcome(outcome: ResolveOutcome): PublicResolveOutcome {
  switch (outcome.status) {
    case 'resolved':
      return { status: 'resolved', entity: outcome.entity };
    case 'ambiguous':
      return { status: 'ambiguous', candidates: outcome.candidates };
    case 'empty':
      return { status: 'empty', message: outcome.message };
    case 'not_configured':
      return { status: 'not_configured', missing: outcome.missing };
    case 'invalid_input':
      return { status: 'invalid_input', issues: outcome.issues };
    default:
      return {
        status: 'upstream_error',
        message: outcome.message,
        retryable: outcome.retryable,
      };
  }
}

/** 同上：候选的公开形状。 */
export function toPublicCandidateOutcome(outcome: CandidateOutcome): PublicCandidateOutcome {
  switch (outcome.status) {
    case 'ok':
      return {
        status: 'ok',
        candidates: outcome.candidates,
        ...(outcome.explainabilityWarning === undefined
          ? {}
          : { explainabilityWarning: outcome.explainabilityWarning }),
      };
    case 'not_configured':
      return { status: 'not_configured', missing: outcome.missing };
    case 'invalid_input':
      return { status: 'invalid_input', issues: outcome.issues };
    case 'empty':
      return { status: 'empty', message: outcome.message };
    default:
      return {
        status: 'upstream_error',
        message: outcome.message,
        retryable: outcome.retryable,
      };
  }
}

/**
 * 可注入的服务适配器契约。
 * 服务端拿到具体实现；测试注入夹具实现。两种实现都不许回退到合成数据。
 */
export interface ServiceAdapter {
  readonly provider: string;
  /** 只报告"配没配"，绝不返回凭据本身。 */
  configuration(): AdapterConfiguration;
  resolveSeed(input: {
    readonly seed: string;
    readonly entityType: SeedEntityType;
  }): Promise<ResolveOutcome>;
  fetchCandidates(input: {
    readonly entityId: string;
    /** 输出领域固定，调用方不必再传。 */
    readonly limit: number;
  }): Promise<CandidateOutcome>;
  /** 可选：预览将要发出的请求。实现它**不得**发请求、也不得消耗预算。 */
  previewRequest?(input: PreviewInput): Promise<RequestPreview>;
}

export type PreviewInput =
  | { readonly op: 'resolve'; readonly seed: string; readonly entityType: SeedEntityType }
  | {
      readonly op: 'candidates';
      readonly entityId: string;
      readonly limit: number;
    };

/**
 * 一次真实请求的**预览**。
 *
 * 预览不发送任何请求，也不消耗预算——它的作用是让人在花掉那 2 次额度之前，
 * 先看清到底会发出什么。
 */
export interface RequestPreview {
  readonly method: string;
  readonly url: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** 预览本身的说明，含已知的官方工具怪癖。 */
  readonly note: string;
}

export interface AdapterConfiguration {
  readonly configured: boolean;
  /** 缺哪些环境变量（只给变量名，不给值）。 */
  readonly missing: readonly string[];
  /** 用的是哪条接入面。 */
  readonly accessSurface: string;
  /**
   * 这条接入面**官方是不是允许**。
   * 官方 CURRENT 开发者指南自己给出的就是 `GET /search` 与 `GET /v2/insights` 的
   * curl / Python 直连示例，CLI 不是必须——所以直连 HTTP 是官方允许的接入面。
   */
  readonly accessSurfaceConfirmed: boolean;
  /**
   * 这条接入面**有没有对真实 API 实测过**。
   * 官方允许 ≠ 本地实测过：只在本地假服务上跑过的路径，不能标成实测过。
   * 不填就是"没说"——界面上不替它下结论。
   */
  readonly accessSurfaceLiveVerified?: boolean;
}

/* ------------------------------------------------------------ 输入校验 */

export interface SeedValidation {
  readonly ok: boolean;
  readonly seed: string;
  readonly entityType: SeedEntityType;
  readonly issues: readonly string[];
}

/**
 * 种子输入校验。空串、控制字符、超长都在服务端拒绝并给出可读原因。
 * 真实服务不接收空查询，也不接收带控制字符的查询。
 */
export function validateSeedInput(
  raw: unknown,
  entityType: unknown,
): SeedValidation {
  const issues: string[] = [];

  let seed = '';
  if (typeof raw !== 'string') {
    issues.push('The seed must be a string');
  } else {
    seed = raw.trim();
    if (seed.length === 0) {
      issues.push('The seed must not be empty');
    } else if (seed.length > MAX_SEED_LENGTH) {
      issues.push(`The seed must not exceed ${MAX_SEED_LENGTH} characters`);
    }
    if (/[\u0000-\u001f\u007f]/.test(seed)) {
      issues.push('The seed must not contain control characters');
    }
  }

  let type: SeedEntityType = 'movie';
  if (typeof entityType !== 'string') {
    issues.push('The entity type must be a string');
  } else if (!SEED_ENTITY_TYPES.includes(entityType as SeedEntityType)) {
    issues.push(`The entity type must be ${SEED_ENTITY_TYPES.join(' or ')}`);
  } else {
    type = entityType as SeedEntityType;
  }

  return { ok: issues.length === 0, seed, entityType: type, issues };
}

export interface CandidateRequestValidation {
  readonly ok: boolean;
  readonly entityId: string;
  readonly limit: number;
  readonly issues: readonly string[];
}

/**
 * 候选请求校验：实体 ID 必须来自上游，不能是前端自造的一段字符串。
 *
 * 只有 entityId 与 limit 两样。**输出领域是固定的**（电影），
 * 调用方不必再传类别——`ServiceAdapter.fetchCandidates` 的契约也是这么写的。
 *
 * 早先这里还要求一个 entityType，可它既没被用到（适配器把输出类别写死成电影），
 * 前端也从没传过：于是每一次点「用这个继续」都被服务端以
 * "The entity type must be a string" 挡下，请求预览同样。收掉这个字段，接口才对得上。
 */
export function validateCandidateRequest(
  raw: unknown,
  limit: unknown,
): CandidateRequestValidation {
  const issues: string[] = [];

  let entityId = '';
  if (typeof raw !== 'string') {
    issues.push('The entity id must be a string');
  } else {
    entityId = raw.trim();
    if (entityId.length === 0) {
      issues.push('The entity id must not be empty');
    } else if (entityId.length > 200) {
      issues.push('The entity id is too long');
    } else if (!/^[A-Za-z0-9._:-]+$/.test(entityId)) {
      issues.push('The entity id contains disallowed characters');
    }
  }

  let max = 20;
  if (limit === undefined) {
    max = 20;
  } else if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_CANDIDATES
  ) {
    issues.push(`The count must be a whole number between 1 and ${MAX_CANDIDATES}`);
  } else {
    max = limit;
  }

  return { ok: issues.length === 0, entityId, limit: max, issues };
}

/* ------------------------------------------------------------ 硬约束 */

/**
 * 分级上限的顺序。MPAA 的分级是有序的：G < PG < PG-13 < R < NC-17。
 * 官方参数表里 `filter.content_rating` 明确兼容 Movie。
 */
export const CONTENT_RATING_ORDER: readonly string[] = Object.freeze([
  'G',
  'PG',
  'PG-13',
  'R',
  'NC-17',
]);

export interface ServiceConstraint {
  /** 分级上限：超过它的候选被挡下。null 表示不限。 */
  readonly maxContentRating: string | null;
  /** 上映年份下限：早于它的候选被挡下。null 表示不限。 */
  readonly minReleaseYear: number | null;
}

export const NO_CONSTRAINT: ServiceConstraint = Object.freeze({
  maxContentRating: null,
  minReleaseYear: null,
});

export interface ConstraintOutcome {
  readonly kept: readonly ServiceCandidate[];
  /** 明确违反约束的。 */
  readonly violated: readonly ServiceCandidate[];
  /** 相关字段缺失、无法核对的（保留，但计数）。 */
  readonly unverifiable: readonly ServiceCandidate[];
}

/**
 * 在**已经取回的候选**上本地施加硬约束。
 *
 * 两个依据都来自官方参数表（兼容 Movie）：`filter.content_rating` 与
 * `filter.release_year`。这里在本地做，不重新发请求——改了筛选不花额度。
 *
 * 字段缺失的候选**保留**并单独计数：说不清就不该悄悄扔掉。
 */
export function applyServiceConstraint(
  candidates: readonly ServiceCandidate[],
  constraint: ServiceConstraint,
): ConstraintOutcome {
  const ceiling =
    constraint.maxContentRating === null
      ? -1
      : CONTENT_RATING_ORDER.indexOf(constraint.maxContentRating);
  const kept: ServiceCandidate[] = [];
  const violated: ServiceCandidate[] = [];
  const unverifiable: ServiceCandidate[] = [];

  for (const candidate of candidates) {
    const rating = candidate.details.contentRating;
    const year = candidate.details.releaseYear;
    let bad = false;
    let unknown = false;

    if (ceiling >= 0) {
      if (rating === undefined) {
        unknown = true;
      } else {
        const index = CONTENT_RATING_ORDER.indexOf(rating);
        if (index < 0) {
          unknown = true; // 没见过的分级：不判它违规。
        } else if (index > ceiling) {
          bad = true;
        }
      }
    }

    if (constraint.minReleaseYear !== null) {
      if (year === undefined) {
        unknown = true;
      } else if (year < constraint.minReleaseYear) {
        bad = true;
      }
    }

    if (bad) violated.push(candidate);
    else {
      kept.push(candidate);
      if (unknown) unverifiable.push(candidate);
    }
  }

  return { kept, violated, unverifiable };
}

/* ---------------------------------------------------------- 本地重排 */

export interface ServiceControls {
  /** 关联权重：放大服务给的关联分，0–100。 */
  readonly affinityWeight: number;
  /** 流行度权重：混入服务给的流行度百分位，0–100。 */
  readonly popularityWeight: number;
  /** 标签相似度权重：混入候选与种子的共有标签比例，0–100。 */
  readonly tagSimilarityWeight: number;
}

export const DEFAULT_SERVICE_CONTROLS: ServiceControls = Object.freeze({
  affinityWeight: 100,
  popularityWeight: 0,
  tagSimilarityWeight: 0,
});

export interface ServiceControlResult {
  readonly ok: boolean;
  readonly controls: ServiceControls;
  readonly issues: readonly string[];
}

export function validateServiceControls(input: unknown): ServiceControlResult {
  const issues: string[] = [];
  const read = (key: string): number => {
    const value = (input as Record<string, unknown> | null)?.[key];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      issues.push(`${key} must be a whole number between 0 and 100`);
      return 0;
    }
    return value;
  };
  const affinityWeight = read('affinityWeight');
  const popularityWeight = read('popularityWeight');
  const tagSimilarityWeight = read('tagSimilarityWeight');
  if (issues.length > 0) return { ok: false, controls: DEFAULT_SERVICE_CONTROLS, issues };
  return {
    ok: true,
    controls: { affinityWeight, popularityWeight, tagSimilarityWeight },
    issues,
  };
}

/**
 * 本地重排的可旋钮集合：只列出**这次响应里真的有字段**的旋钮。
 * 服务没返回流行度，流行度旋钮就不出现——不做没有依据的旋钮。
 */
export interface AvailableKnobs {
  readonly affinity: boolean;
  readonly popularity: boolean;
  readonly tagSimilarity: boolean;
}

/**
 * 旋钮只列出**这次响应里真的有字段**的旋钮。
 * 服务没返回流行度，流行度旋钮就不出现——不做没有依据的旋钮。
 */
export function availableKnobs(
  candidates: readonly ServiceCandidate[],
  seedTags: readonly ServiceTag[] = [],
): AvailableKnobs {
  const seedIds = new Set(seedTags.map((tag) => tag.id));
  return {
    affinity: candidates.some((item) => item.affinity !== null),
    popularity: candidates.some((item) => item.popularity !== null),
    // 标签相似度要两边都有标签才算得出来：种子有、候选也有。
    tagSimilarity:
      seedIds.size > 0 && candidates.some((item) => item.tags.length > 0),
  };
}

/** 标签相似度：候选与种子共有的标签占并集的比例，0–1。 */
export function tagSimilarity(
  candidate: ServiceCandidate,
  seedTags: readonly ServiceTag[],
): number {
  const seedIds = new Set(seedTags.map((tag) => tag.id));
  if (seedIds.size === 0 || candidate.tags.length === 0) return 0;
  const candidateIds = new Set(candidate.tags.map((tag) => tag.id));
  let shared = 0;
  for (const id of candidateIds) {
    if (seedIds.has(id)) shared += 1;
  }
  const union = seedIds.size + candidateIds.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface RankedServiceCandidate {
  readonly candidate: ServiceCandidate;
  readonly rank: number;
  /** 服务给出的名次。 */
  readonly serviceRank: number | null;
  /** 本地启发式排序分，只由服务真实返回的字段算出。 */
  readonly score: number;
  readonly baselineScore: number;
  readonly baselineRank: number;
  readonly deltaRank: number;
  readonly affinityContribution: number;
  readonly popularityContribution: number;
  /**
   * **未加权**的标签相似度（0–1），算不出来就是 null。
   *
   * 这是本地按种子与候选共有的标签算出来的，不是服务给的分数；
   * 但它必须能被看见——否则默认权重为 0 时贡献就是 0.00，
   * 界面看上去会变成"These two films share no tags at all"，那是假话。
   */
  readonly tagSimilarityRaw: number | null;
  readonly tagSimilarityContribution: number;
}

/**
 * 在**同一份冻结候选集**上做确定性重排。
 *
 * 分数 = 关联权重/100 × 关联分
 *      + 流行度权重/100 × 流行度百分位
 *      + 标签相似度权重/100 × 标签相似度
 * 三项都只用服务真实返回的字段；缺的那项按 0 计入。
 * 基线是服务自己的顺序（纯关联分），因此名次变化只反映旋钮，不反映候选集变化。
 */
export function rankServiceCandidates(
  candidates: readonly ServiceCandidate[],
  controls: ServiceControls,
  seedTags: readonly ServiceTag[] = [],
): readonly RankedServiceCandidate[] {
  const knobs = availableKnobs(candidates, seedTags);
  const scoreOf = (item: ServiceCandidate, control: ServiceControls): number => {
    const affinity = item.affinity ?? 0;
    const popularity = knobs.popularity ? (item.popularity ?? 0) : 0;
    const similarity = knobs.tagSimilarity ? tagSimilarity(item, seedTags) : 0;
    return (
      (control.affinityWeight / 100) * affinity +
      (control.popularityWeight / 100) * popularity +
      (control.tagSimilarityWeight / 100) * similarity
    );
  };

  // 没有关联分可依时（这次响应没带这个字段），分数全是 0，退化成按 ID 排会把
  // "The original order from the service"这句话变成假话。这种情况下以服务自己的名次为准。
  const hasAffinity = candidates.some((item) => item.affinity !== null);
  const compare = (
    left: ServiceCandidate,
    right: ServiceCandidate,
    control: ServiceControls,
  ): number => {
    const diff = scoreOf(right, control) - scoreOf(left, control);
    if (diff !== 0) return diff;
    if (!hasAffinity) {
      const leftRank = left.serviceRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.serviceRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  };

  const baselineScores = new Map<string, number>();
  const baselineOrder = [...candidates].sort((left, right) =>
    compare(left, right, DEFAULT_SERVICE_CONTROLS),
  );
  const baselineRanks = new Map<string, number>();
  baselineOrder.forEach((item, index) => {
    baselineRanks.set(item.id, index + 1);
    baselineScores.set(item.id, scoreOf(item, DEFAULT_SERVICE_CONTROLS));
  });

  const order = [...candidates].sort((left, right) => compare(left, right, controls));

  return order.map((item, index) => {
    const rank = index + 1;
    const baselineRank = baselineRanks.get(item.id) ?? rank;
    const score = scoreOf(item, controls);
    const baselineScore = baselineScores.get(item.id) ?? score;
    const affinityContribution =
      (controls.affinityWeight / 100) * (item.affinity ?? 0);
    const popularityContribution = knobs.popularity
      ? (controls.popularityWeight / 100) * (item.popularity ?? 0)
      : 0;
    const tagSimilarityContribution = knobs.tagSimilarity
      ? (controls.tagSimilarityWeight / 100) * tagSimilarity(item, seedTags)
      : 0;
    return Object.freeze({
      candidate: item,
      rank,
      serviceRank: item.serviceRank,
      score,
      baselineScore,
      baselineRank,
      deltaRank: baselineRank - rank,
      affinityContribution,
      popularityContribution,
      // 未加权的那个数：算不出来就说算不出来，不拿 0 冒充。
      tagSimilarityRaw: knobs.tagSimilarity ? tagSimilarity(item, seedTags) : null,
      tagSimilarityContribution,
    });
  });
}

