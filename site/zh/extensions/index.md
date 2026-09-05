---
title: "编写扩展"
description: "面向 agent 的 Plexus 扩展编写契约：扩展是在运行时注册的 connector，声明一个 source 及其贡献的 capability 条目。扩展不能自行声明保留的第一方身份。"
---
# 编写一个 Plexus 扩展 {#编写一个-plexus-扩展}

为本地 Plexus 实例添加能力，需要提交一份 manifest，声明一个 `source` 和它贡献的 capability 条目。这就是扩展：一个在运行时注册的 connector。下面是编写扩展的 agent 要遵循的精简契约，完整要求见[扩展规范](/zh/extensions/spec)。

先分清安装和调用。**安装扩展只是让这些 capability 可被发现，不授予任何访问权。** 每次安装仍须人批准，调用所需的授权也仍由人签发，不能拿安装批准代替调用许可。不过，由人批准不等于每次调用都要重新弹出提示：已有符合条件的常驻授权，仍然可以使用。

## 1. Manifest 的结构 {#_1-manifest-形状}

manifest 声明能力，网关据此建立 source，再将条目投影到各 agent 的 handshake manifest 中。每个 agent 看到的仍限于它的授权子集，不是扩展声明的全部能力。

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

`source` 是 SourceId，也是每个条目 id 的前缀。顶层 `transport` 给出默认传输方式；某项 capability 没有自行覆盖时，就用这个值。`capabilities` 放各项声明；`secrets` 是可选的密钥引用，`serviceHint` 也是可选项，用来说明如何找到本地服务。

每个 `ExtensionCapabilityDecl` 按下面的形状声明：

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

`io` 声明输入结构，这里的例子包含字符串字段 `path`。`grants` 写这项能力需要的动词：`read`、`write` 或 `execute`。

`describe` 则要让 agent 判断这项能力是否相关。说清它做什么、何时用、需要哪些输入。这里值得写具体：描述含糊，agent 就发现不了这项 capability。

::: warning id 是 `<source>.<name>`——不要在 `name` 里重复 source
网关会自动给 `name` 加上 `source` 前缀，形成完整的 capability id。比如 `source` 是 `user-profile`，`name: "read"` 得到的就是 `user-profile.read`。若写成 `name: "user-profile.read"`，结果会变成 `user-profile.user-profile.read`。这个重复的 id 照样通过校验，错误不会得到提示。

`name` 只写不含前缀的部分。一个 source 下有多个名词时，用 `<noun>.<verb>`，如 `vault.read`、`vault.write`；单一用途的 source 直接用 `<verb>`，如 `read`。
:::


## 2. EntryKind（条目种类） {#_2-entrykind-条目种类}

- **capability**：经 transport 调用的条目，这份扩展声明契约支持 `cli` / `local-rest` / `ipc` / `stdio`。
- **skill**：只提供 Markdown 使用指引，不经 transport 执行。内容写在 `body: { format:"markdown", markdown }` 中。
- **workflow**：用 `members[]` 组合已有条目。注册时要解析成员引用，注册完成后，每个成员都必须能解析到对应条目。

## 3. 按 transport 的 `route` 要求 {#_3-按-transport-的-route-要求}

`route` **只由拥有它的 transport 读取，核心从不读**。因此，路由字段按对应 transport 的要求填写。

### cli（第二大 RCE 风险面） {#cli-第二大-rce-风险面}

`bin` 只能写裸二进制名称，不能带路径或 shell 元字符。`args` 是 argv 模板，其中的占位符从 `io.input` 取值替换。`allowedBins` 是允许执行的二进制名单，属于审批内容，须经用户确认。

```jsonc
"route": {
  "bin": "ls",                    // bare binary name — NO path, NO shell metacharacters
  "args": ["{dir}"],              // argv template; {placeholders} fill from io.input
  "allowedBins": ["ls"]           // user-confirmed allow-list (part of the approval surface)
}
```

### local-rest（第三大 SSRF / secret 重定向风险面） {#local-rest-第三大-ssrf-secret-重定向风险面}

`baseUrl` 默认限于 loopback。要使用非 loopback 主机，必须显式选择，并在 `allowedHosts` 中加入经用户明确确认的条目；这份主机允许名单也属于审批内容，具体规则见 `transport-policy.ts`。URL 路径使用 `pathTemplate`，旧字段 `path` 仍作为别名保留。

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

