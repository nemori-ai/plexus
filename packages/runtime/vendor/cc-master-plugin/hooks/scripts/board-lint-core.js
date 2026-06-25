'use strict';
// board-lint-core.js — T9 共享 lint 核心（单一真相源）。
//
// 这是 board lint 的纯逻辑：`lintBoard(text) → { errors, warnings }`。被两个薄包装消费——
//   ① PostToolUse hook（hooks/scripts/board-lint.js，同目录 require './board-lint-core.js'）；
//   ② 手动脚本（skills/orchestrating-to-completion/scripts/board-lint.js，经稳定的 plugin 内相对路径
//      require 同一份文件）。两个消费者复用同一段规则，杜绝两份漂移（DRY）。
//
// 落点为何在 hooks/scripts/（而非 skill 目录）：hook 不能伸手进 skill 树（红线5：hook 自洽、不依赖
//   skill 目录存在）；hooks/ 与 skills/ 都是随 plugin 分发的约定目录，依赖方向 skill→hooks 合法（两者
//   都一起 ship），故核心放 hooks/ 让 hook 同目录 require、手动脚本跨目录（plugin 内）require 同一份。
//
// 红线1 / ADR-006：node/JS only。JSON.parse 解析 board + 结构遍历 + deps 图拓扑校验，零 spawn jq/python，
//   零网络，零依赖（纯 stdlib 思路，本文件连 fs 都不用——只吃一段 text）。这正是 ADR-006 §3.0 点名的
//   「deps-graph integrity 用 node」用例（bash awk 串解析做无环检测不可行——Finding #5 家族）。
//
// 红线2（最关键）：lint 只校验**钉死的硬窄腰 + 合法 JSON + deps 图完整性 + viewer 真会挂的字段**，
//   对一切 agent-shaped 自定义字段**silent-on-unknown**（白名单校验 known 字段形状，未知字段一律放行、
//   零 warn）。绝不要求任何柔性边存在，绝不评判内容「合理性」——只校验 type/格式/enum/图完整性。
//   任何「agent 这么写不优雅但能跑」的规则都不进 lint，否则 lint 自己就成了「第二层窄腰」。
//
// 规则分级（设计稿 §2）：hard fail = 会确凿坏掉某条链路（hook / viewer / resume）的结构/语法错；
//   warn = 可疑但 graceful-degrade、不立即坏链路。

// status enum（窄腰一员，board.md §Status enum）。
const STATUS_ENUM = new Set([
  'ready', 'in_flight', 'blocked', 'done', 'escalated', 'failed', 'stale', 'uncertain',
]);

