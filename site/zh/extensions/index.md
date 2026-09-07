---
title: 编写一个扩展
description: 面向 agent 的 Plexus 扩展编写契约：扩展是一个运行时注册的 connector，声明一个 source 及其贡献的 capability 条目。
---

# 编写一个 Plexus 扩展

你正在为本地 Plexus 实例编写**扩展**。扩展是一个运行时注册的 **connector**：一份 manifest，声明一个 `source` 和它贡献的 capability 条目。安装扩展只是让这些 capability *可被发现*——**不**授予任何访问权。每次安装仍由人批准，每次授权仍由人签发。

这是你（编写扩展的 agent）要遵循的精简契约。完整规范见[扩展规范](/zh/extensions/spec)。

## 1. 清单结构 {#_1-manifest-形状}

![扩展 manifest 声明 capability；网关将其物化为一个 source，并把每一项投影进各 agent 的 handshake manifest（限定在该 agent 的授权子集内）](/diagrams/extension-manifest.png)



```jsonc
{
  "manifest": "plexus-extension/0.1",
  "source": "my-tool",            // SourceId; seeds every entry id (<source>.<name>)
  "label": "My tool",
  "transport": "local-rest",      // default transport for caps that don't override
  "capabilities": [ /* ExtensionCapabilityDecl[] */ ],
  "secrets": [ /* ExtensionSecretRef[]  (optional) */ ],
  "serviceHint": { /* how to locate a local service (optional) */ }
}
```

每个 `ExtensionCapabilityDecl`：

```jsonc
{
  "name": "vault.write",          // <noun>.<verb>; full id = <source>.<name>
  "kind": "capability",           // capability | skill | workflow
  "label": "Write a vault note",
  "describe": "Write/overwrite a note at {path}. Use when the user asks to save…",
  "io": { "input": { "type": "object", "properties": { "path": {"type":"string"} } } },
  "grants": ["write"],            // verbs this cap requires: read | write | execute
  "transport": "local-rest",      // cli | local-rest | skill | workflow | stdio | ipc (no mcp)
  "route": { /* transport routing — see §3 */ }
}
```

好的 `describe` 是 agent 的相关性信号：说清它做**什么**、**何时**用、需要哪些输入。写具体——describe 含糊，agent 就发现不了这项 capability。

::: warning id 是 `<source>.<name>`——不要在 `name` 里重复 source
完整的 capability id 由网关自动加 `source` 前缀得来。source 为 `user-profile` 时，`name: "read"` 产出 id `user-profile.read`；而 `name: "user-profile.read"` 会产出重复的 `user-profile.user-profile.read`——它照样通过校验，所以这个错误是静默的。`name` 只写*不含前缀*的部分：source 下有多个名词时用 `<noun>.<verb>`（`vault.read`、`vault.write`），单一用途的 source 直接用 `<verb>`（`read`）。
:::

## 2. EntryKind（条目种类）

- **capability**：通过传输方式实现的可调用项（`cli` / `local-rest` / `ipc` / `stdio`）。
- **skill** —— 纯 markdown 使用指引，无 transport。`body: { format:"markdown", markdown }`。
- **workflow** —— 通过 `members[]` 组合已有条目（每个成员在注册后都必须可解析）。

## 3. 各传输方式对 `route` 的要求 {#_3-按-transport-的-route-要求}

`route` **只**由拥有它的 transport 读取，核心从不读。按 transport 分：

### cli（第二大 RCE 风险面）
```jsonc
"route": {
  "bin": "ls",                    // bare binary name — NO path, NO shell metacharacters
  "args": ["{dir}"],              // argv template; {placeholders} fill from io.input
  "allowedBins": ["ls"]           // user-confirmed allow-list (part of the approval surface)
}
```

### local-rest（第三大 SSRF / secret 重定向风险面）
```jsonc
"route": {
  "baseUrl": "http://127.0.0.1:27123",  // loopback by default; a non-loopback host is opt-in and
                                        // requires an explicit, user-confirmed `allowedHosts` entry
                                        // (the approval surface) — see `transport-policy.ts`
  "allowedHosts": ["127.0.0.1:27123"],  // host allow-list (part of the approval surface)
  "method": "PUT",
  "pathTemplate": "/vault/{path}",      // canonical URL path key (`path` is a legacy alias)
  "secret": { "name": "vault-key", "attach": "bearer" }  // references secrets[] by name
}
```
secret 的**值**从不出现在 manifest 里——值存放在 `~/.plexus/secrets/<name>`，由 transport 在派发时附上。

