'use strict';
// accounts-lib.js — A2 account-management 关键路径前置 T1：accounts.json 号池调度状态库（node 库）。
//
// 这是号池 registry（accounts.json）的**读 / 写 / 校验**纯逻辑核心，供后续 CLI / switch 脚本
//   `require()` 或 `node -e` 调用（T2 select-account.js / T3 add·delete·list / T4 switch-account.sh）。
//   本文件**只读写 accounts.json 这一份非密 registry**——绝不碰 token、绝不碰 board（红线2 正交）、
//   绝不 spawn（零 jq/python/security）、绝不联网。JSON.parse / JSON.stringify + fs 原子写即全部。
//
// 红线1 / ADR-006：这是**带外 node 库，不是 hook**——node/JS 天经地义合规（ADR-006 已允许 node）。
//   即便它是 hook，JSON.parse + fs 也满足红线1（零 spawn）。
// 红线2：accounts.json 与 board **正交**——它是跨编排、跨 repo 的**用户级**号池 registry，
//   不是 board、不碰 board 的 narrow waist（schema/goal/owner/git/tasks）。本库绝不 import / 读 board。
// 红线5（ship-anywhere）：纯 node stdlib（fs/os/path），零第三方依赖。keychain / file 引用只是
//   **数据形态**（「token 在哪」的非密指针），本库**绝不调 security / 绝不读 token 值**——那是 CLI 的事。
// 安全命门（HARD）：① registry 零 token——本库**绝不打印 / 回显 / 返回任何疑似 token 值**；
//   ② validateRegistry 主动断言「无 token 误入」（发现 sk-ant- 等疑似 token 串 = 硬 error）；
//   ③ saveRegistry 写前必过校验，有 token-leak error 就**拒写抛错**（永不把含 token 的 entry 落盘）。
//
// 设计依据：A2 account-management 设计稿 §A（schema v1 定稿）+ §C-T1（随仓库的设计文档，非随插件分发）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 常量 ────────────────────────────────────────────────────────────────────────────────────────
const SCHEMA = 'cc-master/accounts/v1';

// 严格 ISO-8601 UTC 定宽：YYYY-MM-DDTHH:MM:SSZ（秒精度、Z 后缀、定宽——对齐 board 时间 schema /
//   board-lint-core.js ISO_UTC_RE）。定宽 + Z 使字典序 == 时间序，纯字符串比较即可判过期。
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// vault.kind 合法枚举（设计稿 §A.4：keychain / file 两形态）。
const VAULT_KINDS = new Set(['keychain', 'file']);

// 疑似 token 值前缀 / 形态——防误存 token 进 registry（设计稿 §A.1 不变式1 + T1 安全断言）。
//   Claude OAuth token 形如 `sk-ant-oat01-...`；宽松覆盖 `sk-ant-` 家族 + 长不透明串启发。
const TOKEN_LIKE_RE = /sk-ant-/i;

// SwitchSnapshot 里两个窗口的固定 key（设计稿 §A.3 SwitchSnapshot）。
const WINDOW_KEYS = ['5h', '7d'];

// AccountEntry 里**不该出现**的字段名（任何疑似存 token 的字段名都拦——纵深防御）。
const FORBIDDEN_FIELD_RE = /token$|^token$|oauth|secret|credential|password|bearer/i;

// subscription_type 合法枚举（非密·来自 vault blob 的 claudeAiOauth.subscriptionType）。无重启换号把完整
//   claudeAiOauth blob 存进 vault；blob 里**唯一**非密、对选号/对账有意义的字段是 subscriptionType
//   （max / pro / team / enterprise 这类普通订阅枚举·绝不含 sk-ant- token 形态）。可选地映射进 registry 的
//   非密 subscription_type 字段，便于 list / 巡检区分号档。宽松校验：是字符串即放行（未知值仅 warn 不阻断，
//   Claude Code 升级可能引入新订阅档）。它**绝不是 token**——TOKEN_LIKE_RE/FORBIDDEN_FIELD_RE 不会误命中它。
const KNOWN_SUBSCRIPTION_TYPES = new Set(['max', 'pro', 'team', 'enterprise', 'free']);

// ── 路径解析 ─────────────────────────────────────────────────────────────────────────────────────
// accounts.json 固定路径：${CC_MASTER_HOME:-$HOME/.claude/cc-master}/accounts.json（设计稿 §A.1，
//   orchestrator 拍定默认——用户级 home，绝不落 repo 树 / 绝不跟 board 落 $(pwd)）。
function defaultRegistryPath() {
  const home = process.env.CC_MASTER_HOME || path.join(os.homedir(), '.claude', 'cc-master');
  return path.join(home, 'accounts.json');
}

