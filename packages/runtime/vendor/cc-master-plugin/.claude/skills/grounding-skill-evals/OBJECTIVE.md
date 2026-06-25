# OBJECTIVE — grounding-skill-evals

J_top: 本仓每个 skill 有一份可消费的成功契约（轻量 J），且迭代有据——holdout 防 description 过拟合、predict-then-validate 防自欺、baseline-must-fail 保证 case 有判别力，质量靠独立端点判决而非自检。

baseline_reference:
  user_task: 给 cc-master 某个 skill 写完 / 改完 body 后度量它好不好，或在改 description / 纪律段前后判断改动有没有用。
  without_skill_floor: |
    默认 agent 凭手感改 SKILL.md，自检即完成（"我读了一遍 transcript，感觉行为对了"当判决）；
    用的 eval case 没一个在 without-skill 时会败（两臂都过，零判别力还自称验证过）；
    在脑中那几个 query 上把 description 调到满分却从不留 holdout（过拟合当改进）；
    改前不写预测，改完看数字碰巧变好就喊"改好了"（噪声当真有效）。
  expected_uplift: |
    把 J_top 推过 floor：(1) 强制每个 skill 有 OBJECTIVE.md（声明 J），评测有锚不逐 case 漂移；
    (2) 接现有 Track A/B + codex 第二评委，把"自检即完成"换成独立端点判决（generator≠judge）；
    (3) 三个借来的思想——baseline-must-fail / holdout / predict-then-validate——分别堵零判别力、
    过拟合、自欺三个洞。

strict_dims: [独立端点判决（非自检）, baseline-must-fail 的可败性]

rationale: |
  这两维是 grounding-skill-evals 唯一不可回退的承重核心。独立端点判决——质量必须由独立端点
  （Track A 的数字 / Track B grader + codex 第二评委）裁，不许用"我有信心"绕过；它呼应 cc-master
  红线 4「端点验收 / gate-green ≠ passed」，丢了它本 skill 就退化成「自己给自己打分」。
  baseline-must-fail 的可败性——eval case 必须在 without-skill 臂可证失败，否则两臂都过的 case
  零判别力，所有 accuracy 数字都失去意义；它是「度量有没有用」这件事本身能成立的前提。holdout 比例、
  predict 的写法、Track B 的 run 数都是 Pareto-可换的（带 rationale 可调），但这两维一动本 skill
  就不再度量「真有效」而只是度量「我相信有效」。J 度量与设计分开：本文管成功度量，DESIGN.md 管设计
  宪法（什么是它、为什么、边界移交给谁）。
