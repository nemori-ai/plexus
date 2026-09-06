<a id="plexus-—-developer-guide"></a>

# Plexus — 开发者指南

[English](./README.md) · [中文](./README.zh-CN.md)
Plexus 是由用户自行安装、在本地运行的能力网关。你把自己的部分本地能力开放出来，比如读取 Obsidian vault、访问工作目录、使用 Apple Calendar、运行 Claude Code，AI agent 再通过 Plexus 调用它们，不必拿到原始密钥或文件系统访问权。Plexus 守的是资源所有者这一侧：默认拒绝访问，区分每个 agent 的身份，留下审计记录。agent 想做什么，需要向网关申请，不能自行决定自己有权做。

这份文档从这里开始，带你从零运行 Plexus，再按各部分的依赖关系，从核心概念读到整个系统。阅读时要分清两个角色。管理者（admin）就是你，也就是所有者，负责开放能力、连接 agent、批准授权；你持有管理凭据 `connection-key`，它也是管理权限的信任边界。agent 是发现和调用能力的 AI 工具，只持有自己的独立凭据 PAT，绝不能持有 `connection-key`。

<a id="the-idea-in-60-seconds"></a>

## 用一分钟理解 Plexus
一项能力（capability）就是一个有名字、范围明确的动作，比如 `obsidian.vault.read`、`workspace.write`、`claudecode.run`。每项能力都有动词类别，分为 read、write、execute，也有相应的敏感度。

这里最需要分清的是：开放不等于授权。Plexus 的一切访问都默认拒绝（default-deny）。你开放某项能力，只是让它可以被发现，没有因此授予调用权限；每份授权仍须由人批准。给 agent 选定能力子集，也不等于允许它调用其中的每一项。开放状态还是一道独立限制：关闭能力后，它便不能被发现或获得授权，即使已有有效授权，调用也会被拒绝。

agent 可以先读取公开的 `.well-known/plexus` 入口，了解网关身份、端点、请求格式和注册方式。这个入口不会公开凭据，也不会列出完整的 agent 专属能力清单。agent 用一次性注册码换取自己的 PAT，再通过 PAT 认证的 handshake 绑定真实身份，取得 session 和专属 manifest。清单只包含所有者为它选定、且仍处于开放状态的能力。拿到清单之后，获取限定范围的授权与 token、实际发起调用，仍是不同的步骤。不装插件也能通过 HTTP Floor 完成这些操作。

连接时，选中的 read 能力会获得常驻授权（standing）；有副作用的 write / execute 能力则默认按次授权（per-use），每次使用单独批准。若已有符合条件的常驻授权，调用就不必再次询问所有者。要把某项 write 或 execute 改为常驻，必须由所有者针对该 agent 的具体能力明确操作：连接时可以开启带警告、默认关闭的选项，这是 execute 获得常驻授权的唯一途径（ADR-023），agent 不能靠自己的请求突破这个限制。对于 write，所有者还可以在批准待处理请求时给出实际的信任窗口，或直接授予常驻授权。默认流程不会让不熟悉这些区别的人意外给出常驻写入或执行权限。

对于 Claude Code 这类有原生集成方式的 agent，Plexus 会编译出专属插件，把同一个 Floor 上的能力转换成它习惯的使用方式。插件只是这一接口的投影，也是缓存和捷径；Floor 始终是事实依据，插件不能替代它。即使缓存中的说明过时，权限仍由网关执行检查。

这些概念的完整解释在 `docs/concepts.md`。

<a id="from-zero-—-get-it-running"></a>

## 从零开始，先跑起来
权限的区别，跑一次就容易看清。完整操作见 [快速上手](./getting-started.md)：安装、启动网关、开放一个 source、连接第一个 agent，再看一次真实调用怎样获得批准。先安装并启动：

```bash
bun install
bun run start --vault ~/my-vault        # gateway on 127.0.0.1:7077, console at /admin
```

网关会在本机回环地址 `127.0.0.1:7077` 上运行。打开控制台 `http://127.0.0.1:7077/admin`，选择「Connect an agent」，给 agent 起名，选好起始能力集，再复制控制台给出的安装命令并执行。接入只需这些操作，不用手动粘贴密钥。

---

<a id="how-an-agent-connects-the-shipped-flow"></a>

## agent 怎样连接：当前已实现的流程
下面是 agent 实际走过的连接过程，每一步都有对应实现。

