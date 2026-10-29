import type { RankedMovie } from '../core/types.js';
import { el, formatScore } from './dom.js';

function scoreCell(value: number): HTMLTableCellElement {
  return el('td', undefined, formatScore(value));
}

function addTagGroup(
  parent: HTMLElement,
  title: string,
  tags: readonly string[],
): void {
  const group = el('div', 'tag-group');
  group.append(el('h3', undefined, title));

  if (tags.length === 0) {
    group.append(el('p', 'tag-empty', 'None'));
    return;
  }

  const list = el('ul', 'tag-list');
  for (const tag of tags) {
    list.append(el('li', 'tag', tag));
  }
  group.append(list);
  parent.append(group);
}

export function renderEvidence(panel: HTMLElement, row: RankedMovie | null): void {
  const detailsOpen = panel.querySelector('details')?.open ?? false;

  if (row === null) {
    panel.replaceChildren(
      el('h2', undefined, 'Why this film moved'),
      el('p', 'evidence-empty', 'Pick a film in the list and its score breakdown appears here.'),
    );
    return;
  }

  const title = el('h2', undefined, 'Why this film moved');
  const movieTitle = el('p', 'evidence-title', row.title);

  const rankComparison = el('div', 'rank-comparison');
  const defaultRank = el('div', 'rank-block');
  defaultRank.append(
    el('span', 'rank-label', 'Default'),
    el('strong', undefined, `#${row.baselineRank}`),
  );
  const currentRank = el('div', 'rank-block');
  currentRank.append(
    el('span', 'rank-label', 'Current'),
    el('strong', undefined, `#${row.rank}`),
  );
  rankComparison.append(defaultRank, currentRank);

  const movement =
    row.deltaRank > 0
      ? `${Math.abs(row.deltaRank)} up from default`
      : row.deltaRank < 0
        ? `${Math.abs(row.deltaRank)} down from default`
        : 'Rank unchanged';
  const movementText = el('p', 'movement', movement);
  if (row.deltaRank !== 0) movementText.classList.add('is-changed');

  const inputs = el('p', 'evidence-inputs');
  inputs.append(
    el('span', 'input-chip', `Relation ${row.relation.toFixed(2)}`),
    el('span', 'input-chip', `Tag difference ${row.distance.toFixed(2)}`),
    el('span', 'input-chip', `${row.sharedCount} shared tags`),
  );

  const table = el('table', 'score-table');
  table.append(el('caption', undefined, 'Heuristic score'));

  const head = el('thead');
  const headRow = el('tr');
  for (const heading of ['Contribution', 'Default', 'Current']) {
    const cell = el('th', undefined, heading);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');

  const baseRow = el('tr');
  // Default列直接取排序结果里的基线Contribution，不用Current权重反推，也不写死 0。
  baseRow.append(
    el('th', undefined, 'Relation base score'),
    scoreCell(row.baselineBaseContribution),
    scoreCell(row.baseContribution),
  );
  baseRow.firstElementChild?.setAttribute('scope', 'row');

  const differenceRow = el('tr');
  differenceRow.append(
    el('th', undefined, 'Tag difference bonus'),
    scoreCell(row.baselineDifferenceContribution),
    scoreCell(row.differenceContribution),
  );
  differenceRow.firstElementChild?.setAttribute('scope', 'row');

  const totalRow = el('tr', 'total-row');
  totalRow.append(
    el('th', undefined, 'Total'),
    scoreCell(row.baselineScore),
    scoreCell(row.score),
  );
  totalRow.firstElementChild?.setAttribute('scope', 'row');

  body.append(baseRow, differenceRow, totalRow);
  table.append(body);

  const tagEvidence = el('div', 'tag-evidence');
  addTagGroup(tagEvidence, 'Shared tags', row.sharedTags);
  addTagGroup(tagEvidence, 'Seed only', row.seedOnlyTags);
  addTagGroup(tagEvidence, 'Film only', row.movieOnlyTags);

  const details = el('details', 'method-note');
  details.open = detailsOpen;
  details.append(
    el('summary', undefined, 'How it is computed'),
    el(
      'p',
      undefined,
      'Relation base score = relation weight × synthetic relation score. Tag difference bonus = 20 × (difference weight ÷ 100) × tag difference, capped at 20 points.',
    ),
    el(
      'p',
      undefined,
      'Tag difference = 1 − shared tags ÷ tags in the union. It is a synthetic heuristic, not a preference probability and not a measure of recommendation quality.',
    ),
    el('p', undefined, 'The default column uses the default weights on the same candidate set, so rank changes can be attributed inside the set.'),
  );

  panel.replaceChildren(
    title,
    movieTitle,
    rankComparison,
    movement,
    inputs,
    table,
    tagEvidence,
    details,
  );
}
