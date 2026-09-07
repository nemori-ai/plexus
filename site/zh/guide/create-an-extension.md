---
title: 编写一个扩展
description: 为网关补上一项它未随附的 capability：写一份 manifest，预览安全暴露面，运行时热安装。
---

# 编写并安装一个用户扩展

Plexus 随附一批第一方 source（Obsidian、Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Shortcuts、browser、browser control、Claude Code）。**用户扩展**则是*你*——或替你行事的编码 agent——为网关补充新 capability 的方式：写一份 manifest，校验通过后在运行时安装。装好之后，它无需重启即热加载，在管理 UI 中归入 **Extensions** 层级，你为哪个 agent 授权，它就出现在那个 agent 的 manifest 里，授权与调用方式和其他 capability 完全一致。

本教程用经典的 *"vault write"* 例子走完整个生命周期：

```
write manifest  →  plexus extension preview  →  plexus extension add  →  see it in /admin  →  grant + invoke
```

……随后再看 **"通过对话来编写扩展"** 这条路：让编码 agent（Codex / Claude Code）读取网关提供的*编写指南*，从一段大白话描述直接替你写出 manifest。

::: tip 前置条件
一个运行中的网关（见[快速上手](/zh/guide/)），以及 repo 随附的共享 `plexus` 管理 CLI。在 repo checkout 里以 `bun run packages/cli/src/bin/plexus <args>` 运行它——下文的 `plexus extension …` 命令正是它的简写（可设一次别名：`alias plexus="bun run <repo>/packages/cli/src/bin/plexus"`）。CLI 会自动从 `~/.plexus/connection-key` 读取 connection-key。完整的 manifest 契约见[编写指南](/zh/extensions/)，schema 参考见[规格](/zh/extensions/spec)。
:::

---

![扩展的生命周期——写 manifest、预览安全暴露面、add（你批准）、在 /admin 里看到它，然后授权并 invoke](/diagrams/extension-lifecycle.png)

## 1. 写 manifest——一个能读**也能写**的 vault

这是[编写指南](/zh/extensions/)里的完整示例：声明一个 `local-rest` source（`my-vault`），包含三个条目——**read** capability、**write** capability，和一个用法 **skill**。存为 `my-vault.json`：

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

各字段的含义（完整参考：[规格](/zh/extensions/spec)）：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `manifest` | 是 | Schema 版本，固定为字面量 `"plexus-extension/0.1"`。 |
| `source` | 是 | source id；每个条目的 id 都是 `<source>.<name>`。 |
| `label` | 是 | 供人阅读的 source 标签。 |
| `transport` | 是 | 默认 transport（`local-rest` \| `stdio` \| `ipc` \| `cli` \| `skill` \| `workflow`）。 |
| `capabilities` | 是 | 这个扩展贡献的条目（**不能为空**）。 |
| `secrets` | 否 | 密钥引用——值存放在 `~/.plexus/secrets/`，绝不写进 manifest。 |

每项 capability 包含：`name`（`<noun>.<verb>`）、`kind`（`capability` \| `skill` \| `workflow`）、`label`、`describe`（写给 agent 看的"是什么 / 何时用 / 怎么用"），以及 `grants`——它需要的动词（`read` \| `write` \| `execute`；`[]` 表示无需授权）。`io` 携带 JSON-Schema 形式的输入/输出；`route` 是对应 transport 的路由配置，只有该 transport 会读它。`local-rest` route 的 URL 路径键是 **`pathTemplate`**（规范写法；`path` 是遗留别名，也接受——优先用 `pathTemplate`）。`kind:"skill"` 条目内联一段 markdown `body`，agent 把它**当上下文读**，而不是 invoke。

于是 `my-vault` 贡献了这些 id：`my-vault.notes.read`（read）、`my-vault.notes.write`（write）、`my-vault.notes.howto`（skill）。

::: warning 密钥绝不进 manifest
manifest 只按名字*引用*密钥。先把值写进网关的只写存储：

```sh
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  -X POST "http://127.0.0.1:7077/admin/api/secrets/my-vault-key" \
  -d '{"value":"YOUR-VAULT-API-KEY"}'
```

