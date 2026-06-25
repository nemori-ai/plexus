---
description: '归档 cc-master board 并停用 orchestrator（不删除 board）。'
---

干净地收尾 cc-master 编排。停用一块 board 是**破坏性的**（它会归档这次 orchestration），所以要先认准对的那块 board，并在写入前确认。

1. **认准 board。** Board 住在 cc-master home（`$CC_MASTER_HOME`，否则 `<project>/.claude/cc-master/`），以 `<timestamp>-<pid>.board.json` 命名。列出 home，读取每一块 `owner.active` 为 `true` 的 board。
   - 若恰好只有一块 active，它就是候选。
   - 若有多块 active，把每块 board 的 `goal` 字段与你一直在推进的目标做匹配，取匹配上的那块。
   - 若多块匹配、无一匹配、或你无法无歧义地确定 board，**向用户询问该停哪块 board**（列出候选及其 `goal` 与文件名），不要靠猜——停错 board 会归档掉别人的 orchestration。
2. **停用前先确认。** 说明你将要停的是哪块 board（它的 `goal` 与文件名），并请用户确认。把 `owner.active` 置为 `false` 即让全套 hook 对这块 board 休眠（停用即休眠）——这是一次**显式可逆的归档**而非永久终态：board 文件保留，日后想续跑可经 `/cc-master:as-master-orchestrator --resume <选择器>` 在新 session 里把它复活（`active:false → true` + 重盖 owner，`tasks`/`log`/`goal` 全留）。即便如此，停用仍是会改变状态的一步，没有用户确认，不要停用。
3. 确认后，把那个 board 文件里的 `owner.active` 置为 `false`（保留文件作为审计记录；不要删除它）。就这一处编辑即完成停用：hooks 只把 `owner.active` 为 `true` 的 board 当作活的，所以没有另外的标记文件需要清除。
4. 给用户一段一段话的收尾说明：什么完成了（带 artifacts）、什么还在飞、什么仍阻塞在他们身上。
