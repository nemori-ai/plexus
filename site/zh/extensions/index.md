---
title: 编写一个扩展
description: 编写 Plexus 扩展的、简洁的、面向 agent 的契约——一个运行时注册的连接器，它声明一个源以及它贡献的 capability 条目。
---

# 编写一个 Plexus 扩展

你正在为一个本地 Plexus 实例编写一个**扩展**。一个扩展是一个运行时注册的**连接器**：一份声明了一个 `source` 及它贡献的 capability 条目的 manifest。安装它会让那些 capability *可被发现*——它**不**授予访问权。人类仍然批准每一次安装、签发每一次授权。

这是你（编写方 agent）遵循的简洁契约。完整规范是[扩展规范](/zh/extensions/spec)。

## 1. Manifest 形状



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

每一个 `ExtensionCapabilityDecl`：

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

一个好的 `describe` 是那个 agent 相关性信号——说清它做**什么**、**何时**用它、并点名输入。要具体；含糊的 describe 会让 capability 无从被发现。

::: warning id 是 `<source>.<name>`——不要在 `name` 里重复 source
完整的 capability id 由自动前缀 `source` 组成。所以对 `source: "user-profile"`，一个 `name: "read"` 产出 id `user-profile.read`——而 `name: "user-profile.read"` 产出那个重复、丑陋的 `user-profile.user-profile.read`（它仍然通过校验，所以这个错误是静默的）。把 `name` 挑成那个*无前缀*的部分：当源分组了几个名词时用 `<noun>.<verb>`（`vault.read`、`vault.write`），或对一个单一用途的源用一个裸 `<verb>`（`read`）。
:::

## 2. EntryKind（条目种类）

- **capability** —— 一个由 transport 背书的可调用体（`cli` / `local-rest` / `ipc` / `stdio`）。
- **skill** —— 纯 markdown 使用指引，无 transport。`body: { format:"markdown", markdown }`。
- **workflow** —— 经 `members[]` 组合已有条目（每个都必须在注册后可解析）。

## 3. 按 transport 的 `route` 要求

`route` **只**被拥有它的 transport 读，绝不被核心读。按 transport：

### cli（第 2 大 RCE 界面）
```jsonc
"route": {
  "bin": "ls",                    // bare binary name — NO path, NO shell metacharacters
  "args": ["{dir}"],              // argv template; {placeholders} fill from io.input
  "allowedBins": ["ls"]           // user-confirmed allow-list (part of the approval surface)
}
```

### local-rest（第 3 大 SSRF / secret 重定向界面）
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
secret 的**值**从不出现在 manifest 里——它住在 `~/.plexus/secrets/<name>` 之下，由 transport 在派发时附上。

### skill / workflow
- skill：无 `route`；提供 `body`。
- workflow：无 `route`；提供引用在场条目 id 的 `members[]`。跨源附着（一个 skill/workflow 伸进*另一个*源）默认**关闭**——它是一个提示注入通道，必须被显式门控 + 人类确认。

## 4. 安全界面（人类批准的东西）

当你安装时，人类看到的恰是：该扩展可能生成（spawn）的 **cli 二进制**、它可能触达的**非环回 rest 主机**、任何**跨源** skill 附着、每个 capability 所需的**动词**、以及它是否**由 transport 背书**。把界面保持最小——只请求你真正需要的 bin/主机/动词。

## 5. 安装流程

1. **取回本指南**：`GET /admin/api/extensions/authoring-guide`。
2. 把 manifest **起草**为 JSON。
3. **预览（不提交）**：`POST /admin/api/extensions/preview`，带 `{ manifest }`。读 `valid` / `reasons[]`；若 `valid:false`，修正 manifest 并重新预览。把返回的 `surface`（cli 二进制 / rest 主机 / 跨源 / 动词）展示给人类。
4. **安装（人类批准）**：`POST /admin/api/extensions`，带 `{ manifest }`。本地用户就是 connection-key 持有者 = 那个人类批准者，因此这会直接提交并审计 `source.install`。响应：`{ ok, source, registered, revision, reason? }`。
5. **移除**：`DELETE /admin/api/extensions/:source`。

::: tip 已安装的扩展在网关重启后存续
一个管理员安装的扩展不只是注册在内存里——manifest 被持久化到 `~/.plexus/extensions.json` 并**在启动时重放**，因此它的 capability 在一次重启后还在，无需重新安装。`DELETE`/移除也会把它从那个持久存储里丢掉。
:::

