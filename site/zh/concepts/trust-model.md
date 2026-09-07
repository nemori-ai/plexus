---
title: 信任模型
description: 默认拒绝、三个时钟、来源与敏感度、execute 默认逐次（once）规则——Plexus 如何决定 agent 可以调用什么。
---

# 信任模型

一条原则统辖 Plexus 对 agent 每一次请求的处理：**能触达网关的 agent，默认依然没有任何权限。**
本页专讲信任机制。想在语境里看完整心智模型，先读[核心概念](/zh/concepts/)；对抗视角和凭据边界，
见[安全模型](/zh/architecture/security-model)。

---

## 默认拒绝就是全部承诺

触达网关——哪怕握手成功——换来的只是 agent 知道"拥有者授权给它什么"，绝不是调用任何东西的权利。握手成功
授予该 agent 的 manifest——拥有者为它授权的那个子集，条目细节完整——*仅此而已*。已绑定的 agent 能看到拥有者明确声明的子集中的能力，也能看到拥有者为它创建且仍有效的常驻授权所涵盖的能力，前提是这些能力仍然存在且已开放。从未被授予任何 capability 的 agent，在 `/invoke` 处以 `grant_required` 被拒。

权限由**人**授予：限定到具体 capability、有时限、随时可撤销。agent 抢不来、推断不出，也自封不了。

---

## 三个时钟，而非一个

Plexus 刻意把**你的批准能常驻多久**、**agent 的一段工作片段能持续多久**和**单个 token 存活多久**分开：

