---
title: 把 agent 暴露给别的 agent
description: Plexus 的第二种用法——把一个 coding agent（Claude Code、Codex）发布成 capability，让别的机器上的 agent 跨机调用，每次执行默认逐次批准。
---

# 把 agent 暴露给别的 agent

到目前为止，Plexus 挡在你的**文件和工具**前面。但一个跑着的 **coding agent** 本身就是一个
capability。A 机可以把它的 Claude Code 执行入口——`claudecode.run`——经 Plexus 暴露出去，B 机上的
agent 就能调用它。画面因此翻了过来：从一个 agent 够到多个资源，变成一个 **orchestrator** 够到多个
**worker**，每个 worker 都坐在各自 owner 的门后。在 macOS 上，`claudecode.run` 是 **first-party**
source，自己注册，无需配置。把它暴露出去，别的 agent 就能让你的机器干活——每次一趟，趟趟经过批准。

## 为什么执行是赌注最高的那一档

读可以常驻。一次文件夹读风险低，你也预先拍过板，于是它不打扰你就流过去了。**执行默认逐次。**
`execute` capability 默认**每次使用、逐次批准**——agent 自己永远解除不了这道门。唯一能让 execute
常驻的，是你自己在连接时的刻意 opt-in：为特定 agent + capability 开启常驻 execute 授权（默认关闭、
双重确认）。把"在你机器上跑代码"的能力交给另一个 agent，是 Plexus 治理的最锋利一刃，所以这道门守在
每一次调用前面。

整条规则在审批卡上一目了然：

![一张 execute 调用的 Plexus 审批卡。标题"Grant request"，标签 GRANT / ORCHESTRATOR / PLEXUS-CLI，再加两枚这类调用特有的徽章——FIRST-PARTY 和 ELEVATED。Plexus says："Approving lets orchestrator EXECUTE Run Claude Code (sandboxed)（first-party, elevated-sensitivity）for this one request only；revoke anytime in Plexus → Grants。"SCOPE：claudecode.run [execute]。agent 请求的是 Once（仅供参考）。一条警告写着"granting execute on claudecode.run is a mutating/side-effecting grant and requires a human decision"。右侧是 Trust window 下拉框——对一项 owner 没有 opt-in 常驻的 execute capability，无论选哪个窗口都落定为"Once"。下方是 Approve / Deny 按钮。](/screenshots/guide/08-execute-approval.png)

这张卡上有两样东西，读的审批卡上没有。**ELEVATED** 徽章和那句 **mutating/side-effecting** 警告，把它
标成一件需要人来拍板的事。而 **trust window 落定为 `Once`**：下拉框里给的是平常那些窗口选项，但对一项
你没有在连接时 opt-in 常驻的 execute capability，无论你选哪个，网关都会把它钳到 `Once`——规则住在
grant service 里，不在 UI 里。批准这一趟，你授权的就恰好是这一趟——下一趟重新挂起。

## 一次调用长什么样

调用方用 `list` 查看自己可用的能力范围，和 [信任闭环](/zh/guide/run-it) 中的做法一样。执行能力会显示为 **needs-approval**，默认并未预先授权：

```text
  ○ claudecode.run — Run Claude Code (sandboxed) (execute)  [first-party, elevated]
      Launch headless Claude Code to do REAL coding work ... sandboxed to ONE authorized
      directory: it does its work there and cannot create or modify files outside it ... you only
      pass a `{ prompt }` ... This is a SENSITIVE execute capability: it PENDS for the owner's
      approval before it runs — issue the call and WAIT.
```

默认情况下，每次调用都会挂起，等所有者批准后才会继续执行，并返回：

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