### skill / workflow
- skill：无 `route`；提供 `body`。
- workflow：不设 `route`；提供 `members[]`，填写已存在条目的 ID。跨来源挂载（skill/workflow 引用*其他*来源的条目）**默认关闭**，因为它是提示注入通道；只有明确放行并经人工确认后才能启用。

## 4. 需要人工批准的安全事项 {#_4-安全界面-人类批准的内容}

安装时，用户会看到具体的审批内容：扩展可以启动的 **cli 二进制程序**、可以访问的**非回环 rest 主机**、所有**跨来源**的 skill 挂载、每个 capability 所需的**动词**，以及扩展是否**通过传输方式实现**。申请的资源和权限应尽量少，只申请实际需要的二进制程序、主机和动词。

## 5. 安装流程

1. **获取本指南**：`GET /admin/api/extensions/authoring-guide`。
2. 把 manifest **起草**成 JSON。
3. **预览（不提交）**：`POST /admin/api/extensions/preview`，带 `{ manifest }`。读 `valid` / `reasons[]`；`valid:false` 就修正 manifest 后重新预览。把返回的 `surface`（cli 二进制 / rest 主机 / 跨源 / 动词）展示给人。
4. **安装（由人批准）**：`POST /admin/api/extensions`，带 `{ manifest }`。本地用户就是 connection-key 持有者，也就是批准人，因此这一步直接提交，并留下 `source.install` 审计。响应：`{ ok, source, registered, revision, reason? }`。
5. **移除**：`DELETE /admin/api/extensions/:source`。

::: tip 已安装的扩展在网关重启后仍在
通过管理接口安装的扩展会持久化到 `~/.plexus/extensions.json`，并在**启动时重放**。网关重启后，扩展的能力会恢复，无需重新安装。`DELETE` 或移除操作也会将扩展从这份持久化存储中删除。
:::

CLI 等价命令：`plexus extension preview|add|list|remove`。

## 6. 完整示例 —— local-rest 的 "vault write" 扩展

```jsonc
{
  "manifest": "plexus-extension/0.1",
  "source": "my-vault",
  "label": "My local vault",
  "transport": "local-rest",
  "secrets": [{ "name": "my-vault-key", "attach": "bearer" }],
  "capabilities": [
    {
      "name": "notes.read",
      "kind": "capability",
      "label": "Read a note",
      "describe": "Read the markdown of a note at {path}. Use to fetch existing note content.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] } },
      "grants": ["read"],
      "transport": "local-rest",
      "route": {
        "baseUrl": "http://127.0.0.1:27123",
        "allowedHosts": ["127.0.0.1:27123"],
        "method": "GET",
        "pathTemplate": "/vault/{path}",
        "secret": { "name": "my-vault-key", "attach": "bearer" }
      }
    },
    {
      "name": "notes.write",
      "kind": "capability",
      "label": "Write a note",
      "describe": "Create or overwrite the note at {path} with {content}. Use when saving content the user dictated.",
      "io": { "input": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } },
      "grants": ["write"],
      "transport": "local-rest",
      "route": {
        "baseUrl": "http://127.0.0.1:27123",
        "allowedHosts": ["127.0.0.1:27123"],
        "method": "PUT",
        "pathTemplate": "/vault/{path}",
        "body": "{content}",
        "secret": { "name": "my-vault-key", "attach": "bearer" }
      }
    },
    {
      "name": "notes.howto",
      "kind": "skill",
      "label": "How to use my-vault",
      "describe": "Usage guidance for my-vault.notes.read / notes.write.",
      "grants": [],
      "transport": "skill",
      "body": { "format": "markdown", "markdown": "# my-vault\nRead with `notes.read { path }`; write with `notes.write { path, content }`. Paths are relative to the vault root." }
    }
  ]
}
```

