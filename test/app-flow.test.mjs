// 应用级行为检查：DOM 仿真，不是浏览器验收。
//
// 这些用例直接驱动 `src/ui/app.ts` 这条真实入口，覆盖 SPEC 里"一条演示路径"
// 的每一步。它替代不了被禁止的浏览器/读屏/人工视觉验收，只证明状态机与接线。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, cleanupApp } from './helpers/app-harness.mjs';

after(() => cleanupApp());

/** 离线演示是显式隔开的第二条路：既有用例都先切过去。 */
async function bootDemo(options) {
  const app = await bootApp(options);
  app.switchMode('demo');
  return app;
}

/** 榜单行按当前顺序读出来，便于比较名次与分数。 */
function ids(rows) {
  return rows.map((row) => row.id);
}

test('首屏：合成标识、20 部候选、默认选中第一部、解释面板有内容', async () => {
  const app = await bootDemo();
  assert.match(app.text('.demo-badge'), /Synthetic data/);
  assert.match(app.text('.source-note'), /synthetic/);

  const rows = app.rows();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].id, 'film-a');
  assert.equal(rows[0].score, '72.00');
  assert.equal(rows[0].selected, true);
  assert.equal(app.rows().filter((row) => row.selected).length, 1);

  assert.match(app.text('.ranking-status'), /20 candidates/);
  assert.match(app.text('.seed-title'), /Last Tram Home/);
  assert.match(app.text('.evidence-title'), /Warm City Lights/);
  assert.match(app.text('.evidence-panel'), /Heuristic score/);
});

test('差异权重拉满会换位，基线名次始终是默认权重的结果', async () => {
  const app = await bootDemo();
  const before = app.rows();
  assert.ok(before.every((row) => row.delta === '—'));

  app.setRange('tag-difference', 100);
  const after = app.rows();

  const moved = after.filter((row) => row.delta !== '—');
  assert.ok(moved.length > 0, '提高差异权重应当产生换位');
  assert.ok(moved.some((row) => row.delta.startsWith('↑')));
  assert.ok(moved.some((row) => row.delta.startsWith('↓')));

  // 解释面板里的"默认"列必须还是默认权重下的名次，不随滑杆变化。
  app.setRange('tag-difference', 50);
  const evidence = app.text('.evidence-panel');
  const defaultRank = evidence.match(/Default#(\d+)/);
  assert.ok(defaultRank !== null, '解释面板应给出默认名次');
});

test('关系权重归零后只剩标签差异奖励，排序与默认完全不同', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());
  app.setRange('relation-weight', 0);
  const after = ids(app.rows());
  assert.notDeepEqual(after, before);
  assert.match(app.text('.ranking-status'), /relation 0 /);
});

test('最小重合标签会缩小候选集，并说明每一部为什么被挡下', async () => {
  const app = await bootDemo();
  app.setShared(2);
  const rows = app.rows();
  assert.ok(rows.length < 20);
  assert.match(app.text('.notices'), /Blocked by the minimum shared tags rule/);
  assert.match(app.text('.notices'), /below the required 2/);
});

test('重置回到默认权重、默认候选集与默认选中', async () => {
  const app = await bootDemo();
  const original = ids(app.rows());

  app.setRange('relation-weight', 10);
  app.setRange('tag-difference', 90);
  app.setShared(2);
  assert.notDeepEqual(ids(app.rows()), original);

  app.query('#reset').dispatchEvent(new app.window.Event('click'));
  const restored = app.rows();
  assert.deepEqual(ids(restored), original);
  assert.equal(restored.length, 20);
  assert.equal(restored.filter((row) => row.delta !== '—').length, 0);
  assert.equal(restored[0].selected, true);
  assert.match(app.text('.ranking-status'), /relation 80 \/ difference 0 · minimum shared 0/);
});

test('切换场景换榜、更新种子卡片，并清掉上一场景的选中态', async () => {
  const app = await bootDemo();
  app.clickScenario('sea-drift');
  const rows = app.rows();
  assert.equal(rows.length, 14);
  assert.equal(rows[0].id, 'sea-01');
  assert.match(app.text('.seed-title'), /Tide Post Office/);
  assert.match(app.text('.seed-card'), /Slow films by the sea/);
  assert.equal(rows.filter((row) => row.selected).length, 1);
  assert.equal(rows[0].selected, true);
});

test('空信号场景是空状态，不残留上一份榜单', async () => {
  const app = await bootDemo();
  app.clickScenario('city-night');
  assert.equal(app.rows().length, 20);

  app.clickScenario('no-signals');
  assert.equal(app.rows().length, 0);
  assert.match(app.text('.movie-list'), /The current candidate set is empty/);
  assert.doesNotMatch(app.text('.movie-list'), /Warm City Lights/);
  assert.match(app.text('.notices'), /Dropped for incomplete data: 3/);
});

test('边界场景保留完全并列、零分与长标题', async () => {
  const app = await bootDemo();
  app.clickScenario('edge-cases');
  const rows = app.rows();
  assert.equal(rows.length, 5, '三部资料不全的影片应被排除，其余五部留在榜上');

  const tieA = rows.find((row) => row.id === 'edge-tie-a');
  const tieB = rows.find((row) => row.id === 'edge-tie-b');
  assert.equal(tieA?.score, tieB?.score);
  assert.ok(tieA?.rank < tieB?.rank, '同分按 ID 升序');

  const zero = rows.find((row) => row.id === 'edge-zero');
  assert.equal(zero?.score, '0.00');
  assert.ok(rows.some((row) => row.title.length > 30), '长标题应完整保留');
});

test('大集合场景渲染 240 行且顺序稳定', async () => {
  const app = await bootDemo();
  app.clickScenario('large-cohort');
  const rows = app.rows();
  assert.equal(rows.length, 240);
  assert.equal(new Set(ids(rows)).size, 240);
  assert.equal(ids(app.rows())[0], rows[0].id);
});

test('解释面板给出默认/当前名次与两项贡献，且当前总分等于两项之和', async () => {
  const app = await bootDemo();
  app.setRange('tag-difference', 60);
  app.setRange('relation-weight', 55);

  const cells = app
    .queryAll('.score-table tbody tr')
    .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent));
  assert.equal(cells.length, 3);

  const base = Number(cells[0][2]);
  const difference = Number(cells[1][2]);
  const total = Number(cells[2][2]);
  assert.ok(Math.abs(base + difference - total) < 1e-9, '当前列的两项贡献必须加总到总分');

  const baselineTotal = Number(cells[2][1]);
  assert.ok(Math.abs(base + difference - total) < 1e-9);
  assert.ok(Number.isFinite(baselineTotal));
});

test('导出 JSON 只含约定字段，并能原样导回', async () => {
  const app = await bootDemo();
  app.clickExport();
  const text = await app.exportedText();
  const payload = JSON.parse(text);

  assert.deepEqual(Object.keys(payload).sort(), ['dataset', 'format', 'settings', 'version']);
  assert.equal(payload.format, 'taste-tuner/scenario');
  assert.equal(payload.version, 1);
  assert.equal(payload.dataset.movies.length, 20);
  assert.doesNotMatch(text, /api[-_]?key|token|secret|password/i);

  app.clickScenario('sea-drift');
  assert.equal(app.rows().length, 14);

  app.importFile({
    name: 'round-trip.json',
    size: Buffer.byteLength(text, 'utf8'),
    text: async () => text,
  });
  await app.flush();

  assert.equal(app.rows().length, 20);
  assert.match(app.text('.seed-title'), /Last Tram Home/);
  assert.match(app.text('.seed-card'), /Imported file/);
});

