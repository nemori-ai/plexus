# OBJECTIVE — requirement-elicitation

J_top: 本仓任何 feature / skill / 行为改动在动手之前，真实需求已被用户对着一个具体实例确认、设计已过闸——不把猜出来的方案当需求实现、不在需求未确认时就跳进实现 / 造 body。

baseline_reference:
  user_task: 用户给本仓递来一个请求 / goal（常以一个猜出来的方案形态：「加个 X」「给我做个 Y」），要动手。
  without_skill_floor: |
    默认 agent 照字面把请求当需求——直接拆 DAG 派发 / 直接跳进 skillsmith 写 body / 直接 coding，
    交付一个让真痛点原封不动的产物；在 time / 简单性压力下跳过设计闸（"这么简单不用先呈现设计"）；
    用抽象（"更好的可见性"）当需求，指不出一个它在疼的具体实例就开始建模。
  expected_uplift: |
    把「照字面实现」逼成「先挖真痛点（五个 discovery moves）+ 用用户原话复述确认 + 过设计闸再动手」；
    把「猜出来的需求」逼成「对着一个具体实例确认过的需求」；把「方案=需求」逼成「痛点与方案分离，honor 前者、hold 后者」。

strict_dims:
  - 设计闸不被绕过：需求未经用户对着具体实例确认、或设计未呈现并批准之前，不得有任何实现动作（写 body / coding / 派发实现），无论请求多简单。
  - 真需求 vs 字面请求分离：不得把用户提议的方案直接当需求实现；必须分离痛点与方案，绝对尊重痛点、松松握住方案。

rationale: |
  这是对的成功定义，因为下游一切（DAG / skill / feature）都从「需求」这个根派生——读错根，再严谨的下游都只是
  从一个谎言正确地推导。把成功锚在「设计闸不绕过 + 真需求 vs 字面分离」两条 strict 维上，正对应本 skill 唯一的
  红线（猜出的需求 ≠ 确认的需求，是 cc-master「no-silent-failure / gate-green ≠ passed」在发现阶段的同构）——
  守住它们，下游就不会在一个未经验证的解读上忠实地浪费整条工作链。
  注：本文件只按 schema 落一份成功契约；J 声明 / Track A·B eval 的方法论权威在 grounding-skill-evals，不在本 skill。
  Track A 触发 eval 与本 skill 的 evals/trigger.json 与其它 meta-skill 一并 defer（见 DESIGN.md「已知缺口」）。
