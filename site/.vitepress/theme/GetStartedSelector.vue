<script setup lang="ts">
import { ref, computed } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

// Two decisions: which machine the gateway runs on, and how far it's reachable.
type Machine = "mac" | "linux";
type Reach = "local" | "lan" | "tunnel";

const machine = ref<Machine>("mac");
const reach = ref<Reach>("local");

const REPO = "https://github.com/nemori-ai/plexus";

// ── the two segmented controls ────────────────────────────────────────────────
const machineOpts = computed(() => [
  { v: "mac", label: zh.value ? "这台 Mac" : "This Mac", sub: zh.value ? "macOS" : "macOS" },
  { v: "linux", label: zh.value ? "远程 Linux" : "Remote Linux", sub: zh.value ? "无头服务器" : "headless server" },
]);
const reachOpts = computed(() => [
  { v: "local", label: zh.value ? "仅本机" : "Localhost only", sub: "127.0.0.1" },
  { v: "lan", label: zh.value ? "局域网" : "Your LAN", sub: zh.value ? "同网设备" : "same network" },
  { v: "tunnel", label: zh.value ? "公网隧道" : "Public tunnel", sub: "Cloudflare" },
]);

// ── which cells have a verified, deep walkthrough ─────────────────────────────
const cell = computed(() => `${machine.value}/${reach.value}`);
const VERIFIED = new Set(["mac/local", "mac/tunnel", "linux/tunnel"]);
const verified = computed(() => VERIFIED.has(cell.value));

