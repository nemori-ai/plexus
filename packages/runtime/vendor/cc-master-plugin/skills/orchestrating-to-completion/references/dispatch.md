# 派发 —— 选机制 + 编排并行

> **服务愿景：C1**（异步并行 + 完整落地）**· C5**（在资源预算内高效调度）。**何时读：** 选后台机制并编排并行时——三机制（shell / sub-agent / workflow）、intra-vs-inter workflow、靠 escalation 重新定位（re-altitude）、admission control、**派发卫生 + watchdog/liveness 安全网（含 watchdog 工具降级链）**。

主线编排的核心：选每个节点*在哪*跑、再把这些道编排起来。来源：research report 3（LLM-Compiler TFU dataflow）+ codex 二审。

## 目录

- [分形的三个高度](#分形的三个高度)
- [两个尺度上的 dataflow](#两个尺度上的-dataflow--为何这些高度是自相似的)
- [后台执行机制 —— 恰好三种](#后台执行机制--恰好三种)
- [选择标准 —— 控制 / 综合 / context](#选择标准--控制--综合--context不是数量)
- [Intra vs inter workflow](#intra-vs-inter-workflow--轴--生命周期耦合)
- [靠 escalation 重新定位](#靠-escalation-重新定位core--绝不盲杀)
- [Hybrid + admission control](#hybrid--admission-control)
- [派发卫生](#派发卫生--一跑真并行就咬人的机械细节)
- [watchdog / liveness](#watchdog--liveness--给静默失败盲区配一张安全网)

---

## 分形的三个高度

派发在三个高度上是分形的——选一个机制，就等于选一个节点在哪个高度执行：

- **顶层（主线）** = 一个 **dataflow 调度器**：把后台机制派到 DAG 节点上、并穿插 HITL，受 WIP + 一份共享预算约束，一切都记在 board 上。
- **中层** = workflow *内部*的 fan-out。
- **叶子** = 一个 sub-agent / shell。

---

## 两个尺度上的 dataflow —— 为何这些高度是自相似的

这三个高度不是三个想法——它们是**同一个 dataflow 想法（就绪即派、绝不在 barrier 处阻塞）在两个尺度上的两次现身**。把这点内化，你才能把同一个本能带进一个陌生情境，而不是去对照一张规则清单。

学术根源是 LLM-Compiler 的 **Task Fetching Unit**（report 3）：一条依赖在它的输入就绪那一刻就被派出去；已经能跑的东西绝不等一个还没就绪的；而且 planner 流式地吐图，让 plan 和 execute overlap。cc-master 在两个尺度上跑的是同一套算法：

- **宏观（主线）—— dataflow 作为一种内化的*心态*。** 决策程序*本身*就是一个手跑的 TFU：对账 board（observation 黑板）→ 派发就绪任务（fetch-when-ready）→ 在空隙里塞 fill-work（planner/executor overlap）→ 在端点验收（Joiner 闸）→ 唯有就绪集为空才等。这里**没有 `pipeline()` 原语**——主线 DAG 是动态的、异构的、里头还有个人，没有任何 compile-time 脚本能表达它。Dataflow 在这里以纪律存在（镜头 3 & 4），不是代码。
- **微观（workflow 内部）—— dataflow 作为一个显式*原语*。** 这里 `pipeline()` 是真代码：确定性、有日志、可续。但它僵硬——workflow 一经启动结构就固定，没有运行中途的输入（`${CLAUDE_PLUGIN_ROOT}/skills/authoring-workflows/references/mechanism.md` §7）。微观尺度选 `parallel()`（barrier）还是 `pipeline()`（streaming）的判据，见 `${CLAUDE_PLUGIN_ROOT}/skills/authoring-workflows/references/mechanism.md` §3 的 parallel-vs-pipeline smell-test（默认 pipeline，只有下游真要整批集合才上 barrier）——此处不复述。

**两个尺度之间的切线，就是按动态性切的。** 必须运行中途随机应变的工作——对一个外部完成做出反应、把一个 escalation 重新定位、吸收一个 HITL 回答——归宏观尺度（board + 决策程序，LLM 在 loop 里）。能在 compile time 就固定下来的工作——一批同构项目流过固定 stage——归一个 `pipeline()`。这正是把 LLM-Compiler 那条切线 *"LLM 吐图、代码调度它"* 从单个 agent 任务放大到整场 long-horizon 编排：主线 LLM 做动态规划（吐图 + replan），workflow 脚本做确定性调度。自相似——一个尺度嵌在另一个里。

**防你过度套用的告诫。** `pipeline()` 优化的是*吞吐量*（许多同类项目穿过固定 stage）；而一个单一的 long-horizon 目标是一张*异构 DAG*，治理它的工具是**临界路径**（CPM / work-span），不是 pipeline 吞吐量。所以 pipeline 并行只是 cc-master 的一个**构件（constituent）**，不是它的顶层骨架：

- **临界链**定 makespan——pipelining 救不了一条串行依赖；
- 只有**非临界 float** 才是 pipeline / fan-out 能填的免费并行预算；
- **一批同类子任务**（迁移 N 个文件、review N 条 finding）才是它的主场。

顶层骨架是 dataflow DAG *调度*；`pipeline()` 只是项目恰好同构时它退化成的特例。在一条串行临界链上硬抓 fan-out 是经典的误套——T₁/T∞ ≈ 1 时，根本别 fan out。拓扑复杂、拿不准这条链到底是不是 T₁/T∞ ≈ 1（心算易错估）时，可 `board-graph.js --cmd parallelism` 机器读 `parallelism` 值佐证（见 `graph-analysis.md`）；平凡图一眼看穿就别跑。

---

## 后台执行机制 —— 恰好三种

只教 agent 这三种。（就本插件的用途而言，没有别的后台机制。）

- **shell** —— 可机械检查的执行（build / test / 拉数据 / 监听 / poll CI）。零 token 成本。必须配齐 **timeout + success predicate + log 捕获**，且失败必须能路由到一个下游推理节点（否则就拆成"一个 shell 执行节点 + 一个 sub-agent 诊断节点"）。
- **sub-agent**（`run_in_background`）—— 一个**终端（terminal）**推理单元：单一证据面 + 单一推理链 + 单一交付物 + 无需 fan out + 无需统一 schema + context-safe + 携带一条显式 escalation 路径。
- **workflow** —— 当你需要**对多个叶子的确定性控制**时（fan-out / fan-in · 统一叶子 schema · 对抗式验证 / retry / loop · 联合综合 · context-flood 风险 · journal-resume）——**哪怕叶子数很少也选它**。

> **反过度工程的对称护栏**：workflow 背着一整套机器开销——只有一条推理链 / 一份交付物 / 没有 fan-out 时，单个 sub-agent 就够了，起 workflow 是过度工程（对称于上面「哪怕叶子数很少也选它」，两侧都要守）。论证 SSOT 在 `${CLAUDE_PLUGIN_ROOT}/skills/authoring-workflows/SKILL.md` §1「workflow 是有开销的」，此处不复述。

### 等待外部状态 —— 用一个后台 shell

cc-master 是事件驱动的：一个后台 job 完成时，harness 会唤醒主线并重新进入——所以它从不需要一个定时器去轮询。至于 harness *无法*替你追踪的状态（CI 状态、一个远程队列、一个审批超时），用一个后台 shell 去等它——这个 shell 轮询它自己的 predicate，再骑着完成通知回来：

```bash
until <external state ready>; do sleep 60; done   # run_in_background → harness notifies on exit, re-enters
```

这既事件驱动又 ship-anywhere——它复用的是一个现成积木（一个后台 shell + 完成通知），而不是另引入一套定时器机制。

> **澄清（与 `async-hitl.md` 的「禁 busy-poll」并不矛盾）：** 那里禁的是**主线前台 busy-poll**——指挥在前台空转忙等。这里的后台 shell 轮询正交：轮询关进一个零 token 后台 shell、骑完成通知重入，主线腾出来去填等待窗口。后台等外部状态（荐）≠ 前台空等单个 agent（禁）。

---

## 选择标准 —— 控制 / 综合 / context，不是数量

别按有多少东西来选，按控制 / 综合 / context 来选：

- 它需要推理吗？**否 → shell。**
- 需要推理、且**终端 → sub-agent。**
- 需要**对多个叶子的确定性控制 → workflow。**

---

## Intra vs inter workflow —— 轴 = 生命周期耦合

首要的轴是**生命周期耦合（lifecycle coupling）**，不是数量。

- **一个 workflow** —— 叶子共享同一条生命周期：同一个 goal / schema / 质量闸 / budget envelope / 综合点 / 可接受失败策略，且运行中途没有 HITL 需求。
- **多个 workflow** —— 这些流在优先级 / 失败模式 / 重启成本 / budget 上限 / escalation / 整合时机上各不相同，或者每个都需要独立的闸讨论。

HITL 只是诸多轴之一；失败隔离、优先级、整合时机同样重要。**中层**：一个带多 phase 的单 workflow；一层 `workflow()` 嵌套。

---

## 靠 escalation 重新定位（core）—— 绝不盲杀

一个发现自己其实是一张 **sub-DAG** 的 sub-agent：

- **绝不能自我提拔、也不能自行 fan out**（workflow 叶子同样不能 spawn）；
- 它 **STOP 并返回一个 escalation 结果**（一张 scope map + 提议的叶子 + deps + 部分证据 + 原因）；
- 编排者 **supersede** 旧节点，并用那张 map 去 seed 一个 workflow。

你**靠 checkpoint 重新定位，不靠盲杀。** 推论：一个 workflow 叶子的 prompt 必须足够小、且终端；拿不准时，先跑一个 scoping sub-agent / workflow。

对应的节点状态路由：`uncertain → 验证节点`；`stale → 上游变了，重跑`；`escalated → supersede → workflow`。

---

## Hybrid + admission control

顶层可以同时有一个 shell + N 个 sub-agent + 一个 workflow 在飞。用 admission control 来治理它：

- **启动前先预留** —— 启动那一刻就预留 WIP + token budget（reserve-on-launch，不是 spend-then-report）。
- **WIP cap 把整合负担也算进去** —— 避免 N 个 workflow 一齐返回时的同步悬崖（synchronization cliff）。
- **并发上限 = 取 min**：CPU/IO、模型 budget、rate limit、context-return budget、综合负载，几者中的最小值。

---

## 派发卫生 —— 一跑真并行就咬人的机械细节

- **派发先于 board 标注，handle 是 `in_flight` 的唯一入场券。** board 标注与真实派发是**两个独立动作**：`Write` board 把一个 task 标 `in_flight` 只是改了**模型**，真正派出 worker 的是那次 `Agent` / `Bash` 工具调用。两者一旦顺序颠倒（先标板、再去发调用），就极易在多线程编排里漏掉那次调用——尤其当一个 sibling 的完成通知插进本拍、把你引去验收它时，那次未发的 dispatch 就这样蒸发了（[[Finding #17]] 的精确复发路径）。**纪律**：先调工具拿 handle（agentId / shell handle）、再 `Write` board 标 `in_flight`；handle 写进该 task 当 worker 实证。没有 handle 的 `in_flight` 是**幽灵任务（phantom）**——board 与自报都「显示在跑」、背后却没有活 worker，你在空等一个不存在的进程并据此**虚构进度**。**为什么软纪律不够**：[[Finding #46]] 里这条教训已被写进 board log，却在同一场编排的压力下**再次**复发——一次性 log 拦不住它，故它升进了魂的决策程序（dispatch / recon 节点）作常驻护栏。**地面真相验证法**（recon 时逐个对账每个 `in_flight`）：① 该 task 是否带一个真实 handle（agentId / shell handle）；② `git status` / 工具结果里是否有它的真实产物或 transcript；③ 三者皆空 = phantom，立即降级回 `ready` 重派——别信 board 的字面、别信自报，只信 git 与工具结果这层地面真相。
- **用绝对路径指向工作目标——绝不靠继承 cwd。** 编排者的 cwd 常常*不是*工作落地的那个 repo（你可能在从另一个 worktree 或一个父目录驱动）。每个被派发 agent 的 prompt 都必须给出指向目标的**绝对路径**、并告诉它别依赖继承来的 cwd——否则文件会落进错误的树。
- **单一提交者：叶子负责写 + 自测，编排者负责提交。** 各自 `git commit` 的并行 agent 会抢 git index。要求每个叶子**写它的文件、跑它的测试证明是绿的，但绝不 commit**；由编排者在端点验收、再按依赖序提交。（又是 end-to-end argument——commit 完整性归编排者端点，不归叶子。见 `resume-verify.md`。）
- **对同一个共享可变文件的写者，跨波串行化。** 若几个任务都追加到同一个文件（一个共享测试文件、一个 registry），*同一*波里的两个会互相覆盖。把这些写者拆进**不同的波**，使任一时刻至多一个去碰那文件——编排者吸收这份协调成本，好让叶子保持独立、互不相交。

---

## watchdog / liveness —— 给静默失败盲区配一张安全网

派发卫生堵的是「board 标了却没真派」（phantom，上面那条 #17/#46）；**watchdog 堵的是它的下游孪生**——一个真派出去的 `in_flight` 任务**事后 hang 死 / 静默死**，或那个 phantom 一直没被戳穿，而你又走到了 `wait` 边。harness 的自动重唤起是 **completion-triggered**：只在任务**触发完成事件**时把你带回来，对「永不触发完成事件」的失败（hang / 静默死 / phantom）结构性失明（完整论证 + 「N 小时成功日志不是反证」的幸存者偏差，见 `async-hitl.md` §等待前 arm watchdog）。

**何时 arm**：走 `wait` 边前，剩余 path 里有 blocked 在**可能静默失败的 `in_flight`** 上的（不只是 awaiting-user）→ arm 一个 watchdog 定时唤醒，间隔回来 recon 对地面真相。纯 awaiting-user 不 arm（按 mechanism 用、不按 ritual 用——触发条件与 board 双层记录见 `async-hitl.md`）。

**工具降级链（情境三件套 + universal floor，按优先级，缺则降级）**——ship-anywhere 诚实性：即便用户已开放 cron / ScheduleWakeup，不同宿主（Bedrock / Vertex / Foundry）可用性仍有别，故教法是降级链 + 显式可用性提示，background-shell 永为 floor，不假设新工具到处都在：

1. **CronCreate `recurring:false`（首选 / 通用 watchdog）** —— 本地 session 调度器，**只在 REPL idle 时 fire**（正好在你空转时叫回、不打断干活）。间隔 ≈ 最长 `in_flight` 任务的 p95 + 余量。cache 心智：<270s 保温 / ≥1200s 长等（贴 ScheduleWakeup 的 cache-warmth 心智；见 `cost-and-pacing.md`）。重唤起处置完后 **CronDelete** 清掉待发 job 免重复 fire。注意 `durable:false` 是**本地 session 内存调度**、不需 claude.ai OAuth，故 ship-anywhere OK——区别于云 routines / RemoteTrigger（破 ship-anywhere，不教）。
2. **ScheduleWakeup** —— 原生自定步长 + cache-warmth；已在 /loop dynamic 时用过。
3. **Monitor** —— 某后台任务有可观测 liveness 信号（log 文件 / 进程）时用：`tail -f | grep -E --line-buffered '<进度>|<失败签名>'`，事件驱动、精准。**"silence ≠ success"**：filter 必须覆盖**失败终态**，不能只 grep happy path——否则一个吐了错误就死的任务，你的 filter 等不到它的 happy 行、反而以为还在跑。
4. **background-shell `until <ready>; do sleep N; done` 丢进 `run_in_background`（universal ship-anywhere floor）** —— ADR-004 既有消解（见 §等待外部状态），**永远兜底**：上面三者在某宿主不可用时，这条恒可用（harness 完成重入）。ADR-011 在它之上**补充** timer primitives，不取代它。

被唤醒后 recon 用的就是上面派发卫生那套地面真相验证法（handle / `git status` / 工具结果），处置完静默失败的、该 re-arm 的 re-arm——细节在 `async-hitl.md` §等待前 arm watchdog。
