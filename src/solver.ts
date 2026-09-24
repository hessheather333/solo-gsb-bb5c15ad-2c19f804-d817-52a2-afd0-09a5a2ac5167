/**
 * 水路检修隔离求解器（纯函数，不修改输入）。
 *
 * 模型：管网为无向图。节点通过「无阀管段」与「带阀管段」相连。
 * 关闭一个阀门等价于从图中移除该带阀管段。
 * 目标：在「当前开启」的阀门中寻找关阀组合，使得
 *   1. 漏点与所有供水点断开；
 *   2. 每个保供出口仍能连通至少一个供水点。
 * 优选规则：关阀数最少；同数时按阀门编号排序后的列表取字典序最小。
 */

export interface Pipe {
  id: string;
  from: string;
  to: string;
}

export interface ValvedPipe extends Pipe {
  open: boolean;
}

export interface Network {
  nodes: string[];
  /** 无阀管段 */
  pipes: Pipe[];
  /** 带阀管段，阀门编号 id 全网唯一 */
  valvedPipes: ValvedPipe[];
}

export interface Query {
  /** 供水点节点 */
  supplies: string[];
  /** 漏点节点 */
  leak: string;
  /** 必须不断水的出口节点 */
  outlets: string[];
}

export interface OutletStatus {
  outlet: string;
  connected: boolean;
  /** 该出口当前能连通的供水点 */
  reachableSupplies: string[];
}

export interface Solution {
  /** 需要关闭的阀门编号（升序） */
  closed: string[];
  leakIsolated: boolean;
  outletStatus: OutletStatus[];
}

export interface SolveOk {
  status: 'ok';
  openValveCount: number;
  minClosed: number;
  /** 全部最优（关阀数最少）方案，按字典序排列 */
  solutions: Solution[];
  /** 最优方案总数超过展示上限时为 true */
  truncated: boolean;
}

export interface SolveNoSolution {
  status: 'no-solution';
  openValveCount: number;
  reason: string;
}

export interface SolveInvalid {
  status: 'invalid';
  errors: string[];
}

export type SolveResult = SolveOk | SolveNoSolution | SolveInvalid;

/** 参与组合的开启阀门数量上限 */
export const MAX_OPEN_VALVES = 12;
/** 收集的最优方案数上限（防止结果爆炸） */
export const MAX_SOLUTIONS = 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === 'string' && x.length > 0)) return null;
  return v as string[];
}

/** 解析并校验拓扑 JSON，返回网络或错误列表。 */
export function parseNetwork(raw: unknown): { network?: Network; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { errors: ['拓扑 JSON 必须是一个对象，包含 nodes / pipes / valvedPipes 三个字段。'] };
  }

  const nodes = asStringArray(raw.nodes);
  if (!nodes || nodes.length === 0) {
    errors.push('nodes 必须是非空字符串数组。');
  }
  const nodeSet = new Set(nodes ?? []);
  if (nodes && nodeSet.size !== nodes.length) {
    errors.push('nodes 中存在重复节点。');
  }

  const parsePipes = (v: unknown, field: string, requireOpen: boolean): (Pipe[] | ValvedPipe[] | null) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      errors.push(`${field} 必须是数组。`);
      return null;
    }
    const out: (Pipe | ValvedPipe)[] = [];
    for (let i = 0; i < v.length; i++) {
      const p = v[i];
      if (!isRecord(p) || typeof p.id !== 'string' || !p.id ||
          typeof p.from !== 'string' || !p.from ||
          typeof p.to !== 'string' || !p.to) {
        errors.push(`${field}[${i}] 必须包含非空字符串字段 id / from / to。`);
        continue;
      }
      if (requireOpen && typeof p.open !== 'boolean') {
        errors.push(`${field}[${i}]（${p.id}）缺少布尔字段 open。`);
        continue;
      }
      out.push(
        requireOpen
          ? { id: p.id, from: p.from, to: p.to, open: p.open as boolean }
          : { id: p.id, from: p.from, to: p.to }
      );
    }
    return out;
  };

  const pipes = parsePipes(raw.pipes, 'pipes', false) as Pipe[] | null;
  const valvedPipes = parsePipes(raw.valvedPipes, 'valvedPipes', true) as ValvedPipe[] | null;

  // 阀门编号唯一性校验（阀门编号在带阀管段间必须唯一）
  if (valvedPipes) {
    const seen = new Set<string>();
    for (const vp of valvedPipes) {
      if (seen.has(vp.id)) errors.push(`阀门编号「${vp.id}」重复，阀门编号必须唯一。`);
      seen.add(vp.id);
    }
  }
  // 无管段编号也不允许（无阀管段与带阀管段之间也不允许重号，便于结果指代）
  if (pipes && valvedPipes) {
    const valvedIds = new Set(valvedPipes.map((p) => p.id));
    const pipeSeen = new Set<string>();
    for (const p of pipes) {
      if (valvedIds.has(p.id)) errors.push(`管段编号「${p.id}」同时出现在 pipes 与 valvedPipes 中。`);
      if (pipeSeen.has(p.id)) errors.push(`无阀管段编号「${p.id}」重复。`);
      pipeSeen.add(p.id);
    }
  }
  // 端点必须已声明
  if (nodes) {
    for (const p of [...(pipes ?? []), ...(valvedPipes ?? [])]) {
      if (!nodeSet.has(p.from)) errors.push(`管段「${p.id}」的起点「${p.from}」未在 nodes 中声明。`);
      if (!nodeSet.has(p.to)) errors.push(`管段「${p.id}」的终点「${p.to}」未在 nodes 中声明。`);
    }
  }

  if (errors.length > 0 || !nodes || !pipes || !valvedPipes) {
    return { errors: errors.length > 0 ? errors : ['拓扑解析失败。'] };
  }
  return { network: { nodes, pipes, valvedPipes }, errors: [] };
}

