/**
 * `@plexus/desktop` pure-helper barrel — the OS/GUI-independent core of the
 * Electron desktop shell (P2). The Electron main process (`main/`) imports these;
 * the unit tests exercise them directly with no Electron/sockets.
 */
export * from "./port-discovery.ts";
export * from "./badge.ts";
export * from "./notification.ts";
export * from "./lra-client.ts";
export * from "./sse.ts";
export * from "./runtime-resolver.ts";
