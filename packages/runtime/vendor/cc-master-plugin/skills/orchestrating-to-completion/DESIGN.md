# orchestrating-to-completion — 设计宪法（DESIGN.md）

> 本文回答「这 skill 是什么 / 为什么」。「怎么用」在 [`SKILL.md`](SKILL.md)（魂，本文不复述其七镜头 / 红线 / 决策程序）；深细节在 [`references/`](references/)。
> 设计先于实现——任何对 SKILL.md 的实质改动，先在此更新对应段。
> 这是 cc-master **分发**的两个 skill 之一（住 `skills/`，随插件 ship）。它是产品的**魂**：`SessionStart` hook 每次 compaction 全文重注。

## 1. One-liner

在跑 >24h 目标当总指挥、或协调多个后台 agent/workflow 时调用——给 agent「指挥不演奏」的编排纪律（拆依赖图 → 就绪即派 → 端点验收 → 整合，绝不亲手抄起乐器），覆写它默认的 idle-wait、制造 busywork 装忙、亲手实现 / 亲手 review、把 green gate 当 passed 这四条退化。

## 2. Craft 自分类

- **Craft**：C 纪律级（命名锚在前 + 决策程序 dot-graph 作牙齿 + 红线 backstop）。
- **process-control 轴**：强——决策程序是确定性 dataflow loop（reconcile → 该问就问 → 就绪即发 → fill → verify → 唯 ready-set 空才 wait），step-6 ledger gate 是序敏感的「牙齿」：换序 / 跳步就让 agent 在 ready 仍有活时提前 stop，破坏 long-horizon 续跑的正确性。board narrow-waist 又是被 hook 读的 schema-bound 集成契约。
- **cognitive-override 轴**：强——核心价值在覆写三条 model prior：「指挥不演奏」逆「我顺手做了更快」，「gate-green≠passed」逆「绿了就算过」，「idle≠license to manufacture work」逆「闲着就找点活显得忙」。且要在 deadline / 「就这一次」压力下仍守住，要泛化到任意目标形状。
- **形状蕴含**：(强 process, 强 cognitive) → Craft C。SKILL.md 以命名锚为主干（七镜头 / 红线 / Rationalization Table / Red Flags），配决策程序 dot-graph 作确定性牙齿，**不是编号清单**——价值在 agent 内化心智模型 + 服从那张 graph 的控制流，而非重放步骤。reinject 友好（每回合整篇重注，越短越好），深细节全下沉 `references/`。**愿景索引地图 + hook 共鸣契约**——六愿景（C1–C6）的一张一等导航表（愿景 → 镜头 → reference → 决策程序节点 → hook 注入短语）+「当 hook 对你说话」共鸣小节（hook 刻意复用本 skill 语汇，让 agent 看到 context 外注入的短语能 verbatim 回指到对应镜头 / 决策程序节点）——**整体下沉到 `references/external-coordinates.md`**，主文件末尾只留一句指针 + 一条魂内即用的识别规则。这一下沉是 Finding #28（常驻重注的魂内复述 hook / 愿景状态映射表 desync-prone）与 Finding #7（魂内 SSOT 重复是 reinject 负担）的收敛处置：注入短语的 SSOT 在本 plugin 的 hook 脚本、每 reference 服务哪愿景的 SSOT 在各 reference header 的愿景 tag，魂不再持有这张表的第二份拷贝。每 reference 的 read-when 触发条件写在各 reference header（同时打愿景 tag，令共鸣双向可发现）。

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品 / portfolio 而言

