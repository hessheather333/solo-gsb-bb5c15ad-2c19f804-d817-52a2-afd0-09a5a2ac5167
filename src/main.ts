import './style.css';
import {
  parseNetwork,
  solve,
  inspectResilience,
  MAX_OPEN_VALVES,
  type Query,
  type SolveResult,
  type InspectionResult,
} from './solver';
import { SAMPLE_NETWORK, SAMPLE_QUERY } from './sample';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header>
    <h1>展馆水路检修隔离方案搜索</h1>
    <p class="subtitle">
      粘贴管网拓扑 JSON，指定供水点、漏点与保供出口：可搜索最优关阀组合
      （最多对 ${MAX_OPEN_VALVES} 个当前开启的阀门进行组合搜索；求解过程不修改输入中的阀门状态），
      也可执行保供韧性巡检，评估每个出口需失效多少条管段才会全面断水。
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
          漏点（仅关阀方案搜索使用）
          <input id="leak" type="text" placeholder="如：环管N2" />
        </label>
        <label>
          保供出口（多个用逗号分隔）
          <input id="outlets" type="text" placeholder="如：展厅B, 咖啡厅" />
        </label>
      </div>
      <div class="actions">
        <button id="solve" type="button" class="primary">搜索关阀方案</button>
        <button id="inspect" type="button">保供韧性巡检</button>
      </div>
      <p class="hint action-hint">
        巡检按当前阀门开闭状态，计算每个出口「失去全部供水」至少需同时失效的管段数及一组对应管段编号；
        无阀管段与开启的带阀管段各计 1 条，已关阀不参与，多供水点作为整体评估。
      </p>
    </section>
    <section class="panel result-panel">
      <h2>分析结果</h2>
      <div id="result"><p class="hint">尚未分析。可点击「载入示例拓扑」快速体验。</p></div>
    </section>
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

function renderErrors(title: string, errors: string[]): void {
  resultEl.innerHTML = `
    <div class="banner error">${escapeHtml(title)}</div>
    <ul class="error-list">
      ${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}
    </ul>`;
}

function renderResult(result: SolveResult, query: Query): void {
  if (result.status === 'invalid') {
    renderErrors('输入有误，无法求解：', result.errors);
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

function run(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(topologyEl.value);
  } catch (e) {
    renderErrors('拓扑 JSON 解析失败：', [(e as Error).message]);
    return;
  }
  const { network, errors } = parseNetwork(raw);
  if (!network) {
    renderErrors('拓扑校验失败：', errors);
    return;
  }
  const query: Query = {
    supplies: splitList(suppliesEl.value),
    leak: leakEl.value.trim(),
    outlets: splitList(outletsEl.value),
  };
  renderResult(solve(network, query), query);
}

function renderInspection(result: InspectionResult): void {
  if (result.status === 'invalid') {
    renderErrors('输入有误，无法巡检：', result.errors);
    return;
  }

  const rows = result.items
    .map((it) => {
      if (it.kind === 'is-supply') {
        return `
        <tr>
          <td>${escapeHtml(it.outlet)}</td>
          <td class="num bad">—</td>
          <td><span class="warn">出口与供水点同名，无法按管段失效评估</span></td>
          <td>${escapeHtml(it.outlet)}</td>
        </tr>`;
      }
      if (it.kind === 'dry') {
        return `
        <tr>
          <td>${escapeHtml(it.outlet)}</td>
          <td class="num bad">0</td>
          <td><span class="muted-text">（空清单，当前已断水）</span></td>
          <td><span class="bad">无（已断水）</span></td>
        </tr>`;
      }
      return `
        <tr>
          <td>${escapeHtml(it.outlet)}</td>
          <td class="num ok">${it.minFailures}</td>
          <td>${it.cutPipes.map((p) => `<code>${escapeHtml(p)}</code>`).join('、')}</td>
          <td>${it.reachableSupplies.map(escapeHtml).join('、')}</td>
        </tr>`;
    })
    .join('');

  resultEl.innerHTML = `
    <div class="banner success">
      保供韧性巡检完成：共评估 <strong>${result.items.length}</strong> 个保供出口，
      结果按「使其失去全部供水所需同时失效的管段数」升序排列，数字越小越脆弱、应优先安排巡检。
    </div>
    <p class="hint">
      纳入计数的当前可用管段：${result.activePipeCount} 条（无阀管段与开启带阀管段各按单条失效计）；
      已关阀带阀管段 ${result.closedValveCount} 条不参与；多个供水点作为整体评估；环路及并行管段分别计数。
      同时失效下列清单中的全部管段即可使对应出口失去全部供水。
    </p>
    <table>
      <thead>
        <tr><th>保供出口</th><th>至少需失效管段数</th><th>一组达到该数量的管段（巡检清单）</th><th>当前可达供水点</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function runInspection(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(topologyEl.value);
  } catch (e) {
    renderErrors('拓扑 JSON 解析失败：', [(e as Error).message]);
    return;
  }
  const { network, errors } = parseNetwork(raw);
  if (!network) {
    renderErrors('拓扑校验失败：', errors);
    return;
  }
  renderInspection(
    inspectResilience(network, {
      supplies: splitList(suppliesEl.value),
      outlets: splitList(outletsEl.value),
    })
  );
}

el<HTMLButtonElement>('#load-sample').addEventListener('click', () => {
  topologyEl.value = JSON.stringify(SAMPLE_NETWORK, null, 2);
  suppliesEl.value = SAMPLE_QUERY.supplies.join(', ');
  leakEl.value = SAMPLE_QUERY.leak;
  outletsEl.value = SAMPLE_QUERY.outlets.join(', ');
  run();
});

el<HTMLButtonElement>('#solve').addEventListener('click', run);
el<HTMLButtonElement>('#inspect').addEventListener('click', runInspection);
