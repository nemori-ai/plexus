#!/usr/bin/env node
'use strict';
// board-graph.js — D3.2 交付：board 图分析手动 CLI（运行时带外、随 skill 分发·设计稿 §5.5）。
//
// 落点为何在这（skills/orchestrating-to-completion/scripts/）：它是 agent/orchestrator 会在决策点主动跑的
//   运行时带外脚本（红线5 / Finding #37 落点纪律）—— prose 引用用 ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT}
//   绝对路径，绝不裸相对路径。它**显式被调用**（非 plugin 自动 hook），故不需武装闸（与 board-lint.js /
//   cc-usage.sh / codex-review.sh 同）。它给 orchestrator 提供「机器算的临界路径 / float / 并行度 / impact /
//   ready-set / owner rollup」——替代 status agent 心算（但**永不回写 board**·红线2，只 stdout/--json）。
//
// 红线1 / ADR-006：node/JS only，零 npm dep。复用同一份图核心（DRY）——核心住
//   ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/board-graph-core.js（它再 require board-lint-core 的 buildGraph）。
//   两目录都随 plugin 分发、一起 ship，故这条 plugin 内相对路径装机后稳定（依赖方向 skill→hooks 合法）。
//
// CLI：
//   node board-graph.js <board-path>          人读摘要：临界链 / ready-set / bottleneck / 并行度 / owner rollup
//   node board-graph.js                        无参 → home 下唯一 active 板（多块则提示传路径）
//   node board-graph.js --json [<path>]        结构化全量 JSON（供编排读）
//   node board-graph.js --cmd <name> [<path>]  单项：critical | ready | wip | impact <id> | parallelism | rollup <owner>
// 退出码：0 = 成功（含「有环但已报告」）；2 = usage/IO 错。**不因「图坏」非零退出**（分析+报告，gate 是 lint 的事）。

const fs = require('fs');
const path = require('path');

// 解析共享核心：本脚本在 ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/，核心在
//   ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/ —— 从 __dirname 上溯三级（scripts → skill-name → skills → root）
//   再下到该 ${CLAUDE_PLUGIN_ROOT}/hooks/scripts。这条 plugin 内相对路径装机后稳定（红线5：两目录都 ship）。
const CORE_PATH = path.resolve(__dirname, '..', '..', '..', 'hooks', 'scripts', 'board-graph-core.js');
const { analyzeGraph } = require(CORE_PATH);

function die(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// findSingleActiveBoard(homeDir) → 唯一 active 板的绝对路径，或 die(…,2)（与 board-lint.js 同口径）。
function findSingleActiveBoard(homeDir) {
  let entries;
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch (_e) {
    die(`cc-master board-graph: 找不到 board home（${homeDir}）。\n  怎么修：传一个显式 board 路径，或设 CC_MASTER_HOME。`, 2);
  }
  const active = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.board.json')) continue;
    const full = path.join(homeDir, ent.name);
    try {
      const b = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (b && b.owner && b.owner.active === true) active.push(full);
    } catch (_e) { /* 坏板：无法判 active，跳过 */ }
  }
  if (active.length === 0) {
    die(`cc-master board-graph: home（${homeDir}）里没有 active board。\n  怎么修：传一个显式 board 路径。`, 2);
  }
  if (active.length > 1) {
    die(`cc-master board-graph: home 里有 ${active.length} 块 active board，无法自动选。\n  请传一个显式 board 路径：\n` +
        active.map((p) => `    node board-graph.js ${p}`).join('\n'), 2);
  }
  return active[0];
}

// idTitle(g, id) → "id" 或 "id（title）"（人读摘要点名用）。
function idTitle(g, id) {
  const t = g.taskById.get(id);
  const title = t && typeof t.title === 'string' ? t.title.trim() : '';
  return title ? `${id}（${title}）` : id;
}

// CPM 临界链人读：诚实标注 weight_source；mixed/unit 只报结构 + 节点数，不报小时级 makespan/float（§5.6）。
function formatCritical(g) {
  const cp = g.criticalPath();
  if (cp.weight_source === 'cycle') {
    return `临界路径：deps 图有环（${cp.cycle.join(' → ')} → ${cp.cycle[0]}），CPM 在环上未定义——先用 board-lint 解环。`;
  }
  const lines = [];
  const chainStr = cp.chain.length ? cp.chain.join(' → ') : '（空——无任务）';
  lines.push(`临界链（${cp.chain.length} 节点）：${chainStr}`);
  if (cp.weight_source === 'measured') {
    lines.push(`  权重来源：measured（全节点有 measured 时长）；makespan ≈ ${cp.makespan.toFixed(2)}h。`);
  } else {
    lines.push(`  权重来源：${cp.weight_source}（部分/全部节点缺 measured 时长）——只报临界链结构 + 节点数，` +
               `不报小时级 float/makespan（避免伪精确）。补全 started_at/finished_at 后可得真 CPM。`);
  }
  return lines.join('\n');
}

