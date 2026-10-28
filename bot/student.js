// bot/student.js — статус студента (таблиця wapp.student, db/migration_wapp.sql, db/migration_wapp_student.sql).
//
//  Звідки статус:
//    hrappka — «Student od» / «Student do» з картки HRappka (attrdef_id_61654 / 61655): syncHr після кожного імпорту
//              HRappka (bot/hr_import.js, 6 разів на день) — окремих запитів до HRappka не робимо. Дати міняємо, лише
//              коли вони змінились у HRappka (hr_from / hr_until — що бачили востаннє);
//    app     — працівник надіслав довідку з міні-застосунку (api/wapp.js → fromUpload): status = sent, «чекає перевірки».
//              Дату «дійсна до» з його слів беремо, лише якщо HRappka про статус нічого не знає;
//    panel   — ручна правка (upsert).
//  Стан (stateOf): none — не студент / немає даних; active — чинний; expiring — закінчується за REMIND_DAYS днів;
//                  expired — термін минув; unknown — студент, але без дати.
//  Повідомлення працівнику в боті — лише тим, кому відкритий міні-застосунок (WORKER_APP_ONLY; порожньо — усім):
//    • щодня о 10:30 (remindDue): за REMIND_DAYS (≈1,5 місяця) до кінця — раз на тиждень «донесіть нову довідку»,
//      після кінця — один раз «статус закінчився»; хто щойно надіслав довідку з застосунку (PENDING_DAYS) — не нагадуємо;
//    • одразу після імпорту HRappka (notifyAccepted): «довідку прийнято», коли «Student do» в HRappka посунулось пізніше
//      (або з'явилось після довідки з застосунку). Лише тим, хто працює і має Telegram.
"use strict";

const db = require("../db");
const wapp = require("./worker_app");

const REMIND_DAYS = 45;    // за стільки днів до кінця — щотижневі нагадування (і стан «expiring»)
const REMIND_EVERY = 7;
const PENDING_DAYS = 14;   // довідка з застосунку чекає перевірки — стільки днів не нагадуємо
const EXPIRE_SOON = REMIND_DAYS;
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
  if (row.valid_until <= addDays(t, EXPIRE_SOON)) return "expiring";
  return "active";
}

