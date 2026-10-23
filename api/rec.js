// ══════════════════════════════════════════════════════════════════════
//  Zamówienia · Rekrutacja — замовлення клієнтів і набір під них.  app.use("/api/rec", rec.router); rec.schedule(bot)
//
//  Координатор вводить замовлення (заклад, скільки, склад, дата BHP клієнта) → головний рекрутер підтверджує →
//  координатор отримує в боті «підтверджено — повідомте клієнта» → рекрутація бачить терміни й нестачу.
//  Наше оформлення = BHP мінус N робочих днів (rec.facility.form_days, за замовчуванням 1).
//  «Є» рахується з worker_facility_history: нові на цьому закладі з BHP у вікні замовлення
//  (від оформлення − 3 дні до BHP + 3 дні), без rezygnacja і TEST_; стать — з PESEL (10-та цифра: непарна — чоловік).
//  Поки що розділ бачить лише адмін. Таблиці: db/migration_orders.sql.
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");

router.use(requireAuth);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MATCH_BEFORE = 3, MATCH_AFTER = 3;   // вікно «Є» навколо дат замовлення
const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[rec api]", e);
  res.status(e.code || code).json({ ok: false, error: e.message || String(e) });
};
const bad = (msg) => Object.assign(new Error(msg), { code: 400 });
const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const int = (v, min = 0, max = 500) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : null; };
const txt = (v, max) => String(v == null ? "" : v).trim().slice(0, max) || null;
// N робочих днів до дати (субота й неділя не рахуються): пн 02.11 − 1 → пт 30.10
function workdaysBefore(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

// ── Доступ: поки що лише адмін (потім — ролі «rekrutacja» і «główny rekruter») ──
function access(c) { return { admin: !!c.is_admin, me: c.coordinator_id }; }
router.use((req, res, next) => {
  req.acc = access(req.coordinator);
  if (req.path === "/me") return next();
  if (!req.acc.admin) return res.status(403).json({ ok: false, error: "Brak dostępu" });
  next();
});
router.get("/me", (req, res) => res.json({ ok: true, has_access: req.acc.admin }));

async function log(orderId, by, action, details) {
  await db.query(`INSERT INTO rec.order_log (order_id, by_id, action, details) VALUES ($1, $2, $3, $4)`, [orderId, by, action, details || null]);
}

// ── Довідники ─────────────────────────────────────────────────────────
router.get("/options", async (req, res) => {
  try {
    const [f, pos] = await Promise.all([
      db.query(
        `SELECT f.id, f.name, rg.name AS region, co.full_name AS coordinator, COALESCE(rf.form_days, 1) AS form_days
           FROM facilities f
           LEFT JOIN rec.facility rf ON rf.facility_id = f.id
           LEFT JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
           LEFT JOIN reg.regions rg ON rg.id = so.region_id
           LEFT JOIN coordinators co ON co.id = so.coordinator_id
          WHERE COALESCE(f.is_active, true)
            AND EXISTS (SELECT 1 FROM v_worker_current v WHERE v.facility_id = f.id)
          ORDER BY f.name`),
      db.query(`SELECT position, count(*)::int n FROM rec.orders WHERE position IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    ]);
    const today = todayIso();
    const quick = [];   // найближчі понеділки й вівторки — кнопки дат
    for (let i = 1; quick.length < 4 && i < 21; i++) {
      const d = new Date(today + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      if ([1, 2].includes(d.getUTCDay())) quick.push(d.toISOString().slice(0, 10));
    }
    res.json({ ok: true, today, facilities: f.rows, positions: pos.rows.map((x) => x.position), quick_dates: quick });
  } catch (e) { fail(res, e); }
});

// Дата оформлення для закладу і BHP (форма показує одразу)
router.get("/form-date", async (req, res) => {
  try {
    const bhp = String(req.query.bhp || "");
    if (!ISO.test(bhp)) throw bad("Zła data");
    const r = await db.query(`SELECT COALESCE((SELECT form_days FROM rec.facility WHERE facility_id = $1), 1) AS n`, [int(req.query.facility, 1, 1e9) || 0]);
    const n = r.rows[0].n;
    res.json({ ok: true, form_date: workdaysBefore(bhp, n), form_days: n });
  } catch (e) { fail(res, e, 400); }
});

// ── Замовлення ────────────────────────────────────────────────────────
function orderInput(b, today) {
  const qty = int(b.qty, 1, 500);
  if (!qty) throw bad("Podaj ile osób");
  const any = b.any_gender !== false;
  const men = any ? 0 : int(b.men) || 0, women = any ? 0 : int(b.women) || 0, pairs = any ? 0 : int(b.pairs) || 0;
  if (!any && men + women + 2 * pairs > qty) throw bad(`Skład (${men + women + 2 * pairs}) większy niż zamówienie (${qty})`);
  const bhp = String(b.bhp_date || "");
  if (!ISO.test(bhp)) throw bad("Podaj datę BHP");
  if (bhp < today) throw bad("Data BHP nie może być w przeszłości");
  return {
    qty, any, men, women, pairs, bhp,
    form: ISO.test(String(b.form_date || "")) ? String(b.form_date) : null,
    position: txt(b.position, 120), requirements: txt(b.requirements, 500), mail: txt(b.client_mail, 5000),
  };
}
router.post("/orders", async (req, res) => {
  try {
    const b = req.body || {};
    const facilityId = int(b.facility_id, 1, 1e9);
    const f = await db.query(`SELECT f.id, COALESCE(rf.form_days, 1) AS n FROM facilities f LEFT JOIN rec.facility rf ON rf.facility_id = f.id
                               WHERE f.id = $1 AND COALESCE(f.is_active, true)`, [facilityId]);
    if (!f.rows.length) throw bad("Wybierz obiekt");
    const v = orderInput(b, todayIso());
    const form = v.form || workdaysBefore(v.bhp, f.rows[0].n);
    if (form > v.bhp) throw bad("Oformienie nie może być po BHP");
    const r = await db.query(
      `INSERT INTO rec.orders (facility_id, qty, any_gender, men, women, pairs, bhp_date, form_date, position, requirements, client_mail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [facilityId, v.qty, v.any, v.men, v.women, v.pairs, v.bhp, form, v.position, v.requirements, v.mail, req.acc.me]);
    await log(r.rows[0].id, req.acc.me, "created", { qty: v.qty, bhp: v.bhp, form });
    res.json({ ok: true, id: r.rows[0].id, form_date: form });
  } catch (e) { fail(res, e, 400); }
});

// Список із «Є» / «Бракує»; view: active (new + approved) | done (done / rejected / cancelled) | all
const LIST_SQL = `
  WITH o AS (
    SELECT o.*, f.name AS facility, rg.name AS region, co.full_name AS coordinator, cb.full_name AS created_by_name
      FROM rec.orders o
      JOIN facilities f ON f.id = o.facility_id
      LEFT JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
      LEFT JOIN reg.regions rg ON rg.id = so.region_id
      LEFT JOIN coordinators co ON co.id = so.coordinator_id
      LEFT JOIN coordinators cb ON cb.id = o.created_by
     WHERE ($1::text[] IS NULL OR o.status = ANY($1::text[])) AND ($2::bigint IS NULL OR o.id = $2)
  )
  SELECT o.*, to_char(o.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(o.form_date, 'YYYY-MM-DD') AS form,
         (o.form_date - CURRENT_DATE) AS days_left,
         COALESCE(h.n, 0) AS have, COALESCE(h.men, 0) AS have_men, COALESCE(h.women, 0) AS have_women, COALESCE(h.unknown, 0) AS have_unknown
    FROM o
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT x.worker_id)::int AS n,
             count(DISTINCT x.worker_id) FILTER (WHERE x.sex = 'M')::int AS men,
             count(DISTINCT x.worker_id) FILTER (WHERE x.sex = 'K')::int AS women,
             count(DISTINCT x.worker_id) FILTER (WHERE x.sex IS NULL)::int AS unknown
        FROM (SELECT wh.worker_id,
                     CASE WHEN w.pesel ~ '^[0-9]{11}$' THEN CASE WHEN substr(w.pesel, 10, 1)::int % 2 = 1 THEN 'M' ELSE 'K' END END AS sex
                FROM worker_facility_history wh JOIN workers w ON w.id = wh.worker_id
               WHERE wh.facility_id = o.facility_id
                 AND wh.bhp_date BETWEEN o.form_date - ${MATCH_BEFORE} AND o.bhp_date + ${MATCH_AFTER}
                 AND wh.status::text <> 'rezygnacja' AND COALESCE(w.login, '') NOT LIKE 'TEST_%') x
    ) h ON true
   ORDER BY (o.status NOT IN ('new', 'approved')), o.form_date, o.id`;
function shape(x) {
  const needMen = x.any_gender ? 0 : x.men + x.pairs, needWomen = x.any_gender ? 0 : x.women + x.pairs;
  const miss = Math.max(0, x.qty - x.have);
  return {
    id: Number(x.id), facility_id: x.facility_id, facility: x.facility, region: x.region, coordinator: x.coordinator,
    created_by: x.created_by, created_by_name: x.created_by_name, created_at: x.created_at,
    qty: x.qty, any_gender: x.any_gender, men: x.men, women: x.women, pairs: x.pairs,
    bhp: x.bhp, form: x.form, days_left: x.days_left, position: x.position, requirements: x.requirements, client_mail: x.client_mail,
    status: x.status, note: x.note, approved_at: x.approved_at, notified_at: x.notified_at,
    have: x.have, have_men: x.have_men, have_women: x.have_women, have_unknown: x.have_unknown,
    miss, miss_men: Math.max(0, needMen - x.have_men), miss_women: Math.max(0, needWomen - x.have_women),
    complete: miss === 0,
  };
}
const VIEWS = { active: ["new", "approved"], pending: ["new"], done: ["done", "rejected", "cancelled"], all: null };
router.get("/orders", async (req, res) => {
  try {
    const st = Object.prototype.hasOwnProperty.call(VIEWS, req.query.view) ? VIEWS[req.query.view] : VIEWS.active;
    const r = await db.query(LIST_SQL, [st, null]);
    res.json({ ok: true, today: todayIso(), rows: r.rows.map(shape) });
  } catch (e) { fail(res, e); }
});
router.get("/orders/:id", async (req, res) => {
  try {
    const r = await db.query(LIST_SQL, [null, int(req.params.id, 1, 1e12)]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Nie ma takiego zamówienia" });
    const l = await db.query(
      `SELECT l.at, l.action, l.details, c.full_name AS by_name FROM rec.order_log l LEFT JOIN coordinators c ON c.id = l.by_id
        WHERE l.order_id = $1 ORDER BY l.at`, [r.rows[0].id]);
    res.json({ ok: true, order: shape(r.rows[0]), log: l.rows });
  } catch (e) { fail(res, e); }
});
async function getOrder(id) {
  const r = await db.query(`SELECT * FROM rec.orders WHERE id = $1`, [int(id, 1, 1e12)]);
  if (!r.rows.length) throw Object.assign(new Error("Nie ma takiego zamówienia"), { code: 404 });
  return r.rows[0];
}

// Підтвердити → координатору в бот «повідомте клієнта»
router.post("/orders/:id/approve", async (req, res) => {
  try {
    const o = await getOrder(req.params.id);
    if (o.status !== "new") throw bad("Zamówienie już rozpatrzone");
    await db.query(`UPDATE rec.orders SET status = 'approved', approved_by = $2, approved_at = now(), note = NULL, updated_at = now() WHERE id = $1`, [o.id, req.acc.me]);
    await log(o.id, req.acc.me, "approved");
    const notified = await notify(o.id, "approved");
    res.json({ ok: true, notified });
  } catch (e) { fail(res, e, 400); }
});
router.post("/orders/:id/reject", async (req, res) => {
  try {
    const o = await getOrder(req.params.id);
    const reason = txt((req.body || {}).reason, 500);
    if (!["new", "approved"].includes(o.status)) throw bad("Nie można odrzucić");
    await db.query(`UPDATE rec.orders SET status = 'rejected', note = $2, updated_at = now() WHERE id = $1`, [o.id, reason]);
    await log(o.id, req.acc.me, "rejected", { reason });
    res.json({ ok: true, notified: await notify(o.id, "rejected") });
  } catch (e) { fail(res, e, 400); }
});
router.post("/orders/:id/question", async (req, res) => {
  try {
    const o = await getOrder(req.params.id);
    const q = txt((req.body || {}).text, 500);
    if (!q) throw bad("Wpisz pytanie");
    await db.query(`UPDATE rec.orders SET note = $2, updated_at = now() WHERE id = $1`, [o.id, q]);
    await log(o.id, req.acc.me, "question", { text: q });
    res.json({ ok: true, notified: await notify(o.id, "question") });
  } catch (e) { fail(res, e, 400); }
});
router.post("/orders/:id/status", async (req, res) => {
  try {
    const o = await getOrder(req.params.id);
    const to = String((req.body || {}).status || "");
    const allowed = { done: ["approved"], cancelled: ["new", "approved"], approved: ["done"] };   // done → approved = «знову відкрити»
    if (!allowed[to] || !allowed[to].includes(o.status)) throw bad("Nie można zmienić stanu");
    await db.query(`UPDATE rec.orders SET status = $2, updated_at = now() WHERE id = $1`, [o.id, to]);
    await log(o.id, req.acc.me, to === "approved" ? "reopened" : to);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 400); }
});
router.post("/orders/:id/update", async (req, res) => {
  try {
    const o = await getOrder(req.params.id);
    if (!["new", "approved"].includes(o.status)) throw bad("Zamówienie zamknięte");
    const b = req.body || {};
    const cur = { qty: o.qty, any_gender: o.any_gender, men: o.men, women: o.women, pairs: o.pairs,
      bhp_date: new Intl.DateTimeFormat("sv-SE").format(o.bhp_date), position: o.position, requirements: o.requirements, client_mail: o.client_mail };
    const v = orderInput({ ...cur, ...b }, "0000-00-00");
    const n = (await db.query(`SELECT COALESCE((SELECT form_days FROM rec.facility WHERE facility_id = $1), 1) AS n`, [o.facility_id])).rows[0].n;
    const form = v.form || (b.bhp_date ? workdaysBefore(v.bhp, n) : new Intl.DateTimeFormat("sv-SE").format(o.form_date));
    await db.query(
      `UPDATE rec.orders SET qty = $2, any_gender = $3, men = $4, women = $5, pairs = $6, bhp_date = $7, form_date = $8,
              position = $9, requirements = $10, client_mail = $11, updated_at = now() WHERE id = $1`,
      [o.id, v.qty, v.any, v.men, v.women, v.pairs, v.bhp, form, v.position, v.requirements, v.mail]);
    await log(o.id, req.acc.me, "updated", { from: { qty: o.qty, bhp: cur.bhp_date }, to: { qty: v.qty, bhp: v.bhp, form } });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 400); }
});

// ── Налаштування: оформлення за N робочих днів до BHP ────────────────
router.get("/settings", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT f.id, f.name, COALESCE(rf.form_days, 1) AS form_days, rf.beds_men, rf.beds_women
         FROM facilities f LEFT JOIN rec.facility rf ON rf.facility_id = f.id
        WHERE COALESCE(f.is_active, true) AND EXISTS (SELECT 1 FROM v_worker_current v WHERE v.facility_id = f.id)
        ORDER BY f.name`);
    res.json({ ok: true, rows: r.rows });
  } catch (e) { fail(res, e); }
});
router.post("/settings", async (req, res) => {
  try {
    const b = req.body || {};
    const id = int(b.facility_id, 1, 1e9), n = int(b.form_days, 0, 5);
    if (!id || n == null) throw bad("Złe dane");
    await db.query(
      `INSERT INTO rec.facility (facility_id, form_days, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (facility_id) DO UPDATE SET form_days = EXCLUDED.form_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, n, req.acc.me]);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 400); }
});

