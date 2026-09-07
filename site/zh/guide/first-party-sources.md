---
title: 开放数据源
description: 内置官方数据源的能力 ID、所需授权、使用条件与读写范围。
---

# 内置的官方数据源 {#随附的第一方-source}

Plexus 随附一组**第一方**能力来源，网关一启动，代理就能发现其中的能力。本页逐一介绍各来源的**能力 ID**、**所需授权**、**启用与配置方法**、**前置条件**，以及**能读什么、能写什么**。

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
| **浏览器控制**（`browser-control`） | 读取 + **执行**（操控真实的 Chrome 浏览器） | 需要 Google Chrome；授权域名后才能使用 |
| **Workspace**（`workspace`） | read + **write** | 磁盘上一个已授权的工作目录 |
| **Claude Code**（`claudecode`） | **execute**（受沙箱约束） | PATH 上有 `claude` + macOS `sandbox-exec` |
| **Codex**（`codex`） | **execute**（受沙箱约束） | PATH 上有 `codex` CLI + macOS `sandbox-exec` |

::: tip 两种启用形态
Apple source（**Calendar**、**Reminders**、**Notes**、**Mail**、**Contacts**、**Photos**）、**Shortcuts**、**Browser**、**Browser control**，加上三个受沙箱约束的演示 / agent source（**Workspace**、**Claude Code**、**Codex**）都是**编译进网关**的，**自动注册**，没有添加步骤。Obsidian 适配器则是**受管 source**，在运行时添加（CLI 或 `/admin`）。两类下面都会讲到。
:::

::: warning 安全姿态（对它们全都适用）
默认拒绝访问，代理能访问哪些能力由你授权。连接代理时，你会选定它可访问的能力子集。对于已绑定的代理，能力必须属于你明确选定的子集，或有你为该代理创建且仍有效的持续授权，才在授权范围内。不在这个范围内的授权请求会直接被拒绝，不会进入待审批状态。连接时选中的 **read** 能力会获得 **standing** 持续授权；选中的副作用能力（write / execute）仍按 **per-use** 逐次授权，每次调用都要等待人工批准（`grant_pending_user` 流程，见 [连接一个 agent](/zh/guide/connect-an-agent)），除非你在连接时明确为该能力启用持续授权，或之后批准请求时授予有效的信任窗口。代理永远不能自行授予会改变状态的调用所需的权限。信任模型见 [项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md) 和 [看信任闭环](/zh/guide/run-it)。
:::

---

## Obsidian

Obsidian vault 说到底就是一个装 `.md` 文件的文件夹。Plexus 提供两种暴露方式——按你是否需要写入来选。

### `obsidian-fs`——直接、**只读**、路径受限

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `obsidian.vault.read` | 能力 | `read` | **代码只支持读取** |
| `obsidian.vault.search` | capability | `read` | 大小写不敏感的子串搜索，覆盖笔记路径 + 内容（默认 20 条命中，上限 100） |
| `obsidian.vault.how-to-cite` | 技能 | — | 使用说明，供代理阅读并作为上下文参考 |

**只支持读取**：代码没有实现写入或执行操作。文件访问也**限于笔记库内**：`../` 路径穿越、绝对路径，以及指向笔记库外的符号链接都会被拒绝，不会返回对应内容。

**前置条件：** 磁盘上有一个 vault 文件夹即可。**不需要 Obsidian 应用，不需要 plugin，不需要密钥。**

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
| `obsidian-rest.vault.write` | 能力 | `write` | **创建或覆盖笔记，替换整篇内容 → 默认等待人工审批（PENDS）** |
| `obsidian-rest.vault.append` | 能力 | `write` | **在笔记末尾追加内容（笔记不存在时会创建）→ 默认等待人工审批（PENDS）** |
| `obsidian-rest.vault.how-to-use` | skill | — | 使用指引 |

**使用条件：** 在**同一台 Mac** 上的 Obsidian 应用中安装并运行 **Obsidian Local REST API** 插件。插件通过 HTTPS 在回环地址提供服务，默认地址为 `https://127.0.0.1:27124`，使用插件设置中的 Bearer API 密钥认证。Plexus **仅在主机解析为回环地址时**接受插件的自签名证书；传输层会在*每次调用前*重新检查这一条件。

