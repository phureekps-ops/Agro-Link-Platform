/*
 * AgroLink shared site header behaviour (all public pages).
 * Mega menus (click / hover / keyboard / Escape), mobile accordion menu, current-page highlight,
 * scroll shadow and skip-link target. Markup + styles: css/site-header.css.
 */
(function () {
  "use strict";

  function init() {
    var header = document.getElementById("shHeader");
    if (!header) return;
    var nav = document.getElementById("shNav");
    var toggle = document.getElementById("shToggle");
    var mobileMq = window.matchMedia("(max-width: 1179px)");
    var megaItems = Array.prototype.slice.call(header.querySelectorAll(".sh-has-mega"));

    // ---- current page ----
    var file = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    var isHome = file === "index.html" || file === "";
    if (isHome) {
      var home = header.querySelector("[data-sh-home]");
      if (home) { home.classList.add("sh-current"); home.setAttribute("aria-current", "page"); home.setAttribute("href", "#top"); }
      header.querySelectorAll('a[href^="index.html#"]').forEach(function (a) { a.setAttribute("href", a.getAttribute("href").slice(10)); });
    } else {
      var marked = false;
      header.querySelectorAll(".sh-mega a[href]").forEach(function (a) {
        var target = a.getAttribute("href").split("#")[0].toLowerCase();
        if (target && target === file) {
          a.setAttribute("aria-current", "page");
          var li = a.closest(".sh-has-mega");
          if (li && !marked) { li.classList.add("sh-current"); marked = true; }
        }
      });
    }

    // ---- skip link target ----
    var skip = document.querySelector(".sh-skip");
    if (skip) {
      var main = document.querySelector("main") || header.nextElementSibling;
      if (main) {
        if (!main.id) main.id = "sh-content";
        skip.setAttribute("href", "#" + main.id);
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      }
    }

    // ---- scroll shadow ----
    function onScroll() { header.classList.toggle("sh-scrolled", window.scrollY > 8); }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // ---- mega menus ----
    function closeAll(except) {
      megaItems.forEach(function (li) {
        if (li === except) return;
        li.classList.remove("sh-open");
        li.querySelector(".sh-trigger").setAttribute("aria-expanded", "false");
      });
    }
    megaItems.forEach(function (li) {
      var btn = li.querySelector(".sh-trigger");
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = !li.classList.contains("sh-open");
        closeAll(li);
        li.classList.toggle("sh-open", open);
        btn.setAttribute("aria-expanded", String(open));
      });
      if (window.matchMedia("(hover: hover)").matches) {
        li.addEventListener("mouseleave", function () {
          if (!mobileMq.matches && li.classList.contains("sh-open")) { li.classList.remove("sh-open"); btn.setAttribute("aria-expanded", "false"); }
        });
      }
    });
    document.addEventListener("click", function (e) {
      if (!mobileMq.matches && !e.target.closest(".sh-has-mega")) closeAll();
    });

    // ---- mobile menu ----
    function label(key, fallback) {
      var d = window.AGROLINK_I18N || {}, lang = window.AgroLinkI18n ? window.AgroLinkI18n.getLang() : "th";
      return d[key] ? (d[key][lang] || d[key].th) : fallback;
    }
    function setNav(open) {
      nav.classList.toggle("sh-open", open);
      document.body.classList.toggle("sh-nav-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      var key = open ? "sh_menu_close_aria" : "sh_menu_aria";
      toggle.setAttribute("data-i18n", key);
      toggle.setAttribute("aria-label", label(key, open ? "ปิดเมนู" : "เปิดเมนู"));
      toggle.innerHTML = open ? '<i class="fa-solid fa-xmark" aria-hidden="true"></i>' : '<i class="fa-solid fa-bars" aria-hidden="true"></i>';
      if (!open) closeAll();
    }
    if (toggle && nav) {
      toggle.addEventListener("click", function () { setNav(!nav.classList.contains("sh-open")); });
      nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { if (mobileMq.matches) setNav(false); }); });
      var onMq = function (e) { if (!e.matches) setNav(false); };
      if (mobileMq.addEventListener) mobileMq.addEventListener("change", onMq); else mobileMq.addListener(onMq);
    }

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var openLi = header.querySelector(".sh-has-mega.sh-open");
      if (openLi) { closeAll(); openLi.querySelector(".sh-trigger").focus(); return; }
      if (nav && nav.classList.contains("sh-open")) { setNav(false); toggle.focus(); }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