/** 校验查询条件（供水点 / 漏点 / 保供出口）。 */
export function validateQuery(network: Network, query: Query): string[] {
  const errors: string[] = [];
  const nodeSet = new Set(network.nodes);
  if (query.supplies.length === 0) errors.push('至少需要指定一个供水点。');
  for (const s of query.supplies) {
    if (!nodeSet.has(s)) errors.push(`供水点「${s}」不在节点列表中。`);
  }
  if (!query.leak) {
    errors.push('必须指定漏点。');
  } else if (!nodeSet.has(query.leak)) {
    errors.push(`漏点「${query.leak}」不在节点列表中。`);
  }
  if (query.leak && query.supplies.includes(query.leak)) {
    errors.push(`漏点「${query.leak}」不能同时是供水点。`);
  }
  for (const o of query.outlets) {
    if (!nodeSet.has(o)) errors.push(`保供出口「${o}」不在节点列表中。`);
  }
  const openCount = network.valvedPipes.filter((v) => v.open).length;
  if (openCount > MAX_OPEN_VALVES) {
    errors.push(
      `当前开启的阀门有 ${openCount} 个，超过上限 ${MAX_OPEN_VALVES} 个；` +
      '请先在输入中将部分阀门标记为关闭（"open": false）后再求解。'
    );
  }
  return errors;
}

/** 构建无向邻接表：无阀管段全部保留，带阀管段仅在开启且未被关闭时保留。 */
function buildAdjacency(network: Network, closed: Set<string>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const addEdge = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const p of network.pipes) {
    addEdge(p.from, p.to);
    addEdge(p.to, p.from);
  }
  for (const vp of network.valvedPipes) {
    if (!vp.open || closed.has(vp.id)) continue; // 已关闭的阀门视为断开
    addEdge(vp.from, vp.to);
    addEdge(vp.to, vp.from);
  }
  return adj;
}

