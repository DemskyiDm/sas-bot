// bot/fines.js — ⚠️ штрафи (kary) працівникам. Таблиці: db/migration_fines.sql.
//   • виписує координатор з правом редагування обʼєкта, регіональний — у своїх регіонах, адмін / head — будь-де;
//     з картки працівника в боті (кнопка «Штраф» → мініпанель) або з веб-панелі (Kary → Nowa kara);
//   • працівник отримує повідомлення в бот своєю мовою — про виписку, зміну і скасування;
//   • змінити / скасувати: поки не надіслано в офіс — той, хто може виписати на цьому обʼєкті; після — лише адмін;
//   • список: свої обʼєкти / регіон / уся фірма (bot/coord.js → facsOf), як аванси;
//   • в офіс — листом з Excel через bot/office.js (kind 'fin'), як аванси й медогляд;
//   • типи й суми за замовчуванням змінює адмін / head (fin.types);
//   • тестові працівники (login TEST_…): штраф виписати можна, але він не входить у підсумки й не йде в офіс.
// API — api/tg.js (спільне для мініпанелі й веб-панелі).
"use strict";

const db = require("../db");

const coord = () => require("./coord");
const WAW = "Europe/Warsaw";
const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(new Date());
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const BACK_DAYS = 120;          // штраф можна датувати до 120 днів назад
const AMOUNT_MAX = 100000;
const NOTE_MAX = 300;
const NAME_MAX = 120;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const err = (error) => ({ ok: false, error });

// Надіслано в офіс (tgc.office_items kind 'fin') — дата останнього листа
const SENT_SQL = `(SELECT max(m.sent_at) FROM tgc.office_items i JOIN tgc.office_mails m ON m.id = i.mail_id AND m.status = 'sent'
                    WHERE i.kind = 'fin' AND i.ref_id = f.id)`;

// ── Доступ ────────────────────────────────────────────────────────────
const isManager = (c) => !!(c.is_admin || c.role === "head");
// Заклади, де c може виписувати: null — будь-де (адмін / head); інакше — з правом редагування + регіони, де він регіональний
async function issueFacs(c) {
  if (isManager(c)) return null;
  const r = await db.query(
    `SELECT cf.facility_id FROM coordinator_facilities cf
      WHERE cf.coordinator_id = $1
        AND (cf.is_primary OR EXISTS (SELECT 1 FROM reg.v_access v
              WHERE v.coordinator_id = cf.coordinator_id AND v.facility_id = cf.facility_id AND 'lead' = ANY(v.kinds)))`, [c.id])
    .catch(() => db.query(`SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1 AND is_primary`, [c.id]));
  return r.rows.map((x) => Number(x.facility_id));
}
const canIssueOn = (facs, facilityId) => facs === null || (facilityId != null && facs.includes(Number(facilityId)));
// Змінити / скасувати: не скасований; надісланий в офіс — лише адмін
const canChange = (c, facs, x) => !x.cancelled_at && (x.sent_at ? !!c.is_admin : canIssueOn(facs, x.facility_id));

