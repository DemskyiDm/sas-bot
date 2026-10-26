// bot/student.js — статус студента (таблиця wapp.student, db/migration_wapp.sql).
//
//  Звідки статус:
//    app     — працівник надіслав довідку з міні-застосунку (api/wapp.js → fromUpload): дата «дійсна до» — з його слів;
//    hrappka — пізніше: синхронізація з HRappka викликатиме upsert(workerId, { …, source: "hrappka" });
//    panel   — ручна правка в панелі (теж через upsert).
//  Стан (stateOf): none — не студент / немає даних; active — довідка чинна; expiring — закінчується за EXPIRE_SOON днів;
//                  expired — термін минув; unknown — студент, але без дати.
//  Нагадування працівнику в боті (10:30): за EXPIRE_SOON днів до кінця і в день після закінчення — по одному разу на дату.
"use strict";

const db = require("../db");
const wapp = require("./worker_app");

const EXPIRE_SOON = 14;
const WAW = "Europe/Warsaw";
const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function stateOf(row, today) {
  if (!row || !row.is_student) return "none";
  if (!row.valid_until) return "unknown";
  const t = today || todayIso();
  if (row.valid_until < t) return "expired";
  if (row.valid_until < addDays(t, EXPIRE_SOON)) return "expiring";
  return "active";
}

const ROW_SQL = `SELECT s.worker_id, s.is_student, to_char(s.valid_until, 'YYYY-MM-DD') AS valid_until, s.school, s.source, s.status,
                        s.note, s.doc_id, s.updated_at, d.created_at AS doc_at
                   FROM wapp.student s LEFT JOIN wapp.docs d ON d.id = s.doc_id`;

async function get(workerId) {
  const r = await db.query(`${ROW_SQL} WHERE s.worker_id = $1`, [workerId]);
  const row = r.rows[0] || null;
  return row ? { ...row, state: stateOf(row) } : { state: "none" };
}

// Кілька працівників одним запитом (картка в боті координатора, списки) → { [worker_id]: {...} }
async function many(ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const r = await db.query(`${ROW_SQL} WHERE s.worker_id = ANY($1::int[])`, [ids]);
  for (const row of r.rows) out[row.worker_id] = { ...row, state: stateOf(row) };
  return out;
}

// Запис статусу з будь-якого джерела. Нова дата «дійсна до» — нагадування знову можливі.
async function upsert(workerId, x) {
  const valid = ISO.test(String(x.valid_until || "")) ? x.valid_until : null;
  const source = ["app", "hrappka", "panel"].includes(x.source) ? x.source : "panel";
  const status = ["sent", "accepted", "rejected"].includes(x.status) ? x.status : source === "app" ? "sent" : "accepted";
  await db.query(
    `INSERT INTO wapp.student (worker_id, is_student, valid_until, school, source, doc_id, status, note, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (worker_id) DO UPDATE SET
       is_student = EXCLUDED.is_student, valid_until = EXCLUDED.valid_until,
       school = COALESCE(EXCLUDED.school, wapp.student.school), source = EXCLUDED.source,
       doc_id = COALESCE(EXCLUDED.doc_id, wapp.student.doc_id), status = EXCLUDED.status, note = EXCLUDED.note,
       reminded_for = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.reminded_for END,
       expired_for  = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.expired_for END,
       updated_at = now()`,
    [workerId, x.is_student !== false, valid, x.school ? String(x.school).trim().slice(0, 200) : null, source, x.doc_id || null, status, x.note || null],
  );
  return get(workerId);
}

const fromUpload = (workerId, docId, validUntil, school) =>
  upsert(workerId, { is_student: true, valid_until: validUntil, school, source: "app", doc_id: docId, status: "sent" });