密钥值写入 `~/.plexus/secrets/my-vault-key`（权限模式为 `0600`），**绝不会通过 HTTP 返回**。`route.baseUrl` 指向你*自己的*本地写入守护进程（本例是 `127.0.0.1:27123` 上的回环服务）；`allowedHosts` 默认将传输限制在回环地址。若要使用非回环主机，必须在 `allowedHosts` 中明确添加相应条目，并由用户确认；对该条目的确认就是审批。联邦式多主机拓扑是文档中提出的设计方向，目前仍是草案，见 [联邦 mesh](/zh/architecture/mesh)。
:::

---

## 2. `plexus extension preview`：检查扩展的权限和安全影响 {#_2-plexus-extension-preview——读它的安全暴露面}

校验清单，列出扩展涉及的*权限、访问目标等安全信息*，**不提交任何内容**：

```sh
plexus extension preview ./my-vault.json
```

```text
✓ manifest is VALID
security surface:
  source: my-vault  (My local vault)
  transport-backed: yes
  capabilities (3):
    • my-vault.notes.read  [capability · local-rest · read]  Read a note
    • my-vault.notes.write  [capability · local-rest · write]  Write a note
    • my-vault.notes.howto  [skill · skill · (none)]  How to use my-vault
  rest hosts: 127.0.0.1:27123
```

这条命令调用 `POST /admin/api/extensions/preview`，展示出来的恰好是你在信任一个扩展**之前**该仔细看的东西：

- 各项能力所需的**权限操作**（此处有 `write`，即写入）；
- 扩展可能触达的 **rest 主机**（任何**非回环**主机都是危险信号）；
- 它可能启动的**可执行程序**（此处列表为空，因此省略这一行；使用 `cli` 传输方式时会列出）；
- 有没有把本来源的技能**附加到其他来源**（这是一条向其他来源注入提示词的通道）；
- 它是否**有 transport 支撑**（触达真实服务，还是纯 skill）。

manifest 无效时，你会得到 `✗ manifest is INVALID:`、失败原因和非零退出码（`5`）——什么都不会提交。加 `--json` 拿机器可读输出；`--url` 指向非默认网关；`--key` 覆盖密钥。

---

## 3. `plexus extension add`：安装到运行中的网关 {#_3-plexus-extension-add——实时安装它}

暴露面确认无误后就可以安装。**你——用 connection-key 访问管理 API 的本地用户——就是人类批准者**，所以 CLI 直接提交扩展并留下审计记录：

```sh
plexus extension add ./my-vault.json
```

```text
✓ installed extension "my-vault" — revision 7
  registered 3 capabilities: my-vault.notes.read, my-vault.notes.write, my-vault.notes.howto
```

这会调用 `POST /admin/api/extensions`。这些标识**立即生效，无须重启网关**：它们会出现在管理界面中，可以立即授予相应权限。为某个代理授权后，它们才会出现在该代理的清单中；授权可以通过连接时选择子集，或由所有者发放长期授权。清单还会保存到 `~/.plexus/extensions.json`，在启动时重新加载，因此重启后扩展仍然保留。**只需安装一次，不必每次启动都安装**。可在终端确认并管理：

```sh
plexus extension list                 # GET  /admin/api/extensions
plexus extension remove my-vault      # DELETE /admin/api/extensions/my-vault (purges its grants)
```

::: tip agent 侧安装（无需管理密钥）
代理在*仍然有效的会话*中，也可以通过协议调用 `POST /extensions { sessionId, manifest }` 注册扩展。由于这个扩展会通过传输连接真实服务（transport-backed），这条路径会**等待人工批准**（`grant_pending_user`）：用户在 `/admin` 批准后，扩展才会启用。验收测试走的就是这条流程，见 [`tests/harnesses/acceptance/README.md`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance/README.md)
（codex 代理编写一个向 vault 写入的扩展，提交后等待批准，用户批准后再调用）。上面的 `plexus extension add` 不进入等待批准状态，因为 CLI 通过连接密钥认证，由本地用户以管理员身份安装并批准扩展，不属于代理通过协议注册的路径。
:::

---

## 4. 在管理 UI 里看它——**Extensions** 层级

