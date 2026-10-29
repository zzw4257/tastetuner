import { el, svgEl } from './dom.js';
import type { Scenario } from '../adapters/scenarios.js';
import { createServiceView, type ServiceView } from './service.js';

export type ViewId = 'console' | 'compare' | 'explore';
export type ModeId = 'service' | 'demo';

export interface View {
  readonly root: HTMLElement;
  readonly error: HTMLElement;
  readonly live: HTMLDivElement;
  readonly badge: HTMLElement;
  readonly introCopy: HTMLElement;
  readonly introHeading: HTMLElement;
  readonly modeInputs: readonly HTMLInputElement[];
  readonly modeBanner: HTMLElement;
  readonly sourceNote: HTMLElement;
  readonly serviceRoot: HTMLElement;
  readonly demoRoot: HTMLElement;
  readonly service: ServiceView;
  readonly seedCard: HTMLElement;
  readonly sharedContainer: HTMLElement;
  readonly notices: HTMLElement;
  readonly relationRange: HTMLInputElement;
  readonly relationValue: HTMLOutputElement;
  readonly differenceRange: HTMLInputElement;
  readonly differenceValue: HTMLOutputElement;
  readonly reset: HTMLButtonElement;
  readonly scenarioInputs: readonly HTMLInputElement[];
  readonly tabs: readonly HTMLButtonElement[];
  readonly panels: Readonly<Record<ViewId, HTMLElement>>;
  readonly list: HTMLOListElement;
  readonly status: HTMLParagraphElement;
  readonly compareModes: readonly HTMLInputElement[];
  readonly compareScenario: HTMLSelectElement;
  readonly compareScenarioField: HTMLElement;
  readonly compareSummary: HTMLElement;
  readonly compareBody: HTMLElement;
  readonly atlasSummary: HTMLElement;
  readonly atlas: HTMLElement;
  readonly atlasTable: HTMLElement;
  readonly evidence: HTMLElement;
  readonly exportButton: HTMLButtonElement;
  readonly importButton: HTMLButtonElement;
  readonly importInput: HTMLInputElement;
  readonly importStatus: HTMLParagraphElement;
}

/**
 * 品牌标记：public/favicon.svg 的几何原样内联成 SVG。
 *
 * 内联而不是 <img>：省一次请求，而且颜色走 CSS（.bm-tile/.bm-bar），
 * 柱子的入场动画才能直接作用在 SVG 元素上。
 */
function brandMark(): SVGSVGElement {
  const svg = svgEl('svg', {
    class: 'brand-mark',
    viewBox: '0 0 32 32',
    width: 32,
    height: 32,
    'aria-hidden': 'true',
  });
  svg.append(
    svgEl('rect', { class: 'bm-tile', width: 32, height: 32, rx: 8 }),
    // 三根柱子共用同一条基线 y=24：矮的是已有一部的，高度差就是下一部的位置。
    svgEl('rect', { class: 'bm-bar b1', x: 8, y: 17, width: 4, height: 7 }),
    svgEl('rect', { class: 'bm-bar b2', x: 14, y: 11, width: 4, height: 13 }),
    svgEl('rect', { class: 'bm-bar b3', x: 20, y: 8, width: 4, height: 16 }),
  );
  return svg;
}

function createChrome(): {
  shell: HTMLDivElement;
  badge: HTMLElement;
  introCopy: HTMLElement;
  introHeading: HTMLElement;
} {
  const shell = el('div', 'app-shell');

  const masthead = el('header', 'masthead');
  const badge = el('p', 'demo-badge', 'Checking the live service…');
  const brand = el('a', 'brand');
  brand.href = '/';
  // 窄屏会藏掉字标，标记本身是 aria-hidden —— 没有这句这个链接就没有可访问名。
  brand.setAttribute('aria-label', 'TasteTuner');
  brand.append(brandMark(), el('span', 'brand-word', 'TasteTuner'));
  masthead.append(brand, badge);

  const intro = el('section', 'intro');
  const introCopy = el(
    'p',
    'intro-copy',
    'Type a film you have watched to find similar ones. Reorder them to taste — no new requests are sent.',
  );
  const introHeading = el('h1', '', 'From a film you love to the one you want next');
  intro.append(el('p', 'eyebrow', 'Film discovery'), introHeading, introCopy);

  shell.append(masthead, intro);
  return { shell, badge, introCopy, introHeading };
}

