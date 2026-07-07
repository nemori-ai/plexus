---
title: 连接一个 agent
description: 把一个真实的编码 agent 端到端连接到运行中的 Plexus——管理员连接、一条命令安装、agent list 并 invoke。
---

# 把一个真实的编码 agent 端到端连接起来

本教程按你实际会用的方式，把一个真实的编码 agent 连接到运行中的 Plexus——**管理员连接 agent，一条命令装好，
agent list 出能做什么并调用。** 两个 agent，两种形态：

- **第 1 部分——Claude Code（编译好的 plugin）。** 在控制台连接 agent（或一次 API 调用），复制那**一条**
  安装命令，agent 就得到一个 plugin：一个 `plexus-<agentId>` launcher 加一个编译好的 skill。它运行
  `plexus-<agentId> list`，然后 invoke。
- **第 2 部分——Codex（AGENTS.md + 共享 CLI）。** 把 `plexus` 命令接到 Codex 的 PATH 上，把一次性码交给
  agent 去 `enroll`，再用 `codex exec` 驱动。

底层的 wire（enroll → handshake → grant → invoke）放在文末**附录**——连接 agent 时你从不会碰它。

还没启动过网关？先走一遍[快速上手](/zh/guide/)（装 Bun，`bun run start`）。

::: tip 两种凭据，一套信任模型
- **Connection-key**（`plx_live_…`）——你的**管理员**凭据，管控控制台和 `/admin/api/*`。**agent 永远看不到
  它。**
- **专属 PAT**——**agent 的**持久凭据，由一次性 enroll 码（`plx_enroll_…`）**兑换一次**得来。agent 的命令
  在内部处理它——agent 从不读取、构造或出示凭据，也从不自己拼 HTTP。对第一方 / 受管 source 的 read 可以在
  连接时授予为常驻；**write、execute，以及扩展上的任何操作，都要挂起等人批准**。完整模型：[安全模型](/zh/architecture/security-model)。
:::

---

## 开始之前

启动网关。在仓库根目录运行：

```sh
# Terminal 1 — keep the gateway running (loopback only, 127.0.0.1:7077).
bun run start --vault ~/Documents/MyVault     # an Obsidian vault is handy for reads
```

谁在本地打开 `http://127.0.0.1:7077/admin`、用 connection-key 认证，谁就是**管理员**兼**批准者**
——也就是你。下面的一切都在控制台完成（或走需要 connection-key 的管理 API）。

::: warning `Host` 头是必需的
网关把 **Host/Origin 守卫**钉在它绑定的端口上，每个端点都*先*跑守卫、再做认证（防 DNS 重绑定）。
`Host` 不是 `127.0.0.1:7077` 的请求一律拒绝，返回 `host_forbidden`（403）。下面每条 `curl` 都带
`-H "Host: 127.0.0.1:7077"`。
:::

---

## 第 1 部分——Claude Code：connect → install → list → invoke

### 1. 连接这个 agent（管理员）

在控制台打开 **Connect an agent**。agent 类型选 **Claude Code**，给它一个 id（例如 `my-cc`），选一个
**初始 cap 集合**——比如 `obsidian.vault.read`。连接这个动作同时做两件事：

- 签发**一次性 enroll 码**（`plx_enroll_…`，单次使用，约 15 分钟有效）；
- 把选中的 cap 作为**常驻**授权**授予**这个 agent——*人类批准就发生在这里，只做一次*，此后这些 cap 无需
  再提示即可调用。

等价的 API（需要 connection-key——这是管理员动作，不是 agent 动作）：

```sh
export KEY=$(cat ~/.plexus/connection-key)     # ADMIN credential — never given to the agent
curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
  -H "X-Plexus-Connection-Key: $KEY" \
  -X POST "http://127.0.0.1:7077/admin/api/agents/connect" \
  -d '{"agentId":"my-cc","agentType":"claude-code","capabilities":["obsidian.vault.read"]}'
```

### 2. 复制那条安装命令

控制台会为已连接的 agent 显示一条可复制的**单条安装命令**（由 `GET /integration/:agentId` 提供，
受管理员凭据管控）。它长这样：

