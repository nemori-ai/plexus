# cc-master-skillsmith — 设计宪法（DESIGN.md）

> 本文件回答「本 skill 是什么 / 为什么 / 边界在哪」。**成功怎么度量**在
> [`OBJECTIVE.md`](OBJECTIVE.md)（J_top + baseline + strict 维）；**运行时行为**在
> [`SKILL.md`](SKILL.md)。设计先于实现——任何对 `SKILL.md` 纪律段的实质改动，
> 先在此处更新设计再动 prose。
>
> 这是 6 段精简版 DESIGN 模板——砍掉了与纯 prose、dev-only skill 无关的协议 / 配置 /
> 配套工具 / 邻接图谱等段（对一个不消费 config、不挂 hook、纯 prose 的 dev skill 是
> overkill），只留对「判断这个 skill 站不站得住」承重的部分。

---

## 1. One-liner

造或改**一个** cc-master skill 的 body 时用——先跑 craft 两轴诊断定形状，再按
TDD-for-skills（failing pressure baseline 先于 discipline prose）落笔与堵漏。关注
「这一个怎么写好」，不管「要不要建」与「怎么度量」。

---

## 2. craft 自分类

- **Layer：** dev-only meta-skill（住 `.claude/skills/`，**不**随插件分发；终端用户装 cc-master 看不到它）。
- **Craft：** **Craft C 纪律级（强 process × 强 cognitive）**——见 SKILL.md「craft 诊断」节与
  [`references/craft-axis-diagnosis.md`](references/craft-axis-diagnosis.md) 的 skillsmith 自诊断
  worked example：process 4/5、cognitive 5/5。它对自己用纪律级 craft 是元 dogfood——教 craft
  选型的 skill 必须按它自己诊断出的 craft 来写。
- **Type：** discipline（纪律级）——规则在压力下能被合理化，故配 Iron Law + Rationalization 表 + Red Flags + 「违背字面=违背精神」。
- **Mode：** agentic（贡献者 / agent 调用，无 user-facing slash command）。
- **Lifecycle class：** methodology（方法论类，非 scaffolding；不随某次迁移退役）。
- **路由含义：** 纪律级 → SKILL.md 取最强 stance（祈使 + 硬门 + 抗合理化），命名锚在前、流程骨架在后、硬规则 backstop。

---

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品而言

补的洞：cc-master 此前只有**定性**的 pressure baseline（看 agent 在没有某段时选错），却没有
**「写 body 前先定 craft 形状」**这一步。skillsmith 把两件正交的事都钉死：body 的**形**（craft
诊断）与 body 的**质**（Iron Law gate）。没有它，纪律型 skill 会被凭手感写成编号清单，形状错配
要等真 session 跑出来才暴露，那时已整篇重写。它不能被 `orchestrating-to-completion` /
`authoring-workflows` 覆盖——那两个是**分发**的产品 skill（orchestrator 做什么 / workflow 脚本
怎么写），skillsmith 是**造 skill 的工具**，受众与 lifecycle 都不同。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在「我要给本仓写或改一个 skill 的 body」这个决策瞬间，提供两种确定性：
（1）**craft 选型的判别框架**——两轴 10 题 → 4 象限 → 该写成机械配方 / 心智模型 / 纪律级，
而不是默认落进「Step 1/2/3」；（2）**抗压纪律**——没看 agent 失败就别写 discipline prose，
Rationalization 表里每一行都是真实 baseline 的转录而非凭空想象。

不用它会怎样退化（具体）：默认 agent 把一个本该靠**命名心智锚**承重的方法论写成一串编号步骤
（形状错配），且在 time / sunk-cost 压力下当场把纪律段合理化跳过（「这次太明显，不用先看 agent
失败」），写出一行没有 baseline 支撑的 Rationalization 行——那是谎报。

### 3.3 Human user 视角 —— 对贡献者 / 维护者而言

贡献者得到一个可观察的差别：用了它产出的 skill，body 形状与诊断出的 craft 一致（命名锚段重而
流程段薄 = B/C，编号祈使主导而无锚段 = A），且每条纪律规则都能指回一次真实的失败 baseline；
没用它产出的 skill 多半是「读着像配方但实则要靠判断」的形状错配体，维护时谁也说不清它到底
在堵哪条合理化。

---

## 4. 责任边界（IN / OUT）

### 4.1 IN scope

单一能力方向：**单个 skill 的 body 怎么写好**。具体展开——

