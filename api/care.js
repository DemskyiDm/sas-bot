// ══════════════════════════════════════════════════════════════════════
//  Розділ «Rozmowy» — API панелі
//  Монтується в index.js:  app.use("/api/care", care.router)
//
//  Доступ:
//    координатор  — свої завдання, свої об'єкти, свій рядок у «Kontrola»
//    регіональний — усе по своїх регіонах + питання про координатора (у сумі)
//    адмін        — усе + налаштування
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const careBot = require("../bot/care");

router.use(requireAuth);

const PROBLEM_LABEL = {
  housing: "Mieszkanie", money: "Pieniądze", schedule: "Grafik / godziny",
  team: "Zespół", transport: "Dojazd", other: "Inne",
};

async function scopeOf(c) {
  const r = await db.query(
    `SELECT rl.region_id, rg.name FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
      WHERE rl.coordinator_id = $1 AND rg.is_active ORDER BY rg.name`,
    [c.coordinator_id],
  );
  const isAdmin = !!c.is_admin;
  let regions = r.rows.map((x) => ({ id: x.region_id, name: x.name }));
  if (isAdmin) {
    const all = await db.query(`SELECT id, name FROM reg.regions WHERE is_active ORDER BY name`);
    regions = all.rows;
  }
  const on = await db.query(`SELECT care.is_on($1) AS on`, [c.coordinator_id]);
  return {
    me: c.coordinator_id,
    enabled: on.rows[0].on,
    isAdmin,
    isRegional: r.rows.length > 0,
    isManager: isAdmin || r.rows.length > 0,
    regionIds: r.rows.map((x) => x.region_id),
    regions,
  };
}

router.use(async (req, res, next) => {
  try {
    req.scope = await scopeOf(req.coordinator);
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[care api]", e);
  res.status(code).json({ ok: false, error: e.message || String(e) });
};

// Умова «що бачить користувач» для таблиці з колонками coordinator_id / region_id.
// Додаткові фільтри: coordinator=<id>, region=<id>
function scopeWhere(scope, q, alias, params) {
  const conds = [];
  if (!scope.isAdmin) {
    params.push(scope.me);
    const me = `$${params.length}`;
    if (scope.isRegional) {
      params.push(scope.regionIds);
      conds.push(`(${alias}.coordinator_id = ${me} OR ${alias}.region_id = ANY($${params.length}::int[]))`);
    } else {
      conds.push(`${alias}.coordinator_id = ${me}`);
    }
  }
  const coord = parseInt(q.coordinator, 10);
  if (coord) { params.push(coord); conds.push(`${alias}.coordinator_id = $${params.length}`); }
  if (q.coordinator === "none" && scope.isAdmin) conds.push(`${alias}.coordinator_id IS NULL`);
  const region = parseInt(q.region, 10);
  if (region) { params.push(region); conds.push(`${alias}.region_id = $${params.length}`); }
  return conds.length ? conds.join(" AND ") : "true";
}

// Для даних, прив'язаних до об'єкта, — поточний власник з reg.site_owner (як у Region)
function siteScope(scope, q, siteCol, params) {
  const p2 = [];
  const inner = scopeWhere(scope, q, "o", p2).replace(/\$(\d+)/g, (_, n) => `$${Number(n) + params.length}`);
  params.push(...p2);
  let site = "";
  if (q.site) { params.push(q.site); site = ` AND ${siteCol} = $${params.length}`; }
  if (inner === "true" && !site) return "true";
  return `EXISTS (SELECT 1 FROM reg.site_owner o WHERE o.site_key = ${siteCol} AND o.valid_to IS NULL AND ${inner})${site}`;
}

async function canTouchTask(scope, taskId) {
  const r = await db.query(`SELECT coordinator_id, region_id FROM care.tasks WHERE id = $1`, [taskId]);
  const t = r.rows[0];
  if (!t) return false;
  if (scope.isAdmin || t.coordinator_id === scope.me) return true;
  return scope.isRegional && scope.regionIds.includes(t.region_id);
}

async function settingsMap() {
  const r = await db.query(`SELECT key, value FROM care.settings`);
  const s = {};
  for (const x of r.rows) s[x.key] = Number(x.value);
  return s;
}

// ── Хто я ─────────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const sc = req.scope;
    const p = [];
    const where = scopeWhere(sc, {}, "o", p);
    const coords = await db.query(
      `SELECT DISTINCT c.id, c.full_name AS name, care.is_on(c.id) AS enabled FROM public.coordinators c
        WHERE c.is_active AND (c.id = ${sc.isAdmin ? "c.id" : Number(sc.me)}
           OR EXISTS (SELECT 1 FROM reg.site_owner o WHERE o.coordinator_id = c.id AND o.valid_to IS NULL AND ${where}))
        ORDER BY c.full_name`,
      p,
    );
    const s = await settingsMap();
    res.json({
      ok: true,
      me: { id: sc.me, name: req.coordinator.full_name },
      is_admin: sc.isAdmin, is_regional: sc.isRegional, is_manager: sc.isManager,
      enabled: sc.enabled, has_access: sc.isManager || sc.enabled,
      regions: sc.regions, coordinators: coords.rows,
      settings: { tasks_per_day: s.tasks_per_day, escalate_bdays: s.escalate_bdays, coord_min_answers: s.coord_min_answers, risk_min: s.risk_min },
      problems: PROBLEM_LABEL,
    });
  } catch (e) { fail(res, e); }
});

// Звичайний координатор без увімкненого модуля далі не проходить
router.use((req, res, next) => {
  if (req.scope.isManager || req.scope.enabled) return next();
  res.status(403).json({ ok: false, error: "Moduł Rozmowy nie jest dla Ciebie włączony" });
});

