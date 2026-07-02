---
title: 连接一个 agent
description: 把一个真实的编码 agent 端到端连接到运行中的 Plexus——管理员连接、一条命令安装、agent list 并 invoke。
---

# 把一个真实的编码 agent 端到端连接起来

本教程以你实际会用的方式，把一个真实的编码 agent 连接到运行中的 Plexus——**管理员连接这个 agent，一条命令
安装它，agent list 出它能做什么并调用它。** 两个 agent，两种形态：

- **第 1 部分——Claude Code（编译好的 plugin）。** 你在控制台里连接一个 agent（或一次 API 调用），复制那条
  **一条命令安装**，agent 就得到一个 plugin，带着一个 `plexus-<agentId>` launcher 和一个编译好的 skill。它运行
  `plexus-<agentId> list`，然后 invoke。
- **第 2 部分——Codex（AGENTS.md + 共享 CLI）。** 你把 `plexus` 命令接到 Codex 的 PATH 上，把它那个一次性的码
  交给 agent 去 `enroll`，再用 `codex exec` 来驱动它。

底层的 wire（enroll → handshake → grant → invoke）作为**附录**放在文末——你连接一个 agent 时从不会碰它。

如果你还没启动过网关，先做[快速上手](/zh/guide/)（装 Bun，`bun run start`）。

::: tip 用两种凭据讲清楚的信任模型
- **Connection-key**（`plx_live_…`）——你的**管理员**凭据。它管控控制台和 `/admin/api/*`。**agent 永远看不到
  它。**
- **专属 PAT**——**agent 的**持久凭据，从一个一次性 enroll 码（`plx_enroll_…`）**兑换一次**而来。agent 的命令
  在内部处理它——agent 从不读取、构造或出示凭据，也从不自己拼 HTTP。对第一方 / 受管 source 的 read 可以在连接
  时被授予为常驻；**write、execute，以及扩展上的任何操作，都要挂起等一个人来批准**。完整模型：[安全模型](/zh/architecture/security-model)。
:::

---

## 开始之前

启动一个网关。在仓库根目录运行：

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

你——那个在本地访问位于 `http://127.0.0.1:7077/admin`、经 connection-key 认证的控制台的人类——就是**管理员**和
**批准者**。下面的一切都在那里完成（或经由需要 connection-key 的管理 API）。

::: warning `Host` 头是必需的
网关把一个 **Host/Origin 守卫**钉定到它所绑定的端口，并在每个端点上*先于*认证运行它（DNS 重绑定防护）。一个
`Host` 不是 `127.0.0.1:7077` 的请求会被以 `host_forbidden`（403）拒绝。下面每一条 `curl` 都发送
`-H "Host: 127.0.0.1:7077"`。
:::

---

## 第 1 部分——Claude Code：connect → install → list → invoke

![两个时钟 — 信任窗口之上的短时受限 token](/diagrams/two-clocks.png)

### 1. 连接这个 agent（管理员）

在控制台里，打开 **Connect an agent**。选 **Claude Code** 这个 agent 类型，给这个 agent 一个 id（例如
`my-cc`），并选一个**初始 cap 集合**——比如 `obsidian.vault.read`。连接这一动作同时做两件事：

- 签发一个**一次性 enroll 码**（`plx_enroll_…`，单次使用，约 15 分钟），并
- 把选中的这些 cap 作为**常驻**授权**授予**给这个 agent——*这就是那次人类批准，只做一次*，因此这些 cap 无需
  再次提示即可调用。

