---
title: 暴露一个 source
description: 随附的第一方 source——capability id、授权、前置条件，以及诚实的只读 vs. 可写暴露面。
---

# 随附的第一方 source

Plexus 随附了一组**第一方** capability source，好让你一启动网关，agent 就有真实的东西可供发现。本页覆盖每一个
——它的 **capability id**、它需要的**授权**、如何**启用 / 配置**它、**前置条件**，以及诚实的**只读 vs. 可写**
暴露面。

这些 source：

| Source | 访问 | 前置条件 |
| --- | --- | --- |
| **Obsidian**（`obsidian-fs`） | read | 磁盘上的一个 vault 文件夹 |
| **Obsidian**（`obsidian-rest`） | read + **write** | Obsidian *Local REST API* plugin |
| **Apple Calendar** | read | macOS + Calendar TCC |
| **Apple Reminders** | read + **write** | macOS + Reminders TCC |
| **Things 3** | read + **write** | 已安装 Things 3 |
| **cc-master** | execute / write / read | PATH 上有 Claude Code（`claude`） |
| **Workspace**（`workspace`） | read + **write** | 磁盘上一个已授权的工作目录 |
| **Claude Code**（`claudecode`） | **execute**（受沙箱约束） | PATH 上有 `claude` + macOS `sandbox-exec` |
| **Codex**（`codex`） | **execute**（受沙箱约束） | PATH 上有 `codex` CLI + macOS `sandbox-exec` |

::: tip 两种启用形态
Apple source、Things、cc-master，以及三个受沙箱约束的演示 / agent source（**Workspace**、**Claude Code**、
**Codex**）是**编译进来的**并**自动注册**——没有添加步骤。Obsidian 适配器是你在运行时添加的**受管 source**
（CLI 或 `/admin`）。两者下面都会讲。
:::

::: warning 安全姿态（对它们全都适用）
默认拒绝：一个 agent 在请求授权之前持有*零*调用权限。**对第一方 source 的 read 会自动批准；write 是升级敏感度
的，会挂起等待人类批准**（那套 `grant_pending_user` 动作——见[连接一个 agent](/zh/guide/connect-an-agent)）。
agent 永远无法自行授予一次变更性的调用。信任模型见[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)
和[快速上手](/zh/guide/)。
:::

---

## Obsidian

一个 Obsidian vault 无非是一个装着 `.md` 文件的文件夹。Plexus 以两种方式暴露它——根据你是否需要写入来选。

### `obsidian-fs`——直接、**只读**、路径受限

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | **构造上只读** |
| `obsidian.vault.how-to-cite` | skill | — | 使用指引（作为上下文来读） |

**构造上只读**——代码里根本没有写入/执行的路径——并且**路径受限**：一次 `../` 穿越、一个绝对路径、或一个逃出
vault 的符号链接都会被拒绝，绝不提供。

**前置条件：** 只需磁盘上的一个 vault 文件夹。**不需要 Obsidian 应用，不需要 plugin，不需要密钥。**

**启用它**（受管 source——添加并持久化到 `~/.plexus/sources.json`，无需重启即热加载）。在仓库根目录：

```sh
# via the plexus CLI
bun run packages/cli/src/bin/plexus source add obsidian-fs --vault-path ~/Documents/MyVault

# or the launcher shortcut (persists the same managed source)
bun run start --vault ~/Documents/MyVault
```

你也可以在 `/admin` 的 **Sources** 标签页里添加它。确认它已热出现：

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json(); console.log(d.capabilities.map(c => c.id).join("\n"))'
# → … obsidian.vault.read …
```

### `obsidian-rest`——经由 Local REST API plugin 的**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian-rest.vault.list` | capability | `read` | 列出 vault 条目 |
| `obsidian-rest.vault.read` | capability | `read` | 读一条笔记 |
| `obsidian-rest.vault.write` | capability | `write` | **创建/覆盖一条笔记 → 挂起** |
| `obsidian-rest.vault.how-to-use` | skill | — | 使用指引 |