它**就是** cc-master 这个产品本身——补的不是某个边角洞，而是产品的本体：cc-master 的承诺是「把任意主会话 agent 变成 long-horizon master orchestrator」，这份编排手册就是兑现那个承诺的全部内容。没有它，主会话 agent 退回普通 agent，没有任何 long-horizon 纪律，插件只剩 hook + board 而没有魂。它**不能**被 `authoring-workflows` 覆盖：后者只教「workflow 这一种后台机制的脚本怎么写」，是三机制之一的乐器手册；编排者「该不该用 workflow、何时拆图、何时派发、何时验收」的主线决策只在这里。这是红线 3「两分发 skill 不重叠」的一半。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在**每个 turn 收尾的决策瞬间**，提供一份确定性的决策程序（就绪即发、重叠等待、唯 ready-set 真空才停），把「我感觉没事干了」逼成「跑完那张 graph，确认无可排之事再 wait」。不用它会怎样退化（具体，对应 SKILL.md 的 Rationalization Table 与 Red Flags）：① 后台在跑就 idle-wait 空等，看不见还能排下一段 / 验上一段；② 闲着就 manufacture busywork、把没在临界路径上的「再 review 一遍」当工作；③ 一行小修就亲手抄起乐器、亲自实现或 review，违背指挥不演奏；④ 看 gate 绿了 / review 空了就 silent pass-through 标 done。四种退化都是 long-horizon 跑崩的根因。

### 3.3 Human 视角 —— 对最终落地的用户 / 维护者而言

用户给的 >24h 目标被**跨 compaction、跨 session 驱动到完成**——指挥不忘记自己是谁、不亲手实现把自己降级成乐手、不过度 review 烧预算、该用户拍板的（merge / 不可逆 / 对外）老实抛出来等答而不擅自决定。用了它和没用它的产出可观察区分：用了的会留下每条 path 的 step-6 ledger（board + 对话双写的验收证据），跨 compaction 后能凭 board 重新认领自己是哪场 orchestration；没用的在第一次 compaction 后就忘了目标、忘了还剩什么、或亲手把活做成一团。

## 4. 责任边界

### 4.1 IN scope

单一职责方向：**指挥做什么**——把一个 long-horizon 目标编排到完成的主线决策。

- 拆图：把目标拆成依赖 DAG，找临界路径，按 float 分配资源与模型档位。
- 派发：就绪即发，在三机制（shell / sub-agent / workflow）间按形状选，控 WIP 与配额窗口。
- 验收：只信端点独立验收，gate-green≠passed，content-hash 记账，done+verified 可跳可续。
- 整合：把 done 节点并回主线，past-p95 hedge，stale 标记。
- 该问就问：把用户当 async worker，前台对话 ∥ 后台执行，可预见的用户决策 prefetch。

### 4.2 OUT of scope（明确移交给谁）

| 关切 | 移交给 |
|------|--------|
| 「workflow 脚本怎么写」（`parallel()` vs `pipeline()`、schema、caps、determinism） | `authoring-workflows` |
| board 协议细节（narrow-waist schema、status enum 路由、续接 / supersession） | 自己的 `references/board.md`（深细节下沉，主文件只留 essentials） |
| 写 / 改一个 skill 的 body / 判该不该建 / 度量一个 skill | dev meta-skills（`cc-master-skillsmith` / `curating-skill-portfolios` / `grounding-skill-evals`） |

### 4.3 Boundary heuristic（一句话判定法）

**问「这是在决定指挥做什么、还是在写某件乐器怎么演奏？」**——拆图 / 派发 / 验收 / 整合 / 该问就问（指挥做什么）→ 本 skill；某件乐器（workflow 脚本）内部怎么写 → `authoring-workflows`。一句话：**主线编排决策归本 skill，单个 workflow 脚本的写法归邻居。**

## 5. 触发与反例

### 5.1 Recognition cues（应当被触发的信号）

- 接到一个跨度 >24h 的目标要当总指挥。
- 要协调多个后台 agent / workflow 朝一个大目标推进。
- 每次 context compaction 之后（hook 全文重注后，要重新认领 board、续跑）。
- 抓到自己在 idle-wait 空等、manufacture busywork、亲手抄起乐器（实现 / review）、或把 green gate 当 passed。
- 撞到一个该用户拍板的 merge / 不可逆 / 对外步骤，要决定抛出去而非擅自决定。

### 5.2 Counter-examples（明确不该被触发的反例）

