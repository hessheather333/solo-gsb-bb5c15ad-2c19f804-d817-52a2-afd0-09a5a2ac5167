// 求解器单元测试：node test/solver.test.mjs
// 先用 tsc 将 src/solver.ts 编译到临时目录，再运行断言。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(join(tmpdir(), 'solver-test-'));
execFileSync('npx', ['tsc', 'src/solver.ts', '--outDir', outDir, '--module', 'ES2020', '--target', 'ES2020', '--moduleResolution', 'bundler', '--skipLibCheck'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'inherit',
});
// tsc 输出为 ESM 但无 package.json 类型声明，改名为 .mjs 以便 import
const { renameSync } = await import('node:fs');
renameSync(join(outDir, 'solver.js'), join(outDir, 'solver.mjs'));
const solver = await import(pathToFileURL(join(outDir, 'solver.mjs')).href);

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const network = {
  nodes: ['S1', 'S2', 'N1', 'N2', 'N3', 'N4', 'A', 'B', 'C', 'D'],
  pipes: [
    { id: 'P1', from: 'A', to: 'N2' },
    { id: 'P2', from: 'C', to: 'N3' },
  ],
  valvedPipes: [
    { id: 'V01', from: 'S1', to: 'N1', open: true },
    { id: 'V02', from: 'S2', to: 'N4', open: true },
    { id: 'V03', from: 'N1', to: 'N2', open: true },
    { id: 'V04', from: 'N2', to: 'N3', open: true },
    { id: 'V05', from: 'N3', to: 'N4', open: true },
    { id: 'V06', from: 'N4', to: 'N1', open: true },
    { id: 'V07', from: 'D', to: 'N3', open: true },
    { id: 'V08', from: 'B', to: 'N1', open: true },
    { id: 'V09', from: 'B', to: 'N4', open: false },
  ],
};
const query = { supplies: ['S1', 'S2'], leak: 'N2', outlets: ['B', 'C', 'D'] };

console.log('基本求解：');
const r1 = solver.solve(network, query);
check('返回 ok', r1.status === 'ok');
check('最少关阀数为 2', r1.minClosed === 2);
check('唯一最优方案为 [V03, V04]', r1.solutions.length === 1 && r1.solutions[0].closed.join(',') === 'V03,V04');
check('漏点已隔离', r1.solutions[0].leakIsolated === true);
check('全部出口连通', r1.solutions[0].outletStatus.every((o) => o.connected));
check('出口 B 可达 S1', r1.solutions[0].outletStatus.find((o) => o.outlet === 'B').reachableSupplies.includes('S1'));

console.log('输入不被修改：');
const before = JSON.stringify(network);
solver.solve(network, query);
check('求解后 network 未变化', JSON.stringify(network) === before);

console.log('无需关阀（漏点本就隔离）：');
const r2 = solver.solve(network, { supplies: ['S1'], leak: 'D', outlets: ['A'] });
// D 通过 V07 连到 N3... S1 可达 N3，所以 D 并未隔离 —— 构造真正隔离的场景：
const isoNet = {
  nodes: ['S1', 'X', 'Y'],
  pipes: [],
  valvedPipes: [
    { id: 'V1', from: 'S1', to: 'X', open: true },
    { id: 'V2', from: 'Y', to: 'X', open: false },
  ],
};
const r2b = solver.solve(isoNet, { supplies: ['S1'], leak: 'Y', outlets: ['X'] });
check('漏点已天然隔离时关阀数为 0', r2b.status === 'ok' && r2b.minClosed === 0 && r2b.solutions[0].closed.length === 0);
void r2;

console.log('无解场景：');
const r3 = solver.solve(network, { supplies: ['S1', 'S2'], leak: 'N2', outlets: ['A'] });
check('保供出口与漏点同管段时无解', r3.status === 'no-solution');

