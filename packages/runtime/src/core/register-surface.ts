/**
 * Build the SECURITY-SENSITIVE approval surface for a pending extension registration
 * (m4sec-auth register-confirm). Surfaces — for the human approving in the management
 * client — exactly what authority a `POST /extensions` manifest is asking for:
 *
 *   - every capability it contributes (id / kind / transport / verbs),
 *   - the cli BINARIES it wants to spawn (the #2 RCE surface),
 *   - the non-loopback REST HOSTS it wants to reach (the #3 SSRF / secret-redirect surface),
 *   - any CROSS-SOURCE skill attaches (the #6 prompt-injection channel),
 *   - whether it is transport-backed (cli/local-rest/stdio/ipc).
 *
 * Pure projection over the manifest + the m4sec-trans `cliPolicyFromRoute` /
 * `restPolicyFromRoute` seams (which read the open `route` bag). No mutation, no commit.
 */

import type { ExtensionManifest, SourceId } from "@plexus/protocol";
import { manifestEntries } from "../sources/extension.ts";
import {
  cliPolicyFromRoute,
  restPolicyFromRoute,
} from "../transports/transport-policy.ts";
import type { RegisterApprovalSurface } from "./grant-service.ts";

const TRANSPORT_BACKED = new Set(["cli", "local-rest", "stdio", "ipc"]);

/** Read a string field off the open route bag (defensive — wire JSON is untrusted). */
function routeStr(route: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = route?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function buildRegisterSurface(
  manifest: ExtensionManifest,
  crossSourceProvenance: Record<string, SourceId[]>,
): RegisterApprovalSurface {
  const cliBins = new Set<string>();
  const restHosts = new Set<string>();
  let transportBacked = false;

  const capabilities = (manifest.capabilities ?? []).map((decl) => {
    const transport = decl.transport ?? manifest.transport;
    const route = decl.route as Record<string, unknown> | undefined;
    if (TRANSPORT_BACKED.has(transport)) transportBacked = true;

    if (transport === "cli") {
      const bin = routeStr(route, "bin");
      if (bin) cliBins.add(bin);
      // The user-confirmed allow-list the extension declares is part of the surface too.
      for (const b of cliPolicyFromRoute(route).allowList ?? []) cliBins.add(b);
    }
    if (transport === "local-rest") {
      const baseUrl = routeStr(route, "baseUrl");
      if (baseUrl) {
        try {
          restHosts.add(new URL(baseUrl).host);
        } catch {
          restHosts.add(baseUrl);
        }
      }
      for (const h of restPolicyFromRoute(route).allowedHosts ?? []) restHosts.add(h);
    }

    // Derive the id the way materialization will (sourceSlug.name).
    const id =
      manifestEntries(manifest).find((e) => e.id.endsWith(`.${decl.name}`))?.id ??
      `${manifest.source.replace(/:/g, ".")}.${decl.name}`;

    return {
      id,
      label: decl.label,
      kind: decl.kind,
      transport,
      verbs: decl.grants ?? [],
    };
  });

  const crossSource = Object.entries(crossSourceProvenance).map(([id, sources]) => ({
    id,
    sources,
  }));

  return {
    source: manifest.source,
    label: manifest.label,
    capabilities,
    cliBins: [...cliBins],
    restHosts: [...restHosts],
    crossSource,
    transportBacked,
  };
}
