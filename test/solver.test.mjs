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

// ============ 保供韧性巡检 ============
console.log('保供韧性巡检：');

const findRow = (r, name) => r.rows.find((x) => x.outlet === name);

const ir1 = solver.inspectResilience(network, { supplies: ['S1', 'S2'], leak: 'N2', outlets: ['B', 'C', 'D', 'N2'] });
check('返回 ok', ir1.status === 'ok');
// B：V08 与 V09(已关) 并行，仅 V08 可用 → 1
const iB = findRow(ir1, 'B');
check('出口 B 至少需失效 1 条（已关阀不参与）', iB.assessable && iB.minFailures === 1 && iB.witnessPipes.join(',') === 'V08');
// C：经单条无阀管段 P2 挂在环上 → 1（无阀管段按单条计）
const iC = findRow(ir1, 'C');
check('出口 C 至少需失效 1 条（无阀管段 P2）', iC.assessable && iC.minFailures === 1 && iC.witnessPipes.join(',') === 'P2');
// D：仅 V07 单管 → 1
const iD = findRow(ir1, 'D');
check('出口 D 至少需失效 1 条', iD.assessable && iD.minFailures === 1 && iD.witnessPipes.join(',') === 'V07');
// N2 位于环路中：须同时切断 V03、V04 两条管段
const iN2 = findRow(ir1, 'N2');
check('环路上的 N2 至少需失效 2 条（环路分别计数）', iN2.assessable && iN2.minFailures === 2 && iN2.witnessPipes.join(',') === 'V03,V04');
check('结果按失效数升序（1,1,1,2）', ir1.rows.map((x) => x.minFailures).join(',') === '1,1,1,2');
check('参与计数管段数（2 无阀 + 8 开启阀门，排除已关 V09）', ir1.activePipeCount === 10);

console.log('巡检：已断水出口为 0 和空清单：');
// 仅经一条关闭阀门挂在网上的出口
const cutNet = {
  nodes: ['S', 'X', 'O'],
  pipes: [],
  valvedPipes: [
    { id: 'V1', from: 'S', to: 'X', open: true },
    { id: 'V2', from: 'X', to: 'O', open: false },
  ],
};
const ir2 = solver.inspectResilience(cutNet, { supplies: ['S'], leak: '', outlets: ['O'] });
const r2row = ir2.rows[0];
check('已断水出口 minFailures=0', r2row.assessable && r2row.minFailures === 0);
check('已断水出口为空清单', Array.isArray(r2row.witnessPipes) && r2row.witnessPipes.length === 0);
check('已断水出口标记 alreadyCut', r2row.alreadyCut === true);

console.log('巡检：并行管段分别计数：');
const parNet = {
  nodes: ['S', 'O'],
  pipes: [
    { id: 'P1', from: 'S', to: 'O' },
    { id: 'P2', from: 'S', to: 'O' },
  ],
  valvedPipes: [
    { id: 'V1', from: 'S', to: 'O', open: true },
  ],
};
const ir3 = solver.inspectResilience(parNet, { supplies: ['S'], leak: '', outlets: ['O'] });
const r3row = ir3.rows[0];
check('3 条并行管段 → 需失效 3 条', r3row.assessable && r3row.minFailures === 3);
check('割清单含全部 3 条并行管段', r3row.witnessPipes.length === 3 &&
  ['P1', 'P2', 'V1'].every((p) => r3row.witnessPipes.includes(p)));

console.log('巡检：多供水点作为整体：');
// O 经 P1 连 S1、经 V1 连 S2：必须两条都失效才失去全部供水
const multiNet = {
  nodes: ['S1', 'S2', 'O'],
  pipes: [{ id: 'P1', from: 'S1', to: 'O' }],
  valvedPipes: [{ id: 'V1', from: 'S2', to: 'O', open: true }],
};
const ir4 = solver.inspectResilience(multiNet, { supplies: ['S1', 'S2'], leak: '', outlets: ['O'] });
check('双供水点分别单管接入 → 需失效 2 条', ir4.rows[0].minFailures === 2);
const ir4b = solver.inspectResilience(multiNet, { supplies: ['S1'], leak: '', outlets: ['O'] });
check('只算一个供水点时 → 需失效 1 条', ir4b.rows[0].minFailures === 1);

console.log('巡检：出口与供水点同名：');
const ir5 = solver.inspectResilience(network, { supplies: ['S1'], leak: '', outlets: ['S1', 'B'] });
const same = findRow(ir5, 'S1');
check('同名出口标记无法评估', same.assessable === false && same.reason.includes('无法按管段失效评估'));
check('无法评估排在升序结果最后', ir5.rows[1].outlet === 'S1');

console.log('巡检：无阀管段按单条计且能出现在割中：');
const pNet = {
  nodes: ['S', 'M', 'O'],
  pipes: [{ id: 'P1', from: 'M', to: 'O' }],
  valvedPipes: [{ id: 'V1', from: 'S', to: 'M', open: true }],
};
const ir6 = solver.inspectResilience(pNet, { supplies: ['S'], leak: '', outlets: ['O'] });
check('串联无阀管段场景需失效 1 条', ir6.rows[0].minFailures === 1);
check('割可以是无阀管段 P1 或带阀管段 V1', ['P1', 'V1'].includes(ir6.rows[0].witnessPipes[0]));

console.log('巡检：校验与纯函数：');
const ir7 = solver.inspectResilience(network, { supplies: ['NOPE'], leak: '', outlets: ['B'] });
check('供水点不存在时报错', ir7.status === 'invalid');
const ir8 = solver.inspectResilience(network, { supplies: ['S1'], leak: '', outlets: ['NOPE'] });
check('出口不存在时报错', ir8.status === 'invalid');
const ir9 = solver.inspectResilience(network, { supplies: [], leak: '', outlets: ['B'] });
check('缺少供水点时报错', ir9.status === 'invalid');
const beforeInsp = JSON.stringify(network);
solver.inspectResilience(network, { supplies: ['S1', 'S2'], leak: '', outlets: ['B', 'C'] });
check('巡检不修改输入网络', JSON.stringify(network) === beforeInsp);
// 不受 12 个开启阀门上限影响（巡检为多项式最大流，非组合枚举）
const ir10 = solver.inspectResilience(many.network, { supplies: ['a'], leak: '', outlets: ['b'] });
check('巡检不受开启阀门 12 个上限影响', ir10.status === 'ok' && ir10.rows[0].minFailures === 13);

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
