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
      ? `你在帮我把这台 Mac 上的 **Plexus** 网关经隧道发布出去,好让*你*(在另一台机器上运行)够到我 Mac 上的能力——只经过一道受管、默认拒绝、全程审计的边界,而不是我把裸钥匙或 shell 交给你。

现在就动手。**按顺序、幂等地**做(可安全重跑),并**用大白话叙述每一步**,让我边看边搞懂 Plexus 怎么工作。任何一步需要我的**决定**(域名、文件夹)或**批准**(在 Plexus 控制台点 Approve)时,**停下来问我**,绝不擅自越过。

在**这台 Mac** 上:

1. clone ${REPO}(如果我已经有了就 cd 进去),读 **examples/home-gateway/README.md**。
2. 按它把网关发布到我自己域名的一个 hostname 下(named tunnel),把你自己作为 agent 连接(用你自己的 per-agent 凭据——绝不是我的 admin connection-key),然后打印出给我另一台机器用的**一条命令安装**。
3. 把那条命令给我,让我粘到**另一台机器**上;之后演示:一次读(直接通)+ 一次写(在 Plexus 控制台**挂起等我批准**)。

每一步之后,回显刚发生了什么、以及它证明了什么——发现我暴露的东西 → 由我授权 → 调用它。最后用几行话总结:两种凭据、为什么写/执行会为我挂起、以及一次撤销如何把你切断。`
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
      ? `你在帮我在我的 **Linux 服务器**上立起一个无头 **Plexus** 网关,并把它发布到一个 hostname 下,好让*你*(在另一台机器上运行)够到那台服务器上的工具——只经过一道受管、默认拒绝、全程审计的边界,而不是我把裸钥匙或 shell 交给你。

现在就动手。**按顺序、幂等地**做,并**用大白话叙述每一步**。任何一步需要我的**决定**(域名)或**批准**(在 Plexus 控制台点 Approve)时,**停下来问我**。

在 **Linux 服务器**上:

1. clone ${REPO},读 **docs/deploy-linux.md**。
2. 装 Bun、装依赖、构建 /admin 控制台,然后用它自己的 PLEXUS_HOME 把网关起在 loopback 上。它暴露平台可移植的 source(workspace、sysinfo)——macOS 原生 source 和 exec source 在这里保持 inactive。
3. 把它发布到我域名的一个 hostname 下(任何能把 https://gw.<我的域名> 映射到 http://127.0.0.1:7077 的边缘都行;设 PLEXUS_PUBLIC_HOSTNAME),把你自己作为 agent 连接(用你自己的 per-agent 凭据),并打印给我另一台机器用的一条命令安装。

每一步之后,回显刚发生了什么、以及它证明了什么。最后总结:两种凭据、为什么写/执行会为我挂起、以及一次撤销如何把你切断。`
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
    ? `你在帮我试用 **Plexus**——一个本地能力网关,它让你(我的 AI agent)只经过一道受管、默认拒绝、全程审计的边界去够到我 Mac 上的工具,而不是我把裸钥匙或 shell 交给你。

现在就装好并跑起来。**按顺序、幂等地**做(可安全重跑),并**用大白话叙述每一步**,让我边看边搞懂 Plexus 怎么工作。任何一步需要我的**决定**或**批准**(在 Plexus 控制台点 Approve)时,**停下来问我**,绝不擅自越过。

1. clone ${REPO}(如果我已经有了就 cd 进去),读 **docs/getting-started.md**。
2. 装好、把网关起在 loopback 上、打开 /admin 控制台。跑内置的 onboarding:暴露 demo——一个开放文件夹(demo-intro)和一个受保护文件夹(your-secret)——然后把你自己作为 agent 连接,用你自己的 per-agent 凭据(绝不是我的 admin connection-key)。
3. 带我走一遍闭环:读 demo-intro(直接通),再读 your-secret(在控制台**挂起等我批准**);需要我批准时,把 Plexus 控制台的地址指给我。

最后用几行话总结我刚看到的:两种凭据、为什么受保护的读会为我挂起、以及一次撤销如何把你彻底切断。`
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
      ? `# 零账号试驾——一个用完即弃的公网 URL(已验证可跑):
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# 然后:  ./connect-agent.sh   (打印给你另一台机器用的一条命令安装)

# 用你自己的域名(稳定,国内可用):
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<你的域名> && ./up.sh --hostname gw.<你的域名>`
      : `# Zero-account test-drive — a throwaway public URL (verified working):
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# then:  ./connect-agent.sh   (prints the one-command install for your other machine)

# Your own domain instead (stable):
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<your-domain> && ./up.sh --hostname gw.<your-domain>`;
  }

  if (cell.value === "linux/tunnel") {
    return zh.value
      ? `# 在 Linux 服务器上——无头网关,已在 Docker 里端到端验证。
# 完整 runbook:  docs/deploy-linux.md
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
git clone ${REPO} && cd plexus && bun install
bun run --cwd packages/web-admin build        # 把完整 /admin 控制台构建进去
PLEXUS_HOME="$HOME/.plexus" bun run start       # 只绑 127.0.0.1
# 发布到一个 hostname(边缘中立):跑任意隧道,把
#   https://gw.<你的域名> → http://127.0.0.1:7077,然后用
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
    ? `# 1. 启动网关 + 控制台(仅回环)。会打印你的 connection-key 和 URL。
git clone ${REPO} && cd plexus && bun install && bun run start
# 2. 打开 http://127.0.0.1:7077/admin  →  跑 onboarding:暴露 demo、连接一个 agent
# 或者,零配置直接看整套闭环自证一遍:  bun run demo`
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
        : "可行——就是 **这台 Mac · 仅本机** 那套配置,只是再从控制台的 Network 面板(或 `~/.plexus/network.json`)开启 LAN 绑定。一旦绑了 LAN 接口,Plexus 就把*每一个* admin 调用重新收到 connection-key 之后,LAN 上的设备读不到也改不了任何东西。命令和仅本机一模一样;安全模型里写清了这个 opt-in 到底改了什么。";
    case "linux/local":
      return en
        ? "Works — it's the **Remote Linux · Public tunnel** runbook minus the tunnel. Since the gateway binds loopback only, reach its console over an SSH tunnel — `ssh -L 7077:127.0.0.1:7077 user@server` — instead of a browser on the box. Everything else is identical; follow the Linux runbook."
        : "可行——就是 **远程 Linux · 公网隧道** 那份 runbook,去掉隧道。因为网关只绑 loopback,你用 SSH 隧道去够它的控制台——`ssh -L 7077:127.0.0.1:7077 user@server`——而不是在机器上开浏览器。其余一模一样;照 Linux runbook 走。";
    case "linux/lan":
      return en
        ? "Works — the **Remote Linux · Public tunnel** setup, but instead of a tunnel you bind a LAN interface from the Network panel. Same re-gating as on Mac: the moment you open the bind, the connection-key becomes the LAN trust boundary. See the Linux runbook and the security model."
        : "可行——就是 **远程 Linux · 公网隧道** 那套,只是不走隧道,而是从 Network 面板绑一个 LAN 接口。和 Mac 上一样的重新收口:一开绑,connection-key 就成了 LAN 的信任边界。参见 Linux runbook 与安全模型。";
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
      <span class="gss-kicker">{{ t("Fastest start", "最快上手") }}</span>
      <h3 class="gss-title">
        {{ t("Pick where it runs and who can reach it", "选好它跑在哪、谁能连到它") }}
      </h3>
      <p class="gss-lead">
        {{ t(
          "Two decisions — the machine the gateway runs on, and how far its network reaches. Pick a cell, copy the prompt, and paste it into Claude Code or Codex. It clones the repo, reads the real runbook, and sets everything up — pausing whenever it needs your decision or approval.",
          "两个决定——网关跑在哪台机器上、它的网络能到多远。选好格子,复制这段话,粘给 Claude Code 或 Codex。它会 clone 仓库、读真实的 runbook、把一切装好——遇到需要你决定或批准的地方就停下来问你。"
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
              "把这段粘给 Claude Code 或 Codex——它会读真实的 runbook 并驱动整套配置。")
          : t("Prefer the terminal? These are real, verified commands — the console handles the point-and-click parts (connect an agent, approve).",
              "想用终端?这些都是真实、验证过的命令——控制台负责点选部分(连接 agent、批准)。") }}
      </p>
      <pre class="gss-prompt">{{ active }}</pre>
    </div>

    <!-- Degenerate cell: one honest note, no pretend tutorial -->
    <div class="gss-note" v-else>
      <span class="gss-note-tag">{{ t("Same model, no separate guide", "同一套模型,没有独立教程") }}</span>
      <p class="gss-note-body" v-html="renderNote(note)"></p>
    </div>

    <p class="gss-foot">
      {{ t("Next — the one thing that never changes:", "接下来——那个永远不变的东西:") }}
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