test('导入坏文件整体拒绝，当前场景与参数原样保留', async () => {
  const app = await bootDemo();
  app.setRange('relation-weight', 30);
  const before = ids(app.rows());

  app.importFile({
    name: 'broken.json',
    size: 12,
    text: async () => '{ not json',
  });
  await app.flush();

  assert.deepEqual(ids(app.rows()), before);
  assert.match(app.text('.error-message'), /The action did not complete/);
  assert.match(app.text('.error-message'), /not valid JSON/);
});

test('导入超过上限的文件在读取前就被挡下', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());

  app.importFile({
    name: 'huge.json',
    size: 512 * 1024 + 1,
    text: async () => {
      throw new Error('不应该读到内容');
    },
  });
  await app.flush();

  assert.deepEqual(ids(app.rows()), before);
  assert.match(app.text('.error-message'), /too large/);
});

test('晚到的旧导入不会覆盖新意图', async () => {
  const app = await bootDemo();
  app.clickExport();
  const valid = await app.exportedText();

  // 先发起一个慢读取，再发起一个快读取；慢的那个必须被作废。
  app.importFile({
    name: 'slow.json',
    size: Buffer.byteLength(valid, 'utf8'),
    text: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return valid;
    },
  });
  app.importFile({
    name: 'fast.json',
    size: 40,
    text: async () => '{ broken',
  });
  await app.flush();
  await app.wait(120);

  assert.match(app.text('.error-message'), /not valid JSON/);
  assert.notEqual(app.text('.seed-card'), '');
});

test('比较视图的基线口径与跨场景口径都不做逐片归因', async () => {
  const app = await bootDemo();
  app.clickTab('compare');

  const baselineRows = app.queryAll('.compare-body .compare-table tbody tr');
  assert.equal(baselineRows.length, 20);

  app.selectCompareMode('scenario');
  app.setCompareScenario('sea-drift');
  const warning = app.text('.compare-summary');
  assert.match(warning, /The two scenarios are different fictional candidate sets/);
  assert.match(warning, /cannot be attributed film by film/);

  const statRows = app.queryAll('.compare-body .compare-stats tbody tr');
  // 八项口径：有效最小重合标签、候选数、资料不全被排除、被约束挡下、第一名分数、
  // 分数中位数、标签差异中位数、换位影片数。与浏览器用例断言同一个数字。
  assert.equal(statRows.length, 8);
  const statLabels = statRows.map((row) => row.querySelector('th')?.textContent ?? '');
  assert.ok(statLabels.includes('Effective minimum shared tags'));
  assert.ok(statLabels.includes('Candidates'));
  assert.ok(statLabels.includes('Films reordered'));
});

test('对照场景选成当前场景时明确说明两者相同', async () => {
  const app = await bootDemo();
  app.clickTab('compare');
  app.selectCompareMode('scenario');
  app.setCompareScenario('city-night');
  assert.match(app.text('.compare-summary'), /The comparison scenario and the current scenario are the same one/);
});

test('两侧有效阈值不同时明说差异不能归因于权重', async () => {
  const app = await bootDemo();
  app.clickScenario('sea-drift');
  app.setShared(3);
  app.clickTab('compare');
  app.selectCompareMode('scenario');
  // 边界场景的种子只有两枚标签，阈值会被夹到 2，与当前侧的 3 不同。
  app.setCompareScenario('edge-cases');

  const warning = app.text('.compare-summary');
  assert.match(warning, /different effective minimum shared tags thresholds/);
  assert.match(warning, /The current scenario uses 3 and the comparison scenario uses 2/);
  assert.match(warning, /cannot be attributed to the weights/);
});

test('基线比较给出最大上升与最大下降的具体影片', async () => {
  const app = await bootDemo();
  app.setRange('tag-difference', 100);
  app.clickTab('compare');

  const summary = app.text('.compare-summary');
  assert.match(summary, /Same candidate set, same films: 20 in total, \d+ of them changed rank/);
  assert.match(summary, /Biggest climb: \d+ places (.+)/);
  assert.match(summary, /Biggest drop: \d+ places (.+)/);
});

test('探索视图画出与候选数相同的坐标点，并同步选中态', async () => {
  const app = await bootDemo();
  app.clickTab('explore');
  const points = app.queryAll('.atlas-svg circle[data-movie-id]');
  assert.equal(points.length, 20);
  assert.match(app.text('.atlas-summary'), /not a real taste space/);

  const second = points[1];
  second.dispatchEvent(new app.window.Event('click'));

  const pressed = app
    .queryAll('.atlas-svg circle[data-movie-id]')
    .filter((point) => point.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].getAttribute('data-movie-id'), second.getAttribute('data-movie-id'));
});

test('散点图只用键盘就能移动与选中，且移动后焦点留在新点上', async () => {
  const app = await bootDemo();
  app.clickTab('explore');
  const points = app.queryAll('.atlas-svg circle[data-movie-id]');
  const first = points[0];
  const second = points[1];

  assert.equal(first.getAttribute('tabindex'), '0', '第一个点是唯一的 Tab 停靠点');
  assert.equal(second.getAttribute('tabindex'), '-1');

  app.pressKey(first, 'ArrowRight');
  assert.equal(second.getAttribute('tabindex'), '0');
  assert.equal(first.getAttribute('tabindex'), '-1');
  assert.equal(app.focusedElement(), second, '方向键移动后焦点应落在新点上');

  app.pressKey(second, 'Enter');
  const pressed = app
    .queryAll('.atlas-svg circle[data-movie-id]')
    .filter((point) => point.getAttribute('aria-pressed') === 'true');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].getAttribute('data-movie-id'), second.getAttribute('data-movie-id'));
  assert.match(app.text('.live-region'), /Selected/);
});

test('键盘可以在视图标签之间移动，并保持焦点可见', async () => {
  const app = await bootDemo();
  app.pressTabKey('console', 'ArrowRight');
  assert.equal(app.query('#tab-compare').getAttribute('aria-selected'), 'true');
  assert.equal(app.query('#panel-console').hidden, true);
  assert.equal(app.focused(), 'tab-compare');

  app.pressTabKey('compare', 'End');
  assert.equal(app.query('#tab-explore').getAttribute('aria-selected'), 'true');
});

test('每个可交互控件都有可访问名称', async () => {
  const app = await bootDemo();
  const unnamed = app
    .queryAll('input, select, button, textarea')
    .filter((element) => {
      const label = element.getAttribute('aria-label');
      const labelledBy = element.getAttribute('aria-labelledby');
      const text = element.textContent?.trim() ?? '';
      const title = element.getAttribute('title');
      const hasFor = element.id !== null && app.query(`label[for="${element.id}"]`) !== null;
      return !label && !labelledBy && !text && !title && !hasFor;
    })
    .map((element) => element.tagName.toLowerCase() + (element.id ? `#${element.id}` : ''));
  assert.deepEqual(unnamed, []);
});

test('页面结构：唯一 h1、标题不跳级、id 唯一、aria 引用都能解析', async () => {
  const app = await bootDemo();

  const headings = app.queryAll('h1, h2, h3, h4, h5, h6');
  assert.equal(headings.filter((h) => h.tagName === 'H1').length, 1, '只能有一个 h1');
  let previous = 1;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    assert.ok(level <= previous + 1, `标题从 h${previous} 跳到 h${level}：${heading.textContent}`);
    previous = level;
  }

  const ids = app.queryAll('[id]').map((element) => element.getAttribute('id'));
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');

  const references = app.queryAll('[aria-labelledby], [aria-describedby], [aria-controls]');
  for (const element of references) {
    for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      for (const target of value.split(/\s+/)) {
        assert.ok(
          app.query(`#${target}`) !== null,
          `${attribute} 指向不存在的 id：${target}`,
        );
      }
    }
  }
});

