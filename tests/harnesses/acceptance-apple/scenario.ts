/**
 * ============================================================================
 * Plexus ACCEPTANCE SCENARIO — "codex integrates Plexus's new Apple-native
 * first-party sources, gets authorized, runs a daily-review task, and the user
 * audits + revokes."  (the玩法 / playthrough)
 * ============================================================================
 *
 * THE STORY (user-perspective, end-to-end, HERMETIC + REPEATABLE):
 *
 *   A user wires a **codex agent** into Plexus. Plexus now ships THREE first-party,
 *   Apple-native sources out of the box (no admin source-add needed):
 *     • apple-calendar  (read)        — the user's calendars + events,
 *     • apple-reminders (read+write)  — lists, reminders, create/complete,
 *     • apple-notes     (read+create) — folders, search, read, create-a-note.
 *
 *   codex DISCOVERS them on `GET /.well-known/plexus` (each first-party, each with a
 *   health snapshot), HANDSHAKES, and requests the grants its task needs:
 *   `apple-calendar.events.list` (read → auto-approves, first-party), plus the two
 *   first-party-elevated WRITES `apple-reminders.reminders.create` and
 *   `apple-notes.notes.create` (which PEND → the user clicks Approve via the
 *   connection-key approve-loop). Tokens minted, codex then runs the dispatched task:
 *
 *      "Review today's calendar and create a follow-up reminder + a prep note
 *       for the day."
 *
 *   codex lists today's events, composes a deterministic follow-up from them, creates
 *   the reminder, creates the prep note, and VERIFIES both writes landed (reminders.list
 *   shows the new reminder; notes.search finds the new note). The user then AUDITS
 *   the full ordered chain and REVOKES the reminders-write grant — proving the old token
 *   is now rejected (`token_revoked`/401) while the calendar read still works.
 *
 * Everything runs through the REAL gateway pipeline (real discover → real handshake →
 * real grants+approve → real token mint → real invoke → real audit → real revoke). The
 * only things "scripted" are the codex agent itself (this file, faithfully doing what
 * codex would do over the HTTP API) and the human approvals (a background loop that
 * approves pending items — modeling the user clicking "Approve" in the management UI).
 *
 * HERMETICITY:
 *   - `PLEXUS_FAKE_APPLE=1` selects the FAKE Apple providers — deterministic in-memory
 *     fixtures, NO real macOS, NO TCC permission, NO `osascript`, NO Calendar/Reminders/
 *     Notes app, NO network. The write capabilities mutate the in-memory fixtures.
 *   - temp `PLEXUS_HOME` (signing secret + audit live here),
 *   - the gateway runs IN-PROCESS via `app.request` (fetch-shaped; same pipeline, no
 *     socket — never binds :7077),
 *   - the three Apple sources are first-party + auto-registered (compile-time MODULES),
 *     so there is no admin source-add step.
 *
 * This module is BOTH a runnable demo (`run.ts` calls `runScenario` + prints the
 * transcript) AND the engine `tests/acceptance-apple-e2e.test.ts` asserts against (it
 * returns a structured `ScenarioReport` of the genuine facts).
 *
 * LIVE / real-TCC variant: with `PLEXUS_FAKE_APPLE` UNSET on a real Mac, the same
 * sources shell out to `osascript`/JXA and the first live use
 * triggers the macOS TCC consent prompts (Privacy ▸ Calendars / Reminders / Automation).
 * That is a separate, NON-hermetic manual smoke — see README. This harness never does it.
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, expectedHost } from "@plexus/runtime/config.ts";
import { createAppWithState } from "@plexus/runtime/core/server.ts";
import { createSourceRegistry } from "@plexus/runtime/core/registry.ts";
import { createCapabilityRegistry } from "@plexus/runtime/core/capability-registry.ts";
import { GrantService } from "@plexus/runtime/core/grant-service.ts";
import { _resetSecretCacheForTests, defaultAuthorizer } from "@plexus/runtime/auth/index.ts";
import { getPlatformServices } from "@plexus/runtime/platform/index.ts";

import {
  APPLE_CALENDAR_SOURCE_ID,
  CALENDARS_LIST_ID,
  EVENTS_LIST_ID,
} from "@plexus/runtime/sources/apple-calendar/entries.ts";
import {
  APPLE_REMINDERS_SOURCE_ID,
  REMINDERS_LIST_ID,
  REMINDERS_CREATE_ID,
} from "@plexus/runtime/sources/apple-reminders/entries.ts";
import {
  APPLE_NOTES_SOURCE_ID,
  NOTES_SEARCH_ID,
  NOTES_CREATE_ID,
} from "@plexus/runtime/sources/apple-notes/entries.ts";

import type {
  HandshakeResponse,
  InvokeResponse,
  ScopedToken,
  AuditEvent,
  CapabilitySummary,
} from "@plexus/protocol";

// Re-export the capability ids the test asserts on (single source of truth).
export {
  APPLE_CALENDAR_SOURCE_ID,
  CALENDARS_LIST_ID,
  EVENTS_LIST_ID,
  APPLE_REMINDERS_SOURCE_ID,
  REMINDERS_LIST_ID,
  REMINDERS_CREATE_ID,
  APPLE_NOTES_SOURCE_ID,
  NOTES_SEARCH_ID,
  NOTES_CREATE_ID,
};

// ──────────────────────────────────────────────────────────────────────────────────
// Reporting shapes — the genuine facts the test asserts against.
// ──────────────────────────────────────────────────────────────────────────────────

export interface StepCheck {
  ok: boolean;
  label: string;
  detail?: string;
}

/** A discovered first-party Apple capability summary (for the transcript + asserts). */
export interface DiscoveredCap {
  id: string;
  provenance?: string;
  health?: string;
  grants: string[];
}

