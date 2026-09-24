import './style.css';
import {
  parseNetwork,
  solve,
  inspectResilience,
  MAX_OPEN_VALVES,
  type Query,
  type SolveResult,
  type ResilienceResult,
} from './solver';
import { SAMPLE_NETWORK, SAMPLE_QUERY } from './sample';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header>
    <h1>展馆水路检修隔离方案搜索</h1>
    <p class="subtitle">
      粘贴管网拓扑 JSON，指定供水点、漏点与保供出口，可自动搜索最优关阀组合，
      也可对各保供出口做「保供韧性巡检」（按当前阀门开闭状态估算使其断水至少需失效的管段数）。
      组合搜索最多覆盖 ${MAX_OPEN_VALVES} 个当前开启的阀门；求解过程不修改输入中的阀门状态。
    </p>
  </header>
  <main>
    <section class="panel input-panel">
      <div class="panel-title">
        <h2>1. 管网拓扑 JSON</h2>
        <button id="load-sample" type="button">载入示例拓扑</button>
      </div>
      <textarea id="topology" spellcheck="false" placeholder='{"nodes":[...],"pipes":[...],"valvedPipes":[...]}'></textarea>
      <h2>2. 检修条件</h2>
      <div class="fields">
        <label>
          供水点（多个用逗号分隔）
          <input id="supplies" type="text" placeholder="如：市政供水S1, 备用水箱S2" />
        </label>
        <label>
          漏点
          <input id="leak" type="text" placeholder="如：环管N2" />
        </label>
        <label>
          保供出口（多个用逗号分隔）
          <input id="outlets" type="text" placeholder="如：展厅B, 咖啡厅" />
        </label>
      </div>
      <div class="button-row">
        <button id="solve" type="button" class="primary">搜索关阀方案</button>
        <button id="inspect" type="button" class="secondary">保供韧性巡检</button>
      </div>
      <p class="hint">
        巡检沿用上方「供水点」与「保供出口」：无阀管段与开启的带阀管段均按单条失效计，
        已关阀不参与；多供水点作为整体，环路及并行管段分别计数。
      </p>
    </section>
    <div class="side-column">
      <section class="panel result-panel">
        <h2>关阀方案搜索结果</h2>
        <div id="result"><p class="hint">尚未求解。可点击「载入示例拓扑」快速体验。</p></div>
      </section>
      <section class="panel result-panel">
        <h2>保供韧性巡检</h2>
        <div id="inspect-result">
          <p class="hint">
            点击「保供韧性巡检」后，这里按「使其失去全部供水至少需失效的不同管段数」升序列出各出口，
            并给出一组达到该数量的管段编号，供安排巡检。
          </p>
        </div>
      </section>
    </div>
  </main>
