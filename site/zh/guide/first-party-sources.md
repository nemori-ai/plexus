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
| **Apple Notes** | read + **仅限创建的 write** | macOS + Automation TCC |
| **Apple Mail** | **只读** | macOS + Automation TCC |
| **Apple Contacts** | 只读 | macOS + Automation TCC |
| **Apple Photos** | read（`export` 向受限目录写出一个文件） | macOS + Automation TCC |
| **Shortcuts**（`shortcuts`） | read + **execute**（默认记录模式） | macOS `shortcuts` CLI |
| **Browser**（`browser`） | 只读（Safari + Chrome） | macOS（Safari 历史需要完全磁盘访问权限） |
| **Workspace**（`workspace`） | read + **write** | 磁盘上一个已授权的工作目录 |
| **Claude Code**（`claudecode`） | **execute**（受沙箱约束） | PATH 上有 `claude` + macOS `sandbox-exec` |
| **Codex**（`codex`） | **execute**（受沙箱约束） | PATH 上有 `codex` CLI + macOS `sandbox-exec` |

::: tip 两种启用形态
Apple source（**Calendar**、**Reminders**、**Notes**、**Mail**、**Contacts**、**Photos**）、**Shortcuts**、**Browser**，加上三个受沙箱约束的演示 / agent source（**Workspace**、**Claude Code**、**Codex**）都是**编译进网关**的，**自动注册**，没有添加步骤。Obsidian 适配器则是**受管 source**，在运行时添加（CLI 或 `/admin`）。两类下面都会讲到。
:::

::: warning 安全姿态（对它们全都适用）
默认拒绝，且以你的授权为界：连接 agent 时，你为它勾选可触达的 capability 授权子集，子集之外的授权请求直接拒绝——绝不挂起。子集之内，连接时勾选的 **read** 成为常驻授权；勾选的带副作用的 capability（**write** / **execute**）保持逐次——每次调用都挂起等待人类批准（即 `grant_pending_user` 那套动作——见[连接一个 agent](/zh/guide/connect-an-agent)），除非你在连接时为那一项 capability 显式 opt-in 常驻，或之后在批准它的请求时选一个真实的信任窗口。agent 永远无法给自己授予变更性调用。信任模型见[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)和[看信任回环](/zh/guide/run-it)。
:::

---

## Obsidian

Obsidian vault 说到底就是一个装 `.md` 文件的文件夹。Plexus 提供两种暴露方式——按你是否需要写入来选。

### `obsidian-fs`——直接、**只读**、路径受限

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | **构造上只读** |
| `obsidian.vault.search` | capability | `read` | 大小写不敏感的子串搜索，覆盖笔记路径 + 内容（默认 20 条命中，上限 100） |
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

也可以在 `/admin` 的 **What I expose** 标签页添加。确认它已经上线：

```sh
bun run packages/cli/src/bin/plexus source list
# → … obsidian-fs … enabled · live … capabilities:…
```

同一个 source 会出现在 `/admin` 的 **What I expose** 树里；你为其授权过的 agent，在它自己的 `list` 里能看到 `obsidian.vault.read`。

### `obsidian-rest`——经由 Local REST API plugin 的**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian-rest.vault.list` | capability | `read` | 列出 vault 条目 |
| `obsidian-rest.vault.read` | capability | `read` | 读一条笔记 |
| `obsidian-rest.vault.search` | capability | `read` | 全文搜索 vault（`POST /search/simple/`） |
| `obsidian-rest.vault.write` | capability | `write` | **创建/覆盖一条笔记——替换整条笔记 → 挂起** |
| `obsidian-rest.vault.append` | capability | `write` | **追加到笔记末尾（不存在则创建） → 挂起** |
| `obsidian-rest.vault.how-to-use` | skill | — | 使用指引 |

**前置条件：**在同一台 Mac 的 Obsidian 应用里安装并运行 **Obsidian Local REST API** plugin。该 plugin 在回环上提供 **HTTPS**（默认 `https://127.0.0.1:27124`），用其设置里的 **Bearer API key** 认证。Plexus 接受它的自签名证书，*仅仅*因为主机解析到回环；transport 每次调用前都会重新核验回环。

**启用**（API key **只从 STDIN 读取**——绝不走 argv，那会经 `ps` 泄漏——按名字存进 `~/.plexus/secrets/`，绝不回显）：

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

