---
title: "编写扩展"
description: "为网关添加一项未随附的 capability：编写 manifest，预览安全暴露面，再在运行时热安装扩展。"
---
# 编写并安装一个用户扩展 {#编写并安装一个用户扩展}

Plexus 随附的 source 包括 Obsidian、Apple Calendar/Reminders/Notes/Mail/Contacts/Photos、Shortcuts、browser、browser control 和 Claude Code。它们可用，不代表 agent 已获调用许可。

要给网关补充新的 capability，你可以自己写，也可以让编码 agent 代写：准备一份 manifest，校验通过后，在运行时安装。这就是用户扩展。

安装后，扩展会热加载，无需重启，并在管理 UI 中归入 Extensions 层级。安装、纳入某个 agent 的 manifest、取得调用许可，是三件事。拥有者先选定该 agent 的能力子集；符合条件且仍有效的所有者常驻授权，也可把对应能力纳入其有效授权范围。范围内仍开放的能力才能进入 manifest，其中的能力仍须按与其他 capability 相同的规则授权，才能调用。

本教程用经典的“vault write”例子走完整个生命周期：

```
write manifest  →  plexus extension preview  →  plexus extension add  →  see it in /admin  →  grant + invoke
```

随后再看怎样通过对话编写扩展：让编码 agent（Codex / Claude Code）读取网关提供的编写指南，把你的大白话描述写成 manifest。

::: tip 前置条件
先准备一个运行中的网关（见[快速上手](/zh/guide/)），以及 repo 随附的共享 `plexus` 管理 CLI。它和 connection-key 都供拥有者管理网关，不是 agent 的调用凭据或专属 launcher。

在 repo checkout 中运行 `bun run packages/cli/src/bin/plexus <args>`。下文的 `plexus extension …` 是它的简写，可先设置别名：`alias plexus="bun run <repo>/packages/cli/src/bin/plexus"`。CLI 会自动从 `~/.plexus/connection-key` 读取 connection-key。完整的 manifest 契约见[编写指南](/zh/extensions/)，schema 参考见[规格](/zh/extensions/spec)。
:::

---

![扩展的生命周期：编写 manifest、预览安全暴露面、由你批准 add、在 /admin 中查看，再授权并 invoke](/diagrams/extension-lifecycle.png)


## 1. 写 manifest：让 vault 既能读，也能写 {#_1-写-manifest——一个能读也能写的-vault}

下面沿用[编写指南](/zh/extensions/)的完整示例：从本地服务读取笔记，也能创建或覆盖笔记，再附一段用法指引。它声明一个名为 `my-vault` 的 `local-rest` source，包含 read、write 两项 capability 和一项 skill。存为 `my-vault.json`：

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

先看 source 这一层。它给条目提供共同的身份和默认 transport；完整字段参考见[规格](/zh/extensions/spec)。

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `manifest` | 是 | Schema 版本，固定为字面量 `"plexus-extension/0.1"`。 |
| `source` | 是 | source id；各条目的 id 按 `<source>.<name>` 生成。 |
| `label` | 是 | 给人看的 source 标签。 |
| `transport` | 是 | 默认 transport，支持 `local-rest` \| `stdio` \| `ipc` \| `cli` \| `skill` \| `workflow`。 |
| `capabilities` | 是 | 扩展贡献的条目，不能为空。 |
| `secrets` | 否 | 密钥引用；值保存在 `~/.plexus/secrets/`，绝不写进 manifest。 |

每个条目用 `name`（`<noun>.<verb>`）命名，用 `kind`（`capability` \| `skill` \| `workflow`）区分类别。`label` 给人看，`describe` 给 agent 说明“是什么、何时用、怎么用”。由此生成三个 id：`my-vault.notes.read`（read）、`my-vault.notes.write`（write）、`my-vault.notes.howto`（skill）。

再看调用需要什么。`io` 用 JSON-Schema 描述输入／输出：本例读取必填字符串 `path`，写入还必填字符串 `content`。`grants` 声明所需动词，支持 `read` \| `write` \| `execute`；`[]` 表示无需授权。这里声明的是授权要求，不是已经授予的许可。

