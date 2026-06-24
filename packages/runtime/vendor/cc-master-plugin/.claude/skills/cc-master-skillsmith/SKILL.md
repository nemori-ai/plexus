---
name: cc-master-skillsmith
description: '当你创建、编辑或审查一个 cc-master skill 时用——尤其是那种纪律型（discipline-enforcing）skill（orchestrating-to-completion、authoring-workflows、本 skill），它的规则 agent 在压力下能合理化掉。Triggers: 新建/修改/审查本仓 skill、加 Rationalization Table / Red Flags / 决策程序、改 SKILL.md 的纪律段或 description；或当你发现自己正打算先动手写 skill 正文、却没先看一个 agent 失败。Do NOT use when 你只是要判断要不要建一个 skill / 这块该 skill 还是 reference / 两个 skill 重不重叠（那是 curating-skill-portfolios）；Do NOT use when 你要声明 J / 跑触发或行为 eval / 度量一个 skill（那是 grounding-skill-evals）。'
---

# cc-master-skillsmith — cc-master skill 纪律的 TDD

> **这是项目自用的 dev 工具，不是分发给插件用户的 skill。** 它住在
> `.claude/skills/`（cc-master 自己的贡献者用），**不在** `skills/`（那才会 ship 给
> 插件用户）。终端用户装 cc-master 永远看不到它；它只为锻造*本仓*的 skill 存在。

这是 meta-skill：cc-master 怎么写、怎么改自己的 skill。它之所以存在，是因为一个
*强制纪律* 的 skill——「指挥永不演奏」「没有失败测试就没有生产代码」「只信端点、
不信绿闸」——它本身就是一段处于测试之下的行为。你无法知道这段 prose 到底有没有真正
改变 agent 的行为，除非你已经亲眼看过一个 agent **在没有它的情况下失败**。

**写一个纪律型 skill，就是把 test-driven development 应用到 prose 上。** 压力场景就
是测试。agent 逐字的合理化就是那个失败的输出。杀掉那条合理化的 skill 段落就是生产
代码。

> **REQUIRED BACKGROUND：** 本 skill 改编自 `superpowers:test-driven-development` 的
> RED-GREEN-REFACTOR 循环，以及 `superpowers:writing-skills` 的 subagent 压力测试格式。
> 如果你还没把这两者内化，先读它们——本 skill 假设你已经懂了，只在其上补 cc-master
> 特有的契约。

---

## 铁律（The Iron Law）

```
NO DISCIPLINE SKILL — NEW OR EDITED — WITHOUT A FAILING PRESSURE BASELINE FIRST
（任何纪律型 skill——新建或编辑——都不许在没有一个失败的压力 baseline 之前动笔）
```

和 TDD 同一条铁律，映射到 prose 上。在你写或改一条 agent 能合理化掉的规则之前，你必须
先把一个**压力场景跑过一个没有该 skill（或没有该新段落）的 subagent**，看它选错那个。
没有记录在案的失败 → 不许改 skill。

在跑 baseline 之前就写好了 skill 段落？删掉它。从 baseline 重新开始。

**没有例外：**
- 「这条规则显然是对的」不算例外。
- 「我只是加一行 Rationalization Table」不算例外。
- 「这只是给纪律段落改个措辞」不算例外。
- 别在跑场景时把没 baseline 的草稿「留着当参考」——你会去 adapt 它，那就是 writing-after。
  删除就是删除。

**违背铁律的字面就是违背它的精神。** 「我知道 agent 会说什么，所以我跳过 baseline 直接
写反驳」正是本 skill 禁止的那条合理化。你不知道它们会说什么。你*以为*你知道。baseline
正是你发现自己想错了的途径。

### 合法的 RED 证物目录（证据驱动变异）

铁律要的「记录在案的失败」是一个**目录**，不只合成 baseline 一种形态——以下任一都是
合法的 RED 证物：

| 证物 | 来源 |
|------|------|
| pressure-test RED（合成失败） | 本文循环 + `references/pressure-testing.md` |
| dogfood finding（实战失败条目） | `design_docs/dogfood-findings.md`（AGENTS.md §9 台账） |
| Track A miss（触发失败的具体 query） | `scripts/eval-trigger.sh` 输出 |
| 真 session 失败 transcript | 真实编排 / dev session 的逐字记录 |

