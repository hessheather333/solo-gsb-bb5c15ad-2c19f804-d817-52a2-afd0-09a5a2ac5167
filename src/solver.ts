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

/** 一条参与韧性评估的管段（无阀管段或当前开启的带阀管段）。 */
export interface ActiveEdge {
  id: string;
  from: string;
  to: string;
}

/** 可按管段失效评估的出口。 */
export interface ResilienceRow {
  outlet: string;
  assessable: true;
  /** 使其失去全部供水至少需失效的不同管段数；当前已断水时为 0 */
  minFailures: number;
  /** 当前是否已断水（在当前阀门开闭状态下无任何供水点可达） */
  alreadyCut: boolean;
  /** 一组达到 minFailures 的管段编号（升序）；已断水时为空清单 */
  witnessPipes: string[];
}

/** 出口与供水点同名，无法按管段失效评估。 */
export interface ResilienceUnassessableRow {
  outlet: string;
  assessable: false;
  reason: string;
}

export type ResilienceResultRow = ResilienceRow | ResilienceUnassessableRow;

export interface ResilienceOk {
  status: 'ok';
  /** 参与评估的管段总数（无阀管段 + 当前开启的带阀管段；自环不计） */
  activePipeCount: number;
  /** 按所需失效数升序（无法评估的排在最后） */
  rows: ResilienceResultRow[];
}

export interface ResilienceInvalid {
  status: 'invalid';
  errors: string[];
}

export type ResilienceResult = ResilienceOk | ResilienceInvalid;

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

function uniquePreservingOrder(values: string[]): string[] {
  return [...new Set(values)];
}

/** 参与韧性评估的管段：无阀管段与当前开启的带阀管段均按单条计；自环对连通无意义，忽略。 */
function collectActiveEdges(network: Network): ActiveEdge[] {
  const edges: ActiveEdge[] = [];
  for (const p of network.pipes) {
    if (p.from !== p.to) edges.push({ id: p.id, from: p.from, to: p.to });
  }
  for (const vp of network.valvedPipes) {
    if (vp.open && vp.from !== vp.to) edges.push({ id: vp.id, from: vp.from, to: vp.to });
  }
  return edges;
}