CLI 等价物：`plexus extension preview|add|list|remove`。

## 6. 完整示例 —— 一个 local-rest 的 "vault write" 扩展

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

这个扩展**由 transport 背书**（local-rest）且**可写**，因此它的批准界面列出 `restHosts: ["127.0.0.1:27123"]` 和 `my-vault.notes.write` 上的 `write` 动词——恰是人类签字认可的东西。

## 7. 最佳实践与自检

一份*通过校验*的 manifest 与一份是**好公民**的 manifest 不是一回事。以下这些实践让你的扩展对批准它的人类可信、对发现它的 agent 有用。

### 7a. 实现健康检查

一个源**应当**实现按源的**健康协议**，好让它的 capability 的实时可用性被浮现出来——既在管理仪表盘里，也向发现它的 agent：

```ts
health(): Promise<{ status: "ok" | "degraded" | "unavailable" | "unknown", detail?: string }>
```

- `ok` —— 可达且在服务。`degraded` —— 起来了但受损。`unavailable` —— 宕机/不可达。
- 它是**可选的**：允许一个空操作，你只会报告 `unknown`。但实现它让你的扩展成为好公民——agent 可以绕开一个不可用的源，而非盲目地让一次 invoke 失败。
- 若 `health()` **缺席**，状态从 `checkRequirements()` *派生*（如缺失二进制 / 不可达主机）——而若那也什么都不说，则退回到 `"unknown"`。

健康与 `source_unavailable` invoke 错误（§7b）相互对账：一个报告 `unavailable` 的源也应该让 invoke 以 `source_unavailable` 失败，好让发现与派发一致。

### 7b. 返回精确、语义化的错误

当一个 capability 失败时，喂给调用 agent 一个**标准 Plexus 错误码**外加一条清晰、人类可读的 `message`/`detail`——绝不是一个不透明的 500 或一个含糊的字符串。一个精确的错误让 agent 恢复（重试、另选一个源）或准确地告诉用户哪里出了错。

用那些标准码：`source_unavailable`、`transport_error`、`schema_validation_failed`、`grant_required`（以及[规范](/zh/extensions/spec)里的其他）。

```jsonc
// BAD — opaque, unactionable:
{ "error": "failed" }

// GOOD — semantic code + a message the agent (or user) can act on:
{ "code": "source_unavailable",
  "message": "Obsidian REST API not reachable at 127.0.0.1:27124 — is the plugin running?" }
```

### 7c. 自检清单（安装前运行）

在你 `POST /admin/api/extensions` 之前，逐一勾掉这些：

- [ ] **Manifest 通过校验** —— 运行 `plexus extension preview <manifest.json>` 并确认 `valid:true`。审阅打印出的**安全界面**（声明的 cli 二进制 / rest 主机）。
- [ ] **Transport 可达且主机受限** —— 环回（`127.0.0.1`/`localhost`）默认允许；一个非环回主机是可选启用的，且需要一条显式的、经用户确认的 `allowedHosts` 条目（那个批准界面）——见 `transport-policy.ts`。本地服务确实起着。
- [ ] **secret 仅按名引用** —— manifest 里任何地方都没有 secret 的值。
- [ ] **capability 是诚实的** —— 每一个都有一个具体的 `describe`（什么/何时/输入）和一个准确的 `io` schema；你没有夸大一个 cap 的作为。
- [ ] **健康已实现**（或有意识地跳过）—— 你已决定是否实现 `health()`；跳过它没问题，但它是一个刻意的选择，而非一次疏忽（§7a）。
- [ ] **错误是语义化的** —— 失败返回一个标准码 + 可读消息，而非一个 500 或 `{error:"failed"}`（§7b）。

## 8. 合规清单

- [ ] `manifest` 是 `"plexus-extension/0.1"`；`source` 是一个非保留的 id。
- [ ] 每个 cap 都有 `name`（`<noun>.<verb>`）、`kind`、`label`、一个具体的 `describe`、`grants`、`transport`。
- [ ] cli cap：裸 `bin` + `args` + `allowedBins`。local-rest cap：环回 `baseUrl` + `allowedHosts` + secret 引用。
- [ ] secret 仅按**名**引用（manifest 里无值）。
- [ ] workflow 引用在场的成员 id；跨源附着仅在显式意图时才用。
- [ ] 安装前已预览（`valid:true`）；最小的 cli-二进制 / rest-主机 / 动词界面。
