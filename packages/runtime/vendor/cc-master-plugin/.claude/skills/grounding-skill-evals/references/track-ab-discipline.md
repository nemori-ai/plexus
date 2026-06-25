# 接现有三脚本 + 读判决 + generator≠judge

> 本文是 `grounding-skill-evals` 的深细节：怎么跑本仓**已有**的三个 eval 脚本、怎么诚实读它们的判决、为什么 Track B 必须配一个非-Claude 第二评委。主文件给入口表，本文给操作步骤。

## Contents

- [1. 三脚本是接、不是造](#1-三脚本是接不是造)
- [2. Track A —— 触发准确率（eval-trigger.sh）](#2-track-a--触发准确率eval-triggersh)
- [3. Track B —— 编排纪律 benchmark（eval-benchmark.sh）](#3-track-b--编排纪律-benchmarkeval-benchmarksh)
- [4. codex 第二评委（codex-review.sh）](#4-codex-第二评委codex-reviewsh)
- [5. generator ≠ judge（为什么非要分家族）](#5-generator--judge为什么非要分家族)
- [6. 读判决的诚实纪律](#6-读判决的诚实纪律)
- [7. 演化频率分层 + 谱系/回滚安全网](#7-演化频率分层--谱系回滚安全网)

---

## 1. 三脚本是接、不是造

本仓 `scripts/` 下**已经有**三个 eval 设施。本 skill 的纪律是**接它们**：

| 脚本 | 它是什么 | 它依赖 |
|---|---|---|
| `scripts/eval-trigger.sh` | skill-creator Track A 的薄封装——量 `description` 的触发准确率 | `uv` + Python 3.12 + `claude` CLI |
| `scripts/eval-benchmark.sh` | skill-creator Track B 聚合步的薄封装——读 iteration 目录里的 grading.json 出 mean±stddev | `uv` + Python 3.12 |
| `scripts/codex-review.sh` | codex 当独立第二端点验收者——对一段 diff 出 `approve`/`needs-attention` | `codex` CLI（OAuth） |

> **这些脚本只进 `scripts/`，绝不进 `hooks/`（红线 1 / ADR-006，ship-anywhere）。** 它们都依赖 `uv`/`claude`/`codex`（不随 Claude Code 保证存在），而 hook 只允许 bash + node/JS，容不下它们。**本 skill 将来若补新工具脚本，同样只进 `scripts/`，且复用现有形态，不重造引擎。**

权威用法 / 依赖 / 天花板：`design_docs/eval/README.md`（Track A）+ `design_docs/eval/track-b-benchmark.md`（Track B 完整半手动流程）。仓级 SSOT 是 `AGENTS.md` §8。

## 2. Track A —— 触发准确率（eval-trigger.sh）

**量什么：** 一个 skill 的 `description` 在一组 query 上的 precision / recall / accuracy——即「该触发时触发了吗、不该触发时忍住了吗」。

**何时跑：任何 `description` 改动前后各跑一遍，比 accuracy。** 这是 Track A 的唯一正确用法——改前是 baseline，改后是验证，delta 才是信号。

**怎么跑：**

```bash
scripts/eval-trigger.sh <skill-name>
# 它读 skills/<skill>/evals/trigger.json（should-trigger + near-miss），各 query 跑 3 遍
```

> **注意：** 现成脚本指向 `skills/<skill>/evals/trigger.json`（分发的 skill）。本仓三个 meta-skill 住 `.claude/skills/`（dev-only），eval set 路径需相应调整或用 `CC_MASTER_SKILL_CREATOR` 之外的方式给 `--skill-path` 指 `.claude/skills/<skill>`。若 eval set 还没建，**显式标注待补**，别假装跑过（reject-and-surface）。

**eval set 的诚实纪律：** query 必须 substantive。平凡 query（「帮我写个 hello world」）本就不会触发任何 skill，它过不过与 description 质量无关。把平凡 query 当 near-miss 凑数 = 虚高 accuracy，自欺。near-miss 要是**真的接近但不该触发**的 query（如「写 workflow 脚本」对 `grounding-skill-evals` 是 near-miss——接近 skill 主题但属于另一个 skill）。

## 3. Track B —— 编排纪律 benchmark（eval-benchmark.sh）

**量什么：** with-skill vs without-skill 的**行为断言**——不是触发，是「装了这 skill 之后 agent 的行为有没有真的变好」。各 3 run 看 mean±stddev。

**何时跑：** behavioral 改动（纪律段、流程骨架）前后。

**这是半手动的多步循环**，`eval-benchmark.sh` 只是**最后一步机械聚合**。完整流程（spawn with_skill + without_skill 两臂的 run、给每个 transcript 按行为断言打分、聚合、配 codex 第二评委）在 `design_docs/eval/track-b-benchmark.md`——**先读它**。聚合调用：

```bash
scripts/eval-benchmark.sh <iteration-dir> <skill-name>
# <iteration-dir> 持有 eval-N/{with_skill,without_skill}/run-*/grading.json
# 出 benchmark.json + benchmark.md（pass_rate / time / tokens 的 mean±stddev + delta）
```

**读 mean±stddev 的诚实纪律：** with−without 的 delta 要大于两臂 stddev 之和才算可信信号。delta 小于噪声 = 没结论，别喊「改好了」。

## 4. codex 第二评委（codex-review.sh）

**量什么：** 一个非-Claude 端点（codex / gpt）对同一段 diff（或 transcript）独立出 `verdict: approve | needs-attention`（findings 字段依 codex CLI 的 review-output schema，通常含 severity / file / line——不是脚本保证的，取决于 codex CLI 的输出契约）。

```bash
scripts/codex-review.sh [--base <branch>]   # 默认 base = main
```

**判决映射（呼应本仓 Joiner 闸）：**

| codex 出 | 怎么处理 |
|---|---|
| `approve` + 非空 + diff 确实被读了 | → done（信） |
| `needs-attention` | → Replan（按反馈改） |
| 空 review / 调用失败（脚本 exit 2） | → **按未通过处理**（silent-pass-through guard，不静默放行） |
| OAuth 过期 | → 同上，按未通过 |

**关键：空 review 不是静默 approve。** 脚本对空 / 失败的 review 显式 exit 2，让 caller 的端点闸映射到「未通过」（Replan），永远不映射到 done。**别把「codex 没说话」当成「codex 同意」。**

## 5. generator ≠ judge（为什么非要分家族）

**红线级纪律**（呼应 cc-master「端点验收 / gate-green ≠ passed」红线 4）：**生产 body 的 actor 与评判的 actor 必须分离。**

同家族评委给同家族产出打分，会有 preference leakage——pass-rate 虚高约 33%（arXiv:2502.01534）。所以：

- Track B 用 Claude 跑 with-skill / without-skill 两臂、又用 Claude grader 打分——**这只是第一评委**。
- 必须**再跑 codex 当第二评委**（非-Claude 端点，与 Claude 产出/评判家族分离）对同一 transcript 出独立裁决。
- **两评委分歧 = 高信号**——它指向一个 Claude-grader 因家族偏好没看见的问题，值得深挖，不是「取平均抹平」。

**这条不能用「都是大模型差不多」绕过。** pre-call 声明「我会找个不同的评委」是可绕过的；真正的分离是 codex 这个**运行时不同端点**实际出了独立裁决。

## 6. 读判决的诚实纪律

- **自检不算完成，要独立端点判决。** 「我自己读了一遍 transcript / diff，感觉对了」不是判决。判决 = Track A 的数字 / Track B 的 grader + codex 第二评委的裁决。**「looks fine」从来不构成 passed。**
- **gate-green ≠ passed。** `run-tests.sh` 全绿只证明结构合 contract，不证明行为质量。质量靠 eval + 端点验收独立守护。
- **空 review / 失败调用 → 未通过**，不是「没问题」。silent-pass-through 是要堵的洞，不是默认放行。
- **delta 小于噪声 → 没结论。** Track B 的 mean±stddev 里，delta 不显著就别宣布胜利。
- **跑不全要显式标注待补。** 若分批 / 受限跑不全（如 eval set 还没建、codex OAuth 过期），**显式说「这部分没跑，待补」**，不静默跳过当成跑过了（reject-and-surface）。

## 7. 演化频率分层 + 谱系/回滚安全网

### 评估成本决定演化节奏

prose 的迭代（演化）能跑多快，**由「评估一次有多贵」决定，不由「改一次有多容易」决定**——改一行 description 和改一段纪律 prose 都很便宜，但验证它们的成本差一个量级，演化节奏必须跟着评估成本分层（借思想：评估器成本必须匹配演化预算——外部演化式优化方法论的共性教训；只借原则，不搬引擎）：

| 标的 | 评估一次的成本 | 允许的演化节奏 |
|---|---|---|
| `description`（触发器） | Track A 一次：廉价、客观、全自动（§2） | **高频、多变体**——一轮可试多个候选措辞，各跑一遍比 accuracy |
| skill body 的行为（纪律段 / 流程） | Track B 一次：多分钟、多 run、半手动（§3），还要配 codex 第二评委（§4） | **低频、小步**——一次只动一处，改前后各量一遍，绝不堆叠多个未验证改动再跑一次 |

节奏错配两个方向都是错：把贵评估的标的当便宜的演化（body 一轮改五处、最后才跑一次 Track B）= 分不清哪处改动贡献了 delta；把便宜评估的标的当贵的演化（description 换个词也排队等慎重评审）= 白白浪费演化预算。

**每次演化的诚实形态**：改前写预测、改前后各跑一遍比对、holdout 防过拟合（predict-then-validate）——完整配方在 [`anti-overfit-lite.md`](anti-overfit-lite.md)，此处不复述。

**Track A 信号不可用时的降级路径（Finding #18 / #25，本仓实测）：** 本仓已两次实测到 Track A 的正例 recall 在冷启单轮 / 满载环境下塌到地板（≈0）——根因是测量通道，与 description 质量无关（权威记录：`design_docs/eval/README.md` 的 "Measured floor warning"）。此时 before/after 读出 0 vs 0 不携带任何信息——「无数字不合入」若硬卡这个塌掉的数字，就是在对着死通道调 description。降级纪律：**先验通道、再信数字**——一个全 0（或全满）的指标先怀疑测量、后怀疑被测物；通道确认死了，就降级为**记录在案的定性评审（description diff review）+ predict-then-validate**（预测照写，用定性比对验证），并显式标注「Track A 信号不可用，待通道修复」（reject-and-surface）。**绝不硬卡一个塌掉的数字；也绝不因为数字塌了就什么都不验。**

### 谱系与回滚锚 = git（不另建存档机制）

prose 演化需要谱系（哪个版本从哪来）和回滚（演化失败退回上一个好版本），本仓的答案就是 **git**：每次演化独立 commit（按 `AGENTS.md` §11 分组提交），回滚 = revert / checkout 旧版——不另建快照目录或版本存档机制。同时，**外部锚（可执行 eval + codex 第二评委）是演化闭环的必需件、不是可选项**：没有非同家族端点当锚，prose 自演化会漂成「自己评自己、越评越好」——这条纪律 §4–§5 已立（generator≠judge），此处只指回、不复述。