test('标签页语义完整：选中态、控件指向与面板回指都对得上', async () => {
  const app = await bootDemo();
  const tabs = app.queryAll('[role="tab"]');
  assert.equal(tabs.length, 3);

  for (const tab of tabs) {
    assert.ok(tab.hasAttribute('aria-selected'), '标签必须有 aria-selected');
    const controls = tab.getAttribute('aria-controls');
    assert.ok(controls !== null, '标签必须用 aria-controls 指向面板');
    const panel = app.query(`#${controls}`);
    assert.ok(panel !== null, `面板 ${controls} 不存在`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    const labelledBy = panel.getAttribute('aria-labelledby');
    assert.equal(labelledBy, tab.getAttribute('id'), '面板必须回指自己的标签');
  }

  const positives = app.queryAll('[tabindex]').filter((element) => {
    const value = Number(element.getAttribute('tabindex'));
    return Number.isInteger(value) && value > 0;
  });
  assert.deepEqual(positives.map((element) => element.tagName.toLowerCase()), [], '不要用正数 tabindex');
});

test('表格语义完整：表头有 scope，数据行有行标题', async () => {
  const app = await bootDemo();
  app.clickTab('compare');
  app.selectCompareMode('scenario');
  app.setCompareScenario('sea-drift');
  app.clickTab('explore');

  for (const table of app.queryAll('table')) {
    for (const cell of table.querySelectorAll('thead th')) {
      assert.equal(cell.getAttribute('scope'), 'col', '列标题要标 scope=col');
    }
    for (const row of table.querySelectorAll('tbody tr')) {
      const header = row.querySelector('th[scope="row"]');
      assert.ok(header !== null, '每个数据行都要有行标题');
    }
  }
});

test('播报区域是 status 且用 polite，不抢焦点', async () => {
  const app = await bootDemo();
  for (const selector of ['.live-region', '.io-block [role="status"]']) {
    const region = app.query(selector);
    assert.ok(region !== null, `缺少 ${selector}`);
    assert.equal(region.getAttribute('role'), 'status');
    assert.equal(region.getAttribute('aria-live'), 'polite');
    assert.ok(!region.hasAttribute('tabindex'), '播报区域不该进 Tab 顺序');
  }
});

test('prefers-reduced-motion 下不触发位移动画', async () => {
  const app = await bootApp({ reducedMotion: true });
  app.setRange('tag-difference', 100);
  assert.equal(app.animatedCount(), 0);
});

test('解释表的默认列与当前列各自自洽：两项贡献加总到该列总分', async () => {
  const app = await bootDemo();
  app.setRange('relation-weight', 35);
  app.setRange('tag-difference', 70);

  const cells = app
    .queryAll('.score-table tbody tr')
    .map((row) => Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent));
  const [base, difference, total] = cells;

  for (const column of [1, 2]) {
    const sum = Number(base[column]) + Number(difference[column]);
    assert.ok(Math.abs(sum - Number(total[column])) < 1e-9, '默认列与当前列都必须自洽');
  }
  // 默认列不能是当前列的复制：两个旋钮都动过，两列必须不同。
  assert.notEqual(total[1], total[2]);
});

test('导入失败时焦点落到错误面板，错误区是合法的 role=alert 容器', async () => {
  const app = await bootDemo();
  app.importFile({ name: 'bad.json', size: 5, text: async () => '{}' });
  await app.flush();

  const error = app.query('.error-message');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.hidden, false);
  assert.ok(app.query('.error-message .error-panel') !== null);
  const focused = app.focusedElement();
  assert.ok(focused !== null && focused.classList.contains('error-panel'), '焦点应落在错误面板上');
});

test('空状态提示跟着真实原因走，不会建议恢复 0 部候选', async () => {
  const app = await bootDemo();
  app.clickScenario('no-signals');
  app.setShared(1);

  const hint = app.text('.movie-list');
  assert.match(hint, /The current candidate set is empty/);
  assert.doesNotMatch(hint, /restores the 0 candidates/);
  assert.match(hint, /dropped for incomplete data/i);
});

test('被硬约束挡下时，空状态提示确实给出可执行的恢复办法', async () => {
  const app = await bootDemo();
  app.clickScenario('sea-drift');
  // 海边慢片的种子里有三枚标签，但没有一部影片同时命中三枚。
  app.setShared(3);
  assert.equal(app.rows().length, 0);
  assert.match(app.text('.movie-list'), /restores the 14 candidates/);
  assert.match(app.text('.notices'), /Blocked by the minimum shared tags rule: 14/);
});

test('读取本地文件期间显示真实的读取提示，读完就消失', async () => {
  const app = await bootDemo();
  const status = app.query('.io-block [role="status"]');

  app.importFile({
    name: 'slow.json',
    size: 20,
    text: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return '{}';
    },
  });

  assert.equal(status.hidden, false, '读取期间应显示提示');
  assert.match(status.textContent, /Reading the local JSON/);

  await app.wait(120);
  assert.equal(status.hidden, true, '读取结束后提示应消失');
});

test('错误面板可以被"知道了"关掉，并且不改变当前榜单', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());

  app.importFile({ name: 'bad.json', size: 5, text: async () => 'nope' });
  await app.flush();
  assert.equal(app.query('.error-message').hidden, false);

  const dismiss = app.query('.error-message button');
  dismiss.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  assert.equal(app.query('.error-message').hidden, true);
  assert.deepEqual(ids(app.rows()), before);
});

test('切换到种子标签更少的场景时，最小重合标签会被夹到合法范围', async () => {
  const app = await bootDemo();
  app.setShared(3);
  assert.match(app.text('.ranking-status'), /minimum shared 3/);

  app.clickScenario('no-signals');
  assert.match(app.text('.ranking-status'), /minimum shared 2/, '不得留下超过种子标签数的阈值');
  assert.match(app.text('.live-region'), /minimum shared tags is now 2/);
});

test('换位统计通过 live region 播报，不逐帧刷屏', async () => {
  const app = await bootDemo();
  app.setRange('tag-difference', 100);
  await app.wait(500);
  assert.match(app.text('.live-region'), /Ranking updated: 20 candidates, \d+ reordered/);
});

/** 造一个结构合法但内容有问题的场景文件。 */
function scenarioFile(mutate) {
  const base = {
    format: 'taste-tuner/scenario',
    version: 1,
    dataset: {
      source: 'synthetic',
      version: 'synthetic-fixture-v1',
      tags: { alpha: '甲', beta: '乙' },
      seed: { id: 'seed-x', title: '种子', tagIds: ['alpha', 'beta'] },
      movies: [
        { id: 'm-1', title: '甲片', relation: { seedId: 'seed-x', score: 0.9 }, tagIds: ['alpha'] },
      ],
    },
    settings: { controls: { relationWeight: 80, tagDifference: 0 }, minSharedTags: 0 },
  };
  mutate(base);
  return JSON.stringify(base);
}

const asFile = (text, name = 'fixture.json') => ({
  name,
  size: Buffer.byteLength(text, 'utf8'),
  text: async () => text,
});

test('导入文件的 format 或 version 不对时整体拒绝', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());

  app.importFile(asFile(scenarioFile((file) => { file.format = 'other/format'; })));
  await app.flush();
  assert.match(app.text('.error-message'), /format must be taste-tuner\/scenario/);

  app.importFile(asFile(scenarioFile((file) => { file.version = 2; })));
  await app.flush();
  assert.match(app.text('.error-message'), /version must be 1/);

  assert.deepEqual(ids(app.rows()), before);
});

test('导入文件的设置越过种子上限时整体拒绝', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());

  app.importFile(
    asFile(scenarioFile((file) => { file.settings.minSharedTags = 5; })),
  );
  await app.flush();

  assert.match(app.text('.error-message'), /minSharedTags/);
  assert.deepEqual(ids(app.rows()), before);
});