`route` 决定请求怎样送到服务，只有对应的 transport 会读取它。本例分别用 `GET` 读取、用 `PUT` 写入，写入请求体来自 `{content}`。`local-rest` 的 URL 路径键优先写 `pathTemplate`；遗留别名 `path` 也接受。`kind:"skill"` 则内联一段 markdown `body`，agent 把它当上下文读，而不是 invoke；这段指引还说明，路径相对于 vault 根目录。

::: warning 密钥绝不进 manifest
manifest 只按名字引用密钥。本例引用 `my-vault-key`，以 bearer 方式附加。先由拥有者运行下面的管理命令，把值写进网关的只写存储；命令使用管理 connection-key，不是让 agent 代持这份凭据：

```sh
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  -X POST "http://127.0.0.1:7077/admin/api/secrets/my-vault-key" \
  -d '{"value":"YOUR-VAULT-API-KEY"}'
```

值落在 `~/.plexus/secrets/my-vault-key`，权限为 `0600`，绝不通过 HTTP 返回。还需要你自己的本地写入守护进程已经运行，`route.baseUrl` 才有服务可连；本例指向 `127.0.0.1:27123` 的回环服务。`allowedHosts` 默认把 transport 限在回环上。非回环主机是可选暴露面，必须明确列入 `allowedHosts` 并经用户确认；获批的条目就是允许暴露的范围。

跨主机的单 primary mesh 实现已经交付并经过验证，不再只是草案；更深层、嵌套拓扑及明确延后的扩展仍属规划，见[联邦 mesh](/zh/architecture/mesh)。无论连接到哪里，manifest 都只保留密钥名字，实际值留在网关的密钥存储中。
:::

---


## 2. `plexus extension preview`：安装前核对安全暴露面 {#_2-plexus-extension-preview——读它的安全暴露面}

manifest 写好了，先不要安装。运行下面的命令，它会在不提交任何东西的前提下校验 manifest，并展示其中声明的安全暴露面：

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

命令调用 `POST /admin/api/extensions/preview`。这里的 `VALID` 只说明 manifest 通过校验，不保证扩展无害，也不说明它恰好符合你的本意。接下来要由你核对：它声明要做的事，是不是你愿意交给它的事。

先看每项 capability 所需的动词。本例不只有 `read`，还有一个 `write`；如果原本只想读取笔记，就不能略过这项写入。再看 `rest hosts`，确认请求可能送往哪里。本例是 `127.0.0.1:27123`。非回环主机都值得停下来检查，但你明确选择并批准的远端主机，与意外多出的主机不是一回事；要找的是未经你同意扩大的暴露范围。

还要看它可能启动哪些 `cli` 二进制。使用 `cli` transport 时，预览会列出可执行文件名，供你核对将运行什么程序。本例没有，所以整行省略。

skill 也不能跳过。跨 source 的 skill 附着，可能成为通往其他 source 的 prompt-injection 通道，要检查指引附到了哪里。`transport-backed` 则让你区分：扩展有触达真实服务的 transport 支撑，还是纯 skill。本例的 `yes` 表示前者，不是服务已成功调用的证明。

manifest 无效时，命令会显示 `✗ manifest is INVALID:` 和失败原因，以非零退出码 `5` 结束，什么都不会提交。需要机器可读输出时加 `--json`；`--url` 指向非默认网关；`--key` 覆盖密钥。

预览把这些声明摆到你面前，不替你作信任决定。核对完操作、主机、程序和指引的范围，再决定是否让这份 manifest 进入安装。

---


## 3. `plexus extension add`：实时安装扩展 {#_3-plexus-extension-add——实时安装它}

暴露面确认无误，就可以提交安装。这里运行管理 CLI 的是你：本地拥有者用 connection-key 访问管理 API，也就是这次安装的人类批准者。命令提交的是你已批准的扩展，网关会留下审计记录，不再挂起等一次重复确认：

```sh
plexus extension add ./my-vault.json
```

```text
✓ installed extension "my-vault" — revision 7
  registered 3 capabilities: my-vault.notes.read, my-vault.notes.write, my-vault.notes.howto
```

这条命令调用 `POST /admin/api/extensions`。三个 id 立即注册，无需重启网关；打开管理 UI 就能看到，也可以立即选择和授权给 agent。

但安装没有替任何 agent 取得调用权。你在连接时把能力勾选进该 agent 的子集，或由 owner 为它签发符合条件且仍有效的常驻授权，都能把能力纳入有效授权范围；能力仍须对外开放，才会出现在对应的 manifest 中。owner 签发常驻授权是另一项授权操作，不能把“进入清单”和“获准调用”混为一谈。