**启用**（API key **只从 STDIN 读取**——绝不走 argv，那会经 `ps` 泄漏——按名字存进 `~/.plexus/secrets/`，绝不回显）：

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

**一条值得当真的写入警告：**`obsidian-rest.vault.write` 会**替换整条笔记**（`PUT /vault/{path}`，请求体是完整的 markdown 全文）——先读出笔记，再把想保留的内容全部重发。做增量编辑——日志、跟进、随手记——优先用 `obsidian-rest.vault.append`：它追加到笔记末尾，保留已有内容（笔记不存在时会创建）。

两种写入（`vault.write` / `vault.append`）都需要 `write` 授权，默认**等待人工审批**：代理会收到 `grant_pending_user`，由你在 **Approvals** 标签页批准。若你在连接时为该能力开启的持续授权仍有效，或已批准其请求且授予的信任期限尚未结束，则无需逐次审批。三项读取能力中，连接时选中的会获得**持续授权**，调用可直接通过。重新配置数据源的 `--base-url` 或密钥会**清除该数据源的全部授权**，先前的批准不能沿用到新端点。完整的数据源管理说明见 [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)。

---

## Apple Calendar——**只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | 列出日历 |
| `apple-calendar.events.list` | capability | `read` | 列出某时间窗口内的事件 |
| `apple-calendar.how-to-use` | skill | — | 使用指引 |

**只读**：提供程序仅有 `listCalendars()` 和 `listEvents()` 两个方法，用于列出日历和事件，没有写入途径。**自动注册**（第一方来源，已编译进程序），无需另行添加。

**前置条件（真实 macOS 环境）：** 需要 Calendar 应用，以及一次性的 macOS **TCC** 授权。**首次调用真实提供方时**，Plexus 会运行 `osascript -l JavaScript`（JXA），触发 macOS 授权对话框；权限位于 *System Settings ▸ Privacy & Security ▸ Automation*（以及 *Calendars*）。如果你拒绝授权，调用会失败，并明确提示你到系统设置中启用权限。Plexus 无法再次弹出授权提示，你需要自行到系统设置中重新授权。

**隔离模式（无需 macOS 或 TCC）**：设置 `PLEXUS_FAKE_APPLE=1` 后，来源会选用**模拟提供程序**，使用一套固定的内存测试数据，包括示例日历 `Home`、`Work`、`Birthdays` 和示例事件。验收手册和测试检查也通过这种方式运行。

```sh
PLEXUS_FAKE_APPLE=1 bun run start     # fake providers — no TCC, deterministic fixtures
```

---

## Apple Reminders——**读 + 写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-reminders.lists.list` | capability | `read` | 列出提醒列表 |
| `apple-reminders.reminders.list` | capability | `read` | 列出提醒 |
| `apple-reminders.reminders.create` | capability | `write` | **创建提醒事项 → PENDS（等待批准）** |
| `apple-reminders.reminders.complete` | capability | `write` | **将提醒事项标为已完成 → PENDS（等待批准）** |
| `apple-reminders.skill.how-to-use` | skill | — | 使用指引 |

这两个**写入能力**会修改用户的 *Reminders* 数据，`describe` 已明确说明这一点。它们都需要 `write` 授权，因此会**等待批准**。两个读取能力中，连接时选中的会获得**持续授权**，调用可直接执行。**自动注册**（第一方来源，已编译进程序）。

**前提条件（在 macOS 上实际运行）**：需要 Reminders 应用和一次 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化* + *提醒事项*）。真实提供程序调用 `osascript`，通过 AppleScript 中的 `tell application "Reminders"` 操作应用；首次调用真实提供程序时会弹出授权提示。**隔离模式**：设置 `PLEXUS_FAKE_APPLE=1`，初始列表为 `Reminders` 和 `Groceries`；创建和完成操作会修改内存中的数据。

---