function createScenarioPicker(
  scenarios: readonly Scenario[],
): { panel: HTMLElement; inputs: HTMLInputElement[] } {
  const panel = el('section', 'scenario-panel');
  panel.append(el('h2', 'section-kicker', 'Synthetic scenario'));

  const group = el('fieldset', 'scenario-grid');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Synthetic scenario');

  const inputs: HTMLInputElement[] = [];
  scenarios.forEach((scenario, index) => {
    const id = `scenario-${scenario.id}`;
    const input = el('input', 'scenario-radio');
    input.type = 'radio';
    input.name = 'scenario';
    input.id = id;
    input.value = scenario.id;
    if (index === 0) input.checked = true;

    const label = el('label', 'scenario-card');
    label.htmlFor = id;
    label.append(
      el('span', 'scenario-label', scenario.label),
      el('span', 'scenario-summary', scenario.summary),
      el(
        'span',
        'scenario-highlights',
        scenario.highlights.join(' · '),
      ),
    );

    group.append(input, label);
    inputs.push(input);
  });

  panel.append(group);
  return { panel, inputs };
}

function createSlider(
  id: string,
  labelText: string,
  hintText: string,
  value: number,
): {
  block: HTMLElement;
  range: HTMLInputElement;
  output: HTMLOutputElement;
} {
  const block = el('div', 'control-block');

  const label = el('label', 'control-label');
  label.htmlFor = id;
  const output = el('output', 'control-value');
  output.setAttribute('for', id);
  output.value = String(value);
  label.append(el('span', 'control-label-text', labelText), output);

  const range = el('input', 'range-input');
  range.id = id;
  range.type = 'range';
  range.min = '0';
  range.max = '100';
  range.step = '1';
  range.value = String(value);
  range.setAttribute('aria-describedby', `${id}-hint`);

  const endpoints = el('div', 'range-endpoints');
  endpoints.append(el('span', '', '0'), el('span', '', '100'));

  const hint = el('p', 'hint', hintText);
  hint.id = `${id}-hint`;

  block.append(label, range, endpoints, hint);
  return { block, range, output };
}

