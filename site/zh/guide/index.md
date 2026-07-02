---
title: 快速上手
description: 安装 Plexus、启动网关、暴露一个 source、连接你的第一个 agent——在 macOS 上端到端跑通。
---

# 快速上手（macOS）

真实的端到端路径：安装 Plexus、启动网关、暴露一个 source、连接你的**第一个 agent**——让它能发现一项
capability、拿到授权、并 invoke 它。

Plexus 是一个**本地能力网关**。默认它只绑定到 `127.0.0.1`（把它开放到局域网是可选项，且受
connection-key 管控——请先阅读[安全模型](/zh/architecture/security-model)）。所有状态都存放在 `~/.plexus/`
之下。对这套模型（Connector → Source → Capability、来源、授权）还不熟？浏览一下[核心概念](/zh/concepts/)——
或者干脆跟着往下走，自然就懂了。

自始至终请把两个角色分清楚：

- **你是管理员。** 你持有 **connection-key**——管理凭据。它用于对 `/admin` 控制台做认证。**你永远不会把它交给
  agent。**
- **agent 拿到的是它自己的凭据。** 当你连接一个 agent 时，它会 enroll 换取一份持久的**专属 PAT**；agent 用来
  调用的正是这个——而不是 connection-key。

::: tip 平台
macOS（Apple Silicon 或 Intel）。Apple Calendar / Reminders 这两个 source 仅限 macOS。
:::

---

## 1. 前置条件

