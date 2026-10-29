import {
  DEFAULT_CONTROLS,
  DEFAULT_SETTINGS,
  freezeDataset,
  rankDataset,
} from '../core/ranking.js';
import {
  MAX_SCENARIO_FILE_BYTES,
  parseScenarioFile,
  serializeScenarioFile,
} from '../core/scenario-io.js';
import { createImportIntent } from '../core/import-intent.js';
import { defaultScenarioId, findScenario, scenarios } from '../adapters/scenarios.js';
import type {
  Exclusion,
  FrozenDataset,
  RankedList,
  RankedMovie,
  Settings,
  SyntheticDataset,
} from '../core/types.js';
import { createView, type ModeId, type ViewId } from './view.js';
import { animateReorder, markSelection, renderList, snapshotPositions } from './list.js';
import { renderEvidence } from './evidence.js';
import { renderCompare, type CompareSide } from './compare.js';
import { renderAtlas, updateAtlasSelection } from './atlas.js';
import { createServiceApi, createServiceController } from './service.js';
import { el, prefersReducedMotion } from './dom.js';

interface Source {
  readonly id: string;
  readonly label: string;
  readonly raw: SyntheticDataset;
  readonly frozen: FrozenDataset;
  readonly excluded: readonly Exclusion[];
}

const root = document.getElementById('app');
if (root === null) {
  throw new Error('TasteTuner: missing #app mount point');
}

const view = createView(root, scenarios);

// 场景数据是常量，校验结果也是常量：缓存起来，避免每次重排都把Comparison scenario重新校验一遍。
// 必须在下面第一次调用 loadScenario 之前声明，否则会撞上 TDZ。
const scenarioCache = new Map<string, Source>();

let source: Source = loadScenario(defaultScenarioId);
let settings: Settings = DEFAULT_SETTINGS;
let selectedId: string | null = null;
let activeView: ViewId = 'console';
let compareMode: 'baseline' | 'scenario' = 'baseline';
let compareScenarioId: string = scenarios[1]?.id ?? defaultScenarioId;
view.compareScenario.value = compareScenarioId;
let ranking: RankedList = rankDataset(source.frozen, settings);
let pendingFrame: number | null = null;
let announceTimer: number | null = null;
const importIntent = createImportIntent((pending) => {
  view.importStatus.textContent = pending
    ? 'Reading the local JSON; the current scenario stays unchanged.'
    : '';
  view.importStatus.hidden = !pending;
});

function loadScenario(id: string): Source {
  const cached = scenarioCache.get(id);
  if (cached !== undefined) return cached;

  const scenario = findScenario(id);
  if (scenario === undefined) {
    throw new Error(`Unknown scenario: ${id}`);
  }
  const frozen = freezeDataset(scenario.dataset);
  if (!frozen.ok) {
    throw new Error(`Scenario ${id} did not pass validation: ${frozen.issues.join('; ')}`);
  }
  const source: Source = {
    id: scenario.id,
    label: scenario.label,
    raw: scenario.dataset,
    frozen: frozen.dataset,
    excluded: frozen.excluded,
  };
  scenarioCache.set(id, source);
  return source;
}

function seedTagCount(current: Source): number {
  return new Set(current.frozen.seed.tagIds).size;
}

function announce(message: string): void {
  view.live.textContent = message;
}

/** 清掉播报区：换模式时用，免得上一条（可能还是合成数据的）留在页面上。 */
function clearAnnouncement(): void {
  view.live.textContent = '';
}

function announceSoon(): void {
  if (announceTimer !== null) window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    announceTimer = null;
    const moved = ranking.rows.filter((row) => row.deltaRank !== 0).length;
    announce(
      ranking.rows.length === 0
        ? 'The current candidate set is empty, there is nothing to rank'
        : `Ranking updated: ${ranking.rows.length} candidates, ${moved} reordered`,
    );
  }, 400);
}

