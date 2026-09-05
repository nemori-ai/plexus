---
title: "把 agent 暴露给其他 agent"
description: "Plexus 的第二种用法：把 coding agent（Claude Code、Codex）发布成 capability，供其他机器上的 agent 调用。执行默认逐次批准；所有者也可以明确为指定的 agent 与 capability 设置持续授权，已有授权符合条件时，调用无须再次询问。"
---
# 把 agent 暴露给别的 agent {#把-agent-暴露给别的-agent}

Plexus 可以控制 agent 对文件和工具的访问，也可以把一个 coding agent 的执行入口交给另一个 agent 调用。A 机通过 Plexus 暴露 `claudecode.run`，B 机上的 agent 就能向它提交任务。这样，一个 **orchestrator** 可以调用多个 **worker**，各个 worker 的授权仍由各自的 owner 决定。

在 macOS 上，`claudecode.run` 是 **first-party** source，会自行注册，无需配置。暴露这个入口后，其他 agent 可以请求在你的机器上执行任务。执行默认逐次批准；只有你在连接时明确开启常驻授权，指定的 agent 才能持续调用这项 capability。

## 为什么执行是赌注最高的那一档 {#为什么执行是赌注最高的那一档}

连接时选中的读取能力可以获得常驻授权。执行涉及在你的机器上运行代码，因此 `execute` capability 默认**每次使用、逐次批准**，agent 自己永远不能解除这项限制。唯一能让 execute 常驻的方式，是你在连接时刻意 opt-in：为特定 agent + capability 开启常驻 execute 授权。这个选项默认关闭，并且需要双重确认。

审批卡会显示这次执行请求的授权范围：

![一张 execute 调用的 Plexus 审批卡。标题“Grant request”，标签 GRANT / ORCHESTRATOR / PLEXUS-CLI，以及 FIRST-PARTY 和 ELEVATED 两枚徽章。Plexus says：“Approving lets orchestrator EXECUTE Run Claude Code (sandboxed)（first-party, elevated-sensitivity）for this one request only；revoke anytime in Plexus → Grants。”SCOPE：claudecode.run [execute]。agent 请求的是 Once（仅供参考）。警告写着“granting execute on claudecode.run is a mutating/side-effecting grant and requires a human decision”。右侧是 Trust window 下拉框：对于 owner 未在连接时 opt-in 常驻的 execute capability，无论选择哪个窗口，最终都为“Once”。下方是 Approve / Deny 按钮。](/screenshots/guide/08-execute-approval.png)

与读取请求相比，这张卡多了 **ELEVATED** 徽章和 **mutating/side-effecting** 警告，提醒 owner 这项调用会产生副作用，需要明确授权。

**trust window 最终为 `Once`**：下拉框仍提供通常的窗口选项，但对于你没有在连接时 opt-in 常驻的 execute capability，无论选哪个，网关都会将它限制为 `Once`。这条规则由 grant service 执行，不依赖 UI。批准只对当前这次调用有效，下一次仍会挂起等待批准。

## 一次调用长什么样 {#一次调用长什么样}

调用方用 `list` 查看自己可用的能力，与[信任闭环](/zh/guide/run-it)中的步骤相同。execute capability 默认不会获得预先授权，因此会显示为 **needs-approval**：

```text
  ○ claudecode.run — Run Claude Code (sandboxed) (execute)  [first-party, elevated]
      Launch headless Claude Code to do REAL coding work ... sandboxed to ONE authorized
      directory: it does its work there and cannot create or modify files outside it ... you only
      pass a `{ prompt }` ... This is a SENSITIVE execute capability: it PENDS for the owner's
      approval before it runs — issue the call and WAIT.
```

下面的例子没有开启常驻 execute 授权。调用会挂起，等 owner 批准后继续，并返回结果：