**一条值得当真的写入警告：**`obsidian-rest.vault.write` 会**替换整条笔记**（`PUT /vault/{path}`，请求体是完整的 markdown 全文）——先读出笔记，再把想保留的内容全部重发。做增量编辑——日志、跟进、随手记——优先用 `obsidian-rest.vault.append`：它追加到笔记末尾，保留已有内容（笔记不存在时会创建）。

两项 write（`vault.write` / `vault.append`）都带 `write` 授权，授予时会**挂起等人**——agent 收到 `grant_pending_user`，你在 **Approvals** 标签页批准。三项 read 自动批准。（重新配置 source 的 `--base-url` 或密钥会**清除它的授权**——先前的批准带不到新端点上。）完整的 source 管理见
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

## Apple Notes——**读 + 仅限创建的写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-notes.folders.list` | capability | `read` | 列出文件夹（按账户） |
| `apple-notes.notes.search` | capability | `read` | 有界的标题/正文搜索（默认 20 条命中，硬上限 50） |
| `apple-notes.notes.read` | capability | `read` | 按 id 或精确标题读一条笔记（`text` + 原始 `html`） |
| `apple-notes.notes.create` | capability | `write` | **创建一条新笔记 → 挂起** |
| `apple-notes.skill.how-to-use` | skill | — | 使用指引 |

**构造上仅限创建的写入面：**唯一的写入就是创建一条**新**笔记——没有 update、没有 delete、没有 move、没有 rename 条目，整个 source 里也根本不存在（provider seam 没有这类方法，bridge 没有这类 handler）。已有笔记无法经 Plexus 修改或删除。`apple-notes.notes.create` 仍带 `write` 授权，**挂起等待批准**；三项 read 自动批准。搜索返回命中摘要（id、标题、文件夹、修改日期、短摘录——绝不返回全文）；把命中的 `id` 传给 `notes.read` 拿实际内容。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**Notes 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）——provider 驱动 `osascript`/JXA。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具；`create` 改动内存存储）。

---

## Apple Mail——**严格只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-mail.mailboxes.list` | capability | `read` | 账户 + 各邮箱及未读数 |
| `apple-mail.messages.search` | capability | `read` | 在单个邮箱内的有界搜索（默认 20，硬上限 50） |
| `apple-mail.message.read` | capability | `read` | 按 id 读一封邮件的纯文本（正文上限 20,000 字符） |
| `apple-mail.how-to-use` | skill | — | 使用指引 |

**构造上严格只读**——每项 capability 都带 `read`，provider seam **没有起草/发送/移动/删除方法**：起草或发送 capability 在这个 source 里根本不存在，而不是仅仅被拒绝。搜索一次只在**一个邮箱**内进行（默认 `INBOX`，即统一收件箱），按发件人/主题子串和/或收件日期范围过滤，结果最新在前，带约 200 字符的摘录和 `truncated` 标志；大邮箱上优先用日期范围或发件人过滤。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**Mail 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

---

## Apple Contacts——**只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-contacts.contacts.search` | capability | `read` | 有界的姓名/邮箱/电话子串搜索（默认 20，硬上限 50） |
| `apple-contacts.contacts.read` | capability | `read` | 按联系人 id 读完整名片 |
| `apple-contacts.how-to-use` | skill | — | 使用指引 |

**构造上只读**——provider seam 没有 create/update/delete 方法；这个 source 里不存在任何写入 capability。搜索匹配姓名、邮箱地址或电话号码的大小写不敏感子串（电话匹配按数字比较——查询需要 ≥ 3 位数字才会匹配电话）；`contacts.read` 返回完整名片（姓名、组织、生日，以及带标签的邮箱/电话/邮政地址）。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**Contacts 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

---

## Apple Photos——read 姿态、**牢笼化导出**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-photos.albums.list` | capability | `read` | 相册 + 文件夹及条目数（每层最多 200） |
| `apple-photos.search` | capability | `read` | **仅元数据**的媒体搜索（默认 20，最多 100） |
| `apple-photos.export` | capability | `read` | 把一个条目导出到 `~/.plexus/exports/photos/` 牢笼 |
| `apple-photos.how-to-use` | skill | — | 使用指引 |

