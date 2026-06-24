# Mechanism——Workflow runtime 实际是怎么跑的

> 对引擎下任何判断**之前**先读它。它的存在就是为了挡掉两类错误：(1) 靠猜来断定代码到底
> 是不是并行跑的，(2) 把逆向工程出来的民间传说当真，而 live 的工具契约其实早就变了。
> 改编自一份 Claude Code dynamic-workflow 机制的 research report。

## 目录

- [§0 契约 vs 内部](#0-the-one-distinction-that-governs-everything-contract-vs-internals)
- [§1 一句话本质](#1-one-line-essence)
- [§2 7 个 primitive + 2 个注入对象](#2-the-7-primitives--2-injected-objects-true-semantics)
- [§3 `parallel`（barrier）vs `pipeline`（streaming）+ smell-test](#3-parallel-barrier-vs-pipeline-streaming--the-core-clarification)
- [§4 Determinism三禁——以及为什么](#4-determinism三禁-the-three-forbidden-things--and-why)
- [§5 Resume =「最长未变前缀」](#5-resume--longest-unchanged-prefix)
- [§6 硬 caps](#6-hard-caps-resource-bounds)
- [§7 后台执行](#7-background-execution-the-contract-that-makes-the-main-thread-free)

## 0. 统御一切的那个区分：契约 vs 内部

永远把两层分开：

- **行为契约**——runtime *承诺*一个 primitive 做什么。这有文档：来自递给 agent 的
  `Workflow` 工具 schema 和 `code.claude.com/docs/en/workflows`。**它可以依赖。**
- **内部机制**——runtime *怎么*兑现那个承诺（sandbox 的具体形态、journal 文件格式、cache
  index 的确切实现）。这是个黑箱，Anthropic 几乎从不为它写文档。**别拿它当任何判断的地基。**

对作者来说，契约就够了。其下凡标「confirmed」的都是契约级；凡标「unknown」的都是你绝不能
依赖的内部。

### 已确认的契约（依赖这些）

| 事实 | 确认来源 |
|---|---|
| `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/`workflow()`/`args`/`budget` 语义 | tool schema（first-party） |
| `parallel` 是一个 **barrier**；`pipeline` 是 **no-barrier streaming** | tool schema |
| Failure 语义（thunk throw → `null` 槽位；stage throw → item 被丢） | tool schema |
| determinism三禁 抛错（`Date.now`/`Math.random`/无参 `new Date()`） | tool schema（behavior） |
| resume = `agent()` 调用的**最长未变前缀** | tool schema |
| 并发 `min(16, cpu cores − 2)` per workflow | tool schema |
| 每次 run 总计 1,000 agent；每次 `parallel`/`pipeline` 调用 4,096 item；脚本 512 KB | tool schema |
| `budget` = `{total, spent(), remaining()}`；`spent()` = output token，跨 main loop + 所有 workflow 共享 | tool schema |
| `workflow()` 是一层嵌套；子 workflow 共享并发/计数器/abort/budget | tool schema |
| `args` **原样作为真正的 JSON 值**传入（不被 stringify） | tool schema |

### 内部未知（绝不依赖这些）

- sandbox 究竟是 `vm`-module 的进程内 sandbox、QuickJS、还是 `isolated-vm`。（「V8 isolate」
  那套说法是**民间传说**——它其实描述的是*另一个*产品，Cloudflare 背后的 Managed Agents，
  不是 workflow runtime。）
- cache key 真正的 index（content-hash vs positional index+content）。
- journal 的 on-disk 格式（`agent-<id>.jsonl` 是社区的猜测）。
- determinism 守卫是一个 pre-execution 的 AST gate 还是一个 runtime throw。
- 180 s 的 per-agent stall timeout 和 30 s 的 VM timeout（社区单来源；依赖前先对当前
  build 重新核实）。

## 1. 一句话本质

一个 dynamic workflow 把「下一步跑什么」的决策**从 LLM 手里收走、交给一段确定性的
JavaScript 脚本**。LLM 把脚本写一次；runtime 在后台执行它。中间结果活在**脚本变量**里，
而不在 context window 里——只有最终答案回到 caller。一次 run 能协调几十到几百个 agent 却
不淹掉 context，靠的正是这一点。

脚本是个**纯协调器**：没有文件系统、没有 shell、没有 Node API。所有带副作用的活（读、写、
跑命令）都委托给带一次性 context 的 leaf agent，只有它们的结果回来。

## 2. 7 个 primitive + 2 个注入对象（真实语义）

| Primitive / 对象 | 它做什么 | Barrier？ |
|---|---|---|
| `agent(prompt, opts?)` | 派生一个 fresh-context 的 leaf subagent；返回它的文本，给了 `schema` 时返回一个已校验对象。用户跳过 → `null`。 | n/a |
| `parallel(thunks)` | 并发跑一个 **thunk 数组**，等齐全部。 | **YES** |
| `pipeline(items, ...stages)` | 让每个 item 独立流过所有 stage。 | **NO** |
| `phase(title)` | 为接下来派生的 agent 开启一个命名的 progress group。 | n/a |
| `log(message)` | 在 progress tree 上方发一行叙述。 | n/a |
| `workflow(nameOrRef, args?)` | 内联跑另一个 workflow（只有一层）。 | n/a |
| `args` | 传给本次 run 的输入值，原样作为全局暴露。 | n/a |
| `budget` | `{total, spent(), remaining()}`——共享的 output-token 池。 | n/a |

`agent()` 细节：不给 `schema` 时返回 leaf 的最终文本（一个 string）；给了 JSON `schema`
时返回一个已校验的**对象**（不用 `JSON.parse`）——校验在 tool-call 层发生，不匹配就让
model 重试。被用户跳过的 agent 返回 `null`，这就是到处都见 `.filter(Boolean)` 的缘由。
（完整 opts 见 `api-reference.md`。）

## 3. `parallel`（barrier）vs `pipeline`（streaming）——核心澄清

两者都「并行跑东西」，但**形状**截然不同。这是最常见的混淆来源。

**`parallel(thunks)`——一道 barrier fan-out。**
- 收一个 **thunk 数组**：`[() => agent(...), () => agent(...)]`——**不是** promise 数组。
  （裸 promise 会立刻启动、绕开并发限流器，是个已知的反模式。）
- 它是一道 **barrier**：返回前等齐*每一个* thunk。
- 它**绝不 reject**：抛错的 thunk 在自己的结果槽位里变 `null`。所以总要 `.filter(Boolean)`——
  这个结果数组天生就会有洞。
- **只**在下游某步真的要一次性拿到整个集合时才用：跨集合的 dedup / merge、按 count 提前
  退出（「0 bug → 跳过全部 verification」），或拿单个 item 跟整组比。

**`pipeline(items, ...stages)`——no-barrier 流式。**
- 每个 item **独立**流过**所有** stage——item A 可以在 stage 3，而 item B 还在 stage 1，
  stage 之间没有 barrier。
- 墙钟时间 ≈ *最慢那个 item 走完整条链*的耗时，不是各步最慢 stage 加总。
- 每个 stage 回调收到 `(prevResult, originalItem, index)`——用 `originalItem`/`index` 给后
  续 stage 标注，别手动把 context 一路串下去。
- 抛错的 stage 把那个 item 降为 `null`，并跳过它余下的 stage。
- **多阶段工作就默认用它。**

### Smell-test（决定用哪个）

如果你发现自己在写：

```js
const a = await parallel(...)
const b = transform(a)        // flatten / map / filter — NO cross-item dependency
const c = await parallel(b.map(...))
```

……那么中间这个 `transform` **不**需要 barrier——把它改写成一个 pipeline：
`pipeline(items, stageA, r => transform([r]).flat(), stageB)`。

只有当 stage N 真的要拿 stage N−1 的*整个集合*时（dedup / merge、按 count 提前退出、
「跟其余每个 finding 比」），barrier 才站得住。「代码更整齐」和「这些 stage 概念上各自
独立」**都不是**用 barrier 的理由——barrier latency 是实打实的：5 个 finder、最慢的是
最快的 3 倍时，barrier 白白浪费掉那几个快 finder 三分之二的空闲时间。

## 4. Determinism三禁（三件被禁的事）——以及*为什么*

在 workflow 脚本里，三个经典的 JavaScript 非确定性来源会**抛错（fail-loud）**：

1. `Date.now()`
2. `Math.random()`
3. 无参 `new Date()` / `Date()`——但 `new Date(specificValue)` 没问题。

**为什么：** 一次 run 会被 journal 记下来以便 resume。Resume 时，未变前缀的 `agent()`
结果直接从 cache 重放（§5）。要是脚本的*控制流*依赖了墙钟或某次随机抽样，重放就会和原始
run 分叉、journal 也就失去意义——cache 会悄悄变 stale。所以 runtime 干脆禁掉这种非确定性，
而不是让 resume 默默坏掉。

**变通办法：**
- 需要时间戳？用 `args` 传进来。
- 需要让 agent 各不相同？按 **loop index** 或一个 **per-index label** 来改 prompt，别用
  随机。

所以你的 `Date.now()`「破坏了 resume」，真相其实是反过来的：runtime 抛错正是为了*保护*
resume——脚本必须确定，最长未变前缀的 cache 才成立。

## 5. Resume =「最长未变前缀」

契约的原话：

> 「`agent()` 调用的**最长未变前缀**立刻返回 cache 的结果；第一个被编辑/新增的调用以及
> 它之后的一切都 live 跑。同一脚本 + 同一 args → 100% cache 命中。」

心智模型：resume 顺着 `agent()` 调用的**序列**逐个往下走，按内容（`prompt` + 影响 cache
的 opts）逐项比对。某个调用没变就命中 cache；走到**第一个**变了的调用，它切到 live，此后
的一切也跟着 live 跑。所以它是*前缀有序 + 按内容比对*——既不是纯按位置，也不是乱序的
content-hash。

- 改 `schema` / `model` / `isolation` / `agentType` 会**让 cache 失效**（逼那个调用重跑）。
- `label` / `phase` 是纯装饰，**绝不**让 cache 失效。

这正是「edit-and-resume」的工作流：跑一次 → Write/Edit 那个 saved 脚本 → 用
`{scriptPath, resumeFromRunId}` 重新调用；未变前缀立刻重放，于是你只为改动的部分、以及
它之后的部分付 live 成本。

## 6. 硬 caps（资源边界）

| Cap | 值 |
|---|---|
| 每个 workflow 的并发 agent | **`min(16, cpu cores − 2)`**——超出的排队，slot 空出来就跑 |
| 每次 run 的 agent 总量 | **1,000**（runaway-loop 兜底，远高于真实需要） |
| 单次 `parallel()`/`pipeline()` 调用的 item 数 | **4,096**（超出显式报错——不是静默截断） |
| 脚本大小 | **512 KB**（`script` 参数上的 `maxLength: 524288`） |

**工程后果：** 你可以给 `parallel`/`pipeline` 喂多达 4,096 个 item，它们最终都会跑完，但
任一瞬间只有约 `min(16, cores−2)` 个在跑——其余排队。这就是为什么 fan out 100 个 agent
**并不**等于 100× 加速：一个固定的并发窗口卡住了吞吐（Amdahl / Gustafson + 一道固定窗口）。
按你实际拥有的窗口来规划并行度，别按 item 数。

## 7. 后台执行（让主线空出来的那个契约）

一次 `Workflow` 工具调用**立刻带一个 task ID 返回**；workflow 在后台跑，完成时往对话里
注入一个 `<task-notification>`。所以主线不被阻塞——它立刻拿回控制权，能在 workflow 跑的
同时做下一件事。（主动短间隔轮询是浪费——harness 会在完成时重新唤醒你。）但有一条限制要
记牢：workflow 一旦启动，它的脚本结构就定死了——**没有 mid-run 输入**。workflow 内部的
「持续推进」，是你写流式 `pipeline()` 时就做下的 compile-time 决策，而不是 runtime 现场的
临场调整。
