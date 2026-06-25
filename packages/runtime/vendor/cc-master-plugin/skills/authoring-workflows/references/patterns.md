# Patterns——编排形状、何时用、住在哪

> 每个 pattern 一节：*何时伸手够它*、一份最小骨架、以及由哪个 bundled 的
> `assets/templates/` 骨架或 `assets/examples/` workflow 演示。这些 pattern 由工具契约和
> 社区目录（ray-amjad、alexop.dev）确认；底层语义见 `mechanism.md`。**本页每个形状都有一个
> bundled 文件演示**——没有只剩 prose 的空壳；每节都点名跑它的那个确切 `assets/templates/`
> 或 `assets/examples/` 文件。

本页引用到的每个 bundled template 和 example：要裸的控制流形状就从 template 抄，要完整、
真实-prompt 的组合就从 example 抄。

## 目录

**控制流 primitive**（各一个 bundled template）
- [fan-out + synthesize](#fan-out--synthesize)
- [pipeline-by-default](#pipeline-by-default)
- [loop-until-count](#loop-until-count)
- [loop-until-budget](#loop-until-budget)
- [loop-until-dry](#loop-until-dry)
- [scout-then-fanout (entry shape)](#scout-then-fanout-entry-shape)

**质量 pattern**（各一个 bundled example）
- [adversarial-verify](#adversarial-verify)
- [perspective-diverse-verify](#perspective-diverse-verify)
- [judge-panel](#judge-panel)
- [multi-modal-sweep](#multi-modal-sweep)
- [completeness-critic](#completeness-critic)
- [migrate / discover → transform → verify](#migrate--discover--transform--verify-with-worktree-isolation)

**组合形态**（各一个完整 bundled example）
- [bug-hunt-loop](#bug-hunt-loop)
- [pr-issue-triage](#pr-issue-triage)
- [dep-upgrade-sweep](#dep-upgrade-sweep)
- [test-generation-and-repair](#test-generation-and-repair)
- [tournament-bracket](#tournament-bracket)
- [self-repair-loop](#self-repair-loop)
- [staged-escalation](#staged-escalation)
- [nested-workflow-composition](#nested-workflow-composition)

---

## fan-out + synthesize

**何时：** 一个任务拆成若干独立部分，而你得把它们*全部*收齐才能合并——「review 这个 diff
里的每个文件」「audit 全部 40 个依赖」「map 每个 struct 字段」。用 `parallel()`，因为综合
那一步要拿整个集合。

```js
const parts = await parallel(items.map((it) => () => agent(`work ${it}`)))
const summary = await agent(`synthesize:\n${JSON.stringify(parts.filter(Boolean))}`)
```

**由谁演示：** `assets/templates/fan-out.js`（裸的 barrier 形状）。

---

## pipeline-by-default

**何时：** 多阶段工作，stage 之间**无须**同步——item A 可以走到 stage 2，而 item B 还在
stage 1。这是任何多阶段形状的**默认**；只有当某个 stage 真的要拿整批前一阶段的集合时，才
升级到 barrier（见 `mechanism.md` §3 的 smell-test）。

```js
const out = await pipeline(items,
  (it) => agent(`stage 1 for ${it}`),
  (prev, it) => agent(`stage 2 for ${it} using ${JSON.stringify(prev)}`),
)
```

**由谁演示：** `assets/templates/pipeline.js`（裸的流式形状）。

---

## adversarial-verify

**何时：** finding 必须可信。对每个 finding，派一个 skeptic agent 去试着 **refute** 它
（默认 `isReal = false`；证据不足 → 就毙掉它）。只留下幸存者。这是典范的质量乘数——让
独立的 agent 互相攻击对方的主张，直到答案收敛。

```js
const verified = await pipeline(findings,
  (f) => agent(`Try to REFUTE this finding. Default isReal=false if unsure:\n${JSON.stringify(f)}`,
    { schema: { type: 'object', properties: { isReal: { type: 'boolean' } }, required: ['isReal'] } })
    .then((v) => ({ ...f, verdict: v })))
return verified.filter((f) => f.verdict?.isReal)
```

**由谁演示：** `assets/examples/review-adversarial-verify.js`（dimensions → find →
逐个 finding 做 adversarial verify）。

---

## perspective-diverse-verify

**何时：** 一个 finding 可能以好几种不同方式翻车，单一 verifier 的视角会漏掉那些它管不到
的失败模式。给每个 verifier 配一面**不同的 lens**——correctness / security / performance /
reproducibility——并要求这个 finding 在每一面之下都存活下来。这是 adversarial-verify 的
diverse-lens 变体。

```js
const LENSES = ['correctness', 'security', 'performance', 'reproducibility']
const verdicts = await parallel(LENSES.map((lens) => () =>
  agent(`Verify this finding from the ${lens} angle — try to break it:\n${JSON.stringify(finding)}`,
    { label: `verify:${lens}` })))
```

**由谁演示：** `assets/examples/review-adversarial-verify.js`——它的 `DIMENSIONS`
（bugs / security / perf）在 *find* stage 就贯彻了同样的 diverse-lens 思路；当某个 finding
值得时，把同一份 lens list 搬到 *verify* stage 用。

---

## judge-panel

**何时：** 解空间很宽，「在一个 attempt 上反复迭代」不如「生成几个独立 attempt 再挑」。从
不同角度生成 N 个方案（MVP-first / risk-first / user-first），用一个并行 judge 给它们打分，
从胜者综合、再把亚军里最好的部分嫁接过来。

```js
const proposals = await parallel(ANGLES.map((a) => () => agent(`design from angle: ${a}`)))
const scored = await parallel(proposals.filter(Boolean).map((p) => () =>
  agent(`score 0-10:\n${JSON.stringify(p)}`, { schema: SCORE }).then((s) => ({ ...p, score: s.score }))))
const winner = scored.filter(Boolean).sort((a, b) => b.score - a.score)[0]
const final = await agent(`synthesize from the winner:\n${JSON.stringify(winner)}`)
```

**由谁演示：** `assets/examples/design-judge-panel.js`。

---

## loop-until-count

**何时：** 你有一个明确的目标 count——「找 10 个 bug」「产出 5 个选项」。count 没到目标
就 loop，但**永远**留一个硬停（这里目标*本身*就是那个停；绝不写无界的 `while`）。

```js
const found = []
while (found.length < 10) {
  const r = await agent('find the next item not yet found')
  found.push(r)
}
```

**由谁演示：** loop 控制流 template 算一个家族——把
`assets/templates/loop-until-dry.js` 里的 dry-round 守卫换成一个 count 守卫即可。

---

## loop-until-budget

**何时：** 深度要随用户的 `'+Nk'` budget 指令伸缩，而理想的 count 又说不准。共享 token
budget 还有余量就 loop。`budget.total` 守卫是必须的——少了它，`remaining()` 就是
`Infinity`，loop 会一路跑到 1,000-agent 的 cap。

```js
const RESERVE = 50_000
const out = []
while (budget.total && budget.remaining() > RESERVE) {
  out.push(await agent('produce the next batch'))
}
```

**由谁演示：** `assets/templates/loop-until-budget.js`。

---

## loop-until-dry

**何时：** 规模未知的发现——找出*所有* bug、*所有*调用点。固定计数会漏掉尾巴，dry-round
不会。去重要对着 `seen` 集合做（别用 `confirmed` 集合，否则被拒的项每轮都重新冒出来、loop
永不收敛），连续 K 个 round 什么新东西都没冒出来就停。

```js
const DRY_LIMIT = 2
const seen = new Set(), all = []
let dry = 0
while (dry < DRY_LIMIT) {
  const r = await agent('find items not yet in the seen set', { schema: ITEMS })
  const fresh = (r.items ?? []).filter((x) => !seen.has(x))
  if (fresh.length === 0) { dry++; continue }
  dry = 0
  fresh.forEach((x) => { seen.add(x); all.push(x) })
}
```

**由谁演示：** `assets/templates/loop-until-dry.js`。

---

## multi-modal-sweep

**何时：** 一个问题最好从几个**独立角度**分头搜索来回答，各角度各抓到不同的东西——按
keyword/grep、按 entity/symbol、按 structure/architecture、按 history/changelog。把所有
角度横扫一遍，再在昂贵的 deep-read 之前对整个集合去重（这里 barrier *是*对的——去重得
攒齐每个角度的命中）。

```js
const swept = await parallel(ANGLES.map((a) => () => agent(`research the question ${a}`, { schema: HITS })))
const deduped = [...new Set(swept.filter(Boolean).flatMap((r) => r.hits ?? []))]
const reads = await pipeline(deduped, (ref) => agent(`deep-read ${ref}`))
```

**由谁演示：** `assets/examples/research-multimodal-sweep.js`。

---

## completeness-critic

**何时：** 你想知道自己*漏了*什么，而不只是确认自己找到了什么。工作做完后，派一个 critic
agent 去问「漏了什么——哪个角度没横扫、哪条主张没核实、哪个来源没读？」它揪出来的就是下
一轮的工作。和 multi-modal-sweep、以及任何发现 loop 都天然配对。

```js
const gaps = await agent(
  `Given these findings, what is MISSING — an unswept angle, an unverified claim, an unread source?\n${JSON.stringify(findings)}`)
```

**由谁演示：** `assets/examples/research-multimodal-sweep.js`（它最后那个 `Critique`
phase 正是这个 critic）。

---

## migrate / discover → transform → verify（带 worktree 隔离）

**何时：** 一场迁移触及很多 site，你得 (1) 把它们发现出来、(2) 在隔离里逐个 transform，让
并行编辑不冲突、(3) 用一道 gate 验证。这是唯一需要 `isolation: 'worktree'` 的形状——每个
site 在自己的 worktree 里 transform，并发的文件编辑绝不撞车。

```js
const found = await agent('enumerate every migration site', { schema: SITES })
const out = await pipeline(found.sites ?? [],
  (site) => agent(`apply migration to ${site}, commit in your worktree`, { isolation: 'worktree' }),
  (prev, site) => agent(`verify the migration at ${site} (run the gate)`, { schema: VERIFY }).then((v) => ({ site, ...v })))
```

**由谁演示：** `assets/examples/migrate-discover-transform-verify.js`（唯一用
`isolation: 'worktree'` 的 bundled 资产）。

---

## scout-then-fanout (entry shape)

**何时：** 动手之前你还不知道 work-list——现实里最常见的入口形状。让一个 scout agent 返回
这份 list，再对它 pipeline / parallel。（通常你会把 scout 内联在主线里跑；这里给的是
in-workflow 的版本。）

```js
const scout = await agent('enumerate the work items as a JSON list', { schema: ITEMS })
const out = await pipeline(scout.items ?? [], (it) => agent(`process ${it}`))
```

**由谁演示：** `assets/templates/scout-then-fanout.js`。

---

## 组合形态——完整的真实-prompt workflow

这些把上面的 primitive 和质量 pattern 拼成完整、可跑的 workflow。每一个都作为一个 bundled
`assets/examples/` 文件 ship，你可以整套抄走。

---

## bug-hunt-loop

**何时：** 全仓找 bug，你既不知道总共有多少、又要求每个报出来的 bug 都可信。把
**loop-until-dry**（一直搜到 K 个 dry round 都挖不出新东西）和 **adversarial-verify**
（出报告前对每个幸存者 refute 一遍）组合起来。当 completeness *和* 低误报率都要时，用它，
而不是单趟 review。

**由谁演示：** `assets/examples/bug-hunt-loop.js`。

---

## pr-issue-triage

**何时：** 你有一批打开的 PR/issue 要分类、定优先级，但这份 list 事先并不知道。组合
**scout-then-fanout**（scout 出打开的项）→ 对每项 fan-out 一个分类器 → **judge-panel** 把
标好的这一批排成优先级队列。用它来「triage 整个 backlog」，而不是处理单个已知项。

**由谁演示：** `assets/examples/pr-issue-triage.js`。

---

## dep-upgrade-sweep

**何时：** 你想一次 bump 很多依赖，每个 upgrade 各自隔离让并行编辑不冲突、只保留仍然绿的
bump。这是带 `isolation: 'worktree'` 的 **discover → transform → verify** 形状、特化到依赖
升级（发现过时的 dep → 在各自的 worktree 里逐个 upgrade → gate → 留下绿的）。用它做批量
依赖维护。

**由谁演示：** `assets/examples/dep-upgrade-sweep.js`。

---

## test-generation-and-repair

**何时：** 你想给很多 module 生成 test suite，*并且*要让每个失败的 suite 被自动驱动到绿。
把一个 fan-out 的 test-generation stage 和一个 per-suite 的 **self-repair-loop**（带有界的
attempt cap）组合起来。用它来「跨 codebase 生成并稳住 test」，而不是处理单个 test 文件。

**由谁演示：** `assets/examples/test-generation-and-repair.js`。

---

## tournament-bracket

**何时：** 你有很多候选，想靠两两淘汰、而非绝对打分选出单一胜者（judge-panel 是*绝对*
打分；bracket 是*相对*比较）。跑若干 round：把候选两两配对、一个 judge agent 挑出每对的
胜者、把场地减半、如此重复到只剩一个。每个 round 就是对各对的一次 `parallel()`；round 之间
的 loop 是一句朴素的 `while (field.length > 1)`。当相对比较比绝对 0–10 分更可靠、且场地大到
给每个都打分太浪费时，用它。

**由谁演示：** `assets/examples/tournament-bracket.js`。

---

## nested-workflow-composition

**何时：** 一个可复用的子流程已经存在——它是一个 saved workflow（或你早先 Write 出来的脚本
文件）——而你想把它当作更大脚本里的一个步骤来跑：逐项、带它自己的 `args`。
`workflow(nameOrRef, args)` 内联跑这个 child：它共用 parent 的并发 cap、agent 计数器、abort
signal 和 token budget（它的 token 计入 `budget.spent()`），它的 agent 渲染在一个 `▸ name`
group 下。两条硬边界：嵌套**只有一层**（child 里再调 `workflow()` 会抛错——让 child 保持
leaf-shaped），且名字未知 / `scriptPath` 读不到 / child 语法错误都会**抛错**——把这个调用
逐项包进一个 `catch`，这样坏掉的 child 只降级成一个内联 fallback，而不是把 parent 一起
拖死。别为了「让代码整齐」就伸手够它：一次 child run 要背上一整套 workflow 的机器开销——只
在 child 真的可复用、或需要独立维护时才组合。

**由谁演示：** `assets/examples/nested-workflow-composition.js`。

---

## self-repair-loop

**何时：** 一个 agent 的输出必须通过某个 gate，而你想让它在有限次 attempt 之内自己修自己的
失败。Loop：产出 → 跑 gate → 没过就把 gate 的诊断喂回下一次 attempt 的 prompt；通过、或到
`MAX_ATTEMPTS` 就停。这相当于把计数器换成结构化 pass/fail gate 的 loop-until-{count}，再加
一道硬 attempt cap 当保险丝。dedup-against-seen 在这里**不**适用（被修的始终是同一个 item），
保险丝就是 attempt 计数。用它做「把这个改到能编译 / 能测过」的单-artifact 收敛——*不是*用于
多-finding 的发现。

**由谁演示：** `assets/examples/self-repair-loop.js`。

---

## staged-escalation

**何时：** 工作应当从便宜起步，只在便宜的 stage 失败或返回低信心时，才升级到昂贵的
模型 / 方法。用一个 `pipeline()`：stage 1 是一趟便宜 pass，stage 2 有条件触发——当 stage 1
已经越过信心阈值时 stage 2 短路（原样返回 stage-1 的结果），只有没越过时才派生昂贵的
`agent('escalate: ' + item, { model: ... })`。用它把强模型只花在弱模型吃力的地方，而不是
一律都上。当心：`model` 是 cache key 的一部分（`api-reference.md`），所以你一旦改了 model
选择，escalation 分支在 resume 时会 live 重跑。

**由谁演示：** `assets/examples/staged-escalation.js`。
