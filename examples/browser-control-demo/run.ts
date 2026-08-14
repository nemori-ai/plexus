/**
 * browser-control END-TO-END through a REAL gateway — the agent's whole loop.
 *
 * Not a unit test and not a direct bridge call: this boots an actual Plexus gateway, enrolls an
 * agent, has it DISCOVER the browser capability from the advertisement, proves an un-granted
 * invoke is denied, then drives a real Chrome to a real website over real HTTP `/invoke`.
 *
 * Run:  PLEXUS_BROWSER_CONTROL_ORIGINS=deepseek.com bun run examples/browser-control-demo/run.ts
 */

import { loadConfig, baseUrl } from "@plexus/runtime/config.ts";
import { startRuntime } from "@plexus/runtime/runtime/serve.ts";
import { shutdownLaunchedBrowser } from "@plexus/runtime/sources/browser-control/endpoint.ts";

const AGENT_ID = "agent-browser-demo";
const TABS = "browser-control.tabs.list";
const NAVIGATE = "browser-control.page.navigate";
const READ = "browser-control.page.read";
const CAPS = [TABS, NAVIGATE, READ];

const line = (s = "") => console.log(s);
const step = (n: number, s: string) => console.log(`\n── ${n}. ${s} ${"─".repeat(Math.max(0, 46 - s.length))}`);

