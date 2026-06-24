#!/usr/bin/env node
// usage-pacing.js — H8 (ADR-006 解锁的旗舰 node hook)。
//
// 事件：Stop。每当主线 agent 想交还控制权时触发。读本地 usage JSONL（同 scripts/cc-usage.sh
// 的解析 + 5h rolling block + burn-rate 算法，同源同口径），感知是否临近「5h burn-rate 墙」，
// 临界时注入一条 **非阻断** 的 pacing 警告（hookSpecificOutput.additionalContext，hookEventName
// "Stop"）。**绝不 decision:block** —— hook 只感知+提示，怎么 pace 是认知（属 SKILL A，cost-and-
// pacing.md），不在 hook 里替主线做调度决策（红线4：指挥不演奏，引擎不替它思考）。
//
// 红线1 / ADR-006：node/JS only。JSON.parse 读 JSONL，零 spawn（不 spawn python/不靠 bash 算逻辑），
//   零网络，零额外依赖。所有异常 try/catch 兜住 → 任何失败都静默 exit 0（hook 崩会污染 Stop）。
//
// ARMED GATE（armed-hook 纪律的 node 版，本文件最关键的行为修复）：所有 cc-master hook 在本 session
//   「被武装」之前完全休眠 —— armed ⟺ home（CC_MASTER_HOME / CLAUDE_PROJECT_DIR/.claude/cc-master）里
//   存在一个 *.board.json，其 owner.active:true **且** owner.session_id == 本次 stdin 的 session_id
//   （**仅** stdin sid 空 → 非对称降级：匹配任一 active 板保 compaction 边界鲁棒，ADR-007 §2.3；board 未盖
//   session_id（空串）则**保持休眠**——不收养、不武装不相关 session，红线 6；board sid 非空且 ≠ stdin sid 亦不武装）。
//   在此之前 usage-pacing 完全不 gate，
//   读宿主全局 usage 就注入 —— 于是它会在**每一个** session（包括从没跑过 as-master-orchestrator 的）
//   里刷 pacing 提示，污染所有 session。现在 main() 最前面先判 armed，**未武装 → 在读 usage 之前就静默
//   exit 0**。注意：这个 board 读取**只为判 arming**（active + session_id 两个早已 pinned 的 narrow-
//   waist 字段），不读 tasks、不写 board、绝不依赖 board 的 agent-shaped 部分 —— narrow waist 不动。
// 只读 usage JSONL（+ 判 arming 时只读 board 的 active/session_id）—— 绝不写 board。
//
// A2 T6（号池来源迁移）：本 hook 现在在 armed gate 之后**只读**号池 registry accounts.json（用户级
//   ${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.json），算 pacing 的 effective-N（非 active 且 token
//   未过期的可切入备号数 + 1）并注入「号池有 N 个备号」的粗粒度事实。**红线 2**：accounts.json 与 board 正交
//   （它是独立的用户级 registry，本 hook 既不读 board 的 num_account 也不写它——来源已从 board 迁到 accounts.json）。
//   **红线 1**：纯 JSON.parse、零 spawn、零网络。**红线 6**：读 registry / 注入号池事实**全在 armed gate 之后**，
//   未武装一律静默。无 registry / 空池 / 坏 JSON → effective-N=1（天然单账号，与旧 --num_account 缺省一致，设计稿 §F）。
//
// node-on-PATH（ADR-006 §3.2）：npm/global 安装铁定有 `node`；standalone-binary 安装可能内嵌 node
//   而不暴露到 PATH —— 那种宿主下本脚本（shebang `#!/usr/bin/env node`）根本不会被调起，等同于「该 hook
//   不存在」。这是 Stop 事件上的**优雅降级**（不阻断、不报错），与本 hook「失败必静默」的精神一致；
//   owner 在 ADR-006 接受 npm-install 多数派这条边界。启动开销 ~数十 ms —— Stop 是低频事件（每轮一次，
//   非 per-tool），可承受；故 H8 选 node hook 而非留 bash。

'use strict';

const fs = require('fs');
const path = require('path');

// ── 触发策略阈值（克制，避免每回合刷屏；见文件尾 README 块的完整论证）────────────────────────────
//
// 环境覆写点（与 cc-usage.sh 的 --dir/--now 对偶，供测试注入 fixture + 锚定确定性时间）：
//   CC_MASTER_USAGE_DIR  usage JSONL 根目录（默认 ~/.claude/projects），测试指向 fixture。
//   CC_MASTER_NOW        ISO-8601 覆写「现在」，让 rolling window 与撞墙预测确定可复现。
//   CC_MASTER_5H_BUDGET  （可选）本 5h 窗口的 token 预算上限。给了就走「预测撞墙」分支；
//                        未给则 ceiling 未知（真实约束）→ 退化到「明显临界」启发式，否则静默。
//   CC_MASTER_5H_BURN_FLOOR （可选）无预算时启发式用的绝对 burn 地板（tok/min）。给了就覆写默认。
const USAGE_DIR =
  process.env.CC_MASTER_USAGE_DIR ||
  path.join(process.env.HOME || '', '.claude', 'projects');
// HOME_DIR：armed 判定要扫的 board home（与 bash hooks 同口径：CC_MASTER_HOME 覆写，否则
//   CLAUDE_PROJECT_DIR/.claude/cc-master，再否则 cwd/.claude/cc-master）。测试经 CC_MASTER_HOME 注入。
const HOME_DIR =
  process.env.CC_MASTER_HOME ||
  path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'cc-master');
// ACCOUNTS_FILE（A2 T6）：号池 registry accounts.json 的固定路径。effective-N 与「号池有几个备号」
//   注入从这里读，**不再**从 board top-level num_account / --num_account 来（A2 砍 --num_account）。
//   路径必须**用户级**（CC_MASTER_HOME 覆写，否则 $HOME/.claude/cc-master）——与 accounts-lib.js
//   defaultRegistryPath() 同口径。**绝不复用上面的 HOME_DIR**：HOME_DIR 的 fallback 是 CLAUDE_PROJECT_DIR
//   /.claude/cc-master（**项目级**，跟着 repo 走），而号池是跨编排 / 跨 repo 的用户级资源（设计稿 §A.1）。
//   CC_MASTER_ACCOUNTS_FILE 是测试注入点（直接指向 fixture 文件，绕开目录解析）。
const ACCOUNTS_FILE =
  process.env.CC_MASTER_ACCOUNTS_FILE ||
  path.join(
    process.env.CC_MASTER_HOME || path.join(process.env.HOME || '', '.claude', 'cc-master'),
    'accounts.json'
  );