function bfs(adj: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** 评估某个关阀组合，返回该方案详情（不修改输入网络）。 */
export function evaluate(network: Network, query: Query, closed: string[]): Solution {
  const closedSet = new Set(closed);
  const adj = buildAdjacency(network, closedSet);
  const reachBySupply = new Map<string, Set<string>>();
  for (const s of query.supplies) {
    reachBySupply.set(s, bfs(adj, s));
  }
  const leakIsolated = query.supplies.every((s) => !reachBySupply.get(s)!.has(query.leak));
  const outletStatus: OutletStatus[] = query.outlets.map((outlet) => {
    const reachableSupplies = query.supplies.filter((s) => reachBySupply.get(s)!.has(outlet));
    return { outlet, connected: reachableSupplies.length > 0, reachableSupplies };
  });
  return { closed: [...closed].sort(), leakIsolated, outletStatus };
}

function isValid(sol: Solution): boolean {
  return sol.leakIsolated && sol.outletStatus.every((o) => o.connected);
}

/**
 * 按关阀数从小到大枚举组合；组合本身按「编号升序列表」的字典序生成，
 * 因此同一关阀数下第一个可行解即字典序最小解。
 */
export function solve(network: Network, query: Query): SolveResult {
  const queryErrors = validateQuery(network, query);
  if (queryErrors.length > 0) return { status: 'invalid', errors: queryErrors };

  const openValves = network.valvedPipes.filter((v) => v.open).map((v) => v.id).sort();
  const n = openValves.length;

  for (let k = 0; k <= n; k++) {
    const solutions: Solution[] = [];
    let truncated = false;
    // 字典序生成 k 组合
    const idx = Array.from({ length: k }, (_, i) => i);
    while (true) {
      if (k > 0) {
        const closed = idx.map((i) => openValves[i]);
        const sol = evaluate(network, query, closed);
        if (isValid(sol)) {
          if (solutions.length < MAX_SOLUTIONS) {
            solutions.push(sol);
          } else {
            truncated = true;
          }
        }
      } else {
        const sol = evaluate(network, query, []);
        if (isValid(sol)) solutions.push(sol);
      }
      if (k === 0) break;
      // 下一个组合
      let i = k - 1;
      while (i >= 0 && idx[i] === n - k + i) i--;
      if (i < 0) break;
      idx[i]++;
      for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
    }
    if (solutions.length > 0) {
      return { status: 'ok', openValveCount: n, minClosed: k, solutions, truncated };
    }
  }
  return {
    status: 'no-solution',
    openValveCount: n,
    reason:
      '在全部当前开启阀门的任意关阀组合中，均无法同时满足「漏点与所有供水点断开」且「每个保供出口仍连通至少一个供水点」。' +
      '请检查拓扑、供水点与保供出口设置，或考虑增设阀门 / 旁通管段。',
  };
}

/* ======================================================================
 * 保供韧性巡检（最小割）
 *
 * 对每个保供出口，计算「使其失去全部供水至少需同时失效的不同管段数」：
 *   - 无阀管段、当前开启的带阀管段各视为容量 1 的无向边（单条失效即断）；
 *   - 已关闭的带阀管段当前本就不通，不参与；
 *   - 增设超级源，以无限容量的有向边连接全部供水点，多供水点作为整体；
 *   - 超级源 → 出口的最小割容量 = 最少失效管段数（边不相交路径定理），
 *     跨过割的管段即为一组达到该数量的管段编号；
 *   - 环路与并行管段各自占 1 单位容量，故分别计数。
 * ==================================================================== */

export type InspectionKind = 'ok' | 'dry' | 'is-supply';

export interface InspectionItem {
  outlet: string;
  kind: InspectionKind;
  /**
   * 使其失去全部供水至少需同时失效的管段数：
   * 已断水出口为 0；出口与供水点同名时为 null（无法按管段失效评估）。
   */
  minFailures: number | null;
  /** 一组达到 minFailures 的管段编号（升序）；不可评估时为空清单 */
  cutPipes: string[];
  /** 巡检口径下该出口当前可达的供水点（已断水时为空） */
  reachableSupplies: string[];
}

export interface InspectionOk {
  status: 'ok';
  /** 纳入计数的管段数（无阀管段 + 开启带阀管段） */
  activePipeCount: number;
  /** 不参与计数的已关阀管段数 */
  closedValveCount: number;
  /** 按所需失效数升序：已断水(0) 在前，同名供水点在后，并列保持输入顺序 */
  items: InspectionItem[];
}

export interface InspectionInvalid {
  status: 'invalid';
  errors: string[];
}

export type InspectionResult = InspectionOk | InspectionInvalid;

interface FlowEdge {
  to: number;
  cap: number;
  rev: number;
}

/** 加一条容量为 1 的无向边：两个方向互为反向边、初始容量均为 1。 */
function addUndirected(g: FlowEdge[][], u: number, v: number): void {
  g[u].push({ to: v, cap: 1, rev: g[v].length });
  g[v].push({ to: u, cap: 1, rev: g[u].length - 1 });
}

/** 加一条有向边（用于超级源 → 供水点）。 */
function addDirected(g: FlowEdge[][], u: number, v: number, cap: number): void {
  g[u].push({ to: v, cap, rev: g[v].length });
  g[v].push({ to: u, cap: 0, rev: g[u].length - 1 });
}

/** Dinic 最大流（容量均为整数，图规模为管网级别）。 */
function dinicMaxFlow(g: FlowEdge[][], s: number, t: number): number {
  const n = g.length;
  const level = new Array<number>(n).fill(-1);
  const it = new Array<number>(n).fill(0);

  const bfsLevel = (): boolean => {
    level.fill(-1);
    level[s] = 0;
    const queue = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      for (const e of g[v]) {
        if (e.cap > 0 && level[e.to] < 0) {
          level[e.to] = level[v] + 1;
          queue.push(e.to);
        }
      }
    }
    return level[t] >= 0;
  };

  const dfs = (v: number, pushed: number): number => {
    if (v === t || pushed === 0) return pushed;
    for (; it[v] < g[v].length; it[v]++) {
      const e = g[v][it[v]];
      if (e.cap <= 0 || level[e.to] !== level[v] + 1) continue;
      const d = dfs(e.to, Math.min(pushed, e.cap));
      if (d === 0) continue;
      e.cap -= d;
      g[e.to][e.rev].cap += d;
      return d;
    }
    return 0;
  };

  let flow = 0;
  while (bfsLevel()) {
    it.fill(0);
    while (true) {
      const pushed = dfs(s, Number.MAX_SAFE_INTEGER);
      if (pushed === 0) break;
      flow += pushed;
    }
  }
  return flow;
}