/** A calendar event codex saw for today's window. */
export interface SeenEvent {
  title: string;
  start: string;
  end: string;
  calendar: string;
}

export interface ScenarioReport {
  pass: boolean;
  checks: StepCheck[];
  /** The session id from the handshake. */
  sessionId: string;
  /** The registered agent's client identity (name/version/agentId). */
  agent: { name: string; version?: string; agentId?: string };
  /** The discovered first-party Apple capabilities (from `.well-known`). */
  discovered: DiscoveredCap[];
  /** The granted capability ids (events.list read, reminders.create + notes.create writes). */
  grantedCaps: string[];
  /** Which granted caps auto-approved vs. PENDED for a human (the authz story). */
  grantFlow: { id: string; pended: boolean }[];
  /** The exact task dispatched to codex. */
  task: string;
  /** The calendar events codex saw for today's window. */
  seenEvents: SeenEvent[];
  /** The follow-up subject codex composed from the events (deterministic). */
  followUpSubject: string;
  /** The reminder codex created (echoed from reminders.create). */
  createdReminder: { id: string; list: string; title: string };
  /** The prep note codex created (echoed from notes.create + verified via search). */
  createdNote: { title: string; id: string; verifiedInSearch: boolean };
  /** The reminder verified present via reminders.list after the write. */
  reminderVerifiedInList: boolean;
  /** The temp PLEXUS_HOME (for the transcript). */
  plexusHome: string;
  /** The full audit chain (ordered, oldest→newest). */
  audit: AuditEvent[];
  /** A compact "kind @ capability (outcome)" summary of the audit chain. */
  auditSummary: string[];
  /** The post-revoke re-invoke result (must be a denial). */
  revokeDenial: { status: number; code: string };
  /** Proof the calendar read still works AFTER the reminders-write revoke. */
  readStillWorksAfterRevoke: boolean;
}

export interface Logger {
  line: (s: string) => void;
  step: (tag: string, s: string) => void;
  pass: (s: string) => void;
  fail: (s: string) => void;
}

export function consoleLogger(): Logger {
  return {
    line: (s) => console.log(s),
    step: (tag, s) => console.log(`\n[${tag}] ${s}`),
    pass: (s) => console.log(`   ✓ ${s}`),
    fail: (s) => console.log(`   ✗ ${s}`),
  };
}

export function silentLogger(): Logger {
  return { line: () => {}, step: () => {}, pass: () => {}, fail: () => {} };
}

