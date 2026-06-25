'use strict';
// board-graph-core.js — D3.2 board 图分析核心（设计稿 §5）。
//
// 这是 cc-master 的「图算法单一真相源」：把散落在 view.html `analyze()` / board-lint-core R4 里的图算法
//   提取成一个 hook + CLI 共享的纯库。**邻接构建不在这里重写**——require board-lint-core 的 buildGraph
//   （含 deps 邻接 + parent 倒排），在其上叠拓扑/CPM/impact/parallelism。这保证「lint 的图」「分析的图」
//   「rollup 的图」只有一份（DRY，杜绝三份漂移·设计稿 §5.2）。
//
// 落点为何在 hooks/scripts/（而非 skill 目录）：hook 不能伸进 skill 树（红线5）；hooks/ 与 skills/ 都随
//   plugin 分发、依赖方向 skill→hooks 合法。核心放 hooks/ 让（未来的）hook 同目录 require、CLI 跨目录
//   （plugin 内相对路径）require 同一份。
//
// 红线1 / ADR-006：node/JS only，零 npm dep（红线1/5；且 CPM/float/并行度主流图库本就不提供，自包含手写）。
//   纯 stdlib——本文件连 fs 都不用，只吃一个 board 对象。
//
// 红线2：本库**只读 board、永不回写**。CPM/float/并行度是 ephemeral 的库/CLI 输出，绝不是 board 字段。
//
// ★诚实性纪律（设计稿 §5.6 / Q-G1）：CPM 需节点时长，board 三时间戳柔性可缺。降级链
//   measured（finished−started / now−started）→ unit（dur=1）。每个 CPM 结果带 weight_source；
//   mixed/unit 态**只报临界链结构 + 节点数，不报小时级 float**（避免比心算更误导的伪精确）。
//
// 全部函数**纯、只读、不抛**：坏输入（非数组 tasks / 缺字段 / 含环）→ 退化空结果 + 诚实 source 标注，
//   绝不抛异常（hook 消费者不能因「图坏」崩）。

