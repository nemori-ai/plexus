---
path: AGENTS.md
version: v1.0
last-edited: 2026-06-12
agent-edit-policy: |
  仓库根 AGENTS.md——agent / 贡献者进入 cc-master 的着陆页与导航地图。三类编辑分级：
  - 自主刷新（无需 PR 人审）：§12 目录/文件约定在子目录增减时刷新行级；§N 触发式深入阅读表新增行；§9 findings 台账新增条目的指针；frontmatter 的 last-edited / version 字段；命令或脚本落地后在对应表追加行。
  - 走 PR 人审：§3 六条红线的任意改动（红线 SSOT 在此，改动须人审）；章节重排 / 目录拓扑级变化；§2 不变式语义改动；§N 表的语义重排（不只新增）。
  - 禁止：把 SKILL.md 的运行时灵魂（七镜头 / 决策程序 / Rationalization Table 正文）塞回本文——那类内容已在 skills/orchestrating-to-completion/SKILL.md，是每次 compaction 由 SessionStart hook 重注的常驻手册；本文只给触发条件 → SSOT 的导航指针，不复述。复述即制造双 SSOT（Finding #7 已证重复是负担）。
content-summary: |
  cc-master 仓库根 AGENTS.md——agent 着陆即读的最小心智地图与渐进式披露导航表。承载：(1) 这个插件是什么 + 不是什么（多指针）；(2) 仓库形态 + 不变式速览；(3) 六条 non-negotiable 红线（每条一句话 + 链回 SSOT + grep/CI 硬卡点）——红线 SSOT 在此；(4) gstack × superpowers 路由（指针）；(5) 编排纪律（SKILL A 是灵魂，不复述，只导航）；(6) skill 创作/维护纪律（含 TDD-for-skills 指针 + YAML 引号反模式）；(7) codex 作为端点验收 reviewer；(8) eval 机制 Track A+B；(9) dogfood 循环 + findings 台账；(10) 测试纪律 + 验收门；(11) 分支/PR/commit 约定；(12) 目录与文件约定；(13) ADR 约定（指针）；(§N) 触发式深入阅读大表。直接进入 agent 上下文的是最小必需内容，深度信息（编排方法论 / workflow 写法 / eval / ADR 正文）通过"当你做 X 时去读 Y"按需引出，不预加载。
---

# cc-master

> 本文是 agent / 贡献者进入 `cc-master` 仓库的**第一站**——通读本文即获得做事所需的最小心智地图：这个插件是什么、目录长什么样、哪些红线不能碰、什么时候该读什么。
> §N "触发式深入阅读" 里的链接**不需要预加载**——只在命中对应触发条件时跳转。这是渐进式披露（progressive disclosure），不是 reading list。
> **运行时的灵魂在 [`skills/orchestrating-to-completion/SKILL.md`](skills/orchestrating-to-completion/SKILL.md)（SKILL A）——它是 `SessionStart` hook 每次 compaction 全文重注的常驻手册。本文绝不复述它的七镜头 / 红线 / 决策程序，只给定位与指针。**
> CLAUDE.md = `@AGENTS.md` 一行 include——Claude Code 与 codex 等读同一份真相源。

---

## 1. 这个插件是什么

`cc-master` 是一个 **ship-anywhere 的 Claude Code 插件**：把任意主会话 agent 变成一个 long-horizon **master orchestrator（总指挥）**。给它一个跨度 >24h 的目标，它把目标拆成依赖图、并行派发后台工作、在每个等待窗口里让主线**主动**推进，并且——最难的一环——在反复 context compaction 与跨 session 之间存活续跑而不忘记自己是谁、还剩什么。

它**不是**：agent framework / library，不是某个 LLM API 的包装，不依赖 agent-teams 或 scheduled routines（见 §3 红线 5）。它是 **commands + 3 skills + hooks + 一个 board 文件**的薄编排层。

**产品愿景 / 北极星（charter）**——cc-master **致力于让** agent 化身 master orchestrator 并具备六项能力：① 异步并行多线程推进、把目标完整落地；② 控制 token 消耗速度；③ 把握自主决策 vs 寻求人类接入的边界；④ 目标的分解 / 管理 / 更新 / 规划；⑤ 资源消耗速度合理前提下最大化实施效率的调度编排；⑥ 按复杂性 / 难度 / 时长选合适的模型。这是**方向目标（aspirational）而非「已全部兑现」**——哪些已落地、哪些 design-only 由 gap 审计度量。**完整六条 charter 的 SSOT 在 [`design_docs/spec.md` §1.0](design_docs/spec.md)**，本段只是摘要回指，不复述。

**深入指引**：
- 用户视角（怎么装、怎么用、三范式对比）→ [`README.md`](README.md)
- 编排方法论（魂）→ [`skills/orchestrating-to-completion/SKILL.md`](skills/orchestrating-to-completion/SKILL.md)
- workflow 脚本写法（机制）→ [`skills/authoring-workflows/SKILL.md`](skills/authoring-workflows/SKILL.md)
- 完整设计 spec → [`design_docs/spec.md`](design_docs/spec.md)

---

## 2. 仓库形态 + 关键不变式

