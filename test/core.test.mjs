// Independent acceptance checks by the local orchestrator against MiniMax-authored code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freezeDataset,
  rankDataset,
  validateControls,
  validateSettings,
  DEFAULT_CONTROLS,
  DEFAULT_SETTINGS,
} from '../dist/assets/core/ranking.js';
import { syntheticDataset } from '../dist/assets/adapters/synthetic.js';

const copy = () => structuredClone(syntheticDataset);
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const settings = (controls = {}, minSharedTags = 0) => ({
  controls: { ...DEFAULT_CONTROLS, ...controls },
  minSharedTags,
});
function accept(raw = copy()) {
  const result = freezeDataset(raw);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function reject(change) {
  const raw = copy();
  change(raw);
  const result = freezeDataset(raw);
  assert.equal(result.ok, false, 'Malformed data must fail instead of being repaired');
  assert.ok(result.issues.length > 0);
}

test('synthetic fixture has twenty films and deterministic full results', () => {
  const raw = copy();
  const before = structuredClone(raw);
  const { dataset } = accept(raw);
  assert.equal(dataset.movies.length, 20);
  for (const tagDifference of [0, 37, 100]) {
    assert.deepEqual(
      rankDataset(dataset, settings({ tagDifference })),
      rankDataset(dataset, settings({ tagDifference })),
    );
  }
  assert.deepEqual(raw, before);
  assert.ok(dataset.movies.every((movie) => movie.relation.seedId === dataset.seed.id));
});

test('explicit two-film arithmetic oracle swaps A/B and explains the same result', () => {
  const raw = copy();
  raw.movies = raw.movies.filter((movie) => ['film-a', 'film-b'].includes(movie.id));
  const { dataset } = accept(raw);
  const baseline = rankDataset(dataset, settings()).rows;
  const current = rankDataset(dataset, settings({ tagDifference: 100 })).rows;
  assert.deepEqual(baseline.map((row) => row.id), ['film-a', 'film-b']);
  assert.deepEqual(current.map((row) => row.id), ['film-b', 'film-a']);
  close(baseline[0].score, 72);
  close(baseline[1].score, 65.6);
  close(current[0].score, 81.6);
  close(current[1].score, 77);
  close(current[0].distance, 0.8);
  close(current[1].distance, 0.25);
  assert.equal(current[0].deltaRank, 1);
  assert.equal(current[1].deltaRank, -1);
  assert.deepEqual(current[0].sharedTags, ['City']);
  assert.deepEqual(current[0].seedOnlyTags, ['Memory', 'Quiet']);
  assert.deepEqual(current[0].movieOnlyTags, ['Coast', 'Dream']);
  assert.deepEqual(current[0].tagLabels, ['City', 'Coast', 'Dream']);
  assert.deepEqual(current[1].sharedTags, ['City', 'Memory', 'Quiet']);
  assert.deepEqual(current[1].movieOnlyTags, ['Road']);
});

test('contributions, fixed cohort/baseline and reset remain consistent', () => {
  const { dataset } = accept();
  const initial = rankDataset(dataset, settings());
  const initialById = new Map(initial.rows.map((row) => [row.id, row]));
  for (const tagDifference of [0, 1, 50, 99, 100]) {
    const { rows, baselineRows, dropped } = rankDataset(dataset, settings({ tagDifference }));
    assert.deepEqual(rows.map((row) => row.id).sort(), initial.rows.map((row) => row.id).sort());
    assert.equal(dropped.length, 0);
    assert.equal(baselineRows.length, rows.length);
    for (const row of rows) {
      close(row.score, row.baseContribution + row.differenceContribution);
      close(row.baselineScore, row.baselineBaseContribution + row.baselineDifferenceContribution);
      close(
        row.score - row.baselineScore,
        row.differenceContribution - row.baselineDifferenceContribution,
      );
      assert.equal(row.baselineRank, initialById.get(row.id).rank);
      assert.equal(row.deltaRank, row.baselineRank - row.rank);
      assert.ok(Number.isFinite(row.score));
      assert.ok(Object.isFrozen(row));
      assert.ok(Object.isFrozen(row.sharedTags));
    }
    assert.ok(Object.isFrozen(rows));
  }
  rankDataset(dataset, settings({ tagDifference: 100 }));
  assert.deepEqual(rankDataset(dataset, settings()), initial);
  assert.equal(rankDataset(dataset, settings()).rows[0].id, initial.rows[0].id);
  assert.ok(Object.isFrozen(DEFAULT_CONTROLS));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});

test('baseline contributions stay on the default weights whatever the current knobs say', () => {
  const { dataset } = accept();
  const baselineById = new Map(
    rankDataset(dataset, settings()).rows.map((row) => [row.id, row]),
  );

  for (const relationWeight of [0, 37, 80, 100]) {
    for (const tagDifference of [0, 50, 100]) {
      const { rows } = rankDataset(dataset, settings({ relationWeight, tagDifference }));
      for (const row of rows) {
        const baseline = baselineById.get(row.id);
        // 基线贡献必须等于默认权重下的贡献，与当前两个旋钮无关。
        close(row.baselineBaseContribution, baseline.baselineBaseContribution);
        close(row.baselineDifferenceContribution, baseline.baselineDifferenceContribution);
        close(row.baselineScore, baseline.baselineScore);
        close(row.baselineBaseContribution, DEFAULT_CONTROLS.relationWeight * row.relation);
        close(
          row.baselineDifferenceContribution,
          20 * (DEFAULT_CONTROLS.tagDifference / 100) * row.distance,
        );
      }
    }
  }
});

test('relation weight is a real knob that can invert the default order', () => {
  const { dataset } = accept();
  const byRelation = rankDataset(dataset, settings({ relationWeight: 100, tagDifference: 0 }));
  const byDifference = rankDataset(dataset, settings({ relationWeight: 0, tagDifference: 100 }));

  assert.equal(byRelation.rows[0].id, 'film-a', 'highest relation must lead at full relation weight');
  close(byRelation.rows[0].baseContribution, 90);

  // 关联权重为 0 时只剩差异项：差异最大的 film-c 与 film-k 并列，按 ASCII ID 定序。
  assert.equal(byDifference.rows[0].id, 'film-c');
  assert.equal(byDifference.rows[1].id, 'film-k');
  close(byDifference.rows[0].score, 20);
  close(byDifference.rows[1].score, 20);
  assert.ok(byDifference.rows.every((row) => row.baseContribution === 0));
  assert.notEqual(
    byDifference.rows.map((row) => row.id).join(),
    byRelation.rows.map((row) => row.id).join(),
  );
});

test('the shared-tag constraint shrinks the cohort and keeps baseline inside it', () => {
  const { dataset } = accept();
  const all = rankDataset(dataset, settings());
  const constrained = rankDataset(dataset, settings({}, 2));

  assert.ok(constrained.rows.length < all.rows.length);
  assert.equal(constrained.rows.length + constrained.dropped.length, all.rows.length);
  assert.ok(constrained.rows.every((row) => row.sharedCount >= 2));
  assert.ok(constrained.dropped.every((row) => row.sharedCount < 2 && row.reason.length > 0));

  const tight = rankDataset(dataset, settings({}, 3));
  assert.deepEqual(tight.rows.map((row) => row.id), ['film-a'], 'only film-a shares all three seed tags');
  assert.equal(tight.dropped.length, 19);

  const baselineRanks = constrained.baselineRows.map((row) => row.rank);
  assert.deepEqual(baselineRanks, [...baselineRanks].sort((left, right) => left - right));
  assert.deepEqual(
    constrained.baselineRows.map((row) => row.id).sort(),
    constrained.rows.map((row) => row.id).sort(),
    'baseline and current must share the same frozen cohort',
  );
  for (const row of constrained.rows) {
    const baseline = constrained.baselineRows.find((item) => item.id === row.id);
    assert.equal(baseline.rank, row.baselineRank);
    assert.equal(baseline.score, row.baselineScore);
  }
});

test('an unsatisfiable constraint yields an empty cohort instead of a broken list', () => {
  const raw = copy();
  // 让每部片都丢掉与种子重合的标签，于是"至少共享 1 个"不可能成立。
  raw.movies.forEach((movie) => {
    movie.tagIds = ['road', 'sea', 'dream'];
  });
  const { dataset } = accept(raw);
  const empty = rankDataset(dataset, settings({}, 1));
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.baselineRows.length, 0);
  assert.equal(empty.dropped.length, 20);
  assert.ok(empty.dropped.every((row) => row.sharedCount === 0 && row.reason.includes('1')));
});

