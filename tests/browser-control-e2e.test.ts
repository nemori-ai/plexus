/**
 * browser-control END TO END against a REAL Chrome (launch mode).
 *
 * Drives the actual bridge — the same code path an agent's invoke takes — so this proves the
 * origin gate holds where it matters (in front of a live browser), not just as a pure function.
 *
 * Skipped when Chrome is absent or in bare CI: it spawns a real browser and reaches the network.
 * The gate's own logic is covered hermetically in `browser-control-origin-gate.test.ts`.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEvent, AuditEventInput, BridgeDeps, InvokeContext } from "@plexus/protocol";
import { BrowserControlBridge } from "@plexus/runtime/sources/browser-control/bridge.ts";
import {
  browserControlEntries,
  BC_TABS_ID,
  BC_READ_ID,
  BC_NAVIGATE_ID,
  BC_SCREENSHOT_ID,
  BC_CLICK_ID,
  BC_SCROLL_ID,
  BC_WAIT_ID,
  BC_ELEMENTS_ID,
  BC_TYPE_ID,
  BC_PRESS_ID,
  BC_UPLOAD_ID,
  BC_FRAMES_ID,
} from "@plexus/runtime/sources/browser-control/entries.ts";
import { shutdownBrowserControl, type BrowserControlConfig } from "@plexus/runtime/sources/browser-control/endpoint.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUNNABLE = process.platform === "darwin" && existsSync(CHROME) && !process.env.CI;

const CTX: InvokeContext = { jti: "tok_t", sessionId: "sess_t", agentId: "agent-t", scopes: [] };
const profile = mkdtempSync(join(tmpdir(), "plexus-bc-e2e-"));

function deps(): { deps: BridgeDeps; events: AuditEventInput[] } {
  const entries = browserControlEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const events: AuditEventInput[] = [];
  return {
    events,
    deps: {
      audit: async (e) => {
        events.push(e);
        return { ...e, id: `a-${events.length}`, at: new Date().toISOString() } as unknown as AuditEvent;
      },
      getTransport: () => {
        throw new Error("browser-control is served in-process");
      },
      getEntry: (id) => byId.get(id),
      invokeById: async () => {
        throw new Error("browser-control does not re-enter the pipeline");
      },
    },
  };
}

function cfg(allowlist: string[]): BrowserControlConfig {
  return { mode: "launch", allowlist, attachPort: 9222, profileDir: profile, binary: CHROME };
}

afterAll(async () => {
  // Close the tabs these bridges opened as well as the browser — otherwise the persistent
  // launch profile carries them into the next run.
  await shutdownBrowserControl();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * A page with the two things that break naive form filling: fields that have no rendered text,
 * and a framework-controlled input that ignores a value written behind its back.
 */
const FORM_PAGE = `<!doctype html><meta charset=utf-8><title>Form probe</title>
<form><label>Full name <input name=fullname></label>
<label>Plan <select name=plan><option value=free>Free</option><option value=pro>Pro</option></select></label>
<label>Secret <input type=password name=pw value="hunter2"></label>
<button type=submit>Create account</button></form>
<div id=root></div>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script>const e=React.createElement;function App(){const[v,setV]=React.useState("");
return e("div",null,e("input",{id:"rx",value:v,onChange:(ev)=>setV(ev.target.value)}),
e("p",null,"React state: ["+v+"]"));}
ReactDOM.createRoot(document.getElementById("root")).render(e(App));</script>`;