```
cc-master/
├── AGENTS.md / CLAUDE.md     ← 你正在读 / CLAUDE.md = @AGENTS.md 一行 include
├── README.md / README_zh.md  ← 面向使用者的产品介绍（怎么装 / 怎么用）
├── CONTRIBUTING.md           ← dev loop + before-PR 两道门（红线 SSOT 已外链本文 §3）
├── CHANGELOG.md
├── .claude-plugin/           ← plugin.json 清单 + marketplace.json
├── commands/                 ← as-master-orchestrator / status / handoff-to-new-session / stop（一次性点火）
├── skills/                    ← **分发**给插件用户的 skill 源码（这三个随插件 ship）
│   ├── orchestrating-to-completion/  ← SKILL A：编排方法论（魂）+ references/ + scripts/（运行时带外脚本 cc-usage / codex-review / statusline-capture，随 skill 分发，prose 用 `${CLAUDE_SKILL_DIR}` 引用）
│   ├── authoring-workflows/          ← SKILL B：workflow 写法 + references/ + assets/examples/
│   └── account-management/           ← SKILL C：换号号池机制层（accounts.json registry + vault token 录入 / 选号 / 切号）+ references/ + scripts/
├── .claude/skills/            ← **项目自用** dev skill（造/评/治三件套 + requirement-elicitation 上游需求发现，**不分发**）
├── hooks/scripts/            ← 5 个 hook，全 board-derived「武装」后才醒（ADR-007）：bootstrap-board（ARM 动作）/ reinject / verify-board（goal-hook）/ posttool-batch（过调度软警告）·bash + usage-pacing.js（**账户权威 5h/7d `used_percentage` 双侧 pacing**：临界轻推减速 + 5h 欠用轻推加速、7d 当硬总闸·ADR-010；读 statusline-capture 落的 sidecar，缺则降级本地反推·Finding #37）·node·JS（红线1·ADR-006 已允许 node）
├── scripts/                  ← 带外 **dev-only** 脚本：eval-trigger / eval-benchmark / skill-lint（仅开发本仓用、repo 根调用，**不随 plugin 分发**；裸路径在此正确）。运行时带外脚本（cc-usage / codex-review / statusline-capture）已搬入 `skills/orchestrating-to-completion/scripts/`（随 skill 分发，见上）
├── adrs/                     ← 结构性决策快照（ADR-001..011 + AGENTS.md 规约）
├── tests/                    ← hook 测试（bash）；run-tests.sh 编排 hook + content contract
├── design_docs/             ← 设计文档 + eval/ + dogfood-findings.md（plans/ gitignored）
└── examples/                 ← 可跑样例（sample-orchestration：i18n 场景 walkthrough.md + smoke.sh 冒烟证明）
```

**关键不变式**（每条一句话 + SSOT；硬约束的完整体在 §3 红线）：

- **六条 design 红线**——hooks 只用 bash+node/JS（红线1，ADR-006）/ board narrow waist / 三 skill 不重叠 / 指挥不演奏 / ship-anywhere / 所有 hook 武装后才激活（dormant-until-armed，红线6，ADR-007）。SSOT 在本文 **§3**（每条带 grep/CI 卡点）。
- **临时计划 / 草稿放 `design_docs/plans/`**——已 gitignored，不进版本控制，与正式 `design_docs/` 严格分开。
- **运行时 board 不入版本控制**——`.claude/cc-master/`（或 `$CC_MASTER_HOME`）gitignored；每个 orchestration 一份 time-sortable 文件，并发不撞。

---

## 3. Non-negotiable 红线（SSOT 在此）

这六条是 **cc-master 内任何代码 / 文档变更都不能违反的硬约束**。**本节是这六条红线的单一真相源**（用户拍板）——每条只一句话 + 一个 PR/CI 可执行的 grep/CI 硬卡点；理由 / 决策心智 / 例外在指向的 SSOT 里，本文不复述。违反任一的 PR 会被打回。

1. **Hooks 只用 Claude Code 保证存在的 runtime：bash + node/JS（JS only）。** 不用 `jq` / `python` / 直接跑 TS（这些不随 Claude Code 保证存在）。Hook 跑在对 agent context 失明的 shell 里，但 **Claude Code 本身是 Node 应用——`node` 在任何能触发 hook 的环境天然在**，故 node/JS 不破 ship-anywhere（Bedrock/Vertex/Foundry 是模型后端，非 CLI 宿主）。需结构化 JSON 解析/计算（如从 JSONL 算 usage、deps 图校验）用 node，简单/高频 hook（如 per-tool PostToolUse）用 bash。
   → 决策快照：[`adrs/ADR-006-hooks-may-use-node-js.md`](adrs/ADR-006-hooks-may-use-node-js.md)（取代 [ADR-001](adrs/ADR-001-hooks-pure-bash.md)，纠正「no node」事实错、保留 ship-anywhere 精神）· 硬卡点：`grep -rnE '\bjq\b|\bpython3?\b|tsx|ts-node' hooks/scripts/` 须只命中注释（node/JS 现已允许）。

2. **保持 board 的 narrow waist 稳定。** Board 是单一真相源、也是 hook 唯一能读的状态；只有一小撮固定字段是 hook-dependent（`schema` / `goal` / `owner.session_id` / `git` / `tasks[{id,status,deps}]` + status enum），其余 agent-shaped。动 waist 必须同 PR 改全部 hook + 测试并在 PR 描述显式说明。
   → 决策快照：[`adrs/ADR-003-board-narrow-waist.md`](adrs/ADR-003-board-narrow-waist.md) · 协议 SSOT：[`skills/orchestrating-to-completion/references/board.md`](skills/orchestrating-to-completion/references/board.md) · 硬卡点：动 waist 的 PR 必带 `bash run-tests.sh` 全绿 + hook 测试同步更新。

3. **三个分发 skill 各自自洽、互不重叠。** SKILL A（`orchestrating-to-completion`）= 主线编排**决策**（含「逼顶该不该换号」的 pacing 决策）；SKILL B（`authoring-workflows`）= 脚本内写法；SKILL C（`account-management`）= 换号号池**机制层**（号池管理 / 选号 / 切号 / vault token 安全）。不让职责跨界、不在三者间复述同一份指导——换号的**决策**（何时换、谁拍板）归 A，换号的**机制**（怎么选号、怎么切、怎么管 vault）归 C，A 在 pacing 决策点单向引用 C 而不复述其机制。
   → 决策快照：[`adrs/ADR-005-two-skills-separation.md`](adrs/ADR-005-two-skills-separation.md)（两 skill 分离原则扩到三个，account-management 经 curating 闸纳入·不变其精神）· 硬卡点：跨界/复述在 PR review 拦——"orchestrator 做什么" 归 A，"workflow 脚本怎么写" 归 B，"号池怎么管 / 怎么选号切号 / token 怎么安全" 归 C。

