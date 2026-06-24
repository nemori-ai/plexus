---
name: grounding-skill-evals
description: 'Use when measuring a cc-master skill — 当你写完一个 skill 的 body 要度量它好不好、要迭代它、或在改 description / 纪律段前后想知道改动有没有用时. Triggers: 写完 body 要量化、给 skill 写 OBJECTIVE.md、跑 trigger 准确率 eval、改 description 前后比 accuracy、防 description 过拟合 / 防自欺、读 eval 判决. Do NOT use for writing the skill body itself (→ cc-master-skillsmith) or deciding whether a skill should exist at all / portfolio 准入 (→ curating-skill-portfolios).'
---

# grounding-skill-evals —— 怎么度量一个 cc-master skill

> **这是项目自用的 dev skill，不随插件分发。** 它住在 `.claude/skills/`（给 cc-master 自己的贡献者用），不在 `skills/`（那是 ship 给插件用户的）。终端用户装 cc-master 永远看不到它——它只为度量*本仓*的 skill 而存在。

## Overview

这个 skill 回答一个问题：**「这个 skill 到底好不好，怎么用数据说话？」**

它不写 skill 的 body（那是 `cc-master-skillsmith`），也不判断一个 skill 该不该存在（那是 `curating-skill-portfolios`）。它只管**度量**——给一个已经写出 body 的 skill 声明一份可消费的成功契约（J），接上本仓已有的三个 eval 脚本，并用三个借来的思想防止「自己骗自己说改好了」。

**核心原则：度量先于迭代。** 没有声明 J（成功 = 什么），评测就会逐 case 漂移、优化就会 reward-hack 碰巧在视野里的那个指标。没有 baseline、没有 holdout、没有改前预测，「我感觉改好了」就是在自欺。

> **本 skill 只借三个思想，不搬引擎。** 成熟的 skill 评测 / 优化方法论有一整套重型机器（重型 J 不变量集、多字段机器可读裁决 schema、带自动搜索 + 多候选 filter 的优化引擎、Pareto 前沿追踪、统计显著性 / 方差分析预检）。**本仓体量用不上**，只借 baseline-must-fail / holdout split / predict-then-validate 三个判别力思想，落在纯 prose checklist + 现有脚本上。任何「补个搜索引擎 / 加个多字段裁决 schema」的冲动都是照搬过度工程（红线——过度工程的边界见本 skill 的 When NOT to use / OUT of scope 与 `DESIGN.md` 的「不做」段）。

## When to use

- 刚给一个 skill 写完或改完 body，想要一份独立的成功度量再迭代。
- 要给本仓某个 skill 写 / 修 `OBJECTIVE.md`（轻量 J）。
- 改一个 skill 的 `description` 前后，想知道触发准确率（precision/recall/accuracy）有没有真的提升——跑 Track A。
- 改一个 skill 的纪律段 / 行为，想知道 with-skill vs without-skill 的行为差有没有真的拉开——跑 Track B。
- 怀疑 description 优化「过拟合到我脑子里那几个 query」——要 holdout split 验证。
- 改动前想立个可证伪的预测、改完比对——predict-then-validate 防自欺。

## When NOT to use（明确反例 + 移交）

- **要写 / 改一个 skill 的 body**（craft 诊断、命名锚、流程骨架、纪律段怎么写）→ **`cc-master-skillsmith`**。本 skill 度量 body，不生产 body。
- **要决定一个 skill 该不该建 / 该是 skill 还是 reference / 一组 skill 边界与重叠**（portfolio 准入）→ **`curating-skill-portfolios`**。本 skill 假设 skill 已存在且值得度量；「值不值得存在」是上游问题。
- **要跑纯定性 pressure baseline**（看纪律段在压力下被不被合理化绕过）→ 那是 `cc-master-skillsmith` 的 Iron Law 闭环。本 skill 的 baseline-must-fail 是它的**定量延伸**，不替代它。