## Apple Notes——**读 + 仅限创建的写**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-notes.folders.list` | capability | `read` | 列出文件夹（按账户） |
| `apple-notes.notes.search` | capability | `read` | 有界的标题/正文搜索（默认 20 条命中，硬上限 50） |
| `apple-notes.notes.read` | capability | `read` | 按 id 或精确标题读一条笔记（`text` + 原始 `html`） |
| `apple-notes.notes.create` | capability | `write` | **创建一条新笔记 → PENDS（等待批准）** |
| `apple-notes.skill.how-to-use` | skill | — | 使用指引 |

**写入仅限创建**：只能创建**新**笔记。这个来源没有更新、删除、移动或重命名操作：提供程序没有这些方法，桥接层也没有对应的处理函数。无法通过 Plexus 修改或删除已有笔记。`apple-notes.notes.create` 仍需 `write` 授权，并会**等待批准**；三个读取能力中，连接时选中的会获得**持续授权**，调用可直接执行。搜索只返回结果摘要，包括 id、标题、文件夹、修改日期和简短片段，不返回完整正文；将结果中的 `id` 传给 `notes.read`，才能读取实际内容。**自动注册**（第一方来源，已编译进程序）。

**前置条件（真实 macOS）：** Notes 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）——provider 驱动 `osascript`/JXA。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具；`create` 改动内存存储）。

---

## Apple Mail——**严格只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-mail.mailboxes.list` | capability | `read` | 账户 + 各邮箱及未读数 |
| `apple-mail.messages.search` | capability | `read` | 在单个邮箱内的有界搜索（默认 20，硬上限 50） |
| `apple-mail.message.read` | capability | `read` | 按 id 读一封邮件的纯文本（正文上限 20,000 字符） |
| `apple-mail.how-to-use` | skill | — | 使用指引 |

**严格只读**：所有能力都使用 `read` 授权，提供程序**没有创建草稿、发送、移动或删除邮件的方法**；这些操作在来源中并不存在，并非仅仅禁止调用。搜索**一次只查一个邮箱**，默认的 `INBOX` 指统一收件箱。可按发件人或主题中包含的文字、收件日期范围筛选，条件可单独或组合使用。结果从新到旧排列，附带约 200 个字符的片段和 `truncated` 标记。邮箱较大时，宜用日期范围或发件人缩小搜索范围。**自动注册**（第一方来源，已编译进程序）。

**前置条件（真实 macOS）：** Mail 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

---

