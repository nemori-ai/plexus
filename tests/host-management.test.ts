import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.stop(true));
  homes.splice(0).forEach((h) => rmSync(h, { recursive: true, force: true }));
});
function setup(handler: (request: Request) => Response | Promise<Response>) {
  const home = mkdtempSync(join(tmpdir(), "plexus-host-cli-")); homes.push(home);
  writeFileSync(join(home, "connection-key"), "management-secret", { mode: 0o600 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler }); servers.push(server);
  return { home, origin: `http://127.0.0.1:${server.port}` };
}
async function cli(argv: string[], home?: string, input = "") {
  const child = Bun.spawn([process.execPath, "packages/cli/src/management-bin.ts", ...argv], {
    env: { ...process.env, PLEXUS_HOME: home ?? "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(input); child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode, json: () => JSON.parse(stdout) };
}

describe("trusted host management CLI", () => {
  it("reads only the explicit product home key and fixed admin route", async () => {
    const seen: string[] = [];
    const { home, origin } = setup((r) => {
      seen.push(new URL(r.url).pathname);
      expect(r.headers.get("x-plexus-connection-key")).toBe("management-secret");
      return Response.json({ entries: [{ id: "example.read" }], revision: 3 });
    });
    const result = await cli(["capabilities", "list", "--origin", origin], home);
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
    expect(result.json()).toEqual({ ok: true, data: { entries: [{ id: "example.read" }], revision: 3 } });
    expect(seen).toEqual(["/admin/api/capabilities"]);
    expect(result.stdout).not.toContain("management-secret");
  });
  it("connect carries selection by private stdin; code appears only on machine stdout", async () => {
    const body = { agentId: "omne", capabilities: ["example.read"], standing: [], agentType: "generic" };
    const { home, origin } = setup(async (r) => {
      expect(new URL(r.url).pathname).toBe("/admin/api/agents/connect");
      expect(r.method).toBe("POST"); expect(await r.json()).toEqual(body);
      return Response.json({ ok: true, agentId: "omne", code: "one-time-secret" });
    });
    const result = await cli(["agent", "connect", "--origin", origin], home, JSON.stringify(body));
    expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
    expect(result.json().data.code).toBe("one-time-secret");
  });
  it("routes pending resolution and exposure updates with bounded encoded ids", async () => {
    const seen: { path: string; body: unknown }[] = [];
    const { home, origin } = setup(async (r) => {
      seen.push({ path: new URL(r.url).pathname, body: await r.json() });
      return Response.json({ ok: true });
    });
    expect((await cli(["pending", "resolve", "--origin", origin], home, JSON.stringify({ id: "pending-1", action: "deny", reason: "owner declined" }))).exitCode).toBe(0);
    expect((await cli(["exposure", "set", "--origin", origin], home, JSON.stringify({ id: "example.read", enabled: false }))).exitCode).toBe(0);
    expect(seen).toEqual([
      { path: "/admin/api/pending/pending-1", body: { action: "deny", reason: "owner declined" } },
      { path: "/admin/api/exposure/example.read", body: { enabled: false } },
    ]);
  });
  it("rejects missing explicit home, remote origins, unknown commands and arbitrary body fields", async () => {
    let calls = 0;
    const { home, origin } = setup(() => { calls++; return Response.json({ ok: true }); });
    const cases: [string[], string | undefined, string?][] = [
      [["capabilities", "list", "--origin", origin], undefined],
      [["capabilities", "list", "--origin", "https://example.com"], home],
      [["capabilities", "list", "--origin", `${origin}/admin`], home],
      [["request", "/admin/api/network", "--origin", origin], home],
      [["agent", "revoke", "--origin", origin], home, '{"agentId":"omne","path":"/network"}'],
      [["pending", "resolve", "--origin", origin], home, '{"id":"../network","action":"approve"}'],
    ];
    for (const [args, selectedHome, input] of cases) {
      const result = await cli(args, selectedHome, input);
      expect(result.exitCode).not.toBe(0); expect(result.stderr).toBe(""); expect(result.json().ok).toBe(false);
    }
    expect(calls).toBe(0);
  });
  it("refuses redirects and redacts upstream errors including credentials and paths", async () => {
    const { home, origin } = setup(() => new Response("management-secret /private/product-home", { status: 500 }));
    const result = await cli(["pending", "list", "--origin", origin], home);
    expect(result.exitCode).toBe(1); expect(result.stderr).toBe("");
    expect(result.json()).toEqual({ ok: false, error: { code: "management_request_failed", message: "Plexus management request failed." } });
    let redirected = false;
    const target = setup(() => { redirected = true; return Response.json({ ok: true }); });
    const redirect = setup(() => Response.redirect(`${target.origin}/admin/api/pending`));
    const redirectedResult = await cli(["pending", "list", "--origin", redirect.origin], redirect.home);
    expect(redirectedResult.exitCode).toBe(1); expect(redirected).toBe(false);
  });
});
