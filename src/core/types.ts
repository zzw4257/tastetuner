export interface Controls {
  /** 关系关联权重：把合成关联值放大到 0–100 分，默认 80。 */
  readonly relationWeight: number;
  /** 标签差异权重：0–100，决定差异奖励的实际生效比例，默认 0。 */
  readonly tagDifference: number;
}

export interface Settings {
  readonly controls: Controls;
  /** 硬约束：至少与种子共享 N 个标签；0 表示不筛选候选。 */
  readonly minSharedTags: number;
}

export interface Seed {
  readonly id: string;
  readonly title: string;
  readonly tagIds: readonly string[];
}

export interface Movie {
  readonly id: string;
  readonly title: string;
  readonly relation: {
    readonly seedId: string;
    readonly score: number;
  } | null;
  readonly tagIds: readonly string[] | null;
}

export interface SyntheticDataset {
  readonly source: 'synthetic';
  readonly version: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly seed: Seed;
  readonly movies: readonly Movie[];
}

export interface EligibleMovie {
  readonly id: string;
  readonly title: string;
  readonly relation: {
    readonly seedId: string;
    readonly score: number;
  };
  readonly tagIds: readonly string[];
}

export interface FrozenDataset {
  readonly source: 'synthetic';
  readonly version: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly seed: Seed;
  readonly movies: readonly EligibleMovie[];
}

export interface Exclusion {
  readonly id: string;
  readonly title: string;
  readonly reasons: readonly string[];
}

export type FreezeResult =
  | {
      readonly ok: true;
      readonly dataset: FrozenDataset;
      readonly excluded: readonly Exclusion[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    };

export type ControlResult =
  | {
      readonly ok: true;
      readonly controls: Controls;
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    };

export type SettingsResult =
  | {
      readonly ok: true;
      readonly settings: Settings;
    }
  | {
      readonly ok: false;
      readonly issues: readonly string[];
    };

export interface RankedMovie {
  readonly id: string;
  readonly title: string;
  readonly rank: number;
  readonly baselineRank: number;
  readonly score: number;
  readonly baselineScore: number;
  readonly deltaRank: number;
  readonly baseContribution: number;
  readonly differenceContribution: number;
  /** 基线权重下的关联基础分；与当前权重无关，解释表直接用它，不另算一遍。 */
  readonly baselineBaseContribution: number;
  /** 基线权重下的标签差异奖励。 */
  readonly baselineDifferenceContribution: number;
  readonly relation: number;
  readonly distance: number;
  readonly sharedCount: number;
  readonly sharedTags: readonly string[];
  readonly seedOnlyTags: readonly string[];
  readonly movieOnlyTags: readonly string[];
  readonly tagLabels: readonly string[];
}

/** 被硬约束挡在候选集之外的影片，附带可读的挡下原因。 */
export interface DroppedMovie {
  readonly id: string;
  readonly title: string;
  readonly sharedCount: number;
  readonly reason: string;
}

export interface RankedList {
  /** 当前权重下的排序结果。 */
  readonly rows: readonly RankedMovie[];
  /** 同一候选集、默认权重下的基线排序结果。 */
  readonly baselineRows: readonly RankedMovie[];
  /** 被最小共享标签数挡下的影片。 */
  readonly dropped: readonly DroppedMovie[];
}
