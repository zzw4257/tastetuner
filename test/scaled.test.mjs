// Deterministic generated acceptance cases; these are test data, not recommendations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { freezeDataset, rankDataset, DEFAULT_CONTROLS } from '../dist/assets/core/ranking.js';
import { syntheticDataset } from '../dist/assets/adapters/synthetic.js';

const settings = (controls = {}, minSharedTags = 0) => ({
  controls: { ...DEFAULT_CONTROLS, ...controls },
  minSharedTags,
});

for (const size of [1, 12, 100, 1000, 10000]) {
  test(`generated cohort ${size}: deterministic, ordered, bounded and fixed baseline`, (context) => {
    const raw = structuredClone(syntheticDataset);
    const tagIds = Object.keys(raw.tags);
    raw.version = `acceptance-${size}`;
    raw.movies = Array.from({ length: size }, (_, i) => ({
      id: `case-${String(i).padStart(5, '0')}`,
      title: `合成验收影片 ${i}`,
      relation: { seedId: raw.seed.id, score: ((i * 37 + 7) % 101) / 100 },
      tagIds: Array.from(
        new Set(Array.from({ length: 1 + (i % 6) }, (_, j) => tagIds[(i * 3 + j * 5) % tagIds.length])),
      ),
    }));
    const started = performance.now();
    const checked = freezeDataset(raw);
    assert.equal(checked.ok, true);
    assert.equal(checked.excluded.length, 0);
    const dataset = checked.dataset;
    const baseline = rankDataset(dataset, settings());
    const baseById = new Map(baseline.rows.map((row) => [row.id, row]));
    for (const tagDifference of [0, 47, 100]) {
      const ranked = rankDataset(dataset, settings({ tagDifference }));
      assert.deepEqual(ranked.rows, rankDataset(dataset, settings({ tagDifference })).rows);
      assert.equal(new Set(ranked.rows.map((row) => row.id)).size, size);
      assert.equal(ranked.baselineRows.length, size);
      ranked.rows.forEach((row, i) => {
        assert.equal(row.rank, i + 1);
        assert.equal(row.baselineRank, baseById.get(row.id).rank);
        assert.ok(row.distance >= 0 && row.distance <= 1);
        assert.ok(row.score >= row.baselineScore && row.score <= 100 + 20 + 1e-9);
        assert.ok(Math.abs(row.score - row.baseContribution - row.differenceContribution) < 1e-9);
        if (i > 0) {
          const previous = ranked.rows[i - 1];
          assert.ok(previous.score >= row.score);
          if (previous.score === row.score) assert.ok(previous.id < row.id);
        }
      });
    }
    context.diagnostic(
      `validate + nine full rankings + invariants: ${(performance.now() - started).toFixed(1)}ms on this machine; not a cross-device performance guarantee`,
    );
  });
}

test('constraint filtering stays consistent at scale', () => {
  const raw = structuredClone(syntheticDataset);
  const tagIds = Object.keys(raw.tags);
  raw.version = 'acceptance-constraint';
  raw.movies = Array.from({ length: 500 }, (_, i) => ({
    id: `case-${String(i).padStart(4, '0')}`,
    title: `合成验收影片 ${i}`,
    relation: { seedId: raw.seed.id, score: ((i * 37 + 7) % 101) / 100 },
    tagIds: Array.from(
      new Set(Array.from({ length: 1 + (i % 6) }, (_, j) => tagIds[(i * 3 + j * 5) % tagIds.length])),
    ),
  }));
  const { dataset } = freezeDataset(raw);
  const all = rankDataset(dataset, settings());
  const constrained = rankDataset(dataset, settings({}, 2));
  assert.equal(constrained.rows.length + constrained.dropped.length, all.rows.length);
  assert.ok(constrained.rows.every((row) => row.sharedCount >= 2));
  assert.deepEqual(
    constrained.baselineRows.map((row) => row.id).sort(),
    constrained.rows.map((row) => row.id).sort(),
  );
});
