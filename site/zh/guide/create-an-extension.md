---
title: 编写一个扩展
description: 为网关补上一项它未随附的 capability：写一份 manifest，预览安全暴露面，运行时热安装。
---

# 编写并安装一个用户扩展

Plexus 随附一批第一方 source（Obsidian、Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Shortcuts、browser、Claude Code）。**用户扩展**则是*你*——或替你行事的编码 agent——为网关补充新 capability 的方式：写一份 manifest，校验通过后在运行时安装。装好之后，它无需重启即热加载，在管理 UI 中归入 **Extensions** 层级，你为哪个 agent 授权，它就出现在那个 agent 的 manifest 里，授权与调用方式和其他 capability 完全一致。

本教程用经典的 *"vault write"* 例子走完整个生命周期：

```
write manifest  →  plexus extension preview  →  plexus extension add  →  see it in /admin  →  grant + invoke
```

……随后再看**"通过对话来编写扩展"**这条路：让编码 agent（Codex / Claude Code）读取网关提供的*编写指南*，从一段大白话描述直接替你写出 manifest。

::: tip 前置条件
一个运行中的网关（见[快速上手](/zh/guide/)），以及可用的 `plexus` CLI。CLI 会自动从 `~/.plexus/connection-key` 读取 connection-key。如果你已接入 Codex/CC，`plexus` 已在 PATH 上；否则用 `bun run packages/cli/src/bin/plexus <args>` 直接运行共享 CLI。完整的 manifest 契约见[编写指南](/zh/extensions/)，schema 参考见[规格](/zh/extensions/spec)。
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

值落在 `~/.plexus/secrets/my-vault-key`（权限 `0600`），**绝不**通过 HTTP 返回。`route.baseUrl` 指向*你自己的*本地写入守护进程（此例是 `127.0.0.1:27123` 上的回环服务）；`allowedHosts` 默认把 transport 锁定在回环上——非回环主机属于可选项，必须写成明确的 `allowedHosts` 条目并经用户确认，这条条目就是获批准的暴露面。联邦式多主机拓扑是有文档记录的设计方向（草案）——见[联邦 mesh](/zh/architecture/mesh)。
:::

---

## 2. `plexus extension preview`——读它的安全暴露面

在*不提交任何东西*的前提下校验 manifest，并投影出它的**安全暴露面**：

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

- 每项 capability 需要的**动词**（这里有一个 `write`）；
- 扩展可能触达的 **rest 主机**（任何**非回环**主机都是危险信号）；
- 它可能 spawn 的 **cli 二进制**（这里为空，所以整行省略——`cli` transport 会把它们列出来）；
- **跨 source** 的 skill 附着（通往其他 source 的 prompt-injection 通道）；
- 它是否**有 transport 支撑**（触达真实服务，还是纯 skill）。

manifest 无效时，你会得到 `✗ manifest is INVALID:`、失败原因和非零退出码（`5`）——什么都不会提交。加 `--json` 拿机器可读输出；`--url` 指向非默认网关；`--key` 覆盖密钥。

---

## 3. `plexus extension add`——实时安装它

暴露面确认无误后就可以安装。**你——用 connection-key 访问管理 API 的本地用户——就是人类批准者**，所以 CLI 直接提交扩展并留下审计记录：

```sh
plexus extension add ./my-vault.json
```

```text
✓ installed extension "my-vault" — revision 7
  registered 3 capabilities: my-vault.notes.read, my-vault.notes.write, my-vault.notes.howto
```

这条命令调用 `POST /admin/api/extensions`。这些 id 立即生效，无需重启网关：它们马上出现在管理 UI 里、即刻可授权；你为某个 agent 授权之后（连接时勾选进子集，或由 owner 签发常驻授权），它们就出现在该 agent 的 manifest 里。安装也是**持久的**：manifest 写入 `~/.plexus/extensions.json` 并**在启动时重放**，扩展撑得过网关重启——装一次就够，不必每次启动都装。在终端里确认和管理：

```sh
plexus extension list                 # GET  /admin/api/extensions
plexus extension remove my-vault      # DELETE /admin/api/extensions/my-vault (purges its grants)
```

