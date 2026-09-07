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
      ? `你要帮我把这台 Mac 上的 **Plexus** 网关通过隧道发布出去，让在另一台机器上运行的*你*能够访问我 Mac 上的工具。访问必须经过受管控、默认拒绝、全程审计的边界，而不是由我直接把访问密钥或 shell 交给你。

现在就开始。**按顺序操作，并保证幂等**（可安全重复运行），同时**用通俗的话讲清每一步**，让我跟得上，也能边看边了解 Plexus 如何工作。只要某一步需要我**做决定**（选主机名、文件夹）或**批准**（在 Plexus 控制台点击 Approve），就**停下来问我**，绝不要自行猜测后继续。

在**这台 Mac** 上：

1. 克隆 ${REPO}（如果已经有了，就用 cd 进入仓库），并阅读 **examples/home-gateway/README.md**。
2. 按文档通过命名隧道，将网关发布到我自有域名下的一个主机名。以 agent 身份连接，使用你自己的 agent 专属凭据，绝不要用我的管理员 connection-key。然后输出**一条即可完成安装的命令**，供我的另一台机器使用。
3. 把这条命令交给我，让我粘贴到**另一台机器**上；然后演示一次读取（直接通过）和一次写入（**等待我在 Plexus 控制台批准**）。

每一步结束后，说清刚才做了什么，又验证了什么：发现我开放的能力 → 获得我的授权 → 调用。最后概括两种凭据、写入和执行为什么需要等待我批准，以及一次撤销如何切断你的访问。`
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
      ? `你要帮我在 **Linux 服务器**上搭建一个无头 **Plexus** 网关，并将它发布到一个主机名，让在另一台机器上运行的*你*能够访问服务器上的工具。访问必须经过受管控、默认拒绝、全程审计的边界，而不是由我直接把访问密钥或 shell 交给你。

现在就开始。**按顺序操作，并保证幂等**，同时**用通俗的话讲清每一步**。只要某一步需要我**做决定**（选主机名）或**批准**（在 Plexus 控制台点击 Approve），就**停下来问我**。

在 **Linux 服务器**上：

1. 克隆 ${REPO}并阅读 **docs/deploy-linux.md**。
2. 安装 Bun 和依赖，构建 /admin 控制台，然后用独立的 PLEXUS_HOME 在回环地址上启动网关。它会暴露可跨平台使用的源（workspace、sysinfo）；macOS 原生源和 exec 源在这里保持停用。
3. 用我域名下的主机名发布网关（可用任意能实现 https://gw.<我的域名> → http://127.0.0.1:7077 映射的边缘服务；设置 PLEXUS_PUBLIC_HOSTNAME），再用你自己的 Agent 专属凭证接入，输出供我在另一台机器上使用的一行安装命令。

每完成一步，说清刚才做了什么，以及这证明了什么。最后概括两种凭证、写入和执行为什么会等待我批准，以及一次撤销如何切断你的访问。`
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
    ? `你要帮我试用 **Plexus**。这是一个本地能力网关，让你（我的 AI agent）能够访问我 Mac 上的工具。访问必须经过受管控、默认拒绝、全程审计的边界，而不是由我直接把访问密钥或 shell 交给你。

现在就把它装好并运行起来。**按顺序操作，并保证幂等**（可安全重复运行），同时**用通俗的话讲清每一步**，让我跟得上，也能边看边了解 Plexus 如何工作。只要某一步需要我**做决定**或**批准**（在 Plexus 控制台点击 Approve），就**停下来问我**，绝不要自行猜测后继续。

1. 克隆 ${REPO}（如果已经有了，就用 cd 进入仓库），并阅读 **docs/getting-started.md**。
2. 完成安装，在回环地址上启动网关，并打开 /admin 控制台。运行内置的入门引导，开放演示用的两个文件夹：一个公开文件夹（demo-intro）和一个受保护文件夹（your-secret）。然后以 agent 身份连接，使用你自己的 agent 专属凭据，绝不要用我的管理员 connection-key。
3. 带我走一遍流程：先读取 demo-intro（直接通过），再读取 your-secret（**等待我在控制台批准**）。需要我操作时，把控制台 URL 给我。

最后用几行话概括我刚才看到的过程：两种凭据、刚才读取受保护文件夹为什么需要等待我批准，以及一次撤销如何切断你的访问。`
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
      ? `# 无需账号即可通过临时公共 URL 试用（已验证可用）：
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# 然后：  ./connect-agent.sh   （打印出一条安装命令，供你在另一台机器上运行）

# 也可以改用自己的域名（稳定）：
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<你的域名> && ./up.sh --hostname gw.<你的域名>`
      : `# Zero-account test-drive — a throwaway public URL (verified working):
git clone ${REPO} && cd plexus/examples/home-gateway && ./up.sh --quick
# then:  ./connect-agent.sh   (prints the one-command install for your other machine)

# Your own domain instead (stable):
#   cloudflared tunnel login && ./setup-tunnel.sh gw.<your-domain> && ./up.sh --hostname gw.<your-domain>`;
  }

  if (cell.value === "linux/tunnel") {
    return zh.value
      ? `# 在 Linux 服务器上运行无图形界面的网关，完整流程已在 Docker 中验证。
# 完整操作指南：  docs/deploy-linux.md
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
git clone ${REPO} && cd plexus && bun install
bun run --cwd packages/web-admin build        # 构建完整的 /admin 控制台
PLEXUS_HOME="$HOME/.plexus" bun run start       # 仅绑定 127.0.0.1
# 通过域名对外访问（不依赖特定隧道或 CDN 服务商）：使用任意隧道，按以下地址转发请求
#   https://gw.<你的域名> → http://127.0.0.1:7077，再用以下命令重启：
#   PLEXUS_PUBLIC_HOSTNAME=gw.<你的域名> bun run start`
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
# 2. 打开 http://127.0.0.1:7077/admin  →  按引导开放演示访问，连接智能体
# 或者，无需配置，直接运行演示，验证完整流程：  bun run demo`
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
        : "可以使用。先按 **这台 Mac · 仅限本机访问** 的说明完成设置，再通过控制台的 Network 面板或 `~/.plexus/network.json`，将网关绑定到 LAN 接口。一旦绑定 LAN 接口，Plexus 就会重新要求*每一次*管理调用都通过 connection-key 认证。局域网中的其他设备没有这个密钥，就无法读取或更改任何内容。命令与 localhost 配置相同；主动启用 LAN 绑定会带来哪些变化，security model 中有详细说明。";
    case "linux/local":
      return en
        ? "Works — it's the **Remote Linux · Public tunnel** runbook minus the tunnel. Since the gateway binds loopback only, reach its console over an SSH tunnel — `ssh -L 7077:127.0.0.1:7077 user@server` — instead of a browser on the box. Everything else is identical; follow the Linux runbook."
        : "可以使用。按 **远程 Linux · 公网隧道** 操作指南设置，省去公共隧道即可。网关只绑定回环地址，因此请运行 `ssh -L 7077:127.0.0.1:7077 user@server`，通过 SSH 隧道访问控制台，无需在服务器上打开浏览器。其余设置不变，按 Linux 操作指南执行。";
    case "linux/lan":
      return en
        ? "Works — the **Remote Linux · Public tunnel** setup, but instead of a tunnel you bind a LAN interface from the Network panel. Same re-gating as on Mac: the moment you open the bind, the connection-key becomes the LAN trust boundary. See the Linux runbook and the security model."
        : "可以使用。按 **远程 Linux · 公网隧道** 的说明完成设置，但不启用隧道，而是通过 Network 面板将网关绑定到 LAN 接口。认证要求与 Mac 上相同：一旦绑定 LAN 接口，所有管理访问就都必须通过 connection-key 认证，局域网中的设备也不例外。具体参见 Linux runbook 和 security model。";
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
          "先分别选好两项：网关在哪台机器上运行，以及哪些设备能通过网络访问它。再复制提示词，粘贴到 Claude Code 或 Codex。它会克隆仓库，查阅实际的操作手册，完成安装配置。每逢需要你做决定或批准的步骤，都会停下来。"
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
              "把这段提示词粘贴到 Claude Code 或 Codex，它会查阅实际的操作手册，完成安装配置。")
          : t("Prefer the terminal? These are real, verified commands — the console handles the point-and-click parts (connect an agent, approve).",
              "习惯用终端？可运行以下经过验证的命令；需要点击的操作在控制台完成（连接智能体、批准请求）。") }}
      </p>
      <pre class="gss-prompt">{{ active }}</pre>
    </div>

    <!-- Degenerate cell: one honest note, no pretend tutorial -->
    <div class="gss-note" v-else>
      <span class="gss-note-tag">{{ t("Same model, no separate guide", "配置方式相同，无单独指南") }}</span>
      <p class="gss-note-body" v-html="renderNote(note)"></p>
    </div>

    <p class="gss-foot">
      {{ t("Next — the one thing that never changes:", "接下来看唯一不变的一点：") }}
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