## Apple Contacts——**只读**

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-contacts.contacts.search` | capability | `read` | 有界的姓名/邮箱/电话子串搜索（默认 20，硬上限 50） |
| `apple-contacts.contacts.read` | capability | `read` | 按联系人 id 读完整名片 |
| `apple-contacts.how-to-use` | skill | — | 使用指引 |

**只读**：提供程序没有创建、更新或删除联系人的方法，这个来源没有任何写入能力。搜索按姓名、电子邮件地址或电话号码中的部分内容匹配，不区分大小写；电话匹配只比较数字，且查询中须有至少 3 位数字。`contacts.read` 则返回完整联系人名片，包括姓名、组织、生日，以及带标签的电子邮件地址、电话号码和邮寄地址。**自动注册**（第一方来源，已编译进程序）。

**前置条件（真实 macOS）：** Contacts 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

---

## Apple Photos：读取照片库，**导出限于指定目录** {#apple-photos——read-姿态、牢笼化导出}

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `apple-photos.albums.list` | capability | `read` | 相册 + 文件夹及条目数（每层最多 200） |
| `apple-photos.search` | capability | `read` | **仅元数据**的媒体搜索（默认 20，最多 100） |
| `apple-photos.export` | capability | `read` | 每次仅导出一个项目，且只能写入 `~/.plexus/exports/photos/` 目录 |
| `apple-photos.how-to-use` | skill | — | 使用指引 |

这三个能力都使用 `read` 授权，提供程序**没有修改照片库的方法**。`apple-photos.search` **只搜索元数据**，可按相簿、拍摄日期范围、文件名或关键词中包含的文字筛选；不支持内容搜索或机器学习搜索，因此无法查找“photos of dogs”。未限定范围且涉及超过 5,000 个项目的搜索会被拒绝，需用 `album` 限定相簿。`apple-photos.export` **已声明会写入磁盘**：每次只写入**一个**文件，且*只能*写入网关自己的 `~/.plexus/exports/photos/` 目录；目录不存在时会创建，每次导出都新建一个子目录。它不能写入其他位置，也不会修改照片库，因此仍可如实标注为 `read` 授权，`describe` 文本中逐字披露了这一磁盘副作用。**自动注册**（第一方来源，已编译进程序）。

**前置条件（真实 macOS）：** Photos 应用，加一次性 **TCC** 授权（*系统设置 ▸ 隐私与安全性 ▸ 自动化 ▸ 照片*）。**封闭模式：**`PLEXUS_FAKE_APPLE=1`（确定性内存夹具）。

::: tip 可注入 provider / TCC 的来龙去脉（全部 Apple source 都适用）
每个来源都按同一个环境变量条件选择提供程序：`process.env.PLEXUS_FAKE_APPLE === "1"` 成立时，使用带有预设测试数据的**模拟**提供程序；否则使用 macOS 上的**真实**提供程序，通过 `osascript`／JXA 操作应用，首次使用时须经 macOS TCC 授权。单元测试也可以直接注入所需的提供程序。因此，设置 `PLEXUS_FAKE_APPLE=1` 就能在隔离模式下运行，无需 TCC；`bash run-tests.sh`、[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md) 验收手册和 CI 都使用这个开关。
**Shortcuts** 和 **Browser** 采用同样的方式，但分别使用自己的开关：`PLEXUS_FAKE_SHORTCUTS=1` 和 `PLEXUS_FAKE_BROWSER=1`。
:::

::: tip `osascript` 的性能，实话实说
Apple 提供方通过 `osascript` 操作应用，**应用里的记录量很大时会比较慢**；列出或搜索几百、几千条记录，可能要等上几秒。查询时尽量限定时间窗口、列表、邮箱或相簿，别一次请求全部内容。
:::

---

## Shortcuts——read + **execute**（默认记录模式）

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `shortcuts.list` | capability | `read` | 列出 shortcut 名称 + 文件夹名 |
| `shortcuts.run` | 能力 | `execute` | **运行一个指定名称的快捷指令 → PENDS（等待所有者批准）；默认为记录模式** |
| `shortcuts.how-to-use` | skill | — | 使用指引 |

快捷指令是**用户定义的自动化**，能执行主人为它编排的各种操作，比如发送消息、移动文件或控制应用。因此，`shortcuts.run` 需要**主人把关两次**：调用需要 `execute` 授权，并会**等待主人批准**；即使获得批准，默认也只进入**记录模式**，返回 `launched: false` 和*原本会执行的*完整 `shortcuts run` 命令。命令会被记录并纳入审计，但**不会执行**，直到主人在 Plexus 控制台为此来源单独开启**实际启动**（*What I expose ▸ Shortcuts ▸ Real launch*）。`shortcuts.list` 只读取快捷指令信息，从不运行任何快捷指令；连接时选中它，就会获得**持续授权**，调用可直接通过。运行前一定先列出快捷指令，`run` 接收的名称必须与快捷指令名称**逐字一致**。

**前提（真实 macOS 环境）：** 需要 macOS 的 `shortcuts` CLI（新版 macOS 自带）。**自动注册**（第一方来源，编译时内置）。CLI 是否存在通过 **health** 报告；即使缺少 CLI，条目也照常显示。**隔离模式：** `PLEXUS_FAKE_SHORTCUTS=1`。

---

## Browser——**只读**（Safari + Chrome）

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `browser.tabs.list` | capability | `read` | Safari + Chrome 当前打开的标签页 |
| `browser.bookmarks.search` | capability | `read` | 按标题/URL 子串搜书签，有界（默认 20，硬上限 200） |
| `browser.history.search` | capability | `read` | 按子串 + 可选日期范围搜历史，最新在前，有界 |
| `browser.how-to-use` | skill | — | 使用指引 |

**从设计上保证只读**：提供浏览器数据的接口没有导航、打开、关闭、写入或删除方法。书签和历史记录的 SQLite 文件一律先**复制到临时路径**，再从副本读取，所以 Chrome 正在运行也不会阻塞读取。Safari 与 Chrome 的结果合并返回，**一个浏览器不可用不会影响另一个的结果**。每份结果都包含 `browsers.safari` 和 `browsers.chrome` 状态部分。浏览器未安装、未运行或无法读取时，对应结果为空列表，并附带说明。**自动注册**（第一方来源，编译时内置）。

**前置条件（真实 macOS）：** 列出标签页需要对每个浏览器各一次的**自动化** TCC 授权；**Safari 历史（和书签）需要完全磁盘访问权限**——没有它，Safari 这一半降级为 `unavailable`，Chrome 的结果照常返回。**封闭模式：**`PLEXUS_FAKE_BROWSER=1`（确定性内存夹具）。

---

## 浏览器控制：操作真实的 Chrome（**read + execute**） {#browser-control}

`browser-control` 与上面的只读 `browser` 是**两个独立的来源**。后者的接口**不提供任何会修改状态的方法**，因此能保证只读；如果加入页面控制，这个保证就不成立了。

它直接使用 **Chrome DevTools Protocol**，不依赖 Puppeteer 或 Playwright，也不下载浏览器。CDP 通过 WebSocket 传输 JSON 消息，运行时已经支持这两者。

### 选择**要控制的浏览器** {#真正定分量的那个决定-给哪个浏览器}

各模式提供的能力相同，区别在于**调试端点来自哪里**。这决定了代理连接哪个浏览器，以及能接触到哪些已有的登录会话：

| 模式 | agent 拿到的浏览器 | 它能触达什么 |
| --- | --- | --- |
| **`launch`**（默认） | Plexus 自己拉起的 Chrome，用**自己的 profile** | 一个干净的浏览器——没有 cookie，没有已登录会话 |
| **`attach`**（所有者 opt-in） | **你正在用的** Chrome，经 `chrome://inspect/#remote-debugging` | **那个浏览器登录过的每一个会话** |
| **`extension`**（所有者 opt-in） | 同样是你正在用的 Chrome，经 Plexus 扩展 | 同上——但同意只在安装时给**一次** |

