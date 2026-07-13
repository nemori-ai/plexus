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

调用方用 `list` 发现自己的 surface，与[信任闭环](/zh/guide/run-it)里一样。execute capability 显示为
**needs-approval**——它默认不会被预先授予：

```text
  ○ claudecode.run — Run Claude Code (sandboxed) (execute)  [first-party, elevated]
      Launch headless Claude Code to do REAL coding work ... sandboxed to ONE authorized
      directory: it does its work there and cannot create or modify files outside it ... you only
      pass a `{ prompt }` ... This is a SENSITIVE execute capability: it PENDS for the owner's
      approval before it runs — issue the call and WAIT.
```

调用本身每次都挂起，等 owner 批准后落定，然后返回：

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

owner 的**审计**里留着完整姿态：

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

同一趟调用，两种投影。agent 拿到行动所需的最小结果；owner 留着 jail 路径、约束机制、拼好的
argv——这趟跑确实被关进笼子的证据。哪怕在这里，prompt 文本也被 mask 成 `«prompt»`，
所以审计记下的是*有一趟跑发生过*、以及*它是怎么被关进笼子的*，而不留下原样的指令。这个切分——线上薄、
审计全——正是你能把执行暴露给一个陌生 agent、却不把机器一并暴露给它的原因。

## 跨机器——两条路

上面这一切都发生在一台机器上。要让**另一台**机器上的 agent 调用 `claudecode.run`，你需要可达性，
Plexus 给两种形状。两条路的信任模型完全一致；变的只是*挂起在哪里触发*、*沙箱在哪里跑*。

### 单机跨隧道——`publicHostname`

A 机就是 agent 要连的那台。你把 A 的网关发布到一个 hostname 下（`PLEXUS_PUBLIC_HOSTNAME`），远端
agent 就在这根更长的线上 enroll、调用。这个开关**只加可达性**——信任模型不挪窝：挂起在 A 触发，沙箱
跑在 A，审计留在 A。[`home-gateway` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)
是这条路已验证的菜谱（一条真的 Cloudflare named tunnel，install → enroll → 常驻读 → 挂起的写 →
批准 → 撤销后 fail-closed）。它演示的挂起是 `workspace.write` 上的；`claudecode.run` 走的是同一条
路，只是上头多压了一层 execute 逐次批准的天花板。

### 多机——联邦 mesh

当 coding agent 与 orchestrator 不在同一台机器上时，capability 经 [mesh](/zh/architecture/mesh)
挂载过去。cap 坐在一台 **proxy** 机上，mount 到一台 **parent primary**；agent 跟 parent 说话。这时两
半干净地分开了：**挂起在 parent 的 admin 触发**，**沙箱跑在 proxy 那台**——真正拥有那份 Claude Code
的机器。每台主机各留一份自己跑过什么的审计。

[`mesh-security-audit/cloud` 示例](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)
把这条路端到端验证过了——但用的是 **`codex.run`**，不是 `claudecode.run`：一个 cloud agent 经 mesh 够
到一台 Mac workload 上的 Codex，沙箱 jail、逐次挂起、per-host 审计、撤销后 fail-closed。

::: warning 诚实的状态
`claudecode.run` 的跨机器路径与 `codex.run` 的**结构完全相同**——一样的 enroll、一样的逐次挂起、
一样的 wire/audit 切分、一样的 mesh 转发。端到端验证过的是 **`codex.run`** 那版（在
`mesh-security-audit` 里）。`claudecode.run` 走的是同一条路，但它自己的测试是**本地 record 模式的单
测**——针对 Claude Code capability 本身，并没有单独跑过跨机器的端到端验证。请把 `claudecode.run` 的
mesh 路径当作"codex 已证明的同一套机制"，而不是"已被独立 e2e 验证"。
:::

## Real launch——从 record 切到真跑 {#real-launch-record-to-real}

record 模式是默认，因为它不花一个 token 就把整条信任链证明了。当你真想让 worker *去写代码*时，owner
显式开启：

- 在 console 里：**What I expose → Claude Code → Real launch**，或
- 给网关设 `PLEXUS_CC_HEADLESS_LAUNCH=1`。

开了 real launch，同一趟批准过的调用会在 Claude Code 自带的那个原生沙箱下拉起一个 headless Claude
Code（写入限制在授权目录内），响应里带的是真的 `launched: true`、`output`、`exitCode`，而不再是
record 模式那句 `reason`。这会
**真跑 Claude Code，真烧模型额度**——它是一个 owner 决定，默认关闭，而且每一趟依旧要过同一道授权门
（默认逐次，除非你在连接时为这项 execute opt-in 了常驻）。

## 往后走

**一台机器，多个 worker——一个 roadmap。** 显而易见的下一步，是把 Opus 入口和 Sonnet 入口暴露成两个
不同的 capability，调用方按 capability id 挑 worker，你对每个入口单独把门。**这个能力现在还不存在。**
今天没有 `claudecode` kind adapter，`claudecode.run` 也不吃 model 参数——它的 argv 是
`claude -p <prompt>` 外加 CC 的 permission-bypass flags，仍然不带 `--model`。要做到这一步，需要 (a) 一个 `claudecode` kind adapter（类比
`workspace-dir` 那个），以及 (b) 把 model 参数穿过 launcher/entries，让它注入 `claude --model`。在
那之前，每台机器一个入口。

**给团队做池子。** 同一套逐次批准的模式，前面立一个常驻的中立网关、后面挂多个 worker，就是团队规模的
方向——一个 orchestrator 从里面取用的资源池。这正是[联邦 mesh](/zh/architecture/mesh)朝着造的企业形
状；parent-primary + 向外拨号的 proxy 那套机制怎么已经把它扛起来，见
[`mesh-security-audit/cloud`](https://github.com/nemori-ai/plexus/tree/main/examples/mesh-security-audit)
示例。

---

这一切底下的机制，就是你已经熟的[信任闭环](/zh/guide/run-it)——enroll、逐次批准、审计、撤销。变的
只有被调用的 capability：从读一个文件，换成跑一个 coding agent——这正是为什么这道门问个不停。另见
[连接一个 agent](/zh/guide/connect-an-agent) 与[安全模型](/zh/architecture/security-model)，那里有
execute 默认逐次（需拥有者显式开启才可常驻）规则的完整版。
