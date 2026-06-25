/**
 * RealRemindersProvider — the osascript seam, driven by a FAKE `OsascriptRunner`.
 *
 * NO real osascript, NO macOS TCC: a stub runner returns canned stdout/exit so we can
 * assert (a) the AppleScript scripts carry the expected `tell application "Reminders"`
 * verbs, (b) the RS/US-delimited output parses back into the domain shapes, and (c) a
 * TCC-denied stderr maps to the precise, actionable System-Settings reason. The REAL
 * osascript path itself is a documented LIVE smoke (needs a granted TCC permission).
 */

import { describe, it, expect } from "bun:test";

import {
  RealRemindersProvider,
  type OsascriptCapture,
} from "@plexus/runtime/sources/apple-reminders/provider.ts";

const RS = String.fromCharCode(0x1e); // record sep
const US = String.fromCharCode(0x1f); // field sep

function runner(scripts: string[], reply: (script: string) => OsascriptCapture) {
  return async (script: string): Promise<OsascriptCapture> => {
    scripts.push(script);
    return reply(script);
  };
}

describe("RealRemindersProvider: available() probe + TCC mapping", () => {
  it("ok when osascript exits 0", async () => {
    const scripts: string[] = [];
    const p = new RealRemindersProvider(runner(scripts, () => ({ stdout: "3", stderr: "", exitCode: 0 })));
    const a = await p.available();
    expect(a.ok).toBe(true);
    expect(scripts[0]).toContain('tell application "Reminders"');
  });

  it("maps a TCC-denied stderr to the precise System-Settings reason", async () => {
    const p = new RealRemindersProvider(
      runner([], () => ({ stdout: "", stderr: "execution error: Not authorized (-1743)", exitCode: 1 })),
    );
    const a = await p.available();
    expect(a.ok).toBe(false);
    expect(a.reason).toContain("System Settings ▸ Privacy ▸ Reminders");
  });
});

describe("RealRemindersProvider: AppleScript output parsing", () => {
  it("parses RS/US-delimited lists", async () => {
    const out = `Reminders${US}list-1${RS}Groceries${US}list-2${RS}`;
    const p = new RealRemindersProvider(runner([], () => ({ stdout: out, stderr: "", exitCode: 0 })));
    const lists = await p.listLists();
    expect(lists).toEqual([
      { name: "Reminders", id: "list-1" },
      { name: "Groceries", id: "list-2" },
    ]);
  });

  // The BULK output is SIX REC-terminated, FLD-joined PARALLEL property blocks
  // (ids, lists, titles, bodies, completed, dues) — field i of each block describes
  // reminder i. Build that shape and assert the zip back into Reminder[].
  function bulk(cols: { ids: string[]; lists: string[]; titles: string[]; bodies: string[]; completed: string[]; dues: string[] }): string {
    const block = (xs: string[]) => xs.join(US);
    return [block(cols.ids), block(cols.lists), block(cols.titles), block(cols.bodies), block(cols.completed), block(cols.dues)]
      .map((b) => b + RS)
      .join("") + "\n"; // osascript appends a trailing newline to the whole output
  }

  it("zips the six PARALLEL bulk property blocks into Reminder[] (incl. notes + due date, missing-value→empty)", async () => {
    const out = bulk({
      ids: ["id-1", "id-2"],
      lists: ["Groceries", "Reminders"],
      titles: ["Oat milk", "Buy bread"],
      bodies: ["the barista kind", ""], // 2nd reminder has no notes (was missing value)
      completed: ["false", "false"],
      dues: ["2026-06-26T09:00:00", ""], // 2nd reminder has no due date
    });
    const p = new RealRemindersProvider(runner([], () => ({ stdout: out, stderr: "", exitCode: 0 })));
    const items = await p.listReminders();
    expect(items).toEqual([
      { id: "id-1", list: "Groceries", title: "Oat milk", completed: false, notes: "the barista kind", dueDate: "2026-06-26T09:00:00" },
      { id: "id-2", list: "Reminders", title: "Buy bread", completed: false },
    ]);
  });

  it("an empty result set (six empty blocks) yields no reminders", async () => {
    const out = bulk({ ids: [], lists: [], titles: [], bodies: [], completed: [], dues: [] });
    const p = new RealRemindersProvider(runner([], () => ({ stdout: out, stderr: "", exitCode: 0 })));
    expect(await p.listReminders()).toEqual([]);
  });

  it("DEFAULTS to incomplete-only via a `whose completed is false` clause, but an explicit completed:true filters in AppleScript", async () => {
    const scripts: string[] = [];
    const out = bulk({ ids: ["id-2"], lists: ["Reminders"], titles: ["Done thing"], bodies: [""], completed: ["true"], dues: [""] });
    const p = new RealRemindersProvider(runner(scripts, () => ({ stdout: out, stderr: "", exitCode: 0 })));

    // No completed filter ⇒ default to incomplete: the script narrows with `whose completed is false`.
    await p.listReminders();
    expect(scripts[0]).toContain("whose completed is false");

    // Explicit completed:true ⇒ the script narrows with `whose completed is true`.
    const done = await p.listReminders({ completed: true });
    expect(scripts[1]).toContain("whose completed is true");
    expect(done.map((r) => r.id)).toEqual(["id-2"]);
  });

  it("uses BULK property access (no per-item property reads inside a repeat loop over reminders)", async () => {
    const scripts: string[] = [];
    const out = bulk({ ids: [], lists: [], titles: [], bodies: [], completed: [], dues: [] });
    const p = new RealRemindersProvider(runner(scripts, () => ({ stdout: out, stderr: "", exitCode: 0 })));
    await p.listReminders({ list: "Groceries" });
    const script = scripts[0]!;
    // STRUCTURAL perf assertion: each property is fetched across ALL matching reminders
    // in one Apple Event, by applying the read DIRECTLY to the `whose`-filtered specifier
    // (`id of (reminders of list ... whose ...)`) — NOT via an intermediate
    // `set theReminders to (...)` variable (which forces a list-of-refs and breaks
    // `id of {...}` with -1728), and NOT a per-item `repeat with r in (reminders ...)` loop.
    expect(script).toContain("id of (reminders of list");
    expect(script).toContain("name of container of (reminders of list");
    expect(script).toContain("completed of (reminders of list");
    expect(script).toContain("due date of (reminders of list");
    expect(script).toContain("count of (reminders of list"); // empty-set guard
    expect(script).not.toContain("id of theReminders"); // the broken intermediate-variable form
    expect(script).not.toMatch(/repeat\s+with\s+\w+\s+in\s+\(reminders/);
  });

  it("createReminder builds a `make new reminder` script and returns the new item", async () => {
    const scripts: string[] = [];
    const p = new RealRemindersProvider(
      runner(scripts, () => ({ stdout: `new-id-1${US}Groceries`, stderr: "", exitCode: 0 })),
    );
    const r = await p.createReminder({ title: "Buy oat milk", list: "Groceries", notes: "barista" });
    expect(scripts[0]).toContain("make new reminder");
    expect(scripts[0]).toContain('name:"Buy oat milk"');
    expect(scripts[0]).toContain('list "Groceries"');
    expect(r).toEqual({ id: "new-id-1", list: "Groceries", title: "Buy oat milk", completed: false, notes: "barista" });
  });

  it("a failing exec throws with the TCC reason (mapped to transport_error by the bridge)", async () => {
    const p = new RealRemindersProvider(
      runner([], () => ({ stdout: "", stderr: "Not authorized -1743", exitCode: 1 })),
    );
    await expect(p.listLists()).rejects.toThrow(/System Settings/);
  });
});