// ── Завдання ──────────────────────────────────────────────────────────
router.get("/tasks", async (req, res) => {
  try {
    const q = req.query;
    const params = [];
    const where = [scopeWhere(req.scope, q, "t", params)];
    const status = q.status || "open";
    if (status === "open") where.push(`t.status = 'open'`);
    else if (status === "done") where.push(`t.status = 'done'`);
    else if (status === "late") where.push(`t.status = 'open' AND t.escalated_at IS NOT NULL`);
    else if (status === "missed") where.push(`t.status = 'missed'`);
    const days = Math.min(parseInt(q.days, 10) || 14, 180);
    if (status !== "open" && status !== "late") where.push(`t.created_at > now() - make_interval(days => ${days})`);
    const r = await db.query(
      `SELECT t.id, t.worker_id, w.full_name, w.login, t.site_key, t.kind, t.priority, t.score, t.reasons,
              t.status, t.outcome, t.problem_code, t.comment, t.created_at, t.done_at, t.escalated_at, t.sent_at,
              t.done_via, t.coordinator_id, c.full_name AS coord_name, d.full_name AS done_by_name,
              (care.today() - a.bhp_date)::int AS tenure,
              care.bdays(care.ldate(t.created_at), care.today()) AS age_bdays,
              (w.telegram_chat_id IS NOT NULL) AS has_tg,
              (SELECT json_agg(json_build_object('q', q.text->>'pl', 'a',
                        (SELECT o->'t'->>'pl' FROM jsonb_array_elements(q.options) o WHERE o->>'c' = an.option_code),
                        'f', an.flag, 'at', an.answered_at) ORDER BY an.answered_at DESC, q.sort)
                 FROM care.answers an JOIN care.survey_sends s ON s.id = an.send_id
                 JOIN care.questions q ON q.id = an.question_id
                WHERE s.worker_id = t.worker_id AND an.flag IS NOT NULL AND q.visibility = 'coordinator'
                  AND an.answered_at > t.created_at - INTERVAL '21 days') AS answers
         FROM care.tasks t
         JOIN public.workers w ON w.id = t.worker_id
         LEFT JOIN care.v_active a ON a.worker_id = t.worker_id
         LEFT JOIN public.coordinators c ON c.id = t.coordinator_id
         LEFT JOIN public.coordinators d ON d.id = t.done_by
        WHERE ${where.join(" AND ")}
        ORDER BY (t.status = 'open') DESC, t.priority, t.score DESC NULLS LAST, t.created_at DESC
        LIMIT 400`,
      params,
    );
    // оцінки новачків, що чекають
    const p2 = [];
    const w2 = scopeWhere(req.scope, q, "x", p2);
    const as = await db.query(
      `SELECT x.id, x.worker_id, w.full_name, w.login, x.site_key, x.day_mark, x.requested_at, x.sent_at,
              c.full_name AS coord_name, x.coordinator_id
         FROM (SELECT a.*, o.region_id FROM care.assessments a
                 LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL) x
         JOIN public.workers w ON w.id = x.worker_id
         LEFT JOIN public.coordinators c ON c.id = x.coordinator_id
        WHERE x.value IS NULL AND x.requested_at > now() - INTERVAL '14 days' AND ${w2}
        ORDER BY x.requested_at, w.full_name`,
      p2,
    );
    res.json({ ok: true, data: r.rows, assessments: as.rows });
  } catch (e) { fail(res, e); }
});

router.post("/tasks/:id/close", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canTouchTask(req.scope, id))) return fail(res, new Error("Brak dostępu"), 403);
    const { outcome, problem_code, comment } = req.body || {};
    if (!["stays", "problem", "leaving", "no_answer"].includes(outcome)) return fail(res, new Error("Zły wynik"), 400);
    if (outcome === "problem" && problem_code && !PROBLEM_LABEL[problem_code]) return fail(res, new Error("Zły problem"), 400);
    const t = await careBot.closeTask(id, outcome, problem_code || null, req.scope.me, "panel",
      comment ? String(comment).slice(0, 500) : null);
    if (!t) return fail(res, new Error("Zadanie już zamknięte"), 409);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

router.post("/tasks/:id/reopen", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canTouchTask(req.scope, id))) return fail(res, new Error("Brak dostępu"), 403);
    const ok = await careBot.reopenTask(id);
    if (!ok) return fail(res, new Error("Zmienić można tylko w ciągu doby"), 409);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