const ROW_SQL = `SELECT s.worker_id, s.is_student, to_char(s.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(s.valid_until, 'YYYY-MM-DD') AS valid_until,
                        s.school, s.source, s.status, s.note, s.doc_id, s.updated_at, d.created_at AS doc_at, to_char(d.valid_until, 'YYYY-MM-DD') AS doc_until
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

// Ручний запис статусу (панель). Нова дата «дійсна до» — нагадування знову можливі.
async function upsert(workerId, x) {
  const valid = ISO.test(String(x.valid_until || "")) ? x.valid_until : null;
  const from = ISO.test(String(x.valid_from || "")) ? x.valid_from : null;
  const source = ["app", "hrappka", "panel"].includes(x.source) ? x.source : "panel";
  const status = ["sent", "accepted", "rejected"].includes(x.status) ? x.status : source === "app" ? "sent" : "accepted";
  await db.query(
    `INSERT INTO wapp.student (worker_id, is_student, valid_from, valid_until, school, source, doc_id, status, note, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (worker_id) DO UPDATE SET
       is_student = EXCLUDED.is_student, valid_from = COALESCE(EXCLUDED.valid_from, wapp.student.valid_from), valid_until = EXCLUDED.valid_until,
       school = COALESCE(EXCLUDED.school, wapp.student.school), source = EXCLUDED.source,
       doc_id = COALESCE(EXCLUDED.doc_id, wapp.student.doc_id), status = EXCLUDED.status, note = EXCLUDED.note,
       reminded_for = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.reminded_for END,
       expired_for  = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.expired_for END,
       updated_at = now()`,
    [workerId, x.is_student !== false, from, valid, x.school ? String(x.school).trim().slice(0, 200) : null, source, x.doc_id || null, status, x.note || null],
  );
  return get(workerId);
}

// Довідка з міні-застосунку: «чекає перевірки». Статус з HRappka (hr_until) не чіпаємо — його змінить офіс у HRappka;
// без HRappka — дата зі слів працівника.
async function fromUpload(workerId, docId, validUntil, school) {
  await db.query(
    `INSERT INTO wapp.student (worker_id, is_student, valid_until, school, source, doc_id, status, updated_at)
     VALUES ($1, true, $2, $3, 'app', $4, 'sent', now())
     ON CONFLICT (worker_id) DO UPDATE SET
       is_student = true, school = COALESCE(EXCLUDED.school, wapp.student.school), doc_id = EXCLUDED.doc_id, status = 'sent', updated_at = now(),
       valid_until  = CASE WHEN wapp.student.hr_until IS NULL THEN EXCLUDED.valid_until ELSE wapp.student.valid_until END,
       source       = CASE WHEN wapp.student.hr_until IS NULL THEN 'app' ELSE wapp.student.source END,
       reminded_for = CASE WHEN wapp.student.hr_until IS NULL AND wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.reminded_for END,
       expired_for  = CASE WHEN wapp.student.hr_until IS NULL AND wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.expired_for END`,
    [workerId, ISO.test(String(validUntil || "")) ? validUntil : null, school ? String(school).trim().slice(0, 200) : null, docId || null]);
  return get(workerId);
}

// ── HRappka → wapp.student ─────────────────────────────────────────────
// rows — Map worker_id → { hr_from, hr_until, status } (наявні рядки); hr — [{ worker_id, from, to }] — кожен працівник,
// чия картка HRappka є в знімку (без дат студента — from/to null). first — HRappka ще жодного разу не писала: без повідомлень.
// → set: що записати (дати HRappka), accepted: кому написати «довідку прийнято».
function hrPlan(rows, hr, { first = false, today = todayIso() } = {}) {
  const set = [], accepted = [];
  for (const x of hr) {
    const r = rows.get(x.worker_id);
    const has = !!(x.from || x.to);
    if (!r) { if (has) set.push(x); continue; }
    if ((r.hr_from || null) === (x.from || null) && (r.hr_until || null) === (x.to || null)) continue;   // у HRappka без змін
    if (!has && !r.hr_from && !r.hr_until) continue;   // HRappka про статус не знає і не знала — рядок з застосунку не чіпаємо
    set.push(x);
    if (!first && x.to && x.to >= today && (r.hr_until ? x.to > r.hr_until : r.status === "sent")) accepted.push(x.worker_id);
  }
  return { set, accepted };
}

// people — знімок HRappka (bot/hr_import.js → toPerson: studentFrom / studentTo); client — транзакція імпорту
async function syncHr(client, people, today = todayIso()) {
  const byHr = new Map(people.map((p) => [String(p.id), p]));
  const ws = (await client.query(`SELECT id, hr_employee_id::text AS hr FROM public.workers WHERE hr_employee_id IS NOT NULL`)).rows;
  const hr = ws.filter((w) => byHr.has(w.hr)).map((w) => {
    const p = byHr.get(w.hr);
    return { worker_id: w.id, from: p.studentFrom || null, to: p.studentTo || null };
  });
  const cur = (await client.query(
    `SELECT worker_id, to_char(hr_from, 'YYYY-MM-DD') AS hr_from, to_char(hr_until, 'YYYY-MM-DD') AS hr_until, status FROM wapp.student`)).rows;
  const first = !cur.some((r) => r.hr_from || r.hr_until);
  const { set, accepted } = hrPlan(new Map(cur.map((r) => [r.worker_id, r])), hr, { first, today });
  if (set.length) {
    await client.query(
      `INSERT INTO wapp.student (worker_id, is_student, valid_from, valid_until, hr_from, hr_until, source, status, updated_at)
       SELECT id, (f IS NOT NULL OR u IS NOT NULL), f, u, f, u, 'hrappka', 'accepted', now() FROM unnest($1::int[], $2::date[], $3::date[]) AS t(id, f, u)
       ON CONFLICT (worker_id) DO UPDATE SET
         is_student = EXCLUDED.is_student, valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
         hr_from = EXCLUDED.hr_from, hr_until = EXCLUDED.hr_until, source = 'hrappka', status = 'accepted',
         reminded_for = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.reminded_for END,
         expired_for  = CASE WHEN wapp.student.valid_until IS DISTINCT FROM EXCLUDED.valid_until THEN NULL ELSE wapp.student.expired_for END,
         updated_at = now()`,
      [set.map((x) => x.worker_id), set.map((x) => x.from), set.map((x) => x.to)]);
  }
  return { students: hr.filter((x) => x.from || x.to).length, changed: set.length, accepted, first };
}

// ── Повідомлення працівнику ────────────────────────────────────────────
const DAYS = {
  uk: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "дні" : "днів"}`,
  ru: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "дня" : "дней"}`,
  pl: (n) => `${n} ${n === 1 ? "dzień" : "dni"}`,
  en: (n) => `${n} ${n === 1 ? "day" : "days"}`,
};
const TX = {
  uk: {
    soon: (d, n) => `🎓 Ваш статус студента діє до ${d}${n > 0 ? ` (залишилось ${DAYS.uk(n)})` : ""}. Щоб його продовжити, потрібна нова довідка з навчального закладу — надішліть її через застосунок.`,
    gone: (d) => `🎓 Ваш статус студента закінчився ${d}. Потрібна нова довідка з навчального закладу — надішліть її через застосунок якнайшвидше.`,
    ok: (from, to) => `✅ Нову довідку прийнято. Статус студента діє ${from ? `з ${from} ` : ""}до ${to}.`,
  },
  ru: {
    soon: (d, n) => `🎓 Ваш статус студента действует до ${d}${n > 0 ? ` (осталось ${DAYS.ru(n)})` : ""}. Чтобы его продлить, нужна новая справка из учебного заведения — отправьте её через приложение.`,
    gone: (d) => `🎓 Ваш статус студента закончился ${d}. Нужна новая справка из учебного заведения — отправьте её через приложение как можно скорее.`,
    ok: (from, to) => `✅ Новую справку приняли. Статус студента действует ${from ? `с ${from} ` : ""}до ${to}.`,
  },
  pl: {
    soon: (d, n) => `🎓 Twój status studenta jest ważny do ${d}${n > 0 ? ` (zostało ${DAYS.pl(n)})` : ""}. Aby go przedłużyć, potrzebne jest nowe zaświadczenie z uczelni — wyślij je przez aplikację.`,
    gone: (d) => `🎓 Twój status studenta wygasł ${d}. Potrzebne jest nowe zaświadczenie z uczelni — wyślij je przez aplikację jak najszybciej.`,
    ok: (from, to) => `✅ Nowe zaświadczenie przyjęte. Status studenta jest ważny ${from ? `od ${from} ` : ""}do ${to}.`,
  },
  en: {
    soon: (d, n) => `🎓 Your student status is valid until ${d}${n > 0 ? ` (${DAYS.en(n)} left)` : ""}. To extend it, you need a new certificate from your school — send it in the app.`,
    gone: (d) => `🎓 Your student status expired on ${d}. You need a new certificate from your school — send it in the app as soon as possible.`,
    ok: (from, to) => `✅ Your new certificate has been accepted. Student status is valid ${from ? `from ${from} ` : ""}until ${to}.`,
  },
};

const WHO = `w.id, w.login, w.telegram_chat_id, COALESCE(w.session_data->>'lang', w.lang::text) AS lang,
             to_char(s.valid_from, 'YYYY-MM-DD') AS f, to_char(s.valid_until, 'YYYY-MM-DD') AS d`;
// працівник у боті й ще працює
const ACTIVE = `w.telegram_chat_id IS NOT NULL AND vc.status::text NOT IN ('zwolniony', 'rezygnacja')`;
// застосунок відкритий працівнику (bot/worker_app.js → enabledFor): $n — логіни пілоту (WORKER_APP_ONLY), null — усім, {} — нікому
const IN_APP = (n) => `($${n}::text[] IS NULL OR upper(trim(w.login)) = ANY($${n}::text[]))`;
const appLogins = () => (!wapp.CFG.url ? [] : wapp.CFG.only.length ? wapp.CFG.only : null);
// довідку з застосунку щойно надіслали — чекає перевірки в офісі
const NOT_PENDING = `NOT (s.status = 'sent' AND EXISTS (SELECT 1 FROM wapp.docs d WHERE d.id = s.doc_id AND d.created_at > now() - make_interval(days => ${PENDING_DAYS})))`;

async function send(x, text, hash) {
  const row = wapp.keyboardRow(x.login, x.lang, hash);
  const r = await wapp.tg("sendMessage", { chat_id: x.telegram_chat_id, text, ...(row ? { reply_markup: { inline_keyboard: [row] } } : {}) });
  if (!(r && r.ok)) console.error(`[student] ${x.id}: ${r && r.description}`);
  await new Promise((res) => setTimeout(res, 60));
  return !!(r && r.ok);
}

// Рядок «забираємо» одним UPDATE (два процеси не надішлють двічі)
async function remindDue(today) {
  const t = today || todayIso();
  const soon = await db.query(
    `UPDATE wapp.student s SET reminded_for = s.valid_until, reminded_at = $1::date
       FROM workers w JOIN v_worker_current vc ON vc.id = w.id
      WHERE w.id = s.worker_id AND s.is_student AND s.valid_until >= $1::date AND s.valid_until <= $1::date + $2::int
        AND (s.reminded_at IS NULL OR s.reminded_at <= $1::date - $3::int) AND ${NOT_PENDING} AND ${ACTIVE} AND ${IN_APP(4)}
      RETURNING ${WHO}, s.valid_until - $1::date AS left`,
    [t, REMIND_DAYS, REMIND_EVERY, appLogins()]);
  const gone = await db.query(
    `UPDATE wapp.student s SET expired_for = s.valid_until
       FROM workers w JOIN v_worker_current vc ON vc.id = w.id
      WHERE w.id = s.worker_id AND s.is_student AND s.valid_until < $1::date AND s.valid_until >= $1::date - 7
        AND s.expired_for IS DISTINCT FROM s.valid_until AND ${NOT_PENDING} AND ${ACTIVE} AND ${IN_APP(2)}
      RETURNING ${WHO}`,
    [t, appLogins()]);
  let sent = 0;
  for (const x of soon.rows) {
    const tx = TX[x.lang] || TX.uk;
    if (await send(x, tx.soon(dmy(x.d), Number(x.left)), "#student")) sent++;
  }
  for (const x of gone.rows) {
    const tx = TX[x.lang] || TX.uk;
    if (await send(x, tx.gone(dmy(x.d)), "#student")) sent++;
  }
  if (soon.rows.length || gone.rows.length) console.log(`[student] нагадування: ${sent}/${soon.rows.length + gone.rows.length}`);
  return { soon: soon.rows.length, gone: gone.rows.length, sent };
}

// «Довідку прийнято» — після імпорту HRappka (syncHr → accepted)
async function notifyAccepted(ids) {
  if (!ids || !ids.length) return 0;
  const r = await db.query(
    `SELECT ${WHO} FROM wapp.student s JOIN workers w ON w.id = s.worker_id JOIN v_worker_current vc ON vc.id = w.id
      WHERE s.worker_id = ANY($1::int[]) AND s.is_student AND s.valid_until IS NOT NULL AND ${ACTIVE} AND ${IN_APP(2)}`, [ids, appLogins()]);
  let sent = 0;
  for (const x of r.rows) if (await send(x, (TX[x.lang] || TX.uk).ok(dmy(x.f), dmy(x.d)), "#student")) sent++;
  console.log(`[student] довідку прийнято: ${sent}/${r.rows.length} (змінилось у HRappka ${ids.length})`);
  return sent;
}

function schedule() {
  const cron = require("node-cron");
  cron.schedule("30 10 * * *", async () => {
    try { await remindDue(); } catch (e) { console.error("[student] нагадування:", e.message); }
  }, { timezone: WAW });
}

module.exports = { get, many, upsert, fromUpload, stateOf, hrPlan, syncHr, remindDue, notifyAccepted, schedule, EXPIRE_SOON, REMIND_DAYS, TX };