## 轻量 J 入口（5 分钟，不是 5 小时）

J（objective function）= 这个 skill「成功 = 什么」的机器可读答案，落在每个 skill 目录的 `OBJECTIVE.md`。**本仓的 J 是轻量的**：一句话 `J_top` + 一段 `baseline_reference`（没这 skill 的 agent 会怎样退化）+ 1-2 个不可回退的 `strict_dims`。就这么多——不要膨胀成重型 J 不变量集那种 schema。

最小入口（完整 schema、判据、正反例在 [`references/objective-function.md`](references/objective-function.md)）：

1. **写 `J_top`**——一句话：这个 skill 让 agent 在什么上成功。不是 description（那是触发器），是成功的承重定义。
2. **写 `baseline_reference.without_skill_floor`**——≤3 行：没有这个 skill 的默认 agent 会怎样做差。**写得足够具体，让「这个 skill 打败它」是可判定的，不是口号。**
3. **挑 1-2 个 `strict_dims`**——不可回退的承重维度。**不能全空**（全空 = J 不约束任何东西，迭代可以丢掉一切还自称进步），**也不能全锁**（全锁 = 没有探索空间）。

> **J ≠ description。** description 是触发期的消歧器（prose、流动、随版本演化）；J 是结构性承诺（声明一次、稳定、被 Track A/B 当锚消费）。两者职责分开——改 description 跑 Track A，改 J 是改成功定义本身。

## 接现有 Track A + Track B + codex 第二评委（不重造）

本仓**已有**三个 eval 脚本。本 skill 的纪律是**接它们、读它们的判决**，不是再造一套（怎么跑、怎么读判决的完整步骤在 [`references/track-ab-discipline.md`](references/track-ab-discipline.md)）：

| 设施 | 脚本 | 量什么 | 何时跑 |
|---|---|---|---|
| **Track A —— 触发准确率** | `scripts/eval-trigger.sh <skill>` | `description` 在 should-trigger + near-miss query 上的 precision/recall/accuracy | 任何 `description` 改动**前后各一遍**比 accuracy |
| **Track B —— 编排纪律 benchmark** | `scripts/eval-benchmark.sh <iter-dir> <skill>` | with-skill vs without-skill 的行为断言，各 3 run 看 mean±stddev | behavioral 改动（纪律段 / 流程）前后 |
| **codex 第二评委** | `scripts/codex-review.sh [--base <branch>]` | 非-Claude 端点对同一 diff / transcript 出 `approve | needs-attention` | grader 后跑，分歧 = 高信号 |

**generator ≠ judge（红线级，呼应 cc-master「端点验收 / gate-green ≠ passed」）：** 生产 body 的 actor 和评判的 actor 必须分离。同家族评委给同家族产出打分，pass-rate 虚高约 33%。所以 Track B 的 grader 后**必须**跑 codex 当第二评委——它是非-Claude 端点，与 Claude 产出/评判家族分离。codex `approve` + 非空 + 已读 diff → 信；`needs-attention` / 空 review / OAuth 过期 → 按**未通过**处理（silent-pass-through guard，不静默放行）。

> **`scripts/` 不进 `hooks/`（红线 1 / ADR-006，ship-anywhere）：** 这三个脚本都依赖 `uv` + Python 3.12 + `claude`/`codex` CLI，**只许进 `scripts/`（带外手动 / 编排调用），绝不进 `hooks/`**（hook 只允许 bash + node/JS——Claude Code 保证存在的 runtime；`uv`/python/`claude`/`codex` 不在其中）。将来本 skill 若要补新工具脚本，同样只进 `scripts/`。

## 只借的三个思想（baseline-must-fail / holdout / predict-then-validate）

这三个是本 skill 的判别力内核——都是**思想**，不是引擎（完整配方 + 正反例在 [`references/anti-overfit-lite.md`](references/anti-overfit-lite.md)）：

