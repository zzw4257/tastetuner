import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCENARIO_FILE_BYTES,
  SCENARIO_FILE_FORMAT,
  SCENARIO_FILE_VERSION,
  parseScenarioFile,
  serializeScenarioFile,
} from '../dist/assets/core/scenario-io.js';
import * as syntheticFixture from '../dist/assets/adapters/synthetic.js';
import { DEFAULT_SETTINGS } from '../dist/assets/core/validation.js';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const fixtureDataset = Object.values(syntheticFixture).find((value) => {
  if (!isObject(value)) return false;
  return (
    value.source === 'synthetic' &&
    Array.isArray(value.movies) &&
    isObject(value.seed) &&
    isObject(value.tags)
  );
});
assert.ok(fixtureDataset, 'synthetic fixture must export the documented dataset');

function cloneFixture() {
  return structuredClone(fixtureDataset);
}

function eligibleMovie(dataset) {
  return dataset.movies.find(
    (movie) =>
      movie.relation !== null &&
      movie.relation !== undefined &&
      Array.isArray(movie.tagIds) &&
      movie.tagIds.length > 0,
  );
}

function scenarioEnvelope(dataset, settings = DEFAULT_SETTINGS) {
  return {
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset,
    settings,
  };
}

function canonicalDataset(dataset) {
  return {
    source: dataset.source,
    version: dataset.version,
    tags: Object.fromEntries(Object.entries(dataset.tags)),
    seed: {
      id: dataset.seed.id,
      title: dataset.seed.title,
      tagIds: [...dataset.seed.tagIds],
    },
    movies: dataset.movies.map((movie) => ({
      id: movie.id,
      title: movie.title,
      relation:
        movie.relation === null || movie.relation === undefined
          ? null
          : {
              seedId: movie.relation.seedId,
              score: movie.relation.score,
            },
      tagIds:
        movie.tagIds === null || movie.tagIds === undefined
          ? null
          : Array.isArray(movie.tagIds)
            ? [...movie.tagIds]
            : movie.tagIds,
    })),
  };
}

function canonicalEnvelope(dataset, settings = DEFAULT_SETTINGS) {
  return {
    format: SCENARIO_FILE_FORMAT,
    version: SCENARIO_FILE_VERSION,
    dataset: canonicalDataset(dataset),
    settings: {
      controls: {
        relationWeight: settings.controls.relationWeight,
        tagDifference: settings.controls.tagDifference,
      },
      minSharedTags: settings.minSharedTags,
    },
  };
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

test('an otherwise valid payload with the wrong format is rejected', () => {
  const validPayload = scenarioEnvelope(cloneFixture());
  assert.equal(parseScenarioFile(JSON.stringify(validPayload)).ok, true);

  const parsed = parseScenarioFile(
    JSON.stringify({ ...validPayload, format: 'wrong-format' }),
  );
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues.some((issue) => issue.includes('format')));
});

test('an otherwise valid payload with an unknown version is rejected', () => {
  const validPayload = scenarioEnvelope(cloneFixture());
  assert.equal(parseScenarioFile(JSON.stringify(validPayload)).ok, true);

  const parsed = parseScenarioFile(
    JSON.stringify({ ...validPayload, version: 999 }),
  );
  assert.equal(parsed.ok, false);
  assert.ok(parsed.issues.some((issue) => issue.includes('version')));
});

test('unknown nested fields are dropped on import and export', () => {
  const dataset = cloneFixture();
  const movie = eligibleMovie(dataset);
  assert.ok(movie);
  const movieIndex = dataset.movies.indexOf(movie);

  dataset.__canary = 'synthetic dataset canary';
  dataset.seed.__canary = 'synthetic seed canary';
  dataset.movies[movieIndex].__canary = 'synthetic movie canary';
  dataset.movies[movieIndex].relation.__canary = 'synthetic relation canary';

  const settings = {
    ...DEFAULT_SETTINGS,
    __canary: 'synthetic settings canary',
    controls: {
      ...DEFAULT_SETTINGS.controls,
      __canary: 'synthetic controls canary',
    },
  };

  const parsed = parseScenarioFile(
    JSON.stringify(scenarioEnvelope(dataset, settings)),
  );
  assert.equal(parsed.ok, true);
  assert.equal(Object.hasOwn(parsed.value.raw, '__canary'), false);
  assert.equal(Object.hasOwn(parsed.value.raw.seed, '__canary'), false);
  assert.equal(Object.hasOwn(parsed.value.raw.movies[movieIndex], '__canary'), false);
  assert.equal(
    Object.hasOwn(parsed.value.raw.movies[movieIndex].relation, '__canary'),
    false,
  );
  assert.equal(Object.hasOwn(parsed.value.settings, '__canary'), false);
  assert.equal(Object.hasOwn(parsed.value.settings.controls, '__canary'), false);

  const exported = serializeScenarioFile(parsed.value.raw, parsed.value.settings);
  assert.equal(exported.includes('__canary'), false);
});