function showError(issues: readonly string[]): void {
  if (issues.length === 0) {
    view.error.hidden = true;
    view.error.replaceChildren();
    return;
  }

  const panel = el('div', 'error-panel');
  panel.tabIndex = -1;
  panel.append(el('p', 'error-title', 'The action did not complete'));
  const list = el('ul', 'issues-list');
  for (const issue of issues) {
    list.append(el('li', 'issue', issue));
  }
  panel.append(list);

  const dismiss = el('button', 'button-secondary', 'Got it');
  dismiss.type = 'button';
  dismiss.addEventListener('click', () => showError([]));
  panel.append(dismiss);

  view.error.replaceChildren(panel);
  view.error.hidden = false;
  view.error.scrollIntoView({ block: 'nearest' });
  // 焦点落到错误面板上，键盘用户不会错过发生了什么。
  panel.focus();
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

function renderSeedCard(current: Source): void {
  const tags = el('ul', 'tag-list');
  for (const tagId of current.frozen.seed.tagIds) {
    const label = current.frozen.tags[tagId];
    if (typeof label !== 'string') continue;
    tags.append(el('li', 'tag', label));
  }

  view.seedCard.replaceChildren(
    el('p', 'seed-label', `Fictional seed · ${current.label}`),
    el('h3', 'seed-title', current.frozen.seed.title),
    tags,
  );
}

function renderSharedOptions(max: number, current: number): void {
  const nodes: HTMLElement[] = [];
  for (let value = 0; value <= max; value += 1) {
    const id = `shared-${value}`;
    const input = el('input', 'mode-radio');
    input.type = 'radio';
    input.name = 'shared';
    input.id = id;
    input.value = String(value);
    input.checked = value === current;

    const label = el('label', 'mode-label', value === 0 ? 'No filter' : `≥ ${value}`);
    label.htmlFor = id;

    nodes.push(input, label);
  }
  view.sharedContainer.replaceChildren(...nodes);
}

function renderNotices(list: RankedList): void {
  const nodes: HTMLElement[] = [];

  if (source.excluded.length > 0) {
    const details = el('details', 'notice');
    details.append(
      el(
        'summary',
        'notice-summary',
        `Dropped for incomplete data: ${source.excluded.length}`,
      ),
    );
    const items = el('ul', 'notice-list');
    for (const exclusion of source.excluded) {
      items.append(el('li', '', `${exclusion.title} — ${exclusion.reasons.join(', ')}`));
    }
    details.append(items);
    nodes.push(details);
  }

  if (list.dropped.length > 0) {
    const details = el('details', 'notice');
    details.append(
      el(
        'summary',
        'notice-summary',
        `Blocked by the minimum shared tags rule: ${list.dropped.length}`,
      ),
    );
    const items = el('ul', 'notice-list');
    for (const dropped of list.dropped) {
      items.append(el('li', '', `${dropped.title} — ${dropped.reason}`));
    }
    details.append(items);
    nodes.push(details);
  }

  view.notices.replaceChildren(...nodes);
}

function renderStatus(list: RankedList): void {
  const moved = list.rows.filter((row) => row.deltaRank !== 0).length;
  view.status.textContent =
    `${list.rows.length} candidates · ${moved} reordered · ` +
    `relation ${settings.controls.relationWeight} / difference ${settings.controls.tagDifference} · ` +
    `minimum shared ${settings.minSharedTags}`;
}

function compareSide(
  current: Source,
  list: RankedList,
  effectiveMinSharedTags: number,
): CompareSide {
  return {
    id: current.id,
    label: current.label,
    list,
    excluded: current.excluded.length,
    effectiveMinSharedTags,
  };
}

function renderActiveViewExtras(): void {
  // 只有跨场景模式才需要选择Comparison scenario，其他模式下这个控件没有意义。
  view.compareScenarioField.hidden = compareMode !== 'scenario';

  if (activeView === 'compare') {
    const other = findScenario(compareScenarioId);
    const otherSource = other === undefined ? null : loadScenario(compareScenarioId);
    const otherEffectiveMinSharedTags =
      otherSource !== null && otherSource.id === source.id
        ? settings.minSharedTags
        : otherSource === null
          ? settings.minSharedTags
          : Math.min(settings.minSharedTags, seedTagCount(otherSource));
    const otherList =
      otherSource === null
        ? null
        : rankDataset(otherSource.frozen, {
            controls: settings.controls,
            minSharedTags: otherEffectiveMinSharedTags,
          });
    renderCompare(
      view.compareSummary,
      view.compareBody,
      compareMode,
      compareSide(source, ranking, settings.minSharedTags),
      otherSource !== null && otherList !== null
        ? compareSide(otherSource, otherList, otherEffectiveMinSharedTags)
        : null,
    );
  }

  if (activeView === 'explore') {
    renderAtlas(
      view.atlas,
      view.atlasSummary,
      view.atlasTable,
      ranking.rows,
      selectedId,
      selectMovie,
    );
  }
}

function emptyHint(): string | undefined {
  if (ranking.rows.length > 0) return undefined;
  // 提示要跟着真实原因走：只有确实被硬约束挡下过，才建议把阈值调回 0。
  if (ranking.dropped.length > 0) {
    return `Setting “minimum shared tags” back to 0 restores the ${ranking.dropped.length} candidates that were blocked.`;
  }
  if (source.excluded.length > 0) {
    return `All ${source.excluded.length} films in this scenario are dropped for incomplete data; pick another scenario to continue.`;
  }
  return undefined;
}

function render(options: { animate?: boolean } = {}): void {
  ranking = rankDataset(source.frozen, settings);

  if (selectedId !== null && !ranking.rows.some((row) => row.id === selectedId)) {
    selectedId = null;
  }

  const previous = options.animate === true ? snapshotPositions(view.list) : new Map<string, number>();
  renderList(
    view.list,
    ranking.rows,
    selectedId,
    selectMovie,
    emptyHint(),
  );
  if (options.animate === true) {
    animateReorder(view.list, previous);
  }

  renderStatus(ranking);
  renderNotices(ranking);

  const selected: RankedMovie | null =
    ranking.rows.find((row) => row.id === selectedId) ?? null;
  renderEvidence(view.evidence, selected);
  renderActiveViewExtras();
}

function scheduleRender(animate: boolean): void {
  if (pendingFrame !== null) window.cancelAnimationFrame(pendingFrame);
  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = null;
    render({ animate });
  });
}

