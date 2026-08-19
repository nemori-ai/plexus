/**
 * Status only. There is deliberately no field to fill: Chrome launches the native host and will
 * only launch the one whose manifest names this extension, so there is no address to point at
 * and no secret to hold.
 */
const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: "status" }, (res) => {
  if (chrome.runtime.lastError || !res) {
    $("state").textContent = "extension not running";
    return;
  }
  $("state").textContent = res.connected ? "connected" : "not connected";
  $("hint").textContent = res.connected
    ? ""
    : res.error
      ? res.error
      : "Start a Plexus gateway, then run the native-host installer once.";
});
