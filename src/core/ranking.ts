import type {
  Controls,
  DroppedMovie,
  FrozenDataset,
  RankedList,
  RankedMovie,
  Settings,
} from './types.js';
import { DEFAULT_CONTROLS, validateSettings } from './validation.js';
export {
  DEFAULT_CONTROLS,
  DEFAULT_SETTINGS,
  freezeDataset,
  validateControls,
  validateSettings,
} from './validation.js';

type FrozenMovie = FrozenDataset['movies'][number];

interface MovieFacts {
  readonly relation: number;
  readonly distance: number;
  readonly sharedCount: number;
  readonly sharedTags: readonly string[];
  readonly seedOnlyTags: readonly string[];
  readonly movieOnlyTags: readonly string[];
  readonly tagLabels: readonly string[];
}

interface Contributions {
  readonly base: number;
  readonly difference: number;
  readonly score: number;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareScores(left: number, right: number): number {
  if (left > right) return -1;
  if (left < right) return 1;
  return 0;
}

function getTagLabel(
  labels: Readonly<Record<string, string>>,
  tagId: string,
): string {
  const label = labels[tagId];
  if (label === undefined) {
    throw new Error(`Missing label for tag ${tagId}`);
  }
  return label;
}

/** 与控制项无关的结构事实：关系值、标签差异和可读标签。 */
function analyzeMovie(
  movie: FrozenMovie,
  seedTagIds: readonly string[],
  seedTagSet: ReadonlySet<string>,
  labels: Readonly<Record<string, string>>,
): MovieFacts {
  const movieTagIds = Object.freeze([...new Set(movie.tagIds)]);
  const movieTagSet = new Set(movieTagIds);

  let intersectionCount = 0;
  for (const tagId of seedTagIds) {
    if (movieTagSet.has(tagId)) intersectionCount += 1;
  }

  const unionCount = seedTagSet.size + movieTagSet.size - intersectionCount;
  const distance = unionCount === 0 ? 0 : 1 - intersectionCount / unionCount;

  const sharedTags = Object.freeze(
    seedTagIds.filter((tagId) => movieTagSet.has(tagId)).map((tagId) => getTagLabel(labels, tagId)),
  );
  const seedOnlyTags = Object.freeze(
    seedTagIds.filter((tagId) => !movieTagSet.has(tagId)).map((tagId) => getTagLabel(labels, tagId)),
  );
  const movieOnlyTags = Object.freeze(
    movieTagIds.filter((tagId) => !seedTagSet.has(tagId)).map((tagId) => getTagLabel(labels, tagId)),
  );
  const tagLabels = Object.freeze(movieTagIds.map((tagId) => getTagLabel(labels, tagId)));

  return {
    relation: movie.relation.score,
    distance,
    sharedCount: intersectionCount,
    sharedTags,
    seedOnlyTags,
    movieOnlyTags,
    tagLabels,
  };
}

/**
 * 启发式排序分：关联基础分 = 关系权重 × 合成关联值；
 * 标签差异奖励 = 20 × (差异权重 / 100) × 标签差异，差异奖励上限 20 分。
 */
function contributions(facts: MovieFacts, controls: Controls): Contributions {
  const base = controls.relationWeight * facts.relation;
  const difference = 20 * (controls.tagDifference / 100) * facts.distance;
  return { base, difference, score: base + difference };
}

interface ScoredEntry {
  readonly movie: FrozenMovie;
  readonly facts: MovieFacts;
  readonly contributions: Contributions;
}

function toRow(
  entry: ScoredEntry,
  rank: number,
  baselineRank: number,
  baseline: Contributions,
): RankedMovie {
  return Object.freeze({
    id: entry.movie.id,
    title: entry.movie.title,
    rank,
    baselineRank,
    score: entry.contributions.score,
    baselineScore: baseline.score,
    deltaRank: baselineRank - rank,
    baseContribution: entry.contributions.base,
    differenceContribution: entry.contributions.difference,
    baselineBaseContribution: baseline.base,
    baselineDifferenceContribution: baseline.difference,
    relation: entry.facts.relation,
    distance: entry.facts.distance,
    sharedCount: entry.facts.sharedCount,
    sharedTags: entry.facts.sharedTags,
    seedOnlyTags: entry.facts.seedOnlyTags,
    movieOnlyTags: entry.facts.movieOnlyTags,
    tagLabels: entry.facts.tagLabels,
  });
}

export function rankDataset(dataset: FrozenDataset, settings: Settings): RankedList {
  const maxSharedTags = new Set(dataset.seed.tagIds).size;
  const validation = validateSettings(settings, maxSharedTags);
  if (!validation.ok) {
    throw new RangeError(`Invalid settings: ${validation.issues.join('; ')}`);
  }

  const { controls, minSharedTags } = validation.settings;
  const seedTagIds = [...new Set(dataset.seed.tagIds)];
  const seedTagSet = new Set(seedTagIds);

  const factsById = new Map<string, MovieFacts>();
  const cohort: ScoredEntry[] = [];
  const dropped: DroppedMovie[] = [];

  for (const movie of dataset.movies) {
    const facts = analyzeMovie(movie, seedTagIds, seedTagSet, dataset.tags);
    factsById.set(movie.id, facts);

    if (facts.sharedCount < minSharedTags) {
      dropped.push(
        Object.freeze({
          id: movie.id,
          title: movie.title,
          sharedCount: facts.sharedCount,
          reason: `Shares ${facts.sharedCount} tags with the seed, below the required ${minSharedTags}`,
        }),
      );
      continue;
    }

    cohort.push(
      Object.freeze({
        movie,
        facts,
        contributions: contributions(facts, controls),
      }),
    );
  }

  // 基线与当前使用同一候选集，只是权重不同，因此名次差可以在集合内直接归因。
  const baselineEntries = cohort.map((entry) =>
    Object.freeze({
      movie: entry.movie,
      facts: entry.facts,
      contributions: contributions(entry.facts, DEFAULT_CONTROLS),
    }),
  );

  const baselineOrder = [...baselineEntries].sort(
    (left, right) =>
      compareScores(left.contributions.score, right.contributions.score) ||
      compareIds(left.movie.id, right.movie.id),
  );
  const baselineContributions = new Map<string, Contributions>();
  const baselineRanks = new Map<string, number>();
  baselineOrder.forEach((entry, index) => {
    baselineContributions.set(entry.movie.id, entry.contributions);
    baselineRanks.set(entry.movie.id, index + 1);
  });

  const currentOrder = [...cohort].sort(
    (left, right) =>
      compareScores(left.contributions.score, right.contributions.score) ||
      compareIds(left.movie.id, right.movie.id),
  );

  const rows = currentOrder.map((entry, index) => {
    const baselineRank = baselineRanks.get(entry.movie.id);
    const baseline = baselineContributions.get(entry.movie.id);
    if (baselineRank === undefined || baseline === undefined) {
      throw new Error(`Missing baseline data for movie ${entry.movie.id}`);
    }
    return toRow(entry, index + 1, baselineRank, baseline);
  });

  const baselineRows = baselineOrder.map((entry, index) => {
    const rank = index + 1;
    return toRow(entry, rank, rank, entry.contributions);
  });

  return Object.freeze({
    rows: Object.freeze(rows),
    baselineRows: Object.freeze(baselineRows),
    dropped: Object.freeze(dropped),
  });
}