function selectMovie(id: string, announceSelection = true): void {
  selectedId = id;
  markSelection(view.list, id);
  const row = ranking.rows.find((item) => item.id === id);
  renderEvidence(view.evidence, row ?? null);
  if (activeView === 'explore') {
    // 只更新选中态，不重建散点图，否则键盘焦点会跟着被换掉的节点一起消失。
    updateAtlasSelection(view.atlas, view.atlasTable, id);
  }
  // 默认选中（进页面时的那一次）**不播报**：用户还没选过什么，
  // 而且这条播报不该在真实主线里出现——那是合成场景的片子。
  if (row !== undefined && announceSelection) {
    announce(
      row.deltaRank === 0
        ? `Selected ${row.title}, currently rank ${row.rank}, rank unchanged`
        : `Selected ${row.title}, currently rank ${row.rank}, ${row.deltaRank > 0 ? 'up' : 'down'} ${Math.abs(row.deltaRank)} places from default`,
    );
  }

  // 窄屏时解释面板在榜单上方，选中后把它带进视野，否则解释会看不见。
  if (window.matchMedia('(max-width: 1199px)').matches) {
    view.evidence.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }
}

function syncControls(): void {
  view.relationRange.value = String(settings.controls.relationWeight);
  view.relationValue.value = String(settings.controls.relationWeight);
  view.differenceRange.value = String(settings.controls.tagDifference);
  view.differenceValue.value = String(settings.controls.tagDifference);
  renderSharedOptions(seedTagCount(source), settings.minSharedTags);
}

function activateView(id: ViewId): void {
  activeView = id;
  for (const tab of view.tabs) {
    const isActive = tab.dataset.view === id;
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1;
  }
  for (const [key, panel] of Object.entries(view.panels)) {
    panel.hidden = key !== id;
  }
  renderActiveViewExtras();
}

function isViewId(value: string | undefined): value is ViewId {
  return value === 'console' || value === 'compare' || value === 'explore';
}

// 事件绑定
view.relationRange.addEventListener('input', () => {
  settings = {
    controls: {
      relationWeight: Number(view.relationRange.value),
      tagDifference: settings.controls.tagDifference,
    },
    minSharedTags: settings.minSharedTags,
  };
  view.relationValue.value = view.relationRange.value;
  scheduleRender(true);
  announceSoon();
});

