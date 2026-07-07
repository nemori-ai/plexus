---
title: 暴露一个 source
description: 随附的第一方 source——capability id、授权、前置条件，以及如实交代的只读 vs 可写暴露面。
---

# 随附的第一方 source

Plexus 随附一组**第一方** capability source——网关一启动，agent 就有真实的东西可发现。本页逐一交代：**capability id**、所需**授权**、如何**启用 / 配置**、**前置条件**，以及如实的**只读 vs 可写**暴露面。

这些 source：

| Source | 访问 | 前置条件 |
| --- | --- | --- |
| **Obsidian**（`obsidian-fs`） | read | 磁盘上的一个 vault 文件夹 |
| **Obsidian**（`obsidian-rest`） | read + **write** | Obsidian *Local REST API* plugin |
| **Apple Calendar** | read | macOS + Calendar TCC |
| **Apple Reminders** | read + **write** | macOS + Reminders TCC |
| **Things 3** | read + **write** | 已安装 Things 3 |
| **Workspace**（`workspace`） | read + **write** | 磁盘上一个已授权的工作目录 |
| **Claude Code**（`claudecode`） | **execute**（受沙箱约束） | PATH 上有 `claude` + macOS `sandbox-exec` |
| **Codex**（`codex`） | **execute**（受沙箱约束） | PATH 上有 `codex` CLI + macOS `sandbox-exec` |

::: tip 两种启用形态
Apple source、Things，加上三个受沙箱约束的演示 / agent source（**Workspace**、**Claude Code**、**Codex**）都是**编译进网关**的，**自动注册**，没有添加步骤。Obsidian 适配器则是**受管 source**，在运行时添加（CLI 或 `/admin`）。两类下面都会讲到。
:::

::: warning 安全姿态（对它们全都适用）
默认拒绝：agent 在请求授权之前没有任何调用权限。**第一方 source 的 read 自动批准；write 属于敏感度升级，挂起等待人类批准**（即 `grant_pending_user` 那套动作——见[连接一个 agent](/zh/guide/connect-an-agent)）。agent 永远无法给自己授予变更性调用。信任模型见[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)和[看信任回环](/zh/guide/run-it)。
:::

---

## Obsidian

Obsidian vault 说到底就是一个装 `.md` 文件的文件夹。Plexus 提供两种暴露方式——按你是否需要写入来选。

### `obsidian-fs`——直接、**只读**、路径受限

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | **构造上只读** |
| `obsidian.vault.how-to-cite` | skill | — | 使用指引（当上下文读） |

**构造上只读**——代码里根本没有写入或执行路径——并且**路径受限**：`../` 穿越、绝对路径、逃出 vault 的符号链接，一律拒绝，绝不读出。

**前置条件：**磁盘上有一个 vault 文件夹即可。**不需要 Obsidian 应用，不需要 plugin，不需要密钥。**

**启用**（受管 source——添加后持久化到 `~/.plexus/sources.json`，热加载，无需重启）。在仓库根目录：

```sh
# via the plexus CLI
bun run packages/cli/src/bin/plexus source add obsidian-fs --vault-path ~/Documents/MyVault

# or the launcher shortcut (persists the same managed source)
bun run start --vault ~/Documents/MyVault
```

也可以在 `/admin` 的 **Sources** 标签页添加。确认它已经上线：

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

**前置条件：**在同一台 Mac 的 Obsidian 应用里安装并运行 **Obsidian Local REST API** plugin。该 plugin 在回环上提供 **HTTPS**（默认 `https://127.0.0.1:27124`），用其设置里的 **Bearer API key** 认证。Plexus 接受它的自签名证书，*仅仅*因为主机解析到回环；transport 每次调用前都会重新核验回环。

**启用**（API key **只从 STDIN 读取**——绝不走 argv，那会经 `ps` 泄漏——按名字存进 `~/.plexus/secrets/`，绝不回显）：

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

