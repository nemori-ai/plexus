/**
 * Shared, deterministic shell-emission helpers for the integration RENDERERS
 * (render-plugin.ts, render-generic.ts) + the VERIFIER (verify-plugin.ts).
 *
 * WHY SHARED — the renderers emit self-contained `bash` bootstraps (install.sh / setup.sh)
 * from inline heredocs, and the verifier byte-compares the embedded engine against the
 * committed SSOT. Both sides MUST agree on the tiny transforms (single-quoting, the
 * one-trailing-newline strip the heredocs re-add), or the byte-compare drifts and a valid
 * artifact fails verification. Keeping them in ONE module is the forcing function for that
 * agreement (render-plugin's `stripOneTrailingNewline` comment literally said "MUST match the
 * verifier's").
 *
 * SECURITY — `assertSafeAgentId` is the structural guarantee behind the shell emitters: an
 * agentId flows into shell COMMENTS, curl URLs, and heredoc bodies where single-quoting a
 * comment is meaningless. Rather than escape each site (and hope none is missed), we REFUSE to
 * render a shell artifact for an agentId that is not a safe slug — so no interpolation point can
 * ever inject a live shell line, even if a malicious id slipped past the connect-time check.
 */

/** Strip trailing slashes from a URL/base (idempotent). */
export function stripSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Assert a value is a non-empty string (after trim), else throw with `name` in the message. */
export function requireNonEmpty(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return v;
}

/** Single-quote a value for safe LITERAL use in generated POSIX shell (`'…'` with `'\''` escapes). */
export function shSingleQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Strip exactly one trailing newline (the heredoc re-adds it) — MUST match across render/verify. */
export function stripOneTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/**
 * The ONLY agentId shape the shell emitters will render. A safe slug — ASCII letters/digits and
 * `._-` only, 1–200 chars — has NO newline, whitespace, or shell metacharacter, so it is inert
 * in a comment, a curl URL, a filesystem path, and a single-quoted assignment alike. The
 * connect endpoint enforces the SAME shape up front (fail-fast, 400); this is the render-time
 * belt-and-suspenders that refuses to emit a live-shell-injecting artifact if a bad id ever
 * reaches a renderer through another path.
 */
export const SAFE_AGENT_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** Throw unless `agentId` is a safe slug ({@link SAFE_AGENT_ID}); returns it on success. */
export function assertSafeAgentId(agentId: unknown): string {
  if (typeof agentId !== "string" || !SAFE_AGENT_ID.test(agentId)) {
    throw new Error(
      `unsafe agentId — must match ${SAFE_AGENT_ID} (ASCII letters/digits and ._-, 1–200 chars, ` +
        `no whitespace/newline/shell metacharacters); refusing to render a shell artifact`,
    );
  }
  return agentId;
}

/**
 * Guard against a heredoc-terminator collision: an inlined file body must never contain a LINE
 * exactly equal to its terminator (that would truncate the file). Throws with `name` for a clear
 * error. Our fixed delimiters can't collide with real content, but this stays defensive.
 */
export function assertNoHeredocCollision(body: string, delim: string, name: string): void {
  if (body.split("\n").some((line) => line === delim)) {
    throw new Error(`heredoc delimiter '${delim}' collides with ${name} content`);
  }
}