1. **baseline-must-fail**——每个 eval case 必须在「没有该 skill」时**可证失败**。两臂都过的 case = 零证据（它没区分有没有 skill）。所以**先跑 baseline 臂（without-skill），确认它真的失败，再跑 with-skill 臂**——否则正向证据会先入为主。cc-master 的 pressure baseline 已是它的**定性版**；这里是定量延伸。

2. **holdout split**——把 should-trigger / near-miss query 分成 `train` / `holdout` 两组（默认 70/30）。**只在 train 上调 description，用 holdout 验证。** train 上好、holdout 上崩 = 过拟合到了那组 query（你优化的是「背答案」不是「会判别」）。

3. **predict-then-validate**——改 description / 纪律前，**先写下预测的 delta**（「我预期 accuracy 从 X 升到 Y / 这条 case 会从 fail 翻成 pass」），改后比对实测。**预测对** = 你真的理解了机制；**预测频繁错** = 你在碰运气 + 把噪声当真有效。结构性改动（删一段、加一条硬规则）预测准；纯 prose 措辞策略改动预测准度骤降——准度本身就是信号。

### baseline-must-fail 的强模型天花板（本仓 dogfood 观测）

当一个有能力的模型在单次决策里能自推出纪律选项，RED 不会失守——这**不证明 skill 无价值**，而是说该 skill 的价值在**一致性**（每次都对，含弱模型 / compaction 后退化的 context）、**触发**（想起来要用）、**更硬的边界**，而非翻转一次 fresh 强模型的高压决策。此时判据①的诚实证据 =「GREEN 守住 + 精准引用 skill 段落 + 内容经独立审查判对 + 文档化这道天花板」，而非伪造一个 RED 失败（加压到崩只证明『够压能压垮任何 agent』，是假证据）。

> 这是本仓真实 dogfood 观测——本会话三轮鉴别性 baseline 都未能让强模型 RED 失守，不是凭空规则。强模型 RED 不失守时，不要为了凑一个「baseline 可败」而加压到崩；那制造的是噪声，不是判别力。

## Quick Reference

| 你要做 | 用什么 | 去读 |
|---|---|---|
| 给一个 skill 声明 / 修 J | 写 `OBJECTIVE.md`（J_top + baseline_reference + strict_dims） | [`references/objective-function.md`](references/objective-function.md) |
| 改了 `description`，量触发准确率 | `scripts/eval-trigger.sh <skill>`（前后各一遍比 accuracy） | [`references/track-ab-discipline.md`](references/track-ab-discipline.md) |
| 改了纪律段 / 行为，量行为差 | `scripts/eval-benchmark.sh`（各 3 run，mean±stddev） | [`references/track-ab-discipline.md`](references/track-ab-discipline.md) |
| 拿非-Claude 端点二审 | `scripts/codex-review.sh`（generator≠judge） | [`references/track-ab-discipline.md`](references/track-ab-discipline.md) |
| 定演化节奏（description 高频 / body 低频）、找回滚锚 | 评估成本分层 + git 谱系（每次演化独立 commit） | [`references/track-ab-discipline.md`](references/track-ab-discipline.md) §7 |
| 防 description 过拟合 | holdout split（train/holdout 70/30） | [`references/anti-overfit-lite.md`](references/anti-overfit-lite.md) |
| 防自欺（碰巧当有效） | predict-then-validate（改前写预测、改后比对） | [`references/anti-overfit-lite.md`](references/anti-overfit-lite.md) |
| 保证 case 有判别力 | baseline-must-fail（两臂都过的 case 零证据） | [`references/anti-overfit-lite.md`](references/anti-overfit-lite.md) |

## Common Mistakes

