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
// Підтверджено цього циклу: на всі 3 тижні є запис від понеділка тижня перед m1 (00:00)
function cycleStart(m1) { return addDays(m1, -7); }

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
             [keys, cur, cycleStart(weeks[0])]),
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
      can_edit_current: req.fscope.role === "all", rows });
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
      `INSERT INTO flow.recipients (coordinator_id, chat_id, label, scope, region_id, daily, orders, weekly, lang, is_active, created_by)
       VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [r.coordinator_id, r.chat_id, r.label, r.scope, r.region_id, r.daily, r.orders, r.weekly, r.lang, r.is_active, req.coordinator.coordinator_id],
    );
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { fail(res, e, e.code === 400 ? 400 : 500); }
});
router.patch("/recipients/:id", adminOnly, async (req, res) => {
  try {
    const r = recipientBody(req.body || {});
    await db.query(
      `UPDATE flow.recipients SET coordinator_id = $2, chat_id = $3::bigint, label = $4, scope = $5, region_id = $6,
              daily = $7, orders = $8, weekly = $9, lang = $10, is_active = $11 WHERE id = $1`,
      [parseInt(req.params.id, 10), r.coordinator_id, r.chat_id, r.label, r.scope, r.region_id, r.daily, r.orders, r.weekly, r.lang, r.is_active],
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
router.post("/test", adminOnly, async (req, res) => {
  try {
    if (!BOT) return res.status(400).json({ ok: false, error: "Bot niedostępny" });
    const ck = await clock();
    const kind = ["daily", "remind", "monday"].includes(req.body && req.body.kind) ? req.body.kind : "daily";
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
    SITES_CACHE = await allSites();
    let sent = 0;
    if (kind === "daily") {
      const data = await dailyData(ck.today, false);
      for (const t of targets) {
        const text = "🧪 TEST\n" + buildDaily(data, await targetSites(t), t);
        if (await sendLong(t.chat, text)) sent++;
      }
    } else if (kind === "remind") {
      for (const t of targets) if (await sendLong(t.chat, "🧪 TEST\n" + (await buildRemind(t, ck.today, true)))) sent++;
    } else {
      for (const t of targets) {
        const text = await buildMonday({ ...t, orders: true, weekly: true }, ck.today);
        if (await sendLong(t.chat, "🧪 TEST\n" + text)) sent++;
      }
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
    out: (n, w) => `🔻 <b>Виїхали ${w}: ${n}</b>`,
    today: "сьогодні", since: (d) => `з ${d}`,
    tr: (n) => `🔁 <b>Переведення: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Вийшли нові ${w}: ${n}</b>`,
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
    remind: (weeks, dl) => `✍️ <b>План набору на 3 тижні</b>\nВведіть до ${dl}, скільки людей треба набрати на тижні ${weeks}.`,
    remindSites: "Обʼєкти без плану:",
    where: "Панель → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>План і факт · ${d}</b>`,
    missing: (n) => `✍️ <b>Не ввели план набору: ${n}</b>`,
    allIn: "✅ План набору ввели всі.",
    plans: "План набору:",
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
    out: (n, w) => `🔻 <b>Уехали ${w}: ${n}</b>`,
    today: "сегодня", since: (d) => `с ${d}`,
    tr: (n) => `🔁 <b>Переводы: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Вышли новые ${w}: ${n}</b>`,
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
    remind: (weeks, dl) => `✍️ <b>План набора на 3 недели</b>\nВведите до ${dl}, сколько людей нужно набрать на недели ${weeks}.`,
    remindSites: "Объекты без плана:",
    where: "Панель → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>План и факт · ${d}</b>`,
    missing: (n) => `✍️ <b>Не ввели план набора: ${n}</b>`,
    allIn: "✅ План набора ввели все.",
    plans: "План набора:",
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
    out: (n, w) => `🔻 <b>Wyjechali ${w}: ${n}</b>`,
    today: "dziś", since: (d) => `od ${d}`,
    tr: (n) => `🔁 <b>Przeniesienia: ${n}</b>`,
    inNew: (n, w) => `🟢 <b>Nowi zaczęli ${w}: ${n}</b>`,
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
    remind: (weeks, dl) => `✍️ <b>Plan naboru na 3 tygodnie</b>\nWpisz do ${dl}, ilu ludzi trzeba zrekrutować na tygodnie ${weeks}.`,
    remindSites: "Obiekty bez planu:",
    where: "Panel → 🚌 Wyjazdy / przyjazdy → Plan naboru",
    monday: (d) => `📋 <b>Plan i fakt · ${d}</b>`,
    missing: (n) => `✍️ <b>Bez planu naboru: ${n}</b>`,
    allIn: "✅ Plan naboru wpisali wszyscy.",
    plans: "Plan naboru:",
    prev: (a, b) => `📅 <b>Poprzedni tydzień ${a}–${b}</b>`,
    net: (n) => `Liczebność: ${n > 0 ? "+" : ""}${n}`,
    worst: "Największe zaległości:",
    wLine: (s, f, p, u) => `• ${s} — nabór ${f}${p != null ? ` z ${p}` : ""}${u ? `, poza planem ${u}` : ""}`,
    noCoord: "bez koordynatora",
  },
};
const langOf = (l) => (TX[l] ? l : "uk");

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
      daily: r.daily, orders: r.orders, weekly: r.weekly, lang: langOf(r.lang), auto: false });
  }
  if (st.auto_coords === "1") {
    const ac = await db.query(
      `SELECT DISTINCT c.id, c.telegram_chat_id, to_jsonb(c)->>'lang' AS lang
         FROM reg.site_owner o JOIN public.coordinators c ON c.id = o.coordinator_id
        WHERE o.valid_to IS NULL AND c.is_active AND c.telegram_chat_id IS NOT NULL`);
    for (const c of ac.rows) {
      if (explicitCoords.has(c.id)) continue;
      out.push({ id: null, chat: String(c.telegram_chat_id), scope: "own", coordinator_id: c.id,
        daily: true, orders: false, weekly: false, lang: langOf(c.lang), auto: true });
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
  // Основний блок — усе від попереднього зведення (дні без зведення, напр. вихідні, теж тут).
  // «Дописано» — дати, які вже були в попередніх зведеннях, але цих записів там не було.
  // Перше зведення бере лише сьогодні: старіша історія не «дописана».
  const clamp = (d) => (d < addDays(day, -lateDays) ? addDays(day, -lateDays) : d);
  const mainFrom = prevDay ? clamp(addDays(prevDay, 1)) : day;
  const lateFrom = first ? clamp(first) : day;
  const lateTo = prevDay || addDays(day, -1);   // включно
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
               WHERE ${notShown("out")}`, [lateFrom, lateTo]),
    db.query(`SELECT x.*, to_char(x.move_date, 'YYYY-MM-DD') AS date, w.full_name FROM flow.arrivals($1::date, $2::date) x ${names}
               WHERE ${notShown("in")}`, [lateFrom, lateTo]),
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
  const data = {
    day, week, weekEnd: addDays(week, 6), mainFrom,
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
const NAMES_MAX = 15;
function bySite(list, keyset) { return list.filter((x) => keyset.has(x.site_key)); }
function groupLines(list, t, own, extra) {
  // own: імена по обʼєкту; інакше — кількість по обʼєкту з координатором
  const g = {};
  list.forEach((x) => { (g[x.site_key] = g[x.site_key] || []).push(x); });
  const lines = Object.keys(g).sort((a, b) => g[b].length - g[a].length || a.localeCompare(b)).map((k) => {
    if (own) {
      const ns = g[k].map((x) => esc(x.full_name) + (extra ? extra(x) : ""));
      return `• ${esc(k)}: ${ns.slice(0, NAMES_MAX).join(", ")}${ns.length > NAMES_MAX ? " " + t.more(ns.length - NAMES_MAX) : ""}`;
    }
    const c = (SITES_CACHE || []).find((s) => s.site_key === k);
    return `• ${esc(k)} — ${g[k].length}${c && c.coordinator_name ? ` (${esc(c.coordinator_name)})` : ""}`;
  });
  return lines.slice(0, 25).concat(lines.length > 25 ? [t.more(lines.length - 25)] : []);
}

function buildDaily(data, ts, target) {
  const t = TX[langOf(target.lang)];
  const keys = new Set(ts.keys);
  const own = ts.label === "own";
  const dow = new Date(data.day + "T00:00:00Z").getUTCDay();
  const L = [t.title(`${t.days[dow]} ${dd(data.day)}`)];
  L.push(`<i>${own ? t.sOwn : ts.label === "region" ? esc(t.sRegion(ts.regionName || "—")) : t.sAll}</i>`);

  const deps = bySite(data.deps, keys);
  const out = deps.filter((x) => !x.is_transfer), tr = deps.filter((x) => x.is_transfer);
  const arrs = bySite(data.arrs, keys);
  const aNew = arrs.filter((x) => x.kind === "new" && !["rezygnacja", "unknown"].includes(x.status));
  const aUnc = arrs.filter((x) => x.kind === "new" && x.status === "unknown");
  const aTr = arrs.filter((x) => x.kind === "transfer" && x.status !== "rezygnacja");
  const aRez = arrs.filter((x) => x.status === "rezygnacja");
  const multi = data.mainFrom < data.day;
  const dt = (x) => (multi ? ` (${dd(x.date)})` : "");
  const arrow = (x) => (x.to_site ? ` → ${esc(x.to_site)}` : "") + dt(x);
  const from = (x) => (x.from_site ? ` ← ${esc(x.from_site)}` : "") + dt(x);

  const when = data.mainFrom < data.day ? t.since(dd(data.mainFrom)) : t.today;
  if (!deps.length && !arrs.length) L.push("", t.nothing(when));
  if (out.length) L.push("", t.out(out.length, when), ...groupLines(out, t, own, dt));
  if (tr.length) L.push("", t.tr(tr.length), ...groupLines(tr, t, true, arrow));
  if (aNew.length) L.push("", t.inNew(aNew.length, when), ...groupLines(aNew, t, own, dt));
  if (aTr.length) L.push("", t.inTr(aTr.length), ...groupLines(aTr, t, true, from));
  if (aUnc.length) L.push("", t.unconf(aUnc.length), ...groupLines(aUnc, t, own, dt));
  if (aRez.length) L.push("", t.rez(aRez.length), ...groupLines(aRez, t, own, dt));

  const late = [
    ...bySite(data.lateDeps, keys).map((x) => ({ ...x, k: x.is_transfer ? t.kOut + " 🔁" : t.kOut })),
    ...bySite(data.lateArrs, keys).map((x) => ({ ...x, k: x.status === "rezygnacja" ? t.kRez : t.kIn })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.site_key.localeCompare(b.site_key));
  if (late.length) {
    L.push("", t.late);
    if (own) late.slice(0, 30).forEach((x) => L.push(`• ${dd(x.date)} ${esc(x.site_key)} — ${x.k}: ${esc(x.full_name)}`));
    else {
      const g = {};
      late.forEach((x) => { const k = `${x.date}|${x.site_key}|${x.k}`; g[k] = (g[k] || 0) + 1; });
      Object.entries(g).slice(0, 30).forEach(([k, n]) => { const [d, s, kk] = k.split("|"); L.push(`• ${dd(d)} ${esc(s)} — ${kk}: ${n}`); });
    }
    if (late.length > 30) L.push(t.more(late.length - 30));
  }
  const corr = [
    ...bySite(data.corrOut, keys).map((x) => ({ ...x, what: x.new_date ? t.moved(dd(x.new_date)) : t.cancelled, k: t.kOut })),
    ...bySite(data.corrIn, keys).map((x) => ({ ...x, what: x.cur_status === "rezygnacja" ? t.notCame : x.new_date ? t.moved(dd(x.new_date)) : t.cancelled, k: t.kIn })),
  ];
  if (corr.length) {
    L.push("", t.corr);
    corr.slice(0, 30).forEach((x) => L.push(`• ${dd(x.date)} ${esc(x.site_key)} — ${x.k} ${esc(x.full_name)}: ${x.what}`));
  }

  const wr = data.weekRows.filter((x) => keys.has(x.site_key));
  const s = totals(wr);
  L.push("", t.week(dd(data.week), dd(data.weekEnd)));
  L.push(t.rec(s.arr_fact || 0, s.sites_with_order ? s.order_qty : null, s.arr_entered || 0, s.tr_fact || 0));
  L.push(t.dep(s.dep_fact || 0, data.weekFixed ? s.dep_plan || 0 : null, data.weekFixed ? s.dep_unplanned || 0 : 0));
  return L.join("\n");
}
// Чи є що показати координатору (для skip_empty)
function dailyHasNews(data, ts) {
  const keys = new Set(ts.keys);
  return [data.deps, data.arrs, data.lateDeps, data.lateArrs, data.corrOut, data.corrIn].some((l) => l.some((x) => keys.has(x.site_key)));
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
    [siteKeys, weeks, cycleStart(weeks[0])],
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

// ── Понеділок: хто не ввів план + план–факт минулого тижня ────────────
async function buildMonday(t, today) {
  const tx = TX[langOf(t.lang)];
  SITES_CACHE = SITES_CACHE || (await allSites());
  const ts = await targetSites(t);
  const L = [tx.monday(dd(today))];
  if (t.orders) {
    // на понеділок «найближчий» тиждень — уже поточний: перевіряємо тижні від сьогодні
    const cur = mondayOf(today);
    const weeks = [cur, addDays(cur, 7), addDays(cur, 14)];
    const miss = await db.query(
      `SELECT s.k AS site_key FROM unnest($1::text[]) s(k)
        WHERE (SELECT count(*) FROM flow.v_orders o WHERE o.site_key = s.k AND o.week_start = ANY($2::date[])
                AND o.entered_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Warsaw') < 3 ORDER BY 1`,
      [ts.keys, weeks, cycleStart(cur)]);
    const byCoord = {};
    miss.rows.forEach((x) => {
      const s = ts.sites.find((y) => y.site_key === x.site_key) || {};
      const c = s.coordinator_name || tx.noCoord;
      (byCoord[c] = byCoord[c] || []).push(x.site_key);
    });
    L.push("");
    if (miss.rows.length) {
      L.push(tx.missing(miss.rows.length));
      Object.keys(byCoord).sort().forEach((c) => L.push(`• ${esc(c)}: ${byCoord[c].map(esc).join(", ")}`));
    } else L.push(tx.allIn);
    const plans = await db.query(
      `SELECT to_char(week_start, 'YYYY-MM-DD') AS w, sum(qty)::int AS n FROM flow.v_orders
        WHERE site_key = ANY($1::text[]) AND week_start = ANY($2::date[]) GROUP BY 1 ORDER BY 1`, [ts.keys, weeks]);
    if (plans.rows.length) L.push(`${tx.plans} ${plans.rows.map((x) => `${dd(x.w)} — ${x.n}`).join(" · ")}`);
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
    if (await sendLong(t.chat, buildDaily(data, ts, t))) sent++; else failed++;
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
    if (await sendLong(t.chat, await buildMonday(t, today))) n++;
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
  _test: { dailyData, buildDaily, targetSites, resolveRecipients, buildRemind, buildMonday, sendDaily, tick, weekData, totals, wrapImport, waitImports } };
