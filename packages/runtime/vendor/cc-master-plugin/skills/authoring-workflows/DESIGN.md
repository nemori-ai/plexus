# authoring-workflows — 设计宪法（DESIGN.md）

> 本文回答「这 skill 是什么 / 为什么」。「怎么用」在 [`SKILL.md`](SKILL.md)；引擎契约 / pattern / example 在 [`references/`](references/) + [`assets/`](assets/)。
> 设计先于实现——任何对 SKILL.md 的实质改动，先在此更新对应段。
> 这是 cc-master **分发**的两个 skill 之一（住 `skills/`，随插件 ship）。

## 1. One-liner

在要调用 Workflow 工具、或写 / 调试 / 启动一个 Claude Code dynamic-workflow 脚本时调用——给 agent 引擎契约（determinism / resume / caps）+ 按 work 形状选范式（fan-out / pipeline / loop / scout）+「harness 是权威 validator，别自己重写 linter」的纪律。既增量（引擎规则 agent 先验不携带）又覆写（默认猜 API、不查 shape 就上 `parallel()`）。

## 2. Craft 自分类

- **Craft**：B 心智模型为主，带机械契约成分（honest-test + 范式决策树为命名锚主干，下沉一份随 harness 走的活契约）。
- **process-control 轴**：中——author flow（draft → 写到 harness 契约 → launch）有序但**非强序敏感**：跳步不会破坏正确性，写错了 harness 在 launch / runtime 自己抛错挡住。它不是序敏感的确定性流程（那是 orchestrating 的决策程序）。
- **cognitive-override 轴**：强——核心价值在覆写两条 model prior：「我已经懂这 API，猜就行」逆「写之前先查 `references/mechanism.md`」，「默认 pipeline 不是 parallel」逆「`parallel()` 代码更整齐就用它」（barrier 的 latency 是真的）。要在「我赶时间直接猜」压力下仍守住先查契约。
- **形状蕴含**：(中 process, 强 cognitive) → Craft B 为主。SKILL.md 以命名锚为主干（honest-test「你到底需不需要 workflow」+ 范式决策树 + reference index），配一份机械契约（meta 首语句 / 禁 `Date.now()` / thunk 不裸 promise / caps）作 backstop，深细节（7 primitive 语义、resume 规则、12 个 example）全下沉 `references/` + `assets/`。不写纯编号步骤——价值在 agent 内化「按形状选范式」的判断 + 「harness 即 endpoint」的纪律。

## 3. Value triad（三视角价值）

### 3.1 Plugin 视角 —— 对 cc-master 这个产品 / portfolio 而言

补「Workflow 这个原语怎么正确用」的洞——`orchestrating-to-completion` 把 workflow 列为三后台机制之一（shell / sub-agent / workflow），但只给「何时选它」的主线判断，**深 how 在这**。不引入它，插件用户面对 Workflow 工具只能猜引擎规则（determinism / resume / caps 是引擎实现细节，agent 先验不携带），launch 即栽在 `Date.now()` / 裸 promise / 超 caps。它**不能**被 `orchestrating-to-completion` 覆盖：那是主线指挥手册，假设「已决定用 workflow」；「脚本内部怎么写」是它之后的一层、属于单件乐器的演奏法。这是红线 3「两分发 skill 不重叠」的另一半。

### 3.2 Agent 视角 —— 对调用这个 skill 的 AI 而言

在 agent **伸手够 Workflow 工具的那一瞬间**，提供三样确定性：① honest-test（你到底需不需要 workflow——两行 bugfix 不该上五-agent panel）；② 按 work 形状选范式（独立全收 → fan-out / 多阶段流式 → pipeline / 未知数量 → loop / 不知 work-list → scout）；③ 权威引擎契约。不用它会怎样退化（具体）：① 猜 determinism / resume / caps 规则，写出 launch 即抛错的脚本；② 不查 shape 就默认上 `parallel()`（barrier latency 白付）；③ 手写一个冗余 static linter 去重新实现 harness 已做的校验（drift-prone，比真东西差）。

### 3.3 Human 视角 —— 对最终落地的用户 / 维护者而言

写出的 workflow 脚本**一次 launch 干净**——因为是写到 harness 自己的 validation 契约上的，而非栽在 `Date.now()` 破坏 resume、裸 promise 丢 barrier、超 caps 被拒、`meta` 不是首语句被 launch 校验挡下。用了它和没用它可观察区分：用了的脚本从某个 `assets/templates/` 或 `assets/examples/` 的 known-good 起点改出来、首次 launch 就过 harness 校验；没用的反复 relaunch、在引擎规则上来回试错烧时间。

## 4. 责任边界

### 4.1 IN scope

单一职责方向：**workflow 脚本怎么写 / 调试 / 启动**——单件乐器（workflow 这一机制）的脚本写法。

