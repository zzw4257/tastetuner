import type { RankedMovie } from '../core/types.js';
import { el, formatDelta, formatScore, prefersReducedMotion } from './dom.js';

/** 记录每行Current的位置，用于重排后的位移动画。 */
export function snapshotPositions(list: HTMLElement): Map<string, number> {
  const positions = new Map<string, number>();
  for (const item of Array.from(list.children)) {
    const id = item.getAttribute('data-movie-id');
    if (id === null) continue;
    positions.set(id, item.getBoundingClientRect().top);
  }
  return positions;
}

/**
 * 先量后动：重排后把行从旧位置平移回原位再过渡，
 * 让"Rank changed"这件事被看见，而不是瞬间替换。
 */
export function animateReorder(list: HTMLElement, previous: Map<string, number>): void {
  if (previous.size === 0 || prefersReducedMotion()) return;

  for (const item of Array.from(list.children)) {
    const id = item.getAttribute('data-movie-id');
    if (id === null) continue;
    const before = previous.get(id);
    if (before === undefined) continue;

    const after = item.getBoundingClientRect().top;
    const shift = before - after;
    if (Math.abs(shift) < 1) continue;

    item.animate(
      [
        { transform: `translateY(${shift}px)` },
        { transform: 'translateY(0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(0.22, 0.68, 0.24, 1)' },
    );
  }
}

export function renderList(
  list: HTMLOListElement,
  rows: readonly RankedMovie[],
  selectedId: string | null,
  onSelect: (id: string) => void,
  emptyHint?: string,
): void {
  if (rows.length === 0) {
    const empty = el('li', 'list-empty');
    empty.append(
      el('p', 'list-empty-line', 'The current candidate set is empty. There is nothing to rank, and the previous list is not shown either.'),
    );
    if (emptyHint !== undefined) {
      empty.append(el('p', 'list-empty-hint', emptyHint));
    }
    list.replaceChildren(empty);
    return;
  }

  const items = rows.map((row) => {
    const item = el('li', 'movie-item');
    item.setAttribute('data-movie-id', row.id);

    const button = el('button', 'movie-row');
    button.type = 'button';
    button.dataset.movieId = row.id;
    button.setAttribute('aria-pressed', row.id === selectedId ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      `${row.title}, rank ${row.rank}, heuristic score ${formatScore(row.score)}`,
    );

    const rank = el('span', 'movie-rank', String(row.rank).padStart(2, '0'));
    const title = el('span', 'movie-title', row.title);
    const score = el('span', 'movie-score', formatScore(row.score));
    const delta = el('span', 'movie-delta', formatDelta(row.deltaRank));
    if (row.deltaRank === 0) delta.classList.add('is-flat');

    button.append(rank, title, score, delta);
    button.addEventListener('click', () => onSelect(row.id));
    item.append(button);
    return item;
  });

  list.replaceChildren(...items);
}

/** 选中态只改属性，不重建 DOM，键盘焦点才不会在选中时被丢掉。 */
export function markSelection(list: HTMLElement, selectedId: string | null): void {
  for (const item of Array.from(list.children)) {
    const id = item.getAttribute('data-movie-id');
    if (id === null) continue;
    const button = item.querySelector('button');
    if (button === null) continue;
    button.setAttribute('aria-pressed', id === selectedId ? 'true' : 'false');
  }
}