/** 仅依据当前阀门开闭状态，从全部供水点出发做连通性遍历。 */
function reachableFromSupplies(
  edges: ActiveEdge[],
  indexOf: Map<string, number>,
  supplyIdx: Set<number>
): boolean[] {
  const n = indexOf.size;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const u = indexOf.get(e.from)!;
    const v = indexOf.get(e.to)!;
    adj[u].push(v);
    adj[v].push(u);
  }
  const seen = new Array<boolean>(n).fill(false);
  const queue: number[] = [];
  for (const s of supplyIdx) {
    if (!seen[s]) {
      seen[s] = true;
      queue.push(s);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj[cur]) {
      if (!seen[next]) {
        seen[next] = true;
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Dinic 最大流：节点编号为 0..n-1，另有一个超级源点 n。 */
class Dinic {
  private readonly head: number[];
  private readonly next: number[] = [];
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly level: number[];
  private readonly it: number[];

  constructor(private readonly n: number) {
    this.head = new Array(n + 1).fill(-1);
    this.level = new Array(n + 1).fill(-1);
    this.it = new Array(n + 1).fill(0);
  }

  get source(): number {
    return this.n;
  }

  /** 增加一条容量为 cap 的有向弧（自动附带零容量反向弧）。 */
  addArc(u: number, v: number, cap: number): void {
    this.next.push(this.head[u]);
    this.to.push(v);
    this.cap.push(cap);
    this.head[u] = this.next.length - 1;

    this.next.push(this.head[v]);
    this.to.push(u);
    this.cap.push(0);
    this.head[v] = this.next.length - 1;
  }

  /** 无向单位容量边：两个方向各一条容量 1 的弧。 */
  addUndirectedUnit(u: number, v: number): void {
    this.addArc(u, v, 1);
    this.addArc(v, u, 1);
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
    this.level[s] = 0;
    const queue = [s];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (let a = this.head[u]; a !== -1; a = this.next[a]) {
        if (this.cap[a] > 0 && this.level[this.to[a]] === -1) {
          this.level[this.to[a]] = this.level[u] + 1;
          queue.push(this.to[a]);
        }
      }
    }
    return this.level[t] !== -1;
  }

  private dfs(u: number, t: number, pushed: number): number {
    if (u === t || pushed === 0) return pushed;
    while (this.it[u] !== -1) {
      const a = this.it[u];
      const v = this.to[a];
      if (this.cap[a] > 0 && this.level[v] === this.level[u] + 1) {
        const flow = this.dfs(v, t, Math.min(pushed, this.cap[a]));
        if (flow > 0) {
          this.cap[a] -= flow;
          this.cap[a ^ 1] += flow;
          return flow;
        }
      }
      // 该弧无法再增广，推进当前弧指针
      this.it[u] = this.next[a];
    }
    return 0;
  }

  maxFlow(s: number, t: number): number {
    let flow = 0;
    while (this.bfs(s, t)) {
      for (let i = 0; i < this.it.length; i++) this.it[i] = this.head[i];
      while (true) {
        const pushed = this.dfs(s, t, Infinity);
        if (pushed === 0) break;
        flow += pushed;
      }
    }
    return flow;
  }

  /**
   * 最大流后在残量网络上可到达汇点 t 的节点集合（沿残量弧反向 BFS）。
   * 该集合是「最靠近出口」的最小割：在所有等优割中隔离范围最小、
   * 不会为了切掉一个出口而把整个供水侧都划入割集，便于据此安排巡检。
   */
  sinkSideCut(t: number): boolean[] {
    const inSinkSide = new Array(this.n + 1).fill(false);
    inSinkSide[t] = true;
    const queue = [t];
    while (queue.length > 0) {
      const v = queue.shift()!;
      for (let a = this.head[v]; a !== -1; a = this.next[a]) {
        const u = this.to[a]; // a 为 v→u，其配对弧 a^1 为 u→v
        // u→v 仍有残量，则 u 可经 v 到达汇点
        if (this.cap[a ^ 1] > 0 && !inSinkSide[u]) {
          inSinkSide[u] = true;
          queue.push(u);
        }
      }
    }
    return inSinkSide;
  }
}

/**
 * 保供韧性巡检：对每个保供出口，计算在当前阀门开闭状态下，使其失去全部供水
 * （与所有供水点同时断开）至少需要失效多少条不同管段，并给出一组达到该数量的
 * 管段编号。无阀管段与开启的带阀管段均按单条失效计；已关阀门不参与。
 * 多个供水点作为整体（超级源点以无穷大容量接入），环路与并行管段分别计数。
 * 结果即无向多重图（单位边容）上「供水点集合 → 出口」的最小边割，由最大流求得。
 */
export function inspectResilience(network: Network, query: Query): ResilienceResult {
  const errors: string[] = [];
  const nodeSet = new Set(network.nodes);
  if (query.supplies.length === 0) errors.push('至少需要指定一个供水点。');
  for (const s of query.supplies) {
    if (!nodeSet.has(s)) errors.push(`供水点「${s}」不在节点列表中。`);
  }
  for (const o of query.outlets) {
    if (!nodeSet.has(o)) errors.push(`保供出口「${o}」不在节点列表中。`);
  }
  if (errors.length > 0) return { status: 'invalid', errors };

  const supplies = uniquePreservingOrder(query.supplies);
  const outlets = uniquePreservingOrder(query.outlets);
  const supplySet = new Set(supplies);

  const edges = collectActiveEdges(network);
  const indexOf = new Map<string, number>();
  network.nodes.forEach((node, i) => indexOf.set(node, i));
  const supplyIdx = new Set(supplies.map((s) => indexOf.get(s)!));
  const reachable = reachableFromSupplies(edges, indexOf, supplyIdx);
  // 超级源点接入管容超过任意真实边割，保证不会成为瓶颈
  const infiniteCap = edges.length + 1;

  const rows: ResilienceResultRow[] = outlets.map((outlet) => {
    if (supplySet.has(outlet)) {
      return {
        outlet,
        assessable: false,
        reason: '出口与供水点同名，无法按管段失效评估。',
      };
    }
    const t = indexOf.get(outlet)!;
    if (!reachable[t]) {
      // 当前阀门开闭状态下已无任何供水点可达：无需失效任何管段
      return { outlet, assessable: true, minFailures: 0, alreadyCut: true, witnessPipes: [] };
    }

    const dinic = new Dinic(network.nodes.length);
    for (const s of supplyIdx) dinic.addArc(dinic.source, s, infiniteCap);
    for (const e of edges) {
      dinic.addUndirectedUnit(indexOf.get(e.from)!, indexOf.get(e.to)!);
    }
    const minFailures = dinic.maxFlow(dinic.source, t);
    const inSinkSide = dinic.sinkSideCut(t);

    // 跨越割线、与出口同侧的边界管段，即一组达到最小失效数的管段（最贴近出口的割）
    const witnessPipes: string[] = [];
    for (const e of edges) {
      const u = indexOf.get(e.from)!;
      const v = indexOf.get(e.to)!;
      if (inSinkSide[u] !== inSinkSide[v]) witnessPipes.push(e.id);
    }
    witnessPipes.sort();
    return { outlet, assessable: true, minFailures, alreadyCut: false, witnessPipes };
  });

  rows.sort((a, b) => {
    if (a.assessable !== b.assessable) return a.assessable ? -1 : 1;
    if (a.assessable && b.assessable && a.minFailures !== b.minFailures) {
      return a.minFailures - b.minFailures;
    }
    return a.outlet.localeCompare(b.outlet, 'zh-Hans-CN');
  });

  return { status: 'ok', activePipeCount: edges.length, rows };
}