注意 `launched: false`。`claudecode.run` 开箱即是 **record 模式**：原生命令被完整拼装、写进审计，
但 Claude Code 进程**不真正拉起**——于是这趟调用**不烧一分钱模型额度**。record 模式里为真
的，恰是信任所依赖的一切：enroll、逐次挂起、owner 拍板，以及约束姿态（`sandboxed: true`、jail——
Claude Code 自带的原生沙箱，把这趟跑的写入限制在授权目录内）。你可以把整条授权闭环走完，一个 token
都不花。切到真跑是一个刻意的、单独的开关——见
[Real launch](#real-launch-record-to-real)。

## owner 看到什么，agent 看到什么

上面那段 JSON 就是 agent 能看到的全部，它被刻意做薄：`ok / launched / sandboxed / output /
exitCode / reason`，仅此而已。agent 永远拿不到绝对 jail 路径、机器的布局、完整 argv——把这些交出去，
调用方就能给 owner 的机器做指纹。可达只换来一个结果，从不换来一张地图。

所有者的**审计记录**会详细记下这次调用：

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

同一次调用，双方看到的内容不同。智能体只得到行动所需的最少结果；所有者保留 jail 路径、隔离机制和解析后的 argv，作为运行受到隔离的证据。即使在审计里，提示词也会被遮蔽为 `«prompt»`：记录的是*运行发生过*以及*它如何受到隔离*，不原样保存指令。响应精简，审计完整，才能让陌生人的智能体调用执行能力，而不向它泄露机器信息。

## 跨机器——两条路

前面的操作都在同一台机器上。要让**另一台机器**上的 agent 调用 `claudecode.run`，得先让它能通过网络连到网关。Plexus 提供两种部署方式，信任模型完全相同，区别只在于*审批请求在哪里进入待批准状态*，以及*沙箱在哪里运行*。

### 单机跨隧道——`publicHostname`

智能体连接的是机器 A。通过 `PLEXUS_PUBLIC_HOSTNAME` 将 A 的网关发布到公开主机名下，远程智能体就能经隧道注册并调用。这个设置**只增加可达性**，信任模型不变：待审批请求在 A 上产生，沙箱运行在 A 上执行，审计记录也保存在 A 上。这种做法已在 [`home-gateway` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)
中验证：使用真实的 Cloudflare 命名隧道，依次安装 → 注册 → 持续授权读取 → 写入待审批 → 批准 → 撤销后拒绝调用。示例演示的是 `workspace.write` 的待审批调用；`claudecode.run` 走同一路径，但执行默认仍须逐次审批。

::: warning 跨隧道时，coding 类 capability 要带 `async: true`
经过隧道调用时，信任模型不变，但**请求有时长上限**。同步调用 `claudecode.run` 或 `codex.run` 时，如果任务耗时超过上限，**边缘节点会返回超时错误**（Cloudflare 约在 100 秒后返回 `524`），网关仍会把任务执行完并记录审计。同步调用的结果就此丢失；重试会**再启动一次实际执行，消耗模型额度**。这两个入口都标记为 `longRunning`：请求中传入 `async: true`，取得运行句柄，再通过 `GET /invoke/status?runId=…` 获取结果。见 [异步 invoke 通道](/zh/protocol/#async-invoke)。
:::

### 多机——联邦 mesh

编码 agent 和编排器不在同一台机器上时，能力通过 [mesh](/zh/architecture/mesh) 跨机器挂载。能力位于 **proxy** 机器上，挂载到 **parent primary**，调用方 agent 连接的是 parent。两处各有分工：**审批请求在 parent 的 admin 中等待批准**，**任务在 proxy 的沙箱中执行**，Claude Code 就在这台 proxy 机器上。每台主机各自保留所执行任务的审计记录。

[`mesh-security-audit/cloud` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit) 对这种部署方式做过端到端验证，验证的是 **`codex.run`**，不是 `claudecode.run`。云端 agent 通过 mesh 调用 Mac workload 上的 Codex，每次调用都先等待批准，再在沙箱限制内执行。各主机分别保留审计记录；撤销授权后，后续调用会被拒绝。

::: warning 诚实的状态
`claudecode.run` 与 `codex.run` 的跨机器调用路径**结构完全相同**：注册、每次调用的待批准流程、响应与审计分离，以及 mesh 转发，使用的都是同一套机制。**`codex.run`** 版本已在 `mesh-security-audit` 中完成端到端验证。`claudecode.run` 走同一条路径，但它自己的测试只有**本地 record-mode 单元测试**，没有针对 Claude Code 这项能力单独跑过跨机器端到端测试。因此，`claudecode.run` 的 mesh 路径可以说采用了 Codex 已验证的机制，但不能据此说它已经独立通过端到端验证。
:::

## Real launch：从记录调用切换到实际执行 {#real-launch-record-to-real}

record 模式是默认，因为它不花一个 token 就把整条信任链证明了。当你真想让 worker *去写代码*时，owner
显式开启：

- 在 console 里：**What I expose → Claude Code → Real launch**，或
- 给网关设 `PLEXUS_CC_HEADLESS_LAUNCH=1`。

启用 Real launch 后，获批调用会以无界面模式启动 Claude Code，沿用其原生沙箱，写入范围限于获授权的目录。响应返回 `launched: true`、`output` 和 `exitCode`，取代记录模式的 `reason`。这会**实际运行 Claude Code 并消耗模型额度**。该功能默认关闭，由所有者单独决定是否开启；每次运行仍须通过授权检查，默认逐次审批，除非所有者在连接时已明确为这项执行能力启用持续授权。

## 往后走

**一台机器上的多个执行代理：后续计划。** 下一步的设想是将 Opus 入口和 Sonnet 入口作为两项独立能力暴露，调用方通过能力 ID 选择执行代理，所有者分别控制各项能力的授权。**目前还没有这项功能。** 当前没有 `claudecode` 类型适配器，`claudecode.run` 也不接受模型参数；它的命令行参数是 `claude -p <prompt>` 加上 CC 的权限绕过标志，不含 `--model`。要实现这一方案，需要增加 `claudecode` 类型适配器，类似现有的 `workspace-dir` 适配器；还需要修改 launcher/entries，让模型参数传递到启动命令中，以便使用 `claude --model`。在此之前，每台机器只支持一个入口。

**面向团队的资源池。** 扩展到团队规模时，仍然沿用每次使用都要批准的方式：由一个常驻的中立网关作为入口，后面接入多个执行端，组成资源池，供编排器调用。这是未来的发展方向，也是 [联邦 mesh](/zh/architecture/mesh) 要支持的企业形态。现有的 parent-primary + dial-out-proxy 机制如何支撑这样的安排，可参看 [`mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit) 示例。

---

这里沿用[信任闭环](/zh/guide/run-it)中的登记、审批、审计和撤销流程。能力从读取文件变成了运行编码代理，执行默认仍需逐次审批；只有所有者明确选择启用持续授权，才能放宽这一限制。完整规则见[连接一个 agent](/zh/guide/connect-an-agent)和[安全模型](/zh/architecture/security-model)。