test('ties use ASCII IDs and near display ties use unrounded scores', () => {
  const raw = copy();
  const a = structuredClone(raw.movies[0]);
  const z = structuredClone(a);
  a.id = 'film-a';
  z.id = 'film-z';
  raw.movies = [z, a];
  assert.deepEqual(
    rankDataset(accept(raw).dataset, settings()).rows.map((row) => row.id),
    ['film-a', 'film-z'],
  );
  a.relation.score = 0.80001;
  z.relation.score = 0.80002;
  const rows = rankDataset(accept(raw).dataset, settings()).rows;
  assert.equal(rows[0].id, 'film-z');
  assert.equal(rows[0].score.toFixed(1), rows[1].score.toFixed(1));
});

test('freezing owns a deep copy without freezing the caller', () => {
  const raw = copy();
  const { dataset } = accept(raw);
  const before = rankDataset(dataset, settings({ tagDifference: 100 }));
  assert.equal(Object.isFrozen(raw.movies[0]), false);
  raw.movies[0].title = 'changed';
  raw.movies[0].relation.score = 0;
  raw.movies[0].tagIds.push('dream');
  raw.seed.tagIds.push('sea');
  raw.tags.urban = 'changed';
  raw.movies.length = 0;
  assert.deepEqual(rankDataset(dataset, settings({ tagDifference: 100 })), before);
  assert.ok(Object.isFrozen(dataset));
  assert.ok(Object.isFrozen(dataset.seed.tagIds));
  assert.ok(Object.isFrozen(dataset.movies));
  assert.ok(Object.isFrozen(dataset.movies[0].relation));
  assert.ok(Object.isFrozen(dataset.tags));
});