`launch` 用干净的独立配置处理普通的“读一下这个页面”任务，是安全的默认选择。另外两种模式能访问**你已登录的会话**，必须由所有者明确选择，与执行源的 `Real launch` 一样。

Chrome 自己的同意是**全有或全无**的——它的权限对话框授权的是**那个浏览器**，不是一组站点。所以你真正想要的那条边界（「这个 agent 可以碰 GitHub，别的不行」）**不可能**来自 Chrome。它来自 Plexus。

### Capability

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `browser-control.tabs.list` | capability | `read` | 哪些标签页可被驱动——**只列已授权域名的** |
| `browser-control.page.read` | capability | `read` | 页面的标题、url 与渲染后的文本 |
| `browser-control.page.elements` | capability | `read` | 可交互元素及可用的选择器；密码框只报长度 |
| `browser-control.page.screenshot` | capability | `read` | 视口截图，或用 `fullPage` 截整页 |
| `browser-control.page.scroll` | capability | `read` | 移动视口；回报 `atBottom` |
| `browser-control.page.wait` | capability | `read` | 等待选择器匹配到元素、指定文字出现或页面加载完成 |
| `browser-control.frames.list` | capability | `read` | 内嵌 frame，按**它自己的**域名判定 |
| `browser-control.page.navigate` | capability | `execute` | **跳转到指定 URL；待审批状态为 PENDS**——白名单主要检查这个 URL |
| `browser-control.page.click` | capability | `execute` | **按选择器定位元素并发送真实的指针事件序列；待审批状态为 PENDS** |
| `browser-control.page.type` | capability | `execute` | **向输入字段或编辑器填入内容；待审批状态为 PENDS** |
| `browser-control.page.press` | capability | `execute` | **发送真实的按键事件；待审批状态为 PENDS**（Enter 可以提交） |
| `browser-control.page.upload` | capability | `execute` | **上传文件；待审批状态为 PENDS**，文件只能来自你指定的上传目录 |
| `browser-control.page.evaluate` | capability | `execute` | **以页面身份执行 JavaScript；待审批状态为 PENDS** |
| `browser-control.page.cdp` | capability | `execute` | **原样传递任意页面范围内的 CDP 命令；待审批状态为 PENDS** |
| `browser-control.how-to-use` | skill | — | 使用指引 |