// ── Типи ──────────────────────────────────────────────────────────────
async function types(all) {
  const r = await db.query(
    `SELECT id, name_pl, name_uk, name_ru, amount, sort, is_active FROM fin.types
      ${all ? "" : "WHERE is_active"} ORDER BY sort, name_pl`);
  return r.rows.map((x) => ({ ...x, amount: x.amount == null ? null : num(x.amount) }));
}
async function saveType(c, b) {
  if (!isManager(c)) return err("forbidden");
  const name = (k) => String((b && b[k]) || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  const pl = name("name_pl");
  if (!pl) return err("name_required");
  const amount = b.amount === "" || b.amount == null ? null : num(b.amount);
  if (amount != null && !(amount > 0 && amount <= AMOUNT_MAX)) return err("bad_amount");
  const sort = Number.isInteger(Number(b.sort)) ? Number(b.sort) : 100;
  const vals = [pl, name("name_uk") || null, name("name_ru") || null, amount, sort, b.is_active !== false, c.id];
  const id = parseInt(b.id, 10);
  const r = id
    ? await db.query(
      `UPDATE fin.types SET name_pl = $1, name_uk = $2, name_ru = $3, amount = $4, sort = $5, is_active = $6, updated_by = $7, updated_at = now()
        WHERE id = $8 RETURNING id`, [...vals, id])
    : await db.query(
      `INSERT INTO fin.types (name_pl, name_uk, name_ru, amount, sort, is_active, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, vals);
  return r.rows.length ? { ok: true, id: r.rows[0].id } : err("not_found");
}

// ── Працівник: дані для форми ─────────────────────────────────────────
// Прізвище / імʼя — як у медогляді (bot/office.js → splitName)
const office = () => require("./office");
async function workerInfo(c, workerId) {
  const id = parseInt(workerId, 10);
  if (!id) return err("not_found");
  const f = await coord().facsOf(c, "wide");
  const r = await db.query(
    `SELECT w.id, w.full_name, w.login, to_jsonb(w)->>'last_name' AS last_name, to_jsonb(w)->>'first_name' AS first_name,
            vw.facility_id, fa.name AS facility, vw.status::text AS status, w.telegram_chat_id IS NOT NULL AS in_bot,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = w.id
                       AND h.work_date >= date_trunc('month', CURRENT_DATE) AND h.work_date <= CURRENT_DATE), 0) AS hours_month,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = w.id
                       AND h.work_date >= date_trunc('month', CURRENT_DATE) - interval '1 month'
                       AND h.work_date <  date_trunc('month', CURRENT_DATE)), 0) AS hours_prev
       FROM workers w
       JOIN v_worker_current vw ON vw.id = w.id
       LEFT JOIN facilities fa  ON fa.id = vw.facility_id
      WHERE w.id = $1 AND ($2::int[] IS NULL OR vw.facility_id = ANY($2::int[]))`, [id, f.all]);
  const x = r.rows[0];
  if (!x) return err("not_found");
  const n = office().splitName(x);
  const facs = await issueFacs(c);
  const fines = await list(c, { workerId: id, limit: 20, facs });
  return {
    ok: true,
    worker: {
      id: x.id, full_name: x.full_name, last_name: n.last, first_name: n.first, login: x.login,
      facility_id: x.facility_id, facility: x.facility || "—", status: x.status, in_bot: x.in_bot,
      hours_month: num(x.hours_month), hours_prev: num(x.hours_prev),
    },
    can_issue: canIssueOn(facs, x.facility_id),
    fines: fines.rows,
    types: await types(false),
    today: todayIso(), min_date: addDays(todayIso(), -BACK_DAYS),
  };
}
// Пошук для форми (веб і мініпанель): прізвище або паспорт, у межах найширшого зрізу
async function search(c, qRaw) {
  const q = String(qRaw || "").trim().replace(/\s+/g, " ");
  if (q.replace(/\s/g, "").length < 2) return [];
  const f = await coord().facsOf(c, "wide");
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const r = await db.query(
    `SELECT w.id, w.full_name, w.login, fa.name AS facility, vw.status::text AS status
       FROM workers w
       JOIN v_worker_current vw ON vw.id = w.id
       LEFT JOIN facilities fa ON fa.id = vw.facility_id
      WHERE (w.full_name ILIKE $1 OR w.login ILIKE $1)
        AND ($2::int[] IS NULL OR vw.facility_id = ANY($2::int[]))
      ORDER BY (vw.status::text = 'pracuje') DESC, (w.login LIKE 'TEST_%'), w.full_name LIMIT 15`, [like, f.all]);
  return r.rows;
}

// ── Список ────────────────────────────────────────────────────────────
// o: { facIds (null — усі), month 'YYYY-MM', facilityId, typeId, status: open | sent | cancelled | '' , workerId, ids, limit, facs }
async function list(c, o) {
  const p = [];
  const w = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace("$?", `$${p.length}`)); };
  if (o.facIds) add("f.facility_id = ANY($?::int[])", o.facIds);
  if (o.workerId) add("f.worker_id = $?", o.workerId);
  if (o.ids) add("f.id = ANY($?::bigint[])", o.ids);
  if (o.month && MONTH.test(o.month)) add("date_trunc('month', f.fine_date) = ($?::text || '-01')::date", o.month);
  if (o.facilityId) add("f.facility_id = $?", parseInt(o.facilityId, 10));
  if (o.typeId) add("f.type_id = $?", parseInt(o.typeId, 10));
  const r = await db.query(
    `SELECT f.id, f.worker_id, w.full_name, w.login, to_jsonb(w)->>'last_name' AS last_name, to_jsonb(w)->>'first_name' AS first_name,
            f.facility_id, fa.name AS facility, f.type_id, f.type_name, t.name_uk, t.name_ru, f.amount,
            to_char(f.fine_date, 'YYYY-MM-DD') AS fine_date, f.note, f.created_at, cb.full_name AS created_by_name, f.created_by,
            f.updated_at, f.cancelled_at, xb.full_name AS cancelled_by_name, f.cancel_reason, ${SENT_SQL} AS sent_at
       FROM fin.fines f
       JOIN workers w ON w.id = f.worker_id
       LEFT JOIN facilities fa ON fa.id = f.facility_id
       LEFT JOIN fin.types t ON t.id = f.type_id
       LEFT JOIN coordinators cb ON cb.id = f.created_by
       LEFT JOIN coordinators xb ON xb.id = f.cancelled_by
      ${w.length ? "WHERE " + w.join(" AND ") : ""}
      ORDER BY f.fine_date DESC, f.id DESC
      ${o.limit ? `LIMIT ${Number(o.limit)}` : "LIMIT 2000"}`, p);
  const facs = o.facs !== undefined ? o.facs : await issueFacs(c);
  let rows = r.rows.map((x) => {
    const n = office().splitName(x);
    const st = x.cancelled_at ? "cancelled" : x.sent_at ? "sent" : "open";
    return { ...x, last_name: n.last, first_name: n.first, amount: num(x.amount), status: st, can_change: canChange(c, facs, x),
      is_test: /^TEST_/i.test(x.login || "") };
  });
  if (o.status) rows = rows.filter((x) => x.status === o.status);
  return { rows };
}
// Для сторінки Kary: зріз, фільтри, підсумки
async function page(c, q) {
  const f = await coord().facsOf(c, ["own", "region", "all"].includes(q.scope) ? q.scope : undefined);
  const month = MONTH.test(String(q.month || "")) ? q.month : todayIso().slice(0, 7);
  const facs = await issueFacs(c);
  const all = await list(c, { facIds: f.all, month, facs });
  const rows = all.rows.filter((x) => (!q.facility || String(x.facility_id) === String(q.facility))
    && (!q.type || String(x.type_id) === String(q.type)) && (!q.status || x.status === q.status));
  const live = rows.filter((x) => x.status !== "cancelled" && !x.is_test);   // тестові — не в підсумках
  const facilities = [...new Map(all.rows.filter((x) => x.facility_id).map((x) => [x.facility_id, x.facility])).entries()]
    .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  return {
    ok: true, scope: f.scope, scopes: f.avail, month, rows, facilities,
    kpi: { count: live.length, sum: num(live.reduce((a, x) => a + x.amount, 0)), open: live.filter((x) => x.status === "open").length,
      open_sum: num(live.filter((x) => x.status === "open").reduce((a, x) => a + x.amount, 0)) },
    types: await types(true), can_manage: isManager(c), can_issue_any: facs === null || facs.length > 0, is_admin: !!c.is_admin,
  };
}
// Для листа в офіс: не надіслані, не скасовані, на обʼєктах, де c може виписувати
async function forSend(c, ids) {
  const facs = await issueFacs(c);
  const r = await list(c, { ids, facIds: facs, facs });
  return r.rows.filter((x) => x.status === "open" && !x.is_test);   // тестові в офіс не йдуть
}
async function unsent(c, f) {
  const facs = await issueFacs(c);
  const ids = f && f.all ? (facs === null ? f.all : facs.filter((id) => f.all.includes(id))) : facs;
  return (await list(c, { facIds: ids, facs })).rows.filter((x) => x.status === "open" && !x.is_test);
}

// ── Виписати / змінити / скасувати ────────────────────────────────────
async function input(b, typeRow) {
  const amount = num(b.amount);
  if (!(amount > 0 && amount <= AMOUNT_MAX)) return err("bad_amount");
  const date = ISO.test(String(b.fine_date || "")) ? String(b.fine_date) : todayIso();
  if (date > todayIso() || date < addDays(todayIso(), -BACK_DAYS)) return err("bad_date");
  const note = String(b.note || "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;
  if (!typeRow) return err("bad_type");
  return { ok: true, amount, date, note };
}
async function typeById(id) {
  const r = await db.query(`SELECT id, name_pl, name_uk, name_ru, amount, is_active FROM fin.types WHERE id = $1`, [parseInt(id, 10) || 0]);
  return r.rows[0] || null;
}
async function issue(c, b) {
  const wi = await workerInfo(c, b && b.worker_id);
  if (!wi.ok) return wi;
  if (!wi.can_issue) return err("forbidden");
  const t = await typeById(b.type_id);
  if (t && !t.is_active) return err("bad_type");
  const v = await input(b, t);
  if (!v.ok) return v;
  const r = await db.query(
    `INSERT INTO fin.fines (worker_id, facility_id, type_id, type_name, amount, fine_date, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [wi.worker.id, wi.worker.facility_id, t.id, t.name_pl, v.amount, v.date, v.note, c.id]);
  const id = r.rows[0].id;
  const notified = await notify("new", id);
  console.log(`[fines] #${id} by coordinator ${c.id}: worker ${wi.worker.id}, ${t.name_pl} ${v.amount} zł`);
  return { ok: true, id, notified };
}
async function one(c, id) {
  const r = await list(c, { ids: [parseInt(id, 10) || 0] });
  return r.rows[0] || null;
}
async function update(c, id, b) {
  const x = await one(c, id);
  if (!x) return err("not_found");
  if (!x.can_change) return err(x.sent_at ? "sent_admin_only" : "forbidden");
  const t = await typeById(b.type_id);
  const v = await input(b, t);
  if (!v.ok) return v;
  await db.query(
    `UPDATE fin.fines SET type_id = $2, type_name = $3, amount = $4, fine_date = $5, note = $6, updated_by = $7, updated_at = now()
      WHERE id = $1 AND cancelled_at IS NULL`, [x.id, t.id, t.name_pl, v.amount, v.date, v.note, c.id]);
  const notified = await notify("edit", x.id);
  return { ok: true, notified };
}
async function cancel(c, id, reason) {
  const x = await one(c, id);
  if (!x) return err("not_found");
  if (!x.can_change) return err(x.cancelled_at ? "already_cancelled" : x.sent_at ? "sent_admin_only" : "forbidden");
  await db.query(
    `UPDATE fin.fines SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1 AND cancelled_at IS NULL`,
    [x.id, c.id, String(reason || "").trim().slice(0, NOTE_MAX) || null]);
  const notified = await notify("cancel", x.id);
  return { ok: true, notified };
}