// 严格 ISO-8601 UTC 定宽：YYYY-MM-DDTHH:MM:SSZ（board.md 时间锚格式纪律）。
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// lintBoard(text) — text 是 board 文件的原始字符串。返回 { errors, warnings }，各为
//   [{ rule, message, task? }]。绝不抛（R1 把 JSON.parse 失败收成一条 error）。
function lintBoard(text) {
  const errors = [];
  const warnings = [];
  const err = (rule, message, task) => errors.push(task ? { rule, message, task } : { rule, message });
  const warn = (rule, message, task) => warnings.push(task ? { rule, message, task } : { rule, message });

  // ── R1：合法 JSON ──────────────────────────────────────────────────────────────────────────────
  // 坏什么：viewer 永久冻结（view-server 404 → 客户端静默停在旧帧）；resume 选板读出垃圾；hook 扫描错位。
  let board;
  try {
    board = JSON.parse(text);
  } catch (e) {
    const why = (e && e.message) ? e.message : String(e);
    err('R1',
      `不合法 JSON — board 无法被解析，会导致 webview 永久冻结（404 后停在旧帧）、resume 选板读出垃圾。\n` +
      `  解析器原话（仅供定位）：${why}\n` +
      `  怎么修：检查逗号与括号配对（尤其 sed/echo 截断了含 } 或 " 的字段值）；用 Write 整块重写 board（整写比 sed 改更不易写坏）。`);
    return { errors, warnings }; // JSON 都不合法 → 后续规则无从校验，提前返回
  }

  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    err('R1', `board 顶层不是一个 JSON 对象（解析出 ${Array.isArray(board) ? '数组' : typeof board}）。怎么修：board 必须是 {…} 对象。`);
    return { errors, warnings };
  }

  // ── R2：pinned 窄腰存在且类型对（board.md §narrow-waist + ADR-003）──────────────────────────────
  // R2a schema === "cc-master/v1"
  if (typeof board.schema !== 'string' || board.schema !== 'cc-master/v1') {
    err('R2a',
      `schema 必须是字符串字面量 "cc-master/v1"（当前：${JSON.stringify(board.schema)}）。` +
      `坏什么：它是窄腰版本协议锚点，content 契约断言它；缺/改 = 窄腰破、未来 schema 路由会错认板。`);
  }
  // R2b goal 是 string
  if (typeof board.goal !== 'string') {
    err('R2b',
      `goal 必须是字符串（当前：${JSON.stringify(board.goal)}）。` +
      `坏什么：resume selector 按 goal 子串匹配认板、viewer 顶栏渲染它；缺 = resume 认领退化、顶栏空。`);
  }
  // R2c owner 是对象、owner.active 是 boolean
  const owner = board.owner;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    err('R2c', `owner 必须是对象（当前：${JSON.stringify(owner)}）。坏什么：武装闸读 owner.active/session_id；缺 = 本 session 武装判定崩。`);
  } else {
    if (typeof owner.active !== 'boolean') {
      err('R2c',
        `owner.active 必须是 boolean（当前：${JSON.stringify(owner.active)}）。` +
        `坏什么：武装闸（全 hook 的 isArmed）读它；非 bool = orchestrator 不再被 reinject / Stop 不再 gate / pacing 失声。`);
    }
    // R2d owner.session_id 是字符串（空串合法 —— fresh bootstrap 在缺 sid stdin 上建的待认领板）。
    if (typeof owner.session_id !== 'string') {
      err('R2d',
        `owner.session_id 必须是字符串（空串 "" 合法、表示待显式 re-arm 认领；当前：${JSON.stringify(owner.session_id)}）。` +
        `坏什么：武装闸 session-scope 匹配读它（ADR-007）。`);
    }
  }
  // R2e git 是对象（worktree/branch 字符串、可空）
  const git = board.git;
  if (!git || typeof git !== 'object' || Array.isArray(git)) {
    err('R2e', `git 必须是对象（含 worktree/branch 字符串，可空；当前：${JSON.stringify(git)}）。坏什么：窄腰一员（ADR-003），viewer 渲染 git.branch。`);
  } else {
    if (git.worktree !== undefined && typeof git.worktree !== 'string') {
      err('R2e', `git.worktree 若存在必须是字符串（当前：${JSON.stringify(git.worktree)}）。`);
    }
    if (git.branch !== undefined && typeof git.branch !== 'string') {
      err('R2e', `git.branch 若存在必须是字符串（当前：${JSON.stringify(git.branch)}）。`);
    }
  }
  // R2f tasks 是数组
  const tasks = board.tasks;
  if (!Array.isArray(tasks)) {
    err('R2f',
      `tasks 必须是数组（当前：${Array.isArray(tasks) ? 'array' : typeof tasks}）。` +
      `坏什么：goal-hook 数状态、viewer 整个 DAG、resume 重建模型全靠它；非数组 = viewer 空图（静默）、hook 扫描错位。`);
    // tasks 非数组 → R3/R4 无从遍历，但 R2a-e 已校验完，可返回。
    return { errors, warnings };
  }

  // ── R3：每个 task 的 {id, status, deps} 契约（board.md §narrow-waist tasks）──────────────────────
  const ids = new Set();
  const dupIds = new Set();
  const taskById = new Map(); // id -> task（供 R4 用）
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const where = `tasks[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      err('R3a', `${where} 必须是对象（当前：${JSON.stringify(t)}）。坏什么：viewer 按 t.id 建节点、goal-hook 按 status 路由。`);
      continue;
    }
    const idLabel = (typeof t.id === 'string' && t.id) ? t.id : where;
    // R3a id 是非空字符串
    if (typeof t.id !== 'string' || t.id === '') {
      err('R3a',
        `${where}.id 必须是非空字符串（当前：${JSON.stringify(t.id)}）。` +
        `坏什么：viewer 用 id 建节点 key、goal-hook 按 id 计数；缺 id = 节点 key 撞/丢、hook 漏数。`, idLabel);
    } else {
      // R3b id 全局唯一
      if (ids.has(t.id)) { dupIds.add(t.id); }
      ids.add(t.id);
      taskById.set(t.id, t);
    }
    // R3c status 存在且 ∈ enum
    if (typeof t.status !== 'string' || !STATUS_ENUM.has(t.status)) {
      err('R3c',
        `${idLabel}.status 是 ${JSON.stringify(t.status)}，不在合法集合内。` +
        `坏什么：goal-hook 无法路由它（可能在还有活时放行 Stop），webview 把它画成 unknown 灯。\n` +
        `  怎么修：改成合法值之一：ready / in_flight / blocked / done / escalated / failed / stale / uncertain。`, idLabel);
    }
    // R3d deps 是 required 硬窄腰字段（board.md §narrow-waist 的 {id,status,deps} 三件套，line 208；
    //   line 210 的「可省略柔性边」明确不含 deps）。缺失（undefined）即 hard error——与 R3a(id)/R3c(status)
    //   对齐；存在则必须是数组、元素为字符串。
    if (t.deps === undefined) {
      err('R3d',
        `${idLabel}.deps 缺失。deps 是钉死的窄腰字段（与 id/status 同级，board.md §narrow-waist），不是可省略的柔性边。` +
        `坏什么：缺 deps = 畸形窄腰；下游图校验把它当无上游，让「手编 tasks[] 忘写 deps」这个真实错误静默溜过。\n` +
        `  怎么修：补上 deps——无上游写 "deps": []，有上游写 "deps": ["<上游 task id>", …]。`, idLabel);
    } else if (!Array.isArray(t.deps)) {
      err('R3d',
        `${idLabel}.deps 必须是字符串数组（当前：${typeof t.deps}）。` +
        `坏什么：viewer 兜底丢掉该任务的全部依赖边（静默错图）。\n` +
        `  怎么修：无上游写 "deps": []，有上游写 "deps": ["<上游 task id>", …]。`, idLabel);
    } else {
      for (const d of t.deps) {
        if (typeof d !== 'string') {
          err('R3d', `${idLabel}.deps 含非字符串元素（${JSON.stringify(d)}）；dep 必须是上游 task 的 id 字符串。`, idLabel);
        }
      }
    }
  }
  for (const dup of dupIds) {
    err('R3b',
      `task id "${dup}" 出现多次，必须全局唯一。` +
      `坏什么：viewer 后写者覆盖前者（静默丢节点）；deps 指向它时歧义。`, dup);
  }

  // ── R4：deps 图完整性（设计稿 §2.2；本 lint 相对 hook 现状的最大增量）──────────────────────────
  // 只对「id 合法、deps 是字符串数组」的 task 参与图校验（坏 task 已在 R3 报过，避免重复噪声）。
  //
  // 图构建本身（邻接表 + 悬挂/自环识别 + parent 倒排）已抽到纯函数 buildGraph（D3.2 接缝，喂 board-graph-core）。
  //   lintBoard 调它拿结构，再把 buildGraph 已识别出的 dangling/selfLoops 转成 R4a/R4b 报告——
  //   报告行为**字节级不变**（纯重构：同一组 dangling/selfLoops、同一 findCycle 环、同样的措辞）。
  //   ★D3：buildGraph 算 parentOf/children 供库导出 + R7 nesting 校验（D3.3 / PR-2 已落地·见下方 R7 段）。
  //   parent 现是硬 waist 字段（ADR-012），R7 用 buildGraph 的 parent 倒排做 nesting 不变式校验。
  const validIds = ids; // 已存在的 id 集合
  const g = buildGraph(tasks);
  // R4a/R4b：buildGraph 已识别 dangling/selfLoops 并记录其在 task→dep 顺序里的相对位置（edgeIssues），
  //   这里按那个统一顺序逐条转报告——与抽取前「逐 task、task 内逐 dep、R4a/R4b 交错」的报告顺序字节级一致。
  for (const issue of g.edgeIssues) {
    if (issue.kind === 'dangling') {
      err('R4a',
        `${issue.id}.deps 含 "${issue.dep}"，但没有任何 task 的 id 是 "${issue.dep}"。` +
        `坏什么：webview 静默丢这条依赖边，且 ${issue.id} 永远不会因上游完成而解锁。\n` +
        `  怎么修：把 "${issue.dep}" 改成真实存在的上游 id，或从 ${issue.id}.deps 删掉它。现有 id：${[...validIds].join(', ')}。`, issue.id);
    } else { // 'selfLoop'
      err('R4b',
        `${issue.id}.deps 含它自己（自环）。坏什么：${issue.id} 依赖自己 → 永远 blocked、永不 ready。怎么修：从 ${issue.id}.deps 删掉 "${issue.id}"。`, issue.id);
    }
  }
  // R4c 无环（DFS 着色找有向环）。
  const cycle = findCycle(g.upstream);
  if (cycle) {
    err('R4c',
      `deps 图存在环：${cycle.join(' → ')} → ${cycle[0]}。` +
      `坏什么：环上的任务互相等待 → 永远 ready 不了 → 编排死锁；viewer 拓扑/临界路径算法在环上行为未定义。\n` +
      `  怎么修：打破环——删掉环上某条 deps 边，让依赖关系回到无环的 DAG。`);
  }

  // ── R7：nesting 不变式（D3 PR-2 / D3.3 · 路 ii 的 lint 侧）──────────────────────────────────────
  // `parent` 是 D3 升入硬窄腰的新 hook-dependent 字段（ADR-012）：单值 string，指向一个存在的 owner id，
  //   且该 owner 自己不能再有 parent（depth=1 type 不变式·设计稿 §1.3/§2.1）。R7 用 buildGraph 已产出的
  //   parentOf（child→owner）/ children（owner→[child...]）实现——**不 require board-graph-core**（那会造成
  //   循环依赖：board-graph-core require 本文件的 buildGraph，反向不行）。R7 的检查全是 flat 集合运算，便宜。
  //
  //   ★口径与 board-graph-core.js 的 rollupConsistency()/checkDepth1()/parentCycles() 完全一致（同一语义两处
  //     实现）：DONE 只认 'done'；depth1 违例 = owner 的子自己又被指为 parent（g.children.has(child)）；parent 环
  //     = 把 parentOf 当邻接（每点 ≤1 出边）跑 findCycle。一份口径，lint 侧与库侧字节对齐。
  //
  //   silent-on-unknown 不破：旧板无 `parent` = 缺省 = 合法顶层节点（parentOf 为空 → R7 全不报）；
  //     `parent` 现进 known 字段白名单（buildGraph 只收非空字符串 parent 边）。R7e 守类型边界：parent 键
  //     存在但值非「非空 string」（数组 / 数字 / 空串）→ hard error（否则 buildGraph 静默丢弃、套娃保护失效）。
  const { parentOf, children } = g;

  // R7e parent 类型（hard error，口径对齐 R3d「deps 必须是字符串数组否则 hard error」）。
  //   parent 现是硬 waist 字段（ADR-012·单值 string 或缺省）。buildGraph 只收非空字符串 parent 边——
  //   非字符串（数组 parent:["M1"] / 数字 parent:123）或空串会被它**静默丢弃**、parentOf 不含该 child，
  //   于是 R7 全家把它当顶层节点处理（零报错 + rollup 检查失效）。一个 typo 就悄悄关掉套娃/rollup 保护，
  //   故畸形 parent 必须硬报错。**缺省（无 parent 键）仍合法**（顶层节点·silent-on-unknown 不破）。
  //   ★这一趟扫原始 tasks（不是 buildGraph 的 parentOf——畸形值已被它丢掉），只对「id 合法、有 parent 键」者校验。
  for (const t of tasks) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    if (typeof t.id !== 'string' || t.id === '' || taskById.get(t.id) !== t) continue;
    if (!Object.prototype.hasOwnProperty.call(t, 'parent')) continue; // 缺省合法（顶层节点）
    if (typeof t.parent !== 'string' || t.parent === '') {
      err('R7e',
        `${t.id}.parent 必须是非空字符串（指向一个存在的 owner id；当前：${JSON.stringify(t.parent)}）。` +
        `parent 是钉死的窄腰容器边（ADR-012·单值 string 或缺省），非字符串（数组 / 数字 / 空串）会被图构建静默丢弃，` +
        `让 R7 把它误当顶层节点、悄悄关掉套娃 depth=1 与 rollup 一致性保护（一个 typo 就关掉新保护）。\n` +
        `  怎么修：把 parent 改成单个 owner task 的 id 字符串（如 "M1"），或删掉 parent 键让它成顶层节点。`, t.id);
    }
  }

  // R7a parent 引用存在（hard error，类比 R4a dangling dep——parent 现在是硬 waist 字段）。
  for (const [child, ownerId] of parentOf) {
    if (!validIds.has(ownerId)) {
      err('R7a',
        `${child}.parent 是 "${ownerId}"，但没有任何 task 的 id 是 "${ownerId}"。` +
        `坏什么：parent 是钉死的窄腰容器边（ADR-012），悬挂 parent = rollup gate 找不到 owner、webview 分组渲染丢边。\n` +
        `  怎么修：把 "${ownerId}" 改成真实存在的 owner id，或从 ${child} 删掉 parent。现有 id：${[...validIds].join(', ')}。`, child);
    }
  }

  // R7b depth=1（hard error）：有 parent 的节点，其 parent 指向的节点本身不能再有 parent（owner 只含 leaf）。
  //   口径同 board-graph-core.checkDepth1()——owner 的某个子自己又被指为某节点的 parent（即 children.has(child)）。
  for (const [owner, kids] of children) {
    for (const c of kids) {
      if (children.has(c)) {
        err('R7b',
          `${c} 既是 ${owner} 的子（有 parent="${owner}"），自己又是某些节点的 parent——违反 depth=1（owner 只能含 leaf 子，子不能再下钻）。` +
          `坏什么：破 depth=1 type 不变式，rollup 与 webview 分组的「一层」假设崩。\n` +
          `  怎么修：把 ${c} 的孙子节点（${children.get(c).join(', ')}）改挂到顶层 owner，或把 ${c} 升为顶层 owner（删它的 parent）。`, c);
      }
    }
  }

  // R7c parent 无环（hard error）：parent 链不成环（自指 A.parent=A / 2-环 A↔B）。
  //   R7a∧R7b 成立时天然无环（owner 无 parent、子单跳指 owner），但显式第二趟兜底（口径同 parentCycles()——
  //   把 parentOf 当邻接、每点 ≤1 出边跑 findCycle）。便宜，且若未来放松 depth=1 就需要它。
  const padj = new Map();
  for (const id of validIds) padj.set(id, []);
  for (const [child, ownerId] of parentOf) {
    if (validIds.has(child) && validIds.has(ownerId)) padj.get(child).push(ownerId);
  }
  const pCycle = findCycle(padj);
  if (pCycle) {
    err('R7c',
      `parent 链存在环：${pCycle.join(' → ')} → ${pCycle[0]}（含自指或 2-环）。` +
      `坏什么：parent 成环 = 容器归属无穷回指，rollup 永远算不出顶层 owner、depth=1 也被违反。\n` +
      `  怎么修：打破环——让 parent 链回到「子单跳指向一个无 parent 的顶层 owner」。`);
  }

  // R7d rollup 一致性（warn，非 hard fail）：status=done 的 owner 不应有非 done 子。
  //   口径同 board-graph-core.rollupConsistency()——done owner 的 children 里有非 done 的。warn 而非 hard：
  //   容「父整合中、子刚标完」的瞬态（设计稿 §3.1 / Q-N1/Q-N3 已定 warn），硬拦会误伤。
  for (const [owner, kids] of children) {
    const ownerTask = taskById.get(owner);
    if (!ownerTask || ownerTask.status !== 'done') continue;
    const bad = kids.filter((c) => {
      const ct = taskById.get(c);
      return !ct || ct.status !== 'done';
    });
    if (bad.length) {
      warn('R7d',
        `${owner} 标 done，但它的子 ${bad.join(', ')} 还非 done——rollup 不一致（父不应在子未全 done 时算真 done）。` +
        `影响：不致命（可能是父整合中、子刚标完的瞬态），但若非瞬态 = 父被错标 done 而子在飞，子图静默漏掉。\n` +
        `  建议：确认子全 done + 父端点验收过再标父 done（Finding #12）。`, owner);
    }
  }

  // ── R5：viewer 必需字段（多为 warn —— graceful-degrade，不立即坏链路；设计稿 §2.3）──────────────
  for (const [id, t] of taskById) {
    // R5b blocked_on 若存在，值为 "user" 或某个存在的 task id。
    if (t.blocked_on !== undefined && t.blocked_on !== 'user') {
      if (typeof t.blocked_on !== 'string' || !validIds.has(t.blocked_on)) {
        warn('R5b',
          `${id}.blocked_on 是 ${JSON.stringify(t.blocked_on)}，但它既不是 "user"、也不是某个存在的 task id。` +
          `影响：不致命（webview 显示裸字符串），但这条阻塞关系画不出来。建议指向真实 id 或 "user"。`, id);
      }
    }
    // R5a 时间锚若存在则格式可解析（夹在 R6a 一起处理见下；这里只对 dispatched_at 兜底旧名）。
    // R5c wip_limit 是 top-level，不在 per-task 循环里——见下方 top-level warn。
  }

  // ── R6：三时间戳 + meta.template_version 的形状校验位（全 warn —— agent-shaped 柔性边）──────────
  for (const [id, t] of taskById) {
    for (const field of ['created_at', 'started_at', 'finished_at']) {
      const v = t[field];
      if (v !== undefined && v !== null && !ISO_UTC_RE.test(typeof v === 'string' ? v : '')) {
        // R6a：时间戳存在但非严格 ISO-8601 UTC。
        warn('R6a',
          `${id}.${field} 是 ${JSON.stringify(v)}，非严格 ISO-8601 UTC（YYYY-MM-DDTHH:MM:SSZ）。` +
          `影响：跨天 orchestration 的 timeline 时长会算错；建议用完整 UTC 时间戳。`, id);
      }
    }
    // R6c finished_at 存在则 started_at 也应存在（先起跑才能完成）——纯语义提示。
    if (t.finished_at !== undefined && t.started_at === undefined) {
      warn('R6c',
        `${id} 有 finished_at 却无 started_at（语义：先起跑才能完成）。影响：不坏链路，但暗示盖戳逻辑有漏。`, id);
    }
  }
  // R5c top-level wip_limit 若存在为数字（soft-observed，board.md）。
  if (board.wip_limit !== undefined && typeof board.wip_limit !== 'number') {
    warn('R5c',
      `wip_limit 是 ${JSON.stringify(board.wip_limit)}，非数字。` +
      `影响：posttool-batch 的 C5 过调度软警告会静默关闭（graceful，不致命）；建议用数字或省略。`);
  }
  // R6b top-level meta.template_version 若存在为整数（agent-shaped，timeline 版本门）。
  if (board.meta && typeof board.meta === 'object' && board.meta.template_version !== undefined) {
    const tv = board.meta.template_version;
    if (!Number.isInteger(tv)) {
      warn('R6b',
        `meta.template_version 是 ${JSON.stringify(tv)}，非整数。` +
        `影响：timeline 版本门读它（非整数 → 当旧板走拓扑轴，降级不挂）；建议用整数或省略。`);
    }
  }

  // ── R8：awaiting-user 完整性（decision_package 采访闭环的最小机制保障）─────────────────────────────
  // 背景：`decision_package` 是挂在 awaiting-user 节点上的「采访包」（agent-shaped 柔性边、行为 hook 一概不读）。
  //   一个 awaiting-user 节点的**存在意义**就是「一个备好料的用户决策点」——没包 = 节点没兑现这个意义 = 新 session
  //   跑 /cc-master:discuss 时开不起来讨论（discuss 据 board.md 协议「节点上没 decision_package → 停手」），采访闭环
  //   （一个 session 备料、另一个讨论）整条塌掉。活体证据：awaiting-user 节点不带 / 带不全 decision_package，旧 lint
  //   报 0 error 放行（C1「board 完整性零机制保障」典型）。R8 补这道闸。
  //
  // isAwaitingUser 口径（与 webview / discuss 两端对齐，board.md §decision_package「生命周期闸」+ discuss.md step 5）：
  //   `blocked_on === "user"` 且 `status ∈ {blocked, in_flight}`——只这种节点才被 webview 渲成富决策卡 + 复制按钮、
  //   才会被 discuss 当「仍在等用户拍板」。闸更窄会「邀请又拒绝」，更宽会误伤普通阻塞 / done 节点（守 silent-on-unknown）。
  //
  // 红线 2 不破（写进 board.md §decision_package「lint 强制」）：① 行为型 hook（reinject / verify-board /
  //   posttool-batch / usage-pacing）仍**不读** decision_package，编排行为不依赖它；② board-lint 是**校验器**不是行为
  //   hook，且它本就对 agent-shaped 字段合法性 hard-error（R5b blocked_on 是先例）；③ PostToolUse 的 board-lint hook
  //   **绝不 decision:block**（只软提示），故 R8a hard error 不卡编排者写盘，只在 CLI / run-tests 端点闸真红。
  //   decision_package **仍是 agent-shaped、不进 narrow waist**——R8 只校验「awaiting-user 节点这一既有契约位上的
  //   柔性边」的存在 + 形状，不要求任何别的柔性边存在（守 silent-on-unknown：只查这一条，不顺手给别的柔性边加校验）。
  const ASK_TYPE_ENUM = new Set(['decision', 'advice', 'solution']);
  const INPUTS_HASH_RE = /^sha256:[0-9a-f]+$/;
  for (const [id, t] of taskById) {
    // isAwaitingUser 口径：blocked_on==="user" 且 status ∈ {blocked, in_flight}。
    const isAwaitingUser = t.blocked_on === 'user' && (t.status === 'blocked' || t.status === 'in_flight');
    if (!isAwaitingUser) continue; // 非 awaiting-user 节点一概不查（blocked_on 非 user / 普通 done … → 不触发 R8）

    const dp = t.decision_package;
    // R8a HARD ERROR：awaiting-user 节点必须有一个 decision_package 对象。
    if (!dp || typeof dp !== 'object' || Array.isArray(dp)) {
      err('R8a',
        `${id} 是 awaiting-user 节点（blocked_on:"user" + status=${JSON.stringify(t.status)}），但缺少 decision_package 对象` +
        `（当前：${JSON.stringify(dp)}）。awaiting-user 节点的存在意义就是一个「备好料的用户决策点」——没包 = 节点没兑现` +
        `意义 = 新 session 跑 /cc-master:discuss 开不起来讨论（discuss 见「节点上没 decision_package」即停手），采访闭环塌掉。\n` +
        `  怎么修：在 ${id} 上挂 decision_package（canonical 契约见 board.md §decision_package：version/inputs_hash/ask_type/` +
        `context_md/what_i_need/options…），或若该节点已不在等用户拍板，把 blocked_on 改掉 / status 改成非 blocked·in_flight。`, id);
      continue; // 没包 → 没有字段可逐项查，R8b 跳过
    }

    // R8b WARN：包在、但字段不全（每项不合 → 一条 warn；不 hard fail——graceful，editor 可补全）。
    if (typeof dp.context_md !== 'string' || dp.context_md === '') {
      warn('R8b',
        `${id}.decision_package.context_md 应为非空字符串（当前：${JSON.stringify(dp.context_md)}）。` +
        `影响：discuss 用它把「cc-master 为什么卡在这」讲清楚——缺它用户被空投到失上下文决策点（这正是 decision_package 要解的痛点）。`, id);
    }
    if (typeof dp.what_i_need !== 'string' || dp.what_i_need === '') {
      warn('R8b',
        `${id}.decision_package.what_i_need 应为非空字符串（当前：${JSON.stringify(dp.what_i_need)}）。` +
        `影响：discuss 据它告诉用户「该给你什么」——缺它讨论没有明确产出物。`, id);
    }
    if (typeof dp.ask_type !== 'string' || !ASK_TYPE_ENUM.has(dp.ask_type)) {
      warn('R8b',
        `${id}.decision_package.ask_type 应 ∈ {decision, advice, solution}（当前：${JSON.stringify(dp.ask_type)}）。` +
        `影响：discuss 据它设定姿态（拍板 / 给判断 / 给解法）——缺/错则姿态错配。`, id);
    } else if (dp.ask_type === 'decision' && !(Array.isArray(dp.options) && dp.options.length > 0)) {
      // ask_type==="decision" 时 options 必填非空（board.md §decision_package：decision 型 options 必填非空）。
      warn('R8b',
        `${id}.decision_package.ask_type 是 "decision" 却没有非空 options 数组（当前 options：${JSON.stringify(dp.options)}）。` +
        `影响：decision 型采访让用户在 options 里拍板——没选项用户无从选起（advice/solution 型 options 可空）。`, id);
    }
    if (typeof dp.inputs_hash !== 'string' || !INPUTS_HASH_RE.test(dp.inputs_hash)) {
      warn('R8b',
        `${id}.decision_package.inputs_hash 应匹配 sha256:<hex>（当前：${JSON.stringify(dp.inputs_hash)}）。` +
        `影响：discuss 入口重算此值做 freshness-check（上游变没变）——格式不对则时效性校验失效、可能拿过期依据糊弄用户。`, id);
    }
    if (typeof dp.enter_cmd !== 'string' || dp.enter_cmd === '') {
      warn('R8b',
        `${id}.decision_package.enter_cmd 应为非空字符串（当前：${JSON.stringify(dp.enter_cmd)}）。` +
        `影响：webview 详情栏据此渲染复制 /cc-master:discuss 按钮——缺它用户没有一键讨论入口，采访闭环的「复制即用」那一环断掉。`, id);
    }
  }

  return { errors, warnings };
}

