---
description: '把当前 cc-master orchestration 优雅交接给一个新 session——quiesce、drain 在飞任务并就地端点验收、写一份叙事层 handoff 文档、归档 board，让新 session 用 --resume 无摩擦接手。'
---

你要把**当前正在推进的这场 orchestration** 干净地交接给一个**新 session**——quiesce、把在飞任务排空验完、写一份叙事层 handoff 文档、归档 board，让新 session 用 `/cc-master:as-master-orchestrator --resume <选择器>` 无摩擦接手。这一步会**归档 board**（`owner.active:false`，破坏性但显式可逆——`tasks`/`log`/`goal`/`git` 全留，`--resume` 能复活它），所以**先认准对的那块 board 再动手**。

动手前先读 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/references/handoff.md`——交接文档该写什么 / 不该写什么（叙事层·无噪声纪律）、drain 与 straggler 兜底、6 段模板、归档为什么反而让 `--resume` 更顺，都在那里。

**认准你的 board**（同 `/stop` / `/status`）：列出 cc-master home（`$CC_MASTER_HOME`，否则 `<project>/.claude/cc-master/`），读取每块 `owner.active:true` 的 `<timestamp>-<pid>.board.json`；恰好一块 active 就用它，多块 active 则按 `goal` 匹配你一直在推进的目标，多块匹配 / 无一匹配 / 无法无歧义确定时**向用户询问该交接哪块 board**（列出候选及其 `goal` 与文件名），不要靠猜——交接错 board 会归档掉别人的 orchestration。

认准之后，按 6 步执行：

1. **Quiesce（停止派发新活）。** 立刻停止往 WIP 里放新任务——本回合起不再有新任务进 in_flight。已在飞的让它跑；只是不再开新的。
2. **Drain（让在飞任务在当前 session 跑完 + 就地端点验收）。** 让 `in_flight` 任务在**当前 session** 收敛，每个落地即就地做端点验收（亲跑闸 + 读 diff，见 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/references/resume-verify.md`）——当前 session 还握着 live handle，比甩给新 session 当孤儿盲验省得多。**straggler 兜底**：某个真长跑的在飞任务在合理收敛窗口内排不空 → 把**这一个**降级成「孤儿 + 重验指引」，surface 给用户（等它 vs 当孤儿交出去），别让收敛把「切 session」无限期焊死。drain 纪律 + straggler 判定见 handoff.md。
3. **Write（写叙事层 handoff 文档）。** 写到 `$HOME_DIR/<UTC-timestamp>-<pid>.handoff.md`（`$HOME_DIR` = 上面认准 board 的那个 cc-master home）。**纯叙事层**——指向 board，绝不复抄 DAG / task 列表 / status。6 段骨架与「叙事层 vs 复述 board 的噪声」判据见 handoff.md，照它写。
4. **Log（board.log 留指针 + bump heartbeat）。** 往 board 的柔性边 `log` 段追加一条指向 handoff 文档路径的指针条目 + 一行最终态（这是 narrow-waist 的柔性边，可安全追加，绝不动硬字段）；把 `owner.heartbeat` 更新为当前时间戳。
5. **Archive（归档 board）。** 把 `owner.active` 置 `false`（同 `/stop` 机制：此后全套 hook 对这块 board 休眠）。这让新 session 的 `--resume` 走「复活归档板」的无摩擦路径——归档板 `--resume` 无需 `--force-takeover`（ADR-009）。**这是显式可逆的归档**，不是删除：board 文件保留，`tasks`/`log`/`goal`/`git` 全留。
6. **告诉用户。** 给出两样确切的东西：① handoff 文档的完整路径；② 新 session 要跑的确切命令 `/cc-master:as-master-orchestrator --resume <选择器>`（选择器用刚归档那块 board 的文件名或一个能无歧义匹配它 `goal` 的串）。一句话交代当前态势（交到哪了、有无 straggler 孤儿）。