// ── Повідомлення працівнику (мова з бота працівника) ──────────────────
const MSG = {
  uk: { new: "⚠️ <b>Вам виписано штраф</b>", edit: "✏️ <b>Штраф змінено</b>", cancel: "✅ <b>Штраф скасовано</b>",
    date: "Дата", note: "Коментар", ask: "Якщо є питання — зверніться до свого координатора." },
  ru: { new: "⚠️ <b>Вам выписан штраф</b>", edit: "✏️ <b>Штраф изменён</b>", cancel: "✅ <b>Штраф отменён</b>",
    date: "Дата", note: "Комментарий", ask: "Если есть вопросы — обратитесь к своему координатору." },
  pl: { new: "⚠️ <b>Otrzymujesz karę</b>", edit: "✏️ <b>Kara została zmieniona</b>", cancel: "✅ <b>Kara została anulowana</b>",
    date: "Data", note: "Uwagi", ask: "W razie pytań skontaktuj się ze swoim koordynatorem." },
};
let BOT = null;
async function notify(kind, id) {
  if (!BOT) return false;
  try {
    const r = await db.query(
      `SELECT f.type_name, f.amount, to_char(f.fine_date, 'YYYY-MM-DD') AS d, f.note, t.name_uk, t.name_ru,
              w.telegram_chat_id AS chat, w.lang
         FROM fin.fines f JOIN workers w ON w.id = f.worker_id LEFT JOIN fin.types t ON t.id = f.type_id
        WHERE f.id = $1`, [id]);
    const x = r.rows[0];
    if (!x || !x.chat) return false;
    const lang = MSG[x.lang] ? x.lang : "uk";
    const m = MSG[lang];
    const name = (lang === "uk" && x.name_uk) || (lang === "ru" && x.name_ru) || x.type_name;
    const L = [m[kind], `${esc(name)}: <b>${num(x.amount)} zł</b>`, `${m.date}: ${dmy(x.d)}`];
    if (x.note && kind !== "cancel") L.push(`${m.note}: ${esc(x.note)}`);
    if (kind !== "cancel") L.push("", m.ask);
    await BOT.telegram.sendMessage(String(x.chat), L.join("\n"), { parse_mode: "HTML" });
    return true;
  } catch (e) {
    console.error(`[fines] notify #${id}:`, e.message);
    return false;
  }
}
function schedule(bot) { BOT = bot; }

module.exports = {
  types, saveType, workerInfo, search, list, page, forSend, unsent, issue, update, cancel, schedule,
  issueFacs, isManager, BACK_DAYS, NOTE_MAX, AMOUNT_MAX,
};
