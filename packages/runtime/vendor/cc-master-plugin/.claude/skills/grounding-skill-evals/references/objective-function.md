# 轻量 J 写法 + OBJECTIVE.md schema

> 本文是 `grounding-skill-evals` 的深细节：怎么给一个 cc-master skill 写一份**轻量**的 objective function（J），落在它目录的 `OBJECTIVE.md`。主文件给入口，本文给 schema + 判据 + 正反例。

## Contents

- [1. J 是什么、为什么轻量](#1-j-是什么为什么轻量)
- [2. OBJECTIVE.md 的 schema（§5.4）](#2-objectivemd-的-schema545)
- [3. J_top 怎么填（判据 + 正反例）](#3-j_top-怎么填判据--正反例)
- [4. baseline_reference 怎么填（must-fail 的承重载体）](#4-baseline_reference-怎么填must-fail-的承重载体)
- [5. strict_dims 怎么填（不能全空、不能全锁）](#5-strict_dims-怎么填不能全空不能全锁)
- [6. 自检清单](#6-自检清单)

---

## 1. J 是什么、为什么轻量

**J（objective function）= 这个 skill「成功 = 什么」的机器可读答案。** 它被三类下游消费：评测问「这 skill 绿不绿」、迭代问「我能改什么、必须保什么」、写作自检问「body 还锚在我声明的东西上吗」——三者都读 J，不读 description、不读 prose。

没有声明的 J，这三件事都**失锚**：评测逐 case 漂移、迭代 reward-hack 碰巧在视野里的指标、写作丢失纪律。

**为什么本仓的 J 是轻量的：** 重型方法论的 J 有一整套形状——重型 J 不变量集、多档 measurement class、多阶段 lifecycle、多字段机器可读裁决 schema、独立 skill 元数据 YAML 承载。**本仓 2+1 的小 portfolio 体量用不上那套**——本仓的 J 就是一份 `OBJECTIVE.md` 里的：一句话 `J_top` + 一段 `baseline_reference` + 1-2 个 `strict_dims`。**不引入 cc-master 没有的独立 skill 元数据 YAML**（决策 §4.3）。任何把 J 膨胀回重型 schema 的冲动都是照搬过度工程。

## 2. OBJECTIVE.md 的 schema（§5.4）

每个 skill 目录一份 `OBJECTIVE.md`，照这个 schema：

```markdown
# OBJECTIVE — <skill-name>
J_top: <一句话：这个 skill 让 agent 在什么上成功>
baseline_reference:
  user_task: <一句话用户任务>
  without_skill_floor: <≤3 行：没有这个 skill 的默认 agent 会怎样退化>
  expected_uplift: <这个 skill 把哪条 J 推过 floor>
strict_dims: [<1-2 个不可回退的承重维度>]
rationale: <2-3 句：为何这是对的成功定义>
```

字段速查：

| 字段 | 是什么 | 一句话判据 |
|---|---|---|
| `J_top` | 成功的承重定义（一句话） | 下游只读这句能不能知道「绿 = 什么」？ |
| `baseline_reference.user_task` | 触发这 skill 的用户任务（一句话） | 具体到能据此设计 case |
| `baseline_reference.without_skill_floor` | 没这 skill 的默认 agent 怎样做差（≤3 行） | 「这 skill 打败它」是否可判定？ |
| `baseline_reference.expected_uplift` | 这 skill 把哪条 J 推过 floor | 指向 J_top 或某个 strict_dim |
| `strict_dims` | 1-2 个不可回退的承重维度 | 不能全空（否则不约束），不能全锁（否则无探索空间） |
| `rationale` | 为何这是对的成功定义（2-3 句） | 非占位（不是 `TBD`） |

## 3. J_top 怎么填（判据 + 正反例）

**判据：** J_top 是一句话，回答「这个 skill 让 agent 在**什么上**成功」。它锚在 skill 教的**内部机制**上，不是可见的表面动作。

> **J_top ≠ description。** description 描述「何时触发我」；J_top 描述「成功 = 什么」。把 J_top 写成 description 的复读 = 没有可消费的成功契约。

**正例**（来自 §5 的三个 meta-skill）：

- `cc-master-skillsmith`：「本仓 discipline-bearing 的 skill prose 在 agent 压力下不被合理化绕过，且 body 形状匹配诊断出的 craft。」——锚在「抗合理化 + craft 形状一致」这两个内部机制上。
- `curating-skill-portfolios`：「本仓每个 skill 都站得住（增量或覆写，非装饰）、互不重叠、各有 DESIGN 宪法。」
- `grounding-skill-evals`（本 skill）：「本仓每个 skill 有可消费的成功契约，迭代有据（holdout 防过拟合、预测-验证防自欺）。」

**反例：**

- ❌「让 skill 更好。」——空。「更好」在哪条维度上、对谁、怎么测，全没说。
- ❌「Use when 写完 body 要度量时。」——这是 description（触发条件），不是成功定义。
- ❌「agent 选对答案。」——表面（surface）。baseline 靠猜也能选对，case 失去判别力。要锚在「agent 的推理引用了承重不变量 X」这种**底层（substrate）**上。

## 4. baseline_reference 怎么填（must-fail 的承重载体）

`baseline_reference.without_skill_floor` 是 **must-fail discipline 在 skill 层的 prose 载体**：一段具体描述「没有这个 skill 的默认 agent 会怎样做」，写得足够具体，让「这个 skill 打败它」是**可判定的**，不是口号。

**判据：** 读 `without_skill_floor`，能不能据此设计出一个 without-skill 臂上**保证失败**的 case？能 → 合格；不能（太抽象）→ 回去写具体。

**正例：**

- `cc-master-skillsmith`：「默认 agent 凭感觉写 body——纪律段被 time/sunk-cost 压力合理化跳过，清单/心智模型形状错配（该写成心智模型却写成编号清单）。」——具体到能造一个「施加 time + sunk-cost 压力，看 agent 跳不跳纪律段」的 case。
- `grounding-skill-evals`（本 skill）：「默认 agent 凭手感改 SKILL.md、自检即完成，过拟合到脑中那几个例子。」

**反例：**

- ❌「agent 不用这 skill 会做得差一点。」——「差一点」不可判定。差在哪？哪个 case 上必然差？
- ❌「I'll write baseline_reference once I know what the skill does.」——没有 baseline_reference 就声明不了对 baseline 的杠杆。先写它，否则这份 J 不成立（reject-and-surface，别留空占位）。

## 5. strict_dims 怎么填（不能全空、不能全锁）

`strict_dims` 是 1-2 个**不可回退**（Δ ≥ 0 强制，迭代时不许换掉）的承重维度。其余维度是 Pareto-可换的（带声明的 rationale 可换）。

**两个极端都是错的：**

- **全空**：一切可换。迭代可以带着「声明的 rationale」丢掉每一个维度还自称进步——J 不再约束任何东西。这是最常见的 J 失效。
- **全锁**：每个维度都锁死。迭代没有探索空间，skill 的 J 无法在改动下演化。

**右形状 = 「一小撮承重核心是 strict，其余 Pareto」。** 常见 strict 选择：结构地板（body 有 frontmatter / 目录布局合规）、触发保真（Track A accuracy 不回退）、holdout transfer（holdout 上不崩）。

**正例：**

- `cc-master-skillsmith`：`strict_dims: [craft-形状一致性, Iron-Law-gate-存在性]`——这两个是这 skill 的承重核心，丢了它就不是这 skill 了；prose 措辞、example 选择是 Pareto-可换的。

**反例：**

- ❌ `strict_dims: []`——全空，I-9 式失效。挑至少一个真正 Δ ≥ 0 强制的维度。
- ❌ 把所有维度都塞进 strict_dims——全锁，没探索空间。
- ❌ 把定性 / 高方差的 grader 维度（如某个 5 分 Likert depth 分）放进 strict_dims——grader 方差让它的 Δ 比较很脆，不该当 strict 闸。

## 6. 自检清单

写完 `OBJECTIVE.md`，逐条过：

- [ ] `J_top` 是一句话，且**不是** description 的复读（描述成功，不是触发）。
- [ ] `J_top` 锚在 skill 教的内部机制上，不是「选对答案」这种表面动作。
- [ ] `baseline_reference` 三个子字段都填了（`user_task` / `without_skill_floor` / `expected_uplift`），无 `TBD` 占位。
- [ ] `without_skill_floor` 具体到能据此造出一个 without-skill 臂保证失败的 case。
- [ ] `strict_dims` 非空、非全锁（1-2 个承重核心，其余留给 Pareto）。
- [ ] `strict_dims` 里没有高方差的定性 grader 维度。
- [ ] `rationale` 是 2-3 句实质 prose，不是占位。

任一不过 → 别静默补一个 plausible 的值，**回到对应上游把它想清楚**（reject-and-surface）。「我下一遍再填 rationale」就是 silent patch——下游消费这份 J 时会断。