describe.skipIf(!RUNNABLE)("browser-control e2e — filling a form the agent can actually see", () => {
  const PORT = 8897;
  const origin = `http://127.0.0.1:${PORT}`;
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterAll(() => server?.stop(true));

  it("lists fields with working selectors, types through a framework, and never echoes a password", async () => {
    server ??= Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch: () => new Response(FORM_PAGE, { headers: { "content-type": "text/html" } }),
    });
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "sf", browserControlEntries(), cfg([origin]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: `${origin}/` } }, CTX);
    await bridge.invoke({ id: BC_WAIT_ID, input: { selector: "#rx", timeoutMs: 15_000 } }, CTX);

    // A form field has NO rendered text, so `page.read` cannot show it — this is what makes
    // the agent stop guessing selector names.
    const before = (await bridge.invoke({ id: BC_ELEMENTS_ID, input: {} }, CTX)).output as {
      elements: Record<string, unknown>[];
    };
    const byName = (n: string) => before.elements.find((e) => e.name === n)!;
    expect(byName("fullname").selector).toBe('input[name="fullname"]');
    expect(byName("plan").options).toEqual(["free", "pro"]);

    // A password's CONTENT never leaves the page; only its length does.
    expect(byName("pw").value).toBeUndefined();
    expect(byName("pw").valueLength).toBe(7);

    // The selector the snapshot handed back must actually resolve.
    const typed = await bridge.invoke(
      { id: BC_TYPE_ID, input: { selector: String(byName("fullname").selector), text: "Ada Lovelace" } },
      CTX,
    );
    expect(typed.ok).toBe(true);
    // Verification without echo: the agent learns it landed, not what it was.
    expect((typed.output as Record<string, unknown>).accepted).toBe(true);
    expect(JSON.stringify(typed.output)).not.toContain("Ada Lovelace");

    await bridge.invoke({ id: BC_TYPE_ID, input: { selector: 'select[name="plan"]', text: "pro" } }, CTX);
    await bridge.invoke({ id: BC_TYPE_ID, input: { selector: "#rx", text: "hello react" } }, CTX);

    // Writing `el.value` directly leaves React's state empty while reporting success. The page
    // itself is the witness: its rendered text must show the framework saw the change.
    const page = (await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX)).output as { text: string };
    expect(page.text).toContain("React state: [hello react]");

    const after = (await bridge.invoke({ id: BC_ELEMENTS_ID, input: {} }, CTX)).output as {
      elements: Record<string, unknown>[];
    };
    expect(after.elements.find((e) => e.name === "fullname")!.value).toBe("Ada Lovelace");
    expect(after.elements.find((e) => e.name === "plan")!.value).toBe("pro");
  }, 90_000);
});