console.log('字典序取舍：');
// S—V1—M—V2—L 为串联：关闭 V1 或 V2 都能隔离漏点，
// 两个等价的最小方案 [V1] 与 [V2]，字典序应优先 [V1]
const tieNet = {
  nodes: ['S', 'M', 'L', 'O'],
  pipes: [],
  valvedPipes: [
    { id: 'V2', from: 'M', to: 'L', open: true },
    { id: 'V1', from: 'S', to: 'M', open: true },
    { id: 'V3', from: 'O', to: 'S', open: true },
  ],
};
const r4 = solver.solve(tieNet, { supplies: ['S'], leak: 'L', outlets: ['O'] });
check('并列方案均列出且按字典序排列', r4.status === 'ok' && r4.minClosed === 1 &&
  r4.solutions.length === 2 && r4.solutions[0].closed[0] === 'V1' && r4.solutions[1].closed[0] === 'V2');

console.log('校验：');
const r5 = solver.solve(network, { supplies: ['S1', 'N2'], leak: 'N2', outlets: [] });
check('漏点不能是供水点', r5.status === 'invalid');
const dup = solver.parseNetwork({ nodes: ['a', 'b'], pipes: [], valvedPipes: [
  { id: 'V1', from: 'a', to: 'b', open: true },
  { id: 'V1', from: 'b', to: 'a', open: true },
] });
check('阀门编号重复被拒绝', !dup.network && dup.errors.some((e) => e.includes('重复')));
const many = solver.parseNetwork({
  nodes: ['a', 'b'],
  pipes: [],
  valvedPipes: Array.from({ length: 13 }, (_, i) => ({ id: `V${i}`, from: 'a', to: 'b', open: true })),
});
const r6 = solver.solve(many.network, { supplies: ['a'], leak: 'b', outlets: [] });
check('超过 12 个开启阀门被拒绝', r6.status === 'invalid' && r6.errors.some((e) => e.includes('13')));

console.log('保供韧性巡检：');
// 复用主网络（V09 关闭）：出口均经单条枝管连到环状干管
const i1 = solver.inspectResilience(network, { supplies: ['S1', 'S2'], outlets: ['B', 'C', 'D'] });
check('巡检返回 ok', i1.status === 'ok');
check('可用管段计数正确（2 无阀 + 8 开启阀门）', i1.activePipeCount === 10);
check('已关阀管段计数为 1', i1.closedValveCount === 1);
check('三个出口最少失效数均为 1（单条枝管）',
  i1.items.every((it) => it.kind === 'ok' && it.minFailures === 1));
const bItem = i1.items.find((it) => it.outlet === 'B');
check('出口 B 的巡检清单为 [V08]（V09 已关不参与）', bItem.cutPipes.join(',') === 'V08');
const cItem = i1.items.find((it) => it.outlet === 'C');
check('出口 C 的巡检清单为 [P2]', cItem.cutPipes.join(',') === 'P2');
check('清单长度等于最小失效数', i1.items.every((it) => it.cutPipes.length === it.minFailures));

// 验证割集确实有效：删除清单管段后出口与全部供水点断开
function disconnectedAfterCut(net, supplies, outlet, cutIds) {
  const cut = new Set(cutIds);
  const adj = new Map();
  const addEdge = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const p of net.pipes) {
    if (!cut.has(p.id)) { addEdge(p.from, p.to); addEdge(p.to, p.from); }
  }
  for (const vp of net.valvedPipes) {
    if (vp.open && !cut.has(vp.id)) { addEdge(vp.from, vp.to); addEdge(vp.to, vp.from); }
  }
  const seen = new Set(supplies);
  const q = [...supplies];
  while (q.length) {
    const v = q.shift();
    for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); q.push(w); }
  }
  return !seen.has(outlet);
}
check('割集验证：清单失效后出口确实断水',
  i1.items.every((it) => disconnectedAfterCut(network, ['S1', 'S2'], it.outlet, it.cutPipes)));