![信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。批准授权时你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或自定义（`custom`）时长。窗口结束（或你撤销）之前，agent 不必再问。
  这就是**常驻授权**。

- **会话（session）**——**片段时钟（episode）**：权限能*静默*流动多久。每次 handshake 打开一个会话
  （内存态，**60 分钟**，网关重启即失效），而 `POST /invoke` 和 `POST /grants/refresh` 都要求所出示
  token 的会话仍然存活。片段结束，静默换发链也随之终止——只有 agent 的 **PAT**，在一次全新的、留有
  审计记录的 handshake 里，才能打开下一个片段。

- **受限 token（scoped token）**——**爆炸半径**。每次实际调用都携带一个短寿命的 bearer token，默认 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，钳制在 `[1m, 60m]`）。token 过期后，只要信任窗口还在，agent 就通过
  `POST /grants/refresh` 从常驻授权静默换发一个新的——**不需要 connection-key，也不再提示**。所以泄漏的
  token 几分钟内就一文不值，哪怕常驻授权还在生效。

三者的**有效期和权限范围依次缩小**：PAT（身份凭证，长期有效）→ session（单次工作会话，≤ 1 h）→ token（泄露影响范围，约 15 min）。窃取后一级的凭证，不能取得前一级的权限：泄露的 token 几分钟内就会失效；即使刷新途径也被攻破，刷新仍只能持续到签发该 token 的 session 结束。开启下一次 session 必须使用 PAT，且每次都要经过新的、受审计的握手。所以，trust-window 即使设为 `until-revoked`，长期有效的也只是批准，不会因此产生长期有效、可被窃取的凭证。

`once` 授权是特例：只为一次使用而立（`expiresAt = grantedAt`），不能刷新；未来该问的批准，一次也不会少。

---

## Provenance：能力来源分三类 {#来源-provenance-——三类组织轴}

![来源到默认姿态——第一方与受管的 read 连接时勾选即常驻，所有写/执行挂起待批，扩展的任何动作都挂起](/diagrams/provenance-posture.png)

决定 Plexus 对一项 capability 有多谨慎的唯一事实，是它的**来源**——这项 capability 从哪来。信任随出身而定。

| Provenance | 含义 | 默认审批方式 |
| --- | --- | --- |
| **first-party** | 保留的进程内 source（Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Claude Code、Codex、Shortcuts、browser、browser-control、workspace、sysinfo）。 | read 顺畅放行；write/execute 仍要问人。 |
| **managed** | *你*（所有者）通过可信的 `/admin` 界面添加的来源（例如通过 REST 或文件系统接入的 Obsidian 笔记库），添加时经过人工审核。 | 读取采用与 first-party 相同的审批规则；写入和执行仍须等待人工批准。 |
| **extension** | 由 *agent* 通过 `POST /extensions` 接口注册的来源，属于审批最严格的一类。 | **所有**操作都须等待人工批准。 |

读取 first-party 日历和使用 agent 注册的 shell 封装，风险不同，Plexus 也从不把两者等同看待。网关根据来源指定 provenance；extension 不能冒用 first-party id，因为这些 id 是保留的。

---

## 敏感度（sensitivity）——推导出的风险层级

网关从 `provenance + verb + transport` 推导出一个**敏感度**层级，目的只有一个：让 UI 和每个 agent
描述的是同一种风险：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*扩展上的 read。
- **high**——扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

工作流的敏感度取所有成员中的最高值。

---

## 能否持续授权，看敏感度而非来源（ADR-5） {#常驻资格随敏感度而定-而非随出身-adr-5}

不是每个窗口对每项 capability 都可选。**一次授权默认能不能*常驻*，由该 capability 自身的敏感度决定**
——从 `provenance × verb` 推导——而绝不由它从哪来决定：

- **`read`** 能力可以持续授权：批准后会为授权设定有效期（first-party 和 managed 默认 `7d`；`write` 默认 `1d`），
  之后范围内的 read 在窗口结束或你撤销之前都零摩擦。
- **`execute`** 或其他**高敏感度**能力默认须**逐次批准**，授权上限为 `once`；无论 *agent* 请求什么授权期限，都不能自行突破这个限制。
  运行代码（`claudecode.run`、`codex.run`）默认每次都需要人来批准。**所有者**可以在连接时，为指定的智能体与能力组合开启**常驻执行授权**（默认关闭，需双重确认）；开启后，授权按实际的时间窗口或 `until-revoked` 生效。

::: danger execute 默认逐次——只有拥有者能解除
`execute` 的 `once` 上限在 *agent* 请求的任何窗口下都成立——agent 自己永远解除不了。解除它是拥有者的
刻意动作：连接时按 agent、按 capability 的显式开启，默认关闭、双重确认。没有这次开启，`execute`
capability 即便在管理员提供的信任窗口下也保持逐次；开启之后，授权持续到窗口结束或你撤销。
:::

所有者一侧还有两层控制，与上述上限共同生效。**Real launch** 是执行源的机器级设置（控制台：What I expose → 对应执行源 → “Real launch”）。批准执行调用意味着授予权限，是否*真正启动工具*并消耗你的模型配额，则由这项设置独立决定；默认以记录模式试运行，每次切换设置都会记入审计。执行结果会在**返回给调用智能体前过滤**：智能体收到 `ok / launched / sandboxed / output / exitCode`；隔离诊断信息（jail 路径、机器布局、sandbox argv）只出现在你的审计记录中。

---

## 开放设置：由所有者控制 {#暴露门控——拥有者的外层开关}

![默认拒绝的漏斗——暴露、发现、授权、调用；每道闸都收窄，未通过即拒绝](/diagrams/exposure-gate.png)

授权决定代理*可以*调用什么；**开放设置（what-I-expose）由所有者控制，决定哪些能力可供授权**。所有者禁用某项能力后，它就不会出现在发现结果中，也无法获得授权；调用时会返回 `capability_unexposed`，这项检查在授权检查**之前**执行。因此，有效访问 = **granted ∧ exposed**：停止开放某项能力会立即切断对它的访问，无论已有何种长期授权。

---

## 授权可见、可撤销，风险说明如实呈现 {#可见、可撤销、诚实叙述}

长期授权**双方都能查看**：所有者在 `/admin` 的 **Grants** 页签中查看；代理通过 `GET /grants` 查看*自己的*授权。每行列出代理、能力、操作动词、来源、敏感级别、信任窗口和到期时间。

- **随时撤销。** 人从 **Grants** 标签页撤销，或持 connection-key 调 `POST /grants/revoke`——按 `jti`、
  按 `(agentId, capabilityId)`，或按 `bundleId` 撤销一整个任务 bundle。agent 出示某个 token 及其 `jti`，
  可以放弃**它自己的** token。
- **叙述由网关撰写，绝非 agent 的措辞。** 人批准时读到的风险摘要出自网关之手。agent 那段可选的
  代理可以附上“为什么现在需要”的用途说明，界面会标注为 *“the agent says:”*。这段文字会经过清理和截断，不影响任何决策；代理无法伪造网关的风险摘要。
- **所有事件都会留下审计记录。** 握手、授权、令牌、调用和撤销的每个事件，包括请求分派前的*拒绝*事件，都会写入只追加的本地审计日志
  （`GET /admin/api/audit`），记录中的敏感信息会被隐去。这是尽力而为的可观测性记录，不是能验证是否遭到篡改的账本。

**徽章**是智能体长期使用的身份，也就是每个智能体各自的 PAT。**票据**是人针对一项任务事先批准的授权，其中的授权可以一并撤销。任务包是票据的 1.0 形态；为未来预留的扩展点，已在 [授权可扩展性](/zh/architecture/extensibility)（ADR-020）中写明。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)** —— 概念页介绍整体模型，本页聚焦其中的信任模型。
- **[编译模型](/zh/concepts/compile-model)** —— 启动器如何隐藏 enroll → handshake → grant → invoke 这四步交互，而网关则
  在运行时执行授权检查。
- **[安全模型](/zh/architecture/security-model)**——两种凭据、威胁模型，以及 Plexus 不防什么。