4. **指挥永不演奏（the conductor never plays an instrument）。** Orchestrator 协调，不亲手做单元工作；任何把主线推向亲自实现 / 亲自 review 的改动都是反方向。
   → 纪律 SSOT（含唯一例外、Rationalization Table、Red Flags）：[`skills/orchestrating-to-completion/SKILL.md`](skills/orchestrating-to-completion/SKILL.md) §Red lines · 硬卡点：行为型红线，由 §8 Track B benchmark + 端点验收守护（非 grep 能拦）。

5. **保持 ship-anywhere。** 后台**派发**机制只有 background shell / sub-agent（`run_in_background`）/ workflow（不变）。**timer primitives 已部分解禁（ADR-011 收窄 ADR-002）**：`ScheduleWakeup` + **`CronCreate`（`durable:false` 本地 session 内存调度，不需 claude.ai OAuth）** **许可用于自我唤醒 / watchdog**（补静默失败盲区的安全网，层叠于 harness 自动重唤起之上）——但**只以降级链形态教**（CronCreate / ScheduleWakeup / Monitor 按情境降级，**background-shell `until` 轮询永为 universal floor**），不假设新工具到处都在。**仍排除/仍不教**：**agent-teams**（实验开关，不可靠）、**RemoteTrigger / claude.ai 云 `scheduled routines` / `/schedule`**（需 OAuth、Bedrock/Vertex/Foundry 上没有，破 ship-anywhere——注意与 CronCreate 本地内存调度区分）。别加在 Bedrock / Vertex / Foundry 上会断的依赖。
   → 决策快照：[`adrs/ADR-002-ship-anywhere-scope.md`](adrs/ADR-002-ship-anywhere-scope.md)（被 [`ADR-011`](adrs/ADR-011-self-wakeup-watchdog.md) 部分收窄）· 排除留痕：[`design_docs/spec.md` §12](design_docs/spec.md) · 硬卡点：带外脚本（codex / eval / cc-usage / statusline-capture）依赖 `uv` + Python 3.12 + `claude`/`codex` CLI 或 node——**绝不进 `hooks/`**（那会破 ship-anywhere）。落点二分：**运行时**带外脚本（终端用户会跑：cc-usage / codex-review / statusline-capture）进 `skills/<skill>/scripts/`（随 skill 分发，prose 用 `${CLAUDE_SKILL_DIR}`/`${CLAUDE_PLUGIN_ROOT}` 引用，**裸相对路径会在用户 cwd 下找不到**·Finding #37）；**dev-only** 脚本（eval / skill-lint）留顶层 `scripts/`（仅 repo 根调用，裸路径正确）。

6. **所有 hook 武装后才激活（dormant-until-armed）。** 每个 hook 在本 session 被 `as-master-orchestrator` 武装（board-derived：home 有 `*.board.json` 且 `owner.active:true` 且 `owner.session_id == 本次 hook stdin 的 session_id`；sid 空 → 降级匹配任一 active 板）之前完全休眠（空 stdout、RC 0、不 block）；`bootstrap-board.sh` 唯一豁免（它**是** ARM 动作本身）。**ARM 有 fresh / resume 两形态**：fresh（新建板并盖 `owner.session_id`）与 resume（`as-master-orchestrator --resume` 盖到选定旧板上、`owner.active` 置 true 含复活归档板、保留 `tasks`/`log`/`goal`，经 live 安全闸；ADR-009）——红线实质不变（仍是「bootstrap 是唯一豁免的 ARM 动作」）。
   → 决策快照：[`adrs/ADR-007-hook-arming-gate.md`](adrs/ADR-007-hook-arming-gate.md)（board-derived armed-gate）· 协议 SSOT：本文 §12 hook 武装纪律 · 硬卡点：`grep -rL 'board_matches\|isArmed' hooks/scripts/*.sh hooks/scripts/*.js | grep -vE 'bootstrap-board\.sh|board-graph-core\.js'` 须零命中（除两个豁免外每个 hook 都须含武装判定，否则违规）。**两个豁免**：① `bootstrap-board.sh`（它**是** ARM 动作本身）；② `board-graph-core.js`（**纯 helper 库·无 hook 入口**——按红线5 放 `hooks/scripts/` 好让 hook `require`，只经 `board-lint-core.js`→`board-lint.js`〔已带武装闸的 hook〕被触达，永不作为 hook 入口被 Claude Code 调用，**故无需自带 arming gate**；同类纯库 `board-lint-core.js` 恰含 `isArmed` 字样故一直自然过门，`board-graph-core.js` 只是不含该词的同类纯库）。**红线本身不弱化**——「每个 hook 入口 dormant-until-armed」不变，门只是承认「纯 helper 库非 hook 入口」这一既有事实。

> **违背字面就是违背精神。** "我遵循的是精神，不是字面" 是攻破每一条红线的那句合理化。没有哪个 orchestration 特殊到红线失效——当你开始论证 *这次* 是例外，那套论证本身就是症状。

---

## 4. 迭代范式总图（gstack × superpowers 路由）

本仓的开发遵循用户全局的 **gstack × superpowers 组合范式**——gstack 管"前"（方向判断）和"后"（review / QA / 安全 / ship），superpowers 管"中间"（brainstorming → plans → TDD → debugging → verification）。冲突仲裁：**用户显式指令 > skill > 默认行为**。
→ 完整路由表 + 分工原则 + 避坑：用户全局 `~/.claude/CLAUDE.md` §「gstack × superpowers 组合使用范式」。**本仓收口用 `gh` CLI 手工流程（feature branch → PR → squash merge → `gh release`；本仓**没有** `github-pr` / `github-tag-release` skill——那是历史占位、实物不存在，别去找），不用 gstack 的 `/ship` `/canary` `/land-and-deploy`**（它们假设别的部署形态）。详见 §11。