test('导入重复影片 ID 的文件整体拒绝', async () => {
  const app = await bootDemo();
  const before = ids(app.rows());

  app.importFile(
    asFile(
      scenarioFile((file) => {
        file.dataset.movies.push({
          id: 'm-1',
          title: '重复的甲片',
          relation: { seedId: 'seed-x', score: 0.5 },
          tagIds: ['beta'],
        });
      }),
    ),
  );
  await app.flush();

  assert.match(app.text('.error-message'), /Duplicate film id/);
  assert.deepEqual(ids(app.rows()), before);
});

test('导出再导入不会丢掉被排除影片的语义', async () => {
  const app = await bootDemo();
  app.clickScenario('edge-cases');
  assert.equal(app.rows().length, 5);
  assert.match(app.text('.notices'), /Dropped for incomplete data: 3/);

  app.clickExport();
  const text = await app.exportedText();
  const payload = JSON.parse(text);
  assert.equal(payload.dataset.movies.length, 8, '导出必须保留被排除的原始影片');

  app.clickScenario('city-night');
  app.importFile(asFile(text, 'edge-cases.json'));
  await app.flush();

  assert.equal(app.rows().length, 5);
  assert.match(app.text('.notices'), /Dropped for incomplete data: 3/);

  app.clickExport();
  const again = JSON.parse(await app.exportedText());
  assert.equal(again.dataset.movies.length, 8, '再导出仍然保留被排除的影片');
});

test('导入之后比较与探索两个视图仍然可用', async () => {
  const app = await bootDemo();
  app.clickExport();
  const text = await app.exportedText();
  app.importFile(asFile(text, 'round.json'));
  await app.flush();

  app.clickTab('compare');
  app.selectCompareMode('scenario');
  app.setCompareScenario('sea-drift');
  assert.match(app.text('.compare-summary'), /The two scenarios are different fictional candidate sets/);
  assert.equal(app.queryAll('.compare-body .compare-stats tbody tr').length >= 8, true);

  app.clickTab('explore');
  assert.equal(app.queryAll('.atlas-svg circle[data-movie-id]').length, 20);
  assert.match(app.text('.atlas-summary'), /20 candidates/);
});

test('导入之后重置回到默认权重，但保留导入的数据集', async () => {
  const app = await bootDemo();
  app.clickExport();
  const text = await app.exportedText();
  app.importFile(asFile(text, 'round.json'));
  await app.flush();

  app.setRange('relation-weight', 10);
  app.setRange('tag-difference', 90);
  app.query('#reset').dispatchEvent(new app.window.Event('click', { bubbles: true }));

  assert.match(app.text('.ranking-status'), /relation 80 \/ difference 0 · minimum shared 0/);
  assert.equal(app.rows().length, 20);
  assert.match(app.text('.seed-title'), /Last Tram Home/);
});

test('候选集为空时，比较与探索两个视图都给出空状态而不是残缺内容', async () => {
  const app = await bootDemo();
  app.clickScenario('no-signals');
  assert.equal(app.rows().length, 0);

  app.clickTab('compare');
  assert.match(app.text('.compare-body'), /The current candidate set is empty, so there are no ranks to compare/);

  app.clickTab('explore');
  assert.match(app.text('.atlas-table'), /The current candidate set is empty/);
  assert.equal(app.queryAll('.atlas-svg circle[data-movie-id]').length, 0);
});

test('探索视图的文字清单只列前 20 名，并说明其余在哪看', async () => {
  const app = await bootDemo();
  app.clickScenario('large-cohort');
  app.clickTab('explore');

  const listed = app.queryAll('.atlas-table tbody tr');
  assert.equal(listed.length, 20);
  assert.match(app.text('.atlas-table'), /Only the top 20 are listed here; the other 220 are in the “Ranking” view/);
});

/* ===================== 真实服务这条主线 ===================== */

import { parseInsightsResponse, parseSearchResponse } from '../dist/assets/core/qloo.js';
import {
  insightsPayload,
  insightsWithoutPopularityPayload,
  searchAmbiguousPayload,
  searchArtistPayload,
  searchResolvedPayload,
} from './helpers/qloo-fixtures.mjs';

const configuredApi = (overrides = {}) => {
  const handler = async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
    return { status: 200, body: parseInsightsResponse(insightsPayload) };
  };
  return overrides === undefined ? handler : handler;
};

test('默认进的是真实服务，离线演示必须显式切换才可见', async () => {
  const app = await bootApp();
  assert.equal(app.query('#demo-mode').hidden, true, '离线演示默认应当是隐藏的');
  assert.equal(app.query('#service-mode').hidden, false);
  // 真实服务那一侧不贴模式说明——徽标已经说清楚了。
  assert.equal(app.text('.mode-banner').trim(), '');

  app.switchMode('demo');
  assert.equal(app.query('#demo-mode').hidden, false);
  assert.equal(app.query('#service-mode').hidden, true);
  assert.match(app.text('.mode-banner'), /Offline demo mode/);
  assert.match(app.text('.source-note'), /synthetic/);
});

test('服务未配置时明确说明缺什么，并且不回退到合成数据', async () => {
  const app = await bootApp();
  await app.flush();

  assert.match(app.text('.service-status'), /The live service is not configured/);
  assert.match(app.text('.service-status'), /QLOO_API_KEY/);
  assert.match(app.text('.service-status'), /QLOO_BASE_URL/);
  assert.equal(app.query('#seed-submit').disabled, true);
  assert.equal(app.queryAll('.service-list .service-item').length, 0);
  // 演示区的内容不能被拿来冒充真实结果：演示区整个是隐藏的。
  assert.equal(app.query('#demo-mode').hidden, true);
  assert.equal(app.queryAll('.service-list .service-item').length, 0);
});

test('种子解析成功后取回真实候选，并给出可核对的解释', async () => {
  const app = await bootApp({ api: configuredApi() });
  await app.flush();
  assert.match(app.text('.service-status'), /The live service is ready/);

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.seed-bar'), /Your seed/);
  assert.match(app.text('.seed-bar'), /Sample Film/);
  // 确认之后输入框要收起来——第一屏得留给影片，不是留给输入框。
  assert.equal(app.query('.find-form').hidden, true);

  const items = app.queryAll('.service-list .service-item');
  assert.equal(items.length, 4);
  assert.match(items[0].textContent, /Candidate A/);

  // 解释面板给出服务原值与本地贡献，不是编出来的。
  // 「可用资料」与「为什么这部」是两个分开的面板，别混着找。
  const evidence = app.text('.service-why-body');
  assert.match(evidence, /Candidate A/);
  assert.match(evidence, /Affinity/);
  assert.match(evidence, /92/);
  assert.match(evidence, /Popularity/);
  // 归因里的输入实体名就是解析出来的种子（夹具里叫「Sample Film」）。
  assert.match(evidence, /Sample Film: 0\.82/);
  assert.match(evidence, /not a preference probability/);
  assert.match(evidence, /not a natural-language/);
});

test('名字对不上多个实体时必须让用户选，不替他挑', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
    if (url.endsWith('/api/resolve')) {
      return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
    }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.service-resolution'), /Several films share this name/);
  // 内部标识不进消费界面。
  assert.doesNotMatch(app.text('.service-resolution'), /urn:entity/);
  const choices = app.queryAll('.entity-options input[type="radio"]');
  assert.equal(choices.length, 2);
  // 歧义时还没有取候选。
  assert.equal(app.queryAll('.service-list .service-item').length, 0);

  app.query('#entity-confirm').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.equal(app.queryAll('.service-list .service-item').length, 4);
});

test('旋钮只按实际返回的字段出现', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return {
        status: 200,
        body: parseInsightsResponse(insightsWithoutPopularityPayload),
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.ok(app.query('#service-affinity-weight') !== null, '有关联分就该有关联权重');
  assert.equal(
    app.query('#service-popularity-weight'),
    null,
    '服务没返回流行度，就不该出现流行度旋钮',
  );
});