**[Bun](https://bun.sh) ≥ 1.3.0：**

```sh
curl -fsSL https://bun.sh/install | bash
bun --version          # → 1.3.x
```

## 2. 安装

```sh
git clone <your-plexus-remote> plexus    # or cd into your existing checkout
cd plexus
bun install
```

`/admin` 控制台是位于 `packages/web-admin` 的一个 Vite SPA。如果它的 `dist/` 缺失，先构建一次：

```sh
cd packages/web-admin && bun install && bun run build && cd ../..
```

## 3. 运行网关

```sh
bun run start --vault ~/Documents/MyVault     # --vault is optional; see step 5
```

它会持续运行（Ctrl-C 停止），并打印出管理 URL、你的 connection-key（以及说明它是**管理员**凭据）、还有状态
目录。首次运行会自动创建 `~/.plexus/`——无需任何配置。如果 `7077` 被占用，用 `PLEXUS_PORT=7099 bun run start`
更换端口；始终按它打印出的那个确切的 `127.0.0.1:<port>` 去访问网关。

::: tip 更喜欢 GUI？
`cd packages/desktop && bun run start` 会在一个 Electron 应用里启动同一个网关，并替你把 connection-key 注入
到控制台。下文的每一个概念都完全一致。
:::

## 4. 打开控制台

打开 `http://127.0.0.1:7077/admin`。这个控制台是你的"我信任谁 / 我暴露什么"驾驶舱：概览、**我暴露了什么**
（每一项 capability 连同它的来源 + 敏感度）、**Agents**、**Approvals**、**Grants**、**Activity**。

控制台以同源方式提供，因此它的静态资源无需密钥即可加载，但每一次 `/admin/api/*` 调用都需要 connection-key。
在桌面应用里它被自动注入；在普通浏览器里则在一次性粘贴之后被缓存。你，在本地访问 `/admin` 的这个人，**就是**
那个人类批准者。

connection-key 只是你的**管理员**凭据。查看它：`bun run start --print-key`（或 `cat ~/.plexus/connection-key`）。
它绝不会通过任何 agent 可达的路由被提供，你也绝不会把它粘贴进某个 agent——连接一个 agent（第 6 步）会给它它
自己的凭据。

## 5. （macOS）授予底层应用权限——TCC

第一方 Apple source（`apple-calendar`、`apple-reminders`）是通过 macOS 来读取的，因此**第一次调用**会触发
Apple 的 TCC 授权。若尚未授予，Plexus 会返回一条清晰、可恢复的消息，而不是崩溃。到 **系统设置 ▸ 隐私与安全性**
里授予它：**自动化**（允许 Plexus 控制"日历"）+ **日历**，以及**提醒事项**。这些是一次性的操作系统授权，与
Plexus 自己的授权是两回事。

## 6. 连接你的第一个 agent

这就是整个接入过程——不用粘贴密钥，也不用手写配置。

![agent 如何连接 — admin 铸码并授权；agent 登记并调用；敏感调用挂起待批准](/diagrams/connect-flow.png)

**a. 在控制台里配置它。** 打开 **Agents ▸ Connect an agent**：

1. **Identify（标识）**——给它一个 id（例如 `my-claude-runner`）并选择它的类型（Claude Code 会得到一个编译好的
   plugin）。
2. **Capabilities（能力）**——勾选一个初始集合，作为**常驻**授予（连接的那一刻即可用）。read cap 可以常驻；
   **execute / 高敏感度 cap 不能**——它们每次使用都要单独批准，会显示在 *skipped* 之下。选一个信任窗口（默认
   7 天）。
3. **Install（安装）**——复制它给出的那**一条命令**。

在底层，这会签发一个**一次性 enroll 码**并授予你选中的 cap 集合；如果你更愿意用脚本来做，对应的端点是
`GET /integration/:agentId`（由一个公开的 `install.sh` 支撑）。

**b. 运行这一条命令**（在 agent 所在的环境里）。它会安装一个专属的 Claude Code plugin，用该码换取一份持久的
**专属 PAT**（以 `0600` 存储），然后删除该码。别的什么都不用接。

**c. agent 通过它自己捆绑的 launcher，即 `plexus-<agentId>`，来调用 capability：**

```sh
plexus-my-claude-runner list                      # discover: what's callable now + what needs approval
plexus-my-claude-runner obsidian.vault.read Welcome.md
```

`list` 是 agent 看清自己能做什么（包括新近暴露出来的 capability）的方式——它永远不需要去猜。这个 launcher 是
版本隔离的（它运行自己捆绑的引擎，绝不用全局的 `plexus`），并且悄无声息地处理凭据。**launcher 是 agent 完整
且唯一的接口**——它从不自己拼 HTTP，也从不碰认证。如果某件事无法通过它完成，那就说明 agent 没有那样做的授权；
它会来问你，或请求一次授权。

**d. 审批流程——pending → approve。** 对第一方 source 的一次 **read** 会自动放行（你已预先授予）。而一次
**write**、或**任何 execute capability**，都是默认拒绝的：agent 的调用会以 *pending* 返回，请求会出现在控制台
的 **Approvals** 标签页里，配一张大白话的卡片（谁、做什么、多久），只有**在你批准之后**这次调用才会通过。
execute capability 是**每次使用都单独批准，每次都是**——它们永远不能变成常驻，连你也不行。

::: tip 没有真实 agent 也能观察这个循环
参见 [`examples/`](https://github.com/nemori-ai/plexus/tree/main/examples) 下的参考客户端。想弄懂 launcher
底下那层原始的 wire 协议，请读[协议](/zh/protocol/)——但 agent 永远不会亲手去说它；launcher 才会。
:::

## 7. 暴露你自己的 source（可选）

Apple source 开箱即用。要暴露你的笔记，加一个 Obsidian vault——从控制台的 **Sources** 面板、`plexus source`
管理 CLI、或 launcher 参数：

```sh
bun run start --vault ~/Documents/MyVault               # read-only ⇒ obsidian.vault.read
bun run start --obsidian-rest --rest-url https://127.0.0.1:27124   # read-write ⇒ obsidian-rest.vault.{list,read,write}
```

这些参数会**持久化**到 `~/.plexus/sources.json`，并在下次启动时自动加载（加 `--ephemeral` 则仅本次运行有效）。
受管 source 会立刻在 `.well-known` 和每个 agent 的 `list` 中热出现——无需重启。（你安装的自定义**扩展**同样会
持久化——它们借助 `~/.plexus/extensions.json` 熬过网关重启。）

---

## 命令参考（管理员）

| 命令 | 作用 |
| --- | --- |
| `bun run start` | 在 `127.0.0.1:7077` 上启动网关；保持运行。 |
| `bun run start --vault <path>` | 同时把一个 Obsidian vault 作为只读 source 暴露（持久化）。 |
| `bun run start --obsidian-rest` | 同时暴露一个可读写的 Obsidian REST source（持久化）。 |
| `bun run start --ephemeral` | 配合某个 source 参数：仅本次运行注册。 |
| `bun run start --print-key` | 打印（管理员）connection-key 后退出。 |
| `PLEXUS_PORT=N bun run start` | 使用端口 `N` 代替 `7077`。 |
| `bash run-tests.sh` | 权威关卡：`bunx tsc --noEmit` + `bun test`。 |

所有状态都存放在 `~/.plexus/` 之下。要重置：停止网关并删除该目录——下次启动会重新生成一份全新的 connection-key
+ 签名密钥。

---

## 后续步骤

- **[核心概念](/zh/concepts/)**——心智模型（来源、两个时钟、自描述的 Floor + 编译投影）。
- **[连接一个 agent](/zh/guide/connect-an-agent)**——一个真实的编码 agent，端到端。
- **[安全模型](/zh/architecture/security-model)**——权威的信任与认证模型（connection-key 对比专属 PAT、
  execute 永不常驻规则）。
