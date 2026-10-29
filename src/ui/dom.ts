export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

export function formatScore(value: number): string {
  return value.toFixed(2);
}

/**
 * 原值：服务给的数原样显示，但最多留四位小数。
 *
 * 0.9876543210987654 这种数字在界面上没法读；四位小数足够自己核对，
 * 精确到机器精度的原值在"保存真实响应"里。
 */
export function formatRaw(value: number): string {
  const rounded = Number(value.toFixed(4));
  return String(rounded);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 海报框：只用响应里给的那张图。
 *
 * 图加载不出来（没网、被安全策略挡住、服务压根没给）就换成一块诚实的文字块。
 * 不画占位海报，也不拿别处的图来凑——没有图就是没有图。
 */
/**
 * 已经真加载成功过的海报地址。
 *
 * 本地重排会重建卡片（renderList 每次 replaceChildren），于是同一张海报会**再 new 一次**。
 * 命中缓存就直接可见：不闪空、不重播一次淡入。只有第一次真加载才淡入。
 */
const loadedPosterUrls = new Set<string>();

export function posterFrame(imageUrl: string | undefined, altText: string): HTMLElement {
  const frame = el('div', 'poster');
  // 两件事要说准：**服务没给**海报，和**给了但没加载出来**，不是一回事。
  // 后者不能说"没有图片"——服务明明给了地址，而且 2:3 的位还占着：
  // 慢网或图挂了都不能让下面的字往上跳。
  const note = (text: string, state: 'is-empty' | 'is-failed'): void => {
    frame.classList.add(state);
    frame.replaceChildren(el('span', 'poster-note', text));
  };
  if (imageUrl === undefined) {
    // 一开始就没有图：紧凑状态，不占 2:3 的位。
    note('The service did not provide a poster', 'is-empty');
    return frame;
  }
  const image = el('img', 'poster-image');
  image.alt = altText;
  image.loading = 'lazy';
  image.decoding = 'async';
  // 事件先挂再给 src：命中缓存时 load 可能已经过去了。
  image.addEventListener('load', () => {
    loadedPosterUrls.add(imageUrl);
    image.classList.add('is-loaded');
  });
  if (loadedPosterUrls.has(imageUrl)) {
    // 命中缓存（本地重排重建了卡片）：一上来就可见。
    image.classList.add('is-loaded');
  }
  image.addEventListener('error', () => note('The poster could not be loaded', 'is-failed'));
  image.src = imageUrl;
  frame.append(image);
  return frame;
}

/** 名次变化文案：正向用「上升」，不靠颜色单独表意。 */
export function formatDelta(delta: number): string {
  if (delta > 0) return `↑ ${delta}`;
  if (delta < 0) return `↓ ${Math.abs(delta)}`;
  return '—';
}
