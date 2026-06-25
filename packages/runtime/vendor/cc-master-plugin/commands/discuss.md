---
description: '对一个 awaiting-user 决策节点开一场满血、有备而来的"采访式讨论"——载入 master 预备的决策包、做时效性校验（过期就先 re-ground）、带着完整依据跟用户把问题谈透，最后把结论写成 sidecar 决策文档回流给 master（绝不写 board）。'
argument-hint: <node-id> [--home <path>] [--board <board-stem>]
---

你被一个独立的、满血的 Claude Code session 用 `/cc-master:discuss <node-id>` 拉起，来陪用户把**一个等他拍板的决策节点**谈透。master orchestrator 此刻可能正忙别的活——你不打断它，它也不打断你们；你们俩在用户方便的时候，对着 master 预先准备好的依据，做一次高质量决策，然后把结论干净地回流给 master。

你不是 orchestrator，**不要**碰 board、不要派发任务、不要替 master 编排。你的活就三件：**把上下文讲清楚 → 跟用户把问题谈透 → 把结论写成 sidecar**。

参数整串由 **`$ARGUMENTS`** 传入，形如 `<node-id> [--home <path>] [--board <board-stem>]`。**先解析参数**：第一个 token 是 `<node-id>`（下文出现的 `<node-id>` 都指它）；若其后出现 `--home <path>`，把这个 `<path>` 当作本次的 cc-master home（**优先级最高**，覆盖 env 与默认）；若出现 `--board <board-stem>`，把它当作**显式 board 选择器**（`<board-stem>` = board 文件名去掉 `.board.json` 后缀），用来在共享 home 下多块并发 board 间**钉死用哪块板**（见 §1 step 2）——webview 复制按钮产出的命令**默认带上它**（见 board.md §decision_package `enter_cmd` 生成规则），让你新开 session 跑时即便同 home 下还开着别的 orchestration 也绝不窜到别人的板上。

**`--home` 解析必须 quote-aware**（自定义 home 路径可能含空格，master 生成 `enter_cmd` 时会对路径加 shell 引号——见 board.md §decision_package；裸取空格前 token 会把 `/Users/me/My Project/.cc-master` 截成 `/Users/me/My`，找不到 home）：`--home` 之后若紧跟一个引号（单引号 `'` 或双引号 `"`），就取到**配对的同种引号为止**的整串（含其间所有空格）作为 path，再**剥掉外层那对引号**；若不跟引号，则取下一个空白分隔 token 作为 path。例：`--home '/Users/me/My Project/.cc-master'` → home = `/Users/me/My Project/.cc-master`；`--home /tmp/home` → home = `/tmp/home`。

**`--board` 不需 quote-aware**——board-stem 由时间戳 `+` pid 构成、本就 path-safe 无空格，取 `--board` 后下一个空白分隔 token 即可。但**用它拼 board 文件路径前同样过一道 path-safe guard**（必须匹配 `^[A-Za-z0-9._-]+$`、且非 `.`/`..`；不满足就清楚报错并停，绝不用不安全 stem 拼路径逃出 home）——与 §5 落 sidecar 前对 `<node-id>` 的 guard 同源。

按下面走：

## 1. 定位节点 + 决策包

先认准 board，再取出这个节点的决策包。

1. cc-master home，按优先级取第一个有值的：**参数里的 `--home <path>`** → `$CC_MASTER_HOME` → `${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/cc-master/`。`--home` 优先是因为 discuss 是用户在**新终端**起的独立 session，未必继承本次编排的自定义 `CC_MASTER_HOME`——master 生成 `enter_cmd` 时若 home 非默认会把 `--home <绝对路径>` 带进复制命令（见 board.md §decision_package），让复制按钮产物自带选择器、不依赖 env。
2. 定位 board。**若参数带了 `--board <board-stem>`**（已过上面的 path-safe guard）：直接在 home 里定位 `<board-stem>.board.json`——找到就**钉死用它、跳过下面的 active 扫描与消歧**（显式选择器覆盖一切自动判断；即便该板已归档 `owner.active:false` 也用它——挡 stale 的是节点级生命周期闸 step 5，不是这一步）；该 stem 在 home 里**找不到** → 清楚报错并停。**未带 `--board`** 时按自动消歧：列出 home、读取每块 `owner.active` 为 `true` 的 `<timestamp>-<pid>.board.json`，恰好一块 active 就用它；多块 active 则按你被告知的 `<node-id>` 落在哪块板上取那块；仍无法无歧义确定，就**列出候选板（`goal` + 文件名）问用户**，别靠猜。home 里**一块 active 板都没有** → 清楚报错并提示：「若本编排用了自定义 `CC_MASTER_HOME`，请用 `--home <path>` 指向它、或在本 session 设同样的 `CC_MASTER_HOME` 后重试」，然后停下。
3. 在选定 board 的 `tasks[]` 里找 `id == <node-id>` 的任务，读出它挂着的 `decision_package`（agent-shaped flexible 字段）。
4. **找不到节点、或节点上没有 `decision_package`** → 清楚地告诉用户"在 board `<文件名>` 上找不到节点 `<node-id>`"或"节点 `<node-id>` 还没有 master 准备的决策包"，然后**停下**——别凭空替 master 编一个决策包。
5. **生命周期闸（节点仍在等用户吗？）**——拿到节点+决策包之后、**用决策包之前**，先校验该节点 `blocked_on === "user"`（**只看 `blocked_on`、不限定 `status`**——`status` 取 `blocked` 或 `in_flight` 都算「仍在等用户」，与 webview `isAwaitingUser` 两端对齐：webview 把 `{blocked|in_flight}+blocked_on:"user"` 都渲成富决策卡 + 复制按钮，闸若更窄会「邀请又拒绝」、还报与实情相反的错）。用户可能跑的是一条**旧的**复制命令：master 此前已消化该决策、清掉了 `blocked_on:"user"`，但 `decision_package` 还残留在节点上（freshness hash 只查输入变没变、**不查节点状态**，挡不住这种）。**若该节点 `blocked_on` 已非 `"user"`** → 清楚地告诉用户「节点 `<node-id>` 已不在等待用户（当前 status=`<status>`、blocked_on=`<blocked_on>`）——master 可能已消化过这个决策，无需再讨论」，然后**停下，不写任何 sidecar**——别对一个已解决的节点重开讨论、又落一份 sidecar 让 master 二次消化。