- **自检即完成。** 「我自己看了一遍 transcript，感觉行为对了」不是判决。**自检不算完成——要独立端点判决**（Track A 的数字 / Track B 的 grader + codex 第二评委）。「looks fine」从来不构成 passed。**违背这条字面就是违背精神**：你没法用「我读了一遍很有信心」绕过「跑了 eval 拿到数字」——有信心 ≠ 有证据。
- **baseline 不会败也照用。** 一个两臂（有/无 skill）都过的 case 证明不了任何东西——它对「这 skill 有没有用」零判别力。**baseline 必须可败**：每个 case 必须在 without-skill 臂可证失败，否则它不该进 eval set（reject-and-surface，别静默留着凑数）。**违背这条字面就是违背精神**：「这个 case 虽然两臂都过，但它测的是另一个维度」——那它就该去那个维度的 baseline-fail case set，不是留在这里冒充判别力。
- **同家族自己给自己打分。** 用 Claude 产出、又用 Claude 评判，pass-rate 虚高约 33%。**generator ≠ judge**——Track B 必须跑 codex 第二评委，分歧才是高信号。
- **只看 train 不看 holdout。** 在你脑子里那几个 query 上把 description 调到满分，holdout 上崩盘——这是过拟合，不是改进。永远留 holdout。
- **改前不预测。** 改完跑 eval，数字变好了就宣布胜利——分不清是真有效还是噪声。**改前写预测的 delta**，比对了才知道。
- **把 J 写成 description 的复读。** J 是成功度量（被 eval 当锚消费），description 是触发器。J 复读 description = 没有可消费的成功契约。
- **想给本仓补个自动搜索优化引擎 / 多维优化前沿 / 多字段裁决 schema。** 那是重型方法论的引擎，本仓体量是 overkill。**只借思想，落在 prose + 现有脚本上。**

## Red Flags —— STOP，你在自欺

- 宣布「这 skill 改好了」但**没有跑 Track A/B 拿到数字**——只有「我感觉」。
- 用的 eval case **没有一个在 without-skill 时会失败**——它们对「有没有用」零判别力。
- Track B 只用了 Claude grader，**没跑 codex 第二评委**。
- description 在 train query 上很好，**从没在 holdout 上验证过**。
- 改 description / 纪律**之前没写任何预测**，改完直接看数字喊好。
- 想往 `hooks/` 里塞依赖 `uv`/`claude`/`codex` 的 eval 脚本（红线 1）。
- 想给本仓搭带自动搜索 + 多候选 filter 的优化引擎 / 多维优化前沿 / 统计显著性预检 / 多字段机器可读裁决 schema。

**以上任一 = 停。先声明 J、接现有脚本拿数字、留 holdout、改前预测。自检不算完成，要独立端点判决。**

## Pointers

- **`references/objective-function.md`**——轻量 J 写法 + `OBJECTIVE.md` 的 schema（§5.4）+ `J_top` / `baseline_reference` / `strict_dims` 怎么填的判据与正反例。
- **`references/track-ab-discipline.md`**——怎么跑现有三脚本（eval-trigger / eval-benchmark / codex-review）+ 怎么读判决 + generator≠judge（codex 当第二评委）+ 演化频率分层（评估成本决定节奏，含 Track A 信号死亡时的降级路径）与 git 当谱系/回滚锚。
- **`references/anti-overfit-lite.md`**——holdout split + predict-then-validate + baseline-must-fail 的完整配方与正反例。
- **`cc-master-skillsmith`**——写 body（craft 诊断 + 4 类内容 + pressure baseline）。本 skill 度量它产出的 body。
- **`curating-skill-portfolios`**——portfolio 准入（要不要建 / skill vs reference / 重叠）。本 skill 假设 skill 已存在。
- **`design_docs/eval/README.md`** + **`design_docs/eval/track-b-benchmark.md`**——本仓 eval 机制的权威用法 / 依赖 / 天花板。
- **`skill-creator`**——官方 skill，用来 scaffold 文件 / 优化 description / 跑 eval 的工具。
- **`AGENTS.md` §8**——本仓 eval 机制（Track A + Track B）的仓级 SSOT。
