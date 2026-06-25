---
name: curating-skill-portfolios
description: 'Use when deciding whether a capability deserves its own skill, whether something should be a skill or a reference, where a new skill belongs, or whether two skills overlap — 当你在判断要不要新建一个 skill、这块该不该独立成 skill 还是塞进某个 reference、一组 skill 的边界与重叠时。Triggers: 立项一个新 skill、重构 skill 版图、"这是 skill 还是 reference"、portfolio 体检、两个 skill 触发条件打架。Do NOT use when you only need to write or pressure-test a single skill body (那是 cc-master-skillsmith); Do NOT use when you need to declare J / run trigger or behavior eval / measure a skill (那是 grounding-skill-evals).'
---

# curating-skill-portfolios — 一组 skill 的架构准入

> **这是项目自用的 dev skill，不随插件分发。** 它住 `.claude/skills/`（cc-master 自己的贡献者用），不在 `skills/`（那才会 ship 给插件用户）。终端用户装 cc-master 看不到它；它只为「设计本仓的 skill 版图」存在。

## Overview

**一个 skill 对 agent 的本质效应只有两种：增量（给它没有的）或覆写（纠正它默认会错的）；两者皆无 = 装饰，不建。** 本 skill 是 cc-master 这个小 portfolio（2 个分发 + 几个 dev-only）的**架构准入闸**——回答「要不要建」「该 skill 还是 reference」「放哪」「两个会不会重叠」，并给每个站得住的 skill 写一份 DESIGN.md 设计宪法。它**不**碰任何单个 skill 的 body 内容，也**不**碰度量。

## When to use

命中以下任一**症状**就读本 skill（**先判准入，再动手**）：

- 你正打算「这块信息挺有用，建个 skill 吧」——典型的把该做 reference 的做成 skill 的冲动。
- 你要新建一个 skill，但说不清它给 agent 的是「新东西」还是「纠偏」。
- 你在纠结「这该是独立 skill，还是某个 skill 的 `references/<topic>.md`」。
- 两个 skill 的 description 触发条件看着会打架 / 抢同一类任务。
- 你在重构 skill 版图（拆 / 并 / 退役 / 新增），需要一个可操作判据而非手感。
- 你要给一个新 / 现有 skill 落一份 DESIGN.md 设计宪法。

## When NOT to use

- **只要写好或施压测试单个 skill 的 body**（craft 诊断、4 类 body 内容、pressure baseline）→ `cc-master-skillsmith`。本 skill 决定「要不要这个 skill」，不决定「这个 skill 的正文怎么写」。
- **要声明 J / 跑触发或行为 eval / 度量改动有没有用** → `grounding-skill-evals`。本 skill 是定性的架构判断，不出 precision/recall 数字。
- **mechanically checkable 的结构约束**（frontmatter 有没有 name、目录布局）→ 别手判，交给 `bash run-tests.sh` 的 content contract + `claude plugin validate .`。

---

## 核心方法论：Counterfactual Probe A/B

每个候选 skill 都过两道 probe，再查决策矩阵。**Probe 是 judgment-bearing 的——能被 "这信息挺有用就建吧" 合理化掉，所以下面配了抗合理化。** 两道 probe 的三/四形态展开 + 评级信号 + worked examples 在 → [`references/counterfactual-probe.md`](references/counterfactual-probe.md)（读它再评分，别凭感觉打 strong/weak）。

- **Probe A 增量**：没有这个 skill，agent 缺哪块知识 / 能力 / 路径，以致任务失败或做错？三形态：A.1 新领域知识 / A.2 新能力（无法用已知原语重构）/ A.3 新路径（不会自发推导）。任一 strong → **A strong**。
- **Probe B 覆写**：没有这个 skill，agent 的默认认知会怎样做错？四形态：B.1 倾向覆写（默认合理化掉纪律）/ B.2 触发覆写（该想到却 out-of-mind）/ B.3 风格覆写（统一基线供下游累积）/ B.4 路径覆写（默认走错路）。任一 strong → **B strong**。