test('滑杆只在本地重排，不发新的请求', async () => {
  const app = await bootApp({ api: configuredApi() });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const before = app.apiCalls().length;
  const orderBefore = app
    .queryAll('.service-list .service-item')
    .map((item) => item.querySelector('.movie-title')?.textContent);

  const range = app.query('#service-popularity-weight');
  range.value = '100';
  range.dispatchEvent(new app.window.Event('input', { bubbles: true }));

  const after = app.apiCalls().length;
  assert.equal(after, before, '调滑杆不能触发任何网络请求');

  const orderAfter = app
    .queryAll('.service-list .service-item')
    .map((item) => item.querySelector('.movie-title')?.textContent);
  assert.notDeepEqual(orderAfter, orderBefore, '提高流行度权重后名次应当变化');
});

test('上游出错时给出原因，不拿合成数据顶上', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return {
        status: 503,
        body: { status: 'upstream_error', message: 'The fixture simulated a rate limit.', retryable: true },
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.service-error'), /The fixture simulated a rate limit/);
  assert.equal(app.queryAll('.service-list .service-item').length, 0);
});

test('两段的"区域标识类"必须各自分开，选择器不会指错', async () => {
  const app = await bootApp();
  // 这些类名用来指认整块区域（榜单、解释、错误、播报），重了就会选错。
  // 新增一个"区域标识类"时记得把两边的都列进来——这类重名已经出过三次，
  // 每次都会让选择器指错、界面读到 undefined。
  const regionIds = [
    'movie-list',
    'service-list',
    'movie-item',
    'service-item',
    'evidence-panel',
    'service-evidence',
    'error-message',
    'service-error',
    'live-region',
    'service-live-region',
    'ranking-status',
    'service-ranking-status',
    'service-status',
    'demo-mode',
    'service-mode',
    // 2026-10-29 改版时又撞过一回：真实路径的下拉框用了演示路径同名的
    // `select-input`，浏览器里的选择器直接指到了两个元素。种子卡那几个类名同理。
    'select-input',
    'seed-label',
    'seed-title',
  ];
  for (const name of regionIds) {
    const inService = app.queryAll(`#service-mode .${name}`).length;
    const inDemo = app.queryAll(`#demo-mode .${name}`).length;
    // 规则是"不能两段都出现"，不是"总共只能出现一次"——一个列表里有很多行。
    assert.ok(
      inService === 0 || inDemo === 0,
      `${name} 同时出现在两段里（真实 ${inService} 个 / 演示 ${inDemo} 个）`,
    );
  }
  // 反过来也要成立：每一段都有自己那套标识类。
  assert.equal(app.queryAll('#service-mode .service-list').length, 1);
  assert.equal(app.queryAll('#demo-mode .movie-list').length, 1);
});

test('接入面官方允不允许、有没有实测过，界面上分开说', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo',
            configured: true,
            missing: [],
            accessSurface: 'raw-http',
            accessSurfaceConfirmed: false,
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 503, body: { status: 'upstream_error', message: '夹具。', retryable: false } };
    },
  });
  await app.flush();

  const status = app.text('.service-status');
  assert.match(status, /The live service is ready/);
  assert.match(status, /whether the official guide allows it is unconfirmed/);
});

test('官方允许但没实测过：界面上把这两件事分开说', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo',
            configured: true,
            missing: [],
            accessSurface: 'raw-http',
            accessSurfaceConfirmed: true,
            accessSurfaceLiveVerified: false,
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 503, body: { status: 'upstream_error', message: '夹具。', retryable: false } };
    },
  });
  await app.flush();

  const status = app.text('.service-status');
  assert.match(status, /Access surface: raw-http \(officially allowed; this path has not been exercised against the live API yet\)/);
});

test('候选行里带上年份与分级，分不清是第一部还是续集', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const first = app.query('.service-list .service-item');
  assert.match(first?.textContent ?? '', /2010/, 'Candidate A的年份应当显示出来');
  assert.match(first?.textContent ?? '', /PG-13/, 'Candidate A的分级应当显示出来');

  // 服务没给年份与分级的那一条：就不显示，不编。
  const without = app
    .queryAll('.service-list .service-item')
    .find((item) => item.querySelector('.movie-title')?.textContent === 'Candidate B');
  assert.doesNotMatch(without?.textContent ?? '', /·/);
});

test('取候选失败时给出重试入口，不用重新输一遍种子', async () => {
  let attempts = 0;
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            budget: { enabled: true, limit: 5, used: 0, remaining: 5, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 502,
          body: { status: 'upstream_error', message: 'The fixture simulated the first failure.', retryable: true },
        };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.service-error'), /The fixture simulated the first failure/);
  const retry = app.query('#service-retry');
  assert.ok(retry !== null, '失败后应当有重试入口');
  assert.equal(app.queryAll('.service-list .service-item').length, 0);

  retry.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(app.queryAll('.service-list .service-item').length, 4);
  assert.equal(app.query('.service-error').hidden, true, '重试成功后错误应当消失');
});

test('界面上能预览将要发出的请求，预览不触发任何真实调用', async () => {
  const calls = [];
  const app = await bootApp({
    api: async (url, init) => {
      calls.push({ url: String(url), body: init?.body ?? null });
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/preflight')) {
        return {
          status: 200,
          body: {
            status: 'ok',
            preview: {
              method: 'GET',
              url: 'https://hackathon.api.qloo.com/search?query=%E7%A4%BA%E4%BE%8B',
              params: { query: 'Sample Film', types: 'urn:entity:movie', take: '20' },
              note: 'This is a preview; no request was sent.',
            },
          },
        };
      }
      return { status: 503, body: { status: 'upstream_error', message: '夹具。', retryable: false } };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  // 预览按钮在解析之前就该能用——它正是"先看清再花额度"的入口。
  const button = app.query('#service-preview-button');
  assert.ok(button !== null, '界面上应当有预览入口');

  const before = calls.length;
  button.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const previewCalls = calls.slice(before).filter((call) => call.url.endsWith('/api/preflight'));
  assert.equal(previewCalls.length, 1, '只该调用预览接口');
  assert.equal(
    calls.slice(before).filter((call) => call.url.endsWith('/api/resolve')).length,
    0,
    '预览不该触发真实解析',
  );

  const block = app.text('.preview-block');
  assert.match(block, /GET https:\/\/hackathon\.api\.qloo\.com\/search/);
  assert.match(block, /urn:entity:movie/);
  assert.match(app.text('.service-preview'), /no request was sent/i);
});

test('状态行说清凭据在不在：没就位就告诉用户去跑哪个脚本', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo-cli',
            configured: true,
            missing: [],
            accessSurface: 'qloo-cli',
            accessSurfaceConfirmed: true,
            credentialPresent: false,
            budget: { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 503, body: { status: 'upstream_error', message: '夹具。', retryable: false } };
    },
  });
  await app.flush();

  const status = app.text('.service-status');
  assert.match(status, /no credential/i);
  assert.match(status, /setup-credentials\.py/);
  assert.match(status, /The live request budget is off/);
});

test('服务给的英文名做标题：中文别名只留在折叠的元数据里', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      if (String(url).endsWith('/api/candidates')) {
        return { status: 200, body: parseInsightsResponse(insightsPayload) };
      }
      return { status: 503, body: { status: 'upstream_error', message: 'fixture.', retryable: false } };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const titles = app.queryAll('.service-item .movie-title').map((node) => node.textContent ?? '');
  assert.ok(titles.includes('Candidate A'), `标题用服务给的那个名字：${JSON.stringify(titles)}`);
  assert.ok(!titles.includes('示例影片'), '中文别名不进标题');
  // 播报也用服务给的名字。
  assert.doesNotMatch(app.text('.live-region'), /示例影片/);
  // 别名还在，只是收在折叠起来的说明面板里（默认收起，不在卡片正面）。
  assert.match(app.text('.service-why-body'), /示例影片/);
});