- 只要写 / 调一个 workflow 脚本（`parallel()` 怎么写、caps 多少）→ `authoring-workflows`（near-miss：沾「workflow」字面但属脚本写法，非主线编排）。
- 要判一个能力该不该独立成 skill / 一组 skill 边界与重叠 → `curating-skill-portfolios`。
- 要写 / 改某个 skill 的 body、或度量某 skill → 对应 dev meta-skill。

### 5.3 Pre-flight gate（硬门，任一不满足就 STOP）

- (i) 确有一个 long-horizon / 多后台任务的目标需要编排（不是单条推理链一次性交付——那 dispatch 一个 sub-agent 就够，别上 orchestration）。
- (ii) board 的可配置 home 可达、可读写（续跑要靠它当跨 compaction 的 save file）。

## 6. 演化锚

- **Lifecycle class**：methodology——编码的是「怎么严谨地当 long-horizon 指挥」，模型越强越该严格执行（更强模型更容易自信地「我顺手做了更快」抄起乐器，越需要红线拦），随工程实践本身存续。
- **Sunset trigger**：不适用（methodology 类带存续推定）。它是产品的魂，不会因模型变强而过时——更强的编排者更需要确定性的决策程序与红线，而非更少。
- **Fitness 不变量 → 可跑 probe**：
  - *指挥不演奏 / gate-green≠passed* → 行为型红线，**非 grep 能拦**：由 §8 Track B benchmark（`scripts/eval-benchmark.sh`，with-skill vs without-skill 各 3 run 看编排者行为差 + codex 第二评委）+ 端点验收守。
  - *board narrow-waist 稳定*（红线 2）→ `bash run-tests.sh` 的 hook 测试段：动 waist 的 PR 必带全套 hook 测试同步绿（hook 只读那一小撮 pinned 字段）。
  - *ship-anywhere*（红线 5）→ 两层各守：① **后台派发机制仍只限 shell / sub-agent / workflow**（不变，ADR-002 留痕）；② **timer primitives 的 watchdog 例外**（ADR-011 收窄 ADR-002）——`ScheduleWakeup` + 本地 `CronCreate`（`durable:false` 内存调度，不需 claude.ai OAuth）**许可用于自我唤醒 / watchdog**（补静默失败盲区的安全网），但只以降级链形态教（CronCreate / ScheduleWakeup / Monitor 按情境降级，**background-shell `until` 轮询永为 universal floor**）；**云 `scheduled routines` / `/schedule` / RemoteTrigger（需 OAuth）+ agent-teams 仍排除**（与本地内存调度区分）。带外脚本（cc-usage / cost-pacing 信号）只进 `scripts/`，绝不进 `hooks/`。
  - *与 `authoring-workflows` 不重叠*（红线 3）→ 两者 description 的 Use-when / 反例互指闭合：本 skill 反例指向「写脚本 → authoring-workflows」，邻居反例指向「主线编排 → 本 skill」。
  - *hook 注入词汇 ↔ skill 锚点契约*（共鸣不变量）→ 三个现存 hook（reinject / bootstrap-board / verify-board）emit 的英文短语必须与 SKILL.md「当 hook 对你说话」小节 verbatim 一致（共享 ubiquitous language，让 agent 从 context 外注入回指到镜头 / 决策程序节点）。这是**双向**约束：改任一 hook 的注入文案，须同步「hook 共鸣」小节与愿景地图 hook 列的引用短语；改共鸣小节引用，须核对 hook 真 emit 的字符串（别凭转述）。H3/H5 已 live 接入共鸣小节（H3 verify-board 的 `Unanswered user decisions ...` 追加句 / H5 posttool-batch 的 `warn=`）；H8 待其 PR——新增 hook 落地时连同其注入短语 ↔ 锚点对子在同一 PR 共同设计，不事后回贴。probe：人审 diff 时比对本 plugin hook 脚本的 `ctx=`/`warn=`/`emit_block` 字面量与共鸣小节引文。
- **Cross-major review owner**：`curating-skill-portfolios`（portfolio 准入 / 重叠 / 边界的 SSOT；模型大版本时由它复盘本 skill 是否仍站得住、是否与 `authoring-workflows` 重叠）。