> **本仓对 superpowers 的一处覆盖（self-contain）**：「中间」段最前那一步**需求发现 / brainstorming** 在本仓用项目自带的 [`requirement-elicitation`](.claude/skills/requirement-elicitation/SKILL.md)（dev skill），**不用 `superpowers:brainstorming`**——把这一步内化进本仓、重接地到 board `goal` 模型与「发现 → 准入 → 造 → 度量」生命周期，让贡献者无须外装 superpowers 也有这一步。其余「中间」段（plans / TDD / debugging / verification）与「前 / 后」仍按全局路由表。

---

## 5. 编排纪律（SKILL A 是灵魂）

编排方法论的**唯一真相源是 [`skills/orchestrating-to-completion/SKILL.md`](skills/orchestrating-to-completion/SKILL.md)（SKILL A）**——七镜头、红线、Rationalization Table、Red Flags、决策程序（dot-graph）都在那里，是 `SessionStart` hook 每次 compaction 全文重注的常驻手册。**本文不复述任何一条**；要援引方法论就读 SKILL A，要改方法论就改 SKILL A，不在这里另起一份。

**改 SKILL A 的纪律**（这是本文该说的，SKILL A 正文不必自陈）：
- **reinject 重注友好**——它每回合 compaction 后被整篇重注，**越短越好**；新增内容前先问"这能不能进 `references/` 让主文件保持瘦"；但收敛靠 delta 下沉 `references/`，**非整篇重写 / 有损压缩**——双侧悬崖：过短 → brevity bias 丢洞察，整篇重生成 → context collapse 蚀细节（delta-only 纪律 SSOT：`.claude/skills/cc-master-skillsmith/SKILL.md`）。
- **决策程序骨架不动**——7 步 + step-6 ledger gate 的 dot-graph 是"牙齿"，结构性改动走 PR 人审（红线级）。
- **Finding #7 收敛结论**——主文件曾与 `references/async-hitl.md` 整段重复 step-6 ledger，已收敛为一句指针；新增时不要重新制造跨文件重复（SSOT 原则）。
- 改 SKILL A 的**纪律段 / description** 前，先走 §6 的 TDD-for-skills pressure baseline。

---

## 6. Skill 创作 / 维护纪律（含 TDD-for-skills）

本仓**分发**三个 skill：A（编排决策）、B（workflow 写法）、C（`account-management`·换号号池机制层）——**互不重叠**（红线 3）：A = orchestrator 做什么（含换号**决策**），B = workflow 脚本怎么写，C = 号池怎么管 / 怎么选号切号 / token 怎么安全（换号**机制**）。另有**四个项目自用、不随插件分发**的 dev meta-skill（住 `.claude/skills/`，不在 `skills/`），终端用户装插件时看不到它们——**造 / 评 / 治三件套**（skillsmith / curating / grounding）+ 它们**上游**的一个需求发现 skill：

- **`requirement-elicitation`** — 在动手任何 feature / skill / 行为改动**之前**，通过协作对话挖出用户真实痛点、过设计闸（批准前不实现）。本仓 dev 流的需求发现闸，**取代 `superpowers:brainstorming`**（self-contain + 重接地到 board `goal` 模型）。**它不是「为对仗凑的第四件造/评/治」**——是不同家族的**发现层**（喂给 curating），靠 self-containment 缺口 + 强 B1 覆写挣得席位，见其 [`DESIGN.md`](.claude/skills/requirement-elicitation/DESIGN.md)。
- **`cc-master-skillsmith`** — 写或改**一个** skill 的 body（craft 两轴诊断 + 4 类 body 内容 + pressure-test 纪律）。
- **`curating-skill-portfolios`** — 判断要不要建一个 skill / 这块该 skill 还是 reference / 一组 skill 的边界与重叠（Counterfactual Probe A/B + 裁剪七维 + DESIGN 宪法）。
- **`grounding-skill-evals`** — 声明 J（成功契约）/ 度量一个 skill / 跑触发或行为 eval（轻量 J 写法 + 接现有 eval 三脚本 + holdout / predict-then-validate 防过拟合）。

**路由**：**还没搞清用户真需求 / 动手实现之前 → `requirement-elicitation`；要不要建 skill / 边界 / 重叠 → `curating-skill-portfolios`；写或改一个 skill 的 body → `cc-master-skillsmith`；声明 J / 跑触发或行为 eval / 度量一个 skill → `grounding-skill-evals`**。四者触发时机正交（发现 → 准入 → 造 → 度量），靠 description 识别，不设路由器 skill。

**语言纪律**：本仓所有 skill 正文 + references 一律**中文**；例外仅 `name`（kebab-case 英文）、代码/路径/CLI/API 字段/工具名等技术术语；`description` 中文为主可含英文触发词。

**TDD-for-skills（纪律型 skill 改前必跑 baseline）**：任何"纪律型 / judgment-bearing"的 skill prose（agent 在压力下能把它合理化掉的规则）——新建或编辑——都**必须先跑一遍 subagent pressure baseline 看它在没有该段时选错**，再写堵漏。完整 Iron Law + 三压（time + sunk cost + exhaustion）配方在 → [`.claude/skills/cc-master-skillsmith/SKILL.md`](.claude/skills/cc-master-skillsmith/SKILL.md)（指针 `superpowers:test-driven-development` + `superpowers:writing-skills` + 官方 `skill-creator`）。pressure baseline 是**定性**（哪条 rationalization 要堵）；§8 eval 是**定量**（堵了有没有用）——互补，不替代。

**Frontmatter YAML 引号反模式（Finding #1，血泪）**：`description` 里只要含 `:` 或 `"`，**整个值必须用单引号包起来**——否则 YAML parser 误读、`plugin validate` / content 测试以非显然的方式失败。本仓所有 skill 的 frontmatter 都是单引号整包，照抄即可。**拿不准就加引号**——这是本仓最常见的 skill-authoring footgun。

**content contract = 权威结构 validator**：结构（frontmatter 有 name + description、目录布局）由 `bash run-tests.sh`（node content 段,自动 iterate `skills/*` 与 `.claude/skills/*` 的 SKILL.md）+ `claude plugin validate .`（仅校验分发的 `skills/`）把关，**别手检它们查的东西**。行为靠 pressure baseline，结构靠 contract。