三项都带 `read`——provider seam **没有任何改动照片库的方法**。`apple-photos.search` **仅搜元数据**（相册、拍摄日期范围、文件名/关键词子串——没有内容/ML 搜索，找不到"狗的照片"）；对超过 5000 个条目的无范围搜索会被拒绝——用 `album` 限定。`apple-photos.export` 有一个**如实声明的磁盘副作用**：它恰好写出**一个**文件，且*只*写进网关所有的牢笼目录 `~/.plexus/exports/photos/`（缺失则创建；每次导出一个全新子目录）。它永远写不到磁盘上任何别处，也绝不改动照片库本身——所以它如实地保持 `read` 授权，副作用在其 `describe` 文本里逐字写明。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**Photos 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化 ▸ 照片*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

::: tip 可注入 provider / TCC 的来龙去脉（全部 Apple source 都适用）
每个 source 通过一次 env 检查选择 provider——`process.env.PLEXUS_FAKE_APPLE === "1"` → 带夹具的**假** provider；否则是**真实** macOS provider（驱动 `osascript`/JXA，首次使用受 macOS TCC 管控）。这个选择在单元测试里也可注入。所以 `PLEXUS_FAKE_APPLE=1` 就是封闭、免 TCC 运行的单一开关——`bash run-tests.sh`、
[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md)
剧本和 CI 用的都是它。（**Shortcuts** 和 **Browser** 以各自的开关沿用同一模式：`PLEXUS_FAKE_SHORTCUTS=1` 与 `PLEXUS_FAKE_BROWSER=1`。）
:::

::: tip `osascript` 的性能，实话实说
Apple provider 靠 `osascript` 驱动各自的应用，在**超大存储**上很慢——列出或搜索成百上千条要花好几秒。把查询限定到时间窗口、具体列表/邮箱或相册，别一次索要全部。
:::

---

## Shortcuts——read + **execute**（默认记录模式）

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `shortcuts.list` | capability | `read` | 列出 shortcut 名称 + 文件夹名 |
| `shortcuts.run` | capability | `execute` | **按名字运行一个 shortcut → 挂起；默认记录模式** |
| `shortcuts.how-to-use` | skill | — | 使用指引 |

shortcut 是**用户自定义的自动化**——拥有者把它造成什么样，它就能干什么（发消息、移文件、控制应用）——所以 `shortcuts.run` 被**拥有者双重把关**：它带 `execute` 授权，**挂起等拥有者**；即便调用获批，默认也处于**记录模式**——返回 `launched: false`，外加*本来会*执行的那条 `shortcuts run` 命令原文，已记录、已审计，但**没有执行**——直到拥有者在 Plexus 控制台为这个 source 启用**真实启动**（*What I expose ▸ Shortcuts ▸ Real launch*）。`shortcuts.list` 是只读发现（绝不运行任何东西），自动批准；先 list 再 run——`run` 按**原文**接收 shortcut 名字。

**前置条件（真实 macOS）：**macOS 的 `shortcuts` CLI（现代 macOS 自带）。**自动注册**（编译进来的第一方 source）；CLI 是否在场经 **health** 如实上报，不靠隐藏条目。**封闭模式：**`PLEXUS_FAKE_SHORTCUTS=1`。

---

## Browser——**只读**（Safari + Chrome）

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `browser.tabs.list` | capability | `read` | Safari + Chrome 当前打开的标签页 |
| `browser.bookmarks.search` | capability | `read` | 按标题/URL 子串搜书签，有界（默认 20，硬上限 200） |
| `browser.history.search` | capability | `read` | 按子串 + 可选日期范围搜历史，最新在前，有界 |
| `browser.how-to-use` | skill | — | 使用指引 |

**构造上只读**——provider seam 任何地方都没有导航/打开/关闭/写入/删除方法；书签/历史的 sqlite 文件只会被**拷贝到临时路径**再读取（所以运行中的 Chrome 也不会挡住读取）。结果合并 Safari + Chrome，并**按浏览器优雅降级**：每个结果都带 `browsers.safari` / `browsers.chrome` 状态段；未安装、未运行或不可读的浏览器只贡献空列表加一条说明——绝不影响另一个浏览器的行。**自动注册**（编译进来的第一方 source）。

**前置条件（真实 macOS）：**列出标签页需要对每个浏览器各一次的**自动化** TCC 授权；**Safari 历史（和书签）需要完全磁盘访问权限**——没有它，Safari 这一半降级为 `unavailable`，Chrome 的结果照常返回。**封闭模式：**`PLEXUS_FAKE_BROWSER=1`（确定性内存夹具）。

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
