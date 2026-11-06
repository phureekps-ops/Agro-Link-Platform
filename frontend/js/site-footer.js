/*
 * AgroLink shared site footer behaviour: link groups are open on tablet/desktop and
 * collapse into an accordion on phones. Markup + styles: css/site-footer.css.
 */
(function () {
  "use strict";
  function init() {
    var cols = document.querySelectorAll(".sf-col");
    if (!cols.length) return;
    var file = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    if (file === "index.html" || file === "") {
      document.querySelectorAll('.sf-footer a[href^="index.html#"]').forEach(function (l) { l.setAttribute("href", l.getAttribute("href").slice(10)); });
    }
    var mq = window.matchMedia("(max-width: 767px)");
    function sync() { cols.forEach(function (d) { d.open = !mq.matches; }); }
    sync();
    if (mq.addEventListener) mq.addEventListener("change", sync); else mq.addListener(sync);
    document.querySelectorAll(".sf-col summary").forEach(function (s) {
      s.addEventListener("click", function (e) { if (!mq.matches) e.preventDefault(); });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