// ── Повідомлення координатору (мова з бота координатора) ──────────────
const dmy = (d) => (d ? new Intl.DateTimeFormat("pl-PL", { day: "2-digit", month: "2-digit" }).format(d) : "");
const MSG = {
  uk: {
    approved: (o) => `✅ <b>Замовлення підтверджено</b>\n${o.facility}: ${o.qty} ос. · BHP ${dmy(o.bhp_date)} · наше оформлення ${dmy(o.form_date)}\n\nБудь ласка, повідомте клієнта, що замовлення прийнято.`,
    rejected: (o) => `❌ <b>Замовлення відхилено</b>\n${o.facility}: ${o.qty} ос. · BHP ${dmy(o.bhp_date)}${o.note ? `\nПричина: ${o.note}` : ""}`,
    question: (o) => `❓ <b>Питання щодо замовлення</b>\n${o.facility}: ${o.qty} ос. · BHP ${dmy(o.bhp_date)}\n${o.note}`,
  },
  ru: {
    approved: (o) => `✅ <b>Заказ подтверждён</b>\n${o.facility}: ${o.qty} чел. · BHP ${dmy(o.bhp_date)} · наше оформление ${dmy(o.form_date)}\n\nПожалуйста, сообщите клиенту, что заказ принят.`,
    rejected: (o) => `❌ <b>Заказ отклонён</b>\n${o.facility}: ${o.qty} чел. · BHP ${dmy(o.bhp_date)}${o.note ? `\nПричина: ${o.note}` : ""}`,
    question: (o) => `❓ <b>Вопрос по заказу</b>\n${o.facility}: ${o.qty} чел. · BHP ${dmy(o.bhp_date)}\n${o.note}`,
  },
};
const escH = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
let BOT = null;
async function notify(orderId, kind) {
  try {
    const r = await db.query(
      `SELECT o.*, f.name AS facility, c.telegram_chat_id AS chat, c.id AS cid
         FROM rec.orders o JOIN facilities f ON f.id = o.facility_id LEFT JOIN coordinators c ON c.id = o.created_by WHERE o.id = $1`, [orderId]);
    const o = r.rows[0];
    if (!o || !o.chat || !BOT) return false;
    const coord = await require("../bot/coord").coordById(o.cid);
    const lang = require("../bot/coord").langOf(coord) === "ru" ? "ru" : "uk";
    const safe = { ...o, facility: escH(o.facility), note: escH(o.note) };
    await BOT.telegram.sendMessage(String(o.chat), MSG[lang][kind](safe), { parse_mode: "HTML" });
    if (kind === "approved") await db.query(`UPDATE rec.orders SET notified_at = now() WHERE id = $1`, [orderId]);
    return true;
  } catch (e) {
    console.error(`[rec] notify #${orderId}:`, e.message);
    return false;
  }
}
function schedule(bot) { BOT = bot || null; }

module.exports = { router, schedule, _test: { workdaysBefore, setBot: (b) => { BOT = b; } } };