// 依赖 board-lint-core 的 buildGraph/findCycle（单一真相源·不另起图·设计稿 §5.2）。
//   ★双形态加载（D3.7·UMD 桥）：CommonJS 宿主（hook / CLI / node:test）走 require；浏览器把本文件当
//   classic <script> 加载时无 require，从 globalThis.__ccmBoardLintCore 取（view-server 先 serve lint-core，
//   它的 UMD 尾把导出挂到该 global）。这让 webview 复用同一份核心、杜绝 view.html 再自带一份 analyze（DRY）。
//
// ★IIFE 包裹（D3.7 followup·浏览器共享 global 词法环境陷阱）：本文件作为 classic <script> 与
//   board-lint-core.js 加载进**同一个**浏览器 global 词法环境（global lexical environment）。
//   lint-core 已在顶层声明 buildGraph/findCycle（function·进 global object 环境）与 ISO_UTC_RE
//   （const·进 global lexical 环境）。若本文件也在顶层 `const { buildGraph, findCycle }` / `const ISO_UTC_RE`，
//   两个脚本会**重复声明**同名标识符 → 第二个脚本抛 `SyntaxError: Identifier 'buildGraph' has already
//   been declared` → analyzeGraph 永不发布、webview 的 owner rollup/折叠静默回退。把整个模块体裹进 IIFE
//   让这些声明函数作用域化，顶层零 let/const/function 泄漏，彻底绕开该语义陷阱（vm.runInNewContext 的
//   per-script 独立 context 复现不出这个共享语义——别再用那种 harness「验证」）。CommonJS require 路径
//   零行为变化：IIFE 尾照常 module.exports = { analyzeGraph }。
(function () {
'use strict';

const { buildGraph, findCycle } = (typeof require === 'function')
  ? require('./board-lint-core.js')
  : (typeof globalThis !== 'undefined' && globalThis.__ccmBoardLintCore) || {};

// 终态状态（done 家族）。rollup「子全 done」判定用——只有 'done' 算真完成（与 verify-board / lint 口径一致）。
const DONE = 'done';

// 时间锚解析：严格 ISO-8601 UTC（YYYY-MM-DDTHH:MM:SSZ）→ ms epoch，或 null（缺/不可解析）。
//   只认严格格式（与 board-lint ISO_UTC_RE 同口径），避免把旧板的 "11:50Z" 当时间锚误算。
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function parseTs(v) {
  if (typeof v !== 'string' || !ISO_UTC_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// nodeDuration(task, nowMs) → { dur, source }——单节点时长（小时为单位）+ 来源标注。
//   measured：done 有 finished−started / in_flight 有 now−started（>0）。否则 unit（dur=1·无量纲）。
function nodeDuration(task, nowMs) {
  if (task && typeof task === 'object') {
    const started = parseTs(task.started_at);
    const finished = parseTs(task.finished_at);
    if (started != null && finished != null && finished > started) {
      return { dur: (finished - started) / 3600000, source: 'measured' };
    }
    if (started != null && task.status === 'in_flight') {
      const el = nowMs - started;
      if (el > 0) return { dur: el / 3600000, source: 'measured' };
    }
  }
  return { dur: 1, source: 'unit' };
}

// ── analyzeGraph(board) → Graph 句柄 ────────────────────────────────────────────────────────────
//   一次建图 + 缓存邻接 + parent 倒排，返回带方法的句柄。坏 board（非对象 / tasks 非数组）→ 退化空图。
function analyzeGraph(board) {
  const tasks = (board && typeof board === 'object' && Array.isArray(board.tasks)) ? board.tasks : [];
  const g = buildGraph(tasks); // { ids, taskById, upstream, downstream, dangling, selfLoops, edgeIssues, children, parentOf }
  const ids = g.ids;
  const taskById = g.taskById;
  const upstream = g.upstream;
  const downstream = g.downstream;

  const statusOf = (id) => { const t = taskById.get(id); return t ? t.status : undefined; };
  const isDone = (id) => statusOf(id) === DONE;

  // ── cheap 子集（O(V+E)，hook 可 require）─────────────────────────────────────────────────────

  // topoSort() → { order, cycle }。Kahn 算法（入度归零队列）。有环 → order 为已排出的部分 + cycle 列出环。
  function topoSort() {
    const cyc = findCycle(upstream);
    const indeg = new Map();
    for (const id of ids) indeg.set(id, upstream.get(id).length);
    const queue = [];
    for (const id of ids) if (indeg.get(id) === 0) queue.push(id);
    queue.sort(); // 稳定输出（同层按 id 字典序）
    const order = [];
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      const next = [];
      for (const m of downstream.get(n)) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
      next.sort();
      for (const m of next) queue.push(m);
    }
    return { order, cycle: cyc };
  }

  function cycle() { return findCycle(upstream); }

  function predecessors(id) { return ids.has(id) ? upstream.get(id).slice() : []; }
  function successors(id) { return ids.has(id) ? downstream.get(id).slice() : []; }

  // readySet() → deps 全 done ∧ status==='ready' 的 id（严格语义·设计稿 Q-G6）。
  function readySet() {
    const out = [];
    for (const id of ids) {
      if (statusOf(id) !== 'ready') continue;
      const deps = upstream.get(id);
      if (deps.every((d) => isDone(d))) out.push(id);
    }
    return out;
  }

  // wipStats() → { in_flight, blocked, userGates, counts }。flat 计数（子节点平等计入·设计稿 §4.4）。
  function wipStats() {
    const counts = {};
    let inFlight = 0, blocked = 0, userGates = 0;
    for (const id of ids) {
      const s = statusOf(id);
      counts[s] = (counts[s] || 0) + 1;
      if (s === 'in_flight') inFlight++;
      if (s === 'blocked') blocked++;
      const t = taskById.get(id);
      if (t && t.blocked_on === 'user' && (s === 'blocked' || s === 'in_flight')) userGates++;
    }
    return { in_flight: inFlight, blocked, userGates, counts };
  }

  // ── D3 nesting cheap 子集（喂路 ii 的 hook 检查地基）──────────────────────────────────────────
  function children(ownerId) { return g.children.has(ownerId) ? g.children.get(ownerId).slice() : []; }
  function parentOf(id) { return g.parentOf.has(id) ? g.parentOf.get(id) : null; }

  // rollupConsistency() → [{ owner, nonDoneChildren }]。status==='done' 的 owner 却有非 done 子。
  //   （喂 board-lint R7d + verify-board rollup gate，一份实现两处用·设计稿 §5.3。）
  function rollupConsistency() {
    const out = [];
    for (const [owner, kids] of g.children) {
      if (statusOf(owner) !== DONE) continue;
      const bad = kids.filter((c) => !isDone(c));
      if (bad.length) out.push({ owner, nonDoneChildren: bad });
    }
    return out;
  }

  // checkDepth1() → [{ owner, grandchild }]。owner 的某个子自己又被指为 parent（违 depth=1·喂 R7b）。
  function checkDepth1() {
    const out = [];
    for (const [owner, kids] of g.children) {
      for (const c of kids) {
        if (g.children.has(c)) {
          for (const gc of g.children.get(c)) out.push({ owner, grandchild: gc });
        }
      }
    }
    return out;
  }

  // parentCycles() → id[][]。parent 边上的环（自指 A.parent=A / 2-环 A↔B·喂 R7c）。
  //   parent 单值，把 parentOf 当邻接（每点 ≤1 出边）跑 findCycle。
  function parentCycles() {
    const padj = new Map();
    for (const id of ids) padj.set(id, []);
    for (const [child, owner] of g.parentOf) {
      if (ids.has(child) && ids.has(owner)) padj.get(child).push(owner);
    }
    const cyc = findCycle(padj);
    return cyc ? [cyc] : [];
  }

  // ── rich 分析（重，CLI on-demand；坏输入退化空集，不抛）──────────────────────────────────────

  // descendants(id) → Set（传递后代 = downstream 闭包，impact 用）。带环 guard。
  function descendants(id) {
    const acc = new Set();
    if (!ids.has(id)) return acc;
    const stack = downstream.get(id).slice();
    while (stack.length) {
      const n = stack.pop();
      if (acc.has(n)) continue;
      acc.add(n);
      for (const c of downstream.get(n)) if (!acc.has(c)) stack.push(c);
    }
    acc.delete(id);
    return acc;
  }

  // ancestors(id) → Set（传递祖先 = upstream 闭包）。带环 guard。
  function ancestors(id) {
    const acc = new Set();
    if (!ids.has(id)) return acc;
    const stack = upstream.get(id).slice();
    while (stack.length) {
      const n = stack.pop();
      if (acc.has(n)) continue;
      acc.add(n);
      for (const p of upstream.get(n)) if (!acc.has(p)) stack.push(p);
    }
    acc.delete(id);
    return acc;
  }

  function reachable(a, b) {
    if (a === b) return ids.has(a);
    return descendants(a).has(b);
  }

  // longestPath() → { chain, length }。按节点数的最长依赖链（view.html 现状口径·拓扑退化态）。
  function longestPath() {
    const order = topoSort().order;
    if (order.length === 0 && ids.size > 0) return { chain: [], length: 0 }; // 全在环里
    const len = new Map();   // id -> 以 id 结尾的最长链节点数
    const prev = new Map();
    let endId = null, endLen = 0;
    for (const id of order) {
      let best = 1, bestPrev = null;
      for (const d of upstream.get(id)) {
        const c = (len.get(d) || 0) + 1;
        if (c > best) { best = c; bestPrev = d; }
      }
      len.set(id, best);
      prev.set(id, bestPrev);
      if (best > endLen) { endLen = best; endId = id; }
    }
    const chain = [];
    let cur = endId;
    while (cur != null) { chain.push(cur); cur = prev.get(cur); }
    chain.reverse();
    return { chain, length: endLen };
  }

  // criticalPath(opts) → { chain, schedule, makespan, weight_source }。CPM with ES-EF-LS-LF-float。
  //   ★诚实性（§5.6 / Q-G1）：weight_source ∈ measured|unit|mixed；mixed/unit 态 schedule 仍算（拓扑结构是
  //   真的），但 makespan 标 null 且每节点 float 不报小时数——CLI 层据 weight_source 决定显示精度（只报
  //   临界链结构 + 节点数，不报小时级 float）。有环 → 退化空 schedule + weight_source:'cycle'。
  function criticalPath(opts) {
    const nowMs = (opts && Number.isFinite(opts.now)) ? opts.now : Date.now();
    const cyc = findCycle(upstream);
    if (cyc) return { chain: [], schedule: new Map(), makespan: null, weight_source: 'cycle', cycle: cyc };

    const order = topoSort().order;
    // 每节点时长 + 来源统计
    const dur = new Map();
    let nMeasured = 0, nUnit = 0;
    for (const id of ids) {
      const { dur: d, source } = nodeDuration(taskById.get(id), nowMs);
      dur.set(id, d);
      if (source === 'measured') nMeasured++; else nUnit++;
    }
    // weight_source：全 measured → measured；有 measured 也有 unit → mixed；全 unit（含空图）→ unit。
    let weight_source = 'unit';
    if (nMeasured > 0 && nUnit === 0) weight_source = 'measured';
    else if (nMeasured > 0 && nUnit > 0) weight_source = 'mixed';

    // forward pass: ES/EF
    const es = new Map(), ef = new Map();
    for (const id of order) {
      let e = 0;
      for (const d of upstream.get(id)) e = Math.max(e, ef.get(d) || 0);
      es.set(id, e);
      ef.set(id, e + dur.get(id));
    }
    let makespan = 0;
    for (const id of ids) makespan = Math.max(makespan, ef.get(id) || 0);

    // backward pass: LS/LF
    const lf = new Map(), ls = new Map();
    const revOrder = order.slice().reverse();
    for (const id of revOrder) {
      const downs = downstream.get(id);
      let l = makespan;
      if (downs.length) { l = Infinity; for (const m of downs) l = Math.min(l, ls.get(m)); }
      lf.set(id, l);
      ls.set(id, l - dur.get(id));
    }

    // free float = min(ES of successors) − EF(self); total float = LS − ES
    const schedule = new Map();
    for (const id of ids) {
      const downs = downstream.get(id);
      let ff = makespan - (ef.get(id) || 0);
      if (downs.length) { ff = Infinity; for (const m of downs) ff = Math.min(ff, (es.get(m) || 0) - (ef.get(id) || 0)); }
      schedule.set(id, {
        es: es.get(id) || 0, ef: ef.get(id) || 0,
        ls: ls.get(id) || 0, lf: lf.get(id) || 0,
        float: (ls.get(id) || 0) - (es.get(id) || 0),
        free_float: ff,
        dur: dur.get(id),
      });
    }

    // 临界链 = 真正按时长加权的关键路径：从 EF 最大的 sink 起，反向沿「EF(pred)==ES(self)」的 binding 边
    //   走（该 pred 是把 self 卡住起跑的那条约束），直到无 pred。这给 duration-weighted 关键链（非节点数最长路）。
    const EPS = 1e-9;
    let endId = null, endEf = -Infinity;
    for (const id of ids) { const e = ef.get(id) || 0; if (e > endEf) { endEf = e; endId = id; } }
    const chain = [];
    let cur = endId;
    const guard = new Set();
    while (cur != null && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      const myEs = es.get(cur) || 0;
      let pick = null;
      for (const d of upstream.get(cur)) {
        if (Math.abs((ef.get(d) || 0) - myEs) < EPS) { pick = d; break; } // binding 前驱
      }
      cur = pick;
    }
    chain.reverse();

    return {
      chain,
      schedule,
      makespan: weight_source === 'measured' ? makespan : null, // ★mixed/unit 不报小时级 makespan（伪精确）
      weight_source,
    };
  }

  // parallelism() → { T1, Tinf, parallelism, brent }。T1=总工（节点数·unit 权）；
  //   T∞=临界链长（节点数）；parallelism=T1/T∞；brent=Brent 定理上界 T1/p + (1−1/p)·T∞ 的 p→∞ 极限 = T∞。
  //   按节点数（unit 权）算——与 decomposition.md「值得开几条道」的 T1/T∞ 词汇对齐，不掺时间锚（保稳定）。
  function parallelism() {
    const T1 = ids.size;
    const lp = longestPath();
    const Tinf = lp.length;
    const p = Tinf > 0 ? T1 / Tinf : 0;
    // Brent: 给定 P 个处理器，Tp ≤ T1/P + (1−1/P)·T∞。这里报理想（P=∞）= T∞，及 T1/T∞ 加速比。
    return { T1, Tinf, parallelism: p, brent: Tinf };
  }

  // rollupProgress(ownerId) → { done, total, ratio }（§3.2 进度条素材·advisory，不 gate）。
  function rollupProgress(ownerId) {
    const kids = g.children.has(ownerId) ? g.children.get(ownerId) : [];
    const total = kids.length;
    const done = kids.filter((c) => isDone(c)).length;
    return { done, total, ratio: total > 0 ? done / total : 0 };
  }

  return {
    // raw 句柄（CLI / 调试用）
    ids, taskById, upstream, downstream,
    // cheap
    topoSort, cycle, predecessors, successors, readySet, wipStats,
    children, parentOf, rollupConsistency, checkDepth1, parentCycles,
    // rich
    descendants, ancestors, reachable, criticalPath, longestPath, parallelism, rollupProgress,
  };
}

// ── UMD 双形态导出（D3.7·浏览器桥）─────────────────────────────────────────────────────────────
//   CommonJS（hook / CLI / node:test）：照常 module.exports，零行为变化。
//   浏览器（view.html 把本文件当 classic <script> 加载）：无 module，挂到 globalThis 让 ESM 模块读取。
//   这是 view.html 收敛掉自带 analyze、复用同一份图核心的接合点（设计稿 §5.8 webview 收敛）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { analyzeGraph };
} else if (typeof globalThis !== 'undefined') {
  globalThis.__ccmBoardGraphCore = { analyzeGraph };
}

})(); // ★IIFE 收口（见文件头 IIFE 包裹说明）——所有声明函数作用域化、顶层零泄漏，避免与 board-lint-core
      //   的 classic-script 共享 global 词法环境撞名（SyntaxError redeclare）。
