---
title: 编写一个扩展
description: 添加一项网关未随附的 capability——写一份 manifest、预览它的安全暴露面、实时安装它。
---

# 编写并安装一个用户扩展

Plexus 随附第一方 source（Obsidian、Apple Calendar/Reminders、Things、cc-master）。一个**用户扩展**是*你*——
或一个替你行事的编码 agent——添加一项网关未随附 capability 的方式：一份你编写、校验并在运行时安装的 manifest。
一旦安装，它便在 `.well-known` 和每个 agent 的 manifest 中**热出现**，落在管理 UI 的 **Extensions** 层级之下，
并且像任何别的 capability 一样可授权 + 可调用。

本教程用那个经典的*"vault write"*例子走完整个生命周期：

```
write manifest  →  plexus extension preview  →  plexus extension add  →  see it in /admin  →  grant + invoke
```

……然后展示**"通过对话来编写一个扩展"**的路径：一个编码 agent（Codex / Claude Code）读那份*被提供出来的编写
指南*，并从一段大白话描述里替你写出 manifest。

::: tip 前置条件
一个运行中的网关（见[快速上手](/zh/guide/)）以及可达的 `plexus` CLI。该 CLI 会自动从 `~/.plexus/connection-key`
读取 connection-key。如果你接好了 Codex/CC，`plexus` 已经在 PATH 上；否则用 `bun run packages/cli/src/bin/plexus <args>`
直接运行共享 CLI。完整的 manifest 契约是[编写指南](/zh/extensions/)，schema 参考是[规格](/zh/extensions/spec)。
:::

---

## 1. 写 manifest——一个能读**也能写**的 vault

这是来自[编写指南](/zh/extensions/)的那个跑通示例。它声明一个 `local-rest` source（`my-vault`），带三个条目：
一项 **read** capability、一项 **write** capability、和一个用法 **skill**。存为 `my-vault.json`：

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
| `manifest` | 是 | Schema 版本——字面量 `"plexus-extension/0.1"`。 |
| `source` | 是 | source id；每个条目 id 都成为 `<source>.<name>`。 |
| `label` | 是 | 人类可读的 source 标签。 |
| `transport` | 是 | 默认 transport（`local-rest` \| `stdio` \| `ipc` \| `cli` \| `skill` \| `workflow`）。 |
| `capabilities` | 是 | 这个扩展贡献的条目（**非空**）。 |
| `secrets` | 否 | 密钥引用——值存放在 `~/.plexus/secrets/`，绝不在 manifest 里。 |

每项 capability：`name`（`<noun>.<verb>`）、`kind`（`capability` \| `skill` \| `workflow`）、`label`、`describe`
（面向 agent 的"是什么 / 何时用 / 怎么用"），以及 `grants`——它需要的动词（`read` \| `write` \| `execute`；`[]` =
无授权）。`io` 携带 JSON-Schema 的输入/输出；`route` 是该 transport 的路由配置（只有该 transport 会读它）。对一个
`local-rest` route，URL 路径键是 **`pathTemplate`**（规范写法；`path` 作为遗留别名被接受——优先用 `pathTemplate`）。
一个 `kind:"skill"` 条目随附一段内联 markdown `body`，被**作为上下文**来读，而不是被 invoke。

于是 `my-vault` 贡献了这些 id：`my-vault.notes.read`（read）、`my-vault.notes.write`（write）、以及
`my-vault.notes.howto`（skill）。

::: warning 密钥绝不进 manifest
manifest 只按名字*引用*一个密钥。先把值写进网关那个只写的存储里：

```sh
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  -X POST "http://127.0.0.1:7077/admin/api/secrets/my-vault-key" \
  -d '{"value":"YOUR-VAULT-API-KEY"}'
```

