#!/usr/bin/env node
'use strict';
// board-lint.js — T9 PostToolUse hook（ADR-006 解锁的 node hook）。
//
// 事件：PostToolUse（matcher Write|Edit）。每当 agent 用 Write/Edit 改了**本 session 的 active board**
//   后触发，JSON.parse 重读它、跑共享 lint 核心（board-lint-core.js），不通过则注入一条**非阻断**的
//   additionalContext 报告（hookEventName "PostToolUse"），点名「违了哪条规则 + 哪个 task + 怎么修」，
//   让 agent 下一步去修。**绝不 decision:block** —— PostToolUse 编辑已落盘、撤不回，hook 只软提示。
//
// 红线1 / ADR-006：node/JS only。JSON.parse 解析 stdin + board，零 spawn jq/python，零网络，零依赖。
//   全程 try/catch 兜住 → 任何失败都静默 exit 0（hook 崩绝不污染 agent 流，与 usage-pacing 同纪律）。
//
// 红线2：lint 只校验窄腰 + 合法 JSON + deps 图完整性 + viewer 真会挂的字段，对 agent-shaped 字段
//   silent-on-unknown —— 规则实现全在 board-lint-core.js（单一真相源），本 hook 只负责「门 + 注入」。
//
// 红线6（dormant-until-armed）：本 hook 是 PostToolUse（非 bootstrap），不豁免武装闸。复用与
//   usage-pacing.js **字字相同**的 board-derived isArmed —— 未武装一律静默。再叠一道「改的是本 session
//   的 active board 吗」判定（闸4），只对当前在用的真相源把关，不对归档板 / 别 session 的板出声。
//
// DRY：lint 核心是 ./board-lint-core.js（同目录，随 plugin 分发的约定目录 hooks/ 内 —— 红线5：hook 不
//   伸手进 skill 树）。手动脚本（skills/.../scripts/board-lint.js）经稳定的 plugin 内相对路径 require
//   同一份核心，两个消费者零漂移（content 测试断言）。

const fs = require('fs');
const path = require('path');
const { lintBoard, formatReport } = require('./board-lint-core.js');

// HOME_DIR：与全 hook 同口径（CC_MASTER_HOME 覆写，否则 CLAUDE_PROJECT_DIR/.claude/cc-master，再否则
//   cwd/.claude/cc-master）。测试经 CC_MASTER_HOME 注入。
const HOME_DIR =
  process.env.CC_MASTER_HOME ||
  path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'cc-master');

// ── ARMED GATE（node 版 board_matches，与 usage-pacing.js isArmed 字字相同）─────────────────────────
// isArmed(homeDir, sid)：homeDir 里存在一个 *.board.json 满足 owner.active === true 且（stdin sid 空 →
//   非对称降级：任一 active 板；否则 owner.session_id === sid）。空 board sid 不收养（CODEX14，红线6）。
//   只读 owner.active / owner.session_id 两个 pinned 字段（不读 tasks、不写 board）。任何读/解析失败按
//   「该板不匹配」处理（try/catch 兜住）→ 失败视为未武装 → 静默。
function isArmed(homeDir, sid) {
  let entries;
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch (_e) {
    return false;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.board.json')) continue;
    let board;
    try {
      board = JSON.parse(fs.readFileSync(path.join(homeDir, ent.name), 'utf8'));
    } catch (_e) {
      continue; // 坏板 → 跳过
    }
    const owner = (board && board.owner) || {};
    if (owner.active !== true) continue;
    if (!sid) return true; // 降级：stdin sid 空 → 任一 active 板即武装（ADR-007 §2.3）
    if (owner.session_id === sid) return true; // session-scoped 精确匹配
  }
  return false;
}

// targetIsMyActiveBoard(filePath, sid)：闸4 —— 被编辑文件是不是「本 session 拥有的那块 active
//   board」。读该 board 的 owner.active === true 且（sid 非空时）owner.session_id === sid。
//   防的是：agent 手动编辑一块归档的 / 别 session 的 board，lint 不该对它出声。
//   返回：true（是我的 active 板）/ false（解析成功但归档 or 别 session）/ null（文件 JSON 读不出——
//   可能正是刚写坏的本 session active 板，由调用方用 targetOwnedByMeTolerant 这道坏-JSON 专用闸再判）。
function targetIsMyActiveBoard(filePath, sid) {
  let board;
  try {
    board = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    // 文件读不出 / JSON 不合法 —— 但它可能正是 agent 刚写坏的本 session active board，我们仍想 lint 它。
    // 从坏 JSON 读不出结构化 owner，故返回 null 让调用方走坏-JSON 专用的容错认领闸（红线6 仍守）。
    return null;
  }
  const owner = (board && board.owner) || {};
  if (owner.active !== true) return false; // 归档板（active:false）→ 不出声
  if (sid && owner.session_id !== sid) return false; // 别 session 的 active 板 → 不出声
  return true;
}

