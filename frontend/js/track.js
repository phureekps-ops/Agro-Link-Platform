/**
 * AgroLink -- lightweight public page-view beacon.
 *
 * Fires once per page load, POSTs { path, referrer } to POST /traffic/track
 * (see backend/src/routes/traffic.js), and never touches the page's own
 * rendering or blocks on a response -- a visitor counter must be invisible
 * to real visitors. Same hostname-based API_BASE pattern as
 * ../js/api.js / admin/js/api.js (local dev vs the deployed Render
 * backend), duplicated here rather than shared so this file has zero
 * dependency on any other script loading first or not at all.
 *
 * Uses navigator.sendBeacon with an explicit application/json Blob type
 * (so the backend's normal express.json() body parser picks it up with no
 * special-casing) and falls back to fetch(..., { keepalive: true }) for the
 * rare browser without sendBeacon support.
 */
(function () {
  "use strict";

  var API_BASE = (["localhost", "127.0.0.1"].includes(window.location.hostname))
    ? "http://localhost:4000"
    : "https://agrolink-backend-vhv6.onrender.com";

  function send() {
    try {
      var payload = JSON.stringify({
        path: window.location.pathname || "/",
        referrer: document.referrer || null,
      });
      var url = API_BASE + "/traffic/track";

      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: "application/json" });
        navigator.sendBeacon(url, blob);
      } else {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(function () { /* best-effort -- a visitor never sees this fail */ });
      }
    } catch (e) {
      // A page-view counter must never break the page it's measuring.
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", send);
  } else {
    send();
  }
})();
