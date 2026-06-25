# OBJECTIVE — cc-master-skillsmith

J_top: 本仓 discipline-bearing 的 skill prose 在 agent 压力下不被合理化绕过，且 body 形状匹配诊断出的 craft（机械配方 / 心智模型 / 纪律级）。

baseline_reference:
  user_task: 给 cc-master 造或改一个 skill 的 body（新建或编辑）。
  without_skill_floor: |
    默认 agent 凭感觉写 body——纪律段被 time / sunk-cost 压力当场合理化跳过（"这次太
    明显，不用先看 agent 失败"）；不诊断 craft，默认落进编号清单形状，把本该是心智模型
    的 skill 写成一串 Step 1/2/3（形状错配，要等真 session 跑出来才发现，那时已整篇重写）。
  expected_uplift: |
    把两条 J 推过 floor：(1) Iron Law gate 强制"无 failing pressure baseline 不改 discipline
    prose"，堵住合理化跳过；(2) craft 两轴诊断强制"写第一行 body 前先定 craft"，堵住形状错配。

strict_dims: [craft 形状一致性, Iron-Law-gate 存在性]

rationale: |
  这两维是 skillsmith 唯一不可回退的承重维度。craft 形状一致性——body 的形状必须匹配诊断
  出的 craft，否则规则堵得再严也教错 substrate（命名锚被写成编号步骤，agent 内化不到机制）。
  Iron-Law-gate 存在性——没有"先 baseline 再写"的硬门，discipline prose 就退化为作者凭想象
  写的合理化表（一行没有真实 baseline 支撑的 Rationalization 行就是谎报）。两者分别守 body
  的"形"与"质"，缺一则 skillsmith 失去存在理由。J 度量与设计分开：本文管成功度量，DESIGN.md
  管设计宪法（什么是它、为什么、边界移交给谁）。