const NOW_OVERRIDE = process.env.CC_MASTER_NOW || '';
const BUDGET_RAW = process.env.CC_MASTER_5H_BUDGET || '';
const BURN_FLOOR_RAW = process.env.CC_MASTER_5H_BURN_FLOOR || '';
// account-authoritative pacing (Finding #37): 优先信 status-line 捕获的账户权威 5h/7d used_percentage
//   (落在 sidecar);只有 sidecar 缺/坏时才降级本地反推。PCT_FLOOR:某窗口 used% 到此即临界(默认 85)。
const RATE_CACHE =
  process.env.CC_MASTER_RATE_CACHE ||
  path.join(process.env.HOME || '', '.claude', '.cc-master-rate-limits.json');
const PCT_FLOOR_RAW = process.env.CC_MASTER_PCT_FLOOR || '';
// 7d≥85% dispatch 闸 (need ②): 7d 是跨窗口加速硬总闸(ADR-010 §2.2/§2.6)。当账户权威 7d used% 达此闸(默认 85)
//   时,撞墙提示从泛泛「减速」**升级措辞**为点名 dispatch 闸——「本回合起暂停 dispatch 新节点、把『是否续耗
//   7d 配额』作为 blocked_on:"user" 决策 surface 给用户」。它仍只是软提示(hook 永不能真 block dispatch,红线4)——
//   真正的暂停由 orchestrator 在决策程序 dispatch 节点执行(心智轨,见 SKILL.md / cost-and-pacing.md)。**只在账户
//   口径生效**:本地反推算不出 7d used%(无分母),反推路径不触发此闸(与加速侧反推禁用同精神)。env 覆写测试注入。
const SEVEN_DAY_DISPATCH_GATE_RAW = process.env.CC_MASTER_SEVEN_DAY_DISPATCH_GATE || '';
// account-authoritative UNDERUSE pacing (对偶于撞墙侧): 当账户口径显示 5h 窗口**欠用**（used% 低）且
//   **临近 reset**（窗口快归零、再不烧就白白浪费）且 **7d 总闸有余量**时，注入一条对称的「加速」非阻断提示。
//   三条 env 覆写点（与撞墙侧 CC_MASTER_PCT_FLOOR 对偶；解析失败一律回退默认）：
//     CC_MASTER_UNDERUSE_PCT_CEIL    5h used% 低于此即「欠用」（默认 60）
//     CC_MASTER_UNDERUSE_REMAIN_MIN  距 5h reset 剩余分钟 ≤ 此即「临近 reset」（默认 60）
//     CC_MASTER_SEVEN_DAY_HEADROOM   7d used% 低于此即「总闸有余量」（默认 80；7d 缺失 → 静默，保守取向）
//     CC_MASTER_UNDERUSE_MAX_STALE_MIN  sidecar 新鲜度上限（分钟，默认 15）：captured_at 距今 > 此即陈旧 → 静默
const UNDERUSE_PCT_CEIL_RAW = process.env.CC_MASTER_UNDERUSE_PCT_CEIL || '';
const UNDERUSE_REMAIN_MIN_RAW = process.env.CC_MASTER_UNDERUSE_REMAIN_MIN || '';
const SEVEN_DAY_HEADROOM_RAW = process.env.CC_MASTER_SEVEN_DAY_HEADROOM || '';
const UNDERUSE_MAX_STALE_MIN_RAW = process.env.CC_MASTER_UNDERUSE_MAX_STALE_MIN || '';
// num_account (need ①): how many quotas can be SERIALLY consumed (真实可序列消费的 n 份配额).
//   **A2 T6 来源迁移**：不再读 board top-level num_account / --num_account（已砍），改从号池 registry
//   accounts.json 算 effective-N = 非 active 且 token 未过期的可切入备号数 + 1(当前在用号)；无 registry /
//   空池 / 坏 JSON → 1(天然单账号，行为与 --num_account 缺省一致)。env CC_MASTER_NUM_ACCOUNT 仍作**测试
//   注入兜底**（registry 不可用或显式覆写时用），与其它 CC_MASTER_* 覆写点对偶；解析失败 / 缺失 / 非正整数 → null。
const NUM_ACCOUNT_RAW = process.env.CC_MASTER_NUM_ACCOUNT || '';

// 「明显临界」启发式阈值（ceiling 未知时的保守降级，避免刷屏）：仅当**两条同时成立**才出声 ——
//   (a) 5h 窗口剩余时间 ≤ HEUR_REMAIN_MIN（墙在不远处）；
//   (b) burn_rate ≥ HEUR_BURN_FLOOR（绝对高速燃烧）。
// 没有预算上限时，唯一**诚实可信**的临界信号就是「贴着墙（remain 低）还在高速烧（burn 高）」。
//   注意：曾用过「burn*remain ≥ used」的相对判据，但 burn=used/elapsed、remain≈300-elapsed，代入即
//   等价于 remain≥elapsed —— 与 remain≤60（要求 elapsed≥240）**永远矛盾**，那条在稳态下根本无法
//   触发（self-defeating）。故改用**绝对 burn 地板**：默认设得足够高，正常使用保持静默，只有真高速
//   贴墙才出声。地板可经 CC_MASTER_5H_BURN_FLOOR 覆写。
const HEUR_REMAIN_MIN = 60; // 剩余 ≤ 60 分钟才考虑出声
const HEUR_BURN_FLOOR_DEFAULT = 5000; // 默认绝对 burn 地板（tok/min）—— 保守、避免刷屏
const HEUR_MIN_TOKENS = 1; // burn_rate>0 的最小门（纯 0 直接静默）

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function parseIso(s) {
  // 容错 ISO-8601；非法 → null（调用方按缺失处理）。Z → +00:00 让 Date 正确取 UTC。
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s.replace('Z', '+00:00'));
  return Number.isNaN(t) ? null : t;
}