// buildGraph(tasks) — 从一个 tasks 数组建出图结构的纯函数（不抛、只读、对坏输入退化）。
//   这是 board-lint-core 与 board-graph-core 共享的**单一真相源邻接构建器**（DRY：lint 的图、分析的图、
//   rollup 的图都从这一份长出来，杜绝三份漂移）。lintBoard 调它拿 deps 邻接 + dangling/selfLoops 转 R4 报告；
//   board-graph-core require 它在其上叠 CPM / impact / parallelism 等重算法。
//
//   返回的 upstream/downstream 只含**合法 deps 边**（指向存在 id、且非自环）——与抽取前 lintBoard 的
//   `graph`（cleanDeps）语义一致，故 findCycle(upstream) 等价于旧的 findCycle(graph)。
//   dangling（deps 指向不存在 id）/ selfLoops（deps 含自身）被剔出邻接、单列出来；edgeIssues 保留它们在
//   「逐 task、task 内逐 dep」遍历里的相对顺序，让 lintBoard 能字节级复现旧报告顺序（纯重构纪律）。
//
//   ★D3：新增 parent 边倒排——parentOf（child→owner）+ children（owner→[child...]，按 task 出现序）。
//   只收 parent 是非空字符串的边；parent 指向不存在 id 也照收进 parentOf（库/lint 各自判违例，buildGraph 不判）。
//   buildGraph **不做任何 parent 合法性校验**（depth=1 / 环 / 引用存在都不在这里——那是消费者的事）。
function buildGraph(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const ids = new Set();
  const taskById = new Map();
  for (const t of list) {
    if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.id === 'string' && t.id !== '') {
      // 与 R3b 一致：重复 id 时保留**首个**（Map.set 后写覆盖，故先判 has 再 set 保首）。
      if (!ids.has(t.id)) { ids.add(t.id); taskById.set(t.id, t); }
    }
  }

  const upstream = new Map();   // id -> [合法 dep id...]（去悬挂、去自环）
  const downstream = new Map(); // id -> [合法 dependent id...]
  for (const id of ids) { upstream.set(id, []); downstream.set(id, []); }

  const dangling = [];   // [{ id, dep }]
  const selfLoops = [];  // [id]
  const edgeIssues = []; // [{ kind:'dangling'|'selfLoop', id, dep? }]（保遍历顺序）

  for (const t of list) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const id = t.id;
    if (typeof id !== 'string' || id === '' || !ids.has(id)) continue;
    if (taskById.get(id) !== t) continue; // 重复 id 的后写者不参与图（只首个算·与 lint 一致）
    const deps = Array.isArray(t.deps) ? t.deps.filter((d) => typeof d === 'string') : [];
    for (const d of deps) {
      if (!ids.has(d)) {
        dangling.push({ id, dep: d });
        edgeIssues.push({ kind: 'dangling', id, dep: d });
        continue;
      }
      if (d === id) {
        selfLoops.push(id);
        edgeIssues.push({ kind: 'selfLoop', id });
        continue;
      }
      upstream.get(id).push(d);
      downstream.get(d).push(id);
    }
  }

  // ── D3：parent 边倒排（child → owner 倒排成 owner → [children]）。
  const parentOf = new Map();  // childId -> ownerId（parent 是非空字符串即收，不校验合法性）
  const children = new Map();  // ownerId -> [childId...]（按 child 在 tasks 里的出现序）
  for (const t of list) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const id = t.id;
    if (typeof id !== 'string' || id === '' || !ids.has(id)) continue;
    if (taskById.get(id) !== t) continue;
    const p = t.parent;
    if (typeof p !== 'string' || p === '') continue;
    parentOf.set(id, p);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(id);
  }

  return { ids, taskById, upstream, downstream, dangling, selfLoops, edgeIssues, children, parentOf };
}