---

## 7. codex 作为 reviewer 范式

cc-master 把 **codex 当独立的第二端点验收者**（呼应红线 4 "指挥不演奏" + SKILL A 的"只信端点验收 / gate-green ≠ passed"）。它**不进任何 hook**（要联网 / OAuth / 多分钟超时 / JSON 解析，违背纯 bash ship-anywhere），只以**带外手动 / 编排调用的 sub-agent 端点验收节点**形态接入。

落地物：[`skills/orchestrating-to-completion/scripts/codex-review.sh`](skills/orchestrating-to-completion/scripts/codex-review.sh)——纯 shell 封装 `codex exec review ... --json`，只读 sandbox，对一段 diff 出 `verdict: approve | needs-attention` + 每条 finding 的 severity/file/line。**空 review / OAuth 过期 → 按"未通过"处理**（silent-pass-through guard，不静默放行）。`verdict` 映射现有 Joiner 闸：`needs-attention` → Replan；`approve` + 非空 + 已读 diff → done。
→ 文档化：[`skills/orchestrating-to-completion/references/resume-verify.md`](skills/orchestrating-to-completion/references/resume-verify.md)（codex 第二验收者小节）· 指针：`/codex` skill。

---

## 8. Eval 机制（Track A + Track B）

eval 让 skill 迭代**有数可依**。运行钥匙：`uv run --python 3.12`（系统 Python 跑不了 PEP-604）+ `claude` CLI（复用 session 认证，无需 API key）。两条 Track，**不入 hook、非每-commit CI 门，作改前后对比 / pre-release 检查**。

- **Track A —— 触发准确率门**（全自动可复现）：量每个 skill 的 `description` 在一组 query 上的 precision/recall/accuracy。落地：`skills/<s>/evals/trigger.json`（should-trigger + near-miss）+ [`scripts/eval-trigger.sh`](scripts/eval-trigger.sh)。**何时跑：任何 `description` 改动前后各跑一遍比 accuracy。** 诚实标注：平凡 query 本就不触发 skill，与 description 质量无关——eval query 须 substantive。
- **Track B —— 编排纪律 benchmark**（行为型）：`orchestrating-to-completion` 让编排者行为更好的端到端断言，with-skill vs without-skill 各 3 run 看 mean±stddev。落地：[`scripts/eval-benchmark.sh`](scripts/eval-benchmark.sh) + [`design_docs/eval/track-b-benchmark.md`](design_docs/eval/track-b-benchmark.md)。**codex 当第二评委**：grader 后跑 codex 对同一 transcript 出非-Claude 裁决，分歧 = 高信号。
→ 用法 / 依赖 / 天花板：[`design_docs/eval/README.md`](design_docs/eval/README.md) · 创作/优化 description / 跑 eval 的工具：官方 `skill-creator`。

---

## 9. Dogfood 循环 + findings 台账

cc-master 用**本插件改本插件**——任何 behavioral 改动**必须 dogfood**（用 `/cc-master:as-master-orchestrator <goal>` 起真 orchestration，对 live runtime 验证）。多个历史 bug 对测试套件不可见，只在真 session 下浮现。

**findings 台账 [`design_docs/dogfood-findings.md`](design_docs/dogfood-findings.md) = 已踩反模式的永久纪律记录**（纪律式：踩过一次就写进纪律永久避免）。纪律：**用着不爽 / 给 agent 的指导不对 / 效率没真正拉满，必落台账**（现象 → 根因 → 影响 → 处置 → 严重度/来源）。「处置」字段**必须含蒸馏判定**——回流到哪个 skill 的 body / reference（指明具体落点），或显式判「不回流」+ 理由；**成功机制的验证与失败同权入账蒸馏**（不只记踩坑——台账已有 ✅正向 先例）。台账是 §6 Rationalization Table 与 §3 红线的素材源——很多红线就是 finding 沉淀出来的。

---

## 10. 测试纪律 + 验收门

两道门（与 [`CONTRIBUTING.md`](CONTRIBUTING.md) 同步，本文不复述命令细节，只立纪律）：`bash run-tests.sh` 必须以 `ALL TESTS PASSED` 收尾 + `claude plugin validate .` 无错。

- **测试只保 correctness，不保 quality**——`run-tests.sh`（hook 行为 + content 结构）回答"语义合不合 spec/contract"；quality（指导对不对、效率拉没拉满）靠 §9 dogfood + §7 端点验收独立守护。
- **并行后端点必跑全套**（Finding #12）——sub-agent / workflow fan-out 之后，orchestrator 在端点亲跑一次完整 `run-tests.sh` + `plugin validate`，不信各 leaf 的自报。
- **红线零违反 grep 门**——见 §3 各条卡点；最关键一条：`grep -rnE '\bjq\b|\bpython3?\b|tsx|ts-node' hooks/scripts/` 须只命中注释（node/JS 现已允许·ADR-006——故 grep 门**不含** `node`，否则会把 `usage-pacing.js` 的 `#!/usr/bin/env node` shebang 误判为违反）。

---

## 11. 分支 / PR / commit 约定

- **feature branch**——不在 default 分支直接动手（先 branch）。
- **PR 走 `gh` CLI 手工收口**——`gh pr create`（PR body 末尾带 Claude 署名 `🤖 Generated with [Claude Code]`）→ `gh pr merge <N> --squash --delete-branch`（本仓惯例 squash，main 上 commit 形如 `… (#N)`）。本仓**没有** `github-pr` / `github-tag-release` skill（历史占位、实物不存在，别去找）；不用 gstack `/ship`。
- **发版（release）**——版本号同步改三处：`.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`（两个 manifest 都要 bump，漏一个会版本不一致）+ `CHANGELOG.md`（`[Unreleased]` 定版为 `[x.y.z] — YYYY-MM-DD`，顶部留空 `[Unreleased]`）；合并进 main 后 `gh release create vx.y.z --target main`。无 CI，发版前手动跑 `bash run-tests.sh`（须 `ALL TESTS PASSED`）+ `claude plugin validate .`（须 `Validation passed`）两道门。
- **commit 末尾带** `Co-Authored-By: Claude <noreply@anthropic.com>`；type 前缀 `feat/fix/docs/chore/adr`。
- **single-committer**——sub-agent 只写 + 自证测试绿，**绝不 commit**；orchestrator 端点验收（含 §7 codex 自审）后统一分组 commit。
- **README.md / README_zh.md 同步**——动 user-facing 文档时两份一起改；user-visible 改动加 `CHANGELOG.md ## [Unreleased]` 条目。
- **outward-facing / irreversible（含 merge）先问用户**（红线 4 的延伸）。