// ── 校验：validateRegistry(obj) → { errors, warnings } ────────────────────────────────────────────
// 纯函数，绝不抛、绝不改入参。errors = 会确凿坏掉契约 / 安全的硬错（schema/必填/active 多于一个/
//   token 误入/vault 形态非法）；warnings = 可疑但可降级（时间戳非严格 ISO / 未知顶层字段）。
// 与 board-lint 同风格：白名单校验 known 字段形状，对 agent-shaped 未知字段宽容（silent-on-unknown）。
function validateRegistry(obj) {
  const errors = [];
  const warnings = [];
  const err = (msg, account) => errors.push(account ? { message: msg, account } : { message: msg });
  const warn = (msg, account) => warnings.push(account ? { message: msg, account } : { message: msg });

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    err(`registry 顶层必须是一个 JSON 对象（当前：${Array.isArray(obj) ? '数组' : typeof obj}）。`);
    return { errors, warnings };
  }

  // top-level schema（必填、版本门）。
  if (obj.schema !== SCHEMA) {
    err(`schema 必须是字符串字面量 "${SCHEMA}"（当前：${JSON.stringify(obj.schema)}）。它是 registry 版本协议锚点，缺/改 = 未来迁移会错认池。`);
  }

  // top-level updated_at（必填、严格 ISO；非严格 = warn 不阻断，写侧会刷新）。
  if (!('updated_at' in obj)) {
    warn('缺 top-level updated_at（registry 最后写入时刻）；saveRegistry 会在落盘时盖上。');
  } else if (typeof obj.updated_at !== 'string' || !ISO_UTC_RE.test(obj.updated_at)) {
    warn(`updated_at 非严格 ISO-8601 UTC YYYY-MM-DDTHH:MM:SSZ（当前：${JSON.stringify(obj.updated_at)}）。`);
  }

  // top-level accounts（必填、map：email → AccountEntry；空 {} 合法）。
  const accounts = obj.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
    err(`accounts 必须是对象（map：email → entry；空 {} 合法）。当前：${JSON.stringify(accounts)}。`);
    return { errors, warnings };
  }

  // 顶层未知字段（非 schema/updated_at/accounts）——agent-shaped 宽容，仅一次性 warn 提示。
  for (const k of Object.keys(obj)) {
    if (k !== 'schema' && k !== 'updated_at' && k !== 'accounts') {
      warn(`未知顶层字段 ${JSON.stringify(k)}（registry 已知顶层只有 schema/updated_at/accounts）；放行但请确认非误写。`);
    }
  }

  // 逐 entry 校验 + active 唯一性 + token 误入断言。
  let activeCount = 0;
  for (const [email, entry] of Object.entries(accounts)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      err(`entry 必须是对象（当前：${JSON.stringify(entry)}）。`, email);
      continue;
    }

    // ── 安全断言：token 绝不进 registry（设计稿 §A.1 不变式1·T1 安全 HARD）──────────────────────
    // ① 任何字段名形似 token/secret/credential（纵深防御，拦字段名）。
    // ② 任何字段**值**是疑似 token 串（sk-ant- 家族；递归扫 entry 全部字符串叶子）。
    scanForTokenLeak(entry, email, err);

    // ── vault 引用（必填、形态合法）──────────────────────────────────────────────────────────────
    const vault = entry.vault;
    if (!vault || typeof vault !== 'object' || Array.isArray(vault)) {
      err(`vault 必填且为对象（token 的非密引用指针，不含 token 值）。当前：${JSON.stringify(vault)}。`, email);
    } else if (!VAULT_KINDS.has(vault.kind)) {
      err(`vault.kind 必须 ∈ {keychain, file}（当前：${JSON.stringify(vault.kind)}）。`, email);
    } else if (vault.kind === 'keychain') {
      // keychain：{ kind, service, account:email }。
      if (typeof vault.service !== 'string' || !vault.service) {
        err(`keychain vault 需非空 service（如 "cc-master-oauth"）。当前：${JSON.stringify(vault.service)}。`, email);
      }
      if (typeof vault.account !== 'string' || !vault.account) {
        err(`keychain vault 需 account（= email key）。当前：${JSON.stringify(vault.account)}。`, email);
      } else if (vault.account !== email) {
        warn(`keychain vault.account（${JSON.stringify(vault.account)}）与 entry key email（${JSON.stringify(email)}）不一致——取 token 会按 account 找、与 key 脱节。`, email);
      }
    } else if (vault.kind === 'file') {
      // file：{ kind, path, key:email }。
      if (typeof vault.path !== 'string' || !vault.path) {
        err(`file vault 需非空 path（0600 vault 文件路径）。当前：${JSON.stringify(vault.path)}。`, email);
      }
      if (typeof vault.key !== 'string' || !vault.key) {
        err(`file vault 需 key（= email，vault 行前缀）。当前：${JSON.stringify(vault.key)}。`, email);
      } else if (vault.key !== email) {
        warn(`file vault.key（${JSON.stringify(vault.key)}）与 entry key email（${JSON.stringify(email)}）不一致——取 token 会按 key 找、与 key 脱节。`, email);
      }
    }

    // ── active（必填、boolean、至多一个 true）──────────────────────────────────────────────────────
    if (typeof entry.active !== 'boolean') {
      err(`active 必填且为 boolean（是否当前活跃号）。当前：${JSON.stringify(entry.active)}。`, email);
    } else if (entry.active === true) {
      activeCount += 1;
    }

    // ── 时间戳字段（可选、严格 ISO；非严格 = warn）─────────────────────────────────────────────────
    // **token_expires_at 语义钉死（无重启换号·不可破）**：这里记的是 **refresh token 的长期有效期**
    //   （refresh token 长期有效期·录号时 now+365d），**不是** vault blob 里的短期 access-token expiresAt（~8h）。
    //   选号（select-account.js）按它判「该号 token 是否还在长期有效期内」——若误把 8h 短期 expiresAt 写进
    //   这里，每个号都会在几小时后被选号误判为「已过期」而排除，号池瞬间空。短期 expiresAt **只活在 vault
    //   blob 里**（switch 主动 refresh 后写新鲜值），**绝不进 registry**。
    for (const tf of ['token_added_at', 'token_refreshed_at', 'token_expires_at']) {
      if (tf in entry && entry[tf] != null) {
        if (typeof entry[tf] !== 'string' || !ISO_UTC_RE.test(entry[tf])) {
          warn(`${tf} 非严格 ISO-8601 UTC YYYY-MM-DDTHH:MM:SSZ（当前：${JSON.stringify(entry[tf])}）；跨天算时长会错。`, email);
        }
      }
    }

    // ── subscription_type（可选、字符串·非密·来自 vault blob 的 subscriptionType）─────────────────────
    // 无重启换号把完整 claudeAiOauth blob 存进 vault；本字段是 blob.subscriptionType 的非密投影（仅订阅档枚举，
    //   绝不含 token）。宽松校验：是字符串即放行；未知值仅 warn（Claude Code 可能引入新档）；非字符串 = warn。
    if ('subscription_type' in entry && entry.subscription_type != null) {
      if (typeof entry.subscription_type !== 'string' || !entry.subscription_type) {
        warn(`subscription_type 应为非空字符串（订阅档枚举·非密，来自 blob.subscriptionType）。当前：${JSON.stringify(entry.subscription_type)}。`, email);
      } else if (!KNOWN_SUBSCRIPTION_TYPES.has(entry.subscription_type)) {
        warn(`subscription_type ${JSON.stringify(entry.subscription_type)} 不在已知枚举 {max,pro,team,enterprise,free}（放行——Claude Code 可能新增订阅档；仅提示确认非误写）。`, email);
      }
    }

    // ── identity（可选、object·非密身份·= ~/.claude.json oauthAccount 原样透传）─────────────────────────
    // 身份补全重构：vault blob 只存 token，账号**身份**（accountUuid/emailAddress/organization… 16 字段·全非密）
    //   在 ~/.claude.json 的 oauthAccount。把它原样存进 registry 的 identity 字段，让 switch 能完整覆写身份。
    //   宽松校验（与 subscription_type 同风格·CC 升级自动跟上）：是非空对象即放行；未知子字段不报错（不做字段
    //   白名单——CC 官方可能增删身份字段）；非对象 = warn。token 误入由上面 scanForTokenLeak（值扫描全程生效·
    //   identity 子树仅豁免字段名启发式）拦——这里只查形态。
    if ('identity' in entry && entry.identity != null) {
      if (typeof entry.identity !== 'object' || Array.isArray(entry.identity)) {
        warn(`identity 应为对象（~/.claude.json oauthAccount 的非密身份原样透传·accountUuid/emailAddress/… 等）。当前：${JSON.stringify(entry.identity)}。`, email);
      } else if (Object.keys(entry.identity).length === 0) {
        warn(`identity 是空对象（无身份字段）——switch ②段会降级保留现有 oauthAccount 不动（登录显示可能仍是上一号）；建议重跑 --add 补。`, email);
      }
    }

    // ── switchable（可选、boolean·非密·身份补全重构 P2 残缺号标注）──────────────────────────────────────
    // codex P2 修复：fallback 存「无 refreshToken 的残缺 blob」（只 access token·8h 后失效·无重启换号切不进）时，
    //   account-add 把该 entry 标 switchable:false，让 select-account 排除它、list 标「不可切」——别静默把不可切的
    //   号当可切。缺省（未设）= 视作 true（可切·不破既有完整号）。这是非密 boolean，FORBIDDEN_FIELD_RE 不命中。
    if ('switchable' in entry && entry.switchable != null && typeof entry.switchable !== 'boolean') {
      warn(`switchable 应为 boolean（是否可无重启换号切入·缺省视作可切）。当前：${JSON.stringify(entry.switchable)}。`, email);
    }

    // ── last_switch_out（可选、object|null；非 null 时校验快照形态）──────────────────────────────────
    if ('last_switch_out' in entry && entry.last_switch_out != null) {
      validateSnapshot(entry.last_switch_out, email, 'last_switch_out', err, warn);
    }

    // ── last_observed_quota（可选、object|null；非 null 时校验快照形态·与 last_switch_out 同形）────────
    // 优化①：录号（add/refresh）那刻 cc-usage 给的 5h/7d 配额快照。形态同 SwitchSnapshot
    //   （{ at, 5h:{used_pct,resets_at,source?}, 7d:{...} }），故复用 validateSnapshot。
    //   **诚实语义局限**：cc-usage 反映的是「录号那刻 session 当前号」的配额，未必是被录号的——
    //   仅当被录的就是当前 session 号时才准（见 account-add.sh write_observed_quota 注释）。故 select
    //   只把它当**弱信号兜底**（信任度低于真正的 last_switch_out 切出快照）。校验只查形态、不判信任。
    if ('last_observed_quota' in entry && entry.last_observed_quota != null) {
      validateSnapshot(entry.last_observed_quota, email, 'last_observed_quota', err, warn);
    }

    // ── switch_history（可选、array<SwitchSnapshot>）─────────────────────────────────────────────────
    if ('switch_history' in entry && entry.switch_history != null) {
      if (!Array.isArray(entry.switch_history)) {
        err(`switch_history 必须是数组（当前：${JSON.stringify(typeof entry.switch_history)}）。`, email);
      } else {
        entry.switch_history.forEach((snap, i) => validateSnapshot(snap, email, `switch_history[${i}]`, err, warn));
      }
    }
  }

  // active 唯一性：至多一个 true（设计稿 §A.1 不变式3）。
  if (activeCount > 1) {
    err(`active 唯一性破坏：发现 ${activeCount} 个 active:true 的号（至多一个当前活跃号）。写侧切入新号时须把旧 active 号置 false。`);
  }

  return { errors, warnings };
}