// ── the generated Agent prompt (paste-into-your-agent) ────────────────────────
const prompt = computed(() => {
  if (cell.value === "mac/tunnel") {
    return zh.value
      ? `帮我把这台 Mac 上的 Plexus 网关通过隧道发布出去，让在另一台机器上运行的你也能调用这里的能力。访问只经过网关这一道受管、默认拒绝、全程审计的边界，我不用把原始密钥或 shell 交给你。

现在就动手。按顺序、幂等地做，确保可以安全重跑。每一步都用大白话讲清楚，让我边看边懂 Plexus 怎么工作。需要我决定域名、文件夹，或在 Plexus 控制台点 Approve 时，停下来问我，等我决定或批准后再继续，不能擅自越过。

在这台 Mac 上：

1. clone ${REPO}，已有仓库就 cd 进去，先读 \`examples/home-gateway/README.md\`。
2. 按文档用 named tunnel，把网关发布到我自己域名下的一个 hostname。把你自己作为 agent 接入：用一次性注册码兑换你自己的 per-agent PAT，再用 PAT 认证握手，绝不能用我的 admin connection-key。握手返回 session 和我选定且已暴露的能力子集，不代表你已经能调用。调用前还要另行取得限定范围的授权和 scoped token。完成后，打印一条供另一台机器安装的命令。
3. 把这条命令交给我，让我粘到另一台机器上。随后演示一次读、一次写：读选用已有常驻授权的能力，取得 scoped token 后直接调用；写选用按次审批的能力，让请求在 Plexus 控制台挂起，等我点 Approve 后再执行。

写和执行默认逐次等我批准。已有我授权、仍有效且符合条件的常驻授权时，可以免去重复询问。执行的常驻授权必须由我明确开启；写也可以在我批准请求时设置信任窗口，或由我直接授予常驻授权。agent 不能自行放宽执行权限。

每一步结束，都回显刚做了什么、证明了什么：发现我暴露的能力，确认我为你选定的子集，再取得范围内的授权，最后调用。

最后用几行话说明两种凭据各做什么：我的 admin connection-key 用于管理，你的 PAT 用于认证身份，调用另需 scoped token。再解释写和执行为什么默认挂起等我批准、什么情况下不必重复批准，以及撤销你的 agent 如何切断你的访问。`
      : `You're helping me publish this Mac's **Plexus** gateway over a tunnel so that *you* — running on a different machine — can reach the tools on my Mac, only through a governed, default-deny, fully-audited boundary, instead of me handing you a raw key or a shell.

Do this now. Work **in order and idempotently** (safe to re-run), and **narrate each step in plain language** so I follow along and learn how Plexus works as you go. Whenever a step needs my **decision** (a hostname, a folder) or my **approval** (clicking Approve in the Plexus console), **stop and ask me** — never guess past those.

On **this Mac**:

1. Clone ${REPO} (or cd into it if I already have it) and read **examples/home-gateway/README.md**.
2. Follow it to publish the gateway under a hostname on my own domain (a named tunnel), connect yourself as an agent (using your own per-agent credential — never my admin connection-key), then print the **one-command install** for my other machine.
3. Give me that command to paste on my **other machine**; then show me one read (flows) and one write (**pends for my approval** in the Plexus console).

After each step, echo what just happened and what it proves — discover what I exposed → be granted by me → call it. At the end, summarize the two credentials, why writes/execute pended for me, and how one revoke cuts you off.`;
  }

  if (cell.value === "linux/tunnel") {
    return zh.value
      ? `帮我在我的 Linux 服务器上搭好一个无头 Plexus 网关，发布到一个 hostname，让在另一台机器上运行的你能调用服务器上的工具。访问只经过网关这一道受管、默认拒绝、全程审计的边界，我不用把原始密钥或 shell 交给你。

现在就动手。按顺序、幂等地做，确保可以安全重跑，每一步都用大白话说明。需要我作决定，比如选域名，或在 Plexus 控制台点 Approve 时，停下来问我，等我决定或批准后再继续。

在 Linux 服务器上：

1. clone ${REPO}，先读 \`docs/deploy-linux.md\`。
2. 装 Bun、装依赖、构建 \`/admin\` 控制台，再用网关自己的 \`PLEXUS_HOME\` 把它起在 loopback 上。暴露平台可移植的 source：\`workspace\`、\`sysinfo\`；macOS 原生 source 和 exec source 在这里保持 inactive。
3. 把网关发布到我域名下的一个 hostname。任何能把 \`https://gw.<我的域名>\` 映射到 \`http://127.0.0.1:7077\` 的边缘服务都可以，并设置 \`PLEXUS_PUBLIC_HOSTNAME\`。把你自己作为 agent 接入：用一次性注册码兑换你自己的 per-agent PAT，再用 PAT 认证握手。握手返回 session 和我选定且已暴露的能力子集；知道有哪些能力，还不等于能调用，调用前要另行取得限定范围的授权和 scoped token。打印一条供另一台机器运行的安装命令，交给我。

每一步结束，都回显刚做了什么，以及结果证明了什么，让我能看懂从服务器启动、发布 hostname 到 agent 接入，各步是否已经完成。

最后用几行话总结两种凭据的分工：我的 admin connection-key 用于管理，你的 PAT 用于认证身份，调用另需 scoped token。说明写和执行默认按次挂起等我批准；已有仍有效且符合条件的常驻授权时，可以免去重复询问。执行的常驻授权必须由我明确开启，agent 不能自行放宽；写也可以在我批准请求时设置信任窗口，或由我直接授予常驻授权。再解释撤销你的 agent 如何阻止你继续以这个身份访问网关，别把撤销某一项授权说成切断全部访问。`
      : `You're helping me stand up a headless **Plexus** gateway on my **Linux server** and publish it under a hostname, so that *you* — running on a different machine — can reach the tools on that server, only through a governed, default-deny, fully-audited boundary, instead of me handing you a raw key or a shell.

Do this now. Work **in order and idempotently**, and **narrate each step in plain language**. Whenever a step needs my **decision** (a hostname) or my **approval** (clicking Approve in the Plexus console), **stop and ask me**.

On the **Linux server**:

1. Clone ${REPO} and read **docs/deploy-linux.md**.
2. Install Bun, install deps, build the /admin console, then boot the gateway on loopback with its own PLEXUS_HOME. It exposes the platform-portable sources (workspace, sysinfo) — the macOS-native and exec sources stay inactive here.
3. Publish it under a hostname on my domain (any edge that maps https://gw.<my-domain> → http://127.0.0.1:7077; set PLEXUS_PUBLIC_HOSTNAME), connect yourself as an agent (your own per-agent credential), and print the one-command install for my other machine.

After each step, echo what happened and what it proves. At the end, summarize the two credentials, why writes/execute pend for me, and how one revoke cuts you off.`;
  }

  // mac/local — the default, learn-the-model path
  return zh.value
    ? `帮我试用 Plexus，让你作为我的 AI agent，通过它调用我 Mac 上的工具。Plexus 是本地能力网关，访问只经过这一道受管、默认拒绝、全程审计的边界，我不用把原始密钥或 shell 交给你。

现在就装好并跑起来。按顺序、幂等地做，确保可以安全重跑。每一步都用大白话讲清楚，让我边看边懂 Plexus 怎么工作。需要我作决定，或在 Plexus 控制台点 Approve 时，停下来问我，等我决定或批准后再继续，不能擅自越过。

1. clone ${REPO}，如果我已经有了仓库，就 cd 进去，先读 \`docs/getting-started.md\`。
2. 完成安装，把网关起在 loopback 上，打开 \`/admin\` 控制台。运行内置 onboarding，暴露两个 demo 文件夹：开放的 \`demo-intro\` 和受保护的 \`your-secret\`。把你自己作为 agent 接入，用一次性注册码兑换你自己的 per-agent PAT，再用 PAT 认证握手，绝不能用我的 admin connection-key。握手给出 session 和我选定且已暴露的能力子集，调用前仍要另行取得限定范围的授权和 scoped token。
3. 带我走完一次读文件的流程。按这次 onboarding 的授权配置，先读 \`demo-intro\`：已有符合条件的常驻授权，取得 scoped token 后直接读。再读 \`your-secret\`：这次读取需要申请授权，请求在 Plexus 控制台挂起，等我批准。到这一步，把 Plexus 控制台的地址明确告诉我，等我点 Approve 后再继续。

最后用几行话说明刚才发生了什么：admin connection-key 是我的管理凭据，PAT 是你的身份凭据，实际调用另需 scoped token。两个文件夹的读取结果来自这次 demo 的授权配置；\`your-secret\` 的这次读需要我批准，不表示所有读取都会挂起。再解释撤销你的 agent 后，为什么你不能继续以这个身份访问网关；只撤销某一项授权，不能称为彻底切断你的访问。`
    : `You're helping me try **Plexus** — a local capability gateway that lets you (my AI agent) reach the tools on my Mac only through a governed, default-deny, fully-audited boundary, instead of me handing you a raw key or a shell.

Set it up and run it now. Work **in order and idempotently** (safe to re-run), and **narrate each step in plain language** so I follow along and learn how Plexus works as you go. Whenever a step needs my **decision** or my **approval** (clicking Approve in the Plexus console), **stop and ask me** — never guess past those.

1. Clone ${REPO} (or cd into it if I already have it) and read **docs/getting-started.md**.
2. Install, boot the gateway on loopback, and open the /admin console. Run the built-in onboarding: expose the demo — one open folder (demo-intro) and one protected folder (your-secret) — then connect yourself as an agent using your own per-agent credential (never my admin connection-key).
3. Walk me through the loop: read demo-intro (flows), then read your-secret (**pends for my approval** in the console). Point me at the console URL when something needs me.

At the end, summarize in a few lines what I just saw: the two credentials, why the protected read pended for me, and how one revoke would cut you off.`;
});