**页面操作能力是有意开放的。** 在代理已经获准操作的页面里，`click` + `type` 就能下单、发送、删除和修改设置。再禁用 `evaluate` 并不能防止实际伤害，只会让这套能力不如所有者另选的工具好用。仍不开放的是 **CDP 的浏览器全局命令**，也就是**不属于任何页面的那部分**，这样域名允许列表才有实际约束力。

滚动和等待属于**读取**：它们只改变可见内容或等待时长，不能提交内容、打开链接或触发页面操作。

### 访问边界：域名白名单 {#边界——域名-allowlist}

每次调用都会确定一个**目标 URL**，服务端从实际目标解析其 origin，再按**你设置的白名单**检查，不依据代理自行声明的字段授权。检查遵循三条规则：

1. **允许列表未设置时，对自己的浏览器拒绝访问。** 使用 `attach` 或 `extension` 时，未设置就是**不允许访问**。Plexus 用空配置启动的浏览器没有已登录会话，因此未设置时允许访问公开网络。两种情况都只允许 `http`/`https`，不包括本地文件或 Chrome 设置页。
2. **每条记录授权指定域名及其子域名。** `deepseek.com` 包括 `www.deepseek.com`。匹配使用解析后的主机名，以**点号为边界**，因此不包括 `deepseek.com.evil.com` 和 `evildeepseek.com`。IP 地址必须完全匹配，URL 的协议也必须匹配；授权一个站点，不等于授权它的明文版本。
3. **每次操作前都重新检查标签页当前的 origin。** 标签页在 `github.com` 时获准访问，跳转到 `mail.google.com` 后就不再获准，复用现有调试套接字的调用也一样。复用只是传输优化，不会沿用之前的授权结果。

跨站点 `<iframe>` 在独立的渲染器中运行，**与标签页一样，按自己的域名检查**。页面获准访问，不代表它嵌入的内容也获准；其中已登录的 `accounts.google.com` 框架仍须单独通过域名检查。

源级允许列表与每个代理的范围限制同时生效；授权约束只能进一步缩小访问范围，不能放宽源级允许列表。

### 上传是一条外泄通道

`page.upload` 会把本机文件交给网站。**目录限制是这项功能的核心**：路径相对于所有者指定的一个目录，并通过与文件源相同的词法检查和 realpath 检查，确保文件位于该目录内。**未设置目录就拒绝所有上传**，与已登录浏览器未设置允许列表时一样，默认拒绝访问。审计记录**完整路径和文件大小**；发送文件时只附上文件名。

### 怎么配

在控制台的 **What I expose → Browser control** 下，三项设置：

- **模式**——`launch` / `attach` / `extension`。
- **已授权域名**——一行一个。对一个你已登录的浏览器，空名单拒绝一切。
- **上传目录**——没设就拒绝一切上传。

改动即时生效，不必重启。启动时的兜底是 `PLEXUS_BROWSER_CONTROL_MODE`、`PLEXUS_BROWSER_CONTROL_ORIGINS`（逗号分隔）与 `PLEXUS_BROWSER_CONTROL_UPLOAD_DIR`；控制台里保存过的设置优先于环境变量。

**使用 `attach`：** 先在 `chrome://inspect/#remote-debugging` 开启远程调试（Chrome 144+），只需开启一次。从 Chrome 136 起，**Chrome 拒绝在默认用户配置上启用 `--remote-debugging-port`**，因此，要连接你实际登录使用的浏览器，**只能通过这个开关**。此后每次连接，Chrome 都会询问是否允许，并显示“正受到自动测试软件控制”的横幅。

**用 `extension`：** 先注册一次本地消息宿主，再加载扩展：

```sh
bun run packages/runtime/src/sources/browser-control/install-native-host.ts
```

然后 `chrome://extensions` → **开发者模式** → **加载已解压的扩展程序** → 选 `extension/plexus-browser`。有网关连上时，徽标是绿色。