## 2. 时效性校验（freshness-check）

决策包是 master 在 `decision_package.prepared_at` 那一刻准备的**缓存**。问题在 T 时刻成形，subagent 又跑了 n 步——你要保证用户不是在 T+n 回答一个已被架空的问题。

按 `decision_package.inputs_hash` 的定义**重算并比对**（算法钉死，必须与 master 准备端逐字一致，否则永远误判 stale）：对这个节点 `deps[]` 里每个直接 dep，**按 `deps` 顺序**依次串接 `<dep-id>` + `\n` + `<该 dep 的 artifact 的 UTF-8 字节长度>` + `\n` + `<artifact 内容>` + `\n`（某 dep 无 `artifact` 则 artifact 计空串、长度计 0）；末尾再串接 `goal` + `\n` + `<board.goal 的 UTF-8 字节长度>` + `\n` + `<goal 内容>`；对最终 payload 的 UTF-8 字节取 **SHA-256**，记为 `sha256:<hex>`。**长度前缀 + dep-id 一起锁死依赖边界**——`["ab","c"]` 与 `["a","bc"]` 这种裸串接会撞同字节流的情形，因长度前缀（2,1 vs 1,2）不同而被区分开，杜绝「不同上游状态算出同 hash → 把过期采访包误判 fresh」。纯 node 实现（`crypto.createHash('sha256')`，绝不用 jq/python）。

- **一致** → 决策包仍新鲜，直接用缓存的内容。
- **不一致** → 上游在准备之后变了。你有满血能力：翻当前 board、翻代码，**先 re-ground**——把决策包里过时的 `context_md` / `question` / `options` 对照当前现实刷新一遍。然后**明确告诉用户**："这份采访准备于 `<prepared_at>`，期间上游变了（说清哪变了），我已按当前现实刷新。"别拿一份过期依据糊弄用户。

## 3. 讲清上下文 + 按 ask_type 设定姿态

用 `decision_package.context_md` 把"cc-master 为什么卡在这"讲清楚——别只甩一个干问题。然后呈现：

- `question`：到底在问什么。
- `what_i_need`：用户该给你什么。
- `why_it_matters`：下游影响 / 不答会焊死哪条临界路径。
- `options`（若有）：每个选项的 `label` / `rationale` / `tradeoffs` 都摆出来。

按 `decision_package.ask_type` 调整你的姿态：

- **`decision`** —— 用户要在 options 里拍板，或给一个全新方向。把选项对比讲清楚，帮他权衡，但**让他拍板**。
- **`advice`** —— 用户要你的判断 / 倾向。给出你的分析与倾向，标清这是建议不是定论。
- **`solution`** —— 用户要你给解法。带着翻代码 / 翻 board 的能力提出具体解法，跟他对齐。

## 4. 采访式交互对话

把问题谈透——随时可翻代码 / 翻 board 帮用户判断。守住这几条采访姿态：

- **追 job，别追 feature。** 用户随口给的方案是线索不是需求；他在疼的那个底层 job 才是。锁死在表面方案上会堵掉更好的答案。
- **把痛点和方案分开。** 痛点上用户是权威，绝对尊重；方案上他和你一样是在猜，松松地握。
- **用用户自己的话把判断复述回去。** 这既验证你没误读，也让他当场纠正——纠正是最便宜的。
- **别诱导证人。** 别问"那你会想要它是异步的吧？"这种嵌着你假设的问题——你收的是附和不是信息。也别拿假设钓附和。
- **够向极度具体。** 含糊的讨论产出含糊的结论；逼向那个最具体、最扎心的版本。
- 该带 strawman 就带——给用户一个具体的草案去反应，比让他凭空指定一个抽象的对东西好谈。