**每次 prose 改动必须锚定目录中一个具体失败证物**——后三种是「已经在现实里跑完的
RED」，与合成 baseline 同权。目录之外没有合法入口：尤其「我读完觉得它能更好」这种
审美判断，零证物 = 零改动理由。证物只给你 RED；GREEN 的验证（带新 prose 重跑场景）
不因证物形态而免除。

### 这条铁律 gate 什么、不 gate 什么

这条铁律 gate 的是**判断型、强制纪律的 prose**——agent 在压力下能把自己说服绕过去的
规则。它**不** gate：

- 纯 reference / how-to 内容（API 签名、workflow 范式树、TOC、固定格式的表格）。这些靠
  使用来验证，不靠压力。如果一条约束是机械可检的（regex、`plugin validate`、一个测试），
  就自动化它——别写成一条规则再去压力测它。
- 没有行为主张的机械编辑（修一条死链、给索引里的文件改名、更新一个计数）。content
  contract（见下）会接住结构性破损。

如果你拿不准一次编辑是「纪律」还是「reference」：这次编辑有没有对*一个 agent 在被诱惑不
照做时该选什么*作出主张？如果有，它就是纪律——给它跑 baseline。

---

## 循环（RED → GREEN → REFACTOR）

| 阶段 | 你做什么 | cc-master 产物 |
|-------|-------------|--------------------|
| **RED** | 把一个 3 压场景跑过一个**没有**该 skill/段落的 subagent。 | 逐字捕获到的合理化。 |
| **Verify RED** | 确认 agent 确实选错了，以及*为什么*（那个借口）。 | 借口原文——逐字抄录。 |
| **GREEN** | 写出恰好杀掉那些借口的最小 skill prose。 | 新建/编辑的 SKILL.md 段落 + 每个借口一行 Rationalization Table。 |
| **Verify GREEN** | 把同一场景**带着** skill 重跑。agent 现在合规了。 | agent 引用该段落，选了对的那个。 |
| **REFACTOR** | 冒出新的合理化？加一条反驳 + 表格行。重跑。 | 漏洞堵上，仍 GREEN。 |

完整的压力场景配方（三压、固定的 prompt 脚手架、怎么捕获借口、怎么回填表格）在
[`references/pressure-testing.md`](references/pressure-testing.md)。跑你的第一个 baseline
之前先读它。

### 三压（永远叠加 3+ 条）

单一一条压力是学院派的——agent 只会背诵规则。真实的失败需要 **time pressure + sunk
cost + exhaustion** 叠在一起，逼出一个明确的 A/B/C 选择，且没有「我会去问用户」的逃生口。
配方文件里有确切措辞；短版本：

- **Time（时间）**——部署窗口正在关闭、用户在等、deadline 就是现在。
- **Sunk cost（沉没成本）**——已经投入了几小时/几行；删掉「感觉很浪费」。
- **Exhaustion（疲惫）**——一段长跑的尾声，「只想把这个搞完」。

然后**逐字**捕获 agent 的借口，回填进目标 skill 的 **Rationalization Table**（借口 → 现实，
两列）和 **Red Flags** 列表。这张表不是凭你想象编的——它是真实失败的 transcript。这正是
跑 baseline 的全部意义。

---

## 本 skill 与 eval 的关系（定性 vs 定量）

cc-master 沿两条互补的轴测试它的 skill。别把它们混为一谈。

| | 本 skill（压力 baseline） | Eval（`design_docs/eval/`） |
|---|---|---|
| **种类** | 定性——浮现出*哪些*合理化存在 | 定量——给触发率/行为率打分 |
| **输出** | 逐字借口 → Rationalization Table 行 | precision/recall 数字、mean±stddev |
| **回答** | 「prose 必须堵哪个漏洞？」 | 「这次改动帮了还是害了，幅度多大？」 |
| **何时** | 写/改任何纪律规则之前 | Track A 在每次 `description` 改动；Track B 围绕行为改动 |