describe.skipIf(!RUNNABLE)("browser-control e2e — the gate holds in front of a live browser", () => {
  it("navigates an authorized origin, reads it, screenshots it — and audits the mode", async () => {
    const { deps: d, events } = deps();
    const bridge = new BrowserControlBridge(d, "s1", browserControlEntries(), cfg(["example.com"]));

    const nav = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    expect(nav.ok).toBe(true);
    const navOut = nav.output as Record<string, unknown>;
    expect(String(navOut.url)).toStartWith("https://example.com");
    expect(navOut.leftAuthorizedOrigin).toBeUndefined();

    const read = await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    expect(read.ok).toBe(true);
    const readOut = read.output as Record<string, unknown>;
    expect(String(readOut.title)).toContain("Example");
    expect(String(readOut.text)).toContain("Example Domain");

    const shot = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: {} }, CTX);
    expect(shot.ok).toBe(true);
    expect(String((shot.output as Record<string, unknown>).imageBase64).length).toBeGreaterThan(1000);

    // The OWNER's audit records which mode drove the browser; the agent's result does not
    // carry the profile path, the binary or the port.
    const navEvent = events.find((e) => e.capabilityId === BC_NAVIGATE_ID)!;
    expect((navEvent.detail as Record<string, unknown>).mode).toBe("launch");
    const wire = JSON.stringify(nav.output);
    expect(wire).not.toContain(profile);
    expect(wire).not.toContain(CHROME);
  }, 60_000);

  it("REFUSES an unauthorized origin before any navigation happens", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s2", browserControlEntries(), cfg(["example.com"]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.org/" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("example.org");
    // The refusal must not disclose what IS authorized.
    expect(res.error?.message).not.toContain("example.com");
  }, 60_000);

  it("REFUSES everything when the owner has authorized nothing", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s3", browserControlEntries(), cfg([]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("no authorized sites");
  }, 60_000);

  it("lists only tabs on authorized origins, so an unlisted tab is undiscoverable", async () => {
    const { deps: d } = deps();
    // Open a page on example.com under an allowlist that permits it…
    const open = new BrowserControlBridge(d, "s4", browserControlEntries(), cfg(["example.com"]));
    await open.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const listedWhenAllowed = await open.invoke({ id: BC_TABS_ID, input: {} }, CTX);
    const allowedTabs = (listedWhenAllowed.output as { tabs: unknown[] }).tabs;
    expect(allowedTabs.length).toBeGreaterThan(0);

    // …then list with a DIFFERENT allowlist: the same tab is now invisible.
    const other = new BrowserControlBridge(d, "s5", browserControlEntries(), cfg(["some-other-site.test"]));
    const listedWhenNot = await other.invoke({ id: BC_TABS_ID, input: {} }, CTX);
    expect((listedWhenNot.output as { tabs: unknown[] }).tabs).toEqual([]);
  }, 60_000);

  it("refuses a targetId the agent is not authorized for, with no hint that it exists", async () => {
    const { deps: d } = deps();
    const allowed = new BrowserControlBridge(d, "s6", browserControlEntries(), cfg(["example.com"]));
    await allowed.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const tabs = (await allowed.invoke({ id: BC_TABS_ID, input: {} }, CTX)).output as {
      tabs: { targetId: string }[];
    };
    const realId = tabs.tabs[0]!.targetId;

    // A bridge with a different allowlist knows that id is real, but must refuse it the SAME
    // way it refuses a made-up one — otherwise the error is an existence oracle for tabs.
    const stranger = new BrowserControlBridge(d, "s7", browserControlEntries(), cfg(["some-other-site.test"]));
    const real = await stranger.invoke({ id: BC_READ_ID, input: { targetId: realId } }, CTX);
    const fake = await stranger.invoke({ id: BC_READ_ID, input: { targetId: "not-a-real-target" } }, CTX);
    expect(real.ok).toBe(false);
    expect(fake.ok).toBe(false);
    expect(real.error?.message).toBe(fake.error?.message);
  }, 60_000);

  it("holds one debugging socket across a run of calls instead of redialling", async () => {
    const { deps: d, events } = deps();
    const bridge = new BrowserControlBridge(d, "s9", browserControlEntries(), cfg(["example.com"]));
    // The first call has to open a socket; every later call on that tab must reuse it. In
    // attach mode this is the difference between one debugging session and one per invoke.
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    await bridge.invoke({ id: BC_READ_ID, input: {} }, CTX);
    const reuse = events
      .filter((e) => e.capabilityId === BC_NAVIGATE_ID || e.capabilityId === BC_READ_ID)
      .map((e) => (e.detail as Record<string, unknown>).reusedSocket);
    expect(reuse).toEqual([false, true, true]);
  }, 60_000);

  it("covers subdomains of an authorized domain, so an apex redirect stays in bounds", async () => {
    const { deps: d } = deps();
    // `github.com` authorizes `gist.github.com` — one domain, as the owner meant it.
    const bridge = new BrowserControlBridge(d, "s10", browserControlEntries(), cfg(["github.com"]));
    const res = await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://gist.github.com/" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(String(out.url)).toContain("github.com");
    expect(out.leftAuthorizedOrigin).toBeUndefined();
  }, 60_000);

  it("scrolls a long page and reports whether the bottom is reached", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s11", browserControlEntries(), cfg(["deepseek.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://deepseek.com/harness/en/" } }, CTX);
    const top = (await bridge.invoke({ id: BC_SCROLL_ID, input: { to: "top" } }, CTX)).output as Record<string, unknown>;
    expect(top.scrollY).toBe(0);
    expect(top.atBottom).toBe(false);
    const bottom = (await bridge.invoke({ id: BC_SCROLL_ID, input: { to: "bottom" } }, CTX)).output as Record<string, unknown>;
    expect(Number(bottom.scrollY)).toBeGreaterThan(0);
    expect(bottom.atBottom).toBe(true);
  }, 60_000);

  it("waits for content, and reports a timeout as an answer rather than an error", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s12", browserControlEntries(), cfg(["example.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const hit = await bridge.invoke({ id: BC_WAIT_ID, input: { text: "Example Domain" } }, CTX);
    expect(hit.ok).toBe(true);
    expect((hit.output as Record<string, unknown>).found).toBe(true);

    const miss = await bridge.invoke({ id: BC_WAIT_ID, input: { selector: "#never-appears", timeoutMs: 1200 } }, CTX);
    // A timeout is a fact about the page, not a broken call.
    expect(miss.ok).toBe(true);
    expect((miss.output as Record<string, unknown>).found).toBe(false);
  }, 60_000);

  it("captures the whole page, not just what fits on screen", async () => {
    const { deps: d } = deps();
    const bridge = new BrowserControlBridge(d, "s13", browserControlEntries(), cfg(["deepseek.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://deepseek.com/harness/en/" } }, CTX);
    const viewport = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: {} }, CTX);
    const full = await bridge.invoke({ id: BC_SCREENSHOT_ID, input: { fullPage: true } }, CTX);
    const vBytes = String((viewport.output as Record<string, unknown>).imageBase64).length;
    const fBytes = String((full.output as Record<string, unknown>).imageBase64).length;
    expect(fBytes).toBeGreaterThan(vBytes);
  }, 90_000);

  it("a click that navigates reports where it landed", async () => {
    const { deps: d } = deps();
    // example.com's only link goes to iana.org — authorize only example.com, so the landing
    // origin is outside the allowlist and must be REPORTED rather than silently accepted.
    const bridge = new BrowserControlBridge(d, "s8", browserControlEntries(), cfg(["example.com"]));
    await bridge.invoke({ id: BC_NAVIGATE_ID, input: { url: "https://example.com/" } }, CTX);
    const res = await bridge.invoke({ id: BC_CLICK_ID, input: { selector: "a" } }, CTX);
    expect(res.ok).toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out.clicked).toBe(true);
    if (!String(out.url).startsWith("https://example.com")) {
      expect(out.leftAuthorizedOrigin).toBe(true);
    }
  }, 60_000);
});

