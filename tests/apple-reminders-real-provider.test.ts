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

  it("parses RS/US-delimited reminders incl. completion + due date", async () => {
    const row1 = `id-1${US}Groceries${US}Oat milk${US}the barista kind${US}false${US}2026-06-26T09:00:00`;
    const row2 = `id-2${US}Reminders${US}Done thing${US}${US}true${US}`;
    const out = `${row1}${RS}${row2}${RS}`;
    const p = new RealRemindersProvider(runner([], () => ({ stdout: out, stderr: "", exitCode: 0 })));
    const items = await p.listReminders();
    expect(items).toEqual([
      { id: "id-1", list: "Groceries", title: "Oat milk", completed: false, notes: "the barista kind", dueDate: "2026-06-26T09:00:00" },
      { id: "id-2", list: "Reminders", title: "Done thing", completed: true },
    ]);
    // the completed filter is applied client-side.
    const done = await p.listReminders({ completed: true });
    expect(done.map((r) => r.id)).toEqual(["id-2"]);
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
