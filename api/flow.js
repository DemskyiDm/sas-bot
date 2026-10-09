// ══════════════════════════════════════════════════════════════════════
//  Розділ «Wyjazdy / przyjazdy»: виїзди, приїзди, план набору.
//  Монтується в index.js:  app.use("/api/flow", flow.router)
//                          flow.schedule(bot)   — планувальник
//                          flow.onUpdate(body)  — у вебхуку, перед handleUpdate
//
//  Дані — з worker_facility_history (таблиця → імпорт). Журнал змін (flow.rows,
//  flow.changes) пишеться після кожного імпорту: так видно, що вписали після зведення.
//  Правила виїздів / приїздів — у db/migration_flow.sql (flow.departures / flow.arrivals).
//
//  Доступ: адмін і роль head — уся компанія; регіональний — свої регіони
//  (+ свої об'єкти); координатор — свої об'єкти (reg.site_owner). Налаштування — адмін.
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const IMG = require("./flow_img");   // картинки-таблиці (Telegram, форма «image»)

// ── Утиліти ───────────────────────────────────────────────────────────
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay() || 7;
  return addDays(iso, 1 - dow);
}
const dd = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) : "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const hmToMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minToHm = (n) => `${String(Math.floor(((n % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((n % 60) + 60) % 60).padStart(2, "0")}`;

// Не більше 3 одночасних запитів розділу: пул з'єднань спільний з ботом
const MAX_PARALLEL = 3;
let running = 0;
const waiting = [];
async function query(text, params) {
  if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await db.query(text, params);
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}
const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[flow api]", e);
  res.status(code).json({ ok: false, error: e.message || String(e) });
};

async function getSettings() {
  const r = await db.query(`SELECT key, value FROM flow.settings`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}
async function clock() {
  const r = await db.query(
    `SELECT to_char(flow.today(), 'YYYY-MM-DD') AS today,
            to_char(now() AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') AS hm,
            EXTRACT(ISODOW FROM flow.today())::int AS dow`,
  );
  return r.rows[0];
}

// ── Доступ ────────────────────────────────────────────────────────────
async function scopeOf(c) {
  const me = c.coordinator_id;
  if (c.is_admin || c.role === "head") return { role: "all", admin: !!c.is_admin, me, regionIds: [] };
  const r = await db.query(
    `SELECT rl.region_id FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
      WHERE rl.coordinator_id = $1 AND rg.is_active ORDER BY 1`,
    [me],
  );
  if (r.rows.length) return { role: "lead", admin: false, me, regionIds: r.rows.map((x) => Number(x.region_id)) };
  const o = await db.query(`SELECT 1 FROM reg.site_owner WHERE valid_to IS NULL AND coordinator_id = $1 LIMIT 1`, [me]);
  return { role: o.rows.length ? "coord" : "none", admin: false, me, regionIds: [] };
}
const siteAllowed = (sc, s) =>
  sc.role === "all" || (s.region_id != null && sc.regionIds.includes(Number(s.region_id))) || s.coordinator_id === sc.me;

async function allSites() {
  const r = await query(`SELECT * FROM flow.sites() ORDER BY site_key`);
  return r.rows.map((x) => ({ ...x, region_id: x.region_id == null ? null : Number(x.region_id) }));
}
// Об'єкти в межах доступу і фільтрів (region: all | none | id; coord: id)
async function scopedSites(sc, q) {
  let s = (await allSites()).filter((x) => siteAllowed(sc, x));
  if (sc.role === "coord") return s;   // координатор бачить свої об'єкти, фільтри не діють
  const reg = parseInt(q.region, 10);
  if (q.region === "none" && sc.role === "all") s = s.filter((x) => x.region_id == null);
  else if (reg && (sc.role === "all" || sc.regionIds.includes(reg))) s = s.filter((x) => x.region_id === reg);
  if (q.coord) s = s.filter((x) => x.coordinator_id === parseInt(q.coord, 10));
  return s;
}

router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    req.fscope = await scopeOf(req.coordinator);
  } catch (e) {
    return fail(res, e);
  }
  if (req.path === "/me") return next();
  if (req.fscope.role === "none") return res.status(403).json({ ok: false, error: "Brak dostępu" });
  next();
});
const adminOnly = (req, res, next) => (req.fscope.admin ? next() : res.status(403).json({ ok: false, error: "Tylko administrator" }));

// ══════════════════════════════════════════════════════════════════════
//  Дані
// ══════════════════════════════════════════════════════════════════════
// План–факт тижня по об'єктах
async function weekData(week, siteKeys, today) {
  const [r, w] = await Promise.all([
    query(
      `WITH dep AS (SELECT * FROM flow.departures($1::date, $1::date + 6) WHERE site_key = ANY($2::text[])),
            arr AS (SELECT * FROM flow.arrivals($1::date, $1::date + 6) WHERE site_key = ANY($2::text[])),
            pl  AS (SELECT * FROM flow.week_plan WHERE week_start = $1::date AND site_key = ANY($2::text[])),
            o   AS (SELECT * FROM flow.v_orders WHERE week_start = $1::date AND site_key = ANY($2::text[])),
            a AS (
              SELECT site_key,
                     count(*) FILTER (WHERE kind = 'new' AND status <> 'rezygnacja')::int AS arr_entered,
                     count(*) FILTER (WHERE kind = 'new' AND status NOT IN ('rezygnacja', 'unknown') AND move_date <= $3::date)::int AS arr_fact,
                     count(*) FILTER (WHERE kind = 'new' AND status = 'unknown' AND move_date <= $3::date)::int AS arr_unconf,
                     count(*) FILTER (WHERE kind = 'new' AND status = 'rezygnacja')::int AS arr_rez,
                     count(*) FILTER (WHERE kind = 'transfer' AND status <> 'rezygnacja')::int AS tr_entered,
                     count(*) FILTER (WHERE kind = 'transfer' AND status NOT IN ('rezygnacja', 'unknown') AND move_date <= $3::date)::int AS tr_fact
                FROM arr GROUP BY site_key),
            d AS (
              SELECT site_key, count(*)::int AS dep_now,
                     count(*) FILTER (WHERE move_date <= $3::date)::int AS dep_fact,
                     count(*) FILTER (WHERE move_date <= $3::date AND is_transfer)::int AS dep_fact_tr,
                     count(*) FILTER (WHERE move_date <= $3::date AND NOT EXISTS (
                       SELECT 1 FROM pl WHERE pl.worker_id = dep.worker_id AND pl.site_key = dep.site_key))::int AS dep_unplanned
                FROM dep GROUP BY site_key),
            p AS (
              SELECT site_key, count(*)::int AS dep_plan,
                     count(*) FILTER (WHERE NOT EXISTS (
                       SELECT 1 FROM dep WHERE dep.worker_id = pl.worker_id AND dep.site_key = pl.site_key))::int AS plan_moved
                FROM pl GROUP BY site_key)
       SELECT s.k AS site_key, o.qty AS order_qty,
              to_char(o.entered_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS order_at,
              (o.entered_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Warsaw') AS order_in_week,
              COALESCE(a.arr_entered, 0) AS arr_entered, COALESCE(a.arr_fact, 0) AS arr_fact,
              COALESCE(a.arr_unconf, 0) AS arr_unconf, COALESCE(a.arr_rez, 0) AS arr_rez,
              COALESCE(a.tr_entered, 0) AS tr_entered, COALESCE(a.tr_fact, 0) AS tr_fact,
              COALESCE(d.dep_now, 0) AS dep_now, COALESCE(d.dep_fact, 0) AS dep_fact,
              COALESCE(d.dep_fact_tr, 0) AS dep_fact_tr, COALESCE(d.dep_unplanned, 0) AS dep_unplanned,
              COALESCE(p.dep_plan, 0) AS dep_plan, COALESCE(p.plan_moved, 0) AS plan_moved
         FROM unnest($2::text[]) AS s(k)
         LEFT JOIN o ON o.site_key = s.k
         LEFT JOIN a ON a.site_key = s.k
         LEFT JOIN d ON d.site_key = s.k
         LEFT JOIN p ON p.site_key = s.k`,
      [week, siteKeys, today],
    ),
    query(`SELECT to_char(fixed_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS fixed_at, late
             FROM flow.weeks WHERE week_start = $1::date`, [week]),
  ]);
  const fixed = w.rows[0] || null;
  const rows = r.rows.map((x) => ({
    ...x,
    dep_plan: fixed ? x.dep_plan : null,
    plan_moved: fixed ? x.plan_moved : null,
    dep_unplanned: fixed ? x.dep_unplanned : null,
  }));
  return { rows, fixed };
}

const SUM_KEYS = ["order_qty", "arr_entered", "arr_fact", "arr_unconf", "arr_rez", "tr_entered", "tr_fact",
  "dep_now", "dep_fact", "dep_fact_tr", "dep_unplanned", "dep_plan", "plan_moved"];
function totals(rows) {
  const t = {};
  for (const k of SUM_KEYS) {
    const vals = rows.map((x) => x[k]).filter((v) => v != null);
    t[k] = vals.length ? vals.reduce((a, b) => a + Number(b), 0) : null;
  }
  t.sites_with_order = rows.filter((x) => x.order_qty != null).length;
  return t;
}

// Люди за видом списку (для розгортання цифр)
const ARR_KINDS = {
  arr_entered: `a.kind = 'new' AND a.status <> 'rezygnacja'`,
  arr_fact: `a.kind = 'new' AND a.status NOT IN ('rezygnacja', 'unknown') AND a.move_date <= $4::date`,
  arr_unconf: `a.kind = 'new' AND a.status = 'unknown' AND a.move_date <= $4::date`,
  arr_rez: `a.kind = 'new' AND a.status = 'rezygnacja'`,
  tr_entered: `a.kind = 'transfer' AND a.status <> 'rezygnacja'`,
  arr_all: `true`,
};
const DEP_KINDS = {
  dep_now: `true`,
  dep_fact: `d.move_date <= $4::date`,
  dep_fact_tr: `d.move_date <= $4::date AND d.is_transfer`,
  dep_unplanned: `d.move_date <= $4::date AND NOT EXISTS (SELECT 1 FROM flow.week_plan pl
                    WHERE pl.week_start = $5::date AND pl.worker_id = d.worker_id AND pl.site_key = d.site_key)`,
};
// Postgres не приймає зайвих параметрів: передаємо стільки, скільки $n у запиті
function qp(sql, params) {
  const max = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return query(sql, params.slice(0, max));
}
async function listPeople(kind, from, to, siteKeys, today, week) {
  if (ARR_KINDS[kind]) {
    const r = await qp(
      `SELECT a.worker_id, w.full_name, w.login, a.site_key, to_char(a.move_date, 'YYYY-MM-DD') AS date,
              a.status, a.kind, a.from_site,
              to_char(r.first_seen_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS seen_at, r.baseline
         FROM flow.arrivals($1::date, $2::date) a
         JOIN public.workers w ON w.id = a.worker_id
         LEFT JOIN flow.rows r ON r.hid = a.hid
        WHERE a.site_key = ANY($3::text[]) AND ${ARR_KINDS[kind]}
        ORDER BY a.move_date, a.site_key, w.full_name`,
      [from, to, siteKeys, today],
    );
    return r.rows;
  }
  if (DEP_KINDS[kind]) {
    const r = await qp(
      `SELECT d.worker_id, w.full_name, w.login, d.site_key, to_char(d.move_date, 'YYYY-MM-DD') AS date,
              d.status, d.is_transfer, d.to_site, to_char(d.bhp_date, 'YYYY-MM-DD') AS bhp,
              to_char(r.lwd_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS seen_at, r.baseline,
              CASE WHEN r.lwd_at IS NOT NULL AND NOT r.baseline
                   THEN d.move_date - (r.lwd_at AT TIME ZONE 'Europe/Warsaw')::date END AS notice_days
         FROM flow.departures($1::date, $2::date) d
         JOIN public.workers w ON w.id = d.worker_id
         LEFT JOIN flow.rows r ON r.hid = d.hid
        WHERE d.site_key = ANY($3::text[]) AND ${DEP_KINDS[kind]}
        ORDER BY d.move_date, d.site_key, w.full_name`,
      [from, to, siteKeys, today, week || from],
    );
    return r.rows;
  }
  if (kind === "dep_plan" || kind === "plan_moved") {
    const r = await query(
      `SELECT pl.worker_id, w.full_name, w.login, pl.site_key, to_char(pl.move_date, 'YYYY-MM-DD') AS date,
              pl.is_transfer, to_char(cur.move_date, 'YYYY-MM-DD') AS now_date,
              (cur.worker_id IS NOT NULL) AS still_leaving
         FROM flow.week_plan pl
         JOIN public.workers w ON w.id = pl.worker_id
         LEFT JOIN flow.departures($1::date, $1::date + 6) cur
                ON cur.worker_id = pl.worker_id AND cur.site_key = pl.site_key
        WHERE pl.week_start = $1::date AND pl.site_key = ANY($2::text[])
          AND ($3::boolean = false OR cur.worker_id IS NULL)
        ORDER BY pl.move_date, pl.site_key, w.full_name`,
      [week || from, siteKeys, kind === "plan_moved"],
    );
    return r.rows;
  }
  throw Object.assign(new Error("Nieznana lista"), { code: 400 });
}

// Тижні для плану набору: 3 тижні від найближчого понеділка (у неділю — від завтра)
function orderWeeks(today) {
  const m1 = addDays(mondayOf(today), 7);
  return [m1, addDays(m1, 7), addDays(m1, 14)];
}
// Підтвердження плану діє від останньої суботи 00:00 (польський час): у суботу всі
// підтвердження на наступні 3 тижні знімаються — цифри лишаються, координатор
// підтверджує їх заново («Zapisz») до неділі orders_deadline.
const CONFIRM_DOW = 6;                                    // 6 = субота
function confirmFrom(today) {
  const dow = new Date(today + "T00:00:00Z").getUTCDay(); // 0 = нд … 6 = сб
  return addDays(today, -((dow - CONFIRM_DOW + 7) % 7));
}