1. 管理者连接 agent。在控制台向导中操作，或调用 `POST /admin/api/agents/connect`，为 agent 命名，声明它的授权能力子集，并生成一次性注册码 `plx_enroll_…`。注册码只能使用一次，有效期约 15 分钟。

   选定子集，会把其中的能力纳入这个 agent 的有效授权范围，不代表其中每一项都已获准调用。连接时，选中的 read 能力会得到 standing 授权；有副作用的 write / execute 能力默认仍按次授权。所有者可以明确为某个 agent 的具体能力授予 standing：execute 必须由所有者主动开启，agent 不能通过自己的请求突破这一限制；write 还可以在所有者批准待处理请求、给出实际信任窗口时成为 standing，或通过显式直接授权获得 standing。符合条件且仍有效的所有者常驻授权，也能把选定子集之外的能力纳入有效授权范围。已有符合条件的常驻授权时，不必再次询问所有者。

2. 执行一条命令完成安装。`GET /integration/:agentId` 提供可复制的命令，背后使用公开的 `install.sh`。安装过程会生成这个 agent 专属的 Claude Code 插件，用注册码换取它自己的长期 PAT（`plx_agent_…`），以 `0600` 权限保存 PAT，然后删除注册码。注册码负责这一次接入，之后调用所用的凭据是 PAT。

3. agent 通过随插件提供的启动器 `plexus-<agentId>` 发起调用：

   ```bash
   plexus-<agentId> list                      # discover: what you can call now + what needs approval
   plexus-<agentId> obsidian.vault.read Welcome.md
   ```

   `list` 用来发现能力，区分现在可以调用的能力与仍需批准的能力；第二条命令则实际请求读取 `Welcome.md`。

   启动器的版本彼此隔离：它执行自己随包携带的引擎，绝不调用全局 `plexus`。凭据也由它处理。经过 PAT 认证的 handshake 会绑定 agent 的真实身份，返回 session，以及按该 agent 的有效授权范围和开放状态过滤后的 manifest。有效授权范围包括所有者选定的能力，以及所有者为该 agent 创建、未过期且通过当前 `connection-key` epoch 校验的有效常驻授权所涵盖的能力。获取限定范围的 grant / token 是另外一步，拿到清单并不等于拿到调用许可。

   对使用这套编译集成的 agent 来说，这条命令就是完整且唯一的接口。它不自行拼写 HTTP 请求，不手动处理 enrollment / handshake，也不猜认证方式。如果命令无法完成某项操作，agent 不能把这当作获准换条路绕过接口；应询问用户，或申请所需授权。这条规则约束的是编译集成的使用方式，独立 HTTP 客户端仍可直接使用 Floor，无须安装插件。

安装过程中，agent 拿到的是自己的 PAT。管理者手里的 `connection-key` 则用于管理，不能交给 agent 充当调用凭据。两者的持有者、用途和撤销范围都不同：

| 凭据 | 由谁持有 | 用途与撤销范围 | 如何取得 |
|---|---|---|---|
| connection-key `plx_live_…` | 管理者 | 管理凭据，也是信任边界；轮换 ⇒ 全部撤销 | 网关会打印；也可从 `~/.plexus/connection-key` 读取 |
| per-agent PAT `plx_agent_…` | 每个 agent 各自持有 | 该 agent 的长期调用凭据，可以独立撤销 | 用一次性注册码兑换一次 |

需要停止某个 agent 的访问时，可以单独撤销它的 PAT。轮换管理密钥触及的是整个信任边界，不能把两种操作混用。

权威说明见 [安全模型](./design/security-model.md)。

<a id="reading-path-—-from-first-principles-to-the-whole-system"></a>

## 阅读顺序：从基本概念到整个系统
按下面的顺序读。每一篇都会用到前一篇已经讲清的词，先读懂它们，后面的机制就容易理解。

