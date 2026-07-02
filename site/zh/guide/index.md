---
title: 快速上手
description: 安装 Plexus、启动网关、暴露一个 source、连接你的第一个 agent——在 macOS 上端到端跑通。
---

# 快速上手（macOS）

真实的端到端路径：安装 Plexus、启动网关、暴露一个 source、连接你的**第一个 agent**——让它发现
capability、拿到授权、完成 invoke。

Plexus 是**本地能力网关**，默认只绑定 `127.0.0.1`（开放到局域网是可选项，且受 connection-key
管控——请先读[安全模型](/zh/architecture/security-model)）。所有状态都存放在 `~/.plexus/` 下。
对这套模型（Connector → Source → Capability、来源、授权）还不熟？可以先浏览[核心概念](/zh/concepts/)，
也可以直接跟着往下走，自然就懂了。

自始至终，请分清两个角色：

- **你是管理员。** 你持有 **connection-key**，即管理凭据，用来认证 `/admin` 控制台。**你永远不会把它交给
  agent。**
- **agent 有自己的凭据。** 连接 agent 时，它会 enroll 换取一份持久的**专属 PAT**；agent 调用时用的是这份
  PAT，而不是 connection-key。

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

`/admin` 控制台是 `packages/web-admin` 下的一个 Vite SPA。如果它的 `dist/` 缺失，先构建一次：

```sh
cd packages/web-admin && bun install && bun run build && cd ../..
```

## 3. 运行网关

```sh
bun run start --vault ~/Documents/MyVault     # --vault is optional; see step 5
```

网关会持续运行（Ctrl-C 停止），启动时打印管理 URL、你的 connection-key（并注明这是**管理员**凭据）和状态
目录。首次运行会自动创建 `~/.plexus/`，无需任何配置。如果 `7077` 被占用，用 `PLEXUS_PORT=7099 bun run start`
换端口；访问网关时，以它打印出的那个 `127.0.0.1:<port>` 为准。

::: tip 更喜欢 GUI？
`cd packages/desktop && bun run start` 会在 Electron 应用里启动同一个网关，并替你把 connection-key 注入
控制台。下文所有概念完全一致。
:::

## 4. 打开控制台

打开 `http://127.0.0.1:7077/admin`。控制台是你的"我信任谁 / 我暴露什么"驾驶舱：概览、**我暴露了什么**
（每项 capability 连同来源 + 敏感度）、**Agents**、**Approvals**、**Grants**、**Activity**。

控制台以同源方式提供，静态资源无需密钥即可加载，但每次 `/admin/api/*` 调用都要带 connection-key。
桌面应用会自动注入；普通浏览器里粘贴一次后缓存。在本地打开 `/admin` 的你，**就是**那个人类批准者。

connection-key 只是你的**管理员**凭据。查看它：`bun run start --print-key`（或 `cat ~/.plexus/connection-key`）。
它不会出现在任何 agent 可达的路由上，你也永远不会把它粘贴给 agent——连接 agent（第 6 步）会给它自己的凭据。

## 5. （macOS）授予底层应用权限——TCC

第一方 Apple source（`apple-calendar`、`apple-reminders`）经由 macOS 读取，**第一次调用**会触发
Apple 的 TCC 授权。若尚未授予，Plexus 会返回一条清晰、可恢复的提示，而不是崩溃。到 **系统设置 ▸ 隐私与安全性**
里授予：**自动化**（允许 Plexus 控制"日历"）+ **日历**，以及**提醒事项**。这些是一次性的操作系统授权，
与 Plexus 自己的授权是两回事。

## 6. 连接你的第一个 agent

这就是整个接入过程——不用粘贴密钥，也不用手写配置。

![agent 如何连接 — admin 铸码并授权；agent 登记并调用；敏感调用挂起待批准](/diagrams/connect-flow.png)

**a. 在控制台里配置。** 打开 **Agents ▸ Connect an agent**：

1. **Identify（标识）**——给它一个 id（例如 `my-claude-runner`），选它的类型（Claude Code 会得到编译好的
   plugin）。
2. **Capabilities（能力）**——勾选一个初始集合，作为**常驻**授予（连接那一刻即可用）。read cap 可以常驻；
   **execute / 高敏感度 cap 不行**，它们每次使用都要单独批准，会列在 *skipped* 之下。选一个信任窗口（默认
   7 天）。
3. **Install（安装）**——复制它给出的那**一条命令**。

底层动作：签发一个**一次性 enroll 码**，并授予你勾选的 cap 集合。想用脚本完成，对应端点是
`GET /integration/:agentId`（由公开的 `install.sh` 支撑）。

**b. 在 agent 所在的环境里运行这条命令。** 它会安装一个专属的 Claude Code plugin，用码换取持久的
**专属 PAT**（以 `0600` 存储），然后删除该码。别的什么都不用接。

**c. agent 通过自带的 launcher `plexus-<agentId>` 调用 capability：**

```sh
plexus-my-claude-runner list                      # discover: what's callable now + what needs approval
plexus-my-claude-runner obsidian.vault.read Welcome.md
```

`list` 让 agent 看清自己能做什么（包括新暴露出来的 capability）——它永远不需要猜。launcher 版本隔离
（运行自带的引擎，绝不用全局 `plexus`），凭据在内部处理，agent 无感。**launcher 是 agent 完整且唯一的
接口**：它从不自己拼 HTTP，也从不碰认证。凡是它做不到的事，就是 agent 没有授权的事；agent 会来问你，
或请求一次授权。

**d. 审批流程——pending → approve。** 对第一方 source 的 **read** 自动放行（你已预先授予）。**write**
和任何 **execute capability** 都默认拒绝：调用以 *pending* 返回，请求出现在控制台的 **Approvals** 标签页，
配一张大白话卡片（谁、做什么、多久），你批准之后调用才会通过。execute capability **每次使用都单独批准**，
没有例外——它永远变不成常驻，连你也不行。

::: tip 没有真实 agent 也能观察这个循环
参见 [`examples/`](https://github.com/nemori-ai/plexus/tree/main/examples) 下的参考客户端。想弄懂 launcher
底下那层原始的 wire 协议，读[协议](/zh/protocol/)——但 agent 从不亲手说这层协议；说协议的是 launcher。
:::

## 7. 暴露你自己的 source（可选）

Apple source 开箱即用。要暴露你的笔记，加一个 Obsidian vault——从控制台的 **Sources** 面板、`plexus source`
管理 CLI，或启动参数：

```sh
bun run start --vault ~/Documents/MyVault               # read-only ⇒ obsidian.vault.read
bun run start --obsidian-rest --rest-url https://127.0.0.1:27124   # read-write ⇒ obsidian-rest.vault.{list,read,write}
```

这些参数会**持久化**到 `~/.plexus/sources.json`，下次启动自动加载（加 `--ephemeral` 则仅本次运行有效）。
受管 source 会立刻出现在 `.well-known` 和每个 agent 的 `list` 里，无需重启。（你安装的自定义**扩展**同样
持久化——它们靠 `~/.plexus/extensions.json` 熬过网关重启。）

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

所有状态都在 `~/.plexus/` 下。要重置：停止网关、删除该目录——下次启动会重新生成全新的 connection-key
+ 签名密钥。

---

## 后续步骤

- **[核心概念](/zh/concepts/)**——心智模型（来源、两个时钟、自描述的 Floor + 编译投影）。
- **[连接一个 agent](/zh/guide/connect-an-agent)**——一个真实的编码 agent，端到端。
- **[安全模型](/zh/architecture/security-model)**——权威的信任与认证模型（connection-key 对比专属 PAT、
  execute 永不常驻规则）。