console.log('巡检：环路与并行管段分别计数：');
// 环：S-a, a-b 两条并行，b-O，验证割数为 1；四条边组成的环 S-x-O, S-y-O 验证割数为 2
const ringNet = {
  nodes: ['S', 'X', 'Y', 'O'],
  pipes: [
    { id: 'P1', from: 'S', to: 'X' },
    { id: 'P2', from: 'X', to: 'O' },
    { id: 'P3', from: 'S', to: 'Y' },
    { id: 'P4', from: 'Y', to: 'O' },
  ],
  valvedPipes: [],
};
const i2 = solver.inspectResilience(ringNet, { supplies: ['S'], outlets: ['O'] });
check('环路两条独立路径 → 需失效 2 条', i2.items[0].minFailures === 2);
check('割集为跨割的 2 条不同管段', i2.items[0].cutPipes.length === 2);
check('割集失效后确实断水', disconnectedAfterCut(ringNet, ['S'], 'O', i2.items[0].cutPipes));

const paraNet = {
  nodes: ['S', 'A', 'B', 'O'],
  pipes: [
    { id: 'P1', from: 'S', to: 'A' },
    { id: 'P2', from: 'A', to: 'B' },
    { id: 'P3', from: 'A', to: 'B' },
    { id: 'P4', from: 'B', to: 'O' },
  ],
  valvedPipes: [],
};
const i3 = solver.inspectResilience(paraNet, { supplies: ['S'], outlets: ['O'] });
check('并行管段只计数为 1（瓶颈在 P1/P4）', i3.items[0].minFailures === 1);

console.log('巡检：多供水点作为整体：');
// S1、S2 各经一条管段在 X 汇合后到 O：割 X-O 一条即可，不能只断单个水源
const multiNet = {
  nodes: ['S1', 'S2', 'X', 'O'],
  pipes: [
    { id: 'P1', from: 'S1', to: 'X' },
    { id: 'P2', from: 'S2', to: 'X' },
    { id: 'P3', from: 'X', to: 'O' },
  ],
  valvedPipes: [],
};
const i4 = solver.inspectResilience(multiNet, { supplies: ['S1', 'S2'], outlets: ['O'] });
check('多水源整体：切断公共段 P3 一条即可', i4.items[0].minFailures === 1 && i4.items[0].cutPipes.join(',') === 'P3');

console.log('巡检：已断水出口、同名供水点与排序：');
// A 当前已断水（唯一连通阀 V1 关闭）；S 与供水点同名
const weirdNet = {
  nodes: ['S', 'M', 'A'],
  pipes: [],
  valvedPipes: [
    { id: 'V1', from: 'S', to: 'M', open: true },
    { id: 'V2', from: 'M', to: 'A', open: false },
  ],
};
const i5 = solver.inspectResilience(weirdNet, { supplies: ['S'], outlets: ['S', 'A'] });
check('结果数为 2（去重）', i5.items.length === 2);
check('已断水出口排最前且为 0 / 空清单',
  i5.items[0].outlet === 'A' && i5.items[0].kind === 'dry' &&
  i5.items[0].minFailures === 0 && i5.items[0].cutPipes.length === 0);
check('同名供水点排最后且无法评估',
  i5.items[1].outlet === 'S' && i5.items[1].kind === 'is-supply' &&
  i5.items[1].minFailures === null && i5.items[1].cutPipes.length === 0);

console.log('巡检：校验：');
const i6 = solver.inspectResilience(network, { supplies: [], outlets: ['B'] });
check('缺少供水点被拒绝', i6.status === 'invalid' && i6.errors.some((e) => e.includes('供水点')));
const i7 = solver.inspectResilience(network, { supplies: ['S1'], outlets: ['ZZZ'] });
check('出口不在节点中被拒绝', i7.status === 'invalid' && i7.errors.some((e) => e.includes('ZZZ')));
const netBefore = JSON.stringify(network);
solver.inspectResilience(network, { supplies: ['S1', 'S2'], outlets: ['B', 'C', 'D'] });
check('巡检不修改输入', JSON.stringify(network) === netBefore);

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
