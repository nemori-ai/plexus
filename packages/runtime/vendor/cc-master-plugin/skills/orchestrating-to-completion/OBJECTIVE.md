# OBJECTIVE — orchestrating-to-completion

J_top: 编排者把一个 long-horizon 目标驱动到完成时，DAG 并行到真实数据依赖结构允许的程度（不画假串行边）、为每个就绪节点选对后台机制（shell / sub-agent / workflow + parallel/pipeline 形状，既不过度工程也不滥用 barrier）、且按 5h/7d 配额窗口做双侧 pacing（既不让额度白白蒸发、也不半截撞墙），在资源预算内最大化推进效率，同时守住七镜头 / 红线（指挥不演奏、只信端点验收等）。

baseline_reference:
  user_task: 给一个跨度 >24h 的目标，让主线 agent 当总指挥把它并行拆解、派发、续跑到完成。
  without_skill_floor: 没有该 skill 的默认 agent 在预算压力下倾向把本可并行的任务串行化（画假依赖边以求省 token / 求稳），makespan 被拉长；选机制时也退化——一条推理链 / 一份交付物就动用 workflow（过度工程），或在串行临界链 / 无跨集合依赖处硬上 barrier（barrier 误用，白白浪费快 leaf 的空闲）；且 pacing 只会单边节流，欠用配额时让 5h 窗口额度白白蒸发——容量一边浪费、一边可能透支半截撞墙。（本仓 dogfood 行为 eval 实证：魂-only 拆 DAG 倾向串行、欠 pace 探针两 agent 给出相反决策；机制选择的护栏 / smell-test 此前住 SKILL B、主线选机制时根本不会打开——非对称可达性，Finding #44 家族。）
  expected_uplift: 把 J_top 的两条 strict_dim（调度正确性 = 并行度逼近真实依赖上限 + 机制选择正确、双侧容量 pacing）从 floor 推过去——拆图时逐边举证删掉假串行边，选机制时一条链一份交付物就单 sub-agent（不过度工程）/ 默认 pipeline 只有下游真要整批集合才 barrier（不误用 barrier），pacing 时既防超支也防额度蒸发。

strict_dims: [调度正确性（dispatch 决策质量，含两个面向：①并行度——逼近真实数据依赖结构允许的上限，无凭顺序习惯画出的假串行边、呈 foundation-then-parallel 形状不过度串行；②机制选择正确率——过度工程率，无 fan-out / 单一交付物却起 workflow，越低越好；barrier 误用率，无跨集合依赖却上 parallel barrier，越低越好）, 双侧容量 pacing（既防超支半截撞墙、也防欠用额度蒸发，加速以 7d 窗口当总闸）]

rationale: 这个 skill 的承重价值不在「跑完目标」这个表面动作，而在两个底层机制——调度正确性（把依赖图压到真实数据结构允许的最大并行度、每条边逐一举证默认错，并为每个就绪节点选对后台机制、不过度工程不误用 barrier），以及对配额窗口做对称的双侧 pacing（蒸发与撞墙同是失败）。默认 agent 在压力下恰恰在这两处退化（串行化保稳 + 机制选错挤在同一个调度决策里、单边节流），所以它们是不可回退的 strict 核心；七镜头的其余措辞、reference 选择是 Pareto-可换的。机制选择正确率与并行度同栖「调度正确性」一条，是 Finding #44 家族的非对称可达性归因：二者同属 dispatch 决策质量、且同根于同一可达性病根——护栏 / smell-test 住 SKILL B（workflow 写法），主线编排时根本读不到，所以默认 agent 在「并行度」与「机制选择」上一并失明。它们不是两个独立缺口、而是同一非对称可达性在调度决策上的两个面向，故合成一条 strict_dim 涵盖二者，与本仓「1-2 个 strict_dims」约束一致。

## 非目标（notes）

J 不要求 pacing 精确闭环到 100%——账户权威 usage 信号物理上有诚实天花板（缺 sidecar 时只能本地反推，见 `references/cost-and-pacing.md` 的诚实天花板讨论），只要求方向性的双侧逼近（该节流时节流、该提速时提速），而非一个精确的利用率目标值。strict_dim 上判的是「有没有朝正确方向调」，不是「调到了某个精确数」。