view.differenceRange.addEventListener('input', () => {
  settings = {
    controls: {
      relationWeight: settings.controls.relationWeight,
      tagDifference: Number(view.differenceRange.value),
    },
    minSharedTags: settings.minSharedTags,
  };
  view.differenceValue.value = view.differenceRange.value;
  scheduleRender(true);
  announceSoon();
});

view.sharedContainer.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const value = Number(target.value);
  if (!Number.isInteger(value)) return;
  settings = { controls: settings.controls, minSharedTags: value };
  render({ animate: true });
  announce(
    value === 0
      ? 'Minimum shared tags filter cleared'
      : `Now requires at least ${value} shared tags`,
  );
});

view.reset.addEventListener('click', () => {
  importIntent.invalidate();
  settings = DEFAULT_SETTINGS;
  syncControls();
  render();
  const first = ranking.rows[0];
  if (first !== undefined) {
    selectMovie(first.id);
  }
  announce('Weights reset to defaults');
});

for (const input of view.scenarioInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    importIntent.invalidate();
    const next = loadScenario(input.value);
    const max = seedTagCount(next);
    let clamped = false;
    let minSharedTags = settings.minSharedTags;
    if (minSharedTags > max) {
      minSharedTags = max;
      clamped = true;
    }
    source = next;
    settings = { controls: settings.controls, minSharedTags };
    selectedId = null;
    showError([]);
    renderSeedCard(source);
    syncControls();
    render();
    const first = ranking.rows[0];
    if (first !== undefined) {
      selectMovie(first.id);
    }
    announce(
      clamped
        ? `Switched to ${next.label}; minimum shared tags is now ${max}`
        : `Switched to ${next.label}`,
    );
  });
}

view.tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => {
    if (!isViewId(tab.dataset.view)) return;
    activateView(tab.dataset.view);
  });

  tab.addEventListener('keydown', (event) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? view.tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + view.tabs.length) %
            view.tabs.length;
    const target = view.tabs[next];
    if (target === undefined) return;
    if (!isViewId(target.dataset.view)) return;
    activateView(target.dataset.view);
    target.focus();
  });
});

for (const input of view.compareModes) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    compareMode = input.value === 'scenario' ? 'scenario' : 'baseline';
    renderActiveViewExtras();
  });
}

view.compareScenario.addEventListener('change', () => {
  compareScenarioId = view.compareScenario.value;
  if (compareMode !== 'scenario') {
    compareMode = 'scenario';
    for (const input of view.compareModes) {
      input.checked = input.value === 'scenario';
    }
  }
  renderActiveViewExtras();
});

