#!/usr/bin/env node
'use strict';
// board-lint.js — T9 交付 B：独立手动 lint 脚本（运行时带外、随 skill 分发）。
//
// 落点为何在这（skills/orchestrating-to-completion/scripts/）：它是**终端用户/agent 会跑的运行时**带外
//   脚本（红线5 / Finding #37 落点纪律）—— prose 引用用 ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT} 绝对
//   路径，绝不裸相对路径。它**显式被调用**（不是 plugin-level 自动 hook），故**不需要武装闸**（武装闸是
//   防 hook 在无关 session 自动出声；显式跑就是想要它跑 —— 与 cc-usage.sh / codex-review.sh 同）；它对
//   任意给定的 board 路径都 lint（想查归档板也行），补 PostToolUse hook 看不见的编辑路径（尤其 Bash 改 board）。
//
// 红线1 / ADR-006：node/JS only。共用同一份 lint 核心（DRY） —— 不复制规则集。核心住
//   ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/board-lint-core.js（hook 同目录 require 它；本脚本经 plugin 内
//   相对路径 require 同一份）。两个目录都随 plugin 分发、一起 ship，故这条 plugin 内相对路径在装机后稳定。
//
// CLI：
//   node board-lint.js <board-path>     lint 该文件
//   node board-lint.js                  无参 → lint CC_MASTER_HOME 下唯一的 active 板（多块则提示传路径）
//   node board-lint.js --json [<path>]  出结构化 {errors, warnings} JSON（供编排读）
// 退出码：0 = 无 hard error（可能有 warning）；1 = 至少一个 hard error；2 = usage/IO 错。

const fs = require('fs');
const path = require('path');

// 解析共享核心：本脚本在 ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/，核心在
//   ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/ —— 两者都随 plugin 分发，从 __dirname 上溯三级
//   （scripts → skill-name → skills → plugin-root）再下到 hooks 的 scripts。这条 plugin 内相对路径
//   装机后稳定（红线5：依赖方向 skill→hooks 合法，两目录都 ship）。
const CORE_PATH = path.resolve(__dirname, '..', '..', '..', 'hooks', 'scripts', 'board-lint-core.js');
const { lintBoard, formatReport } = require(CORE_PATH);

function die(msg, code) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// findSingleActiveBoard(homeDir) → 唯一 active 板的绝对路径，或抛一个 agent-friendly 错。
function findSingleActiveBoard(homeDir) {
  let entries;
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch (_e) {
    die(`cc-master board lint: 找不到 board home（${homeDir}）。\n  怎么修：传一个显式 board 路径，或设 CC_MASTER_HOME。`, 2);
  }
  const active = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.board.json')) continue;
    const full = path.join(homeDir, ent.name);
    try {
      const b = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (b && b.owner && b.owner.active === true) active.push(full);
    } catch (_e) {
      // 坏板：无法判 active —— 跳过（用户可显式传它的路径来 lint）。
    }
  }
  if (active.length === 0) {
    die(`cc-master board lint: home（${homeDir}）里没有 active board。\n  怎么修：传一个显式 board 路径。`, 2);
  }
  if (active.length > 1) {
    die(`cc-master board lint: home 里有 ${active.length} 块 active board，无法自动选。\n  请传一个显式 board 路径，例如：\n` +
        active.map((p) => `    node board-lint.js ${p}`).join('\n'), 2);
  }
  return active[0];
}

function main() {
  const argv = process.argv.slice(2);
  let asJson = false;
  const rest = [];
  for (const a of argv) {
    if (a === '--json') asJson = true;
    else rest.push(a);
  }

  let boardPath = rest[0];
  if (!boardPath) {
    const home =
      process.env.CC_MASTER_HOME ||
      path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'cc-master');
    boardPath = findSingleActiveBoard(home); // 内部失败会 die(…,2)
  }

  let text;
  try {
    text = fs.readFileSync(boardPath, 'utf8');
  } catch (_e) {
    die(`cc-master board lint: 读不到 board 文件（${boardPath}）。\n  怎么修：确认路径存在、可读。`, 2);
  }

  const result = lintBoard(text);

  if (asJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    const report = formatReport(result);
    if (report) process.stdout.write(report.replace(/\n+$/, '') + '\n');
    else process.stdout.write('cc-master board lint: PASS（0 hard error，0 warning）\n');
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}

try {
  main();
} catch (e) {
  // 手动脚本失败要 agent-friendly（非裸 stack trace）—— 但这是显式调用，给一条可读错 + rc 2。
  die(`cc-master board lint: 内部错误 —— ${(e && e.message) ? e.message : String(e)}`, 2);
}