// Темп набору: скільки % плану тижня має бути набрано до кінця дня (pace = пн,вт,ср,чт,пт; сб і нд — 100%).
// Обʼєкт відстає (червоний), якщо набір з понеділка менший за round(план × темп).
function paceOf(st, day) {
  const p = String((st && st.pace) || "20,40,60,80,100").split(",").map(Number);
  const dow = new Date(day + "T00:00:00Z").getUTCDay() || 7;   // 1 = пн … 7 = нд
  const v = dow <= 5 ? p[dow - 1] : 100;
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
}
const isLagging = (fact, plan, pace) => plan != null && Number(plan) > 0 && Number(fact) < Math.round((Number(plan) * pace) / 100);

// ══════════════════════════════════════════════════════════════════════
//  API
// ══════════════════════════════════════════════════════════════════════
router.get("/me", async (req, res) => {
  try {
    const sc = req.fscope;
    if (sc.role === "none") return res.json({ ok: true, has_access: false });
    const [sites, ck, regs] = await Promise.all([
      scopedSites(sc, {}),
      clock(),
      query(`SELECT id, name FROM reg.regions WHERE is_active ORDER BY name`),
    ]);
    const regions = regs.rows.filter((r) => sc.role === "all" || sc.regionIds.includes(Number(r.id)));
    const coords = {};
    sites.forEach((s) => { if (s.coordinator_id) coords[s.coordinator_id] = s.coordinator_name; });
    res.json({
      ok: true, has_access: true, role: sc.role, is_admin: sc.admin, me: sc.me,
      today: ck.today, week: mondayOf(ck.today), order_weeks: orderWeeks(ck.today),
      sites: sites.length,
      regions,
      coordinators: Object.entries(coords).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) { fail(res, e); }
});

// Тиждень: план–факт по об'єктах
router.get("/week", async (req, res) => {
  try {
    const ck = await clock();
    const week = isDate(req.query.week) ? mondayOf(req.query.week) : mondayOf(ck.today);
    const sites = await scopedSites(req.fscope, req.query);
    const { rows, fixed } = await weekData(week, sites.map((s) => s.site_key), ck.today);
    const meta = Object.fromEntries(sites.map((s) => [s.site_key, s]));
    const out = rows.map((x) => ({
      ...x,
      region_name: meta[x.site_key].region_name, region_id: meta[x.site_key].region_id,
      coordinator_name: meta[x.site_key].coordinator_name, coordinator_id: meta[x.site_key].coordinator_id,
    }));
    const state = week > ck.today ? "future" : addDays(week, 6) < ck.today ? "past" : "current";
    res.json({ ok: true, week, week_end: addDays(week, 6), today: ck.today, state, fixed, rows: out, total: totals(out) });
  } catch (e) { fail(res, e); }
});

// Список людей за цифрою
router.get("/list", async (req, res) => {
  try {
    const ck = await clock();
    let sites = await scopedSites(req.fscope, req.query);
    if (req.query.site) sites = sites.filter((s) => s.site_key === req.query.site);
    const keys = sites.map((s) => s.site_key);
    let from, to, week = null;
    if (isDate(req.query.date)) { from = to = req.query.date; }
    else { week = isDate(req.query.week) ? mondayOf(req.query.week) : mondayOf(ck.today); from = week; to = addDays(week, 6); }
    const rows = await listPeople(String(req.query.kind || ""), from, to, keys, ck.today, week);
    const meta = Object.fromEntries(sites.map((s) => [s.site_key, s]));
    res.json({ ok: true, rows: rows.map((x) => ({ ...x, coordinator_name: (meta[x.site_key] || {}).coordinator_name || null })) });
  } catch (e) { fail(res, e, e.code === 400 ? 400 : 500); }
});

// Експорт поіменно за період (до 93 днів): хто закінчив, хто почав, план виїздів тижня.
// План / поза планом — за планом того тижня, у який припадає дата (фіксація в пн 0:00).
router.get("/export", async (req, res) => {
  try {
    const ck = await clock();
    const from = isDate(req.query.from) ? req.query.from : mondayOf(ck.today);
    const to = isDate(req.query.to) ? req.query.to : addDays(from, 6);
    if (to < from) return res.status(400).json({ ok: false, error: "Data „do” wcześniejsza niż „od”" });
    if (addDays(from, 92) < to) return res.status(400).json({ ok: false, error: "Najwyżej 93 dni naraz" });
    const sites = await scopedSites(req.fscope, req.query);
    const keys = sites.map((s) => s.site_key);
    const [dep, arr, plan, weeks] = await Promise.all([
      query(
        `SELECT to_char(d.move_date, 'YYYY-MM-DD') AS date, d.site_key, w.full_name, w.login, d.status, d.is_transfer, d.to_site,
                to_char(d.bhp_date, 'YYYY-MM-DD') AS bhp,
                to_char(r.lwd_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS seen_at, COALESCE(r.baseline, false) AS baseline,
                CASE WHEN r.lwd_at IS NOT NULL AND NOT r.baseline
                     THEN d.move_date - (r.lwd_at AT TIME ZONE 'Europe/Warsaw')::date END AS notice_days,
                to_char(date_trunc('week', d.move_date), 'YYYY-MM-DD') AS week,
                EXISTS (SELECT 1 FROM flow.week_plan pl WHERE pl.week_start = date_trunc('week', d.move_date)::date
                         AND pl.worker_id = d.worker_id AND pl.site_key = d.site_key) AS planned
           FROM flow.departures($1::date, $2::date) d
           JOIN public.workers w ON w.id = d.worker_id
           LEFT JOIN flow.rows r ON r.hid = d.hid
          WHERE d.site_key = ANY($3::text[])
          ORDER BY d.move_date, d.site_key, w.full_name`, [from, to, keys]),
      query(
        `SELECT to_char(a.move_date, 'YYYY-MM-DD') AS date, a.site_key, w.full_name, w.login, a.status, a.kind, a.from_site,
                to_char(a.last_work_date, 'YYYY-MM-DD') AS lwd,
                to_char(r.first_seen_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS seen_at, COALESCE(r.baseline, false) AS baseline
           FROM flow.arrivals($1::date, $2::date) a
           JOIN public.workers w ON w.id = a.worker_id
           LEFT JOIN flow.rows r ON r.hid = a.hid
          WHERE a.site_key = ANY($3::text[])
          ORDER BY a.move_date, a.site_key, w.full_name`, [from, to, keys]),
      query(
        `WITH dep AS (SELECT worker_id, site_key, move_date FROM flow.departures(date_trunc('week', $1::date)::date, $2::date + 6))
         SELECT to_char(pl.week_start, 'YYYY-MM-DD') AS week, to_char(pl.move_date, 'YYYY-MM-DD') AS date, pl.site_key,
                w.full_name, w.login, pl.is_transfer,
                (SELECT to_char(min(dep.move_date), 'YYYY-MM-DD') FROM dep
                  WHERE dep.worker_id = pl.worker_id AND dep.site_key = pl.site_key
                    AND dep.move_date BETWEEN pl.week_start AND pl.week_start + 6) AS now_date
           FROM flow.week_plan pl JOIN public.workers w ON w.id = pl.worker_id
          WHERE pl.week_start BETWEEN date_trunc('week', $1::date)::date AND $2::date AND pl.site_key = ANY($3::text[])
          ORDER BY pl.week_start, pl.move_date, pl.site_key, w.full_name`, [from, to, keys]),
      query(`SELECT to_char(week_start, 'YYYY-MM-DD') AS week FROM flow.weeks
              WHERE week_start BETWEEN date_trunc('week', $1::date)::date AND $2::date`, [from, to]),
    ]);
    const meta = Object.fromEntries(sites.map((s) => [s.site_key, s]));
    const add = (x) => ({ ...x, coordinator_name: (meta[x.site_key] || {}).coordinator_name || null, region_name: (meta[x.site_key] || {}).region_name || null });
    const fixed = new Set(weeks.rows.map((x) => x.week));
    res.json({
      ok: true, from, to, today: ck.today,
      departures: dep.rows.map((x) => ({ ...add(x), week_fixed: fixed.has(x.week) })),
      arrivals: arr.rows.map(add), plan: plan.rows.map(add),
    });
  } catch (e) { fail(res, e); }
});

// День: хто виїхав / приїхав, що дописали після зведення
router.get("/day", async (req, res) => {
  try {
    const ck = await clock();
    const day = isDate(req.query.date) ? req.query.date : ck.today;
    const sites = await scopedSites(req.fscope, req.query);
    const keys = sites.map((s) => s.site_key);
    const meta = Object.fromEntries(sites.map((s) => [s.site_key, s]));
    const [deps, arrs, sum, late, corr] = await Promise.all([
      listPeople("dep_now", day, day, keys, ck.today, null),
      listPeople("arr_all", day, day, keys, ck.today, null),
      query(`SELECT to_char(made_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS made_at, sent, failed
               FROM flow.summaries WHERE day = $1::date`, [day]),
      query(`SELECT i.kind, i.worker_id, w.full_name, w.login, i.site_key, to_char(i.move_date, 'YYYY-MM-DD') AS date, i.status
               FROM flow.summary_items i JOIN public.workers w ON w.id = i.worker_id
              WHERE i.day = $1::date AND i.late AND i.site_key = ANY($2::text[])
              ORDER BY i.move_date, i.site_key, w.full_name`, [day, keys]),
      query(`SELECT i.kind, i.worker_id, w.full_name, w.login, i.site_key, to_char(i.move_date, 'YYYY-MM-DD') AS date,
                    to_char(i.corrected_to, 'YYYY-MM-DD') AS corrected_to, i.status
               FROM flow.summary_items i JOIN public.workers w ON w.id = i.worker_id
              WHERE i.corrected_day = $1::date AND i.site_key = ANY($2::text[])
              ORDER BY i.move_date, i.site_key, w.full_name`, [day, keys]),
    ]);
    // хто з'явився після зведення цього дня
    const shown = await query(
      `SELECT kind, worker_id, site_key FROM flow.summary_items WHERE move_date = $1::date AND day = $1::date`, [day]);
    const seen = new Set(shown.rows.map((x) => `${x.kind}|${x.worker_id}|${x.site_key}`));
    const madeAt = sum.rows[0] ? sum.rows[0].made_at : null;
    const mark = (kind) => (x) => ({
      ...x,
      coordinator_name: (meta[x.site_key] || {}).coordinator_name || null,
      after_summary: !!madeAt && !seen.has(`${kind}|${x.worker_id}|${x.site_key}`),
    });
    res.json({
      ok: true, day, today: ck.today, summary: sum.rows[0] || null,
      departures: deps.map(mark("out")), arrivals: arrs.map(mark("in")),
      late: late.rows, corrections: corr.rows,
    });
  } catch (e) { fail(res, e); }
});

// План набору: форма на 3 тижні
router.get("/orders", async (req, res) => {
  try {
    const ck = await clock();
    const weeks = orderWeeks(ck.today);
    const cur = mondayOf(ck.today);
    const sites = await scopedSites(req.fscope, req.query);
    const keys = sites.map((s) => s.site_key);
    const [ord, hc, dep, arr] = await Promise.all([
      query(`SELECT site_key, to_char(week_start, 'YYYY-MM-DD') AS week, qty, entered_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Warsaw' AS confirmed,
                    to_char(entered_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS entered_at
               FROM flow.v_orders WHERE site_key = ANY($1::text[]) AND week_start BETWEEN $2::date AND $2::date + 21`,
             [keys, cur, confirmFrom(ck.today)]),
      query(`SELECT site_key, count(DISTINCT worker_id)::int AS n FROM flow.v_rows
              WHERE site_key = ANY($1::text[]) AND status NOT IN ('rezygnacja', 'unknown')
                AND bhp_date <= $2::date AND (last_work_date IS NULL OR last_work_date >= $2::date)
              GROUP BY site_key`, [keys, ck.today]),
      query(`SELECT site_key, to_char(date_trunc('week', move_date), 'YYYY-MM-DD') AS week, count(*)::int AS n
               FROM flow.departures($2::date, $2::date + 27) WHERE site_key = ANY($1::text[]) GROUP BY 1, 2`, [keys, cur]),
      query(`SELECT site_key, to_char(date_trunc('week', move_date), 'YYYY-MM-DD') AS week, count(*)::int AS n
               FROM flow.arrivals($2::date, $2::date + 27)
              WHERE site_key = ANY($1::text[]) AND kind = 'new' AND status <> 'rezygnacja' GROUP BY 1, 2`, [keys, cur]),
    ]);
    const key = (s, w) => s + "|" + w;
    const O = Object.fromEntries(ord.rows.map((x) => [key(x.site_key, x.week), x]));
    const D = Object.fromEntries(dep.rows.map((x) => [key(x.site_key, x.week), x.n]));
    const A = Object.fromEntries(arr.rows.map((x) => [key(x.site_key, x.week), x.n]));
    const H = Object.fromEntries(hc.rows.map((x) => [x.site_key, x.n]));
    const rows = sites.map((s) => {
      const cells = [cur, ...weeks].map((w) => {
        const o = O[key(s.site_key, w)];
        return { week: w, qty: o ? o.qty : null, entered_at: o ? o.entered_at : null, confirmed: o ? !!o.confirmed : false,
          dep: D[key(s.site_key, w)] || 0, arr: A[key(s.site_key, w)] || 0 };
      });
      return {
        site_key: s.site_key, region_name: s.region_name, coordinator_name: s.coordinator_name, coordinator_id: s.coordinator_id,
        headcount: H[s.site_key] || 0, current: cells[0], weeks: cells.slice(1),
        confirmed: cells.slice(1).every((c) => c.confirmed),
      };
    });
    const st = await getSettings();
    res.json({ ok: true, today: ck.today, current_week: cur, weeks, deadline: st.orders_deadline,
      confirm_from: confirmFrom(ck.today), can_edit_current: req.fscope.role === "all", rows });
  } catch (e) { fail(res, e); }
});

router.post("/orders", async (req, res) => {
  let client = null;
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "Brak danych" });
    if (items.length > 2000) return res.status(400).json({ ok: false, error: "Za dużo wierszy" });
    const ck = await clock();
    const weeks = orderWeeks(ck.today);
    const allowedWeeks = new Set(req.fscope.role === "all" ? [mondayOf(ck.today), ...weeks] : weeks);
    const sites = new Set((await scopedSites(req.fscope, {})).map((s) => s.site_key));
    for (const it of items) {
      const qty = Number(it.qty);
      if (!sites.has(it.site_key)) return res.status(403).json({ ok: false, error: `Brak dostępu do obiektu ${it.site_key}` });
      if (!allowedWeeks.has(it.week_start)) return res.status(400).json({ ok: false, error: `Tego tygodnia nie można już zmienić: ${it.week_start}` });
      if (!Number.isInteger(qty) || qty < 0 || qty > 999) return res.status(400).json({ ok: false, error: `Liczba 0–999: ${it.site_key}` });
    }
    client = await db.pool.connect();
    await client.query("BEGIN");
    for (const it of items) {
      await client.query(`INSERT INTO flow.orders (site_key, week_start, qty, entered_by) VALUES ($1, $2::date, $3, $4)`,
        [it.site_key, it.week_start, Number(it.qty), req.coordinator.coordinator_id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true, saved: items.length });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    fail(res, e);
  } finally {
    if (client) client.release();
  }
});

