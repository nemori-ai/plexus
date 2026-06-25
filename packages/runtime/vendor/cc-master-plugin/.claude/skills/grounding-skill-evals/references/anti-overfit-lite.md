# 防过拟合 + 防自欺：三个只借的思想（baseline-must-fail / holdout / predict-then-validate）

> 本文是 `grounding-skill-evals` 的深细节：三个从外部成熟的 skill 评测 / 优化方法论 **只借思想、不搬引擎**的判别力内核。主文件给一句话入口，本文给完整配方 + 正反例 + 抗合理化。**只借这三个思想——不要把带自动搜索 + 多候选 filter 的优化引擎、多维优化前沿、统计显著性 / 方差分析预检、多字段裁决 schema 一起搬进来**（红线：照搬过度工程——过度工程的边界见本 skill 的 When NOT to use / OUT of scope 与 `DESIGN.md` 的「不做」段）。

## Contents

- [0. 为什么只借思想](#0-为什么只借思想)
- [1. baseline-must-fail —— 两臂都过的 case 是零证据](#1-baseline-must-fail--两臂都过的-case-是零证据)
- [2. holdout split —— 防 description 过拟合](#2-holdout-split--防-description-过拟合)
- [3. predict-then-validate —— 防自欺](#3-predict-then-validate--防自欺)
- [4. 三者怎么串起来用](#4-三者怎么串起来用)
- [5. 抗合理化表](#5-抗合理化表)

---

## 0. 为什么只借思想

成熟的评测 / 优化方法论有一整套重型机器：评测侧的多字段机器可读裁决 schema、自动 holdout-gap 检测 / 偏置缓解套件、多维 rubric；优化侧的带自动搜索 + 多候选 filter 的优化引擎、多维优化前沿、统计显著性 / 方差分析预检、自动化的 predicted-delta 契约。**本仓 2+1 的小 portfolio 体量撑不起也不需要那套引擎。**

但那套引擎背后有三个**与体量无关、纯思想层面**的判别力原则，本仓**该借**——它们不需要任何脚本，只是 prose checklist + 现有三脚本的用法纪律：

1. **baseline-must-fail**——case 必须能区分「有/无 skill」，否则零证据。
2. **holdout split**——优化 description 时留一组没碰过的 query 验证，防过拟合。
3. **predict-then-validate**——改前写预测、改后比对，防把噪声当真有效。

判据：**借的是「为什么这么做」的原则，不是「怎么自动化这么做」的脚本。** 任何让你去写 Pareto 计算 / ANOVA / verdict schema validator 的冲动，都越过了「只借思想」这条线。

## 1. baseline-must-fail —— 两臂都过的 case 是零证据

**原则：** 一个 eval case 只有在「没有该 skill 的 agent **必然失败**」时才有判别力。如果有 skill 和无 skill 两臂都过（或都败），这个 case 对「这 skill 有没有用」零信息——它测的不是 skill 的杠杆。

**为什么先跑 baseline 臂：** 必须**先跑 without-skill 臂、确认它真的失败，再跑 with-skill 臂**。顺序是纪律——如果先跑 with-skill 看到它过了，正向证据会先入为主，你会倾向于把一个其实两臂都过的 case 当成「skill 起作用了」。先确立失败，正向证据才有意义。

**和 cc-master pressure baseline 的关系：** cc-master-skillsmith 的 Iron Law「无 failing pressure baseline 不改 discipline prose」**已经是 baseline-must-fail 的定性版**——它要求你先看 agent 在没有该纪律段时选错。本节是它的**定量延伸**：把「看它选错」变成「在 eval set 里，每个 case 在 without-skill 臂可证失败」。两者互补不替代：定性版找出「哪条 rationalization 要堵」，定量版确认「这组 case 真的能测出堵没堵住」。

**正例：**

- ✅ case「施加 time + sunk-cost 压力，要 agent 在 A(删了重写)/B(将就提交)/C(问用户) 里选」——without-skill 臂的默认 agent 会选 B（合理化跳过纪律），with-skill 臂引用纪律段选 A。两臂分得开，有判别力。
- ✅ Track A 的 near-miss query「写 workflow 脚本」对 `grounding-skill-evals`——它接近 skill 主题但该触发 `authoring-workflows`。一个好的 description 在这条上**不**触发本 skill。without-skill（坏 description）可能误触发，with-skill（好 description）忍住。

**反例：**

- ❌ case「问 agent『什么是 holdout split』」——两臂都能答上来（模型本来就知道）。这测的是模型知识，不是 skill 杠杆。零判别力。
- ❌ Track A 的平凡 query「帮我写个 fibonacci」——它本就不触发任何 skill，两臂都「正确地不触发」。把它当 near-miss 凑数 = 虚高 accuracy（见 `design_docs/eval/README.md` 的天花板段）。
- ❌「这个 case 虽然两臂都过，但它测的是另一个维度，留着也无害。」——有害：它稀释了 eval set 的判别力，还让 accuracy 虚高。它该去那个维度的 baseline-fail case set，不是留在这里冒充判别力。**reject-and-surface，别静默留着。**

## 2. holdout split —— 防 description 过拟合

**原则：** 优化一个 skill 的 `description`（Track A 的对象）时，把 query 集分成 `train` / `holdout` 两组（默认 70/30），**只在 train 上调 description，用 holdout 验证**。如果 train 上 accuracy 升、holdout 上 accuracy 崩，你优化的是「背下 train 那组 query」而不是「学会判别该不该触发」——这就是过拟合。

**为什么需要：** description 是一小段 prose，很容易被调成「精确匹配 train query 的措辞」。比如 train 里有「跑 trigger 准确率」，你就往 description 塞「trigger 准确率」这几个字——train 上立刻满分，但换一组语义相同、措辞不同的 holdout query（「量一下 description 触发对不对」）就触发不了。holdout 是唯一能戳穿这种「背答案」的镜子。

**怎么做（轻量）：**

1. 写 eval set（`trigger.json`）时，把 should-trigger + near-miss query **分成两组**，标好 `train` / `holdout`（70/30）。
2. 改 description 时，**只看 train 的 accuracy 调**。
3. 改完，跑一遍 holdout。**train 升 + holdout 也升（或不崩）= 真改进；train 升 + holdout 崩 = 过拟合，回退。**

> **不要搭确定性 holdout-split 脚本 / 自动 holdout-gap 检测阈值 / 自动 paraphrase 引擎。** 本仓的 holdout 就是「eval set 里手动标两组，改时只看一组」。思想到位即可，不要工程化。

**正例：**

- ✅ train 上把某 near-miss 从误触发改成不触发，holdout 上另外两条语义相邻的 near-miss 也跟着不触发了——description 学到的是「这类 query 不属于我」的判别边界，不是某条 query 的措辞。真改进。

**反例：**

- ❌ 全部 query 都用来调 description，没留 holdout——你永远不知道是真学会了判别还是背下了这组 query。
- ❌ train 上 accuracy 0.95、holdout 上 0.55，却宣布「description 优化成功」——这是过拟合的教科书信号，必须回退。
- ❌ 把 holdout 也拿来调（「holdout 上差，我再针对它改改」）——一旦你针对 holdout 调，它就变成了 train，过拟合检测的镜子就碎了。holdout 只用来验证，不用来调。

## 3. predict-then-validate —— 防自欺

**原则：** 改 `description` / 纪律段之前，**先写下你预测的 delta**（一句可证伪的话），改后跑 eval 比对实测。预测对 = 你真的理解了改动的机制；预测频繁错 = 你在碰运气，把噪声 + 巧合当成「真有效」。

**预测长什么样（可证伪）：**

- 「我预期这次 description 改动让 Track A accuracy 从 0.78 升到 ≥0.88，且 holdout 不回退。」
- 「我预期加这条硬规则后，Track B 那条『没跑 codex 第二评委就喊 passed』的行为断言从 fail 翻成 pass。」
- 「我预期删掉这段冗余 prose **不**改变任何 case 的判决（纯结构改动）。」

**为什么有效：** 写预测逼你说清「我改的这一处**通过什么机制**影响哪个指标」。如果你写不出可证伪的预测，说明你其实不知道这次改动会怎样——那就别假装它是「改进」。改完比对：

- **预测对**——机制理解正确，这是真改进。
- **预测错（方向反了 / 幅度差很多）**——停下。要么你对机制的理解错了（去搞懂），要么这个指标被噪声主导（delta < 噪声，没结论）。**别看到数字碰巧变好就宣布胜利。**

**准度本身就是信号：** 结构性改动（删一段重复、加一条硬规则、改决策程序骨架）预测准——因为机制清晰。纯 prose 措辞策略改动（换个说法、调语气）预测准度**骤降**——因为「换个措辞会让 accuracy 怎样变」本就难预测。**当你发现自己对一类改动总是预测不准，那类改动就该走定性 review（pressure baseline）而不是靠 eval 数字定胜负。** 准度地图告诉你哪些改动 eval 能裁、哪些不能。

**正例：**

- ✅ 「删这段和 §3 重复的 prose，预测 0 个 case 判决变化」→ 跑完确实全员不变 → 验证了「这是纯结构改动」。
- ✅ 「加『空 review 按未通过处理』这条硬规则，预测那条 silent-pass-through 断言翻 pass」→ 跑完确实翻了 → 机制理解正确。

**反例：**

- ❌ 改完才看数字，数字好就喊「改好了」——分不清真有效还是噪声。**改前没预测 = 没有可证伪的假设 = 自欺的温床。**
- ❌ 预测错了却找补「虽然 accuracy 没按我说的升，但我感觉 description 读起来更顺了」——预测错就是预测错，「读起来更顺」不是你预测的指标，是事后合理化。

## 4. 三者怎么串起来用

一次典型的「改 description / 纪律 → 度量」闭环：

1. **改前（predict）：** 写下可证伪的预测 delta。
2. **保证 case 有判别力（baseline-must-fail）：** 确认 eval set 里每个 case 在 without-skill 臂可证失败；先跑 baseline 臂确立失败。
3. **改（只在 train 上调）：** holdout 那组完全不碰。
4. **改后（validate + holdout）：** 跑 eval，train + holdout 都跑；比对实测 vs 预测；train 升 holdout 不崩才算真改进。
5. **读判决（诚实）：** delta < 噪声 = 没结论；自检不算完成，要 Track A 数字 / Track B grader + codex 第二评委的独立判决（详见 [`track-ab-discipline.md`](track-ab-discipline.md) §6）。

## 5. 抗合理化表

| 借口 | 现实 |
|------|------|
| 「这个 case 两臂都过，但它测的是别的维度，留着无害。」 | 有害：稀释判别力 + 虚高 accuracy。它该去那个维度的 baseline-fail set，不是冒充判别力。reject-and-surface。 |
| 「全部 query 都用来调 description 更充分，不用留 holdout。」 | 没 holdout = 永远分不清真学会判别还是背答案。70/30 留 holdout 是过拟合的唯一镜子。 |
| 「holdout 上差，我针对它再改改就好。」 | 你一针对 holdout 调，它就变成 train，镜子碎了。holdout 只验证、不调参。 |
| 「改前写预测太麻烦，改完看数字不就知道了。」 | 改完看数字分不清有效还是噪声。预测是可证伪假设；没有它，「变好」全是事后合理化。 |
| 「预测虽然没中，但我感觉 prose 更顺了，算改进。」 | 「更顺」不是你预测的指标，是找补。预测错就回去搞懂机制，或承认这指标被噪声主导。 |
| 「本仓也该搭个自动 holdout-gap 检测 / 多维优化前沿 / 统计显著性预检，才严谨。」 | 那是重型方法论的引擎，本仓体量是 overkill。**只借思想，落在 prose checklist + 现有脚本上**（红线）。 |
| 「数字变好了就是改好了，不用管 baseline 会不会败。」 | 若 case 在 baseline 不会败，「变好」可能只是噪声漂移。先保证 case 有判别力，数字才有意义。 |

> **违背字面就是违背精神。** 「我留了 holdout，只是顺手在它上面也调了一下」——那 holdout 就不再是 holdout 了。「我写了预测，只是改完发现不对就改了预测」——那预测就不再防自欺了。这三个思想的价值全在**纪律地照字面执行**：baseline 先跑且必须可败、holdout 只验证不调参、预测改前写死不回改。任何「我遵循的是精神不是字面」都是在拆掉它们的牙齿。