// 解析 usage JSONL，算当前 5h rolling block 的 used_tokens / burn_rate_per_min / window_remaining_min。
// 与 cc-usage.sh **逐行同源**：按 message.id 去重保留 MAX usage（被重写的 assistant 记录带更完整的
// 累计 usage，first-seen 会少报使 pacing 误以为配额还多）；--now 锚点丢弃未来行；5h 块在「>5h idle 间隙」
// 或「自块首消息已满 5h（连续使用跨界）」时切新块；只有仍 contains now 的块才是活动窗口，过期则干净归零。
function computeFiveHour(dir, nowMs) {
  const byId = new Map(); // mid -> { ts, tok }
  let files;
  try {
    files = walkJsonl(dir);
  } catch (_e) {
    return null; // 目录不可读 → 视为无数据
  }
  if (!files.length) return null;

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch (_e) {
      continue; // 单个文件读失败 → 跳过，不让整体崩
    }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch (_e) {
        continue; // 损坏行 → 跳过
      }
      if (!o || o.type !== 'assistant') continue;
      const msg = o.message || {};
      const u = msg.usage;
      const mid = msg.id;
      if (!u || !mid) continue;
      const tok =
        (u.input_tokens || 0) +
        (u.output_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0);
      const ts = parseIso(o.timestamp);
      if (ts === null) continue;
      const prev = byId.get(mid);
      if (prev === undefined || tok > prev.tok) byId.set(mid, { ts, tok });
    }
  }

  // --now 锚点：丢弃晚于 now 的行（确定性/历史评估不计尚未发生的 usage）。
  const rows = [];
  for (const { ts, tok } of byId.values()) {
    if (ts <= nowMs) rows.push({ ts, tok });
  }
  if (!rows.length) return { used_tokens: 0, window_remaining_min: 0, burn_rate_per_min: 0 };
  rows.sort((a, b) => a.ts - b.ts);

  // 5h rolling block（ccusage 口径）。
  const blocks = [];
  let cur = [];
  for (const r of rows) {
    if (
      cur.length &&
      (r.ts - cur[cur.length - 1].ts > FIVE_HOURS_MS || r.ts - cur[0].ts >= FIVE_HOURS_MS)
    ) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) blocks.push(cur);

  // 只有仍 contains now 的块是活动窗口；最近活动 >5h 前 → 窗口已刷新 → 干净归零（不报 stale，
  // 不报负的 window_remaining_min）。
  let fh = { used_tokens: 0, window_remaining_min: 0, burn_rate_per_min: 0 };
  if (blocks.length) {
    const b = blocks[blocks.length - 1];
    const start = b[0].ts;
    if (nowMs <= start + FIVE_HOURS_MS) {
      const used = b.reduce((s, r) => s + r.tok, 0);
      const elapsedMin = Math.max((nowMs - start) / 60000, 1);
      fh = {
        used_tokens: used,
        window_remaining_min: Math.round((start + FIVE_HOURS_MS - nowMs) / 60000),
        burn_rate_per_min: Math.round(used / elapsedMin),
      };
    }
  }
  return fh;
}