test('excluded records retain null relations, null tags, and empty tag arrays', () => {
  const dataset = cloneFixture();
  const template = eligibleMovie(dataset);
  assert.ok(template);

  dataset.movies.push(
    {
      ...template,
      id: 'excluded-relation',
      title: 'Excluded relation',
      relation: null,
      tagIds: [...template.tagIds],
    },
    {
      ...template,
      id: 'excluded-null-tags',
      title: 'Excluded null tags',
      relation: { ...template.relation },
      tagIds: null,
    },
    {
      ...template,
      id: 'excluded-empty-tags',
      title: 'Excluded empty tags',
      relation: { ...template.relation },
      tagIds: [],
    },
  );

  const parsed = parseScenarioFile(
    JSON.stringify(scenarioEnvelope(dataset)),
  );
  assert.equal(parsed.ok, true);

  const excludedIds = parsed.value.excluded.map((item) => item.id);
  assert.ok(excludedIds.includes('excluded-relation'));
  assert.ok(excludedIds.includes('excluded-null-tags'));
  assert.ok(excludedIds.includes('excluded-empty-tags'));

  const rawMovies = new Map(
    parsed.value.raw.movies.map((movie) => [movie.id, movie]),
  );
  assert.equal(rawMovies.get('excluded-relation').relation, null);
  assert.equal(rawMovies.get('excluded-null-tags').tagIds, null);
  assert.deepEqual(rawMovies.get('excluded-empty-tags').tagIds, []);

  const exported = JSON.parse(
    serializeScenarioFile(parsed.value.raw, parsed.value.settings),
  );
  const exportedMovies = new Map(
    exported.dataset.movies.map((movie) => [movie.id, movie]),
  );
  assert.equal(exportedMovies.get('excluded-relation').relation, null);
  assert.equal(exportedMovies.get('excluded-null-tags').tagIds, null);
  assert.deepEqual(exportedMovies.get('excluded-empty-tags').tagIds, []);
});

test('a valid version 1 scenario round-trips without losing records or settings', () => {
  const dataset = cloneFixture();
  const text = serializeScenarioFile(dataset, DEFAULT_SETTINGS);
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, true);

  const expectedExcluded = dataset.movies
    .filter(
      (movie) =>
        movie.relation === null ||
        movie.relation === undefined ||
        movie.tagIds === null ||
        movie.tagIds === undefined ||
        (Array.isArray(movie.tagIds) && movie.tagIds.length === 0),
    )
    .map((movie) => movie.id);
  const expectedEligible = dataset.movies.filter(
    (movie) =>
      movie.relation !== null &&
      movie.relation !== undefined &&
      Array.isArray(movie.tagIds) &&
      movie.tagIds.length > 0,
  );

  assert.deepEqual(parsed.value.raw, dataset);
  assert.deepEqual(parsed.value.dataset.movies, expectedEligible);
  assert.deepEqual(
    parsed.value.excluded.map((item) => item.id),
    expectedExcluded,
  );
  assert.deepEqual(parsed.value.settings, DEFAULT_SETTINGS);

  const reparsed = parseScenarioFile(text);
  assert.equal(reparsed.ok, true);
  assert.deepEqual(reparsed.value.dataset, parsed.value.dataset);
  assert.deepEqual(reparsed.value.settings, parsed.value.settings);
});

test('the serializer rejects invalid settings', () => {
  assert.throws(
    () =>
      serializeScenarioFile(cloneFixture(), {
        ...DEFAULT_SETTINGS,
        minSharedTags: -1,
      }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /settings|minSharedTags/i);
      return true;
    },
  );
});

test('the serializer rejects an invalid dataset', () => {
  const dataset = cloneFixture();
  dataset.source = 'unsupported';

  assert.throws(
    () => serializeScenarioFile(dataset, DEFAULT_SETTINGS),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /dataset|source/i);
      return true;
    },
  );
});

test('compact serialization stays reimportable immediately below the byte limit', () => {
  const dataset = cloneFixture();
  const movie = eligibleMovie(dataset);
  assert.ok(movie);

  movie.title = '';
  const baseCompactBytes = utf8Bytes(
    JSON.stringify(canonicalEnvelope(dataset)),
  );
  assert.ok(baseCompactBytes < MAX_SCENARIO_FILE_BYTES);

  movie.title = 'x'.repeat(MAX_SCENARIO_FILE_BYTES - 1 - baseCompactBytes);
  const expectedCompact = canonicalEnvelope(dataset);
  assert.equal(
    utf8Bytes(JSON.stringify(expectedCompact)),
    MAX_SCENARIO_FILE_BYTES - 1,
  );
  assert.ok(
    utf8Bytes(JSON.stringify(expectedCompact, null, 2)) >
      MAX_SCENARIO_FILE_BYTES,
    'the pretty representation must not fit while compact JSON does',
  );

  const text = serializeScenarioFile(dataset, DEFAULT_SETTINGS);
  assert.equal(utf8Bytes(text), MAX_SCENARIO_FILE_BYTES - 1);
  const parsed = parseScenarioFile(text);
  assert.equal(parsed.ok, true);
});

test('the serializer throws RangeError when compact output exceeds the byte limit', () => {
  const dataset = cloneFixture();
  const movie = eligibleMovie(dataset);
  assert.ok(movie);
  movie.title = 'x'.repeat(MAX_SCENARIO_FILE_BYTES + 1024);

  assert.throws(
    () => serializeScenarioFile(dataset, DEFAULT_SETTINGS),
    (error) =>
      error instanceof RangeError && /too large/.test(error.message),
  );
});
