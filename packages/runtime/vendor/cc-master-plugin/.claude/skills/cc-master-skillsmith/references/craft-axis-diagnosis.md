# craft 两轴诊断 —— 写 body 前先定 craft

**何时读：** 你要写或重构一个 cc-master skill 的 body，在落第一行之前。这是
SKILL.md「写 body 前先跑 craft 两轴诊断」那一节的展开——SKILL.md 说*何时*与
*为何*，本文给*怎么诊断*（两轴 10 题 + 4 象限决策表）。

## Contents

- [为什么诊断必须先于写](#为什么诊断必须先于写)
- [两条独立的轴](#两条独立的轴)
- [process-control 轴 —— 5 题](#process-control-轴--5-题)
- [cognitive-override 轴 —— 5 题](#cognitive-override-轴--5-题)
- [4 象限决策表](#4-象限决策表)
- [(弱,弱) 反模式：拒绝建](#弱弱-反模式拒绝建)
- [边界情形（某轴 = 2）](#边界情形某轴--2)
- [worked example —— skillsmith 自诊断](#worked-example--skillsmith-自诊断)
- [诊断之后读什么](#诊断之后读什么)

---

## 为什么诊断必须先于写

跳过诊断的作者默认会写成编号步骤——「Step 1 做 X、Step 2 做 Y、Step 3 验证
Z」——因为那是模型见得最多的形状。这个默认只贴合两轴的一个极端（process 强
× cognitive 弱）。真正住在网格别处的 skill 一旦这么写，要等到 baseline 跑出
形状不对才发现，那时往往已经迭代了好几轮、烧了 dogfood 周期、留下一条让人
困惑的维护痕迹。

cc-master 自己踩过这条坑的同构版：一个本该靠**命名心智锚**承重的方法论，
先被写成一串编号清单，跑了真 session 才发现它的价值在锚不在步序，只能整篇
回炉。**诊断本身就是预防。** 开编辑器前先跑它。

---

## 两条独立的轴

每个 skill 同时坐落在两条轴上，且两轴**互相独立**——一轴强不说明另一轴的
任何事。两轴张成的 4 象限映射到不同的 **craft（写法）**。

**process-control 轴** —— 这个 skill 把 agent 的行为锁进确定性轨道的强度。

- 强：有序步骤、序列敏感、决策门、硬规则、red flags。跳步或换序破坏正确性。
- 弱：松散流程、步骤可换序、「往这个方向走，路自己挑」。

**cognitive-override 轴** —— 这个 skill 教 agent 一套**逆其默认 prior** 的判断
框架 / 心智锚 / 决策原则的强度。

- 强：命名心智锚（「先复现再修」「看 substrate 不看 surface」「must-fail 纪律」）。
  显式覆写模型训练分布里的 prior。要在新场景里重新应用，不只是重放步骤。
- 弱：不需要哲学。具体方法 + 模型 prior 就足够执行。

两轴不互相替代。纪律级 skill 两轴都要强；reference 级 skill（查表）两轴都不要。
多数有用 skill 落在中间——落在哪决定了写法。

---

## process-control 轴 —— 5 题

每题答 yes/no，yes +1（0–5）。≥3=strong，1–2=mid，0=weak。

| # | 问题 | yes-trigger 例子 |
| --- | --- | --- |
| **Q1** | **可复现性需求** —— 每次运行是否需要 shape 一致的输出？ | 红-绿-重构必须按这个序跑；board 续接每次读同一组 narrow-waist 字段；eval 必须按同序走 case。 |
| **Q2** | **序列敏感** —— 跳步或换序是否破坏正确性？ | 鉴权必须先 verify 再 authorise；schema 迁移不能 N+1→N；先 init 再 migrate 不能反。 |
| **Q3** | **集成契约** —— 下游消费方是否读一份 schema-bound 输出？ | board 的 narrow waist 被 hook 读；codex verdict JSON 被 Joiner 闸读；spec-diff 被优化器读。 |
| **Q4** | **错误代价** —— 一步走错的代价是否高到难以或无法恢复？ | 破坏性文件操作；merge / 生产部署；不可逆的对外动作。 |
| **Q5** | **多 actor 协议** —— 这个流程是否是别方依赖的跨 actor 契约？ | 多个后台 agent 依赖同一份 board 契约；codex 第二验收者依赖 diff 已读；多 agent hand-off。 |

process 分高 = **body 必须把协议本身编码进去**：编号步骤、决策门、硬规则、
red flags。agent 对步骤的遵守就是这个 skill 的主要价值。

---

## cognitive-override 轴 —— 5 题

每题答 yes/no，yes +1（0–5）。≥3=strong，1–2=mid，0=weak。

| # | 问题 | yes-trigger 例子 |
| --- | --- | --- |
| **Q1** | **反直觉** —— 这个 skill 是否逆模型的默认行为？ | 测试先行逆「先实现」的 prior；复现再修逆「立刻打补丁」；「指挥不演奏」逆「我顺手做了更快」。 |
| **Q2** | **判断需求** —— 成功是否要在上下文里权衡取舍，而非照菜谱？ | 架构决策；brainstorming 要「先探 2–3 条路再定」；在几个竞争心智锚里选一个。 |
| **Q3** | **substrate 引用** —— 成功是否靠引用某个机制 / 原则，而非照执行一个步骤？ | 锚在内部机制（substrate-vs-surface）而非表面标签；锚在判别原则（must-fail 纪律）而非步数。 |
| **Q4** | **抗压** —— agent 是否必须在压力（deadline / 「就这一次」/ 「一次性例外」）下仍合规？ | 测试先行的「永不跳测试」；验收前置的「永不静默跳过」；「指挥不演奏」在 deadline 下仍 dispatch。 |
| **Q5** | **泛化** —— agent 是否必须把这个 skill 迁移到训练分布外的场景？ | 心智模型类 skill 要跨语言 / 领域 / 代码库工作；debugging 方法论要迁移到没见过的栈。 |

cognitive 分高 = **body 必须把心智模型编码进去**：命名锚、为何反直觉的解释、
抗压语言、before/after 框架。agent 对模型的内化（而非对步骤的重放）就是这个
skill 的主要价值。

---

## 4 象限决策表

把 (process_score, cognitive_score) 点落进网格。≥3=strong，<3=weak。

| | cognitive 弱（<3） | cognitive 强（≥3） |
|---|---|---|
| **process 强（≥3）** | **Craft A —— 机械配方**：祈使语气 + 编号步骤 + 决策表 + 硬规则 + 验证门 + 每步自检。无命名锚、无哲学叙事。 | **Craft C —— 纪律级**：命名锚在前（substrate）+ 流程步骤在后（surface）+ 硬规则 backstop（扛住每一种合理化压力的红线）+ 一句「为何不可妥协」把硬规则锚回心智模型。 |
| **process 弱（<3）** | **(弱,弱) 反模式**：拒绝建。折进别的 skill / 强化一轴 / 重审 scope。 | **Craft B —— 心智模型**：命名锚为主（每个 5–15 行）+ before/after 对比 + 陷阱表 + why 解释 + 叙事流程 + 抗合理化。无祈使步骤、无编号清单。 |

决策规则：

- (process ≥3, cognitive ≥3) → **Craft C 纪律级**。
- (process ≥3, cognitive <3) → **Craft A 机械配方**。
- (process <3, cognitive ≥3) → **Craft B 心智模型**。
- (process <3, cognitive <3) → **反模式**；拒绝继续；重审 scope（见下节）。

落定 craft 后，body 怎么按这个形状装四类内容、4 层怎么分配，读
[`body-content-types.md`](body-content-types.md)。

---

## (弱,弱) 反模式：拒绝建

两轴都 0–2 的 skill，既不给 agent 可操作步骤，**也不**教心智模型。它是
占位 prose：一个名字、一段 description、一段说不出任何模型自己 prior 产不出
的东西的 body。三条合法回应：

1. **重审 scope。** 这候选大概率是别的 skill 里的一段 reference（一节、一张表、
   一个 worked example），不是独立 skill。折进去。
2. **强化一轴。** 加真的流程结构（决策门、schema-bound 输出、序列敏感）**或**
   加真的心智锚（agent 否则会错过的一条反直觉原则）。一轴够强就是真 skill。
3. **丢掉候选。** 不是每个有用的想法都值得一个 skill。薄 skill 的代价是永久
   的——一旦发布，它就永远和更密的 sibling 抢注意力。

诊断纪律禁止「先写出来看看」。弱弱 skill 一旦发布就是噪声：稀释 description
触发池、钝化 router 精度，逼着每个后来的维护者去 debug「这 skill 到底干嘛的」。

> **违背字面就是违背精神。** 「我知道它弱弱，但这次它真的有用」——如果真有用，
> 它必有一轴强；找出那一轴写进去，它就不再是弱弱。说不出强在哪轴，就是弱弱。

---

## 边界情形（某轴 = 2）

某轴落在 2（mid），偏向规则：

- 偏 **Craft B**，若 skill 偏推理（agent 要论证、要权衡、要引用原则）。
- 偏 **Craft A**，若 skill 偏步骤（agent 要排序、要验证、要过门）。

拿不准时：用选定的 craft 写出骨架，写完第一个 reference 后重新诊断——若骨架
读着别扭，边界判断要反过来。

---

## worked example —— skillsmith 自诊断

skillsmith 自己是个好测试用例，因为答案已知：纪律级（强 × 强）。走一遍 rubric
印证为何。

**process-control 轴：**

| # | 答 | 理由 |
| --- | --- | --- |
| Q1 可复现性 | yes | RED→GREEN→REFACTOR 必须按这个序跑，换序破坏 baseline-先于-写的因果。 |
| Q2 序列敏感 | yes | 先 baseline 后写 prose；颠倒就是「写后补测」，正是 Iron Law 禁的。 |
| Q3 集成契约 | partial→yes | 捕到的 verbatim 借口要回填进目标 skill 的 Rationalization Table（schema-shaped 双列）。 |
| Q4 错误代价 | partial→yes | 写错形状（craft 错判）= 整篇重写；纪律段没堵住 = 红线在真 session 被合理化绕过。 |
| Q5 多 actor 协议 | no | skillsmith 是单作者工具，不跨 actor 投影。 |

≈ 4/5 —— process 强。

**cognitive-override 轴：**

| # | 答 | 理由 |
| --- | --- | --- |
| Q1 反直觉 | yes | 「没看 agent 失败就别写 prose」逆「我知道它们会说什么直接写堵漏」的 prior。 |
| Q2 判断需求 | yes | 判一段编辑是 discipline 还是 reference、判 craft 落哪象限，都是权衡不是照菜谱。 |
| Q3 substrate 引用 | yes | 教的是 craft 原则（baseline-先于-写、形状匹配 craft），是机制不是步数。 |
| Q4 抗压 | yes | 要扛住「deadline 紧，直接写 8 条编号步骤 ship」的诱惑。 |
| Q5 泛化 | yes | craft 原则要跨 skill 类型、跨纪律 / 心智 / reference 迁移。 |

5/5 —— cognitive 强。

**结论。** (4,5) → 强 × 强 → Craft C 纪律级。skillsmith 必须对自己用纪律级
craft（命名锚在前、流程步骤在后、硬规则锚回锚）——这是元 dogfood：教 craft
选型的 skill 必须按它自己诊断出的 craft 来写。

---

## 诊断之后读什么

(process_score, cognitive_score) 定了、craft 选了，下一份要读的是该 craft 的
body 形状与 4 层分配——[`body-content-types.md`](body-content-types.md)：body 只
装四类内容（触发 / 命名锚 / 流程骨架 / 硬约束），各 craft 怎么填这四类，4 层
（SKILL.md / references / scripts / templates）各装什么，以及 progressive-
disclosure 的阈值（≤500 行、≥100 行拆 reference、一层深、no orphan）。

若诊断落进 (弱,弱) 反模式象限，**不要**进 body 写作——回到 scope 重审，折进
别的 skill 或丢掉。
