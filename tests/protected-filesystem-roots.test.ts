import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { confineToVault, readVaultPath, searchVault } from "@plexus/runtime/sources/obsidian/vault-reader.ts";
import { RealWorkspaceProvider } from "@plexus/runtime/sources/workspace/provider.ts";
import { wsList, wsRead, wsWrite } from "@plexus/runtime/sources/workspace/ops.ts";
import { vaultPathHealth } from "@plexus/runtime/sources/obsidian/open-vault.ts";
import { RealSysinfoProvider } from "@plexus/runtime/sources/sysinfo/provider.ts";

let root: string; let management: string; let material: string;
const savedHome = process.env.PLEXUS_HOME; const savedProtected = process.env.PLEXUS_PROTECTED_PATHS;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plexus-protected-"));
  management = join(root, "private-management"); material = join(root, "material");
  mkdirSync(management); mkdirSync(material);
  writeFileSync(join(management, "connection-key"), "never-visible-key");
  writeFileSync(join(material, "note.md"), "ordinary material");
  process.env.PLEXUS_HOME = management; delete process.env.PLEXUS_PROTECTED_PATHS;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.PLEXUS_HOME; else process.env.PLEXUS_HOME = savedHome;
  if (savedProtected === undefined) delete process.env.PLEXUS_PROTECTED_PATHS; else process.env.PLEXUS_PROTECTED_PATHS = savedProtected;
  rmSync(root, { recursive: true, force: true });
});
const SAFE = "Filesystem resource overlaps protected application storage.";

describe("first-party protected filesystem roots", () => {
  it("rejects root equality, ancestor and descendant for read/list/write with fixed path-free errors", async () => {
    mkdirSync(join(management, "child"));
    for (const exposed of [root, management, join(management, "child")]) {
      const provider = new RealWorkspaceProvider(exposed);
      for (const result of [await wsList(provider, {}), await wsRead(provider, { path: "connection-key" }), await wsWrite(provider, { path: "new.txt", content: "mutated" })]) {
        expect(result.ok).toBe(false); const output = JSON.stringify(result);
        expect(output).toContain(SAFE); expect(output).not.toContain(management); expect(output).not.toContain("never-visible-key");
      }
      await expect(readVaultPath(exposed, "")).rejects.toThrow(SAFE);
      await expect(searchVault(exposed, "key")).rejects.toThrow(SAFE);
      expect(JSON.stringify(await provider.available())).not.toContain(management);
      expect(vaultPathHealth(exposed).detail).toBe(SAFE);
      expect(existsSync(join(exposed, "new.txt"))).toBe(false);
    }
    expect(readFileSync(join(management, "connection-key"), "utf8")).toBe("never-visible-key");
  });
  it("denies configured aliases and protected aliases in either root direction", async () => {
    const alias = join(root, "alias"); symlinkSync(management, alias);
    await expect(readVaultPath(alias, "connection-key")).rejects.toThrow(SAFE);
    process.env.PLEXUS_PROTECTED_PATHS = JSON.stringify([join(alias, "child-not-created")]);
    await expect(readVaultPath(management, "")).rejects.toThrow(SAFE);
    const product = join(root, "product"); mkdirSync(product);
    const productAlias = join(root, "product-alias"); symlinkSync(product, productAlias);
    process.env.PLEXUS_PROTECTED_PATHS = JSON.stringify([productAlias]);
    await expect(readVaultPath(product, "")).rejects.toThrow(SAFE);
    await expect(new RealWorkspaceProvider(join(product, "future")).write("new.txt", "secret")).rejects.toThrow(SAFE);
  });
  it("refuses protected symlink content, listings and nonexistent writes through an existing alias", async () => {
    symlinkSync(management, join(material, "private-alias"));
    await expect(readVaultPath(material, "private-alias/connection-key")).rejects.toThrow(SAFE);
    await expect(readVaultPath(material, "")).rejects.toThrow(SAFE);
    await expect(searchVault(material, "key")).rejects.toThrow(SAFE);
    await expect(new RealWorkspaceProvider(material).write("private-alias/future/file.txt", "mutated")).rejects.toThrow(SAFE);
    expect(existsSync(join(management, "future"))).toBe(false);
  });
  it("fails closed for malformed protected-root configuration before disclosing or writing material", async () => {
    for (const raw of ["not-json", "{}", '["relative/path"]', '[null]', '"/absolute"']) {
      process.env.PLEXUS_PROTECTED_PATHS = raw;
      await expect(readVaultPath(material, "note.md")).rejects.toThrow("Invalid protected filesystem configuration.");
      await expect(new RealWorkspaceProvider(material).write("new.txt", "mutated")).rejects.toThrow("Invalid protected filesystem configuration.");
    }
    expect(existsSync(join(material, "new.txt"))).toBe(false);
  });
  it("keeps dedicated material read/list/write/search available and protects sysinfo logs", async () => {
    const provider = new RealWorkspaceProvider(material);
    await provider.write("nested/new.md", "written material");
    expect((await provider.read("nested/new.md")).type).toBe("file");
    expect((await provider.read("")).type).toBe("dir");
    expect((await searchVault(material, "written")).hits).toHaveLength(1);
    await expect(new RealSysinfoProvider({ logRoot: management }).readLog("connection-key", 10)).rejects.toThrow(SAFE);
  });
  it("protects default Plexus home even without an environment override", () => {
    delete process.env.PLEXUS_HOME;
    expect(() => confineToVault(join(homedir(), ".plexus"), "")).toThrow(SAFE);
  });
});