async function pickFreePort(): Promise<number> {
  const probe = Bun.serve({ fetch: () => new Response("ok"), hostname: "127.0.0.1", port: 0 });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function main() {
  const port = await pickFreePort();
  const config = { ...loadConfig(), port } as ReturnType<typeof loadConfig>;
  // The SUPERVISED boot seam — same one `bun run serve` uses, so the first-party sources are
  // actually scanned and advertised rather than merely registered.
  const runtime = await startRuntime(config, { emitReadyLine: false, writePortFile: false });
  const state = runtime.state;
  const server = { stop: () => runtime.stop() };
  const base = baseUrl(config);
  const host = new URL(base).host;
  const key = state.connectionKey.current();
  line(`[demo] gateway up at ${base}`);
  line(`[demo] owner-authorized origins: ${process.env.PLEXUS_BROWSER_CONTROL_ORIGINS ?? "(none)"}`);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: path === "/grants" ? "PUT" : "POST",
      headers: { host, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  try {
    // ── 0. OWNER mints the agent's one-time code and opts the execute caps in as standing.
    step(0, "OWNER  POST /admin/api/agents/connect");
    const connect = (await (
      await post("/admin/api/agents/connect", { agentId: AGENT_ID, capabilities: CAPS, standing: CAPS, agentType: "browser-demo" }, { "x-plexus-connection-key": key })
    ).json()) as { code?: string; error?: { message?: string } };
    if (!connect.code) throw new Error(`connect failed: ${JSON.stringify(connect.error)}`);
    line(`one-time code: ${connect.code.slice(0, 14)}…`);

    // ── 1. DISCOVER the floor. Per ADR-023 the well-known no longer broadcasts the capability
    //      directory — it advertises the ROUTES. The cap list arrives at handshake, already
    //      narrowed to this agent's owner-authorized subset.
    step(1, "DISCOVER  GET /.well-known/plexus");
    const wk = (await (await fetch(`${base}/.well-known/plexus`, { headers: { host } })).json()) as {
      gateway?: { name?: string; version?: string; protocol?: string };
    };
    line(`gateway ${wk.gateway?.name} v${wk.gateway?.version} (protocol ${wk.gateway?.protocol})`);

    // ── 2. ENROLL → the agent's own PAT.
    step(2, "ENROLL  POST /agents/enroll");
    const enrolled = (await (await post("/agents/enroll", { code: connect.code })).json()) as { pat: string };
    line(`durable PAT ${enrolled.pat.slice(0, 14)}…`);
    const bearer = { authorization: `Bearer ${enrolled.pat}` };

    // ── 3. HANDSHAKE → the full describe the agent actually reads.
    step(3, "UNDERSTAND  POST /link/handshake");
    const hs = (await (await post("/link/handshake", { client: { name: "browser-demo", version: "0.1.0", agentId: AGENT_ID } }, bearer)).json()) as {
      sessionId: string;
      manifest: { entries: { id: string; describe: string; grants: string[] }[] };
    };
    const sess = { "x-plexus-session": hs.sessionId };
    line(`session ${hs.sessionId}`);
    for (const e of hs.manifest.entries.filter((e) => e.id.startsWith("browser-control."))) {
      line(`  • ${e.id}  grants:${JSON.stringify(e.grants)}`);
    }
    const nav = hs.manifest.entries.find((e) => e.id === NAVIGATE)!;
    line(`\ndescribe(${NAVIGATE}):\n${nav.describe.slice(0, 320)}…`);

    // ── 3b. DEFAULT-DENY — an invoke carrying NO credential at all.
    step(3, "DEFAULT-DENY  POST /invoke (no session, no token)");
    const denied = (await (await post("/invoke", { id: NAVIGATE, input: { url: "https://www.deepseek.com/harness/en/" } })).json()) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    if (denied.ok) throw new Error("SECURITY FAILURE: un-credentialed invoke succeeded");
    line(`denied: ${denied.error?.code} — ${denied.error?.message}`);

    // ── 4. GRANT.
    step(4, "GRANTED  PUT /grants");
    const grant = (await (
      await post(
        "/grants",
        { sessionId: hs.sessionId, grants: Object.fromEntries(CAPS.map((id) => [id, id === NAVIGATE ? "execute" : "allow"])) },
        { ...bearer, ...sess },
      )
    ).json()) as { token: string; jti: string; scopes: unknown };
    line(`scoped token jti=${grant.jti}  scopes=${JSON.stringify(grant.scopes)}`);
    const auth = { authorization: `Bearer ${grant.token}`, ...sess };

    // ── 5. DRIVE A REAL BROWSER TO A REAL SITE.
    step(5, "CALL  POST /invoke → navigate + read");
    const navRes = (await (await post("/invoke", { id: NAVIGATE, input: { url: "https://www.deepseek.com/harness/en/" } }, auth)).json()) as {
      ok: boolean;
      output?: Record<string, unknown>;
      error?: { code: string; message: string };
      auditId?: string;
    };
    line(`navigate ok=${navRes.ok} audit=${navRes.auditId} ${navRes.ok ? JSON.stringify(navRes.output) : JSON.stringify(navRes.error)}`);

    const readRes = (await (await post("/invoke", { id: READ, input: {} }, auth)).json()) as {
      ok: boolean;
      output?: { url?: string; title?: string; text?: string; truncated?: boolean };
      error?: { code: string; message: string };
    };
    line(`read ok=${readRes.ok}`);
    if (readRes.ok) {
      line(`  url:   ${readRes.output?.url}`);
      line(`  title: ${readRes.output?.title}`);
      line("─── page text (first 700 chars) ───");
      line(String(readRes.output?.text ?? "").slice(0, 700).trimEnd());
      line("───────────────────────────────────");
    } else {
      line(`  ${JSON.stringify(readRes.error)}`);
    }

    // ── 6. THE BOUNDARY — a site the owner did NOT authorize.
    step(6, "BOUNDARY  POST /invoke → an unauthorized origin");
    const off = (await (await post("/invoke", { id: NAVIGATE, input: { url: "https://news.ycombinator.com/" } }, auth)).json()) as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    line(`ok=${off.ok} → ${off.error?.code}: ${off.error?.message}`);

    // ── 7. What the agent can SEE.
    step(7, "DIRECTORY  POST /invoke → tabs.list");
    const tabs = (await (await post("/invoke", { id: TABS, input: {} }, auth)).json()) as {
      ok: boolean;
      output?: unknown;
    };
    line(JSON.stringify(tabs.output));

    // ── 8. SAFE BY DEFAULT — a second agent the owner did NOT opt in as standing. Driving a
    //      browser is `execute`, so without that opt-in the same call needs per-use approval.
    step(8, "SAFE-BY-DEFAULT  a second agent, no standing opt-in");
    const c2 = (await (
      await post("/admin/api/agents/connect", { agentId: "agent-browser-demo-2", capabilities: CAPS, agentType: "browser-demo" }, { "x-plexus-connection-key": key })
    ).json()) as { code: string };
    const e2 = (await (await post("/agents/enroll", { code: c2.code })).json()) as { pat: string };
    const h2 = (await (
      await post("/link/handshake", { client: { name: "browser-demo-2", version: "0.1.0", agentId: "agent-browser-demo-2" } }, { authorization: `Bearer ${e2.pat}` })
    ).json()) as { sessionId: string };
    const g2 = (await (
      await post("/grants", { sessionId: h2.sessionId, grants: { [NAVIGATE]: "execute" } }, { authorization: `Bearer ${e2.pat}`, "x-plexus-session": h2.sessionId })
    ).json()) as { token?: string; status?: string; error?: { code: string; message: string } };
    line(`grant for the un-opted-in agent → ${JSON.stringify(g2).slice(0, 240)}`);
  } catch (err) {
    line(`\n✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  } finally {
    shutdownLaunchedBrowser();
    server.stop();
    line("\n[demo] gateway stopped, browser closed");
  }
}

await main();