安装也是持久的。manifest 写入 `~/.plexus/extensions.json`，在网关启动时重放，因此扩展能撑过重启，装一次就够，不必每次启动重新提交。

在终端里可以列出已安装的扩展，也可以移除：

```sh
plexus extension list                 # GET  /admin/api/extensions
plexus extension remove my-vault      # DELETE /admin/api/extensions/my-vault (purges its grants)
```

`list` 用来确认安装结果；`remove` 不只移除扩展，还会清除它的 grants，不能留下原有授权继续使用。

::: tip agent 侧安装：不需要管理密钥
处于实时会话中的 agent 也能通过协议提交 `POST /extensions { sessionId, manifest }`。本例有 transport 支撑，这条注册路径会挂起，返回 `grant_pending_user`；只有用户在 `/admin` 批准后，扩展才上线。

[验收 harness 说明](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance/README.md)演练的正是这个过程：codex agent 写出一个 vault-WRITE 扩展，提交后挂起，用户批准，随后走到 invoke。

两条路径的区别在于谁提交批准。`plexus extension add` 是拥有者的管理入口，提交 owner 已批准的安装；agent 的协议入口则要等人决定。connection-key 是拥有者的管理凭据，不要交给 agent。
:::

---

## 4. 在管理 UI 中找到它：Extensions 层级 {#_4-在管理-ui-里看它——extensions-层级}

打开管理 UI，进入侧栏的 Create an extension：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Create-an-extension 视图中编写并安装扩展](/diagrams/create-extension.png)

这里也可以完成安装：粘贴 manifest，点 preview，核对与 CLI 相同的安全暴露面，再安装。已安装的扩展会列在 Installed extensions 下。

Plexus 用 First-party、Managed、Extensions 三个来源层级区分能力。在“我暴露了什么”等列出 capability 的地方，扩展贡献的条目归入 Extensions，并带有来源标签。标签说明它是用户添加的扩展，也包括用户经由 agent 添加的情况，不意味着每份扩展都必须由 agent 提交。

原来那句“由用户经由 agent 添加，所以 Plexus 总会先来问你”，应当分开理解：来源说明能力从哪里来，是否需要再次批准，还要看具体操作。

敏感度由 provenance、动词和 transport 一起决定，不由 Extensions 标签单独决定。已有符合条件、仍有效的常驻授权时，可以不再重复提示；具体授权条件留到第 5 步。此时你可以在 Installed extensions 中找到 `my-vault`，并在 Extensions 层级辨认它贡献的三个条目。

---


## 5. 授权并调用扩展 {#_5-授权-invoke-这个扩展}

扩展已经装好，接下来才是允许哪个 agent 使用它。授权与调用方式和其他 capability 相同，完整走查见[连接一个 agent](/zh/guide/connect-an-agent)。安装让网关认识新 id，不会替 agent 取得调用许可。

你可以重新连接 agent，勾选新 capability，把它纳入这个 agent 的选定子集。所有者也可以通过额外能力选择器，或批准并重新指定目标的待处理请求，为该 agent 的 capability 创建常驻授权；授权仍有效、未过期且通过当前 `connection-key` epoch 校验时，对应 capability 也在有效授权范围内。agent 不能自行创建这条例外。你从未授权给该 agent 的 capability，其授权请求会被直接拒绝——不挂起。这里说的“从未授权”，指它既不在你选定的子集内，也没有上述有效常驻授权，不是说它仅仅尚无常驻授权记录。有效授权范围划定可以请求哪些能力；选定子集记录你选给它的能力，常驻授权记录保存你已作出的批准，agent 据此取得限定范围的 scoped token，才有实际调用凭据。这三件事不能合成一步。

子集之内也不是每次都要等人。连接时勾选的 `read` 会获得常驻授权；已有符合条件、仍有效的常驻授权，扩展请求就可以复用，不必再次提示。没有可用授权、需要人作决定时，`PUT /grants` 返回 `grant_pending_user`，请求挂起。你到 Approvals 标签页批准，并选择信任窗口，随后才会铸出 token。信任窗口记录的是这次批准有效多久，不是把能力永久交给 agent；扩展的 `read` 也不能仅凭只读就跳过所需批准。

