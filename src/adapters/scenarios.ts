import type { SyntheticDataset } from '../core/types.js';

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  /** 这个场景想让人看见什么，写在界面上而不是藏在数据里。 */
  readonly highlights: readonly string[];
  readonly dataset: SyntheticDataset;
}

// 全部标题、标签、关系值与分数都是人工构造或确定性生成的合成数据。
// 它们不是 Qloo 元数据，不代表任何真实用户的偏好，也不证明推荐质量。

const cityNight = {
  source: 'synthetic',
  version: 'synthetic-city-night-v1',
  tags: {
    urban: 'City',
    memory: 'Memory',
    quiet: 'Quiet',
    road: 'Road',
    sea: 'Coast',
    dream: 'Dream',
    rain: 'Rain',
    station: 'Station',
    window: 'Window',
    light: 'Light',
    night: 'Night',
    mist: 'Mist',
    street: 'Street',
  },
  seed: {
    id: 'seed-night-tram',
    title: 'Last Tram Home',
    tagIds: ['urban', 'memory', 'quiet'],
  },
  movies: [
    // Jaccard distances: A = 1 - 3/4 = 0.25; B = 1 - 1/5 = 0.8.
    { id: 'film-a', title: 'Warm City Lights', relation: { seedId: 'seed-night-tram', score: 0.9 }, tagIds: ['urban', 'memory', 'quiet', 'road'] },
    { id: 'film-b', title: 'Letters from the Tide', relation: { seedId: 'seed-night-tram', score: 0.82 }, tagIds: ['urban', 'sea', 'dream'] },
    { id: 'film-c', title: 'Last Ferry out of the Fog', relation: { seedId: 'seed-night-tram', score: 0.88 }, tagIds: ['sea', 'night', 'mist', 'dream'] },
    { id: 'film-d', title: 'Rain on the Old Street', relation: { seedId: 'seed-night-tram', score: 0.86 }, tagIds: ['urban', 'rain', 'street', 'memory'] },
    { id: 'film-e', title: 'Empty Platform', relation: { seedId: 'seed-night-tram', score: 0.84 }, tagIds: ['station', 'quiet', 'night', 'rain'] },
    { id: 'film-f', title: 'Glass Sea', relation: { seedId: 'seed-night-tram', score: 0.83 }, tagIds: ['sea', 'dream', 'window', 'memory'] },
    { id: 'film-g', title: 'Far Light', relation: { seedId: 'seed-night-tram', score: 0.81 }, tagIds: ['road', 'light', 'night', 'urban'] },
    { id: 'film-h', title: 'Room of Tides', relation: { seedId: 'seed-night-tram', score: 0.8 }, tagIds: ['sea', 'quiet', 'window', 'dream'] },
    { id: 'film-i', title: 'Dream Highway', relation: { seedId: 'seed-night-tram', score: 0.79 }, tagIds: ['road', 'dream', 'night', 'memory'] },
    { id: 'film-j', title: 'Radio in the Rain Window', relation: { seedId: 'seed-night-tram', score: 0.77 }, tagIds: ['rain', 'window', 'memory', 'station'] },
    { id: 'film-k', title: 'Empty Coast', relation: { seedId: 'seed-night-tram', score: 0.75 }, tagIds: ['sea', 'street', 'mist', 'night'] },
    { id: 'film-l', title: 'Morning Archive', relation: { seedId: 'seed-night-tram', score: 0.73 }, tagIds: ['memory', 'light', 'urban', 'rain'] },
    { id: 'film-m', title: 'Night Bus Window', relation: { seedId: 'seed-night-tram', score: 0.71 }, tagIds: ['urban', 'night', 'window', 'road'] },
    { id: 'film-n', title: 'Quiet Platform Two', relation: { seedId: 'seed-night-tram', score: 0.69 }, tagIds: ['station', 'quiet', 'rain', 'memory'] },
    { id: 'film-o', title: 'Harbour Fog', relation: { seedId: 'seed-night-tram', score: 0.67 }, tagIds: ['sea', 'mist', 'station', 'night'] },
    { id: 'film-p', title: 'Streetlight Arithmetic', relation: { seedId: 'seed-night-tram', score: 0.65 }, tagIds: ['street', 'light', 'urban', 'memory'] },
    { id: 'film-q', title: 'Dream in Reverse', relation: { seedId: 'seed-night-tram', score: 0.63 }, tagIds: ['dream', 'road', 'quiet', 'night'] },
    { id: 'film-r', title: 'Rain on the Windshield', relation: { seedId: 'seed-night-tram', score: 0.61 }, tagIds: ['rain', 'window', 'road', 'urban'] },
    { id: 'film-s', title: 'Salt in the Seats', relation: { seedId: 'seed-night-tram', score: 0.59 }, tagIds: ['sea', 'quiet', 'mist', 'dream'] },
    { id: 'film-t', title: 'Last Light of the Depot', relation: { seedId: 'seed-night-tram', score: 0.57 }, tagIds: ['light', 'station', 'night', 'street'] },
  ],
} satisfies SyntheticDataset;

