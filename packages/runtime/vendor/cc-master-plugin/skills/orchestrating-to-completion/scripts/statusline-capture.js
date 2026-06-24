#!/usr/bin/env node
// statusline-capture.js — 把账户权威用量信号(5h/7d rate_limits)从 status-line stdin 捕获落盘。
//
// 为什么存在(账户权威 usage pacing,本 skill 内详见 references/cost-and-pacing.md):
//   订阅账户的 5h/7d `used_percentage` + `resets_at` 是**权威**用量信号,但官方核实(claude-code-guide
//   查 code.claude.com)结论是它**只**出现在 status-line 脚本的 stdin 里——所有 hook 的 stdin、transcript
//   JSONL、任何 CLI 子命令(/usage /status /cost)、~/.claude 落盘**全都没有**;API `anthropic-ratelimit-*`
//   headers 是 API tier 的 RPM/ITPM,与订阅 5h/7d 滚动窗口口径不同,不能替代。于是带外脚本 cc-usage.sh 与
//   Stop hook usage-pacing.js **都够不到**这个权威值,只能靠本脚本在 status-line 被调用时把它捕获到 sidecar,
//   两者再读 sidecar(权威优先,本地 JSONL 反推退为 fallback)。
//
// 它**不是 hook**(不在 hooks/、不在 hooks.json,是 settings.json 的 statusLine):**不注入任何 agent
//   context、不 block、不碰 board**,只被动缓存一个**账户全局只读信号**到账户级 sidecar。故 dormant-until-
//   armed(红线6)的精神不触犯(无注入/无 block/无 per-session 污染)→ **无武装闸**。
//
// 红线1/ADR-006:node/JS only,零网络、零额外依赖。status-line 脚本**绝不能污染 UI**——任何失败一律静默
//   exit 0(try/catch 全兜)。落盘用「写 temp + rename」原子写,读取方永不会看到半写的 sidecar。
//   缺 rate_limits(非 Pro/Max,或窗口尚未在本 session 出现)→ **不写 sidecar**(不抹掉上次捕获的权威值)。
//
// 用法(接进你自己的 status line,不覆盖既有的):
//   statusLine.command = "<脚本绝对路径> --passthrough '<你原本的 status line 命令>'"
//   ⚠️ ${CLAUDE_PLUGIN_ROOT}/${CLAUDE_SKILL_DIR} 在 statusLine.command 的展开**官方未文档化**(hooks.json command
//      字段明确支持,statusLine.command 未说明;且 statusLine 是 user-scoped、不绑 plugin,变量很可能无定义)——
//      保守用绝对路径;详见 cost-and-pacing.md「接法」段(Finding #39)。
//   有 --passthrough 时:捕获 sidecar 后,把原始 stdin 透传给你原本的命令、原样输出它的 stdout(你的状态行不变)。
//   无 --passthrough 时:输出一行 `5h:NN% 7d:NN%`。
//
// 环境覆写(测试注入 + 确定性):
//   CC_MASTER_RATE_CACHE  sidecar 路径(默认 ~/.claude/.cc-master-rate-limits.json,账户级、跨 project 共享)。
//   CC_MASTER_NOW         ISO-8601 覆写「现在」,让 captured_at 确定可复现(否则 Date.now())。

'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function nowEpoch() {
  const o = process.env.CC_MASTER_NOW;
  if (o) {
    const t = Date.parse(o.replace('Z', '+00:00'));
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function cachePath() {
  return (
    process.env.CC_MASTER_RATE_CACHE ||
    path.join(process.env.HOME || '', '.claude', '.cc-master-rate-limits.json')
  );
}

// 只收一个「真出现且带数值 used_percentage」的窗口;resets_at 有就一并带上。其余一律视为缺失(返回 null)。
function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  if (typeof w.used_percentage !== 'number') return null;
  const o = { used_percentage: w.used_percentage };
  if (typeof w.resets_at === 'number') o.resets_at = w.resets_at;
  return o;
}

// 原子写:写同目录 temp 再 rename(同一文件系统,rename 原子)——读取方永不会看到半写内容。
function writeAtomic(file, data) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_e) {
    /* 目录已存在/不可建 → 让后续 write 自己失败并被外层 catch 兜住 */
  }
  const tmp = path.join(dir, '.rate-' + process.pid + '.tmp');
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function getPassthrough(argv) {
  const i = argv.indexOf('--passthrough');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_e) {
    raw = '';
  }
  let obj = null;
  try {
    obj = JSON.parse(raw || '{}');
  } catch (_e) {
    obj = null; // 坏 stdin → 不解析、不写、按缺失处理
  }

  // 捕获:仅当 stdin 真带 rate_limits 且至少一个窗口可用,才落 sidecar(否则不抹旧值)。
  let captured = null;
  if (obj && obj.rate_limits && typeof obj.rate_limits === 'object') {
    const fh = pickWindow(obj.rate_limits.five_hour);
    const sd = pickWindow(obj.rate_limits.seven_day);
    if (fh || sd) {
      captured = { captured_at: nowEpoch() };
      if (fh) captured.five_hour = fh;
      if (sd) captured.seven_day = sd;
      try {
        writeAtomic(cachePath(), JSON.stringify(captured));
      } catch (_e) {
        /* 落盘失败不致命,继续输出 status line */
      }
    }
  }

  // 输出:优先 chain 用户原本的 status line(--passthrough);否则吐一行 cc-master 状态。
  const pt = getPassthrough(process.argv.slice(2));
  if (pt) {
    try {
      const out = cp.execSync(pt, {
        input: raw,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      process.stdout.write(out);
    } catch (_e) {
      /* 用户脚本失败不致命,静默(绝不污染 status line) */
    }
    return;
  }
  if (captured) {
    const seg = [];
    if (captured.five_hour) seg.push('5h:' + captured.five_hour.used_percentage + '%');
    if (captured.seven_day) seg.push('7d:' + captured.seven_day.used_percentage + '%');
    if (seg.length) process.stdout.write(seg.join(' ') + '\n');
  }
}

try {
  main();
} catch (_e) {
  /* 兜底:任何未预期异常都不得污染 status line */
}
process.exit(0);