function humanSummary(g) {
  const lines = [];
  lines.push('cc-master board-graph 摘要');
  lines.push('');
  lines.push(formatCritical(g));
  lines.push('');
  const ready = g.readySet();
  lines.push(`ready-set（deps 全 done ∧ status=ready，可派发）：${ready.length ? ready.join(', ') : '（空）'}`);
  const wip = g.wipStats();
  lines.push(`WIP：in_flight=${wip.in_flight} · blocked=${wip.blocked} · 等用户=${wip.userGates}`);
  const par = g.parallelism();
  lines.push(`并行度：T₁=${par.T1}（总节点）· T∞=${par.Tinf}（临界链长）· 加速比≈${par.parallelism.toFixed(2)}（值得开几条道的上界）`);
  // 最高 impact 节点（gating 最多下游）
  let impactNode = null, impactMax = -1;
  for (const id of g.ids) {
    const v = g.descendants(id).size;
    if (v > impactMax) { impactMax = v; impactNode = id; }
  }
  if (impactNode != null && impactMax > 0) {
    lines.push(`最高 impact：${idTitle(g, impactNode)} gating ${impactMax} 个下游任务`);
  }
  // owner rollup（有 owner 时）
  const owners = [...new Set([...g.ids].filter((id) => g.children(id).length > 0))];
  if (owners.length) {
    lines.push('');
    lines.push('owner rollup（子 done 占比·advisory）：');
    for (const o of owners) {
      const rp = g.rollupProgress(o);
      lines.push(`  ${idTitle(g, o)}：${rp.done}/${rp.total}（${(rp.ratio * 100).toFixed(0)}%）`);
    }
    const incon = g.rollupConsistency();
    if (incon.length) {
      lines.push('  ⚠ rollup 不一致（owner 标 done 但有非 done 子）：');
      for (const v of incon) lines.push(`    ${v.owner} → 非 done 子：${v.nonDoneChildren.join(', ')}`);
    }
  }
  return lines.join('\n');
}

// fullJson(g) — --json 全量结构化输出。Map → 普通对象/数组，便于 JSON.stringify。
function fullJson(g) {
  const cp = g.criticalPath();
  const schedule = {};
  for (const [id, s] of cp.schedule) schedule[id] = s;
  const owners = [...new Set([...g.ids].filter((id) => g.children(id).length > 0))];
  const rollup = {};
  for (const o of owners) rollup[o] = { ...g.rollupProgress(o), children: g.children(o) };
  return {
    nodes: [...g.ids],
    topo: g.topoSort(),
    critical: { chain: cp.chain, makespan: cp.makespan, weight_source: cp.weight_source, schedule },
    longestPath: g.longestPath(),
    parallelism: g.parallelism(),
    readySet: g.readySet(),
    wip: g.wipStats(),
    rollup,
    rollupConsistency: g.rollupConsistency(),
    nesting: { checkDepth1: g.checkDepth1(), parentCycles: g.parentCycles() },
  };
}

// runCmd(g, cmd, arg) → 单项输出字符串（--cmd）。未知 cmd → die(…,2)。
function runCmd(g, cmd, arg) {
  switch (cmd) {
    case 'critical': return formatCritical(g);
    case 'ready': { const r = g.readySet(); return r.length ? r.join('\n') : '（ready-set 空）'; }
    case 'wip': { const w = g.wipStats(); return `in_flight=${w.in_flight} blocked=${w.blocked} userGates=${w.userGates}`; }
    case 'parallelism': { const p = g.parallelism(); return `T1=${p.T1} Tinf=${p.Tinf} parallelism=${p.parallelism.toFixed(2)} brent=${p.brent}`; }
    case 'impact': {
      if (!arg) die(`cc-master board-graph: --cmd impact 需要一个 task id：--cmd impact <id>`, 2);
      const d = g.descendants(arg);
      return `${arg} gating ${d.size} 个下游：${d.size ? [...d].join(', ') : '（无）'}`;
    }
    case 'rollup': {
      if (!arg) die(`cc-master board-graph: --cmd rollup 需要一个 owner id：--cmd rollup <owner>`, 2);
      const rp = g.rollupProgress(arg);
      const kids = g.children(arg);
      return `${arg}：${rp.done}/${rp.total}（${(rp.ratio * 100).toFixed(0)}%）子：${kids.length ? kids.join(', ') : '（无·非 owner）'}`;
    }
    default:
      die(`cc-master board-graph: 未知 --cmd "${cmd}"。合法：critical | ready | wip | impact <id> | parallelism | rollup <owner>`, 2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let asJson = false;
  let cmd = null, cmdArg = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') asJson = true;
    else if (a === '--cmd') { cmd = argv[++i]; }
    else rest.push(a);
  }
  // 位置参数分两类：像路径的（含 / 或 .board.json）当 board 路径，其余当 cmd arg（impact <id> / rollup <owner>）。
  //   这样 `--cmd impact M1 /path/x.board.json` 与 `--cmd impact M1`（无路径走 home）都正确解析。
  const looksPath = (s) => typeof s === 'string' && (s.includes('/') || s.endsWith('.board.json'));
  const pathArgs = rest.filter(looksPath);
  const nonPathArgs = rest.filter((s) => !looksPath(s));
  let boardPath = pathArgs.length ? pathArgs[pathArgs.length - 1] : null;
  if (cmd === 'impact' || cmd === 'rollup') cmdArg = nonPathArgs.length ? nonPathArgs[0] : null;

  if (!boardPath) {
    const home =
      process.env.CC_MASTER_HOME ||
      path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'cc-master');
    boardPath = findSingleActiveBoard(home); // 内部失败 die(…,2)
  }

  let board;
  try {
    board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  } catch (_e) {
    die(`cc-master board-graph: 读不到或解析失败（${boardPath}）。\n  怎么修：确认路径存在、且是合法 board JSON（先跑 board-lint）。`, 2);
  }

  const g = analyzeGraph(board);

  if (asJson) {
    process.stdout.write(JSON.stringify(fullJson(g)) + '\n');
  } else if (cmd) {
    process.stdout.write(runCmd(g, cmd, cmdArg) + '\n');
  } else {
    process.stdout.write(humanSummary(g) + '\n');
  }
  process.exit(0); // 成功（含「有环已报告」）——不因图坏非零退出
}

try {
  main();
} catch (e) {
  die(`cc-master board-graph: 内部错误 —— ${(e && e.message) ? e.message : String(e)}`, 2);
}
