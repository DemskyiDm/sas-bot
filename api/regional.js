// ══════════════════════════════════════════════════════════════════════
//  Розділ «Region» — RAG-статус об'єктів для регіональних координаторів
//  Монтується в index.js:  app.use("/api/regional", regional.router)
//  Уся логіка статусів — у SQL (reg.rag_raw / reg.take_snapshot),
//  тут тільки доступ, вибірки і розсилки.
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");

const STATUS_ORDER = { R: 0, A: 1, G: 2, S: 3, N: 4 };

// ── Доступ ────────────────────────────────────────────────────────────
// Адмін бачить усе. Регіональний — тільки регіони, де він призначений.
async function getScope(coordinator) {
  const r = await db.query(
    `SELECT r.id, r.name,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.full_name) ORDER BY c.full_name)
                        FROM reg.region_leads rl
                        JOIN public.coordinators c ON c.id = rl.coordinator_id
                       WHERE rl.region_id = r.id), '[]') AS leads
       FROM reg.regions r
      WHERE r.is_active
        AND ($1::boolean OR EXISTS (SELECT 1 FROM reg.region_leads rl
                                     WHERE rl.region_id = r.id AND rl.coordinator_id = $2))
      ORDER BY r.name`,
    [!!coordinator.is_admin, coordinator.coordinator_id],
  );
  return { isAdmin: !!coordinator.is_admin, regions: r.rows, regionIds: r.rows.map((x) => x.id) };
}