等价的 API（需要 connection-key——这是一个管理员动作，不是 agent 动作）：

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"my-cc","agentType":"claude-code","capabilities":["obsidian.vault.read"]}'
```

### 2. 复制那条一条命令安装

控制台会为已连接的 agent 显示一条可复制的**一条命令安装**（由 `GET /integration/:agentId` 提供，受管理密钥
管控）。它长这样：

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

这个一次性码通过一个环境变量随命令传递（绝不烧进文件里）；安装器把它落到一个 0600 的临时文件中，兑换成 agent
的 PAT，然后删除它。装上的是一个**为这单个 agent 编译**的 Claude Code plugin：一个 `plexus-my-cc` launcher（它
自己捆绑的、版本钉定的引擎——绝不是裸的全局 `plexus`）外加一个编译好的 `use-plexus` skill。

### 3. agent 先 list，再 invoke

一旦装好，agent 的整个接口就是这个 launcher。它的子命令：

```sh
plexus-my-cc list                                   # what can I call NOW vs what needs approval
plexus-my-cc obsidian.vault.read path=Projects/Plexus.md
plexus-my-cc obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```

- **`enroll`** 在安装期间已替你运行（兑换一次性码 → 持久 PAT，本地存储）。如果这个 agent 什么时候被取消 enroll
  （换了新机器 / 重置了凭据），命令会告诉它去运行 `plexus-my-cc enroll <code>`——这是唯一一处会牵涉到码的地方。
- **`list`** 会把每项 capability 标记为 **callable-now**（一个常驻授权）还是 **needs-approval**。
  `obsidian.vault.read` 现在就可调用，因为你在连接时授予了它。
- **`<capabilityId> [args]`** 用于 invoke——位置参数按顺序绑定到输入 schema，或用 `key=value`，或用
  `--input '<json>'`。加 `--json` 来解析 `InvokeResponse`；加 `--purpose "<one sentence>"` 在一次调用可能挂起时
  告诉拥有者*为什么*。

在一个装好该 plugin 的 Claude Code 会话里，问它*"通过 Plexus 读一下我的 Obsidian 笔记 `Projects/Plexus.md`"*，
就会让那个编译好的 skill 恰好运行上面这些命令，并返回真实的笔记。

::: tip launcher 是 agent 完整且唯一的接口
永远不要自己拼 HTTP，永远不要猜认证。这个编译好的 skill 是对网关那个鲜活、自描述的 Floor 的一层投影；
enroll→PAT→handshake→token→invoke 这条链在引擎内部由模板生成，从不进入 agent 的上下文。一个陈旧的 skill 永远
无法超出 Floor 那份鲜活的授权——最坏情况也不过是它引用了一项已撤销的 cap，于是 invoke 直接失败。
:::

### 4. 当一次调用需要批准时

如果 agent 调用了某个你在连接时**没有**授予的东西——任何 `write` / `execute`，或任何 `extension` capability
（哪怕只是一次 read）——命令会报出 `grant_pending_user`。agent 会转达网关撰写的说明，并请你在控制台里批准它
（**Pending** 标签页，你在那里挑一个信任窗口）：

```
http://127.0.0.1:7077/admin
```

[在 /admin Pending 标签页批准一个挂起的授权](https://github.com/nemori-ai/plexus/blob/main/docs/assets/screenshots/grant-approval.png)

要在不触发挂起的情况下拓宽一个已连接 agent 的常驻 cap，只需从控制台里多授予一些（或用一个更大的 cap 集合重新
运行 **Connect an agent**）——`plexus-my-cc list` 随后就会把它们显示为 callable-now。

---

## 第 2 部分——驱动一个**真实**的 `codex` agent 对接 Plexus

Codex **不是**一个编译好 plugin 的 agent。它通过一个 **AGENTS.md 块 + 一个在 PATH 上的共享 `plexus` 命令**来
集成，由 `codex exec` 驱动。Plexus **不是**一个 MCP server（不存在 `/mcp` wire），因此没有什么东西要放进 Codex
的 `config.toml`。

### B1. 把 Codex 接好 + enroll

```sh
# From the repo root — symlinks bin/plexus onto PATH + appends the AGENTS.md block.
bash integrations/codex/setup.sh
#   (if it warns ~/.local/bin isn't on PATH, add it:  export PATH="$HOME/.local/bin:$PATH")
```

然后**连接这个 agent**并给它 **enroll**。连接一个 Codex agent 与第 1 部分是同样的控制台流程，但要选 **Generic /
other agent** 类型——那会把一次性码作为原始的 enroll 坐标交付，而不是一个编译好的 plugin。兑换一次：

```sh
plexus enroll plx_enroll_…        # once — stores THIS agent's PAT locally
plexus list                       # sanity-check: the caps you granted show callable-now
```

（完整设置——自动 vs 手动、全局 vs 每项目 AGENTS.md——见
[`integrations/codex/setup.md`](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md)。）

### B2. 为什么要 `--dangerously-bypass-approvals-and-sandbox`

**Codex 会给它运行的命令加沙箱。** `plexus` 命令通过**回环 HTTP**（`127.0.0.1`）与网关通信。`codex exec` 默认用
一个 `read-only` 沙箱，它会**阻断那次回环调用**，于是 Codex 无法触达 Plexus。你必须让 Codex 在你驱动 Plexus 的
那个会话里做那次回环调用。最粗暴的办法就是这个 flag：

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

（更窄、更安全的替代方案是在你的 Codex 沙箱配置里授予网络权限，而不是整体移除沙箱。）它移除沙箱，使 agent 能够
与一个本地服务通信——**只在你自己拥有的机器上、对你信任的自动化使用它。** 它是一个 Codex CLI 的 flag，不是
Plexus 的；Plexus 自己的授权（常驻授权 + 挂起批准的那套动作）仍然作用于每一次调用。

### B3. 一个跑通的任务——*读我的日历 / 创建一条提醒*

在网关运行的前提下（用 `PLEXUS_FAKE_APPLE=1 bun run start` 启动它，以获得确定性的 Apple 夹具且没有 macOS TCC
提示——见[暴露一个 source](/zh/guide/first-party-sources)）：

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex 遵循它的 AGENTS.md 教给它的纪律——**先 list，再 invoke**——例如会运行：

```text
exec   plexus list --json                                              succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, needs-approval) …
exec   plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
```

**那次 write 会挂起。** `apple-reminders.reminders.create` 是一次 `write`，所以除非你在连接时把它授予为常驻，
命令会打印一条 `grant_pending_user` 通知并**轮询**，同时叫你去 `/admin` 批准它（Pending 标签页 + 信任窗口
选择器）。批准它；命令便完成这次 invoke，Codex 报告已创建的提醒。一次纯 read（`apple-calendar.events.list`）——
你在连接时授予过的——直接就能用。

### 一些坑——老实说

- **macOS TCC（*第一次*实时 Apple 调用会提示你）。** 在一台真实的 Mac 上、`PLEXUS_FAKE_APPLE` **未设置**时，
  Apple source 会 shell 出 `osascript`/JXA，每一个的**首次**实时使用都会触发 macOS 的 **TCC** 授权对话框。如果
  你拒绝，调用会以一条精确的"到系统设置里启用它"的消息失败。要一次不带 TCC 的封闭运行，设 `PLEXUS_FAKE_APPLE=1`。
- **`osascript` provider 在超大列表上的性能**——通过 `osascript` 走的 Calendar/Reminders 在极大的存储上很慢。
  把你的查询限定范围（一天/一周的窗口、某个具体列表）。
- **Codex 的沙箱默认阻断回环**——如果 `plexus list` 在 Codex 里以网络错误失败、而同一条命令在你自己的 shell 里
  却能用，重读 B2。

---

## 附录——底层揭秘（PAT wire）

你连接一个 agent 时从不会碰这些——`plexus` 命令把它们全包了。但这正是它在 wire 上所做的（权威依据：在
[安全模型](/zh/architecture/security-model) §2 里引用了 `file:line`）。

1. **DISCOVER**——`GET /.well-known/plexus`（免认证）。网关身份 + 一份摘要 capability 列表 + `auth` 公示
   （enroll / handshake 的 URL）。
2. **ENROLL**——`POST /agents/enroll { "code": "plx_enroll_…" }`。这里**码就是凭据**；connection-key 绝不被
   接受。成功时它会以明文**一次**返回持久的 **PAT**——命令把它本地存下，之后再也无法找回：
   ```sh
   curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
     -X POST "http://127.0.0.1:7077/agents/enroll" \
     -d '{"code":"plx_enroll_…"}'          # → { "pat": "plx_agent_…", "agentId": "my-cc" }
   ```
3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer plx_agent_…`。PAT 会被校验，会话被绑定到它
   解析出的那个**真实**的 `agentId`（一个客户端永远无法自称是别的 agent 的身份）。返回一个 `sessionId` + 完整
   manifest。