- honest-test：判这活到底需不需要 workflow（否则单 sub-agent 就够）。
- 按 shape 选范式：fan-out / pipeline（默认）/ loop-until-{budget,dry} / scout-then-fanout，及其复合形态。
- 写到 harness 契约：`meta` 首语句纯字面、禁 `Date.now()`/`Math.random()`、`parallel()` 收 thunk 不收裸 promise、守 caps。
- launch 与排错：harness 报错即权威，按 `references/mechanism.md` 修后 relaunch。

### 4.2 OUT of scope（明确移交给谁）

| 关切 | 移交给 |
|------|--------|
| 主线编排决策（何时用哪种后台机制、拆图、派发、端点验收、整合） | `orchestrating-to-completion` |
| 写 / 改一个 skill 的 body / 判该不该建 / 度量一个 skill | dev meta-skills（`cc-master-skillsmith` / `curating-skill-portfolios` / `grounding-skill-evals`） |

### 4.3 Boundary heuristic（一句话判定法）

**问「这是在写脚本内部、还是在做主线编排决策？」**——脚本内怎么写（`parallel()` vs `pipeline()`、schema、caps、determinism）→ 本 skill；主线编排决策（何时拆图、派发、验收、用哪种机制）→ `orchestrating-to-completion`。一句话：**乐器怎么演奏归本 skill，指挥棒怎么挥归邻居。**

## 5. 触发与反例

### 5.1 Recognition cues（应当被触发的信号）

- 要调用 Workflow 工具（哪怕自觉已懂 API）。
- 要写 / 调试 / 启动一个 dynamic-workflow 脚本。
- 拿不准引擎的 determinism / resume / caps 规则。
- 想伸手够 `parallel()` / `pipeline()` 而没先查 work 的 shape。
- 想手写一个 validation linter，或刚被 harness 报错要 relaunch。

### 5.2 Counter-examples（明确不该被触发的反例）

- 主线怎么协调多个后台任务 / 何时该用 workflow vs sub-agent → `orchestrating-to-completion`（主线编排决策，非脚本写法）。
- 单个 sub-agent 一次性任务（一条推理链一个交付物）→ **不该上 workflow**，直接 dispatch 一个 sub-agent（honest-test 的反面）。
- 要判要不要为某能力建 skill / 度量某 skill → 对应 dev meta-skill。

### 5.3 Pre-flight gate（硬门，任一不满足就 STOP）

- (i) honest-test 通过：这活确有 fan-out / context-flood / 可复用质量 pattern 之一（否则 STOP，单 sub-agent 解决，别上 workflow）。
- (ii) 目标 work 的 shape 能说清（独立全收 / 多阶段流式 / 未知数量 / 不知 work-list），否则先 scout，不是先猜范式。

## 6. 演化锚

- **Lifecycle class**：methodology——「按 work 形状选范式」「honest-test 先判需不需要」「harness 即 endpoint，不重写 linter」都是随工程实践存续的判断，模型越强越该执行。
- **Sunset trigger**：不适用（methodology 类带存续推定）。**但**注明：本 skill 教的**具体引擎契约**（primitive 语义、resume 规则、caps 数值、`Date.now()` 禁令）是**随 harness 版本走的活规格**，不是会过时的脚手架。引擎契约变了就更新 `references/api-reference.md` / `references/mechanism.md`——**契约准确性以 harness 为权威**，不写假 sunset。
- **Fitness 不变量 → 可跑 probe**：
  - *引擎契约准确* → probe：harness 自身在 launch（校验 `meta`）/ runtime（throw on `Date.now()` 等、enforce caps）校验——**harness 即权威 endpoint**，契约漂移由真 launch 暴露，不靠本仓重写校验。
  - *不重写 linter*（纪律不被磨平）→ probe：`grep -rinE 'lint|validator|static.?check' skills/authoring-workflows/` 的每条命中须是 ①「harness 是权威、不重写 linter」的论述语境，或 ② 与 workflow 校验无关的 benign 提及（near-miss eval query 里的 `npm run lint`、self-repair example 里跑的 lint **gate**）——**绝不**是一份自造的 workflow-契约 static linter 实现。
  - *默认 pipeline 指导在场* → probe：SKILL.md / `references/mechanism.md` 始终保留「default to `pipeline()`、`parallel()` 仅当下游真需全集」的 smell-test，不被「代码更整齐」磨平。
  - *与 `orchestrating-to-completion` 不重叠*（红线 3）→ 两者 description 的 Use-when / 反例互指闭合：本 skill 反例指向「主线编排 → orchestrating」，邻居反例指向「写脚本 → 本 skill」。
- **Cross-major review owner**：`curating-skill-portfolios`（portfolio 准入 / 重叠 / 边界的 SSOT；模型大版本时由它复盘本 skill 是否仍站得住、是否与 `orchestrating-to-completion` 重叠）。
