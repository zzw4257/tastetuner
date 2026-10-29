import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticDataset } from '../dist/assets/adapters/synthetic.js';
import { DEFAULT_SETTINGS } from '../dist/assets/core/validation.js';
import { parseScenarioFile, serializeScenarioFile } from '../dist/assets/core/scenario-io.js';

function exportedPayload() {
  return JSON.parse(serializeScenarioFile(syntheticDataset, DEFAULT_SETTINGS));
}

for (const field of ['relation', 'tagIds']) {
  test(`parseScenarioFile rejects an omitted movie ${field}`, () => {
    const payload = exportedPayload();
    delete payload.dataset.movies[0][field];

    const result = parseScenarioFile(JSON.stringify(payload));

    assert.equal(result.ok, false);
  });

  test(`serializeScenarioFile rejects undefined movie ${field}`, () => {
    const dataset = {
      ...syntheticDataset,
      movies: syntheticDataset.movies.map((movie, index) =>
        index === 0 ? { ...movie, [field]: undefined } : movie,
      ),
    };

    assert.throws(() => serializeScenarioFile(dataset, DEFAULT_SETTINGS));
  });
}

test('parseScenarioFile preserves explicit null relation and tagIds', () => {
  const payload = exportedPayload();
  payload.dataset.movies[0].relation = null;
  payload.dataset.movies[0].tagIds = null;

  const result = parseScenarioFile(JSON.stringify(payload));

  assert.equal(result.ok, true);
  assert.equal(result.value.raw.movies[0].relation, null);
  assert.equal(result.value.raw.movies[0].tagIds, null);
});

test('parseScenarioFile preserves empty tag arrays', () => {
  const payload = exportedPayload();
  payload.dataset.movies[0].tagIds = [];

  const result = parseScenarioFile(JSON.stringify(payload));

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.raw.movies[0].tagIds, []);
});