test('候选列表标题写清里面是哪一类实体', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(app.text('#service-list-heading'), 'Similar to “Sample Film”');
  // 种子类别收在高级入口里：第一次来的人不用先理解"种子类型"。
  const advanced = app.query('.advanced-entry');
  assert.ok(advanced !== null);
  assert.equal(advanced.hasAttribute('open'), false, '高级入口默认收起来');
  assert.match(app.text('.advanced-summary'), /artist or band/);
  // 内部标识不进消费界面。
  assert.doesNotMatch(app.text('#service-mode'), /urn:entity/);
});

test('公开界面不再有原始载荷的下载入口', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 上游原始载荷是私有材料：公开界面里既不该有下载入口，也不该有它本身。
  assert.equal(app.query('#service-raw-save'), null, '公开界面没有原始载荷下载');
  assert.doesNotMatch(app.text('.service-diagnostics'), /raw response/i);
});

test('真实路径也有状态摘要，并给出上映年份', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 给人看的状态行：几部、动了几个。开发者指标挪进了开发诊断。
  const status = app.text('.service-ranking-status');
  assert.match(status, /4 similar films/);
  assert.doesNotMatch(status, /Affinity/, '开发者指标不该出现在给人看的状态行里');
  assert.match(app.text('.dev-metrics'), /Affinity 0\.30–0\.92/);

  // 上映年份属于「片目与影评」那一面（可核对的详情）。
  assert.match(app.text('.service-materials-body'), /Release year: 2010/);
});

test('海报只用响应给的那张地址；服务没给图就换成诚实的文字卡', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return {
        status: 200,
        body: parseInsightsResponse({
          success: true,
          results: {
            entities: [
              {
                entity_id: 'uuid-img',
                name: 'Candidate A',
                subtype: 'urn:entity:movie',
                affinity: 0.9,
                properties: { image: { url: 'https://images.example.invalid/a.jpg' } },
              },
            ],
          },
        }),
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 海报用的就是响应里的那个地址——不多放行别的域，也不自己挑一张。
  const poster = app.query('.service-item .poster-image');
  assert.ok(poster !== null, '卡片上要有海报');
  assert.equal(
    poster.getAttribute('src'),
    'https://images.example.invalid/a.jpg',
    '海报地址只能来自响应',
  );

  // 服务没给图时，不画占位海报，只给一块诚实的文字卡。
  const noImage = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await noImage.flush();
  noImage.query('#seed-input').value = 'Sample Film';
  noImage
    .query('#seed-submit')
    .dispatchEvent(new noImage.window.Event('click', { bubbles: true }));
  await noImage.flush();

  // 夹具里只有Candidate A带图：它画 img，另外三部换成诚实的文字卡。
  assert.equal(noImage.queryAll('.service-item .poster-image').length, 1);
  assert.equal(
    noImage.queryAll('.service-item .poster-note').length,
    3,
    '服务没给图的那几部要给文字卡，不画占位海报',
  );
  // 服务没给地址 ≠ 给了没加载出来：这两句话不能混。
  assert.match(noImage.text('.service-item .poster-note'), /The service did not provide a poster/);
});

test('硬约束在本地筛，不重新请求；改完立刻反映到榜单', async () => {
  const calls = [];
  const app = await bootApp({
    api: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return {
        status: 200,
        body: parseInsightsResponse({
          success: true,
          results: {
            entities: [
              {
                entity_id: 'g-1',
                name: 'PG 片',
                subtype: 'urn:entity:movie',
                affinity: 0.9,
                properties: { release_year: 2001, content_rating: 'PG' },
              },
              {
                entity_id: 'r-1',
                name: 'R 片',
                subtype: 'urn:entity:movie',
                affinity: 0.8,
                properties: { release_year: 2002, content_rating: 'R' },
              },
            ],
          },
        }),
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.equal(app.queryAll('.service-list .service-item').length, 2);

  const before = calls.length;
  const select = app.query('#constraint-rating');
  select.value = 'PG';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.flush();

  assert.equal(calls.length, before, '改硬约束不能发新请求');
  const titles = app
    .queryAll('.service-list .service-item')
    .map((item) => item.querySelector('.movie-title')?.textContent);
  assert.deepEqual(titles, ['PG 片']);
  assert.match(app.text('.service-ranking-status'), /1 filtered out/);
});

test('用掉一次额度后，状态行里的余额立刻变真', async () => {
  let used = 0;
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: {
              enabled: true,
              limit: 2,
              used,
              remaining: 2 - used,
              state: used >= 2 ? 'exhausted' : 'available',
            },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        used += 1;
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      used += 1;
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();
  assert.match(app.text('.service-status'), /0 used, 2 left/);

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 解析 + 取候选各扣一次，状态行必须跟着变，不能还写着"剩 2 次"。
  assert.match(app.text('.service-status'), /2 used, 0 left/);
});

test('控件顺序：三个权重在前，硬约束在后', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const controls = app.query('#service-mode .service-controls');
  const order = [...controls.querySelectorAll('input[type="range"]')].map((input) =>
    input.getAttribute('id'),
  );
  // 上面一行只放真正表达偏好的两个滑杆；服务自己的相似度权重收进「更多调整」。
  assert.deepEqual(order, [
    'service-popularity-weight',
    'service-tag-similarity-weight',
    'service-affinity-weight',
  ]);
  // 偏好滑杆要排在「更多调整」之前——否则还是在五张卡之后。
  // 「更多调整」现在在正文容器里，比先后要按**文档顺序**看，不能只看直接子节点。
  const flat = [...controls.querySelectorAll('input[type="range"], details.more-controls')];
  const more = controls.querySelector('.more-controls');
  const moreIndex = flat.indexOf(more);
  const affinityIndex = flat.indexOf(controls.querySelector('#service-affinity-weight'));
  assert.ok(moreIndex >= 0, '要有「更多调整」折叠区');
  assert.ok(moreIndex > 1, '两个偏好滑杆应当排在「更多调整」之前');
  assert.ok(affinityIndex > moreIndex, '服务自己的相似度滑杆在「更多调整」里面');
  // 硬约束也在「更多调整」里。
  assert.ok(more.querySelector('#constraint-rating') !== null, '硬约束在「更多调整」里');
});

test('硬约束把候选全挡下时，不谎称"服务没有返回候选"', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return {
        status: 200,
        body: parseInsightsResponse({
          success: true,
          results: {
            entities: [
              {
                entity_id: 'r-1',
                name: 'R 片',
                subtype: 'urn:entity:movie',
                affinity: 0.9,
                properties: { release_year: 2002, content_rating: 'R' },
              },
            ],
          },
        }),
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.equal(app.queryAll('.service-list .service-item').length, 1);

  const select = app.query('#constraint-rating');
  select.value = 'G';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.flush();

  assert.equal(app.queryAll('.service-list .service-item').length, 0);
  const empty = app.text('.service-list .list-empty');
  assert.match(empty, /the current hard constraints block all of them/);
  assert.doesNotMatch(empty, /The service returned no candidates/);
  assert.match(app.text('.service-ranking-status'), /1 filtered out/);
});

test('榜单上的名次变化说清是相对默认权重，不是相对服务原序', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 名次变化的基准说明归到开发诊断；给人看的卡片上用人话标。
  assert.match(app.text('.dev-metrics'), /changed rank against the default weights/);

  // 把流行度权重拉满，Candidate C（流行度最高）应当往上走，卡片上要标出变化。
  const range = app.query('#service-popularity-weight');
  range.value = '100';
  range.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
  assert.match(
    app.text('.service-list'),
    /\d+ places (up|down) from default/,
    '名次变了，卡片上要用人话标出来',
  );
  assert.match(app.text('.service-ranking-status'), /\d+ reordered/);
});

test('状态行不自相矛盾：没凭据时不说"已就绪"，也不让人白点一次', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo-cli',
            configured: true,
            missing: [],
            accessSurface: 'qloo-cli',
            accessSurfaceConfirmed: true,
            credentialPresent: false,
            budget: { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 503, body: { status: 'not_configured', missing: ['QLOO_API_KEY'] } };
    },
  });
  await app.flush();

  const status = app.text('.service-status');
  assert.doesNotMatch(status, /The live service is ready/, '凭据没就位就不能说已就绪');
  assert.match(status, /no credential/i);
  assert.equal(app.query('#seed-submit').disabled, true, '没凭据就别让人白点一次');
});