打开管理 UI，进侧栏的 **Create an extension**：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Create-an-extension 视图里编写并安装扩展](/diagrams/create-extension.png)

在这里可以粘贴 manifest，点 **preview** 查看同样的安全暴露面，然后安装。已安装的扩展列在 **Installed extensions** 之下；它们的 capability 在所有列出 capability 的地方（"我暴露了什么"）都归入 **Extensions** 来源层级。Plexus 有三个来源层级——**First-party**、**Managed**、**Extensions**——并给每一项来自扩展的 capability 打上标签，让人始终知道它*由用户经由 agent 添加*：

> *Extension——由用户经由 agent 添加，所以 Plexus 总会先来问你。*

正因为有这个来源标记，代理为扩展能力申请的任何授权都要**等待人工批准**，不只是写入权限。见第 5 步。

---

## 5. 授予权限并调用扩展 {#_5-授权-invoke-这个扩展}

授权和调用方式与其他能力相同（完整步骤见 [连接一个 agent](/zh/guide/connect-an-agent)）。有三点需要注意：

- **先授权代理使用新增的能力 ID。** 代理只能使用你授权的那部分能力：你可以重新连接代理，选中新增能力，也可以在管理控制台为它授予长期权限。若它申请的能力从未获你授权，请求会直接被拒绝，不会进入待审批状态。
- **智能体请求的任何扩展授权都会进入待审批状态**，*即使只是读取*。网关对扩展来源有更高的信任要求，因此会交由人工审批：`PUT /grants` 返回 `grant_pending_user`，你在 **Approvals** 标签页中批准并指定 trust-window 后，才会签发令牌。
- **写入是双重门控的**——`my-vault.notes.write` 既带 `write` 授权，*又*来自扩展，所以 agent 请求它的授权必然挂起。

代理获准使用该能力后，在编程代理中执行一次 shell 调用就能完成整个过程（若还需申请调用授权，CLI 会显示 `grant_pending_user` 提示，并在等待你批准时持续轮询）：

```sh
plexus call my-vault.notes.write \
  --input '{"path":"Daily/2026-06-25.md","content":"# Today\nWrote this via a Plexus extension."}'
```

文件会通过*你自己的本地写入守护进程*写入你的 vault。调用的统一响应契约为：`{ id, ok, output?, error?, auditId }`（ADR-017）。

---

## "通过对话来编写一个扩展"

manifest 不必手写。Plexus **自带编写指南**，编码 agent 读到的就是那份精确契约，可以从一段大白话描述产出有效的 manifest：

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  "http://127.0.0.1:7077/admin/api/extensions/authoring-guide"
```

`GET /admin/api/extensions/authoring-guide` 会以 Markdown 格式返回编写指南，人手编写扩展也遵循同一份契约。可以按以下步骤操作：

1. 向你的 agent（Codex / Claude Code）**描述你要什么**，例如：*"添加一项 capability，向我 `127.0.0.1:27123` 上的本地 vault 守护进程写一条笔记，接收 `path` 和 `content`，用名为 `my-vault-key` 的 bearer 密钥做认证。"*
2. 代理**获取编写指南**（地址见上文），写出符合指南的 manifest，再运行 **`plexus extension preview`**，核对预览列出的操作、REST 主机和 CLI 可执行文件。代理和你都能看到扩展将获准使用的权限范围。
3. 预览检查通过后，用 **`plexus extension add`** 安装；若由代理通过 `POST /extensions` 注册，则会在 `/admin` 中**等待你批准**。

这些步骤都使用实际的预览和添加接口。正式添加前，你*或代你操作的代理*会核对预览列出的权限范围，检查扩展是否申请了超出描述的权限；新增能力 ID 只有在你授权该代理使用后才会向它开放；它申请的任何扩展调用授权都要等待人工批准。规范要求见[规格](/zh/extensions/spec)。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent)：完整的授权与调用流程，包括请求进入待审批状态后如何批准，以及使用 Codex 的逐步操作示例。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的 source，无需编写任何东西即可使用。
- [编写指南](/zh/extensions/) / [规格](/zh/extensions/spec)——完整的 manifest 契约与 schema。