`obsidian-rest.vault.write` 带 `write` 授权，授予时会**挂起等人**——agent 收到 `grant_pending_user`，你在 **Pending** 标签页批准。两项 read 自动批准。（重新配置 source 的 `--base-url` 或密钥会**清除它的授权**——先前的批准带不到新端点上。）完整的 source 管理见
[`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)。

---

## Apple Calendar——**只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | 列出日历 |
| `apple-calendar.events.list` | capability | `read` | 列出某时间窗口内的事件 |
| `apple-calendar.how-to-use` | skill | — | 使用指引 |

**构造上只读**——provider 只暴露 `listCalendars()` / `listEvents()`，没有写入路径。**自动注册**（编译进来的第一方 source），没有添加步骤。

**前置条件（真实 macOS）：**Calendar 应用，加一次性的 macOS **TCC** 授权。**第一次实时调用**会 shell 出 `osascript -l JavaScript`（JXA），触发 macOS 授权对话框——*系统设置 ▸ 隐私与安全性 ▸ 自动化*（以及*日历*）。拒绝之后，调用会失败并给出准确的"到系统设置里启用"提示；Plexus 无法替你再次弹窗——你要自己去系统设置重新授予。

**封闭模式（无 macOS、无 TCC）：**设 `PLEXUS_FAKE_APPLE=1`，source 会解析到**假 provider**，带确定性的内存夹具（示例日历 `Home` / `Work` / `Birthdays` 和示例事件）。验收剧本和测试关卡就是这样跑的。

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
| `apple-reminders.reminders.complete` | capability | `write` | **把提醒标为完成 → 挂起** |
| `apple-reminders.skill.how-to-use` | skill | — | 使用指引 |

两项 **write** capability 会实实在在*改动用户的 Reminders*——它们的 `describe` 也是这么写的——都带 `write` 授权，因此都**挂起等待批准**。两项 read 自动批准。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**Reminders 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化* + *提醒事项*）。真实 provider 用 `osascript` 执行 `tell application "Reminders"`（AppleScript）；首次实时使用会弹授权。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（种子列表 `Reminders` / `Groceries`；create/complete 改动内存存储）。

---

## Things 3——**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `things.todos.list` | capability | `read` | 列出待办（AppleScript） |
| `things.projects.list` | capability | `read` | 列出项目（AppleScript） |
| `things.todos.add` | capability | `write` | **追加一条待办 → 挂起** |
| `things.how-to-use` | skill | — | 使用指引 |

**值得留意的暴露面差异：**read 走 AppleScript 词典（`tell application "Things3"`），写入（`things.todos.add`）走 **Things URL-scheme**（`things:///add?title=…&notes=…&when=…&list=…`）。这让写入成为边界清晰的**追加**——不是任意变更——但它仍带 `write` 授权，仍**挂起等待批准**。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：****已安装 Things 3**（通过一次 `osascript` 版本探测检测）。写入用 `open` 二进制打开 `things://` URL。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（种子待办 + 项目；`add` 改动内存存储）。

::: tip 可注入 provider / TCC 的来龙去脉（三个 Apple source 都适用）
每个 source 通过一次 env 检查选择 provider——`process.env.PLEXUS_FAKE_APPLE === "1"` → 带夹具的**假** provider；否则是**真实** macOS provider（驱动 `osascript`/JXA 或 Things URL-scheme，首次使用受 macOS TCC 管控）。这个选择在单元测试里也可注入。所以 `PLEXUS_FAKE_APPLE=1` 就是封闭、免 TCC 运行的单一开关——`bash run-tests.sh`、
[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md)
剧本和 CI 用的都是它。
:::

::: tip `osascript` 的性能，实话实说
Apple provider 靠 `osascript` 驱动 Calendar / Reminders，在**超大存储**上很慢——列出成百上千条要花好几秒。把查询限定到时间窗口或具体列表，别一次索要全部。
:::

---

## Workspace——沙箱化工作目录（**读 + 写**）

`workspace` 把磁盘上**一个已授权的工作目录**暴露为路径受限的文件系统——也就是演示流程里 agent 的草稿 / 产出文件夹。它是下面两个沙箱化 runner 的配套读写面：agent 在这里 list/read 文件，让 Claude Code 或 Codex 在同一个牢笼里构建，再把产物读回来。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `workspace.list` | capability | `read` | 列出目录（只读） |
| `workspace.read` | capability | `read` | 读文件（只读） |
| `workspace.write` | capability | `write` | **创建/覆盖文件 → 挂起** |
| `workspace.how-to-use` | skill | — | 使用指引 |

和 Obsidian 的 vault 读取器一样**路径受限**：所有路径都在 workspace 根之下解析，逃逸（`..`、绝对路径、向外的符号链接）一律拒绝。两项 read（`list`/`read`）自动批准；`workspace.write` 在第一方 source 上带 `write` 授权，因此**挂起等拥有者**。**自动注册**（编译进来的第一方 source）；可用性（已授权目录是否存在）经 **health** 报告，绝不靠隐藏条目。

---

## Claude Code——无头、**受沙箱约束**（`execute`）

`claudecode` 把 Claude Code CLI 暴露为**一项敏感 capability**：启动无头 Claude Code 做真实编码工作，**由 macOS `sandbox-exec` 约束**在已授权目录内。agent 看不到 shell，也看不到启动命令——只有 `{ prompt }`。牢笼之外的读写**在内核处失败**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | **在牢笼里启动无头 Claude Code → 挂起** |
| `claudecode.how-to-use` | skill | — | 使用指引 |

`claudecode.run` 是第一方 source 上的 `execute`，属于敏感度升级，**挂起等拥有者**——发出调用后等待批准。两次调用之间用 `workspace.read` 验证产物。**自动注册**（编译进来的第一方 source）；`claude` + `sandbox-exec` 是否在场经 **health** 如实上报，不靠隐藏条目。

---

## Codex——无头、**受沙箱约束**（`execute`）

`codex` 是 `claudecode` 的镜像：无头运行本地 Codex CLI（`codex exec`）做真实编码工作，**由 macOS `sandbox-exec` 约束**在已授权目录内。姿态相同——只有 `{ prompt }`（外加可选的、牢笼内的 `cwd`）；牢笼之外的读写**在内核处失败**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | **在牢笼里启动无头 `codex exec` → 挂起** |
| `codex.how-to-use` | skill | — | 使用指引 |

`codex.run` 是第一方 source 上的 `execute`，因此**挂起等拥有者**——发出调用后等待。本地 `codex` CLI 缺席时，调用返回 `source_unavailable`，不会让会话失败。**自动注册**（编译进来的第一方 source）；`codex` + `sandbox-exec` 是否在场经 **health** 如实上报。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent)——端到端驱动这些 capability（原始 HTTP，**以及**一个真实的 Codex agent），含 pending → approve 动作。
- [编写一个扩展](/zh/guide/create-an-extension)——添加网关未随附的 capability。
- [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)
  ——完整的受管 source 生命周期（添加 / 启用 / 禁用 / 重新配置 / 移除）。