```text
$ plexus-orchestrator claudecode.run --input '{"prompt":"Read README.md, then add a small greet(name) example ..."}'
plexus: 'claudecode.run' is awaiting the owner's approval — waiting (up to 15 min). Approve it in the Plexus console.
# (owner approves — trust window resolves to "Once"; this execute wasn't opted into standing)
plexus: approved — invoking 'claudecode.run'.
{
  "ok": true,
  "launched": false,
  "sandboxed": true,
  "output": "",
  "exitCode": null,
  "reason": "record mode: the owner has not enabled real launch for this source (Plexus console → What I expose → Claude Code → Real launch), so the native command was assembled and audited but not spawned",
  "op": "run"
}
```

注意 `launched: false`。`claudecode.run` 默认使用 **record 模式**：原生命令会完整组装并写入审计，但**不会真正启动 Claude Code 进程，也不会消耗模型额度**。

在这个模式下，你仍可以走完 enroll、逐次挂起、owner 批准和审计的授权流程。系统也会记录沙箱配置，包括 `sandboxed: true` 和授权目录 jail。真实执行时，Claude Code 自带的原生沙箱会将写入限制在该目录内；record 模式记录的是准备采用的约束，尚未验证实际运行时的沙箱行为。

真正启动进程需要 owner 单独开启开关，见 [Real launch](#real-launch-record-to-real)。

## owner 看到什么，agent 看到什么 {#owner-看到什么-agent-看到什么}

上面的 JSON 就是这次调用返回给 agent 的内容，包括 `ok`、`launched`、`sandboxed`、`output`、`exitCode`、`reason` 和 `op`。agent 永远拿不到绝对 jail 路径、机器的布局、完整 argv；这些信息会让调用方能够识别 owner 机器的特征。

可达只换来一个结果，从不换来一张地图。

owner 的**审计**则保留命令和约束的详细记录：

```text
invoke claudecode.run detail = {
  transport: "in-process", kind: "capability", op: "run",
  sandboxed: true,
  jail: "<the authorized dir>",
  mechanism: "claude-native",
  launched: false,
  argv: ["<claude>","-p","«prompt»","--dangerously-skip-permissions","--permission-mode","bypassPermissions"],   # prompt is masked to «prompt» in the audit argv
  confinement: {...}
}
```

owner 可以查看 jail 路径、约束机制和组装好的 argv。即使在这份审计里，prompt 文本也会被遮蔽为 `«prompt»`，不保留原样的指令。审计记录调用发生过，以及系统为它设置了哪些执行约束；其中的 `launched` 字段标明进程是否真正启动。

## 跨机器——两条路 {#跨机器——两条路}

前面的例子发生在同一台机器上。要让另一台机器上的 agent 调用 `claudecode.run`，Plexus 提供两种连接方式。两条路的信任模型完全一致，区别在于挂起在哪里触发、沙箱在哪里运行。

### 单机跨隧道——`publicHostname` {#单机跨隧道——publichostname}

A 机是 agent 要连接的网关所在机器。通过 `PLEXUS_PUBLIC_HOSTNAME` 将 A 的网关发布到一个 hostname 后，远端 agent 就可以通过该地址 enroll 和调用。

这个开关**只增加可达性**。信任模型保持不变：挂起在 A 触发，沙箱在 A 运行，审计也留在 A。

[`home-gateway` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)验证了这条路径：通过真实的 Cloudflare named tunnel，依次完成 install、enroll、常驻读取、写入挂起、批准，以及撤销后的 fail-closed。示例中的挂起发生在 `workspace.write` 上；`claudecode.run` 使用同一条连接路径，但还要遵守 execute 默认逐次批准、仅 owner 可在连接时 opt-in 常驻的限制。

::: warning 跨隧道时，coding 类 capability 要带 `async: true`
隧道有请求时长上限。同步调用 `claudecode.run` / `codex.run` 时，如果任务超过这个上限，Cloudflare 会在约 100 秒返回 `524`。网关仍会继续运行任务并记录审计，但调用方无法从这次同步响应中拿到结果。若已开启 real launch，重试还会启动第二次真实执行，再次消耗模型额度。

这两个条目都标记为 `longRunning`。调用时带上 `async: true`，先取得执行句柄，再通过 `GET /invoke/status?runId=…` 获取结果。见[异步 invoke 通道](/zh/protocol/#async-invoke)。
:::

### 多机——联邦 mesh {#多机——联邦-mesh}

当 coding agent 与 orchestrator 不在同一台机器上时，也可以通过 [mesh](/zh/architecture/mesh) 挂载 capability。

capability 位于一台 **proxy** 机器上，挂载到一台 **parent primary**，agent 与 parent 通信。请求在 **parent 的 admin 挂起等待批准**，沙箱则运行在 **proxy** 上，也就是真正安装并运行 Claude Code 的机器。每台主机分别保留自己处理过的操作的审计。

[`mesh-security-audit/cloud` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)已完成这条路径的端到端验证，不过使用的是 **`codex.run`**，不是 `claudecode.run`。示例中，一个 cloud agent 经 mesh 调用 Mac workload 上的 Codex，验证了沙箱 jail、逐次挂起、各主机的审计，以及撤销后的 fail-closed。

::: warning 验证范围
`claudecode.run` 与 `codex.run` 使用相同的跨机器机制，包括 enroll、默认逐次挂起、调用响应与审计的分离，以及 mesh 转发。

端到端验证过的是 `mesh-security-audit` 中的 **`codex.run`** 版本。`claudecode.run` 自身的测试仅为针对 Claude Code capability 的**本地 record 模式单元测试**，没有单独进行跨机器端到端验证。因此，Codex 示例验证了共用机制，但不能据此声称 Claude Code 的 mesh 路径已通过独立 e2e 验证。
:::

## Real launch——从 record 切到真跑 {#real-launch-record-to-real}

默认的 record 模式让你无需消耗模型额度，就能检查授权流程和生成的审计。需要实际运行 Claude Code 时，由 owner 显式开启：

- 在 console 中：**What I expose → Claude Code → Real launch**，或
- 为网关设置 `PLEXUS_CC_HEADLESS_LAUNCH=1`。

开启 real launch 后，获得授权的调用会在 Claude Code 自带的原生沙箱中启动 headless Claude Code，写入限制在授权目录内。响应会包含 `launched: true`、实际的 `output` 和 `exitCode`，不再返回 record 模式的那句 `reason`。

这会**真正运行 Claude Code，并消耗模型额度**。开关默认关闭，由 owner 决定是否开启。开启后，每次调用仍需经过同一套授权检查：默认逐次批准，除非你在连接时为指定 agent 的这项 execute capability opt-in 了常驻授权。

## 往后走 {#往后走}

**一台机器提供多个 worker 入口**是后续方向。例如，将 Opus 和 Sonnet 分别暴露为两个 capability，调用方按 capability id 选择 worker，owner 为每个入口单独管理授权。**这个能力现在还不存在。**

目前没有 `claudecode` kind adapter，`claudecode.run` 也不接受 model 参数。它的 argv 仍是 `claude -p <prompt>` 加上 CC 的 permission-bypass flags，不包含 `--model`。

要支持这种用法，需要：

- 一个 `claudecode` kind adapter，类似 `workspace-dir` 的 adapter；
- 将 model 参数传过 launcher/entries，注入 `claude --model`。

在此之前，每台机器只有一个入口。

**团队共享 worker 池**是另一个方向：由一个持续在线的中立网关连接多个 worker，orchestrator 从中调用所需资源，执行仍默认逐次批准。[联邦 mesh](/zh/architecture/mesh) 已实现的 parent-primary 与主动向外连接的 proxy 机制，为这种部署提供了基础。当前机制的运行示例见 [`mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)。

---

这里沿用的是[信任闭环](/zh/guide/run-it)中的机制：enroll、授权、审计和撤销。被调用的 capability 从读取文件变成了运行 coding agent，因此执行默认需要逐次批准；只有 owner 在连接时显式 opt-in，指定的 agent + capability 才能获得常驻 execute 授权。

另见[连接一个 agent](/zh/guide/connect-an-agent)与[安全模型](/zh/architecture/security-model)，了解完整的授权规则。