const seaDrift = {
  source: 'synthetic',
  version: 'synthetic-sea-drift-v1',
  tags: {
    sea: 'Sea',
    paper: 'Paper',
    slow: 'Slow',
    lamp: 'Lamp',
    salt: 'Salt',
    ferry: 'Ferry',
    letter: 'Letter',
    fog: 'Fog',
    gull: 'Seagull',
    tide: 'Tide',
    wood: 'Wood',
    window: 'Window',
  },
  seed: {
    id: 'seed-tide-post',
    title: 'Tide Post Office',
    tagIds: ['sea', 'paper', 'tide'],
  },
  movies: [
    { id: 'sea-01', title: 'Lighthouse Letters', relation: { seedId: 'seed-tide-post', score: 0.91 }, tagIds: ['sea', 'paper', 'letter', 'lamp'] },
    { id: 'sea-02', title: 'Slow Tide Afternoon', relation: { seedId: 'seed-tide-post', score: 0.87 }, tagIds: ['sea', 'slow', 'tide'] },
    { id: 'sea-03', title: 'Saltwater Cabin', relation: { seedId: 'seed-tide-post', score: 0.85 }, tagIds: ['wood', 'salt', 'sea'] },
    { id: 'sea-04', title: 'Twenty Minutes by Ferry', relation: { seedId: 'seed-tide-post', score: 0.83 }, tagIds: ['ferry', 'sea', 'window'] },
    { id: 'sea-05', title: 'Reading Letters in Fog', relation: { seedId: 'seed-tide-post', score: 0.8 }, tagIds: ['fog', 'letter', 'paper'] },
    { id: 'sea-06', title: 'Seagull and Paper Plane', relation: { seedId: 'seed-tide-post', score: 0.78 }, tagIds: ['gull', 'paper', 'sea'] },
    { id: 'sea-07', title: 'Salt by the Window', relation: { seedId: 'seed-tide-post', score: 0.76 }, tagIds: ['window', 'salt', 'slow'] },
    { id: 'sea-08', title: 'After the Tide Recedes', relation: { seedId: 'seed-tide-post', score: 0.74 }, tagIds: ['tide', 'sea', 'wood'] },
    { id: 'sea-09', title: 'Reading Slowly by Lamplight', relation: { seedId: 'seed-tide-post', score: 0.71 }, tagIds: ['lamp', 'paper', 'slow'] },
    { id: 'sea-10', title: 'Horizon Clearing Fog', relation: { seedId: 'seed-tide-post', score: 0.69 }, tagIds: ['fog', 'sea', 'tide'] },
    { id: 'sea-11', title: 'Nobody at the Ferry', relation: { seedId: 'seed-tide-post', score: 0.66 }, tagIds: ['ferry', 'fog'] },
    { id: 'sea-12', title: 'Salt and Old Paper', relation: { seedId: 'seed-tide-post', score: 0.62 }, tagIds: ['salt', 'paper'] },
    { id: 'sea-13', title: 'The Letter Never Sent', relation: { seedId: 'seed-tide-post', score: 0.58 }, tagIds: ['letter'] },
    { id: 'sea-14', title: 'Empty Boat', relation: { seedId: 'seed-tide-post', score: 0.41 }, tagIds: ['sea'] },
  ],
} satisfies SyntheticDataset;