// ── the SHELL fallback (real, verified commands only — no invented one-liners) ──
const shell = computed(() => {
  if (cell.value === "mac/tunnel") {
    return zh.value
      ? `# 在 Mac 上免账号试用：获取一个用完即弃的公网 URL，已有环境中验证可跑。
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# 然后运行：  ./connect-agent.sh   （打印一条安装命令，供另一台机器上的 agent 接入）

# 也可以用自己的域名固定访问地址；稳定性和国内可达性仍取决于隧道与网络：
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<你的域名> && ./up.sh --hostname gw.<你的域名>`
      : `# Zero-account test-drive — a throwaway public URL (verified working):
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# then:  ./connect-agent.sh   (prints the one-command install for your other machine)

# Your own domain instead (stable):
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<your-domain> && ./up.sh --hostname gw.<your-domain>`;
  }

  if (cell.value === "linux/tunnel") {
    return zh.value
      ? `# 在 Linux 服务器上运行无头网关；这条部署路径已在 Docker 中做过端到端验证。
# 完整 runbook：  docs/deploy-linux.md
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
git clone ${REPO} && cd plexus && bun install
bun run --cwd packages/web-admin build        # 构建完整的 /admin 控制台
PLEXUS_HOME="$HOME/.plexus" bun run start       # 只监听 127.0.0.1
# 发布到一个 hostname：不限定边缘服务，可选任意能完成下列映射的隧道：
#   https://gw.<你的域名> → http://127.0.0.1:7077，然后用
#   PLEXUS_PUBLIC_HOSTNAME=gw.<你的域名> bun run start 重启`
      : `# On the Linux server — headless gateway, verified end-to-end in Docker.
# Full runbook:  docs/deploy-linux.md
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
git clone ${REPO} && cd plexus && bun install
bun run --cwd packages/web-admin build        # build the full /admin console in
PLEXUS_HOME="$HOME/.plexus" bun run start       # binds 127.0.0.1 only
# Publish under a hostname (edge-neutral): run any tunnel that maps
#   https://gw.<your-domain> → http://127.0.0.1:7077, then reboot with
#   PLEXUS_PUBLIC_HOSTNAME=gw.<your-domain> bun run start`;
  }

  // mac/local
  return zh.value
    ? `# 1. 启动网关和控制台，仅监听回环地址。启动后会打印你的 connection-key 和 URL。
git clone ${REPO} && cd plexus && bun install && bun run start
# 2. 打开 http://127.0.0.1:7077/admin  →  跟着 onboarding 暴露 demo、连接一个 agent
# 或者，装好依赖后用内置配置跑一遍 demo，验证示例中的完整流程：  bun run demo`
    : `# 1. Boot the gateway + console (loopback). Prints your connection-key + the URL.
git clone ${REPO} && cd plexus && bun install && bun run start
# 2. Open http://127.0.0.1:7077/admin  →  run onboarding: expose the demo, connect an agent
# Or, to just watch the whole loop prove itself with zero setup:  bun run demo`;
});