**前置条件：** 在同一台 Mac 的 Obsidian 应用里安装并运行 **Obsidian Local REST API** plugin。该 plugin 在回环上
提供 **HTTPS**（默认 `https://127.0.0.1:27124`），并用其设置里的一把 **Bearer API key** 做认证。Plexus 接受该
plugin 的自签名证书*仅仅*是因为该主机解析到回环；transport 在每次调用前都会重新核验回环。

**启用它**（API key **只从 STDIN** 读取——绝不从 argv，那会经由 `ps` 泄漏——并按 NAME 存储在 `~/.plexus/secrets/`
里，绝不回显）：

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

`obsidian-rest.vault.write` 带一个 `write` 授权，所以授予它会**挂起等一个人**——agent 拿到 `grant_pending_user`，
你在 **Pending** 标签页批准。两项 read 自动批准。（重新配置一个 source 的 `--base-url`/密钥会**清除它的授权**，
所以之前的一次批准无法带到一个新端点上。）完整的 source 管理：
[`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)。

---

## Apple Calendar——**只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | 列出日历 |
| `apple-calendar.events.list` | capability | `read` | 列出某窗口内的事件 |
| `apple-calendar.how-to-use` | skill | — | 使用指引 |

**构造上只读**——该 provider 只暴露 `listCalendars()` / `listEvents()`；没有写入路径。**自动注册**（编译进来的、
第一方）——没有添加步骤。

**前置条件（真实 macOS）：** Calendar 应用，以及一次性的 macOS **TCC** 授权。**第一次实时调用**会 shell 出
`osascript -l JavaScript`（JXA）并触发 macOS 授权对话框——*系统设置 ▸ 隐私与安全性 ▸ 自动化*（以及*日历*）。
如果你拒绝，调用会以一条精确的"到系统设置里启用它"的消息失败；Plexus 无法替你重新提示——你要在系统设置里重新
授予。

**封闭模式（无 macOS、无 TCC）：** 设 `PLEXUS_FAKE_APPLE=1`，该 source 便解析出一个**假 provider**，带确定性的
内存夹具（示例日历 `Home` / `Work` / `Birthdays` 和示例事件）。验收剧本和测试关卡就是这么跑的。

```sh
PLEXUS_FAKE_APPLE=1 bun run start     # fake providers — no TCC, deterministic fixtures
```

---

## Apple Reminders——**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-reminders.lists.list` | capability | `read` | 列出提醒列表 |
| `apple-reminders.reminders.list` | capability | `read` | 列出提醒 |
| `apple-reminders.reminders.create` | capability | `write` | **创建一条提醒 → 挂起** |
| `apple-reminders.reminders.complete` | capability | `write` | **把一条提醒标为完成 → 挂起** |
| `apple-reminders.skill.how-to-use` | skill | — | 使用指引 |

那两项 **write** capability 会如实地*变更用户的 Reminders*——它们的 `describe` 就是这么说的——两者都带一个
`write` 授权，因此都**挂起等待批准**。两项 read 自动批准。**自动注册**（编译进来的、第一方）。

**前置条件（真实 macOS）：** Reminders 应用，以及一次性的 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化* +
*提醒事项*）。真实 provider 会对 `tell application "Reminders"` shell 出 `osascript`（AppleScript）；首次实时使用
会提示。**封闭模式：** `PLEXUS_FAKE_APPLE=1`（种子列表 `Reminders` / `Groceries`；create/complete 会变更内存
存储）。

---

## Things 3——**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `things.todos.list` | capability | `read` | 列出待办（AppleScript） |
| `things.projects.list` | capability | `read` | 列出项目（AppleScript） |
| `things.todos.add` | capability | `write` | **追加一条待办 → 挂起** |
| `things.how-to-use` | skill | — | 使用指引 |

**值得知道的暴露面差异：** read 走 AppleScript 词典（`tell application "Things3"`），但写入（`things.todos.add`）
用的是 **Things URL-scheme**（`things:///add?title=…&notes=…&when=…&list=…`）。这使得该写入是一个边界清晰的
**追加**——而非任意变更——但它仍带一个 `write` 授权并**挂起等待批准**。**自动注册**（编译进来的、第一方）。

**前置条件（真实 macOS）：** **已安装 Things 3**（通过一次 `osascript` 版本探测来检测）。写入通过 `open` 二进制
打开 `things://` URL。**封闭模式：** `PLEXUS_FAKE_APPLE=1`（种子待办 + 项目；`add` 变更内存存储）。

::: tip 可注入 provider / TCC 的来龙去脉（三个 Apple source 都适用）
每个 source 都通过一次 env 检查来选它的 provider——`process.env.PLEXUS_FAKE_APPLE === "1"` → 带夹具的**假**
provider，否则是**真实**的 macOS provider（它驱动 `osascript`/JXA 或 Things URL-scheme，首次使用受 macOS TCC
管控）。这个选择在单元测试里也是可注入的。所以 `PLEXUS_FAKE_APPLE=1` 就是那个用于封闭、免 TCC 运行的单一开关
——被 `bash run-tests.sh`、
[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md)
剧本和 CI 所使用。
:::

::: tip `osascript` 的性能，老实说
Apple provider 通过 `osascript` 驱动 Calendar / Reminders，它在**超大存储上很慢**——列出成百上千条会花上明显的
数秒。把查询限定到一个窗口或某个具体列表，而不是索要全部。
:::

---

## cc-master——Claude Code 编排

cc-master 是 Claude Code 长时程编排 plugin 的一个**受管 launcher**。它无头地 spawn
`claude --plugin-dir <embedded cc-master> -p …`，并**从不变更你的 `~/.claude`**——该 plugin 通过 `--plugin-dir`
注入被自动加载进受管会话。

| Capability id | 类别 | 授权 | 备注 |
| --- | --- | --- | --- |
| `cc-master.session.launch` | capability | `execute` | 启动一个无头 Claude Code 会话（始终暴露） |
| `cc-master.orchestration.run` | workflow | `execute` | 旗舰编排 workflow |
| `cc-master.board.create` | capability | `write` | 创建一块编排 board |
| `cc-master.agent.dispatch` | capability | `execute` | 派发一个受管的子 agent |
| `cc-master.board.status` | capability | `read` | 读 board 状态 |
| `cc-master.skill.orchestrating-to-completion` | skill | — | 使用指引 |
| `cc-master.skill.authoring-workflows` | skill | — | 使用指引 |
| `cc-master.skill.as-master-orchestrator` | skill | — | 使用指引 |
| `cc-master.skill.status` | skill | — | 使用指引 |

所有 **execute** / **write** capability 都挂起等待批准（每项 capability 都默认拒绝）；`board.status` 是一次
read。`session.launch` 之外的编排暴露面受一个配置 flag **管控**（见下）——当它关闭时，只有
`cc-master.session.launch` 被暴露。

**前置条件：** PATH 上有 `claude` 二进制，且 plugin 已安装在 `~/.claude/` 之下。当两者都在场时 Plexus 会
**自动检测** cc-master 并浮现这些 capability。

**启用 / 配置：**

- 如果 cc-master 还没启用，用 `/admin` 里的 **Install cc-master** 动作。它执行一次一流的、**幂等的、经审计的**
  安装——只添加使该 plugin 启用 + 注册其 marketplace 所需的那两个设置键，绝不重写无关的设置。已启用 ⇒ 安全的
  空操作。
- 暴露门控持久化到 `~/.plexus/cc-master.json`，形如 `{ "loadCcMaster": <bool> }`（默认 `true`）；`/admin` 的
  cc-master 配置会切换它（`GET`/`POST /admin/api/cc-master/config`）。

从 discovery 里确认检测：

```sh
curl -s -H "Host: 127.0.0.1:7077" http://127.0.0.1:7077/.well-known/plexus | bun -e \
  'const d = await Bun.stdin.json();
   console.log(d.capabilities.filter(c => c.id.startsWith("cc-master")).map(c => c.id).join("\n"))'
```

::: warning 出于安全，launch 受门控
一次裸的 `bun run start`（以及整个测试关卡）会以**仅记录**模式运行 cc-master——`cc-master.agent.dispatch` 会在
一块真实的 board 上记录该次派发，并返回**它本会运行的 argv**，而不 spawn `claude`。随附的桌面应用把门控翻到
**开**（`PLEXUS_CC_HEADLESS_LAUNCH=1`），于是 launch 会真实执行；手动设置那个 env var 即可让一次裸运行也真实
launch。见
[`tests/harnesses/acceptance/README.md`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance/README.md)。
:::

---

## Workspace——沙箱化工作目录（**读 + 写**）

`workspace` 把磁盘上**一个已授权的工作目录**作为一个路径受限的文件系统暴露面来暴露——即演示流程中 agent 的
草稿/产出文件夹。它是下面两个沙箱化 runner 的配套读/写暴露面：一个 agent 在这里 list/read 文件，让 Claude Code
或 Codex 在同一个牢笼里构建，然后把产物读回来。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `workspace.list` | capability | `read` | 列出一个目录（只读） |
| `workspace.read` | capability | `read` | 读一个文件（只读） |
| `workspace.write` | capability | `write` | **创建/覆盖一个文件 → 挂起** |
| `workspace.how-to-use` | skill | — | 使用指引 |

像 Obsidian vault 读取器一样**路径受限**：每个路径都在 workspace 根之下解析，若逃逸（`..`、绝对路径、或符号
链接向外）则被拒绝。两项 read（`list`/`read`）自动批准；`workspace.write` 在一个第一方 source 上带一个 `write`
授权，因此它**挂起等拥有者**。**自动注册**（编译进来的、第一方）；可用性（那个已授权目录存在吗？）经由
**health** 报告，绝不靠隐藏条目。

---

## Claude Code——无头、**受沙箱约束**（`execute`）

`claudecode` 把 Claude Code CLI 作为**一项敏感 capability** 暴露：启动无头 Claude Code 去做真实的编码工作，
**由 macOS `sandbox-exec` 约束**在那个已授权目录里。agent 永远看不到一个 shell 或启动命令——只有一个
`{ prompt }`。牢笼之外的读/写会**在内核处失败**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | **在牢笼里启动无头 Claude Code → 挂起** |
| `claudecode.how-to-use` | skill | — | 使用指引 |

`claudecode.run` 是一个第一方 source 上的 `execute`，因此它被升级并**挂起等拥有者**——发出调用后等待批准。在两次
调用之间验证产物（经由 `workspace.read`）。**自动注册**（编译进来的、第一方）；`claude` + `sandbox-exec` 是否在场
经由 **health** 浮现，而不靠隐藏条目。

---

## Codex——无头、**受沙箱约束**（`execute`）

`codex` 是 `claudecode` 的镜像：它无头地运行本地 Codex CLI（`codex exec`）去做真实的编码工作，**由 macOS
`sandbox-exec` 约束**在那个已授权目录里。同样的姿态——只有一个 `{ prompt }`（外加一个可选的、在牢笼内的
`cwd`）；牢笼之外的读/写会**在内核处失败**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | **在牢笼里启动无头 `codex exec` → 挂起** |
| `codex.how-to-use` | skill | — | 使用指引 |

`codex.run` 是一个第一方 source 上的 `execute`，因此它**挂起等拥有者**——发出调用后等待。如果本地 `codex` CLI
缺席，调用会报 `source_unavailable`，而不是让会话失败。**自动注册**（编译进来的、第一方）；`codex` +
`sandbox-exec` 的在场经由 **health** 浮现。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent)——把这些 capability 端到端驱动起来（原始 HTTP **以及**一个真实
  的 Codex agent），包括那套 pending → approve 的动作。
- [编写一个扩展](/zh/guide/create-an-extension)——添加一项网关未随附的 capability。
- [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)
  ——完整的受管 source 生命周期（添加 / 启用 / 禁用 / 重新配置 / 移除）。