// The exact task codex is dispatched (the "派个任务..看看完成情况").
export const TASK =
  "Review today's calendar and create a follow-up reminder + a prep note for the day.";

// ──────────────────────────────────────────────────────────────────────────────────
// The scenario.
// ──────────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  logger?: Logger;
}

export async function runScenario(opts: RunOptions = {}): Promise<ScenarioReport> {
  const log = opts.logger ?? consoleLogger();
  const checks: StepCheck[] = [];
  const ok = (cond: boolean, label: string, detail?: string) => {
    checks.push({ ok: cond, label, ...(detail ? { detail } : {}) });
    (cond ? log.pass : log.fail).call(log, `${label}${detail ? ` — ${detail}` : ""}`);
    return cond;
  };

  // ── isolated temp fixtures (never touch real ~/.plexus) ───────────────────────────
  const sandbox = mkdtempSync(join(tmpdir(), "plexus-apple-acceptance-"));
  const plexusHome = join(sandbox, "plexus-home");
  mkdirSync(plexusHome, { recursive: true });

  // ── HERMETIC env: temp home + FAKE Apple providers (no macOS / TCC / network) ─────
  const priorHome = process.env.PLEXUS_HOME;
  const priorFake = process.env.PLEXUS_FAKE_APPLE;
  process.env.PLEXUS_HOME = plexusHome;
  process.env.PLEXUS_FAKE_APPLE = "1";
  _resetSecretCacheForTests();

  const config = loadConfig();
  const HOST = expectedHost(config);

  // ── boot the real gateway IN-PROCESS (fetch-shaped; same pipeline, no socket) ─────
  // The three Apple sources are first-party + auto-registered (compile-time MODULES) —
  // no admin source-add is performed anywhere in this scenario.
  const platform = getPlatformServices();
  const sources = createSourceRegistry(platform);
  const capabilities = createCapabilityRegistry(sources);
  const { app, state } = createAppWithState(config, { sources, capabilities });
  await state.capabilities.start();
  // Deterministically warm the per-source health cache so `.well-known` carries a real
  // health snapshot (start() warms it in the background; we await it for repeatability).
  for (const sourceId of [APPLE_CALENDAR_SOURCE_ID, APPLE_REMINDERS_SOURCE_ID, APPLE_NOTES_SOURCE_ID]) {
    await state.capabilities.refreshHealth(sourceId);
  }

  const adminKey = state.connectionKey.current();

  // in-process fetch helper (fetch-shaped; same pipeline, no socket).
  const req = (path: string, init?: RequestInit) =>
    app.request("http://" + HOST + path, {
      ...init,
      headers: { host: HOST, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  const adminReq = (path: string, init?: RequestInit) =>
    req(path, { ...init, headers: { "X-Plexus-Connection-Key": adminKey, ...(init?.headers ?? {}) } });

  // ── HUMAN-IN-THE-LOOP approver — models the user clicking "Approve" in the
  //    management UI. Polls the SHARED pending store (the same one /admin/api/pending
  //    reads) and approves every pending item. The grant requests still flow through
  //    real HTTP; this just drives the human-decision side programmatically.
  const approver = new GrantService(state, defaultAuthorizer());
  let approving = true;
  const approveLoop = (async () => {
    while (approving) {
      for (const p of approver.listPending()) {
        log.line(`   [user] approving pending ${p.kind} ${p.pendingId}`);
        await approver.approve(p.pendingId);
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();

  // captured evidence
  let sessionId = "";
  const agent = { name: "codex", version: "0.1.0", agentId: "agent-codex" };
  // AUTHORIZED SUBSET (ADR-023, fail-closed): the owner connects codex with exactly the
  // capabilities this task needs — an agent-bound session sees/grants only this subset.
  // The writes stay per-use (no standing opt-in): they still PEND for the human approver.
  state.agentSubsets.set(agent.agentId, [
    EVENTS_LIST_ID,
    REMINDERS_CREATE_ID,
    REMINDERS_LIST_ID,
    NOTES_CREATE_ID,
    NOTES_SEARCH_ID,
  ]);
  let discovered: DiscoveredCap[] = [];
  const grantedCaps: string[] = [];
  const grantFlow: { id: string; pended: boolean }[] = [];
  let seenEvents: SeenEvent[] = [];
  let followUpSubject = "";
  let createdReminder = { id: "", list: "", title: "" };
  let createdNote = { title: "", id: "", verifiedInSearch: false };
  let reminderVerifiedInList = false;
  let audit: AuditEvent[] = [];
  let auditSummary: string[] = [];
  let revokeDenial = { status: 0, code: "" };
  let readStillWorksAfterRevoke = false;

  try {
    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 1 — SETUP (hermetic): the runtime is booted with PLEXUS_FAKE_APPLE=1; the
    //          three Apple sources are first-party + auto-registered (no admin add).
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("1", "SETUP — boot runtime hermetically (PLEXUS_FAKE_APPLE=1, temp PLEXUS_HOME); Apple sources auto-registered first-party");
    const capsAfter = (await (await adminReq("/admin/api/capabilities")).json()) as {
      entries: { id: string; source: string }[];
    };
    const liveIds = new Set(capsAfter.entries.map((e) => e.id));
    ok(
      liveIds.has(EVENTS_LIST_ID) && liveIds.has(REMINDERS_CREATE_ID) && liveIds.has(NOTES_CREATE_ID),
      "the three Apple sources auto-registered LIVE (no admin source-add)",
      `${[...liveIds].filter((id) => id.startsWith("apple-")).length} apple entries`,
    );

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 2 — codex INTEGRATES: discover → handshake → read manifest
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("2", "codex INTEGRATES — discover → handshake → read manifest");
    // The public `.well-known` no longer carries a catalog (authorized-subset §3.3); the
    // exposure-aware discoverable set — what it used to advertise — is read off the registry.
    const summaries: CapabilitySummary[] = state.capabilities
      .summaries()
      .filter((s) => !state.exposure?.isDisabled(s.id));
    const wantIds: string[] = [CALENDARS_LIST_ID, EVENTS_LIST_ID, REMINDERS_CREATE_ID, NOTES_CREATE_ID];
    discovered = summaries
      .filter((c) => wantIds.includes(c.id))
      .map((c) => ({
        id: c.id,
        provenance: c.provenance,
        health: c.health?.status,
        grants: c.grants,
      }));
    ok(
      summaries.some((c) => c.id === EVENTS_LIST_ID) &&
        summaries.some((c) => c.id === REMINDERS_CREATE_ID) &&
        summaries.some((c) => c.id === NOTES_CREATE_ID),
      "discover lists the apple-calendar / apple-reminders / apple-notes capabilities",
    );
    const allFirstParty = discovered.every((d) => d.provenance === "first-party");
    ok(allFirstParty, "every discovered Apple capability is provenance:first-party");
    const allHaveHealth = discovered.every((d) => typeof d.health === "string" && d.health.length > 0);
    ok(allHaveHealth, "every discovered Apple capability carries a health field", discovered.map((d) => `${d.id.split(".").slice(0, 1)}=${d.health}`).join(", "));

    const hs = (await (await req("/link/handshake", {
      method: "POST",
      body: JSON.stringify({ connectionKey: adminKey, client: agent }),
    })).json()) as HandshakeResponse;
    sessionId = hs.sessionId;
    ok(!!sessionId, "handshake established a session (codex registered)", `${agent.name} / ${agent.agentId}`);
    const manifestIds = new Set(hs.manifest.entries.map((e) => e.id));
    ok(
      manifestIds.has(EVENTS_LIST_ID) && manifestIds.has(REMINDERS_CREATE_ID) && manifestIds.has(NOTES_CREATE_ID),
      "manifest contains the three task capabilities",
    );

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 3 — GRANTS ("为他授权对应功能"): request events.list (read), reminders.create
    //          (write), apple-notes.notes.create (write). The READ auto-approves (first-party);
    //          the WRITES PEND → the user (approve-loop) approves them; tokens minted.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("3", "GRANTS — request events.list (read) + reminders.create / notes.create (writes); reads auto-approve, writes PEND → user approves");

    const grant = async (capId: string): Promise<{ token: ScopedToken; pended: boolean }> => {
      const res = (await (await req("/grants", {
        method: "PUT",
        body: JSON.stringify({ sessionId, grants: { [capId]: "allow" } }),
      })).json()) as ScopedToken & { status?: string; pendingId?: string };
      // Auto-approved path: a token comes back immediately (first-party read).
      if (Array.isArray(res.scopes) && res.token) return { token: res, pended: false };
      // Pended path: a human must approve (first-party-elevated write).
      const pendingId = res.pendingId;
      if (!pendingId) throw new Error(`grant for ${capId} neither minted nor pended: ${JSON.stringify(res)}`);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const st = (await (await req(`/grants/status?pendingId=${pendingId}`, {
          headers: { "X-Plexus-Session": sessionId },
        })).json()) as {
          state: string;
          token?: ScopedToken;
        };
        if (st.state === "approved" && st.token) return { token: st.token, pended: true };
        if (st.state === "denied" || st.state === "expired") throw new Error(`grant ${capId} ${st.state}`);
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`grant for ${capId} never resolved`);
    };

    const readGrant = await grant(EVENTS_LIST_ID);
    ok(!!readGrant.token.token, "events.list read grant minted a token", EVENTS_LIST_ID);
    ok(readGrant.pended === false, "events.list (read, first-party) AUTO-APPROVED (no human needed)");
    grantedCaps.push(EVENTS_LIST_ID);
    grantFlow.push({ id: EVENTS_LIST_ID, pended: readGrant.pended });

    const remGrant = await grant(REMINDERS_CREATE_ID);
    const remScope = remGrant.token.scopes.find((s) => s.id === REMINDERS_CREATE_ID);
    ok(!!remGrant.token.token && !!remScope?.verbs.includes("write"), "reminders.create write grant minted a token (write verb)", REMINDERS_CREATE_ID);
    ok(remGrant.pended === true, "reminders.create (write, first-party-elevated) PENDED → the user approved it");
    grantedCaps.push(REMINDERS_CREATE_ID);
    grantFlow.push({ id: REMINDERS_CREATE_ID, pended: remGrant.pended });

    const noteGrant = await grant(NOTES_CREATE_ID);
    const noteScope = noteGrant.token.scopes.find((s) => s.id === NOTES_CREATE_ID);
    ok(!!noteGrant.token.token && !!noteScope?.verbs.includes("write"), "apple-notes.notes.create write grant minted a token (write verb)", NOTES_CREATE_ID);
    ok(noteGrant.pended === true, "apple-notes.notes.create (write, first-party-elevated) PENDED → the user approved it");
    grantedCaps.push(NOTES_CREATE_ID);
    grantFlow.push({ id: NOTES_CREATE_ID, pended: noteGrant.pended });

    const readToken = readGrant.token.token;
    const remToken = remGrant.token.token;
    const noteToken = noteGrant.token.token;
    const remJti = remGrant.token.jti;

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 4 — DISPATCH THE TASK + COMPLETE IT ("派个任务..看看完成情况"):
    //   Review today's calendar → compose a follow-up → create the reminder + the prep
    //   note → VERIFY both writes landed in the fake stores.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("4", `DISPATCH THE TASK — "${TASK}"`);

    // 4a. Review today's calendar. The fake events sit in mid-2026; use a window that
    //     deterministically catches the first fake event ("Team sync" on 2026-06-24).
    const start = "2026-06-24T00:00:00.000Z";
    const end = "2026-06-25T00:00:00.000Z";
    const evRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ id: EVENTS_LIST_ID, input: { start, end } }),
    })).json()) as InvokeResponse;
    const evOut = (evRes.output ?? {}) as { events?: SeenEvent[] };
    seenEvents = evOut.events ?? [];
    ok(evRes.ok === true && seenEvents.length > 0, "apple-calendar.events.list returned today's events", `${seenEvents.length} event(s): ${seenEvents.map((e) => e.title).join(", ")}`);

    // 4b. Compose the follow-up deterministically from the first event seen.
    const subjectEvent = seenEvents[0];
    if (!subjectEvent) throw new Error("no events returned for the window (fake fixture changed?)");
    followUpSubject = subjectEvent.title;

    // 4c. Create the follow-up reminder via the WRITE capability.
    const reminderTitle = `Follow up on ${followUpSubject}`;
    const createRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${remToken}` },
      body: JSON.stringify({
        id: REMINDERS_CREATE_ID,
        input: { title: reminderTitle, notes: `Auto-created by codex from today's calendar review (${TASK}).` },
      }),
    })).json()) as InvokeResponse;
    const remOut = (createRes.output ?? {}) as { id?: string; list?: string; title?: string };
    createdReminder = { id: remOut.id ?? "", list: remOut.list ?? "", title: remOut.title ?? "" };
    ok(createRes.ok === true && createdReminder.title === reminderTitle, "apple-reminders.reminders.create created the follow-up reminder", reminderTitle);

    // 4d. Create a prep note for the day via the WRITE capability.
    const noteTitle = `Prep for ${followUpSubject}`;
    const addRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${noteToken}` },
      body: JSON.stringify({ id: NOTES_CREATE_ID, input: { title: noteTitle, body: "From codex's daily review." } }),
    })).json()) as InvokeResponse;
    const addOut = (addRes.output ?? {}) as { id?: string; title?: string };
    createdNote = { title: noteTitle, id: addOut.id ?? "", verifiedInSearch: false };
    ok(addRes.ok === true && addOut.title === noteTitle, "apple-notes.notes.create created the prep note", noteTitle);

    // 4e. VERIFY completion — the writes really landed in the fake stores. Each read is a
    //     REAL authorized read: reminders.list / todos.list are their OWN first-party read
    //     capabilities (auto-approved via a fresh grant — no token-scope laundering).
    //     reminders.list shows the new reminder.
    const remListGrant = await grant(REMINDERS_LIST_ID);
    const remListRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${remListGrant.token.token}` },
      body: JSON.stringify({ id: REMINDERS_LIST_ID, input: {} }),
    })).json()) as InvokeResponse;
    const remList = (remListRes.output ?? {}) as { reminders?: { title: string }[] };
    reminderVerifiedInList = remListRes.ok === true && (remList.reminders ?? []).some((r) => r.title === reminderTitle);
    ok(reminderVerifiedInList, "VERIFY: apple-reminders.reminders.list shows the new reminder (write landed)");

    //     notes.search finds the new note.
    const noteGrantSearch = await grant(NOTES_SEARCH_ID);
    const noteSearchRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${noteGrantSearch.token.token}` },
      body: JSON.stringify({ id: NOTES_SEARCH_ID, input: { query: noteTitle } }),
    })).json()) as InvokeResponse;
    const noteHits = (noteSearchRes.output ?? {}) as { notes?: { title: string }[] };
    createdNote.verifiedInSearch = noteSearchRes.ok === true && (noteHits.notes ?? []).some((n) => n.title === noteTitle);
    ok(createdNote.verifiedInSearch, "VERIFY: apple-notes.notes.search finds the new note (write landed)");

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 5 — AUDIT REVIEW ("审计一下日志"): the full ordered chain.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("5", "AUDIT REVIEW — assert + pretty-print the full ordered chain");
    const auditRes = (await (await adminReq("/admin/api/audit?limit=200")).json()) as { events: AuditEvent[] };
    // readAudit returns newest→oldest; present oldest→newest for the story.
    audit = [...auditRes.events].reverse();
    auditSummary = audit.map((e) => {
      const cap = e.capabilityId ? ` ${e.capabilityId}` : "";
      const outcome = e.outcome ? ` (${e.outcome})` : "";
      const det = e.detail && typeof e.detail.outcome === "string" ? ` (${e.detail.outcome})` : "";
      return `${e.type}${cap}${outcome}${det}`;
    });
    const kinds = new Set(audit.map((e) => e.type));
    ok(kinds.has("handshake"), "audit: handshake present");
    ok(kinds.has("grant.allow") || kinds.has("grant.pending"), "audit: grant.allow / grant.pending present (for each cap)");
    ok(kinds.has("token.issue"), "audit: token.issue present");
    const invokes = audit.filter((e) => e.type === "invoke");
    const invokedCaps = new Set(invokes.map((e) => e.capabilityId));
    ok(invokedCaps.has(EVENTS_LIST_ID), "audit: invoke apple-calendar.events.list present (calendar read)");
    ok(invokedCaps.has(REMINDERS_CREATE_ID), "audit: invoke apple-reminders.reminders.create present (write)");
    ok(invokedCaps.has(NOTES_CREATE_ID), "audit: invoke apple-notes.notes.create present (write)");
    ok(invokedCaps.has(REMINDERS_LIST_ID) && invokedCaps.has(NOTES_SEARCH_ID), "audit: the verifying list/search invokes present");
    // The write-invokes resolved ok.
    const writeOk = (capId: string) =>
      invokes.some((e) => e.capabilityId === capId && (e.outcome === "ok" || (e.detail && e.detail.outcome === "ok")));
    ok(writeOk(REMINDERS_CREATE_ID) && writeOk(NOTES_CREATE_ID), "audit: both write-invokes recorded with outcome ok");
    // ordering sanity: handshake precedes the first invoke.
    const firstHandshake = audit.findIndex((e) => e.type === "handshake");
    const firstInvoke = audit.findIndex((e) => e.type === "invoke");
    ok(firstHandshake >= 0 && firstInvoke >= 0 && firstHandshake < firstInvoke, "audit ordering: handshake precedes the first invoke");

    // ───────────────────────────────────────────────────────────────────────────────
    // STEP 6 — REVOKE: revoke the reminders WRITE grant; re-invoke with the old token →
    //          must FAIL (token_revoked / 401). The calendar READ still works.
    // ───────────────────────────────────────────────────────────────────────────────
    log.step("6", "REVOKE the reminders-write grant — re-invoke with the OLD token must FAIL (token_revoked); calendar read still works");
    const revRes = await adminReq("/grants/revoke", {
      method: "POST",
      body: JSON.stringify({ jti: remJti, reason: "acceptance: revoke the reminders write grant" }),
    });
    const revBody = (await revRes.json()) as { ok: boolean; revokedJtis: string[] };
    ok(revRes.status === 200 && revBody.ok === true && revBody.revokedJtis.includes(remJti), "revoke succeeded (management connection-key)");

    // Re-invoke the reminders write with the now-revoked token.
    const deniedRes = await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${remToken}` },
      body: JSON.stringify({ id: REMINDERS_CREATE_ID, input: { title: "Should never land" } }),
    });
    const deniedBody = (await deniedRes.json()) as InvokeResponse;
    revokeDenial = { status: deniedRes.status, code: deniedBody.error?.code ?? "" };
    ok(deniedRes.status === 401 && deniedBody.ok === false, "re-invoke with revoked token → HTTP 401, ok:false");
    ok(deniedBody.error?.code === "token_revoked", "denial code is token_revoked", deniedBody.error?.code);

    // The calendar READ still works (we only revoked the reminders write grant).
    const stillReadRes = (await (await req("/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ id: EVENTS_LIST_ID, input: { start, end } }),
    })).json()) as InvokeResponse;
    readStillWorksAfterRevoke = stillReadRes.ok === true;
    ok(readStillWorksAfterRevoke, "calendar read still works (only the reminders write grant was revoked)");
  } finally {
    approving = false;
    await approveLoop;
    if (priorHome === undefined) delete process.env.PLEXUS_HOME;
    else process.env.PLEXUS_HOME = priorHome;
    if (priorFake === undefined) delete process.env.PLEXUS_FAKE_APPLE;
    else process.env.PLEXUS_FAKE_APPLE = priorFake;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const pass = checks.every((c) => c.ok);
  return {
    pass,
    checks,
    sessionId,
    agent,
    discovered,
    grantedCaps,
    grantFlow,
    task: TASK,
    seenEvents,
    followUpSubject,
    createdReminder,
    createdNote,
    reminderVerifiedInList,
    plexusHome,
    audit,
    auditSummary,
    revokeDenial,
    readStillWorksAfterRevoke,
  };
}