// ── the honest note shown for a degenerate cell ───────────────────────────────
const note = computed(() => {
  const en = !zh.value;
  switch (cell.value) {
    case "mac/lan":
      return en
        ? "Works — it's the **This Mac · Localhost only** setup, then you flip on LAN binding from the console's Network panel (or `~/.plexus/network.json`). The moment a LAN interface is bound, Plexus re-gates *every* admin call behind the connection-key, so a LAN peer can read nothing and change nothing. Same commands as localhost; the security model spells out exactly what that opt-in changes."
        : "可行，沿用“这台 Mac · 仅本机”的配置，命令完全相同，再从控制台的 Network 面板或 `~/.plexus/network.json` 开启 LAN 绑定。绑定后，每一次 admin 调用都要验证 connection-key。这是主人的管理凭据；agent 用自己的 PAT 认证，调用另需相应授权和 scoped token。同网设备能连到网关，不等于取得管理或调用权限。安全模型里说明了这项 opt-in 具体改变了什么。";
    case "linux/local":
      return en
        ? "Works — it's the **Remote Linux · Public tunnel** runbook minus the tunnel. Since the gateway binds loopback only, reach its console over an SSH tunnel — `ssh -L 7077:127.0.0.1:7077 user@server` — instead of a browser on the box. Everything else is identical; follow the Linux runbook."
        : "可行，照“远程 Linux · 公网隧道”那份 runbook 配置，去掉公网隧道。网关仍只绑定 loopback，要从你本机访问服务器上的控制台，就用 SSH 转发：`ssh -L 7077:127.0.0.1:7077 user@server`。浏览器开在你本机，不用在服务器上开。SSH 转发解决的是如何连到控制台，控制台的认证要求仍然适用。其余步骤完全相同，照 Linux runbook 走。";
    case "linux/lan":
      return en
        ? "Works — the **Remote Linux · Public tunnel** setup, but instead of a tunnel you bind a LAN interface from the Network panel. Same re-gating as on Mac: the moment you open the bind, the connection-key becomes the LAN trust boundary. See the Linux runbook and the security model."
        : "可行，沿用“远程 Linux · 公网隧道”的配置，去掉公网隧道，再从 Network 面板绑定一个 LAN 接口。和 Mac 一样，绑定后每一次 admin 调用都需要主人的 connection-key。能通过 LAN 连接，只说明网络可达，管理访问仍要经过认证。agent 继续用自己的 PAT 认证，取得相应授权和 scoped token 后才能调用，不使用主人的管理凭据。部署步骤见 Linux runbook，LAN 绑定对访问范围和认证要求的影响见安全模型。";
    default:
      return "";
  }
});