// 递归扫一个 entry 的所有字符串叶子，发现疑似 token 值 / 疑似 token 字段名 → 硬 error。
//   绝不把命中的 token 值回显到 message（只报「字段 X 疑似含 token」，不贴值）。
//   **identity 子树豁免字段名启发式（安全关键·身份补全重构）**：identity 是 ~/.claude.json oauthAccount 的
//     原样透传（16 个非密标识字段·CC 官方定的键名，未来可能引入含 `oauth` 子串的字段名如 `oauthAccountId`）——
//     字段名启发式（FORBIDDEN_FIELD_RE）会把它们误杀。故进入 identity 子树后**只做值扫描（TOKEN_LIKE_RE
//     `sk-ant-` 仍全程生效·值里混进真 token 必拦），跳字段名扫描**。inIdentity flag 一旦置真，对整棵子树生效
//     （identity 内可嵌套对象，子层仍豁免字段名、保留值扫描）。这只放宽**字段名**启发式，绝不放宽值扫描——
//     identity 的键名非密、但任何叶子值若是 `sk-ant-` token 仍硬拒（token 绝不进 registry·安全命门不破）。
function scanForTokenLeak(node, email, err, fieldPath, inIdentity) {
  if (node == null) return;
  if (typeof node === 'string') {
    if (TOKEN_LIKE_RE.test(node)) {
      err(`字段 ${fieldPath || '(root)'} 的值疑似含 token（命中 sk-ant- 形态）——registry 绝不该含任何 token / 凭证值（只存 vault 引用指针）。值已隐去不回显。`, email);
    }
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const childPath = fieldPath ? `${fieldPath}.${k}` : k;
    // identity 子树（本层或祖先已进 identity）→ 豁免字段名启发式（CC 官方非密标识键名）。
    const childInIdentity = inIdentity || (!fieldPath && k === 'identity');
    // 字段名疑似存 token（纵深防御，拦字段名本身）——identity 子树内跳过（只对 identity 外字段拦字段名）。
    if (!childInIdentity && FORBIDDEN_FIELD_RE.test(k)) {
      err(`字段名 ${JSON.stringify(childPath)} 疑似用于存 token / 凭证（registry 只存 vault 非密引用，绝不存 token 字段）。`, email);
    }
    // 值扫描全程生效（含 identity 子树）——任何叶子值是 sk-ant- token 仍拦。
    scanForTokenLeak(v, email, err, childPath, childInIdentity);
  }
}

