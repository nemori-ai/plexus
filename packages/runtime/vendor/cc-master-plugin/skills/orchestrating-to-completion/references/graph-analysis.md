# 图分析 —— 用 board-graph CLI 机器算临界路径 / float / 并行度 / impact / rollup

> **服务愿景：C4**（分解 / 规划）**· C5**（资源预算内高效调度）。**何时读：** 想把 board 的临界路径 / float / 并行度 / impact / owner rollup 从「心算估计」升级到「机器算」时——CLI 每个 `--cmd` 算什么、怎么调、CPM 诚实性（mixed/unit 只报结构）、以及**何时机器算 vs 何时心算够用**的决策判据。

## 目录

- [1. 它是什么 + 落点 + 不是什么](#1-它是什么--落点--不是什么)
- [2. 怎么调（调用形态）](#2-怎么调调用形态)
- [3. CPM 诚实性 —— mixed/unit 只报结构](#3-cpm-诚实性--mixedunit-只报结构)
- [4. 与 D3 套娃 owner rollup 衔接](#4-与-d3-套娃-owner-rollup-衔接)
- [5. ★何时机器算 vs 何时心算够用（决策判据）](#5-何时机器算-vs-何时心算够用决策判据)
- [6. 诚实天花板 + 不是 gate](#6-诚实天花板--不是-gate)
- [与 decomposition.md 的边界](#与-decompositionmd-的边界)

---

## 1. 它是什么 + 落点 + 不是什么

`board-graph.js` 是一个**手动带外 CLI**（住在 `${CLAUDE_SKILL_DIR}/scripts/board-graph.js`）——agent 在决策点**显式跑**它，**不是 plugin 自动 hook**。故它无武装闸、无 hook 注入短语（与 `cc-usage.sh` / `codex-review.sh` / `board-lint.js` 同族：显式被调、非自动注入）。它就是 `/cc-master:status` 与 `decomposition.md` 里那句「要真算 float / 临界链请走带外脚本」中的**那个脚本**。

- **只读、永不回写 board**（红线 2）——临界路径 / float / 并行度 / rollup 都是 ephemeral 的 stdout / `--json` 输出，**绝不是 board 字段**。board 上没有机器算出来的 float；CLI 每次现算、不落盘。
- **零 npm dep、node-only**（红线 1 · ADR-006）——复用 `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/board-graph-core.js` 这一份图核心（它再 require board-lint-core 的 `buildGraph`），与 board-lint **同一份图**、口径字节对齐（ADR-012）。
- **不是什么**：
  - **不是 gate**——「图坏」（缺窄腰 / dep 悬挂 / 成环）它也 exit 0、只分析 + 报告；gate 是 `board-lint.js` / `verify-board.sh` 的事。
  - **不是可视化**——节点 + 边的图形 webview 是 `/cc-master:view`。
  - **不替代心算**——它是心算的**可选升级**（零 token、只读、秒级），不是必跑仪式（何时该升级见 §5）。

---

## 2. 怎么调（调用形态）

引用一律用 `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PLUGIN_ROOT}` 绝对引用——**裸相对路径禁止**（装机后相对用户 cwd 解析、找不到脚本·Finding #38/#39）。

- **人读摘要**（临界链 / ready / WIP / 并行度 / 最高 impact / owner rollup 一把抓）：

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/board-graph.js
  ```

  无参 → 取 home 下**唯一** active 板（多块 active 则报错、提示传显式路径——与 status / view 的「认板」纪律一致）。要点某块板就传它的绝对路径作末位参数。

- **结构化全量**（供编排程序化读：`nodes` / `topo` / `critical` / `longestPath` / `parallelism` / `readySet` / `wip` / `rollup` / `nesting`）：

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/board-graph.js --json [<board-path>]
  ```

  人读摘要够用就别上 `--json`；要程序化消费字段时再上（schema 以脚本注释为准、不在此复抄以免 stale）。

- **单项 `--cmd <name>`**（逐 cmd 算什么）：

  | `--cmd` | 算什么 |
  |---|---|
  | `critical` | CPM 临界链 + `weight_source` 诚实标注（measured 态给小时级 makespan；mixed/unit 只报结构·见 §3）。 |
  | `ready` | deps 全 `done` ∧ `status=ready` 的可派发集（严格语义——与决策程序 q_ready 同口径）。 |
  | `wip` | `in_flight` / `blocked` / 等用户（userGates）计数。 |
  | `impact <id>` | 该节点的传递闭包：它 gating 多少下游（bottleneck 定位）。 |
  | `parallelism` | T₁（总节点）/ T∞（临界链长）/ 加速比 / Brent 上界。 |
  | `rollup <owner>` | 某 owner 的子 done 占比（advisory、不 gate · D3 套娃）。 |

  调用形态：`node ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/board-graph.js --cmd impact <id> [<board-path>]`（`impact` / `rollup` 后跟 id，board 路径可选、缺则走 home 唯一 active 板）。

---

## 3. CPM 诚实性 —— mixed/unit 只报结构（最重要的一节）

CPM 要节点时长；board 三个时间锚（`created_at` / `started_at` / `finished_at`）是**柔性可缺**的（agent-shaped、非 waist）。缺时长时降级：`measured`（`finished − started` 或 `now − started`）→ `unit`（dur=1）。

每个 CPM 结果带一个 `weight_source ∈ measured | mixed | unit | cycle`：

- **`measured`**（全节点有 measured 时长）→ 报临界链 **+ 小时级 makespan / float**。这是机器算真比心算强的态：给得出心算给不出的小时数。
- **`mixed` / `unit`**（部分 / 全部节点缺时长）→ **只报临界链结构 + 节点数，不报小时级 float / makespan**。补全时间锚后才升级到 measured。
- **`cycle`**（deps 有环）→ CPM 在环上未定义，提示先 `board-lint` 解环。

**这条诚实纪律的意义**：机器算 **≠ 一定更精确**。缺时间锚时机器只多给你「拓扑结构是真的」，小时数仍是假的——`weight_source` 让你知道机器算**什么时候真比心算强**（measured 态、有小时数）、什么时候只是**结构辅助**（mixed/unit 态、只有链与节点数）。别把 unit/mixed 态机器吐出的节点数当小时级 makespan 汇报——那比心算更误导（伪精确）。

---

## 4. 与 D3 套娃 owner rollup 衔接

`--cmd rollup <owner>`（与人读摘要的 owner rollup 段）读 `done_children / total_children`，给一个 **advisory** 进度（status agent 渲染进度条用）。

- **gate 语义不在这**——「父 done = 全子 done ∧ 父端点验收过」的 **gate** 由 hook（`verify-board` rollup gate + `board-lint` R7d）机器强制，归 `board.md` D3 小节 / ADR-012。CLI 只读**进度 advisory**，不驱动任何 gate。
- 摘要还会报 **rollup 不一致**（owner 标 `done` 却有非 done 子）——这与 board-lint R7d 是同一份实现（`rollupConsistency()`、字节对齐），CLI 帮你**提前看见**lint 会拦的东西。
- 一句话边界：**rollup 的 gate 在 hook、advisory 读在 CLI、概念在 `board.md` D3 小节**。

---

## 5. ★何时机器算 vs 何时心算够用（决策判据）

判据锚在**拓扑复杂度**，不是「累不累 / 窗口剩多少」——同一块板，复杂度决定心算靠不靠得住。两侧都要守：

**该机器算（升级触发）——拓扑非平凡、心算开始出错时**：

- 图有**非平凡的交错 fork/join**（钻石依赖、多源多汇、入度/出度 >1 的 join/fork 叠在一起）——这种图心算临界链开始估错（人脑追不准多条交错路径哪条最长）。
- 要定位 **bottleneck**——「哪个节点 gating 最多下游」用 `--cmd impact`：传递闭包人脑算不准，机器一遍扫准。
- 节点带 measured 时间锚——`--cmd critical` 给真 makespan / float（心算给不出小时数）。
- resume 接手一块**陌生的复杂板** / compaction 后重认领——机器一把扫出临界链 + ready + WIP + 最高 impact，比逐 task 心算重建快且不漏。

**心算够用（默认快路径）——拓扑平凡时**：

- 小图 / 单链 / 浅依赖（节点少、几乎无交错 join/fork）——临界链一眼可见，心算不易错。**在这种平凡图上仪式性跑一遍 CLI 是 busywork**（不解锁依赖、不降风险、不产 artifact、不验假设——过不了 fill-work 准入测试·违镜头 4），别为「显得严谨」而跑。
- 只需一眼粗判 fan-out 值不值（T₁/T∞ 明显 ≈1 或明显 ≫1）——结论已经显然，机器算只是给同一个显然结论盖章。

**判据本质**：CLI 是心算的**廉价升级**，触发条件是**拓扑复杂度**——图复杂到心算临界链/impact 会估错时升级机器算；图平凡到一眼看穿时心算够用、跑 CLI 反成 busywork。两侧都是错：大钻石图硬心算会估错临界链；平凡单链仪式性跑 CLI 是镀金。

---

## 6. 诚实天花板 + 不是 gate

- CLI **不 gate、不回写、「图坏」exit 0**——它是**分析镜**不是闸；闸归 `board-lint.js` / `verify-board.sh`。
- measured 依赖时间锚质量——锚缺则降级到结构 / 节点数（§3），**别把 unit 态的节点数当小时数**。
- 与 `/cc-master:view`（可视化）、`board-lint.js`（合法性闸）、`cc-usage.sh`（pacing 信号）各司其职——graph-analysis = **结构分析**那一格。

---

## 与 decomposition.md 的边界

`decomposition.md` 是**概念 SSOT**，本文是**工具 SSOT**——严格单向引用、绝不双向复述（红线 3 同精神 / Finding #7 反模式）：

| | `decomposition.md` | `graph-analysis.md`（本文） |
|---|---|---|
| **管什么** | CPM / float / T₁T∞ / Brent 的**概念与方法论**（前向后向遍历是什么、float 怎么定义、为什么压临界链） | **工具 how-to**（CLI 怎么调、`weight_source` 诚实性、何时机器算 vs 心算） |
| **引用方向** | 末尾**单向**指向本文（「要机器算这些见 graph-analysis.md」） | 本文**单向**指向它（「为什么要算临界路径、float 概念见 `decomposition.md` §2/§3」） |
| **绝不** | 不写 CLI 用法 / `--cmd` 表 / `weight_source` | 不复述 CPM 前向后向遍历的数学 / float 定义 |

一句话边界：`decomposition.md` 回答「临界路径是什么、为什么重要」（概念见其 §2/§3）；本文回答「在这块真实 board 上怎么把它机器算出来、什么时候值得算」。
