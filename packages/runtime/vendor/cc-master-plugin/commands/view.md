---
description: '在本地浏览器打开当前 active 编排 board 的 DAG 可视化（xyflow webview）——只读、每 2s 活轮询、零联网。'
---

启动一个本地 webview，把当前 active 编排 board 的任务 DAG 渲成 xyflow 图（节点 + 边）。这是**只读**的可视化工具——它**绝不写 board**，只起一个本地 http server 把 board 渲给浏览器看。

1. **认准要可视化的那块 board。** Board 住在 cc-master home（`$CC_MASTER_HOME`，否则 `<project>/.claude/cc-master/`），以 `<timestamp>-<pid>.board.json` 命名。列出 home，读取每一块 `owner.active` 为 `true` 的 board。
   - 若恰好只有一块 active，就用它。
   - 若有多块 active，把每块 board 的 `goal` 字段与你当前正在推进的目标做匹配，用匹配上的那块。
   - 若多块匹配、无一匹配、或你无法无歧义地确定 board，**向用户询问该可视化哪块 board**（列出候选及其 `goal` 与文件名），不要靠猜；若一块 active board 都没有，告诉用户先用 `/cc-master:as-master-orchestrator <目标>` 起一场 orchestration。
2. **以后台 shell 启动 view server**（`run_in_background`，让它跨回合一直活着）。把上一步认准的 board **绝对路径**塞进 `CC_MASTER_BOARD` 环境变量，跑：

   ```
   CC_MASTER_BOARD="<认准的 board 绝对路径>" node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrating-to-completion/scripts/view-server.js"
   ```

   **务必给 `CC_MASTER_BOARD` 的值套双引号**——board 绝对路径可能含空格（project 路径或 `$CC_MASTER_HOME` 带空格），不套引号会在空格处被 shell 拆词、传错路径而死。同理**务必用 `${CLAUDE_PLUGIN_ROOT}/...` 绝对引用**脚本路径——裸相对路径会相对用户 cwd 解析、装到用户机器后找不到脚本而死（Finding #38/#39 self-containment）。
3. **抓 URL 并交给用户。** server 启动后会往 stdout 打**恰好一行** `cc-master board view: http://127.0.0.1:<port>`（端口由 OS 分配、每次不定）。从后台 shell 的输出里抓出这行的 `http://127.0.0.1:<port>`，**把它呈现给用户**，让他在浏览器里打开。若等了一两秒这行还没出现，把后台 shell 的 stderr 报给用户（最常见是 `node` 不在 PATH、或 board 路径没塞对）。
4. **说明它怎么用、怎么停。** 告诉用户：这个 view **每 2s 活轮询** `/board.json`、board 一变浏览器自动更新（**不用手动刷新**），且是**只读**的——看，不改。要停掉它，**杀掉那个后台 shell**（或者它会随本 session 结束而自然退出）。
5. 重申：这是只读的可视化工具，**它从不写 board**。
