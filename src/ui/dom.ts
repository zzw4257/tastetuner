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
export function posterFrame(imageUrl: string | undefined, altText: string): HTMLElement {
  const frame = el('div', 'poster');
  // 两件事要说准：**服务没给**海报，和**给了但没加载出来**，不是一回事。
  // 后者不能说"没有图片"——服务明明给了地址。
  const degrade = (text: string): void => {
    frame.classList.add('is-empty');
    frame.replaceChildren(el('span', 'poster-note', text));
  };
  if (imageUrl === undefined) {
    degrade('The service did not provide a poster');
    return frame;
  }
  const image = el('img', 'poster-image');
  image.src = imageUrl;
  image.alt = altText;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('error', () => degrade('The poster could not be loaded'));
  frame.append(image);
  return frame;
}

/** 名次变化文案：正向用「上升」，不靠颜色单独表意。 */
export function formatDelta(delta: number): string {
  if (delta > 0) return `↑ ${delta}`;
  if (delta < 0) return `↓ ${Math.abs(delta)}`;
  return '—';
}
