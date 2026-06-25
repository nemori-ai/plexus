---
description: '渲染一份 cc-master board 摘要——进度、阻塞、临界路径估计（agent 心算，非机器算的 CPM）、以及等待用户拍板的决策。'
---

读取你的编排 board，渲染一份**可一眼扫完、按状态分组**的 board 视图——精神上对标 Claude Code `/workflow` 那种分层、活的、glanceable 进度大纲，只不过映射到 cc-master 的 DAG。Board 住在 cc-master home（`$CC_MASTER_HOME`，否则 `<project>/.claude/cc-master/`），以 `<timestamp>-<pid>.board.json` 命名。

先确定要报告哪块 board：

1. 列出 home，读取其中每一块 `owner.active` 为 `true` 的 `<timestamp>-<pid>.board.json`。
2. 若恰好只有一块 active，就用它。
3. 若有多块 active，把每块 board 的 `goal` 字段与你当前正在推进的目标做匹配，用匹配上的那块。
4. 若多块匹配、无一匹配、或你无法无歧义地确定 board，**向用户询问该报告哪块 board**（列出候选 board 及其 `goal` 与文件名），不要靠猜。

然后渲染 board 视图。求**可扫性**：先一行 header，再按状态分组、每个任务一行紧凑摘要，最后是健康检查。别堆成段落散文。

**1) Header 行（一眼定位）**——一行给出：`goal`（截断到能扫的长度）· 进度 `done/total`（done 含 `verified`）· `git.branch` · 一条预算/pacing 备注（数字来自下面预算快照那次 `cc-usage.sh` 调用——保留它）。

**2) 按状态分组的任务区**——每组一个清楚的视觉小节标题，组内每个任务一行：`<id> · <title>` 加该状态相关的那一点细节。空组直接略过不渲染。建议分组与顺序（把最需要人看的放最上）：

- **⛔ Blocked-on-user（`status:"blocked"` 且 `blocked_on:"user"`）—— 置于最顶、醒目凸显。** 一个长跑的 orchestrator 绝不能默默卡在一个用户闸上；每行给出 `<id> · <title>`（即等用户拍板的那个决策）。**没有这类任务则整组省略**（别渲染一个空的「无」）。
- **▶ In flight（`in_flight`）**——每行：`<id> · <title>` + `mechanism`/`handle` + 自 `dispatched_at` 起的已耗时；对任何已超过其类别 p95 时长、可作 hedge 候选的任务，行尾打一个 hedge 旗标（如 `⚠ p95-超时·可 hedge`）。
- **⛔ Blocked-on-task（`status:"blocked"` 且 `blocked_on:"<taskid>"`）**——每行：`<id> · <title>` + `阻塞于 <taskid>`。
- **◷ Ready（`ready`）**——每行：`<id> · <title>`（依赖已满足、待派发）。
- **✓ Done（`done`，含 `verified`）**——每行：`<id> · <title>` + `artifact`。
- **⚠ 需注意（`stale` / `failed` / `escalated` / `uncertain`）**——把这几类非常态汇到一组、每行标出各自 status，凸显需要路由处置。

**3) 临界路径（Critical path，agent 心算估计）**：你**心算估计**的那条通往目标的最长依赖链（沿 `deps` 看哪条串行链最长）。注意这是估计而非机器算出的 CPM——board 上**没有**机器算出的 float 字段（CLI 是 ephemeral 算它、不回写 board）。把它如实呈现为估计，别当成精确的零 float 链。要真算 float / ES-EF-LS-LF / 临界链（拓扑复杂、心算易错时），跑 `node ${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/board-graph.js --cmd critical`（机器算的 CPM，带 `weight_source` 诚实标注；详见 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/references/graph-analysis.md`）——平凡小图心算够用、别仪式性跑它。

然后跑这些**只读的 program-state 健康检查**（全部从你已读取的 board 派生，外加一次可选的 `cc-usage.sh` 调用——不发明任何新状态，不写回任何东西）：

- **Narrow-waist 完整性**：校验 board 钉住的 waist——`schema`、`goal`、`owner`，以及每个任务都带 `id`/`status`/`deps`。报告任何违例。
- **Deps-graph 一致性**——扫描 `tasks[]` 的 DAG，查三类缺陷并按任务 `id` 逐一报告：
  - **悬空 deps（Dangling deps）**：任何指向 board 上并不存在的任务 `id` 的 `deps` 条目。
  - **环（Cycles）**：任何依赖环（一条绕回自身的 `deps` 链）——环永远无法推进。
  - **可解锁却仍锁着（Unlockable-but-locked）**：任何 `blocked` 任务，其 `blocked_on` 指向一个 `<taskid>` 而该任务已 `done`——上游已清，它却从未被释放到 `ready`。把这些列为"现在即可解锁"。
- **过度调度（Over-scheduling）**：统计 `in_flight` 任务数，与 `wip_limit` 比对（这是一条弹性边界——可能缺失；若缺失，明说并跳过比对，而非假定有上限）。报告 `in_flight N / wip_limit M`；当达到上限（无余量再派发）或超出（已越上限——下回合不应再加，考虑推迟高 float 的活）时标出。
- **未答的用户决策（Unanswered user decisions）**：列出每个**同时**满足 `status:"blocked"` **且** `blocked_on:"user"` 的任务的 `title`——这些是编排者正在等用户拍板的决策。两个字段缺一不可（即 verify-board.sh 强制的那条 `blocked(blocked_on:"user")` 契约）：一个已 `status:"done"`（或已以其他方式解决）却仍残留 `blocked_on:"user"` 元数据的任务，是一个**已答**决策——**不要**把它报成未答。把真正未答的那些醒目凸显出来（一个长跑的 orchestration 绝不能默默卡在一个未答的用户闸上）。
- **预算快照（Budget snapshot）**：注意主线可跑 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/cc-usage.sh`（带外，非 hook）取一个 5h/7d 的 usage 信号。先看 `source`：`account` = status-line 捕获的**账户权威** `used_percentage` + 从 `resets_at` 算的 `window_remaining_min`（5h/7d 都给 `used_percentage`）；`local-derived-approx` = sidecar 缺失时退回的本地 JSONL **反推**（给 `used_tokens` / `burn_rate_per_min` / `window_remaining_min`，标 approx——reset 倒计时可能严重失真）。在 pacing 决策前读出相对滚动配额窗口的状态；取到就把数字呈现出来，并标明是 account 权威还是 approx 反推。

想看可视化的 DAG 图（节点 + 边的 xyflow 本地 webview），跑 `/cc-master:view`。

不要修改 board；这是只读的。