- **Track A —— 触发准确率**（`design_docs/eval/README.md`）：`description` 有没有让 Claude
  恰好在该读时读这个 skill。任何 `description` 编辑前后各跑一遍。压力 baseline 测的是
  *body*；Track A 测的是 *frontmatter 触发*。
- **Track B —— 行为 benchmark**（`design_docs/eval/track-b-benchmark.md`）：with-skill vs
  without-skill 在 transcript 上的行为断言，以 codex 当第二评委。压力 baseline 找到漏洞；
  Track B 度量堵上它有没有移动整体行为。

流程是：**压力 baseline（找到漏洞，定性）→ 写/改 prose → eval（确认有用，定量）。** 它们
是顺序的，不是替代——一个绿的 Track-A 数字背后没有压力 baseline，意味着你为一个从未在压力
下测过的 body 优化了它的触发器。

---

## content contract 是权威的结构闸

行为是你拿 baseline 去守的；**结构是 harness 拿来强制的。** 别手检闸门已经查的东西。

```bash
./run-tests.sh                 # node "content" 套件断言 skills/（分发）和
                               # .claude/skills/（项目自用，含本 skill）下每个 SKILL.md
                               # 都有带 name + description 的 YAML frontmatter
claude plugin validate .       # 校验 plugin manifest、分发的 skill、command
```

`run-tests.sh` 必须以 `ALL TESTS PASSED` 收尾。content 套件同时 iterate `skills/*/SKILL.md`
和 `.claude/skills/*/SKILL.md`，所以这个 skill 本身就处在它所宣讲的同一道结构闸之下——把
frontmatter 写对它就过。`claude plugin validate .` 校验的是*分发的*插件（manifest +
`skills/` + command）；它**看不到** `.claude/skills/`（那些不属于 ship 出去的插件），这正是
为什么 content 套件要覆盖它们。

### Frontmatter YAML 引号（Finding #1，血泪）

一个含 `:` 或 `"` 的 `description` **必须加引号**，否则 YAML parser 会误读它，
`plugin validate` / content 测试以非显然的方式失败。整个值用单引号包起来（像本 skill 自己
的 frontmatter 那样）。这是本仓最常见的 skill-authoring footgun——见 AGENTS.md §6。拿不准
就加引号。

---

## 写 body 前先跑 craft 两轴诊断（强制前置）

压力 baseline 回答的是「这条纪律规则有没有被堵住」；它**不**回答「这整个
skill 的 body 该长什么形状」。这两件事正交：你可以把每条规则都堵得密不透
风，却把一个本该是**心智模型**的 skill 写成一串编号步骤——形状错配，规则再
严也教错了 substrate。

所以：**写 body 的第一行之前，先对这个 skill 跑一遍 craft 两轴诊断**，定下它
是哪一种 craft，再按那种 craft 的形状落笔。两轴各 5 题、每题 yes +1、≥3=strong，
组合成 4 象限：

| | cognitive 弱 | cognitive 强 |
|---|---|---|
| **process 强** | **Craft A** 机械配方（编号步骤） | **Craft C** 纪律级（命名锚 + 流程 + 硬规则 backstop） |
| **process 弱** | **(弱,弱) 反模式 → 拒绝建** | **Craft B** 心智模型（命名锚为主） |

完整的两轴 10 题（每题带 yes-trigger 例子）+ 4 象限决策表在
[`references/craft-axis-diagnosis.md`](references/craft-axis-diagnosis.md)。诊断
定下 craft 之后，body 只装四类内容（触发 / 命名锚 / 流程骨架 / 硬约束），4 层
写作分配 + progressive-disclosure 阈值在
[`references/body-content-types.md`](references/body-content-types.md)。

**craft 诊断必做，不是可选的开场白。** 跳过诊断默认会落进「Step 1 做 X、Step 2
做 Y」的编号清单形状——那是模型见得最多的写法，它只贴合两轴里的一个极端
（process 强 / cognitive 弱）。住在网格别处的 skill 一旦这么写，要等到 baseline
跑出形状不对才发现，那时已经是整篇重写。诊断本身就是预防。

### craft 诊断的 Rationalization Table

