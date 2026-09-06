---
title: "暴露源"
description: "查看随附的第一方 source，查清各自的 capability id、授权方式和使用前提，分清哪些能力只读、哪些会写入或执行操作，再决定开放哪些。"
---
# 随附的第一方 source {#随附的第一方-source}

Plexus 随附一组第一方 capability source，用来读取本机应用和文件、写入指定目录，或运行受约束的操作。本页逐一说明它们的 `capability id`、所需授权、启用与配置方法、前置条件，以及哪些只能读、哪些可以写或执行。source 注册到网关，并不等于 agent 已有权访问。

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
| **Browser control**（`browser-control`） | read + **execute**（驱动真实的 Chrome） | Google Chrome；域名允许列表为空时，`attach` 和 `extension` 拒绝访问，`launch` 允许在其干净配置文件中访问 HTTP/HTTPS |
| **Workspace**（`workspace`） | read + **write** | 磁盘上一个已授权的工作目录 |
| **Claude Code**（`claudecode`） | **execute**（受沙箱约束） | PATH 上有 `claude` + macOS `sandbox-exec` |
| **Codex**（`codex`） | **execute**（受沙箱约束） | PATH 上有 `codex` CLI + macOS `sandbox-exec` |

::: tip 两种启用方式
Apple source（**Calendar**、**Reminders**、**Notes**、**Mail**、**Contacts**、**Photos**）、**Shortcuts**、**Browser**、**Browser control**，以及三个受沙箱约束的演示 / agent source（**Workspace**、**Claude Code**、**Codex**），都已编译进网关，启动时自动注册，不必手动添加。

Obsidian 适配器是受管 source，需要在运行时通过 CLI 或 `/admin` 添加。下面分别说明这两类 source 的配置和使用方法。
:::

::: warning 所有 source 都遵守的授权规则
默认拒绝。连接 agent 时，你为它勾选可触达的 capability 子集；此外，所有者为该 agent 创建、未过期且通过当前 `connection-key` epoch 校验的有效常驻授权，也能把对应 capability 纳入有效授权范围。授权请求的子集检查接受这两种依据中的任一种；两者都不具备的请求直接拒绝，不会挂起等待批准。有效授权范围决定它可以请求什么，不代表其中每项操作都已获准调用。

连接时选中的 **read** 会获得常驻授权；**write** 和 **execute** 默认逐次审批，每次调用都要等待人类批准，即 `grant_pending_user` 流程，见[连接一个 agent](/zh/guide/connect-an-agent)。

