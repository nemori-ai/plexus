# curating-skill-portfolios — 设计宪法（DESIGN.md）

> 本文回答「这 skill 是什么 / 为什么」。「怎么用」在 [`SKILL.md`](SKILL.md)；「成功 = 什么」在 [`OBJECTIVE.md`](OBJECTIVE.md)。
> 设计先于实现——任何对 SKILL.md 的实质改动，先在此更新对应段。
> 本文同时是 [`references/design-md-template.md`](references/design-md-template.md) 6 段模板的 **dogfood 实例**：用本 skill 自己的模板给自己写设计宪法。

## 1. One-liner

当维护者要判断一个能力该不该独立成 skill、该 skill 还是 reference、放哪、会不会和现有 skill 重叠时调用——给 agent 覆写「有用就建」的错误准入路径，并补上一套 Counterfactual Probe + 3 必维 scoresheet + DESIGN 宪法的可操作架构判据。

## 2. Craft 自分类

- **Craft**：B 心智模型（命名锚为主，非编号步骤）
- **process-control 轴**：弱——准入判断不是序列敏感的确定性流程，没有「跳步破坏正确性」的硬序；Probe A/B、3 必维、重叠检测都是判别框架而非操作配方。
- **cognitive-override 轴**：强——核心价值在覆写 agent 默认的「有用信息就建 skill」「字面像就算重叠」两条错误 prior，要在压力下仍守住「装饰不建」「纯增量该做 reference」，要泛化到任意新候选。
- **形状蕴含**：(弱 process, 强 cognitive) → Craft B 心智模型。SKILL.md 以命名锚（Counterfactual Probe / 增量×覆写矩阵 / 3 必维 / 重叠 signature）为主干，配 Rationalization 表 + Red Flags 抗合理化，不写「Step 1 / Step 2」的祈使编号清单。深细节（probe 三/四形态、scoresheet 判定、DESIGN 模板）下沉 references。

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品 / portfolio 而言

补的是 cc-master 红线 3「两 skill 不重叠」的**可操作判据洞**：红线说了结论（不重叠），但没给「怎么判要不要建 / 怎么判重叠」的方法。不引入它，portfolio 会在「有用就建」的诱惑下膨胀装饰 skill，触发条件互相打架而无判据消解。它不能被 skillsmith 覆盖——skillsmith 管「单个 body 怎么写」，假设这个 skill 已经决定要建；「要不要建 / 边界 / 重叠」是它之前的一层判断，必须独立成 skill。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在「立项一个新 skill / 判 skill-vs-reference / 重构版图」的决策瞬间，提供**架构准入判据**（Probe A/B 二元本质 + 3 必维 + 重叠 signature）。agent 不用它会怎样做差：见「这信息挺有用」就建独立 skill（把纯增量内容本该做的 reference 做成了 skill）、凭 description 字面像不像判重叠（漏掉真重叠）、把维护者 dev 工具混进分发 `skills/`——这正是 OBJECTIVE.md 的 `without_skill_floor`，两份文件说同一件退化，只是一个写在设计意图、一个写在度量契约。

### 3.3 Human 视角 —— 对最终落地的维护者而言

维护者在评审「要不要加这个 skill」的 PR 时，能引用一份完成的 scoresheet（D1/D2/D3 + verdict）作为准入证据，而不是「感觉它有用」。用了它和没用它的 PR 可区分：用了的带 Probe 评级 + 默认 agent trace + 三维证据；没用的只有「这看着该建」。这种可观察差异让 portfolio 决策可审计、可复盘。

## 4. 责任边界

### 4.1 IN scope

单一职责方向：**一组 skill 的架构准入**——决定每个候选站不站得住、放哪、彼此重不重叠，并给站得住的配 DESIGN 宪法。

- Counterfactual Probe A/B：判一个候选的本质效应（增量 / 覆写 / 装饰）。
- 3 必维 scoresheet（audience-plane / bounded-context / Probe）+ verdict（admit / reject / 做reference / 先拆）。
- 重叠检测：两 skill 是否 Probe 答案相同，用 description Use-when/Do-NOT 对子消解。
- DESIGN.md 6 段设计宪法的模板与方法论权威。

### 4.2 OUT of scope（明确移交给谁）