扩展**只负责传输**，没有白名单，也没有审批逻辑。原生消息宿主由 Chrome 自行启动，而且 Chrome 只会为该扩展启动清单中列有该扩展 ID 的宿主。两者的绑定由 Chrome 保证，无需你复制配对令牌。与远程调试开关相比，这种方式的 Chrome 连接许可**只在安装时授予一次**，无需每次连接都确认。

**前提：** Google Chrome。此源**自动注册**（内置、第一方），在**授权域名之前不启用**；是否安装 Chrome 通过 **health** 呈现，不会因此隐藏条目。Plexus 在关闭时会关闭自己的调试套接字和自己打开的标签页，避免代理浏览时在你的 Chrome 中不断积累窗口。

---

## Workspace——沙箱化工作目录（**读 + 写**）

`workspace` 将磁盘上一个获授权的工作目录开放为**文件读写接口**，供演示流程存放临时文件和输出。它与下面的 Claude Code、Codex 共用这一目录：智能体先在这里列出、读取文件，再让其中一个工具在目录内构建，最后读回产物。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `workspace.list` | capability | `read` | 列出目录（只读） |
| `workspace.read` | capability | `read` | 读文件（只读） |
| `workspace.write` | capability | `write` | **创建或覆盖文件 → PENDS（待批准）** |
| `workspace.how-to-use` | skill | — | 使用指引 |

与 Obsidian vault 读取器一样，工作区有**路径限制**：所有路径都必须解析到工作区根目录内；通过 `..`、绝对路径或指向目录外的符号链接越界，都会被拒绝。连接时选定的两个读取操作（`list`／`read`）获得**持续授权**，调用可直接执行。`workspace.write` 属于第一方来源，使用 `write` 授权，因此会**等待所有者批准**。该来源**自动注册**（内置、第一方）；获授权的目录是否存在，由 **health** 报告，不会因此隐藏条目。

---

## Claude Code——无头、**受沙箱约束**（`execute`）

`claudecode` 将 Claude Code CLI 开放为**一项敏感能力**：以无头模式启动 Claude Code，执行实际编码工作，**由 macOS `sandbox-exec` 将其限制在获授权的目录内**。智能体只能提交 `{ prompt }`，没有可用的 shell 或启动命令。对目录外的读写**会被内核拒绝**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | **在获授权的目录内以无头模式启动 Claude Code → PENDS（待批准）** |
| `claudecode.how-to-use` | skill | — | 使用指引 |

`claudecode.run` 是第一方来源的 `execute` 能力，属于敏感执行操作，**调用后须等待所有者批准**。两次调用之间，通过 `workspace.read` 验证产物。它**会自动注册**（编译内置的第一方来源）；`claude` + `sandbox-exec` 是否存在会通过 **health** 报告，不会因为缺失而隐藏入口。

---

## Codex——无头、**受沙箱约束**（`execute`）

`codex` 与 `claudecode` 相对应：它以无界面模式运行本地 Codex CLI（`codex exec`），完成实际编码工作，**由 macOS `sandbox-exec` 将操作限制在授权目录内**。和 Claude Code 一样，调用时只提供 `{ prompt }`（另可指定受限目录内的 `cwd`），目录外的读写**会在内核层失败**。

| Capability id | 类别 | 授权 | 暴露面 |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | **在获授权的目录内以无头模式启动 `codex exec` → PENDS（待批准）** |
| `codex.how-to-use` | skill | — | 使用指引 |

`codex.run` 是第一方来源的 `execute` 操作，调用后默认须**等待所有者批准**；所有者已明确为该智能体和这项能力启用持续授权时，无需逐次批准。本地缺少 `codex` CLI 时，调用返回 `source_unavailable`，会话仍可继续。该来源**自动注册**（内置、第一方）；`codex` + `sandbox-exec` 是否存在，由 **health** 报告。

---

## 接下来去哪

- [连接一个 agent](/zh/guide/connect-an-agent) — 用原始 HTTP **和**真实的 Codex 智能体走完整个能力调用流程，包括调用进入待批准状态后，由所有者批准的步骤。
- [编写一个扩展](/zh/guide/create-an-extension)——添加网关未随附的 capability。
- [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)
  ——完整的受管 source 生命周期（添加 / 启用 / 禁用 / 重新配置 / 移除）。
