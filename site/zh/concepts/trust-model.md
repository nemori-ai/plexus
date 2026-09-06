---
title: "信任模型"
description: "Plexus 如何决定 agent 可以调用什么：默认拒绝、来源与敏感度，以及三个时钟——grant 的信任窗口、内存中 session 的存活时间、scoped token 的有效期。execute 默认逐次（once）批准，只有所有者明确为指定 agent 与 capability 开通常驻授权，才能改变这一默认规则。"
---
# 信任模型 {#信任模型}

Plexus 处理 agent 的每一次请求时，都遵守同一条原则：**能触达网关的 agent，默认依然没有任何权限。**

本页介绍信任机制。完整的概念说明见[核心概念](/zh/concepts/)；威胁与凭据边界见[安全模型](/zh/architecture/security-model)。

---

## 默认拒绝 {#默认拒绝就是全部承诺}

能访问网关，甚至握手成功，都不等于获得调用权限。agent 使用自己的 PAT 完成握手；PAT 由一次性 enrollment code 换取，握手据此确认 agent 的真实身份。connection-key 是拥有者的管理凭据，不是 agent 的调用凭据。

握手返回 session 和该 agent 的有效授权范围内、仍对外开放的 capability 子集 manifest，其中包含条目的完整细节，但不会公开有效授权范围之外的能力。有效授权范围包括拥有者为该 agent 选择的 capability，以及拥有者为它创建、未过期且通过当前 `connection-key` epoch 校验的有效常驻授权所涵盖的 capability。取得相应的授权和 scoped token 是另一步。连接时，选中的 read 会获得常驻授权；有副作用的 write/execute 默认逐次批准。已有符合条件的常驻授权时，agent 可以在其范围内调用，不必重新请求批准。从未获得任何 capability 授权的 agent，在 `/invoke` 处会收到 `grant_required`。

权限由**人**授予：限定到具体 capability、有时限、随时可撤销。agent 不能自行取得、从其他权限推断出或宣称自己拥有这些权限。

---

## 三种不同的有效期 {#三个时钟-而非一个}

Plexus 把**你的批准能有效多久**、**agent 的一段工作能持续多久**和**单个 token 存活多久**分开处理：

![信任窗口与短时受限 token](/diagrams/two-clocks.png)

- **信任窗口（trust-window）**规定一次授权决定的有效期。批准时可以选择 `once`、`1h`、`1d`、`7d`、`until-revoked`，或自定义（`custom`）时长。对于符合常驻条件、已获批准的授权，在窗口结束或你撤销之前，agent 不必再问你。`once` 不属于可重复使用的常驻授权。

- **会话（session）**限定一段工作（episode）的持续时间。每次 handshake 创建一个会话，有效期为 **60 分钟**，只保存在内存中，网关重启即失效。`POST /invoke` 和 `POST /grants/refresh` 都要求 token 所属的会话仍然有效。会话结束后，原 token 不能再用于调用或换发。agent 必须用自己的 **PAT** 重新握手，才能建立新会话；这次握手也会留下审计记录。

- **受限 token（scoped token）**是实际调用时携带的短期 bearer token。默认有效期为 **15 分钟**（`DEFAULT_TOKEN_LIFETIME_MS`），配置范围限制在 `[1m, 60m]`。

token 到期后，agent 可以通过 `POST /grants/refresh` 换发，但原会话必须仍然有效，对应的常驻授权也必须符合换发条件，并且仍在信任窗口内。满足这些条件时，不需要 connection-key，也不再提示拥有者批准。

单枚 token 过期，并不保证被盗后的滥用随即结束。如果刷新路径仍可用，滥用可能随换发延续，但不能超过原会话的有效期。被盗的 scoped token 无法创建 PAT，也无法建立新会话。

因此，长期有效的授权决定不等于长期有效的调用凭据。信任窗口可以设为 `until-revoked`，调用和换发仍受会话与 token 的有效期约束。只有 PAT 能用于建立下一次会话。

`once` 授权是特例：只供一次使用（`expiresAt = grantedAt`），不能刷新；以后需要的批准不会因此减少。

---

## 来源的三种分类 {#来源-provenance-——三类组织轴}

![来源与默认授权方式；实际授权还受敏感度和拥有者选择约束](/diagrams/provenance-posture.png)

**来源（provenance）**说明 capability 从哪里来。它参与决定风险层级和默认授权方式，但还需要结合动词与 transport 判断，不能只看来源。

| 来源 | 含义 | 默认授权方式 |
| --- | --- | --- |
| **first-party** | 保留的进程内 source（Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Claude Code、Codex、Shortcuts、browser、browser-control、workspace、sysinfo）。 | 连接时选中的 read 获得常驻授权；write/execute 默认逐次批准。 |
| **managed** | 拥有者通过可信的 `/admin` UI 添加并审查的 source，例如通过 REST 或文件系统接入的 Obsidian vault。 | read 的默认方式与第一方相同；write/execute 默认逐次批准。 |
| **extension** | agent 经 `POST /extensions` 通过协议注册的 source，默认审查最严格。 | 任何动词都需要先由人批准；批准后能否常驻，还要看具体 capability 的条件。 |

第一方日历的 read 和 agent 注册的 shell 包装器风险不同。source 的来源由网关确定，扩展不能冒用保留的第一方 id。即使 source 属于第一方或受管来源，agent 也只能调用已获授权且已暴露的 capability。

---

## 敏感度的推导规则 {#敏感度-sensitivity-——推导出的风险层级}

