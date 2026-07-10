---
title: 信任模型
description: 默认拒绝、两个时钟、来源与敏感度、execute 默认逐次（once）规则——Plexus 如何决定 agent 可以调用什么。
---

# 信任模型

一条原则统辖 Plexus 对 agent 每一次请求的处理：**能触达网关的 agent，默认依然没有任何权限。**
本页专讲信任机制。想在语境里看完整心智模型，先读[核心概念](/zh/concepts/)；对抗视角和凭据边界，
见[安全模型](/zh/architecture/security-model)。

---

## 默认拒绝就是全部承诺

触达网关——哪怕握手成功——换来的只是 agent 知道"拥有者授权给它什么"，绝不是调用任何东西的权利。握手成功
授予该 agent 的 manifest——拥有者为它授权的那个子集，条目细节完整——*仅此而已*。agent 永远不会得知网关
拥有超出其授权子集的能力。从未被授予任何 capability 的 agent，在 `/invoke` 处以 `grant_required` 被拒。

权限由**人**授予：限定到具体 capability、有时限、随时可撤销。agent 抢不来、推断不出，也自封不了。

---

## 两个时钟，而非一个

Plexus 刻意把**你的批准能常驻多久**和**单个 token 存活多久**分开：

![两个时钟 — 信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。批准授权时你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或自定义（`custom`）时长。窗口结束（或你撤销）之前，agent 不必再问。
  这就是**常驻授权**。

- **受限 token（scoped token）**——**爆炸半径**。每次实际调用都携带一个短寿命的 bearer token，默认 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，钳制在 `[1m, 60m]`）。token 过期后，只要信任窗口还在，agent 就通过
  `POST /grants/refresh` 从常驻授权静默换发一个新的——**不需要 connection-key，也不再提示**。所以泄漏的
  token 几分钟内就一文不值，哪怕常驻授权还在生效。

`once` 授权是特例：只为一次使用而立（`expiresAt = grantedAt`），不能刷新；未来该问的批准，一次也不会少。

---

## 来源（provenance）——三类组织轴

![来源到默认姿态——第一方与受管的读自动授予，所有写/执行挂起待批，扩展的任何动作都挂起](/diagrams/provenance-posture.png)

决定 Plexus 对一项 capability 有多谨慎的唯一事实，是它的**来源**——这项 capability 从哪来。信任随出身而定。

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| **first-party** | 保留的进程内 source（Apple Calendar/Reminders、Obsidian 文件系统、Claude Code）。 | read 顺畅放行；write/execute 仍要问人。 |
| **managed** | *你*通过可信的 `/admin` UI 添加的 source（如 Obsidian REST vault），添加时经过人的审查。 | read 姿态与第一方相同；write/exec 仍挂起等人批准。 |
| **extension** | *agent* 经 `POST /extensions` 在 wire 上注册，最严格的一类。 | **任何**动词都挂起等人批准。 |

第一方日历 read 和 agent 注册的 shell 包装器不是同一种风险，Plexus 从不假装它们是。来源印记由网关
盖在 source 上——扩展无法冒充第一方 id（那些 id 是保留的）。

---

## 敏感度（sensitivity）——推导出的风险层级

网关从 `provenance + verb + transport` 推导出一个**敏感度**层级，目的只有一个：让 UI 和每个 agent
描述的是同一种风险：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*扩展上的 read。
- **high**——扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

Workflow 的敏感度按成员上卷（取最大值）。

---

## 常驻资格随敏感度而定，而非随出身（ADR-5）

不是每个窗口对每项 capability 都可选。**一次授权默认能不能*常驻*，由该 capability 自身的敏感度决定**
——从 `provenance × verb` 推导——而绝不由它从哪来决定：

- **`read`** capability 可以常驻：一经批准就取一个真实窗口（第一方/受管默认 `7d`；`write` 默认 `1d`），
  之后范围内的 read 在窗口结束或你撤销之前都零摩擦。
- **`execute`**（或其他**高敏感度**）capability 默认**逐次**批准，上限是 `once`——*agent* 请求任何窗口
  都解除不了这道底线。运行代码（`claudecode.run`、`codex.run`）默认每次都要一个新鲜的人类决定。
  **拥有者**可以在连接时为特定 agent + capability 显式开启**常驻 execute** 授权（默认关闭、双重确认）；
  一经开启，这份授权就走真实窗口或 `until-revoked`。

::: danger execute 默认逐次——只有拥有者能解除
`execute` 的 `once` 上限在 *agent* 请求的任何窗口下都成立——agent 自己永远解除不了。解除它是拥有者的
刻意动作：连接时按 agent、按 capability 的显式开启，默认关闭、双重确认。没有这次开启，`execute`
capability 即便在管理员提供的信任窗口下也保持逐次；开启之后，授权持续到窗口结束或你撤销。
:::

还有两层拥有者侧的控制与这道天花板叠加。**Real launch（真实启动）**是 exec 源上的机器级设置
（控制台：What I expose → 该源 → "Real launch"；每次翻转都有审计）：批准一次 execute 调用只是授了权；
到底*真的* spawn 工具（消耗你的模型额度），还是只做诚实的记录模式演练，由你这台机器自己的开关决定，默认记录模式。
另外 exec 结果在 wire 上做了**抹除**（wire-redacted）：调用方 agent 只拿到 `ok / launched / sandboxed / output / exitCode`；
限制诊断信息（沙箱目录路径、机器布局、sandbox argv）只出现在你的审计记录里。

---

## 暴露门控——拥有者的外层开关

![默认拒绝的漏斗——暴露、发现、授权、调用；每道闸都收窄，未通过即拒绝](/diagrams/exposure-gate.png)

授权决定 agent *可以*调用什么；**暴露（我暴露什么）是拥有者摆在授权之前的外层门控**。被拥有者禁用的
capability 在 discovery 里不可见、不可授权，invoke 时以 `capability_unexposed` 被拒——这一步在授权检查
**之前**执行。所以有效访问 = **已授权 ∧ 已暴露**：撤掉暴露就切断了这项 capability，不管还有什么常驻授权。

---

## 可见、可撤销、诚实叙述

常驻授权是一等公民，**两侧都看得见**：拥有者在 `/admin` 的 **Grants** 标签页看到全部；agent 在
`GET /grants` 只看到*它自己*的。每一行都带着 agent、capability、动词、来源、敏感度、信任窗口和到期时间。

- **随时撤销。** 人从 **Grants** 标签页撤销，或持 connection-key 调 `POST /grants/revoke`——按 `jti`、
  按 `(agentId, capabilityId)`，或按 `bundleId` 撤销一整个任务 bundle。agent 出示某个 token 及其 `jti`，
  可以放弃**它自己的** token。
- **叙述由网关撰写，绝非 agent 的措辞。** 人批准时读到的风险摘要出自网关之手。agent 那段可选的
  "为什么是现在"说明展示时标注为 *"the agent says：（agent 说：）"*，会被净化和截断，且不影响任何决定。
  agent 永远伪造不了那份风险摘要。
- **一切都有审计。** 每次握手、授权、token、invoke 和撤销——包括派发前的*拒绝*——都记进一份只追加的
  本地审计轨迹（`GET /admin/api/audit`），密钥已抹除。把它当作尽力而为的可观测性，而不是防篡改账本。

这些机制背后，是人用来推理的两种凭证性质：**工牌**——agent 的持久身份，即按 agent 独立的 PAT；
**门票**——以任务为界的授权同意，开工前一次批准、可作为一个整体撤销。任务 bundle 就是门票的 1.0
形态；它接下来的走向，作为接缝锁定在[授权可扩展性](/zh/architecture/extensibility)（ADR-020）。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)**——本页所展开的完整心智模型。
- **[编译模型](/zh/concepts/compile-model)**——launcher 如何收起 enroll → handshake → grant → invoke
  这条链，而网关实时强制授权。
- **[安全模型](/zh/architecture/security-model)**——两种凭据、威胁模型，以及 Plexus 不防什么。