| 借口 | 现实 |
|------|------|
| 「我一看就知道这是纪律级，不用跑两轴。」 | 「一看就知道」正是默认落进编号清单的那条路。10 题花两分钟，重写花两小时。 |
| 「先按编号步骤写出来，形状不对再调。」 | 形状是 substrate，不是排版。写成编号清单再改成心智模型 = 整篇重写，不是局部调。 |
| 「(弱,弱) 也写出来看看，万一有用呢。」 | 弱弱象限既不给步骤也不给心智模型，是占位 prose。它一旦发布就永久和更密的 sibling 抢注意力。拒绝建 / 折进别的 skill / 重审 scope。 |
| 「诊断和压力 baseline 是一回事，跑了一个就够。」 | 不是。baseline 测「规则有没有被堵」（定性堵漏），诊断测「body 形状对不对」（craft 选型）。互补，不替代。 |

> **违背字面就是违背精神。** 「我跑了压力 baseline，相当于诊断过了」——没有。
> 你堵了规则的漏，没定 body 的形。当你开始论证「*这个* skill 太明显不用诊断」，
> 那套论证本身就是症状：最明显的 skill 恰是最容易被默认写成编号清单的那个。

---

## 改既有 skill：delta-only，永不整篇重写

改一个**已存在**的 skill / reference 时，只产出**条目级 delta**——定点的小节增、表格
加行、半句补、删掉指得出的具体某几处——**绝不重生成整个文件**。这条规则堵的是同一次
baseline 暴露的双侧悬崖（一个强模型受试在三压 + 「优化它」下默认整篇重生成了
reference：123→95 行、7 小节并成 5、合并小节「减目录噪声」）：

- **整篇重写 → context collapse**：每次重生成都在重新采样全文，来之不易的细节——
  Finding 条目、引号 footgun 警告、回退留痕——正是最容易被「顺手精简」掉的那批。
  重写几轮，洞察就蒸发了。
- **过度压缩 → brevity bias**：以「更精炼」为目标的迭代压缩系统性地丢领域洞察——
  行数降了，substrate 没了。

「太长」的**合法**收敛只有两种，且都是 delta：**下沉细节到 `references/`**（主文件留
一句指针）+ **删真正重复的那几处**（指得出具体哪两段重复）。不是重生成、不是合并
小节、不是砍行数。改多快、怎么回退（演化频率分层 + git 谱系）归 `grounding-skill-evals`
的 `references/track-ab-discipline.md` §7——本节只管「怎么改」，那里管「改多快 + 怎么
回退」。

### 证物前置步：judgment 子集静态自查

动 delta 之前先做一遍静态自查。机械子集（frontmatter 引号 / 必备字段 / 死链）已由
`scripts/skill-lint.sh` 覆盖——跑它，别手检。这里只查 lint 查不了的 **judgment 子集**：

- [ ] **自相矛盾**——同一概念在文内是否两种口径（Finding #9：`wip_limit` 在 board.md
      里 pinned vs flexible 前后打架，处置 = 统一口径）。
- [ ] **与 SSOT 漂移**——这段是否复述了别处的 SSOT 且口径已漂（红线 3 / Finding #7）。
- [ ] **prose-实现脱节**——描述的行为是否已与实现不符（Finding #28：把已 live 的 hook
      标作 TODO）。

自查逮到的矛盾**本身就是合法证物**（文内失败，可直接锚 delta）；什么都没逮到、也没有
证物目录里的其它失败——那就没有改的理由。

### delta-only 的 Rationalization Table

| 借口 | 现实 |
|------|------|
| 「它臃肿 / 目录噪声多，整篇重写压缩、合并小节更干净。」 | 整篇重写是 context collapse 的头号入口，合并小节 / 砍行数是 brevity bias。冗余只删具体那几处重复（delta），臃肿靠下沉 `references/`——绝不重生成整个文件。 |
| 「我读完觉得这段啰嗦 / 能更好，所以改了它。」 | 审美判断不是证据。没有具体失败证物 = 没有改的理由，哪怕你「觉得」更好——强模型尤其会诚实地「觉得」然后照改（见 baseline）。 |

### 演化闭环总览（pointer-only 地图）

skill prose 的演化是一个闭环；本节只给地图 + 每步的落地处，不复述任何一步：

