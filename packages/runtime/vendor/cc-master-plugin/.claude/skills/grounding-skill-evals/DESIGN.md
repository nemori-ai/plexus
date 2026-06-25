# grounding-skill-evals — Design Statement

> 本文件回答「本 skill 是什么 / 为什么」（设计宪法）。
> 「成功 = 什么」（成功度量）在 `OBJECTIVE.md`；runtime 行为在 `SKILL.md`；深细节在 `references/`。
> 设计先于实现——任何对 `SKILL.md` 的实质改动都应先在此处更新。
> 这是 cc-master 三件 meta-skill 之一，**dev-only，不随插件分发**（住 `.claude/skills/`）。

## 1. One-liner

度量一个已写出 body 的 cc-master skill：声明轻量 J（`OBJECTIVE.md`）、接现有 Track A/B + codex 第二评委、用 baseline-must-fail / holdout / predict-then-validate 三个借来的思想防过拟合与自欺。**不写 body（→ skillsmith），不判该不该建（→ curating）。**

<!-- ≤160 字；能贴 PR 顶部、能被邻居 skill 的边界表引用。 -->

## 2. Craft 自分类

- **Layer：** dev-only meta-skill（项目自用，不分发；与 skillsmith / curating 平级，靠 description 触发，无路由器）。
- **Craft：** Craft C 纪律级 —— process 强（度量有固定序：声明 J → baseline 先跑 → train 调 → holdout 验 → 端点判决）× cognitive 强（要逆「自检即完成 / 数字变好就是改好」的 model prior）。
- **Mode：** agentic（贡献者 / orchestrator 在度量某 skill 时调用）。
- **承重形态：** 命名锚（baseline-must-fail / holdout / predict-then-validate / generator≠judge）+ 硬规则 backstop（Common Mistakes / Red Flags / 抗合理化表）。纯编号步骤不够——本 skill 的价值在堵「凭手感度量」这套合理化，那是纪律级而非机械配方。

<!-- 路由含义：Craft C → SKILL.md 要带抗合理化的硬规则 + Red Flags，不只是 checklist；eval 阈值按 discipline 类。 -->

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品而言

补上一道体检出的**最大缺口之一：per-skill J + 度量纪律**（判别力思想借鉴自外部成熟的 skill 评测 / 优化方法论）。在此之前本仓凭手感改 SKILL.md，eval 三脚本存在但没有「先声明成功契约、先保证 case 可败、留 holdout、改前预测」的纪律把它们串成可信闭环。没有它，本仓 skill 迭代退化为「自己给自己打分」，与红线 4「端点验收 / gate-green ≠ passed」相悖。它**不**与现有 eval 设施重叠——它是用法纪律层，脚本仍是那三个。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在「写完 / 改完 body 要度量」的决策瞬间，提供一种**抗自欺的确定性**：把「我感觉改好了」逼成「跑了独立端点拿到数字、case 在 baseline 可败、holdout 没崩、预测对上了」。不用它会怎样退化（具体）：自检即完成、用零判别力的 case、过拟合到脑中 query、改前不预测改后看数字喊好——四种退化模式都写进了 `OBJECTIVE.md::without_skill_floor` 和 SKILL.md 的 Common Mistakes。

### 3.3 Human user 视角 —— 对最终落地者（本仓维护者）而言

skill 改动的「变好了」从口头声明变成可复现的证据链（Track A 数字 / Track B mean±stddev + codex 第二评委）。维护者能区分「真改进」和「噪声漂移 / 过拟合」，PR review 有据可依，不必靠对 prose 的主观印象拍板。

## 4. Responsibility boundary（责任边界）

### 4.1 IN scope（单一能力方向：度量一个已存在的 skill）

- 给一个已写出 body 的 skill 声明 / 修轻量 J（`OBJECTIVE.md`：J_top + baseline_reference + strict_dims）。
- 接现有 `scripts/eval-trigger.sh`（Track A 触发准确率）+ `scripts/eval-benchmark.sh`（Track B 行为 benchmark）+ `scripts/codex-review.sh`（第二评委），并**诚实读它们的判决**。
- 用 baseline-must-fail / holdout split / predict-then-validate 三个**思想**（非引擎）防零判别力、过拟合、自欺。

### 4.2 OUT of scope（明确移交给谁）—— Do NOT 边界

| 关切 | 移交给 | 一句话理由 |
|------|--------|-----------|
| 写 / 改一个 skill 的 **body**（craft 诊断、命名锚、流程骨架、纪律段怎么写、pressure baseline） | **`cc-master-skillsmith`** | 本 skill 度量 body，不生产 body。generator≠judge：造与评分离。 |
| 决定一个 skill **该不该建** / 该是 skill 还是 reference / 一组 skill 的边界与重叠（portfolio 准入） | **`curating-skill-portfolios`** | 本 skill 假设 skill 已存在且值得度量；「值不值得存在」是上游问题。 |
| 给本仓搭带自动搜索 + 多候选 filter 的优化引擎 / 多维优化前沿 / 统计显著性预检 / 多字段裁决 schema / 自动 holdout-gap 检测 | **不做（红线：照搬过度工程）** | 本仓 2+1 体量用不上那套重型引擎；只借思想，落在 prose + 现有脚本。 |
| 往 `hooks/` 塞依赖 `uv`/`claude`/`codex` 的 eval 脚本 | **不做（红线 1 / ADR-006：hooks 只 bash+node/JS）** | 这些脚本要 `uv`/python/`claude`/`codex`（不随 Claude Code 保证存在），hook 容不下。新工具只进 `scripts/`。 |