// 校验一个 SwitchSnapshot（last_switch_out / switch_history[]）：{ at, 5h:{used_pct,resets_at}, 7d:{...} }。
function validateSnapshot(snap, email, label, err, warn) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    err(`${label} 必须是对象（SwitchSnapshot）。当前：${JSON.stringify(snap)}。`, email);
    return;
  }
  if (typeof snap.at !== 'string' || !ISO_UTC_RE.test(snap.at)) {
    warn(`${label}.at 非严格 ISO-8601 UTC（当前：${JSON.stringify(snap.at)}）。`, email);
  }
  for (const wk of WINDOW_KEYS) {
    const w = snap[wk];
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      err(`${label}.${JSON.stringify(wk)} 必须是对象 { used_pct, resets_at }（当前：${JSON.stringify(w)}）。`, email);
      continue;
    }
    if (!Number.isInteger(w.used_pct) || w.used_pct < 0 || w.used_pct > 100) {
      err(`${label}.${wk}.used_pct 必须是 0-100 整数（当前：${JSON.stringify(w.used_pct)}）。`, email);
    }
    if (typeof w.resets_at !== 'string' || !ISO_UTC_RE.test(w.resets_at)) {
      warn(`${label}.${wk}.resets_at 非严格 ISO-8601 UTC（当前：${JSON.stringify(w.resets_at)}）；选号算法按它推算恢复度、失真会选错号。`, email);
    }
  }
}

// ── 读：loadRegistry(path?) → { schema, updated_at?, accounts } ────────────────────────────────────
// path 缺省走 defaultRegistryPath()。文件不存在 = 返回空池（不报错——无文件 = 天然单账号，设计稿 §F）。
// 坏 JSON = 抛清晰 error（不静默返垃圾——调用方该看到「registry 损坏」，自行决定降级单账号还是修）。
function loadRegistry(p) {
  const filePath = p || defaultRegistryPath();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // 文件不存在 = 天然单账号空池（设计稿 §F：无 accounts.json = effective-N 1）。
      return emptyRegistry();
    }
    throw e; // 权限 / IO 错等照实抛（不是「不存在」就不该静默吞）。
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    const why = (e && e.message) ? e.message : String(e);
    throw new Error(`accounts.json 不是合法 JSON（${filePath}）：${why}。请人工修复或删除该文件（删除 = 降级回天然单账号空池）。`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`accounts.json 顶层不是对象（${filePath}），解析出 ${Array.isArray(obj) ? '数组' : typeof obj}。`);
  }
  // 规整：保证 accounts 是对象、schema 有值（容忍历史/手写文件缺 schema，按 v1 当默认补；校验另说）。
  if (!obj.accounts || typeof obj.accounts !== 'object' || Array.isArray(obj.accounts)) {
    obj.accounts = {};
  }
  if (typeof obj.schema !== 'string') {
    obj.schema = SCHEMA;
  }
  return obj;
}

// 空池骨架（文件不存在 / 显式建空池）。
function emptyRegistry() {
  return { schema: SCHEMA, accounts: {} };
}

// ── 并发串行化：registry 读-改-写锁（codex round#7 Finding C·防并发 lost-update）──────────────────────
// 病根：saveRegistry 的 tmp+rename 只防**单次写**撕裂，挡不住「load→改→save」跨步的并发——两个换号/录号进程
//   各自 loadRegistry 拿到同一份旧态、各自改、后写的 rename 覆盖先写的改动（丢新增号 / active 反映错号）。
// 修：mutateRegistry(regPath, mutator) 在**整个 load-改-save 序列**外加一把咨询文件锁（O_EXCL lockfile·带重试 +
//   超时 + stale 回收），让并发的 RMW 串行执行——每个 mutator 在持锁期间 load 到**最新**态再改再存，消除 lost-update。
// token-blind 不变：锁文件只含非密 pid/时间戳·绝不碰 token；mutator 只动非密 registry（token 那一坨永在 vault）。
function lockPath(regPath) { return (regPath || defaultRegistryPath()) + '.lock'; }

// 同步睡眠 ms（让出 CPU·非 busy-spin）：Atomics.wait 在一个无人通知的 buffer 上等待，到时返回 'timed-out'。
//   node -e 单次调用是同步流程（无 event loop 调度点），故用它实现「真睡眠」；不可用时（极旧 node）退化到 busy-spin。
function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms | 0));
  } catch (_e) {
    const until = Date.now() + ms; while (Date.now() < until) { /* fallback busy-spin */ }
  }
}

