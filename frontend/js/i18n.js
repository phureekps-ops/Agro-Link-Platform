/**
 * AgroLink — shared in-page TH/EN language switcher.
 *
 * Scope (per product decision, 2026-10): public/marketing pages only — NOT
 * the portal login/dashboard apps. Mechanism: instant in-page text swap via
 * a TH/EN toggle button, no page reload, no separate /en/ URLs.
 *
 * How a page uses this:
 *   1. Include a page-specific dictionary script BEFORE this file, that sets
 *      `window.AGROLINK_I18N = { key: { th: "...", en: "..." }, ... }`.
 *   2. Tag translatable elements with `data-i18n="key"`. The element's
 *      textContent is replaced with dict[key][lang] (falls back to .th).
 *   3. For an attribute instead of text (placeholder / title / aria-label /
 *      alt), also add `data-i18n-attr="attrName"` (comma-separate for more
 *      than one attribute, e.g. data-i18n-attr="title,aria-label").
 *   4. Add one or more `<button data-lang-toggle>` elements anywhere on the
 *      page (its label is set automatically to the *other* language's name).
 *
 * The chosen language is remembered per-browser via localStorage so it
 * carries over between public pages once more of them adopt this pattern.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "agrolink_lang";
  var DEFAULT_LANG = "th";

  function getStoredLang() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === "en" || v === "th" ? v : DEFAULT_LANG;
    } catch (e) {
      return DEFAULT_LANG;
    }
  }

  function setStoredLang(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* private-mode / storage blocked — language just won't persist */
    }
  }

  function applyLang(lang) {
    var dict = window.AGROLINK_I18N || {};

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var entry = dict[key];
      if (!entry) return;
      var text = lang === "en" ? (entry.en !== undefined ? entry.en : entry.th) : entry.th;
      if (text === undefined) return;

      var attrList = el.getAttribute("data-i18n-attr");
      if (attrList) {
        attrList.split(",").forEach(function (attr) {
          el.setAttribute(attr.trim(), text);
        });
      } else {
        el.textContent = text;
      }
    });

    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "th");

    document.querySelectorAll("[data-lang-toggle]").forEach(function (btn) {
      btn.textContent = lang === "en" ? "ไทย" : "EN";
      btn.setAttribute(
        "aria-label",
        lang === "en" ? "สลับเป็นภาษาไทย (Switch to Thai)" : "Switch to English"
      );
      btn.setAttribute("data-current-lang", lang);
    });
  }

  function initI18n() {
    var lang = getStoredLang();
    applyLang(lang);

    document.querySelectorAll("[data-lang-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        lang = getStoredLang() === "en" ? "th" : "en";
        setStoredLang(lang);
        applyLang(lang);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initI18n);
  } else {
    initI18n();
  }

  // Exposed for other pages/scripts that may want to react to a language
  // change later (e.g. re-render dynamically-built content).
  window.AgroLinkI18n = { getLang: getStoredLang, applyLang: applyLang };
})();