// 递归收集 dir 下所有 *.jsonl（等价 cc-usage.sh 的 glob('**/*.jsonl', recursive=True)）。
function walkJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_e) {
      continue; // 子目录不可读 → 跳过
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

// 决定是否警告 + 文案。返回 string（要注入）或 null（静默）。
function decideWarning(fh) {
  if (!fh) return null;
  const { used_tokens: used, window_remaining_min: remain, burn_rate_per_min: burn } = fh;
  // 窗口已关闭 / 无燃烧 → 没有撞墙之忧 → 静默。
  if (remain <= 0 || burn < HEUR_MIN_TOKENS) return null;

  const budget = parseBudget(BUDGET_RAW);
  if (budget !== null) {
    // ── 有预算上限：预测撞墙 ── 按当前 burn 把剩余窗口跑满，是否在 reset 前越界。
    const projected = used + burn * remain;
    if (projected <= budget) return null; // 预测不越界 → 静默
    const pctNow = Math.round((used / budget) * 100);
    return formatWarning({ used, burn, remain, budget, projected: Math.round(projected), pctNow });
  }

  // ── 无预算上限（ceiling 未知，真实约束）：优雅降级到「明显临界」启发式 ──
  // 仅当 剩余时间已短（贴墙）**且** burn 绝对高（高速燃烧）时才出声，否则静默（避免刷屏）。
  if (remain > HEUR_REMAIN_MIN) return null;
  const burnFloor = parseFloorOr(BURN_FLOOR_RAW, HEUR_BURN_FLOOR_DEFAULT);
  if (burn < burnFloor) return null; // 速率没到地板 → 不算「明显临界」→ 静默
  return formatWarning({ used, burn, remain, budget: null, projected: null, pctNow: null });
}

// ── ACCOUNT-AUTHORITATIVE pacing (Finding #37) ──────────────────────────────────────────────────────
// 账户权威 5h/7d used_percentage(+resets_at)只在 status-line stdin 出现(官方核实:hook/JSONL/CLI 全无),由
// statusline-capture.js 落到 sidecar。撞墙判据优先用它——账户 % 是权威,不像本地反推 window_remaining_min
// 会失真到数量级(Finding #37);并第一次把 7d 纳入(此前 hook 只看 5h、对 7d 全盲,Finding #31)。
function readRateCache(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null; // 缺/坏 sidecar → 账户口径不可用 → 调用方降级本地反推
  }
}
function pctOf(w) {
  return w && typeof w.used_percentage === 'number' ? w.used_percentage : null;
}
function parsePctFloor(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 85; // 默认 85%:账户某窗口用量到 85% 即临界
}
// 7d dispatch 闸阈值(need ②):非正/非数/缺 → 回退默认 85（与撞墙 floor 同值,7d≥85% 即升级措辞到「暂停 dispatch」）。
function parseSevenDayDispatchGate(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 85;
}
// 返回 {valid, warn}:valid=false ⟺ 账户口径不可用(缺/坏/空)→ 调用方 fallback 本地反推;
// valid=true 时 warn 是文案(到墙)或 null(账户有效但未到墙 → 权威静默,不再反推)。
// num_account 缩放（need ①，撞墙侧的 Q1 连带修正）：撞当前账号 5h 墙(85%)时——
//   n=1 → 这是该账号要烧穿、回落减速（原行为）；
//   n>1 → 当前账号 5h 烧满只是「切到下一份配额」的触发信号、**不是减速信号**（切了有新的满配额 5h 窗，
//         理想是把这份烧满后顺势用下一份，而非在还有余配额时减速空耗）。故 5h 命中时按 n 分叉措辞。
//   **7d 墙不随 n 变**：7d 是跨窗口的总闸（n 是 5h 内的并行/序列度，正交）——7d 命中永远是减速框架，
//   无论几份配额（别把 5h 余量烧成 7d 透支）。
// 7d≥85% dispatch 闸（need ②）：7d 是跨窗口加速硬总闸——当 7d used% 达 dispatchGate（默认 85）时,7d 那条提示从
//   泛泛「减速」**升级措辞**为点名 dispatch 闸:「暂停 dispatch 新节点、把『是否续耗 7d 配额』作 blocked_on:"user"
//   surface 给用户」。这升级只换 **7d 那条** 的措辞强度(5h 撞墙仍是降档/降WIP/defer);7d 命中即触发,与 n 正交。
//   仍只软提示(红线4:hook 永不能真 block dispatch);真正的暂停由 orchestrator 在决策程序 dispatch 节点执行。
function decideAccountWarning(acct, nowSec, floor, n, dispatchGate) {
  if (!acct || typeof acct !== 'object') return { valid: false, warn: null };
  const p5 = pctOf(acct.five_hour);
  const p7 = pctOf(acct.seven_day);
  if (p5 === null && p7 === null) return { valid: false, warn: null }; // 空/无效 → fallback
  const f = acct.five_hour;
  const nAcct = Number.isInteger(n) && n >= 1 ? n : 1;
  const gate = Number.isFinite(dispatchGate) && dispatchGate > 0 ? dispatchGate : 85;
  // 5h 仅在窗口仍有效(resets_at 在未来,或无 resets_at)时参与判墙;已过 reset 的 stale 5h 不参与,
  // 但 7d 不依赖 5h 的 resets_at,仍权威。
  const fhValid = p5 !== null && (typeof f.resets_at !== 'number' || f.resets_at > nowSec);
  const fhHit = fhValid && p5 >= floor;
  const sdHit = p7 !== null && p7 >= floor;
  // 7d 信号是否确认存在（Finding 2 修复，多账号交互的深层 edge）：sidecar 有 5h% 但**缺** seven_day.used_percentage
  //   时 p7===null。「切到下一份配额(n>1)」分支必须**只在 7d 信号确认存在且确有余量**时才走——7d 未知时不能
  //   假设它有余量、不能鼓励切号/续耗（切号刷新的是 5h，7d 是跨号累计的总闸；7d 也许早已逼顶，盲目切号续耗会
  //   把未知的 7d 透支）。p7===null（7d 缺）→ sdKnown=false → 退回保守减速措辞，不 claim 7d 有余量、不鼓励切号。
  const sdKnown = p7 !== null;
  // 7d dispatch 闸独立判定（Finding 3 修复）：dispatch 闸是 ADR-010 的**硬边界**（7d≥gate→暂停 dispatch），
  //   绝不能被可配置的 warning `floor` 架空。早先 sdHit=p7>=floor、提前-return 守卫只看 fhHit/sdHit——
  //   用户把 CC_MASTER_PCT_FLOOR 抬过 gate（如 floor=90、gate=85）时，7d=87% → sdHit=false → 提前 return →
  //   7d≥85% dispatch 闸根本不 fire（硬边界被软 floor 架空）。故 sdGateHit 从 `p7 >= gate` **独立**判，
  //   并纳入下面的提前-return 守卫 + warn 逻辑：无论 warning floor 多高，硬 7d dispatch 闸都能 fire。
  const sdGateHit = p7 !== null && p7 >= gate;
  if (!fhHit && !sdHit && !sdGateHit) return { valid: true, warn: null }; // 账户有效且未到任何墙/闸 → 权威静默
  const hits = [];
  if (fhHit) hits.push(`5h ${p5}%`);
  // 7d 命中 warning floor 或 dispatch 闸任一即列入 hits（floor>gate 时 sdHit 可能为 false 但 sdGateHit 为 true）。
  if (sdHit || sdGateHit) hits.push(`7d ${p7}%`);
  const slowdownLevers =
    `pace 杠杆(怎么 pace 是你的认知判断,见 orchestrating-to-completion / cost-and-pacing):` +
    `① 把后续节点降到更便宜的模型档;② 降并发 WIP、暂缓新派工;③ defer 高 float 的非临界任务到窗口 reset 后。`;
  // 7d≥dispatchGate：dispatch 闸升级段(need ②)。点名「暂停 dispatch 新节点、surface 用户确认」,比泛泛减速重。
  //   附带提及:握多份配额(n>1)时「切到下一份配额(切账号刷新 7d)」是用户的一个可能响应——但切换本身不在此实现。
  //   **从 sdGateHit（p7>=gate，独立于 floor）判**，不再 `sdHit &&`——否则 floor>gate 时 sdHit=false 会让硬闸
  //   被软 floor 架空（Finding 3）。
  const sdDispatchGate = sdGateHit;
  let warn;
  if (sdDispatchGate) {
    // 7d 达 dispatch 闸:最硬措辞(无论 5h 是否也撞墙、无论 n)。7d 是跨窗口不可逆消耗边界 → 暂停派发 + surface 用户。
    const fhNote = fhHit ? `(5h 也已 ${p5}%)` : '';
    const switchNote =
      nAcct > 1
        ? `你声明了 ${nAcct} 份可序列消费的配额——「切到下一份配额(切账号会刷新 7d 窗)」是用户可选的一个响应,` +
          `与「暂停续耗」并列由用户拍;切换动作本身不由 hook/本提示执行。`
        : '';
    warn =
      `[cc-master pacing] 7d 配额硬总闸(权威口径,来自 status-line 捕获):7d 已用 ${p7}%(≥${gate}%)${fhNote}。` +
      `按 ADR-010,7d 是加速硬总闸——**本回合起暂停 dispatch 新节点**,把「是否继续消耗 7d 配额」作为一个 ` +
      `blocked_on:"user" 决策 surface 给用户,等用户确认后再续派发。在飞任务可继续跑完、可端点验收,但不要再派新活。` +
      `${switchNote}这是非阻断提示,真正的暂停由你(orchestrator)在决策程序的 dispatch 节点执行,不替你决策。`;
  } else if (fhHit && nAcct > 1 && sdKnown && !sdHit) {
    // n>1 且只有 5h 撞墙、且 7d 信号**确认存在**并仍有余量(p7 已知 < floor、未达 dispatch 闸)：这是「切下一份
    //   配额」信号,不减速。**Finding 2**:加 sdKnown(p7!==null)守卫——7d 缺失时绝不走这条,以免在 7d 未知时假设
    //   有余量、鼓励切号续耗（切号刷新 5h 不刷 7d，7d 也许早逼顶）。7d 缺 → 落到下面 else 的保守减速措辞。
    warn =
      `[cc-master pacing] 账户 5h 配额临界(权威口径,来自 status-line 捕获):${hits.join(' / ')} ` +
      `已达/超过 ${floor}% 阈值。你声明了 ${nAcct} 份可序列消费的配额且 7d 总闸仍有余量(7d 仅 ${p7}%)——当前账号这份 ` +
      `5h 烧满是**切到下一份配额**的触发信号,不是减速信号:理想是把这份烧满后顺势用下一份满配额的 5h 窗,` +
      `而非在总配额还有余时减速空耗。切换/续派由你的认知判断;这是非阻断提示,不替你决策。`;
  } else {
    // 保守减速分支，三种情形落这里：① n=1（回落减速）；② 7d 撞墙但未达 dispatch 闸（floor≤p7<gate,罕见——
    //   floor 默认即 gate）；③ **n>1 + 5h 撞墙但 7d 信号缺失（p7===null → !sdKnown）**（Finding 2）——7d 未知
    //   时不假设有余量、不鼓励切号，退回保守减速措辞。
    const nNote = nAcct > 1 && sdHit ? `(7d 是跨窗口总闸,与 ${nAcct} 份配额正交——总闸吃紧仍须减速)` : '';
    warn =
      `[cc-master pacing] 账户配额临界(权威口径,来自 status-line 捕获):${hits.join(' / ')} ` +
      `已达/超过 ${floor}% 阈值${nNote}。${slowdownLevers}这是非阻断提示,不替你决策。`;
  }
  return { valid: true, warn };
}