### 增量 × 覆写决策矩阵

| A 增量 | B 覆写 | skill 类别 | 决策 |
|---|---|---|---|
| Strong | Strong | 双价值（典型成熟编排类） | **必建**——最强理由 |
| Strong | Weak | 纯增量（reference-wrap 候选） | **该做某个 skill 的 reference**，不是独立 skill |
| Weak | Strong | 纯覆写（纪律 / 立场 / 方法论） | **应建**——canonical skill 的本色，「没有新信息」不是缺陷，override 即价值 |
| Weak | Weak | 装饰 | **不建 / 退役** |

> **「装饰不建，pure-augmentation 该是 reference」是本 skill 最常被绕过的两条判断。** 矩阵的展开、两条 stance 注解、anti-pattern 表都在 reference；评分前必读。

---

## cc-master 只用 3 条承重维

cc-master 是 2+4 的小 portfolio（2 个分发 + 4 个 dev-only：造/评/治三件套 + `requirement-elicitation` 上游需求发现），**只用三条承重维**（audience-plane / bounded-context / Probe）：任一不过即拒，没有 trade-off 路径——

1. **audience-plane（受众面）**——受众是插件**用户**（装 cc-master 的人 / 替他们行动的 agent）还是仓库**维护者**？维护者用的 dev skill 进 `.claude/skills/`，**不进**分发的 `skills/`，更不进 marketplace。判错受众 = 把 dev 工具混进产品。
2. **bounded-context（单一职责）**——候选是否落入**恰好一个**清晰职责方向？跨两个职责 = 它其实是两个 skill，先拆。
3. **Probe（增量 ∨ 覆写至少一强）**——过上面的 Counterfactual Probe，A 或 B 至少一个 strong。两个都 weak = 装饰，拒。

三维的判定规则 + 重叠检测 + 输出 scoresheet 模板在 → [`references/portfolio-scoresheet.md`](references/portfolio-scoresheet.md)。

---

## 重叠检测

**两个 skill 都过 Probe，但 Probe 答案相同 = overlap signature。** 不是「描述看着像」就重叠——是它们对 agent 的**本质效应**（A 的哪一形态 strong、B 的哪一形态 strong）撞了。消解办法：靠每个 skill 的 `description` 里的 **`Use when … / Do NOT use …` 对子**——每个 skill 显式声明自己的触发条件 + 把对方的领域写成反例。cc-master 红线 3「两 skill 不重叠」就是这条的产物。

检测流程 + 对子写法在 [`references/portfolio-scoresheet.md`](references/portfolio-scoresheet.md) 的「重叠检测」小节。

---

## DESIGN.md 设计宪法

每个站得住的 skill 配一份 6 段 DESIGN.md（本仓 DESIGN.md 统一用 6 段），回答「这 skill 是什么 / 为什么」，**设计先于实现**——任何对 SKILL.md 的实质改动先在 DESIGN.md 更新。六段：① one-liner ② craft 自分类 ③ value triad（plugin / agent / human 三视角）④ 责任边界（IN / OUT 移交表 / boundary heuristic）⑤ 触发与反例 ⑥ 演化锚。

完整模板 + 每段填写指引在 → [`references/design-md-template.md`](references/design-md-template.md)。本 skill 自己的 DESIGN.md（[`DESIGN.md`](DESIGN.md)）就是这套模板的 dogfood 实例。

---

## Quick Reference

| 你面对的问题 | 用什么 | 判据 |
|---|---|---|
| 这块该不该独立成 skill | Counterfactual Probe A/B | A 或 B 至少一强，否则装饰/做 reference |
| 这是 skill 还是 reference | 决策矩阵 | 强增量+弱覆写 → reference；弱增量+强覆写 → 应建 skill |
| 这 skill 放哪 | audience-plane 维 | 维护者用 → `.claude/skills/`；用户用 → `skills/` |
| 这候选职责清不清 | bounded-context 维 | 跨两职责 → 先拆 |
| 两个 skill 会不会撞 | 重叠检测 | 都过 Probe 且 Probe 答案相同 = overlap，用 description 对子消解 |
| 给这 skill 写设计宪法 | DESIGN.md 6 段模板 | 见 reference |
| 单个 body 怎么写 | **→ cc-master-skillsmith** | 不归本 skill |
| 度量这 skill 有没有用 | **→ grounding-skill-evals** | 不归本 skill |

