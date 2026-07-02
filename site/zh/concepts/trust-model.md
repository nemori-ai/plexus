---
title: 信任模型
description: 默认拒绝、两个时钟、来源与敏感度、以及 execute 永不常驻规则——Plexus 如何决定一个 agent 可以调用什么。
---

# 信任模型

这是对那一个统辖 Plexus 处理 agent 每一次请求之一切的想法的一段专注阅读：**一个能触达网关的 agent，默认仍然
没有任何权限。** 想在语境里看整个心智模型，先读[核心概念](/zh/concepts/)；本页只对信任机制做深入。想看对抗
视角和凭据边界，见[安全模型](/zh/architecture/security-model)。

---

## 默认拒绝就是全部承诺

触达网关——哪怕成功握手——只换来一个 agent 对"存在什么"的*知识*，而绝不换来调用任何东西的权利。一次成功的
握手授予完整 manifest，且*别无所授*。一个从未被授予任何 capability 的 agent，会在 `/invoke` 处以 `grant_required`
被拒绝。

权限是由一个**人**来授予的：范围限定到具体 capability、有时限、且随时可撤销。它绝不是 agent 能夺取、推断、或
自称的东西。

---

## 两个时钟，而非一个

Plexus 刻意把**你的批准能常驻多久**与**单个 token 存活多久**分开：

![两个时钟 — 信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**——*你这个决定*的存活期。当你批准一次授权时，你选一个窗口：`once`、`1h`、`1d`、
  `7d`、`until-revoked`，或一个 `custom` 时长。在那个窗口结束（或你撤销）之前，agent 不必再问。这就是
  **常驻授权**。

- **受限 token（scoped token）**——**爆炸半径**。每一次实际调用都携带一个短寿命的 bearer token，默认 **15 分钟**
  （`DEFAULT_TOKEN_LIFETIME_MS`，钳制在 `[1m, 60m]`）。它过期时，只要信任窗口还立着，agent 就通过
  `POST /grants/refresh` 从常驻授权那里悄无声息地重铸一个新的——**无需 connection-key，无需再提示**。因此一个
  泄漏的 token 在几分钟内就一文不值，哪怕常驻授权还持续着。

一个 `once` 授权是特殊的：它恰好为一次使用而立（`expiresAt = grantedAt`），无法刷新，也永远不会短路掉一次未来的
批准。

---

## 来源（provenance）——三类组织轴

驱动 Plexus 对一项 capability 有多谨慎的那个唯一事实，是它的**来源**——这项 capability 从哪来。信任随出身而定。

| 来源 | 含义 | 默认姿态 |
| --- | --- | --- |
| **first-party** | 一个保留的、进程内的 source（Apple Calendar/Reminders、Obsidian 文件系统、cc-master）。 | read 顺畅流过；write/execute 仍然要问人。 |
| **managed** | 一个*你*通过可信的 `/admin` UI 添加的 source（例如一个 Obsidian REST vault）。在添加时经人类审查。 | 共享第一方的 **read** 姿态；write/exec 仍挂起等一个人。 |
| **extension** | 由一个 *agent* 经 `POST /extensions` 在 wire 上注册。最严格的一类。 | **任何**动词都挂起等一个人。 |

一次第一方日历 read 和一个 agent 注册的 shell 包装器不是同一种风险，Plexus 从不假装它们是。网关从 source 处
*盖上*来源印记——一个扩展无法冒充一个第一方 id（那些 id 是保留的）。

---

## 敏感度（sensitivity）——推导出的风险层级

从 `provenance + verb + transport`，网关算出一个**敏感度**层级，纯粹是为了诚实的叙述（好让 UI 和每个 agent
描述同一种风险）：

- **low**——第一方 / 受管上的 read。
- **elevated**——第一方 / 受管上的 write/exec，*或*一个扩展上的 read。
- **high**——一个扩展上的 write/exec，*或*任何带 write/exec 的 `cli` / `local-rest` transport。

Workflow 会把其成员的敏感度上卷（取最大值）。

---

## 常驻资格随敏感度而定，而非随出身（ADR-5）

不是每个窗口都对每项 capability 可供选择。**一次授权究竟能不能*常驻*，是由该 capability 自身的敏感度决定的**
——由 `provenance × verb` 推导而来——而绝不由它从哪来决定：

- 一项 **`read`** capability 可以常驻：一旦批准它就取一个真实窗口（第一方/受管默认 `7d`；`write` 默认 `1d`），
  于是后续在范围内的 read 直到窗口结束或你撤销之前都毫无摩擦。
- 一项 **`execute`**（或另有**高敏感度**）capability **永远不能**常驻。它是**每次使用**都批准，上限为 `once`
  ——*即便一个管理员提供了一个更长的信任窗口*。运行代码（`claudecode.run`、`codex.run`）正是那种其敏感度确实
  要求每次都做一个新鲜人类决定的情形，所以它永远不搭 `7d`/`until-revoked` 窗口。

::: danger execute 永不常驻的上限是结构性的
一个拥有者**无法**把一项 `execute` capability 变成常驻——那道 `once` 上限即便在管理员提供的信任窗口下也照样
成立。`read` cap 可以携带一个真实的常驻窗口（1d/7d）；`execute` 永远不会。常驻这回事是*capability* 的一个属性，
而不是 agent——甚至管理员——能为一项危险的 cap 覆盖掉的选择。
:::

---

## 暴露门控——拥有者的外层开关

授权决定一个 agent *可以*调用什么；**暴露（我暴露什么）是拥有者摆在它们前面的外层门控**。一项被拥有者禁用的
capability 在 discovery 里不可见、不可授权，并在 invoke 时以 `capability_unexposed` 被拒绝——这在授权检查
**之前**强制执行。所以有效访问 = **已授权 ∧ 已暴露**：撤销暴露会切断一项 capability，无论存在什么常驻授权。

---

## 可见、可撤销、诚实叙述

常驻授权是一等公民，且**从两侧都可见**：拥有者在 `/admin` 的 **Grants** 标签页里看到它们；agent 在 `GET /grants`
看到*它自己*的。每一行都携带 agent、capability、动词、来源、敏感度、信任窗口、以及到期时间。

- **随时撤销。** 一个人从 **Grants** 标签页撤销，或用 connection-key 经 `POST /grants/revoke` 撤销——按 `jti`、
  按 `(agentId, capabilityId)`、或按 `bundleId` 撤销一整个任务 bundle。一个 agent 可以通过出示某个 token 及其
  `jti` 来放弃**它自己的** token。
- **叙述由网关撰写，绝非 agent 的措辞。** 人类批准的那份风险摘要是由网关撰写的。agent 那段可选的"为什么是现在"
  目的会被标注为*"the agent says：（agent 说：）"*来展示，会被净化和截断，且不影响任何决定。agent 永远无法伪造
  那份风险摘要。
- **一切都被审计。** 每一次握手、授权、token、invoke 和撤销——包括派发前的*拒绝*——都被记录到一份只追加的
  本地审计轨迹里（`GET /admin/api/audit`），密钥被抹除。把它当作尽力而为的可观测性，而非一份防篡改账本。

---

## 接下来去哪

- **[读一遍就通](/zh/concepts/)**——本页所放大的那份完整心智模型。
- **[编译模型](/zh/concepts/compile-model)**——launcher 如何隐藏 enroll → handshake → grant → invoke 这条链，
  同时网关实时强制授权。
- **[安全模型](/zh/architecture/security-model)**——两种凭据、威胁模型、以及 Plexus 不防范什么。