::: tip agent 侧安装（无需管理密钥）
处于实时会话中的 *agent* 也可以走协议，用 `POST /extensions { sessionId, manifest }` 注册扩展。因为扩展有 transport 支撑，这条路径会**挂起**等人批准（`grant_pending_user`）——用户在 `/admin` 里批准后才上线。验收 harness 演练的正是这个流程：
[`tests/harnesses/acceptance/README.md`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance/README.md)
（codex agent 写出一个 vault-WRITE 扩展，挂起，用户批准，随后被 invoke）。上面那条 `plexus extension add` 路径之所以不挂起，正是因为 CLI 是管理员/人类的暴露面，不是 agent 的。
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

正因为这个标签，**agent 请求的任何扩展 capability 授权都会挂起等人**（不只是 write）——见第 5 步。

---

## 5. 授权 + invoke 这个扩展

授权与调用方式和任何 capability 相同（完整走查见[连接一个 agent](/zh/guide/connect-an-agent)）。有三点要预期：

- **先把新 id 授权给这个 agent。** agent 的世界就是你为它授权的 capability 子集：重新连接并勾选新 capability，或在管理控制台为它签发常驻授权。你从未授权给该 agent 的 capability，其授权请求会被直接拒绝——不挂起。
- **agent 请求的每次扩展授权都挂起等待批准**——哪怕只是 *read*。扩展来源被当作敏感度升级对待，网关会推给人：`PUT /grants` 返回 `grant_pending_user`，你在 **Approvals** 标签页批准（附带信任窗口），token 才会铸出。
- **写入是双重门控的**——`my-vault.notes.write` 既带 `write` 授权，*又*来自扩展，所以 agent 请求它的授权必然挂起。

授权就位后，在编码 agent 看来，整件事就是一次 shell 调用（需要授权时，CLI 打印 `grant_pending_user` 通知，并在你批准期间轮询）：

```sh
plexus call my-vault.notes.write \
  --input '{"path":"Daily/2026-06-25.md","content":"# Today\nWrote this via a Plexus extension."}'
```

……文件经*你自己的*本地写入守护进程落进 vault。invoke 遵循统一契约：`{ id, ok, output?, error?, auditId }`（ADR-017）。

---

## "通过对话来编写一个扩展"

manifest 不必手写。Plexus **自带编写指南**，编码 agent 读到的就是那份精确契约，可以从一段大白话描述产出有效的 manifest：

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  "http://127.0.0.1:7077/admin/api/extensions/authoring-guide"
```

`GET /admin/api/extensions/authoring-guide` 以 markdown 返回编写指南——和人类遵循的是同一份契约。循环于是变成：

1. 向你的 agent（Codex / Claude Code）**描述你要什么**，例如：*"添加一项 capability，向我 `127.0.0.1:27123` 上的本地 vault 守护进程写一条笔记，接收 `path` 和 `content`，用名为 `my-vault-key` 的 bearer 密钥做认证。"*
2. agent **拉取编写指南**（上面的 URL），照它写出 manifest，再跑 **`plexus extension preview`** 自检安全暴露面——把动词 / rest 主机 / cli 二进制读回来，它（和你）都能看清即将授予这个扩展什么。
3. 预览干净后，用 **`plexus extension add`** 安装；或走 agent 路径，`POST /extensions` 注册，在 `/admin` 里**挂起**等你批准。

因为每一步走的都是*真实*的 preview/add 暴露面，agent 没法把比描述更宽的扩展蒙混过你：任何东西提交之前，你（或替你行事的 agent）都先读到投影出来的暴露面；新 id 只有在你为某个 agent 授权之后才触达它，而它请求的任何扩展授权都要挂起等人。规范参考见[规格](/zh/extensions/spec)。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent)——完整的授权 + invoke 循环，含 pending → approve 动作和一次真实的 Codex 走查。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的 source，无需编写任何东西即可使用。
- [编写指南](/zh/extensions/) / [规格](/zh/extensions/spec)——完整的 manifest 契约与 schema。