/** 最大流跑完后，残量网络中从源点仍可达的节点构成最小割的源侧。 */
function residualReachable(g: FlowEdge[][], s: number): Set<number> {
  const seen = new Set<number>([s]);
  const queue = [s];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    for (const e of g[v]) {
      if (e.cap > 0 && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

/** 当前通水的管段：全部无阀管段 + 开启的带阀管段；已关阀不参与。 */
function activePipes(network: Network): Pipe[] {
  return [
    ...network.pipes,
    ...network.valvedPipes.filter((v) => v.open),
  ];
}

/**
 * 保供韧性巡检：按当前阀门开闭状态，对每个保供出口求使其断水的最小失效管段集合。
 * 纯函数，不修改输入网络与阀门状态；巡检不使用漏点，也不受开启阀门数量上限约束。
 */
export function inspectResilience(
  network: Network,
  query: Pick<Query, 'supplies' | 'outlets'>
): InspectionResult {
  const errors: string[] = [];
  const nodeSet = new Set(network.nodes);
  const supplies = [...new Set(query.supplies)];
  const outlets = [...new Set(query.outlets)];
  if (supplies.length === 0) errors.push('至少需要指定一个供水点。');
  for (const s of supplies) {
    if (!nodeSet.has(s)) errors.push(`供水点「${s}」不在节点列表中。`);
  }
  if (outlets.length === 0) errors.push('至少需要指定一个保供出口。');
  for (const o of outlets) {
    if (!nodeSet.has(o)) errors.push(`保供出口「${o}」不在节点列表中。`);
  }
  if (errors.length > 0) return { status: 'invalid', errors };

  const pipes = activePipes(network);
  const nodeIndex = new Map<string, number>();
  network.nodes.forEach((name, i) => nodeIndex.set(name, i));
  const source = network.nodes.length;
  const nNodes = network.nodes.length + 1;
  // 无限容量取「管段总数 + 1」：真实割容量不超过管段总数，超级源边永不被割断
  const INF = pipes.length + 1;
  // 当前通水状态下的邻接表（已关阀已排除），用于判定当前可达供水点
  const adj = buildAdjacency(network, new Set());

  const minCutFor = (outlet: string): { value: number; cut: string[] } => {
    const g: FlowEdge[][] = Array.from({ length: nNodes }, () => []);
    for (const p of pipes) {
      addUndirected(g, nodeIndex.get(p.from)!, nodeIndex.get(p.to)!);
    }
    for (const s of supplies) {
      addDirected(g, source, nodeIndex.get(s)!, INF);
    }
    const t = nodeIndex.get(outlet)!;
    const value = dinicMaxFlow(g, source, t);
    const reach = residualReachable(g, source);
    const cut = pipes
      .filter((p) => reach.has(nodeIndex.get(p.from)!) !== reach.has(nodeIndex.get(p.to)!))
      .map((p) => p.id)
      .sort();
    return { value, cut };
  };

  const items: InspectionItem[] = outlets.map((outlet) => {
    // 出口本身就是供水点时，移除任何管段都无法使其「失去供水」，无法按管段失效评估
    if (supplies.includes(outlet)) {
      return { outlet, kind: 'is-supply', minFailures: null, cutPipes: [], reachableSupplies: [outlet] };
    }
    const reachableSupplies = supplies.filter((s) => bfs(adj, s).has(outlet));
    if (reachableSupplies.length === 0) {
      // 当前已经断水：无需再失效任何管段
      return { outlet, kind: 'dry', minFailures: 0, cutPipes: [], reachableSupplies: [] };
    }
    const { value, cut } = minCutFor(outlet);
    return { outlet, kind: 'ok', minFailures: value, cutPipes: cut, reachableSupplies };
  });

  // 稳定排序：已断水(0) → 正常出口按失效数升序（并列保持输入顺序）→ 同名供水点
  items.sort((a, b) => inspectionRank(a) - inspectionRank(b));

  return {
    status: 'ok',
    activePipeCount: pipes.length,
    closedValveCount: network.valvedPipes.filter((v) => !v.open).length,
    items,
  };
}

function inspectionRank(it: InspectionItem): number {
  if (it.kind === 'dry') return 0;
  if (it.kind === 'is-supply') return Number.POSITIVE_INFINITY;
  return it.minFailures ?? Number.POSITIVE_INFINITY;
}
