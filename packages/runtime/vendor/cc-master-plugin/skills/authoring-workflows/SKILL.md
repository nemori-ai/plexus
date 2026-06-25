---
name: authoring-workflows
description: '当你要调用 Workflow 工具，或要写 / 调试 / 启动一个 Claude Code dynamic-workflow 脚本时用——author / debug / launch a Claude Code dynamic-workflow script，当你要写 workflow 脚本时——哪怕你自觉已经懂这套 API。当你发现自己在猜 workflow 引擎的 determinism 或 resume 规则、没查 shape 就伸手够 parallel() / pipeline()、想手写一个 validation linter、或刚被 harness 报错正要 relaunch 时用。先查再猜，别等跑挂了才来。'
---

# 写 dynamic workflow

一个 dynamic workflow 把「下一步跑什么」的决策从 LLM 手里收走，交给一段
**确定性的 JavaScript 脚本**，由 runtime 在后台执行。要写这样的脚本，就用本 skill。这里
要守的纪律很少，就三条：**先问清自己到底需不需要 workflow、按 work 的形状选范式、照
runtime 自己的 validation 契约来写——权威的闸是 harness，别去重新实现它。**

## 1. 先问清自己——你究竟需不需要 workflow？

workflow 是有开销的，只有一种情况配得上：任务要协调**几十到几百个 agent**，且必须把中间
结果挡在 context *之外*。除此之外都是大材小用。

- 两行的 bugfix **不**需要一个五-agent 的 review panel。
- 一次单点查询**不**需要 fan-out。
- 一条推理链、一份交付物——dispatch 一个 sub-agent 就行，不是 workflow。

下面三条至少命中一条，才上 workflow：work 会 fan out 成很多独立单元、中间产物会淹掉你的
context、或者你想复用一套质量 pattern（adversarial cross-review、judge panel）。一条都不
沾，就到此为止。

## 2. 范式决策树

照 work 的**形状**选，不是凭口味。（完整语义见 `references/mechanism.md`；完整 pattern
目录见 `references/patterns.md`。）

- **任务互相独立，且你要把全部结果一起收齐** → **fan-out**
  （`parallel()`，一道 barrier）。模板：`assets/templates/fan-out.js`。
- **多阶段、阶段之间无须同步** → **pipeline**
  （`pipeline()`，流式——**默认就用它**；item A 可以走到 stage 2，而 item B 还在 stage 1）。
  模板：`assets/templates/pipeline.js`。
- **数量未知** → **loop**：
  - 深度要随一个 `'+Nk'` budget 伸缩 → **loop-until-budget**
    （`assets/templates/loop-until-budget.js`）。
  - 规模未知的发现（找出*所有*某类东西）→ **loop-until-dry**
    （`assets/templates/loop-until-dry.js`）。
- **连 work-list 都还不知道** → **scout-then-fanout**：先派一个 scout agent 把这份 list
  枚举出来，再对它 pipeline / parallel。这是现实里最常见的入口形状。
  模板：`assets/templates/scout-then-fanout.js`。

> **默认用 `pipeline()`。** 只有当下游某个 stage 真的要拿*整批*前一阶段的集合时（dedup /
> merge、按 count 提前退出、「跟其余全部比一遍」），才换成 barrier（`parallel()`）。「代码更
> 整齐」不是理由——barrier 的 latency 是实打实的。见 `references/mechanism.md` §3 的
> smell-test。

> **真实的 workflow 会把这几种形状叠在一起。** fan-out 里套一个 loop、scout 之后接一个
> verify stage、pipeline 当中夹一道 self-repair gate——这些组合形态（bug-hunt-loop、
> pr-issue-triage、dep-upgrade-sweep 等）住在 `references/patterns.md`，并整套 ship 在
> `assets/examples/` 里。当你的 work 套不进任何一个裸形状时，从最接近的那个组合 example
> 起手。

## 3. 写作流程——照 harness 契约起草，再 launch

1. **起草**：从 `assets/templates/` 里的某个骨架（或 `assets/examples/` 里某个完整组合）
   起手，填进真实的 prompt、schema、work-list。`meta` 必须是第一条语句、且是一个纯字面量
   （`name` + `description`）。
2. **照 harness 的 validation 契约写。** runtime 才是权威的 checker——**没有一个独立的
   linter 要你跑，你也不该自己造一个**。契约如下：
   - `meta` 是第一条语句、是纯字面量（`name` + `description` 必填）——harness 在 **launch
     时**校验。
   - 不出现 `Date.now()` / `Math.random()` / 无参 `new Date()`——它们会破坏 resume，harness
     在 **runtime 抛错**。
   - 不出现 `require` / node-builtin import / `process.*`——sandbox 一律拒收。
   - `parallel()` 收 thunk（`() => ...`），不收裸 promise（裸 promise 会立刻 eager 执行、
     barrier 也就丢了）。
   - 守住 caps（16 并发 / 1,000 总量 / 单次调用 4,096 / 512 KB）。

   每条约束的含义和缘由见 `references/mechanism.md`。