`;

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`缺少元素 ${selector}`);
  return node;
}

const topologyEl = el<HTMLTextAreaElement>('#topology');
const suppliesEl = el<HTMLInputElement>('#supplies');
const leakEl = el<HTMLInputElement>('#leak');
const outletsEl = el<HTMLInputElement>('#outlets');
const resultEl = el<HTMLDivElement>('#result');
const inspectResultEl = el<HTMLDivElement>('#inspect-result');

function splitList(text: string): string[] {
  return text
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]!));
}

function renderErrors(target: HTMLElement, title: string, errors: string[]): void {
  target.innerHTML = `
    <div class="banner error">${escapeHtml(title)}</div>
    <ul class="error-list">
      ${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}
    </ul>`;
}

function renderResult(result: SolveResult, query: Query): void {
  if (result.status === 'invalid') {
    renderErrors(resultEl, '输入有误，无法求解：', result.errors);
    return;
  }
  if (result.status === 'no-solution') {
    resultEl.innerHTML = `
      <div class="banner error">无解：当前条件下不存在满足要求的关阀组合。</div>
      <p>${escapeHtml(result.reason)}</p>
      <p class="hint">参与搜索的开启阀门数：${result.openValveCount}</p>`;
    return;
  }

  const best = result.solutions[0];
  const rows = (sol: typeof best) =>
    sol.outletStatus
      .map(
        (o) => `
        <tr>
          <td>${escapeHtml(o.outlet)}</td>
          <td class="${o.connected ? 'ok' : 'bad'}">${o.connected ? '✓ 正常供水' : '✗ 断水'}</td>
          <td>${o.reachableSupplies.map(escapeHtml).join('、') || '—'}</td>
        </tr>`
      )
      .join('');

  resultEl.innerHTML = `
    <div class="banner success">
      找到 ${result.solutions.length}${result.truncated ? '+' : ''} 个最优方案：
      最少需关闭 <strong>${result.minClosed}</strong> 个阀门。
      推荐方案（同数按阀门编号字典序最小）：关闭
      ${best.closed.length > 0 ? best.closed.map((v) => `<code>${escapeHtml(v)}</code>`).join('、') : '（无需关阀）'}
    </div>
    <p class="hint">
      参与搜索的当前开启阀门数：${result.openValveCount}；
      漏点「${escapeHtml(query.leak)}」在所有方案中均已与全部供水点断开；
      输入 JSON 中的阀门开闭状态不会被修改。
    </p>
    ${result.solutions
      .map(
        (sol, i) => `
      <details class="solution" ${i === 0 ? 'open' : ''}>
        <summary>
          方案 ${i + 1}：关闭 ${sol.closed.length} 个阀门
          ${sol.closed.length > 0 ? `（${sol.closed.map(escapeHtml).join('、')}）` : ''}
        </summary>
        <table>
          <thead>
            <tr><th>保供出口</th><th>连通状态</th><th>可达供水点</th></tr>
          </thead>
          <tbody>${rows(sol)}</tbody>
        </table>
      </details>`
      )
      .join('')}
    ${result.truncated ? '<p class="hint">最优方案过多，仅展示前 100 个。</p>' : ''}`;
}

function renderInspection(result: ResilienceResult): void {
  if (result.status === 'invalid') {
    renderErrors(inspectResultEl, '输入有误，无法巡检：', result.errors);
    return;
  }

  const rows = result.rows.map((row) => {
    if (!row.assessable) {
      return `
        <tr>
          <td>${escapeHtml(row.outlet)}</td>
          <td><span class="tag tag-skip">无法评估</span></td>
          <td class="num">—</td>
          <td>${escapeHtml(row.reason)}</td>
        </tr>`;
    }
    const tag = row.alreadyCut
      ? '<span class="tag tag-cut">已断水</span>'
      : row.minFailures === 1
        ? '<span class="tag tag-low">薄弱</span>'
        : '<span class="tag tag-ok">有韧性</span>';
    const pipes =
      row.witnessPipes.length > 0
        ? row.witnessPipes.map((p) => `<code>${escapeHtml(p)}</code>`).join('、')
        : '<span class="hint">（空清单）</span>';
    return `
      <tr>
        <td>${escapeHtml(row.outlet)}</td>
        <td>${tag}</td>
        <td class="num"><strong>${row.minFailures}</strong></td>
        <td>${pipes}</td>
      </tr>`;
  });

  inspectResultEl.innerHTML = `
    <div class="banner success">
      巡检完成：共评估 ${result.rows.length} 个保供出口，参与计数的管段
      （无阀管段 + 当前开启的带阀管段）共 <strong>${result.activePipeCount}</strong> 条；
      已关阀不参与。结果已按所需失效数升序排列。
    </div>
    <table>
      <thead>
        <tr><th>保供出口</th><th>状态</th><th>至少需失效管段数</th><th>一组达到该数量的管段（巡检清单）</th></tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <p class="hint">
      数值表示：在当前阀门开闭状态下，使该出口与全部供水点断开，至少需要同时失效多少条不同管段
      （多供水点作为整体；环路及并行管段分别计数）。已断水出口显示 0 与空清单；
      出口与供水点同名时无法按管段失效评估。数值越小越应优先巡检，右侧管段为一组最薄弱环节。
    </p>`;
}

function readQuery(): { network: import('./solver').Network; query: Query } {
  let raw: unknown;
  try {
    raw = JSON.parse(topologyEl.value);
  } catch (e) {
    throw { topologyErrors: [`拓扑 JSON 解析失败：${(e as Error).message}`] };
  }
  const { network, errors } = parseNetwork(raw);
  if (!network) throw { topologyErrors: errors };
  const query: Query = {
    supplies: splitList(suppliesEl.value),
    leak: leakEl.value.trim(),
    outlets: splitList(outletsEl.value),
  };
  return { network, query };
}

function run(): void {
  try {
    const { network, query } = readQuery();
    renderResult(solve(network, query), query);
  } catch (e) {
    renderErrors(resultEl, '拓扑校验失败：', (e as { topologyErrors: string[] }).topologyErrors);
  }
}

function runInspection(): void {
  try {
    const { network, query } = readQuery();
    renderInspection(inspectResilience(network, query));
  } catch (e) {
    renderErrors(inspectResultEl, '拓扑校验失败：', (e as { topologyErrors: string[] }).topologyErrors);
  }
}

el<HTMLButtonElement>('#load-sample').addEventListener('click', () => {
  topologyEl.value = JSON.stringify(SAMPLE_NETWORK, null, 2);
  suppliesEl.value = SAMPLE_QUERY.supplies.join(', ');
  leakEl.value = SAMPLE_QUERY.leak;
  outletsEl.value = SAMPLE_QUERY.outlets.join(', ');
  run();
  runInspection();
});

el<HTMLButtonElement>('#solve').addEventListener('click', run);
el<HTMLButtonElement>('#inspect').addEventListener('click', runInspection);
