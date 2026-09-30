import { afterEach, expect, it } from "bun:test";
import { api, forgetManagementKey, hasResolvableKey, rememberManagementKey, setPasteKeyPrompt, setAuthFailureHandler } from "../packages/web-admin/src/api.ts";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  forgetManagementKey(); setAuthFailureHandler(null);
});
it("host managed auth opens the key gate without reading, persisting or sending a renderer key", async () => {
  let secretAccess = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { plexusDesktop: {
    hostManagedAuthentication: true,
    getConnectionKey: () => { secretAccess++; return "must-not-read"; },
  } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => { secretAccess++; return "must-not-read"; },
    setItem: () => { secretAccess++; }, removeItem: () => {},
  } });
  setPasteKeyPrompt(async () => { secretAccess++; return "must-not-prompt"; });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("X-Plexus-Connection-Key")).toBe(false);
    return Response.json({ entries: [], revision: 1 });
  }) as unknown as typeof fetch;
  expect(await hasResolvableKey()).toBe(true);
  rememberManagementKey("must-not-cache");
  await api.capabilities();
  await api.resolvePending("pending-1", "deny");
  expect(secretAccess).toBe(0);
});
it("host-managed requests still report server authentication failure", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { plexusDesktop: { hostManagedAuthentication: true } } });
  let failures = 0;
  setAuthFailureHandler(() => { failures++; });
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await expect(api.capabilities()).rejects.toThrow("401");
  expect(failures).toBe(1);
});
