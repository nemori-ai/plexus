<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useData } from "vitepress";

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

// The selector's fixed scenario, when embedded on a level page (locks the first row).
const props = defineProps<{ scenario?: "local" | "remote" }>();

type Scenario = "local" | "remote";
type Agent = "claude" | "codex";
type Expose = "folder" | "vault";

const scenario = ref<Scenario>(props.scenario ?? "local");
const agent = ref<Agent>("claude");
const expose = ref<Expose>("folder");

// Level 2 (remote) only exposes a workspace folder over the tunnel — keep the choice valid.
watch(scenario, (s) => {
  if (s === "remote" && expose.value !== "folder") expose.value = "folder";
  if (s === "local" && props.scenario === undefined) expose.value = "folder";
});

const REPO = "https://github.com/nemori-ai/plexus";

// ── segmented-control option sets (bilingual) ─────────────────────────────────
const scenarioOpts = computed(() => [
  { v: "local", label: zh.value ? "全在这台 Mac" : "All on this Mac", sub: zh.value ? "Level 1" : "Level 1" },
  { v: "remote", label: zh.value ? "从另一台机器够到它" : "From another machine", sub: "Level 2" },
]);
const agentOpts = computed(() => [
  { v: "claude", label: "Claude Code" },
  { v: "codex", label: "Codex" },
]);
const exposeOpts = computed(() =>
  scenario.value === "remote"
    ? [{ v: "folder", label: zh.value ? "我指定的一个文件夹" : "A folder I choose" }]
    : [
        { v: "folder", label: zh.value ? "我指定的一个文件夹" : "A folder I choose", sub: "workspace" },
        { v: "vault", label: zh.value ? "我的 Obsidian vault(只读)" : "My Obsidian vault (read-only)", sub: "obsidian.vault.read" },
      ],
);

// ── the agent-specific credential clause ──────────────────────────────────────
function agentClause(): string {
  if (agent.value === "claude") {
    return zh.value
      ? "把自己作为 **Claude Code** agent 连接(你会拿到一个编译好的 `plexus-<id>` launcher,那是你唯一的接口),用你自己的 per-agent 凭据——绝不是我的 admin connection-key。"
      : "connect yourself as a **Claude Code** agent (you get a compiled `plexus-<id>` launcher — your only interface), using your own per-agent credential — never my admin connection-key.";
  }
  return zh.value
    ? "把自己作为 **Codex**(在连接向导里选 Generic / other agent)连接:按 `integrations/codex/setup.md` 把 `plexus` 命令接到你的 PATH 上、并加上 AGENTS.md 指令块,用你自己的 per-agent PAT——绝不是我的 admin connection-key。"
    : "connect yourself as **Codex** (pick Generic / other agent in the connect wizard): follow `integrations/codex/setup.md` to put the `plexus` command on your PATH + add the AGENTS.md block, using your own per-agent PAT — never my admin connection-key.";
}

function exposeClause(): string {
  if (expose.value === "folder") {
    return zh.value
      ? "把**我指定的一个文件夹**(向我要路径)暴露成 `workspace` source,然后给我演示一次读和一次写——写会在 Plexus UI 里**挂起等我批准**。"
      : "expose **a folder I'll name** (ask me for the path) as a `workspace` source, then show me one read and one write into it — the write will **pend for my approval** in the Plexus UI.";
  }
  return zh.value
    ? "把**我的 Obsidian vault**(向我要路径)只读暴露成 `obsidian.vault.read`,然后演示一次读。"
    : "expose **my Obsidian vault** (ask me for the path) read-only as `obsidian.vault.read`, then show me one read.";
}