### 4.3 Boundary heuristic（一句话判定法）

**问「这是在生产 body、在判该不该建、还是在度量一个已写好的 body？」**——生产 → skillsmith；该不该建 → curating；**度量已写好的 body → 本 skill**。再补一句：本 skill 永远只**接**现有脚本、只**借**思想，任何「搭引擎 / 进 hook」的冲动都越界。

## 5. Trigger and use conditions（触发与反例）

### 5.1 Recognition cues（应当被触发的信号）

- 刚给一个 skill 写完 / 改完 body，要独立度量再迭代。
- 要给本仓某 skill 写 / 修 `OBJECTIVE.md`（轻量 J）。
- 改某 skill 的 `description`，要 Track A 量触发准确率前后比。
- 改某 skill 的纪律段 / 行为，要 Track B 量 with-skill vs without-skill 行为差。
- 怀疑 description 过拟合（要 holdout）、想立可证伪预测防自欺（predict-then-validate）。

### 5.2 Counter-examples（明确不该被触发的反例）

- 「帮我写这个 skill 的 body / 加一段 Rationalization Table」——是 authoring，归 `cc-master-skillsmith`。
- 「要不要为 X 建个新 skill / 这两个 skill 是不是重叠了」——是 portfolio 准入，归 `curating-skill-portfolios`。
- 「写 workflow 脚本怎么写 parallel()」——near-miss，接近「脚本」字面但归 `cc-master:authoring-workflows`，与度量无关。
- 「跑一遍 `run-tests.sh` 看结构过没过」——那是 content contract 的结构闸（correctness），不是本 skill 的质量度量；gate-green ≠ passed。

### 5.3 Pre-flight gate（硬门）

- (i) 目标 skill 已有 body（已写出 SKILL.md）——本 skill 度量已存在的 body，不从空白起。
- (ii) 调用意图是「度量 / 迭代」，不是「生产 body」或「判该不该建」。
- (iii) 要跑脚本时，所需 runtime（`uv` + Python 3.12 + `claude`/`codex` CLI）可达；不可达就**显式标注待补**，不假装跑过（reject-and-surface）。

任何不满足 → STOP，把缺口反馈给上游或路由到对应邻居 skill。

## 6. Evolution anchor（演化锚）

- **Lifecycle class：** methodology（方法论类，非脚手架——不会因某个一次性任务完成而 sunset）。
- **Sunset trigger：** 仅当本仓决定把度量纪律重型化（真要自动搜索优化引擎 / 多维优化前沿 / 多字段裁决 schema）时，本 skill 会被一个更重的 evaluate/optimize 链路取代；但那与现有 ship-anywhere + 小 portfolio 取向相悖，短期不预期发生。
- **Fitness 不变量（映射可跑 probe）：**
  - *只接不造、只借不搭引擎* → probe：`grep -rinE 'verdict.?schema|holdout.?gap|pareto.?frontier|anova' .claude/skills/grounding-skill-evals/` 应只命中「明确排除」语境（描述本仓**不做**的过度工程形状），不出现任何真实现 / validator / 计算脚本。
  - *脚本只进 scripts/ 不进 hooks/*（红线 1）→ probe：本 skill 引用的脚本路径全在 `scripts/`；`grep -rE 'jq|node' hooks/scripts/` 仍只命中注释。
  - *generator≠judge 不被磨平* → probe：Track B 流程始终含 codex 第二评委节点；端点判决 / baseline-must-fail 两条 strict_dim 在 `OBJECTIVE.md` 中保留。
  - *与 skillsmith / curating 不重叠*（红线 3）→ probe：三者 description 的 Do NOT use 反例互指闭合，无职责跨界。
- **Cross-major review owner：** `curating-skill-portfolios`（portfolio 准入 / 重叠 / 边界的 SSOT；跨大版本时由它复盘本 skill 是否仍站得住、是否与 sibling 重叠）。

### 已知缺口（reject-and-surface，不无声化）

- **本 skill 自己的 `evals/trigger.json` 尚未建立，Track A 待跑。** 教度量的 skill 自己尚未被度量——按本 skill 自己的 reject-and-surface 纪律，这里**显式标注 defer 待补**，不假装跑过。注：用户已决定三件 meta-skill 暂 defer Track A（meta-skill 的 substantive trigger query 集成本高、收益待评估），所以这是「defer 待补」而非「马上建」。补建时机：当某件 meta-skill 的 description 要实质改动、需前后比 accuracy 时。

<!-- 本节人类侧叙述与 OBJECTIVE.md 的 strict_dims 一一对应；跨大版本时被 curating-skill-portfolios 复盘。 -->