---

## Common Mistakes

| 错法 | 为什么错 / 改法 |
|---|---|
| 「这信息挺有用 → 建个 skill」 | 有用 ≠ 该独立成 skill。先跑 Probe：若纯增量（A strong / B weak），它该是某 skill 的 `references/<topic>.md`，不是独立 skill。 |
| 「没有新信息 → 不值得建」 | 错。纯覆写 skill（A weak / B strong，如 TDD 类纪律）「没有新信息」**正是常态**——override 即价值。 |
| 凭 description 像不像判重叠 | 重叠看的是 **Probe 答案是否相同**，不是字面相似。都过 Probe 且答案撞 = overlap。 |
| 把 dev 工具放进 `skills/` | 受众判错。维护者用的进 `.claude/skills/`（不分发）；只有插件用户用的才进 `skills/`。 |
| 凭感觉打 Probe 评级 | 评级要靠「没有这个 skill，默认 agent 会怎样」的具体 trace，不是 vibe。先读 `references/counterfactual-probe.md` 的 worked examples。 |
| 跨进单个 skill 的 body 去「顺手修」 | 本 skill 只做架构准入，不碰 body。body 归 cc-master-skillsmith。越界 = 红线 3 被破。 |

---

## Red Flags — STOP，你在绕过准入

- 你打算建 skill，但**没跑过 Probe A/B**，只是觉得「这有用 / 这该对仗一下 / 凑齐三件套」。
- 你把一段**纯静态资料**（spec / 字段表 / 一次性步骤）做成了独立 skill，而它本该是 reference。
- 你判定两个 skill「不重叠」，但**没比对它们的 Probe 答案**，只比了 description 字面。
- 你把一个**维护者才用**的 dev 工具放进了分发的 `skills/`。
- 你正打算**亲手改某个 skill 的 body**（那是 skillsmith）或**跑 eval 数字**（那是 grounding-evals），却还挂在本 skill 名下。
- 你开始论证「这次是例外，Probe 不适用」——**这套论证本身就是症状**。

**违背字面就是违背精神。** 「我守的是 portfolio 健康的精神，不是 Probe 的字面」是绕过每一条准入的那句合理化。没有哪个候选特殊到 Probe 失效——当你开始论证*这次*例外，回去跑 Probe。

---

## Pointers

- **[`references/counterfactual-probe.md`](references/counterfactual-probe.md)** — Probe A 三形态 / Probe B 四形态 + 决策矩阵 + 两条 stance 注解 + anti-pattern 表 + worked examples（评分前必读）。
- **[`references/portfolio-scoresheet.md`](references/portfolio-scoresheet.md)** — 3 必维判定规则 + scoresheet 模板 + 重叠检测 + description 对子写法。
- **[`references/design-md-template.md`](references/design-md-template.md)** — 6 段 DESIGN.md 模板 + 每段填写指引。
- **[`OBJECTIVE.md`](OBJECTIVE.md)** — 本 skill 的成功契约（J_top + baseline floor）。`grounding-skill-evals` 是 OBJECTIVE.md 的方法论权威；本 skill 只是按 schema 落一份。
- **`cc-master-skillsmith`** — 单个 skill 的 body 怎么写 / 怎么 pressure-test。本 skill 的 Do-NOT 边界对面。
- **`grounding-skill-evals`** — J 声明 / Track A 触发 eval / Track B 行为 benchmark。本 skill 的另一条 Do-NOT 边界。
- **`AGENTS.md` §3 红线 3 / §6** — 仓库级 portfolio 纪律（两 skill 不重叠、语言纪律、YAML 单引号）。
