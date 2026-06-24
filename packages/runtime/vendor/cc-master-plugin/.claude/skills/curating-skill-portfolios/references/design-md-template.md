# DESIGN.md 模板 —— 6 段设计宪法

> 这是 SKILL.md「DESIGN.md 设计宪法」一节的展开。每个站得住的 skill（过了 scoresheet 3 必维）配一份 DESIGN.md，回答「这 skill 是什么 / 为什么」。**设计先于实现**——任何对 SKILL.md 的实质改动，先在 DESIGN.md 更新对应段，再动正文。
>
> 完整 10 段的 DESIGN（含 pipe protocol / context manifest / companion tooling / neighbour graph 等跨宿主治理段）对本仓 overkill；cc-master 是 2+4 的小 portfolio（2 个分发 + 4 个 dev-only），裁到 6 段——只保留对「判断这个 skill 站不站得住、边界清不清、会不会随模型演化退役」真正承重的部分。

## Contents

- [为什么是 DESIGN.md 而不是写进 SKILL.md](#为什么是-designmd-而不是写进-skillmd)
- [6 段模板（可直接复制）](#6-段模板可直接复制)
- [逐段填写指引](#逐段填写指引)
- [DESIGN.md vs OBJECTIVE.md vs SKILL.md 的分工](#designmd-vs-objectivemd-vs-skillmd-的分工)
- [反模式 —— DESIGN.md 写成什么样就废了](#反模式--designmd-写成什么样就废了)

---

## 为什么是 DESIGN.md 而不是写进 SKILL.md

SKILL.md 是 **runtime 手册**——agent 在干活时读它，要瘦、要可扫、只装触发 / 锚 / 流程 / 硬约束（见 `cc-master-skillsmith` 的 4 类 body 内容）。SKILL.md 回答「**怎么用**」。

DESIGN.md 是 **设计宪法**——维护者在改这个 skill 前读它，回答「**这 skill 是什么 / 为什么 / 边界在哪 / 何时该退役**」。这些是**设计意图**，不是 runtime 指令；塞进 SKILL.md 会让那篇本该瘦的 runtime 手册变胖，还把「设计为什么这么定」和「现在该怎么做」混在一起。

两者分开的收益：改 skill 前先在 DESIGN.md 把设计意图更新清楚（一次思考），SKILL.md 只承接「怎么用」的落地（一次执行）。DESIGN.md 改动留下设计演化的痕迹，SKILL.md 留下行为契约的痕迹——各自单一真相源。

---

## 6 段模板（可直接复制）

把下面整段复制到新 skill 目录的 `DESIGN.md`，逐段填实。`<...>` 是待填占位。

```markdown
# <skill-name> — 设计宪法（DESIGN.md）

> 本文回答「这 skill 是什么 / 为什么」。「怎么用」在 SKILL.md；「成功 = 什么」在 OBJECTIVE.md。
> 设计先于实现——任何对 SKILL.md 的实质改动，先在此更新对应段。

## 1. One-liner

<≤160 字的一句话：这 skill 在什么触发瞬间、给 agent 提供什么本质效应（增量 / 覆写）。
能贴在 PR 描述顶部、能被邻居 skill 的边界表引用的那种密度。>

## 2. Craft 自分类

- **Craft**：<A 机械配方 | B 心智模型 | C 纪律级>（由 cc-master-skillsmith 的 craft 两轴诊断定）
- **process-control 轴**：<弱 / 强，一句话理由>
- **cognitive-override 轴**：<弱 / 强，一句话理由>
- **形状蕴含**：<这个 craft 决定 SKILL.md body 该长什么形状——命名锚为主 / 编号步骤为主 / 锚+流程+硬规则 backstop>

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品 / portfolio 而言

<在 cc-master 的 skill 版图里补哪个洞？不引入它，portfolio 会缺什么？
能不能被现有 skill 完全覆盖——若能，为什么仍独立成 skill？>

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

<在哪一类决策瞬间，提供哪种确定性（步骤模板 / 心智模型 / 速查表 / 抗压纪律 / 架构判据）？
agent 不用它会怎样地做差——退化模式具体长什么样？>

### 3.3 Human 视角 —— 对最终落地的维护者而言

<维护者在什么场景因这 skill 的存在得到什么具体、可观察的好处？
用了它和没用它的产出，维护者能不能区分出来？>

## 4. 责任边界

### 4.1 IN scope

<单一职责方向，一句话能概括（对应 scoresheet 的 D2 bounded-context）。bullets 是这方向的具体展开。>

- <...>
- <...>

### 4.2 OUT of scope（明确移交给谁）

| 关切 | 移交给 |
|------|--------|
| <落在边界外的关切 1> | `<邻居 skill>` |
| <落在边界外的关切 2> | `<邻居 skill>` |

### 4.3 Boundary heuristic（一句话判定法）

<读者拿到一个边缘场景，靠这一句话能立刻判断属于本 skill 还是邻居 skill。>

## 5. 触发与反例

### 5.1 Recognition cues（应当被触发的信号）

- <症状 1>
- <症状 2>

### 5.2 Counter-examples（明确不该被触发的反例）

- <反例 1 → 该去哪个 skill / 该怎么做>
- <反例 2 → ...>

### 5.3 Pre-flight gate（硬门，任一不满足就 STOP）

- (i) <前置条件 1>
- (ii) <前置条件 2>

## 6. 演化锚

- **Lifecycle class**：<scaffolding（补当前模型弱点，更强模型出现即重审）| methodology（编码一条更强模型执行得更好的纪律，随工程实践本身存续）>
- **Sunset trigger**（仅 scaffolding 类需要）：<什么条件出现时这 skill 该退役 / 折进别处；methodology 类写「不适用」>
- **Fitness 不变量 → 可跑 probe**：<这 skill 承诺的架构不变量，各自映射到一个可验证的检查>
  - <不变量 1> → <怎么验（run-tests.sh 的哪段 / 红线 grep / pressure baseline）>
  - <不变量 2> → <...>
- **Cross-major review owner**：<谁在模型大版本时复盘这 skill 的存废——通常是 curating-skill-portfolios>
```

---

## 逐段填写指引

### § 1 One-liner

**严格 ≤160 字。** 不是 description（那是 frontmatter 里给 router 读的触发器），而是给人读的「这 skill 一句话是什么」。密度要够到能直接贴 PR 顶部。包含两个要素：**触发瞬间** + **本质效应**（增量给什么 / 覆写纠什么）。写不出一句话 = 这 skill 的定位还没想清楚，回 scoresheet 重审。

### § 2 Craft 自分类

直接抄 `cc-master-skillsmith` 的 craft 两轴诊断结论。这一段是 **DESIGN.md 和 skillsmith 的接缝**：curating 判「要不要建」，skillsmith 判「建出来该长什么形状」，DESIGN.md 的 §2 把后者的结论钉在案，让维护者改 body 前先知道目标形状。**curating 自己不做 craft 诊断**（那是 skillsmith 的领地），只在 DESIGN.md 留一格转录结论。

### § 3 Value triad

三视角缺一不可，每个视角回答一个不同的问题：

- **Plugin 视角**回答「portfolio 完整性」——这是 scoresheet D3 Probe 的另一种问法。若这里写不出「不引入它 portfolio 会缺什么」，大概率 Probe 没过，回去重判。
- **Agent 视角**回答「runtime 价值」——直接对应 Probe A/B 跑出的 strong 形态。「提供哪种确定性」就是 Probe A 给的增量；「不用它会怎样做差」就是 Probe B 覆写的那个默认失败。
- **Human 视角**回答「可观察收益」——维护者能不能区分用了/没用。区分不出 = 这 skill 可能是装饰（Weak+Weak），回 Probe。

三视角是 **Probe 结论的三面投影**，不是新判断。写 triad 时若发现和 Probe 结论对不上，是 Probe 之前没认真跑——回去补。

### § 4 责任边界

对应 scoresheet D2（bounded-context）+ 重叠检测。OUT-of-scope 移交表的每一行，应该和这个 skill 的 `description` 里的 `Do NOT use …` 反例一一对应——DESIGN.md 的边界表是 description 反例对子的设计依据。boundary heuristic 那一句是边界的「速判公式」，要能判边缘场景，不能是「看情况」这种废话。

### § 5 触发与反例

Recognition cues 写**症状**（agent / 维护者会怎么描述这个处境），不写 workflow。Counter-examples 是边界的反面，每条要指明「该去哪」。Pre-flight gate 是硬门——任一不满足就 STOP 并把缺口反馈上游，不是「尽量满足」。这一段是 description 触发逻辑的设计来源：先在 DESIGN.md 想清触发/反例，再凝练成 frontmatter 的 `Use when / Do NOT use` 对子。

### § 6 演化锚

这一段是 lifecycle 的「Bitter Lesson 两面」思想在此的轻量落地：

- **scaffolding**（脚手架）：补当前模型的弱点，寿命 ≈ 到下一个更强模型出现。必须写 sunset trigger——什么条件下它该退役。
- **methodology**（方法论）：编码一条更强模型会执行得**更好**而非更少的纪律（TDD、debugging、可审计协议都是）。寿命 ≈ 工程实践本身，带「存续推定」。

cc-master 的 meta-skill 三件套**全是 methodology 类**——它们编码的是「怎么严谨地造 / 准入 / 度量 skill」，模型越强越该严格执行，不会因模型变强而过时。Fitness 不变量映射到可跑 probe 是关键：每条架构承诺别只当口号，要指明怎么验（`run-tests.sh` 的哪段、哪条红线 grep、哪个 pressure baseline）。

---

## DESIGN.md vs OBJECTIVE.md vs SKILL.md 的分工

三份文件**职责严格分开**，别在它们之间复述同一份内容：

| 文件 | 回答 | 谁读 | 谁是方法论权威 |
|---|---|---|---|
| **SKILL.md** | 怎么用（runtime 手册） | 干活的 agent | `cc-master-skillsmith`（body 怎么写） |
| **DESIGN.md** | 是什么 / 为什么 / 边界 / 演化 | 改这 skill 的维护者 | **本 skill（curating）的 §DESIGN.md 模板** |
| **OBJECTIVE.md** | 成功 = 什么（可度量契约） | 跑 eval 的人 / 迭代者 | `grounding-skill-evals`（J 怎么声明） |

**curating 是 DESIGN.md 的方法论权威，但不是 OBJECTIVE.md 的。** OBJECTIVE.md 的 schema 和怎么声明 J，归 `grounding-skill-evals`。curating 给每个 skill 写 DESIGN.md 时会**引用** OBJECTIVE.md 的 J（§3 value triad 要和 J_top 自洽），但 J 的方法论权威在 grounding，不在这里。两者接缝：DESIGN.md §3.2 的「不用它会怎样做差」应该和 OBJECTIVE.md 的 `without_skill_floor` 说的是同一件事，只是一个写在设计意图里、一个写在度量契约里。

---

## 反模式 —— DESIGN.md 写成什么样就废了

| 反模式 | 为什么废 / 怎么改 |
|---|---|
| 把 SKILL.md 的 runtime 步骤抄进 DESIGN.md | DESIGN.md 是设计意图不是操作手册。重复 = 两处真相源，改一处忘一处。只写「为什么这么设计」，不写「怎么操作」。 |
| §3 value triad 三视角写得一样 | 三视角是三个**不同**的问题（portfolio / runtime / 可观察收益）。写得一样 = 没真想清楚价值在哪，大概率 Probe 没认真跑。 |
| §6 fitness 不变量写成口号（「保持高质量」） | 不变量必须映射到**可跑的检查**。映射不出检查的「不变量」是装饰句，删掉。 |
| boundary heuristic 写成「看情况」 | 那不是 heuristic。要能让读者拿一个边缘场景立刻判属于本 skill 还是邻居。判不了就重写。 |
| §6 把 methodology 类硬写 sunset trigger | methodology 类带存续推定，sunset trigger 写「不适用」。硬编一个假的退役条件 = 误导未来的 cross-major 复盘。 |
| DESIGN.md 写完就不再维护 | DESIGN.md 是宪法不是一次性文档。**设计先于实现**——下次改 SKILL.md 实质行为前，先回来更新对应段。 |