// ── Нагадування працівнику ─────────────────────────────────────────────
const TX = {
  uk: {
    soon: (d) => `🎓 Довідка студента діє до ${d}. Надішліть нову довідку в офіс — через застосунок.`,
    gone: (d) => `🎓 Довідка студента закінчилась ${d}. Надішліть нову якнайшвидше — через застосунок.`,
  },
  ru: {
    soon: (d) => `🎓 Справка студента действует до ${d}. Отправьте новую справку в офис — через приложение.`,
    gone: (d) => `🎓 Справка студента закончилась ${d}. Отправьте новую как можно скорее — через приложение.`,
  },
  pl: {
    soon: (d) => `🎓 Zaświadczenie studenta jest ważne do ${d}. Wyślij nowe do biura — przez aplikację.`,
    gone: (d) => `🎓 Zaświadczenie studenta wygasło ${d}. Wyślij nowe jak najszybciej — przez aplikację.`,
  },
  en: {
    soon: (d) => `🎓 Your student certificate is valid until ${d}. Send a new one to the office — in the app.`,
    gone: (d) => `🎓 Your student certificate expired on ${d}. Send a new one as soon as possible — in the app.`,
  },
};

// Працівник у боті, ще працює; рядок «забираємо» одним UPDATE (два процеси не надішлють двічі)
async function remindDue(today) {
  const t = today || todayIso();
  const soon = await db.query(
    `UPDATE wapp.student s SET reminded_for = s.valid_until
       FROM workers w JOIN v_worker_current vc ON vc.id = w.id
      WHERE w.id = s.worker_id AND s.is_student AND s.valid_until >= $1::date AND s.valid_until < $1::date + $2::int
        AND s.reminded_for IS DISTINCT FROM s.valid_until AND w.telegram_chat_id IS NOT NULL
        AND vc.status::text NOT IN ('zwolniony', 'rezygnacja')
      RETURNING w.id, w.login, w.telegram_chat_id, COALESCE(w.session_data->>'lang', w.lang::text) AS lang, to_char(s.valid_until, 'YYYY-MM-DD') AS d`,
    [t, EXPIRE_SOON]);
  const gone = await db.query(
    `UPDATE wapp.student s SET expired_for = s.valid_until
       FROM workers w JOIN v_worker_current vc ON vc.id = w.id
      WHERE w.id = s.worker_id AND s.is_student AND s.valid_until < $1::date AND s.valid_until >= $1::date - 7
        AND s.expired_for IS DISTINCT FROM s.valid_until AND w.telegram_chat_id IS NOT NULL
        AND vc.status::text NOT IN ('zwolniony', 'rezygnacja')
      RETURNING w.id, w.login, w.telegram_chat_id, COALESCE(w.session_data->>'lang', w.lang::text) AS lang, to_char(s.valid_until, 'YYYY-MM-DD') AS d`,
    [t]);
  let sent = 0;
  const go = async (x, key) => {
    const tx = TX[x.lang] || TX.uk;
    const row = wapp.keyboardRow(x.login, x.lang, "#student");
    const r = await wapp.tg("sendMessage", {
      chat_id: x.telegram_chat_id, text: tx[key](dmy(x.d)), ...(row ? { reply_markup: { inline_keyboard: [row] } } : {}),
    });
    if (r && r.ok) sent++;
    else console.error(`[student] ${key} ${x.id}: ${r && r.description}`);
    await new Promise((res) => setTimeout(res, 60));
  };
  for (const x of soon.rows) await go(x, "soon");
  for (const x of gone.rows) await go(x, "gone");
  if (soon.rows.length || gone.rows.length) console.log(`[student] нагадування: ${sent}/${soon.rows.length + gone.rows.length}`);
  return { soon: soon.rows.length, gone: gone.rows.length, sent };
}

function schedule() {
  const cron = require("node-cron");
  cron.schedule("30 10 * * *", async () => {
    try { await remindDue(); } catch (e) { console.error("[student] нагадування:", e.message); }
  }, { timezone: WAW });
}

module.exports = { get, many, upsert, fromUpload, stateOf, remindDue, schedule, EXPIRE_SOON };