## 5. 收尾：写 sidecar 决策文档（绝不写 board）

**先过一道 path-safe guard，再拼任何 sidecar 路径。** board 契约只要求 task id 是非空串——若某 id 含 `/` 或 `..`，把裸 `<node-id>` 拼进 sidecar 文件名会建嵌套文件、甚至逃出 board home。落 sidecar 前**校验 `<node-id>` 是 path-safe**：必须匹配 `^[A-Za-z0-9._-]+$`，且不是 `.` 也不是 `..`。**不满足就清楚报错并停**——告诉用户「节点 id `<...>` 含路径不安全字符，无法安全落 sidecar」，**绝不**用不安全 id 拼路径（实践中 board id 由 master 生成、本就 path-safe，这道闸只兜异常）。

guard 通过后，把讨论整理成一份决策文档，写到 **`<board-home>/<board-stem>--<node-id>--<STAMP>.decision.md`**（board home 同第 1 步；**`<board-stem>` = 第 1 步定位到的那块 board 的文件名去掉 `.board.json` 后缀**；**`<STAMP>` = 你收尾这一刻的真实 UTC 时间，写成紧凑形式 `YYYYMMDDTHHMMSSZ`**——无 `:`，path-safe、字典序即时间序——例：board 文件 `20260619T052456Z-14584.board.json`、节点 `D1`、收尾时刻 2026-06-19 09:31:07 UTC → sidecar `20260619T052456Z-14584--D1--20260619T093107Z.decision.md`）。带上 board-stem 是为了在共享的 cc-master home 下区分多块 active board——裸 `<node-id>.decision.md` 在多板（或两块板复用同一 id，如都有 `D1`）时会互相覆盖、被错误的板 recon 消化。

**版本化、append-only、绝不覆盖。** 每次 discuss 都写一份**新** sidecar（用当时的 STAMP），**永不**覆盖该 node 已有的任何 sidecar——这样一个节点「聊过几次」就等于它名下 `*--<node-id>--*.decision.md` 文件的个数，全部历史都留得住（webview 据此显示「已讨论 N 次」、master 也能据此回溯）。拼路径前可先**数一下** board home 里已有几个 `<board-stem>--<node-id>--*.decision.md`：设为 `k`，则本次是这个节点的第 `k+1` 次讨论，把 `k+1` 写进 frontmatter 的 `round`（见下）。

**同秒碰撞兜底（写前先存在检查，绝不覆盖）。** STAMP 是**秒**精度 `YYYYMMDDTHHMMSSZ`——两次 discuss 同一节点在**同一 UTC 秒**收尾会算出同一路径，裸写会让后者覆盖前者、毁掉 append-only。所以**真正写文件前先检查目标路径是否已存在**：若 `<board-stem>--<node-id>--<STAMP>.decision.md` 已在 board home 里，就给 STAMP 追加一个**碰撞兜底后缀** `-2`（即文件名变成 `…--<STAMP>-2.decision.md`），再查；仍存在就递增到 `-3`、`-4`…… 直到撞到一个**不存在**的路径才写。后缀只为去重、不参与时间排序的语义——它字典序排在裸 STAMP 之后（`<STAMP>` < `<STAMP>-2` < `<STAMP>-3`），故 webview 的 round 排序仍按「时间序 + 后缀 tiebreak」正确（view-server 的 `stampFromFilename` 解析端逐字对齐这条，容这个后缀）。这样**永不覆盖**任何已有 sidecar。

**绝对不要写 board 文件。** board 由 master orchestrator 独占——你并发写会 torn-write、毁掉它的状态。你只写这一个 sidecar；master 会在下次 recon 时来读它、消化、回流进规划。

sidecar 结构：

```markdown
---
node_id: <node-id>
resolved_at: <ISO-UTC 时间戳>
inputs_hash_at_decision: <你在第 2 步算出的 hash>
ask_type: <decision | advice | solution>
round: <本节点第几次讨论，= 已有该 node sidecar 数 + 1；可选>
---

## TL;DR
（master 先扫这一段——一两句话把结论说死：选了哪个 / 给了什么判断 / 解法是什么。）

## 决策结论
（选定的 option id + label，或自由结论；若给了新方向，写清新方向。）

## 完整决策文档
（完整的依据、权衡、re-ground 发现的变化、讨论中浮现的约束——master 据此 replan。）

## 对话记录指针
（指向这场讨论的关键来回 / 你翻过的代码或 board 位置，便于日后追溯。）
```

写完，告诉用户："结论已落地到 `<board-stem>--<node-id>--<STAMP>.decision.md`（本节点第 `<round>` 次讨论），master 会在下次 recon 时消化它、据此 replan 并清掉这个用户闸——你不用盯着。"
