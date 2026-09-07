---
title: 更新日志
description: 每个 Plexus 版本带来了什么——按版本讲的产品故事。
---

# 更新日志

每个版本对「运行 Plexus 的那个人」意味着什么。线上契约单独计版本，且移动得慢得多——见[协议](/zh/protocol/)。

::: tip
打了标签的发布及其完整提交历史在 [GitHub](https://github.com/nemori-ai/plexus/releases)。
:::

## 0.9.1——够到你真正登录着的那个浏览器

`attach` 现在对你日常那个 Chrome 是有效的，同时多出第三条路。

- **正式支持 `chrome://inspect` 开关。**自 Chrome 136 起，二进制在默认 profile 上拒绝 `--remote-debugging-port`，所以那个开关是进入已登录浏览器的**唯一**路径——而它提供的暴露面与经典 flag 并不相同。两种形态现在都收在同一个连接门面之后。
- **一个 Chrome 扩展，作为第三条传输通道。**同意在**安装时给一次**，而不是每次连接都给，并且在你的常规 profile 上可用。它只是一条传输通道：allowlist、批准与审计都留在网关里——那是页面辩不动的地方。
- **点击与输入走真实输入事件。**那些无视直接 DOM 写入的自定义表单控件和富文本编辑器，现在真的能收到 agent 发出的内容；目标被别的东西盖住时，点击会被拒绝。
- 标签页在被列出之前就已过滤：一个开着 25 个标签页的浏览器里，只有已授权域名上的那些会出现。

## 0.9.0——browser control

**驱动一个真实的 Chrome。**新的 execute 级 source：导航、读取、点击、输入、截图、上传——走 DevTools Protocol，不依赖 Puppeteer 或 Playwright，也不下载浏览器。

- **所有者的决定是「给哪个浏览器」：**一个「谁也不是」的干净 profile，还是他自己登录着的那个。这才是定**爆炸半径**的东西，其余都是细节。
- **一份由你掌握的域名 allowlist**，针对真实目标 URL 校验，并在每次动作之前重新校验——因为 Chrome 自己的同意授权的是那个浏览器，不是一组站点。
- **页面暴露面是开放的**（包括任意 JavaScript 与原样透传的页面级 CDP），因为在一个 agent 本就可以触碰的页面里，click + type 已经等同于完整的用户能动性。扣住的是 CDP 属于浏览器全局的那一半——正是它让 allowlist 是真边界。
- **上传是牢笼化的**：只能来自你指定的一个目录，在你指定之前拒绝一切。

见[暴露一个 source](/zh/guide/first-party-sources#browser-control)。

## 0.8.1

- 审计会记录一次 invoke 实际用的是**哪种传输形态**。

## 0.8.0——长调用不再堵着，控制台说得更多

- **异步 invoke 句柄。**耗时数分钟的 capability 立即返回一个句柄，而不是占着连接；agent 在结果就绪时来取。
- 控制台新增 **Activity 概览条**——一眼看清最近发生了什么。
- **沙箱运行的失败输出在抵达 agent 之前会被脱敏。**
- **agent 协议加固：**拒绝信息现在自带足够的信息，让 agent 能自己纠正，不必靠猜。

## 0.7.0——首个公开发布

项目对外亮相的那个版本：信任模型定型，机器上也已经有足够真实的 source，值得接一个 agent 上来。

- **把你的个人数据做成第一方 source。**Apple Notes、Mail、Contacts、Photos 与 Shortcuts 加入 Calendar 和 Reminders，另有只读的浏览器标签页/书签/历史，以及 Obsidian 的搜索 + 追加。
- **agent 只看得见你授权的那个子集。**发现阶段不再广播目录：agent 能扫到的**就是**它的所有者授予它的；子集之外的请求直接拒绝，而不是挂起来等你盖章。
- **带副作用的 capability 默认逐次。**连接时勾选一个 `write` 或 `execute` 不再等于常驻——每次调用都要问。常驻是一个刻意的、按 capability 的 opt-in，默认关闭且需双重确认。
- **会话 fail-closed**，撤销是彻底停止，而不是延迟停止。
- **四种安装 agent 的形态**，包括面向「没有文件系统也没有 shell」的 agent 的 in-context 形态——外加把整个闭环从头走一遍的快速上手。
- **编码类 agent 使用它们自己的原生沙箱**，而不是在外面再套一层。

## 0.7 之前

一路走来，每个阶段一段话。

- **0.6.0-rc.1**——首个公开候选版：桌面 / 运行时重构、统一的授权与信任模型、建立在 Connector → Source → Capability 之上的 *What I expose* 视图、首批 Apple source，以及按 source 的 health。
- **0.4.0**——capability source 变成**受管的**：在控制台或 CLI 里实时添加、启用、重配、移除，不用 flag 也不用重启。重配一个 source 的安全面会清空它的授权。
- **0.3.x**——Claude Code 与 Codex 集成，让主流编码 agent 真的能用上 Plexus 暴露的东西；Obsidian 经由它自己的 Local REST API 实现读**写**。
- **0.2.x**——扩展生态：公开的 manifest 规范、用户自己写的 skill 与 workflow，以及一次能把你从安装带到「接上一个 agent」的 macOS 首次运行。
- **0.1.x**——网关本身、M0 协议契约，以及后面一切所依赖的那个决定：**默认由人在环中授权**，因此 agent 永远无法给自己授予一次 write 或 execute。