// findCycle(graph: Map<id, deps[]>) → 返回环上的 id 数组（从环起点起），或 null（无环）。
// DFS 三色着色（white 未访 / gray 在栈 / black 完成）；遇到 gray 邻居即回边 = 环。
function findCycle(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  for (const id of graph.keys()) color.set(id, WHITE);

  for (const start of graph.keys()) {
    if (color.get(start) !== WHITE) continue;
    // 迭代式 DFS（避免大图爆栈）。stack 元素 { node, iter }。
    const stack = [{ node: start, deps: graph.get(start) || [], i: 0 }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.deps.length) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const next = top.deps[top.i++];
      const c = color.get(next);
      if (c === undefined) continue; // dep 指向不存在 id（R4a 已报）——不参与环
      if (c === GRAY) {
        // 回边：从 next 沿 parent 链回到 top.node，构造环路径。
        const cyc = [next];
        let cur = top.node;
        while (cur !== next && cur !== undefined) {
          cyc.push(cur);
          cur = parent.get(cur);
        }
        return cyc.reverse();
      }
      if (c === WHITE) {
        color.set(next, GRAY);
        parent.set(next, top.node);
        stack.push({ node: next, deps: graph.get(next) || [], i: 0 });
      }
    }
  }
  return null;
}

// formatReport({errors,warnings}) → agent-friendly 多行报告字符串（设计稿 §7）。绝不吐原始 stack trace。
//   hard fail 与 warn 分组；每条点名 rule + 字段/task + 怎么修。无 error 无 warn → 返回 ''（静默）。
function formatReport(result) {
  const { errors, warnings } = result;
  if (errors.length === 0 && warnings.length === 0) return '';
  const lines = [];
  const head = errors.length > 0
    ? `cc-master board lint: FAIL（${errors.length} 个 hard error${warnings.length ? `，${warnings.length} warning` : ''}）`
    : `cc-master board lint: PASS（0 hard error，${warnings.length} warning）`;
  lines.push(head, '');
  for (const e of errors) lines.push(`[hard] ${e.rule} ${e.message}`, '');
  for (const w of warnings) lines.push(`[warn] ${w.rule} ${w.message}`, '');
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ── UMD 双形态导出（D3.7·浏览器桥）─────────────────────────────────────────────────────────────
//   CommonJS（hook / CLI / node:test）：照常 module.exports，零行为变化。
//   浏览器（view.html 把本文件当 classic <script> 加载，供 board-graph-core 复用 buildGraph/findCycle）：
//   无 module，挂到 globalThis.__ccmBoardLintCore 让 board-graph-core.js 的 require-fallback 读取（DRY：
//   一份 buildGraph，hook / CLI / webview 三处共用·设计稿 §5.2）。
{
  const __ccmLintExports = { lintBoard, formatReport, findCycle, buildGraph, STATUS_ENUM, ISO_UTC_RE };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = __ccmLintExports;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.__ccmBoardLintCore = __ccmLintExports;
  }
}