// 取锁：O_EXCL 独占建 lockfile（已存在 = 别人持锁）。带重试（默认最多 ~5s）+ stale 回收（持锁进程已死 / 锁超
//   过 staleMs 视作残留·抢占）。返回锁句柄（{ path }）或抛错（超时未取到）。绝不写 token 进锁文件。
function acquireRegistryLock(regPath, opts) {
  const o = opts || {};
  const lp = lockPath(regPath);
  // timeout 默认 20s（registry RMW 每次都是毫秒级·20s 容得下数十个并发排队·又远短于会让用户以为卡死的时长）；
  //   CCM_REGISTRY_LOCK_TIMEOUT_MS 可 env 覆写。staleMs 默认 30s（持锁进程异常死亡的残锁回收窗口·远大于正常 RMW）。
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs
    : (Number.isFinite(Number(process.env.CCM_REGISTRY_LOCK_TIMEOUT_MS)) && Number(process.env.CCM_REGISTRY_LOCK_TIMEOUT_MS) > 0
        ? Number(process.env.CCM_REGISTRY_LOCK_TIMEOUT_MS) : 20000);
  // staleMs 默认 120s（残锁回收窗口）：registry RMW 是毫秒级，但**高负载 / CPU 饥饿下持锁进程可能被 OS 长时间
  //   descheduled**——staleMs 太小会**误判活着的持锁者为 stale 而抢占 → lost-update**。取 120s 远超任何真实 RMW、
  //   又仍能回收真正异常死亡的残锁（进程已死还有 pid 检测兜底）。CCM_REGISTRY_LOCK_STALE_MS 可 env 覆写。
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs
    : (Number.isFinite(Number(process.env.CCM_REGISTRY_LOCK_STALE_MS)) && Number(process.env.CCM_REGISTRY_LOCK_STALE_MS) > 0
        ? Number(process.env.CCM_REGISTRY_LOCK_STALE_MS) : 120000);
  const start = Date.now();
  // **livePid（codex round#13 Finding A·锁记录的 pid 必须在临界区期间活着）**：stale 判定靠 pid 存活性——若锁文件
  //   记的 pid 在临界区跑完前就退出（如 bash 经一次性 `node` 进程取锁、那 node 立即退出·临界区在 bash 里跑），
  //   并发对手会立刻把这个**已死 pid** 判 stale 破锁 → 锁形同虚设。故允许调用方传一个**会在临界区期间存活的 pid**
  //   （bash 的 `$$`·经 opts.livePid / 第 1 个 CLI arg）记进锁文件；缺省 = 本 node 进程 pid（node 内全程持锁的场景）。
  const livePid = (o && Number.isInteger(o.livePid) && o.livePid > 0) ? o.livePid : process.pid;
  // 确保父目录在（与 saveRegistry 一致）。
  try { fs.mkdirSync(path.dirname(lp), { recursive: true, mode: 0o700 }); } catch (_e) { /* best-effort */ }
  // **owner token（codex round#8 Finding A·防 stale 抢占后原持有者误删新锁）**：每次取锁生成一个唯一 token 写进锁
  //   文件；释放时只有锁文件里仍是**我的** token 才 unlink——若我已被判 stale、别人抢了锁（写了新 token），我 resume
  //   后 release 读到不是我的 token → 不删，不会误删新持有者的锁、不会让第三者并发进入临界区。
  const ownerToken = String(livePid) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  for (;;) {
    try {
      // wx = O_CREAT|O_EXCL：文件已存在则抛 EEXIST（别人持锁）。内容仅非密 pid+时刻+owner token（诊断 / stale / 归属判定用·零 token）。
      const fd = fs.openSync(lp, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: livePid, at: nowIso(), owner: ownerToken })); } catch (_e) { /* 内容 best-effort */ }
      fs.closeSync(fd);
      return { path: lp, owner: ownerToken };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e; // 非「已存在」的真错（权限等）→ 抛。
      // 锁已存在：判 stale → 抢占；否则等一会儿重试。
      // **pid 存活性是权威·绝不只凭 mtime 破锁（codex round#12 Finding B）**：旧码先按 mtime>staleMs 置 stale、再仅在
      //   !stale 时查 pid——于是一个**活着但慢/被 descheduled** 的持锁者，只要锁文件 mtime 老过阈值就被别人 unlink
      //   破锁 → 两进程同进临界区 → lost-update / vault 行复活。修：**先查 pid**——
      //     · pid 可读且**活着**（process.kill(pid,0) 成功）→ **永不 stale**（活持有者·无论 mtime 多老都不破）；
      //     · pid 可读且**已死**（ESRCH）→ stale（死持有者·安全回收）；
      //     · pid 不可读（锁文件坏 / 缺 pid）**且 mtime 老过 staleMs** → stale（坏锁兜底回收）；mtime 单独**绝不**破活锁。
      let stale = false;
      let observedOwner = null;   // stale 判定时观察到的 owner token·破锁前 compare-and-delete 用（codex round#13 Finding C）。
      try {
        const st = fs.statSync(lp);
        let pidKnown = false, pidAlive = false;
        try {
          const info = JSON.parse(fs.readFileSync(lp, 'utf8') || '{}');
          observedOwner = (info && typeof info.owner === 'string') ? info.owner : null;
          if (info && typeof info.pid === 'number') {
            pidKnown = true;
            try { process.kill(info.pid, 0); pidAlive = true; } // 活着 → 不抛。
            catch (ke) { if (ke && ke.code === 'ESRCH') pidAlive = false; else pidAlive = true; } // EPERM 等 = 进程在（别的用户/权限）→ 当活着·保守不破。
          }
        } catch (_e) { pidKnown = false; observedOwner = null; /* 锁文件坏 / 读不出 pid */ }
        if (pidKnown) {
          stale = !pidAlive;                         // 活 → 不破；死 → 回收。mtime 不参与（活锁绝不因老 mtime 被破）。
        } else {
          stale = (Date.now() - st.mtimeMs > staleMs); // 仅当 pid 不可读（坏锁）才退回 mtime 兜底回收。
        }
      } catch (_e) { /* stat 失败（锁刚被释放？）→ 下轮重试直接抢 */ }
      // **破 stale 锁前 compare-and-delete（codex round#13 Finding C·防破到别人的新锁）**：旧码据**早先**的 read/stat
      //   就直接 unlink——若 A 与 B 同时判一把 stale 锁、A 先删并取了**新锁**（新 owner），B 的 unlink 会删掉 A 的新锁、
      //   让第三者并发进入临界区。修：unlink 前**重读**锁文件确认 owner 仍是当初观察到的那个（stale 锁的 owner）才删；
      //   owner 已变（被别人抢/重建）→ 不删（不是同一把锁了），回去重试。owner 不可读（坏锁）则按原样删（兜底）。
      if (stale) {
        let okToUnlink = true;
        if (observedOwner != null) {
          try {
            const cur = JSON.parse(fs.readFileSync(lp, 'utf8') || '{}');
            if (cur && typeof cur.owner === 'string' && cur.owner !== observedOwner) okToUnlink = false; // 已易主 → 不是那把 stale 锁，绝不删。
          } catch (_e) { /* 读不出 = 坏锁/刚被删 → 按可删兜底（unlink 失败也无碍） */ }
        }
        if (okToUnlink) { try { fs.unlinkSync(lp); } catch (_e) { /* 竞争下别人已删·重试即可 */ } }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error('acquireRegistryLock：取 registry 锁超时（' + timeoutMs + 'ms）——另有进程长时间持锁（' + lp + '）。稍后重试，或确认无卡死进程。');
      }
      // 同步等待 ~15-25ms 再重试（node -e 单次调用里无 async 调度）。**用 Atomics.wait 真睡眠·让出 CPU**（而非
      //   busy-spin 烧满一核——高并发下 busy-spin 会让所有等锁进程争 CPU、拖慢持锁者 RMW、放大锁竞争·codex round#8 观察）。
      //   抖动一点（15 + rand*10）减少多进程同步唤醒的 thundering-herd。
      sleepSyncMs(15 + Math.floor(Math.random() * 10));
    }
  }
}

function releaseRegistryLock(handle) {
  if (!handle || !handle.path) return;
  // **只删属于自己的锁（codex round#8 Finding A）**：读锁文件确认 owner token 仍是我的才 unlink。若我曾被判 stale、
  //   别人已抢锁（owner 变了）/ 锁已被回收（文件不在），就**不删**——绝不误删新持有者的锁让第三者并发进入临界区。
  //   无 owner（旧式 handle / 读不出）则保守按「是我的」删（向后兼容·单进程场景无害）。
  try {
    if (handle.owner) {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(handle.path, 'utf8') || '{}'); } catch (_e) { cur = null; }
      if (cur && cur.owner && cur.owner !== handle.owner) return; // 锁已易主 → 不是我的，绝不删。
    }
    fs.unlinkSync(handle.path);
  } catch (_e) { /* 已被回收 / 不存在 → 无碍 */ }
}

