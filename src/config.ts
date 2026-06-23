/**
 * Gateway runtime configuration. Loopback-only bind, default port 7077.
 * Pure data + helpers; no business logic.
 */

import { PLEXUS_PROTOCOL_VERSION } from "./protocol/index.ts";

/** Gateway implementation version (package version). */
export const PLEXUS_VERSION = "0.1.0";

/** Self-describe protocol version advertised in `.well-known` (e.g. "0.1"). */
export const PLEXUS_PROTOCOL = PLEXUS_PROTOCOL_VERSION.split(".").slice(0, 2).join(".");

export interface GatewayConfig {
  /** Loopback host — NEVER 0.0.0.0 (§5 security model). */
  readonly host: "127.0.0.1";
  /** Bound port. */
  readonly port: number;
  /** Optional friendly instance name set by the user. */
  readonly instance?: string;
}

const DEFAULT_PORT = 7077;

/** Resolve config from env, defaulting to loopback:7077. */
export function loadConfig(): GatewayConfig {
  const portEnv = process.env.PLEXUS_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : DEFAULT_PORT;
  const instance = process.env.PLEXUS_INSTANCE;
  return {
    host: "127.0.0.1",
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    ...(instance ? { instance } : {}),
  };
}

/** The loopback base URL the gateway binds to, e.g. "http://127.0.0.1:7077". */
export function baseUrl(config: GatewayConfig): string {
  return `http://${config.host}:${config.port}`;
}

/** The exact loopback authority the Host header must match (§5b HostOriginPolicy). */
export function expectedHost(config: GatewayConfig): string {
  return `${config.host}:${config.port}`;
}
