# requirement-elicitation — 设计宪法（DESIGN.md）

> 本文回答「这 skill 是什么 / 为什么」。「怎么用」在 [`SKILL.md`](SKILL.md)；「成功 = 什么」在 [`OBJECTIVE.md`](OBJECTIVE.md)。
> 设计先于实现——任何对 SKILL.md 的实质改动，先在此更新对应段。
> 本 skill 是 cc-master 自成一体的需求发现 dev skill：方法论内核（道 + 五个 discovery moves + strawman + 设计闸 + 何时停止挖掘）与仓库无关、可独立成立，接地到 cc-master 的 board `goal` 模型与造-skill 生命周期，全中文，不依赖任何外部领域模型 / 源码路径 / 跨链接。

## 1. One-liner

开始本仓任何 feature / skill / 行为改动**之前**用——通过协作对话把「用户的字面请求」纠正为「真实业务痛点」，过设计闸（批准前不实现）才准动手。它是 cc-master dev 流的**需求发现闸**，取代外部的 `superpowers:brainstorming`，重接地到本仓形态。增量弱、**覆写强**（纠的是「照字面实现请求」这条默认）。

## 2. Craft 自分类

- **Layer**：dev-only meta-skill（住 `.claude/skills/`，**不**随插件分发；终端用户装 cc-master 看不到它）。
- **Craft**：**B 心智模型 + C 纪律级** 混合——核心是一条信念（道）的认知覆写，配几条红线纪律（设计闸 + no-silent-failure 同构）。
- **process-control 轴**：弱——发现不是序敏感的确定性流程，五个 discovery moves 是判别框架而非操作配方；唯一的硬序是设计闸「批准前不实现」。
- **cognitive-override 轴**：强——覆写「字面请求=需求」「提议方案=需求」「抽象就够了，不用具体实例」三条默认 prior，且要在 time / 简单性压力下仍守住。
- **形状蕴含**：(弱 process, 强 cognitive) → 命名锚为主（道 / 五个 discovery moves / strawman / 设计闸三判断）+ 红线与反模式作 backstop，**不写编号清单**；每个 move「为什么有效」的深细节下沉 [`references/discovery_moves.md`](references/discovery_moves.md)。
- **Mode**：agentic（贡献者 / orchestrator 调用，无 user-facing slash command）。
- **Lifecycle class**：methodology。

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品 / portfolio 而言

补的洞：cc-master dev 流此前的需求发现一步**外依赖** `superpowers:brainstorming`——一个通用、未接地本仓的外部 skill。这有两重问题：① 违背 self-contain，没装 superpowers 的贡献者就没有这一步；② 通用 brainstorming 不懂本仓的 board `goal` 模型与「发现 → 准入 → 造 → 度量」生命周期。本 skill 把这一步**内化 + 重接地**，让造 / 评 / 治三件套有一个自洽的、本仓形态的上游。它**不能被 curating 覆盖**——curating 假设「已经知道要某个能力，判它该不该是 skill / 放哪 / 重叠」；「这个能力到底是不是真需求、用户真正的痛点是什么」是它**之前**的一层判断，必须独立。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在「用户递来一个请求 / goal，我要动手」的决策瞬间，提供一种确定性：把「照字面造」纠正为「先挖真痛点（五个 discovery moves）+ 用户原话复述确认 + 过设计闸再动手」。不用它会怎样退化（具体）：默认 agent 把「加个导出按钮」直接拆成 DAG 派发实现，交付一个让真痛点原封不动的 feature；或在 time / 简单性压力下跳过设计闸，直接跳进 skillsmith 写 body / 直接 coding；或用抽象（"更好的可见性"）当需求而指不出一个它在疼的具体实例。

### 3.3 Human 视角 —— 对最终落地的维护者而言

维护者得到一个可观察的差别：用了它，每次动手前手上有一个**被用户对着具体实例确认过的需求陈述** + 一份过闸的设计；没用它，产出常是「忠实实现了我猜的方案、却没解决我的问题」。用了 / 没用的对话产物可区分——前者带具体痛点实例 + strawman 迭代痕迹 + 书面设计，后者只有一个被照字面执行的请求。

## 4. 责任边界

### 4.1 IN scope

单一职责方向：**在动手实现之前，发现并确认真实需求、过设计闸**。具体展开——

- 道：用户字面话是症状（常是猜出来的解法），不是需求本身；它是下游一切的根，读错则全盘从谎言正确推导。
- 五个 discovery moves（追 job / 抠具体实例 / 痛点与方案分离 / 够向极度具体 / 用户原话复述）。
- strawman 纪律（strawman → 讨论 → 推荐）。
- 设计闸三判断（先定范围再抠细节 / 带方案非既成事实 / 先落地设计再让用户读）+ 何时停止挖掘。

### 4.2 OUT of scope（明确移交给谁——红线 3「skill 不重叠」的可操作判据）

| 关切 | 移交给 |
|------|--------|
| 已确认需求后写一个 skill 的 body（craft 诊断 / 命名锚 / pressure baseline） | `cc-master-skillsmith` |
| 判要不要建 skill / 放哪 / 会不会重叠（含「这请求该拆成几个 skill」的 skill-decomposition） | `curating-skill-portfolios` |
| 度量一个已写好的 skill（J / Track A·B / 防自欺） | `grounding-skill-evals` |
| 把已批准的 goal 拆图 / 派发 / 驱动到完成（编排 loop） | `orchestrating-to-completion` |
| 其中 workflow 脚本怎么写（parallel / pipeline / caps） | `authoring-workflows` |
| 命名清晰的竞争方案之间的仲裁 | `/codex` 第二意见 / eng-review |