`my-vault.notes.write` 既要求 `write`，又来自扩展，并通过 `local-rest` 写入。网关会结合来源、动词和 transport 判断敏感度，但这不等于它永远必须重新弹窗。写入默认逐次批准；你可以在真实的批准窗口中选择常驻信任，也可以在管理控制台显式签发常驻授权。只要授权符合条件、仍有效，后续请求便可复用。`execute` 的例外更严格：必须由拥有者为特定 agent 与 capability 显式开启常驻 opt-in；agent 不能自行解除执行授权的逐次批准上限。

授权就位后，本仓库教程用共享 CLI 演示一次 shell 调用。需要批准时，CLI 会打印 `grant_pending_user` 通知，并在你处理批准期间轮询。使用编译集成的 agent 则应走自己的专属 launcher 和获准的凭据生命周期，不能把这里的共享管理 CLI 当作自己的入口，也不能持有管理 connection-key。

```sh
plexus call my-vault.notes.write \
  --input '{"path":"Daily/2026-06-25.md","content":"# Today\nWrote this via a Plexus extension."}'
```

获准的请求经你自己的本地写入守护进程，把文件写进 vault。invoke 遵循统一契约：`{ id, ok, output?, error?, auditId }`（ADR-017）。

---


## 通过对话编写一个扩展 {#通过对话来编写一个扩展}

manifest 不必手写。你可以把想做的事告诉编码 agent，让它按 Plexus 自带的编写指南准备同一份 manifest，再走前面的预览、安装和授权流程。换的是编写方式，不是安装入口或权限规则。

先由拥有者运行下面的命令，取得指南：

```sh
curl -s -H "Host: 127.0.0.1:7077" \
  -H "X-Plexus-Connection-Key: $(cat ~/.plexus/connection-key)" \
  "http://127.0.0.1:7077/admin/api/extensions/authoring-guide"
```

`GET /admin/api/extensions/authoring-guide` 以 markdown 返回编写指南，和人类遵循的是同一份契约。

这条命令读取的是拥有者的管理 connection-key，应由你自己执行，再把返回的指南交给编码 agent。不要让普通 agent 读取或继承这把管理密钥；它访问网关时，用自己的身份凭据 PAT 和经认证取得的 session。

具体可以这样做：

1. 向你的 agent（Codex / Claude Code）描述需求，例如：“添加一项 capability，向我 `127.0.0.1:27123` 上的本地 vault 守护进程写一条笔记，接收 `path` 和 `content`，用名为 `my-vault-key` 的 bearer 密钥做认证。”这里提供的是密钥引用名，实际值仍由拥有者按前面的步骤存入网关，不写进 manifest。

2. 把取得的指南交给 agent，让它照着写出 manifest。随后由你运行 `plexus extension preview`，把预览结果拿回来一起核对：有哪些 capability、要求什么动词、请求送往哪些 `rest` 主机、可能启动哪些 `cli` 二进制。不要只看校验是否通过，还要逐项对照原来的需求。

3. 确认范围无误后，由你用 `plexus extension add` 安装。这是拥有者提交已批准的安装，不会再挂起等一次重复确认。也可以让 agent 用自己的实时会话经 `POST /extensions` 注册；本例有 transport 支撑，这条路径会在 `/admin` 挂起，等你批准后才上线。

预览展示的是扩展声明的能力和目标地址，供你审查，并不能保证 agent 不会写出超出本意的内容。真正限制访问的是网关的有效授权范围与 grant 检查：新 id 要先纳入该 agent 的选定子集，或由所有者为该 agent 创建符合条件且仍有效的常驻授权，调用还须取得限定范围的授权。已有符合条件、仍有效的常驻授权时，可以复用；否则按规则等待批准。两种途径都不能绕过开放状态、scope 与 verb 限制、session 有效性、scoped token 要求或其他调用检查。完整契约见[规格](/zh/extensions/spec)。

---

## 接下来去哪 {#接下来去哪}

- [连接一个 agent](/zh/guide/connect-an-agent)——走完授权与 invoke 循环，包括 pending → approve，以及一次真实的 Codex 走查。
- [暴露一个 source](/zh/guide/first-party-sources)——使用随附的 source，不必自己编写扩展。
- [编写指南](/zh/extensions/) / [规格](/zh/extensions/spec)——查阅完整的 manifest 契约与 schema。
