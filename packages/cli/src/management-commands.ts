/**
 * Trusted Product-host management only. The native management binary deliberately
 * has no agent handshake/call commands, arbitrary request path, key flag or default
 * home. Credentials come from the Product's explicit private state directory.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

type ObjectBody = Record<string, unknown>;
type RequestPlan = { path: string; method: "GET" | "POST" | "DELETE"; body?: ObjectBody };

class ManagementFailure extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) { super(message); }
}
function invalid(): never {
  throw new ManagementFailure("invalid_management_request", "Invalid Plexus management command or input.", 2);
}
function object(raw: unknown): ObjectBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  return raw as ObjectBody;
}
function fields(body: ObjectBody, allowed: readonly string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._:-]{0,199}$/.test(value)) invalid();
  return value;
}
function optionalString(body: ObjectBody, key: string) {
  if (body[key] !== undefined && (typeof body[key] !== "string" || (body[key] as string).length > 2000)) invalid();
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) invalid();
  return value.map(id);
}
function trustWindow(body: ObjectBody) {
  if (body.trustWindow === undefined) return;
  const window = object(body.trustWindow);
  fields(window, ["kind", "ms"]);
  if (!["once", "1h", "1d", "7d", "until-revoked", "custom"].includes(String(window.kind))) invalid();
  if (window.kind === "custom" && (typeof window.ms !== "number" || !Number.isFinite(window.ms) || window.ms <= 0)) invalid();
  if (window.ms !== undefined && (typeof window.ms !== "number" || !Number.isFinite(window.ms) || window.ms <= 0)) invalid();
}
const READS: Record<string, string> = {
  "capabilities list": "/capabilities", "agent list": "/agents/enrollments",
  "pending list": "/pending", "exposure list": "/exposure",
  "source list": "/sources", "source catalog": "/connectors",
};
async function readBody(): Promise<ObjectBody> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = Bun.stdin.stream().getReader();
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 1_048_576) invalid();
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return invalid(); }
}
async function plan(command: string): Promise<RequestPlan> {
  if (Object.hasOwn(READS, command)) return { path: READS[command]!, method: "GET" };
  if (!["agent connect", "agent revoke", "pending resolve", "exposure set", "source add", "source remove"].includes(command)) invalid();
  const body = await readBody();
  switch (command) {
    case "agent connect":
      fields(body, ["agentId", "capabilities", "standing", "agentType", "trustWindow", "ttlMs"]);
      id(body.agentId); strings(body.capabilities);
      if (body.standing !== undefined) strings(body.standing);
      if (body.agentType !== undefined && body.agentType !== "generic") invalid();
      if (body.ttlMs !== undefined && (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0)) invalid();
      trustWindow(body);
      return { path: "/agents/connect", method: "POST", body };
    case "agent revoke":
      fields(body, ["agentId", "reason"]); id(body.agentId); optionalString(body, "reason");
      return { path: "/agents/revoke", method: "POST", body };
    case "pending resolve": {
      fields(body, ["id", "action", "reason", "trustWindow", "agentId"]);
      const pendingId = id(body.id);
      if (body.action !== "approve" && body.action !== "deny") invalid();
      optionalString(body, "reason");
      if (body.agentId !== undefined) id(body.agentId);
      trustWindow(body);
      const { id: _, ...payload } = body;
      return { path: `/pending/${encodeURIComponent(pendingId)}`, method: "POST", body: payload };
    }
    case "exposure set":
      fields(body, ["id", "enabled"]); id(body.id);
      if (typeof body.enabled !== "boolean") invalid();
      return { path: `/exposure/${encodeURIComponent(body.id as string)}`, method: "POST", body: { enabled: body.enabled } };
    case "source remove":
      fields(body, ["id"]);
      return { path: `/sources/${encodeURIComponent(id(body.id))}`, method: "DELETE", body: {} };
    case "source add":
      // ConfiguredSource is validated by its owning runtime endpoint. This command
      // does not accept an HTTP path/method or a secret-file option.
      fields(body, ["id", "kind", "label", "enabled", "transport", "route", "secretRef", "approval", "metadata"]);
      id(body.id); id(body.kind);
      if (typeof body.label !== "string" || typeof body.enabled !== "boolean" || typeof body.transport !== "string") invalid();
      if (body.route !== undefined) object(body.route);
      if (body.secretRef !== undefined) id(body.secretRef);
      return { path: "/sources", method: "POST", body };
    default: return invalid();
  }
}

/** Emits exactly one JSON line; errors never include upstream text, input or paths. */
export async function runManagement(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 4 || argv[2] !== "--origin") invalid();
    const origin = argv[3]!;
    // Require a canonical literal loopback origin. Reject credentials, paths,
    // query, fragments, alternate encodings, DNS names and redirects.
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) invalid();
    const url = new URL(origin);
    if (Number(url.port || "80") > 65535) invalid();
    const home = process.env.PLEXUS_HOME;
    if (!home || !isAbsolute(home)) throw new ManagementFailure("management_home_required", "An explicit absolute PLEXUS_HOME is required.", 2);
    const request = await plan(`${argv[0]} ${argv[1]}`);
    let key: string;
    try { key = readFileSync(join(home, "connection-key"), "utf8").trim(); }
    catch { throw new ManagementFailure("management_unavailable", "Plexus management credentials are unavailable."); }
    if (!key) throw new ManagementFailure("management_unavailable", "Plexus management credentials are unavailable.");
    const response = await fetch(`${origin}/admin/api${request.path}`, {
      method: request.method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "X-Plexus-Connection-Key": key, accept: "application/json", "content-type": "application/json" },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    if (!response.ok) throw new ManagementFailure("management_request_failed", "Plexus management request failed.");
    const data: unknown = await response.json();
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
    return 0;
  } catch (error) {
    const failure = error instanceof ManagementFailure ? error : new ManagementFailure("management_request_failed", "Plexus management request failed.");
    process.stdout.write(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }) + "\n");
    return failure.exitCode;
  }
}