// mutateRegistry(regPath, mutator) —— 在锁内做完整 load→mutate→save（消除并发 lost-update·codex round#7 Finding C）。
//   mutator(reg) 收**锁内 load 的最新 registry**、原地改它（调 upsertAccount/setActive/recordSwitchOut… 等助手）；
//   返回后本函数 saveRegistry 落盘、释放锁。任何异常都先释放锁再抛（绝不漏锁）。返回 saveRegistry 的落盘路径。
//   regPath 缺省 = defaultRegistryPath()。token-blind：只动非密 registry，锁文件零 token。
function mutateRegistry(regPath, mutator) {
  const rp = regPath || defaultRegistryPath();
  const handle = acquireRegistryLock(rp);
  try {
    const reg = loadRegistry(rp);   // 锁内 load 最新态（并发对手的改动若先落盘·这里能看到）。
    mutator(reg);                   // 原地改（调用方用 lib 助手）。
    return saveRegistry(reg, rp);   // 锁内落盘（原子 tmp+rename + 校验 + token-leak 拒写）。
  } finally {
    releaseRegistryLock(handle);    // 无论成功 / 抛错都释放锁（不漏锁）。
  }
}

// ── 通用文件锁（给 file vault 的「读-筛-写-rename」跨进程串行化用·codex round#9 Finding C）─────────────────
//   file vault（accounts.env）的重写在单进程内是原子（temp+rename），但**跨进程不串行**：delete 与 add/writeback
//   并发改同一 accounts.env 时各自筛旧快照、最后 mv 者赢 → 可能复活已删 token 行 / 丢另一个号刚写的 blob。
//   修：用与 registry 同一把锁原语（O_EXCL + owner token + stale 回收），锁住 vault 文件的整段 read-filter-write-rename。
//   withFileLock 是给 bash 用的薄封装：取 <vaultPath>.lock → 跑 fn() → 释放（无论成功/抛错·绝不漏锁）。
//   token-blind：锁文件只含非密 pid/at/owner·绝不碰 token；fn 内的 vault 重写仍是 bash 的事（只读前缀·不读值）。
//   注意：fn 在 node 里只能做 node 能做的（这里主要给 bash 当「持锁跑一段 shell」用·见下 acquireFileLock/releaseFileLock）。
function acquireFileLock(targetPath, opts) { return acquireRegistryLock(targetPath, opts); }
function releaseFileLock(handle) { return releaseRegistryLock(handle); }