### 4.3 Boundary heuristic（一句话判定法）

**「真需求是否已被用户对着一个具体实例确认？」——否 → 本 skill（继续发现）；是 → 移交下游。** 再补一层：还不知道用户真正需要什么 → 本 skill；知道需求了、在判它是不是个 skill → curating；知道要建这 skill 了、在写正文 → skillsmith；写完了、在度量 → grounding。

## 5. 触发与反例

### 5.1 Recognition cues（应当被触发的信号）

- 开始本仓任何 feature / skill / 行为改动之前（动第一下实现之前，无论请求看起来多简单）。
- 请求以一个猜出来的方案形态到来、而底层问题没说出口（"加个按钮" / "给我做个 X"）。
- 要建模或动手却说不清真实需求、指不出一个它真在疼的具体实例。
- 为一个新问题空间和用户共创词汇。
- 一个请求捆了多个独立子系统、动手前要先拆。
- 作为 master orchestrator 跑前台需求发现对话（挖需求是指挥自己的活，绝不外包）。

### 5.2 Counter-examples（明确不该被触发的反例）

- 已确认需求、要写一个 skill 的 body → `cc-master-skillsmith`。
- 在判「要不要为 X 建个 skill / 这两个会不会重叠」→ `curating-skill-portfolios`。
- 在度量一个已写好的 skill（accuracy 涨没涨 / 行为差） → `grounding-skill-evals`。
- 写 workflow 脚本怎么 parallel/pipeline → `authoring-workflows`。
- 把一个**已批准**的 goal 拆图、派发、驱动到完成 → `orchestrating-to-completion`。

### 5.3 Pre-flight gate（硬门，任一不满足就 STOP）

- (i) 手上**还没有**一个被用户对着具体实例确认的需求陈述（有了 = 发现已完成，移交下游，别赖着多挖）。
- (ii) 调用意图是「发现 / 澄清需求」，不是已经在实现 / 准入 / 度量（否则路由到对应 sibling）。

## 6. 演化锚

- **Lifecycle class**：methodology——它编码的是「动手前先挖真需求」的纪律，模型越强越该守（更强模型更自信地照字面快速实现，越需要这道闸拦），不会因模型变强而过时。
- **Sunset trigger**：不适用（methodology 带存续推定）。唯一会让它退役的：cc-master 不再自维护、也不再有人对它提需求（极不可能）。
- **Fitness 不变量 → 可跑 probe**：
  - *self-contain（方法论自成一体、已取代外部 brainstorming）* → grep 本 skill `SKILL.md` + `references/` 正文 **不出现**任何外部领域模型 / 外部源码路径 / 跨仓库专有标记等残留，所有引用都指向 cc-master 自身（board `goal` 模型、`design_docs/plans/` 等本仓路径）；`AGENTS.md` §4 dev 流的需求发现一步指向本 skill 而非 `superpowers:brainstorming`。
  - *设计闸纪律在场* → SKILL.md 始终含「批准前不实现」红线 + 「猜出的需求 ≠ 确认的需求」的 no-silent-failure 同构（呼应红线「gate-green ≠ passed」）。
  - *与 skillsmith / curating / grounding 不重叠（红线 3）* → 见下「重叠诚实交代」；四者 description 的 Do-NOT 互指闭合。
  - *全中文正文 + frontmatter 单引号整包* → 人审 / PR review + `bash run-tests.sh` content 段。
- **Cross-major review owner**：`curating-skill-portfolios`（portfolio 准入 / 重叠 / 边界的 SSOT）。

### 重叠诚实交代（本 skill 与 skillsmith 都靠 B1）

本 skill 与 `cc-master-skillsmith` 的 Probe strong 形态**都是 B.1 倾向覆写**（都在覆写「agent 在压力下合理化掉一条纪律」）。但重叠检测的精确判据是「同形态 **且** 覆写的是**同一类默认失败**」——这里 target default 不同：

- 本 skill B1 覆写的默认失败 = **「照字面实现请求、不挖真需求」**（发现阶段，动手之前）。
- skillsmith B1 覆写的默认失败 = **「绕过 pressure baseline、凭手感写 discipline prose」**（造 body 阶段，已决定要建之后）。

同形态、不同 target default、不同生命周期时刻 → **不 overlap**，正交。靠 description 的 Use-when / Do-NOT 对子互指消解（本 skill「已确认需求写 body → skillsmith」；skillsmith「判要不要建/发现需求 → 上游」）。

### 已知缺口（reject-and-surface，不无声化）

- **本 skill 的 `evals/trigger.json` 尚未建立，Track A 待跑**——与其它 meta-skill 一致 defer（用户已决定三件 meta-skill 暂 defer Track A，本 skill 并入同一 defer）。补建时机：本 skill 的 `description` 要实质改动、需前后比 accuracy 时。
- **discipline prose 是成熟内核，尚未跑过 pressure baseline**——按 TDD-for-skills，net-new discipline 才强制 failing baseline 先行；本 skill 的红线与反模式已是验证过的成熟内核，故 fresh baseline 标注 defer 而非阻塞。若日后实质改写某条红线 prose，则按 `cc-master-skillsmith` 的 Iron Law 先跑 baseline。