router.post("/tasks/:id/comment", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canTouchTask(req.scope, id))) return fail(res, new Error("Brak dostępu"), 403);
    await db.query(`UPDATE care.tasks SET comment = $2 WHERE id = $1`, [id, String(req.body?.comment || "").slice(0, 500) || null]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Доручення: регіональний/адмін — будь-кому в своєму регіоні; координатор — собі
router.post("/tasks", async (req, res) => {
  try {
    const workerId = parseInt(req.body?.worker_id, 10);
    const comment = String(req.body?.comment || "").trim().slice(0, 500);
    if (!workerId) return fail(res, new Error("Wybierz pracownika"), 400);
    const a = (await db.query(
      `SELECT a.worker_id, a.facility_id, a.site_key, o.coordinator_id, o.region_id
         FROM care.v_active a LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
        WHERE a.worker_id = $1`, [workerId])).rows[0];
    if (!a) return fail(res, new Error("Pracownik teraz nie pracuje"), 400);
    const sc = req.scope;
    let coordId = parseInt(req.body?.coordinator_id, 10) || a.coordinator_id;
    if (!sc.isAdmin) {
      const inRegion = sc.isRegional && sc.regionIds.includes(a.region_id);
      if (!inRegion && a.coordinator_id !== sc.me) return fail(res, new Error("To nie twój obiekt"), 403);
      if (!inRegion) coordId = sc.me;
    }
    if (!coordId) return fail(res, new Error("Obiekt nie ma koordynatora — przypisz w Region → Ustawienia"), 400);
    if (!(await db.query(`SELECT care.is_on($1) AS on`, [coordId])).rows[0].on)
      return fail(res, new Error("Moduł Rozmowy jest wyłączony dla tego koordynatora (Ustawienia → Koordynatorzy)"), 400);
    if (coordId !== a.coordinator_id) {
      // inny koordynator niż właściciel obiektu: aktywny i (dla regionalnego) z tego samego regionu
      const ok = await db.query(
        `SELECT 1 FROM public.coordinators c WHERE c.id = $1 AND c.is_active
            AND ($2::boolean OR c.id = $3 OR EXISTS (SELECT 1 FROM reg.site_owner o WHERE o.coordinator_id = c.id
                  AND o.valid_to IS NULL AND o.region_id = ANY($4::int[])))`,
        [coordId, sc.isAdmin, sc.me, sc.regionIds],
      );
      if (!ok.rows.length) return fail(res, new Error("Nie można zlecić temu koordynatorowi"), 403);
    }
    const ins = await db.query(
      `INSERT INTO care.tasks (worker_id, facility_id, site_key, coordinator_id, region_id, kind, priority, score, reasons, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, 'manual', 1,
               (SELECT score FROM care.risk_daily WHERE worker_id = $1 ORDER BY day DESC LIMIT 1),
               array_prepend('manual', COALESCE((SELECT reasons FROM care.risk_daily WHERE worker_id = $1 ORDER BY day DESC LIMIT 1), '{}')),
               $6, $7)
       ON CONFLICT DO NOTHING RETURNING id`,
      [workerId, a.facility_id, a.site_key, coordId, a.region_id, comment || null, sc.me],
    );
    if (!ins.rows.length) return fail(res, new Error("Ten pracownik ma już otwarte zadanie"), 409);
    const h = new Date().getHours();
    if (h >= 8 && h < 21) careBot.sendTaskNow(ins.rows[0].id).catch(() => {});
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { fail(res, e); }
});

router.post("/assessments/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const v = parseInt(req.body?.value, 10);
    if (![1, 2, 3].includes(v)) return fail(res, new Error("Zła ocena"), 400);
    const a = (await db.query(
      `SELECT a.coordinator_id, o.region_id FROM care.assessments a
         LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL WHERE a.id = $1`, [id])).rows[0];
    if (!a) return fail(res, new Error("Nie znaleziono"), 404);
    const sc = req.scope;
    if (!(sc.isAdmin || a.coordinator_id === sc.me || (sc.isRegional && sc.regionIds.includes(a.region_id))))
      return fail(res, new Error("Brak dostępu"), 403);
    await careBot.rateAssessment(id, v, sc.me);
    careBot.refreshAssessmentMsg(id).catch(() => {});
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Пошук працівника для доручення
router.get("/workers", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, data: [] });
    const params = [`%${q}%`];
    const where = siteScope(req.scope, {}, "a.site_key", params);
    const r = await db.query(
      `SELECT a.worker_id, w.full_name, w.login, a.site_key, (care.today() - a.bhp_date)::int AS tenure,
              c.full_name AS coord_name
         FROM care.v_active a JOIN public.workers w ON w.id = a.worker_id
         LEFT JOIN reg.site_owner o2 ON o2.site_key = a.site_key AND o2.valid_to IS NULL
         LEFT JOIN public.coordinators c ON c.id = o2.coordinator_id
        WHERE (w.full_name ILIKE $1 OR w.login ILIKE $1) AND ${where}
        ORDER BY w.full_name LIMIT 20`,
      params,
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { fail(res, e); }
});

// ── Ризик ─────────────────────────────────────────────────────────────
router.get("/risk", async (req, res) => {
  try {
    const params = [];
    const where = scopeWhere(req.scope, req.query, "r", params);
    const min = Math.max(parseInt(req.query.min, 10) || 1, 0);
    params.push(min);
    const r = await db.query(
      `WITH d AS (SELECT MAX(day) AS day FROM care.risk_daily)
       SELECT r.worker_id, w.full_name, w.login, r.site_key, r.tenure, r.score, r.reasons, r.coordinator_id,
              c.full_name AS coord_name, (SELECT day FROM d) AS day,
              ot.id AS open_task, ot.created_at AS open_since,
              lt.outcome AS last_outcome, lt.problem_code AS last_problem, lt.done_at AS last_done
         FROM care.risk_daily r
         JOIN public.workers w ON w.id = r.worker_id
         LEFT JOIN public.coordinators c ON c.id = r.coordinator_id
         LEFT JOIN care.tasks ot ON ot.worker_id = r.worker_id AND ot.status = 'open'
         LEFT JOIN LATERAL (SELECT outcome, problem_code, done_at FROM care.tasks x
                             WHERE x.worker_id = r.worker_id AND x.status = 'done' ORDER BY done_at DESC LIMIT 1) lt ON true
        WHERE r.day = (SELECT day FROM d) AND ${where} AND r.score >= $${params.length}
        ORDER BY r.score DESC, r.tenure
        LIMIT 500`,
      params,
    );
    const s = await settingsMap();
    res.json({ ok: true, data: r.rows, risk_min: s.risk_min });
  } catch (e) { fail(res, e); }
});

// ── Анкети: зведення ──────────────────────────────────────────────────
// Питання «про координатора» (visibility = manager): бачать адмін і регіональні,
// але регіональний — не про самого себе. Координатор — ніколи.
const mgrOk = (sc, coordId) => sc.isAdmin || (sc.isManager && coordId !== sc.me);
const optLabel = (q, c) => { const o = (q.options || []).find((x) => x.c === c); return o ? (o.t.pl || o.t.uk) : c; };
const isScale = (q) => (q.options || []).filter((o) => /^[1-5]$/.test(o.c)).length === 5;
async function surveyCode(code) {
  const r = await db.query(`SELECT code FROM care.surveys ORDER BY sort`);
  const all = r.rows.map((x) => x.code);
  return all.includes(code) ? code : (all.includes("d3") ? "d3" : all[0]);
}
// Дані «Poleć znajomego» (хто привів, канал) — як у самому розділі: регіональні й керівник завжди,
// координатор — лише якщо там увімкнено «видно координаторам»
async function seesRef(sc) {
  if (sc.isManager) return true;
  try {
    const r = await db.query(`SELECT value FROM ref.settings WHERE key = 'visible_coords'`);
    return !!(r.rows[0] && r.rows[0].value === "1");
  } catch (e) { return false; }
}
// Канал «як дізналися» (Poleć znajomego, пілот анкети на старті)
const REF_STAY = { m1: "1 mies.", m2: "2 mies.", m3: "3 mies.", m6: "6 mies.", more: "dłużej" };
const REF_SRC = { friend: "znajomy", coord: "koordynator", recruit: "rekruter", facebook: "Facebook", instagram: "Instagram",
  tiktok: "TikTok", telegram: "Telegram", jobsite: "portal z ofertami", other: "inne" };

router.get("/surveys", async (req, res) => {
  try {
    const sc = req.scope;
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const s = await settingsMap();
    const minN = s.coord_min_answers || 5;
    const code = await surveyCode(String(req.query.survey || ""));

    // відсоток відповідей — по всіх анкетах (вкладки)
    const p1 = [days];
    const w1 = siteScope(sc, req.query, "s.site_key", p1);
    const rates = await db.query(
      `SELECT sv.code, sv.name, sv.day_offset, sv.sort, sv.is_active,
              COUNT(s.id) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sent,
              COUNT(s.id) FILTER (WHERE s.status = 'done')::int AS done,
              COUNT(s.id) FILTER (WHERE s.status = 'no_telegram')::int AS no_tg,
              COUNT(s.id) FILTER (WHERE s.status = 'failed')::int AS failed,
              COUNT(s.id) FILTER (WHERE s.flag = 'high')::int AS high,
              COUNT(s.id) FILTER (WHERE s.flag = 'low')::int AS low
         FROM care.surveys sv
         LEFT JOIN care.survey_sends s ON s.survey_code = sv.code
              AND s.planned_for > care.today() - $1::int AND ${w1}
        GROUP BY sv.code ORDER BY sv.sort`,
      p1,
    );

    // питання вибраної анкети
    const qs = (await db.query(
      `SELECT id, sort, code, text->>'pl' AS text, visibility, options FROM care.questions WHERE survey_code = $1 ORDER BY sort`, [code])).rows;

    // розподіл відповідей: питання для координатора — за період
    const p2 = [days, code];
    const w2 = siteScope(sc, req.query, "s.site_key", p2);
    const ans = await db.query(
      `SELECT q.id, a.option_code, COUNT(*)::int AS n
         FROM care.answers a
         JOIN care.survey_sends s ON s.id = a.send_id AND s.survey_code = $2
         JOIN care.questions q ON q.id = a.question_id AND q.visibility = 'coordinator'
        WHERE a.answered_at > now() - make_interval(days => $1::int) AND ${w2}
        GROUP BY q.id, a.option_code`,
      p2,
    );
    const counts = new Map();          // question id → {option → n}
    const add = (id, c, n) => { const m = counts.get(id) || counts.set(id, {}).get(id); m[c] = (m[c] || 0) + n; };
    ans.rows.forEach((x) => add(x.id, x.option_code, x.n));
    // про координатора — тільки регіональним/адміну, за 90 днів, по кожному координатору від coord_min_answers
    if (sc.isManager) {
      const pm = [code];
      const wm = [scopeWhere(sc, req.query, "o", pm)];
      if (!sc.isAdmin) { pm.push(sc.me); wm.push(`o.coordinator_id <> $${pm.length} AND s.coordinator_id IS DISTINCT FROM $${pm.length}`); }
      if (req.query.site) { pm.push(String(req.query.site)); wm.push(`s.site_key = $${pm.length}`); }
      const man = await db.query(
        `SELECT q.id, a.option_code, o.coordinator_id AS coord, COUNT(*)::int AS n
           FROM care.answers a
           JOIN care.survey_sends s ON s.id = a.send_id AND s.survey_code = $1
           JOIN care.questions q ON q.id = a.question_id AND q.visibility = 'manager'
           JOIN reg.site_owner o ON o.site_key = s.site_key AND o.valid_to IS NULL
          WHERE a.answered_at > now() - INTERVAL '90 days' AND ${wm.join(" AND ")}
          GROUP BY q.id, a.option_code, o.coordinator_id`,
        pm,
      );
      const tot = new Map();
      for (const x of man.rows) tot.set(`${x.id}_${x.coord}`, (tot.get(`${x.id}_${x.coord}`) || 0) + x.n);
      for (const x of man.rows) if (tot.get(`${x.id}_${x.coord}`) >= minN) add(x.id, x.option_code, x.n);
    }
    const questions = qs
      .filter((q) => q.visibility === "coordinator" || sc.isManager)
      .map((q) => {
        const m = counts.get(q.id) || {};
        const n = Object.values(m).reduce((a, b) => a + b, 0);
        const out = { id: q.id, survey: code, sort: q.sort, code: q.code, text: q.text, visibility: q.visibility, n,
          options: q.options.map((o) => ({ c: o.c, t: o.t.pl || o.t.uk, f: o.f || null, n: m[o.c] || 0 })) };
        return q.visibility === "manager" && n < minN ? { ...out, hidden: true, n: null, options: [] } : out;
      });

    // по об'єктах — колонки = питання вибраної анкети
    const p3 = [days, code];
    const w3 = siteScope(sc, req.query, "s.site_key", p3);
    const sitesR = await db.query(
      `SELECT s.site_key, MAX(c.full_name) AS coord_name, MAX(o.coordinator_id) AS coord_id,
              COUNT(*) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sent,
              COUNT(*) FILTER (WHERE s.status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE s.flag = 'high')::int AS high
         FROM care.survey_sends s
         LEFT JOIN reg.site_owner o ON o.site_key = s.site_key AND o.valid_to IS NULL
         LEFT JOIN public.coordinators c ON c.id = o.coordinator_id
        WHERE s.survey_code = $2 AND s.planned_for > care.today() - $1::int AND s.status <> 'planned'
          AND s.site_key IS NOT NULL AND ${w3}
        GROUP BY s.site_key`,
      p3,
    );
    const p4 = [days, code];
    const w4 = siteScope(sc, req.query, "s.site_key", p4);
    let mgrCond = "q.visibility <> 'manager'";                    // координатору — без питань про координатора
    if (sc.isAdmin) mgrCond = "true";
    else if (sc.isManager) { p4.push(sc.me); mgrCond = `(q.visibility <> 'manager' OR s.coordinator_id IS DISTINCT FROM $${p4.length})`; }
    const sa = await db.query(
      `SELECT s.site_key, q.code, a.option_code, COUNT(*)::int AS n
         FROM care.answers a
         JOIN care.survey_sends s ON s.id = a.send_id AND s.survey_code = $2
         JOIN care.questions q ON q.id = a.question_id
        WHERE a.answered_at > now() - make_interval(days => $1::int) AND s.site_key IS NOT NULL AND ${w4} AND ${mgrCond}
        GROUP BY 1, 2, 3`,
      p4,
    );
    const qByCode = new Map(qs.map((q) => [q.code, q]));
    const siteMap = new Map(sitesR.rows.map((x) => [x.site_key, { ...x, q: {} }]));
    for (const x of sa.rows) {
      const site = siteMap.get(x.site_key);
      if (!site) continue;
      const cell = site.q[x.code] || (site.q[x.code] = { n: 0, opts: {} });
      cell.n += x.n; cell.opts[x.option_code] = (cell.opts[x.option_code] || 0) + x.n;
    }
    const sites = [...siteMap.values()].map((x) => {
      for (const [qc, cell] of Object.entries(x.q)) {
        const q = qByCode.get(qc);
        if (!q) { delete x.q[qc]; continue; }
        if (q.visibility === "manager" && (!mgrOk(sc, x.coord_id) || cell.n < minN)) { x.q[qc] = { hidden: true }; continue; }
        if (isScale(q)) {
          let sum = 0, k = 0;
          for (const [c, n] of Object.entries(cell.opts)) if (/^[1-5]$/.test(c)) { sum += Number(c) * n; k += n; }
          cell.avg = k ? Math.round((sum / k) * 10) / 10 : null;
        }
      }
      delete x.coord_id;
      return x;
    }).sort((a, b) => b.high - a.high || b.sent - a.sent || a.site_key.localeCompare(b.site_key));
    const cols = qs.filter((q) => q.visibility === "coordinator" || sc.isManager)
      .map((q) => ({ code: q.code, text: q.text, visibility: q.visibility, scale: isScale(q),
        options: q.options.map((o) => ({ c: o.c, t: o.t.pl || o.t.uk, f: o.f || null })) }));

    // тривожні відповіді вибраної анкети (тільки видимі координатору)
    const p5 = [days, code];
    const w5 = siteScope(sc, req.query, "s.site_key", p5);
    const recent = await db.query(
      `SELECT a.answered_at, s.worker_id, w.full_name, w.login, s.site_key, s.survey_code, q.text->>'pl' AS q,
              (SELECT o->'t'->>'pl' FROM jsonb_array_elements(q.options) o WHERE o->>'c' = a.option_code) AS a, a.flag,
              (SELECT t.status || COALESCE(':' || t.outcome, '') FROM care.tasks t
                WHERE t.worker_id = s.worker_id AND t.created_at >= a.answered_at - INTERVAL '1 hour'
                ORDER BY t.created_at LIMIT 1) AS task
         FROM care.answers a
         JOIN care.survey_sends s ON s.id = a.send_id AND s.survey_code = $2
         JOIN care.questions q ON q.id = a.question_id
         JOIN public.workers w ON w.id = s.worker_id
        WHERE a.flag IS NOT NULL AND q.visibility = 'coordinator'
          AND a.answered_at > now() - make_interval(days => $1::int) AND ${w5}
        ORDER BY (a.flag = 'high') DESC, a.answered_at DESC LIMIT 60`,
      p5,
    );

    // анкета на старті: канал «як дізналися» (Poleć znajomego)
    let channels = null;
    if (code === "start" && (await seesRef(sc))) {
      try {
        const p6 = [days];
        const w6 = siteScope(sc, req.query, "h.site_key", p6);
        const ch = await db.query(
          `SELECT a.source, COUNT(*)::int AS n
             FROM ref.answers a JOIN ref.v_hires h ON h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date
            WHERE a.ext AND a.status = 'answered' AND a.answered_at > now() - make_interval(days => $1::int) AND ${w6}
            GROUP BY 1 ORDER BY 2 DESC`, p6);
        channels = ch.rows.map((x) => ({ source: x.source, label: REF_SRC[x.source] || x.source, n: x.n }));
      } catch (e) { channels = null; }                 // розділу Poleć znajomego немає
    }
    res.json({ ok: true, survey: code, rates: rates.rows, questions, cols, sites, recent: recent.rows, channels,
      min_answers: minN, is_manager: sc.isManager });
  } catch (e) { fail(res, e); }
});

// ── Хто як відповів: анкета → працівники ──────────────────────────────
router.get("/surveys/answers", async (req, res) => {
  try {
    const sc = req.scope;
    const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
    const code = await surveyCode(String(req.query.survey || ""));
    const qs = (await db.query(
      `SELECT id, sort, code, text->>'pl' AS text, visibility, options FROM care.questions WHERE survey_code = $1 ORDER BY sort`, [code])).rows;
    const p = [days, code];
    const w = siteScope(sc, req.query, "s.site_key", p);
    const r = await db.query(
      `SELECT s.id, s.worker_id, w.full_name, w.login, s.site_key, s.status, s.flag, s.coordinator_id, c.full_name AS coord_name,
              to_char(s.bhp_date, 'YYYY-MM-DD') AS bhp, s.sent_at, s.completed_at,
              COALESCE(json_object_agg(q.code, json_build_object('o', a.option_code, 'f', a.flag, 'at', a.answered_at))
                       FILTER (WHERE q.code IS NOT NULL), '{}') AS ans
         FROM care.survey_sends s
         JOIN public.workers w ON w.id = s.worker_id
         LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
         LEFT JOIN care.answers a ON a.send_id = s.id
         LEFT JOIN care.questions q ON q.id = a.question_id
        WHERE s.survey_code = $2 AND s.planned_for > care.today() - $1::int AND s.status IN ('sent','done','expired') AND ${w}
        GROUP BY s.id, w.id, c.full_name
        ORDER BY COALESCE(s.completed_at, s.sent_at) DESC NULLS LAST, s.id DESC
        LIMIT 3000`,
      p,
    );
    const mgrQ = new Set(qs.filter((q) => q.visibility === "manager").map((q) => q.code));
    const rows = r.rows.map((x) => {
      const ans = {};
      let last = null;
      for (const [qc, v] of Object.entries(x.ans || {})) {
        if (mgrQ.has(qc) && !mgrOk(sc, x.coordinator_id)) continue;
        const q = qs.find((y) => y.code === qc);
        ans[qc] = { o: v.o, t: q ? optLabel(q, v.o) : v.o, f: v.f };
        if (!last || v.at > last) last = v.at;
      }
      return { id: x.id, worker_id: x.worker_id, full_name: x.full_name, login: x.login, site_key: x.site_key,
        coord_name: x.coord_name, status: x.status, flag: x.flag, bhp: x.bhp, sent_at: x.sent_at,
        answered_at: last, answered: Object.keys(x.ans || {}).length, ans };
    });
    // анкета на старті: + «як дізналися» / хто привів
    if (code === "start" && rows.length && (await seesRef(sc))) {
      try {
        const ra = await db.query(
          `SELECT worker_id, to_char(bhp_date, 'YYYY-MM-DD') AS bhp, source, referrer_text, status, stay_plan
             FROM ref.answers WHERE worker_id = ANY($1::int[])`, [rows.map((x) => x.worker_id)]);
        const m = new Map(ra.rows.map((x) => [`${x.worker_id}_${x.bhp}`, x]));
        rows.forEach((x) => {
          const a = m.get(`${x.worker_id}_${x.bhp}`);
          if (a && a.status === "answered") x.ref = { source: a.source, label: REF_SRC[a.source] || a.source, text: a.referrer_text,
            stay: a.stay_plan ? REF_STAY[a.stay_plan] : null };
        });
      } catch (e) { /* немає розділу Poleć znajomego */ }
    }
    const cols = qs.filter((q) => q.visibility === "coordinator" || sc.isManager)
      .map((q) => ({ code: q.code, text: q.text, visibility: q.visibility, scale: isScale(q),
        options: q.options.map((o) => ({ c: o.c, t: o.t.pl || o.t.uk, f: o.f || null })) }));
    res.json({ ok: true, survey: code, cols, rows, is_manager: sc.isManager, is_admin: sc.isAdmin });
  } catch (e) { fail(res, e); }
});

// ── Усі анкети одного працівника ─────────────────────────────────────
router.get("/surveys/worker", async (req, res) => {
  try {
    const sc = req.scope;
    const wid = parseInt(req.query.worker_id, 10);
    if (!wid) return fail(res, new Error("worker_id"), 400);
    const p = [wid];
    const w = siteScope(sc, {}, "s.site_key", p);
    const sends = await db.query(
      `SELECT s.id, s.survey_code, sv.name, sv.sort, s.site_key, s.status, s.flag, s.coordinator_id, c.full_name AS coord_name,
              to_char(s.bhp_date, 'YYYY-MM-DD') AS bhp, s.planned_for, s.sent_at, s.reminded_at, s.completed_at
         FROM care.survey_sends s
         JOIN care.surveys sv ON sv.code = s.survey_code
         LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
        WHERE s.worker_id = $1 AND s.status <> 'planned' AND ${w}
        ORDER BY COALESCE(s.sent_at, s.planned_for::timestamptz) DESC, s.id DESC`,
      p,
    );
    const wk = (await db.query(`SELECT id, full_name, login FROM public.workers WHERE id = $1`, [wid])).rows[0];
    if (!wk) return fail(res, new Error("Nie ma takiego pracownika"), 404);
    let refs = [];
    if (await seesRef(sc)) try {
      const p2 = [wid];
      const w2 = siteScope(sc, {}, "h.site_key", p2);
      refs = (await db.query(
        `SELECT to_char(a.bhp_date, 'YYYY-MM-DD') AS bhp, a.source, a.referrer_text, a.status, a.answered_at, a.ext, h.site_key, a.stay_plan
           FROM ref.answers a JOIN ref.v_hires h ON h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date
          WHERE a.worker_id = $1 AND ${w2} ORDER BY a.bhp_date DESC`, p2)).rows
        .map((x) => ({ ...x, label: REF_SRC[x.source] || x.source, stay: x.stay_plan ? REF_STAY[x.stay_plan] : null }));
    } catch (e) { refs = []; }
    if (!sends.rows.length && !refs.length) return fail(res, new Error("Brak ankiet tego pracownika w Twoim zakresie"), 404);
    const ids = sends.rows.map((x) => x.id);
    const ans = ids.length ? (await db.query(
      `SELECT a.send_id, q.sort, q.code, q.text->>'pl' AS q, q.visibility, q.options, a.option_code, a.flag, a.answered_at
         FROM care.answers a JOIN care.questions q ON q.id = a.question_id
        WHERE a.send_id = ANY($1::int[]) ORDER BY a.send_id, q.sort`, [ids])).rows : [];
    const out = sends.rows.map((s) => ({
      ...s,
      answers: ans.filter((a) => a.send_id === s.id)
        .filter((a) => a.visibility !== "manager" || mgrOk(sc, s.coordinator_id))
        .map((a) => ({ q: a.q, code: a.code, a: optLabel(a, a.option_code), o: a.option_code, f: a.flag, at: a.answered_at, mgr: a.visibility === "manager" })),
      hidden: ans.some((a) => a.send_id === s.id && a.visibility === "manager" && !mgrOk(sc, s.coordinator_id)),
    }));
    res.json({ ok: true, worker: wk, sends: out, refs });
  } catch (e) { fail(res, e); }
});

// ── Kontrola: по координаторах ────────────────────────────────────────
router.get("/control", async (req, res) => {
  try {
    const sc = req.scope;
    const days = Math.min(parseInt(req.query.days, 10) || 28, 180);
    const s = await settingsMap();
    const minN = s.coord_min_answers || 5;
    const params = [days];
    const where = scopeWhere(sc, req.query, "t", params);
    const r = await db.query(
      `WITH t AS (SELECT * FROM care.tasks WHERE created_at > now() - make_interval(days => $1::int)),
       tk AS (
         SELECT t.coordinator_id,
                COUNT(*)::int AS created,
                COUNT(*) FILTER (WHERE t.status = 'open')::int AS open_now,
                COUNT(*) FILTER (WHERE t.status = 'done')::int AS done,
                COUNT(*) FILTER (WHERE t.status = 'done' AND (t.escalated_at IS NULL OR t.done_at < t.escalated_at))::int AS on_time,
                COUNT(*) FILTER (WHERE t.escalated_at IS NOT NULL)::int AS escalated,
                COUNT(*) FILTER (WHERE t.status = 'missed')::int AS missed,
                COUNT(*) FILTER (WHERE t.outcome = 'stays')::int AS o_stays,
                COUNT(*) FILTER (WHERE t.outcome = 'problem')::int AS o_problem,
                COUNT(*) FILTER (WHERE t.outcome = 'leaving')::int AS o_leaving,
                COUNT(*) FILTER (WHERE t.outcome = 'no_answer')::int AS o_no_answer,
                COUNT(*) FILTER (WHERE t.kind = 'survey')::int AS from_survey,
                ROUND(AVG(EXTRACT(EPOCH FROM (t.done_at - COALESCE(t.sent_at, t.created_at))) / 3600)
                      FILTER (WHERE t.status = 'done'))::int AS avg_hours
           FROM t WHERE ${where}
          GROUP BY t.coordinator_id),
       spot AS (
         SELECT sc.coordinator_id,
                COUNT(*) FILTER (WHERE sc.status = 'answered')::int AS spot_answered,
                COUNT(*) FILTER (WHERE sc.answer = 'no')::int AS spot_no
           FROM care.spot_checks sc
          WHERE sc.asked_at > now() - make_interval(days => $1::int)
          GROUP BY sc.coordinator_id),
       asm AS (
         SELECT coordinator_id, COUNT(*)::int AS assess_req, COUNT(value)::int AS assess_done
           FROM care.assessments WHERE requested_at > now() - make_interval(days => $1::int)
             AND requested_at < now() - INTERVAL '2 days'
          GROUP BY coordinator_id),
       sv AS (
         SELECT o.coordinator_id,
                COUNT(*) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sv_sent,
                COUNT(*) FILTER (WHERE s.status = 'done')::int AS sv_done,
                COUNT(*) FILTER (WHERE s.status = 'no_telegram')::int AS sv_no_tg
           FROM care.survey_sends s
           JOIN reg.site_owner o ON o.site_key = s.site_key AND o.valid_to IS NULL
          WHERE s.planned_for > care.today() - $1::int
          GROUP BY o.coordinator_id),
       cq AS (
         SELECT o.coordinator_id,
                COUNT(*) FILTER (WHERE q.code = 'coord5')::int AS c5_n,
                ROUND(AVG(a.option_code::numeric) FILTER (WHERE q.code = 'coord5'), 1) AS c5_avg,
                COUNT(*) FILTER (WHERE q.code IN ('coord3','coordx'))::int AS cy_n,
                COUNT(*) FILTER (WHERE q.code IN ('coord3','coordx') AND a.option_code = 'yes')::int AS cy_yes
           FROM care.answers a
           JOIN care.survey_sends s ON s.id = a.send_id
           JOIN care.questions q ON q.id = a.question_id AND q.visibility = 'manager'
           JOIN reg.site_owner o ON o.site_key = s.site_key AND o.valid_to IS NULL
          WHERE a.answered_at > now() - make_interval(days => GREATEST($1::int, 90))
          GROUP BY o.coordinator_id),
       -- Ефект: ті, хто мав ризик до 80-го дня. Дожили до 80 днів — з розмовою і без.
       fl AS (
         SELECT DISTINCT ON (r.worker_id, r.bhp_date) r.worker_id, r.bhp_date, r.coordinator_id, r.day
           FROM care.risk_daily r
          WHERE r.score >= care.setting('risk_min') AND r.tenure < 80 AND r.bhp_date + 80 <= care.today()
          ORDER BY r.worker_id, r.bhp_date, r.day),
       ef AS (
         SELECT fl.coordinator_id,
                EXISTS (SELECT 1 FROM care.tasks x WHERE x.worker_id = fl.worker_id AND x.status = 'done'
                          AND x.outcome IN ('stays','problem','leaving') AND care.ldate(x.done_at) < fl.bhp_date + 80) AS talked,
                EXISTS (SELECT 1 FROM public.worker_facility_history h WHERE h.worker_id = fl.worker_id
                          AND h.bhp_date <= fl.bhp_date + 80 AND COALESCE(h.last_work_date, DATE '9999-12-31') >= fl.bhp_date + 80
                          AND h.status::text <> 'unknown') AS survived
           FROM fl),
       eff AS (
         SELECT coordinator_id,
                COUNT(*) FILTER (WHERE talked)::int AS ef_t_n, COUNT(*) FILTER (WHERE talked AND survived)::int AS ef_t_ok,
                COUNT(*) FILTER (WHERE NOT talked)::int AS ef_n_n, COUNT(*) FILTER (WHERE NOT talked AND survived)::int AS ef_n_ok
           FROM ef GROUP BY coordinator_id)
       SELECT tk.*, c.full_name AS coord_name,
              COALESCE(spot.spot_answered, 0) AS spot_answered, COALESCE(spot.spot_no, 0) AS spot_no,
              COALESCE(asm.assess_req, 0) AS assess_req, COALESCE(asm.assess_done, 0) AS assess_done,
              COALESCE(sv.sv_sent, 0) AS sv_sent, COALESCE(sv.sv_done, 0) AS sv_done, COALESCE(sv.sv_no_tg, 0) AS sv_no_tg,
              cq.c5_n, cq.c5_avg, cq.cy_n, cq.cy_yes,
              COALESCE(eff.ef_t_n, 0) AS ef_t_n, COALESCE(eff.ef_t_ok, 0) AS ef_t_ok,
              COALESCE(eff.ef_n_n, 0) AS ef_n_n, COALESCE(eff.ef_n_ok, 0) AS ef_n_ok
         FROM tk
         LEFT JOIN public.coordinators c ON c.id = tk.coordinator_id
         LEFT JOIN spot ON spot.coordinator_id = tk.coordinator_id
         LEFT JOIN asm  ON asm.coordinator_id  = tk.coordinator_id
         LEFT JOIN sv   ON sv.coordinator_id   = tk.coordinator_id
         LEFT JOIN cq   ON cq.coordinator_id   = tk.coordinator_id
         LEFT JOIN eff  ON eff.coordinator_id  = tk.coordinator_id
        ORDER BY (tk.done::numeric / NULLIF(tk.created, 0)) NULLS FIRST, c.full_name`,
      params,
    );
    const rows = r.rows.map((x) => {
      // відповіді працівників про координатора і «чи була розмова» — не показуємо самому координатору
      const own = !sc.isAdmin && x.coordinator_id === sc.me;
      if (!sc.isManager || own) {
        x.c5_n = null; x.c5_avg = null; x.cy_n = null; x.cy_yes = null;
        x.spot_answered = null; x.spot_no = null;
      } else {
        if ((x.c5_n || 0) < minN) { x.c5_avg = null; }
        if ((x.cy_n || 0) < minN) { x.cy_yes = null; }
      }
      return x;
    });
    res.json({ ok: true, data: rows, days, min_answers: minN, is_manager: sc.isManager });
  } catch (e) { fail(res, e); }
});

// ── Для панелі об'єкта в Region ──────────────────────────────────────
router.get("/site", async (req, res) => {
  try {
    const site = String(req.query.site || "");
    if (!site) return fail(res, new Error("site"), 400);
    const p0 = [site];
    const allowed = siteScope(req.scope, {}, "$1::text", p0);
    if (allowed !== "true") {
      const chk = await db.query(`SELECT 1 WHERE ${allowed}`, p0);
      if (!chk.rows.length) return fail(res, new Error("Brak dostępu"), 403);
    }

    const t = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open_now,
              COUNT(*) FILTER (WHERE status = 'open' AND escalated_at IS NOT NULL)::int AS late,
              COUNT(*) FILTER (WHERE status = 'done' AND done_at > now() - INTERVAL '28 days')::int AS done28,
              COUNT(*) FILTER (WHERE outcome = 'stays' AND done_at > now() - INTERVAL '28 days')::int AS stays,
              COUNT(*) FILTER (WHERE outcome = 'problem' AND done_at > now() - INTERVAL '28 days')::int AS problem,
              COUNT(*) FILTER (WHERE outcome = 'leaving' AND done_at > now() - INTERVAL '28 days')::int AS leaving,
              COUNT(*) FILTER (WHERE outcome = 'no_answer' AND done_at > now() - INTERVAL '28 days')::int AS no_answer,
              COUNT(*) FILTER (WHERE status = 'missed' AND created_at > now() - INTERVAL '28 days')::int AS missed
         FROM care.tasks WHERE site_key = $1`,
      [site],
    );
    const probs = await db.query(
      `SELECT problem_code AS code, COUNT(*)::int AS n FROM care.tasks
        WHERE site_key = $1 AND outcome = 'problem' AND done_at > now() - INTERVAL '90 days'
        GROUP BY 1 ORDER BY 2 DESC`,
      [site],
    );
    const sv = await db.query(
      `SELECT COUNT(DISTINCT s.id) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sent,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'done')::int AS done,
              COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'no_telegram')::int AS no_tg,
              ROUND(AVG(a.option_code::numeric) FILTER (WHERE q.code = 'work5' AND a.option_code ~ '^[1-5]$'), 1) AS work5,
              ROUND(AVG(a.option_code::numeric) FILTER (WHERE q.code = 'housing5' AND a.option_code ~ '^[1-5]$'), 1) AS housing5,
              COUNT(*) FILTER (WHERE q.code = 'stay')::int AS stay_n,
              COUNT(*) FILTER (WHERE q.code = 'stay' AND a.option_code <> 'yes')::int AS stay_doubt
         FROM care.survey_sends s
         LEFT JOIN care.answers a ON a.send_id = s.id
         LEFT JOIN care.questions q ON q.id = a.question_id
        WHERE s.site_key = $1 AND s.planned_for > care.today() - 90`,
      [site],
    );
    const top = await db.query(
      `SELECT q.code AS q, a.option_code AS c,
              (SELECT o->'t'->>'pl' FROM jsonb_array_elements(q.options) o WHERE o->>'c' = a.option_code) AS label,
              COUNT(*)::int AS n
         FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id JOIN care.questions q ON q.id = a.question_id
        WHERE s.site_key = $1 AND a.answered_at > now() - INTERVAL '90 days'
          AND ((q.code = 'problem' AND a.option_code <> 'nothing') OR q.code = 'reason')
        GROUP BY q.code, a.option_code, q.options ORDER BY q.code, COUNT(*) DESC`,
      [site],
    );
    res.json({
      ok: true, tasks: t.rows[0], problems: probs.rows, surveys: sv.rows[0],
      top_problems: top.rows.filter((x) => x.q === "problem").slice(0, 4),
      exit_reasons: top.rows.filter((x) => x.q === "reason").slice(0, 4),
    });
  } catch (e) { fail(res, e); }
});

// ── Кому увімкнено модуль (адмін) ─────────────────────────────────────
router.get("/coordinators", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const r = await db.query(
      `WITH act AS (SELECT site_key, COUNT(*)::int AS n FROM care.v_active GROUP BY site_key)
       SELECT c.id, c.full_name, (c.telegram_chat_id IS NOT NULL) AS has_tg, COALESCE(c.lang::text, 'uk') AS lang,
              care.is_on(c.id) AS enabled, cc.enabled_at,
              (SELECT string_agg(DISTINCT rg.name, ', ') FROM reg.site_owner o JOIN reg.regions rg ON rg.id = o.region_id
                WHERE o.coordinator_id = c.id AND o.valid_to IS NULL) AS regions,
              (SELECT COUNT(*)::int FROM reg.site_owner o WHERE o.coordinator_id = c.id AND o.valid_to IS NULL) AS sites,
              (SELECT COALESCE(SUM(act.n), 0)::int FROM reg.site_owner o JOIN act ON act.site_key = o.site_key
                WHERE o.coordinator_id = c.id AND o.valid_to IS NULL) AS workers,
              (SELECT COUNT(*)::int FROM care.tasks t WHERE t.coordinator_id = c.id AND t.status = 'open') AS open_tasks,
              EXISTS (SELECT 1 FROM reg.region_leads rl WHERE rl.coordinator_id = c.id) AS is_lead
         FROM public.coordinators c
         LEFT JOIN care.coordinators cc ON cc.coordinator_id = c.id
        WHERE c.is_active
        ORDER BY care.is_on(c.id) DESC, (SELECT COUNT(*) FROM reg.site_owner o WHERE o.coordinator_id = c.id AND o.valid_to IS NULL) = 0,
                 c.full_name`,
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { fail(res, e); }
});

router.put("/coordinators", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const map = req.body?.enabled || {};
    const langs = req.body?.lang || {};
    for (const l of Object.values(langs))
      if (!["uk", "ru", "pl"].includes(l)) return fail(res, new Error(`Zły język: ${l}`), 400);
    const off = [];
    let changed = 0;
    for (const [idRaw, val] of Object.entries(map)) {
      const id = parseInt(idRaw, 10);
      if (!id) continue;
      const on = !!val;
      const r = await db.query(
        `INSERT INTO care.coordinators (coordinator_id, enabled, enabled_at, updated_by)
         VALUES ($1, $2, CASE WHEN $2 THEN now() END, $3)
         ON CONFLICT (coordinator_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by,
               enabled_at = CASE WHEN EXCLUDED.enabled AND NOT care.coordinators.enabled THEN now()
                                 WHEN EXCLUDED.enabled THEN care.coordinators.enabled_at END
           WHERE care.coordinators.enabled IS DISTINCT FROM EXCLUDED.enabled
         RETURNING coordinator_id`,
        [id, on, req.scope.me],
      );
      if (r.rows.length) { changed++; if (!on) off.push(id); }
    }
    // мова повідомлень координатору (Telegram): uk / ru / pl
    for (const [idRaw, l] of Object.entries(langs)) {
      const id = parseInt(idRaw, 10);
      if (!id) continue;
      await db.query(`UPDATE public.coordinators SET lang = $2 WHERE id = $1`, [id, l]);
      changed++;
    }
    const cancelled = await careBot.cancelForCoordinators(off);
    res.json({ ok: true, changed, cancelled });
  } catch (e) { fail(res, e); }
});

// ── Тестовий набір повідомлень (адмін) ────────────────────────────────
router.get("/test", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const c = await db.query(
      `SELECT c.id, c.full_name, (c.telegram_chat_id IS NOT NULL) AS has_tg, COALESCE(c.lang::text, 'uk') AS lang,
              care.is_on(c.id) AS enabled
         FROM public.coordinators c WHERE c.is_active ORDER BY (c.id = $1) DESC, c.full_name`,
      [req.scope.me],
    );
    res.json({ ok: true, me: req.scope.me, coordinators: c.rows, items: careBot.TEST_ITEMS, sent: await careBot.testSummary() });
  } catch (e) { fail(res, e); }
});

router.post("/test/send", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const ids = (req.body?.coordinators || []).map((x) => parseInt(x, 10)).filter(Boolean);
    const all = [...careBot.TEST_ITEMS.coordinator, ...careBot.TEST_ITEMS.worker];
    const items = (req.body?.items || []).filter((x) => all.includes(x));
    if (!ids.length) return fail(res, new Error("Wybierz koordynatora"), 400);
    if (!items.length) return fail(res, new Error("Wybierz, co wysłać"), 400);
    if (ids.length > 10) return fail(res, new Error("Maksymalnie 10 koordynatorów naraz"), 400);
    const result = await careBot.sendTestSet({
      coordinatorIds: ids, items,
      coordLang: String(req.body?.coord_lang || "profile"), workerLang: String(req.body?.worker_lang || "uk"),
      by: req.scope.me,
    });
    res.json({ ok: true, result });
  } catch (e) { fail(res, e); }
});

router.post("/test/clear", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const ids = (req.body?.coordinators || []).map((x) => parseInt(x, 10)).filter(Boolean);
    res.json({ ok: true, result: await careBot.clearTests(ids.length ? ids : null) });
  } catch (e) { fail(res, e); }
});

// ── Налаштування (адмін) ─────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const s = await db.query(`SELECT key, value, note FROM care.settings ORDER BY key`);
    const sv = await db.query(
      `SELECT sv.code, sv.name, sv.day_offset, sv.is_active,
              (SELECT COUNT(*) FROM care.questions q WHERE q.survey_code = sv.code)::int AS questions
         FROM care.surveys sv ORDER BY sv.sort`,
    );
    const jobs = await db.query(`SELECT job, to_char(MAX(ran_at), 'DD.MM HH24:MI') AS last FROM care.job_runs GROUP BY job ORDER BY job`);
    res.json({ ok: true, settings: s.rows, surveys: sv.rows, jobs: jobs.rows });
  } catch (e) { fail(res, e); }
});

router.put("/settings", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const values = req.body?.values || {};
    const RANGE = {
      tasks_enabled: [0, 1], surveys_enabled: [0, 1], task_saturday: [0, 1],
      task_hour: [6, 12], survey_hour: [9, 20], spot_check_share: [0, 1],
      tasks_per_day: [1, 20], escalate_bdays: [1, 10], expire_bdays: [1, 20], coord_min_answers: [3, 50],
    };
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      const [lo, hi] = RANGE[k] || [0, 1000];
      if (v === "" || v == null || !isFinite(n) || n < lo || n > hi)
        return fail(res, new Error(`Zła wartość: ${k} (dozwolone ${lo}–${hi})`), 400);
    }
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      await db.query(`UPDATE care.settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`, [k, n, req.scope.me]);
    }
    for (const [code, on] of Object.entries(req.body?.surveys || {})) {
      await db.query(`UPDATE care.surveys SET is_active = $2 WHERE code = $1`, [code, !!on]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Ручний запуск (адмін): перерахунок ризику / ранкова розсилка
router.post("/run/:job", async (req, res) => {
  try {
    if (!req.scope.isAdmin) return fail(res, new Error("Admin only"), 403);
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (req.params.job === "risk") {
      const r = await db.query(`SELECT care.take_risk($1::date) AS n`, [day]);
      const p = await db.query(`SELECT * FROM care.plan_day($1::date)`, [day]);
      return res.json({ ok: true, result: { risk: r.rows[0].n, ...p.rows[0] } });
    }
    if (req.params.job === "build") {
      const r = await db.query(`SELECT care.build_tasks($1::date) AS n`, [day]);
      return res.json({ ok: true, result: { tasks: r.rows[0].n } });
    }
    fail(res, new Error("unknown job"), 400);
  } catch (e) { fail(res, e); }
});

module.exports = { router };