这个扩展**通过传输方式实现**（local-rest），并且**具备写入能力**，因此审批内容会列出主机 `restHosts: ["127.0.0.1:27123"]`，以及 `my-vault.notes.write` 所需的 `write` 动词。用户批准的正是这些资源和权限。

## 7. 最佳实践与自检

manifest *通过校验*，还不等于扩展**可信、好用**。以下做法能让审批它的人信得过它，也让发现它的 agent 用得上它。

### 7a. 实现健康检查

source **SHOULD** 实现**健康检查协议**，让管理面板和发现它的 agent 都能看到其能力当前是否可用：

```ts
health(): Promise<{ status: "ok" | "degraded" | "unavailable" | "unknown", detail?: string }>
```

- `ok`——可访问且正常提供服务。`degraded`——服务仍在运行，但运行状态不正常。`unavailable`——已停止运行或无法访问。
- 健康检查是**可选的**：允许不做任何操作，只报告 `unknown`。实现健康检查后，智能体就能避开不可用的源，避免在不知情的情况下发起调用而失败。
- 若未实现 `health()`，状态从 `checkRequirements()` *派生*（如二进制缺失、主机不可达）；若那里也没有信息，则退回 `"unknown"`。

健康状态要与 `source_unavailable` invoke 错误（§7b）对得上：报告 `unavailable` 的 source，其 invoke 也应以 `source_unavailable` 失败，发现与派发才一致。

### 7b. 返回精确、语义化的错误

能力调用失败时，应向调用它的 agent 返回**标准 Plexus 错误码**，并附上清楚、易读的 `message`/`detail`，不要只返回没有具体说明的 500 或含糊的字符串。准确的错误信息能帮助 agent 重试、改用其他 source，或向用户说明具体出了什么问题。

用标准错误码：`source_unavailable`、`transport_error`、`schema_validation_failed`、`grant_required`（其余见[规范](/zh/extensions/spec)）。

```jsonc
// BAD — opaque, unactionable:
{ "error": "failed" }

// GOOD — semantic code + a message the agent (or user) can act on:
{ "code": "source_unavailable",
  "message": "Obsidian REST API not reachable at 127.0.0.1:27124 — is the plugin running?" }
```

### 7c. 自检清单（安装前逐项检查） {#_7c-自检清单-安装前运行}

调用 `POST /admin/api/extensions` 前，请完成以下各项检查，确认通过后逐项勾选：

- [ ] **清单验证通过**——运行 `plexus extension preview <manifest.json>`，确认结果为 `valid:true`，并核对预览输出中**已声明的 cli 可执行文件和 rest 主机**。
- [ ] **传输可达，访问限于允许的主机**——默认允许访问回环地址（`127.0.0.1`／`localhost`）；非回环主机须显式启用，对应的 `allowedHosts` 条目属于需要用户批准的范围，必须经用户明确确认。参见 `transport-policy.ts`。确认本地服务已启动且可达。
- [ ] **secret 只按名引用** —— manifest 任何位置都不出现 secret 值。
- [ ] **能力描述准确**——每项能力都有具体的 `describe`（做什么、何时使用、需要哪些输入）和准确的 `io` 结构定义；不夸大能力的作用。
- [ ] **健康检查已实现**（或有意跳过）—— 是否实现 `health()` 由你决定；跳过没问题，但要是刻意的选择，而非疏忽（§7a）。
- [ ] **错误语义化** —— 失败返回标准错误码 + 可读消息，而非 500 或 `{error:"failed"}`（§7b）。

## 8. 合规清单

- [ ] `manifest` 为 `"plexus-extension/0.1"`；`source` 是未被保留的 id。
- [ ] 每个 capability 都有 `name`（`<noun>.<verb>`）、`kind`、`label`、具体的 `describe`、`grants`、`transport`。
- [ ] cli capability：`bin`（仅二进制名）+ `args` + `allowedBins`。local-rest capability：回环 `baseUrl` + `allowedHosts` + secret 引用。
- [ ] secret 只按**名**引用（manifest 里无值）。
- [ ] 工作流引用的都是已有成员的 id；只有明确打算跨 source 附加时，才这样做。
- [ ] 安装前已成功预览（`valid:true`）；cli-bins / rest-hosts / verbs 的审批范围限于所需的最小范围。
