// bot/student_policy.js — номер полісу приватного медичного страхування студентів (wapp.student_policy, db/migration_student_policy.sql).
//
//  Номер один на всіх на місяць; приходить, як правило, 10 числа — на поточний місяць.
//  Вводить координатор STUDENT_POLICY_COORD (.env, id акаунта панелі; кілька — через кому; за замовчуванням 6 — Denys Brychka),
//  у боті координатора (bot/coord.js):
//    • з DUE_DAY числа щодня о REMIND_AT, поки номера на поточний місяць немає, — нагадування з полем відповіді;
//      відповідь на нього (reply) і є номер;
//    • /polis — поточний номер і поле, щоб ввести новий; кнопка «Змінити» під підтвердженням.
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
async function save(ym, number, coordinatorId) {
  await db.query(
    `INSERT INTO wapp.student_policy (month, number, coordinator_id, entered_at) VALUES ($1::date, $2, $3, now())
     ON CONFLICT (month) DO UPDATE SET number = EXCLUDED.number, coordinator_id = EXCLUDED.coordinator_id, entered_at = now()`,
    [`${ym}-01`, clean(number), coordinatorId || null]);
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

module.exports = { DUE_DAY, REMIND_AT, COORDS, latest, ofMonth, save, consent, forWorker, isEditor, valid, clean };
