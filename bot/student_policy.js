// bot/student_policy.js — номер полісу приватного медичного страхування студентів (wapp.student_policy, db/migration_student_policy.sql).
//
//  Номер один на всіх на місяць; приходить, як правило, 10 числа — на поточний місяць.
//  Вводить координатор STUDENT_POLICY_COORD (.env, id акаунта панелі; кілька — через кому; за замовчуванням 6 — Denys Brychka),
//  у боті координатора (bot/coord.js):
//    • з DUE_DAY числа щодня о REMIND_AT, поки номера на поточний місяць немає, — нагадування з полем відповіді;
//      відповідь на нього (reply) і є номер;
//    • /polis — поточний номер і поле, щоб ввести новий; кнопка «Змінити» під підтвердженням.
//  Новий або змінений номер — повідомлення в боті кожному студенту, який має право (notify): «номер оновлено, ваш номер …».
//  Кому показуємо (міні-застосунок працівника — api/wapp.js, картка в боті координатора):
//    в останній анкеті HRappka з питанням «…objęciem prywatnym ubezpieczeniem zdrowotnym?» відповідь TAK
//    (hrs.surveys, bot/hr_sign.js) і статус студента не закінчився. Показуємо останній внесений номер —
//    до 10 числа це ще номер минулого місяця (з назвою його місяця).
"use strict";

const db = require("../db");

const DUE_DAY = 10;
const REMIND_AT = "10:00";
const COORDS = String(process.env.STUDENT_POLICY_COORD || "6").split(/[,;\s]+/).map(Number).filter(Boolean);
// Номер полісу: латиниця, цифри, / - . і пробіли; хоч одна цифра
const NUMBER = /^(?=.*\d)[A-Za-z0-9/.\- ]{3,40}$/;

const clean = (s) => String(s || "").trim().replace(/\s+/g, " ").toUpperCase();
const valid = (s) => NUMBER.test(clean(s));

// Останній внесений номер → { month: "YYYY-MM", number } або null
async function latest() {
  const r = await db.query(`SELECT to_char(month, 'YYYY-MM') AS month, number FROM wapp.student_policy ORDER BY month DESC LIMIT 1`);
  return r.rows[0] || null;
}
async function ofMonth(ym) {
  const r = await db.query(`SELECT number FROM wapp.student_policy WHERE month = $1::date`, [`${ym}-01`]);
  return r.rows[0] ? r.rows[0].number : null;
}
// → true, якщо номер новий або змінився (тоді й повідомляємо студентів)
async function save(ym, number, coordinatorId) {
  const before = await ofMonth(ym);
  await db.query(
    `INSERT INTO wapp.student_policy (month, number, coordinator_id, entered_at) VALUES ($1::date, $2, $3, now())
     ON CONFLICT (month) DO UPDATE SET number = EXCLUDED.number, coordinator_id = EXCLUDED.coordinator_id, entered_at = now()`,
    [`${ym}-01`, clean(number), coordinatorId || null]);
  return before !== clean(number);
}

// Повідомлення студентам, які мають право (TAK в останній анкеті, статус студента не закінчився), у боті й ще працюють.
// Не залежить від WORKER_APP_ONLY: номер — у самому тексті; кнопка застосунку — лише кому він відкритий.
const MONTH_LOC = { uk: "uk-UA", ru: "ru-RU", pl: "pl-PL", en: "en-GB" };
const TX = {
  uk: (m, n) => `🎓 Номер полісу медичного страхування оновлено.\nВаш номер на ${m}: ${n}`,
  ru: (m, n) => `🎓 Номер полиса медицинского страхования обновлён.\nВаш номер на ${m}: ${n}`,
  pl: (m, n) => `🎓 Numer polisy ubezpieczenia zdrowotnego został zaktualizowany.\nTwój numer na ${m}: ${n}`,
  en: (m, n) => `🎓 Your health insurance policy number has been updated.\nYour number for ${m}: ${n}`,
};
const monthOf = (lang, ym) => `${new Intl.DateTimeFormat(MONTH_LOC[lang] || MONTH_LOC.uk, { month: "long", timeZone: "UTC" })
  .format(new Date(ym + "-15T12:00:00Z"))} ${ym.slice(0, 4)}`;
async function recipients() {
  const r = await db.query(
    `SELECT w.id, w.login, w.telegram_chat_id, COALESCE(w.session_data->>'lang', w.lang::text) AS lang
       FROM (SELECT DISTINCT ON (worker_id) worker_id, answers->>'insurance' AS ins FROM hrs.surveys
              WHERE answers ? 'insurance' ORDER BY worker_id, hr_created_at DESC NULLS LAST, hr_answer_id DESC) a
       JOIN workers w ON w.id = a.worker_id JOIN v_worker_current vc ON vc.id = w.id
       LEFT JOIN wapp.student s ON s.worker_id = w.id
      WHERE a.ins = 'TAK' AND w.telegram_chat_id IS NOT NULL AND vc.status::text NOT IN ('zwolniony', 'rezygnacja')
        AND NOT (s.is_student AND s.valid_until < CURRENT_DATE)`);
  return r.rows;
}
async function notify(ym, number) {
  const wapp = require("./worker_app");
  const list = await recipients();
  let sent = 0;
  for (const x of list) {
    const lang = TX[x.lang] ? x.lang : "uk";
    const row = wapp.keyboardRow(x.login, lang, "#student");
    const r = await wapp.tg("sendMessage", { chat_id: x.telegram_chat_id, text: TX[lang](monthOf(lang, ym), clean(number)),
      ...(row ? { reply_markup: { inline_keyboard: [row] } } : {}) });
    if (r && r.ok) sent++; else console.error(`[policy] ${x.id}: ${r && r.description}`);
    await new Promise((res) => setTimeout(res, 60));
  }
  console.log(`[policy] номер ${ym} оновлено — повідомлено ${sent}/${list.length}`);
  return { sent, total: list.length };
}

// Відповідь в останній анкеті з питанням про страхування → { [worker_id]: "TAK" | "NIE" }
async function consent(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const r = await db.query(
    `SELECT DISTINCT ON (worker_id) worker_id, answers->>'insurance' AS ins
       FROM hrs.surveys WHERE worker_id = ANY($1::int[]) AND answers ? 'insurance'
      ORDER BY worker_id, hr_created_at DESC NULLS LAST, hr_answer_id DESC`, [ids]);
  for (const x of r.rows) out[x.worker_id] = x.ins;
  return out;
}

// Для працівника: null — не питали (анкети без цього питання); { consent: "NIE" }; { consent: "TAK", number, month }.
// number = null — номера ще не вносили (або статус студента закінчився: studentState зі bot/student.js = expired).
async function forWorker(workerId, studentState) {
  const ins = (await consent([workerId]))[workerId];
  if (!ins) return null;
  if (ins !== "TAK") return { consent: "NIE" };
  const p = studentState === "expired" ? null : await latest();
  return { consent: "TAK", number: p ? p.number : null, month: p ? p.month : null };
}

const isEditor = (coordinatorId) => COORDS.includes(Number(coordinatorId));

module.exports = { DUE_DAY, REMIND_AT, COORDS, latest, ofMonth, save, notify, recipients, consent, forWorker, isEditor, valid, clean, TX };