test('missing data is excluded visibly before both rankings; empty is valid', () => {
  const raw = copy();
  raw.movies[0].relation = null;
  raw.movies[1].tagIds = null;
  raw.movies[2].tagIds = [];
  raw.movies[3].relation = null;
  raw.movies[3].tagIds = null;
  const result = accept(raw);
  // 合格数量**从输入与被排除记录推出来**：夹具变长时不用再改写死的数字。
  const excluded = result.excluded.length;
  const eligible = raw.movies.length - excluded;
  assert.equal(excluded, 4, '被弄坏的四条都要被排除');
  assert.equal(result.dataset.movies.length, eligible);
  assert.equal(result.excluded.find((row) => row.id === 'film-d').reasons.length, 2);
  assert.ok(result.excluded.every((row) => row.reasons.length > 0));
  for (const tagDifference of [0, 100]) {
    const ranked = rankDataset(result.dataset, settings({ tagDifference }));
    assert.equal(ranked.rows.length, eligible);
    assert.equal(ranked.baselineRows.length, eligible);
  }
  raw.movies.forEach((movie) => {
    movie.relation = null;
  });
  assert.deepEqual(rankDataset(accept(raw).dataset, settings()).rows, []);
  raw.movies = [];
  assert.deepEqual(rankDataset(accept(raw).dataset, settings()).rows, []);
});

