# Site Realtime Demo — "Watch it govern"

Port the admin **Realtime monitor** onto the docs-site home page (`site/`) as a
**simulated-signal demo animation**. It must be eye-catching on first paint AND teach
Plexus's trust model through what the simulated agents do — the animation *is* the
concepts page's trailer.

This document is both the **spec** and the **implementation plan**. Ground truth for the
as-built monitor is `packages/web-admin/src/realtime-engine.ts` (canvas engine, lifted
nearly verbatim) and `packages/web-admin/src/Realtime.tsx` (chrome, re-expressed in Vue).
House patterns come from `site/.vitepress/theme/PlexusHero.vue`.

---

## Decisions at a glance

| Question | Decision | Why (one line) |
|---|---|---|
| Placement | **Replaces** PlexusHero in the `home-hero-after` slot | Owner steer: the monitor is the dominant visual; two canvases fighting is worse than one great one |
| PlexusHero.vue | Unmounted, file kept | Not imported → not bundled; may be revived on a concepts page later |
| Pillar strip | Superseded by a 5-chapter **act rail** | Pillars 1–2 (Any shape / Self-describing) are restated in `plx-stance` text; 3–4 (Revocable / Audited) are now *dramatized*, not asserted |
| Chrome kept | Canvas stage + live caption + pending cards + compact ledger | That's where the value is |
| Chrome dropped | Filter tray, window segments, theme toggle, audit drawer, reconnect | Demo noise; the site nav already owns theme |
| Pending cards | **Interactive** — visitor clicks Approve/Deny; script auto-resolves after ~6 s if ignored | Making the visitor the owner is the strongest teaching move available |
| Engine copy | Verbatim copy into `site/.vitepress/theme/realtime-engine.ts`; **only `refreshPalette()` edited** | Keeps future diffs against the admin original mechanical |
| CSS strategy | Lift `rt-*` rules; **admin-token shim** scoped to the component root (engine gets the direct token edit — it reads `documentElement`, where the shim isn't visible) | One shim block documents the whole mapping; lifted CSS stays diff-able |
| i18n | `useData().lang.startsWith("zh")` + `{en, zh}` string pairs in the script module | Exactly PlexusHero's mechanism |
| Loop length | ~66 s, first flow at **0.8 s** | Reads in one scroll-pause; instantly alive |
| "Not fake live data" | `● Simulated demo` pill (never `● Live`) + "run it for real →" link to the guide | Honest, and converts curiosity into installs |

---

## 1. Scenario script

### 1.1 The world (set once via `engine.setWorld`)

Agents — the PlexusHero roster, verbatim:

| id | label |
|---|---|
| `claude-code` | Claude Code |
| `codex` | Codex |
| `mail-assistant` | Mail assistant |
| `research-agent` | Research agent |
| `monitor` | Monitor |

Capabilities — **real IDs only** (verified in `packages/runtime/src/sources/*`), clustered
by source into constellation galaxies. Verb drives node size/color (`execute` = bigger, amber):

| source | caps (verb) |
|---|---|
| `apple-calendar` | `apple-calendar.events.list` (read), `apple-calendar.calendars.list` (read) |
| `apple-notes` | `apple-notes.notes.search` (read), `apple-notes.notes.create` (**write**) |
| `claudecode` | `claudecode.run` (**execute**) |
| `codex` | `codex.run` (**execute**) |
| `workspace` | `workspace.list` (read), `workspace.read` (read), `workspace.write` (**write**) |
| `sysinfo` | `sysinfo.resources.read` (read), `sysinfo.processes.list` (read), `sysinfo.log.read` (read) |
| `obsidian-rest` | `obsidian-rest.vault.read` (read), `obsidian-rest.vault.write` (**write**) |

Fictional authorized subsets (drive who bounces): Mail assistant ⊂ {apple-calendar.\*,
apple-notes.\*}; Monitor ⊂ {sysinfo.\*}; Claude Code ⊂ {workspace.\*, claudecode.run};
Codex ⊂ {workspace.list, workspace.read, codex.run}; Research agent ⊂
{obsidian-rest.\*, workspace.read}. **Research agent's subset excludes apple-calendar** —
that's Act IV.

Posture rules the script obeys (hard constraints — do not improvise):

- first-party / managed **reads flow** (invoke → ok, green pass).
- any **write / execute pends** (breathing amber orb at the wall) until resolved.
- `TrustWindowKind = once | 1h | 1d | 7d | until-revoked | custom` — the demo uses `1d`
  and `once` only. There is **no `session`** literal; never render one.
- **Execute defaults to per-use (ADR-023 shape)**: neither demo agent has the owner's
  standing-execute opt-in, so `claudecode.run` / `codex.run` pends **every** time;
  approval is `once`. Never state the old "never standing" absolute — the owner CAN
  opt a specific agent + capability into standing execute (default off).
- Out-of-subset requests are rejected outright (invoke denied → `blocked`, red bounce).

### 1.2 Dramaturgy

Five acts + coda, ~66 s. The concept order is deliberate: **standing grant / trust
window is introduced (Act II) before the per-call default is uttered (Act III)** — never
hand a zero-knowledge reader a negation of a concept they haven't met. Ambient reads are
interleaved throughout so the stage never stalls during a pend.

Beat notation: `t` = seconds since loop start. Kind maps 1:1 to `engine.fire()` /
`resolveWaiting()` and to a ledger row per the admin `classify()` table (invoke/ok → ✓ ok;
invoke/denied → ⊘ blocked, bounced; allow → ✓ allowed; deny → ⊘ denied; pend → ⏳ waiting).

#### Act I — Reads flow (0–10 s)

| id | t | beat | canvas |
|---|---|---|---|
| a1.1 | 0.8 | Monitor → `sysinfo.resources.read` invoke ok | green pass + cap pulse |
| a1.2 | 2.2 | Mail assistant → `apple-calendar.events.list` invoke ok | pass |
| a1.3 | 3.6 | Claude Code → `workspace.list` invoke ok | pass |
| a1.4 | 5.0 | Research agent → `obsidian-rest.vault.read` invoke ok | pass |
| a1.5 | 6.4 | Monitor → `sysinfo.processes.list` invoke ok (no caption change) | pass |
| a1.6 | 8.0 | Mail assistant → `apple-calendar.calendars.list` invoke ok (no caption change) | pass |

Captions:

- **a1.1** — EN: "**Monitor** called `sysinfo.resources.read` — a first-party read on a
  **standing grant**. It flows; you weren't interrupted."
  zh: "**Monitor** 调用了 `sysinfo.resources.read`——第一方读能力，走**常驻授权**。直接放行，没有打扰你。"
- **a1.2** — EN: "Reads inside an agent's **authorized subset** pass straight through the
  wall — and every one still lands on its **audit trail**."
  zh: "在 agent **授权子集**之内的读操作直接过墙——但每一笔仍落在它自己的**审计轨迹**上。"
- **a1.4** — EN: "**Research agent** reads a managed source, `obsidian-rest.vault.read` —
  same posture: reads flow."
  zh: "**Research agent** 读取 managed 来源 `obsidian-rest.vault.read`——同样的姿态：读操作放行。"

#### Act II — A write pends → trust window (10–24 s)

| id | t | beat |
|---|---|---|
| a2.pend | 10.5 | Mail assistant → `apple-notes.notes.create` **pend**. Card appears (window `1d`, flag `notesGranted`, auto-resolve **approve** at t=17.0) |
| a2.ok1 | 19.5 | if `notesGranted`: `apple-notes.notes.create` invoke ok — else: invoke **denied** (blocked bounce) |
| a2.ok2 | 21.5 | if `notesGranted`: `apple-notes.notes.create` invoke ok (no caption change) — else: skip |

Captions:

- **a2.pend** — EN: "A write. **Mail assistant** wants `apple-notes.notes.create`, and the wall
  holds it — no standing grant yet. Your call."
  zh: "写入来了。**Mail assistant** 想调用 `apple-notes.notes.create`，墙把它拦住——还没有常驻授权。由你决定。"
- **on approve** — EN: "Approved with a **trust window** of `1d` — a **standing grant**
  that lasts until it expires or you revoke it."
  zh: "已批准，**信任窗口** `1d`——一条**常驻授权**，到期或被**撤销**前一直有效。"
- **on deny** — EN: "You held the wall. Denied — and everything stays **default-deny**."
  zh: "你按住了墙。已拒绝——一切保持**默认拒绝**。"
- **a2.ok1 (granted)** — EN: "The window stands, so later writes flow without asking
  again — each one still audited."
  zh: "窗口在，后续写入不再逐次询问——但每一笔仍然留痕。"
- **a2.ok1 (denied branch)** — EN: "No grant, no passage — the same write bounces off
  the wall."
  zh: "没有授权就没有通行——同样的写入被墙弹回。"

#### Act III — Execute, per call (24–40 s)

| id | t | beat |
|---|---|---|
| a3.pend1 | 24.5 | Claude Code → `claudecode.run` **pend** (window `once`, flag `run1`, auto-approve at t=30.0) |
| a3.amb | 27.0 | Monitor → `sysinfo.resources.read` invoke ok (ambient, no caption) |
| a3.pend2 | 33.5 | Claude Code → `claudecode.run` **pends again** (window `once`, flag `run2`, auto-approve at t=38.0) |

Captions:

- **a3.pend1** — EN: "**Claude Code** asks to run code. `claudecode.run` is *execute* —
  by default it stops at the wall **every time**, and approval is `once`."
  zh: "**Claude Code** 请求运行代码。`claudecode.run` 是 *execute*——默认每次都停在墙前，批准就是 `once`。"
- **on approve (either pend)** — EN: "Approved for `once` — this run, and only this run."
  zh: "已批准 `once`——只放行这一次运行。"
- **on deny (either pend)** — EN: "Denied — the run never happened. Nothing standing,
  nothing to clean up."
  zh: "已拒绝——这次运行没有发生。没有常驻，也没有残留。"
- **a3.pend2** — EN: "It runs again — it pends again. Execute is approved per call
  **by default** — lifting that is the owner's call alone."
  zh: "再运行一次——就再挂起一次。execute **默认按次批准**——要解除，只能由拥有者亲自开启。"

#### Act IV — Off-subset bounces (40–50 s)

| id | t | beat |
|---|---|---|
| a4.deny | 41.0 | Research agent → `apple-calendar.events.list` invoke **denied** → blocked, red bounce + burst |
| a4.contrast | 45.5 | Mail assistant → `apple-calendar.events.list` invoke ok — the same cap, the right agent |

Captions:

- **a4.deny** — EN: "**Research agent** reached for `apple-calendar.events.list` —
  outside its **authorized subset**. **Default-deny**: the wall bounces it, and the
  attempt itself is audited."
  zh: "**Research agent** 伸手 `apple-calendar.events.list`——在它的**授权子集**之外。**默认拒绝**：墙直接弹回，这次尝试本身也被审计。"
- **a4.contrast** — EN: "The same capability flows for **Mail assistant**. Subsets are
  drawn per agent — so is the **blast radius**."
  zh: "同一个能力，**Mail assistant** 调用就直接放行。授权子集按 agent 划定——**爆炸半径**也是。"

#### Act V — Revoke cuts it off (50–62 s)

| id | t | beat |
|---|---|---|
| a5.revoke | 50.5 | **note beat** — no canvas flow (grant.revoke is control-plane); pushes a ledger row `ev: revoke` (deny styling), path `Monitor → sysinfo.resources.read`, out `revoked` |
| a5.blocked | 52.5 | Monitor → `sysinfo.resources.read` invoke **denied** → blocked (the agent that flowed all loop now bounces) |
| a5.surgical | 55.5 | if `notesGranted`: Mail assistant → `apple-notes.notes.create` invoke ok — else: invoke denied |

Captions:

- **a5.revoke** — EN: "You revoke **Monitor**'s standing grant — one move."
  zh: "你**撤销**了 **Monitor** 的常驻授权——一个动作。"
- **a5.blocked** — EN: "Cut off mid-loop: the very next call bounces, and its scoped
  token dies with the grant."
  zh: "回环中途被切断：下一次调用直接弹回，受限 token 也随授权一起失效。"
- **a5.surgical (granted)** — EN: "**Mail assistant**'s window still stands. Revoke is
  surgical — one grant, one agent, nothing else disturbed."
  zh: "**Mail assistant** 的信任窗口仍然有效。撤销是外科手术式的——只动一条授权、一个 agent，其余不受影响。"
- **a5.surgical (denied branch)** — EN: "**Mail assistant** never got a window — its
  write still bounces. Default-deny doesn't drift."
  zh: "**Mail assistant** 没拿到窗口——它的写入仍被弹回。默认拒绝不会悄悄松动。"

#### Coda — Audit (62–66 s)

| id | t | beat |
|---|---|---|
| c.1 | 62.0 | Claude Code → `workspace.read` invoke ok |
| c.2 | 63.0 | **note beat**, caption only |

- **c.2** — EN: "Sixty seconds, and every event is accounted for — one **audit trail**
  per agent. This is a simulation; run the real **trust loop** in the guide."
  zh: "六十秒，每个事件都有账——每个 agent 各一条**审计轨迹**。这是模拟演示；到指南里跑一遍真实的**信任回环**。"

At t=66 the loop restarts: force-resolve any still-open cards (as their default), reset
fired-set + branch flags + act rail to Act I. The **ledger persists across loops**
(capped at 40 rows; row keys are `${loopIndex}:${beatId}` so they never collide) —
an accumulating trail is itself on-message. Timestamps use the real wall clock (`hhmmss`),
which makes the ledger feel live without claiming to be.

### 1.3 Branch semantics (visitor interaction)

- Each pend beat carries `flag`, `window` (`"1d" | "once"`), `resolveAt`, and the four
  caption variants. Visitor click before `resolveAt` cancels the auto-resolution;
  otherwise the script resolves with **approve** (the default keeps the loop's
  happy-path teaching intact).
- Resolution (either way) does three things: `engine.resolveWaiting(agent, cap, approved)`,
  push an `allow`/`deny` ledger row, set the caption variant. Sets the branch flag.
- Downstream beats declare `requires?: { flag, value }` plus an optional swapped variant
  (see a2.ok1, a5.surgical). Execute denials need no follow-up swap — the deny animation
  and caption are the whole story.
- Early approval simply means downstream beats find the flag already set — they still
  fire at their scheduled `t` (trust-window semantics, not a cascade).

### 1.4 Terminology canon (verbatim, non-negotiable)

trust window / 信任窗口 · standing grant / 常驻授权 · default-deny / 默认拒绝 ·
authorized subset / 授权子集 · revoke / 撤销 · audit trail / 审计轨迹 ·
blast radius / 爆炸半径 · trust loop / 信任回环 · "token" stays **untranslated** in zh ·
provenance words first-party / managed / extension untranslated · window kinds rendered
as code literals (`1d`, `once`). No invariant sentence may be paraphrased — the captions
above are the copy; implementers change wording only by updating this spec.

---

## 2. Component spec

### 2.1 Placement

`<RealtimeDemo>` is injected via the `home-hero-after` layout slot in
`site/.vitepress/theme/index.ts`, **replacing** `<PlexusHero>`. It renders on both home
pages (`site/index.md`, `site/zh/index.md`) with zero markdown edits — the component
reads the locale itself. It sits directly under the hero text/actions, above
`plx-stance`, i.e. above the fold on desktop: the visitor sees the first flow within a
second of landing.

### 2.2 Layout (top → bottom, max-width 1152px like `.plx-hero`)

1. **Header row** — simulated pill + eyebrow/heading + escape hatch link.
   - Pill (replaces the admin `● Live`): EN `● Simulated demo`, zh `● 模拟演示` —
     green pulsing dot kept (`rt-lp`), but the word is always "Simulated". This is the
     honesty affordance; the wall-clock timestamps do the "feels live" work.
   - Eyebrow: EN `SIXTY SECONDS, SIMULATED` / zh `六十秒 · 模拟信号`.
     Heading: EN `Watch it govern` / zh `看它如何把关`.
     Sub: EN "Five agents reaching real capabilities through the Plexus wall — a
     scripted loop of the exact event shapes the real monitor renders." /
     zh "五个 agent 穿过 Plexus 之墙调用真实能力——用真实监控渲染的事件形状，编排成一段循环脚本。"
   - Right-aligned link: EN `run it for real →` → `/guide/`; zh `跑一遍真的 →` → `/zh/guide/`.
2. **Stage** — the canvas, inside a framed panel (1px `--vp-c-divider` border,
   12px radius, `--vp-c-bg-alt` ground — "plates in a manual", matching `custom.css`).
   Pending cards overlay top-right. The admin's click-to-filter hint is dropped
   (no filter exists here); the engine's own `PLEXUS · default-deny · audited`
   wall label stays.
3. **Caption line** — moved **out** of the canvas overlay to a dedicated line below the
   stage (PlexusHero's `plx-caption` pattern; `min-height: 3em` so it never reflows the
   page). Overlay captions collide with pending cards on narrow screens; below-stage
   never does. Same `<b>` / `<code>` styling as `plx-vislabel`.
4. **Act rail** — five chapters in the pillar-strip visual language (top hairline,
   mono index, amber top-bar on the current one). The current act highlights as the
   script enters it; **clicking a chapter jumps the loop clock to that act's start**
   (clear transient flows + open cards first). Entries:
   1. EN "Reads flow / standing grants, audited" — zh "读，直接放行 / 常驻授权，全程留痕"
   2. EN "A write pends / you set the trust window" — zh "写，先挂起 / 信任窗口由你给"
   3. EN "Execute, per call / once means once" — zh "execute，按次批 / once 就是 once"
   4. EN "Off-subset bounces / default-deny holds" — zh "子集外，弹回 / 默认拒绝不松动"
   5. EN "Revoke cuts it off / surgical, immediate" — zh "撤销，即刻切断 / 外科手术式"
5. **Ledger** — compact (~176px, 5 visible rows, scrollable), admin row anatomy verbatim:
   time · ev badge (invoke/allow/deny/pend/revoke) · `agent → cap` (or `⊗` when bounced) ·
   outcome ✓/⊘/⏳. Head: EN `Recent activity · N events — hover a row to replay it above ↑`
   (zh: `最近活动 · N 条——悬停一行，在上方重放 ↑`). Hover replay kept (`engine.replay`,
   already replay-safe per engine A2). Row **click does nothing** — the audit drawer
   stays in the admin.

### 2.3 Pending cards (interactive)

Admin card anatomy with demo copy:

- eyebrow: EN `At the wall — your call` / zh `停在墙前——由你决定` (pulsing amber dot kept)
- who: `**{agent}** wants to run \`{cap}\`` / zh `**{agent}** 想调用 \`{cap}\``
- meta (write): EN "approving opens a trust window (`1d`); denying keeps default-deny" /
  zh "批准会打开一个信任窗口（`1d`）；拒绝则保持默认拒绝"
- meta (execute): EN "execute is per-call by default — approving grants `once`" /
  zh "execute 默认按次批准——通过即 `once`"
- buttons: **`Approve · 1d`** or **`Approve · once`** (the TrustWindowKind is literally on
  the button — that's the teaching) and `Deny` / zh `批准 · 1d` `批准 · once` `拒绝`.

If ignored, the script auto-resolves at `resolveAt` (~6 s of card lifetime) — a demo must
never dead-end on a passive viewer, but an active one should get to *be* the owner.

### 2.4 Sizing & responsiveness

- Desktop: stage height `clamp(340px, 46vh, 460px)`; cards 300px wide, top-right.
- `< 720px`: stage `300px`; ledger 4 rows; act rail wraps to 2+3 grid
  (pillar-strip's own breakpoint pattern); header link drops below the heading.
- `< 560px`: pending cards leave the overlay and render **static between stage and
  caption** (full width) — never cover the wall on a phone.
- No horizontal scroll at any width; the canvas is DPR-aware and `ResizeObserver`-driven
  already (engine handles it).

### 2.5 Themes

Engine palette re-reads on `.dark` class flips via a `MutationObserver` on
`document.documentElement` `{ attributes: true, attributeFilter: ["class"] }` →
`engine.refreshPalette()` — exactly PlexusHero's pattern (the admin watched `data-theme`;
the site does not have it). Chrome CSS follows automatically through the token shim.
Constraint: every token the engine reads **must resolve to an `oklch(...)` string** —
the engine's alpha helper `A()` parses oklch literals. All chosen site tokens
(`--vp-c-text-*`, `--vp-c-divider/border`, `--vp-c-brand-1`, `--plx-green`, `--plx-clay`)
are oklch in both themes; keep fallbacks oklch too.

### 2.6 Reduced motion

The engine already collapses all flow durations to 1 ms under
`prefers-reduced-motion: reduce` (events become instant state changes) and the lifted
`rt-*` reduced-motion block plus the site-wide kill-switch in `custom.css` stop CSS
keyframes. The script runs at normal cadence: the **ledger and captions carry the full
story without motion** — no separate static-frame mode needed. Verify no pulsing dots
survive.

### 2.7 Performance

- One RAF: the engine's. The **script driver shares it** — an elapsed-time clock advanced
  per frame, never `setTimeout` (no drift, no burst-on-return).
- The clock pauses when `document.hidden` (engine already skips frames then) **and** when
  the component scrolls out of view (`IntersectionObserver`, threshold 0) — engine
  `stop()`/`start()` plus clock freeze. Returning resumes mid-act with no backlog.
- Engine's idle throttle (~10 fps when settled) is inherited; ambient beats are spaced
  so idle windows actually occur.

### 2.8 Accessibility

- Canvas: `role="img"` with a bilingual `aria-label` summarizing the scene ("Simulated
  activity: five agents calling capabilities through the Plexus wall; writes and
  execute pend for approval").
- Caption line is `aria-live="polite"` — it already narrates every beat, which doubles
  as the screen-reader experience.
- Pending buttons and act-rail chapters are real `<button>`s; current chapter gets
  `aria-current="step"`. Ledger rows are non-interactive (hover-only is decorative).

---

## 3. Implementation plan

### 3.1 Files

| action | path | contents |
|---|---|---|
| **add** | `site/.vitepress/theme/realtime-engine.ts` | Verbatim copy of `packages/web-admin/src/realtime-engine.ts` with (a) a provenance header, (b) the `refreshPalette()` swap below. Nothing else changes. |
| **add** | `site/.vitepress/theme/realtime-script.ts` | The world (agents + caps), beat types, the full beat table from §1 with `{en, zh}` caption pairs, card/rail/header strings, `LOOP_LEN = 66_000`. Pure data + types, no DOM. |
| **add** | `site/.vitepress/theme/RealtimeDemo.vue` | Chrome (header, stage, cards, caption, act rail, ledger), the script driver, scoped `rt-*` CSS + token shim. All browser APIs inside `onMounted` (SSG builds SSR-render the home page — module-scope `document` access breaks `vitepress build`). |
| **edit** | `site/.vitepress/theme/index.ts` | `home-hero-after: () => h(RealtimeDemo)` replacing PlexusHero; drop the PlexusHero import; update the header comment. `GetStartedSelector` registration untouched. |
| — | `site/index.md`, `site/zh/index.md` | **No edits.** The component is slot-injected and locale-aware. |
| — | `site/.vitepress/theme/PlexusHero.vue` | **Keep, unmounted** (unimported → unbundled). |

Do **not** create `site/CLAUDE.md` — a file there breaks `vitepress build` (known trap).

### 3.2 Engine provenance header + `refreshPalette()` delta

> **Amendment (verification-exposed)**: a second minimal delta is allowed in the copy —
> the agent-column x in `layout()` is clamped (`Math.min(Math.max(W * 0.085, 118), wallX - 40)`)
> so right-aligned agent labels never clip at the canvas edge in the docs-site panel
> (narrower than the admin's full viewport; found at 1100px). The provenance header
> documents both deltas.

Header (top of the copied file):

```ts
/**
 * COPIED from packages/web-admin/src/realtime-engine.ts (admin Realtime monitor).
 * Keep byte-identical to the original EXCEPT refreshPalette(), which reads the
 * docs-site tokens (--vp-c-* / --plx-*) and detects theme via the `.dark` class
 * instead of the admin's data-theme attribute. When the admin engine changes,
 * re-copy and re-apply only that one edit.
 */
```

The one edited method:

```ts
refreshPalette(): void {
  const cs = getComputedStyle(document.documentElement);
  const g = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
  const dark = document.documentElement.classList.contains("dark");
  this.P = {
    ink: g("--vp-c-text-1", "oklch(0.93 0.012 78)"),
    dim: g("--vp-c-text-2", "oklch(0.74 0.012 76)"),
    faint: g("--vp-c-text-3", "oklch(0.58 0.010 72)"),
    ghost: g("--vp-c-text-3", "oklch(0.58 0.010 72)"),
    hair: g("--vp-c-divider", "oklch(0.30 0.010 66)"),
    hairS: g("--vp-c-border", "oklch(0.34 0.011 66)"),
    amber: g("--vp-c-brand-1", "oklch(0.80 0.135 74)"),
    grant: g("--plx-green", "oklch(0.78 0.12 158)"),
    deny: g("--plx-clay", "oklch(0.66 0.15 32)"),
    light: !dark,
    mono: g("--vp-font-family-mono", "ui-monospace, monospace"),
    ui: g("--vp-font-family-base", "system-ui, sans-serif"),
  };
  this.settled = false;
}
```

`amber` deliberately reads `--vp-c-brand-1` (not `--plx-amber`) so light mode gets the
AA-deepened amber, matching PlexusHero.

### 3.3 CSS strategy — shim, not find-replace

Lift these `rt-*` groups from `packages/web-admin/src/styles.css` (2182–2501) into the
component's `<style scoped>`: `.rt-live` + `rt-lp`, `.rt-stage/.rt-canvas`,
`.rt-pends/.rt-pend` + `rt-pin`, `.rt-cap` (restyled as the below-stage caption line),
`.rt-ledger/.rt-row` + `rt-rin`, and the reduced-motion block. **Skip** bar buttons,
tray, chips, segments, reconnect, drawer-related rules, and the admin's
`height: 100vh` container (the demo container is a framed panel, not a full frame).

Shim block on the component root (chrome only — the engine got the direct edit above,
because it reads `documentElement`, where element-scoped vars are invisible):

```css
.rt-demo {
  --ink: var(--vp-c-text-1);
  --ink-dim: var(--vp-c-text-2);
  --ink-faint: var(--vp-c-text-3);
  --ink-ghost: var(--vp-c-text-3);
  --hairline: var(--vp-c-divider);
  --hairline-strong: var(--vp-c-border);
  --amber: var(--vp-c-brand-1);
  --grant: var(--plx-green);
  --deny: var(--plx-clay);
  --bg: var(--vp-c-bg);
  --bg-deep: var(--vp-c-bg-alt);
  --surface: var(--vp-c-bg-soft);
  --surface-raised: var(--vp-c-bg-elv);
  --font-mono: var(--vp-font-family-mono);
  --font-ui: var(--vp-font-family-base);
}
```

Why shim over find-replace: lifted rules stay textually diff-able against the admin
original, and the entire token mapping lives in one auditable block. Note: with Vue
scoped CSS, keep all lifted selectors under the component root; the pilfered keyframes
(`rt-lp`, `rt-pin`, `rt-rin`) work fine scoped.

### 3.4 Script driver (inside RealtimeDemo.vue)

```ts
// state: elapsed clock (ms), fired Set<beatId>, flags Record<string, boolean>,
//        loopIndex, cards ref, ledger ref (max 40), caption ref, actIndex ref
// per engine frame tick (piggyback on our own rAF that also respects
// document.hidden + IntersectionObserver visibility):
//   elapsed += dt (0 while paused)
//   for each beat with beat.t*1000 <= elapsed not yet fired (and requires satisfied):
//     flow  -> engine.fire(...); push ledger row; set caption if present
//     pend  -> engine.fire(..., "pend"); push waiting row; push card {resolveAt, window, flag, captions}
//     note  -> set caption; optional ledger row (a5.revoke)
//     act   -> actIndex = n
//   for each open card past resolveAt -> resolve(card, /*approve*/ true)
//   if elapsed >= LOOP_LEN: force-resolve open cards, reset fired/flags/actIndex,
//     loopIndex++, elapsed = 0  (ledger persists)
// resolve(card, approved): cancel card; engine.resolveWaiting(agent, cap, approved);
//   push allow/deny row; set caption variant; flags[card.flag] = approved
// act-rail click(n): force-resolve cards; drop in-flight visuals are fine (engine
//   flows self-expire); elapsed = actStart(n)*1000; fired = beats with t < actStart
```

Vue bits: `useData().lang` → `zh` computed picks every `{en, zh}` pair;
`MutationObserver` on the `.dark` class → `refreshPalette()`; full teardown in
`onBeforeUnmount` (`engine.destroy()`, observers, rAF).

### 3.5 Acceptance checklist (implementer runs all; verifier re-runs all)

Build & SSR
1. `cd /Users/pandazki/Codes/plexus/site && bun install && bun run build` — green.
   (This exercises SSR: any module-scope `document`/`window` in the new files fails here.)
2. `bun run preview` (or `bun run dev`) — open `/` and `/zh/`.

Both locales
3. `/`: header, captions, cards, act rail, ledger head all EN. `/zh/`: all zh; canon
   spot-check — 信任窗口、常驻授权、默认拒绝、授权子集、撤销、审计轨迹、爆炸半径、信任回环
   present; "token" appears untranslated; nowhere renders a `session` window literal.

Both themes
4. Toggle appearance both directions on each locale: canvas repaints (wall, beads,
   labels) and chrome follows; no stale colors after several toggles.

Scenario correctness
5. First flow visible within ~1.5 s of page load; full loop reads Acts I→V + coda in
   ~66 s and restarts seamlessly; watch two full loops — no stuck waiting orbs, no
   console errors, ledger keeps accumulating (capped) with unique keys.
6. Execute teaching: `claudecode.run` pends **twice** in every loop, each approved
   `once` — never silently flows.
7. Interaction: click `Approve · 1d` on the write card → wall opens green, `allow` row,
   trust-window caption, later `apple-notes.notes.create` writes flow. Reload; click `Deny` →
   later write bounces `blocked`, Act V shows the denied-branch caption. Ignore all
   cards for a loop → auto-resolution at ~6 s each.
8. Act rail: highlights track the acts; clicking a chapter jumps there without stuck
   cards or double-fired beats.
9. Ledger hover replays the flow above (pend rows replay as a bounce — engine behavior);
   hover never resolves or bounces a live waiting orb.

Motion / perf / responsive
10. Emulate `prefers-reduced-motion: reduce`: no CSS pulse/slide animations, flows are
    instant, captions + ledger still tell the whole story, no errors.
11. Background the tab 30 s, return: no event burst; scroll the demo off-screen:
    CPU/RAF near idle; scroll back: resumes.
12. 390×844 viewport, both locales: no horizontal scroll; pending card readable and
    tappable (static below stage at this width); ledger and act rail legible.

Hygiene
13. Zero console errors/warnings on load, across a theme flip, a locale switch, and a
    full loop. No `site/CLAUDE.md` was created. `packages/web-admin` untouched.