// ── ACCOUNT-AUTHORITATIVE UNDERUSE pacing（对偶于 decideAccountWarning 的「欠用→加速」侧）──────────────
// 撞墙侧问「快烧到墙了，要不要减速」；欠用侧对称地问「窗口快 reset 了却还没怎么用，要不要在它白白浪费前加速」。
// 三条判据 AND（缺一静默——保守，不无端催加速）：
//   ① underused：5h used% < UNDERUSE_PCT_CEIL（默认 60）—— 当前窗口确实欠用。
//   ② nearReset：5h.resets_at 有效（数字）且 (resets_at - nowSec)/60 ≤ UNDERUSE_REMAIN_MIN（默认 60）——
//      窗口快归零；resets_at 缺/已过 → 静默（窗口何时刷新未知/已刷新，催加速无意义）。
//   ③ sevenDayOK：7d used% < SEVEN_DAY_HEADROOM（默认 80）—— 总闸有余量才敢催加速。**7d 信号缺失
//      （null/缺）→ 静默**（用户拍板的保守取向：总闸状态未知就别开闸——不能在 7d 也许快满时催 5h 加速）。
//   ④ fresh：sidecar 的 captured_at 距今 ≤ UNDERUSE_MAX_STALE_MIN（默认 15min）。captured_at 缺/陈旧 → 静默。
//      **为何只欠用侧需要这道闸、撞墙侧不需要（不对称）**：sidecar 由 status-line 捕获，主线 idle 等后台时
//      status-line 不刷新 → captured_at 不更新，而后台 agent 仍在烧配额 → 账户真实 5h used% 已上涨，但 sidecar
//      里的 p5 仍停在旧的偏低值（stale-low p5）。在**欠用侧**，stale-low p5 让本函数误判「还很闲」→ 临 reset
//      误催加速 → 多烧（危险方向）；在**撞墙侧**（decideAccountWarning），stale-low p5 只会让 used%≥floor 的
//      判墙**少报一次警**（stale-low = 漏报减速 = 安全方向，最坏只是没及时刹车、不会主动多烧）。故新鲜度闸只在
//      催加速这个「越陈越危险」的方向上加，撞墙侧无此要求（红线4 精神：宁可少催加速，不可据陈值乱催）。
// 返回 {warn}（要注入的文案）或 {warn:null}（静默）。撞墙(used%≥85)与欠用(used%<60)区间天然互斥，
//   且本函数仅在 decideAccountWarning 判定「账户有效但未到墙」时才被主流程调用 → 同一 Stop 绝不双发。
function decideAccountUnderuse(acct, nowSec, n) {
  if (!acct || typeof acct !== 'object') return { warn: null };
  const f = acct.five_hour;
  const p5 = pctOf(f);
  const p7 = pctOf(acct.seven_day);
  // ① underused（5h used% < effective_ceil）。5h 信号缺失 → 无从判欠用 → 静默。
  // num_account 缩放（need ①，§方案 A）：n 份可序列消费的配额并行 → 单账号该以 ~n 倍速烧，同一剩余时间下
  //   「欠用」判定线该更高。把欠用 ceil 抬成 effective_ceil = min(95, ceil × n)（封顶 95，避免误判「满了」）：
  //   n=1 → 60（原行为）；n≥2 → 基本「临 reset 还没烧满就催加速」。这是把用户「n 倍速」直觉翻译成当前信号
  //   物理上撑得住的形态（账户口径无绝对 token 分母 → 算不出 tok/min 精确速率，只能缩放无量纲的 used% 节奏，
  //   见 cost-and-pacing.md 诚实天花板）。**撞墙侧不随 n 变**（见 decideAccountWarning 头注）。
  const nAcct = Number.isInteger(n) && n >= 1 ? n : 1;
  const ceil = Math.min(95, parseUnderusePctCeil(UNDERUSE_PCT_CEIL_RAW) * nAcct);
  if (p5 === null || p5 >= ceil) return { warn: null };
  // ② nearReset（resets_at 有效且距 reset 剩余 ≤ remainMin）。resets_at 缺/非数/已过 → 静默。
  if (!f || typeof f.resets_at !== 'number' || f.resets_at <= nowSec) return { warn: null };
  const remainMin = (f.resets_at - nowSec) / 60;
  const remainCeil = parseUnderuseRemainMin(UNDERUSE_REMAIN_MIN_RAW);
  if (remainMin > remainCeil) return { warn: null };
  // ③ sevenDayOK（7d used% < headroom）。**7d 缺失 → 静默**（保守：总闸未知不开闸）。
  const headroom = parseSevenDayHeadroom(SEVEN_DAY_HEADROOM_RAW);
  if (p7 === null || p7 >= headroom) return { warn: null };
  // ④ fresh（sidecar 新鲜度闸，见函数头注释的不对称论证）。captured_at 缺失（非数字）或距今 >
  //    maxStaleMin → stale-low p5 不可信 → 静默，绝不据陈值催加速。
  const maxStaleMin = parseUnderuseMaxStale(UNDERUSE_MAX_STALE_MIN_RAW);
  if (typeof acct.captured_at !== 'number' || nowSec - acct.captured_at > maxStaleMin * 60) {
    return { warn: null };
  }
  const nAcctNote =
    nAcct > 1
      ? `(按 ${nAcct} 份可序列消费的配额理想节奏,此刻本该烧得更多——欠用判定线已据此抬高)`
      : '';
  const warn =
    `[cc-master pacing] 账户配额欠用(权威口径,来自 status-line 捕获):5h 仅用 ${p5}%${nAcctNote}、` +
    `窗口约 ${Math.round(remainMin)} min 后 reset(7d 总闸余量充足,仅 ${p7}%)。当前窗口的配额若不用` +
    `将随 reset 白白蒸发——可考虑加速以充分利用。加速杠杆(怎么加速是你的认知判断,见 ` +
    `orchestrating-to-completion / cost-and-pacing 的加速侧 lever):① 把临界路径节点升到更强的模型档以提质提速;` +
    `② 提并发 WIP、把已就绪的高 float 任务提前派发;③ 把原计划 defer 到下一窗口的就绪工作拉进本窗口。` +
    `注意:加速须先过 7d 总闸(别把 5h 余量烧成 7d 透支);且这不是制造 busywork——没有真正就绪的活就别硬凑。` +
    `这是非阻断提示,不替你决策。`;
  return { warn };
}