test('zero is a measured synthetic relation, distinct from unknown', () => {
  const raw = copy();
  raw.movies = [raw.movies[0]];
  raw.movies[0].relation.score = 0;
  const result = accept(raw);
  assert.equal(result.excluded.length, 0);
  assert.equal(rankDataset(result.dataset, settings()).rows[0].score, 0);
});

const malformed = {
  'duplicate movie': (raw) => {
    raw.movies[1].id = raw.movies[0].id;
  },
  'duplicate tags': (raw) => {
    raw.movies[0].tagIds.push(raw.movies[0].tagIds[0]);
  },
  'wrong seed relation': (raw) => {
    raw.movies[0].relation.seedId = 'other';
  },
  'missing relation property': (raw) => {
    delete raw.movies[0].relation;
  },
  'invalid tag array': (raw) => {
    raw.movies[0].tagIds = 'urban';
  },
  'missing tag property': (raw) => {
    delete raw.movies[0].tagIds;
  },
  'unknown movie tag': (raw) => {
    raw.movies[0].tagIds = ['unknown'];
  },
  'unknown seed tag': (raw) => {
    raw.seed.tagIds = ['unknown'];
  },
  'empty seed': (raw) => {
    raw.seed.tagIds = [];
  },
  'wrong source': (raw) => {
    raw.source = 'qloo';
  },
  'blank version': (raw) => {
    raw.version = ' ';
  },
  'blank title': (raw) => {
    raw.movies[0].title = '';
  },
  'blank label': (raw) => {
    raw.tags.urban = '';
  },
  'invalid ID': (raw) => {
    raw.movies[0].id = '../film';
  },
  'invalid present data alongside missing': (raw) => {
    raw.movies[0].relation = null;
    raw.movies[0].tagIds = ['unknown'];
  },
  'sparse seed tags': (raw) => {
    raw.seed.tagIds = new Array(1);
  },
  'sparse movie tags': (raw) => {
    raw.movies[0].tagIds = new Array(1);
  },
  'sparse movie list': (raw) => {
    raw.movies = new Array(1);
  },
};
for (const [name, change] of Object.entries(malformed)) {
  test(`rejects ${name}`, () => reject(change));
}
for (const score of [NaN, Infinity, -0.01, 1.01, '0.5', undefined]) {
  test(`rejects invalid relation ${String(score)}`, () =>
    reject((raw) => {
      raw.movies[0].relation.score = score;
    }),
  );
}
for (const input of [null, [], true, 'data', 1, {}]) {
  test(`rejects malformed root ${JSON.stringify(input)}`, () =>
    assert.equal(freezeDataset(input).ok, false),
  );
}

test('controls validate their boundary and ranking never silently clamps', () => {
  for (const input of [
    null,
    [],
    {},
    { tagDifference: '10' },
    ...[NaN, Infinity, -1, 101, 0.5, undefined].map((tagDifference) => ({ tagDifference })),
  ]) {
    assert.equal(validateControls(input).ok, false);
  }
  for (const relationWeight of [0, 100]) {
    assert.equal(validateControls({ relationWeight, tagDifference: 0 }).ok, true);
  }
  assert.equal(validateControls({ relationWeight: 50 }).ok, false, 'missing tagDifference is invalid');

  const { dataset } = accept();
  assert.throws(() => rankDataset(dataset, settings({ tagDifference: 100.5 })), RangeError);
  assert.throws(() => rankDataset(dataset, settings({}, 99)), RangeError);
});

test('settings validate the shared-tag bound against the seed vocabulary', () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS, 3).ok, true);
  assert.equal(validateSettings(settings({}, 3), 3).ok, true);
  assert.equal(validateSettings(settings({}, 4), 3).ok, false);
  assert.equal(validateSettings(settings({}, -1), 3).ok, false);
  assert.equal(validateSettings(settings({}, 1.5), 3).ok, false);
  assert.equal(validateSettings({ controls: DEFAULT_CONTROLS }, 3).ok, false);
});
