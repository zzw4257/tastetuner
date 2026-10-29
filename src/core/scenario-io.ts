import type {
  Exclusion,
  FrozenDataset,
  Settings,
  SyntheticDataset,
} from './types.js';
import { freezeDataset, validateSettings } from './validation.js';

export const SCENARIO_FILE_FORMAT = 'taste-tuner/scenario';
export const SCENARIO_FILE_VERSION = 1;
export const MAX_SCENARIO_FILE_BYTES = 512 * 1024;

export interface ParsedScenario {
  /** 校验并冻结后的候选集合。 */
  readonly dataset: FrozenDataset;
  /** 原始数据，保留被排除的影片以便再次导出时不丢失语义。 */
  readonly raw: SyntheticDataset;
  readonly excluded: readonly Exclusion[];
  readonly settings: Settings;
}

export type ParseScenarioResult =
  | { readonly ok: true; readonly value: ParsedScenario }
  | { readonly ok: false; readonly issues: readonly string[] };

type UnknownRecord = Record<string, unknown>;

interface ValidatedScenarioData {
  readonly dataset: FrozenDataset;
  readonly raw: SyntheticDataset;
  readonly excluded: readonly Exclusion[];
  readonly settings: Settings;
}

type ScenarioDataResult =
  | { readonly ok: true; readonly value: ValidatedScenarioData }
  | { readonly ok: false; readonly issues: readonly string[] };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function copyArray(input: unknown): unknown {
  return Array.isArray(input) ? Array.from(input) : input;
}

/** 标签字典的键是数据定义的标签 ID；仅复制自有可枚举键。 */
function copyDictionary(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const output: UnknownRecord = {};
  for (const key of Object.keys(input)) {
    Object.defineProperty(output, key, {
      value: own(input, key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

function canonicalizeRelation(input: unknown): unknown {
  if (!isRecord(input)) return input;

  return {
    seedId: own(input, 'seedId'),
    score: own(input, 'score'),
  };
}

function canonicalizeMovie(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const tagIds = own(input, 'tagIds');
  return {
    id: own(input, 'id'),
    title: own(input, 'title'),
    relation: canonicalizeRelation(own(input, 'relation')),
    tagIds: copyArray(tagIds),
  };
}

function canonicalizeMovies(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return Array.from(input, (movie) => canonicalizeMovie(movie));
}

function canonicalizeSeed(input: unknown): unknown {
  if (!isRecord(input)) return input;

  return {
    id: own(input, 'id'),
    title: own(input, 'title'),
    tagIds: copyArray(own(input, 'tagIds')),
  };
}

function canonicalizeDataset(input: unknown): unknown {
  if (!isRecord(input)) return input;

  return {
    source: own(input, 'source'),
    version: own(input, 'version'),
    tags: copyDictionary(own(input, 'tags')),
    seed: canonicalizeSeed(own(input, 'seed')),
    movies: canonicalizeMovies(own(input, 'movies')),
  };
}

function canonicalizeControls(input: unknown): unknown {
  if (!isRecord(input)) return input;

  return {
    relationWeight: own(input, 'relationWeight'),
    tagDifference: own(input, 'tagDifference'),
  };
}

function canonicalizeSettings(input: unknown): unknown {
  if (!isRecord(input)) return input;

  return {
    controls: canonicalizeControls(own(input, 'controls')),
    minSharedTags: own(input, 'minSharedTags'),
  };
}

function validateScenarioData(
  datasetInput: unknown,
  settingsInput: unknown,
): ScenarioDataResult {
  const rawDataset = canonicalizeDataset(datasetInput);
  const frozen = freezeDataset(rawDataset);
  if (!frozen.ok) {
    return { ok: false, issues: frozen.issues };
  }

  const seedTagCount = new Set(frozen.dataset.seed.tagIds).size;
  const rawSettings = canonicalizeSettings(settingsInput);
  const settings = validateSettings(rawSettings, seedTagCount);
  if (!settings.ok) {
    return { ok: false, issues: settings.issues };
  }

  return {
    ok: true,
    value: {
      dataset: frozen.dataset,
      raw: rawDataset as SyntheticDataset,
      excluded: frozen.excluded,
      settings: settings.settings,
    },
  };
}

export function serializeScenarioFile(dataset: SyntheticDataset, settings: Settings): string {
  const validated = validateScenarioData(dataset, settings);
  if (!validated.ok) {
    throw new Error(`Invalid scenario data: ${validated.issues.join('; ')}`);
  }

  const payload = {
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset: validated.value.raw,
    settings: validated.value.settings,
  };
  const text = JSON.stringify(payload);
  const bytes = byteLength(text);

  if (bytes > MAX_SCENARIO_FILE_BYTES) {
    throw new RangeError(
      `Scenario file too large (${bytes} bytes); the limit is ${MAX_SCENARIO_FILE_BYTES} bytes`,
    );
  }

  return text;
}

/** UTF-8 字节数，不是 UTF-16 长度；中文文件按字符数算会低估三倍。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 解析本地场景文件：先看大小与格式，再走和运行时完全相同的数据校验，
 * 任何一步不过就整体拒绝，不做局部修补。
 */
export function parseScenarioFile(text: string): ParseScenarioResult {
  const bytes = byteLength(text);
  if (bytes > MAX_SCENARIO_FILE_BYTES) {
    return {
      ok: false,
      issues: [`File too large (${bytes} bytes); the limit is ${MAX_SCENARIO_FILE_BYTES} bytes`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`The file is not valid JSON: ${detail}`] };
  }

  if (!isRecord(parsed)) {
    return { ok: false, issues: ['The top level of the file must be an object'] };
  }

  const issues: string[] = [];
  if (own(parsed, 'format') !== SCENARIO_FILE_FORMAT) {
    issues.push(`format must be ${SCENARIO_FILE_FORMAT}`);
  }
  if (own(parsed, 'version') !== SCENARIO_FILE_VERSION) {
    issues.push(`version must be ${SCENARIO_FILE_VERSION}`);
  }

  const validated = validateScenarioData(
    own(parsed, 'dataset'),
    own(parsed, 'settings'),
  );
  if (!validated.ok) {
    issues.push(...validated.issues);
    return { ok: false, issues };
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      dataset: validated.value.dataset,
      raw: validated.value.raw,
      excluded: validated.value.excluded,
      settings: validated.value.settings,
    },
  };
}