// ── the generated prompt (the paste-into-your-agent output) ───────────────────
const prompt = computed(() => {
  if (scenario.value === "remote") {
    return zh.value
      ? `你在帮我把家里的 **Plexus** 网关发布出去,好让*你*(在另一台机器上运行)经隧道够到我这台 Mac 上的能力——只经过一道受管、默认拒绝、全程审计的边界,而不是我把裸钥匙或 shell 交给你。

现在就动手。**按顺序、幂等地**做(可安全重跑),并**用大白话叙述每一步**,让我边看边搞懂 Plexus 怎么工作。任何一步需要我的**决定**(域名、文件夹)或**批准**(在 Plexus UI 里点 Approve)时,**停下来问我**,绝不擅自越过。

在**家里这台机器**上:

1. clone ${REPO}(如果我已经有了就 cd 进去),读 **examples/home-gateway/README.md**。
2. 按它把网关发布到我自己域名的一个 hostname 下(named tunnel),${agentClause()} 然后打印出给我另一台机器用的**一条命令安装**。
3. 把那条命令给我,让我粘到**另一台机器**上;之后演示:一次读(直接通)+ 一次写(在 Plexus UI 里**挂起等我批准**)。

每一步之后,回显刚发生了什么、以及它证明了什么——发现我暴露的东西 → 由我授权 → 调用它。最后用几行话总结我刚看到的:两种凭据、为什么写/执行会为我挂起、以及一次撤销如何把你切断。`
      : `You're helping me publish my home **Plexus** gateway so that *you* — running on a different machine — can reach the tools on my Mac over a tunnel, only through a governed, default-deny, fully-audited boundary, instead of me handing you a raw key or a shell.

Do this now. Work **in order and idempotently** (safe to re-run), and **narrate each step in plain language** so I follow along and learn how Plexus works as you go. Whenever a step needs my **decision** (a hostname, a folder) or my **approval** (clicking Approve in the Plexus UI), **stop and ask me** — never guess past those.

On my **home machine**:

1. Clone ${REPO} (or cd into it if I already have it) and read **examples/home-gateway/README.md**.
2. Follow it to publish the gateway under a hostname on my own domain (a named tunnel), ${agentClause()} then print the **one-command install** for my other machine.
3. Give me that command to paste on my **other machine**; then show me one read (flows) and one write (**pends for my approval** in the Plexus UI).

After each step, echo what just happened and what it proves — discover what I exposed → be granted by me → call it. At the end, summarize in a few lines: the two credentials, why writes/execute pended for me, and how one revoke cuts you off.`;
  }

  // Level 1 — local
  const runbook = "docs/getting-started.md";
  return zh.value
    ? `你在帮我试用 **Plexus**——一个本地能力网关,它让你(我的 AI agent)只经过一道受管、默认拒绝、全程审计的边界去够到我 Mac 上的工具,而不是我把裸钥匙或 shell 交给你。

现在就装好并跑起来。**按顺序、幂等地**做(可安全重跑),并**用大白话叙述每一步**,让我边看边搞懂 Plexus 怎么工作。任何一步需要我的**决定**(文件夹、密钥)或**批准**(在 Plexus UI 里点 Approve)时,**停下来问我**,绝不擅自越过。

1. clone ${REPO}(如果我已经有了就 cd 进去),读 **${runbook}**。
2. 按它端到端执行:安装、以隔离的 demo 实例启动网关、${agentClause()} ${exposeClause()}
3. 每一步之后,回显刚发生了什么、以及它证明了什么——发现我暴露的东西 → 由我授权 → 调用它;需要我批准时,把 Plexus UI 的地址指给我。

最后用几行话总结我刚看到的:两种凭据、为什么写/执行会为我挂起、以及一次撤销如何把你彻底切断。`
    : `You're helping me try **Plexus** — a local capability gateway that lets you (my AI agent) reach the tools on my Mac only through a governed, default-deny, fully-audited boundary, instead of me handing you a raw key or a shell.

Set it up and run it now. Work **in order and idempotently** (safe to re-run), and **narrate each step in plain language** so I follow along and learn how Plexus works as you go. Whenever a step needs my **decision** (a folder, a key) or my **approval** (clicking Approve in the Plexus UI), **stop and ask me** — never guess past those.

1. Clone ${REPO} (or cd into it if I already have it) and read **${runbook}**.
2. Execute it end to end: install, start the gateway as an isolated demo instance, ${agentClause()} ${exposeClause()}
3. After each step, echo what just happened and what it proves — discover what I exposed → be granted access by me → call it — and point me to the Plexus UI URL when something needs my approval.

At the end, summarize in a few lines what I just saw: the two credentials, why writes/execute pended for me, and how one revoke would cut you off.`;
});

