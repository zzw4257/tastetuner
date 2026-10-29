import type { RankedList, RankedMovie } from '../core/types.js';
import { el, formatDelta, formatScore } from './dom.js';

export interface CompareSide {
  readonly id: string;
  readonly label: string;
  readonly list: RankedList;
  readonly excluded: number;
  readonly effectiveMinSharedTags: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function movers(rows: readonly RankedMovie[]): {
  readonly up: RankedMovie | null;
  readonly down: RankedMovie | null;
  readonly count: number;
} {
  let up: RankedMovie | null = null;
  let down: RankedMovie | null = null;
  let count = 0;
  for (const row of rows) {
    if (row.deltaRank === 0) continue;
    count += 1;
    if (up === null || row.deltaRank > up.deltaRank) up = row;
    if (down === null || row.deltaRank < down.deltaRank) down = row;
  }
  return { up, down, count };
}

function renderBaselineCompare(summary: HTMLElement, body: HTMLElement, side: CompareSide): void {
  const rows = side.list.rows;
  const { up, down, count } = movers(rows);

  summary.replaceChildren(
    el(
      'p',
      'compare-line',
      `Same candidate set, same films: ${rows.length} in total, ${count} of them changed rank.`,
    ),
  );
  if (up !== null || down !== null) {
    const parts: string[] = [];
    if (up !== null) parts.push(`Biggest climb: ${up.deltaRank} places (${up.title})`);
    if (down !== null) parts.push(`Biggest drop: ${Math.abs(down.deltaRank)} places (${down.title})`);
    summary.append(el('p', 'compare-line is-muted', parts.join(' · ')));
  }

  if (rows.length === 0) {
    body.replaceChildren(el('p', 'compare-empty', 'The current candidate set is empty, so there are no ranks to compare.'));
    return;
  }

  const table = el('table', 'compare-table');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of ['Film', 'Default', 'Current', 'Rank change', 'Score change']) {
    const cell = el('th', undefined, heading);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const bodyRows = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const title = el('th', 'compare-title', row.title);
    title.setAttribute('scope', 'row');
    const delta = el('td', 'compare-delta', formatDelta(row.deltaRank));
    if (row.deltaRank === 0) delta.classList.add('is-flat');
    const scoreDelta = el('td', 'compare-delta', `${row.score - row.baselineScore >= 0 ? '+' : '−'}${Math.abs(row.score - row.baselineScore).toFixed(2)}`);
    if (row.score === row.baselineScore) scoreDelta.classList.add('is-flat');
    tr.append(
      title,
      el('td', 'compare-num', String(row.baselineRank)),
      el('td', 'compare-num', String(row.rank)),
      delta,
      scoreDelta,
    );
    bodyRows.append(tr);
  }
  table.append(bodyRows);
  body.replaceChildren(table);
}

function statsFor(side: CompareSide): readonly [string, string][] {
  const rows = side.list.rows;
  return [
    ['Effective minimum shared tags', String(side.effectiveMinSharedTags)],
    ['Candidates', String(rows.length)],
    ['Dropped for incomplete data', String(side.excluded)],
    ['Blocked by constraints', String(side.list.dropped.length)],
    ['Top score', rows.length > 0 ? formatScore(rows[0]?.score ?? 0) : '—'],
    ['Median score', rows.length > 0 ? formatScore(median(rows.map((row) => row.score))) : '—'],
    ['Median tag difference', rows.length > 0 ? median(rows.map((row) => row.distance)).toFixed(2) : '—'],
    ['Films reordered', String(movers(rows).count)],
  ];
}

function renderScenarioCompare(
  summary: HTMLElement,
  body: HTMLElement,
  current: CompareSide,
  other: CompareSide,
): void {
  const warning = el('p', 'compare-warning');
  const thresholdsDiffer =
    current.effectiveMinSharedTags !== other.effectiveMinSharedTags;

  if (thresholdsDiffer) {
    warning.append(el('strong', undefined, 'The two sides use different effective minimum shared tags thresholds.'));
    warning.append(
      document.createTextNode(
        `The current scenario uses ${current.effectiveMinSharedTags} and the comparison scenario uses ${other.effectiveMinSharedTags}. The threshold changes what counts as the candidate set, so the overall rank differences below cannot be attributed to the weights.`,
      ),
    );
    if (current.id === other.id) {
      warning.append(document.createTextNode(' The selected comparison scenario is the same as the current scenario.'));
    }
  } else if (current.id === other.id) {
    warning.append(el('strong', undefined, 'The comparison scenario and the current scenario are the same one.'));
    warning.append(
      document.createTextNode(
        `Both columns use the same scenario and the same effective threshold (${current.effectiveMinSharedTags}), so the per-film numbers must match; only a different scenario shows a difference.`,
      ),
    );
  } else {
    warning.append(el('strong', undefined, 'The two scenarios are different fictional candidate sets.'));
    warning.append(
      document.createTextNode(
        `Both sides use the same effective minimum shared tags threshold (${current.effectiveMinSharedTags}), but the same film has no counterpart in the other scenario, so rank differences cannot be attributed film by film, and candidate-set differences cannot be attributed to the weight change.`,
      ),
    );
  }

  summary.replaceChildren(warning);

  const table = el('table', 'compare-table compare-stats');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of ['Metric', current.label, other.label]) {
    const cell = el('th', undefined, heading);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const bodyRows = el('tbody');
  const currentStats = statsFor(current);
  const otherStats = statsFor(other);
  currentStats.forEach(([label, value], index) => {
    const tr = el('tr');
    const cell = el('th', 'compare-title', label);
    cell.setAttribute('scope', 'row');
    tr.append(cell, el('td', 'compare-num', value), el('td', 'compare-num', otherStats[index]?.[1] ?? '—'));
    bodyRows.append(tr);
  });
  table.append(bodyRows);

  const columns = el('div', 'compare-columns');
  for (const side of [current, other]) {
    const column = el('div', 'compare-column');
    column.append(el('h3', 'control-heading', `${side.label} · Top 5`));
    const list = el('ol', 'compare-top-list');
    for (const row of side.list.rows.slice(0, 5)) {
      const item = el('li', 'compare-top-item');
      item.append(
        el('span', 'compare-top-rank', String(row.rank)),
        el('span', 'compare-top-title', row.title),
        el('span', 'compare-top-score', formatScore(row.score)),
      );
      list.append(item);
    }
    if (side.list.rows.length === 0) {
      list.append(el('li', 'compare-top-item is-muted', 'The candidate set is empty'));
    }
    column.append(list);
    columns.append(column);
  }

  body.replaceChildren(table, columns);
}

export function renderCompare(
  summary: HTMLElement,
  body: HTMLElement,
  mode: 'baseline' | 'scenario',
  current: CompareSide,
  other: CompareSide | null,
): void {
  if (mode === 'baseline' || other === null) {
    renderBaselineCompare(summary, body, current);
    return;
  }
  renderScenarioCompare(summary, body, current, other);
}
