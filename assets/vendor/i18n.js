/* Shared minimal i18n runtime for M365-Copilot2API console pages.
 * Contract (all pages):
 *   <script>window.I18N_DICT = { en: {key:"...", ...}, "zh-CN": {key:"...", ...} };</script>
 *   <script src="/vendor/i18n.js"></script>
 * Markup hooks resolved automatically (and kept fresh via MutationObserver):
 *   data-i18n="key"            -> textContent
 *   data-i18n-html="key"       -> innerHTML (trusted, dictionary-owned strings)
 *   data-i18n-placeholder="k"  -> placeholder attribute
 *   data-i18n-title="key"      -> title attribute
 *   data-i18n-aria="key"       -> aria-label attribute
 * JS API: I18N.t(key, params), I18N.apply(), I18N.setLocale(l), I18N.locale,
 *         I18N.wireSelect(selectEl). Locale persists under localStorage
 *         key "m365_locale"; falls back to browser zh* detection, else "en".
 */
(function () {
  var KEY = "m365_locale";
  var LOCALES = ["en", "zh-CN"];
  var currentLocale = (function () {
    try {
      var s = localStorage.getItem(KEY);
      if (s && LOCALES.indexOf(s) !== -1) return s;
    } catch (e) {}
    return (navigator.language || "").toLowerCase().indexOf("zh") === 0
      ? "zh-CN"
      : "en";
  })();

  function t(key, params) {
    var D = window.I18N_DICT || {};
    var s = D[currentLocale] && D[currentLocale][key];
    if (s == null) s = D.en && D.en[key];
    if (s == null) return key;
    if (params)
      for (var k in params) s = s.split("{" + k + "}").join(String(params[k]));
    return s;
  }

  // Writes happen only when the value differs, so the MutationObserver below
  // converges instead of re-triggering itself forever.
  function applyRoot() {
    var els;
    els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
      var v = t(els[i].getAttribute("data-i18n"));
      if (els[i].textContent !== v) els[i].textContent = v;
    }
    els = document.querySelectorAll("[data-i18n-html]");
    for (var j = 0; j < els.length; j++) {
      var h = t(els[j].getAttribute("data-i18n-html"));
      if (els[j].innerHTML !== h) els[j].innerHTML = h;
    }
    els = document.querySelectorAll("[data-i18n-placeholder]");
    for (var k2 = 0; k2 < els.length; k2++) {
      var p = t(els[k2].getAttribute("data-i18n-placeholder"));
      if (els[k2].getAttribute("placeholder") !== p)
        els[k2].setAttribute("placeholder", p);
    }
    els = document.querySelectorAll("[data-i18n-title]");
    for (var k3 = 0; k3 < els.length; k3++) {
      var ti = t(els[k3].getAttribute("data-i18n-title"));
      if (els[k3].getAttribute("title") !== ti) els[k3].setAttribute("title", ti);
    }
    els = document.querySelectorAll("[data-i18n-aria]");
    for (var k4 = 0; k4 < els.length; k4++) {
      var a = t(els[k4].getAttribute("data-i18n-aria"));
      if (els[k4].getAttribute("aria-label") !== a)
        els[k4].setAttribute("aria-label", a);
    }
  }

  var observer = null;
  function ensureObserver() {
    if (!observer && document.body) {
      observer = new MutationObserver(function () {
        applyRoot();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function apply() {
    ensureObserver();
    applyRoot();
    document.documentElement.lang = currentLocale;
  }

  function setLocale(locale) {
    if (LOCALES.indexOf(locale) === -1) locale = "en";
    currentLocale = locale;
    try {
      localStorage.setItem(KEY, locale);
    } catch (e) {}
    apply();
    try {
      document.dispatchEvent(
        new CustomEvent("i18n:locale", { detail: { locale: currentLocale } })
      );
    } catch (e) {}
  }

  function wireSelect(sel) {
    if (!sel) return;
    sel.value = currentLocale;
    sel.addEventListener("change", function () {
      setLocale(sel.value);
    });
  }

  window.I18N = {
    t: t,
    apply: apply,
    setLocale: setLocale,
    wireSelect: wireSelect,
    get locale() {
      return currentLocale;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