这里用 `PUT` 请求 `/vault/{path}`，`secret.name` 按名称引用 `secrets[]`，`attach: "bearer"` 指定附加方式。secret 的**值从不写进 manifest**，而是存放在 `~/.plexus/secrets/<name>`，由 transport 在派发时附上。

### skill / workflow {#skill-workflow}

- `skill`：不提供 `route`，只提供 `body`。
- `workflow`：不提供 `route`，由 `members[]` 引用已在场的条目 id。跨源附着，也就是 `skill` / `workflow` 伸进另一个 source，默认**关闭**。这是一条提示注入通道，必须显式开启，并经人确认。


## 4. 安全界面：人要批准什么 {#_4-安全界面-人类批准的内容}

声明写完后，拥有者要审查的是扩展实际申请的范围：可能生成（spawn）的 cli 二进制、可能触达的非回环 rest 主机、任何跨源 skill 附着、每个 capability 所需的动词，以及它是否由 transport 背书。

这份界面应当尽量小。只申请真正需要的二进制、主机和动词，让人能看清扩展要做什么，再决定是否安装。

## 5. 安装流程 {#_5-安装流程}

下面的管理请求使用 connection-key，它是拥有者的管理凭据，不是 agent 的凭据。直接提交安装请求，表达的是拥有者的批准，并不意味着 agent 可以自行安装；安装批准也不代替调用所需的授权。

1. **获取指南**：请求 `GET /admin/api/extensions/authoring-guide`，取得本指南。
2. **起草声明**：把 manifest 写成 JSON。
3. **先预览，不提交**：向 `POST /admin/api/extensions/preview` 发送 `{ manifest }`。检查返回的 `valid` 和 `reasons[]`；若为 `valid:false`，按原因修正 manifest，再次预览。把返回的 `surface` 展示给拥有者审查，其中包括 cli 二进制、rest 主机、跨源附着和动词。
4. **由人批准安装**：向 `POST /admin/api/extensions` 发送 `{ manifest }`。本地用户是 connection-key 持有者，也就是批准人，因此由其直接提交，留下 `source.install` 审计记录。响应形状为 `{ ok, source, registered, revision, reason? }`。
5. **移除扩展**：请求 `DELETE /admin/api/extensions/:source`。

::: tip 已安装的扩展在网关重启后仍在
管理员安装的扩展不只注册在内存里。manifest 会持久化到 `~/.plexus/extensions.json`，并在启动时重放；网关重启后，capability 依然在场，无需重装。通过 `DELETE` 移除扩展时，也会将它从持久存储里清掉。
:::

CLI 的等价命令是 `plexus extension preview|add|list|remove`。无论通过 API 还是 CLI 安装，都先把声明拿来预览，再由拥有者审查并提交。下面用一个具体扩展走一遍。


## 6. 完整示例：用 local-rest 读写 vault {#_6-完整示例-——-local-rest-的-vault-write-扩展}

这份 manifest 声明了两个可调用条目：`notes.read` 读取已有笔记的 Markdown，`notes.write` 创建或覆盖笔记。另一个条目 `notes.howto` 是使用指引，不执行请求。

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

读取时必须提供字符串 `path`；写入时还必须提供字符串 `content`，它会作为 `PUT` 请求的正文。两个请求都发往同一个本地服务，并引用 `my-vault-key`，以 `bearer` 方式附上密钥。使用指引说明了两种调用的参数，也明确了路径相对于 vault 根目录。

这个扩展由 `local-rest` transport 背书，而且可以写入。因此，批准界面会列出 `restHosts: ["127.0.0.1:27123"]`，以及 `my-vault.notes.write` 所需的 `write` 动词。拥有者批准安装时，认可的就是这里列出的主机和操作范围；这份安装批准本身不授予 agent 调用权限。


## 7. 最佳实践与自检 {#_7-最佳实践与自检}

扩展注册成功后，agent 还需要知道它现在能不能用；调用失败时，也需要知道失败在哪里。manifest 通过校验，不等于它是好公民。把这两件事交代清楚，扩展才对批准它的人可信，对发现它的 agent 有用。

### 7a. 实现健康检查 {#_7a-实现健康检查}

source 应当实现按源的健康协议，让 capability 的实时可用性既出现在管理仪表盘里，也告知发现它的 agent。协议签名如下：

```ts
health(): Promise<{ status: "ok" | "degraded" | "unavailable" | "unknown", detail?: string }>
```

