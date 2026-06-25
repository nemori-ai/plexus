# 选号调度算法 —— 方法论

> 这是 SKILL.md「选号 + 换号」的方法论展开。`${CLAUDE_SKILL_DIR}/scripts/select-account.js` 是它的落地实现——本文讲**为什么这么选**，脚本讲**怎么算**；权重 / 阈值是脚本顶部可 env 覆写的常量（见下表）。本文不复制代码，只蒸馏判据。

## Contents

- [目标](#目标)
- [单窗口恢复度推算](#单窗口恢复度推算)
- [单号可用度评分（7d 硬总闸）](#单号可用度评分7d-硬总闸)
- [选号主流程](#选号主流程)
- [权重与阈值（可 env 覆写）](#权重与阈值可-env-覆写)
- [source 信任分级（最大精度风险）](#source-信任分级最大精度风险)
- [边界处理](#边界处理)
- [落点纪律（红线 1）](#落点纪律红线-1)

## 目标

给定此刻 `now`，从 registry 里所有**非 active 且 token 未过期**的号中，选一个**预计可用配额最优**的号切入。「可用配额最优」= 综合 5h + 7d 两个窗口、按各自 reset 推算「现在恢复了多少」。算法**只读 accounts.json 的非密元信息**（`last_switch_out` 快照），完全不碰 token——它是 token-blind 的。

## 单窗口恢复度推算

对一个号的某窗口（5h 或 7d），用切出快照 `{used_pct, resets_at}` + `now` 推算「现在的 used_pct」：

- **`now >= resets_at`**（已过 reset）→ 窗口刷新满血，`recovered_used_pct = 0`。
- **`now < resets_at`**（未过 reset）→ 配额还没恢复，**保守仍按切出时的 `used_pct`**。

**为何用保守二值（不插值）**：5h/7d 是**滚动**窗口、配额是**渐进**恢复的，所以「未过 reset 就当没变」是低估恢复。但账户口径**不给绝对 token 分母 + 不给 burn rate**（cost-and-pacing 诚实天花板），无法精确插值——线性插值是未经验证的精度假设，可能选错。二值版在「选哪个号最优」的**相对排序**上多数够用（过 reset 的号一定优于没过的）。多个号都未过 reset 时，二值版看不出谁离 reset 更近 → 用 **`resets_at` 早晚当 tiebreaker**（更早彻底满血者优），补这块盲区而不引入插值假设。

## 单号可用度评分（7d 硬总闸）

把一个号的 5h + 7d 恢复度合成一个可用度分。**关键非对称：7d 是硬总闸**——7d 已逼顶的号即便 5h 满血也几乎没用（切进去马上又被 7d 卡）：

- `p5 = recovered_used_pct(5h)`，`p7 = recovered_used_pct(7d)`。
- **`p7 >= SEVEN_DAY_HARD_GATE`（默认 85）→ 该号判作几乎不可用**（极低分 `SCORE_UNUSABLE`，排在所有正常号之后），对齐 `usage-pacing.js` 的 dispatch gate。
- 否则 `score = W5 × (100 - p5) + W7 × (100 - p7)`——两窗口各自剩余额度加权，**7d 加权更重**（它是跨窗口总闸、最易不知不觉逼顶）。

## 选号主流程

1. **筛候选**：跳过 active 号、跳过 token 已过期的号（切进去认证失败）、跳过 `switchable:false` 残缺号（只含 access token、无 refresh token——无重启换号靠 refreshToken 续期，切不进，`select-account.js` 硬排除并附「重跑 `--add` 录完整 blob」提示）。缺省 / 未设 `switchable` = 视作可切（不破既有完整号）。
2. **打分**：无历史新号（`last_switch_out == null`）视作满血、`SCORE_FRESH_FULL` 最优先；有历史的按上面 `account_score`；再 `apply_expiry_penalty`（临到期降权）。
3. **排序**：score 降序；tiebreak = `resets_at` 更早者优。
4. **裁决**：
   - 候选空 → `NONE`（无备号 / 单账号场景），保持现状。
   - 最优分 ≤ `SCORE_UNUSABLE_FLOOR` → `NONE_ALL_EXHAUSTED`（全员逼顶/不可用），**surface 用户**别盲切（脚本 exit 3）。
   - 否则返回 best email（脚本 stdout 纯 email，exit 0）。

## 权重与阈值（可 env 覆写）

`select-account.js` 把这些做成顶部常量 + env 覆写，便于 dogfood 调而不改逻辑：

| 常量（env 覆写名） | 默认 | 语义 |
|---|---|---|
| `SEVEN_DAY_HARD_GATE`（`CCM_SELECT_7D_HARD_GATE`） | 85 | 7d used% ≥ 此 → 号几乎不可用（对齐 usage-pacing dispatchGate / 85% 闸）。 |
| `W5`（`CCM_SELECT_W5`） | 0.4 | 5h 短窗、恢复快，权重低些。 |
| `W7`（`CCM_SELECT_W7`） | 0.6 | 7d 跨窗口总闸，选号优先看它的余量。 |
| `EXPIRY_WARN_DAYS`（`CCM_SELECT_EXPIRY_WARN_DAYS`） | 14 | token 距到期 ≤ 此天数 → 降权。 |
| `EXPIRY_PENALTY`（`CCM_SELECT_EXPIRY_PENALTY`） | 40 | 临到期大幅降权但不归零（号还能用、只是该续期）。 |
| `LOCAL_APPROX_TRUST`（`CCM_SELECT_LOCAL_APPROX_TRUST`） | 0.85 | local-derived-approx 来源快照的信任折扣（见下）。 |

> **W5/W7 是最该 dogfood 调的旋钮**：0.4/0.6 是直觉起点、无实证。真换号场景下观察「按这权重选的号是否真更经烧」回流调整。

## source 信任分级（最大精度风险）

切出快照的 `{5h,7d}` 各带一个 `source`：`"account"`（账户权威 `used_percentage` + `resets_at`）或 `"local-derived-approx"`（cc-usage.sh 降级——没接 statusline-capture / headless 时反推）。

**`local-derived-approx` 的 `resets_at` 是反推、可能失真到数量级**（Finding #37）——基于它的恢复推算不可信。算法的处置：任一窗口来源是 `local-derived-approx` → 整号评分乘信任系数 `LOCAL_APPROX_TRUST`（默认 0.85，粗排），并在 warnings 里**告知口径不可靠**。`account` 来源 = 1.0（权威）。**这是选号精度的最大风险点**——算法只保证**相对排序方向性正确**，不承诺精确；真换号必 dogfood 验证选出的号是否真更经烧。

## 边界处理

| 边界 | 处理 |
|---|---|
| 无历史新号（`last_switch_out == null`） | 视作满血、最优先（乐观假设：从没用过通常确实最经烧）；切入后第一次 pacing 探测拿真实 used% 纠正认知。 |
| token 已过期 | 排除候选（切进去认证失败）。 |
| `switchable:false` 残缺号 | 排除候选 + warning（只含 access token、无 refresh token，无重启换号切不进）；缺省/未设 = 视作可切。 |
| token 临近到期（≤ `EXPIRY_WARN_DAYS`） | 不排除、`EXPIRY_PENALTY` 降权 + 返回时附「X 天后到期、建议 refresh」提示。 |
| 全员逼顶 / 不可用 | `NONE_ALL_EXHAUSTED`（exit 3），surface 用户（`blocked_on:"user"`），别盲切。 |
| 无备号（候选空） | `NONE`，保持现状（单账号天然行为）。 |
| registry 不存在 / 坏 JSON | 选号不可用 → 降级单账号，绝不崩（fail-safe）。 |

## 落点纪律（红线 1）

选号算法是 `switch-account.sh` 切号前调用的逻辑——它**不进 hook**，是带外脚本（node·ADR-006 允许）。hook 注入号池信息时只注「号池有 N 个可用备号」这类**粗粒度事实**，**绝不在 hook 里跑完整选号**（避免把调度逻辑塞进 hook + 红线 1 风险 + 复杂度）。