---

## 12. 目录与文件约定

- **command**（`commands/*.md`）——一次性点火，frontmatter + body；body 首个非空行的 sentinel 注释（如 `<!-- cc-master:bootstrap:v1 -->`）是 hook 触发标记，**只在首行独立成行时触发**（内联提及不触发，Finding #16）。仅作为 hook 触发点的 command 需要 sentinel（目前只有 `as-master-orchestrator`）；`status` / `stop` / `handoff-to-new-session` 等普通 command 不需要（`handoff-to-new-session` 由旧 session 运行、把 board 优雅交接给新 session——是 `--resume` 跨 session re-arm 的写/准备侧，本身不武装 hook，故无 sentinel）。**命令体正文是用户敲 `/command` 时注入 agent context 的 prompt——用 imperative / 第二人称 / task-first 写（对齐 `status` / `stop` 的嗓音），别写成第三人称 reference 文档、也别把 reference 的哲学说教复述进来（[[Finding #43]]）。**
- **skill**（`skills/<name>/SKILL.md` + `references/` + `assets/`）——frontmatter `name` + `description`（单引号整包，§6）；大 reference 顶部加锚点 TOC；深度细节进 `references/` 保持主文件瘦。
- **command / skill 必须分发 self-contain（不断链）**——分发的 `commands/` 与 `skills/<name>/` 里的任何文件（命令体 / SKILL.md / `references/` / `scripts/` / DESIGN.md…）引用别的文件时，**只能指向随 plugin 分发的约定目录**（`skills/` `hooks/` `commands/` `agents/` `bin/`），且**必须用 `${CLAUDE_PLUGIN_ROOT}/<dir>/…` 绝对引用**（skill 引用自己目录内的资产用 `${CLAUDE_SKILL_DIR}/…`）。**两类断链禁止**：① **裸相对路径**（如 `scripts/cc-usage.sh`——装到用户机器后相对其 cwd 解析、找不到）；② **引用非约定目录的文件**（`design_docs/` `adrs/` `README` `AGENTS.md` `CHANGELOG`——这些不保证随 plugin 分发，安装后死链）。**概念性提及不算文件引用、可留**：泛指「以本 plugin 的 hook 脚本为准」、叙事性 `Finding #NN` / `ADR-NNN`（不带路径）、描述脚本运行时读「所在 repo 的 AGENTS.md」这类行为。→ 硬卡点：`grep -rnE 'design_docs\|adrs/[A-Z]\|\]\(\.\.\|hooks/scripts\|README\.md' commands/ skills/ \| grep -v CLAUDE_` 须只剩 `codex-review.sh` 那条「读所在 repo 的 AGENTS.md」行为描述。来源 [[Finding #38]]/[[Finding #39]]（真实安装才现形的形态盲区）。→ **裸跨 skill 引用专项硬卡点**（[[Finding #50]]）：反引号包裹、以兄弟 skill 名（`authoring-workflows` / `orchestrating-to-completion` / `account-management`）开头带 `/` 的路径引用，是装机后相对用户 cwd 解析的死链，必须升为 `${CLAUDE_PLUGIN_ROOT}/skills/<name>/…`。模式：`` grep -rnE '`(authoring-workflows|orchestrating-to-completion|account-management)/[^`]*`' skills/ commands/ hooks/ `` 须零命中（正则反引号锚定已天然排除 `${CLAUDE_*}/…` 修正形式，故**不接** `| grep -v CLAUDE_` 行级过滤——加了反而对「同行既有修正形式又有残留裸引用」漏报，与 `skill-lint.sh` check(4) 的逐 token 匹配保持一致·[[Finding #50]] codex round-3 catch）。**注意范围**：只查这三个**分发 skill 名**——纯 skill 名提及（不带 `/`）合法、同 skill 内 `references/x.md` 自引用天然不匹配、dev-only repo 根 `scripts/`（如 DESIGN.md 里）不算（不分发·红线5，裸路径从 repo 根正确，故**有意不纳入**模式避免误报）。此卡点已接进 [`scripts/skill-lint.sh`](scripts/skill-lint.sh) check (4) 自动执行（命中即 `exit 1`）。
- **hook**（`hooks/scripts/*.sh` / `*.js`）——bash 或 node/JS（红线 1·ADR-006）；状态写 sidecar，**永不碰 board**。
  - **hook 武装纪律（硬规则，违背字面就是违背精神）**：**所有 hook 在本 session 被 `as-master-orchestrator` 武装之前完全休眠。** 武装是 board-derived 且跨 compaction 持久——armed ⟺ home 里存在一个 `*.board.json`，其 `owner.active:true` 且 `owner.session_id == 本次 hook stdin 的 session_id`（sid 空 → 降级匹配任一 active 板，保 compaction 边界鲁棒）。每个 hook 的 `board_matches` / `isArmed` 即这道闸——**未武装一律静默**（空 stdout、RC 0、不 block）。`bootstrap-board.sh` 是**唯一豁免的 hook 入口**：它就是 ARM 动作本身。**另：`hooks/scripts/` 下的纯 helper 库（无 hook 入口、只被别的 hook `require`）也豁免于「须含武装判定」的 grep 门**——它们永不作为 hook 入口被 Claude Code 调用，故无需自带 arming gate；当前是 `board-graph-core.js`（只经 `board-lint-core.js`→已带武装闸的 `board-lint.js` 被触达；同类纯库 `board-lint-core.js` 恰含 `isArmed` 字样故一直自然过门，`board-graph-core.js` 是不含该词的同类纯库）。这**不弱化红线**——「每个 hook 入口 dormant-until-armed」不变，grep 门只是承认「纯 helper 库非 hook 入口」这一既有事实，对应 §3 红线6 卡点的 `grep -vE 'bootstrap-board\.sh|board-graph-core\.js'` 排除。**ARM 有两种形态**：fresh（建板即把 `owner.session_id` 盖成创建它的 session）与 resume（`as-master-orchestrator --resume <选择器>` 把选定的**已存在**旧板盖成新 sid、`owner.active` 无条件置 true 含**复活 `/stop` 归档板**、保留 `tasks`/`log`/`goal`/`git`，经 live 安全闸——见 ADR-009）。两形态都经 `bootstrap-board.sh` + 显式用户命令，仍是「唯一豁免的 ARM 动作」，红线 6 实质不变。解除武装 = `/stop` 归档板（`owner.active:false`，此后**显式可逆**——可经 `--resume` 复活）+ goal-hook。新增 / 修改任何 hook **必须**先过这道闸（绝不在未武装路径上注入或 block），且只读 narrow-waist 的 `active` / `session_id` 判 arming——不碰 board 的 agent-shaped 部分（红线 2）。→ 决策快照：[`adrs/ADR-007-hook-arming-gate.md`](adrs/ADR-007-hook-arming-gate.md)（+ resume re-arm：[`adrs/ADR-009-resume-cross-session-re-arm.md`](adrs/ADR-009-resume-cross-session-re-arm.md)）。
- **design_docs**——正式文档进 `design_docs/`；临时 plan 进 `design_docs/plans/`（gitignored）；日期前缀命名（`YYYY-MM-DD-<slug>.md`）。
- **board 不入版本控制**——`.claude/cc-master/`（或 `$CC_MASTER_HOME`）gitignored。

---

## 13. ADR 约定

结构性架构决策（"为什么 X 不 Y / 何时可推翻"）记成 ADR——与 design_docs（描述当前状态）严格分开。命名 `ADR-NNN-<slug>.md`，带 Status/Date/Scope frontmatter + Context/Decision/Consequences/Alternatives/Related 模板。**何时写 ADR、ADR-vs-design_docs 试金石、workflow 全在** → [`adrs/AGENTS.md`](adrs/AGENTS.md)。现有 ADR-001..011（hooks-pure-bash / ship-anywhere-scope / board-narrow-waist / loop-dissolution-and-goal-hook / two-skills-separation / hooks-may-use-node-js / hook-arming-gate / account-authoritative-usage-and-script-placement / resume-cross-session-re-arm / two-sided-pacing-corridor / self-wakeup-watchdog —— ADR-010：pacing 从单边上限护栏改为**双侧目标走廊**（5h reset 目标落 70–90% 区间、欠用侧轻推加速 / 临界侧轻推减速），以 **7d 窗口当加速硬总闸**；ADR-011：前台空转期 **watchdog 自我唤醒**——`ScheduleWakeup`/`CronCreate`（本地内存调度）部分解禁、许可用于补静默失败盲区的安全网，**降级链 + background-shell 永为 floor**，云 routines / agent-teams 仍排除·收窄 ADR-002）。

---

## N. 触发式深入阅读

下表按"**当你要做 X 时去读 Y**"组织——命中触发条件时跳转，未命中不需预加载。

| 当你要 | 读什么 |
|---|---|
| 改编排方法论 / 援引七镜头 · 红线 · 决策程序 | [`skills/orchestrating-to-completion/SKILL.md`](skills/orchestrating-to-completion/SKILL.md)（魂 · 不在本文复述）|
| 把目标拆成依赖 DAG（CPM / float / 临界路径 / 粒度）| [`skills/orchestrating-to-completion/references/decomposition.md`](skills/orchestrating-to-completion/references/decomposition.md) |
| 派发的某个大节点*内部*本身是个复杂规划问题（让执行者发现并遵循**被编排项目自己**约定的 planning 规范 + 维护其计划文档 / board ⊥ 项目 planning 层的多层次调度）| [`skills/orchestrating-to-completion/references/multi-layer-planning.md`](skills/orchestrating-to-completion/references/multi-layer-planning.md)（注意：「项目」指 orchestrator 所服务的目标项目，**非 cc-master 本仓**）|
| 选后台机制 / 编排并行（shell · sub-agent · workflow · 两尺度 dataflow / 反过度工程护栏 · parallel-vs-pipeline smell-test）| [`skills/orchestrating-to-completion/references/dispatch.md`](skills/orchestrating-to-completion/references/dispatch.md) |
| 动 board 协议 / narrow-waist schema / status enum / 续跑续接 | [`skills/orchestrating-to-completion/references/board.md`](skills/orchestrating-to-completion/references/board.md) |
| 异步完成 + HITL / p95 hedging / 用户当 async worker | [`skills/orchestrating-to-completion/references/async-hitl.md`](skills/orchestrating-to-completion/references/async-hitl.md) |
| 前台空转等后台时为静默失败盲区 arm watchdog 自我唤醒（降级链 CronCreate/ScheduleWakeup/Monitor + background-shell floor、`wakeup` 柔性边双层记录、CronDelete 清理）| [`adrs/ADR-011-self-wakeup-watchdog.md`](adrs/ADR-011-self-wakeup-watchdog.md) + [`skills/orchestrating-to-completion/references/async-hitl.md`](skills/orchestrating-to-completion/references/async-hitl.md)（`wait` 边主体）+ [`skills/orchestrating-to-completion/references/dispatch.md`](skills/orchestrating-to-completion/references/dispatch.md)（工具降级链）|
| 廉价续跑 + 端点验收 / content-hash / codex 第二验收者 | [`skills/orchestrating-to-completion/references/resume-verify.md`](skills/orchestrating-to-completion/references/resume-verify.md) |
| 选每节点模型档位 / 主线为何固定模型保 cache / 按 5h-7d 配额窗口 pace（**双侧目标走廊**：欠用加速 / 临界减速、**7d 当硬总闸**·ADR-010）| [`skills/orchestrating-to-completion/references/cost-and-pacing.md`](skills/orchestrating-to-completion/references/cost-and-pacing.md)（reference 知识,非红线）+ [`adrs/ADR-010-two-sided-pacing-corridor.md`](adrs/ADR-010-two-sided-pacing-corridor.md) |
| 沿愿景轴定位（哪条镜头 / reference / 决策程序节点服务哪项 charter 能力）/ 把 hook 注入短语回溯到锚点 | [`skills/orchestrating-to-completion/references/external-coordinates.md`](skills/orchestrating-to-completion/references/external-coordinates.md)（愿景索引 + hook 共享词汇,魂瘦身下沉的坐标系）|
| 写 / 调试 / 启动 workflow 脚本（API + 机制 + pattern + 11 个 example）| [`skills/authoring-workflows/SKILL.md`](skills/authoring-workflows/SKILL.md) + [`references/`](skills/authoring-workflows/references/) + [`assets/examples/`](skills/authoring-workflows/assets/examples/) |
| 动手任何 feature / skill / 行为改动前先挖真需求 / 过设计闸（取代 `superpowers:brainstorming`）| [`.claude/skills/requirement-elicitation/SKILL.md`](.claude/skills/requirement-elicitation/SKILL.md)（道 + 五个 discovery moves + strawman + 设计闸，项目自用 dev skill）|
| 写 / 改任何本仓 skill（尤其纪律型）/ 跑 pressure baseline | [`.claude/skills/cc-master-skillsmith/SKILL.md`](.claude/skills/cc-master-skillsmith/SKILL.md)（TDD-for-skills，项目自用 dev skill）|
| 判断要不要建 skill / 该 skill 还是 reference / 一组 skill 边界与重叠 | [`.claude/skills/curating-skill-portfolios/SKILL.md`](.claude/skills/curating-skill-portfolios/SKILL.md)（Counterfactual Probe A/B + 裁剪七维 + DESIGN 宪法，项目自用 dev skill）|
| 声明 J（成功契约）/ 度量一个 skill / 跑触发或行为 eval | [`.claude/skills/grounding-skill-evals/SKILL.md`](.claude/skills/grounding-skill-evals/SKILL.md)（轻量 J 写法 + Track A/B + holdout / predict-then-validate，项目自用 dev skill）|
| 改 hook | [`hooks/scripts/`](hooks/scripts/) + [`tests/`](tests/) + [`CONTRIBUTING.md`](CONTRIBUTING.md)（先确认红线 1：bash+node/JS，ADR-006）|
| 新建 / 改任何 hook 前先懂「武装闸」/ 为什么所有 hook 未武装即休眠 | [`adrs/ADR-007-hook-arming-gate.md`](adrs/ADR-007-hook-arming-gate.md)（board-derived armed-gate）+ 本文 §12 hook 武装纪律 |
| 让新 session 用 `--resume` 续旧板 / 复活归档板 / 接管安全闸的「显式 vs 隐式」论证 | [`adrs/ADR-009-resume-cross-session-re-arm.md`](adrs/ADR-009-resume-cross-session-re-arm.md)（显式跨 session re-arm）+ [`hooks/scripts/bootstrap-board.sh`](hooks/scripts/bootstrap-board.sh) 的 resume 分支 |
| 由旧 session 优雅交接 board 给新 session（`--resume` 的写/准备侧：停派发 + 兜底在飞任务 + 写叙事交接文档 + 归档板）| [`commands/handoff-to-new-session.md`](commands/handoff-to-new-session.md)（与 `--resume` 配对的写侧）|
| 让 codex 当端点验收 reviewer | [`skills/orchestrating-to-completion/scripts/codex-review.sh`](skills/orchestrating-to-completion/scripts/codex-review.sh) + `/codex` skill |
| 在 pacing 决策点感知 5h-7d usage（带外信号脚本，非 hook）| [`skills/orchestrating-to-completion/scripts/cc-usage.sh`](skills/orchestrating-to-completion/scripts/cc-usage.sh)（账户权威 `used_percentage` 优先、本地反推 fallback；信号由 `statusline-capture.js` 捕获·Finding #37）|
| 跑触发准确率 eval（description 改动前后）| [`scripts/eval-trigger.sh`](scripts/eval-trigger.sh) + [`design_docs/eval/README.md`](design_docs/eval/README.md) |
| 跑编排纪律 benchmark（行为型 + codex 第二评委）| [`scripts/eval-benchmark.sh`](scripts/eval-benchmark.sh) + [`design_docs/eval/track-b-benchmark.md`](design_docs/eval/track-b-benchmark.md) |
| 写新 ADR / 援引现有 ADR / 判断 ADR-vs-design_docs | [`adrs/AGENTS.md`](adrs/AGENTS.md) + [`adrs/`](adrs/) |
| 落 dogfood 发现 / 援引已踩反模式 | [`design_docs/dogfood-findings.md`](design_docs/dogfood-findings.md) |
| 援引设计留痕 / 有意排除的决策 | [`design_docs/spec.md` §12](design_docs/spec.md) |
| 追踪六条愿景的落地 gap / 重审某能力兑现度 | [`design_docs/vision-landing-tracker.md`](design_docs/vision-landing-tracker.md)（兑现度矩阵 + 六张 gap 卡 + 排序讨论清单，living 追踪）|
| 临时计划 / 草稿（不进版本控制）| 写在 `design_docs/plans/`（gitignored），不进正式 design_docs |
| 装 / 用插件（用户视角）| [`README.md`](README.md) / [`README_zh.md`](README_zh.md) |
| 跑 dev loop / before-PR 两道门 | [`CONTRIBUTING.md`](CONTRIBUTING.md)（红线 SSOT 见本文 §3）|