function parseBudget(raw) {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null; // 非正/非数 → 当未给（降级到启发式）
}

function parseFloorOr(raw, fallback) {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback; // 非正/非数 → 回退默认地板
}

// 欠用侧三个阈值的解析（与撞墙侧 parsePctFloor 同形态：非正/非数/缺 → 回退默认）。
function parseUnderusePctCeil(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60; // 默认 60%:5h used% 低于此即欠用
}
function parseUnderuseRemainMin(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60; // 默认 60min:距 5h reset ≤ 此即临近 reset
}
function parseSevenDayHeadroom(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 80; // 默认 80%:7d used% 低于此即总闸有余量
}
function parseUnderuseMaxStale(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 15; // 默认 15min:sidecar captured_at 距今超过此即陈旧 → 静默
}

function formatWarning({ used, burn, remain, budget, projected, pctNow }) {
  const head =
    budget !== null
      ? `[cc-master pacing] 5h 配额预测撞墙：当前已用 ${used} tok（占预算 ${budget} 的 ${pctNow}%），` +
        `burn ≈ ${burn} tok/min，窗口剩 ${remain} min；按此速率窗口结束前将达 ~${projected} tok，越过 ${budget} 上限。`
      : `[cc-master pacing] 5h 配额临界：当前已用 ${used} tok，burn ≈ ${burn} tok/min，窗口仅剩 ${remain} min ` +
        `且 burn 已过临界地板（未设 CC_MASTER_5H_BUDGET，按「贴墙 + 高速绝对 burn」判定为明显临界）。`;
  const levers =
    `pace 杠杆（怎么 pace 是你的认知判断，见 orchestrating-to-completion / cost-and-pacing）：` +
    `① 把后续节点降到更便宜的模型档（downgrade model）；② 降并发 WIP、暂缓新派工；` +
    `③ defer 高 float 的非临界路径任务到窗口 reset 后。这是非阻断提示，不替你决策。`;
  return `${head} ${levers}`;
}

// ── ARMED GATE（node 版 board_matches）─────────────────────────────────────────────────────────────
// isArmed(homeDir, sid) → 本 session 是否被武装：homeDir 里存在一个 *.board.json 满足
//   owner.active === true 且 (stdin sid 空 → 降级：任一 active 板；否则 owner.session_id === sid)。降级是
//   **非对称**的 —— 仅 stdin sid 空时触发（ADR-007 §2.3，owning session 跨 compaction 重锚）。board 的
//   owner.session_id 为空串（bootstrap 在缺 sid 的 stdin 上建板、或迁移/手改板的异常）时**保持休眠**：它对
//   任何非空 stdin sid 都不字面相等 → false → DORMANT（fail-safe）。对称收养空 board sid 曾试过（CODEX12）并
//   回退（CODEX14）：会武装任意不相关 session，重新引入红线 6 要防的跨会话污染。合法续跑因 resume/compaction
//   保留 session_id、板带原 session_id 故照常匹配；异常 blank 板由显式 re-arm 认领。board sid 非空且 ≠ stdin
//   sid 当然也不匹配（红线 6）。→ ADR-007。
// 只读 owner.active / owner.session_id 两个 narrow-waist pinned 字段（不读 tasks、不写 board）。
// 任何读/解析失败都按「该板不匹配」处理（try/catch 兜住），整体绝不抛 —— 失败 → 视为未武装 → 静默。
// 注意：用 JSON.parse 取结构化字段，不靠 grep/正则去 board 里捞 —— node hook 的既定做法（红线1 允许）。
function isArmed(homeDir, sid) {
  let entries;
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch (_e) {
    return false; // home 不存在/不可读 → 没有任何板 → 未武装
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
    if (owner.active !== true) continue; // 必须 active
    if (!sid) return true; // 降级：stdin sid 空 → 任一 active 板即武装（compaction 边界鲁棒，ADR-007 §2.3）
    // board 未盖 session_id（""/null/undefined）→ 字面 !== 非空 sid → 不武装（休眠，fail-safe）。
    // 对称收养空 board sid 曾试过（CODEX12）并已回退（CODEX14）：它会武装任意不相关 session，重新引入红线 6
    // 要防的跨会话污染。合法续跑因 resume/compaction 保留 session_id、板带原 session_id 故照常精确匹配；异常
    // 的 blank 板由显式 re-arm（重跑 as-master-orchestrator → bootstrap 重盖 session_id）认领。→ ADR-007。
    if (owner.session_id === sid) return true; // session-scoped 精确匹配（board sid 必须非空且 == stdin sid）
  }
  return false;
}

