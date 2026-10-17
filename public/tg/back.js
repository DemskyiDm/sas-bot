// Повна панель, відкрита з мініпанелі Telegram (/tg/): кнопка «Назад» Telegram і кнопка на сторінці → назад у мініпанель.
// У звичайному браузері нічого не робить (прапорець sas_tg ставить лише мініпанель у вікні Telegram).
(function () {
  var flag = null;
  try { flag = sessionStorage.getItem("sas_tg"); } catch (e) { flag = null; }
  if (!flag) return;
  var home = "/tg/#home";
  var back = function () { location.href = home; };
  var s = document.createElement("script");
  s.src = "https://telegram.org/js/telegram-web-app.js";
  s.onload = function () {
    try {
      var w = window.Telegram && window.Telegram.WebApp;
      if (!w) return;
      w.BackButton.onClick(back);
      w.BackButton.show();
    } catch (e) { /* старий клієнт — лишається кнопка на сторінці */ }
  };
  document.head.appendChild(s);
  var add = function () {
    var a = document.createElement("a");
    a.href = home;
    a.textContent = "‹ KoorPanel";
    a.setAttribute("aria-label", "KoorPanel");
    a.style.cssText = "position:fixed;right:12px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:9998;" +
      "padding:9px 14px;border-radius:20px;background:#23395e;color:#cfe0ff;font:600 13px system-ui,sans-serif;" +
      "text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.4);border:1px solid #34507e";
    document.body.appendChild(a);
  };
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
