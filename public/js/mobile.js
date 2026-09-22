// ══════════════════════════════════════════════════════════════════════
//  Мобільна версія панелі (разом з css/mobile.css).
//  1) кнопка ☰ і меню, що виїжджає зліва;
//  2) назва поточного розділу у верхній смужці;
//  3) таблиці на телефоні показуються картками: підпис колонки + значення.
//  Нічого не робить на екранах ширше 768px.
// ══════════════════════════════════════════════════════════════════════
(function () {
  "use strict";
  var MQ = window.matchMedia("(max-width: 768px)");
  // порядок важливий: перша знайдена колонка стає заголовком картки
  var TITLE_HEADERS = [/imi[eę]\s*i\s*nazwisko/i, /nazwisko/i, /^pracownik$/i, /^obiekt$/i, /^koordynator$/i, /pracownik/i, /^nazwa$/i];

  function clean(t) {
    return String(t || "")
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ").trim();
  }

  // ── Меню ────────────────────────────────────────────────────────────
  function setupMenu() {
    var sidebar = document.querySelector(".sidebar");
    var main = document.querySelector(".main");
    if (!sidebar || !main || document.querySelector(".m-menu-btn")) return;

    var backdrop = document.createElement("div");
    backdrop.className = "m-backdrop";
    backdrop.addEventListener("click", closeMenu);
    document.body.appendChild(backdrop);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "m-menu-btn";
    btn.setAttribute("aria-label", "Menu");
    btn.textContent = "☰";
    btn.addEventListener("click", function () { document.body.classList.toggle("m-menu-open"); });

    var topbar = main.querySelector(".topbar");
    if (topbar) {
      topbar.insertBefore(btn, topbar.firstChild);
    } else {
      var bar = document.createElement("div");
      bar.className = "m-bar";
      var title = document.createElement("div");
      title.className = "m-bar-title";
      bar.appendChild(btn);
      bar.appendChild(title);
      main.insertBefore(bar, main.firstChild);
      updateTitle();
      new MutationObserver(updateTitle).observe(sidebar, { attributes: true, subtree: true, attributeFilter: ["class"] });
    }

    // вибір пункту меню закриває меню
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest(".nav-item, .nav-sub")) setTimeout(closeMenu, 60);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
  }

  function closeMenu() { document.body.classList.remove("m-menu-open"); }

  function updateTitle() {
    var el = document.querySelector(".m-bar-title");
    if (!el) return;
    var active = document.querySelector(".sidebar .nav-item.active");
    el.textContent = clean(active ? active.textContent : "") || clean(document.title.split("—").pop());
  }

  // ── Таблиці → картки ────────────────────────────────────────────────
  function skipTable(t) {
    if (t.dataset.mKeep !== undefined) return true;
    if (t.closest("#pageHours, .modal, .settings-table")) return true;   // сітка годин лишається сіткою
    if (/analytics/i.test(location.pathname)) return true;
    return false;
  }

  function headerLabels(t) {
    var row = t.tHead && t.tHead.rows[t.tHead.rows.length - 1];
    if (!row) return null;
    var labels = [];
    for (var i = 0; i < row.cells.length; i++) {
      var c = row.cells[i];
      var span = c.colSpan || 1;
      var text = c.querySelector("input,select") ? "" : clean(c.textContent);
      for (var k = 0; k < span; k++) labels.push(text);
    }
    return labels.some(Boolean) ? labels : null;
  }

  function titleIndex(labels) {
    for (var p = 0; p < TITLE_HEADERS.length; p++)
      for (var i = 0; i < labels.length; i++) if (TITLE_HEADERS[p].test(labels[i])) return i;
    return -1;
  }

  function isEmptyCell(td) {
    if (td.querySelector("input,select,button,img,svg,a,.badge,.pill,.dot,.trend")) return false;
    var t = clean(td.textContent);
    return t === "" || t === "—" || t === "-";
  }

  // клітинка лише з кнопками (Edytuj, Historia…) — без підпису, кнопки праворуч
  function isActionCell(td) {
    if (!td.querySelector("button")) return false;
    var copy = td.cloneNode(true);
    copy.querySelectorAll("button").forEach(function (b) { b.remove(); });
    return clean(copy.textContent) === "";
  }

  function toCards(t) {
    var labels = headerLabels(t);
    if (!labels) return;
    var ti = titleIndex(labels);
    t.classList.add("m-cards");
    var bodies = t.tBodies;
    for (var b = 0; b < bodies.length; b++) {
      var rows = bodies[b].rows;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].cells;
        if (cells.length === 1 && (cells[0].colSpan || 1) > 1) { rows[r].classList.add("m-group"); continue; }
        var col = 0;
        for (var c = 0; c < cells.length; c++) {
          var td = cells[c];
          if (td.getAttribute("data-label") === null) td.setAttribute("data-label", labels[col] || "");
          td.classList.toggle("m-title", col === ti);
          td.classList.toggle("m-empty", col !== ti && isEmptyCell(td));
          td.classList.toggle("m-actions", col !== ti && isActionCell(td));
          col += td.colSpan || 1;
        }
      }
    }
  }

  function fromCards(t) { t.classList.remove("m-cards"); }

  function processTables() {
    var tables = document.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (MQ.matches && !skipTable(t)) toCards(t); else fromCards(t);
    }
  }

  var timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(processTables, 80); }

  function init() {
    setupMenu();
    processTables();
    // таблиці перемальовуються скриптами сторінок — підписуємо знову
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i].target;
        if (n.nodeType === 1 && (n.tagName === "TBODY" || n.tagName === "TABLE" || n.querySelector && n.querySelector("table"))) {
          schedule(); return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    (MQ.addEventListener ? MQ.addEventListener.bind(MQ, "change") : MQ.addListener.bind(MQ))(function () {
      if (!MQ.matches) closeMenu();
      processTables();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
