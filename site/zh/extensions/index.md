---
title: 编写一个扩展
description: 面向 agent 的 Plexus 扩展编写契约：扩展是一个运行时注册的 connector，声明一个 source 及其贡献的 capability 条目。
---

# 编写一个 Plexus 扩展

你正在为本地 Plexus 实例编写**扩展**。扩展是一个运行时注册的 **connector**：一份 manifest，声明一个 `source` 和它贡献的 capability 条目。安装扩展只是让这些 capability *可被发现*——**不**授予任何访问权。每次安装仍由人批准，每次授权仍由人签发。

这是你（编写扩展的 agent）要遵循的精简契约。完整规范见[扩展规范](/zh/extensions/spec)。

## 1. Manifest 形状

![扩展 manifest 声明 capability；网关将其物化为一个 source，并把每一项投影到 .well-known floor 上](/diagrams/extension-manifest.png)



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

- **capability** —— 由 transport 背书的可调用条目（`cli` / `local-rest` / `ipc` / `stdio`）。
- **skill** —— 纯 markdown 使用指引，无 transport。`body: { format:"markdown", markdown }`。
- **workflow** —— 通过 `members[]` 组合已有条目（每个成员在注册后都必须可解析）。

## 3. 按 transport 的 `route` 要求

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
- workflow：无 `route`；`members[]` 引用已在场的条目 id。跨源附着（skill/workflow 伸进*另一个* source）默认**关闭**——它是一条提示注入通道，必须显式开启并经人确认。

## 4. 安全界面（人类批准的内容）

安装时，人看到的正是：扩展可能生成（spawn）的 **cli 二进制**、可能触达的**非回环 rest 主机**、任何**跨源** skill 附着、每个 capability 所需的**动词**、以及它是否**由 transport 背书**。把这个界面保持最小——只申请真正需要的二进制、主机和动词。

## 5. 安装流程

1. **获取本指南**：`GET /admin/api/extensions/authoring-guide`。
2. 把 manifest **起草**成 JSON。
3. **预览（不提交）**：`POST /admin/api/extensions/preview`，带 `{ manifest }`。读 `valid` / `reasons[]`；`valid:false` 就修正 manifest 后重新预览。把返回的 `surface`（cli 二进制 / rest 主机 / 跨源 / 动词）展示给人。
4. **安装（由人批准）**：`POST /admin/api/extensions`，带 `{ manifest }`。本地用户就是 connection-key 持有者，也就是批准人，因此这一步直接提交，并留下 `source.install` 审计。响应：`{ ok, source, registered, revision, reason? }`。
5. **移除**：`DELETE /admin/api/extensions/:source`。

::: tip 已安装的扩展在网关重启后仍在
管理员安装的扩展不只注册在内存里：manifest 会持久化到 `~/.plexus/extensions.json`，并**在启动时重放**，重启后 capability 依然在场，无需重装。`DELETE`/移除同样会把它从持久存储里清掉。
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

这个扩展**由 transport 背书**（local-rest）且**可写**，所以批准界面会列出 `restHosts: ["127.0.0.1:27123"]` 和 `my-vault.notes.write` 上的 `write` 动词——这正是人签字认可的内容。

## 7. 最佳实践与自检

manifest *通过校验*，不等于它是**好公民**。下面的实践让扩展对批准它的人可信、对发现它的 agent 有用。

### 7a. 实现健康检查

source **应当**实现按源的**健康协议**，让 capability 的实时可用性随时可见——既出现在管理仪表盘里，也告知发现它的 agent：

```ts
health(): Promise<{ status: "ok" | "degraded" | "unavailable" | "unknown", detail?: string }>
```

- `ok` —— 可达且在服务。`degraded` —— 在运行但受损。`unavailable` —— 宕机或不可达。
- 健康检查是**可选的**：允许空实现，只是状态会一直报 `unknown`。实现它才算好公民——agent 可以绕开不可用的 source，而不是盲目发起一次注定失败的 invoke。
- 若未实现 `health()`，状态从 `checkRequirements()` *派生*（如二进制缺失、主机不可达）；若那里也没有信息，则退回 `"unknown"`。

健康状态要与 `source_unavailable` invoke 错误（§7b）对得上：报告 `unavailable` 的 source，其 invoke 也应以 `source_unavailable` 失败，发现与派发才一致。

### 7b. 返回精确、语义化的错误

capability 失败时，给调用方 agent 一个**标准 Plexus 错误码**，加一条清晰、人类可读的 `message`/`detail`——不要甩一个不透明的 500 或一句含糊的字符串。错误精确，agent 才能恢复（重试、换一个 source），或准确告诉用户哪里出了问题。

用标准错误码：`source_unavailable`、`transport_error`、`schema_validation_failed`、`grant_required`（其余见[规范](/zh/extensions/spec)）。

```jsonc
// BAD — opaque, unactionable:
{ "error": "failed" }

// GOOD — semantic code + a message the agent (or user) can act on:
{ "code": "source_unavailable",
  "message": "Obsidian REST API not reachable at 127.0.0.1:27124 — is the plugin running?" }
```

### 7c. 自检清单（安装前运行）

`POST /admin/api/extensions` 之前，逐项勾掉：

- [ ] **Manifest 通过校验** —— 运行 `plexus extension preview <manifest.json>`，确认 `valid:true`。审阅打印出的**安全界面**（声明的 cli 二进制 / rest 主机）。
- [ ] **Transport 可达、主机受限** —— 回环（`127.0.0.1`/`localhost`）默认允许；非回环主机需显式开启，并要求一条经用户确认的 `allowedHosts` 条目（即批准界面）——见 `transport-policy.ts`。本地服务确实在运行。
- [ ] **secret 只按名引用** —— manifest 任何位置都不出现 secret 值。
- [ ] **capability 诚实** —— 每个条目都有具体的 `describe`（什么 / 何时 / 输入）和准确的 `io` schema；没有夸大它能做的事。
- [ ] **健康检查已实现**（或有意跳过）—— 是否实现 `health()` 由你决定；跳过没问题，但要是刻意的选择，而非疏忽（§7a）。
- [ ] **错误语义化** —— 失败返回标准错误码 + 可读消息，而非 500 或 `{error:"failed"}`（§7b）。

## 8. 合规清单

- [ ] `manifest` 为 `"plexus-extension/0.1"`；`source` 是未被保留的 id。
- [ ] 每个 capability 都有 `name`（`<noun>.<verb>`）、`kind`、`label`、具体的 `describe`、`grants`、`transport`。
- [ ] cli capability：`bin`（仅二进制名）+ `args` + `allowedBins`。local-rest capability：回环 `baseUrl` + `allowedHosts` + secret 引用。
- [ ] secret 只按**名**引用（manifest 里无值）。
- [ ] workflow 引用在场的成员 id；跨源附着只在显式有此意图时使用。
- [ ] 安装前已预览（`valid:true`）；cli 二进制 / rest 主机 / 动词界面保持最小。