```sh
curl -fsSL http://127.0.0.1:7077/integration/my-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

一次性码通过环境变量随命令传递（绝不烧进文件）；安装器把它落到一个 0600 的临时文件，兑换成 agent 的
PAT，然后删除。装上的是**为这一个 agent 编译**的 Claude Code plugin：一个 `plexus-my-cc` launcher
（自带版本锁定的引擎，绝不是裸的全局 `plexus`）加一个编译好的 `use-plexus` skill。

### 3. agent 先 list，再 invoke

装好之后，agent 的整个接口就是这个 launcher。它的子命令：

```sh
plexus-my-cc list                                   # what can I call NOW vs what needs approval
plexus-my-cc obsidian.vault.read path=Projects/Plexus.md
plexus-my-cc obsidian.vault.read --input '{"path":"Projects/Plexus.md"}' --json
```

- **`enroll`** 安装期间已替你运行（一次性码兑换成持久 PAT，本地存储）。如果 agent 哪天被取消 enroll
  （换了机器 / 重置了凭据），命令会提示它运行 `plexus-my-cc enroll <code>`——这是唯一会牵涉到码的地方。
- **`list`** 把每项 capability 标为 **callable-now**（有常驻授权）或 **needs-approval**。
  `obsidian.vault.read` 现在就能调，因为你在连接时授予了它。
- **`<capabilityId> [args]`** 用于 invoke——位置参数按顺序绑定到输入 schema，也可以用 `key=value` 或
  `--input '<json>'`。加 `--json` 解析 `InvokeResponse`；调用可能挂起时，加 `--purpose "<one sentence>"`
  告诉拥有者*为什么*。

在装好该 plugin 的 Claude Code 会话里，问它*“通过 Plexus 读一下我的 Obsidian 笔记 `Projects/Plexus.md`”*，
编译好的 skill 就会恰好运行上面这些命令，返回真实的笔记。

::: tip launcher 是 agent 完整且唯一的接口
永远不要自己拼 HTTP，永远不要猜认证。编译好的 skill 是网关那个实时、自描述的 Floor 的一层投影；
enroll→PAT→handshake→token→invoke 这条链由引擎内部的模板生成，从不进入 agent 的上下文。陈旧的 skill
永远越不过 Floor 的实时授权——最坏情况不过是引用了一项已撤销的 cap，invoke 直接失败。
:::

### 4. 当一次调用需要批准时

agent 若调用了你在连接时**没有**授予的东西——任何 `write` / `execute`，或任何 `extension` capability
（哪怕只是 read）——命令会报 `grant_pending_user`。agent 会转达网关撰写的说明，请你在控制台批准
（**Approvals** 标签页，在那里选信任窗口）：

```
http://127.0.0.1:7077/admin
```

![在 /admin 的 Approvals 标签页批准挂起的授权](/diagrams/grant-approval.png)

想在不触发挂起的情况下拓宽已连接 agent 的常驻 cap，直接在控制台多授予一些（或用更大的 cap 集合重新运行
**Connect an agent**）——`plexus-my-cc list` 随即把它们显示为 callable-now。

---

## 第 2 部分——驱动一个**真实**的 `codex` agent 对接 Plexus

Codex **不是**编译 plugin 的 agent。它通过 **AGENTS.md 块 + PATH 上的共享 `plexus` 命令**集成，由
`codex exec` 驱动。Plexus **不是** MCP server（不存在 `/mcp` wire），所以 Codex 的 `config.toml` 里
没有任何东西要配。

### B1. 把 Codex 接好 + enroll

```sh
# From the repo root — symlinks bin/plexus onto PATH + appends the AGENTS.md block.
bash integrations/codex/setup.sh
#   (if it warns ~/.local/bin isn't on PATH, add it:  export PATH="$HOME/.local/bin:$PATH")
```

然后**连接这个 agent**并让它 **enroll**。连接 Codex agent 的控制台流程与第 1 部分相同，但类型要选
**Generic / other agent**——那会把一次性码作为原始 enroll 坐标交付，而不是编译好的 plugin。兑换一次：

```sh
plexus enroll plx_enroll_…        # once — stores THIS agent's PAT locally
plexus list                       # sanity-check: the caps you granted show callable-now
```

（完整设置——自动 vs 手动、全局 vs 每项目 AGENTS.md——见
[`integrations/codex/setup.md`](https://github.com/nemori-ai/plexus/blob/main/integrations/codex/setup.md)。）

### B2. 为什么要 `--dangerously-bypass-approvals-and-sandbox`

**Codex 会给它运行的命令加沙箱。** `plexus` 命令通过**回环 HTTP**（`127.0.0.1`）与网关通信。`codex exec`
默认使用 `read-only` 沙箱，会**拦下这次回环调用**，Codex 因此够不到 Plexus。你得让 Codex 在驱动 Plexus
的那个会话里放行回环调用。最粗暴的办法就是这个 flag：

```
codex exec --dangerously-bypass-approvals-and-sandbox "<task>"
```

（更窄、更安全的做法：在 Codex 沙箱配置里授予网络权限，而不是整个移除沙箱。）这个 flag 移除沙箱，让
agent 能跟本地服务通信——**只在你自己的机器上、对你信任的自动化使用它。** 它是 Codex CLI 的 flag，不是
Plexus 的；Plexus 自己的授权（常驻授权 + 挂起批准）仍然作用于每一次调用。

### B3. 一个跑通的任务——*读我的日历 / 创建一条提醒*

网关运行的前提下（用 `PLEXUS_FAKE_APPLE=1 bun run start` 启动，得到确定性的 Apple 夹具、没有 macOS TCC
提示——见[暴露一个 source](/zh/guide/first-party-sources)）：

```sh
codex exec --dangerously-bypass-approvals-and-sandbox \
  "Use the plexus command: run 'plexus list' to see what's available, read today's
   events with apple-calendar.events.list, then create a follow-up reminder for the
   first event with apple-reminders.reminders.create. Use --json."
