// Scenario library acceptance checks: every scenario must be labelled, valid and deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeDataset, rankDataset, DEFAULT_CONTROLS } from '../dist/assets/core/ranking.js';
import { scenarios, defaultScenarioId, findScenario } from '../dist/assets/adapters/scenarios.js';

const settings = (controls = {}, minSharedTags = 0) => ({
  controls: { ...DEFAULT_CONTROLS, ...controls },
  minSharedTags,
});

test('scenario library is labelled, unique and complete', () => {
  assert.ok(scenarios.length >= 5);
  const ids = scenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');
  for (const scenario of scenarios) {
    assert.ok(scenario.label.trim().length > 0);
    assert.ok(scenario.summary.trim().length > 0);
    assert.ok(scenario.highlights.length > 0);
    assert.equal(scenario.dataset.source, 'synthetic');
    assert.ok(scenario.dataset.version.includes('synthetic'));
  }
  assert.ok(findScenario(defaultScenarioId) !== undefined);
  assert.equal(findScenario('does-not-exist'), undefined);
});

test('every scenario freezes cleanly and ranks deterministically', () => {
  for (const scenario of scenarios) {
    const frozen = freezeDataset(scenario.dataset);
    assert.equal(frozen.ok, true, `${scenario.id}: ${JSON.stringify(frozen)}`);
    assert.ok(frozen.dataset.movies.every((movie) => movie.relation.seedId === frozen.dataset.seed.id));

    for (const tagDifference of [0, 100]) {
      const first = rankDataset(frozen.dataset, settings({ tagDifference }));
      const second = rankDataset(frozen.dataset, settings({ tagDifference }));
      assert.deepEqual(first, second, `${scenario.id} must be deterministic`);
      assert.equal(first.rows.length, first.baselineRows.length);
    }
  }
});

test('the edge-case scenario really contains ties, a zero score and excluded rows', () => {
  const scenario = findScenario('edge-cases');
  assert.ok(scenario !== undefined);
  const frozen = freezeDataset(scenario.dataset);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.excluded.length, 3, 'three films must be excluded for missing data');
  assert.ok(frozen.excluded.every((row) => row.reasons.length > 0));

  const ranked = rankDataset(frozen.dataset, settings({ tagDifference: 100 }));
  const tieA = ranked.rows.find((row) => row.id === 'edge-tie-a');
  const tieB = ranked.rows.find((row) => row.id === 'edge-tie-b');
  assert.ok(tieA !== undefined && tieB !== undefined);
  assert.equal(tieA.score, tieB.score, 'the two tie films must share a score');
  assert.ok(tieA.rank < tieB.rank, 'equal scores must fall back to ASCII id order');

  const zero = ranked.rows.find((row) => row.id === 'edge-zero');
  assert.ok(zero !== undefined);
  assert.equal(zero.relation, 0);
  assert.equal(zero.score, 0);
});

test('the no-signal scenario is an empty state, not an error and not a stale list', () => {
  const scenario = findScenario('no-signals');
  assert.ok(scenario !== undefined);
  const frozen = freezeDataset(scenario.dataset);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.dataset.movies.length, 0);
  assert.equal(frozen.excluded.length, 3);

  const ranked = rankDataset(frozen.dataset, settings());
  assert.equal(ranked.rows.length, 0);
  assert.equal(ranked.baselineRows.length, 0);
});

test('the large cohort is deterministic across module instances', async () => {
  const again = await import('../dist/assets/adapters/scenarios.js?reload=1');
  const first = scenarios.find((scenario) => scenario.id === 'large-cohort');
  const second = again.scenarios.find((scenario) => scenario.id === 'large-cohort');
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.dataset.movies.length, 240);
  assert.equal(second.dataset.movies.length, 240);
  assert.equal(JSON.stringify(first.dataset), JSON.stringify(second.dataset));

  const frozen = freezeDataset(first.dataset);
  assert.equal(frozen.ok, true);
  assert.equal(frozen.excluded.length, 0);
  const ranked = rankDataset(frozen.dataset, settings({ tagDifference: 47 }));
  assert.equal(ranked.rows.length, 240);
  assert.equal(new Set(ranked.rows.map((row) => row.id)).size, 240);
});