// ── Налаштування (адмін) ──────────────────────────────────────────────
const SETTING_RULES = {
  enabled: (v) => ["0", "1"].includes(v),
  summary_time: (v) => hmToMin(v) != null && hmToMin(v) < 1440,
  summary_days: (v) => /^[1-7](,[1-7])*$/.test(v),
  pre_import_min: (v) => /^\d{1,3}$/.test(v) && Number(v) <= 180,
  late_days: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 60,
  skip_empty: (v) => ["0", "1"].includes(v),
  auto_coords: (v) => ["0", "1"].includes(v),
  orders_remind: (v) => v === "" || v.split(",").every((t) => hmToMin(t) != null && hmToMin(t) < 1440),
  orders_deadline: (v) => hmToMin(v) != null && hmToMin(v) < 1440,
  monday_time: (v) => hmToMin(v) != null && hmToMin(v) < 1440,
  coord_format: (v) => ["text", "image"].includes(v),
  pace: (v) => /^\d{1,3}(,\d{1,3}){4}$/.test(v) && v.split(",").every((x) => Number(x) <= 100),
};

router.get("/settings", adminOnly, async (req, res) => {
  try {
    const [st, rc, ch, co, rg, last] = await Promise.all([
      query(`SELECT key, value, note FROM flow.settings ORDER BY key`),
      query(`SELECT r.*, c.full_name AS coordinator_name, (c.telegram_chat_id IS NOT NULL) AS has_tg, rg.name AS region_name,
                    ch.title AS chat_title
               FROM flow.recipients r
               LEFT JOIN public.coordinators c ON c.id = r.coordinator_id
               LEFT JOIN reg.regions rg ON rg.id = r.region_id
               LEFT JOIN flow.chats ch ON ch.chat_id = r.chat_id
              ORDER BY r.id`),
      query(`SELECT chat_id::text AS chat_id, title, type, is_member,
                    to_char(updated_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS updated_at
               FROM flow.chats ORDER BY is_member DESC, title`),
      query(`SELECT id, full_name, (telegram_chat_id IS NOT NULL) AS has_tg FROM public.coordinators
              WHERE is_active AND full_name NOT ILIKE 'test%' ORDER BY full_name`),
      query(`SELECT id, name FROM reg.regions WHERE is_active ORDER BY name`),
      query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(made_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS made_at, sent, failed
               FROM flow.summaries ORDER BY day DESC LIMIT 7`),
    ]);
    const auto = await query(
      `SELECT count(DISTINCT c.id)::int AS n, count(DISTINCT c.id) FILTER (WHERE c.telegram_chat_id IS NULL)::int AS no_tg
         FROM reg.site_owner o JOIN public.coordinators c ON c.id = o.coordinator_id AND c.is_active
        WHERE o.valid_to IS NULL`);
    res.json({
      ok: true, settings: st.rows,
      recipients: rc.rows.map((r) => ({ ...r, chat_id: r.chat_id == null ? null : String(r.chat_id) })),
      chats: ch.rows, coordinators: co.rows, regions: rg.rows, summaries: last.rows, auto: auto.rows[0],
    });
  } catch (e) { fail(res, e); }
});

router.patch("/settings", adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const keys = Object.keys(b).filter((k) => SETTING_RULES[k]);
    if (!keys.length) return res.status(400).json({ ok: false, error: "Brak zmian" });
    for (const k of keys) {
      const v = String(b[k]).trim().replace(/\s+/g, "");
      if (!SETTING_RULES[k](v)) return res.status(400).json({ ok: false, error: `Nieprawidłowa wartość: ${k}` });
      b[k] = k.endsWith("_time") || k === "orders_deadline"
        ? minToHm(hmToMin(v))
        : k === "orders_remind" ? v.split(",").filter(Boolean).map((t) => minToHm(hmToMin(t))).join(",") : v;
    }
    for (const k of keys) {
      await db.query(`UPDATE flow.settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`,
        [k, b[k], req.coordinator.coordinator_id]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

function recipientBody(b) {
  const r = {
    coordinator_id: b.coordinator_id ? parseInt(b.coordinator_id, 10) : null,
    chat_id: b.chat_id != null && String(b.chat_id).trim() !== "" ? String(b.chat_id).trim() : null,
    label: b.label ? String(b.label).slice(0, 100) : null,
    scope: ["own", "region", "all"].includes(b.scope) ? b.scope : "all",
    region_id: b.region_id ? parseInt(b.region_id, 10) : null,
    daily: b.daily !== false, orders: !!b.orders, weekly: b.weekly !== false,
    lang: ["uk", "ru", "pl"].includes(b.lang) ? b.lang : "uk",
    format: b.format === "image" ? "image" : "text",
    is_active: b.is_active !== false,
  };
  if (r.chat_id && !/^-?\d{4,20}$/.test(r.chat_id)) throw Object.assign(new Error("Chat ID — tylko cyfry (dla grup z minusem)"), { code: 400 });
  if (!r.coordinator_id && !r.chat_id) throw Object.assign(new Error("Wybierz koordynatora albo podaj chat ID"), { code: 400 });
  if (r.scope === "own" && !r.coordinator_id) throw Object.assign(new Error("„Swoje obiekty” — tylko dla koordynatora"), { code: 400 });
  if (r.scope === "region" && !r.region_id && !r.coordinator_id) throw Object.assign(new Error("Wybierz region"), { code: 400 });
  return r;
}
router.post("/recipients", adminOnly, async (req, res) => {
  try {
    const r = recipientBody(req.body || {});
    const ins = await db.query(
      `INSERT INTO flow.recipients (coordinator_id, chat_id, label, scope, region_id, daily, orders, weekly, lang, is_active, created_by, format)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [r.coordinator_id, r.chat_id, r.label, r.scope, r.region_id, r.daily, r.orders, r.weekly, r.lang, r.is_active, req.coordinator.coordinator_id, r.format],
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { fail(res, e, e.code === 400 ? 400 : 500); }
});
router.patch("/recipients/:id", adminOnly, async (req, res) => {
  try {
    const r = recipientBody(req.body || {});
    await db.query(
      `UPDATE flow.recipients SET coordinator_id = $2, chat_id = $3::bigint, label = $4, scope = $5, region_id = $6,
              daily = $7, orders = $8, weekly = $9, lang = $10, is_active = $11, format = $12 WHERE id = $1`,
      [parseInt(req.params.id, 10), r.coordinator_id, r.chat_id, r.label, r.scope, r.region_id, r.daily, r.orders, r.weekly, r.lang, r.is_active, r.format],
    );
    res.json({ ok: true });
  } catch (e) { fail(res, e, e.code === 400 ? 400 : 500); }
});
router.delete("/recipients/:id", adminOnly, async (req, res) => {
  try {
    await db.query(`DELETE FROM flow.recipients WHERE id = $1`, [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Тест: зведення «як зараз» — собі або вибраному отримувачу. Нічого не записує.
// kind = recipient — рівно те, що отримує цей отримувач за галочками (Dzień / Plan naboru / Tydzień);
// галочки беруться з форми (ще не збережені теж), інакше — збережені.
router.post("/test", adminOnly, async (req, res) => {
  try {
    if (!BOT) return res.status(400).json({ ok: false, error: "Bot niedostępny" });
    const ck = await clock();
    const kind = ["daily", "remind", "monday", "recipient"].includes(req.body && req.body.kind) ? req.body.kind : "daily";
    let targets;
    if (req.body && req.body.recipient_id) {
      targets = (await resolveRecipients()).filter((t) => t.id === parseInt(req.body.recipient_id, 10));
    } else {
      const me = await db.query(`SELECT telegram_chat_id, to_jsonb(c)->>'lang' AS lang FROM public.coordinators c WHERE id = $1`,
        [req.coordinator.coordinator_id]);
      const chat = me.rows[0] && me.rows[0].telegram_chat_id;
      if (!chat) return res.status(400).json({ ok: false, error: "Brak Telegrama w Twojej karcie koordynatora" });
      targets = [{ chat, scope: "all", lang: langOf(me.rows[0].lang), label: "test", coordinator_id: req.coordinator.coordinator_id }];
    }
    if (!targets.length) return res.status(400).json({ ok: false, error: "Odbiorca bez Telegrama lub nieaktywny" });
    // форма відправки: з форми (ще не збережена теж), інакше — збережена; «собі» — текст, якщо не вибрано
    const fmt = ["text", "image"].includes(req.body && req.body.format) ? req.body.format : null;
    targets = targets.map((t) => ({ ...t, format: fmt || t.format || "text" }));
    SITES_CACHE = await allSites();
    let sent = 0;
    if (kind === "recipient") {
      const b = req.body || {};
      const flag = (k, t) => (typeof b[k] === "boolean" ? b[k] : !!t[k]);
      const parts = [];
      for (const t0 of targets) {
        const t = { ...t0, daily: flag("daily", t0), orders: flag("orders", t0), weekly: flag("weekly", t0) };
        if (!t.daily && !t.orders && !t.weekly) {
          return res.status(400).json({ ok: false, error: "Nic nie zaznaczono — zaznacz Dzień, Plan naboru albo Tydzień" });
        }
        if (t.daily) {
          const data = await dailyData(ck.today, false);
          const ts = await targetSites(t);
          if (await deliverDaily(t, data, ts, "🧪 TEST · Dzień\n")) { sent++; parts.push("daily"); }
        }
        if (t.orders || t.weekly) {
          const what = [t.orders && "Plan naboru", t.weekly && "Tydzień"].filter(Boolean).join(" + ");
          if (await deliverMonday(t, ck.today, `🧪 TEST · Poniedziałek: ${what}\n`)) { sent++; parts.push("monday"); }
        }
      }
      return res.json({ ok: true, sent, of: targets.length, parts });
    }
    if (kind === "daily") {
      const data = await dailyData(ck.today, false);
      for (const t of targets) {
        const ts = await targetSites(t);
        if (await deliverDaily(t, data, ts, "🧪 TEST\n")) sent++;
      }
    } else if (kind === "remind") {
      for (const t of targets) if (await sendLong(t.chat, "🧪 TEST\n" + (await buildRemind(t, ck.today, true)))) sent++;
    } else {
      for (const t of targets) if (await deliverMonday({ ...t, orders: true, weekly: true }, ck.today, "🧪 TEST\n")) sent++;
    }
    res.json({ ok: true, sent, of: targets.length });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Telegram: тексти
// ══════════════════════════════════════════════════════════════════════
const TX = {
  uk: {
    days: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
    title: (d) => `🚌 <b>Виїзди і приїзди · ${d}</b>`,
    sOwn: "Ваші обʼєкти", sAll: "Усі обʼєкти", sRegion: (n) => `Регіон: ${n}`,
    out: (n, w) => `🔻 <b>Закінчили ${w}: ${n}</b>`,
    today: "сьогодні", since: (d) => `з ${d}`,
    tr: (n) => `🔁 <b>Переведення: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Почали ${w}: ${n}</b>`,
    inTr: (n) => `↪️ Прийшли переведенням: ${n}`,
    unconf: (n) => `❔ Без статусу (не підтверджені): ${n}`,
    rez: (n) => `❌ Не доїхали: ${n}`,
    nothing: (w) => `Виїздів і приїздів ${w} немає.`,
    late: "✍️ <b>Дописано після попереднього зведення</b>",
    kOut: "виїзд", kIn: "приїзд", kRez: "не доїхав",
    corr: "↩️ <b>Зміни в уже показаному</b>",
    moved: (d) => `перенесено на ${d}`, cancelled: "скасовано", notCame: "не доїхав",
    week: (a, b) => `📅 <b>Тиждень ${a}–${b}</b>`,
    rec: (f, p, e, t) => `Набір: ${f}${p != null ? ` з ${p}${p ? ` (${Math.round((f / p) * 100)}%)` : ""}` : " (план не введено)"} · вписано ${e}${t ? ` · переведенням ${t}` : ""}`,
    dep: (f, p, u) => `Виїзди: ${f}${p != null ? ` · план ${p}` : ""}${u ? ` · поза планом ${u}` : ""}`,
    more: (n) => `… і ще ${n}`,
    remind: (weeks, dl) => `✍️ <b>План набору на 3 тижні</b>\nВведіть або підтвердіть до ${dl}, скільки людей треба набрати на тижні ${weeks}.\nУ суботу підтвердження знімаються — цифри лишаються, натисніть «Zapisz».`,
    remindSites: "Обʼєкти без плану:",
    where: "Панель → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>План і факт · ${d}</b>`,
    missing: (n) => `✍️ <b>Не ввели / не підтвердили план набору: ${n}</b>`,
    allIn: "✅ План набору ввели всі.",
    plans: "План набору:",
    plansBy: (w) => `📋 <b>План набору по обʼєктах</b> · тижні ${w}`,
    plansTotal: "Разом",
    plansLegend: "✅ підтверджено · ⚠️ не підтверджено після суботи · ❌ не введено",
    prev: (a, b) => `📅 <b>Минулий тиждень ${a}–${b}</b>`,
    net: (n) => `Чисельність: ${n > 0 ? "+" : ""}${n}`,
    worst: "Найбільше відставання:",
    wLine: (s, f, p, u) => `• ${s} — набір ${f}${p != null ? ` з ${p}` : ""}${u ? `, поза планом ${u}` : ""}`,
    noCoord: "без координатора",
  },
  ru: {
    days: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
    title: (d) => `🚌 <b>Выезды и приезды · ${d}</b>`,
    sOwn: "Ваши объекты", sAll: "Все объекты", sRegion: (n) => `Регион: ${n}`,
    out: (n, w) => `🔻 <b>Закончили ${w}: ${n}</b>`,
    today: "сегодня", since: (d) => `с ${d}`,
    tr: (n) => `🔁 <b>Переводы: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Начали ${w}: ${n}</b>`,
    inTr: (n) => `↪️ Пришли переводом: ${n}`,
    unconf: (n) => `❔ Без статуса (не подтверждены): ${n}`,
    rez: (n) => `❌ Не доехали: ${n}`,
    nothing: (w) => `Выездов и приездов ${w} нет.`,
    late: "✍️ <b>Дописано после прошлой сводки</b>",
    kOut: "выезд", kIn: "приезд", kRez: "не доехал",
    corr: "↩️ <b>Изменения в уже показанном</b>",
    moved: (d) => `перенесено на ${d}`, cancelled: "отменено", notCame: "не доехал",
    week: (a, b) => `📅 <b>Неделя ${a}–${b}</b>`,
    rec: (f, p, e, t) => `Набор: ${f}${p != null ? ` из ${p}${p ? ` (${Math.round((f / p) * 100)}%)` : ""}` : " (план не введён)"} · вписано ${e}${t ? ` · переводом ${t}` : ""}`,
    dep: (f, p, u) => `Выезды: ${f}${p != null ? ` · план ${p}` : ""}${u ? ` · вне плана ${u}` : ""}`,
    more: (n) => `… и ещё ${n}`,
    remind: (weeks, dl) => `✍️ <b>План набора на 3 недели</b>\nВведите или подтвердите до ${dl}, сколько людей нужно набрать на недели ${weeks}.\nВ субботу подтверждения снимаются — цифры остаются, нажмите «Zapisz».`,
    remindSites: "Объекты без плана:",
    where: "Панель → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>План и факт · ${d}</b>`,
    missing: (n) => `✍️ <b>Не ввели / не подтвердили план набора: ${n}</b>`,
    allIn: "✅ План набора ввели все.",
    plans: "План набора:",
    plansBy: (w) => `📋 <b>План набора по объектам</b> · недели ${w}`,
    plansTotal: "Итого",
    plansLegend: "✅ подтверждено · ⚠️ не подтверждено после субботы · ❌ не введено",
    prev: (a, b) => `📅 <b>Прошлая неделя ${a}–${b}</b>`,
    net: (n) => `Численность: ${n > 0 ? "+" : ""}${n}`,
    worst: "Сильнее всего отстают:",
    wLine: (s, f, p, u) => `• ${s} — набор ${f}${p != null ? ` из ${p}` : ""}${u ? `, вне плана ${u}` : ""}`,
    noCoord: "без координатора",
  },
  pl: {
    days: ["nd", "pn", "wt", "śr", "cz", "pt", "sb"],
    title: (d) => `🚌 <b>Wyjazdy i przyjazdy · ${d}</b>`,
    sOwn: "Twoje obiekty", sAll: "Wszystkie obiekty", sRegion: (n) => `Region: ${n}`,
    out: (n, w) => `🔻 <b>Zakończyli ${w}: ${n}</b>`,
    today: "dziś", since: (d) => `od ${d}`,
    tr: (n) => `🔁 <b>Przeniesienia: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Rozpoczęli ${w}: ${n}</b>`,
    inTr: (n) => `↪️ Przyszli z przeniesienia: ${n}`,
    unconf: (n) => `❔ Bez statusu (niepotwierdzeni): ${n}`,
    rez: (n) => `❌ Nie dojechali: ${n}`,
    nothing: (w) => `Brak wyjazdów i przyjazdów ${w}.`,
    late: "✍️ <b>Dopisane po poprzednim podsumowaniu</b>",
    kOut: "wyjazd", kIn: "przyjazd", kRez: "nie dojechał",
    corr: "↩️ <b>Zmiany w już pokazanych</b>",
    moved: (d) => `przesunięto na ${d}`, cancelled: "odwołano", notCame: "nie dojechał",
    week: (a, b) => `📅 <b>Tydzień ${a}–${b}</b>`,
    rec: (f, p, e, t) => `Nabór: ${f}${p != null ? ` z ${p}${p ? ` (${Math.round((f / p) * 100)}%)` : ""}` : " (brak planu)"} · wpisano ${e}${t ? ` · z przeniesienia ${t}` : ""}`,
    dep: (f, p, u) => `Wyjazdy: ${f}${p != null ? ` · plan ${p}` : ""}${u ? ` · poza planem ${u}` : ""}`,
    more: (n) => `… i jeszcze ${n}`,
    remind: (weeks, dl) => `✍️ <b>Plan naboru na 3 tygodnie</b>\nWpisz lub potwierdź do ${dl}, ilu ludzi trzeba zrekrutować na tygodnie ${weeks}.\nW sobotę potwierdzenia się zerują — liczby zostają, kliknij „Zapisz”.`,
    remindSites: "Obiekty bez planu:",
    where: "Panel → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>Plan i fakt · ${d}</b>`,
    missing: (n) => `✍️ <b>Bez potwierdzonego planu naboru: ${n}</b>`,
    allIn: "✅ Plan naboru wpisali wszyscy.",
    plans: "Plan naboru:",
    plansBy: (w) => `📋 <b>Plan naboru po obiektach</b> · tygodnie ${w}`,
    plansTotal: "Razem",
    plansLegend: "✅ potwierdzone · ⚠️ niepotwierdzone po sobocie · ❌ brak planu",
    prev: (a, b) => `📅 <b>Poprzedni tydzień ${a}–${b}</b>`,
    net: (n) => `Liczebność: ${n > 0 ? "+" : ""}${n}`,
    worst: "Największe zaległości:",
    wLine: (s, f, p, u) => `• ${s} — nabór ${f}${p != null ? ` z ${p}` : ""}${u ? `, poza planem ${u}` : ""}`,
    noCoord: "bez koordynatora",
  },
};
const langOf = (l) => (TX[l] ? l : "uk");

// Тексти зведення за день (повідомлення 1) і тижня наростаючим підсумком (повідомлення 2)
const B = (n) => `<b>${n}</b>`;
const TXD = {
  uk: {
    inclTr: (n) => `в т.ч. переведенням: ${B(n)}`,
    fromTr: (s) => ` ↪️ переведенням з ${s}`, toTr: (s) => ` → ${s}`,
    trOut: (n) => `🔁 <b>Переведені на інші обʼєкти: ${n}</b>`,
    trAll: (n) => `🔁 <b>Переведення: ${n}</b>`, fromN: (s, n) => `з ${s} ${B(n)}`,
    lateN: (n) => `✍️ <b>Дописано після попереднього зведення: ${n}</b>`,
    corrN: (n) => `↩️ <b>Зміни в уже показаному: ${n}</b>`,
    wTitle: (a, b) => `📅 <b>Тиждень ${a}${a === b ? "" : "–" + b}</b> (з понеділка по сьогодні)`,
    wNothing: "З понеділка виїздів і приїздів немає.",
    wOut: (n) => `🔻 Закінчили: ${B(n)}`, wIn: (n) => `🟢 Почали: ${B(n)}`,
    wTrOut: (n) => `🔁 Переведені на інші обʼєкти: ${B(n)}`,
    wRez: (n) => `❌ Не доїхали: ${B(n)}`, wUnc: (n) => `❔ Без статусу: ${B(n)}`,
    bySite: "По обʼєктах:",
    siteLine: (s, o, i, tr, rz, to) => `${s} — закінчили ${B(o)}${to ? ` · переведені ${B(to)}` : ""} · почали ${B(i)}${tr ? ` (переведенням ${B(tr)})` : ""}${rz ? ` · не доїхали ${B(rz)}` : ""}`,
    recTr: (n) => `в т.ч. переведенням: ${B(n)}`,
    rec2: (f, p) => `Набір до плану тижня (з переведеннями): ${B(f)}${p != null ? ` з ${B(p)}${p ? ` (${B(Math.round((f / p) * 100) + "%")})` : ""}` : " (план не введено)"}`,
    dep2: (f, p, u) => `Виїзди (з переведеннями): ${B(f)}${p != null ? ` · за планом тижня ${B(p)}` : ""}${u ? ` · поза планом ${B(u)}` : ""}`,
    lagT: (p) => `🔴 <b>Відстають від темпу набору</b> (на сьогодні треба ${p}% плану тижня):`,
    lagL: (s, f, p) => `• ${s} — ${B(f)} з ${B(p)} (${Math.round((f / p) * 100)}%)`,
  },
  ru: {
    inclTr: (n) => `в т.ч. переводом: ${B(n)}`,
    fromTr: (s) => ` ↪️ переводом из ${s}`, toTr: (s) => ` → ${s}`,
    trOut: (n) => `🔁 <b>Переведены на другие объекты: ${n}</b>`,
    trAll: (n) => `🔁 <b>Переводы: ${n}</b>`, fromN: (s, n) => `из ${s} ${B(n)}`,
    lateN: (n) => `✍️ <b>Дописано после прошлой сводки: ${n}</b>`,
    corrN: (n) => `↩️ <b>Изменения в уже показанном: ${n}</b>`,
    wTitle: (a, b) => `📅 <b>Неделя ${a}${a === b ? "" : "–" + b}</b> (с понедельника по сегодня)`,
    wNothing: "С понедельника выездов и приездов нет.",
    wOut: (n) => `🔻 Закончили: ${B(n)}`, wIn: (n) => `🟢 Начали: ${B(n)}`,
    wTrOut: (n) => `🔁 Переведены на другие объекты: ${B(n)}`,
    wRez: (n) => `❌ Не доехали: ${B(n)}`, wUnc: (n) => `❔ Без статуса: ${B(n)}`,
    bySite: "По объектам:",
    siteLine: (s, o, i, tr, rz, to) => `${s} — закончили ${B(o)}${to ? ` · переведены ${B(to)}` : ""} · начали ${B(i)}${tr ? ` (переводом ${B(tr)})` : ""}${rz ? ` · не доехали ${B(rz)}` : ""}`,
    recTr: (n) => `в т.ч. переводом: ${B(n)}`,
    rec2: (f, p) => `Набор к плану недели (с переводами): ${B(f)}${p != null ? ` из ${B(p)}${p ? ` (${B(Math.round((f / p) * 100) + "%")})` : ""}` : " (план не введён)"}`,
    dep2: (f, p, u) => `Выезды (с переводами): ${B(f)}${p != null ? ` · по плану недели ${B(p)}` : ""}${u ? ` · вне плана ${B(u)}` : ""}`,
    lagT: (p) => `🔴 <b>Отстают от темпа набора</b> (на сегодня нужно ${p}% плана недели):`,
    lagL: (s, f, p) => `• ${s} — ${B(f)} из ${B(p)} (${Math.round((f / p) * 100)}%)`,
  },
  pl: {
    inclTr: (n) => `w tym z przeniesienia: ${B(n)}`,
    fromTr: (s) => ` ↪️ przeniesiony z ${s}`, toTr: (s) => ` → ${s}`,
    trOut: (n) => `🔁 <b>Przeniesieni na inne obiekty: ${n}</b>`,
    trAll: (n) => `🔁 <b>Przeniesienia: ${n}</b>`, fromN: (s, n) => `z ${s} ${B(n)}`,
    lateN: (n) => `✍️ <b>Dopisane po poprzednim podsumowaniu: ${n}</b>`,
    corrN: (n) => `↩️ <b>Zmiany w już pokazanych: ${n}</b>`,
    wTitle: (a, b) => `📅 <b>Tydzień ${a}${a === b ? "" : "–" + b}</b> (od poniedziałku do dziś)`,
    wNothing: "Od poniedziałku brak wyjazdów i przyjazdów.",
    wOut: (n) => `🔻 Zakończyli: ${B(n)}`, wIn: (n) => `🟢 Rozpoczęli: ${B(n)}`,
    wTrOut: (n) => `🔁 Przeniesieni na inne obiekty: ${B(n)}`,
    wRez: (n) => `❌ Nie dojechali: ${B(n)}`, wUnc: (n) => `❔ Bez statusu: ${B(n)}`,
    bySite: "Po obiektach:",
    siteLine: (s, o, i, tr, rz, to) => `${s} — zakończyli ${B(o)}${to ? ` · przeniesieni ${B(to)}` : ""} · rozpoczęli ${B(i)}${tr ? ` (z przeniesienia ${B(tr)})` : ""}${rz ? ` · nie dojechali ${B(rz)}` : ""}`,
    recTr: (n) => `w tym z przeniesienia: ${B(n)}`,
    rec2: (f, p) => `Nabór do planu tygodnia (z przeniesieniami): ${B(f)}${p != null ? ` z ${B(p)}${p ? ` (${B(Math.round((f / p) * 100) + "%")})` : ""}` : " (brak planu)"}`,
    dep2: (f, p, u) => `Wyjazdy (z przeniesieniami): ${B(f)}${p != null ? ` · wg planu tygodnia ${B(p)}` : ""}${u ? ` · poza planem ${B(u)}` : ""}`,
    lagT: (p) => `🔴 <b>Poniżej tempa naboru</b> (na dziś potrzeba ${p}% planu tygodnia):`,
    lagL: (s, f, p) => `• ${s} — ${B(f)} z ${B(p)} (${Math.round((f / p) * 100)}%)`,
  },
};
const txOf = (l) => ({ ...TX[langOf(l)], ...TXD[langOf(l)] });

// Підписи картинок-таблиць (без HTML і емодзі: шрифт картинки їх не має)
const IMGTX = {
  uk: {
    site: "Обʼєкт", coord: "Координатор", out: "Закінчили", in: "Почали", inTr: ["в т.ч.", "переведенням"], rez: ["Не", "доїхали"],
    rec: "Набір / план", total: "Разом", gToday: "Сьогодні", gWtd: "Тиждень на сьогодні", gSince: "З понеділка", gPlan: "План тижня", gFull: "За тиждень",
    dayTitle: (d) => `Виїзди і приїзди · ${d}`, daySub: "за день", weekTitle: (a, b) => `Тиждень ${a}${a === b ? "" : " – " + b}`,
    wtdSub: "з понеділка по сьогодні", prevSub: "минулий тиждень", prevEmpty: "За тиждень виїздів і приїздів не було",
    lag: (p) => `набір відстає від темпу: на сьогодні треба ${p}% плану тижня`, lagFull: "набір нижче плану тижня",
    note: "«—» план не введено · «Закінчили» і «Почали» — разом із переведеннями",
    oTitle: "План набору · 3 тижні", oSub: (d) => `стан на ${d}`, oWeeks: "Тижні з понеділка", oStatus: "Стан",
    oOk: "підтверджено", oUnc: "не підтверджено", oMiss: "не введено",
    oLegRed: "план не введено", oLegAmber: "не підтверджено після суботи",
  },
  ru: {
    site: "Объект", coord: "Координатор", out: "Закончили", in: "Начали", inTr: ["в т.ч.", "переводом"], rez: ["Не", "доехали"],
    rec: "Набор / план", total: "Итого", gToday: "Сегодня", gWtd: "Неделя на сегодня", gSince: "С понедельника", gPlan: "План недели", gFull: "За неделю",
    dayTitle: (d) => `Выезды и приезды · ${d}`, daySub: "за день", weekTitle: (a, b) => `Неделя ${a}${a === b ? "" : " – " + b}`,
    wtdSub: "с понедельника по сегодня", prevSub: "прошлая неделя", prevEmpty: "За неделю выездов и приездов не было",
    lag: (p) => `набор отстаёт от темпа: на сегодня нужно ${p}% плана недели`, lagFull: "набор ниже плана недели",
    note: "«—» план не введён · «Закончили» и «Начали» — вместе с переводами",
    oTitle: "План набора · 3 недели", oSub: (d) => `на ${d}`, oWeeks: "Недели с понедельника", oStatus: "Статус",
    oOk: "подтверждён", oUnc: "не подтверждён", oMiss: "не введён",
    oLegRed: "план не введён", oLegAmber: "не подтверждён после субботы",
  },
  pl: {
    site: "Obiekt", coord: "Koordynator", out: "Zakończyli", in: "Rozpoczęli", inTr: ["w tym z", "przeniesienia"], rez: ["Nie", "dojechali"],
    rec: "Nabór / plan", total: "Razem", gToday: "Dziś", gWtd: "Tydzień do dziś", gSince: "Od poniedziałku", gPlan: "Plan tygodnia", gFull: "Za tydzień",
    dayTitle: (d) => `Wyjazdy i przyjazdy · ${d}`, daySub: "dzień", weekTitle: (a, b) => `Tydzień ${a}${a === b ? "" : " – " + b}`,
    wtdSub: "od poniedziałku do dziś", prevSub: "poprzedni tydzień", prevEmpty: "W tygodniu nie było wyjazdów ani przyjazdów",
    lag: (p) => `nabór poniżej tempa: na dziś potrzeba ${p}% planu tygodnia`, lagFull: "nabór poniżej planu tygodnia",
    note: "«—» brak planu · „Zakończyli” i „Rozpoczęli” — razem z przeniesieniami",
    oTitle: "Plan naboru · 3 tygodnie", oSub: (d) => `stan na ${d}`, oWeeks: "Tygodnie od poniedziałku", oStatus: "Stan",
    oOk: "potwierdzone", oUnc: "do potwierdzenia", oMiss: "do wpisania",
    oLegRed: "brak planu", oLegAmber: "niepotwierdzone po sobocie",
  },
};

// ── Отримувачі ────────────────────────────────────────────────────────
// Явні — з flow.recipients; автоматичні — координатори зі своїми об'єктами (auto_coords).
async function resolveRecipients() {
  const st = await getSettings();
  const out = [];
  const exp = await db.query(
    `SELECT r.*, c.telegram_chat_id AS c_chat, to_jsonb(c)->>'lang' AS c_lang, c.is_active AS c_active
       FROM flow.recipients r LEFT JOIN public.coordinators c ON c.id = r.coordinator_id
      WHERE r.is_active
        AND NOT EXISTS (SELECT 1 FROM flow.chats ch WHERE ch.chat_id = r.chat_id AND NOT ch.is_member)`);
  const explicitCoords = new Set();
  for (const r of exp.rows) {
    if (r.coordinator_id) explicitCoords.add(r.coordinator_id);
    if (r.coordinator_id && r.c_active === false) continue;
    const chat = r.chat_id || r.c_chat;
    if (!chat) continue;
    out.push({ id: r.id, chat: String(chat), scope: r.scope, region_id: r.region_id, coordinator_id: r.coordinator_id,
      daily: r.daily, orders: r.orders, weekly: r.weekly, lang: langOf(r.lang), auto: false,
      format: r.format === "image" ? "image" : "text" });
  }
  if (st.auto_coords === "1") {
    const ac = await db.query(
      `SELECT DISTINCT c.id, c.telegram_chat_id, to_jsonb(c)->>'lang' AS lang
         FROM reg.site_owner o JOIN public.coordinators c ON c.id = o.coordinator_id
        WHERE o.valid_to IS NULL AND c.is_active AND c.telegram_chat_id IS NOT NULL`);
    for (const c of ac.rows) {
      if (explicitCoords.has(c.id)) continue;
      out.push({ id: null, chat: String(c.telegram_chat_id), scope: "own", coordinator_id: c.id,
        daily: true, orders: false, weekly: false, lang: langOf(c.lang), auto: true,
        format: st.coord_format === "image" ? "image" : "text" });
    }
  }
  return out;
}
let SITES_CACHE = null;
async function targetSites(t) {
  const sites = SITES_CACHE || (await allSites());
  if (t.scope === "all") return { keys: sites.map((s) => s.site_key), label: "all", sites };
  if (t.scope === "own") {
    const s = sites.filter((x) => x.coordinator_id === t.coordinator_id);
    return { keys: s.map((x) => x.site_key), label: "own", sites: s };
  }
  let regionIds = t.region_id ? [Number(t.region_id)] : [];
  if (!regionIds.length && t.coordinator_id) {
    const r = await db.query(`SELECT region_id FROM reg.region_leads WHERE coordinator_id = $1`, [t.coordinator_id]);
    regionIds = r.rows.map((x) => Number(x.region_id));
  }
  const s = sites.filter((x) => regionIds.includes(x.region_id));
  const names = [...new Set(s.map((x) => x.region_name).filter(Boolean))].join(", ");
  return { keys: s.map((x) => x.site_key), label: "region", regionName: names, sites: s };
}

async function sendLong(chatId, text) {
  if (!BOT || !chatId) return false;
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));   // друга спроба — збій мережі
        await BOT.telegram.sendMessage(chatId, p, { parse_mode: "HTML", disable_web_page_preview: true });
        ok = true;
      } catch (e) {
        console.error("[flow] telegram", chatId, e.message);
      }
    }
    if (!ok) return false;
  }
  return true;
}

// ── Щоденне зведення: дані (одні на всіх) ─────────────────────────────
// record = false — лише подивитися (тест), нічого не позначати як показане
async function dailyData(day, record) {
  const st = await getSettings();
  const lateDays = Number(st.late_days) || 14;
  SITES_CACHE = await allSites();
  const prev = await db.query(
    `SELECT to_char(min(day), 'YYYY-MM-DD') AS first, to_char(max(day) FILTER (WHERE day < $1::date), 'YYYY-MM-DD') AS prev
       FROM flow.summaries`, [day]);
  const { first, prev: prevDay } = prev.rows[0];
  // Основний блок — лише цей день. Дні без зведення (сервер вимкнений, зведення вимкнене)
  // у повідомленні 1 не показуються — їх кількості є в тижневому повідомленні 2.
  // «Дописано» — записи з датою дня, за який зведення вже пішло, але яких у ньому не було.
  const clamp = (d) => (d < addDays(day, -lateDays) ? addDays(day, -lateDays) : d);
  const mainFrom = day;
  const lateFrom = first ? clamp(first) : day;
  const lateTo = prevDay || addDays(day, -1);   // включно
  const onSummaryDay = `EXISTS (SELECT 1 FROM flow.summaries s WHERE s.day = x.move_date)`;
  const names = `JOIN public.workers w ON w.id = x.worker_id`;
  const notShown = (kind) => `NOT EXISTS (SELECT 1 FROM flow.summary_items i WHERE i.kind = '${kind}' AND i.worker_id = x.worker_id
                                  AND i.site_key = x.site_key AND i.move_date = x.move_date)`;
  const [deps, arrs, lateDeps, lateArrs, corrOut, corrIn] = await Promise.all([
    // тест (record = false) показує основний блок повністю, навіть якщо зведення вже пішло
    db.query(`SELECT x.*, to_char(x.move_date, 'YYYY-MM-DD') AS date, w.full_name FROM flow.departures($1::date, $2::date) x ${names}
               WHERE ${record ? notShown("out") : "true"}`, [mainFrom, day]),
    db.query(`SELECT x.*, to_char(x.move_date, 'YYYY-MM-DD') AS date, w.full_name FROM flow.arrivals($1::date, $2::date) x ${names}
               WHERE ${record ? notShown("in") : "true"}`, [mainFrom, day]),
    db.query(`SELECT x.*, to_char(x.move_date, 'YYYY-MM-DD') AS date, w.full_name FROM flow.departures($1::date, $2::date) x ${names}
               WHERE ${notShown("out")} AND ${onSummaryDay}`, [lateFrom, lateTo]),
    db.query(`SELECT x.*, to_char(x.move_date, 'YYYY-MM-DD') AS date, w.full_name FROM flow.arrivals($1::date, $2::date) x ${names}
               WHERE ${notShown("in")} AND ${onSummaryDay}`, [lateFrom, lateTo]),
    // показаний виїзд більше не стоїть на ту дату: перенесено (нова дата) або скасовано
    db.query(`SELECT i.*, to_char(i.move_date, 'YYYY-MM-DD') AS date, w.full_name,
                     (SELECT to_char(min(d.move_date), 'YYYY-MM-DD') FROM flow.departures(i.move_date - 31, i.move_date + 62) d
                       WHERE d.worker_id = i.worker_id AND d.site_key = i.site_key AND d.move_date <> i.move_date) AS new_date
                FROM flow.summary_items i JOIN public.workers w ON w.id = i.worker_id
               WHERE i.kind = 'out' AND i.corrected_day IS NULL AND i.move_date >= $1::date - $2::int AND i.move_date <= $1::date
                 AND NOT EXISTS (SELECT 1 FROM flow.departures(i.move_date, i.move_date) d
                                  WHERE d.worker_id = i.worker_id AND d.site_key = i.site_key)`, [day, lateDays]),
    // показаний приїзд: тепер rezygnacja, інша дата або зник
    db.query(`SELECT i.*, to_char(i.move_date, 'YYYY-MM-DD') AS date, w.full_name, cur.status AS cur_status,
                     (SELECT to_char(min(a.move_date), 'YYYY-MM-DD') FROM flow.arrivals(i.move_date - 31, i.move_date + 62) a
                       WHERE a.worker_id = i.worker_id AND a.site_key = i.site_key AND a.move_date <> i.move_date
                         AND a.status <> 'rezygnacja') AS new_date
                FROM flow.summary_items i JOIN public.workers w ON w.id = i.worker_id
                LEFT JOIN LATERAL (SELECT a.status FROM flow.arrivals(i.move_date, i.move_date) a
                                    WHERE a.worker_id = i.worker_id AND a.site_key = i.site_key LIMIT 1) cur ON true
               WHERE i.kind = 'in' AND i.corrected_day IS NULL AND COALESCE(i.status, '') <> 'rezygnacja'
                 AND i.move_date >= $1::date - $2::int AND i.move_date <= $1::date
                 AND (cur.status IS NULL OR cur.status = 'rezygnacja')`, [day, lateDays]),
  ]);
  const week = mondayOf(day);
  const wk = await weekData(week, SITES_CACHE.map((s) => s.site_key), day);
  // переведення з понеділка: куди і звідки (для зведення по всій фірмі)
  const weekTr = await db.query(
    `SELECT site_key, from_site, count(*)::int AS n FROM flow.arrivals($1::date, $2::date)
      WHERE kind = 'transfer' AND status NOT IN ('rezygnacja', 'unknown') GROUP BY 1, 2`, [week, day]);
  const data = {
    day, week, weekEnd: addDays(week, 6), mainFrom, weekTr: weekTr.rows, pace: paceOf(st, day),
    deps: deps.rows, arrs: arrs.rows, lateDeps: lateDeps.rows, lateArrs: lateArrs.rows,
    corrOut: corrOut.rows, corrIn: corrIn.rows, weekRows: wk.rows, weekFixed: !!wk.fixed,
  };
  if (record) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const ins = `INSERT INTO flow.summary_items (kind, worker_id, site_key, move_date, day, hid, status, late)
                   VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8) ON CONFLICT DO NOTHING`;
      for (const x of data.deps) await client.query(ins, ["out", x.worker_id, x.site_key, x.date, day, x.hid, x.status, false]);
      for (const x of data.arrs) await client.query(ins, ["in", x.worker_id, x.site_key, x.date, day, x.hid, x.status, false]);
      for (const x of data.lateDeps) await client.query(ins, ["out", x.worker_id, x.site_key, x.date, day, x.hid, x.status, true]);
      for (const x of data.lateArrs) await client.query(ins, ["in", x.worker_id, x.site_key, x.date, day, x.hid, x.status, true]);
      for (const x of [...data.corrOut, ...data.corrIn]) {
        await client.query(
          `UPDATE flow.summary_items SET corrected_day = $5::date, corrected_to = $6::date
            WHERE kind = $1 AND worker_id = $2 AND site_key = $3 AND move_date = $4::date`,
          [x.kind, x.worker_id, x.site_key, x.date, day, x.new_date || null]);
      }
      await client.query(
        `INSERT INTO flow.summaries (day, made_at) VALUES ($1::date, now()) ON CONFLICT (day) DO UPDATE SET made_at = EXCLUDED.made_at`, [day]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return data;
}

// ── Щоденне зведення: текст для одного отримувача ─────────────────────
const NAMES_MAX = 40;
const NB = "\u00A0\u00A0\u00A0";       // відступ перед прізвищем
function bySite(list, keyset) { return list.filter((x) => keyset.has(x.site_key)); }
const coordOf = (k) => { const c = (SITES_CACHE || []).find((s) => s.site_key === k); return c && c.coordinator_name ? ` (${esc(c.coordinator_name)})` : ""; };
// Рядок «Обʼєкт — N»; detail own / region — під ним прізвища, кожне з нового рядка; all — тільки кількість
function siteBlocks(list, t, detail, extra) {
  const g = {};
  list.forEach((x) => { (g[x.site_key] = g[x.site_key] || []).push(x); });
  const keys = Object.keys(g).sort((a, b) => g[b].length - g[a].length || a.localeCompare(b));
  const out = [];
  for (const k of keys.slice(0, 40)) {
    out.push(`${esc(k)} — ${B(g[k].length)}${detail === "own" ? "" : coordOf(k)}`);
    if (detail === "all") continue;
    g[k].slice(0, NAMES_MAX).forEach((x) => out.push(NB + esc(x.full_name) + (extra ? extra(x) : "")));
    if (g[k].length > NAMES_MAX) out.push(NB + t.more(g[k].length - NAMES_MAX));
  }
  if (keys.length > 40) out.push(t.more(keys.length - 40));
  return out;
}
// Переведення по обʼєкту призначення: «IDL Psary ← 3: з ANPACARS 2, з Mieszko 1»
function trDestLines(list, t) {
  const g = {};
  list.forEach((x) => {
    const d = (g[x.site_key] = g[x.site_key] || { n: 0, from: {} });
    const n = Number(x.n) || 1;
    const f = x.from_site || "?";
    d.n += n; d.from[f] = (d.from[f] || 0) + n;
  });
  return Object.keys(g).sort((a, b) => g[b].n - g[a].n || a.localeCompare(b)).map((k) =>
    `${esc(k)} ← ${B(g[k].n)}: ${Object.entries(g[k].from).sort((a, b) => b[1] - a[1]).map(([f, n]) => t.fromN(esc(f), n)).join(", ")}`);
}
const scopeLine = (t, ts) => `<i>${ts.label === "own" ? t.sOwn : ts.label === "region" ? esc(t.sRegion(ts.regionName || "—")) : t.sAll}</i>`;
const detailOf = (ts) => (ts.label === "own" ? "own" : ts.label === "region" ? "region" : "all");

// Повідомлення 1 — зведення за день: координатору й регіональному з прізвищами, по фірмі — кількість.
// opts.image — підпис до картинки: по фірмі кількості по обʼєктах уже в таблиці, тут їх не повторюємо.
function buildDaily(data, ts, target, opts = {}) {
  const t = txOf(target.lang);
  const keys = new Set(ts.keys);
  const detail = detailOf(ts);
  const named = detail !== "all";
  const inTable = !!opts.image && !named;
  const dow = new Date(data.day + "T00:00:00Z").getUTCDay();
  const L = [t.title(`${t.days[dow]} ${dd(data.day)}`), scopeLine(t, ts)];

  const deps = bySite(data.deps, keys);
  const out = deps.filter((x) => !x.is_transfer), tr = deps.filter((x) => x.is_transfer);
  const arrs = bySite(data.arrs, keys);
  const aNew = arrs.filter((x) => x.kind === "new" && !["rezygnacja", "unknown"].includes(x.status));
  const aUnc = arrs.filter((x) => x.kind === "new" && x.status === "unknown");
  const aTr = arrs.filter((x) => x.kind === "transfer" && x.status !== "rezygnacja");
  const aRez = arrs.filter((x) => x.status === "rezygnacja");
  const multi = data.mainFrom < data.day;
  const dt = (x) => (multi ? ` (${dd(x.date)})` : "");
  const when = multi ? t.since(dd(data.mainFrom)) : t.today;

  if (!deps.length && !arrs.length) L.push("", t.nothing(when));
  if (out.length && !inTable) L.push("", t.out(out.length, when), ...siteBlocks(out, t, detail, dt));
  const inAll = aNew.concat(aTr);
  if (inAll.length && !inTable) {
    L.push("", t.inNew(inAll.length, when));
    if (aTr.length) L.push(t.inclTr(aTr.length));
    L.push(...siteBlocks(inAll, t, detail, (x) => (x.kind === "transfer" ? t.fromTr(esc(x.from_site || "?")) : "") + dt(x)));
  }
  if (named && tr.length) L.push("", t.trOut(tr.length), ...siteBlocks(tr, t, detail, (x) => t.toTr(esc(x.to_site || "?")) + dt(x)));
  if (!named && aTr.length) L.push("", t.trAll(aTr.length), ...trDestLines(aTr, t));
  if (aUnc.length) L.push("", `<b>${t.unconf(aUnc.length)}</b>`, ...siteBlocks(aUnc, t, detail, dt));
  if (aRez.length && !inTable) L.push("", `<b>${t.rez(aRez.length)}</b>`, ...siteBlocks(aRez, t, detail, dt));

  const late = [
    ...bySite(data.lateDeps, keys).map((x) => ({ ...x, k: x.is_transfer ? t.kOut + " 🔁" : t.kOut })),
    ...bySite(data.lateArrs, keys).map((x) => ({ ...x, k: x.status === "rezygnacja" ? t.kRez : t.kIn })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.site_key.localeCompare(b.site_key));
  if (late.length) {
    L.push("", t.lateN(late.length));
    if (named) late.slice(0, 30).forEach((x) => L.push(`• ${dd(x.date)} ${esc(x.site_key)} — ${x.k}: ${esc(x.full_name)}`));
    else {
      const g = {};
      late.forEach((x) => { const k = `${x.date}|${x.site_key}|${x.k}`; g[k] = (g[k] || 0) + 1; });
      Object.entries(g).slice(0, 30).forEach(([k, n]) => { const [d, s2, kk] = k.split("|"); L.push(`• ${dd(d)} ${esc(s2)} — ${kk}: ${B(n)}`); });
    }
    if (late.length > 30) L.push(t.more(late.length - 30));
  }
  const corr = [
    ...bySite(data.corrOut, keys).map((x) => ({ ...x, what: x.new_date ? t.moved(dd(x.new_date)) : t.cancelled, k: t.kOut })),
    ...bySite(data.corrIn, keys).map((x) => ({ ...x, what: x.cur_status === "rezygnacja" ? t.notCame : x.new_date ? t.moved(dd(x.new_date)) : t.cancelled, k: t.kIn })),
  ];
  if (corr.length) {
    L.push("", t.corrN(corr.length));
    if (named) corr.slice(0, 30).forEach((x) => L.push(`• ${dd(x.date)} ${esc(x.site_key)} — ${x.k} ${esc(x.full_name)}: ${x.what}`));
    else {
      const g = {};
      corr.forEach((x) => { const k = `${x.date}|${x.site_key}|${x.k}|${x.what}`; g[k] = (g[k] || 0) + 1; });
      Object.entries(g).slice(0, 30).forEach(([k, n]) => { const [d, s2, kk, w] = k.split("|"); L.push(`• ${dd(d)} ${esc(s2)} — ${kk}: ${w} — ${B(n)}`); });
    }
  }
  return L.join("\n");
}

// Повідомлення 2 — тиждень наростаючим підсумком (з понеділка по сьогодні), тільки цифри
function buildWeekToDate(data, ts, target) {
  const t = txOf(target.lang);
  const keys = new Set(ts.keys);
  const detail = detailOf(ts);
  const wr = data.weekRows.filter((x) => keys.has(x.site_key));
  const s = totals(wr);
  const n = (v) => Number(v) || 0;
  const L = [t.wTitle(dd(data.week), dd(data.day)), scopeLine(t, ts)];
  const outN = n(s.dep_fact) - n(s.dep_fact_tr), inN = n(s.arr_fact) + n(s.tr_fact);
  if (!n(s.dep_fact) && !inN && !n(s.arr_rez) && !n(s.arr_unconf)) L.push("", t.wNothing);
  else {
    L.push("", t.wOut(outN), t.wIn(inN));
    if (n(s.tr_fact)) L.push(t.inclTr(n(s.tr_fact)));
    if (n(s.dep_fact_tr)) L.push(t.wTrOut(n(s.dep_fact_tr)));
    if (n(s.arr_rez)) L.push(t.wRez(n(s.arr_rez)));
    if (n(s.arr_unconf)) L.push(t.wUnc(n(s.arr_unconf)));
    const act = (x) => n(x.dep_fact) + n(x.arr_fact) + n(x.tr_fact) + n(x.arr_rez);
    const rows = wr.filter((x) => act(x) > 0).sort((a, b) => act(b) - act(a) || a.site_key.localeCompare(b.site_key));
    if (rows.length) {
      L.push("", t.bySite);
      rows.slice(0, 70).forEach((x) => L.push(t.siteLine(esc(x.site_key) + (detail === "own" ? "" : coordOf(x.site_key)),
        n(x.dep_fact) - n(x.dep_fact_tr), n(x.arr_fact) + n(x.tr_fact), n(x.tr_fact), n(x.arr_rez), n(x.dep_fact_tr))));
      if (rows.length > 70) L.push(t.more(rows.length - 70));
    }
    if (detail === "all") {
      const wt = (data.weekTr || []).filter((x) => keys.has(x.site_key));
      if (wt.length) L.push("", t.trAll(wt.reduce((a, x) => a + x.n, 0)), ...trDestLines(wt, t));
    }
  }
  // набір до плану — разом із переведеннями (місце на обʼєкті закрите), окремо скільки з них переведенням
  L.push("", t.rec2(n(s.arr_fact) + n(s.tr_fact), s.sites_with_order ? n(s.order_qty) : null));
  if (n(s.tr_fact)) L.push(t.recTr(n(s.tr_fact)));
  L.push(t.dep2(n(s.dep_fact), data.weekFixed ? n(s.dep_plan) : null, data.weekFixed ? n(s.dep_unplanned) : 0));
  // хто відстає від темпу набору (як червоні рядки на картинці)
  const lag = wr.filter((x) => isLagging(n(x.arr_fact) + n(x.tr_fact), x.order_qty, data.pace))
    .map((x) => ({ k: x.site_key, f: n(x.arr_fact) + n(x.tr_fact), p: n(x.order_qty) }))
    .sort((a, b) => a.f / a.p - b.f / b.p || b.p - a.p || a.k.localeCompare(b.k));
  if (lag.length) {
    L.push("", t.lagT(data.pace));
    lag.slice(0, 25).forEach((x) => L.push(t.lagL(esc(x.k) + (detail === "own" ? "" : coordOf(x.k)), x.f, x.p)));
    if (lag.length > 25) L.push(t.more(lag.length - 25));
  }
  return L.join("\n");
}
// Підпис до картинки тижня: підсумки, яких немає в таблиці (план виїздів, без статусу, звідки переведення)
function buildWeekCaption(data, ts, target) {
  const t = txOf(target.lang);
  const keys = new Set(ts.keys);
  const s = totals(data.weekRows.filter((x) => keys.has(x.site_key)));
  const n = (v) => Number(v) || 0;
  const L = [t.wTitle(dd(data.week), dd(data.day)), scopeLine(t, ts), ""];
  L.push(t.rec2(n(s.arr_fact) + n(s.tr_fact), s.sites_with_order ? n(s.order_qty) : null));
  if (n(s.tr_fact)) L.push(t.recTr(n(s.tr_fact)));
  L.push(t.dep2(n(s.dep_fact), data.weekFixed ? n(s.dep_plan) : null, data.weekFixed ? n(s.dep_unplanned) : 0));
  if (n(s.arr_unconf)) L.push(t.wUnc(n(s.arr_unconf)));
  if (detailOf(ts) === "all") {
    const wt = (data.weekTr || []).filter((x) => keys.has(x.site_key));
    if (wt.length) L.push("", t.trAll(wt.reduce((a, x) => a + x.n, 0)), ...trDestLines(wt, t));
  }
  return L.join("\n");
}
// Чи є що показати координатору (для skip_empty)
function dailyHasNews(data, ts) {
  const keys = new Set(ts.keys);
  return [data.deps, data.arrs, data.lateDeps, data.lateArrs, data.corrOut, data.corrIn].some((l) => l.some((x) => keys.has(x.site_key)));
}

// ══════════════════════════════════════════════════════════════════════
//  Картинки-таблиці (форма відправки «image»)
// ══════════════════════════════════════════════════════════════════════
const coordName = (k) => { const s = (SITES_CACHE || []).find((x) => x.site_key === k); return (s && s.coordinator_name) || ""; };
function scopeText(t, ts) {
  if (ts.label === "own") { const s = (ts.sites || [])[0]; return t.sOwn + (s && s.coordinator_name ? ` · ${s.coordinator_name}` : ""); }
  if (ts.label === "region") return t.sRegion(ts.regionName || "—");
  return t.sAll;
}
const stamp = (day) => `KoorPanel · ${dd(day)} ${new Date().toLocaleTimeString("pl-PL", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" })}`;

// Колонки «Обʼєкт | Координатор | Закінчили | Почали | в т.ч. переведенням | Не доїхали | Набір / план | %»
function moveCols(it, own, groupLabels) {
  const cols = [{ label: it.site, kind: "site", align: "left" }];
  if (!own) cols.push({ label: it.coord, kind: "muted", align: "left" });
  cols.push({ label: it.out, kind: "num", sep: true }, { label: it.in, kind: "num" }, { label: it.inTr, kind: "num" },
    { label: it.rez, kind: "num" }, { label: it.rec, kind: "text", sep: true }, { label: "%", kind: "pct" });
  return { cols, lead: own ? 1 : 2, groups: [{ label: groupLabels[0], span: 4 }, { label: groupLabels[1], span: 2 }] };
}
// Набір / план, %, чи відстає від темпу
function recCells(f, p, pace) {
  if (p == null) return [{ v: `${f} / —`, tone: "muted" }, null, false];
  return [`${f} / ${p}`, Number(p) > 0 ? `${Math.round((f / p) * 100)}%` : null, isLagging(f, p, pace)];
}
// Рядки: спершу найбільше відставання (найменший %), обʼєкти без плану — внизу
function moveRows(items, own, pace) {
  const pc = (x) => (x.p != null && Number(x.p) > 0 ? x.f / x.p : 9);
  items.sort((a, b) => (a.p == null) - (b.p == null) || pc(a) - pc(b) || (b.p || 0) - (a.p || 0) || a.site.localeCompare(b.site));
  return items.map((x) => {
    const [rec, pct, lag] = recCells(x.f, x.p, pace);
    const cells = [x.site];
    if (!own) cells.push(x.coord || "—");
    cells.push(x.out, x.in, x.inTr, x.rez, rec, pct);
    return { cells, tone: lag ? "red" : null };
  });
}
function moveTotal(it, own, x, pace) {
  const [rec, pct, lag] = recCells(x.f, x.p, pace);
  const cells = [it.total];
  if (!own) cells.push("");
  cells.push(x.out, x.in, x.inTr, x.rez, rec, lag && pct ? { v: pct, tone: "red" } : pct);
  return { cells };
}
const nz = (v) => Number(v) || 0;
// Підсумок тижня по обʼєктах у межах отримувача — як у текстовому зведенні (rec2)
function weekTotalItem(rows) {
  const s = totals(rows);
  return { out: nz(s.dep_fact), in: nz(s.arr_fact) + nz(s.tr_fact), inTr: nz(s.tr_fact), rez: nz(s.arr_rez),
    f: nz(s.arr_fact) + nz(s.tr_fact), p: s.sites_with_order ? nz(s.order_qty) : null };
}

// Картинка 1 — за день: обʼєкти, де сьогодні був рух; праворуч — тиждень на сьогодні
function dayTableSpec(data, ts, target) {
  const t = txOf(target.lang), it = IMGTX[langOf(target.lang)];
  const keys = new Set(ts.keys), own = ts.label === "own";
  const wk = Object.fromEntries(data.weekRows.map((x) => [x.site_key, x]));
  const g = {};
  const get = (k) => (g[k] = g[k] || { site: k, coord: coordName(k), out: 0, in: 0, inTr: 0, rez: 0 });
  bySite(data.deps, keys).forEach((x) => { get(x.site_key).out++; });
  bySite(data.arrs, keys).forEach((x) => {
    if (x.status === "rezygnacja") get(x.site_key).rez++;
    else if (x.kind === "transfer") { get(x.site_key).in++; get(x.site_key).inTr++; }
    else if (x.status !== "unknown") get(x.site_key).in++;
  });
  const items = Object.values(g).map((x) => {
    const w = wk[x.site] || {};
    return { ...x, f: nz(w.arr_fact) + nz(w.tr_fact), p: w.order_qty == null ? null : Number(w.order_qty) };
  });
  if (!items.length) return null;
  const sum = (k) => items.reduce((a, x) => a + x[k], 0);
  const wt = weekTotalItem(data.weekRows.filter((x) => keys.has(x.site_key)));
  const dow = new Date(data.day + "T00:00:00Z").getUTCDay();
  return {
    title: it.dayTitle(`${t.days[dow]} ${dd(data.day)}`), sub: `${scopeText(t, ts)} · ${it.daySub}`,
    ...moveCols(it, own, [it.gToday, it.gWtd]),
    rows: moveRows(items, own, data.pace),
    total: moveTotal(it, own, { out: sum("out"), in: sum("in"), inTr: sum("inTr"), rez: sum("rez"), f: wt.f, p: wt.p }, data.pace),
    legend: [{ tone: "red", text: it.lag(data.pace) }], note: it.note, footRight: stamp(data.day),
  };
}
// Картинка тижня: з понеділка по сьогодні (або весь минулий тиждень — у понеділковому звіті)
function weekTableSpec(weekRows, ts, target, o) {
  const it = IMGTX[langOf(target.lang)];
  const keys = new Set(ts.keys), own = ts.label === "own";
  const wr = weekRows.filter((x) => keys.has(x.site_key));
  const items = wr
    .filter((x) => x.order_qty != null || nz(x.dep_fact) + nz(x.arr_fact) + nz(x.tr_fact) + nz(x.arr_rez) + nz(x.arr_unconf) > 0)
    .map((x) => ({
      site: x.site_key, coord: coordName(x.site_key), out: nz(x.dep_fact), in: nz(x.arr_fact) + nz(x.tr_fact), inTr: nz(x.tr_fact),
      rez: nz(x.arr_rez), f: nz(x.arr_fact) + nz(x.tr_fact), p: x.order_qty == null ? null : Number(x.order_qty),
    }));
  return {
    title: o.title, sub: o.sub, ...moveCols(it, own, o.groups),
    rows: moveRows(items, own, o.pace), total: moveTotal(it, own, weekTotalItem(wr), o.pace),
    empty: o.empty, legend: [{ tone: "red", text: o.legend }], note: it.note, footRight: stamp(o.day),
  };
}
function wtdTableSpec(data, ts, target) {
  const t = txOf(target.lang), it = IMGTX[langOf(target.lang)];
  return weekTableSpec(data.weekRows, ts, target, {
    title: it.weekTitle(dd(data.week), dd(data.day)), sub: `${scopeText(t, ts)} · ${it.wtdSub}`,
    groups: [it.gSince, it.gPlan], pace: data.pace, legend: it.lag(data.pace), empty: t.wNothing, day: data.day,
  });
}
// План набору: обʼєкт × 3 тижні + стан підтвердження
function ordersSpec(od, ts, target, today) {
  const t = txOf(target.lang), it = IMGTX[langOf(target.lang)];
  const own = ts.label === "own";
  const order = { miss: 0, unc: 1, ok: 2 };
  // спершу не введені, далі не підтверджені, далі готові; усередині — за координатором (без координатора — у кінці)
  const rows = od.rows.slice().sort((a, b) => order[a.status] - order[b.status]
    || (a.coordinator_name == null) - (b.coordinator_name == null)
    || (a.coordinator_name || "").localeCompare(b.coordinator_name || "") || a.site_key.localeCompare(b.site_key));
  const label = { ok: it.oOk, unc: it.oUnc, miss: it.oMiss };
  const cols = [{ label: it.site, kind: "site", align: "left" }];
  if (!own) cols.push({ label: it.coord, kind: "muted", align: "left" });
  od.weeks.forEach((w, i) => cols.push({ label: dd(w), kind: "num", sep: i === 0 }));
  cols.push({ label: it.oStatus, kind: "status", align: "left", sep: true });
  const mk = (x) => {
    const cells = [x.site_key];
    if (!own) cells.push(x.coordinator_name || "—");
    x.q.forEach((v) => cells.push(v));
    cells.push(label[x.status]);
    return { cells, tone: x.status === "miss" ? "red" : x.status === "unc" ? "amber" : null };
  };
  const sums = od.weeks.map((_, i) => od.rows.reduce((a, x) => a + (x.q[i] || 0), 0));
  const total = { cells: [it.total, ...(own ? [] : [""]), ...sums, ""] };
  return {
    title: it.oTitle, sub: `${scopeText(t, ts)} · ${it.oSub(dd(today))}`, cols, lead: own ? 1 : 2,
    groups: [{ label: it.oWeeks, span: 3 }],
    rows: rows.map(mk), total,
    legend: [{ tone: "red", text: it.oLegRed }, { tone: "amber", text: it.oLegAmber }], footRight: stamp(today),
  };
}

// ── Відправка картинок ────────────────────────────────────────────────
const CAPTION_MAX = 1000;   // ліміт Telegram — 1024 символи підпису
let IMG_ERRORS = 0;
function renderSafe(spec) {
  try {
    return IMG.render(spec);
  } catch (e) {
    if (IMG_ERRORS++ % 50 === 0) {
      console.error("[flow] картинка не вийшла — шлемо текстом:", e.message,
        "| потрібно: npm install @resvg/resvg-js@2.6.2 opentype.js@1.3.4 і шрифти в assets/fonts");
    }
    return null;
  }
}
async function sendPhotos(chatId, pngs, caption) {
  if (!BOT || !chatId || !pngs.length) return false;
  for (let i = 0; i < pngs.length; i += 10) {
    const part = pngs.slice(i, i + 10);
    const cap = i === 0 && caption ? { caption, parse_mode: "HTML" } : {};
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));
        if (part.length === 1) await BOT.telegram.sendPhoto(chatId, { source: part[0], filename: "tabela.png" }, cap);
        else {
          await BOT.telegram.sendMediaGroup(chatId, part.map((b, k) => ({
            type: "photo", media: { source: b, filename: `tabela_${i + k + 1}.png` }, ...(k === 0 ? cap : {}),
          })));
        }
        ok = true;
      } catch (e) {
        console.error("[flow] telegram photo", chatId, e.message);
      }
    }
    if (!ok) return false;
  }
  return true;
}
// Картинка(и) з підписом. Довгий текст: у підписі — заголовок (до першого порожнього рядка), решта — окремим повідомленням.
// Telegram не прийняв картинку — шлемо fallback (той самий зміст текстом).
async function sendCard(chatId, pngs, text, fallback) {
  let caption = text, rest = "";
  if (text.length > CAPTION_MAX) {
    const lines = text.split("\n");
    const cut = lines.indexOf("");
    caption = (cut > 0 ? lines.slice(0, cut) : lines.slice(0, 2)).join("\n");
    rest = (cut > 0 ? lines.slice(cut + 1) : lines.slice(2)).join("\n").trim();
    if (caption.length > CAPTION_MAX) { caption = ""; rest = text; }
  }
  if (!(await sendPhotos(chatId, pngs, caption))) return fallback ? sendLong(chatId, fallback) : false;
  return !rest || sendLong(chatId, rest);
}

// Щоденне: 1) за день, 2) тиждень з понеділка. Форма — текст або картинки (якщо картинка не вийшла — текст).
async function deliverDaily(t, data, ts, prefix = "") {
  if (t.format === "image") {
    const daySpec = dayTableSpec(data, ts, t);
    const dayPng = daySpec ? renderSafe(daySpec) : [];
    const weekPng = dayPng ? renderSafe(wtdTableSpec(data, ts, t)) : null;
    if (dayPng && weekPng) {
      // за день: у підписі прізвища (координатор, регіон) або переведення, без статусу, дописано (фірма)
      const dayText = prefix + buildDaily(data, ts, t);
      const ok1 = dayPng.length ? await sendCard(t.chat, dayPng, prefix + buildDaily(data, ts, t, { image: true }), dayText)
        : await sendLong(t.chat, dayText);
      const ok2 = await sendCard(t.chat, weekPng, prefix + buildWeekCaption(data, ts, t), prefix + buildWeekToDate(data, ts, t));
      return ok1 && ok2;
    }
  }
  const ok1 = await sendLong(t.chat, prefix + buildDaily(data, ts, t));
  const ok2 = await sendLong(t.chat, prefix + buildWeekToDate(data, ts, t));
  return ok1 && ok2;
}
// Понеділок: план набору (таблиця обʼєкт × 3 тижні) і план–факт минулого тижня
async function deliverMonday(t, today, prefix = "") {
  if (t.format === "image") {
    SITES_CACHE = SITES_CACHE || (await allSites());
    const ts = await targetSites(t);
    const tx = txOf(t.lang), it = IMGTX[langOf(t.lang)];
    const cards = [];
    if (t.orders) {
      const od = await ordersData(ts, today);
      const png = renderSafe(ordersSpec(od, ts, t, today));
      if (png) {
        cards.push([png, [tx.monday(dd(today)), scopeLine(tx, ts), "", od.missing.length ? tx.missing(od.missing.length) : tx.allIn].join("\n"), "orders"]);
      } else cards.push(null);
    }
    if (t.weekly) {
      const prev = addDays(mondayOf(today), -7);
      const wk = await weekData(prev, ts.keys, today);
      const png = renderSafe(weekTableSpec(wk.rows, ts, t, {
        title: it.weekTitle(dd(prev), dd(addDays(prev, 6))), sub: `${scopeText(tx, ts)} · ${it.prevSub}`,
        groups: [it.gFull, it.gPlan], pace: 100, legend: it.lagFull, empty: it.prevEmpty, day: today,
      }));
      if (png) {
        const s = totals(wk.rows);
        // як у таблиці: набір разом із переведеннями
        cards.push([png, [tx.prev(dd(prev), dd(addDays(prev, 6))), scopeLine(tx, ts), "",
          tx.rec2(nz(s.arr_fact) + nz(s.tr_fact), s.sites_with_order ? nz(s.order_qty) : null),
          ...(nz(s.tr_fact) ? [tx.recTr(nz(s.tr_fact))] : []),
          tx.dep2(nz(s.dep_fact), wk.fixed ? nz(s.dep_plan) : null, wk.fixed ? nz(s.dep_unplanned) : 0),
          tx.net(nz(s.arr_fact) + nz(s.tr_fact) - nz(s.dep_fact))].join("\n"), "weekly"]);
      } else cards.push(null);
    }
    if (cards.length && cards.every(Boolean)) {
      let ok = true;
      for (let i = 0; i < cards.length; i++) {
        // Telegram не прийняв картинку — ця частина звіту йде текстом
        const part = cards[i][2] === "orders" ? { ...t, weekly: false } : { ...t, orders: false };
        const fb = (i === 0 ? prefix : "") + (await buildMonday(part, today));
        ok = (await sendCard(t.chat, cards[i][0], (i === 0 ? prefix : "") + cards[i][1], fb)) && ok;
      }
      return ok;
    }
  }
  return sendLong(t.chat, prefix + (await buildMonday(t, today)));
}

// ── Неділя: нагадування координатору про план набору ──────────────────
async function sitesWithoutPlan(siteKeys, today) {
  const weeks = orderWeeks(today);
  const r = await db.query(
    `SELECT s.k AS site_key FROM unnest($1::text[]) s(k)
      WHERE (SELECT count(*) FROM flow.v_orders o
              WHERE o.site_key = s.k AND o.week_start = ANY($2::date[])
                AND o.entered_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Warsaw') < 3
      ORDER BY 1`,
    [siteKeys, weeks, confirmFrom(today)],
  );
  return r.rows.map((x) => x.site_key);
}
async function buildRemind(t, today, force) {
  const st = await getSettings();
  const tx = TX[langOf(t.lang)];
  const ts = await targetSites({ ...t, scope: "own" });
  // тест для адміна без своїх об'єктів — показуємо на прикладі перших об'єктів
  const missing = force ? (ts.keys.length ? ts.keys : (SITES_CACHE || []).slice(0, 3).map((s) => s.site_key))
    : await sitesWithoutPlan(ts.keys, today);
  if (!missing.length) return null;
  const weeks = orderWeeks(today).map(dd).join(", ");
  return [tx.remind(weeks, st.orders_deadline), "", tx.remindSites, ...missing.map((k) => `• ${esc(k)}`), "", tx.where].join("\n");
}

// ── Понеділок: план набору по обʼєктах + план–факт минулого тижня ─────
// План на 3 тижні: на понеділок «найближчий» тиждень — уже поточний, тому тижні від сьогодні.
// Стан обʼєкта: ok — усі 3 тижні збережені після суботи 0:00; unc — цифри є, але не підтверджені; miss — бракує тижня.
async function ordersData(ts, today) {
  const cur = mondayOf(today);
  const weeks = [cur, addDays(cur, 7), addDays(cur, 14)];
  const r = await db.query(
    `SELECT s.k AS site_key, to_char(w.w, 'YYYY-MM-DD') AS week, o.qty,
            COALESCE(o.entered_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Warsaw', false) AS confirmed
       FROM unnest($1::text[]) s(k) CROSS JOIN unnest($2::date[]) w(w)
       LEFT JOIN flow.v_orders o ON o.site_key = s.k AND o.week_start = w.w`,
    [ts.keys, weeks, confirmFrom(today)]);
  const by = {};
  for (const x of r.rows) {
    const o = (by[x.site_key] = by[x.site_key] || { q: {}, has: 0, conf: 0 });
    o.q[x.week] = x.qty == null ? null : Number(x.qty);
    if (x.qty != null) o.has++;
    if (x.qty != null && x.confirmed) o.conf++;
  }
  const rows = ts.keys.map((k) => {
    const o = by[k] || { q: {}, has: 0, conf: 0 };
    const s = (ts.sites || []).find((y) => y.site_key === k) || {};
    return { site_key: k, coordinator_name: s.coordinator_name || null, q: weeks.map((w) => (o.q[w] == null ? null : o.q[w])),
      status: o.conf >= 3 ? "ok" : o.has >= 3 ? "unc" : "miss" };
  });
  return { weeks, rows, missing: rows.filter((x) => x.status !== "ok") };
}
async function buildMonday(t, today) {
  const tx = TX[langOf(t.lang)];
  SITES_CACHE = SITES_CACHE || (await allSites());
  const ts = await targetSites(t);
  const L = [tx.monday(dd(today))];
  if (t.orders) {
    const od = await ordersData(ts, today);
    L.push("", od.missing.length ? tx.missing(od.missing.length) : tx.allIn);
    // по обʼєктах: «• NOTINO — 12 · 10 · 10 ✅», по фірмі й регіону — згруповано за координатором
    L.push("", tx.plansBy(od.weeks.map(dd).join(" · ")));
    const icon = { ok: "✅", unc: "⚠️", miss: "❌" };
    const order = { miss: 0, unc: 1, ok: 2 };
    const line = (x) => `• ${esc(x.site_key)}: ${x.q.map((v) => (v == null ? "—" : B(v))).join(" · ")} ${icon[x.status]}`;
    const sorted = od.rows.slice().sort((a, b) => order[a.status] - order[b.status] || a.site_key.localeCompare(b.site_key));
    if (ts.label === "own") sorted.forEach((x) => L.push(line(x)));
    else {
      const g = {};
      sorted.forEach((x) => { const c = x.coordinator_name || tx.noCoord; (g[c] = g[c] || []).push(x); });
      Object.keys(g).sort((a, b) => a.localeCompare(b)).forEach((c) => { L.push(`<b>${esc(c)}</b>`); g[c].forEach((x) => L.push(line(x))); });
    }
    const sums = od.weeks.map((_, i) => od.rows.reduce((a, x) => a + (x.q[i] || 0), 0));
    L.push(`${tx.plansTotal}: ${sums.map(B).join(" · ")}`, tx.plansLegend);
  }
  if (t.weekly) {
    const prev = addDays(mondayOf(today), -7);
    const wk = await weekData(prev, ts.keys, today);
    const s = totals(wk.rows);
    L.push("", tx.prev(dd(prev), dd(addDays(prev, 6))));
    L.push(tx.rec(s.arr_fact || 0, s.sites_with_order ? s.order_qty : null, s.arr_entered || 0, s.tr_fact || 0));
    L.push(tx.dep(s.dep_fact || 0, wk.fixed ? s.dep_plan || 0 : null, wk.fixed ? s.dep_unplanned || 0 : 0));
    L.push(tx.net((s.arr_fact || 0) + (s.tr_fact || 0) - (s.dep_fact || 0)));
    const worst = wk.rows
      .filter((x) => (x.order_qty && x.arr_fact < x.order_qty) || (x.dep_unplanned || 0) > 0)
      .sort((a, b) => ((b.order_qty || 0) - b.arr_fact + (b.dep_unplanned || 0)) - ((a.order_qty || 0) - a.arr_fact + (a.dep_unplanned || 0)))
      .slice(0, 10);
    if (worst.length) {
      L.push("", tx.worst);
      worst.forEach((x) => L.push(tx.wLine(esc(x.site_key), x.arr_fact, x.order_qty, x.dep_unplanned)));
    }
  }
  return L.join("\n");
}

// ══════════════════════════════════════════════════════════════════════
//  Планувальник
// ══════════════════════════════════════════════════════════════════════
let BOT = null;
async function claim(job, key) {
  const r = await db.query(`INSERT INTO flow.job_runs (job, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job`, [job, key]);
  return r.rowCount > 0;
}
async function capture(source) {
  try {
    const r = await db.query(`SELECT * FROM flow.capture($1)`, [source || null]);
    const x = r.rows[0];
    if (x && (x.new_rows || x.changed || x.gone)) console.log(`[flow] journal ${source}: +${x.new_rows} ~${x.changed} -${x.gone}`);
    return x;
  } catch (e) {
    console.error("[flow] capture", e.message);
    return null;
  }
}

// Імпорт таблиці: виклики йдуть по черзі (не одночасно), після кожного — запис у журнал.
// Повний імпорт, що вже стоїть у черзі, новий повний виклик не дублює — чекає на нього.
// Імпорт довше 30 хв вважаємо завислим: черга йде далі, щоб не стали зведення та інші імпорти.
// index.js і api/routes.js беруть require("./import_sheets").runImport у момент запуску —
// підміна в exports діє для всіх, сам import_sheets.js не змінюється.
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
let IMPORT_CHAIN = Promise.resolve();
function wrapImport() {
  let mod;
  try { mod = require("../import_sheets"); } catch (e) { console.error("[flow] import_sheets", e.message); return; }
  if (!mod || mod.__flowWrapped || typeof mod.runImport !== "function") return;
  const orig = mod.runImport;
  let queuedFull = null;
  mod.runImport = function (...args) {
    const full = !args[0] || (Array.isArray(args[0]) && !args[0].length);
    if (full && queuedFull) return queuedFull.promise;
    const job = {};
    job.promise = IMPORT_CHAIN.then(async () => {
      if (full && queuedFull === job) queuedFull = null;   // стартував — наступний повний стане в чергу
      let timer;
      try {
        return await Promise.race([
          orig.apply(this, args),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("import timeout 30 min")), IMPORT_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timer);
        await capture("import");
      }
    });
    if (full) queuedFull = job;
    IMPORT_CHAIN = job.promise.catch((e) => console.error("[flow] import", e.message));
    return job.promise;
  };
  mod.__flowWrapped = true;
}
// Чекати, поки черга імпортів спорожніє, але не довше ms
async function waitImports(ms) {
  let timer;
  await Promise.race([IMPORT_CHAIN, new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

async function sendDaily(day) {
  const data = await dailyData(day, true);
  const st = await getSettings();
  let sent = 0, failed = 0;
  for (const t of await resolveRecipients()) {
    if (!t.daily) continue;
    const ts = await targetSites(t);
    if (!ts.keys.length) continue;
    if (t.scope === "own" && st.skip_empty === "1" && !dailyHasNews(data, ts)) continue;
    // 1) за день, 2) тиждень наростаючим підсумком — текстом або картинками (t.format)
    if (await deliverDaily(t, data, ts)) sent++; else failed++;
  }
  await db.query(`UPDATE flow.summaries SET sent = $2, failed = $3 WHERE day = $1::date`, [day, sent, failed]);
  console.log(`[flow] summary ${day}: sent ${sent}, failed ${failed}`);
}
// Нагадування — кожному координатору зі своїми об'єктами (якщо auto_coords = 1)
async function sendRemind(today) {
  const st = await getSettings();
  if (st.auto_coords !== "1") return;
  SITES_CACHE = await allSites();
  const cs = await db.query(
    `SELECT DISTINCT c.id, c.telegram_chat_id, to_jsonb(c)->>'lang' AS lang
       FROM reg.site_owner o JOIN public.coordinators c ON c.id = o.coordinator_id
      WHERE o.valid_to IS NULL AND c.is_active AND c.telegram_chat_id IS NOT NULL`);
  let n = 0;
  for (const c of cs.rows) {
    const t = { chat: String(c.telegram_chat_id), coordinator_id: c.id, lang: langOf(c.lang), scope: "own" };
    const text = await buildRemind(t, today, false);
    if (text && (await sendLong(t.chat, text))) n++;
  }
  console.log(`[flow] orders reminder ${today}: ${n}`);
}
async function sendMonday(today) {
  SITES_CACHE = await allSites();
  let n = 0;
  for (const t of await resolveRecipients()) {
    if (t.auto || !(t.orders || t.weekly)) continue;
    const ts = await targetSites(t);
    if (!ts.keys.length) continue;
    if (await deliverMonday(t, today)) n++;
  }
  console.log(`[flow] monday report ${today}: ${n}`);
}

async function tick() {
  const st = await getSettings();
  if (st.enabled !== "1") return;
  const ck = await clock();
  const now = hmToMin(ck.hm);
  const days = String(st.summary_days || "").split(",").map(Number);
  const sumAt = hmToMin(st.summary_time);
  const inWin = (at, minutes) => at != null && now >= at && now < at + minutes;

  // план виїздів тижня: у понеділок, або пізніше, якщо ще не зафіксований
  const week = mondayOf(ck.today);
  const wf = await db.query(`SELECT 1 FROM flow.weeks WHERE week_start = $1::date`, [week]);
  if (!wf.rows.length) {
    const late = !(ck.dow === 1 && now < 60);
    const n = await db.query(`SELECT flow.fix_week($1::date, $2) AS n`, [week, late]);
    console.log(`[flow] week ${week} plan fixed: ${n.rows[0].n} departures${late ? " (late)" : ""}`);
  }
  // імпорт перед зведенням
  const pre = Number(st.pre_import_min) || 0;
  if (pre > 0 && days.includes(ck.dow) && inWin(sumAt - pre, 10) && (await claim("preimport", ck.today))) {
    // не чекаємо: імпорт іде у фоні, зведення нижче почекає на нього (до 15 хв)
    Promise.resolve().then(() => require("../import_sheets").runImport()).catch((e) => console.error("[flow] pre-import", e.message));
  }
  // зведення (до 3 годин запізнення — якщо сервер перезапускався)
  if (days.includes(ck.dow) && inWin(sumAt, 180) && (await claim("summary", ck.today))) {
    await waitImports(15 * 60 * 1000);
    await capture("summary");
    await sendDaily(ck.today);
  }
  // неділя: нагадування координаторам
  if (ck.dow === 7) {
    for (const hm of String(st.orders_remind || "").split(",").filter(Boolean)) {
      if (inWin(hmToMin(hm), 60) && (await claim("remind", `${ck.today} ${hm}`))) await sendRemind(ck.today);
    }
  }
  // понеділок: план набору і план–факт минулого тижня
  if (ck.dow === 1 && inWin(hmToMin(st.monday_time), 180) && (await claim("monday", ck.today))) await sendMonday(ck.today);
}

function schedule(bot) {
  BOT = bot;
  wrapImport();
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { console.error("[flow] tick", e.message); } finally { busy = false; }
  };
  setTimeout(run, 20 * 1000);
  setInterval(run, 30 * 1000);
  // журнал і без імпорту (таблицю могли змінити вручну в базі або окремим скриптом)
  setInterval(() => capture("timer"), 10 * 60 * 1000);
}

// Вебхук: групи, куди додали бота, — запам'ятати для списку отримувачів.
// Повертає true для оновлень із груп: боту працівників там нічого робити.
async function onUpdate(u) {
  try {
    if (!u) return false;
    const mcm = u.my_chat_member;
    const msg = u.message || u.edited_message || u.channel_post || u.edited_channel_post;
    const chat = (mcm && mcm.chat) || (msg && msg.chat) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat);
    if (!chat || chat.type === "private") return false;
    // група стала супергрупою: новий chat_id — переносимо отримувачів
    if (msg && msg.migrate_to_chat_id) {
      await db.query(`UPDATE flow.recipients SET chat_id = $2 WHERE chat_id = $1`, [chat.id, msg.migrate_to_chat_id]);
      await db.query(`UPDATE flow.chats SET is_member = false, updated_at = now() WHERE chat_id = $1`, [chat.id]);
      await db.query(
        `INSERT INTO flow.chats (chat_id, title, type, is_member) VALUES ($1, $2, 'supergroup', true)
         ON CONFLICT (chat_id) DO UPDATE SET is_member = true, updated_at = now()`, [msg.migrate_to_chat_id, chat.title || null]);
      return true;
    }
    const member = mcm ? ["member", "administrator", "creator"].includes(mcm.new_chat_member && mcm.new_chat_member.status) : true;
    await db.query(
      `INSERT INTO flow.chats (chat_id, title, type, is_member, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, type = EXCLUDED.type,
              is_member = EXCLUDED.is_member, updated_at = now()`,
      [chat.id, chat.title || null, chat.type || null, member],
    );
    return true;
  } catch (e) {
    console.error("[flow] onUpdate", e.message);
    return false;
  }
}

module.exports = { router, schedule, onUpdate, capture, setBot: (b) => { BOT = b; },
  _test: { dailyData, buildDaily, buildWeekToDate, targetSites, resolveRecipients, buildRemind, buildMonday, sendDaily, tick, weekData, totals, wrapImport, waitImports,
    deliverDaily, deliverMonday, sendMonday, dayTableSpec, wtdTableSpec, ordersSpec, ordersData, buildWeekCaption, paceOf, isLagging } };