| 关切 | 移交给 |
|------|--------|
| 单个 skill 的 body 怎么写（craft 诊断 / 4 类 body 内容 / pressure baseline） | `cc-master-skillsmith` |
| 声明 J / 跑 Track A 触发 eval / Track B 行为 benchmark / 防过拟合自欺 | `grounding-skill-evals` |
| OBJECTIVE.md 的 schema 与 J 怎么声明（本 skill 只按 schema 落一份，不是 J 的方法论权威） | `grounding-skill-evals` |
| mechanically checkable 的结构（frontmatter 字段、目录布局） | `bash run-tests.sh` content contract + `claude plugin validate .` |

### 4.3 Boundary heuristic（一句话判定法）

问「这个判断发生在 skill 生命周期的哪一刻」：**之前**（要不要存在 / 放哪 / 会不会撞）→ 本 skill；**之中**（已决定要建，正文怎么写）→ skillsmith；**之后**（写完了，怎么度量它有没有用）→ grounding-skill-evals。

## 5. 触发与反例

### 5.1 Recognition cues（应当被触发的信号）

- 「这块信息挺有用，建个 skill 吧」的冲动（典型把 reference 做成 skill）。
- 要新建 skill 但说不清给 agent 的是「新东西」还是「纠偏」。
- 纠结「独立 skill 还是某 skill 的 `references/<topic>.md`」。
- 两个 skill 的 description 触发条件看着会打架 / 抢同类任务。
- 重构 skill 版图（拆 / 并 / 退役 / 新增），需要判据而非手感。
- 要给新 / 现有 skill 落一份 DESIGN.md 设计宪法。

### 5.2 Counter-examples（明确不该被触发的反例）

- 只要写好或施压测试单个 skill 的 body → `cc-master-skillsmith`（本 skill 决定「要不要这个 skill」，不决定「正文怎么写」）。
- 要声明 J / 跑触发或行为 eval / 度量改动有没有用 → `grounding-skill-evals`（本 skill 是定性架构判断，不出 precision/recall）。
- mechanically checkable 的结构约束（frontmatter 有没有 name、目录布局）→ 别手判，交给 content contract + `plugin validate`。

### 5.3 Pre-flight gate（硬门，任一不满足就 STOP）

- (i) 候选的能力方向已经能用一两句话说清（说不清 = 先去 `requirement-elicitation` 挖清真需求，不是先准入）。
- (ii) cc-master 的受众面声明可引用（哪些进 `skills/`、哪些进 `.claude/skills/`），否则 D1 无法评分。

## 6. 演化锚

- **Lifecycle class**：methodology——它编码的是「怎么严谨地做 skill 架构准入」，模型越强越该严格执行（更强模型更容易自信地「有用就建」，越需要 Probe 拦），不会因模型变强而过时。
- **Sunset trigger**：不适用（methodology 类带存续推定）。唯一会让它退役的不是模型变强，而是 cc-master portfolio 长大到需要更多承重维（layer / host-parity / 道术器全维）——那时本 skill 不是退役而是**扩维重写**，仍在同一职责。
- **Fitness 不变量 → 可跑 probe**：
  - 「裁剪到 3 必维，不复活砍掉的维」 → grep SKILL.md / references 不出现 layer/host-parity/道术器 type 作为承重维（人审 + 红线级 PR review）。
  - 「与 skillsmith / grounding 互不重叠」 → 三者 description 的 Probe strong 形态各异（本 skill B.4+A.3 / skillsmith B.1 / grounding B.2），由 `portfolio-scoresheet.md` 的重叠检测自证；红线 3 + content contract 守。
  - 「正文全中文」 → 人审 / PR review 拦（content test 只查 frontmatter name+description，不查语言，无自动 probe）；「frontmatter 单引号整包」 → `bash run-tests.sh` content 段 + Finding #1 自检。
  - 「SKILL.md ≤500 行、references 一层深、no orphan」 → progressive-disclosure 阈值（当前 SKILL.md 130 行，远低于阈值）。
- **Cross-major review owner**：本 skill 自己（curating-skill-portfolios）——meta-skill 三件套的存废复盘正是它的职责；模型大版本时由它对自己 + skillsmith + grounding 各跑一遍 Probe 重判。