/** A typeahead that only reacts to keystrokes, and a form sealed inside a shadow root. */
const HARD_PAGE = `<!doctype html><meta charset=utf-8><title>hard</title>
<input id=search autocomplete=off><ul id=sugg></ul>
<script>const s=document.getElementById('search'),u=document.getElementById('sugg');
s.addEventListener('keydown',()=>setTimeout(()=>{u.innerHTML=s.value?'<li>suggestion for '+s.value+'</li>':''},0));</script>
<my-form></my-form><p id=out>submitted: []</p>
<script>customElements.define('my-form',class extends HTMLElement{connectedCallback(){
const r=this.attachShadow({mode:'open'});
r.innerHTML='<form><label>Email <input name=email></label><button>Go</button></form>';
r.querySelector('form').addEventListener('submit',(e)=>{e.preventDefault();
document.getElementById('out').textContent='submitted: ['+r.querySelector('input').value+']';});}});</script>`;

describe.skipIf(!RUNNABLE)("browser-control e2e — keystrokes and shadow DOM", () => {
  const PORT = 8896;
  const origin = `http://127.0.0.1:${PORT}`;
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterAll(() => server?.stop(true));

  it("reaches inside a shadow root, and only real keystrokes open a typeahead", async () => {
    server ??= Bun.serve({
      port: PORT,
      hostname: "127.0.0.1",
      fetch: () => new Response(HARD_PAGE, { headers: { "content-type": "text/html" } }),
    });
    const { deps: d } = deps();
    const b = new BrowserControlBridge(d, "sh", browserControlEntries(), cfg([origin]));
    await b.invoke({ id: BC_NAVIGATE_ID, input: { url: `${origin}/` } }, CTX);

    // A form inside a shadow root has no document-level CSS path; the snapshot must hand back
    // a hop path, and that path must work in the ACTING verbs too.
    const els = (await b.invoke({ id: BC_ELEMENTS_ID, input: {} }, CTX)).output as {
      elements: Record<string, string>[];
    };
    const email = els.elements.find((e) => e.name === "email")!;
    expect(email.selector).toContain(">>>");

    // Setting a value, however correctly, never makes a keystroke-driven suggestion list appear.
    await b.invoke({ id: BC_TYPE_ID, input: { selector: "#search", text: "plex" } }, CTX);
    let page = (await b.invoke({ id: BC_READ_ID, input: {} }, CTX)).output as { text: string };
    expect(page.text).not.toContain("suggestion for");

    await b.invoke({ id: BC_TYPE_ID, input: { selector: "#search", text: "plexus", keystrokes: true } }, CTX);
    await b.invoke({ id: BC_WAIT_ID, input: { text: "suggestion for plexus", timeoutMs: 5_000 } }, CTX);
    page = (await b.invoke({ id: BC_READ_ID, input: {} }, CTX)).output as { text: string };
    // Exactly once — a keyDown carrying `text` already inserts, so a `char` event too would
    // type "plexus" as "pplleexxuuss".
    expect(page.text).toContain("suggestion for plexus");

    // Type into the shadow field, then submit it with a real Enter.
    await b.invoke({ id: BC_TYPE_ID, input: { selector: email.selector, text: "ada@example.com" } }, CTX);
    const pressed = await b.invoke({ id: BC_PRESS_ID, input: { selector: email.selector, key: "Enter" } }, CTX);
    expect(pressed.ok).toBe(true);
    page = (await b.invoke({ id: BC_READ_ID, input: {} }, CTX)).output as { text: string };
    expect(page.text).toContain("submitted: [ada@example.com]");
  }, 90_000);
});

