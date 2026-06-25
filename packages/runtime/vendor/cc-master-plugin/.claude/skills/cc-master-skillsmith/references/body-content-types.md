# body 只装 4 类内容 —— 4 层写作分配 + 阈值

**何时读：** craft 诊断（[`craft-axis-diagnosis.md`](craft-axis-diagnosis.md)）定下
craft 之后、动笔写 body 时；以及写完做 progressive-disclosure 自检时。本文回答
「body 该装什么、不该装什么、超了往哪拆」。

## Contents

- [原则：SKILL.md 是入口不是百科](#原则skillmd-是入口不是百科)
- [4 类合法 body 内容（硬规则）](#4-类合法-body-内容硬规则)
- [4 层写作分配表](#4-层写作分配表)
- [各 craft 怎么填这 4 类](#各-craft-怎么填这-4-类)
- [progressive-disclosure 阈值](#progressive-disclosure-阈值)
- [写完做这一遍 pass](#写完做这一遍-pass)

---

## 原则：SKILL.md 是入口不是百科

`SKILL.md` 是入口——agent 在一次 context load 里扫完。`references/` 是按需的
深度层——只在 agent 为某一步需要时才加载。三层加载模型（Anthropic skill-spec
的 progressive disclosure）：

1. **metadata** —— frontmatter（`name` + `description`）。永远在 context，
   router 用它选 skill。
2. **body** —— SKILL.md 其余部分。invoke 时加载，必须自包含到不拉更多文件就能
   开工。
3. **bundled resources** —— `references/` / `scripts/`。只在 body 为某一步引用时
   才加载。

这个加载模型塑造每一个 body 写作决策：invoke-time 要读的留 inline，深方法论拆到
references。

> cc-master 特例：SKILL A（`orchestrating-to-completion`）由 SessionStart hook
> 每次 compaction **全文重注**。它的 body **越短越好**——新增内容前先问「这能不
> 能进 references 让主文件保持瘦」。重注友好 = 比一般 skill 更严的瘦身纪律。

---

## 4 类合法 body 内容（硬规则）

SKILL.md 的 body **只装这四类**，其余一律进更深的层。

1. **触发（trigger）** —— frontmatter 的 `description` 字段 + 任何「When to use /
   When NOT to use」prose。驱动 trigger router。
2. **命名锚（mental-anchor naming）** —— agent 留在工作记忆里的、命名的概念把手
   （hyphenated 概念，如 `指挥不演奏`、`端点验收`、`gate-green≠passed`）。每个锚
   = 一个名字 + 一段 **5–15 行**的紧 rationale；完整方法论进 reference。
3. **流程骨架（process skeleton）** —— agent 要走的编号步骤。每步说清它的 purpose
   + 关键决策 gate，再指向 reference 看 walkthrough。子分支的决策细节**不**住在
   骨架里。
4. **硬约束（hard constraints）** —— schema-shaped 的 reject-and-surface 规则、
   agent 不可违反的不变量、red flags。短而绝对，不带合理化。

一段 body 若不落进这四类之一，它属于某个 reference。无例外。

---

## 4 层写作分配表

cc-master 的 skill 用四个物理层。每层有不同的写作分配。（cc-master 不强制
templates 层；多数 dev skill 是 SKILL.md + references，需要可执行逻辑时才加
scripts，且 scripts **只进 `scripts/`，绝不进 `hooks/`**——红线。）

| 层 | 装什么 | 不装什么 |
| --- | --- | --- |
| **`SKILL.md` body**（≤500 行） | 触发；命名锚名 + 5–15 行 rationale；编号流程骨架（每步 purpose + 决策 gate）；硬约束 / red flags | 完整方法论 walkthrough；穷举式步骤；子分支决策表；长 worked example |
| **`references/<topic>.md`**（一层深） | 方法论展开；决策表；子分支路由；完整 walkthrough；陷阱目录；多个 worked example；长 rationale | 实现代码；确定性逻辑 |
| **`scripts/<name>.sh\|.py`**（仅 cc-master 带外脚本，进 `scripts/` 不进 `hooks/`） | 自动化原语；确定性逻辑；lint；生成器；探针 | prose 解释；judgment 判断 |
| **`templates/<name>.md`**（按需，非必备） | subagent dispatch prompt 脚手架；输出模板；fixtures | 一般方法论（那进 references） |

agent 读的每一段都有唯一的家，由它承载哪类 guidance 决定。混了分配——body 里塞
长 worked example、template 里写一般方法论——会悄悄破坏加载模型，并把它漏进的那
层撑爆。

---

## 各 craft 怎么填这 4 类

诊断定的 craft 决定这四类的**配比**，不是有无：

- **Craft A 机械配方（强 process × 弱 cognitive）**：以**流程骨架 + 硬约束**为主
  （祈使语气、编号步骤、决策表、验证门、每步自检）。命名锚极少或没有，无哲学
  叙事。触发照常。
- **Craft B 心智模型（弱 process × 强 cognitive）**：以**命名锚**为主（每个 5–15
  行）+ before/after 对比 + 陷阱表 + why 解释 + 抗合理化。无祈使编号清单。流程骨架
  退化为「方向」而非「步序」。
- **Craft C 纪律级（强 process × 强 cognitive）**：四类都重——**命名锚在前**
  （substrate）、**流程骨架在后**（surface）、**硬约束 backstop**（扛住每一种合理
  化压力的红线）、加一句「为何不可妥协」把硬约束锚回命名锚。skillsmith 自己就是
  Craft C。

形状错配的自检：命名锚段很重而流程段很薄 → 是 B 或 C；编号祈使主导而无锚段 →
是 A；两者都重且带硬规则 backstop → 是 C。诊断说 B 却写成纯编号清单 = fail-loud，
回炉。

---

## progressive-disclosure 阈值

- **SKILL.md ≤ 500 行**。到 500 行即视为披露失败——停下，审哪些段该进 references。
- **≥ 100 行 distinct 内容 → 拆到 `references/<topic>.md`**。inline 只留 agent 要
  读才能往下走的决策步骤（短、高紧迫、不接受加载开销）；深方法论（表、穷举例子、
  pattern 目录、带证据的 worked example）拆出去。
- **references 一层深** —— 没有 `references/subdir/<file>.md`。两级间接破坏扫描
  模型。若某 reference 主题真需要子文件，信号是它长成了自己的 skill——拆成 sibling。
- **>100 行的 reference 顶部加 `## Contents` 锚点 TOC** —— agent 扫长 reference 找
  一节时，TOC 是 skip map。<100 行不需要。
- **no orphan** —— `references/` / `scripts/` / `templates/` 下每个文件都必须从
  SKILL.md 沿引用图可达。不可达文件付了维护成本却不进运行时。

---

## 写完做这一遍 pass

body 草稿写完，做一遍显式 pass：

> **逐段读 body。问：它属于 4 类合法内容之一吗？不属于，就移到对应 reference
> （或 scripts / templates），在 body 里换成一行指针。**

漂移多半以「只占几行」的 worked example、或作者想「放手边」的子分支表的形态混进
body。两者加时都显得便宜，都在多次编辑里复利、撑破 500 行上限。一出现就移出去。
每次实质 body 编辑后重跑这一遍——测试是机械的（每段是否落进四类之一），不是审美的。
