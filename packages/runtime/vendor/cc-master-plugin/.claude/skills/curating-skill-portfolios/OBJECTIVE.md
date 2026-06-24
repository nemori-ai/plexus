# OBJECTIVE — curating-skill-portfolios

J_top: 本仓每个 skill 都站得住（增量或覆写至少一强，非装饰）、互不重叠、各有一份 DESIGN.md 设计宪法——portfolio 不积累装饰重量、不放任触发重叠。

baseline_reference:
  user_task: 维护者面对一个新能力 / 一段有用信息 / 一次 skill 版图重构，要判断它该不该独立成 skill、放哪、会不会和现有 skill 撞。
  without_skill_floor: |
    没有这个 skill 的默认 agent：见「有用信息」就建个 skill（把本该做 reference 的纯增量内容做成独立 skill）；
    凭 description 字面像不像判重叠（漏掉「都过 Probe 但答案相同」的真重叠）；
    把维护者才用的 dev 工具混进分发的 skills/；建完就走，没有 DESIGN.md 钉住设计意图，下次改 SKILL.md 时设计漂移。
  expected_uplift: |
    把「要不要建」从手感升级成 Counterfactual Probe A/B + 3 必维 scoresheet 的可操作判据；
    把「会不会重叠」从字面比对升级成 Probe 答案比对 + description Use-when/Do-NOT 对子消解；
    把「建完就走」升级成每个站得住的 skill 配一份 6 段 DESIGN.md，设计先于实现。

strict_dims:
  - 装饰拦截率：D3 两 probe 都 weak 的候选必须被判「不建/退役」，不得「为凑齐/为对仗」放行。
  - 重叠零放行：两个 strong 形态相同的 skill 必须被判 overlap 并要求 description 对子消解，不得以「描述看着不像」放过。

rationale: |
  这是对的成功定义，因为 portfolio 健康的承重指标不是「有多少 skill」而是「每个 skill 站不站得住、彼此正不正交」——
  装饰 skill 一旦发布就永久稀释 description 触发池、钝化 router 精度，重叠 skill 让两个触发条件互相打架。
  把成功锚在「装饰拦截 + 重叠零放行」两条 strict 维上，正好对应 cc-master 红线 3「两 skill 不重叠」与
  Probe「装饰不建」这两条最常被合理化绕过的判断——守住它们，portfolio 就不会在「有用就建」的诱惑下膨胀成噪声。
  注：本文件只按 schema 落一份成功契约；J 声明 / Track A·B eval 的方法论权威在 grounding-skill-evals，不在本 skill。
