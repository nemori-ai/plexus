/** Trusted host-selected immutable distribution assets; never agent-controlled. */
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function assetPath(packagedRelativePath: string, checkoutUrl: URL): string {
  const root = process.env.PLEXUS_ASSET_ROOT;
  if (!root) return fileURLToPath(checkoutUrl);
  if (!isAbsolute(root)) throw new Error("PLEXUS_ASSET_ROOT must be absolute");
  const path = join(root, packagedRelativePath);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Invalid packaged asset path");
  return path;
}