- 写 body 前的 **craft 两轴诊断**（process-control × cognitive-override → 4 象限）。
- body 只装的 **4 类内容**（触发 / 命名锚 / 流程骨架 / 硬约束）+ 4 层写作分配 + progressive-disclosure 阈值。
- **TDD-for-skills**：failing pressure baseline 先于任何 discipline prose；三压配方；Rationalization 表 / Red Flags 的回填。
- frontmatter YAML 单引号整包（Finding #1）等本仓 body-level 写作纪律。

### 4.2 OUT of scope（明确移交给谁——这就是红线 3「两 skill 不重叠」的可操作判据）

| 关切 | 移交给 |
|------|--------|
| 要不要新建一个 skill / 这个该是 skill 还是 reference / 一组 skill 的边界与重叠 / 重构准入 | `curating-skill-portfolios`（Probe A/B + 裁剪七维 + DESIGN 宪法） |
| 声明 J / 跑 Track A·B eval / 防过拟合·防自欺 / 给 skill 写 OBJECTIVE | `grounding-skill-evals`（轻量 J + 接现有三脚本 + holdout/predict） |

> **Do-NOT（抗越界）：** skillsmith **绝不**回答「要不要建」与「怎么度量」。一旦你在 skillsmith
> 里开始论证某个 skill 该不该存在、或某次 description 改动 accuracy 涨没涨——停。那是 curating /
> grounding 的领地。三者触发时机正交（写 body / 判准入 / 度量），跨界即复述、即制造重叠，
> 正是红线 3 要拦的。

### 4.3 Boundary heuristic（一句话判定法）

**问的是「这一行 body 该长什么形状、该不该现在写」→ skillsmith；问「这个 skill 该不该存在」
→ curating；问「它有没有真的变好」→ grounding。**

---

## 5. 触发与反例

### 5.1 Recognition cues（应被触发的信号）

- 要新建 / 修改 / 审查**本仓**一个 skill 的 body——尤其纪律型（其规则 agent 在压力下能合理化绕过）。
- 要给某 skill 加 Rationalization Table / Red Flags / 决策程序，或改 SKILL.md 的纪律段 / description。
- 你发现自己**正要写 skill prose，却还没看过一个 agent 在没有它时失败**。

### 5.2 Counter-examples（明确不该被触发的反例）

- 在权衡「要不要建这个 skill / 它该是 skill 还是某 skill 的 reference」——是 `curating-skill-portfolios`。
- 在声明 J、跑触发准确率 / 行为 benchmark、判断改动有没有过拟合——是 `grounding-skill-evals`。
- 在写**分发**的产品 skill 的运行时方法论本身（orchestrator 做什么 / workflow 脚本怎么写）——
  那是 `orchestrating-to-completion` / `authoring-workflows` 的正文，不是「怎么造 skill」。
- 纯机械可校验的约束（regex / `plugin validate` / 测试能拦的）——自动化它，别写成纪律去 baseline。

### 5.3 Pre-flight gate（硬门）

- (i) 改动落在**单个 skill 的 body**，而非 portfolio 准入或 eval 度量（否则路由到 sibling）。
- (ii) 若改的是 discipline-bearing prose——**先有一次捕到的真实 failing baseline** 在手（Iron Law）。

任何不满足 → STOP：路由到正确的 sibling，或先去跑 baseline。

---

## 6. 演化锚

- **Lifecycle class：** methodology（方法论类——只要 cc-master 还在演化自己的 skill 就一直在用，不随某次迁移退役）。
- **Sunset trigger：** 仅当本仓不再自维护 skill（极不可能），或 craft 诊断 / TDD-for-skills 被某个更强的上游 meta 完全吸收时。
- **Fitness 不变量（映射可跑 probe）：**
  - *craft 形状一致性* —— body 形状匹配诊断出的 craft（OBJECTIVE strict 维之一）；probe = 对照
    [`references/craft-axis-diagnosis.md`](references/craft-axis-diagnosis.md) 的形状错配自检。
  - *Iron-Law-gate 存在性* —— 「无 failing baseline 不改 discipline prose」的硬门常驻
    （OBJECTIVE strict 维之二）；probe = §8 Track B benchmark + 每条 Rationalization 行可指回一次真实 baseline。
  - *分发洁净* —— 始终住 `.claude/skills/`，不进分发 `skills/`、不进 marketplace；probe = `claude plugin validate .` 不应看见它。
- **Cross-major review owner：** `curating-skill-portfolios`（它持有 portfolio 准入与重叠判据，
  本 skill 的边界是否仍与 sibling 正交由它复盘）。