describe.skipIf(!RUNNABLE)("browser-control e2e — frames are judged on their own domain", () => {
  const parentOrigin = "http://localhost:8894";
  const frameOrigin = "http://127.0.0.1:8895";
  let parent: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.serve> | undefined;
  const uploadDir = mkdtempSync(join(tmpdir(), "plexus-bc-upload-"));

  afterAll(() => {
    parent?.stop(true);
    child?.stop(true);
    try {
      rmSync(uploadDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function boot() {
    child ??= Bun.serve({
      port: 8895,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          `<!doctype html><title>frame</title><label>Card <input name=card></label>
           <input type=file name=doc><p id=picked>picked: []</p>
           <script>document.querySelector('input[type=file]').addEventListener('change',e=>
             document.getElementById('picked').textContent='picked: ['+(e.target.files[0]?.name??'')+']');</script>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    parent ??= Bun.serve({
      port: 8894,
      hostname: "localhost",
      fetch: () =>
        new Response(
          `<!doctype html><title>checkout</title><input name=coupon>
           <iframe src="${frameOrigin}/" width=500 height=300></iframe>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
  }

  it("an authorized page does NOT authorize what it embeds", async () => {
    boot();
    const { deps: d } = deps();
    const b = new BrowserControlBridge(d, "fr1", browserControlEntries(), cfg([parentOrigin]));
    await b.invoke({ id: BC_NAVIGATE_ID, input: { url: `${parentOrigin}/` } }, CTX);
    await b.invoke({ id: BC_WAIT_ID, input: { selector: "iframe", timeoutMs: 10_000 } }, CTX);

    // The frame is on a domain the owner did not authorize, so it is neither listed…
    const frames = (await b.invoke({ id: BC_FRAMES_ID, input: {} }, CTX)).output as { frames: unknown[] };
    expect(frames.frames).toEqual([]);
    // …nor visible through the page: a page's selectors do not reach into another document.
    const els = (await b.invoke({ id: BC_ELEMENTS_ID, input: {} }, CTX)).output as {
      elements: Record<string, string>[];
    };
    expect(els.elements.map((e) => e.name)).toEqual(["coupon"]);
  }, 90_000);

  it("drives a frame, and uploads only from inside the owner's directory", async () => {
    boot();
    writeFileSync(join(uploadDir, "invoice.txt"), "hello");
    const { deps: d } = deps();
    const b = new BrowserControlBridge(d, "fr2", browserControlEntries(), {
      ...cfg([parentOrigin, frameOrigin]),
      uploadDir,
    });
    await b.invoke({ id: BC_NAVIGATE_ID, input: { url: `${parentOrigin}/` } }, CTX);
    await b.invoke({ id: BC_WAIT_ID, input: { selector: "iframe", timeoutMs: 10_000 } }, CTX);

    const frames = (await b.invoke({ id: BC_FRAMES_ID, input: {} }, CTX)).output as {
      frames: { targetId: string; url: string }[];
    };
    // Frames from every authorized tab are listed, the same way tabs.list spans the browser —
    // an earlier test in this file may still have one open.
    const mine = frames.frames.filter((f) => f.url.startsWith(frameOrigin));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const targetId = mine[0]!.targetId;

    const typed = await b.invoke(
      { id: BC_TYPE_ID, input: { targetId, selector: 'input[name="card"]', text: "4242" } },
      CTX,
    );
    expect(typed.ok).toBe(true);

    // A file input's value is not settable from page JS — that is the protection that stops a
    // website helping itself to your disk. The page itself witnesses the attachment.
    const up = await b.invoke(
      { id: BC_UPLOAD_ID, input: { targetId, selector: 'input[type="file"]', path: "invoice.txt" } },
      CTX,
    );
    expect(up.ok).toBe(true);
    expect((up.output as Record<string, unknown>).fileName).toBe("invoice.txt");
    // The wire gets the file's NAME; where it lives on this machine is the owner's business.
    expect(JSON.stringify(up.output)).not.toContain(uploadDir);
    const framePage = (await b.invoke({ id: BC_READ_ID, input: { targetId } }, CTX)).output as { text: string };
    expect(framePage.text).toContain("picked: [invoice.txt]");

    for (const path of ["../../etc/passwd", "/etc/passwd"]) {
      const bad = await b.invoke({ id: BC_UPLOAD_ID, input: { targetId, selector: 'input[type="file"]', path } }, CTX);
      expect(bad.ok).toBe(false);
      expect(bad.error?.message).toContain("outside the owner's upload directory");
    }
  }, 90_000);

  it("refuses every upload when the owner set no upload directory", async () => {
    boot();
    const { deps: d } = deps();
    const b = new BrowserControlBridge(d, "fr3", browserControlEntries(), cfg([parentOrigin, frameOrigin]));
    await b.invoke({ id: BC_NAVIGATE_ID, input: { url: `${frameOrigin}/` } }, CTX);
    const res = await b.invoke(
      { id: BC_UPLOAD_ID, input: { selector: 'input[type="file"]', path: "invoice.txt" } },
      CTX,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("no upload directory is set");
  }, 90_000);
});