```

Codex 遵循 AGENTS.md 教它的纪律——**先 list，再 invoke**——比如会运行：

```text
exec   plexus list --json                                              succeeded
         → apple-calendar.events.list (read, callable-now),
           apple-reminders.reminders.create (write, needs-approval) …
exec   plexus apple-calendar.events.list --input '{"start":"2026-06-25","end":"2026-06-26"}' --json
         → { "ok": true, "output": { "events": [ { "title": "Team sync", … } ] } }
exec   plexus apple-reminders.reminders.create --input '{"list":"Reminders","title":"Follow up on Team sync"}' --json
```

**这次 write 会挂起。** `apple-reminders.reminders.create` 是 `write`，除非你在连接时把它授予为常驻，
否则命令会打印 `grant_pending_user` 通知并**轮询**，同时叫你去 `/admin` 批准（Approvals 标签页 + 信任窗口
选择器）。批准后，命令完成这次 invoke，Codex 报告提醒已创建。纯 read（`apple-calendar.events.list`）
你在连接时授予过，直接就能用。

### 一些坑——老实说

- **macOS TCC（*第一次*实时 Apple 调用会提示你）。** 在真实的 Mac 上、`PLEXUS_FAKE_APPLE` **未设置**时，
  Apple source 会 shell 出 `osascript`/JXA，每个的**首次**实时使用都会弹 macOS 的 **TCC** 授权对话框。
  你若拒绝，调用会失败，并给出精确的“到系统设置里启用”的提示。想要一次不碰 TCC 的封闭运行，设
  `PLEXUS_FAKE_APPLE=1`。
- **`osascript` provider 在超大列表上的性能**——经 `osascript` 走的 Calendar/Reminders 在极大的存储上
  很慢。把查询限定范围（一天 / 一周的窗口、某个具体列表）。
- **Codex 的沙箱默认拦回环**——如果 `plexus list` 在 Codex 里报网络错误、同一条命令在你自己的 shell 里
  却能跑，重读 B2。

---

## 附录——底层揭秘（PAT wire）

连接 agent 时你从不会碰这些——`plexus` 命令全包了。但它在 wire 上做的正是这些（权威依据：
[安全模型](/zh/architecture/security-model) §2 里引用了 `file:line`）。

1. **DISCOVER**——`GET /.well-known/plexus`（免认证）。网关身份 + 摘要 capability 列表 + `auth` 公示
   （enroll / handshake 的 URL）。
2. **ENROLL**——`POST /agents/enroll { "code": "plx_enroll_…" }`。这一步**码就是凭据**；connection-key
   一概不收。成功时明文返回持久 **PAT**，**仅此一次**——命令把它存到本地，之后再也无法找回：
   ```sh
   curl -s -H "Host: 127.0.0.1:7077" -H "content-type: application/json" \
     -X POST "http://127.0.0.1:7077/agents/enroll" \
     -d '{"code":"plx_enroll_…"}'          # → { "pat": "plx_agent_…", "agentId": "my-cc" }
   ```
3. **HANDSHAKE**——`POST /link/handshake`，带 `Authorization: Bearer plx_agent_…`。PAT 经过校验，会话
   绑定到它解析出的**真实** `agentId`（客户端永远无法自称是别的 agent）。返回 `sessionId` + 完整
   manifest。
4. **GRANT**——`PUT /grants`，带 `X-Plexus-Session: <sessionId>` 头和 `{ "grants": { "<capabilityId>": "allow" } }`。
   管理员已设为常驻的 capability 会短路成一个受限 token；否则授权器要么自动放行一次低敏感度的第一方
   read，要么替拥有者**挂起**（`grant_pending_user` + `pendingId`；用同一个会话头轮询 `GET /grants/status?pendingId=…`）。
5. **INVOKE**——`POST /invoke`，带 `Authorization: Bearer <scoped-jwt>` 和 `{ "id": "<capabilityId>", "input": { … } }`。
   统一的结果契约（ADR-017）：`{ id, ok, output?, error?, auditId }`；拒绝返回 `ok:false`，`error.code`
   取自一个闭合联合。

这条链的精确参考实现是
[`examples/min-agent/`](https://github.com/nemori-ai/plexus/tree/main/examples/min-agent)——捆绑引擎
（`tools/plexus-cli/plexus`）就是它经过认可、经 Floor 校验的版本，随每个编译好的 plugin 一起交付。留意
那些指引里**从来没有**的动作：读磁盘上的密钥、在 handshake 时出示 connection-key、自铸 token。唯一公示的
前进路径，就是那条经审计、经拥有者批准的路径。

---

## 接下来去哪

- [编写一个扩展](/zh/guide/create-an-extension)——给 agent 一项网关未随附的 capability（例如 vault
  *write*），并让编码 agent 从一段描述里写出 manifest。
- [暴露一个 source](/zh/guide/first-party-sources)——随附的 source（Obsidian、Apple Calendar/Reminders、
  Things、Claude Code）：capability id、授权、前置条件。
- [协议](/zh/protocol/)——冻结的 wire 契约与相关 ADR（ADR-016 端点公示、ADR-017 `/invoke`、ADR-018 统一
  信任模型）。