const nearDuplicate = {
  source: 'synthetic',
  version: 'synthetic-near-duplicate-v1',
  tags: {
    city: 'City',
    rain: 'Rain',
    tram: 'Tram',
    neon: 'Neon',
    laundromat: 'Laundromat',
    cat: 'Cat',
    bench: 'Bench',
    umbrella: 'Umbrella',
  },
  seed: {
    id: 'seed-old-cinema',
    title: 'Old Town Cinema',
    tagIds: ['city', 'rain', 'tram'],
  },
  movies: [
    { id: 'near-01', title: 'The Same Street', relation: { seedId: 'seed-old-cinema', score: 0.94 }, tagIds: ['city', 'rain', 'tram', 'neon'] },
    { id: 'near-02', title: 'The Same Rain', relation: { seedId: 'seed-old-cinema', score: 0.93 }, tagIds: ['city', 'rain', 'tram', 'bench'] },
    { id: 'near-03', title: 'The Same Last Tram', relation: { seedId: 'seed-old-cinema', score: 0.92 }, tagIds: ['city', 'tram', 'umbrella'] },
    { id: 'near-04', title: 'Familiar Neon', relation: { seedId: 'seed-old-cinema', score: 0.9 }, tagIds: ['city', 'neon', 'rain'] },
    { id: 'near-05', title: 'The Laundromat Cat', relation: { seedId: 'seed-old-cinema', score: 0.72 }, tagIds: ['city', 'laundromat', 'cat'] },
    { id: 'near-06', title: 'Bench in the Rain', relation: { seedId: 'seed-old-cinema', score: 0.68 }, tagIds: ['rain', 'bench', 'cat'] },
    { id: 'near-07', title: 'Waiting Under the Umbrella', relation: { seedId: 'seed-old-cinema', score: 0.61 }, tagIds: ['umbrella', 'tram', 'rain'] },
    { id: 'near-08', title: 'The Cinema Next Door', relation: { seedId: 'seed-old-cinema', score: 0.55 }, tagIds: ['city', 'neon'] },
    { id: 'near-09', title: 'After the Rain Stops', relation: { seedId: 'seed-old-cinema', score: 0.44 }, tagIds: ['rain'] },
    { id: 'near-10', title: 'Empty Bench', relation: { seedId: 'seed-old-cinema', score: 0.31 }, tagIds: ['bench'] },
  ],
} satisfies SyntheticDataset;

const edgeCases = {
  source: 'synthetic',
  version: 'synthetic-edge-cases-v1',
  tags: {
    light: 'Light',
    dust: 'Dust',
    corridor: 'Corridor',
    echo: 'Echo',
    blue: 'Blue',
    chair: 'Chair',
  },
  seed: {
    id: 'seed-empty-room',
    title: 'Empty Room',
    tagIds: ['light', 'dust'],
  },
  movies: [
    { id: 'edge-tie-a', title: 'Tie A', relation: { seedId: 'seed-empty-room', score: 0.7 }, tagIds: ['light', 'dust', 'chair'] },
    { id: 'edge-tie-b', title: 'Tie B', relation: { seedId: 'seed-empty-room', score: 0.7 }, tagIds: ['light', 'dust', 'chair'] },
    { id: 'edge-zero', title: 'Zero Score but Tagged', relation: { seedId: 'seed-empty-room', score: 0 }, tagIds: ['light', 'dust'] },
    { id: 'edge-long', title: 'A long story about a late-night convenience store, the last tram, a lost property desk, and the cat that never comes home', relation: { seedId: 'seed-empty-room', score: 0.66 }, tagIds: ['light', 'corridor', 'echo'] },
    { id: 'edge-blue', title: 'The Blue Corridor', relation: { seedId: 'seed-empty-room', score: 0.52 }, tagIds: ['blue', 'corridor'] },
    { id: 'edge-no-relation', title: 'Film with no relation', relation: null, tagIds: ['light', 'dust'] },
    { id: 'edge-no-tags', title: 'Film with no tags', relation: { seedId: 'seed-empty-room', score: 0.4 }, tagIds: null },
    { id: 'edge-empty-tags', title: 'Film with empty tags', relation: { seedId: 'seed-empty-room', score: 0.38 }, tagIds: [] },
  ],
} satisfies SyntheticDataset;

const noSignals = {
  source: 'synthetic',
  version: 'synthetic-no-signals-v1',
  tags: {
    light: 'Light',
    dust: 'Dust',
  },
  seed: {
    id: 'seed-silent',
    title: 'Silent Screening Room',
    tagIds: ['light', 'dust'],
  },
  movies: [
    { id: 'silent-01', title: 'No Tags A', relation: { seedId: 'seed-silent', score: 0.8 }, tagIds: null },
    { id: 'silent-02', title: 'No Tags B', relation: { seedId: 'seed-silent', score: 0.7 }, tagIds: [] },
    { id: 'silent-03', title: 'No Relation C', relation: null, tagIds: ['light'] },
  ],
} satisfies SyntheticDataset;