test('重置只动本地旋钮与约束：候选不变，也不重新请求', async () => {
  const calls = [];
  const app = await bootApp({
    api: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  const before = calls.length;
  const orderBefore = app
    .queryAll('.service-list .service-item')
    .map((item) => item.querySelector('.movie-title')?.textContent);

  const popularity = app.query('#service-popularity-weight');
  popularity.value = '100';
  popularity.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  const select = app.query('#constraint-rating');
  select.value = 'PG-13';
  select.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.flush();

  const reset = app.query('#service-reset');
  assert.ok(reset !== null, '真实路径也应当有重置');
  reset.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(calls.length, before, '重置不能发请求');
  assert.equal(app.query('#service-popularity-weight').value, '0');
  assert.equal(app.query('#constraint-rating').value, '');
  assert.deepEqual(
    app
      .queryAll('.service-list .service-item')
      .map((item) => item.querySelector('.movie-title')?.textContent),
    orderBefore,
    '候选不该变',
  );
});

test('已解析的种子把标签列出来，标签相似度那个旋钮才看得懂', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            accessSurface: 'fixture',
            accessSurfaceConfirmed: true,
            credentialPresent: true,
            budget: { enabled: true, limit: 2, used: 0, remaining: 2, state: 'available' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 种子条只说"这是你的种子"，不铺一屏标签。
  assert.match(app.text('.seed-bar'), /Your seed/);
  assert.match(app.text('.seed-bar'), /Sample Film/);
  assert.doesNotMatch(app.text('#service-mode'), /Seed only/);

  // 标签相似度是什么意思，由旋钮的说明与展开面板讲清楚。
  const knob = app.query('#service-tag-similarity-weight');
  assert.ok(knob !== null);
  const hintId = knob.getAttribute('aria-describedby');
  assert.ok(hintId !== null);
  assert.match(app.text(`#${hintId}`), /shares with the seed/);
});

test('页头徽标与状态行说同一件事：没凭据就不写"已就绪"', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'qloo-cli',
            configured: true,
            missing: [],
            accessSurface: 'qloo-cli',
            accessSurfaceConfirmed: true,
            credentialPresent: false,
            budget: { enabled: false, limit: 0, used: 0, remaining: 0, state: 'disabled' },
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      return { status: 503, body: { status: 'not_configured', missing: ['QLOO_API_KEY'] } };
    },
  });
  await app.flush();

  assert.doesNotMatch(app.text('.demo-badge'), /Ready/);
  assert.match(app.text('.demo-badge'), /no credential/i);
});

/* ---------------------------------------------------------------------------
 * 消歧那条路上的四条回归。
 *
 * 这四条都对着真实探路走过的形状：/search 命中多个实体 → 用户挑一个 →
 * 用那个实体取候选。挑的那个实体的**标签与名字**必须一路跟着走，
 * 不能被上一次查询的种子顶掉。
 * ------------------------------------------------------------------------- */

const SERVICE_STATUS_BODY = {
  provider: 'fixture',
  configured: true,
  missing: [],
  accessSurface: 'fixture',
  accessSurfaceConfirmed: true,
  entityTypes: ['movie', 'artist'],
  maxCandidates: 50,
};

/** 在消歧列表里选中第 n 项（linkedom 不会自动取消同组其它项，所以手动来）。 */
function pickEntity(app, index) {
  const radios = app.queryAll('.entity-options input[type="radio"]');
  radios.forEach((radio, position) => {
    radio.checked = position === index;
  });
  app.query('#entity-confirm').dispatchEvent(new app.window.Event('click', { bubbles: true }));
}

test('消歧后算标签相似度，用的是被挑中那个种子的标签', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) return { status: 200, body: SERVICE_STATUS_BODY };
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 第 1 个候选带标签，第 2 个不带。挑第 1 个 → 标签相似度算得出来。
  pickEntity(app, 0);
  await app.flush();

  assert.ok(
    app.query('#service-tag-similarity-weight') !== null,
    '挑中的种子自己有标签，标签相似度旋钮就该出现',
  );
});

test('换一个种子重查，不会拿上一次的种子标签顶上', async () => {
  let resolveCount = 0;
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) return { status: 200, body: SERVICE_STATUS_BODY };
      if (url.endsWith('/api/resolve')) {
        resolveCount += 1;
        return {
          status: 200,
          body: parseSearchResponse(
            resolveCount === 1 ? searchResolvedPayload : searchAmbiguousPayload,
          ),
        };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  // 第一次唯一命中：种子的标签是 [示例]。
  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.ok(app.query('#service-tag-similarity-weight') !== null);

  // 第二次歧义，挑那个**没有标签**的候选。
  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 1);
  await app.flush();

  assert.equal(
    app.query('#service-tag-similarity-weight'),
    null,
    '这次挑的种子没有标签，旋钮不该出现——更不能拿上一次种子的标签继续出现',
  );
});

test('消歧那条路上取候选失败，"重试取候选"必须真的能用', async () => {
  let failNext = true;
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) return { status: 200, body: SERVICE_STATUS_BODY };
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      if (failNext) {
        failNext = false;
        return {
          status: 503,
          body: { status: 'upstream_error', message: 'The fixture simulated a rate limit.', retryable: true },
        };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 0);
  await app.flush();

  const retry = app.query('#service-retry');
  assert.ok(retry !== null, '取候选失败必须给一条明确的出路');
  retry.dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(
    app.queryAll('.service-list .service-item').length,
    4,
    '重试必须真的把候选取回来，不能是个点了没反应的按钮',
  );
});