// ── the SHELL fallback (real, verified commands only — no invented one-liners) ──
const shell = computed(() => {
  if (scenario.value === "remote") {
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
  const exposeFlag =
    expose.value === "vault"
      ? zh.value
        ? " --vault ~/你的/vault    # 只读暴露成 obsidian.vault.read"
        : " --vault ~/path/to/vault    # exposes it read-only as obsidian.vault.read"
      : "";
  return zh.value
    ? `# 1. 启动网关 + 控制台(仅回环)。会打印你的 connection-key 和 URL。
git clone ${REPO} && cd plexus && bun install && bun run start${exposeFlag}
# 2. 打开 http://127.0.0.1:7077/admin  →  Connect an agent(并暴露你的 source)
# 或者,零配置直接看整套回环自证一遍:  bun run demo`
    : `# 1. Boot the gateway + console (loopback). Prints your connection-key + the URL.
git clone ${REPO} && cd plexus && bun install && bun run start${exposeFlag}
# 2. Open http://127.0.0.1:7077/admin  →  Connect an agent  (and expose your source)
# Or, to just watch the whole loop prove itself with zero setup:  bun run demo`;
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
</script>

<template>
  <div class="gss">
    <div class="gss-head">
      <span class="gss-kicker">{{ t("Fastest start", "最快上手") }}</span>
      <h3 class="gss-title">
        {{ t("Pick your setup — your agent does the rest", "选好你的场景——剩下的交给你的 agent") }}
      </h3>
      <p class="gss-lead">
        {{ t(
          "Choose below, copy the prompt, and paste it into Claude Code or Codex. It clones the repo, reads the real runbook, and sets everything up — narrating each step and pausing whenever it needs your decision or approval, so you learn the flow as it goes.",
          "在下面选好,复制这段话,粘给 Claude Code 或 Codex。它会 clone 仓库、读真实的 runbook、把一切装好——边做边叙述,遇到需要你决定或批准的地方就停下来问你;你在不知不觉中就学会了整个流程。"
        ) }}
      </p>
    </div>

    <div class="gss-rows">
      <div class="gss-row" v-if="!props.scenario">
        <label class="gss-label">{{ t("Scenario", "场景") }}</label>
        <div class="gss-seg">
          <button
            v-for="o in scenarioOpts" :key="o.v"
            class="gss-opt" :class="{ on: scenario === o.v }"
            @click="scenario = o.v as Scenario"
          >
            <span class="gss-opt-label">{{ o.label }}</span>
            <span class="gss-opt-sub">{{ o.sub }}</span>
          </button>
        </div>
      </div>

      <div class="gss-row">
        <label class="gss-label">{{ t("Your agent", "你的 agent") }}</label>
        <div class="gss-seg">
          <button
            v-for="o in agentOpts" :key="o.v"
            class="gss-opt" :class="{ on: agent === o.v }"
            @click="agent = o.v as Agent"
          >
            <span class="gss-opt-label">{{ o.label }}</span>
          </button>
        </div>
      </div>

      <div class="gss-row">
        <label class="gss-label">{{ t("What to try", "试点什么") }}</label>
        <div class="gss-seg gss-seg-wrap">
          <button
            v-for="o in exposeOpts" :key="o.v"
            class="gss-opt" :class="{ on: expose === o.v }"
            @click="expose = o.v as Expose"
          >
            <span class="gss-opt-label">{{ o.label }}</span>
            <span class="gss-opt-sub" v-if="(o as any).sub">{{ (o as any).sub }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="gss-out">
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

    <p class="gss-foot">
      {{ t("Prefer to do it by hand?", "想手动来?") }}
      <a :href="scenario === 'remote' ? (zh ? '/zh/guide/home' : '/guide/home') : (zh ? '/zh/guide/local' : '/guide/local')">
        {{ t("The step-by-step walkthrough →", "分步 walkthrough →") }}
      </a>
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
.gss-foot { margin: 12px 0 0; font-size: 12.5px; color: var(--vp-c-text-3); }
.gss-foot a { font-weight: 600; }
@media (max-width: 640px) {
  .gss-row { grid-template-columns: 1fr; gap: 6px; }
  .gss-label { padding-top: 0; }
}
</style>