`ok` —— 可达且在服务。`degraded` —— 在运行但受损。`unavailable` —— 宕机或不可达。`unknown` 表示没有可用的状态信息，不能把它当作服务正常。

健康检查是可选的，允许空实现。未实现 `health()` 时，状态会从 `checkRequirements()` 派生，例如二进制缺失、主机不可达；若那里也没有信息，才退回 `"unknown"`。空实现不提供健康信息，在上述派生途径也没有信息的情况下，状态就会一直报 `unknown`。

实现健康检查的用处在发现阶段就能体现：agent 可以据此绕开不可用的 source，省去一次注定失败的 invoke。不过，发现时的状态与派发时的错误也要对得上。报告 `unavailable` 的 source，其 invoke 也应以 `source_unavailable` 失败（§7b），不能在一处明确说不可用，到了另一处却只留下含糊的失败信息。

### 7b. 返回精确、语义化的错误 {#_7b-返回精确、语义化的错误}

capability 失败时，应向调用方 agent 返回标准 Plexus 错误码，并附上一条清晰、人类可读的 `message`/`detail`。不要只返回不透明的 500，或一句不知道指向什么的字符串。错误码说明失败的类别，文字说明这次具体出了什么问题，两者都要有。

用标准错误码：`source_unavailable`、`transport_error`、`schema_validation_failed`、`grant_required`（其余见[规范](/zh/extensions/spec)）。

```jsonc
// BAD — opaque, unactionable:
{ "error": "failed" }

// GOOD — semantic code + a message the agent (or user) can act on:
{ "code": "source_unavailable",
  "message": "Obsidian REST API not reachable at 127.0.0.1:27124 — is the plugin running?" }
```

后一种写法不只说“失败了”，还指出无法到达哪个服务，并给出检查插件是否运行的线索。agent 因而有依据判断如何恢复，例如是否重试、是否换一个 source；无法恢复时，也能准确告诉用户哪里出了问题。错误信息提供的是判断依据，重试能否成功仍取决于故障本身。

校验通过解决的是 manifest 是否符合声明契约，运行质量还要看发现和失败时交出了什么信息。一个已注册的扩展若始终不报告可用性，失败后又只返回 `failed`，调用方依然无从判断该怎么办。这些信息是否清楚、彼此一致，需要在扩展的实际行为中落实，不能由声明通过校验来代替。


### 7c. 安装前自检 {#_7c-自检清单-安装前运行}

提交 `POST /admin/api/extensions` 之前，逐项检查：

- [ ] Manifest 通过校验：运行 `plexus extension preview <manifest.json>`，确认 `valid:true`，并审阅打印出的安全界面，包括声明的 cli 二进制和 rest 主机。

- [ ] Transport 可达，主机范围受限：回环（`127.0.0.1`/`localhost`）默认允许；非回环主机须显式开启，并有一条经用户确认的 `allowedHosts` 条目，纳入批准界面。规则见 `transport-policy.ts`。确认本地服务确实在运行。

- [ ] secret 只按名引用：manifest 的任何位置都没有写入 secret 值。

- [ ] capability 如实描述：每项 `describe` 都说清做什么、何时用、需要什么输入，`io` schema 准确，没有夸大能力。

- [ ] 健康检查已有安排：是否实现 `health()` 由你决定；可以跳过，但应是有意选择，而非遗漏（§7a）。

- [ ] 失败有明确语义：返回标准错误码和可读消息，不是只给一个 500 或 `{error:"failed"}`（§7b）。

## 8. 声明合规清单 {#_8-合规清单}

- [ ] `manifest` 为 `"plexus-extension/0.1"`；`source` 使用非保留 id。

- [ ] 每个 capability 都有 `name`、`kind`、`label`、具体的 `describe`、`grants`、`transport`。`name` 不重复 source 前缀；多名词用 `<noun>.<verb>`，单一用途的 source 可直接用 `<verb>`。

- [ ] cli capability 提供 `bin`（仅二进制名）、`args` 和 `allowedBins`；local-rest capability 提供 `baseUrl`、`allowedHosts` 和 secret 引用。`baseUrl` 默认限于回环；非回环主机须显式开启，并列入经用户确认的 `allowedHosts`。

- [ ] secret 只按名引用，manifest 中没有密钥值。

- [ ] workflow 引用已在场的成员 id；跨源附着只在确有此意图、显式开启且经人确认后使用。

- [ ] 安装前已预览，结果为 `valid:true`；cli 二进制、rest 主机和动词的申请范围保持最小。
