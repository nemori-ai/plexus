# Counterfactual Probe A/B — 准入闸的操作指南

> 这是 SKILL.md「核心方法论」的展开。每个候选 skill 在判定要不要建 / 该 skill 还是 reference / 两个会不会重叠之前，都必须过这两道 probe。**probe 评级是 judgment-bearing 的**——能被「这信息挺有用就建吧」合理化掉——所以本文给了具体评级信号 + worked examples + 抗合理化注解。评分前读完它，别凭感觉打 strong/weak。

## Contents

- [核心命题 — 二元本质](#核心命题--二元本质)
- [Probe A — 增量诊断](#probe-a--增量诊断)
- [Probe B — 覆写诊断](#probe-b--覆写诊断)
- [增量 × 覆写决策矩阵](#增量--覆写决策矩阵)
- [两条 stance 注解](#两条-stance-注解)
- [Anti-patterns — 看着像 skill 其实不是](#anti-patterns--看着像-skill-其实不是)
- [Worked examples](#worked-examples)
- [本指南刻意不做的事](#本指南刻意不做的事)

## 核心命题 — 二元本质

> 一个 skill 对 agent 的本质效应恰是**两类之一**（可兼有）：
>
> 1. **增量（augmentation）**——skill 提供 agent 默认不具备的知识 / 能力 / 路径。
> 2. **覆写（override）**——skill 在 agent 默认认知 / 倾向 / 触发 / 路径**会错**时，把它纠正过来。
>
> 两者皆无的候选不是 skill，只是 portfolio 上的装饰重量。

这条二元判定不可商量。每个候选都过两道 probe，合并裁决驱动下面的四象限决策。

## Probe A — 增量诊断

> *没有这个 skill，agent 缺哪块知识 / 能力 / 路径，以致任务因缺输入而失败或做错？*

三形态，各有评级信号：

### A.1 新领域知识

agent 先验不携带的事实 / 程序 / 上下文。测法：不调用 skill 时，agent 的回答是否对该领域有事实性错误（或干脆「我不知道」）？

- **Strong A1**：没有 skill 时 agent 把领域答错（如「workflow 引擎的 determinism 规则是什么」——没 skill 就猜）。
- **Weak A1**：agent 先验已覆盖该领域，skill 是冗余知识包装。

### A.2 新能力

agent 无法靠自己组合已知原语重构的工具用法 / 技巧 / 配方。测法：不调用 skill 时，agent 能否用它已会的原语操作拼出任务？

- **Strong A2**：agent 拼不出（如阶段顺序非显然的多阶段 build pipeline）。
- **Weak A2**：agent 能从原语推导（如「先 grep 再 sed」——两个都已会）。

### A.3 新路径

即便具备全部构件能力，agent 不经提示也不会自发推导出的动作序列。测法：不调用 skill 时，agent 是否走一条偏离 skill 处方的不同路径（对错不论）？

- **Strong A3**：agent 默认路径错或极低效（如「TDD：先写测试再写实现」——默认是先写代码）。
- **Weak A3**：agent 默认路径本就和处方一致，skill 冗余。

**Probe A 评级**：A1/A2/A3 任一 strong → **A strong**。无一 strong → **A weak**。

## Probe B — 覆写诊断

> *没有这个 skill，agent 默认认知会做什么，这默认在哪失败？*

四形态：

### B.1 倾向覆写

agent 默认会合理化掉纪律（跳测试 / 压 warning / 抄近路）。skill 强制纪律。

- **Strong B1**：TDD 类 / debugging 类 / 安全纪律类。压力下 agent 默认跳纪律，skill 拦住。
- **Weak B1**：该纪律太廉价，agent 默认从不跳，skill 是多余强化。

### B.2 触发覆写

该想到这个 skill 的领域时，agent 默认却想不到。skill 的 description 纪律 + 「1% 也要调用」机制克服「out of mind」。

- **Strong B2**：相关能力没有显式触发就「不在脑子里」（如 UI 工作时的无障碍检查——agent 想不到去做）。
- **Weak B2**：触发从上下文就很明显，agent 需要时总会去拿。

### B.3 风格覆写

agent 默认自由发挥输出。skill 锁一个统一基线，让多 agent / 多 session 的产物可比、可累积。

- **Strong B3**：输出基线对下游消费方重要（如跨 session 可追溯的 spec 文档风格）。
- **Weak B3**：输出风格波动无所谓，统一不增值。

### B.4 路径覆写

agent 默认走错路。skill 强制对的那条，哪怕错的那条局部更诱人。

- **Strong B4**：默认路径是错的（如 debugging 里「修症状」vs「找根因」）。
- **Weak B4**：默认路径本就 fine，skill 冗余。

**Probe B 评级**：B1/B2/B3/B4 任一 strong → **B strong**。无一 strong → **B weak**。

## 增量 × 覆写决策矩阵

| A 增量 | B 覆写 | skill 类别 | 决策 |
|---|---|---|---|
| Strong | Strong | **双价值**（典型成熟编排类） | **必建**——最强理由 |
| Strong | Weak | **纯增量**（reference-wrap 候选） | **该做 reference**——该是某个现有 skill 的 `references/<topic>.md`，不是独立 skill |
| Weak | Strong | **纯覆写**（纪律 / 立场 / 方法论） | **应建**——canonical skill 的本色；「没有新信息」不是缺陷，override 即价值 |
| Weak | Weak | **装饰** | **不建 / 退役**——never ship |

## 两条 stance 注解

**① 纯增量候选几乎总该是 reference，不是独立 skill。** 增量内容没有值得单独配 `description` + 触发机制的「行为惯性」。这是最常见的 authoring 误判源——「这是有用信息」被错当成「这是一个 skill」。它的正确归宿：某个处理相关 workflow 的 sibling skill 里的 `references/<topic>.md`，那个 skill 的 body 在 workflow 步骤走到相关点时引用它。

**② 纯覆写 skill 是 canonical skill 的本色。** TDD 类 / debugging 类 / 立场类 skill 携带近乎零的新信息（「agent 名义上没这 skill 也能全做」），但其 override 价值压倒性（「agent 的默认在压力下破坏方法论」）。**没有新信息不是 skill 的瑕疵——override 就是价值。** 别因为「这 skill 没教新东西」就退掉一个纯覆写纪律。

## Anti-patterns — 看着像 skill 其实不是

每条都过「这看着有用」的表面 smell test，却在二元诊断的根因上失败：

| Anti-pattern | A 增量 | B 覆写 | 正确归宿 |
|---|---|---|---|
| 单个工具调用的包装 | weak | 无 | `references/<topic>.md` |
| 静态领域知识 / 资料 | strong | 无 | `references/<topic>.md` |
| 某个大 skill 的内部一步 | 仅局部 | 仅局部 | inline 进那个 skill 的 reference |
| 纯内容脚手架 | weak | 无 | 一个模板 artifact，不是独立 skill |
| 固定形状输出 artifact | weak | 无 | `assets/<file>` |
| 「为对仗 / 凑齐 / 装饰」候选 | 无 | 无 | 根本不是 skill——从 portfolio 删掉 |

> cc-master 体量小，完整 anti-pattern 表里 framework-level / trigger-too-rare 那两条在本仓体量基本用不上——但「静态资料该做 reference」「凑齐三件套是装饰」这两条对本仓**高频**：meta-skill 三件套就最容易犯「为对仗而建第四个」的错。
>
> （注：后来确实加入了第四件 dev skill `requirement-elicitation`，但它**不是**这条警告所指的「为对仗的第四件造/评/治」——它是**不同家族的上游需求发现层**（喂给 curating），过了 Probe（强 B.1 覆写「照字面实现」）且补了 self-containment 缺口（内化 `superpowers:brainstorming`），不是装饰。这恰是本警告的**正确用法**：建第四个之前先证明它过 Probe、非凑数——而非「不许有第四个」。）

## Worked examples

### 例 1 — 清晰「必建」（Strong + Strong）

**候选**：`orchestrating-to-completion`（cc-master 现有 SKILL A）——长 horizon 编排纪律。

- **Probe A**：Strong A3——agent 默认在等待窗口里 idle-wait 或制造 busywork，不会自发推导「主动推进可派发工作」的编排路径。
- **Probe B**：Strong B1 + B4——agent 默认会合理化掉「指挥不演奏」（亲手实现/review）、把 green gate 当 passed。
- **决策**：必建（双价值）。方法论类。

### 例 2 — 清晰「该做 reference」（Strong A only）

**候选**：一个 `workflow-engine-determinism-spec` skill，文档化 workflow 引擎的 determinism / resume 字段规则。

- **Probe A**：Strong A1——agent 先验不携带该引擎的精确规则。
- **Probe B**：Weak——agent 围绕 workflow 编写的默认行为没问题，无需 override。
- **决策**：该做 reference。它本就是 `authoring-workflows` 的 `references/` 一节，不是独立 skill。增量没有值得独立 skill 机制的行为惯性。

### 例 3 — 清晰「不建」（Weak + Weak）

**候选**：一个 `be-concise` skill，提醒 agent 回话简洁。

- **Probe A**：Weak——agent 默认已够简洁。
- **Probe B**：Weak——agent 不会合理化掉简洁，无默认失败可覆写。
- **决策**：不建。装饰重量；「简洁训练」在 plugin 级 skill 设计的上游。

### 例 4 — 「应建」纯覆写（Weak A + Strong B）

**候选**：cc-master-skillsmith 的 Iron Law「无 failing pressure baseline 不改 discipline prose」。

- **Probe A**：Weak——没教 agent 任何它不会的新技术，pressure-testing 的机制 agent 名义上都能拼。
- **Probe B**：Strong B1——agent 默认在「我知道 agent 会怎么说，跳过 baseline 直接写 counter」的压力下绕过测试。
- **决策**：应建（纯覆写）。「没有新信息」正是纯覆写纪律的常态——别因此退掉它。

## 本指南刻意不做的事

- **不**决定这 skill 的 body 内容或形状——那是 `cc-master-skillsmith` 的领地（准入通过后）。
- **不**出 precision/recall 数字或 ablation delta——那是 `grounding-skill-evals` 的定量半边。本 probe 是**假设**（从对默认行为的推理来），经验锚定由 grounding-evals 的 Track B / pressure baseline 提供。
- **不**从感觉推 probe 评级——评级来自「没有这个 skill，默认 agent 具体会怎样」的 trace，至少一句话长。挥手（「agent 会受益」）不是证据；行为具体性才是。