1. [核心概念](./concepts.md)先讲各部分怎样连起来：Connector → Source → Capability，来源（provenance）、敏感度（sensitivity），以及各自计时的 token、session 和 grant。再看能力开放这一道关口、自描述的 Floor，以及编译怎样把它投影成集成。这篇建立的是后续文档共用的理解方式，值得先完整读一遍。
2. [架构](./design/architecture.md)把整个系统放在一页里：四个平面、运行时主干、三个扩展方向，以及必须一直成立的不变量清单。每一层叫什么、处在什么位置，都能在这里找到；要继续追某一部分的设计，也有指向其唯一权威文档的入口。
3. [安全模型](./design/security-model.md)讲信任、认证与授权，也是凭据规则的唯一权威依据。它区分管理者的 `connection-key` 与每个 agent 各自的 PAT，说明 enrollment，以及 PAT 认证怎样绑定真实的 `agentId`。execute 默认使用 `once` 授权（ADR-5）；所有者明确开启常驻授权的例外见 ADR-023。后续的 task tickets、企业归因和可插拔策略仍是设计方向，它们的扩展接口已在[授权可扩展性](./design/authz-extensibility.md)中确定（ADR-020）。
4. mesh 让 Plexus 通过一个 primary 联合多台机器。当前的单一 primary 拓扑已经交付，更深层或嵌套的拓扑仍待后续扩展。理解现有实现，可以接着读：
   - [联邦 mesh 领域模型](./design/federated-mesh-domain-model.md)：先统一术语，划清限界上下文，列出各部分必须遵守的不变量。
   - [mesh 模型与实现](./design/mesh-model.md)：把同一套模型对应到实际执行约束的代码，给出文件与行号（file:line）。想知道它到底怎样工作，这篇最直接。
   - 子系统的细节分别见[网络与韧性](./design/networking-resilience.md)、[mesh 健康状态报告](./design/mesh-health-reporting.md)、[Linux 隔离约束](./design/linux-confinement.md)和[能力设备](./design/capability-appliance.md)。
5. [agent 技能编译领域模型](./design/agent-skill-compile-domain-model.md)讲自动完成集成的 agent：管理者授予的能力集（cap-set），怎样在 Floor 之上编译成每个 agent 的专属插件。要看产物具体应当包含什么，再读[插件产物规范](./design/cc-plugin-artifact-spec.md)。
6. [协议契约](./protocol/PLEXUS-PROTOCOL.md)规定线上交互：有哪些端点，enroll → handshake → grant → invoke 的完整循环怎样衔接，以及已经冻结的类型。需要落实客户端与网关之间的请求和响应时，到这里查。
7. 编写扩展时，先读[扩展编写指南](./extension-authoring.md)。这是对外提供、可跟着操作的指南；[扩展规范](./extensions/EXTENSION-SPEC.md)则规定扩展必须遵守的要求，查规范以它为准。

动手练习有三篇教程：[连接 agent](./tutorials/connect-an-agent.md) · [创建扩展](./tutorials/create-an-extension.md) · [第一方来源](./tutorials/first-party-sources.md)。

随用随查的资料还有：[安全说明](./security.md)用较易读的方式解释威胁模型，具体规则以安全模型文档为准；[来源管理](./sources/MANAGING-SOURCES.md)供管理 source 时查阅；[已知限制](./KNOWN-LIMITATIONS.md)记录哪些行为已经验证，哪些仍待验证或完成，核对实现状态时看这里。

---

<a id="where-the-code-lives"></a>

## 代码在哪里
| 路径 | 负责什么 |
|---|---|
| `packages/runtime/` | 网关的运行时实现：HTTP 服务器、能力注册表、授权、agent 注册接入、来源管理，以及集成与编译所用的渲染器（`src/integration/`）。 |
| `packages/web-admin/` | 用 React 编写的管理控制台，通过 `/admin` 提供访问。 |
| `packages/protocol/` | 已冻结的协议类型；线上协议契约以这里的类型定义为准。 |
| `tools/plexus-cli/plexus` | 零依赖的 agent 引擎，负责 `enroll`、`list` 和 `invoke`。为每个 agent 编译的插件都会把这套引擎一并打包进去。 |
| `integrations/` | 基于 `AGENTS.md` 的 Codex 集成放在这里；Claude Code 集成由网关为每个 agent 单独编译。 |
| `examples/` | 可运行的示例：`min-agent`、`mesh-demo`、`mesh-security-audit`、`appliance`、`home-gateway`。 |

要基于 Plexus 开发，先启动网关，再读 [`concepts.md`](./concepts.md)，弄清各部分怎样配合。

要修改 Plexus 本身、参与实现，先读[贡献指南](../CONTRIBUTING.md)。其中说明了 monorepo 的目录布局、提交改动需要通过的构建与测试检查，以及协议只能增补的规则。
