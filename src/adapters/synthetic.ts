import type { SyntheticDataset } from '../core/types.js';
import { findScenario } from './scenarios.js';

// 全部标题、标签、关系值与分数都是人工构造的合成数据。
// 它们不是 Qloo 元数据，不代表任何真实用户的偏好，也不证明推荐质量。

const cityNight = findScenario('city-night');
if (cityNight === undefined) {
  throw new Error('Missing the "City at night" scenario data');
}

/**
 * 测试用的固定数据集。
 * 直接引用场景库里的那份数据，而不是再抄一遍：抄两份的代价是改了一处、另一处静默过期，
 * 算分回归就会对着过期数据断言，而界面上跑的是新数据。
 */
export const syntheticDataset: SyntheticDataset = cityNight.dataset;