view.exportButton.addEventListener('click', () => {
  let text: string;
  try {
    text = serializeScenarioFile(source.raw, settings);
  } catch (error) {
    showError([`Export failed: ${describeError(error)}`]);
    announce('Export failed; the current scenario is unchanged');
    return;
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a');
  link.href = url;
  link.download = `taste-tuner-${source.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  announce('Scenario JSON file exported');
});

view.importButton.addEventListener('click', () => {
  view.importInput.click();
});

view.importInput.addEventListener('change', () => {
  const file = view.importInput.files?.[0];
  view.importInput.value = '';
  // 任何新选择先使旧读取失效，文件大小或内容无效也不例外。
  importIntent.invalidate();
  if (file === undefined) return;

  if (file.size > MAX_SCENARIO_FILE_BYTES) {
    showError([
      `File too large (${file.size} bytes); the limit is ${MAX_SCENARIO_FILE_BYTES} bytes`,
    ]);
    announce('Import failed; the current scenario is unchanged');
    return;
  }

  void importIntent.run(() => file.text()).then((outcome) => {
    // 旧请求的成功或失败都不能再修改界面、焦点或Current场景。
    if (outcome.status === 'stale') return;
    if (!outcome.ok) {
      showError([`Could not read the imported file: ${describeError(outcome.error)}`]);
      announce('Import failed; the current scenario is unchanged');
      return;
    }

    const parsed = parseScenarioFile(outcome.value);
    if (!parsed.ok) {
      showError(parsed.issues);
      announce('Import failed; the current scenario is unchanged');
      return;
    }

    source = {
      id: 'imported',
      label: `Imported file ${file.name}`,
      raw: parsed.value.raw,
      frozen: parsed.value.dataset,
      excluded: parsed.value.excluded,
    };
    settings = parsed.value.settings;
    selectedId = null;
    showError([]);
    // 导入的数据不属于任何内置场景，所以场景选择器不能继续显示旧的高亮项。
    for (const input of view.scenarioInputs) {
      input.checked = false;
    }
    renderSeedCard(source);
    syncControls();
    render();
    const imported = ranking.rows[0];
    if (imported !== undefined) {
      selectMovie(imported.id);
    }
    announce(`Scenario imported: ${ranking.rows.length} candidates`);
  });
});

// Live service是主线，Offline synthetic demo是显式隔开的第二条路。
let mode: ModeId = 'service';
let serviceCredentialPresent: boolean | null = null;
/** 用的是哪条接入面——回放与Live service要说不同的话。 */
let serviceAccessSurface: string | null = null;
/** 状态拿不到（服务起不来 / 响应形状不对）：界面要如实说"用不了"。 */
let serviceUnavailable = false;

function setMode(next: ModeId): void {
  if (mode !== next) {
    // 换模式时清掉播报：上一条可能是合成场景的，不能留在真实主线的页面上。
    clearAnnouncement();
  }
  mode = next;
  view.serviceRoot.hidden = next !== 'service';
  view.demoRoot.hidden = next !== 'demo';
  for (const input of view.modeInputs) input.checked = input.value === next;

  if (next === 'service') {
    // 徽标与状态行要说同一件事：工具装着不等于连得上。
    // **回放**也在这里：那时候没有Live service，徽标不能写"Live service"。
    if (serviceAccessSurface === 'saved-response-replay') {
      view.badge.textContent = 'Replay · cached responses';
      view.sourceNote.textContent =
        'This is a cached replay: the candidates and explanations come from responses saved on this machine. No live service was called and no request budget was spent.';
    } else {
      view.badge.textContent = serviceUnavailable
        ? 'Live service · unavailable'
        : serviceCredentialPresent === true
          ? 'Live service · ready'
          : serviceCredentialPresent === false
            ? 'Live service · no credential'
            : 'Live service';
      view.sourceNote.textContent =
        'Credentials are used on the server only: they never reach the browser or the logs, and the page only talks to same-origin /api.';
    }
    view.introHeading.textContent = 'From a film you love to the one you want next';
    view.introCopy.textContent =
      'Type a film you have watched to find similar ones. Reorder them to taste — no new requests are sent.';
    // Live service那一侧不需要再贴一遍模式说明：徽标已经说清楚了。
    view.modeBanner.textContent = '';
  } else {
    view.badge.textContent = 'Synthetic data · offline demo';
    // 演示模式不依赖服务状态：话已经说准了，胶囊直接显形。
    view.badge.classList.add('is-ready');
    // 演示模式讲的是另一件事：标题也得跟着换，不能还写着"Find similar films"。
    view.introHeading.textContent = 'Understand a ranking change';
    view.introCopy.textContent =
      'Pick a synthetic scenario, move the two weights, and see why each film stays where it is. All of the data is fictional.';
    view.modeBanner.textContent =
      'Offline demo mode: everything below is synthetic data, not a result from the live service.';
    view.sourceNote.textContent =
      'All titles, tags and relation scores are synthetic; this section calls no live service.';
  }
}

view.modeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (input.checked) setMode(input.value as ModeId);
  });
});

const serviceController = createServiceController(view.service, createServiceApi(), {
  onStatus: (status) => {
    serviceCredentialPresent = status.credentialPresent ?? null;
    serviceAccessSurface = status.accessSurface ?? null;
    // 状态**拿不到**时（服务起不来、响应形状不对）：accessSurface 是 unknown。
    // 这时徽标不能还写"Live service"——那看上去像一切正常。
    serviceUnavailable = status.accessSurface === 'unknown';
    if (mode === 'service') setMode('service');
    // 状态真的回来了（200），胶囊才淡入：位宽早就留好了，换字不推东西。
    view.badge.classList.add('is-ready');
  },
});

// 首屏
renderSeedCard(source);
syncControls();
render();
const first = ranking.rows[0];
if (first !== undefined) {
  // 首屏的默认选中不是用户动作：不播报（否则合成片名会漏进真实主线）。
  selectMovie(first.id, false);
}
setMode('service');
void serviceController.start();

export {};