// ── 写：saveRegistry(reg, path?) ──────────────────────────────────────────────────────────────────
// 原子写（写 tmp + rename）、mkdir -p 目录、0600 权限、刷新 updated_at。
// 写前过 validateRegistry——有 token-leak / 结构硬 error 就**拒写抛错**（永不把含 token 的 entry 落盘）。
function saveRegistry(reg, p) {
  const filePath = p || defaultRegistryPath();
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) {
    throw new Error('saveRegistry：reg 必须是 registry 对象。');
  }
  // 不改入参——克隆后规整 + 刷新 updated_at。
  const out = JSON.parse(JSON.stringify(reg));
  if (typeof out.schema !== 'string') out.schema = SCHEMA;
  if (!out.accounts || typeof out.accounts !== 'object' || Array.isArray(out.accounts)) out.accounts = {};
  out.updated_at = nowIso();

  // 写前校验——token-leak / 结构硬 error 一律拒写（安全命门：永不落盘含 token 的 registry）。
  const { errors } = validateRegistry(out);
  if (errors.length > 0) {
    const tokenLeak = errors.some((e) => /token|凭证|secret|credential/i.test(e.message));
    const head = tokenLeak
      ? 'saveRegistry 拒写：registry 含疑似 token / 凭证（安全命门——token 绝不进 accounts.json）。'
      : 'saveRegistry 拒写：registry 校验有硬 error（结构非法，落盘会污染号池）。';
    // 错误信息只列「哪个 account 的哪条规则」，绝不回显任何字段值（防 token 经报错泄漏）。
    const detail = errors.map((e) => (e.account ? `[${e.account}] ` : '') + e.message).join('\n  - ');
    throw new Error(`${head}\n  - ${detail}`);
  }

  // 原子写：写 tmp（同目录、0600）→ rename 覆盖（同分区 rename 原子）。umask 已不可靠（进程级），
  //   故显式 mode 0o600 建 tmp + 写后再 chmod 兜底（容忍 mode 在某些 fs/umask 下被掩）。
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.accounts.json.tmp-${process.pid}-${Date.now()}`);
  const json = JSON.stringify(out, null, 2) + '\n';
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600); // 兜底：writeFileSync 的 mode 受 umask 影响，显式再钉一次。
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o600); // rename 保留 tmp 的 mode，但目标若先存在则可能保留旧 mode——再钉一次。
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* tmp 清理 best-effort */ }
    throw e;
  }
  return filePath;
}

// ── entry 增删改助手（纯函数，原地改 reg 并返回 reg；绝不碰 token）──────────────────────────────────
// 注：助手**原地修改**传入的 reg 对象（读-改-写流程的「改」段），返回同一 reg 便于链式。
//   token 那一坨永远只进 keychain/file vault（CLI 的事），本库的助手只动非密引用 + 元信息。

// upsertAccount：插入或更新一个 email 的 entry（vault 引用 + 可选时间元信息）。绝不接受 token 字段。
function upsertAccount(reg, email, fields) {
  requireEmail(email);
  const f = fields || {};
  ensureAccounts(reg);
  // 防 token 误入：调用方传进来的 fields 不该含 token——主动拒（不等到 saveRegistry 才发现）。
  assertNoTokenInFields(f);
  const prev = reg.accounts[email] || {};
  const entry = Object.assign({}, prev);
  if (f.vault !== undefined) entry.vault = f.vault;
  if (f.token_added_at !== undefined) entry.token_added_at = f.token_added_at;
  if (f.token_refreshed_at !== undefined) entry.token_refreshed_at = f.token_refreshed_at;
  if (f.token_expires_at !== undefined) entry.token_expires_at = f.token_expires_at;
  // subscription_type：非密订阅档枚举（来自 vault blob.subscriptionType）。普通枚举（max/pro/…），不触
  //   sk-ant- 形态，assertNoTokenInFields 不会误拦。可选——录号/换号若拿到 blob 即透传，缺则不写。
  if (f.subscription_type !== undefined) entry.subscription_type = f.subscription_type;
  // identity：非密身份对象（= ~/.claude.json oauthAccount 原样透传·16 字段·身份补全重构）。原样透传，不做
  //   字段白名单（CC 升级自动跟上）。**token-leak 兜底（安全关键）**：assertNoTokenInFields 只查 string 顶层值、
  //   跳对象——故 identity 对象不会被它早扫。这里对 f.identity 单独跑一次带 identity 豁免 flag 的 scanForTokenLeak
  //   （只豁免字段名启发式·保留值扫描）——若 identity 任何叶子值混进 sk-ant- token，saveRegistry 前即抛错拦下。
  if (f.identity !== undefined) {
    if (f.identity != null) {
      const leak = [];
      scanForTokenLeak(f.identity, email, (m) => leak.push(m), 'identity', true);
      if (leak.length > 0) {
        throw new Error(`upsertAccount：identity 子树值疑似含 token（命中 sk-ant- 形态）——身份字段全非密、绝不该含 token 值。值已隐去；identity 不写入。`);
      }
    }
    entry.identity = f.identity;
  }
  // switchable：非密 boolean（残缺号标注·P2）。FORBIDDEN_FIELD_RE 不命中。可选——缺则不写（视作可切）。
  if (f.switchable !== undefined) entry.switchable = f.switchable;
  // active：upsert 默认不动 active（设计稿 §A.5：add 不自动设 active，active 只由 switch 切入时设）。
  //   新 entry 缺 active 时补 false（保证窄腰字段在）。
  if (typeof entry.active !== 'boolean') entry.active = false;
  reg.accounts[email] = entry;
  return reg;
}

// removeAccount：删一个 email 的 entry（vault 删项 / 删行是 CLI 的事，本助手只删 registry entry）。
function removeAccount(reg, email) {
  requireEmail(email);
  ensureAccounts(reg);
  delete reg.accounts[email];
  return reg;
}

// setActive：把指定 email 置 active=true、其余全 false（维护 active 唯一性不变式）。
//   email 不在池中 = 抛错（不静默——切入一个不存在的号是 bug）。
function setActive(reg, email) {
  requireEmail(email);
  ensureAccounts(reg);
  if (!(email in reg.accounts)) {
    throw new Error(`setActive：email ${JSON.stringify(email)} 不在号池中，无法置 active。`);
  }
  for (const [k, entry] of Object.entries(reg.accounts)) {
    if (entry && typeof entry === 'object') entry.active = (k === email);
  }
  return reg;
}

// recordSwitchOut：写一个 email 切出时的配额快照到 last_switch_out（+ append switch_history）。
//   snap = { at, fiveHour:{used_pct,resets_at,source?}, sevenDay:{...} } —— 用 JS 友好 key（fiveHour/
//   sevenDay）作 API 入参，落盘时映射回 schema 的 "5h"/"7d"（避免调用方写 reg["5h"] 这类别扭 key）。
function recordSwitchOut(reg, email, snap) {
  requireEmail(email);
  ensureAccounts(reg);
  if (!(email in reg.accounts)) {
    throw new Error(`recordSwitchOut：email ${JSON.stringify(email)} 不在号池中。`);
  }
  const s = snap || {};
  const five = s.fiveHour || s['5h'] || {};
  const seven = s.sevenDay || s['7d'] || {};
  const snapshot = {
    at: s.at || nowIso(),
    '5h': normalizeWindow(five),
    '7d': normalizeWindow(seven),
  };
  const entry = reg.accounts[email];
  entry.last_switch_out = snapshot;
  // switch_history append（设计稿 §A.6：写侧先只写 last_switch_out + append history；T1 不强制 history，
  //   但助手提供 append 能力，留给 T4 决定是否写——这里保守 append，便于复盘且封顶交由调用方）。
  if (!Array.isArray(entry.switch_history)) entry.switch_history = [];
  entry.switch_history.push(snapshot);
  return reg;
}

// recordObservedQuota：写一个 email 录号（add/refresh）那刻观察到的配额快照到 last_observed_quota。
//   形态与 recordSwitchOut 的 last_switch_out 完全相同（{ at, 5h, 7d }），入参也用 JS 友好 key
//   （fiveHour/sevenDay）→ 落盘映射回 "5h"/"7d"。**与 last_switch_out 的区别（语义、非形态）**：
//     · last_switch_out = 该号**切出时**的真实配额（select 高信任，按它推算恢复度）；
//     · last_observed_quota = 录号那刻 **session 当前号**的配额视角（cc-usage 只反映当前 session 账号，
//       未必是被录号——仅当录的就是当前号时才准）。故 select 只把它当**弱信号兜底**（无 last_switch_out
//       时才用、且信任度更低）。本助手只写形态、不判信任（信任分级在 select-account.js）。
//   **不 append history**（它不是 switch 事件、只是注册时刻的一次性观察快照，每次 refresh 覆盖即可）。
//   token-blind：只接非密 used_pct/resets_at/source，绝不碰 token（同 recordSwitchOut）。
function recordObservedQuota(reg, email, snap) {
  requireEmail(email);
  ensureAccounts(reg);
  if (!(email in reg.accounts)) {
    throw new Error(`recordObservedQuota：email ${JSON.stringify(email)} 不在号池中。`);
  }
  const s = snap || {};
  const five = s.fiveHour || s['5h'] || {};
  const seven = s.sevenDay || s['7d'] || {};
  const snapshot = {
    at: s.at || nowIso(),
    '5h': normalizeWindow(five),
    '7d': normalizeWindow(seven),
  };
  reg.accounts[email].last_observed_quota = snapshot;
  return reg;
}

// 规整一个窗口快照子结构 { used_pct, resets_at, source? }（source 是 B.7 信任分级字段，可选透传）。
function normalizeWindow(w) {
  const out = {
    used_pct: w.used_pct,
    resets_at: w.resets_at,
  };
  if (w.source !== undefined) out.source = w.source; // 账户权威 vs local-derived-approx（B.7 信任分级）。
  return out;
}

// ── email 安全 helper（给 T3/T4 的 bash file-vault 行操作用）──────────────────────────────────────
// 设计稿 §A.4 必修 bug：email 含 `.`/`@`，是正则元字符。switch-account.sh `read_token_file` 用
//   `grep -m1 "^${ACCOUNT}_TOKEN="`、account-add.sh `store_token_file` 用 `grep -Ev "^${ACCOUNT}_..."`——
//   email 里的 `.` 在 BRE/ERE 下匹配任意字符，`alice@x.com` 会误匹配 `alicexxxcom`，**静默取错/删错行**。
//
// 本库用 JSON 对象 key 存取 registry，天然不涉 grep、对 email 元字符免疫。但 file vault 是 bash 脚本
//   的领域，本 helper 给后续 T3/T4 实现者**明确接口 + 安全契约**：file vault 的行操作**必须用定字符串
//   匹配**（grep -F / awk 精确比较 `$0` 前缀），**绝不用 grep -E / 默认 BRE 的 `^email_` 正则**。
//
// fileVaultLineMatch(email) → {
//   prefix:        `<email>_`            —— vault 行前缀（fixed-string，喂 awk index($0,p)==1）
//   tokenLine:     `<email>_TOKEN=`      —— token 行的 fixed-string 前缀
//   expiresLine:   `<email>_EXPIRES=`    —— expires 行的 fixed-string 前缀
//   grepFixedToken: 'grep -F -- "<prefix>" file'  —— **历史字段，已被 P2-5 弃用于「读 token 行」**（见下）
//   awkFieldGuard: awk 安全比较表达式（等号前字段精确等于前缀，绝不用正则）
//   note:          一句话纪律给实现者
// }
// **用法（T3/T4·P2-5 后已统一到 awk index 行首锚定）**：
//   - 取 token 行：`awk -v p="$(... .tokenLine)" 'index($0,p)==1' "$vaultFile" | head -1`（行首锚定·定字符串·对 `.`/`@` 免疫）。
//   - 删某 email 的行：`awk -v p="$(... .prefix)" 'index($0,p)!=1' "$vaultFile"`（精确前缀、非正则）。
//   - **绝不** `grep -E "^${email}_TOKEN="`（email 的 `.` 会误匹配——这正是 §A.4 的 bug）。
//   - **读 token 行也绝不 `grep -F`（P2-5）**：`grep -F` 虽免疫元字符，却是**子串**匹配、**非行首锚定**——
//     重叠标识（`xalice@x.com_TOKEN=` 排在 `alice@x.com_TOKEN=` 之前）下会先命中前者，随后 `${line#prefix}`
//     因前缀不在行首而不剥离 → 整行畸形当 token 注入。`grepFixedToken` 字段仅作历史兼容保留，**新代码绝不用它读 token**，
//     一律 `awk index($0,p)==1`（switch-account.sh `read_token_file` 已是此形态）。
function fileVaultLineMatch(email) {
  requireEmail(email);
  const prefix = `${email}_`;
  return {
    prefix,
    tokenLine: `${email}_TOKEN=`,
    expiresLine: `${email}_EXPIRES=`,
    // grepFixedToken/grepFixedExpires：**历史字段（P2-5 弃用于读 token 行）**。grep -F 免疫元字符但是子串匹配、
    //   非行首锚定——重叠标识下取错行→整行畸形当 token。仅作向后兼容保留，**读 token 一律用 awk index($0,p)==1**（下方 awkFieldGuard）。
    grepFixedToken: `grep -F -- ${shArg(`${email}_TOKEN=`)}`,
    grepFixedExpires: `grep -F -- ${shArg(`${email}_EXPIRES=`)}`,
    // awk 精确前缀守卫（**读/删/写一律用这个**）：index($0, prefix)==1 表示行以 prefix 起头（行首锚定·非正则·对 `.`/`@` 免疫）。
    //   读 token 行：`awk -v p=<tokenLine> 'index($0,p)==1'`；删行时取反：`awk -v p=<prefix> 'index($0,p)!=1'`。
    awkFieldGuard: `index($0, p) == 1`,
    note: 'file vault 行操作必须用 awk index($0,p)==1 行首锚定（定字符串前缀比较），绝不用 grep -E/BRE 的 ^email_（email 的 . 是正则元字符会误匹配·§A.4），读 token 行也绝不用 grep -F（子串匹配·非行首锚定·重叠标识下取错行→整行畸形当 token·P2-5）。',
  };
}

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────────────
// 当前时刻的严格 ISO-8601 UTC（秒精度、Z 后缀、定宽）。Date#toISOString 出毫秒（...sssZ），裁到秒。
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ensureAccounts(reg) {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) {
    throw new Error('reg 必须是 registry 对象。');
  }
  if (!reg.accounts || typeof reg.accounts !== 'object' || Array.isArray(reg.accounts)) {
    reg.accounts = {};
  }
}