它被写入 `~/.plexus/secrets/my-vault-key`（模式 `0600`），并且**绝不**通过 HTTP 返回。`route.baseUrl` 指向*你
自己的*本地写入守护进程（这里是 `127.0.0.1:27123` 上的一个回环服务）；`allowedHosts` 默认把 transport 钉定到
回环——一个非回环主机是可选项，需要一条明确、经用户确认的 `allowedHosts` 条目（那个批准暴露面）。一个联邦式
多主机拓扑是一个有文档记载的设计方向（草案）——见[联邦 mesh](/zh/architecture/mesh)。
:::

---

## 2. `plexus extension preview`——读它的安全暴露面

在*不提交任何东西*的情况下校验 manifest 并投影它的**安全暴露面**：

```sh
plexus extension preview ./my-vault.json
```

```text
✓ manifest is VALID
security surface:
  source:           my-vault  ("My local vault")
  transport-backed: true
  capabilities:
    • my-vault.notes.read   capability · local-rest · verbs: read
    • my-vault.notes.write  capability · local-rest · verbs: write
    • my-vault.notes.howto  skill      · skill      · verbs: —
  rest hosts:  127.0.0.1:27123
  cli bins:    (none)
  cross-source attaches: (none)
```

这会调用 `POST /admin/api/extensions/preview`，并恰好浮现出在你信任一个扩展**之前**值得仔细审视的那些东西：

- 每项 capability 需要的**动词**（这里是一个 `write`），
- 该扩展可能触达的 **rest 主机**（任何**非回环**主机都是一个危险信号），
- 它可能 spawn 的 **cli 二进制**（这里为空——一个 `cli` transport 会把它们列出），
- **跨 source** 的 skill 附着（一个通向别的 source 的 prompt-injection 通道），
- 它是否**由 transport 支撑**（触达一个真实服务 vs. 一个纯 skill）。

如果 manifest 无效，你会得到 `✗ manifest is INVALID:` 连同原因和一个非零退出码（`5`）——什么都不提交。加
`--json` 得到机器可读的输出。用 `--url` 指向一个非默认网关；用 `--key` 覆盖密钥。

---

## 3. `plexus extension add`——实时安装它

一旦暴露面看起来没问题，就安装它。**你，那个访问经 connection-key 认证的管理 API 的本地用户，就是那个人类
批准者**——所以 CLI 会实时提交该扩展并审计它：

```sh
plexus extension add ./my-vault.json
```

```text
✓ installed extension "my-vault" — revision 7
  registered 3 capabilities: my-vault.notes.read, my-vault.notes.write, my-vault.notes.howto
```

这会调用 `POST /admin/api/extensions`。这些 id 会立刻在 `.well-known` 和每个 agent 的 manifest 中热出现——无需
重启网关。这次安装也是**持久的**：manifest 被持久化到 `~/.plexus/extensions.json` 并**在启动时重放**，因此你的
扩展熬得过网关重启（你安装它一次，而不是每次启动都装）。从终端确认 + 管理：

```sh
plexus extension list                 # GET  /admin/api/extensions
plexus extension remove my-vault      # DELETE /admin/api/extensions/my-vault (purges its grants)
```

::: tip agent 侧安装（无需管理密钥）
一个处于实时会话中的 *agent* 也可以通过协议用 `POST /extensions { sessionId, manifest }` 注册一个扩展。因为该
扩展由 transport 支撑，那条路径会**挂起**等一个人（`grant_pending_user`）——用户在 `/admin` 里批准它之后它才
上线。这正是验收 harness 演练的那个流程：
[`tests/harnesses/acceptance/README.md`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance/README.md)
（一个 codex agent 编写一个 vault-WRITE 扩展，它挂起，用户批准，然后它被 invoke）。上面那条 `plexus extension add`
路径之所以跳过挂起，恰恰*因为* CLI 是管理员/人类的暴露面，而非一个 agent。
:::

---

## 4. 在管理 UI 里看它——**Extensions** 层级

打开管理 UI 并到侧栏的 **Create an extension**：

```
http://127.0.0.1:7077/admin
```