// ── 号池 registry（A2 T6：effective-N + 号池注入的来源，替代 board num_account / --num_account）──────────
// A2 砍了 --num_account：pacing 的「有效 N」不再从 board top-level num_account 来，改从号池 registry
//   accounts.json 算。来源迁移的两条不变式：① accounts.json 与 board **正交**（红线 2：它非 board、不碰
//   narrow waist——只读一份用户级 registry 文件，不读/不写任何 board 字段）；② 优雅降级——无 registry /
//   空池 / 坏 JSON → effective-N=1（天然单账号，行为与 --num_account 缺省完全一致，设计稿 §F）。
//
// 内联**最小 registry 读取**而非 require accounts-lib.js：hook 必须永不崩 + self-contain。跨目录
//   require('../../skills/account-management/scripts/accounts-lib.js') 虽随 plugin 同分发可解析，但是个
//   脆耦合（lib 重构 / standalone-binary 布局差异会让 hook 静默失效）；hook 只需「读 + 数」这一小撮逻辑，
//   内联十几行换来零跨目录耦合 + 红线 1 干净（纯 JSON.parse、零 spawn）。语义与 accounts-lib.js
//   loadRegistry / token 过期判定保持一致（设计稿 §A.3 token_expires_at + §B.4 token_expired 候选过滤）。

// readRegistryAccounts(file) → 号池 accounts map（object）或 null（无文件 / 坏 JSON / 任何读失败）。
//   纯只读、JSON.parse、零 spawn。文件不存在（ENOENT）= null（天然单账号，不报错）。坏 JSON / 非对象
//   = null（保守降级单账号，绝不让 pacing 因 registry 坏而崩——失败必静默是本 hook 的总纪律）。
function readRegistryAccounts(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return null; // ENOENT / 权限 / IO → 无号池 → 降级单账号
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_e) {
    return null; // 坏 JSON → 降级单账号（hook 不修 registry、不报错）
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const accounts = obj.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return null;
  return accounts;
}

// poolStatus(accounts, nowMs) → { backups, switchable, effectiveN }。accounts = registry 的 accounts map
//   （readRegistryAccounts 的返回）或 null。语义（设计稿 §F）：
//     backups   = 号池里**非当前 active** 的号数（不含正在用的那一份）。
//     switchable = backups 里 **可切入** 的号数 —— 必须同时满足：① `switchable !== false`（未被显式标
//                  `switchable:false` 的残缺号，与 select-account.js / account-add.sh 的 switchable 语义同口径：
//                  仅显式写 `false`（如只有 access token、无 refresh token 的残缺 blob）才排除，缺省/未设 =
//                  视作可切）；② **token 未过期**（token_expires_at < now 的排除——切进去认证失败，与
//                  select-account.js B.4 的 token_expired 候选过滤同口径；缺 token_expires_at = 不判过期、计入）。
//                  `switchable:false` 号与过期号一样**计入 backups、不计入 switchable**（存在但不可切）。
//     effectiveN = switchable + 1（+1 = 当前在用的这一份）。null / 空池 → effectiveN=1（单账号）。
//   token 过期判定用严格 ISO 字典序字符串比较即可（定宽 + Z → 字典序==时间序，accounts-lib §A.3 时间纪律），
//   但为稳健（容忍非定宽手写值）这里用 Date.parse 解析比较；解析失败 = 不判过期（计入，乐观——选号侧再纠正）。
function poolStatus(accounts, nowMs) {
  if (!accounts || typeof accounts !== 'object') {
    return { backups: 0, switchable: 0, effectiveN: 1 };
  }
  let backups = 0;
  let switchable = 0;
  for (const entry of Object.values(accounts)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.active === true) continue; // 当前在用号不算备号
    backups += 1;
    // 显式 switchable:false（残缺号·只有 access、无 refresh）→ select-account.js 会排除它 → 不是真容量 lever，
    //   不计 switchable（计入 backups·与过期号同处理）。只排 === false（显式不可切）；缺省/未设 = 视作可切。
    if (entry.switchable === false) continue; // 显式残缺号 → 选号算法排除 → 不计 switchable
    // token 过期判定：有 token_expires_at 且能解析且 < now → 过期 → 不可切入（不计 switchable）。
    const exp = parseIso(entry.token_expires_at);
    if (exp !== null && exp < nowMs) continue; // token 已过期 → 切进去认证失败 → 排除
    switchable += 1;
  }
  return { backups, switchable, effectiveN: switchable + 1 };
}

