import type { RankedMovie } from '../core/types.js';
import { el, formatScore, svgEl } from './dom.js';

const WIDTH = 720;
const HEIGHT = 400;
const MARGIN = { top: 30, right: 26, bottom: 48, left: 58 };

function scaleX(value: number): number {
  const span = WIDTH - MARGIN.left - MARGIN.right;
  return MARGIN.left + Math.min(1, Math.max(0, value)) * span;
}

function scaleY(value: number): number {
  const span = HEIGHT - MARGIN.top - MARGIN.bottom;
  return HEIGHT - MARGIN.bottom - Math.min(1, Math.max(0, value)) * span;
}

function axisText(x: number, y: number, text: string, className: string): SVGTextElement {
  const node = svgEl('text', { x, y, class: className });
  node.textContent = text;
  return node;
}

export function renderAtlas(
  container: HTMLElement,
  summary: HTMLElement,
  table: HTMLElement,
  rows: readonly RankedMovie[],
  selectedId: string | null,
  onSelect: (id: string) => void,
): void {
  const moved = rows.filter((row) => row.deltaRank !== 0).length;

  summary.replaceChildren(
    el(
      'p',
      'atlas-line',
      `${rows.length} candidates · ${moved} changed rank. The horizontal axis is the synthetic relation score and the vertical axis is the tag difference; this is an observable synthetic coordinate space, not a real taste space.`,
    ),
  );

  const svg = svgEl('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    class: 'atlas-svg',
    role: 'group',
    'aria-label': 'Synthetic coordinate scatter: horizontal axis is the synthetic relation score, vertical axis is the tag difference',
  });
  // 网格与坐标轴
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const x = scaleX(tick);
    const y = scaleY(tick);
    svg.append(
      svgEl('line', {
        x1: x,
        y1: MARGIN.top,
        x2: x,
        y2: HEIGHT - MARGIN.bottom,
        class: 'atlas-grid',
      }),
      svgEl('line', {
        x1: MARGIN.left,
        y1: y,
        x2: WIDTH - MARGIN.right,
        y2: y,
        class: 'atlas-grid',
      }),
    );
    svg.append(
      axisText(x, HEIGHT - MARGIN.bottom + 18, tick.toFixed(2), 'atlas-tick'),
      axisText(MARGIN.left - 10, y + 4, tick.toFixed(2), 'atlas-tick atlas-tick-y'),
    );
  }

  svg.append(
    svgEl('line', {
      x1: MARGIN.left,
      y1: MARGIN.top,
      x2: MARGIN.left,
      y2: HEIGHT - MARGIN.bottom,
      class: 'atlas-axis',
    }),
    svgEl('line', {
      x1: MARGIN.left,
      y1: HEIGHT - MARGIN.bottom,
      x2: WIDTH - MARGIN.right,
      y2: HEIGHT - MARGIN.bottom,
      class: 'atlas-axis',
    }),
    axisText(WIDTH - MARGIN.right, HEIGHT - 12, 'Synthetic relation →', 'atlas-axis-title atlas-axis-title-x'),
    axisText(MARGIN.left - 44, MARGIN.top - 12, 'Tag difference ↑', 'atlas-axis-title'),
  );

  const points: SVGElement[] = [];
  let activeIndex = rows.findIndex((row) => row.id === selectedId);
  if (activeIndex < 0) activeIndex = 0;

  rows.forEach((row, index) => {
    const cx = scaleX(row.relation);
    const cy = scaleY(row.distance);
    const isSelected = row.id === selectedId;

    if (isSelected) {
      svg.append(svgEl('circle', { cx, cy, r: 9, class: 'atlas-ring' }));
    }

    const point = svgEl('circle', {
      cx,
      cy,
      r: row.deltaRank === 0 ? 4 : 5,
      class: row.deltaRank === 0 ? 'atlas-point' : 'atlas-point is-moved',
      tabindex: index === activeIndex ? 0 : -1,
      role: 'button',
      'aria-pressed': isSelected ? 'true' : 'false',
    });
    point.setAttribute('data-movie-id', row.id);
    point.setAttribute(
      'aria-label',
      `${row.title}, relation ${row.relation.toFixed(2)}, tag difference ${row.distance.toFixed(2)}, currently rank ${row.rank}`,
    );
    const title = svgEl('title');
    title.textContent = `${row.title} · #${row.rank} · score ${formatScore(row.score)}`;
    point.append(title);

    point.addEventListener('click', () => onSelect(row.id));
    point.addEventListener('focus', () => {
      activeIndex = index;
    });
    point.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect(row.id);
        return;
      }

      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (step === 0) return;
      event.preventDefault();

      const nextIndex = (index + step + rows.length) % rows.length;
      const next = points[nextIndex];
      if (next === undefined) return;
      for (const other of points) other.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    });

    points.push(point);
    svg.append(point);
  });

  const legend = el('div', 'atlas-legend');
  legend.append(
    el('span', 'legend-item', '● changed rank'),
    el('span', 'legend-item', '○ rank unchanged'),
    el('span', 'legend-item', '◎ currently selected'),
    el('span', 'legend-item', 'Move point by point with the arrow keys, select with Enter'),
  );

  container.replaceChildren(svg, legend);

  if (rows.length === 0) {
    table.replaceChildren(el('p', 'compare-empty', 'The current candidate set is empty, so there are no coordinates to show.'));
    return;
  }

  const list = el('table', 'atlas-list');
  const head = el('thead');
  const headRow = el('tr');
  for (const heading of ['Film', 'Relation', 'Difference', 'Rank']) {
    const cell = el('th', undefined, heading);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  }
  head.append(headRow);
  list.append(head);

  // 散点图是主视图，这里只作为文字备用清单，列出前 20 名并说明其余去哪看。
  const shown = rows.slice(0, 20);
  const body = el('tbody');
  for (const row of shown) {
    const tr = el('tr');
    tr.setAttribute('data-movie-id', row.id);
    if (row.id === selectedId) tr.classList.add('is-selected');
    const title = el('th', 'compare-title', row.title);
    title.setAttribute('scope', 'row');
    tr.append(
      title,
      el('td', 'compare-num', row.relation.toFixed(2)),
      el('td', 'compare-num', row.distance.toFixed(2)),
      el('td', 'compare-num', String(row.rank)),
    );
    body.append(tr);
  }
  list.append(body);

  const nodes: HTMLElement[] = [list];
  if (rows.length > shown.length) {
    nodes.push(
      el(
        'p',
        'atlas-note',
        `Only the top ${shown.length} are listed here; the other ${rows.length - shown.length} are in the “Ranking” view.`,
      ),
    );
  }
  table.replaceChildren(...nodes);
}

/**
 * 只改选中态，不重建散点图：键盘选中一个点时焦点必须留在那个点上，
 * 所以这里不能像重新渲染那样把 SVG 换掉。
 */
export function updateAtlasSelection(
  container: HTMLElement,
  table: HTMLElement,
  selectedId: string | null,
): void {
  const svg = container.querySelector('svg');
  if (svg !== null) {
    const points = Array.from(svg.querySelectorAll('circle[data-movie-id]'));
    for (const point of points) {
      point.setAttribute(
        'aria-pressed',
        point.getAttribute('data-movie-id') === selectedId ? 'true' : 'false',
      );
    }

    svg.querySelector('.atlas-ring')?.remove();
    if (selectedId !== null) {
      const point = svg.querySelector(`circle[data-movie-id="${CSS.escape(selectedId)}"]`);
      if (point !== null) {
        const ring = svgEl('circle', {
          cx: point.getAttribute('cx') ?? 0,
          cy: point.getAttribute('cy') ?? 0,
          r: 9,
          class: 'atlas-ring',
        });
        point.before(ring);
      }
    }
  }

  for (const row of Array.from(table.querySelectorAll('tr'))) {
    row.classList.toggle('is-selected', row.getAttribute('data-movie-id') === selectedId);
  }
}