1. **证据 artifact**——锚定一个具体失败 → 本文铁律段「合法的 RED 证物目录」。
2. **反思**——从证物里抄录出要堵的那条合理化 → 本文循环（RED→GREEN→REFACTOR）+
   `references/pressure-testing.md`。
3. **delta**——条目级增删改，绝不整篇重写 → 本节。
4. **eval / 定性门**——改前后量一遍（通道死时降级定性）→ `grounding-skill-evals`
   `references/track-ab-discipline.md` §7。
5. **成败双向蒸馏**——成功与失败同权回流台账 + skill → AGENTS.md §9 +
   `references/pressure-testing.md` §6（回填）。

---

## Pointers

- **`references/craft-axis-diagnosis.md`** — 写 body 前的 craft 两轴诊断：
  process-control 轴 5 题 + cognitive-override 轴 5 题（每题带 yes-trigger 例子）
  + 4 象限决策表（强强→Craft C / 强弱→Craft A / 弱强→Craft B / 弱弱→拒绝建）。
- **`references/body-content-types.md`** — body 只装的 4 类内容（触发 / 命名锚 /
  流程骨架 / 硬约束）+ 4 层写作分配表（SKILL.md / references / scripts /
  templates 各装什么）+ progressive-disclosure 阈值（≤500 行 / ≥100 行拆
  reference / 一层深 / no orphan）。
- **`references/pressure-testing.md`** — 完整配方：三压场景模板、固定的 real-scenario
  prompt 脚手架、逐字捕获合理化、GREEN 守不住时的 meta-testing、以及回填目标 skill 的
  Rationalization Table / Red Flags。
- **`superpowers:test-driven-development`** — 本 skill 所仿照的 RED-GREEN-REFACTOR 循环和
  铁律。REQUIRED background。
- **`superpowers:writing-skills`** — 通用的（非 cc-master）skill-authoring 纪律、TDD↔skill
  映射表、subagent 测试方法论。
- **`skill-creator`** — Anthropic 官方的 skill，用来 scaffold 一个 skill、优化 `description`、
  跑 eval。用它来*创建文件并跑 Track A/B*；用**本** skill 来知道*你究竟在什么时候才被允许写
  纪律 prose*（压力 baseline 闸）。
- **`design_docs/eval/README.md`** + **`design_docs/eval/track-b-benchmark.md`** — 定量的那一半
  （Track A 触发准确率、Track B 行为 benchmark）。
- **`.claude/skills/grounding-skill-evals/references/track-ab-discipline.md` §7** — 演化频率
  分层（评估成本定节奏）+ git 谱系 / 回滚安全网。本文 delta-only 管「怎么改」，那里管
  「改多快 + 怎么回退」。
- **`AGENTS.md` §6** — 仓库层面的 skill 创作/维护纪律（两 skill 不重叠、YAML 引号反模式、
  content-contract 指针）。

---

## Red Flags — STOP，你跳过了 baseline

- 正打算写一条纪律规则，而你**没有为它捕获到任何失败**。
- 「我晚点再 baseline / 等草稿写完再说。」
- 「我已经知道 agent 会怎么合理化。」
- 加一行你**编出来**而不是抄录下来的 Rationalization Table。
- 改一段纪律段落的措辞却不重跑场景。
- 「这只是一个小措辞改动，铁律在这里不太适用。」
- 把一个绿的 Track-A eval 当成 *body* 有效的证明（它只测触发器）。
- 准备写 body 第一行了，却没先跑 craft 两轴诊断（默认就会写成编号清单）。
- 「这个 skill 太明显，跳过诊断 / 跳过 baseline」——最明显的恰是最容易写错形状的。
- 诊断落进 (弱,弱) 象限了，却还想「先写出来看看」——弱弱象限是拒绝建，不是写出来。
- 你正要重新生成整个 skill 文件 / 把 N 个小节并成更少 / 以「更精炼」为由大幅砍行——
  那是 context collapse / brevity bias 的入口，停，回到条目级 delta。
- 改 prose 的全部理由是「我读完觉得它臃肿 / 能更好」——证物目录里锚不出任何一个具体
  失败。

**所有这些都意味着：停。先把压力 baseline 跑过一个 subagent。再写。** craft 诊断同理——
写 body 前先跑两轴，定下形状再落笔。
