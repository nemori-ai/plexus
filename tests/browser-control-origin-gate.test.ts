/**
 * The ORIGIN GATE — the security spine of browser control.
 *
 * Chrome's own remote-debugging consent is all-or-nothing (it authorizes the browser, not a set
 * of sites), so this gate is where "which sites may this agent touch" is actually decided. The
 * cases below are the ones that would matter if it were wrong: an unset allowlist must deny, and
 * a hostile URL must not be able to look like an allowed one.
 */
import { describe, it, expect } from "bun:test";
import {
  judgeUrl,
  normalizeAllowEntry,
  normalizeAllowlist,
  refusalMessage,
} from "@plexus/runtime/sources/browser-control/origin-gate.ts";

const ALLOW = ["https://github.com"];

describe("origin gate — unset means inert, never open", () => {
  it("denies every URL when no allowlist is configured", () => {
    for (const url of ["https://github.com/x", "https://example.com", "http://localhost:3000"]) {
      const v = judgeUrl(url, []);
      expect(v.allowed).toBe(false);
      expect((v as { reason: string }).reason).toBe("no-allowlist");
    }
    expect(judgeUrl("https://github.com", undefined).allowed).toBe(false);
  });

  it("an allowlist of only-unparseable entries is still empty (no accidental widening)", () => {
    expect(normalizeAllowlist(["", "   ", "not a url at all!!", "file:///etc"])).toEqual([]);
    expect(judgeUrl("https://github.com", ["file:///etc"]).allowed).toBe(false);
  });
});

describe("origin gate — a hostile URL cannot impersonate an allowed one", () => {
  it("refuses a suffix-extended host that a prefix match would accept", () => {
    // `https://github.com.evil.com/` — the classic string-prefix defeat.
    const v = judgeUrl("https://github.com.evil.com/pwn", ALLOW);
    expect(v.allowed).toBe(false);
    expect((v as { reason: string }).reason).toBe("not-allowed");
    expect((v as { origin?: string }).origin).toBe("https://github.com.evil.com");
  });

  it("refuses userinfo that makes the real host look like the allowed one", () => {
    // `https://github.com@evil.com/` — the host is evil.com; the allowed name is only userinfo.
    const v = judgeUrl("https://github.com@evil.com/", ALLOW);
    expect(v.allowed).toBe(false);
    expect((v as { origin?: string }).origin).toBe("https://evil.com");
  });

  it("treats scheme and port as part of the origin", () => {
    expect(judgeUrl("http://github.com/", ALLOW).allowed).toBe(false); // http ≠ https origin
    expect(judgeUrl("https://github.com:8443/", ALLOW).allowed).toBe(false); // port is origin-bearing
  });

  it("refuses a subdomain that was not itself authorized", () => {
    expect(judgeUrl("https://gist.github.com/x", ALLOW).allowed).toBe(false);
  });

  it("allows the exact origin, on any path or query", () => {
    for (const url of [
      "https://github.com",
      "https://github.com/",
      "https://github.com/nemori-ai/plexus/pull/21",
      "https://github.com/search?q=a#frag",
    ]) {
      const v = judgeUrl(url, ALLOW);
      expect(v.allowed).toBe(true);
      expect((v as { origin: string }).origin).toBe("https://github.com");
    }
  });
});

describe("origin gate — non-web schemes stay out", () => {
  it("refuses file, chrome, devtools and javascript targets even when an allowlist exists", () => {
    for (const url of [
      "file:///Users/someone/.ssh/id_rsa",
      "chrome://inspect/#remote-debugging",
      "devtools://devtools/bundled/inspector.html",
      "javascript:fetch('/')",
    ]) {
      const v = judgeUrl(url, ALLOW);
      expect(v.allowed).toBe(false);
      // `javascript:` and the rest are refused on scheme; none may be smuggled in by origin.
      expect(["scheme", "unparseable", "not-allowed"]).toContain((v as { reason: string }).reason);
    }
  });

  it("refuses chrome://inspect specifically — the page that governs remote debugging itself", () => {
    expect(judgeUrl("chrome://inspect/#remote-debugging", ALLOW).allowed).toBe(false);
  });
});

describe("origin gate — owner input is normalized the way an owner would type it", () => {
  it("accepts a bare host, a scheme'd host, and a trailing slash as the same origin", () => {
    expect(normalizeAllowEntry("github.com")).toBe("https://github.com");
    expect(normalizeAllowEntry("https://github.com")).toBe("https://github.com");
    expect(normalizeAllowEntry("https://github.com/")).toBe("https://github.com");
    expect(normalizeAllowEntry("  github.com  ")).toBe("https://github.com");
  });

  it("defaults a bare host to https, not plaintext", () => {
    expect(normalizeAllowEntry("example.com")).toBe("https://example.com");
  });

  it("keeps an explicit http entry distinct (localhost dev is a real case)", () => {
    expect(normalizeAllowEntry("http://localhost:3000")).toBe("http://localhost:3000");
    expect(judgeUrl("http://localhost:3000/app", ["http://localhost:3000"]).allowed).toBe(true);
  });

  it("dedupes entries that normalize to the same origin", () => {
    expect(normalizeAllowlist(["github.com", "https://github.com/", "https://github.com"])).toEqual([
      "https://github.com",
    ]);
  });
});

describe("origin gate — a refusal does not leak the owner's other sites", () => {
  it("names the requested origin and the owner's remedy, never the allowlist", () => {
    const v = judgeUrl("https://evil.com", ["https://github.com", "https://internal.corp"]);
    const msg = refusalMessage(v as Extract<typeof v, { allowed: false }>);
    expect(msg).toContain("evil.com");
    // The other authorized sites must not turn a denial into an enumeration oracle.
    expect(msg).not.toContain("github.com");
    expect(msg).not.toContain("internal.corp");
  });

  it("tells the owner where to configure it when nothing is authorized yet", () => {
    const v = judgeUrl("https://github.com", []);
    expect(refusalMessage(v as Extract<typeof v, { allowed: false }>)).toContain("What I expose");
  });
});
