---
title: Level 2 · 从任何地方够到它
description: 把家里的 Plexus 网关发布到一个域名下，让另一台机器上的 agent 经隧道发现、enroll、调用你的 capability——读可常驻，写为你挂起，一次撤销 fail closed。
---

# Level 2 · 从任何地方够到它

**适合谁：** 你的资源在**家里**（Mac 上的笔记、文件、工具）；你的 agent 在**别处**——公司电脑上的
Claude Code、酒店 wifi 上的笔记本。这套设置把家里的网关发布到一个域名下，让那个远端 agent 能从
任何地方**发现 → enroll → 调用**你的 capability，而每一个改动性的动作仍然为*你*挂起，一次撤销就
让 agent 在各处都失效。

不需要 mesh，不需要云端算力，也没有新的信任故事：家里那台机器**就是**网关（[Level 1](/zh/guide/local)
那台），隧道只是可达性。它端到端跑自
[`examples/home-gateway`](https://github.com/nemori-ai/plexus/tree/main/examples/home-gateway)，
在真实域名上的 Cloudflare named tunnel 上验证过。

## 它怎么工作（一段话）

网关始终只绑定**回环地址**。一个边缘进程（这里是 `cloudflared`——但任何边缘都行）向**外**拨号，
把 `https://gw.<your-domain>` 映射到 `http://127.0.0.1:7901`；任何地方都不开入站端口。网关侧唯一
的开关是 **`PLEXUS_PUBLIC_HOSTNAME`**（FEAT public-hostname）：Host/Origin 守卫接受这个发布出去的
域名（以及它的 `https://` origin，所以 `/admin` 控制台也能远程用），并且该域名成为**规范广告地址**
——`.well-known`、auth 广告、一条命令的安装,全部下发远端 agent 真能够到的 URL。其余一切（默认拒绝、
PAT 身份、挂起、审计、撤销）就是 [Level 1](/zh/guide/local) 的信任模型跑在更长的线上。

## 前置条件

家里机器上要有 `bun`、`curl`、`jq`、`cloudflared`（`brew install cloudflared`）；默认（named tunnel）
模式需要一个挂在你 Cloudflare 账号上的域名。所有东西落在 `~/PlexusDemo/home-gateway`、端口 `7901`，
所以你个人的 `~/.plexus:7077` 分毫不动。

## 默认设置——用你自己域名的 named tunnel

一次性准备（一次浏览器授权，然后一个脚本），在 `examples/home-gateway/` 里：

```sh
cloudflared tunnel login             # 浏览器：选你的域名所在 zone
./setup-tunnel.sh gw.<your-domain>   # 建隧道、路由 DNS、写好 config
```

然后，每次：

```sh
./up.sh --hostname gw.<your-domain>
#   → 启动网关（公网域名已接好）、起连接器，并经真实边缘验证
#     https://gw.<your-domain>/.well-known/plexus。

./connect-agent.sh                   # admin 动作：连接 'office-cc'，给一组常驻的读能力
#   → 打印给公司机器用的一条命令安装
```

**在公司机器上**，粘贴打印出来的命令——它带一个单次使用的 `plx_enroll_…` 码（唯一会流动的秘密，
兑换一次即失效）：

```sh
curl -fsSL https://gw.<your-domain>/integration/office-cc/install.sh | PLEXUS_ENROLL_CODE="plx_enroll_…" bash
```

它会物化 per-agent 插件，把网关钉到公网 URL，并把码兑换成持久的 per-agent PAT。然后：

```sh
plexus-office-cc list                                  # 发现：可立即调用 vs 需要批准
plexus-office-cc workspace.read Welcome.md             # 常驻的读——直接就通
plexus-office-cc workspace.write --input '{"path":"office-note.md","content":"hi from the office"}'
#   → 挂起。launcher 会等着；你批准后调用才通过。
```

**从任何地方批准：** 打开 `https://gw.<your-domain>/admin`（受 connection-key 管控——密钥绝不离开
你这边），Approvals → 带一个信任窗口批准。写入落在家里的 workspace。然后是终止开关：
`./revoke-agent.sh office-cc`——公司那边的下一个调用立刻 fail closed。在 `/admin` → Activity 里审计
整条链路。

## 零账号试驾——quick tunnel

```sh
./up.sh --quick     # trycloudflare.com，随机域名，无需 CF 账号
```

同样的故事，跑在一个用完即弃的域名上。**网络现实提醒：** 很多网络——尤其中国大陆，加上一些企业
DNS——在 DNS 层过滤 `trycloudflare.com`；`up.sh` 会预检并指引你改用 named 模式，而不是把你晾在超时上。
用你自己域名的 named tunnel 不受影响——这正是它作为默认的原因。

## 自带边缘（Bring your own edge）

`PLEXUS_PUBLIC_HOSTNAME` 是**边缘中立**的——网关只需要知道它被发布在哪个域名下。任何能把
`https://<hostname>` 映射到 `http://127.0.0.1:7901` 的东西都行：VPS 上的 **frp**、
**Tailscale Funnel**（`tailscale funnel 7901`）、或一台普通的**反向代理**（Caddy/nginx）。跑起你的
边缘，然后 `PLEXUS_PUBLIC_HOSTNAME=<hostname> ./up.sh --hostname <hostname>`。

## 发布究竟暴露了什么（这段读一遍）

- `/.well-known/plexus` 变成**公开元数据**：capability 的 id + 标签（摘要——不是 schema，不是数据）。
  这是设计好的会话前层级；如果连"橱窗浏览"都嫌多，在域名前面加一层 **Cloudflare Access**（给 agent
  一个 service token，给 `/admin` 一个邮箱 OTP）——网关能干净地跑在它后面。
- **权限从不随可达性一起来。** 够到网关本身不给 agent 任何东西：enroll 需要你铸的码，调用需要你批准
  的授权，`execute` 永不搭常驻授权的便车，connection-key 是 admin 专属、不出现在任何 agent 够得到的
  路由上。
- 经公网域名访问的 `/admin` 控制台仍然受 connection-key 管控、并做 https-origin 检查；密钥只存在家里
  机器的 `$DEMO_ROOT/home/connection-key`。

## 后续步骤

- **[Level 3 · 给团队做资源池 →](/zh/guide/fleet)**——当资源属于团队、而不属于个人时。
- **[安全模型](/zh/architecture/security-model)**——信任边界，以及发布究竟暴露/不暴露什么（权威说明）。