// ── output mode toggle + copy ─────────────────────────────────────────────────
const outMode = ref<"agent" | "shell">("agent");
const active = computed(() => (outMode.value === "agent" ? prompt.value : shell.value));
const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(active.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    /* clipboard blocked — the block is selectable as a fallback */
  }
}

const t = (en: string, z: string) => (zh.value ? z : en);
const runIt = computed(() => (zh.value ? "/zh/guide/run-it" : "/guide/run-it"));

// tiny inline markdown-ish renderer for the note (bold + inline code + the two links)
function renderNote(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/security model/gi, '<a href="/architecture/security-model">$&</a>')
    .replace(
      /Linux runbook/gi,
      '<a href="https://github.com/nemori-ai/plexus/blob/main/docs/deploy-linux.md">$&</a>',
    );
}
</script>

<template>
  <div class="gss">
    <div class="gss-head">
      <span class="gss-kicker">{{ t("Fastest start", "快速上手") }}</span>
      <h3 class="gss-title">
        {{ t("Pick where it runs and who can reach it", "网关跑在哪，谁能连到它") }}
      </h3>
      <p class="gss-lead">
        {{ t(
          "Two decisions — the machine the gateway runs on, and how far its network reaches. Pick a cell, copy the prompt, and paste it into Claude Code or Codex. It clones the repo, reads the real runbook, and sets everything up — pausing whenever it needs your decision or approval.",
          "两个决定——网关跑在哪台机器上、它的网络能到多远。选好格子，复制这段话，粘给 Claude Code 或 Codex。它会 clone 仓库，读仓库里的实际 runbook，再按步骤安装配置。需要你决定或批准时，会停下来问你，等你回应后再继续。"
        ) }}
      </p>
    </div>

    <div class="gss-rows">
      <div class="gss-row">
        <label class="gss-label">{{ t("Machine", "机器") }}</label>
        <div class="gss-seg">
          <button
            v-for="o in machineOpts" :key="o.v"
            class="gss-opt" :class="{ on: machine === o.v }"
            @click="machine = o.v as Machine"
          >
            <span class="gss-opt-label">{{ o.label }}</span>
            <span class="gss-opt-sub">{{ o.sub }}</span>
          </button>
        </div>
      </div>

      <div class="gss-row">
        <label class="gss-label">{{ t("Reach", "可达性") }}</label>
        <div class="gss-seg gss-seg-wrap">
          <button
            v-for="o in reachOpts" :key="o.v"
            class="gss-opt" :class="{ on: reach === o.v }"
            @click="reach = o.v as Reach"
          >
            <span class="gss-opt-label">{{ o.label }}</span>
            <span class="gss-opt-sub">{{ o.sub }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Verified cell: the two-tab prompt / shell output -->
    <div class="gss-out" v-if="verified">
      <div class="gss-out-head">
        <div class="gss-tabs">
          <button class="gss-tab" :class="{ on: outMode === 'agent' }" @click="outMode = 'agent'">
            {{ t("Agent prompt", "Agent 引导词") }}
          </button>
          <button class="gss-tab" :class="{ on: outMode === 'shell' }" @click="outMode = 'shell'">
            {{ t("Shell", "命令行") }}
          </button>
        </div>
        <button class="gss-copy" @click="copy">
          {{ copied ? t("Copied ✓", "已复制 ✓") : t("Copy", "复制") }}
        </button>
      </div>
      <p class="gss-out-hint">
        {{ outMode === 'agent'
          ? t("Paste this into Claude Code or Codex — it reads the real runbook and drives the setup.",
              "把这段话粘给 Claude Code 或 Codex，它会读仓库里的实际 runbook，照着完成整套配置。")
          : t("Prefer the terminal? These are real, verified commands — the console handles the point-and-click parts (connect an agent, approve).",
              "也可以用终端。这些都是实际使用、已在已有环境中验证过的命令；连接 agent、批准请求等点选操作，在控制台完成。") }}
      </p>
      <pre class="gss-prompt">{{ active }}</pre>
    </div>

    <!-- Degenerate cell: one honest note, no pretend tutorial -->
    <div class="gss-note" v-else>
      <span class="gss-note-tag">{{ t("Same model, no separate guide", "同一套模型，没有独立教程") }}</span>
      <p class="gss-note-body" v-html="renderNote(note)"></p>
    </div>

    <p class="gss-foot">
      {{ t("Next — the one thing that never changes:", "接下来，看始终不变的部分：") }}
      <a :href="runIt">{{ t("Watch the trust loop →", "看一遍信任闭环 →") }}</a>
    </p>
  </div>
</template>

<style scoped>
.gss {
  margin: 24px 0 8px;
  padding: 22px 22px 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
}
.gss-kicker {
  display: inline-block;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
.gss-title {
  margin: 6px 0 6px;
  padding: 0;
  border: 0;
  font-size: 19px;
  line-height: 1.3;
  letter-spacing: -0.01em;
}
.gss-lead {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
}
.gss-rows { display: flex; flex-direction: column; gap: 12px; }
.gss-row { display: grid; grid-template-columns: 96px 1fr; align-items: start; gap: 12px; }
.gss-label {
  padding-top: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.gss-seg { display: flex; gap: 8px; }
.gss-seg-wrap { flex-wrap: wrap; }
.gss-opt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 9px;
  background: var(--vp-c-bg);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}
.gss-opt:hover { border-color: var(--vp-c-brand-1); }
.gss-opt.on {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.gss-opt-label { font-size: 13.5px; font-weight: 600; color: var(--vp-c-text-1); }
.gss-opt-sub { font-size: 11.5px; color: var(--vp-c-text-3); }
.gss-out {
  margin-top: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
}
.gss-out-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 6px 6px;
  background: var(--vp-c-bg);
  border-bottom: 1px solid var(--vp-c-divider);
}
.gss-tabs { display: flex; gap: 2px; }
.gss-tab {
  padding: 5px 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-text-3);
  cursor: pointer;
}
.gss-tab:hover { color: var(--vp-c-text-1); }
.gss-tab.on { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.gss-out-hint {
  margin: 0;
  padding: 8px 16px 0;
  background: var(--vp-c-bg);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--vp-c-text-3);
}
.gss-copy {
  padding: 4px 12px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 7px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-bg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.gss-copy:hover { background: var(--vp-c-brand-2); border-color: var(--vp-c-brand-2); }
.gss-prompt {
  margin: 0;
  padding: 14px 16px;
  max-height: 300px;
  overflow: auto;
  background: var(--vp-c-bg);
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vp-c-text-1);
}
.gss-note {
  margin-top: 18px;
  padding: 14px 16px;
  border: 1px dashed var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.gss-note-tag {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}
.gss-note-body { margin: 0; font-size: 13px; line-height: 1.65; color: var(--vp-c-text-2); }
.gss-note-body :deep(code) {
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--vp-c-bg-soft);
}
.gss-foot { margin: 12px 0 0; font-size: 12.5px; color: var(--vp-c-text-3); }
.gss-foot a { font-weight: 600; }
@media (max-width: 640px) {
  .gss-row { grid-template-columns: 1fr; gap: 6px; }
  .gss-label { padding-top: 0; }
}
</style>