function createTabs(): {
  tablist: HTMLElement;
  tabs: HTMLButtonElement[];
  panels: Record<ViewId, HTMLElement>;
} {
  const labels: readonly [ViewId, string][] = [
    ['console', 'Ranking'],
    ['compare', 'Compare'],
    ['explore', 'Explore'],
  ];

  const tablist = el('div', 'tablist');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'View switcher');

  const tabs: HTMLButtonElement[] = [];
  const panels = {} as Record<ViewId, HTMLElement>;

  labels.forEach(([id, text], index) => {
    const tab = el('button', 'tab', text);
    tab.type = 'button';
    tab.id = `tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    tab.setAttribute('aria-controls', `panel-${id}`);
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.dataset.view = id;

    const panel = el('section', 'view-panel');
    panel.id = `panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${id}`);
    panel.tabIndex = 0;
    if (index !== 0) panel.hidden = true;

    tablist.append(tab);
    panels[id] = panel;
    tabs.push(tab);
  });

  return { tablist, tabs, panels };
}

export function createView(
  root: HTMLElement,
  scenarios: readonly Scenario[],
): View {
  const { shell, badge, introCopy, introHeading } = createChrome();

  // Live service是主线，Offline synthetic demo是显式隔开的第二条路。
  // 但它不该站在消费界面正中——收进Developer diagnostics里，Default不打扰找片的人。
  const devPanel = el('details', 'dev-panel shell-dev-panel');
  devPanel.append(el('summary', 'dev-summary', 'Developer diagnostics'));
  // Live service那侧的诊断内容也放进这个折叠区：页脚只有一个"Developer diagnostics"。
  const devBody = el('div', 'dev-body');
  devPanel.append(devBody);
  const modeGroup = el('fieldset', 'mode-switch');
  modeGroup.setAttribute('role', 'radiogroup');
  modeGroup.setAttribute('aria-label', 'Working mode');
  modeGroup.append(el('legend', 'control-label-text', 'Working mode'));
  const modeInputs: HTMLInputElement[] = [];
  const modeSwitchOptions: readonly [ModeId, string][] = [
    ['service', 'Live service'],
    ['demo', 'Offline synthetic demo'],
  ];
  modeSwitchOptions.forEach(([value, text], index) => {
    const id = `mode-${value}`;
    const input = el('input', 'mode-radio');
    input.type = 'radio';
    input.name = 'mode';
    input.id = id;
    input.value = value;
    if (index === 0) input.checked = true;
    const label = el('label', 'mode-label', text);
    label.htmlFor = id;
    modeGroup.append(input, label);
    modeInputs.push(input);
  });
  devBody.append(modeGroup);

  // 模式说明只在离线演示时出现——Live service那一侧不需要再说一遍。
  const modeBanner = el('p', 'mode-banner');

  const service = createServiceView(devBody);
  const serviceRoot = service.root;
  shell.append(serviceRoot);

  const demoRoot = el('section', 'demo-mode');
  demoRoot.id = 'demo-mode';
  demoRoot.setAttribute('aria-labelledby', 'demo-mode-heading');
  const demoHeading = el('h2', 'mode-heading', 'Offline synthetic demo');
  demoHeading.id = 'demo-mode-heading';
  demoRoot.append(
    modeBanner,
    demoHeading,
    el(
      'p',
      'mode-note',
      'Everything in this section is hand-made fictional data: titles, tags and relation scores are invented. It is not a response from any live service and it is nobody’s taste. It exists to demonstrate how ranking and explanations behave.',
    ),
  );

  const error = el('div', 'error-message');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  demoRoot.append(error);

  const scenario = createScenarioPicker(scenarios);
  demoRoot.append(scenario.panel);

  const { tablist, tabs, panels } = createTabs();
  const tabRow = el('div', 'tab-row');
  tabRow.append(tablist);
  demoRoot.append(tabRow);

  const main = el('main', 'workspace');

  const controls = el('section', 'controls-panel');
  controls.setAttribute('aria-labelledby', 'controls-heading');
  controls.append(el('h2', '', 'Tune the direction'));
  controls.firstElementChild?.setAttribute('id', 'controls-heading');

  const seedCard = el('div', 'seed-card');
  controls.append(seedCard);

  const relation = createSlider(
    'relation-weight',
    'Relation weight',
    'Scales the synthetic relation score into the base score. At 0 only tag differences count.',
    80,
  );
  controls.append(relation.block);

  const difference = createSlider(
    'tag-difference',
    'Tag difference weight',
    'The less the tags overlap, the higher the bonus, up to 20 points. It never adds films.',
    0,
  );
  controls.append(difference.block);

  const sharedBlock = el('div', 'control-block');
  sharedBlock.append(el('h3', 'control-heading', 'Minimum shared tags'));
  const sharedContainer = el('div', 'shared-options');
  sharedContainer.setAttribute('role', 'radiogroup');
  sharedContainer.setAttribute('aria-label', 'Minimum number of shared tags');
  sharedBlock.append(sharedContainer);
  controls.append(sharedBlock);

  const reset = el('button', 'button-secondary', 'Reset to defaults');
  reset.id = 'reset';
  reset.type = 'button';
  controls.append(reset);

  const ioBlock = el('div', 'io-block');
  ioBlock.append(el('h3', 'control-heading', 'Local import and export'));
  const ioButtons = el('div', 'io-buttons');
  const exportButton = el('button', 'button-secondary', 'Export scenario JSON');
  exportButton.id = 'export-button';
  exportButton.type = 'button';
  const importButton = el('button', 'button-secondary', 'Import scenario JSON');
  importButton.id = 'import-button';
  importButton.type = 'button';
  const importInput = el('input', 'sr-only');
  importInput.type = 'file';
  importInput.id = 'import-input';
  importInput.accept = 'application/json,.json';
  importInput.setAttribute('aria-label', 'Choose a scenario JSON file to import');
  ioButtons.append(exportButton, importButton, importInput);
  const importStatus = el('p', 'hint');
  importStatus.setAttribute('role', 'status');
  importStatus.setAttribute('aria-live', 'polite');
  importStatus.setAttribute('aria-atomic', 'true');
  importStatus.hidden = true;
  ioBlock.append(
    ioButtons,
    importStatus,
    el('p', 'hint', 'Reads and writes only the local file you pick. Nothing is uploaded and nothing leaves this machine.'),
  );
  controls.append(ioBlock);

  const notices = el('div', 'notices');
  controls.append(notices);

  const viewStack = el('div', 'view-stack');

  const ranking = panels.console;
  const list = el('ol', 'movie-list');
  list.setAttribute('role', 'list');
  const status = el('p', 'ranking-status');
  ranking.append(
    el('h2', '', 'Current ranking'),
    el('p', 'list-caption', 'The candidate set is fixed; ranks come from the unrounded heuristic score, and ties break by ID ascending.'),
    status,
    list,
  );

  const compare = panels.compare;
  const compareModesGroup = el('div', 'compare-modes');
  compareModesGroup.setAttribute('role', 'radiogroup');
  compareModesGroup.setAttribute('aria-label', 'Comparison mode');
  const compareModes: HTMLInputElement[] = [];
  const modeOptions: readonly [string, string][] = [
    ['baseline', 'Baseline ↔ current'],
    ['scenario', 'Scenario ↔ scenario'],
  ];
  modeOptions.forEach(([value, text], index) => {
    const id = `compare-mode-${value}`;
    const input = el('input', 'mode-radio');
    input.type = 'radio';
    input.name = 'compare-mode';
    input.id = id;
    input.value = value;
    if (index === 0) input.checked = true;
    const label = el('label', 'mode-label', text);
    label.htmlFor = id;
    compareModesGroup.append(input, label);
    compareModes.push(input);
  });

  const compareScenario = el('select', 'select-input');
  compareScenario.id = 'compare-scenario';
  for (const item of scenarios) {
    const option = el('option', '', item.label);
    option.value = item.id;
    compareScenario.append(option);
  }

  const compareScenarioField = el('div', 'compare-scenario-field');
  // 标签必须指向选择器，否则读屏只会报出一个没有名字的下拉框。
  const compareScenarioLabel = el('label', 'control-label-text', 'Comparison scenario');
  compareScenarioLabel.htmlFor = compareScenario.id;
  compareScenarioField.append(compareScenarioLabel, compareScenario);

  const compareSummary = el('div', 'compare-summary');
  const compareBody = el('div', 'compare-body');
  compare.append(
    el('h2', '', 'Both readings side by side'),
    compareModesGroup,
    compareScenarioField,
    compareSummary,
    compareBody,
  );

  const explore = panels.explore;
  const atlasSummary = el('p', 'atlas-summary');
  const atlas = el('div', 'atlas');
  const atlasTable = el('div', 'atlas-table');
  explore.append(
    el('h2', '', 'Synthetic coordinates'),
    atlasSummary,
    atlas,
    el('h3', 'control-heading', 'The same set of films as a list'),
    atlasTable,
  );

  viewStack.append(ranking, compare, explore);

  const evidence = el('aside', 'evidence-panel');
  evidence.id = 'movie-evidence';
  evidence.setAttribute('aria-label', 'Rank explanation for the selected film');

  main.append(controls, viewStack, evidence);
  demoRoot.append(main);
  shell.append(demoRoot);

  const sourceNote = el('p', 'source-note');
  devBody.append(sourceNote);
  // Developer diagnostics放页脚：它不是这个页面要卖的东西。
  shell.append(devPanel);

  const live = el('div', 'live-region sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  shell.append(live);

  root.replaceChildren(shell);

  return {
    root,
    error,
    live,
    badge,
    introCopy,
    introHeading,
    modeInputs,
    modeBanner,
    sourceNote,
    serviceRoot,
    demoRoot,
    service,
    seedCard,
    sharedContainer,
    notices,
    relationRange: relation.range,
    relationValue: relation.output,
    differenceRange: difference.range,
    differenceValue: difference.output,
    reset,
    scenarioInputs: scenario.inputs,
    tabs,
    panels,
    list,
    status,
    compareModes,
    compareScenario,
    compareScenarioField,
    compareSummary,
    compareBody,
    atlasSummary,
    atlas,
    atlasTable,
    evidence,
    exportButton,
    importButton,
    importInput,
    importStatus,
  };
}