4. **GRANT**——`PUT /grants`，带 `X-Plexus-Session: <sessionId>` 头以及 `{ "grants": { "<capabilityId>": "allow" } }`。
   一项管理员已经设为常驻的 capability 会短路到一个受限 token；否则授权器要么自动放行一次低敏感度的第一方
   read，要么替拥有者**挂起**（`grant_pending_user` + `pendingId`；用同一个会话头轮询 `GET /grants/status?pendingId=…`）。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 以及 `{ "id": "<capabilityId>", "input": { … } }`。
   一个统一的结果契约（ADR-017）：`{ id, ok, output?, error?, auditId }`；一次拒绝是 `ok:false` 配一个闭合联合
   的 `error.code`。

这条链的精确参考实现是
[`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent)——那个捆绑引擎
（`tools/plexus-cli/plexus`）就是它经过认可、经 Floor 校验的版本，每一个编译好的 plugin 都随附它。留意一个 agent
**从不**被指示去做的事：读一把磁盘上的密钥、在 handshake 时出示 connection-key、或自铸一个 token。唯一被公示的
前进路径，就是那条经审计、经拥有者批准的路径。

---

## 接下来去哪

- [编写一个扩展](/zh/guide/create-an-extension)——给一个 agent 一项网关未随附的 capability（例如一次 vault
  *write*），并让一个编码 agent 从一段描述里编写出 manifest。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的那些 source（Obsidian、Apple Calendar/Reminders、
  Things、cc-master）：capability id、授权、以及前置条件。
- [协议](/zh/protocol/)——冻结的 wire 契约与那些 ADR（ADR-016 端点公示、ADR-017 `/invoke`、ADR-018 统一信任
  模型）。
