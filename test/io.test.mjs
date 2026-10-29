// Local import/export acceptance checks: structure, size and source are validated before use.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCENARIO_FILE_BYTES,
  SCENARIO_FILE_FORMAT,
  SCENARIO_FILE_VERSION,
  parseScenarioFile,
  serializeScenarioFile,
} from '../dist/assets/core/scenario-io.js';
import { scenarios } from '../dist/assets/adapters/scenarios.js';
import { DEFAULT_CONTROLS } from '../dist/assets/core/ranking.js';

const scenario = scenarios[0];
const settings = {
  controls: { relationWeight: 60, tagDifference: 40 },
  minSharedTags: 1,
};

test('a scenario file round-trips through export and import', () => {
  const text = serializeScenarioFile(scenario.dataset, settings);
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.dataset.movies.length, scenario.dataset.movies.length);
  assert.deepEqual(parsed.value.settings, settings);
  assert.deepEqual(
    parsed.value.dataset.movies.map((movie) => movie.id),
    scenario.dataset.movies.map((movie) => movie.id),
  );
  assert.equal(JSON.parse(text).format, SCENARIO_FILE_FORMAT);
  assert.equal(JSON.parse(text).version, SCENARIO_FILE_VERSION);
});

test('exported files carry only the documented, non-secret fields', () => {
  const text = serializeScenarioFile(scenario.dataset, settings);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ['dataset', 'format', 'settings', 'version']);
  assert.deepEqual(Object.keys(parsed.settings).sort(), ['controls', 'minSharedTags']);
  assert.deepEqual(Object.keys(parsed.dataset).sort(), ['movies', 'seed', 'source', 'tags', 'version']);
  assert.ok(!/api[-_]?key|secret|token|password/i.test(text), 'no credential-shaped field may appear');
});

test('importing the same file twice produces the same state', () => {
  const text = serializeScenarioFile(scenario.dataset, settings);
  const first = parseScenarioFile(text);
  const second = parseScenarioFile(text);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.value.dataset, second.value.dataset);
  assert.deepEqual(first.value.settings, second.value.settings);
});

test('malformed files are rejected with readable issues instead of partial loads', () => {
  const cases = [
    ['not json', '{oops'],
    ['empty file', ''],
    ['array root', '[]'],
    ['null root', 'null'],
    ['wrong format', JSON.stringify({ format: 'other', version: 1, dataset: {}, settings: {} })],
    ['wrong version', JSON.stringify({ format: SCENARIO_FILE_FORMAT, version: 99, dataset: {}, settings: {} })],
  ];
  for (const [name, text] of cases) {
    const parsed = parseScenarioFile(text);
    assert.equal(parsed.ok, false, `${name} must be rejected`);
    assert.ok(parsed.issues.length > 0, `${name} must explain why`);
  }
});

test('a file whose dataset is invalid is rejected as a whole', () => {
  const broken = structuredClone(scenario.dataset);
  broken.movies[0].tagIds = ['unknown-tag'];
  broken.movies[1].id = '../escape';
  broken.movies[2].relation.score = 4;
  const text = JSON.stringify({
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset: broken,
    settings: { controls: DEFAULT_CONTROLS, minSharedTags: 0 },
  });
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues.length >= 3, `expected one issue per broken field: ${parsed.issues}`);
  assert.ok(parsed.issues.some((issue) => issue.includes('tagIds')));
  assert.ok(parsed.issues.some((issue) => issue.includes('score')));
});

test('a non-synthetic source is refused', () => {
  const foreign = structuredClone(scenario.dataset);
  foreign.source = 'qloo';
  const text = JSON.stringify({
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset: foreign,
    settings: { controls: DEFAULT_CONTROLS, minSharedTags: 0 },
  });
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues.some((issue) => issue.includes('source')));
});

test('settings outside the seed vocabulary are refused', () => {
  const text = JSON.stringify({
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset: scenario.dataset,
    settings: { controls: DEFAULT_CONTROLS, minSharedTags: 99 },
  });
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues.some((issue) => issue.includes('minSharedTags')));
});

test('oversized files are refused before parsing', () => {
  const parsed = parseScenarioFile('x'.repeat(MAX_SCENARIO_FILE_BYTES + 1));
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues[0].includes('too large'));
});

test('the size limit counts UTF-8 bytes, not characters', () => {
  // 二十万中文字符不到字符上限，但 UTF-8 编码后超过字节上限，必须被拒。
  const cjk = '场'.repeat(200_000);
  assert.ok(cjk.length < MAX_SCENARIO_FILE_BYTES);
  assert.ok(new TextEncoder().encode(cjk).length > MAX_SCENARIO_FILE_BYTES);
  const parsed = parseScenarioFile(cjk);
  assert.equal(parsed.ok, false);
  assert.match(parsed.issues[0], /too large \(\d+ bytes\)/);
});
