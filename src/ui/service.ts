/**
 * 真实服务这条主线：种子输入 → 实体解析与歧义确认 → 真实候选 → 本地确定性重排与证据。
 *
 * 边界：
 * - 滑杆只重排**已经冻结下来的一份候选**，不联网。
 * - 服务没配置、上游出错、结果为空，各自有明确状态，**不回退到任何合成数据**。
 * - 旋钮只按**这次响应里真的有字段**出现；服务没给流行度，就不出现流行度旋钮。
 * - 分数是"Ranks locally with a heuristic over the fields the service returns"，不是偏好概率。
 */

import {
  CONTENT_RATING_ORDER,
  DEFAULT_SERVICE_CONTROLS,
  MAX_SEED_LENGTH,
  NO_CONSTRAINT,
  SEED_ENTITY_TYPES,
  applyServiceConstraint,
  availableKnobs,
  rankServiceCandidates,
  validateServiceControls,
  type CandidateOutcome,
  type RankedServiceCandidate,
  type ResolveOutcome,
  type SeedEntityType,
  type ServiceCandidate,
  type RequestPreview,
  OUTPUT_ENTITY_TYPE_URN,
  type ServiceConstraint,
  type ServiceControls,
  type ServiceTag,
} from '../core/service.js';
import { el, formatRaw, formatScore, posterFrame } from './dom.js';

export interface ServiceStatusResponse {
  readonly provider: string;
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** 用的是哪条接入面。 */
  readonly accessSurface: string;
  /** 这条接入面官方是不是允许。 */
  readonly accessSurfaceConfirmed: boolean;
  /** 这条接入面有没有对真实 API 实测过。官方允许 ≠ 本地实测过。 */
  readonly accessSurfaceLiveVerified?: boolean;
  /** 服务端有没有读到凭据文件。只报在不在，不报内容。 */
  readonly credentialPresent?: boolean | null;
  /** 服务端的真实请求预算。 */
  readonly budget?: {
    readonly enabled: boolean;
    readonly limit: number;
    readonly used: number;
    readonly remaining: number;
    readonly state: string;
  };
  readonly entityTypes: readonly SeedEntityType[];
  readonly maxCandidates: number;
}

export interface ServiceApi {
  status(): Promise<ServiceStatusResponse>;
  resolve(seed: string, entityType: SeedEntityType): Promise<ResolveOutcome>;
  candidates(entityId: string, limit: number): Promise<CandidateOutcome>;
  /** 预览将要发出的请求。不发请求、不消耗额度。 */
  preflight(input: {
    readonly op: 'resolve' | 'candidates';
    readonly seed?: string;
    readonly entityId?: string;
    readonly entityType?: SeedEntityType;
    readonly limit?: number;
  }): Promise<{ readonly status: string; readonly preview?: RequestPreview }>;
}

export interface ServiceView {
  readonly root: HTMLElement;
  readonly status: HTMLElement;
  /** 服务不可用时的**可见**提示（诊断折叠区里的状态行用户看不到）。 */
  readonly unavailable: HTMLElement;
  readonly error: HTMLElement;
  readonly notice: HTMLElement;
  readonly form: HTMLFormElement;
  readonly advanced: HTMLElement;
  readonly seedInput: HTMLInputElement;
  readonly entityType: HTMLSelectElement;
  readonly submit: HTMLButtonElement;
  readonly resolution: HTMLElement;
  readonly controls: HTMLDetailsElement;
  readonly controlsBody: HTMLElement;
  readonly preview: HTMLElement;
  readonly devMetrics: HTMLElement;
  readonly seedBar: HTMLElement;
  readonly seedBarTitle: HTMLElement;
  readonly seedBarFacts: HTMLElement;
  readonly seedChange: HTMLButtonElement;
  readonly listHeading: HTMLElement;
  readonly statusLine: HTMLElement;
  readonly list: HTMLElement;
  readonly live: HTMLElement;
}

const ENTITY_TYPE_LABELS: Readonly<Record<SeedEntityType, string>> = Object.freeze({
  movie: 'Film',
  artist: 'Artist / band',
});