// readNumAccount(file, nowMs) → pacing 的有效 N（≥1）或 null（调用方 || 1 降级）。env CC_MASTER_NUM_ACCOUNT
//   优先（测试注入 / 显式覆写，与其它 CC_MASTER_* 覆写点对偶）；否则从 registry 算 poolStatus().effectiveN。
//   registry 不可用（null）→ effectiveN=1。**绝不碰 board**（红线 2：来源已迁到正交的 accounts.json）。
function readNumAccount(file, nowMs) {
  const env = parseNumAccount(NUM_ACCOUNT_RAW);
  if (env !== null) return env; // env 覆写优先（测试 / 显式）
  const accounts = readRegistryAccounts(file);
  return poolStatus(accounts, nowMs).effectiveN;
}
// parseNumAccount(v) → 正整数（≥1）或 null（缺失/非正整数/非数字 → 调用方降级 1）。接受数字或数字字符串。
function parseNumAccount(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// ── 主流程：全程 try/catch，任何异常 → 静默 exit 0 ──────────────────────────────────────────────
function main() {
  // 读 stdin，取 session_id —— armed gate 要用它做 session-scoped 判定。
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch (_e) {
    stdin = '';
  }
  let sid = '';
  let stopHookActive = false;
  try {
    const o = JSON.parse(stdin || '{}');
    if (o && typeof o.session_id === 'string') sid = o.session_id;
    // stop_hook_active:true ⟺ Claude Code 因「上一次 Stop hook 续了对话 → agent 再次尝试 Stop」而
    // **重入**本 hook。同一 stdin 口径解析，零新依赖（红线1：node/JS only）。
    if (o && o.stop_hook_active === true) stopHookActive = true;
  } catch (_e) {
    /* ignore — 非法 stdin 不致命；sid 留空 → 走降级 arming 判定 */
  }

  // ── STOP RE-ENTRY GUARD：stop_hook_active:true → 立即静默 exit 0（在任何 usage 计算/注入之前）。──
  // 不加这道闸，usage 仍超预算时本 hook 会在**每一次** Stop 重注同一 pacing 警告——effect 等同
  // 「session 永远停不下来」的循环（虽不 decision:block，但实质卡死），违背「never blocks」契约。
  // 有了它，警告对每个**真正的新 Stop**最多出现一次，re-entry 一律静默（不破坏 unarmed→silent）。
  if (stopHookActive) return;

  // ── ARMED GATE：本 session 未被武装（home 无匹配的 active 板）→ 在读 usage 之前就静默 exit 0。──
  // 这是本 hook 最关键的行为修复：不武装就不读宿主全局 usage、不注入 —— 不再污染无关 session。
  // **红线 6**：下面读 accounts.json 算号池 / 注入号池事实**全在这道闸之后**——未武装一律静默，绝不在
  //   未武装路径读 registry / 注入（与「不读宿主全局 usage」同精神）。
  if (!isArmed(HOME_DIR, sid)) return;

  const nowMs = NOW_OVERRIDE ? parseIso(NOW_OVERRIDE) : Date.now();
  if (nowMs === null) return; // --now 非法 → 静默（不猜）

  // num_account（need ①）：**A2 T6 来源迁移**——从号池 registry accounts.json 算 effective-N（非 active 且
  //   token 未过期的可切入备号数 + 1），不再读 board top-level num_account（已砍 --num_account）。env 覆写优先
  //   （测试）；无 registry / 空池 / 坏 JSON → 1（天然单账号）。读 accounts.json 是正交于 board 的只读（红线 2）、
  //   纯 JSON.parse 零 spawn（红线 1）、在 armed gate 之后（红线 6）。同时拿号池粗粒度事实供下面注入。
  const accounts = readRegistryAccounts(ACCOUNTS_FILE);
  const pool = poolStatus(accounts, nowMs);
  const numAccount = readNumAccount(ACCOUNTS_FILE, nowMs) || 1;

  // account-authoritative override (Finding #37): 优先用 status-line 捕获的账户权威 5h/7d used_percentage
  // 判墙(脱钩会失真到数量级的本地反推 window_remaining_min),并纳入 7d。账户口径权威——可用就以它为准(到墙
  // 警告/没到就静默),只有 sidecar 缺/坏时才降级本地反推(approx)。
  const floor = parsePctFloor(PCT_FLOOR_RAW);
  const dispatchGate = parseSevenDayDispatchGate(SEVEN_DAY_DISPATCH_GATE_RAW); // need ②:7d≥此 → 升级到「暂停 dispatch」
  const acct = readRateCache(RATE_CACHE);
  const nowSec = Math.floor(nowMs / 1000);
  const a = decideAccountWarning(acct, nowSec, floor, numAccount, dispatchGate);
  let warning;
  if (a.valid) {
    // 账户口径权威。撞墙优先：到墙就只发减速提示（a.warn 非空）；没到墙再问欠用 → 可能发对称的加速提示。
    // 撞墙(used%≥85)与欠用(used%<60)区间天然互斥，account 分支里同一 Stop 绝不同发两条。
    if (a.warn) warning = a.warn;
    else warning = decideAccountUnderuse(acct, nowSec, numAccount).warn;
  } else {
    // 账户不可用 → 本地反推 fallback(approx)：维持现状只做撞墙判定。**本地反推路径禁欠用提示**——反推的
    // reset 倒计时会失真到数量级（Finding #37），据此催加速会乱催，故此路径不出欠用提示。
    const fh = computeFiveHour(USAGE_DIR, nowMs);
    warning = decideWarning(fh);
  }
  if (!warning) return; // 余量充足 / 无数据 / 降级判定不临界 → 静默 exit 0

  // ── 号池粗粒度事实注入（A2 T6 §F）──────────────────────────────────────────────────────────────
  // 当 pacing 已要出声（warning 非空）**且**号池里确有可切入备号（switchable ≥ 1）时，在 pacing 提示尾部
  //   附一句号池的**粗粒度事实**——让编排者在配额吃紧的此刻知道「换号」这个 lever 可用。**只注入事实、不在
  //   hook 跑选号算法**（选哪个号是 switch-account.sh 带外的事，§B.7：hook 不跑完整选号、避免把调度逻辑塞进
  //   hook）。无号池 / 无可切入备号 → 不附（switchable=0 时换号无意义，别加噪音）。这段全在 armed gate 之后
  //   （红线 6）、纯读 accounts.json（红线 1/2）；措辞对齐现有 pacing 注入的「非阻断、决策归你」风格。
  if (pool.switchable >= 1) {
    warning +=
      ` [号池] 你有 ${pool.backups} 个备号(其中 ${pool.switchable} 个 token 未过期、可切入)——` +
      `配额逼顶时「换号」是一个可用的 pacing lever:切到一份恢复更多的配额。选哪个号 / 切不切由你的认知判断` +
      `(选号 + 切换是带外 /cc-master:accounts 与 switch 脚本的事,不在此 hook 执行);这是事实告知,不替你决策。`;
  }

  // 非阻断注入：仅 additionalContext，hookEventName "Stop"。绝不 decision:block。
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: warning,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

try {
  main();
} catch (_e) {
  // 兜底：任何未预期异常都不得污染 Stop —— 静默成功退出。
}
process.exit(0);
