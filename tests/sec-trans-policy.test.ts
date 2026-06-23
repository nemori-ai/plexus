/**
 * m4sec-trans — TRANSPORT CONFINEMENT POLICY unit tests (the pure validators the
 * register-time confirm path + the transports both call).
 *
 * These assert REAL denials with the concrete attack payloads from the M4 security
 * review (must-fix #2 cli RCE, #3 local-rest SSRF + secret-redirect):
 *   - isBinaryAllowed: /bin/sh, absolute paths, relative paths, shell interpreters,
 *     metacharacters → DENIED; a bare/allow-listed bin → allowed; an allow-list entry
 *     can NEVER override the hard-deny floor.
 *   - isAllowedHost: 169.254.169.254, attacker.example, LAN IPs → DENIED; loopback in
 *     all its forms → allowed; an explicit user-confirmed host → allowed.
 */

import { describe, it, expect } from "bun:test";
import {
  isBinaryAllowed,
  isAllowedHost,
  cliPolicyFromRoute,
  restPolicyFromRoute,
  sanitizeCliEnv,
  BLOCKED_ENV_VARS,
} from "../src/transports/transport-policy.ts";

describe("isBinaryAllowed — cli RCE (#2) hard-deny floor", () => {
  it("DENIES the review's RCE payload bin /bin/sh", () => {
    const d = isBinaryAllowed("/bin/sh");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("absolute_path");
  });

  it("DENIES any absolute path (POSIX, Windows, UNC)", () => {
    expect(isBinaryAllowed("/usr/bin/curl").allowed).toBe(false);
    expect(isBinaryAllowed("/bin/bash").allowed).toBe(false);
    expect(isBinaryAllowed("C:\\Windows\\System32\\cmd.exe").allowed).toBe(false);
    expect(isBinaryAllowed("\\\\evil\\share\\x.exe").allowed).toBe(false);
  });

  it("DENIES relative paths containing a separator", () => {
    expect(isBinaryAllowed("./evil").allowed).toBe(false);
    expect(isBinaryAllowed("../../bin/sh").allowed).toBe(false);
    expect(isBinaryAllowed("a/b").allowed).toBe(false);
    expect(isBinaryAllowed("a/b").reason).toBe("path_separator");
  });

  it("DENIES shell interpreters + script runtimes by bare name (case-insensitive)", () => {
    for (const bin of ["sh", "bash", "zsh", "fish", "Bash", "python", "python3", "perl", "ruby", "node", "deno", "bun", "osascript", "env", "xargs"]) {
      const d = isBinaryAllowed(bin);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("shell_interpreter");
    }
  });

  it("DENIES shell metacharacters / chaining embedded in the bin name", () => {
    for (const bin of ["git; rm -rf /", "echo`whoami`", "a|b", "a&&b", "a$(b)", "a b", "echo\nrm"]) {
      const d = isBinaryAllowed(bin);
      expect(d.allowed).toBe(false);
      // either metachar or interpreter, both are real denials
      expect(["shell_metacharacter", "shell_interpreter", "path_separator"]).toContain(d.reason!);
    }
  });

  it("DENIES empty / whitespace bin", () => {
    expect(isBinaryAllowed("").allowed).toBe(false);
    expect(isBinaryAllowed("   ").allowed).toBe(false);
  });

  it("an allow-list entry CANNOT override the hard-deny floor (/bin/sh stays denied)", () => {
    const d = isBinaryAllowed("/bin/sh", { allowList: ["/bin/sh"] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("absolute_path");
    // a shell interpreter allow-listed bare is still denied
    expect(isBinaryAllowed("bash", { allowList: ["bash"] }).allowed).toBe(false);
  });
});

describe("isBinaryAllowed — allowed paths", () => {
  it("allows a bare safe bin when NO allow-list is configured (back-compat: echo/true)", () => {
    expect(isBinaryAllowed("echo").allowed).toBe(true);
    expect(isBinaryAllowed("true").allowed).toBe(true);
    expect(isBinaryAllowed("git").allowed).toBe(true);
  });

  it("allows a bin that IS on the explicit allow-list", () => {
    expect(isBinaryAllowed("git", { allowList: ["git", "rg"] }).allowed).toBe(true);
  });

  it("DENIES a safe bare bin that is NOT on a configured allow-list", () => {
    const d = isBinaryAllowed("curl", { allowList: ["git"] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("not_in_allow_list");
  });
});

describe("cliPolicyFromRoute / sanitizeCliEnv", () => {
  it("reads allowedBins off the open route bag", () => {
    expect(cliPolicyFromRoute({ allowedBins: ["git", "rg"] }).allowList).toEqual(["git", "rg"]);
    expect(cliPolicyFromRoute({}).allowList).toBeUndefined();
    expect(cliPolicyFromRoute(undefined).allowList).toBeUndefined();
    // non-string members are filtered out
    expect(cliPolicyFromRoute({ allowedBins: ["git", 5, null] }).allowList).toEqual(["git"]);
  });

  it("strips loader/interpreter-hijack env vars (PATH, LD_PRELOAD, DYLD_*, NODE_OPTIONS)", () => {
    const cleaned = sanitizeCliEnv({
      PATH: "/attacker/bin",
      LD_PRELOAD: "/tmp/evil.so",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      NODE_OPTIONS: "--require /tmp/evil.js",
      MY_SAFE_VAR: "ok",
    });
    expect(cleaned).toEqual({ MY_SAFE_VAR: "ok" });
    expect(cleaned).not.toHaveProperty("PATH");
    expect(cleaned).not.toHaveProperty("LD_PRELOAD");
  });

  it("BLOCKED_ENV_VARS covers the loader hijack surface", () => {
    for (const v of ["PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV"]) {
      expect(BLOCKED_ENV_VARS.has(v)).toBe(true);
    }
  });
});

describe("isAllowedHost — local-rest SSRF (#3)", () => {
  it("DENIES the cloud-metadata SSRF target 169.254.169.254", () => {
    const d = isAllowedHost("http://169.254.169.254/latest/meta-data/");
    expect(d.allowed).toBe(false);
    expect(d.loopback).toBe(false);
    expect(d.reason).toBe("non_loopback_host");
  });

  it("DENIES an arbitrary attacker host", () => {
    expect(isAllowedHost("http://attacker.example/steal").allowed).toBe(false);
    expect(isAllowedHost("https://evil.example.com/x").allowed).toBe(false);
  });

  it("DENIES LAN / link-local / any-interface IPs", () => {
    for (const u of [
      "http://192.168.1.50/x",
      "http://10.0.0.5/x",
      "http://172.16.0.1/x",
      "http://0.0.0.0/x",
      "http://169.254.10.10/x",
    ]) {
      expect(isAllowedHost(u).allowed).toBe(false);
    }
  });

  it("DENIES a host that merely CONTAINS a loopback substring (no rebinding bypass)", () => {
    expect(isAllowedHost("http://127.0.0.1.evil.com/x").allowed).toBe(false);
    expect(isAllowedHost("http://localhost.evil.com/x").allowed).toBe(false);
    expect(isAllowedHost("http://notlocalhost/x").allowed).toBe(false);
  });

  it("ALLOWS loopback in all forms, any port", () => {
    for (const u of [
      "http://127.0.0.1:27123/x",
      "http://localhost:5000/x",
      "http://[::1]:8080/x",
      "http://127.5.5.5/x", // 127.0.0.0/8 is entirely loopback
      "https://localhost/x",
    ]) {
      const d = isAllowedHost(u);
      expect(d.allowed).toBe(true);
      expect(d.loopback).toBe(true);
    }
  });

  it("ALLOWS an explicit user-confirmed host (and only that host)", () => {
    const policy = { allowedHosts: ["api.internal.example"] };
    const d = isAllowedHost("http://api.internal.example/x", policy);
    expect(d.allowed).toBe(true);
    expect(d.loopback).toBe(false);
    // a different host is still denied under the same policy
    const d2 = isAllowedHost("http://attacker.example/x", policy);
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe("not_in_host_allow_list");
  });

  it("host allow-list entry with a pinned port only matches that port", () => {
    const policy = { allowedHosts: ["api.example:8080"] };
    expect(isAllowedHost("http://api.example:8080/x", policy).allowed).toBe(true);
    expect(isAllowedHost("http://api.example:9090/x", policy).allowed).toBe(false);
  });

  it("DENIES a malformed base URL", () => {
    const d = isAllowedHost("not a url");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("malformed_url");
  });

  it("restPolicyFromRoute reads allowedHosts off the open route bag", () => {
    expect(restPolicyFromRoute({ allowedHosts: ["a.example"] }).allowedHosts).toEqual(["a.example"]);
    expect(restPolicyFromRoute({}).allowedHosts).toBeUndefined();
  });
});
