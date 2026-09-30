/** Opt-in native artifact acceptance: PLEXUS_TEST_DISTRIBUTION=<absolute build dir> bun test <this file>. */
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const built = process.env.PLEXUS_TEST_DISTRIBUTION;
it.skipIf(!built)("relocated native distribution serves real UI and manages isolated enrolled agents without Bun on PATH", async () => {
  const temp = mkdtempSync(join(tmpdir(), "plexus-native-relocation-"));
  const dist = join(temp, "moved bundle"); const home = join(temp, "product private state");
  cpSync(built!, dist, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as { files: Record<string, { sha256: string }> };
  for (const [path, { sha256 }] of Object.entries(manifest.files)) {
    expect(createHash("sha256").update(readFileSync(join(dist, path))).digest("hex")).toBe(sha256);
  }
  const env = { ...process.env, PATH: "/usr/bin:/bin", PLEXUS_HOME: home, PLEXUS_ASSET_ROOT: join(dist, "assets"), PLEXUS_PORT: "0", PLEXUS_FAKE_APPLE: "1" };
  const runtime = Bun.spawn([join(dist, "bin/plexus-runtime")], { cwd: temp, env, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(runtime.stderr).text();
  try {
    const reader = runtime.stdout.getReader(); const decoder = new TextDecoder(); let stdout = "";
    const readReady = async () => {
      for (;;) {
        const result = await reader.read(); if (result.done) throw new Error("Runtime exited before readiness");
        stdout += decoder.decode(result.value);
        const match = stdout.match(/PLEXUS_READY (\{[^\n]+\})/);
        if (match) return JSON.parse(match[1]!) as { port: number };
      }
    };
    let timer: ReturnType<typeof setTimeout>;
    const info = await Promise.race([readReady(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Runtime readiness timeout")), 15_000); })]).finally(() => clearTimeout(timer));
    reader.releaseLock();
    const origin = `http://127.0.0.1:${info.port}`;
    expect((await fetch(`${origin}/v1/health`)).status).toBe(200);
    const html = await (await fetch(`${origin}/admin/`)).text();
    expect(html).toContain('<div id="root">'); expect(html).not.toContain("not built");
    const script = html.match(/src="([^"]+\.js)"/)?.[1]; expect(script).toBeDefined();
    const js = await (await fetch(`${origin}${script}`)).text();
    expect(js.length).toBeGreaterThan(10000); expect(js).toContain("hostManagedAuthentication");
    expect((await fetch(`${origin}/admin/api/capabilities`)).status).toBe(401);
    expect((await fetch(`${origin}/admin/`, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    async function manage(args: string[], body?: unknown) {
      const proc = Bun.spawn([join(dist, "bin/plexus-management"), ...args, "--origin", origin], { cwd: temp, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      if (body) proc.stdin.write(JSON.stringify(body)); proc.stdin.end();
      const [raw, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(err).toBe(""); expect(exit).toBe(0);
      const result = JSON.parse(raw); expect(result.ok).toBe(true); return result.data;
    }
    const caps = await manage(["capabilities", "list"]);
    expect(caps.entries.length).toBeGreaterThan(0);
    const skill = caps.entries.find((e: { kind: string; skill?: { body?: string } }) => e.kind === "skill");
    expect(skill).toBeDefined();
    const connected = await manage(["agent", "connect"], { agentId: "omne-native-test", capabilities: [], agentType: "generic" });
    expect(new URL(connected.enrollUrl).origin).toBe(origin);
    const enrolled = await fetch(connected.enrollUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: connected.code }) });
    expect(enrolled.status).toBe(200);
    const credential = await enrolled.json() as { pat: string };
    const handshake = () => fetch(connected.handshakeUrl, { method: "POST", headers: { authorization: `Bearer ${credential.pat}`, "content-type": "application/json" }, body: JSON.stringify({ client: { name: "omne-test" } }) });
    const handshaken = await handshake();
    expect(handshaken.status).toBe(200);
    const handshakenBody = await handshaken.json() as { grantsUrl: string };
    expect(new URL(handshakenBody.grantsUrl).origin).toBe(origin);
    expect((await fetch(`${origin}/admin/api/pending`, { headers: { authorization: `Bearer ${credential.pat}` } })).status).toBe(401);
    expect((await manage(["pending", "list"])).pending).toEqual([]);
    const roster = await manage(["agent", "list"]);
    expect(roster.agents.some((a: { agentId: string; status: string }) => a.agentId === "omne-native-test" && a.status === "active")).toBe(true);
    await manage(["agent", "revoke"], { agentId: "omne-native-test" });
    expect((await handshake()).status).toBe(401);
    // Real guide, not the degraded compiled fallback.
    const key = readFileSync(join(home, "connection-key"), "utf8").trim();
    const guide = await (await fetch(`${origin}/admin/api/extensions/authoring-guide`, { headers: { "X-Plexus-Connection-Key": key } })).text();
    expect(guide).toBe(readFileSync(join(dist, "assets/docs/extension-authoring.md"), "utf8"));
    expect(stdout).not.toContain(key); expect(stdout).not.toContain(credential.pat);
  } finally {
    runtime.kill("SIGTERM"); await runtime.exited; await stderr;
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);