网关从 `provenance + verb + transport` 推导**敏感度**层级，让 UI 和每个 agent 对同一项风险使用一致的描述：

- **low**：第一方或受管 source 上的 read。
- **elevated**：第一方或受管 source 上的 write/exec，或扩展上的 read；符合下述 high 条件的除外。
- **high**：扩展上的 write/exec，或任何使用 `cli` / `local-rest` transport 的 write/exec。

Workflow 的敏感度取所有成员中的最大值。

---

## 常驻授权的条件（ADR-5） {#常驻资格随敏感度而定-而非随出身-adr-5}

并非每项 capability 都能使用所有信任窗口。判断常驻资格需要结合敏感度及相应的授权规则，不能只看 source 的来源。符合常驻条件后，仍需拥有者实际授予授权。

- **`read`** capability 可以获得常驻授权。第一方和受管 read 的默认信任窗口为 `7d`。已有符合条件的常驻授权时，agent 可以在授权范围内继续读取，直到窗口结束或你撤销授权。
- **`write`** 默认逐次批准；拥有者可以在批准待处理请求时选择真实信任窗口，也可以通过显式直接授权使其常驻。write 的默认信任窗口为 `1d`，但这个默认值本身不会给已有 agent 授权。
- **`execute`** 默认逐次批准，上限为 `once`。高敏感度 capability 也默认逐次处理。对于 execute，无论 agent 请求多长的窗口，都不能自行改成常驻。运行代码（`claudecode.run`、`codex.run`）默认每次都需要人的新批准。

拥有者可以在连接时，为特定 agent 的特定 capability 显式开启常驻授权。execute 的这项设置默认关闭，需要双重确认；开启后才能使用真实信任窗口或 `until-revoked`。

::: danger execute 默认逐次——只有拥有者能解除
`execute` 的 `once` 上限不受 agent 所请求窗口的影响，agent 自己永远无法解除。拥有者必须在连接时，按 agent、按 capability 显式开启常驻 execute；该选项默认关闭，需要双重确认。没有这次开启，即使管理员提供了信任窗口，`execute` capability 仍然逐次批准。开启之后，授权持续到窗口结束或你撤销。
:::

execute 还有机器上的运行设置。**Real launch（真实启动）**位于控制台的 What I expose → 该源 → "Real launch"，每次切换都会留下审计记录。批准 execute 调用后，是否真正启动工具、消耗你的模型额度，由这台机器上的开关决定。默认使用记录模式，只记录演练，不实际启动工具。

exec 结果返回给调用方时会移除部分诊断信息（wire-redacted）。agent 只拿到 `ok / launched / sandboxed / output / exitCode`；沙箱目录路径、机器布局和 sandbox argv 等限制诊断信息只保留在拥有者的审计记录中。

---

## 暴露控制 {#暴露门控——拥有者的外层开关}

![暴露、发现、授权与调用的检查顺序](/diagrams/exposure-gate.png)

授权决定 agent **可以调用什么**；暴露决定拥有者允许哪些 capability 向 agent 开放，是授权之前的一层控制。

拥有者禁用某项 capability 后，它在 discovery 中不可见，也不能再获授权。invoke 会在授权检查**之前**以 `capability_unexposed` 拒绝请求。因此，有效访问必须同时满足 **已授权 ∧ 已暴露**。取消暴露后，即使仍有有效的常驻授权，也不能调用这项 capability。

---

## 查看、撤销与审计 {#可见、可撤销、诚实叙述}

拥有者和 agent 都能查看常驻授权。拥有者在 `/admin` 的 **Grants** 标签页查看全部授权；agent 通过 `GET /grants` 只能查看自己的。每条记录都包含 agent、capability、动词、来源、敏感度、信任窗口和到期时间。

- **撤销。** 拥有者可以在 **Grants** 标签页操作，或持 connection-key 调用 `POST /grants/revoke`。撤销对象可以是 `jti` 对应的 token、`(agentId, capabilityId)` 对应的授权，或 `bundleId` 对应的整个任务 bundle。agent 也可以出示自己的 token 及其 `jti`，放弃该 token；这不等于撤销该 agent 或它的全部授权。
- **风险说明。** 人批准时看到的风险摘要由网关生成，agent 无法伪造。agent 可以另附“为什么现在需要”的说明，展示时标注为 *"the agent says：（agent 说：）"*，并经过净化和截断。这段说明不参与网关的授权判定。
- **审计。** 握手、授权、token、invoke 和撤销事件，包括派发前被拒绝的请求，都会写入只追加的本地审计记录。记录可通过 `GET /admin/api/audit` 查看，其中的密钥已移除。审计只能提供尽力而为的可观测性，不能视为防篡改账本。

agent 的持久身份由每个 agent 独立的 PAT 表示。以任务为界的授权则可以在开工前批准，并作为一个整体撤销。任务 bundle 的后端机制仍然保留，但 1.0 控制台没有 bundle 管理界面，成员授权显示为普通常驻授权。后续扩展约定见[授权可扩展性](/zh/architecture/extensibility)（ADR-020）。

---

## 继续阅读 {#接下来去哪}

- **[核心概念](/zh/concepts/)**：本页涉及的完整概念说明。
- **[编译模型](/zh/concepts/compile-model)**：使用编译集成时，launcher 如何处理 enroll → handshake → grant → invoke 流程，以及网关如何在请求时执行授权检查。HTTP Floor 不要求插件，launcher 要求不适用于所有 HTTP 客户端。
- **[安全模型](/zh/architecture/security-model)**：凭据边界、威胁模型，以及 Plexus 不防范的情况。