function requireEmail(email) {
  if (typeof email !== 'string' || !email) {
    throw new Error(`email 必须是非空字符串（当前：${JSON.stringify(email)}）。`);
  }
}

// 防 token 误入助手字段（upsert 时主动拒，不等到 saveRegistry）。绝不回显命中的值。
function assertNoTokenInFields(fields) {
  for (const [k, v] of Object.entries(fields || {})) {
    if (FORBIDDEN_FIELD_RE.test(k)) {
      throw new Error(`upsertAccount：字段名 ${JSON.stringify(k)} 疑似存 token / 凭证——registry 只存 vault 非密引用，绝不存 token。`);
    }
    if (typeof v === 'string' && TOKEN_LIKE_RE.test(v)) {
      throw new Error(`upsertAccount：字段 ${JSON.stringify(k)} 的值疑似含 token（命中 sk-ant- 形态）——值已隐去；registry 绝不存 token 值。`);
    }
  }
}

// POSIX sh 单引号转义（给 shArg 用，让 helper 返回的命令片段嵌进 bash 安全）。
function shArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  // 常量（供测试 / 调用方复用）。
  SCHEMA,
  ISO_UTC_RE,
  VAULT_KINDS,
  // 路径。
  defaultRegistryPath,
  // 核心读写校验。
  validateRegistry,
  loadRegistry,
  saveRegistry,
  emptyRegistry,
  // 并发串行化锁（codex round#7 Finding C·防并发 lost-update）。
  mutateRegistry,
  acquireRegistryLock,
  releaseRegistryLock,
  // 通用文件锁（codex round#9 Finding C·file vault 跨进程串行化）。
  acquireFileLock,
  releaseFileLock,
  // entry 助手。
  upsertAccount,
  removeAccount,
  setActive,
  recordSwitchOut,
  recordObservedQuota,
  // email 安全 helper（给 T3/T4 file vault bash 用）。
  fileVaultLineMatch,
  // 小工具（导出便于测试 / 调用方）。
  nowIso,
};
