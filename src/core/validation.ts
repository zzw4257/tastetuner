import type {
  Controls,
  ControlResult,
  EligibleMovie,
  Exclusion,
  FreezeResult,
  FrozenDataset,
  Seed,
  Settings,
  SettingsResult,
} from './types.js';

export const DEFAULT_CONTROLS = Object.freeze({
  relationWeight: 80,
  tagDifference: 0,
}) satisfies Controls;

export const DEFAULT_SETTINGS = Object.freeze({
  controls: DEFAULT_CONTROLS,
  minSharedTags: 0,
}) satisfies Settings;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isReadableLabel(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function isWeight(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

function addIssue(issues: string[], path: string, message: string): void {
  issues.push(`${path}：${message}`);
}

function parseTags(input: unknown, path: string, issues: string[]): {
  readonly value: Readonly<Record<string, string>>;
  readonly valid: boolean;
} {
  if (!isPlainRecord(input)) {
    addIssue(issues, path, 'Must be a plain object');
    return { value: Object.freeze({}), valid: false };
  }

  const values: Record<string, string> = {};
  let valid = true;

  for (const id of Object.keys(input)) {
    if (!ID_PATTERN.test(id)) {
      addIssue(issues, `${path}.${id}`, 'Invalid tag id format');
      valid = false;
      continue;
    }

    const label = input[id];
    if (!isReadableLabel(label)) {
      addIssue(issues, `${path}.${id}`, 'A tag name must be a non-empty readable string');
      valid = false;
      continue;
    }

    Object.defineProperty(values, id, {
      value: label,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return { value: Object.freeze(values), valid };
}

function parseTagIds(
  input: readonly unknown[],
  path: string,
  knownTagIds: ReadonlySet<string>,
  issues: string[],
): { readonly value: readonly string[]; readonly valid: boolean } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let valid = true;

  Array.from(input).forEach((value, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof value !== 'string') {
      addIssue(issues, itemPath, 'The tag id must be a string');
      valid = false;
      return;
    }
    if (!ID_PATTERN.test(value)) {
      addIssue(issues, itemPath, 'Invalid tag id format');
      valid = false;
      return;
    }
    if (seen.has(value)) {
      addIssue(issues, itemPath, 'Duplicate tag id');
      valid = false;
      return;
    }
    seen.add(value);
    if (!knownTagIds.has(value)) {
      addIssue(issues, itemPath, 'References an unknown tag id');
      valid = false;
      return;
    }
    ids.push(value);
  });

  return { value: ids, valid };
}

function parseSeed(
  input: unknown,
  path: string,
  knownTagIds: ReadonlySet<string>,
  issues: string[],
): { readonly value: Seed; readonly valid: boolean } {
  if (!isRecord(input)) {
    addIssue(issues, path, 'Must be an object');
    return { value: { id: '', title: '', tagIds: [] }, valid: false };
  }

  const idValue = own(input, 'id');
  const titleValue = own(input, 'title');
  const tagIdsValue = own(input, 'tagIds');
  const id = typeof idValue === 'string' ? idValue : '';
  const title = typeof titleValue === 'string' ? titleValue : '';
  let valid = true;

  if (!ID_PATTERN.test(id)) {
    addIssue(issues, `${path}.id`, 'Invalid seed id format');
    valid = false;
  }
  if (!isNonEmptyString(titleValue)) {
    addIssue(issues, `${path}.title`, 'Must be a non-empty string');
    valid = false;
  }

  let tagIds: readonly string[] = [];
  if (!Array.isArray(tagIdsValue) || tagIdsValue.length === 0) {
    addIssue(issues, `${path}.tagIds`, 'Must be a non-empty array');
    valid = false;
  } else {
    const values: readonly unknown[] = tagIdsValue;
    const parsed = parseTagIds(values, `${path}.tagIds`, knownTagIds, issues);
    tagIds = parsed.value;
    valid = valid && parsed.valid;
  }

  return { value: { id, title, tagIds }, valid };
}

function parseRelation(
  input: unknown,
  path: string,
  seed: Seed,
  issues: string[],
): {
  readonly value: { readonly seedId: string; readonly score: number } | null;
  readonly valid: boolean;
  readonly missing: boolean;
} {
  if (input === null) return { value: null, valid: true, missing: true };
  if (!isRecord(input)) {
    addIssue(issues, path, 'Must be null or an object');
    return { value: null, valid: false, missing: false };
  }

  const seedIdValue = own(input, 'seedId');
  const scoreValue = own(input, 'score');
  const seedId = typeof seedIdValue === 'string' ? seedIdValue : '';
  const score =
    typeof scoreValue === 'number' && Number.isFinite(scoreValue) ? scoreValue : 0;
  let valid = true;

  if (typeof seedIdValue !== 'string') {
    addIssue(issues, `${path}.seedId`, 'Must be a string');
    valid = false;
  } else if (ID_PATTERN.test(seed.id) && seedIdValue !== seed.id) {
    addIssue(issues, `${path}.seedId`, 'Must match dataset.seed.id');
    valid = false;
  }
  if (
    typeof scoreValue !== 'number' ||
    !Number.isFinite(scoreValue) ||
    scoreValue < 0 ||
    scoreValue > 1
  ) {
    addIssue(issues, `${path}.score`, 'Must be a finite number between 0 and 1');
    valid = false;
  }

  return { value: { seedId, score }, valid, missing: false };
}

function parseMovieTags(
  input: unknown,
  path: string,
  knownTagIds: ReadonlySet<string>,
  issues: string[],
): {
  readonly value: readonly string[];
  readonly valid: boolean;
  readonly missing: boolean;
} {
  if (input === null) return { value: [], valid: true, missing: true };
  if (!Array.isArray(input)) {
    addIssue(issues, path, 'Must be null or an array');
    return { value: [], valid: false, missing: false };
  }
  if (input.length === 0) return { value: [], valid: true, missing: true };

  const values: readonly unknown[] = input;
  const parsed = parseTagIds(values, path, knownTagIds, issues);
  return { value: parsed.value, valid: parsed.valid, missing: false };
}

function parseMovies(
  input: unknown,
  knownTagIds: ReadonlySet<string>,
  seed: Seed,
  issues: string[],
): {
  readonly eligible: readonly EligibleMovie[];
  readonly excluded: readonly Exclusion[];
} {
  if (!Array.isArray(input)) {
    addIssue(issues, 'dataset.movies', 'Must be an array');
    return { eligible: [], excluded: [] };
  }

  const values: readonly unknown[] = input;
  const eligible: EligibleMovie[] = [];
  const excluded: Exclusion[] = [];
  const seenIds = new Set<string>();

  Array.from(values).forEach((item, index) => {
    const path = `dataset.movies[${index}]`;
    if (!isRecord(item)) {
      addIssue(issues, path, 'Must be an object');
      return;
    }

    const idValue = own(item, 'id');
    const titleValue = own(item, 'title');
    const id = typeof idValue === 'string' ? idValue : '';
    const title = typeof titleValue === 'string' ? titleValue : '';
    const idValid = ID_PATTERN.test(id);
    const titleValid = isNonEmptyString(titleValue);
    let duplicateId = false;

    if (!idValid) {
      addIssue(issues, `${path}.id`, 'Invalid film id format');
    } else if (seenIds.has(id)) {
      addIssue(issues, `${path}.id`, 'Duplicate film id');
      duplicateId = true;
    } else {
      seenIds.add(id);
    }
    if (!titleValid) addIssue(issues, `${path}.title`, 'Must be a non-empty string');

    const relation = parseRelation(own(item, 'relation'), `${path}.relation`, seed, issues);
    const tags = parseMovieTags(own(item, 'tagIds'), `${path}.tagIds`, knownTagIds, issues);
    const reasons: string[] = [];

    if (relation.missing) reasons.push('Missing seed relation');
    if (tags.missing) reasons.push('Missing tags');

    if (reasons.length > 0) {
      excluded.push(
        Object.freeze({
          id,
          title,
          reasons: Object.freeze(reasons),
        }),
      );
      return;
    }

    if (
      !relation.valid ||
      !tags.valid ||
      relation.value === null ||
      !idValid ||
      duplicateId ||
      !titleValid
    ) {
      return;
    }

    const frozenRelation = Object.freeze({
      seedId: relation.value.seedId,
      score: relation.value.score,
    });
    eligible.push(
      Object.freeze({
        id,
        title,
        relation: frozenRelation,
        tagIds: Object.freeze([...tags.value]),
      }),
    );
  });

  return {
    eligible: Object.freeze(eligible),
    excluded: Object.freeze(excluded),
  };
}

export function freezeDataset(input: unknown): FreezeResult {
  const issues: string[] = [];
  if (!isRecord(input)) {
    addIssue(issues, 'dataset', 'Must be an object');
    return { ok: false, issues };
  }

  const source = own(input, 'source');
  const versionValue = own(input, 'version');
  const version = typeof versionValue === 'string' ? versionValue : '';

  if (source !== 'synthetic') addIssue(issues, 'dataset.source', 'Must equal "synthetic"');
  if (!isNonEmptyString(versionValue)) {
    addIssue(issues, 'dataset.version', 'Must be a non-empty string');
  }

  const tags = parseTags(own(input, 'tags'), 'dataset.tags', issues);
  const knownTagIds = new Set(Object.keys(tags.value));
  const seed = parseSeed(own(input, 'seed'), 'dataset.seed', knownTagIds, issues);
  const movies = parseMovies(own(input, 'movies'), knownTagIds, seed.value, issues);

  if (issues.length > 0) return { ok: false, issues };

  const frozenSeed: Seed = Object.freeze({
    id: seed.value.id,
    title: seed.value.title,
    tagIds: Object.freeze([...seed.value.tagIds]),
  });
  const dataset: FrozenDataset = Object.freeze({
    source: 'synthetic',
    version,
    tags: tags.value,
    seed: frozenSeed,
    movies: movies.eligible,
  });

  return { ok: true, dataset, excluded: movies.excluded };
}

export function validateControls(input: unknown): ControlResult {
  const issues: string[] = [];
  if (!isRecord(input)) {
    addIssue(issues, 'controls', 'Must be an object');
    return { ok: false, issues };
  }

  const relationWeight = own(input, 'relationWeight');
  const tagDifference = own(input, 'tagDifference');

  if (!isWeight(relationWeight)) {
    addIssue(issues, 'controls.relationWeight', 'Must be a finite whole number between 0 and 100');
  }
  if (!isWeight(tagDifference)) {
    addIssue(issues, 'controls.tagDifference', 'Must be a finite whole number between 0 and 100');
  }
  if (issues.length > 0) return { ok: false, issues };

  const controls: Controls = Object.freeze({
    relationWeight: relationWeight as number,
    tagDifference: tagDifference as number,
  });
  return { ok: true, controls };
}

/**
 * 校验完整设置：两个权重加上最小共享标签数。
 * 最小共享标签数以上限为准，避免出现超过种子标签总数的筛选条件。
 */
export function validateSettings(input: unknown, maxSharedTags: number): SettingsResult {
  const issues: string[] = [];
  if (!isRecord(input)) {
    addIssue(issues, 'settings', 'Must be an object');
    return { ok: false, issues };
  }

  const controls = validateControls(own(input, 'controls'));
  if (!controls.ok) {
    return { ok: false, issues: controls.issues };
  }

  const minSharedTags = own(input, 'minSharedTags');
  if (
    typeof minSharedTags !== 'number' ||
    !Number.isFinite(minSharedTags) ||
    !Number.isInteger(minSharedTags) ||
    minSharedTags < 0 ||
    minSharedTags > maxSharedTags
  ) {
    addIssue(
      issues,
      'settings.minSharedTags',
      `Must be a finite whole number between 0 and ${maxSharedTags}`,
    );
    return { ok: false, issues };
  }

  const settings: Settings = Object.freeze({
    controls: controls.controls,
    minSharedTags,
  });
  return { ok: true, settings };
}