3. **Launch。** harness 拒收脚本或抛错时，它的报错就是权威——读它，照
   `references/mechanism.md` 修好，再 relaunch。

> **为什么不配 linter？** `meta`（launch 时）和 determinism / caps / escape（runtime 时）
> harness 都已经权威地校验过了。再造一个独立的 static linter，无非是把 harness 自己的检查
> 用启发式重写一遍——会漂、还比真货差。所以本 skill 只教你契约，不 ship 第二个 validator。
> （编排原则「信确定性 endpoint、不信 prose 自检」在这里由 harness 兑现——它*就是*那个
> endpoint。）

## 4. Reference 索引——动手猜之前先读

- **`references/mechanism.md`**——**对引擎下任何判断之前**先读它。已确认的契约 vs 内部
  未知；7 个 primitive 的真实语义；`parallel`（barrier）vs `pipeline`（streaming）+
  smell-test；`Date.now()` 为什么会破坏 resume；resume =「最长未变前缀」；硬 caps
  （16 并发 / 1,000 总量 / 单次调用 4,096 / 512 KB）。
- **`references/patterns.md`**——挑*形状*：控制流 primitive（fan-out+synthesize、
  pipeline-by-default、loop-until-{count,budget,dry}、scout-then-fanout）、质量 pattern
  （adversarial-verify、perspective-diverse-verify、judge-panel、multi-modal-sweep、
  completeness-critic、migrate→transform→verify）、组合形态（bug-hunt-loop、
  pr-issue-triage、dep-upgrade-sweep、test-generation-and-repair、tournament-bracket、
  self-repair-loop、staged-escalation）。顶部有一份 section TOC；每节都讲清*何时*用 +
  骨架 + 由哪个 bundled 资产演示。**每个形状都有一个 bundled 文件演示**——没有只剩 prose
  的空壳形状。
- **`references/api-reference.md`**——primitive 签名、`agent()` 的每个选项
  （`label`/`phase`/`schema`/`model`/`isolation`/`agentType`）、cache-key 四要素、failure
  语义。没有任何编造的选项。
- **`assets/templates/`**——5 个控制流骨架（copy → fill）。

### `assets/examples/`——12 个完整、真实-prompt 的 workflow（分别何时读）

| Example | 何时读 |
|---|---|
| `review-adversarial-verify.js` | 跨多个维度 review 改动的代码，再在出报告前逐条 refute 每个 finding（adversarial-verify 的典范组合）。 |
| `design-judge-panel.js` | 生成 N 个独立设计方案、用一个 judge panel 打分、从胜者综合。 |
| `research-multimodal-sweep.js` | 从多个搜索角度研究一个问题 → dedup → deep-read → completeness critic。 |
| `migrate-discover-transform-verify.js` | 一场迁移：先发现 site，在隔离 worktree 里逐个 transform，再 gate-verify（唯一用 `isolation:'worktree'` 的资产）。 |
| `bug-hunt-loop.js` | 全仓搜 bug 直到连续 K 个 dry round，再对每个幸存者 adversarially verify（loop-until-dry + adversarial-verify）。 |
| `pr-issue-triage.js` | scout 打开的 PR/issue、fan out 一个分类器、用 judge 把这批排成优先级队列（scout-then-fanout + judge-panel）。 |
| `dep-upgrade-sweep.js` | 发现过时的 dep，在隔离 worktree 里逐个 upgrade、gate，只保留转绿的 bump。 |
| `test-generation-and-repair.js` | 给每个 module 生成 test，再在 attempt cap 之内把每个失败的 suite self-repair 到绿。 |
| `tournament-bracket.js` | 靠两两淘汰从众多候选里选出一个胜者（相对比较，不是绝对打分）。 |
| `self-repair-loop.js` | 把一个 artifact 驱动到通过某个 gate，把失败诊断喂回有界的重试。 |
| `staged-escalation.js` | 先用便宜的 pass 试每一项；只在信心低的地方升级到强模型。 |
| `nested-workflow-composition.js` | 用 `workflow()` 把一个 saved/file workflow 当子步骤组合进来（共享 budget/caps、一层嵌套、逐项 catch-and-degrade，唯一用 `workflow()` 的资产）。 |

每个 bundled template 和 example 都是照 harness 契约写的，随便挑一个都是 known-good 的
起点。
