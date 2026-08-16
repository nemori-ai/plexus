/** Pairing UI. The token is stored locally and only ever sent to the gateway it names. */
const KEY = "plexus.pairing";
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(KEY).then((s) => {
  const cfg = s[KEY];
  $("url").value = cfg?.url ?? "ws://127.0.0.1:7901/browser-extension";
  $("token").value = cfg?.token ?? "";
});

chrome.action.getBadgeText({}).then((t) => {
  $("state").textContent = t === "" ? "connected" : t === "!" ? "token rejected" : "not connected";
});

$("save").addEventListener("click", async () => {
  const url = $("url").value.trim();
  const token = $("token").value.trim();
  if (!/^wss?:\/\//.test(url) || !token) {
    $("state").textContent = "need a ws:// URL and a token";
    return;
  }
  await chrome.storage.local.set({ [KEY]: { url, token } });
  $("state").textContent = "pairing…";
});