// targetOwnedByMeTolerant(filePath, sid)：坏-JSON 专用闸 —— 目标文件 JSON.parse 失败时，对**原始文本**
//   做容错扫描，判它的 owner.session_id 是否属于本 session。这道闸专为「本 session 把自己唯一的 active
//   board 写成 invalid JSON」而设：此时结构化 isArmed 扫不到任何可解析 active 板（坏板自己 parse 失败被
//   跳过）→ 标准武装闸误判未武装 → lint 漏掉它最该 catch 的那种坏写入（codex 逮到的 single-active-board
//   盲区）。
//
//   红线6（dormant-until-armed）守法依据：只在原始文本里真能扫出 owner.session_id === sid（sid 非空时）
//   时才认领；sid 空时（compaction 边界降级）退而认任意写坏 *.board.json 的本 home 编辑（已过闸2 = 文件
//   在 cc-master home 内且匹配 *.board.json，一个 agent 主动往 home 写 board 文件已在和 cc-master 打交道，
//   给它一条「JSON 写坏了」的非阻断软提示是帮助而非骚扰）。**绝不**对「文本里扫出别 session 的
//   session_id」认领（防红线6 泄漏：从没跑过 orchestrator 的 session 编辑一块别人的坏板须保持静默）。
//   纯字符串扫描、零文件结构信任、任何异常静默 false。
function targetOwnedByMeTolerant(filePath, sid) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return false; // 读不出 → 不认领
  }
  // 容错扫 owner.session_id 的值（首个 "session_id":"<value>"）。坏 JSON 也常保留 owner 块完整、只截断
  //   后续 tasks —— 这正是 agent 写坏的典型形态。
  const m = raw.match(/"session_id"\s*:\s*"([^"]*)"/);
  if (sid) {
    // sid 非空：只认领文本里明确写着本 session 的板。扫不出 / 写的是别 session → 不认领（红线6）。
    return !!m && m[1] === sid;
  }
  // sid 空（降级）：本 home 内写坏的 *.board.json 即认领（已过闸2，给软提示是帮助）。
  return true;
}

function main() {
  // 读 stdin，取 tool_name / tool_input.file_path / session_id。
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return; // stdin 读不到 → 静默
  }
  let toolName = '';
  let filePath = '';
  let sid = '';
  try {
    const o = JSON.parse(stdin || '{}');
    if (o && typeof o.tool_name === 'string') toolName = o.tool_name;
    if (o && typeof o.session_id === 'string') sid = o.session_id;
    const ti = (o && o.tool_input) || {};
    if (typeof ti.file_path === 'string') filePath = ti.file_path;
  } catch (_e) {
    return; // 非法 stdin → 静默
  }

  // ── 闸1：tool_name ∈ {Write, Edit, MultiEdit}（最高频早退；其余 Read/Grep/Bash 立即静默）──────────
  // Bash 改 board（sed/echo/cat >）的 tool_input 是 command 字符串、无结构化 file_path —— 静态 hook 无法
  // 可靠判断它改没改 board（解析任意 shell 找输出重定向不可判定），交手动脚本补（设计稿 §5.1）。
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return;

  // ── 闸2：file_path 落在 home 内且匹配 *.board.json（纯字符串判断，无文件读）──────────────────────
  if (!filePath) return;
  const resolvedFile = path.resolve(filePath);
  const resolvedHome = path.resolve(HOME_DIR);
  const inHome =
    resolvedFile === resolvedHome ||
    resolvedFile.startsWith(resolvedHome + path.sep);
  if (!inHome) return;
  if (!path.basename(resolvedFile).endsWith('.board.json')) return;

  // ── 闸3+闸4：武装 ∧「编辑的是本 session 的 active board」——但二者必须解耦（codex 逮到的 bug）─────
  // 先算闸4（目标本身是不是本 session 的 active 板），因为坏-JSON 目标要走专用的容错认领路径，不能被
  // 闸3 标准 isArmed 提前堵死。三个分支：
  const verdict = targetIsMyActiveBoard(resolvedFile, sid);
  if (verdict === false) return; // 解析成功但归档板 / 别 session 板 → 静默（现有正确行为，别动）
  if (verdict === true) {
    // 目标解析成功且是本 session 的 active 板 —— 它自己就是武装证据（lint 跑它会静默通过或报 warn）。
    // 标准 isArmed 此时必然也成立（它能 parse 这块 active 板），但我们不再依赖它「找到另一块」可解析板。
    // 仍过一道 isArmed 兜「目标解析成功但 owner 被改成非本 session 而 sid 空降级匹配到它」的常规路径。
    if (!isArmed(HOME_DIR, sid)) return;
  } else {
    // verdict === null：目标文件 JSON.parse 失败（可能正是刚写坏的本 session active board）。
    //   标准 isArmed 在「本 session 只有这一块 active 板、且它就是被写坏的目标」时会**误判未武装**
    //   （坏板 parse 失败被 isArmed 跳过、没有别的可解析 active 板救场 → return false）——这正是 codex
    //   逮到的 single-active-board 盲区。故对坏-JSON 目标用专用容错闸认领，而非标准 isArmed：
    //   - 它在文本里扫出 owner.session_id === sid（sid 非空）→ 是本 session 的板 → 放行 lint 报 R1。
    //   - sid 空（降级）→ 本 home 内写坏的 *.board.json 即认领 → 放行 lint 报 R1。
    //   - 扫出别 session 的 session_id / 扫不出且 sid 非空 → 不认领 → 静默（红线6：never-armed session
    //     编辑别人的坏板须沉默）。
    if (!targetOwnedByMeTolerant(resolvedFile, sid)) return;
  }

  // ── 四闸全过 → 读被编辑 board → 跑 lint ─────────────────────────────────────────────────────────
  let text;
  try {
    text = fs.readFileSync(resolvedFile, 'utf8');
  } catch (_e) {
    return; // 文件读不出 → 静默（编辑可能已 mv 走等边角，不强求）
  }

  const result = lintBoard(text);
  if (result.errors.length === 0 && result.warnings.length === 0) return; // lint 通过 → 静默（不刷屏）

  const report = formatReport(result);
  if (!report) return;

  // 非阻断注入：仅 additionalContext，hookEventName "PostToolUse"。绝不 decision:block。
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: report,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

try {
  main();
} catch (_e) {
  // 兜底：任何未预期异常都不得污染 agent 流 —— 静默成功退出。
}
process.exit(0);