test('归因面板说得出种子的名字，而不是甩一串 GUID', async () => {
  // 用真实形状：归因条目只有 entity_id 与 score，没有 name。
  const { slimInsightsResponse, slimSearchResponse } = await import(
    './helpers/live-shape.fixture.mjs'
  );
  const app = await bootApp({
    api: async (url) => {
      if (url.endsWith('/api/status')) return { status: 200, body: SERVICE_STATUS_BODY };
      if (url.endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(slimSearchResponse) };
      }
      return { status: 200, body: parseInsightsResponse(slimInsightsResponse) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Fixture Film A';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 0);
  await app.flush();

  const rows = app
    .queryAll('.service-item:first-child .contribution-list li')
    .map((item) => item.textContent);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /Fixture Film A/, '归因里应当说得出种子的名字');
  assert.doesNotMatch(rows[0], /[0-9A-F]{8}-[0-9A-F]{4}-/, '不该把 GUID 当成归因标签甩给用户');
  assert.match(
    app.text('.service-why-body'),
    /not anyone’s preference probability/,
    '单种子时贡献恒为 100%，必须说清那是归因不是偏好概率',
  );
});

test('解释表里的标签相似度是真实的相似度，不是加权后的 0.00', async () => {
  // 夹具：Candidate A的标签与种子共有 1 个 → 未加权相似度 0.5。
  // 默认权重把标签相似度权重设成 0，所以"当前"那一列确实是 0.00 ——
  // 但"原值"那一列必须显示 0.50，不能也显示 0.00（那等于谎称一点标签都不重合）。
  const app = await bootApp({ api: configuredApi() });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const rows = app.queryAll('.service-evidence .score-table tbody tr');
  const similarity = rows.find((row) => row.textContent?.includes('Tag similarity'));
  assert.ok(similarity !== undefined, '解释表里要有标签相似度这一行');
  const cells = Array.from(similarity.querySelectorAll('td')).map((cell) => cell.textContent);
  assert.equal(cells[0], '0.50', '原值那一列要显示未加权的真实相似度');
  assert.equal(cells[1], '0.00', '当前那一列是按默认权重计入分数的部分');

  // 这一行必须说清是本地算的，不是服务给的分数。
  assert.match(similarity.textContent ?? '', /computed locally/);
});

test('取候选失败后，"正在取回候选…"不能留在界面上', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return {
        status: 400,
        body: { status: 'invalid_input', issues: ['The entity type must be a string'] },
      };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 0);
  await app.flush();

  // 失败要说清楚原因。
  assert.match(app.text('.service-error'), /The entity type must be a string/);
  // 但不能让界面停在"还在取"的样子。
  assert.doesNotMatch(
    app.text('.service-resolution'),
    /Fetching candidates/,
    '请求结束后还挂着"正在取回候选…"，看着像还在取',
  );
});

test('消歧之后也要说得出"你的种子"是哪一部', async () => {
  // 这一条必须走**消歧**那条路：唯一命中时种子卡本来就会填上。
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return {
          status: 200,
          body: {
            provider: 'fixture',
            configured: true,
            missing: [],
            entityTypes: ['movie', 'artist'],
            maxCandidates: 50,
          },
        };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 1); // 第二个候选：2013
  await app.flush();

  const seed = app.text('.seed-bar');
  assert.match(seed, /Your seed/, '种子的身份要一直显示着');
  assert.match(seed, /Sample Film/);
  assert.match(seed, /2013/, '显示的是**被挑中的那一部**的年份，不是别的');
});

test('确认之后消歧列表与「就这部」按钮都收掉，不占着位置', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  assert.ok(app.query('#entity-confirm') !== null, '确认前要有「就这部」');

  pickEntity(app, 0);
  await app.flush();

  // 确认之后：消歧列表与按钮都没了，输入框收成种子条。
  assert.equal(app.query('#entity-confirm'), null, '确认后不该还留着「就这部」按钮');
  assert.equal(app.queryAll('.entity-options').length, 0, '确认后不该还留着消歧列表');
  assert.equal(app.query('.find-form').hidden, true, '输入框要收起来');
  assert.equal(app.query('.seed-bar').hidden, false, '种子条要顶上来');
  assert.match(app.text('.seed-bar'), /Your seed/);
});

test('「换一部片」把输入框放回来，并清掉上一次确认过的消歧列表', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 0);
  await app.flush();

  app.query('#seed-change').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(app.query('.find-form').hidden, false, '输入框要放回来');
  assert.equal(app.query('.seed-bar').hidden, true, '种子条要收起来');
  assert.equal(app.queryAll('.entity-options').length, 0, '上一次的消歧列表不能留着');
});

test('简介在卡面上就看得见，不必展开任何面板', async () => {
  const app = await bootApp({ api: configuredApi() });
  await app.flush();
  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const card = app.query('.service-list .service-item');
  // 卡面（不含展开的面板）里已经有简介。
  const face = card.querySelector('.service-item-meta')?.textContent ?? '';
  assert.match(face, /Fixture description field/, '简介要出现在卡面上');
  // 展开的面板此时还是收着的。
  assert.equal(card.querySelector('.service-why').hasAttribute('open'), false);
});

test('高级入口选音乐人时，请求带的是音乐类别，出来的仍然是电影', async () => {
  const sent = [];
  const app = await bootApp({
    api: async (url, init) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        sent.push(JSON.parse(String(init?.body ?? '{}')));
        return { status: 200, body: parseSearchResponse(searchResolvedPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  // 音乐人种子收在高级入口里，默认是电影。
  assert.equal(app.query('#seed-type').value, 'movie');
  app.query('#seed-type').value = 'artist';

  app.query('#seed-input').value = 'Radiohead';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.equal(sent[0]?.entityType, 'artist', '请求要带上音乐类别');
  // 类别只决定"去哪找"，输出的仍然是电影。
  assert.match(app.text('#service-list-heading'), /Similar to/);
});

test('确认之后焦点被送到结果区标题，不掉回 body', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchAmbiguousPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();
  pickEntity(app, 0);
  await app.flush();

  // 消歧面板被收走了，焦点别丢。
  assert.equal(app.focused(), 'service-list-heading');
});

test('界面上的话不替某一批评测数据下结论', async () => {
  const app = await bootApp({ api: configuredApi() });
  await app.flush();
  app.query('#seed-input').value = 'Sample Film';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  const whole = app.text('#service-mode');
  // "实测这批候选……"这类话只对当时那一批成立，换一批响应就可能是假的。
  assert.doesNotMatch(whole, /this batch of candidates/, '界面不许替某一批评测数据下结论');

  // 滑杆说明说的是"这项加分随什么变大"，不是断言名次一定靠前。
  const knob = app.query('#service-popularity-weight');
  const hintId = knob.getAttribute('aria-describedby');
  assert.match(app.text(`#${hintId}`), /adds/, '滑杆说明要说清它改的是加分');
});

test('空片名提交：把服务端的原因原样说出来，不要闷着不动', async () => {
  // 这里要复现**服务端**的校验：空片名会被 400 挡下。
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return {
          status: 400,
          body: { status: 'invalid_input', issues: ['The seed must not be empty'] },
        };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  // 什么都不填直接提交。
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  assert.match(app.text('.service-error'), /The seed must not be empty/, '空片名要说清为什么');
});

test('标题要跟着模式换：演示模式讲的是另一件事', async () => {
  const app = await bootApp({ api: configuredApi() });
  await app.flush();

  // 真实服务模式：讲的是"找相似电影"。
  assert.match(app.text('h1'), /From a film you love/);

  // 切到离线演示：标题也得换，不能还写着"找相似电影"——
  // 那一段是合成场景控制台，讲的不是同一件事。
  app.switchMode('demo');
  assert.match(app.text('h1'), /Understand a ranking change/);
  assert.doesNotMatch(app.text('h1'), /Find similar films|you want next/);

  app.switchMode('service');
  assert.match(app.text('h1'), /From a film you love/);
});

test('音乐人当种子：种子上写明是音乐人，取回的仍是电影', async () => {
  const app = await bootApp({
    api: async (url) => {
      if (String(url).endsWith('/api/status')) {
        return { status: 200, body: SERVICE_STATUS_BODY };
      }
      if (String(url).endsWith('/api/resolve')) {
        return { status: 200, body: parseSearchResponse(searchArtistPayload) };
      }
      return { status: 200, body: parseInsightsResponse(insightsPayload) };
    },
  });
  await app.flush();

  app.query('#seed-type').value = 'artist';
  app.query('#seed-input').value = 'Radiohead';
  app.query('#seed-submit').dispatchEvent(new app.window.Event('click', { bubbles: true }));
  await app.flush();

  // 种子上写的是音乐人。
  assert.match(app.text('.seed-bar'), /Radiohead/);
  assert.match(app.text('.seed-bar'), /English rock band/);
  // 取回的仍然是电影。
  assert.equal(app.queryAll('.service-list .service-item').length, 4);
  assert.match(app.text('.service-list'), /Candidate A/);
});
