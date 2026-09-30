#!/usr/bin/env bun
/** Build the relocatable native distribution consumed by trusted Product hosts. */
import { $ } from "bun";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PLEXUS_PROTOCOL_VERSION } from "../../protocol/src/index.ts";
import { PLEXUS_VERSION } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = join(root, "dist/plexus-host-darwin-arm64");
const target = "bun-darwin-arm64";
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
function files(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "bin"), { recursive: true });
mkdirSync(join(output, "assets"), { recursive: true });
await $`bun run --cwd ${join(root, "packages/web-admin")} build`.cwd(root);
await $`bun build --compile --target=${target} ${join(root, "packages/runtime/src/index.ts")} --outfile ${join(output, "bin/plexus-runtime")}`.cwd(root);
await $`bun build --compile --target=${target} ${join(root, "packages/cli/src/management-bin.ts")} --outfile ${join(output, "bin/plexus-management")}`.cwd(root);
// Bun compilation can leave a stale Mach-O signature. Sign before hashing so
// the shipped local-development artifacts execute after relocation on macOS.
if (process.platform !== "darwin") throw new Error("Build this macOS host distribution on macOS for signing");
for (const name of ["plexus-runtime", "plexus-management"]) {
  await $`codesign --force --sign - ${join(output, "bin", name)}`;
  await $`codesign --verify --strict ${join(output, "bin", name)}`;
}
cpSync(join(root, "packages/web-admin/dist"), join(output, "assets/web-admin"), { recursive: true });
const staticFiles = [
  ...files(join(root, "packages/runtime/src/sources")).filter((p) => p.endsWith(".md") && p.includes("/skills/")),
  join(root, "packages/runtime/src/integration/templates/skill-body.md"),
  join(root, "tools/plexus-cli/plexus"),
  ...files(join(root, "integrations")).filter((p) => p.endsWith(".md")),
  join(root, "docs/extension-authoring.md"),
];
for (const path of staticFiles) {
  const repoPath = relative(root, path);
  const packagedPath = repoPath.replace(/^packages\/runtime\/src\//, "runtime/");
  const dest = join(output, "assets", packagedPath);
  mkdirSync(dirname(dest), { recursive: true }); cpSync(path, dest);
}
for (const name of ["LICENSE", "docs/host-integration.md"]) cpSync(join(root, name), join(output, name === "LICENSE" ? name : "README.md"));
const commit = (await $`git rev-parse HEAD`.cwd(root).quiet().text()).trim();
const tracked = (await $`git ls-files -z --cached --others --exclude-standard`.cwd(root).quiet().text()).split("\0").filter(Boolean).sort();
const sourceFiles = tracked.filter((name) => /^(packages\/(runtime|cli|protocol|web-admin)\/|tools\/plexus-cli\/|integrations\/|docs\/host-integration.md$|docs\/extension-authoring.md$|bun.lock$|package.json$)/.test(name));
const sourceFileHashes = Object.fromEntries(sourceFiles.map((name) => [name, digest(readFileSync(join(root, name)))]));
const sourceTreeSha256 = digest(JSON.stringify(sourceFileHashes));
const artifactFiles = Object.fromEntries(files(output).map((path) => [relative(output, path), { sha256: digest(readFileSync(path)), size: statSync(path).size }]));
writeFileSync(join(output, "manifest.json"), JSON.stringify({
  schemaVersion: 1, name: "plexus-host", version: PLEXUS_VERSION, protocolVersion: PLEXUS_PROTOCOL_VERSION,
  platform: "darwin", arch: "arm64", target, bunVersion: Bun.version, signing: "ad-hoc",
  source: { commit, treeSha256: sourceTreeSha256, files: sourceFileHashes },
  runtime: "bin/plexus-runtime", management: "bin/plexus-management", assetRoot: "assets", files: artifactFiles,
}, null, 2) + "\n");
await $`tar -czf ${output + ".tar.gz"} -C ${dirname(output)} ${"plexus-host-darwin-arm64"}`;
writeFileSync(output + ".tar.gz.sha256", `${digest(readFileSync(output + ".tar.gz"))}  plexus-host-darwin-arm64.tar.gz\n`);
console.log(`Host distribution: ${output}`);