常驻授权的例外由所有者决定。你可以在连接时为特定 agent 的某项 capability 显式启用常驻授权，或之后直接授予。符合条件的 **write**，也可以在待批请求获准时，通过一个真实的信任窗口成为常驻授权。**execute** 则必须由所有者显式选择常驻，agent 仅仅请求更长的窗口不能获得它。已有且仍有效的合格常驻授权可以复用，不必再次审批；agent 不能给自己授予有副作用的调用权限。完整信任模型见[项目 README](https://github.com/nemori-ai/plexus/blob/main/README.md)和[查看信任闭环](/zh/guide/run-it)。
:::

---

## Obsidian {#obsidian}

Obsidian vault 就是一个装着 `.md` 文件的文件夹。只需要读取、搜索笔记，可以用 `obsidian-fs` 直接读这个文件夹；需要写入，就选 `obsidian-rest`，通过 Local REST API plugin 接入。

### `obsidian-fs`：直接读取，只读且路径受限 {#obsidian-fs——直接、只读、路径受限}

磁盘上有一个 vault 文件夹，就能使用 `obsidian-fs`。不需要安装 Obsidian 应用，不需要 plugin，也不需要密钥。你把文件夹的位置交给 Plexus，它就可以从这里提供笔记读取和搜索。

这个 source 提供以下三个条目。前两个是需要 `read` 授权的 capability，第三个是供 agent 作为上下文阅读的使用指引。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `obsidian.vault.read` | capability | `read` | 读取笔记，代码本身保证只读 |
| `obsidian.vault.search` | capability | `read` | 对笔记路径和内容做不区分大小写的子串搜索，默认返回 20 条命中，最多 100 条 |
| `obsidian.vault.how-to-cite` | skill | — | 使用指引，作为上下文阅读 |

只读由代码本身保证：`obsidian-fs` 中没有写入或执行操作的代码路径。通过这个 source，agent 能读取、搜索笔记，没有可以调用的修改或执行入口。

读取范围也有明确边界。传入的路径必须留在 vault 内：用 `../` 向上穿越、传入绝对路径，或者借符号链接指向 vault 外部，都会被拒绝。符号链接即使放在 vault 里，只要它指向外部，也不能借它读出外面的文件。

添加时，指定磁盘上的 vault 路径即可。`obsidian-fs` 属于受管 source，配置会持久化到 `~/.plexus/sources.json`；添加后热加载，不需要重启网关。在仓库根目录运行下面任一条命令。CLI 和启动器快捷方式添加并持久化的是同一个受管 source。

```sh
# via the plexus CLI
bun run packages/cli/src/bin/plexus source add obsidian-fs --vault-path ~/Documents/MyVault

# or the launcher shortcut (persists the same managed source)
bun run start --vault ~/Documents/MyVault
```

也可以打开 `/admin`，在 What I expose 标签页添加。添加完成后，用下面的命令查看 source 列表，确认 `obsidian-fs` 已显示为 `enabled · live`：

```sh
bun run packages/cli/src/bin/plexus source list
# → … obsidian-fs … enabled · live … capabilities:…
```

同一个 source 也会出现在 `/admin` 的 What I expose 树里。要确认 agent 能否发现它，可以让已获你授权的 agent 查看自己的 `list`，其中应当能看到 `obsidian.vault.read`。

### `obsidian-rest`：通过 Local REST API plugin 读写笔记 {#obsidian-rest——经由-local-rest-api-plugin-的读-写}

使用 `obsidian-rest`，需要在同一台 Mac 的 Obsidian 应用里安装并运行 Obsidian Local REST API plugin。它在回环地址上提供 HTTPS 服务，默认端点为 `https://127.0.0.1:27124`，通过 plugin 设置中的 Bearer API key 认证。Plexus 接受它的自签名证书，仅仅因为主机解析到回环地址；transport 在每次调用前都会重新核验这一点。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `obsidian-rest.vault.list` | capability | `read` | 列出 vault 条目 |
| `obsidian-rest.vault.read` | capability | `read` | 读取一条笔记 |
| `obsidian-rest.vault.search` | capability | `read` | 全文搜索 vault，使用 `POST /search/simple/` |
| `obsidian-rest.vault.write` | capability | `write` | 创建或覆盖笔记，替换整条内容；默认挂起待批，已有合格常驻授权可复用 |
| `obsidian-rest.vault.append` | capability | `write` | 追加到笔记末尾，不存在则创建；默认挂起待批，已有合格常驻授权可复用 |
| `obsidian-rest.vault.how-to-use` | skill | — | 使用指引 |

添加 source 时，API key 只从 STDIN 读取。密钥不能放进 argv，因为命令行参数会经 `ps` 泄漏。下面的命令通过管道传入密钥，再以 `obsidian-local-rest-api-key` 为名存进 `~/.plexus/secrets/`，整个过程绝不回显密钥：

```sh
printf %s "$OBSIDIAN_KEY" | bun run packages/cli/src/bin/plexus source add obsidian-rest \
    --base-url https://127.0.0.1:27124 --secret-name obsidian-local-rest-api-key --api-key-stdin
```

写入前要分清两项操作。`obsidian-rest.vault.write` 会替换整条笔记：它调用 `PUT /vault/{path}`，请求体就是完整的 markdown 全文。修改已有笔记时，先读出原文，再把修改后的全文发回去，所有想保留的内容都要一起重发。只发送改动的部分，就只会留下这部分内容。

日志、跟进、随手记这类增量内容，优先用 `obsidian-rest.vault.append`。它把新内容追加到笔记末尾，保留已有内容；如果笔记还不存在，就创建笔记。需要替换全文时用 `vault.write`，只往末尾增加内容时用 `vault.append`。

这两项操作都需要 `write` 授权，默认逐次审批。没有可复用的合格常驻授权时，授权请求会挂起，agent 收到 `grant_pending_user`，由你在 Approvals 标签页批准。表里的“默认挂起待批”指的就是这个流程。

是否改为常驻，由所有者决定。你可以在连接时为特定 agent 的某项 capability 显式启用常驻授权，也可以之后直接授予；写入请求还可以在你批准时，通过一个真实的信任窗口获得常驻授权。已有符合条件且仍有效的常驻授权，就不必再次批准。连接时勾选的三项 `read` 则会获得常驻授权，后续调用直接通过授权检查。

重新配置这个 source 的 `--base-url` 或密钥，会清除它的已有授权。此前的批准不能沿用到新端点，换密钥后也需要重新授权。添加、启用、禁用、重新配置和移除 source 的完整说明，见 [`docs/sources/MANAGING-SOURCES.md`](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)。

---

## Apple Calendar：只读 {#apple-calendar——只读}

Apple Calendar 可以列出日历，也可以列出某个时间窗口内的事件。它已作为第一方 source 编译进网关，启动时自动注册，不需要手动添加。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-calendar.calendars.list` | capability | `read` | 列出日历 |
| `apple-calendar.events.list` | capability | `read` | 列出某个时间窗口内的事件 |
| `apple-calendar.how-to-use` | skill | — | 使用指引 |

只读由代码本身保证。provider 只暴露 `listCalendars()` 和 `listEvents()`，没有写入路径。

在真实 macOS 上使用，需要 Calendar 应用，以及一次性的 macOS TCC 授权。Plexus 的 capability 授权与 TCC 授权是两件事：前者决定 agent 能否调用这项能力，后者决定 provider 能否访问本机应用。真实调用需要两边都获准；在 Plexus 里批准了读取，并不会同时授予系统权限。

第一次实时调用会通过 shell 运行 `osascript -l JavaScript`，用 JXA 访问 Calendar，并触发 macOS 授权对话框。相关权限在“系统设置 ▸ 隐私与安全性 ▸ 自动化”以及“日历”中。

如果拒绝，调用会失败，并明确提示你到系统设置里启用权限。Plexus 无法替你再次弹出授权框，需要你自己去系统设置重新授予。

没有 macOS，或需要在不经过 TCC 的封闭模式下运行，可以设置 `PLEXUS_FAKE_APPLE=1`。这时 source 会选用假 provider，数据来自确定性的内存夹具，包括 `Home`、`Work`、`Birthdays` 三个示例日历和示例事件。验收剧本和测试关卡使用的就是这个模式：

```sh
PLEXUS_FAKE_APPLE=1 bun run start     # fake providers — no TCC, deterministic fixtures
```

---

## Apple Reminders：读取与写入 {#apple-reminders——读-写}

Apple Reminders 可以列出提醒列表和其中的提醒，也可以创建一条提醒，或把已有提醒标为完成。这个第一方 source 同样编译进网关，启动时自动注册，不需要添加。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-reminders.lists.list` | capability | `read` | 列出提醒列表 |
| `apple-reminders.reminders.list` | capability | `read` | 列出提醒 |
| `apple-reminders.reminders.create` | capability | `write` | 创建一条提醒；默认挂起待批，已有合格常驻授权可复用 |
| `apple-reminders.reminders.complete` | capability | `write` | 把提醒标为完成；默认挂起待批，已有合格常驻授权可复用 |
| `apple-reminders.skill.how-to-use` | skill | — | 使用指引 |

创建和标记完成都会实际改动用户的 Reminders，两项 capability 的 `describe` 也明确说明了这一点。它们都需要 `write` 授权，默认逐次审批：没有可复用的合格常驻授权时，请求会挂起，等待所有者批准。

所有者可以为特定 agent 的某项 capability 显式启用常驻授权，也可以之后直接授予；符合条件的写入请求，还可以在获批时通过一个真实的信任窗口获得常驻授权。已有符合条件且仍有效的常驻授权，就不必每次重新批准。连接时勾选的两项 `read` 会获得常驻授权，后续调用直接通过 Plexus 的授权检查。

访问真实数据，需要 macOS 上的 Reminders 应用，以及一次性的 TCC 授权。“系统设置 ▸ 隐私与安全性”中的“自动化”和“提醒事项”权限都要满足，Plexus 授权不能替代它们。真实 provider 通过 `osascript` 执行 AppleScript，用 `tell application "Reminders"` 访问应用，首次实时使用会弹出系统授权对话框。

封闭模式仍使用 `PLEXUS_FAKE_APPLE=1`。假 provider 预置了 `Reminders` 和 `Groceries` 两个种子列表；创建提醒和标记完成会改动内存存储。

---

## Apple Notes：读取笔记，写入仅限创建 {#apple-notes——读-仅限创建的写}

Apple Notes 可以按账户列出文件夹，搜索和读取笔记，也可以创建一条新笔记。它是编译进网关的第一方 source，启动时自动注册，不需要手动添加。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-notes.folders.list` | capability | `read` | 按账户分组列出文件夹 |
| `apple-notes.notes.search` | capability | `read` | 搜索标题和正文，默认返回 20 条命中，硬上限 50 条 |
| `apple-notes.notes.read` | capability | `read` | 按 id 或精确标题读取一条笔记，返回 `text` 和原始 `html` |
| `apple-notes.notes.create` | capability | `write` | 创建一条新笔记；默认挂起待批，已有合格常驻授权可复用 |
| `apple-notes.skill.how-to-use` | skill | — | 使用指引 |

搜索先返回摘要，包括 id、标题、文件夹、修改日期和短摘录，绝不返回全文。找到需要的笔记后，把命中的 `id` 传给 `notes.read`，再取出实际内容。

写入只限于创建新笔记，这个限制由代码本身保证。整个 source 都没有 `update`、`delete`、`move` 或 `rename` 条目，provider seam 没有这类方法，bridge 也没有这类 handler。已有笔记无法通过 Plexus 修改或删除。

连接时勾选的三项 `read` 会获得常驻授权，调用直接通过授权检查。`apple-notes.notes.create` 仍需要 `write` 授权，默认逐次审批，请求会挂起等待所有者批准。所有者可以在连接时为特定 agent 的这项 capability 显式启用常驻授权，也可以之后直接授予，或在批准写入请求时给出真实的信任窗口。已有符合条件且仍有效的常驻授权，就可以复用，不必再次批准。

访问真实数据，需要 macOS 上的 Notes 应用，以及一次性的 TCC 授权，位置在“系统设置 ▸ 隐私与安全性 ▸ 自动化”。provider 通过 `osascript`／JXA 驱动应用。封闭模式使用 `PLEXUS_FAKE_APPLE=1`，由假 provider 提供确定性的内存夹具；`create` 会改动内存存储。

---

## Apple Mail：严格只读 {#apple-mail——严格只读}

Apple Mail 可以列出账户和邮箱、查看未读数，再搜索和读取邮件。它同样是编译进网关的第一方 source，启动时自动注册，不需要手动添加。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-mail.mailboxes.list` | capability | `read` | 列出账户、各邮箱及未读数 |
| `apple-mail.messages.search` | capability | `read` | 在单个邮箱内搜索，默认返回 20 条命中，硬上限 50 条 |
| `apple-mail.message.read` | capability | `read` | 按 id 读取一封邮件的纯文本，正文上限 20,000 字符 |
| `apple-mail.how-to-use` | skill | — | 使用指引 |

这里的只读也由代码本身保证。每项 capability 都需要 `read` 授权，provider seam 没有起草、发送、移动或删除方法。起草和发送 capability 在这个 source 中根本不存在，并非只是调用时被拒绝。

搜索一次只查一个邮箱，默认是 `INBOX`，即统一收件箱。可以按发件人或主题中的子串过滤，也可以按收件日期范围过滤，两类条件可以组合使用。结果按最新在前排列，带约 200 字符的摘录和 `truncated` 标志。邮箱里的邮件较多时，优先用日期范围或发件人缩小搜索范围；找到邮件后，再按 id 读取正文。

访问真实数据，需要 macOS 上的 Mail 应用，以及一次性的 TCC 授权，位置在“系统设置 ▸ 隐私与安全性 ▸ 自动化”。封闭模式同样使用 `PLEXUS_FAKE_APPLE=1`，由假 provider 提供确定性的内存夹具。

---

## Apple Contacts：只读 {#apple-contacts——只读}

Apple Contacts 可以搜索联系人，再按 id 读取完整名片。它是编译进网关的第一方 source，启动时自动注册。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-contacts.contacts.search` | capability | `read` | 按姓名、邮箱或电话子串搜索，默认返回 20 条命中，硬上限 50 条 |
| `apple-contacts.contacts.read` | capability | `read` | 按联系人 id 读取完整名片 |
| `apple-contacts.how-to-use` | skill | — | 使用指引 |

只读由代码本身保证：provider seam 没有 `create`、`update` 或 `delete` 方法，整个 source 中不存在任何写入 capability。

搜索匹配姓名、邮箱地址或电话号码中的子串，不区分大小写。电话匹配按数字比较，查询中至少要有 3 位数字，才会匹配电话号码。找到联系人后，用 `contacts.read` 读取完整名片，得到姓名、组织、生日，以及带标签的邮箱、电话和邮政地址。

访问真实数据，需要 macOS 上的 Contacts 应用，以及一次性的 TCC 授权，位置在“系统设置 ▸ 隐私与安全性 ▸ 自动化”。封闭模式使用 `PLEXUS_FAKE_APPLE=1`，由假 provider 提供确定性的内存夹具。

---

## Apple Photos：`read` 授权，导出限于指定目录 {#apple-photos——read-姿态、牢笼化导出}

Apple Photos 可以列出相册和文件夹、搜索媒体条目，也可以导出一个条目。它同样是编译进网关的第一方 source，启动时自动注册。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `apple-photos.albums.list` | capability | `read` | 列出相册、文件夹及条目数，每层最多 200 项 |
| `apple-photos.search` | capability | `read` | 仅搜索媒体元数据，默认返回 20 条命中，最多 100 条 |
| `apple-photos.export` | capability | `read` | 将一个条目导出到受限目录 `~/.plexus/exports/photos/` |
| `apple-photos.how-to-use` | skill | — | 使用指引 |

`apple-photos.search` 只搜元数据：可以限定相册、拍摄日期范围，或按文件名、关键词中的子串搜索。它没有图像内容搜索或 ML 搜索，不能靠识别画面找出“狗的照片”。不限定范围且涉及超过 5000 个条目的搜索会被拒绝，需要用 `album` 限定相册。

三项 capability 都使用 `read` 授权，provider seam 没有任何修改照片库的方法。不过，导出确实会写磁盘。

`apple-photos.export` 每次恰好写出一个文件，只能写进网关所有的受限目录 `~/.plexus/exports/photos/`。目录不存在时会创建，每次导出都会使用一个全新的子目录。它无法写入磁盘上的其他位置，也绝不改动照片库本身，因此仍保持 `read` 授权。这项磁盘副作用在它的 `describe` 文本里明确写明。

访问真实数据，需要 macOS 上的 Photos 应用，以及一次性的 TCC 授权，位置在“系统设置 ▸ 隐私与安全性 ▸ 自动化 ▸ 照片”。封闭模式使用 `PLEXUS_FAKE_APPLE=1`，由假 provider 提供确定性的内存夹具。

::: tip 所有 Apple source 的 provider 选择与 TCC
每个 source 都通过一次环境变量检查选择 provider。只有 `process.env.PLEXUS_FAKE_APPLE === "1"` 成立时，才使用带夹具的假 provider；否则使用真实 macOS provider，通过 `osascript`／JXA 驱动应用，首次使用受 macOS TCC 管控。单元测试也可以注入这个选择。

因此，`PLEXUS_FAKE_APPLE=1` 是启用封闭、免 TCC 运行的单一开关。`bash run-tests.sh`、[`tests/harnesses/acceptance-apple`](https://github.com/nemori-ai/plexus/blob/main/tests/harnesses/acceptance-apple/README.md) 验收剧本和 CI 都使用它。

Shortcuts 和 Browser 也采用同样的方式，但各有自己的开关，分别是 `PLEXUS_FAKE_SHORTCUTS=1` 和 `PLEXUS_FAKE_BROWSER=1`。
:::

::: tip `osascript` 的性能限制
Apple provider 通过 `osascript` 驱动各自的应用。数据量很大时，这种方式会很慢：列出或搜索成百上千个条目，可能要花好几秒。查询时限定时间窗口，指定某个列表、邮箱或相册，别一次索要全部。
:::

---

## Shortcuts：读取与执行，默认记录模式 {#shortcuts——read-execute-默认记录模式}

shortcut 是用户自定义的自动化。拥有者把它做成什么样，它就能做什么，包括发消息、移动文件、控制应用。因此，允许 agent 运行一个 shortcut，需要由拥有者分别决定两件事：是否授予 `execute` 授权，以及是否启用真实启动。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `shortcuts.list` | capability | `read` | 列出 shortcut 名称和文件夹名 |
| `shortcuts.run` | capability | `execute` | 按名称运行一个 shortcut；默认挂起待批，默认记录模式 |
| `shortcuts.how-to-use` | skill | — | 使用指引 |

运行前，先用 `shortcuts.list` 查到名称，再把名称原文传给 `shortcuts.run`，不要改写。`shortcuts.list` 只负责发现，绝不会运行任何东西；连接时勾选它，就会获得常驻 `read` 授权，后续调用直接通过授权检查。

`shortcuts.run` 默认逐次审批，授权请求会挂起，等待拥有者批准。只有拥有者能为特定 agent 的这项 capability 显式启用常驻 `execute` 授权；已有符合条件且仍有效的常驻授权，就不必重复审批。agent 自己请求更长的信任窗口，不能获得常驻执行权限。

获准调用后，还有真实启动这一关。默认处于记录模式，结果返回 `launched: false`，并附上本来会执行的那条 `shortcuts run` 命令原文。这次调用已经记录，也经过审计，但 shortcut 没有执行。

拥有者需要在 Plexus 控制台的 What I expose ▸ Shortcuts ▸ Real launch 为这个 source 启用真实启动。逐次批准和常驻授权都不会自动打开这个开关；打开开关也不能代替 `execute` 授权。

在真实 macOS 上使用，需要 `shortcuts` CLI，现代 macOS 已自带。这个第一方 source 编译进网关，启动时自动注册；CLI 是否存在由 `health` 如实报告，不会因为缺少 CLI 就隐藏条目。封闭模式使用 `PLEXUS_FAKE_SHORTCUTS=1`。

---

## Browser：只读访问 Safari 和 Chrome {#browser——只读-safari-chrome}

Browser 可以查看 Safari 和 Chrome 当前打开的标签页，搜索书签和历史记录。它是编译进网关的第一方 source，启动时自动注册。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `browser.tabs.list` | capability | `read` | 列出 Safari 和 Chrome 当前打开的标签页 |
| `browser.bookmarks.search` | capability | `read` | 按标题或 URL 子串搜索书签，默认返回 20 条，硬上限 200 条 |
| `browser.history.search` | capability | `read` | 按子串搜索历史，可选日期范围，最新在前，返回数量有界 |
| `browser.how-to-use` | skill | — | 使用指引 |

只读由代码本身保证。provider seam 中没有导航、打开、关闭、写入或删除方法。书签和历史的 sqlite 文件只会先拷贝到临时路径，再从副本读取，因此 Chrome 正在运行也不会挡住读取。

结果合并两个浏览器的数据，但各自报告状态。每个结果都带有 `browsers.safari` 和 `browsers.chrome` 状态段；某个浏览器未安装、未运行或不可读时，只返回它的空列表和一条说明，另一个浏览器的数据行照常返回。

在真实 macOS 上列出标签页，需要分别为每个浏览器授予一次自动化 TCC 权限。读取 Safari 历史和书签还需要完全磁盘访问权限；缺少它时，Safari 这一部分降级为 `unavailable`，Chrome 的结果仍照常返回。

封闭模式使用 `PLEXUS_FAKE_BROWSER=1`，数据来自确定性的内存夹具。

---

## Browser control：驱动真实的 Chrome（读 + execute） {#browser-control}

Browser control 可以读取页面，也可以驱动真实的 Chrome 执行操作。它的 source 是 `browser-control`，与上面只读的 `browser` 刻意分开。`browser` 的只读由代码结构保证：provider seam 里根本没有变更方法。如果把页面控制也放进去，这个 source 表面上仍称只读，实际却有了修改页面的入口，原来的保证就悄悄变成了假话。

`browser-control` 直接使用 Chrome DevTools Protocol。不需要 Puppeteer，不需要 Playwright，也不下载浏览器。CDP 传递的就是 WebSocket 上的 JSON，运行时已经具备这两项支持。

### 先决定把哪个浏览器交给 agent {#真正定分量的那个决定-给哪个浏览器}

三种模式暴露的 capability 完全一样。区别只在调试端点从哪里来，而端点连接的是哪个浏览器，决定了操作可能影响多大范围。同一组能力，接到一个干净的浏览器，和接到你平时使用、已经登录了账户的浏览器，分量很不一样。

下表列的是连接本身可能触达的范围。agent 通过 Plexus 实际能访问哪些站点，还要受 Plexus 的站点边界约束；连接到已登录的浏览器，并不等于获准访问其中所有站点。

| 模式 | agent 拿到的浏览器 | 底层连接可能触达什么 |
| --- | --- | --- |
| `launch`（默认） | Plexus 自己启动的 Chrome，使用独立的专用 profile | 一个干净的浏览器，没有 cookie，也没有已登录会话 |
| `attach`（所有者主动选择） | 所有者正在使用的 Chrome，经 `chrome://inspect/#remote-debugging` 连接 | 该浏览器中的每一个已登录会话 |
| `extension`（所有者主动选择） | 同样是所有者正在使用的 Chrome，经 Plexus 扩展连接 | 同样可能触达该浏览器中的每一个已登录会话；同意只在安装时授予一次 |

日常“去把这页读了”的工作，用 `launch` 就能覆盖，因此它是安全的默认选择。另两种模式连接的是你已登录账户的浏览器，需要所有者明确决定是否开放。这和 exec source 上的 `Real launch` 一样，都需要所有者主动选择；这里选择的是浏览器连接模式。

Chrome 自己的同意是全有或全无的：权限对话框授权的是那个浏览器，并不让你从中选出一组站点。如果你想限定“这个 agent 可以访问 GitHub，其他站点不行”，Chrome 的同意无法提供这条边界。按站点限制访问的边界由 Plexus 提供。

### 可用能力 {#capability}

下面列出各项操作及其所需授权。能发现一个条目，或它已在 agent 的授权子集中，都不等于已经获准调用；调用还需要相应范围的授权。`execute` 默认逐次审批，请求挂起等待所有者批准。只有所有者能为特定 agent 的某项 capability 显式启用常驻 `execute` 授权，agent 自己请求更长的信任窗口不能获得它。已有符合条件且仍有效的常驻授权，就可以复用，不必再次提示批准。表中的“默认挂起待批”都包含这个例外。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `browser-control.tabs.list` | capability | `read` | 列出可以驱动的标签页，只列已授权域名下的标签页 |
| `browser-control.page.read` | capability | `read` | 读取页面标题、url 和渲染后的文本 |
| `browser-control.page.elements` | capability | `read` | 列出可交互元素及可用的选择器；密码框只报告长度 |
| `browser-control.page.screenshot` | capability | `read` | 截取视口，或用 `fullPage` 截取整页 |
| `browser-control.page.scroll` | capability | `read` | 移动视口，返回 `atBottom` |
| `browser-control.page.wait` | capability | `read` | 等待某个选择器、一段字符串出现，或等待加载结束 |
| `browser-control.frames.list` | capability | `read` | 列出内嵌 frame，按 frame 自己的域名判定能否访问 |
| `browser-control.page.navigate` | capability | `execute` | 跳转到指定 URL，这是 allowlist 首要约束的操作；默认挂起待批 |
| `browser-control.page.click` | capability | `execute` | 对选择器指向的元素执行一整套真实指针事件；默认挂起待批 |
| `browser-control.page.type` | capability | `execute` | 填写一个字段或编辑器；默认挂起待批 |
| `browser-control.page.press` | capability | `execute` | 触发一个真实按键事件，Enter 可以提交；默认挂起待批 |
| `browser-control.page.upload` | capability | `execute` | 附加一个文件，只能来自你指定的上传目录；默认挂起待批 |
| `browser-control.page.evaluate` | capability | `execute` | 以该页面的身份执行 JavaScript；默认挂起待批 |
| `browser-control.page.cdp` | capability | `execute` | 原样透传任意页面级 CDP 命令；默认挂起待批 |
| `browser-control.how-to-use` | skill | — | 使用指引 |

`scroll` 和 `wait` 归为 `read`，因为它们都不代表站点做事。前者改变可见范围，后者改变我们等待多久；两者都不能提交、跟随链接，也不能激活任何东西。滚动虽然移动了视口，等待虽然让调用停留一段时间，却没有因此获得点击或按键的执行权限。

页面内的操作面则是刻意开放的。在 agent 已获准操作的页面里，`click` 加上 `type`，已经足以让它像用户一样做事：下单、发送、删除、改设置，都能通过点击和输入完成。这些能力的分量不能只看名字。填入内容以后，点击按钮可以发送；一个真实的 Enter 按键也可能完成提交。

既然这些事情已经能通过点击和输入做到，再单独扣住 `evaluate`，也挡不住由这些操作造成的实际伤害，只会让这项能力比所有者转而会用的替代品更不好用。因此，这里允许以页面身份执行 JavaScript，也允许原样透传页面级 CDP 命令。这项取舍针对的是 agent 已被允许触碰的页面。

没有开放的是 CDP 中属于浏览器全局的那部分，也就是不属于任何页面的命令。扣住这部分，域名 allowlist 才能成为实际边界。接下来要看的是，这条边界怎样约束每一次操作。

### 域名 allowlist 怎样限制访问 {#边界——域名-allowlist}

每次调用，source 都会在服务端从实际目标解析出目标 URL，再用你设定的 allowlist 校验它的 origin。检查的是这次调用实际要访问哪里，agent 自报的字段不能作为依据。具体有三条规则：

1. 空名单的含义，要看连接的是哪个浏览器。对于你自己的浏览器，也就是 `attach` 和 `extension` 模式，没设名单就拒绝访问，不会默认开放控制。这里有你的已登录会话，需要先划定范围。

   对于 `launch` 模式，Plexus 用空 profile 启动浏览器，没有已登录会话需要隔离，因此没设名单时允许访问开放 web。给一个没有身份的浏览器划出这样的隔离范围，并不能保护任何已有会话。

   不过，两种情况都只允许 `http`／`https`，所谓“整个 web”始终不包括本地磁盘和 Chrome 自己的设置页。

2. 一条条目授权的是那个域名，包括它的子域。`deepseek.com` 可以覆盖 `www.deepseek.com`。匹配时，source 检查解析出的 host，并按点边界判断：`deepseek.com.evil.com` 和 `evildeepseek.com` 都不在范围内，不能因为字符串里带着获准域名就通过。IP 条目必须精确匹配；scheme 也必须相同，授权一个站点的 HTTPS 访问，不会顺带授权它的 HTTP 明文形式。

3. 每次动作之前，都要重新检查标签页当前的 origin。只授权了 `github.com` 时，一个在 `github.com` 上获准访问的标签页，导航到 `mail.google.com` 后就会被拒绝。即使调用复用了已经持有的调试 socket，也必须重新校验。socket 可以继续用，上一次的放行结果不能跟着继续用；复用只省去了传输层重新建立连接的工作。

跨站 `<iframe>` 在自己的渲染进程里运行，检查方式和标签页一样，按它自己的域名判断。外层页面获准访问，不会让它内嵌的内容也自动获准。因此，即便你放行的页面嵌入了一个已登录的 `accounts.google.com` frame，agent 也不能借外层页面的许可访问这个 frame。

域名检查还要与每个 agent 的 scope 一起生效。source 级 allowlist 是共同的底线，针对 agent 的授权约束只能在这个范围内继续收窄。两者叠加，agent 的 scope 不能扩大 source 在当前模式下允许访问的范围。

### 上传是一条外泄通道 {#上传是一条外泄通道}

`page.upload` 会把你机器上的一个文件交给网站，因此上传还需要单独限制文件来源。你指定一个目录，上传路径只能相对于这个目录填写。这个目录边界不是给上传功能附加的便利设施，它就是这项功能本身：交给网站的，只能是你指定目录里的文件。

这里使用与文件类 source 相同的“词法 + realpath”双重校验：既检查路径本身是否越界，也检查解析后的真实路径是否仍在指定目录内。路径写在目录下面，并不足以通过检查；如果它借符号链接指向外面，同样会被拒绝。

没有设置上传目录，就拒绝一切上传。三种模式都如此，`launch` 也没有例外。它在空 allowlist 下可以访问开放 web，并不意味着可以从本机任意取文件上传。这里的默认拒绝，与 `attach`／`extension` 的空名单规则一致，不能把 `launch` 的开放 web 例外一并套到上传上。

审计记录完整路径与大小；线上只给文件名。

### 怎么配 {#怎么配}

打开控制台的 What I expose → Browser control，在这里设置连接模式、已授权域名和上传目录：

- 模式：选择 `launch`、`attach` 或 `extension`。
- 已授权域名：一行一个。使用 `attach` 或 `extension` 连接你已登录的浏览器时，空名单会拒绝一切访问。
- 上传目录：指定允许上传的文件所在目录。没有设置，就拒绝一切上传。

改动即时生效，不必重启。

启动时，三项设置分别以 `PLEXUS_BROWSER_CONTROL_MODE`、`PLEXUS_BROWSER_CONTROL_ORIGINS` 和 `PLEXUS_BROWSER_CONTROL_UPLOAD_DIR` 作为兜底。其中，环境变量 `PLEXUS_BROWSER_CONTROL_ORIGINS` 用逗号分隔域名，控制台里则是一行一个。控制台中保存过的设置优先于环境变量；已经保存的值，不会被启动环境里的值覆盖。

使用 `attach`，需要 Chrome 144+。先在 Chrome 打开 `chrome://inspect/#remote-debugging`，启用远程调试。这个开关只需打开一次，之后每次建立连接，Chrome 都会单独询问你是否允许，并显示“正受自动化测试软件控制”的横幅。

之所以要从这里启用，是因为自 Chrome 136 起，Chrome 二进制程序拒绝在默认 profile 上使用 `--remote-debugging-port`。要接入你真正登录着的那个浏览器，这个开关是唯一入口，不能用命令行参数代替。

使用 `extension`，先注册一次本地消息宿主，再加载扩展。注册命令是：

```sh
bun run packages/runtime/src/sources/browser-control/install-native-host.ts
```

命令完成后，打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”，选择 `extension/plexus-browser` 目录。有网关连上时，扩展徽标会变成绿色。这个颜色表示连接已经建立，访问哪些域名、调用是否获准，仍由 Plexus 判断。

扩展只负责传输请求。它不保存 allowlist，也不处理批准；域名策略和批准逻辑都留在 Plexus。

本地消息宿主由 Chrome 自己启动。宿主清单必须写明这个扩展的 id，Chrome 才会为它启动对应宿主，因此两者的绑定由 Chrome 强制检查，不需要你在两个窗口之间复制配对 token。

与 `attach` 每次连接都询问相比，扩展这条路径只在安装时征求一次同意。这里说的是 Chrome 对扩展连接的同意，Plexus 对具体操作的授权和批准仍按原有规则执行。

这个 source 的前置条件是 Google Chrome。它作为第一方 source 编译进网关，启动时自动注册，不需要手动添加。Chrome 是否存在，由 `health` 如实报告；缺少 Chrome 时，条目也不会被藏起来。

自动注册后，`attach` 和 `extension` 在没有任何已授权域名时仍拒绝访问。`launch` 保留干净 profile 的例外：空名单允许访问 `http`／`https` 页面。

Plexus 关停时，会关闭自己持有的调试 socket，以及自己打开的标签页。agent 这次浏览留下的这些资源会一起清理，不会随着一次次使用，在你的 Chrome 里越积越多窗口。

---

## Workspace：受限工作目录，支持读写 {#workspace——沙箱化工作目录-读-写}

`workspace` 把磁盘上一个由拥有者授权的工作目录暴露为路径受限的文件系统，作为演示流程里 agent 存放草稿和产物的文件夹。它也是下面两个沙箱化 runner 的配套读写入口：agent 先在这里列出、读取文件，再让 Claude Code 或 Codex 在同一目录边界内构建，最后把产物读回来。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `workspace.list` | capability | `read` | 列出目录，只读 |
| `workspace.read` | capability | `read` | 读取文件，只读 |
| `workspace.write` | capability | `write` | 创建或覆盖文件；默认挂起待批，已有合格常驻授权可复用 |
| `workspace.how-to-use` | skill | — | 使用指引 |

路径限制与 Obsidian 的 vault 读取器相同。所有路径都在 workspace 根目录下解析；通过 `..` 向外逃逸、传入绝对路径，或借符号链接指向目录外部，一律拒绝。

连接时勾选的 `workspace.list` 和 `workspace.read` 会获得常驻授权，后续调用直接通过授权检查。`workspace.write` 默认逐次审批，没有可复用的合格常驻授权时，请求会挂起等待拥有者批准。拥有者可以为特定 agent 的这项 capability 显式启用常驻授权，或之后直接授予；符合条件的写入请求，也可以在批准时通过真实的信任窗口获得常驻授权。

这个第一方 source 已编译进网关，启动时自动注册，无需添加。已授权目录是否存在，由 `health` 如实报告，不会因为目录不存在就隐藏条目。

---

## Claude Code：无头运行，受沙箱约束 {#claude-code——无头、受沙箱约束-execute}

`claudecode` 启动本地 Claude Code CLI，以无头方式完成真实编码工作，并由 macOS `sandbox-exec` 把它限制在已授权目录内。它作为一项敏感 capability 开放。agent 看不到 shell，也看不到启动命令，能传入的只有 `{ prompt }`。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `claudecode.run` | capability | `execute` | 在授权目录内启动无头 Claude Code；默认挂起待批，已有合格常驻授权可复用 |
| `claudecode.how-to-use` | skill | — | 使用指引 |

`claudecode.run` 需要 `execute` 授权，默认逐次审批；没有可复用的合格常驻授权时，发出授权请求后要等待拥有者批准。常驻执行必须由拥有者为特定 agent 的这项 capability 显式启用，agent 自己请求更长的信任窗口不能获得它。

授权决定这次操作能否运行，沙箱限制运行后能读写哪里。即使调用已经获准，授权目录外的读写仍会在内核处失败。两次调用之间，用 `workspace.read` 读取并核对产物，再继续编码。

本机需要 PATH 上的 `claude`，以及 macOS `sandbox-exec`。这个第一方 source 已编译进网关，自动注册；两项工具是否存在由 `health` 报告，缺少工具也不会隐藏条目。

---

## Codex：无头运行，受沙箱约束 {#codex——无头、受沙箱约束-execute}

`codex` 提供与 `claudecode` 对应的编码入口，通过 `codex exec` 无头运行本地 Codex CLI。它同样由 macOS `sandbox-exec` 限制在已授权目录内，目录外的读写会在内核处失败。

agent 的输入仍以 `{ prompt }` 为限，另可指定一个 `cwd`，但这个工作目录也必须位于已授权目录内；接口不向 agent 暴露 shell 或启动命令。

| Capability id | 类别 | 授权 | 提供什么 |
| --- | --- | --- | --- |
| `codex.run` | capability | `execute` | 在授权目录内启动无头 `codex exec`；默认挂起待批，已有合格常驻授权可复用 |
| `codex.how-to-use` | skill | — | 使用指引 |

`codex.run` 需要 `execute` 授权，默认逐次审批。没有可复用的合格常驻授权时，请求挂起等待拥有者批准；常驻执行同样要求拥有者为特定 agent 的这项 capability 显式启用，agent 不能自行提升权限。获得授权不会放宽沙箱的目录边界。两次调用之间，仍通过 `workspace.read` 检查产物。

本机需要 PATH 上的 `codex` CLI，以及 macOS `sandbox-exec`。本地 `codex` CLI 缺席时，调用返回 `source_unavailable`，不会让会话失败。这个第一方 source 已编译进网关，自动注册；`codex` 和 `sandbox-exec` 是否存在，由 `health` 如实报告。

---

## 接下来去哪 {#接下来去哪}

- [连接一个 agent](/zh/guide/connect-an-agent)：用原始 HTTP 和一个真实的 Codex agent，跑通这些 capability 的端到端调用，包括从等待批准到获准的 pending → approve 流程。

- [编写扩展](/zh/guide/create-an-extension)：需要网关没有随附的 capability，可以通过扩展添加。

- [管理受管 source](https://github.com/nemori-ai/plexus/blob/main/docs/sources/MANAGING-SOURCES.md)：查阅完整的生命周期操作，包括添加、启用、禁用、重新配置和移除。
