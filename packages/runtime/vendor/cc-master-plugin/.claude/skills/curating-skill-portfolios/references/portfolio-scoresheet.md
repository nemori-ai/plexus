# Portfolio scoresheet — 3 必维 + 重叠检测

> 这是 SKILL.md「cc-master 只用 3 条承重维」与「重叠检测」的展开。本仓 portfolio 小（2 个分发 + 4 个 dev-only），只用三条承重维（audience-plane / bounded-context / Probe）+ 重叠检测——任一承重维不过即拒，**无 trade-off 路径**。

## Contents

- [3 必维](#3-必维)
- [判定规则](#判定规则)
- [scoresheet 模板](#scoresheet-模板)
- [重叠检测](#重叠检测)
- [description 对子写法](#description-对子写法)

## 3 必维

### D1 — audience-plane（受众面）

**问题**：候选的受众是插件**用户**面（装 cc-master 的人 / 替他们行动的 agent），还是仓库**维护者**面？

**过条件**：受众必须明确落一面。只服务仓库维护者自身演进 / 治理 / 贡献流程的能力**不是** runtime 产品 skill。

**判错的后果**：把 dev 工具混进产品 = 终端用户装插件看到本不该看到的东西。

**落地映射**（cc-master 具体）：
- 维护者面 → 进 `.claude/skills/`（**不分发**，不进 marketplace）。meta-skill 三件套（skillsmith / curating / grounding）+ 它们发现层上游的 `requirement-elicitation` 全在此面。
- 用户面 → 进 `skills/`（随插件 ship）。现有 `orchestrating-to-completion` / `authoring-workflows` 在此面。

**评分**：二元 0/1。0 = 拒，无例外。

**证据要求**：一句话写出候选的调用模式——「当 [谁] 对 [什么] 做 X 时调用」。读起来是「维护者审 cc-master 自己的 skill 版图」= 维护者面；是「插件用户跑长 horizon 目标」= 用户面。

### D2 — bounded-context（单一职责）

**问题**：候选是否落入**恰好一个**清晰职责方向？

**过条件**：职责必须单一。跨两个职责方向的候选**不可准入**——它其实是两个 skill 穿了一件马甲，先拆。

**评分**：二元 0/1。0 = 阻塞，先做边界拆分。

**证据要求**：一句话命名它的单一职责；若怀疑跨界，写出它疑似横跨的两个职责，判断是不是该拆。

> cc-master 实例：skillsmith = 「单个 body 怎么写」；curating = 「一组 skill 的架构准入」；grounding = 「怎么度量」。三者职责正交，不跨界。若某候选同时做「写 body」又「判要不要建」，它跨了 skillsmith 和 curating 的界，拒，要么拆要么并入既有。

### D3 — Probe（增量 ∨ 覆写至少一强）

**问题**：候选过 Counterfactual Probe A/B 了吗？

**过条件**：A 或 B 至少一个 strong。两个都 weak = 装饰，拒。

**评分**：A / B 各 weak/strong；joint pass = `(A==strong) ∨ (B==strong)`。

**证据要求**：引用 `references/counterfactual-probe.md` 里跑出的 probe 评级 + 「没有这个 skill 默认 agent 会怎样」的 trace。挥手不算证据。

**这是三维里唯一 judgment-bearing 的一维**——D1/D2 基本是结构判断，D3 能被「这信息挺有用就算 strong 吧」合理化。所以 D3 评分**必须**先读 counterfactual-probe reference 的 worked examples，按那里的 strong/weak 信号打分。

## 判定规则

| Verdict | 条件 |
|---|---|
| **准入（admit）** | D1=1 且 D2=1 且 D3 joint pass。 |
| **拒（reject）** | D3 两 probe 都 weak（装饰），或 D1 受众判错且无法重塑。 |
| **改做 reference** | D3 = 强增量 + 弱覆写（纯增量）——它该是某个现有 skill 的 `references/<topic>.md`，不是独立 skill。 |
| **先拆（decompose）** | D2 跨两职责——候选是两个 skill，先做边界拆分，拆出的片再各自过 scoresheet。 |

> **「装饰不建」「pure-augmentation 该是 reference」这两条是本 scoresheet 最常被绕过的判定。** 当你打算把一个 D3=强增量+弱覆写的候选硬建成独立 skill 时，停——它该是 reference。当你打算把一个 D3 两 probe 都 weak 的候选「为凑齐 / 为对仗」建出来时，停——它是装饰。**违背字面就是违背精神**：「我守的是 portfolio 完整的精神」是绕过这两条的那句合理化。

## scoresheet 模板

每个候选产出一份：

```
| 维 | 评分 | 证据（≥1 句） |
|---|---|---|
| D1 audience-plane    | 0/1                | <受众面 + 落 .claude/skills 还是 skills> |
| D2 bounded-context   | 0/1                | <单一职责 + 是否跨界> |
| D3 Probe A/B         | A:weak/strong B:weak/strong | <probe 评级 + 默认 agent trace> |
| Verdict              | admit/reject/做reference/先拆 | <一句话 rationale> |
```

## 重叠检测

**两个 skill 都过 Probe，但 Probe 答案相同 = overlap signature。** 重叠看的是它们对 agent 的**本质效应**撞没撞，不是 description 字面像不像。

检测流程：
1. 对两个疑似重叠的 skill 各跑 Probe A/B。
2. 看它们**哪个形态 strong**：A 的 A.1/A.2/A.3 哪个、B 的 B.1/B.2/B.3/B.4 哪个。
3. 若两个 skill strong 的形态**相同**（如都靠 B.1 倾向覆写、覆写的还是同一类默认失败）→ overlap，它们在抢同一类任务。
4. 若 strong 形态不同（一个靠 A.3 新路径、另一个靠 B.1 倾向覆写）→ 不重叠，正交。

**消解办法**：靠每个 skill 的 `description` 里的 `Use when … / Do NOT use …` 对子——每个 skill 显式声明自己的触发条件 + 把对方的领域写成反例。cc-master 红线 3「两 skill 不重叠」就是这条的产物。

> cc-master 实例：skillsmith 靠 B.1（agent 默认绕过 pressure baseline）；curating 靠 B.4 + A.3（agent 默认「有用就建」走错准入路径）；grounding 靠 B.2（agent 默认不去度量、out of mind）。三者 strong 形态各异 → 不重叠。

## description 对子写法

每个 skill 的 `description` 必须带这一对：

- **`Use when …` / `当…时`**：本 skill 的触发条件，写症状不写 workflow（见 `superpowers:writing-skills` 的 CSO 节）。
- **`Do NOT use …`**：把每个邻居 skill 的领域写成显式反例，并指明该去哪个 skill。

cc-master 三件套的对子（互为反例，消解重叠）：

| skill | Use when（触发） | Do NOT use（反例 → 去哪） |
|---|---|---|
| `cc-master-skillsmith` | 写 / 改 / 审一个 skill 的 body | 判要不要建 → curating；度量 → grounding |
| `curating-skill-portfolios` | 判要不要建 / skill vs reference / 重叠 | 写 body → skillsmith；度量 → grounding |
| `grounding-skill-evals` | 声明 J / 跑 Track A/B / 度量 | 写 body → skillsmith；判要不要建 → curating |

写对子时**整个 description 单引号整包**（Finding #1）——含 `:` 或 `"` 不包会被 YAML 误读，content 测试 / `plugin validate` 以非显然方式失败。