async function requireRegional(req, res, next) {
  try {
    req.scope = await getScope(req.coordinator);
    if (!req.scope.isAdmin && req.scope.regionIds.length === 0)
      return res.status(403).json({ ok: false, error: "Brak dostępu do sekcji Region" });
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

function requireAdminOnly(req, res, next) {
  if (!req.coordinator.is_admin) return res.status(403).json({ ok: false, error: "Admin only" });
  next();
}

// region=all | none | <id>  →  { sql, params } для умови по region_id
function regionClause(scope, region, col, params) {
  if (region === "none") {
    if (!scope.isAdmin) return "false";
    return `${col} IS NULL`;
  }
  if (region && region !== "all") {
    const id = parseInt(region, 10);
    if (!scope.regionIds.includes(id)) return "false";
    params.push(id);
    return `${col} = $${params.length}`;
  }
  if (scope.isAdmin) return "true";
  params.push(scope.regionIds);
  return `${col} = ANY($${params.length}::int[])`;
}

async function latestWeek() {
  const r = await db.query(`SELECT to_char(MAX(week_end), 'YYYY-MM-DD') AS w FROM reg.v_snap`);
  return r.rows[0].w;
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Доступ до конкретного об'єкта: регіон зі знімку тижня або поточна прив'язка
async function siteAllowed(scope, siteKey) {
  if (scope.isAdmin) return true;
  const r = await db.query(
    `SELECT 1 FROM reg.site_owner
      WHERE site_key = $1 AND valid_to IS NULL AND region_id = ANY($2::int[])
     UNION
     SELECT 1 FROM reg.v_snap
      WHERE site_key = $1 AND region_id = ANY($2::int[])
     LIMIT 1`,
    [siteKey, scope.regionIds],
  );
  return r.rows.length > 0;
}

// ── Знімок тижня ──────────────────────────────────────────────────────
// Картки створюються/закриваються тільки для найсвіжішого тижня,
// щоб догрузка історії не наплодила карток «заднім числом».
async function takeSnapshot(weekEnd, by, allowCards = true) {
  const last = await latestWeek();
  const manageCards = allowCards && (!last || weekEnd >= last);
  const r = await db.query(`SELECT reg.take_snapshot($1::date, $2, $3) AS n`, [weekEnd, by || null, manageCards]);
  return { rows: r.rows[0].n, manageCards };
}

function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function lastSunday(from) {
  const d = new Date(from || Date.now());
  d.setDate(d.getDate() - (d.getDay() === 0 ? 7 : d.getDay()));
  return localISO(d);
}

// ══════════════════════════════════════════════════════════════════════
//  API
// ══════════════════════════════════════════════════════════════════════
router.use(requireAuth);

router.get("/me", async (req, res) => {
  try {
    const scope = await getScope(req.coordinator);
    res.json({ ok: true, is_admin: scope.isAdmin, regions: scope.regions, has_access: scope.isAdmin || scope.regionIds.length > 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.use(requireRegional);

router.get("/weeks", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT DISTINCT to_char(week_end, 'YYYY-MM-DD') AS w FROM reg.v_snap ORDER BY w DESC LIMIT 52`,
    );
    res.json({ ok: true, data: r.rows.map((x) => x.w) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/reasons", async (req, res) => {
  try {
    const r = await db.query(`SELECT code, label FROM reg.reasons ORDER BY sort, label`);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/coordinators-list", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, full_name FROM public.coordinators
        WHERE is_active AND full_name NOT ILIKE 'test%' ORDER BY full_name`,
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Дошка: об'єкти тижня + показники регіону ─────────────────────────
router.get("/board", async (req, res) => {
  try {
    const week = isDate(req.query.week) ? req.query.week : await latestWeek();
    if (!week) return res.json({ ok: true, week: null, sites: [], kpi: null });
    const params = [week];
    const where = regionClause(req.scope, req.query.region, "s.region_id", params);

    const sites = await db.query(
      `SELECT s.site_key, s.region_id, rg.name AS region_name,
              s.coordinator_id, c.full_name AS coordinator_name,
              s.window_days, s.headcount_start, s.headcount_end, s.headcount_avg::float8 AS headcount_avg,
              s.departures, s.rotation::float8 AS rotation,
              s.ret_possible, s.ret_achieved, s.retention::float8 AS retention,
              s.abs_nn, s.abs_base, s.absence::float8 AS absence,
              s.st_rot, s.st_ret, s.st_abs, s.raw_status, s.status, s.red_weeks,
              (SELECT json_agg(json_build_object('w', to_char(h.week_end,'YYYY-MM-DD'), 's', h.status) ORDER BY h.week_end)
                 FROM reg.v_snap h
                WHERE h.site_key = s.site_key AND h.week_end BETWEEN $1::date - 49 AND $1::date) AS trend,
              card.id AS card_id, card.status AS card_status,
              to_char(card.due_at, 'YYYY-MM-DD HH24:MI') AS card_due,
              (card.status = 'open' AND card.due_at < now()) AS card_overdue
         FROM reg.v_snap s
         LEFT JOIN reg.regions rg ON rg.id = s.region_id
         LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
         LEFT JOIN LATERAL (
           SELECT * FROM reg.red_cards rc
            WHERE rc.site_key = s.site_key AND rc.status <> 'closed'
            ORDER BY rc.opened_at DESC LIMIT 1) card ON true
        WHERE s.week_end = $1::date AND ${where}`,
      params,
    );
    const rows = sites.rows.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        b.red_weeks - a.red_weeks ||
        b.headcount_end - a.headcount_end,
    );

    // ── Показники регіону (квартал тижня) ──
    const kp = [week];
    const kWhere = regionClause(req.scope, req.query.region, "s.region_id", kp);
    const kWhereCards = kWhere.replace(/s\.region_id/g, "c.region_id");
    const kpi = await db.query(
      `WITH q AS (SELECT date_trunc('quarter', $1::date)::date AS qs),
       wk AS (
         SELECT s.week_end,
                SUM(s.headcount_end) FILTER (WHERE s.status IN ('G','A','R'))  AS hc,
                SUM(s.headcount_end) FILTER (WHERE s.status = 'R')             AS hc_red
           FROM reg.v_snap s, q
          WHERE s.week_end BETWEEN q.qs AND $1::date AND ${kWhere}
          GROUP BY s.week_end),
       first_w AS (SELECT MIN(week_end) AS w FROM wk),
       red_start AS (
         SELECT s.site_key FROM reg.v_snap s, first_w
          WHERE s.week_end = first_w.w AND s.status = 'R' AND ${kWhere}),
       now_w AS (
         SELECT s.site_key, s.status FROM reg.v_snap s
          WHERE s.week_end = $1::date AND ${kWhere}),
       cards AS (
         SELECT c.* FROM reg.red_cards c, q
          WHERE c.opened_at >= q.qs AND ${kWhereCards})
       SELECT
         (SELECT to_char(qs, 'YYYY-MM-DD') FROM q) AS quarter_start,
         (SELECT hc FROM wk WHERE week_end = $1::date)     AS hc,
         (SELECT hc_red FROM wk WHERE week_end = $1::date) AS hc_red,
         (SELECT AVG(hc_red::numeric / NULLIF(hc, 0)) FROM wk)::float8 AS share_red_quarter,
         (SELECT COUNT(*) FROM wk) AS weeks_in_quarter,
         (SELECT COUNT(*) FROM red_start) AS red_at_start,
         (SELECT COUNT(*) FROM red_start rs JOIN now_w n USING (site_key) WHERE n.status <> 'R') AS red_exited,
         (SELECT COUNT(*) FROM now_w WHERE status = 'R') AS sites_red,
         (SELECT COUNT(*) FROM now_w WHERE status = 'A') AS sites_amber,
         (SELECT COUNT(*) FROM now_w WHERE status = 'G') AS sites_green,
         (SELECT COUNT(*) FROM now_w WHERE status IN ('S','N')) AS sites_other,
         (SELECT COUNT(*) FROM cards WHERE filled_at IS NOT NULL OR due_at < now()) AS cards_due,
         (SELECT COUNT(*) FROM cards WHERE filled_at IS NOT NULL AND filled_at <= due_at) AS cards_on_time,
         (SELECT COUNT(*) FROM cards WHERE status = 'open' AND due_at < now()) AS cards_overdue`,
      kp,
    );
    const k = kpi.rows[0];
    ["hc", "hc_red", "weeks_in_quarter", "red_at_start", "red_exited", "sites_red", "sites_amber",
      "sites_green", "sites_other", "cards_due", "cards_on_time", "cards_overdue"].forEach(
      (f) => (k[f] = parseInt(k[f] || 0, 10)),
    );
    k.share_red = k.hc ? k.hc_red / k.hc : null;

    const settings = await db.query(`SELECT key, value::float8 AS value FROM reg.settings`);
    res.json({
      ok: true,
      week,
      sites: rows,
      kpi: k,
      settings: Object.fromEntries(settings.rows.map((x) => [x.key, x.value])),
    });
  } catch (e) {
    console.error("[regional/board]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Картка об'єкта: показники, історія, поіменні списки, червона картка ─
router.get("/site", async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ ok: false, error: "key required" });
    if (!(await siteAllowed(req.scope, key))) return res.status(403).json({ ok: false, error: "Forbidden" });
    const week = isDate(req.query.week) ? req.query.week : await latestWeek();

    const [snap, hist, owner, card] = await Promise.all([
      db.query(
        `SELECT s.*, to_char(s.week_end,'YYYY-MM-DD') AS week_end,
                s.rotation::float8 AS rotation, s.retention::float8 AS retention,
                s.absence::float8 AS absence, s.headcount_avg::float8 AS headcount_avg,
                rg.name AS region_name, c.full_name AS coordinator_name
           FROM reg.v_snap s
           LEFT JOIN reg.regions rg ON rg.id = s.region_id
           LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
          WHERE s.site_key = $1 AND s.week_end = $2::date`,
        [key, week],
      ),
      db.query(
        `SELECT to_char(week_end,'YYYY-MM-DD') AS w, status, raw_status,
                rotation::float8 AS rotation, retention::float8 AS retention, absence::float8 AS absence,
                headcount_end
           FROM reg.v_snap
          WHERE site_key = $1 AND week_end BETWEEN $2::date - 77 AND $2::date
          ORDER BY week_end`,
        [key, week],
      ),
      db.query(
        `SELECT so.region_id, rg.name AS region_name, so.coordinator_id, c.full_name AS coordinator_name,
                to_char(so.valid_from,'YYYY-MM-DD') AS valid_from
           FROM reg.site_owner so
           LEFT JOIN reg.regions rg ON rg.id = so.region_id
           LEFT JOIN public.coordinators c ON c.id = so.coordinator_id
          WHERE so.site_key = $1 AND so.valid_to IS NULL`,
        [key],
      ),
      db.query(
        `SELECT rc.*, to_char(rc.opened_week,'YYYY-MM-DD') AS opened_week,
                to_char(rc.due_at,'YYYY-MM-DD HH24:MI') AS due_at_txt,
                to_char(rc.action_due,'YYYY-MM-DD') AS action_due,
                to_char(rc.filled_at,'YYYY-MM-DD HH24:MI') AS filled_at_txt,
                (rc.status = 'open' AND rc.due_at < now()) AS overdue,
                c.full_name AS owner_name,
                COALESCE((SELECT json_agg(json_build_object(
                           'at', to_char(n.at,'YYYY-MM-DD HH24:MI'), 'by', cc.full_name, 'text', n.text) ORDER BY n.at)
                          FROM reg.card_notes n LEFT JOIN public.coordinators cc ON cc.id = n.by_coordinator_id
                         WHERE n.card_id = rc.id), '[]') AS notes
           FROM reg.red_cards rc
           LEFT JOIN public.coordinators c ON c.id = rc.owner_coordinator_id
          WHERE rc.site_key = $1
          ORDER BY (rc.status <> 'closed') DESC, rc.opened_at DESC
          LIMIT 1`,
        [key],
      ),
    ]);

    const s = snap.rows[0];
    const win = s ? s.window_days : 28;
    const k1 = await db.query(`SELECT reg.setting('ret_days_1')::int AS k1, reg.setting('ret_days_2')::int AS k2`);
    const { k1: d1, k2: d2 } = k1.rows[0];

    const [approaching, departures, absences] = await Promise.all([
      // активні на кінець тижня, у кого поріг 30/80 днів у найближчі 14 днів
      db.query(
        `SELECT w.full_name, w.login, f.name AS facility, to_char(p.bhp_date,'YYYY-MM-DD') AS bhp,
                t.k AS threshold, to_char(p.bhp_date + t.k,'YYYY-MM-DD') AS date,
                (p.bhp_date + t.k) - $2::date AS days_left
           FROM reg.v_periods p
           JOIN public.workers w ON w.id = p.worker_id
           JOIN public.facilities f ON f.id = p.facility_id
           CROSS JOIN LATERAL (VALUES ($3::int), ($4::int)) t(k)
          WHERE p.site_key = $1 AND p.status <> 'przeniesiony'
            AND (p.last_work_date IS NULL OR p.last_work_date > $2::date)
            AND p.bhp_date + t.k > $2::date AND p.bhp_date + t.k <= $2::date + 14
          ORDER BY t.k DESC, p.bhp_date + t.k`,
        [key, week, d1, d2],
      ),
      // звільнення у вікні знімка, зі стажем на виході
      db.query(
        `SELECT w.full_name, w.login, f.name AS facility, p.status,
                to_char(p.bhp_date,'YYYY-MM-DD') AS bhp, to_char(p.last_work_date,'YYYY-MM-DD') AS last_day,
                p.last_work_date - p.bhp_date AS tenure
           FROM reg.v_periods p
           JOIN public.workers w ON w.id = p.worker_id
           JOIN public.facilities f ON f.id = p.facility_id
          WHERE p.site_key = $1 AND p.status <> 'przeniesiony'
            AND p.last_work_date > $2::date - $3::int AND p.last_work_date <= $2::date
          ORDER BY p.last_work_date - p.bhp_date, p.last_work_date DESC`,
        [key, week, win],
      ),
      // неявки без причини (NN) у вікні
      db.query(
        `SELECT w.full_name, w.login, COUNT(*)::int AS nn,
                string_agg(to_char(hl.work_date,'DD.MM'), ', ' ORDER BY hl.work_date) AS days
           FROM public.hours_log hl
           JOIN reg.v_periods p ON p.worker_id = hl.worker_id
                               AND hl.work_date >= p.bhp_date
                               AND (p.last_work_date IS NULL OR hl.work_date <= p.last_work_date)
           JOIN public.workers w ON w.id = hl.worker_id
          WHERE p.site_key = $1 AND hl.absence_type::text = 'NN'
            AND hl.work_date > $2::date - $3::int AND hl.work_date <= $2::date
          GROUP BY w.full_name, w.login
          ORDER BY nn DESC, w.full_name
          LIMIT 50`,
        [key, week, win],
      ),
    ]);

    res.json({
      ok: true,
      week,
      site_key: key,
      snapshot: s || null,
      history: hist.rows,
      owner: owner.rows[0] || null,
      card: card.rows[0] || null,
      thresholds: { d1, d2 },
      approaching: approaching.rows,
      departures: departures.rows,
      absences: absences.rows,
    });
  } catch (e) {
    console.error("[regional/site]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Координатори регіону ──────────────────────────────────────────────
router.get("/coordinators", async (req, res) => {
  try {
    const week = isDate(req.query.week) ? req.query.week : await latestWeek();
    if (!week) return res.json({ ok: true, data: [] });
    const params = [week];
    const where = regionClause(req.scope, req.query.region, "s.region_id", params);
    const r = await db.query(
      `SELECT s.coordinator_id, COALESCE(c.full_name, '— bez koordynatora —') AS coordinator_name,
              COUNT(*)::int AS sites,
              COUNT(*) FILTER (WHERE s.status = 'R')::int AS red,
              COUNT(*) FILTER (WHERE s.status = 'A')::int AS amber,
              COUNT(*) FILTER (WHERE s.status = 'G')::int AS green,
              SUM(s.headcount_end)::int AS headcount,
              SUM(s.headcount_end) FILTER (WHERE s.status = 'R')::int AS headcount_red,
              (SUM(s.departures * 28.0 / s.window_days) / NULLIF(SUM(s.headcount_avg), 0))::float8 AS rotation,
              (SUM(s.ret_achieved)::numeric / NULLIF(SUM(s.ret_possible), 0))::float8 AS retention,
              (SUM(s.abs_nn)::numeric / NULLIF(SUM(s.abs_base), 0))::float8 AS absence,
              json_agg(json_build_object('site', s.site_key, 'status', s.status) ORDER BY s.site_key) AS site_list
         FROM reg.v_snap s
         LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
        WHERE s.week_end = $1::date AND ${where}
        GROUP BY s.coordinator_id, c.full_name
        ORDER BY (SUM(s.headcount_end) FILTER (WHERE s.status = 'R'))::numeric
                 / NULLIF(SUM(s.headcount_end), 0) DESC NULLS LAST, coordinator_name`,
      params,
    );
    res.json({ ok: true, week, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Червоні картки ────────────────────────────────────────────────────
router.get("/cards", async (req, res) => {
  try {
    const params = [];
    const where = regionClause(req.scope, req.query.region, "rc.region_id", params);
    const st = req.query.status || "active";
    const stWhere = {
      active: `rc.status <> 'closed'`,
      overdue: `rc.status = 'open' AND rc.due_at < now()`,
      closed: `rc.status = 'closed'`,
      all: `true`,
    }[st] || `rc.status <> 'closed'`;
    const r = await db.query(
      `SELECT rc.id, rc.site_key, rc.status, rg.name AS region_name,
              to_char(rc.opened_week,'YYYY-MM-DD') AS opened_week,
              to_char(rc.due_at,'YYYY-MM-DD HH24:MI') AS due_at,
              to_char(rc.filled_at,'YYYY-MM-DD HH24:MI') AS filled_at,
              to_char(rc.closed_week,'YYYY-MM-DD') AS closed_week, rc.close_reason,
              (rc.status = 'open' AND rc.due_at < now()) AS overdue,
              (rc.filled_at IS NOT NULL AND rc.filled_at > rc.due_at) AS filled_late,
              rs.label AS reason, rc.reason_note, rc.action_plan,
              to_char(rc.action_due,'YYYY-MM-DD') AS action_due,
              c.full_name AS owner_name,
              (SELECT s.red_weeks FROM reg.v_snap s
                WHERE s.site_key = rc.site_key ORDER BY s.week_end DESC LIMIT 1) AS red_weeks
         FROM reg.red_cards rc
         LEFT JOIN reg.regions rg ON rg.id = rc.region_id
         LEFT JOIN reg.reasons rs ON rs.code = rc.reason_code
         LEFT JOIN public.coordinators c ON c.id = rc.owner_coordinator_id
        WHERE ${stWhere} AND ${where}
        ORDER BY (rc.status = 'open' AND rc.due_at < now()) DESC, rc.status, rc.due_at
        LIMIT 500`,
      params,
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function cardInScope(scope, id) {
  const r = await db.query(`SELECT * FROM reg.red_cards WHERE id = $1`, [id]);
  const card = r.rows[0];
  if (!card) return { error: 404 };
  if (!scope.isAdmin && !scope.regionIds.includes(card.region_id)) return { error: 403 };
  return { card };
}

router.patch("/cards/:id", async (req, res) => {
  try {
    const { card, error } = await cardInScope(req.scope, req.params.id);
    if (error) return res.status(error).json({ ok: false, error: error === 404 ? "Not found" : "Forbidden" });
    if (card.status === "closed") return res.status(400).json({ ok: false, error: "Karta zamknięta" });

    const { reason_code, reason_note, action_plan, action_due, owner_coordinator_id } = req.body || {};
    const missing = [];
    if (!reason_code) missing.push("przyczyna");
    if (!action_plan || !String(action_plan).trim()) missing.push("plan działań");
    if (!isDate(action_due)) missing.push("termin");
    if (!owner_coordinator_id) missing.push("odpowiedzialny");
    if (missing.length) return res.status(400).json({ ok: false, error: "Uzupełnij: " + missing.join(", ") });

    const r = await db.query(
      `UPDATE reg.red_cards SET
          reason_code = $2, reason_note = NULLIF($3, ''), action_plan = $4, action_due = $5::date,
          owner_coordinator_id = $6, status = 'filled',
          filled_at = COALESCE(filled_at, now()), filled_by = COALESCE(filled_by, $7)
        WHERE id = $1 RETURNING id, status, to_char(filled_at,'YYYY-MM-DD HH24:MI') AS filled_at`,
      [card.id, reason_code, reason_note || "", String(action_plan).trim(), action_due,
        parseInt(owner_coordinator_id, 10), req.coordinator.coordinator_id],
    );
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/cards/:id/notes", async (req, res) => {
  try {
    const { card, error } = await cardInScope(req.scope, req.params.id);
    if (error) return res.status(error).json({ ok: false, error: error === 404 ? "Not found" : "Forbidden" });
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "Pusta notatka" });
    await db.query(`INSERT INTO reg.card_notes (card_id, by_coordinator_id, text) VALUES ($1, $2, $3)`, [
      card.id, req.coordinator.coordinator_id, text.slice(0, 2000),
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  Налаштування (тільки адмін)
// ══════════════════════════════════════════════════════════════════════
router.get("/admin/config", requireAdminOnly, async (req, res) => {
  try {
    const [regions, sites, settings, flags] = await Promise.all([
      db.query(
        `SELECT r.id, r.name, r.is_active,
                COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.full_name) ORDER BY c.full_name)
                            FROM reg.region_leads rl
                            JOIN public.coordinators c ON c.id = rl.coordinator_id
                           WHERE rl.region_id = r.id), '[]') AS leads
           FROM reg.regions r
          ORDER BY r.is_active DESC, r.name`,
      ),
      db.query(
        `WITH keys AS (
           SELECT DISTINCT reg.site_key(group_name, name) AS site_key FROM public.facilities
            WHERE is_active AND name <> 'test'
           UNION SELECT site_key FROM reg.site_owner WHERE valid_to IS NULL),
         hc AS (
           SELECT site_key, COUNT(DISTINCT worker_id)::int AS n FROM reg.v_periods
            WHERE last_work_date IS NULL OR last_work_date > CURRENT_DATE GROUP BY site_key)
         SELECT k.site_key, COALESCE(hc.n, 0) AS headcount,
                so.region_id, so.coordinator_id, to_char(so.valid_from,'YYYY-MM-DD') AS valid_from,
                (SELECT string_agg(f.name, ', ' ORDER BY f.name) FROM public.facilities f
                  WHERE reg.site_key(f.group_name, f.name) = k.site_key) AS facilities
           FROM keys k
           LEFT JOIN hc ON hc.site_key = k.site_key
           LEFT JOIN reg.site_owner so ON so.site_key = k.site_key AND so.valid_to IS NULL
          ORDER BY (so.region_id IS NULL) DESC, k.site_key`,
      ),
      db.query(`SELECT key, value::float8 AS value, note FROM reg.settings ORDER BY key`),
      db.query(
        `SELECT id, site_key, flag, to_char(date_from,'YYYY-MM-DD') AS date_from,
                to_char(date_to,'YYYY-MM-DD') AS date_to, note
           FROM reg.site_flags ORDER BY (date_to IS NULL) DESC, date_from DESC`,
      ),
    ]);
    res.json({ ok: true, regions: regions.rows, sites: sites.rows, settings: settings.rows, flags: flags.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/admin/regions", requireAdminOnly, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Nazwa wymagana" });
    const r = await db.query(`INSERT INTO reg.regions (name) VALUES ($1) RETURNING id`, [name]);
    const lead = parseInt((req.body && req.body.coordinator_id) || 0, 10);
    if (lead)
      await db.query(
        `INSERT INTO reg.region_leads (region_id, coordinator_id, created_by) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [r.rows[0].id, lead, req.coordinator.coordinator_id],
      );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch("/admin/regions/:id", requireAdminOnly, async (req, res) => {
  try {
    const { name, is_active } = req.body || {};
    await db.query(
      `UPDATE reg.regions SET
          name = COALESCE(NULLIF($2, ''), name),
          is_active = COALESCE($3, is_active)
        WHERE id = $1`,
      [req.params.id, name ? String(name).trim() : "", typeof is_active === "boolean" ? is_active : null],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Регіональні координатори регіону: їх може бути кілька
router.post("/admin/regions/:id/leads", requireAdminOnly, async (req, res) => {
  try {
    const coordId = parseInt((req.body && req.body.coordinator_id) || 0, 10);
    if (!coordId) return res.status(400).json({ ok: false, error: "Wybierz koordynatora" });
    await db.query(
      `INSERT INTO reg.region_leads (region_id, coordinator_id, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, coordId, req.coordinator.coordinator_id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete("/admin/regions/:id/leads/:coordinatorId", requireAdminOnly, async (req, res) => {
  try {
    await db.query(`DELETE FROM reg.region_leads WHERE region_id = $1 AND coordinator_id = $2`, [
      req.params.id, req.params.coordinatorId,
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Зміна прив'язки об'єкта: поточний запис закривається, новий діє з valid_from
router.put("/admin/sites", requireAdminOnly, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { site_key, region_id, coordinator_id } = req.body || {};
    const validFrom = isDate(req.body && req.body.valid_from) ? req.body.valid_from : localISO(new Date());
    if (!site_key) return res.status(400).json({ ok: false, error: "site_key required" });
    await client.query("BEGIN");
    // нова прив'язка діє з validFrom: пізніші записи прибираємо,
    // запис, що перекриває validFrom, закриваємо днем раніше — без накладок
    await client.query(
      `DELETE FROM reg.site_owner WHERE site_key = $1 AND valid_from >= $2::date`,
      [site_key, validFrom],
    );
    await client.query(
      `UPDATE reg.site_owner SET valid_to = $2::date - 1
        WHERE site_key = $1 AND valid_from < $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
      [site_key, validFrom],
    );
    await client.query(
      `INSERT INTO reg.site_owner (site_key, region_id, coordinator_id, valid_from, created_by)
       VALUES ($1, $2, $3, $4::date, $5)`,
      [site_key, region_id || null, coordinator_id || null, validFrom, req.coordinator.coordinator_id],
    );
    // активна картка переходить до нового регіону
    await client.query(`UPDATE reg.red_cards SET region_id = $2 WHERE site_key = $1 AND status <> 'closed'`, [
      site_key, region_id || null,
    ]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

router.patch("/admin/settings", requireAdminOnly, async (req, res) => {
  try {
    const body = req.body || {};
    const keys = Object.keys(body);
    for (const k of keys) {
      const v = Number(body[k]);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ ok: false, error: `Błędna wartość: ${k}` });
    }
    for (const k of keys) {
      await db.query(
        `UPDATE reg.settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`,
        [k, Number(body[k]), req.coordinator.coordinator_id],
      );
    }
    res.json({ ok: true, updated: keys.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/admin/flags", requireAdminOnly, async (req, res) => {
  try {
    const { site_key, date_from, date_to, note } = req.body || {};
    if (!site_key || !isDate(date_from)) return res.status(400).json({ ok: false, error: "Obiekt i data od są wymagane" });
    await db.query(
      `INSERT INTO reg.site_flags (site_key, flag, date_from, date_to, note, created_by)
       VALUES ($1, 'structural', $2::date, $3::date, NULLIF($4, ''), $5)`,
      [site_key, date_from, isDate(date_to) ? date_to : null, note || "", req.coordinator.coordinator_id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch("/admin/flags/:id", requireAdminOnly, async (req, res) => {
  try {
    const d = isDate(req.body && req.body.date_to) ? req.body.date_to : localISO(new Date());
    await db.query(`UPDATE reg.site_flags SET date_to = GREATEST($2::date, date_from) WHERE id = $1`, [req.params.id, d]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Перерахунок тижня (неділя). weeks > 1 — догрузити історію назад.
router.post("/admin/snapshot", requireAdminOnly, async (req, res) => {
  try {
    const week = isDate(req.body && req.body.week) ? req.body.week : lastSunday();
    if (new Date(week + "T12:00:00").getDay() !== 0)
      return res.status(400).json({ ok: false, error: "Tydzień musi kończyć się w niedzielę" });
    const n = Math.min(Math.max(parseInt((req.body && req.body.weeks) || 1, 10), 1), 26);
    const done = [];
    // картки — тільки для останнього тижня пакета (і лише якщо він не старший за вже збережені)
    const lastBefore = await latestWeek();
    const cardsForLast = !lastBefore || week >= lastBefore;
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(week + "T12:00:00");
      d.setDate(d.getDate() - 7 * i);
      const w = localISO(d);
      const r = await takeSnapshot(w, req.coordinator.coordinator_id, i === 0 && cardsForLast);
      done.push({ week: w, sites: r.rows, cards: r.manageCards });
    }
    res.json({ ok: true, data: done });
  } catch (e) {
    console.error("[regional/snapshot]", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  Telegram: нові червоні, нагадування, ескалація
// ══════════════════════════════════════════════════════════════════════
async function safeSend(bot, chatId, text) {
  if (!bot || !chatId) return false;
  try {
    await bot.telegram.sendMessage(chatId, text);
    return true;
  } catch (e) {
    console.error("[regional] telegram", chatId, e.message);
    return false;
  }
}

async function adminChats() {
  const r = await db.query(
    `SELECT DISTINCT c.telegram_chat_id FROM public.coordinator_auth ca
       JOIN public.coordinators c ON c.id = ca.coordinator_id
      WHERE ca.is_admin AND c.telegram_chat_id IS NOT NULL AND c.is_active`,
  );
  return r.rows.map((x) => x.telegram_chat_id);
}

// Після понеділкового знімка: регіональному — список нових червоних
async function notifyNewRed(bot, week) {
  const r = await db.query(
    `SELECT rg.id, c.telegram_chat_id,
            string_agg(rc.site_key || ' — до ' || to_char(rc.due_at, 'DD.MM HH24:MI'), E'\n' ORDER BY rc.site_key) AS list
       FROM reg.red_cards rc
       JOIN reg.regions rg ON rg.id = rc.region_id
       JOIN reg.region_leads rl ON rl.region_id = rg.id
       JOIN public.coordinators c ON c.id = rl.coordinator_id AND c.is_active
      WHERE rc.opened_week = $1::date AND rc.status = 'open'
      GROUP BY rg.id, c.telegram_chat_id`,
    [week],
  );
  for (const row of r.rows) {
    await safeSend(bot, row.telegram_chat_id,
      `🔴 Нові червоні об'єкти (тиждень до ${week}):\n${row.list}\n\nЗаповніть картку в панелі: Region → Karty.`);
  }
  const esc = await db.query(
    `SELECT s.site_key, s.red_weeks, rg.name AS region FROM reg.v_snap s
       LEFT JOIN reg.regions rg ON rg.id = s.region_id
      WHERE s.week_end = $1::date AND s.status = 'R' AND s.red_weeks = reg.setting('escalate_red_weeks')::int`,
    [week],
  );
  if (esc.rows.length) {
    const text = "⚠️ Об'єкти червоні вже " + esc.rows[0].red_weeks + " тижнів поспіль:\n" +
      esc.rows.map((x) => `${x.site_key} (${x.region || "без регіону"})`).join("\n");
    for (const chat of await adminChats()) await safeSend(bot, chat, text);
  }
}

// Щодня: нагадати про картку, що спливає за добу; ескалувати прострочені
async function sendCardReminders(bot) {
  const soon = await db.query(
    `SELECT rc.id, rc.site_key, to_char(rc.due_at,'DD.MM HH24:MI') AS due,
            array_agg(c.telegram_chat_id) FILTER (WHERE c.telegram_chat_id IS NOT NULL) AS chats
       FROM reg.red_cards rc
       JOIN reg.regions rg ON rg.id = rc.region_id
       JOIN reg.region_leads rl ON rl.region_id = rg.id
       JOIN public.coordinators c ON c.id = rl.coordinator_id AND c.is_active
      WHERE rc.status = 'open' AND rc.reminded_at IS NULL
        AND rc.due_at > now() AND rc.due_at <= now() + INTERVAL '1 day'
      GROUP BY rc.id, rc.site_key, rc.due_at`,
  );
  for (const x of soon.rows) {
    let ok = false;
    for (const chat of x.chats || [])
      ok = (await safeSend(bot, chat, `⏰ ${x.site_key}: картку червоного об'єкта треба заповнити до ${x.due}.`)) || ok;
    if (ok) await db.query(`UPDATE reg.red_cards SET reminded_at = now() WHERE id = $1`, [x.id]);
  }
  const late = await db.query(
    `SELECT rc.id, rc.site_key, rg.name AS region,
            string_agg(c.full_name, ', ' ORDER BY c.full_name) AS regional,
            array_agg(c.telegram_chat_id) FILTER (WHERE c.telegram_chat_id IS NOT NULL) AS chats
       FROM reg.red_cards rc
       LEFT JOIN reg.regions rg ON rg.id = rc.region_id
       LEFT JOIN reg.region_leads rl ON rl.region_id = rg.id
       LEFT JOIN public.coordinators c ON c.id = rl.coordinator_id AND c.is_active
      WHERE rc.status = 'open' AND rc.escalated_at IS NULL AND rc.due_at < now()
      GROUP BY rc.id, rc.site_key, rg.name`,
  );
  if (!late.rows.length) return;
  const admins = await adminChats();
  const text = "❗ Прострочені картки червоних об'єктів:\n" +
    late.rows.map((x) => `${x.site_key} — ${x.region || "без регіону"}${x.regional ? " (" + x.regional + ")" : ""}`).join("\n");
  for (const chat of admins) await safeSend(bot, chat, text);
  for (const x of late.rows) {
    for (const chat of x.chats || [])
      await safeSend(bot, chat, `❗ ${x.site_key}: термін заповнення картки минув. Керівника повідомлено.`);
    await db.query(`UPDATE reg.red_cards SET escalated_at = now() WHERE id = $1`, [x.id]);
  }
}

// Планувальник: пн 06:00 — знімок минулого тижня; пн–пт 09:00 — нагадування
function schedule(bot) {
  const done = new Set();
  setInterval(async () => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const key = `${localISO(now)}_${hm}`;
    if (done.has(key)) return;
    try {
      if (now.getDay() === 1 && hm === "06:00") {
        done.add(key);
        const week = lastSunday(now);
        const r = await takeSnapshot(week, null);
        console.log(`[regional] snapshot ${week}: ${r.rows} sites`);
        await notifyNewRed(bot, week);
      }
      if (now.getDay() >= 1 && now.getDay() <= 5 && hm === "09:00") {
        done.add(key);
        await sendCardReminders(bot);
      }
    } catch (e) {
      console.error("[regional] schedule", e.message);
    }
    if (done.size > 50) done.clear();
  }, 30 * 1000);
}

module.exports = { router, schedule, takeSnapshot, sendCardReminders, notifyNewRed };
