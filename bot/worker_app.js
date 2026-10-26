// bot/worker_app.js — міні-застосунок працівника в Telegram (public/tgw/, api/wapp.js): адреса, пілот, кнопки в боті.
//
//  .env (pm2 restart після зміни):
//    TG_WORKER_URL=https://sas-panel.duckdns.org/tgw/   адреса застосунку (HTTPS); без неї кнопок у боті немає
//    WORKER_APP_ONLY=TEST_1,12345                       пілот: лише ці ID працівників (порожньо — усі)
//    WORKER_DOCS_EMAIL=biuro@firma.pl                   куди йдуть документи з застосунку (через кому — кілька)
//
//  Кнопка меню чату (ліворуч від поля вводу) ставиться працівнику один раз — при вході і при першому
//  меню після запуску (session_data.wapp = адреса, з якою поставили). Координаторам не ставимо: у них своя «Panel».
"use strict";

const db = require("../db");

const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const CFG = {
  url: String(process.env.TG_WORKER_URL || "").trim(),
  only: list(process.env.WORKER_APP_ONLY).map((x) => x.toUpperCase()),
  docsEmail: list(process.env.WORKER_DOCS_EMAIL),
};

const enabledFor = (login) => !!CFG.url && (!CFG.only.length || CFG.only.includes(String(login || "").trim().toUpperCase()));
const link = (hash) => CFG.url + (hash || "");

// Текст кнопки — мовою бота працівника
const BTN = { uk: "📱 Застосунок", ru: "📱 Приложение", pl: "📱 Aplikacja", en: "📱 App" };
const MENU = { uk: "Застосунок", ru: "Приложение", pl: "Aplikacja", en: "App" };
const langOf = (l) => (BTN[l] ? l : "uk");

// Рядок inline-кнопок для меню працівника (або null, якщо застосунок не для нього)
function keyboardRow(login, lang, hash) {
  if (!enabledFor(login)) return null;
  return [{ text: BTN[langOf(lang)], web_app: { url: link(hash) } }];
}

async function tg(method, params) {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, description: "no BOT_TOKEN" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

// Кнопка меню чату — раз на адресу (session.wapp), лише працівникам пілоту і не координаторам
async function ensureMenuButton(chatId, session) {
  if (!session || !session.workerId || !enabledFor(session.workerLogin) || session.wapp === CFG.url) return false;
  try {
    const c = await db.query(`SELECT 1 FROM public.coordinators WHERE telegram_chat_id = $1 AND COALESCE(is_active, true) LIMIT 1`, [chatId]);
    if (c.rows.length) return false;
  } catch (e) { /* без таблиці координаторів — як працівнику */ }
  const r = await tg("setChatMenuButton", {
    chat_id: chatId,
    menu_button: { type: "web_app", text: MENU[langOf(session.lang)], web_app: { url: CFG.url } },
  });
  if (!r || !r.ok) {
    console.error(`[wapp] menu button ${chatId}: ${r && r.description}`);
    return false;
  }
  session.wapp = CFG.url;
  return true;
}

module.exports = { CFG, enabledFor, link, keyboardRow, ensureMenuButton, tg };
