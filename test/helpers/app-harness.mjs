// 应用级 DOM 仿真测试台。
//
// 这是纯 Node 的 DOM 仿真（linkedom），不是浏览器：没有 Chrome、没有渲染、没有像素。
// 它能验证 `src/ui/app.ts` 这条真实入口的状态机（场景切换、旋钮、空状态、导入竞态、
// 比较口径、探索选中态），因为当前环境禁止启动浏览器。仿真覆盖不到布局、样式、
// 真实焦点顺序与读屏语义，这些仍然标为未验收。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

let compiledDir = null;
let instanceCounter = 0;

function compileApp() {
  if (compiledDir !== null) return compiledDir;
  compiledDir = mkdtempSync(join(tmpdir(), 'taste-tuner-app-'));
  execFileSync(
    process.execPath,
    [
      join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--project',
      join(projectRoot, 'tsconfig.json'),
      '--outDir',
      compiledDir,
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  return compiledDir;
}

export function cleanupApp() {
  if (compiledDir === null) return;
  rmSync(compiledDir, { recursive: true, force: true });
  compiledDir = null;
}

/** CSS.escape 的最小实现：属性选择器里用到的标识符都是 [a-z0-9-]。 */
function cssEscape(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

/**
 * linkedom 把 `value` 做成了只读属性，真实浏览器里它是可读写的。
 * 这里用 WeakMap 补一个可写版本，未设置过的元素回落到原 getter。
 */
const PATCHED = Symbol('taste-tuner-patched');
function makeValueWritable(Ctor) {
  if (Ctor === undefined || Object.hasOwn(Ctor.prototype, PATCHED)) return;
  const original = Object.getOwnPropertyDescriptor(Ctor.prototype, 'value');
  const store = new WeakMap();
  Object.defineProperty(Ctor.prototype, 'value', {
    get() {
      if (store.has(this)) return store.get(this);
      return original?.get?.call(this) ?? '';
    },
    set(value) {
      store.set(this, String(value));
    },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(Ctor.prototype, PATCHED, { value: true });
}

/**
 * linkedom 的 label.htmlFor 不会反射成 for 属性，真实浏览器会。
 * 这里补上反射，否则按 for 关联标签的控件会被误判成"没有可访问名称"。
 * linkedom 不为 <label> 单独建类，所以补在 HTMLElement.prototype 上。
 */
const PATCHED_HTMLFOR = Symbol('taste-tuner-htmlfor-patched');
function makeHtmlForReflective(Ctor) {
  if (Ctor === undefined || Object.hasOwn(Ctor.prototype, PATCHED_HTMLFOR)) return;
  Object.defineProperty(Ctor.prototype, 'htmlFor', {
    get() {
      return this.getAttribute('for') ?? '';
    },
    set(value) {
      this.setAttribute('for', String(value));
    },
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(Ctor.prototype, PATCHED_HTMLFOR, { value: true });
}

const DOM_GLOBALS = [
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLSelectElement',
  'HTMLOutputElement',
  'HTMLOListElement',
  'HTMLDivElement',
  'HTMLParagraphElement',
  'HTMLSpanElement',
  'HTMLAnchorElement',
  'HTMLLabelElement',
  'HTMLDetailsElement',
  'HTMLFieldSetElement',
  'HTMLTableElement',
  'SVGElement',
  'SVGTextElement',
  'Node',
  'NodeList',
  'Event',
  'CustomEvent',
];

/**
 * 启动一份独立的应用实例。
 * 每个实例是一次全新的 ESM 求值，模块级状态互不影响。
 */
export async function bootApp(options = {}) {
  const reducedMotion = options.reducedMotion === true;
  const outDir = compileApp();
  const html = readFileSync(join(projectRoot, 'public', 'index.html'), 'utf8');
  const { document, window } = parseHTML(html);

  let focusedId = null;
  let focusedElement = null;
  let scrolled = 0;
  let animated = 0;
  const exportedBlobs = [];

  // linkedom 没有实现这几样浏览器 API；这里补最小可运行版本。
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = (query) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });

  // linkedom 没有实现 <select> 的 value / selectedIndex。
  // 少了它，界面读到的种子类别是 undefined，请求里就没有 entityType——
  // 于是仿真跑的是一条**真实浏览器里不会发生**的路径（真浏览器有值，
  // 真服务端也才认得出类别）。这里补上最小可运行版本，让仿真与浏览器一致。
  const selectProto = window.HTMLSelectElement?.prototype;
  if (selectProto !== undefined) {
    Object.defineProperty(selectProto, 'selectedIndex', {
      configurable: true,
      get() {
        const options = Array.from(this.options ?? []);
        const chosen = options.findIndex((option) => option.hasAttribute('selected'));
        return chosen >= 0 ? chosen : 0;
      },
    });
    Object.defineProperty(selectProto, 'value', {
      configurable: true,
      get() {
        const options = Array.from(this.options ?? []);
        const index = this.selectedIndex;
        return options[index]?.value ?? '';
      },
      set(next) {
        const options = Array.from(this.options ?? []);
        options.forEach((option) => option.removeAttribute('selected'));
        const match = options.find((option) => option.value === next);
        if (match !== undefined) match.setAttribute('selected', '');
      },
    });
  }

  const elementProto = window.Element.prototype;
  elementProto.scrollIntoView = function scrollIntoView() {
    scrolled += 1;
  };
  elementProto.animate = function animate() {
    animated += 1;
    return { finished: Promise.resolve(), cancel() {} };
  };
  elementProto.focus = function focus() {
    focusedElement = this;
    focusedId =
      this.getAttribute('id') ?? this.getAttribute('data-movie-id') ?? this.textContent ?? null;
  };

  globalThis.document = document;
  globalThis.window = window;
  makeValueWritable(window.HTMLInputElement);
  makeValueWritable(window.HTMLSelectElement);
  makeHtmlForReflective(window.HTMLElement);
  for (const name of DOM_GLOBALS) {
    const value = window[name];
    if (value !== undefined) globalThis[name] = value;
  }
  globalThis.CSS = { escape: cssEscape };

  // 真实服务那条主线走同源 /api。仿真里把 fetch 换成可控的假实现：
  // 默认就是"服务端未配置"，所以不会发出任何真实请求。
  const apiCallLog = [];
  const defaultApiHandler = async () => ({
    // 真实服务的 /api/status **总是 200**（"未配置"也是 200，只是 configured=false）。
    // 夹具早先回 503，那是把"服务起不来"与"服务没配置"混成了一件事。
    status: 200,
    body: {
      status: 'not_configured',
      missing: ['QLOO_API_KEY', 'QLOO_BASE_URL'],
      provider: 'qloo',
      configured: false,
      entityTypes: ['movie', 'artist'],
      maxCandidates: 50,
    },
  });
  // 应用一加载就会问一次服务状态，所以假响应必须能在启动前装好。
  let apiHandler = options.api ?? defaultApiHandler;
  globalThis.fetch = async (url, init) => {
    apiCallLog.push({ url: String(url), body: init?.body ?? null });
    const result = await apiHandler(String(url), init);
    const text = JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: new Map(),
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };

  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    exportedBlobs.push(blob);
    return 'blob:taste-tuner-test';
  };
  URL.revokeObjectURL = () => {};

  instanceCounter += 1;
  const entry = join(outDir, 'ui', 'app.js');
  await import(`${pathToFileURL(entry).href}?instance=${instanceCounter}`);

  const flush = async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const query = (selector) => document.querySelector(selector);
  const queryAll = (selector) => Array.from(document.querySelectorAll(selector));
  const text = (selector) => query(selector)?.textContent ?? '';

  const rows = () =>
    queryAll('.movie-list .movie-item').map((item) => {
      const button = item.querySelector('button');
      const cells = Array.from(item.querySelectorAll('span'));
      return {
        id: item.getAttribute('data-movie-id') ?? '',
        title: cells[1]?.textContent ?? '',
        rank: cells[0]?.textContent ?? '',
        score: cells[2]?.textContent ?? '',
        delta: cells[3]?.textContent ?? '',
        selected: button?.getAttribute('aria-pressed') === 'true',
      };
    });

  const dispatch = (element, type) => {
    // 事件必须冒泡：应用用事件委托监听"最小重合标签"与"比较方式"这两组单选。
    element.dispatchEvent(new window.Event(type, { bubbles: true }));
  };

  const byId = (id, kind) => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(`找不到${kind} #${id}`);
    return element;
  };

  const setRange = (id, value) => {
    const input = byId(id, '滑杆');
    input.value = String(value);
    dispatch(input, 'input');
  };

  const clickScenario = (id) => {
    const input = byId(`scenario-${id}`, '场景');
    input.checked = true;
    dispatch(input, 'change');
  };

  const setShared = (value) => {
    const input = byId(`shared-${value}`, '最小重合标签选项');
    input.checked = true;
    dispatch(input, 'change');
  };

  const clickTab = (view) => {
    dispatch(byId(`tab-${view}`, '视图标签'), 'click');
  };

  const pressTabKey = (view, key) => {
    const event = new window.Event('keydown');
    event.key = key;
    byId(`tab-${view}`, '视图标签').dispatchEvent(event);
  };

  /** 在任意元素上按键。 */
  const pressKey = (element, key) => {
    const event = new window.Event('keydown', { bubbles: true });
    event.key = key;
    element.dispatchEvent(event);
  };

  const selectCompareMode = (mode) => {
    const input = byId(`compare-mode-${mode}`, '比较方式');
    input.checked = true;
    dispatch(input, 'change');
  };

  const setCompareScenario = (id) => {
    const select = byId('compare-scenario', '对照场景选择器');
    select.value = id;
    dispatch(select, 'change');
  };

  const importFile = (file) => {
    const input = byId('import-input', '导入文件输入');
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    dispatch(input, 'change');
  };

  const exportedText = async () => {
    const blob = exportedBlobs.at(-1);
    if (blob === undefined) throw new Error('没有产生导出文件');
    return blob.text();
  };

  const clickExport = () => {
    dispatch(byId('export-button', '导出按钮'), 'click');
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 切换工作模式：'service' 是真实服务，'demo' 是离线合成演示。 */
  const switchMode = (mode) => {
    const input = document.getElementById(`mode-${mode}`);
    if (input === null) throw new Error(`找不到模式 ${mode}`);
    input.checked = true;
    dispatch(input, 'change');
  };

  /** 用假响应驱动 /api。handler 收到 (url, init)。 */
  const setApiHandler = (handler) => {
    apiHandler = handler;
  };

  /** 已经发生过的 /api 调用，用来断言"滑杆不联网"。 */
  const apiCalls = () => apiCallLog.slice();

  return {
    document,
    window,
    focused: () => focusedId,
    focusedElement: () => focusedElement,
    scrolledCount: () => scrolled,
    animatedCount: () => animated,
    rows,
    text,
    query,
    queryAll,
    setRange,
    clickScenario,
    setShared,
    clickTab,
    pressTabKey,
    pressKey,
    selectCompareMode,
    setCompareScenario,
    importFile,
    exportedText,
    clickExport,
    wait,
    switchMode,
    setApiHandler,
    apiCalls,
    flush,
    restoreUrls: () => {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    },
  };
}