/** 确定性线性同余发生器：同样的种子永远得到同样的候选集合。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const largeTitles = [
  'Long Night',
  'Old Letter',
  'Return Trip',
  'Empty Platform',
  'Rain in the South',
  'Slow Goodbye',
  'Seventh Day by the Sea',
  'Someone Is Waiting',
  'Glass and Fog',
  'The Last One',
] as const;

const largePlaces = [
  'North Shore',
  'Old Town',
  'Station',
  'Wharf',
  'Alley',
  'Valley',
  'Highland',
  'Seaside',
  'Downtown',
  'Border',
] as const;

/** 240 部的确定性大集合：验证排序在真实规模下仍然稳定、可解释。 */
function buildLargeCohort(): SyntheticDataset {
  const random = lcg(20261027);
  const tagIds = ['sea', 'rain', 'light', 'road', 'night', 'letter', 'window', 'city', 'quiet', 'mist'];
  const tagLabels: Record<string, string> = {
    sea: 'Sea',
    rain: 'Rain',
    light: 'Light',
    road: 'Road',
    night: 'Night',
    letter: 'Letter',
    window: 'Window',
    city: 'City',
    quiet: 'Quiet',
    mist: 'Mist',
  };

  const movies = Array.from({ length: 240 }, (_, index) => {
    const relation = Math.round(random() * 100) / 100;
    const tagCount = 2 + Math.floor(random() * 4);
    const picked = new Set<string>();
    for (let i = 0; i < tagCount; i += 1) {
      picked.add(tagIds[Math.floor(random() * tagIds.length)] ?? 'light');
    }
    const titleIndex = index % largeTitles.length;
    const placeIndex = Math.floor(index / largeTitles.length) % largePlaces.length;
    return {
      id: `mass-${String(index).padStart(3, '0')}`,
      title: `${largePlaces[placeIndex]} ${largeTitles[titleIndex]}`,
      relation: { seedId: 'seed-mass', score: relation },
      tagIds: [...picked],
    };
  });

  return {
    source: 'synthetic',
    version: 'synthetic-large-cohort-v1',
    tags: tagLabels,
    seed: {
      id: 'seed-mass',
      title: 'Night Sample',
      tagIds: ['night', 'road', 'quiet'],
    },
    movies,
  };
}

export const scenarios: readonly Scenario[] = Object.freeze([
  {
    id: 'city-night',
    label: 'City at night',
    summary: '20 fictional city films; the seed is the last tram home. Watch how the tag-difference weight moves the ranks.',
    highlights: ['Baseline scenario', 'Weights change ranks', 'Readable tag evidence'],
    dataset: cityNight,
  },
  {
    id: 'sea-drift',
    label: 'Slow films by the sea',
    summary: '14 slow coastal films; the seed is the tide post office. The relation scores are flatter, so the difference bonus matters more.',
    highlights: ['Flatter relation scores', '14 candidates', 'Both weights usable'],
    dataset: seaDrift,
  },
  {
    id: 'near-duplicate',
    label: 'Near duplicates',
    summary: '10 films that closely resemble the seed. More similar does not mean a higher score: the difference bonus is capped.',
    highlights: ['High overlap', 'Difference bonus cap', 'Minimum shared tags rule'],
    dataset: nearDuplicate,
  },
  {
    id: 'edge-cases',
    label: 'Edges and gaps',
    summary: 'A very long title, an exact tie, a zero score with tags, and three films dropped for incomplete data.',
    highlights: ['Exact tie', 'Long text', 'Zero is a measurement', 'Dropped and why'],
    dataset: edgeCases,
  },
  {
    id: 'large-cohort',
    label: 'Large cohort',
    summary: '240 deterministically generated films, to check that ranking stays stable, reproducible and explainable at scale.',
    highlights: ['240 films', 'Deterministic', 'Scale and performance'],
    dataset: buildLargeCohort(),
  },
  {
    id: 'no-signals',
    label: 'No signals',
    summary: 'Every film is missing usable tags. This is a normal empty state, not an error, and it never falls back to the previous list.',
    highlights: ['Empty state', 'All dropped', 'No invented candidates'],
    dataset: noSignals,
  },
]);

export const defaultScenarioId = 'city-night';

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