export function createServiceView(diagnostics: HTMLElement): ServiceView {
  const root = el('section', 'service-mode');
  root.id = 'service-mode';

  // ---- 第一屏只有一件事要做：说出一部电影 ----
  const form = el('form', 'find-form');
  form.addEventListener('submit', (event) => event.preventDefault());

  const seedField = el('div', 'find-field');
  const seedLabel = el('label', 'find-label', 'Film title');
  seedLabel.htmlFor = 'seed-input';
  const seedInput = el('input', 'find-input');
  seedInput.id = 'seed-input';
  seedInput.type = 'text';
  seedInput.maxLength = MAX_SEED_LENGTH;
  seedInput.placeholder = 'e.g. Rear Window';
  seedInput.setAttribute('aria-describedby', 'seed-hint');
  seedField.append(seedLabel, seedInput);

  const submit = el('button', 'button-primary find-submit', 'Find similar films');
  submit.id = 'seed-submit';
  submit.type = 'submit';

  const hint = el(
    'p',
    'find-hint',
    'Type a film you have watched to find similar ones. If the name is ambiguous you pick from the candidates — the app never guesses for you.',
  );
  hint.id = 'seed-hint';

  form.append(seedField, submit, hint);

  // 服务不可用时的**可见**提示：诊断折叠区里的状态行用户看不到，
  // 所以这里在主界面给一条能行动的说明（带"再问一次"）。
  const unavailable = el('div', 'service-unavailable');
  unavailable.id = 'service-unavailable';
  unavailable.setAttribute('role', 'status');
  // 没有内容时整个藏起来：空的框也是噪音。
  unavailable.hidden = true;

  root.append(unavailable, form);

  // ---- 高级入口：Artist种子默认收起来 ----
  const advanced = el('details', 'advanced-entry');
  advanced.append(el('summary', 'advanced-summary', 'Use an artist or band as the seed'));
  const typeField = el('div', 'find-field');
  const typeLabel = el('label', 'find-label', 'Seed type');
  typeLabel.htmlFor = 'seed-type';
  const entityType = el('select', 'seed-type-select');
  entityType.id = 'seed-type';
  (['movie', 'artist'] as const).forEach((value) => {
    const option = el('option', '', ENTITY_TYPE_LABELS[value]);
    option.value = value;
    entityType.append(option);
  });
  typeField.append(typeLabel, entityType);
  advanced.append(
    typeField,
    el(
      'p',
      'hint',
      'The category only decides where to look it up. Seed with an artist and you still get films back.',
    ),
  );
  root.append(advanced);

  const error = el('div', 'service-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(error);

  // 提示区：服务说了话但不是故障（比如归因算不出来）。
  const notice = el('div', 'service-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  root.append(notice);

  const resolution = el('div', 'service-resolution');
  root.append(resolution);

  // ---- 种子条：确认之后把输入收成这一条 ----
  // 留着它是因为"Change the film"得有个入口；但它不能占着整屏，
  // 否则第一屏根本看不到Film。
  const seedBar = el('div', 'seed-bar');
  seedBar.hidden = true;
  const seedBarLabel = el('span', 'seed-bar-label', 'Your seed');
  const seedBarTitle = el('span', 'seed-bar-title');
  const seedBarFacts = el('span', 'seed-bar-facts');
  const changeSeed = el('button', 'button-secondary seed-bar-change', 'Change the film');
  changeSeed.id = 'seed-change';
  changeSeed.type = 'button';
  seedBar.append(seedBarLabel, seedBarTitle, seedBarFacts, changeSeed);
  root.append(seedBar);

  // ---- 调整顺序：排在Film**之前** ----
  // 用户找片时最想调的就是顺序，调它却在五张大卡之后，那等于没有。
  // 手机上默认收起来：两个滑杆会把第一张片子挤到屏外去。
  const controls = el('details', 'service-controls');
  const controlsSummary = el('summary', 'service-controls-summary', 'Reorder');
  controlsSummary.id = 'service-controls-heading';
  // summary 与内容分层：renderControls 只重画内容，**不碰 summary**
  // （早先两者放一起，replaceChildren 会把 summary 一起清掉，折叠区就没了标题）。
  const controlsBody = el('div', 'controls-body');
  controls.append(controlsSummary, controlsBody);
  root.append(controls);

  // ---- 结果：五部真实Film是视觉中心 ----
  const results = el('section', 'service-results');
  results.setAttribute('aria-labelledby', 'service-list-heading');
  const listHeading = el('h2', 'results-heading', 'Similar films');
  listHeading.id = 'service-list-heading';
  // 确认之后消歧面板整个被收掉，焦点会掉回 body——键盘用户就丢了位置。
  // 给标题一个焦点位，取回候选之后把焦点送过来。
  listHeading.tabIndex = -1;
  const statusLine = el('p', 'service-ranking-status');
  const list = el('ol', 'service-list');
  list.setAttribute('role', 'list');
  results.append(listHeading, statusLine, list);
  root.append(results);

  // ---- Developer diagnostics：默认收起来 ----
  // 诊断内容放进外壳给的那个容器，这样页脚只有**一个**"Developer diagnostics"折叠区，
  // 而不是服务这边一个、外壳那边一个。
  const status = el('p', 'service-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const preview = el('div', 'service-preview');
  preview.id = 'service-preview';
  const devMetrics = el('p', 'dev-metrics');
  diagnostics.append(status, preview, devMetrics);

  // 类名与演示区分开：两处都有 live region 时，选择器不能指错。
  const live = el('div', 'service-live-region sr-only');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  root.append(live);

  return {
    root,
    status,
    unavailable,
    error,
    notice,
    form,
    advanced,
    seedInput,
    entityType,
    submit,
    resolution,
    controls,
    controlsBody,
    preview,
    devMetrics,
    seedBar,
    seedBarTitle,
    seedBarFacts,
    seedChange: changeSeed,
    listHeading,
    statusLine,
    list,
    live,
  };
}

/** 默认走同源 /api。浏览器里不出现任何凭据。 */
export function createServiceApi(fetchImpl: typeof fetch = globalThis.fetch): ServiceApi {
  const read = async (response: Response): Promise<unknown> => {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error(`The server returned an unreadable response (HTTP ${response.status})`);
    }
  };

  return {
    async status(): Promise<ServiceStatusResponse> {
      const response = await fetchImpl('/api/status', {
        headers: { accept: 'application/json' },
      });
      // 非 200（例如平台起不来时的 503）：这是"服务不可用"，不是"字段缺失"——
      // 不校验的话，界面会拿一个错误响应当状态用，然后照常显示成"Live service"。
      if (!response.ok) {
        throw new Error(`the status endpoint answered HTTP ${response.status}`);
      }
      const body = (await read(response)) as ServiceStatusResponse;
      if (typeof body?.configured !== 'boolean' || !Array.isArray(body?.missing)) {
        throw new Error('the status payload has an unexpected shape');
      }
      return body;
    },

    async resolve(seed: string, entityType: SeedEntityType): Promise<ResolveOutcome> {
      const response = await fetchImpl('/api/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ seed, entityType }),
      });
      return (await read(response)) as ResolveOutcome;
    },

    async candidates(entityId: string, limit: number): Promise<CandidateOutcome> {
      const response = await fetchImpl('/api/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ entityId, limit }),
      });
      return (await read(response)) as CandidateOutcome;
    },

    async preflight(input): Promise<{ status: string; preview?: RequestPreview }> {
      const response = await fetchImpl('/api/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      });
      return (await read(response)) as { status: string; preview?: RequestPreview };
    },
  };
}

type Resolution =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | {
      readonly kind: 'resolved';
      readonly entityId: string;
      readonly name: string;
      readonly type: string;
      readonly year?: number;
      readonly disambiguation?: string;
      readonly tags: readonly ServiceTag[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly {
        readonly id: string;
        readonly name: string;
        readonly type: string;
        readonly year?: number;
        readonly disambiguation?: string;
        readonly imageUrl?: string;
        readonly tags: readonly ServiceTag[];
      }[];
    }
  /** 已经确认：消歧列表与输入都收起来了，种子条顶在上面。 */
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Current正在用的种子：身份 + 标签。
 *
 * 这三样必须绑在一起走：标签相似度要用它的标签，归因面板要用它的名字
 * 把服务给的 entity_id 说成人话。少传一样，就会拿上一次种子的东西顶上。
 */
interface SeedRef {
  readonly entityId: string;
  readonly name: string;
  readonly year?: number;
  /** 消歧串。Artist没有上映年份，那串字是唯一的区分。 */
  readonly disambiguation?: string;
  readonly tags: readonly ServiceTag[];
}

interface CandidateState {
  /** 已取回的候选（未经硬约束过滤）。 */
  readonly candidates: readonly ServiceCandidate[];
  /** 本地硬约束。改了不重新发请求。 */
  readonly constraint: ServiceConstraint;
  /** 候选所属的实体类别（urn:entity:movie 之类）。 */
  readonly entityType: string;
  /** 这一批候选对应的种子。 */
  readonly seed: SeedRef;
  readonly controls: ServiceControls;
  readonly explainabilityWarning?: string;
}

export interface ServiceController {
  start(): Promise<void>;
}

export interface ServiceControllerOptions {
  /** 配置状态变化时回调，用来更新外壳上的徽标。 */
  /** 状态变化时回调，带上完整的凭据/预算状态，外壳据此措辞。 */
  readonly onStatus?: (status: ServiceStatusResponse) => void;
}

export function createServiceController(
  view: ServiceView,
  api: ServiceApi,
  options: ServiceControllerOptions = {},
): ServiceController {
  let resolution: Resolution = { kind: 'idle' };
  let candidateState: CandidateState | null = null;
  let selectedId: string | null = null;
  // 一次只摊开一部分候选：服务一次会回 20 部，全铺开既读不完，也看不出名次变化。
  // 状态行报的是**真实条数**，展开多少只是眼下看到多少。
  const REVEAL_STEP = 6;
  let visibleCount = REVEAL_STEP;
  /**
   * 上一次成功解析出来的种子：取候选失败时用它重试，不用重新输一遍。
   * 它同时也是"Which seed the next fetch will use"的唯一来源。
   */
  let lastSeed: SeedRef | null = null;
  let pending = false;
  // 取候选与解析种子是两个不同的忙闲状态：解析成功后紧接着要取候选，
  // 用同一个标志会把取候选挡掉。
  let loadingCandidates = false;
  /**
   * 结果入场只在网上响应真的画出候选时才播：本地重排（改权重/改约束）不重播。
   * 用一次性标记而不是参数：renderList 的调用点很多，只有网络那条需要入场。
   */
  let entrancePending = false;
  /**
   * 折叠区的展开状态要跨重画活下来。
   * 重画只重画内容；用户刚点开的「调整顺序」不该在重置之后自己合上。
   * null 表示"Not decided yet"，这时才按屏幕宽窄取默认值。
   */
  let controlsOpen: boolean | null = null;
  view.controls.addEventListener('toggle', () => {
    controlsOpen = view.controls.open;
  });

  const announce = (message: string): void => {
    view.live.textContent = message;
  };

  const showError = (message: string | null, retry?: () => void): void => {
    if (message === null || message.length === 0) {
      view.error.hidden = true;
      view.error.replaceChildren();
      return;
    }
    view.error.hidden = false;
    const panel = el('div', 'error-panel', message);
    if (retry !== undefined) {
      // 取候选失败时给一条明确的出路，不用重新输一遍种子。
      const button = el('button', 'button-secondary', 'Fetch candidates again');
      button.id = 'service-retry';
      button.type = 'button';
      button.addEventListener('click', retry);
      panel.append(button);
    }
    view.error.replaceChildren(panel);
  };

  const showNotice = (message: string | null): void => {
    if (message === null || message.length === 0) {
      view.notice.hidden = true;
      view.notice.replaceChildren();
      return;
    }
    view.notice.hidden = false;
    view.notice.replaceChildren(el('p', 'notice-text', message));
  };

  const renderStatus = (): void => {
    view.status.replaceChildren();
    view.status.className = 'service-status';
    view.status.append(
      el('span', 'status-dot is-off', '●'),
      el('span', '', 'Checking the live service configuration…'),
    );
  };

  /**
   * 重新拉一次服务状态。
   *
   * 额度是**每次请求都扣**的：失败的尝试也算。所以用过一次之后，状态行里
   * "0 used"就是骗人的了 —— 每次操作后都刷新一次，让余额始终是真的。
   * 这是本地调用，不消耗额度。
   */
  const refreshStatus = async (): Promise<void> => {
    try {
      const status = await api.status();
      renderConfigured(status);
    } catch {
      // 拿不到状态就保持原样，不在这里报错——错误该由真正失败的那次操作说。
    }
  };

  /**
   * 重新问一次服务状态。
   *
   * 用户点"Check again"也走这里：服务恢复了就自己回到正常状态。
   */
  const refreshStatusNow = async (): Promise<void> => {
    renderStatus();
    try {
      const status = await api.status();
      renderConfigured(status);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      renderStatusFailed(detail);
    }
  };

  /**
   * 服务不可用：**在主界面**说清楚，并给一个"再问一次"。
   *
   * 诊断折叠区里的状态行用户看不到——不可用这种事不能只写在折叠区里。
   */
  const renderUnavailable = (): void => {
    view.unavailable.hidden = false;
    view.unavailable.replaceChildren(
      el(
        'p',
        '',
        'The live service is not available right now. Nothing was requested — try again in a moment.',
      ),
    );
    const retry = el('button', 'button-secondary', 'Check again');
    retry.id = 'service-retry-status';
    retry.type = 'button';
    retry.addEventListener('click', () => {
      void refreshStatusNow();
    });
    view.unavailable.append(retry);
  };

  /**
   * 种子类型只列**这一轮真支持**的。
   *
   * 公开实例只授权电影（音乐人种子会被明确拒绝）→ 那就别在界面上摆一个用不了的选项。
   * 契约（能接音乐人）留着，等授权范围变了再放出来。
   */
  const renderSeedTypes = (types: readonly SeedEntityType[]): void => {
    const supported = types.length === 0 ? SEED_ENTITY_TYPES : types;
    view.entityType.replaceChildren();
    supported.forEach((value) => {
      const option = el('option', '', ENTITY_TYPE_LABELS[value]);
      option.value = value;
      view.entityType.append(option);
    });
    // 只有一种类型时，"音乐人当种子"的入口就是死的：收起来。
    view.advanced.hidden = supported.length < 2;
  };

  const renderConfigured = (status: ServiceStatusResponse): void => {
    view.status.className = 'service-status';
    view.status.replaceChildren();
    renderSeedTypes(status.entityTypes ?? []);
    // 服务恢复了：把可见的"不可用"提示收掉。
    view.unavailable.replaceChildren();
    view.unavailable.hidden = true;
    options.onStatus?.(status);
    if (!status.configured) {
      view.status.append(
        el('span', 'status-dot is-off', '●'),
        el(
          'span',
          '',
          `The live service is not configured: the server is missing ${status.missing.join(', ')}. Set them on the machine that runs the service and restart it. Credentials are never entered or stored in the browser.`,
        ),
      );
      view.submit.disabled = true;
      return;
    }
    // 本机回放是一种单独的形态：它不联网、不要凭据，也不是赛事接入面。
    const isReplay = status.accessSurface === 'saved-response-replay';
    // 三件事分开说：官方允不允许、这条路径有没有对真实 API 实测过、本机回放不是接入面。
    const surface = isReplay
      ? `Access surface: ${status.accessSurface} (local replay, not an event access surface)`
      : status.accessSurfaceConfirmed !== true
        ? `Access surface: ${status.accessSurface} (whether the official guide allows it is unconfirmed)`
        : status.accessSurfaceLiveVerified === true
          ? `Access surface: ${status.accessSurface} (officially allowed; this path has been exercised against the live API)`
          : status.accessSurfaceLiveVerified === false
            ? `Access surface: ${status.accessSurface} (officially allowed; this path has not been exercised against the live API yet)`
            : `Access surface: ${status.accessSurface}`;
    const credential =
      status.credentialPresent === null || status.credentialPresent === undefined
        ? ''
        : status.credentialPresent === true
          ? 'Credential in place.'
          : 'No credential yet: run python3 scripts/setup-credentials.py.' +
            '(You can skip this if you already configured the credential in the official tool’s own private config.)';
    const budget =
      status.budget === undefined
        ? ''
        : status.budget.enabled === true
          ? `Live request budget: ${status.budget.limit} total, ${status.budget.used} used, ${status.budget.remaining} left.`
          : 'The live request budget is off, so no live request is sent.';
    // 三件独立的事：工具在不在、凭据在不在、预算开不开。
    // 以前"Ready"和"No credential"会同时出现——那是在自相矛盾。
    const toolReady = status.credentialPresent !== false;
    const headline = isReplay
      ? `Replay mode (${status.provider}): only responses saved on this machine.`
      : toolReady
        ? `The live service is ready (${status.provider}).`
        : `The official tool is present (${status.provider}) but the credential is missing, so the live service cannot be reached.`;
    view.status.append(
      el('span', 'status-dot is-on', '●'),
      el(
        'span',
        '',
        `${headline} The sliders only reorder the candidates already fetched; nothing is sent over the network. ${surface}. ${credential}${budget}`,
      ),
    );
    // 凭据没就位就别让人白点一次。回放不用凭据，所以照常可用。
    view.submit.disabled = isReplay ? false : !toolReady;
  };

  const renderStatusFailed = (message: string): void => {
    // 细节只进**服务端日志**：内部异常（路径、模块名）不该出现在页面上。
    console.error(`Live service status unavailable: ${message}`);
    view.status.className = 'service-status is-error';
    view.status.replaceChildren(
      el('span', 'status-dot is-off', '●'),
      el(
        'span',
        '',
        'The live service is not available right now. Nothing was requested; try again in a moment.',
      ),
    );
    options.onStatus?.({
      provider: 'unknown',
      configured: false,
      missing: [],
      accessSurface: 'unknown',
      accessSurfaceConfirmed: false,
      credentialPresent: null,
      entityTypes: [],
      maxCandidates: 0,
    });
    view.submit.disabled = true;
    renderUnavailable();
  };

  const renderResolution = (): void => {
    view.resolution.replaceChildren();
    if (resolution.kind === 'idle') return;
    if (resolution.kind === 'busy') {
      view.resolution.append(el('p', 'hint', 'Asking the live service to resolve this seed…'));
      return;
    }
    if (resolution.kind === 'failed') {
      view.resolution.append(el('p', 'service-failure', resolution.message));
      return;
    }
    if (resolution.kind === 'resolved') {
      renderSeedBar({
        entityId: resolution.entityId,
        name: resolution.name,
        ...(resolution.year === undefined ? {} : { year: resolution.year }),
        ...(resolution.disambiguation === undefined
          ? {}
          : { disambiguation: resolution.disambiguation }),
        tags: [],
      });
      return;
    }
    // 已经确认过了：消歧列表与「就这部」按钮都收起来了，这里什么都不画。
    if (resolution.kind === 'confirmed') return;

    view.resolution.append(
      el('h3', 'results-heading', 'Several films share this name'),
      el('p', 'hint', 'The service returned them in this order and the first one is selected by default. Picking the wrong one would waste the request, so the app does not decide for you.'),
    );
    const group = el('div', 'entity-options');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Films with the same name');

    // 吸底确认条要显示**当前选中的是哪一部**，所以先把这个查询准备好。
    const selectedCandidate = (): { readonly id: string; readonly name: string } | undefined => {
      const checked = Array.from(
        group.querySelectorAll('input[type="radio"]'),
      ).find((input) => (input as HTMLInputElement).checked) as HTMLInputElement | undefined;
      if (checked === undefined) return undefined;
      return resolution.kind === 'ambiguous'
        ? resolution.candidates.find((item) => item.id === checked.value)
        : undefined;
    };

    resolution.candidates.forEach((candidate, index) => {
      const id = `entity-${index}`;
      const input = el('input', 'mode-radio');
      input.type = 'radio';
      input.name = 'entity-choice';
      input.id = id;
      input.value = candidate.id;
      if (index === 0) input.checked = true;
      const label = el('label', 'entity-option');
      label.htmlFor = id;
      // 年份与消歧串可能是同一个（实测消歧串就是年份）——重复显示没有意义。
      const facts: string[] = [];
      if (candidate.year !== undefined) facts.push(String(candidate.year));
      if (
        candidate.disambiguation !== undefined &&
        candidate.disambiguation !== String(candidate.year)
      ) {
        facts.push(candidate.disambiguation);
      }
      const body = el('span', 'entity-option-body');
      body.append(el('span', 'entity-option-name', candidate.name));
      if (facts.length > 0) body.append(el('span', 'entity-option-facts', facts.join(' · ')));
      if (index === 0) body.append(el('span', 'entity-option-tag', 'First result from the service'));
      label.append(posterFrame(candidate.imageUrl, `Poster of ${candidate.name}`), body);
      // 选中变了就刷新吸底条上的名字（每个 radio 自己听，不靠冒泡）。
      input.addEventListener('change', () => {
        const picked = selectedCandidate();
        chosenName.textContent = picked === undefined ? '' : `Selected: ${picked.name}`;
      });
      group.append(input, label);
    });
    view.resolution.append(group);

    // 确认动作**吸底**：实测 20 个匹配项时，按钮落在三屏之下（y≈2345），
    // 选中第一部也得滚很久才够得着。做成面板内的吸底条，选中哪一部都够得着；
    // 键盘与单次确认语义不变（还是同一个 radio 组 + 同一个按钮）。
    const bar = el('div', 'entity-confirm-bar');
    const chosenName = el('span', 'entity-confirm-name');
    const confirm = el('button', 'button-primary', 'This one');
    confirm.type = 'button';
    confirm.id = 'entity-confirm';
    confirm.addEventListener('click', () => {
      // 逐个看 checked，不依赖 :checked 选择器。
      const chosen = Array.from(
        group.querySelectorAll('input[type="radio"]'),
      ).find((input) => (input as HTMLInputElement).checked) as HTMLInputElement | undefined;
      if (chosen === undefined) return;
      const picked = resolution.kind === 'ambiguous'
        ? resolution.candidates.find((item) => item.id === chosen.value)
        : undefined;
      if (picked === undefined) return;
      // 用**用户挑的那个**实体的身份、名字与标签，别拿别处的顶上。
      void loadCandidates({
        entityId: picked.id,
        name: picked.name,
        ...(picked.year === undefined ? {} : { year: picked.year }),
        ...(picked.disambiguation === undefined
          ? {}
          : { disambiguation: picked.disambiguation }),
        tags: picked.tags,
      });
    });
    const first = selectedCandidate();
    chosenName.textContent = first === undefined ? '' : `Selected: ${first.name}`;
    bar.append(chosenName, confirm);
    view.resolution.append(bar);
  };

  const knobBlock = (
    id: string,
    label: string,
    description: string,
    value: number,
    onInput: (next: number) => void,
    // 紧凑款：数值跟标题并排，省一行高度——上方那两个旋钮不能占太多地方。
    compact = false,
  ): HTMLElement => {
    const block = el('div', 'control-block');
    const heading = el('h3', 'control-heading');
    const input = el('input', 'range-input');
    input.type = 'range';
    input.id = id;
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(value);
    const output = el('output', 'range-value', String(value));
    output.htmlFor = id;
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.value = String(next);
      onInput(next);
    });
    // 说明必须跟滑杆程序化关联：读屏用户才知道这个滑杆在调什么。
    const hint = el('p', 'hint', description);
    hint.id = `${id}-hint`;
    input.setAttribute('aria-describedby', hint.id);
    if (compact) {
      heading.classList.add('control-heading-inline');
      heading.append(label, ' ', output);
      block.append(heading, input, hint);
      return block;
    }
    heading.textContent = label;
    block.append(heading, input, output, hint);
    return block;
  };

  /** 预览将要发出的请求：不发请求、不消耗额度。 */
  const showPreview = async (): Promise<void> => {
    view.preview.replaceChildren();
    const seed = view.seedInput.value.trim();
    const entityType = view.entityType.value as SeedEntityType;
    const op: 'resolve' | 'candidates' =
      lastSeed === null ? 'resolve' : 'candidates';
    const button = el('button', 'button-secondary', 'Preview the request that will be sent');
    button.id = 'service-preview-button';
    button.type = 'button';
    button.addEventListener('click', () => {
      void (async () => {
        view.preview.replaceChildren(el('p', 'hint', 'Building the request preview…'));
        try {
          const result = await api.preflight(
            op === 'resolve'
              ? { op, seed, entityType }
              : {
                  op,
                  entityId: lastSeed?.entityId ?? '',
                  limit: 20,
                },
          );
          if (result.preview === undefined) {
            view.preview.replaceChildren(
              el('p', 'service-failure', 'Could not build a preview: the server does not support it.'),
            );
            return;
          }
          const block = el('pre', 'preview-block');
          block.textContent = `${result.preview.method} ${result.preview.url}\n${JSON.stringify(result.preview.params, null, 2)}`;
          view.preview.replaceChildren(
            el('h3', 'control-heading', 'Request to be sent'),
            block,
            el('p', 'hint', result.preview.note),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          view.preview.replaceChildren(
            el('p', 'service-failure', `Could not build the preview: ${detail}`),
          );
        }
      })();
    });
    view.preview.replaceChildren(
      el('h3', 'control-heading', 'Request preview'),
      el(
        'p',
        'hint',
        'See the request before spending any budget. A preview sends nothing and costs nothing.',
      ),
      button,
    );
  };

  const renderControls = (): void => {
    // 重画只清内容，summary 留着——它就是这一节的标题与展开开关。
    // 先把「更多调整」是不是开着记下来：内容一清，原元素就没了，但这个状态要留住。
    const moreWasOpen =
      view.controlsBody.querySelector<HTMLDetailsElement>('details.more-controls')?.open ===
      true;
    view.controlsBody.replaceChildren();
    view.preview.replaceChildren();
    // 预览入口在任何时候都该在：它正是"Look before you spend"的那一步。
    void showPreview();
    // 手机默认收着：两个滑杆会把第一张片子挤到屏外去；桌面直接可调。
    // 但用户已经决定过的展开状态要尊重——重画不能把折叠区又合上。
    view.controls.open =
      controlsOpen ??
      (typeof window.matchMedia === 'function'
        ? window.matchMedia('(min-width: 720px)').matches
        : true);
    if (candidateState === null) return;
    const knobs = availableKnobs(candidateState.candidates, candidateState.seed.tags);

    // 上方只留**真正表达偏好**的两个滑杆，名字是人话。
    // 服务自己的相似度（affinity）默认就占满 100，那是"Order from the service"，
    // 把它当旋钮摆在最上面只会让人以为顺序是随它变的。
    const topKnobs = el('div', 'control-row');
    if (knobs.popularity) {
      topKnobs.append(
        knobBlock(
          'service-popularity-weight',
          'Favour popularity',
          'The more popular the film, the more this adds.',
          candidateState.controls.popularityWeight,
          (next) => updateControls({ ...candidateState!.controls, popularityWeight: next }),
          true,
        ),
      );
    }
    if (knobs.tagSimilarity) {
      topKnobs.append(
        knobBlock(
          'service-tag-similarity-weight',
          'Favour similar themes',
          'The more tags it shares with the seed, the more this adds.',
          candidateState.controls.tagSimilarityWeight,
          (next) =>
            updateControls({ ...candidateState!.controls, tagSimilarityWeight: next }),
          true,
        ),
      );
    }
    if (topKnobs.childElementCount > 0) {
      view.controlsBody.append(topKnobs);
    }
    if (!knobs.affinity) {
      view.controlsBody.append(
        el('p', 'hint', 'This response has no affinity field, so it cannot be reordered locally. Below is the order the service returned.'),
      );
    }

    // 其余的（服务自己的相似度权重、硬约束、重置）收进「更多调整」。
    const more = el('details', 'more-controls');
    more.append(el('summary', 'more-summary', 'More controls'));
    // 开着就继续开着：重画不该把用户刚展开的折叠区合上。
    more.open = moreWasOpen;
    const moreBody = el('div', 'more-body');
    moreBody.append(
      el('p', 'hint', 'The order is recomputed locally on this candidate set; no new request is sent. The score uses only fields the service really returned.'),
    );

    if (knobs.affinity) {
      moreBody.append(
        knobBlock(
          'service-affinity-weight',
          'Favour the service’s similarity',
          'How much weight the service’s affinity gets. At 100 the order follows the service’s affinity, with a deterministic tie-break when two films share it.',
          candidateState.controls.affinityWeight,
          (next) => updateControls({ ...candidateState!.controls, affinityWeight: next }),
        ),
      );
    }

    // 重置只动本地旋钮与硬约束：候选不动，所以不花额度。
    const reset = el('button', 'button-secondary', 'Reset to defaults');
    reset.id = 'service-reset';
    reset.type = 'button';
    reset.addEventListener('click', () => {
      if (candidateState === null) return;
      candidateState = {
        ...candidateState,
        controls: DEFAULT_SERVICE_CONTROLS,
        constraint: NO_CONSTRAINT,
      };
      renderControls();
      renderList();
      // 重画把按钮换掉了：焦点不还回去，键盘用户就掉回页面顶上。
      view.controlsBody.querySelector<HTMLButtonElement>('#service-reset')?.focus();
      announce('Weights and hard constraints are back to their defaults. The candidates did not change and nothing was re-requested.');
    });
    moreBody.append(reset);

    // 硬约束：在已取回的候选上本地筛选，改它不花额度。
    const constraintBlock = el('div', 'control-block');
    constraintBlock.append(el('h3', 'control-heading', 'Hard constraints'));
    constraintBlock.append(
      el(
        'p',
        'hint',
        'Filters applied locally to the candidates already fetched: a rating ceiling and an earliest release year. Changing them costs no budget.',
      ),
    );

    const ratingField = el('div', 'seed-field');
    const ratingLabel = el('label', 'control-label-text', 'Rating ceiling');
    ratingLabel.htmlFor = 'constraint-rating';
    const ratingSelect = el('select', 'select-input');
    ratingSelect.id = 'constraint-rating';
    const unlimited = el('option', '', 'Any');
    unlimited.value = '';
    ratingSelect.append(unlimited);
    CONTENT_RATING_ORDER.forEach((rating) => {
      const option = el('option', '', `${rating} or below`);
      option.value = rating;
      ratingSelect.append(option);
    });
    ratingSelect.value = candidateState.constraint.maxContentRating ?? '';
    ratingSelect.addEventListener('change', () => {
      updateConstraint({
        ...candidateState!.constraint,
        maxContentRating: ratingSelect.value === '' ? null : ratingSelect.value,
      });
    });
    ratingField.append(ratingLabel, ratingSelect);
    constraintBlock.append(ratingField);

    const yearField = el('div', 'seed-field');
    const yearLabel = el('label', 'control-label-text', 'Released no earlier than');
    yearLabel.htmlFor = 'constraint-year';
    const yearInput = el('input', 'text-input');
    yearInput.id = 'constraint-year';
    yearInput.type = 'number';
    yearInput.min = '1880';
    yearInput.max = '2100';
    yearInput.placeholder = 'Any';
    yearInput.value =
      candidateState.constraint.minReleaseYear === null
        ? ''
        : String(candidateState.constraint.minReleaseYear);
    yearInput.addEventListener('change', () => {
      const raw = yearInput.value.trim();
      const parsed = raw === '' ? null : Number(raw);
      if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1880 || parsed > 2100)) {
        showError('The earliest year must be a whole number between 1880 and 2100, or left empty.');
        return;
      }
      updateConstraint({
        ...candidateState!.constraint,
        minReleaseYear: parsed,
      });
    });
    yearField.append(yearLabel, yearInput);
    constraintBlock.append(yearField);
    moreBody.append(constraintBlock);

    more.append(moreBody);
    view.controlsBody.append(more);
  };

  /** 硬约束之后剩下的候选。 */
  const constrained = (): readonly ServiceCandidate[] => {
    if (candidateState === null) return [];
    return applyServiceConstraint(candidateState.candidates, candidateState.constraint).kept;
  };

  const ranked = (): readonly RankedServiceCandidate[] => {
    if (candidateState === null) return [];
    return rankServiceCandidates(
      constrained(),
      candidateState.controls,
      candidateState.seed.tags,
    );
  };

  /** 实体类别 URN → 人能读的类别名。 */
  const typeLabel = (urn: string): string => {
    if (urn.endsWith(':movie')) return 'Film';
    if (urn.endsWith(':artist')) return 'Artist';
    return urn.replace(/^urn:entity:/, '');
  };

  const renderList = (): void => {
    // 入场标记在这里被消费掉：这一次渲染带入场，之后的本地重排不再带。
    view.list.classList.toggle('is-entering', entrancePending);
    entrancePending = false;
    view.list.replaceChildren();
    // 标题写清里面是哪一类实体——否则选了"Artist"之后看到的是什么就没处问。
    view.listHeading.textContent =
      candidateState === null
        ? 'Similar films'
        : candidateState.seed.name === ''
          ? 'Similar films'
          : `Similar to “${candidateState.seed.name}”`;
    if (candidateState === null) return;
    const outcome = applyServiceConstraint(candidateState.candidates, candidateState.constraint);
    const rows = ranked();

    if (rows.length === 0) {
      // 两种空不是一回事：服务没给候选，和本地硬约束把候选全挡下了。
      if (candidateState.candidates.length === 0) {
        view.statusLine.textContent = '';
        view.list.append(el('li', 'list-empty', 'The service returned no candidates.'));
        return;
      }
      view.statusLine.textContent = `0 similar films · ${outcome.violated.length} filtered out`;
      view.list.append(
        el(
          'li',
          'list-empty',
          `The service returned ${candidateState.candidates.length} candidates, but the current hard constraints block all of them. Raise the rating ceiling or lower the earliest year to see them.`,
        ),
      );
      return;
    }
    const moved = rows.filter((row) => row.deltaRank !== 0).length;
    const filtered =
      outcome.violated.length === 0 ? '' : `  · ${outcome.violated.length} filtered out`;
    const unknown =
      outcome.unverifiable.length === 0 ? '' : `  · ${outcome.unverifiable.length} with incomplete data`;
    // 这一行是给人看的：几部、动了几个。别把开发者Metric摆在这儿。
    view.statusLine.textContent =
      `${rows.length} similar films` + (moved === 0 ? '' : `  · ${moved} reordered`) + filtered + unknown;

    // 开发者Metric挪进Developer diagnostics：有用，但不占消费界面。
    const affinities = rows
      .map((row) => row.candidate.affinity)
      .filter((value): value is number => value !== null);
    const span =
      affinities.length === 0
        ? ''
        : ` Affinity ${Math.min(...affinities).toFixed(2)}–${Math.max(...affinities).toFixed(2)}`;
    view.devMetrics.textContent =
      `${rows.length} candidates · ${moved} changed rank against the default weights${span}${filtered}${unknown}`;
    const shown = rows.slice(0, visibleCount);
    shown.forEach((row) => {
      const item = el('li', 'service-item');
      item.dataset.movieId = row.candidate.id;
      if (row.rank === 1) item.classList.add('is-hero');
      if (row.candidate.id === selectedId) item.classList.add('is-selected');

      const card = el('div', 'service-item-body');
      card.append(posterFrame(row.candidate.details.imageUrl, `Poster of ${row.candidate.name}`));

      const meta = el('div', 'service-item-meta');
      meta.append(el('p', 'service-item-rank', `Rank ${row.rank}`));
      if (row.deltaRank !== 0) {
        meta.append(
          el(
            'p',
            'service-item-delta',
            row.deltaRank > 0
              ? `${row.deltaRank} places up from default`
              : `${Math.abs(row.deltaRank)} places down from default`,
          ),
        );
      }

      // 标题用**服务给的那个名字**（API 里的英文名）。别名（可能有中文原名）只进
      // 折叠起来的"片目与影评"里，不占标题，也不进播报——不编造翻译。
      const alias = row.candidate.details.alsoKnownAs;
      const title = el('h3', 'service-item-title');
      const button = el('button', 'movie-button movie-title', row.candidate.name);
      button.type = 'button';
      button.setAttribute('aria-pressed', row.candidate.id === selectedId ? 'true' : 'false');
      button.addEventListener('click', () => {
        selectedId = row.candidate.id;
        renderList();
        announce(
          row.deltaRank === 0
            ? `Selected ${row.candidate.name}, currently rank ${row.rank}, rank unchanged`
            : `Selected ${row.candidate.name}, currently rank ${row.rank}, ${row.deltaRank > 0 ? 'up' : 'down'} ${Math.abs(row.deltaRank)} places from default`,
        );
      });
      title.append(button);
      meta.append(title);

      // 别名不进卡片正面：正面只留服务给的那个名字。
      // 年份、片长、分级：服务没给就不显示，不编。
      const facts: string[] = [];
      if (row.candidate.details.releaseYear !== undefined) {
        facts.push(String(row.candidate.details.releaseYear));
      }
      if (row.candidate.details.duration !== undefined) {
        facts.push(`${row.candidate.details.duration} min`);
      }
      if (row.candidate.details.contentRating !== undefined) {
        facts.push(row.candidate.details.contentRating);
      }
      if (facts.length > 0) meta.append(el('p', 'service-item-facts', facts.join(' · ')));

      // 先给简介：这是服务给的一段真实短简介，是Film本身的内容，
      // 不是分数也不是我们自己编的理由。服务没给就不显示。
      const synopsis = row.candidate.details.description;
      if (synopsis !== undefined && synopsis.trim().length > 0) {
        // 简介是服务返回的原文（这次是英文）。不假装翻译，也不假装有中文版。
        meta.append(el('p', 'service-item-synopsis-label', 'Synopsis · as returned by the service'));
        const text = el('p', 'service-item-synopsis', synopsis);
        meta.append(text);
        // 长简介默认只露两行；展开才看全文。
        const toggle = el('button', 'link-button synopsis-toggle', 'Expand synopsis');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          const open = text.classList.toggle('is-open');
          toggle.textContent = open ? 'Collapse synopsis' : 'Expand synopsis';
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        toggle.setAttribute('aria-expanded', 'false');
        meta.append(toggle);
        // 简介本来就放得下的时候，这个按钮点了什么也不会发生——那是假按钮。
        // 量一下真实高度，放得下就收起来。量不出来（仿真里没有布局）就保守保留。
        requestAnimationFrame(() => {
          const shown = text.clientHeight;
          if (shown === 0) return;
          toggle.hidden = text.scrollHeight <= shown + 1;
        });
      }

      // 两个动作，名字要说清各自管什么：一个是片目与影评，一个是排名解释。
      const actions = el('div', 'service-item-actions');
      const materials = el('details', 'service-materials');
      materials.append(el('summary', 'service-materials-summary', 'Filmography and reviews'));
      const materialsPanel = el('div', 'service-evidence service-materials-body');
      materials.append(materialsPanel);
      const why = el('details', 'service-why');
      why.append(el('summary', 'service-why-summary', 'Why it is ranked here'));
      const panel = el('div', 'service-evidence service-why-body');
      why.append(panel);
      actions.append(materials, why);

      card.append(meta);
      item.append(card, actions);
      view.list.append(item);

      renderMaterialsBody(materialsPanel, row);
      renderEvidenceBody(panel, row);
    });
    // 剩下的不藏着，只是先不铺开——一眼看完 20 部反而看不出名次怎么变的。
    if (rows.length > shown.length) {
      const remaining = rows.length - shown.length;
      const more = el(
        'button',
        'button-secondary',
        `Show ${Math.min(REVEAL_STEP, remaining)} more of ${remaining}`,
      );
      more.id = 'service-reveal-more';
      more.type = 'button';
      more.addEventListener('click', () => {
        visibleCount += REVEAL_STEP;
        renderList();
        announce(`Now showing ${Math.min(visibleCount, rows.length)} of ${rows.length} similar films`);
      });
      const moreRow = el('li', 'list-empty reveal-more-row');
      moreRow.append(more);
      view.list.append(moreRow);
    }
  };


  /**
   * 一部Film的展开说明：服务给了什么、本地怎么排的、哪些能自己核对。
   *
   * 默认是收起来的（渐进披露）：卡片上只有一句可核对的关联分。
   */
  const renderEvidenceBody = (
    target: HTMLElement,
    row: RankedServiceCandidate,
  ): void => {
    const state = candidateState;
    if (state === null) return;
    const candidate = row.candidate;
    target.append(el('h3', 'control-heading', candidate.name));

    const table = el('table', 'score-table');
    table.append(el('caption', '', 'How the service fields map onto the local heuristic score'));
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', '', 'Item'),
      el('th', '', 'Raw value'),
      el('th', '', 'Current'),
    );
    headRow.querySelectorAll('th').forEach((cell) => cell.setAttribute('scope', 'col'));
    head.append(headRow);
    table.append(head);

    const body = el('tbody');
    const addRow = (label: string, raw: string, current: string): void => {
      const tr = el('tr');
      tr.append(el('th', '', label), el('td', '', raw), el('td', '', current));
      tr.firstElementChild?.setAttribute('scope', 'row');
      body.append(tr);
    };
    addRow(
      'Service rank',
      row.serviceRank === null ? '—' : String(row.serviceRank),
      String(row.rank),
    );
    addRow(
      'Affinity',
      candidate.affinityRaw === null ? 'Not returned' : formatRaw(candidate.affinityRaw),
      formatScore(row.affinityContribution),
    );
    addRow(
      'Popularity',
      candidate.popularity === null ? 'Not returned' : formatScore(candidate.popularity),
      formatScore(row.popularityContribution),
    );
    if (candidate.details.alsoKnownAs !== undefined) {
      addRow('Aliases', '—', candidate.details.alsoKnownAs);
    }
    if (candidate.disambiguation !== undefined) {
      addRow('Disambiguation', '—', candidate.disambiguation);
    }
    addRow(
      'Tag similarity (computed locally)',
      row.tagSimilarityRaw === null ? 'Cannot be computed' : formatScore(row.tagSimilarityRaw),
      formatScore(row.tagSimilarityContribution),
    );
    addRow('Heuristic score', formatScore(row.baselineScore), formatScore(row.score));
    table.append(body);
    target.append(table);

    target.append(
      el(
        'p',
        'hint',
        'The local score is a heuristic value produced by reordering the fields the service returned using your weights. It is not a preference probability and it does not measure recommendation quality.' +
          'Tag similarity is computed locally from the tags the seed and the candidate share; it is not a score from the service.' +
          'The “Current” column is the part of it that counts with the weights you set.',
      ),
    );

    if (candidate.contributions.length > 0) {
      target.append(
        el('h3', 'control-heading', 'Attribution from the service (structured metadata)'),
        el(
          'p',
          'hint',
          'This is the share of the contribution the service computed for the input entities, not a natural-language “reason”.' +
            (candidate.contributions.length === 1
              ? 'Only one seed was entered this time, so it is always 100% (all of it comes from that seed) — that is attribution, not anyone’s preference probability.'
              : ''),
        ),
      );
      const list = el('ul', 'contribution-list');
      candidate.contributions.forEach((item) => {
        // 实测服务只给 entity_id，不给名字。拿Current种子的名字顶上，
        // 比在界面上甩一串 GUID 像人话；不是Current种子的就照实显示 id。
        const label =
          item.entityId === state.seed.entityId ? state.seed.name : item.entityName;
        list.append(el('li', '', `${label}: ${formatScore(item.score)}`));
      });
      target.append(list);
    }

  };

  /**
   * 「可用资料」：能用得上的、能自己核对的东西——外部标识、去向、影评链接。
   *
   * 跟「为什么这部」分开：一个是资料，一个是排名解释。混在一起就成了技术大杂烩。
   */
  /** 从服务给的 URL 里取域名当链接文字；取不到就返回 null（不编造）。 */
  const safeHost = (href: string): string | null => {
    try {
      const url = new URL(href);
      return url.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };

  const renderMaterialsBody = (
    target: HTMLElement,
    row: RankedServiceCandidate,
  ): void => {
    const details = row.candidate.details;
    // **有用的在前**：年份、日期、分级、片长、流媒体——使用者要看的。
    const detailRows: [string, string][] = [
      ...(details.releaseYear === undefined ? [] : [['Release year', String(details.releaseYear)] as [string, string]]),
      ...(details.releaseDate === undefined ? [] : [['Release date', details.releaseDate] as [string, string]]),
      ...(details.contentRating === undefined ? [] : [['Rating', details.contentRating] as [string, string]]),
      ...(details.duration === undefined
        ? []
        : [['Runtime', `${details.duration} min`] as [string, string]]),
      ...(details.streamingServices === undefined
        ? []
        : [['Streaming services listed by the service', details.streamingServices.join(', ')] as [string, string]]),
    ];
    if (detailRows.length > 0) {
      target.append(el('h3', 'control-heading', 'Details you can check'));
      const list = el('ul', 'detail-list');
      detailRows.forEach(([label, value]) => {
        list.append(el('li', '', `${label}: ${value}`));
      });
      target.append(list);
    }
    if (details.streamingServices !== undefined) {
      target.append(
        el(
          'p',
          'hint',
          'Where it can be watched is service-supplied: it comes from the streaming tags or external id keys the service gave for this film. We do not look up streaming sources. ' +
            'This is not a live availability check — there is no availability evidence here, so we do not claim “you can watch it now”.',
        ),
      );
    }

    // **技术性的收进可选的折叠区**：外部标识有八九行、影评链接是裸 URL，
    // 对核对字段的人有用，对使用者只是噪音，所以默认收起。
    const externalRows: [string, string][] =
      details.externalIds === undefined
        ? []
        : Object.entries(details.externalIds).map(
            ([key, value]) => [`External ID · ${key}`, value] as [string, string],
          );
    // 实测这些是影评站之类的相关链接，不是"Official entity page"，所以不能那样叫。
    const links = details.relatedLinks ?? [];
    if (externalRows.length > 0 || links.length > 0) {
      const technical = el('details', 'service-technical');
      technical.append(
        el('summary', 'service-technical-summary', 'Technical identifiers and review links'),
      );
      const body = el('div', 'service-technical-body');
      if (externalRows.length > 0) {
        const list = el('ul', 'detail-list');
        externalRows.forEach(([label, value]) => {
          list.append(el('li', '', `${label}: ${value}`));
        });
        body.append(list);
      }
      technical.append(body);
      target.append(technical);
    }

    // **影评链接留在明面上**：它们是使用者真正用得上的东西，不能埋在技术标识底下。
    // 链接文字用**域名**（从服务给的 URL 里取），不是一整条裸 URL；**不假装可用性已核实**。
    if (links.length > 0) {
      target.append(el('h3', 'control-heading', 'Review links'));
      const list = el('ul', 'detail-list');
      links.slice(0, 3).forEach((href) => {
        const item = el('li');
        const host = safeHost(href);
        const link = el('a', 'detail-link', host ?? href);
        link.href = href;
        link.rel = 'noreferrer noopener';
        link.target = '_blank';
        item.append(link);
        list.append(item);
      });
      target.append(
        list,
        el('p', 'hint', 'Review links given by the service, not the official entity page; only the first few are listed. We did not check whether they are reachable.'),
      );
    } else {
      target.append(el('p', 'hint', 'The service returned no related links, and we do not invent one.'));
    }
  };

  /** 改硬约束：本地重新筛选，不重新请求。 */
  const updateConstraint = (next: ServiceConstraint): void => {
    if (candidateState === null) return;
    candidateState = { ...candidateState, constraint: next };
    renderList();
    const outcome = applyServiceConstraint(candidateState.candidates, next);
    announce(
      `Hard constraints updated: ${outcome.kept.length} kept, ${outcome.violated.length} blocked.`,
    );
  };

  const updateControls = (next: ServiceControls): void => {
    if (candidateState === null) return;
    const validation = validateServiceControls({
      affinityWeight: next.affinityWeight,
      popularityWeight: next.popularityWeight,
      tagSimilarityWeight: next.tagSimilarityWeight,
    });
    if (!validation.ok) return;
    candidateState = { ...candidateState, controls: validation.controls };
    renderList();
    announce(`Re-ranked with the new weights: ${ranked().length} candidates.`);
  };

  view.seedChange.addEventListener('click', () => {
    showFindForm();
  });

  /** 「Change the film」：把输入框放回来，之前确认过的消歧列表一并收掉。 */
  const showFindForm = (): void => {
    setResultState(false);
    view.form.hidden = false;
    view.advanced.hidden = false;
    view.seedBar.hidden = true;
    resolution = { kind: 'idle' };
    renderResolution();
    // 旧候选也要收掉：种子条一藏，那五张片子就没了身份——
    // 界面上留着一部片的候选、种子却不见了，是在骗人。
    candidateState = null;
    selectedId = null;
    renderControls();
    renderList();
    view.seedInput.focus();
    announce('Ready for another film');
  };

  /**
   * 结果状态：把首屏的大标题收起来。
   *
   * 用户已经选好片了，大标题还在重复介绍"What is this"——那半屏是浪费。
   * 身份由种子条承担（你的种子 / 片名 / 年份）。
   */
  const setResultState = (active: boolean): void => {
    document.body.classList.toggle('is-result', active);
  };

  /** 紧凑种子条：确认之后顶替输入框。 */
  const renderSeedBar = (seed: SeedRef): void => {
    view.seedBarTitle.textContent = seed.name;
    // 有上映年份就写年份；没有（Artist）就写消歧串——那是唯一的区分。
    view.seedBarFacts.textContent =
      seed.year !== undefined
        ? `${seed.year}`
        : seed.disambiguation !== undefined
          ? seed.disambiguation
          : '';
    view.seedBar.hidden = false;
  };

  /** 拿不到候选时的出路：用上一次解析出来的种子重试，不用重新输一遍。 */
  const retryLastSeed = (): void => {
    if (lastSeed === null) return;
    void loadCandidates(lastSeed);
  };

  /**
   * 取回候选。
   *
   * 种子是一个整体传进来的：身份、名字、标签都出自**同一次解析**。
   * 早先这里读的是一个外层的 seedTags 全局变量，于是消歧那条路上
   * （用户从多个候选里挑一个）传进来的标签被丢掉了：标签相似度要么不出现，
   * 要么拿上一次查询的种子标签去算——两种都是拿别的种子的数据冒充。
   */
  const loadCandidates = async (seed: SeedRef): Promise<void> => {
    if (loadingCandidates) return;
    loadingCandidates = true;
    view.submit.disabled = true;
    // 先记下这次用的种子：失败时"Fetch candidates again"要靠它，请求预览也靠它。
    lastSeed = seed;
    candidateState = null;
    selectedId = null;
    renderControls();
    renderList();
    // 这一句要留着句柄：请求结束（成功或失败）都得把它收掉，
    // 否则"Fetching candidates…"会一直挂在界面上，像是还在取。
    const loading = el('p', 'hint', 'Fetching candidates…');
    view.resolution.append(loading);
    try {
      const outcome = await api.candidates(seed.entityId, 20);
      if (outcome.status === 'ok') {
        // 重试成功了就把上一次的失败收掉，别让红字留在已经拿到结果的界面上。
        showError(null);
        // 确认之后把输入收成一条种子条：第一屏要看得见Film，不是看得见输入框。
        setResultState(true);
        renderSeedBar(seed);
        view.form.hidden = true;
        view.advanced.hidden = true;
        // 消歧列表与「就这部」按钮一起收掉——它们已经完成任务了。
        // 必须**真的重画一次**：只改状态不清 DOM，旧列表与按钮会一直占着位置。
        resolution = { kind: 'confirmed' };
        renderResolution();
        // 新一批候选：展开数收回默认，别把上一批的"再看几部"带过来。
        visibleCount = REVEAL_STEP;
        candidateState = {
          candidates: outcome.candidates,
          constraint: NO_CONSTRAINT,
          // 输出领域固定是电影：种子是Artist也返回电影。
          entityType: OUTPUT_ENTITY_TYPE_URN,
          seed,
          controls: DEFAULT_SERVICE_CONTROLS,
          ...(outcome.explainabilityWarning === undefined
            ? {}
            : { explainabilityWarning: outcome.explainabilityWarning }),
        };
        selectedId = outcome.candidates[0]?.id ?? null;
        // 这一批是服务刚送回来的：让结果卡逐张入场（本地重排不会走到这里）。
        entrancePending = true;
        // 消歧面板被收走了，焦点别丢：把它送到结果区的标题上。
        view.listHeading.focus();
        announce(`Fetched ${outcome.candidates.length} candidates.`);
      } else if (outcome.status === 'empty') {
        showError(outcome.message, retryLastSeed);
      } else if (outcome.status === 'not_configured') {
        showError(`The live service is not configured: missing ${outcome.missing.join(', ')}.`);
      } else if (outcome.status === 'invalid_input') {
        showError(outcome.issues.join('；'));
      } else {
        showError(outcome.message, retryLastSeed);
      }
      if (
        candidateState !== null &&
        candidateState.explainabilityWarning !== undefined
      ) {
        showError(`Service note: ${candidateState.explainabilityWarning}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      showError(`Could not fetch candidates: ${detail}`, retryLastSeed);
    } finally {
      loadingCandidates = false;
      view.submit.disabled = false;
      loading.remove();
      // 收尾时也重画一次解析区：加载提示与旧消歧列表都不会留着占位置。
      renderResolution();
      renderControls();
      renderList();
      await refreshStatus();
    }
  };

  view.submit.addEventListener('click', () => {
    void (async () => {
      if (pending) return;
      pending = true;
      showError(null);
      view.submit.disabled = true;
      // 重新查一部片：输入框与高级入口都放回来，上一次的种子条收掉。
      setResultState(false);
      view.form.hidden = false;
      view.advanced.hidden = false;
      view.seedBar.hidden = true;
      resolution = { kind: 'busy' };
      candidateState = null;
      selectedId = null;
      // 换一个种子重查时，上一个种子就不再是"The one used next time"了。
      // 不清掉的话，请求预览会拿旧种子去预览——看到的和真正会发出去的不是一回事。
      lastSeed = null;
      renderResolution();
      renderControls();
      renderList();
        try {
        const outcome = await api.resolve(
          view.seedInput.value,
          view.entityType.value as SeedEntityType,
        );
        if (outcome.status === 'resolved') {
          resolution = {
            kind: 'resolved',
            entityId: outcome.entity.id,
            name: outcome.entity.name,
            type: outcome.entity.type,
            ...(outcome.entity.year === undefined ? {} : { year: outcome.entity.year }),
            ...(outcome.entity.disambiguation === undefined
              ? {}
              : { disambiguation: outcome.entity.disambiguation }),
            tags: outcome.entity.tags,
          };
          announce(`Resolved: ${outcome.entity.name}`);
          await loadCandidates({
            entityId: outcome.entity.id,
            name: outcome.entity.name,
            ...(outcome.entity.year === undefined ? {} : { year: outcome.entity.year }),
            ...(outcome.entity.disambiguation === undefined
              ? {}
              : { disambiguation: outcome.entity.disambiguation }),
            tags: outcome.entity.tags,
          });
        } else if (outcome.status === 'ambiguous') {
          resolution = {
            kind: 'ambiguous',
            candidates: outcome.candidates.map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              ...(item.year === undefined ? {} : { year: item.year }),
              ...(item.disambiguation === undefined
                ? {}
                : { disambiguation: item.disambiguation }),
              ...(item.imageUrl === undefined ? {} : { imageUrl: item.imageUrl }),
              tags: item.tags,
            })),
          };
          announce(`That name matched ${outcome.candidates.length} entities; pick one.`);
        } else if (outcome.status === 'empty') {
          resolution = { kind: 'failed', message: outcome.message };
          showError(outcome.message);
        } else if (outcome.status === 'not_configured') {
          resolution = {
            kind: 'failed',
            message: `The live service is not configured: missing ${outcome.missing.join(', ')}.`,
          };
          showError(resolution.message);
        } else if (outcome.status === 'invalid_input') {
          resolution = { kind: 'failed', message: outcome.issues.join('；') };
          showError(resolution.message);
        } else {
          resolution = { kind: 'failed', message: outcome.message };
          showError(outcome.message);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        resolution = { kind: 'failed', message: `Could not reach the live service: ${detail}` };
        showError(resolution.message);
      } finally {
        pending = false;
        view.submit.disabled = false;
        renderResolution();
        await refreshStatus();
      }
    })();
  });

  return {
    async start(): Promise<void> {
      renderStatus();
      // 预览入口从一开始就该在：用户还没花任何额度就能先看清请求长什么样。
      renderControls();
      try {
        const status = await api.status();
        renderConfigured(status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        renderStatusFailed(detail);
      }
    },
  };
}