[在 /admin 的 Create-an-extension 视图里编写并安装一个扩展](https://github.com/nemori-ai/plexus/blob/main/docs/assets/screenshots/create-extension.png)

在那里你可以粘贴一份 manifest，点 **preview** 看同样的安全暴露面，并安装它。已安装的扩展出现在 **Installed
extensions** 之下，它们的 capability 会在任何列出 capability 的地方（"我暴露了什么"）显示在 **Extensions**
来源层级之下。Plexus 使用三个来源层级——**First-party**、**Managed**、**Extensions**——并给每一项来自扩展的
capability 打上标签，好让人类始终知道它是*由一个 agent 用户添加的*：

> *Extension——由一个 agent 用户添加，所以 Plexus 总会来跟你确认。*

正是这个打标签，才使得**一个扩展 capability 上的任何授权都挂起等一个人**（而不只是 write）——见第 5 步。

---

## 5. 授权 + invoke 这个扩展

像授权和调用任何 capability 一样授权和调用它（完整走查在[连接一个 agent](/zh/guide/connect-an-agent)）。有两件事
要预期：

- **一个扩展 capability 上的每一次授权都挂起等待批准**——哪怕是一次 *read*。扩展来源被当作升级来对待，所以网关
  会推给一个人：`PUT /grants` 返回 `grant_pending_user`，你在 **Pending** 标签页批准（带一个信任窗口），token
  才被铸出。
- **写入是双重门控的**——`my-vault.notes.write` 既带一个 `write` 授权*又*来自扩展，所以它总会挂起。

从一个编码 agent 来看，整件事就是一次 shell 调用（CLI 打印那条 `grant_pending_user` 通知并在你批准期间轮询）：

```sh
plexus call my-vault.notes.write \
  --input '{"path":"Daily/2026-06-25.md","content":"# Today\nWrote this via a Plexus extension."}'
```

……然后文件通过*你自己的*本地写入守护进程落进你的 vault。Invoke 是统一契约：`{ id, ok, output?, error?, auditId }`
（ADR-017）。

---

## "通过对话来编写一个扩展"

你不必手写 manifest。Plexus **提供它自己的编写指南**，好让一个编码 agent 读到那份精确的契约，并从一段大白话
描述里产出一份有效的 manifest：

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  "http://127.0.0.1:7077/admin/api/extensions/authoring-guide"
```

那个 `GET /admin/api/extensions/authoring-guide` 会把编写指南作为 markdown 返回——正是一个人类会遵循的同一份
契约。于是这个循环变成：

1. **把你想要的东西描述**给你的 agent（Codex / Claude Code），例如*"添加一项 capability，向我 `127.0.0.1:27123`
   上的本地 vault 守护进程写入一条笔记，读取一个 `path` 和 `content`，用一个名为 `my-vault-key` 的 bearer 密钥
   做认证。"*
2. agent **拉取编写指南**（上面那个 URL），写出一份遵循它的 manifest，并运行 **`plexus extension preview`** 来
   自检安全暴露面——把动词 / rest 主机 / cli 二进制读回来，好让它（和你）看清它即将授予该扩展什么。
3. 预览干净后，**`plexus extension add`** 安装它——或者，在 agent 路径上，`POST /extensions` 注册它并让它在
   `/admin` 里**挂起**等你批准。

因为每一步都是那个*真实*的 preview/add 暴露面，agent 无法把一个比描述更宽的扩展蒙混过你：你（或替你行事的
agent）在任何东西提交之前先读到投影出来的暴露面，而且任何扩展授权都挂起等一个人。规范参考见[规格](/zh/extensions/spec)。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent)——完整的授权 + invoke 循环，包括那套 pending → approve 的动作和
  一次真实的 Codex 走查。
- [暴露一个 source](/zh/guide/first-party-sources)——那些随附的 source，你无需编写任何东西即可使用。
- [编写指南](/zh/extensions/) / [规格](/zh/extensions/spec)——完整的 manifest 契约与 schema。
