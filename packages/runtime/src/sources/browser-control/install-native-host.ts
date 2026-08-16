/**
 * Register the native messaging host with Chrome.
 *
 * Two files, both under the owner's own directories: a launcher Chrome can execute, and the
 * manifest that tells Chrome which extension may execute it. The manifest's `allowed_origins` is
 * the security boundary — Chrome refuses to start this host for any other extension — so it
 * names exactly one id and never a wildcard.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { homePath } from "../../core/paths.ts";

/** Fixed by the public key pinned in the extension manifest, so it does not move with the path. */
export const EXTENSION_ID = "ignlhljcefbhanjbhaokkcjpcblgkjli";
export const HOST_NAME = "com.plexus.browser_control";

/** Where each Chromium family reads native-host manifests from, on macOS. */
const MANIFEST_DIRS: Record<string, string> = {
  chrome: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  chromium: "Library/Application Support/Chromium/NativeMessagingHosts",
  edge: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
  brave: "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
};

export interface InstallResult {
  launcher: string;
  manifests: string[];
}

/**
 * Write the launcher and the manifests.
 *
 * The launcher hard-codes ABSOLUTE paths to both the runtime and this script: Chrome starts a
 * host from its own environment, which is launchd's, and that PATH does not include a
 * user-installed `bun`. A shebang that resolves from PATH works from a terminal and fails when
 * Chrome does it.
 */
export function installNativeHost(opts: { runtime?: string; script?: string; home?: string } = {}): InstallResult {
  const runtime = opts.runtime ?? process.execPath;
  const script = opts.script ?? resolve(new URL("./native-host.ts", import.meta.url).pathname);
  const launcher = homePath("chrome", "plexus-native-host");
  mkdirSync(dirname(launcher), { recursive: true });
  // PLEXUS_HOME is threaded EXPLICITLY: the host must find the same gateway state directory the
  // gateway used, and Chrome will not pass the owner's shell environment.
  writeFileSync(
    launcher,
    `#!/bin/sh\nexport PLEXUS_HOME=${JSON.stringify(homePath())}\nexec ${JSON.stringify(runtime)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(launcher, 0o755);

  const home = opts.home ?? homedir();
  const manifests: string[] = [];
  for (const dir of Object.values(MANIFEST_DIRS)) {
    const target = join(home, dir);
    try {
      mkdirSync(target, { recursive: true });
    } catch {
      continue; // a browser family that is not installed needs no manifest
    }
    const path = join(target, `${HOST_NAME}.json`);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          name: HOST_NAME,
          description: "Plexus browser control bridge",
          path: launcher,
          type: "stdio",
          allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
        },
        null,
        2,
      )}\n`,
    );
    manifests.push(path);
  }
  return { launcher, manifests };
}

if (import.meta.main) {
  const res = installNativeHost();
  console.log(`[plexus] native host installed: ${res.launcher}`);
  for (const m of res.manifests) console.log(`[plexus]   manifest: ${m}`);
  console.log(`[plexus] load the extension from extension/plexus-browser (id ${EXTENSION_ID})`);
}
