// ══════════════════════════════════════════════════════════════════════
//  «Pulpit kierownika» — зведена панель для керівника відділу
//  і операційного директора. Тільки читання.
//  Монтується в index.js:  app.use("/api/board", board.router)
//
//  Доступ: адмін панелі або роль head.
//  Фільтри в кожному запиті: region (all | none | id), client, coord,
//  period (7 | 28 | 91 днів), to (неділя — кінець періоду).
//  Регіон і координатор об'єкта — поточна прив'язка з reg.site_owner.
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");

router.use(requireAuth);

function hasAccess(c) {
  return !!(c && (c.is_admin || c.role === "head"));
}
router.use((req, res, next) => {
  if (req.path === "/me") return next();
  if (!hasAccess(req.coordinator)) return res.status(403).json({ ok: false, error: "Brak dostępu" });
  next();
});

// Не більше 3 одночасних запитів пульта: пул з'єднань спільний з ботом,
// працівник, що вносить години, не повинен чекати на звіти.
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

// Відповіді однакові для всіх, хто має доступ (бачать усе) — кешуємо на хвилину:
// повторне відкриття і швидке перемикання фільтрів не навантажують базу.
const CACHE = new Map();
const TTL_MS = 60 * 1000;
router.use((req, res, next) => {
  if (req.method !== "GET" || req.path === "/me") return next();
  const key = req.originalUrl;
  const hit = CACHE.get(key);
  if (hit && hit.t > Date.now() - TTL_MS) return res.json(hit.v);
  const send = res.json.bind(res);
  res.json = (v) => {
    if (v && v.ok) {
      CACHE.set(key, { t: Date.now(), v });
      if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
    }
    return send(v);
  };
  next();
});

const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[board api]", e);
  res.status(code).json({ ok: false, error: e.message || String(e) });
};
// Польська множина: 1 skarga, 2–4 skargi, 5+ skarg
function pl(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (n === 1) return one;
  if (b >= 2 && b <= 4 && !(a >= 12 && a <= 14)) return few;
  return many;
}
const isDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s && s >= "2020-01-01";
};

// Об'єкти в межах фільтра: завжди $1 регіон, $2 клієнт, $3 координатор
const SC = `sc AS (SELECT * FROM board.sites($1::int, $2::text, $3::int))`;

function filters(q) {
  let region = null;
  if (q.region === "none") region = -1;
  else if (q.region && q.region !== "all") region = parseInt(q.region, 10) || null;
  const client = q.client ? String(q.client).slice(0, 200) : null;
  const coord = parseInt(q.coord, 10) || null;
  const period = [7, 28, 91].includes(Number(q.period)) ? Number(q.period) : 28;
  return { region, client, coord, period, to: isDate(q.to) ? q.to : null };
}

// Кінець періоду: остання повна неділя (або обрана, не пізніше за сьогодні)
async function anchor(to) {
  const r = await query(
    `SELECT to_char(care.today() - EXTRACT(ISODOW FROM care.today())::int, 'YYYY-MM-DD') AS def,
            to_char(care.today(), 'YYYY-MM-DD') AS today`,
  );
  const { def, today } = r.rows[0];
  if (to && to <= today) return to;
  return def;
}
const base = (f) => [f.region, f.client, f.coord];

// ══════════════════════════════════════════════════════════════════════
//  Хто я + довідники фільтрів
// ══════════════════════════════════════════════════════════════════════
router.get("/me", async (req, res) => {
  try {
    const ok = hasAccess(req.coordinator);
    if (!ok) return res.json({ ok: true, has_access: false });
    const c = req.coordinator;
    const [regions, clients, weeks, mod, lead] = await Promise.all([
      query(`SELECT id, name FROM reg.regions WHERE is_active ORDER BY name`),
      query(`SELECT DISTINCT client_name AS name FROM public.facilities
                 WHERE client_name IS NOT NULL AND btrim(client_name) <> '' ORDER BY 1`),
      query(`SELECT to_char(d, 'YYYY-MM-DD') AS w
                  FROM generate_series(care.today() - EXTRACT(ISODOW FROM care.today())::int,
                                       care.today() - EXTRACT(ISODOW FROM care.today())::int - 7 * 25,
                                       INTERVAL '-7 days') d`),
      query(`SELECT COUNT(*) FILTER (WHERE enabled)::int AS on,
                       (SELECT value FROM care.settings WHERE key = 'risk_min')::int AS risk_min
                  FROM care.coordinators`),
      query(`SELECT EXISTS (SELECT 1 FROM reg.region_leads WHERE coordinator_id = $1) AS lead,
                    care.is_on($1) AS on`, [c.coordinator_id]),
    ]);
    // Посилання в розділи Region і Rozmowy — тільки якщо там є доступ
    const isLead = lead.rows[0].lead;
    res.json({
      ok: true, has_access: true,
      regions: regions.rows, clients: clients.rows.map((x) => x.name),
      weeks: weeks.rows.map((x) => x.w),
      module_on: mod.rows[0].on, risk_min: mod.rows[0].risk_min,
      links: { region: !!c.is_admin || isLead, rozmowy: !!c.is_admin || isLead || lead.rows[0].on },
    });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Показники за період (A − L, A]
// ══════════════════════════════════════════════════════════════════════
async function kpis(f, A, L) {
  const r = await query(
    `WITH ${SC},
     per AS (SELECT v.* FROM reg.v_periods v WHERE v.facility_id IN (SELECT facility_id FROM sc)),
     sp AS (SELECT * FROM board.v_spells),
     hc AS (
       SELECT COUNT(DISTINCT worker_id) FILTER (
                WHERE bhp_date <= $4::date AND (last_work_date IS NULL OR last_work_date > $4::date))::int AS hc_end,
              COUNT(DISTINCT worker_id) FILTER (
                WHERE bhp_date <= $4::date - $5::int
                  AND (last_work_date IS NULL OR last_work_date > $4::date - $5::int))::int AS hc_start
         FROM per),
     dep_l AS (
       SELECT sp.* FROM sp
        WHERE sp.end_facility IN (SELECT facility_id FROM sc) AND sp.end_status <> 'przeniesiony'
          AND sp.end_date > $4::date - $5::int AND sp.end_date <= $4::date),
     dep AS (
       SELECT COUNT(*)::int AS dep,
              COUNT(*) FILTER (WHERE end_date - start_date < 30)::int AS dep_early
         FROM dep_l),
     hires AS (
       SELECT COUNT(*)::int AS hires FROM sp
        WHERE sp.start_facility IN (SELECT facility_id FROM sc)
          AND sp.start_date > $4::date - $5::int AND sp.start_date <= $4::date),
     rez AS (
       SELECT COUNT(DISTINCT h.worker_id)::int AS rez
         FROM public.worker_facility_history h JOIN public.workers w ON w.id = h.worker_id
        WHERE h.facility_id IN (SELECT facility_id FROM sc) AND h.status::text = 'rezygnacja'
          AND h.bhp_date > $4::date - $5::int AND h.bhp_date <= $4::date
          AND COALESCE(w.login, '') NOT LIKE 'TEST_%'),
     s80 AS (
       SELECT COUNT(*)::int AS n80,
              COUNT(*) FILTER (WHERE sp.end_date IS NULL OR sp.end_date >= sp.start_date + 80)::int AS ok80
         FROM sp
        WHERE sp.start_facility IN (SELECT facility_id FROM sc)
          AND sp.start_date + 80 >  $4::date - GREATEST($5::int, 28)
          AND sp.start_date + 80 <= $4::date
          AND NOT COALESCE(sp.end_status = 'przeniesiony' AND sp.end_date < sp.start_date + 80, false)),
     ab AS (
       SELECT COUNT(*) FILTER (WHERE d.abs = 'NN')::int AS nn,
              COUNT(*) FILTER (WHERE d.worked OR d.abs IN ('NN','UN','L4','URL'))::int AS nn_base
         FROM (SELECT DISTINCT ON (hl.worker_id, hl.work_date)
                      (hl.hours IS NOT NULL AND hl.hours > 0) AS worked, hl.absence_type::text AS abs
                 FROM public.hours_log hl
                 JOIN per p ON p.worker_id = hl.worker_id AND hl.work_date >= p.bhp_date
                           AND (p.last_work_date IS NULL OR hl.work_date <= p.last_work_date)
                WHERE hl.work_date > $4::date - $5::int AND hl.work_date <= $4::date
                ORDER BY hl.worker_id, hl.work_date) d),
     rday AS (SELECT MAX(day) AS d FROM care.risk_daily WHERE day <= $4::date + 7 AND day > $4::date - 7),
     risk AS (
       SELECT COUNT(*) FILTER (WHERE r.score >= care.setting('risk_min'))::int AS risk_n,
              COUNT(*)::int AS risk_all,
              to_char(MAX(r.day), 'YYYY-MM-DD') AS risk_day
         FROM care.risk_daily r, rday
        WHERE r.day = rday.d AND r.facility_id IN (SELECT facility_id FROM sc)),
     prec AS (
       SELECT COUNT(*) FILTER (WHERE z.cov)::int AS dep_cov,
              COUNT(*) FILTER (WHERE z.cov AND z.flagged)::int AS dep_flagged
         FROM (SELECT
                 EXISTS (SELECT 1 FROM care.risk_daily r WHERE r.worker_id = d.worker_id
                           AND r.day BETWEEN d.end_date - 21 AND d.end_date - 3) AS cov,
                 EXISTS (SELECT 1 FROM care.risk_daily r WHERE r.worker_id = d.worker_id
                           AND r.day BETWEEN d.end_date - 21 AND d.end_date - 3
                           AND r.score >= care.setting('risk_min')) AS flagged
                 FROM dep_l d) z),
     leav AS (
       SELECT COUNT(*)::int AS leaving,
              COUNT(*) FILTER (WHERE x.left_d IS NOT NULL)::int AS leaving_left,
              COUNT(*) FILTER (WHERE x.left_d IS NULL AND x.d + 30 <= care.today())::int AS leaving_stayed
         FROM (SELECT t.worker_id, care.ldate(t.done_at) AS d,
                      (SELECT MIN(s.end_date) FROM board.v_spells s
                        WHERE s.worker_id = t.worker_id AND s.end_status <> 'przeniesiony'
                          AND s.end_date >= care.ldate(t.done_at) - 7
                          AND s.end_date <= LEAST(care.ldate(t.done_at) + 30, care.today())) AS left_d
                 FROM care.tasks t
                WHERE t.outcome = 'leaving' AND t.facility_id IN (SELECT facility_id FROM sc)
                  AND care.ldate(t.done_at) > $4::date - $5::int AND care.ldate(t.done_at) <= $4::date) x)
     SELECT * FROM hc, dep, hires, rez, s80, ab, risk, prec, leav`,
    [...base(f), A, L],
  );
  return r.rows[0];
}

async function tenureBuckets(f, A, L) {
  const r = await query(
    `WITH ${SC}
     SELECT b, COUNT(*)::int AS n FROM (
       SELECT CASE WHEN t <= 7 THEN 1 WHEN t <= 14 THEN 2 WHEN t <= 30 THEN 3 WHEN t <= 60 THEN 4
                   WHEN t <= 80 THEN 5 WHEN t <= 180 THEN 6 ELSE 7 END AS b
         FROM (SELECT sp.end_date - sp.start_date + 1 AS t FROM board.v_spells sp
                WHERE sp.end_facility IN (SELECT facility_id FROM sc) AND sp.end_status <> 'przeniesiony'
                  AND sp.end_date > $4::date - $5::int AND sp.end_date <= $4::date) x) y
     GROUP BY b ORDER BY b`,
    [...base(f), A, L],
  );
  const labels = ["do 7 dni", "8–14", "15–30", "31–60", "61–80", "81–180", "ponad 180"];
  const m = Object.fromEntries(r.rows.map((x) => [x.b, x.n]));
  return labels.map((l, i) => ({ label: l, n: m[i + 1] || 0 }));
}

// ── «Do decyzji»: що потребує рішення керівника зараз ─────────────────
const CAT_LABEL = {
  housing: "Zakwaterowanie", pay: "Wynagrodzenie", transport: "Dojazd", team: "Zespół / brygadzista",
  schedule: "Grafik / godziny",
};
async function decisions(f) {
  const p = base(f);
  const [red, sig, cat, early, spot, late, leav, noCoord, noTg, cfg] = await Promise.all([
    query(
      `WITH ${SC}
       SELECT s.site_key, s.red_weeks, s.headcount_end, c.full_name AS coord, rg.name AS region,
              rc.status AS card_status, rc.due_at < now() AS card_late, rc.filled_at,
              to_char(rc.due_at, 'YYYY-MM-DD') AS card_due,
              NULLIF(btrim(COALESCE(rc.action_plan, '')), '') IS NOT NULL AS has_plan,
              to_char(rc.action_due, 'YYYY-MM-DD') AS action_due, rc.action_due < care.today() AS plan_late
         FROM reg.v_snap s
         LEFT JOIN reg.red_cards rc ON rc.site_key = s.site_key AND rc.status <> 'closed'
         LEFT JOIN public.coordinators c ON c.id = s.coordinator_id
         LEFT JOIN reg.regions rg ON rg.id = s.region_id
        WHERE s.week_end = (SELECT MAX(week_end) FROM reg.rag_snapshots) AND s.status = 'R'
          AND s.site_key IN (SELECT site_key FROM sc)
        ORDER BY s.red_weeks DESC, s.headcount_end DESC`, p),
    query(
      `WITH ${SC}
       SELECT x.site_key,
              COUNT(DISTINCT x.worker_id) FILTER (WHERE x.k = 'leaving')::int AS leaving,
              COUNT(DISTINCT x.worker_id) FILTER (WHERE x.k = 'problem')::int AS problem,
              COUNT(DISTINCT x.worker_id) FILTER (WHERE x.k = 'survey')::int AS survey,
              COUNT(DISTINCT x.worker_id)::int AS n
         FROM (SELECT t.site_key, t.worker_id, t.outcome AS k FROM care.tasks t
                WHERE t.outcome IN ('leaving','problem') AND t.done_at > now() - INTERVAL '7 days'
               UNION ALL
               SELECT s.site_key, s.worker_id, 'survey' FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
                WHERE a.flag = 'high' AND a.answered_at > now() - INTERVAL '7 days') x
        WHERE x.site_key IN (SELECT site_key FROM sc)
        GROUP BY x.site_key HAVING COUNT(DISTINCT x.worker_id) >= 3 ORDER BY n DESC`, p),
    query(
      `WITH ${SC}
       SELECT x.site_key, x.cat, COUNT(DISTINCT x.worker_id)::int AS n,
              (SELECT COUNT(*) FROM care.v_active a WHERE a.site_key = x.site_key)::int AS hc
         FROM (SELECT t.site_key, t.worker_id, CASE t.problem_code WHEN 'money' THEN 'pay' ELSE t.problem_code END AS cat
                 FROM care.tasks t
                WHERE t.problem_code IS NOT NULL AND t.done_at > now() - INTERVAL '14 days'
               UNION ALL
               SELECT s.site_key, s.worker_id,
                      CASE WHEN q.code IN ('housing3','housing5') THEN 'housing'
                           WHEN q.code = 'transport3' THEN 'transport'
                           WHEN a.option_code = 'money' THEN 'pay'
                           ELSE a.option_code END
                 FROM care.answers a
                 JOIN care.survey_sends s ON s.id = a.send_id
                 JOIN care.questions q ON q.id = a.question_id
                WHERE a.answered_at > now() - INTERVAL '14 days'
                  AND ((q.code IN ('housing3','transport3') AND a.option_code IN ('no','partly'))
                    OR (q.code = 'housing5' AND a.option_code IN ('1','2','3'))
                    OR (q.code IN ('problem','reason') AND a.option_code IN ('housing','money','pay','transport','team','schedule')))) x
        WHERE x.site_key IN (SELECT site_key FROM sc) AND x.cat IN ('housing','pay','transport','team','schedule')
        GROUP BY x.site_key, x.cat HAVING COUNT(DISTINCT x.worker_id) >= 3 ORDER BY x.site_key, n DESC`, p),
    query(
      `WITH ${SC},
       sp AS MATERIALIZED (SELECT * FROM board.v_spells),
       hi AS (SELECT start_site, COUNT(*)::int AS n FROM sp WHERE start_date > care.today() - 56 GROUP BY 1)
       SELECT sp.end_site AS site_key, COUNT(*)::int AS n, COALESCE(MAX(hi.n), 0)::int AS hires
         FROM sp LEFT JOIN hi ON hi.start_site = sp.end_site
        WHERE sp.end_facility IN (SELECT facility_id FROM sc) AND sp.end_status <> 'przeniesiony'
          AND sp.end_date > care.today() - 28 AND sp.end_date <= care.today()
          AND sp.end_date - sp.start_date < 30
        GROUP BY sp.end_site HAVING COUNT(*) >= 3 ORDER BY n DESC`, p),
    query(
      `WITH ${SC}
       SELECT c.id, c.full_name AS coord, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE sp.answer = 'no')::int AS no
         FROM care.spot_checks sp JOIN public.coordinators c ON c.id = sp.coordinator_id
        WHERE sp.status = 'answered' AND sp.answered_at > now() - INTERVAL '30 days'
          AND sp.coordinator_id IN (SELECT coordinator_id FROM sc)
        GROUP BY c.id, c.full_name HAVING COUNT(*) FILTER (WHERE sp.answer = 'no') >= 2
        ORDER BY no DESC`, p),
    query(
      `WITH ${SC}
       SELECT c.id, c.full_name AS coord, COUNT(*)::int AS n
         FROM care.tasks t JOIN public.coordinators c ON c.id = t.coordinator_id
        WHERE t.status = 'open' AND t.escalated_at IS NOT NULL
          AND t.coordinator_id IN (SELECT coordinator_id FROM sc)
        GROUP BY c.id, c.full_name HAVING COUNT(*) >= 3 ORDER BY n DESC`, p),
    query(
      `WITH ${SC}
       SELECT COUNT(*)::int AS n, COUNT(DISTINCT t.site_key)::int AS sites
         FROM care.tasks t
        WHERE t.outcome = 'leaving' AND t.done_at > now() - INTERVAL '7 days'
          AND t.facility_id IN (SELECT facility_id FROM sc)`, p),
    query(
      `WITH ${SC},
       act AS (SELECT site_key, COUNT(*)::int AS n FROM care.v_active GROUP BY site_key)
       SELECT COUNT(*)::int AS sites, COALESCE(SUM(x.n), 0)::int AS people
         FROM (SELECT DISTINCT sc.site_key, act.n FROM sc JOIN act ON act.site_key = sc.site_key
                WHERE sc.coordinator_id IS NULL) x`, p),
    query(
      `WITH ${SC}
       SELECT string_agg(c.full_name, ', ' ORDER BY c.full_name) AS names, COUNT(*)::int AS n
         FROM care.coordinators cc JOIN public.coordinators c ON c.id = cc.coordinator_id
        WHERE cc.enabled AND c.is_active AND c.telegram_chat_id IS NULL
          AND c.id IN (SELECT coordinator_id FROM sc)`, p),
    query(`SELECT value::int AS v FROM reg.settings WHERE key = 'escalate_red_weeks'`),
  ]);
  const escWeeks = (cfg.rows[0] && cfg.rows[0].v) || 6;
  const out = [];
  const dd = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) : "");

  for (const s of red.rows) {
    const who = [s.region, s.coord].filter(Boolean).join(" · ");
    if (s.card_status === "open" && s.card_late && !s.filled_at) {
      out.push({ sev: 1, text: `${s.site_key}: czerwona karta niewypełniona`, sub: `termin minął ${dd(s.card_due)} · ${who}`, site: s.site_key });
    } else if (s.has_plan && s.plan_late) {
      out.push({ sev: s.red_weeks >= escWeeks ? 1 : 2, text: `${s.site_key}: termin planu minął ${dd(s.action_due)}, nadal czerwony (${s.red_weeks} tyg.)`, sub: who, site: s.site_key });
    } else if (s.red_weeks >= escWeeks) {
      out.push({ sev: s.has_plan ? 2 : 1, text: `${s.site_key}: czerwony ${s.red_weeks} tyg. z rzędu`,
        sub: `${s.headcount_end} ${pl(s.headcount_end, "osoba", "osoby", "osób")} · ${s.has_plan ? "plan do " + dd(s.action_due) : "karta bez planu"} · ${who}`, site: s.site_key });
    } else if (s.red_weeks >= 3 && !s.has_plan) {
      out.push({ sev: 2, text: `${s.site_key}: czerwony ${s.red_weeks} tyg., karta bez planu`, sub: who, site: s.site_key });
    }
  }
  for (const s of sig.rows) {
    const parts = [];
    if (s.leaving) parts.push(`${s.leaving}× chce odejść`);
    if (s.problem) parts.push(`${s.problem}× problem`);
    if (s.survey) parts.push(`${s.survey}× niepokojąca ankieta`);
    out.push({ sev: 2, text: `${s.site_key}: sygnały od ${s.n} ${pl(s.n, "osoby", "osób", "osób")} w 7 dni`, sub: parts.join(", ") + " — możliwy problem całego obiektu", site: s.site_key });
  }
  // skargi: jeden wpis na obiekt; próg rośnie z wielkością obiektu (min. 3, min. 5% pracujących)
  const bySite = {};
  for (const c of cat.rows) {
    if (c.n < Math.max(3, Math.ceil((c.hc || 0) * 0.05))) continue;
    (bySite[c.site_key] = bySite[c.site_key] || []).push(c);
  }
  for (const [site, l] of Object.entries(bySite)) {
    const tot = l.reduce((a, x) => a + x.n, 0);
    out.push({ sev: 2, text: `${site}: skargi w 14 dni`, sub: l.map((x) => `${(CAT_LABEL[x.cat] || x.cat).toLowerCase()} — ${x.n} ${pl(x.n, "osoba", "osoby", "osób")}`).join(", ") + " (rozmowy i ankiety)", site, n: tot });
  }
  for (const s of early.rows) {
    if (s.hires > 0 && s.n / s.hires < 0.15) continue;
    out.push({ sev: 2, text: `${s.site_key}: ${s.n} ${pl(s.n, "odejście", "odejścia", "odejść")} przed 30. dniem w 4 tyg.`,
      sub: `przyjęto ${s.hires} w 8 tyg. — sprawdź rekrutację i pierwsze dni`, site: s.site_key, detail: "early_now" });
  }
  for (const c of spot.rows) {
    if (c.no / c.n < 0.15) continue;
    out.push({ sev: 2, text: `${c.coord}: ${c.no}× pracownik mówi, że rozmowy nie było`, sub: `z ${c.n} sprawdzonych w 30 dni`, coord: c.id });
  }
  for (const c of late.rows) {
    out.push({ sev: 3, text: `${c.coord}: ${c.n} ${pl(c.n, "rozmowa", "rozmowy", "rozmów")} po terminie`, sub: "regionalny już dostał powiadomienie", coord: c.id });
  }
  if (leav.rows[0].n > 0) {
    const l = leav.rows[0];
    out.push({ sev: 3, text: `${l.n} ${pl(l.n, "osoba zgłosiła", "osoby zgłosiły", "osób zgłosiło")} „chce odejść” w 7 dni`, sub: `${l.sites} ${pl(l.sites, "obiekt", "obiekty", "obiektów")}`, detail: "leaving7" });
  }
  if (noCoord.rows[0].sites > 0) {
    const x = noCoord.rows[0];
    out.push({ sev: 3, text: `${x.sites} ${pl(x.sites, "obiekt", "obiekty", "obiektów")} bez koordynatora`, sub: `${x.people} ${pl(x.people, "osoba pracuje", "osoby pracują", "osób pracuje")} — przypisz w Region → Ustawienia`, detail: "nocoord" });
  }
  if (noTg.rows[0].n > 0) {
    out.push({ sev: 3, text: `${noTg.rows[0].n} ${pl(noTg.rows[0].n, "koordynator", "koordynatorów", "koordynatorów")} z modułem Rozmowy bez Telegrama`, sub: noTg.rows[0].names });
  }
  out.sort((a, b) => a.sev - b.sev);
  return out;
}

router.get("/summary", async (req, res) => {
  try {
    const f = filters(req.query);
    const A = await anchor(f.to);
    const prevA = await query(`SELECT to_char($1::date - $2::int, 'YYYY-MM-DD') AS d, to_char($1::date - $2::int + 1, 'YYYY-MM-DD') AS from`, [A, f.period]);
    const [cur, prev, tenure, dec] = await Promise.all([
      kpis(f, A, f.period),
      kpis(f, prevA.rows[0].d, f.period),
      tenureBuckets(f, A, f.period),
      decisions(f),
    ]);
    res.json({ ok: true, anchor: A, from: prevA.rows[0].from, period: f.period, cur, prev, tenure, decisions: dec });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Світлофор регіонів за тижнями (зі знімків Region)
// ══════════════════════════════════════════════════════════════════════
async function regSettings() {
  const r = await query(`SELECT key, value FROM reg.settings`);
  const s = {};
  for (const x of r.rows) s[x.key] = Number(x.value);
  return s;
}
// Регіон (або вся компанія) як один великий об'єкт: ті самі пороги, що в Region
function aggStatus(list, s) {
  const use = list.filter((x) => x.status !== "S");
  let hcW = 0, rotW = 0, pos = 0, ach = 0, nn = 0, bs = 0, hc = 0, dep = 0;
  const cnt = { R: 0, A: 0, G: 0, S: 0, N: 0 };
  for (const x of list) cnt[x.status] = (cnt[x.status] || 0) + 1;
  for (const x of use) {
    const h = Number(x.headcount_avg) || 0;
    hc += h; dep += x.departures || 0;
    if (x.rotation != null) { hcW += h; rotW += Number(x.rotation) * h; }
    pos += x.ret_possible || 0; ach += x.ret_achieved || 0;
    nn += x.abs_nn || 0; bs += x.abs_base || 0;
  }
  const rot = hcW > 0 ? rotW / hcW : null;
  const ret = pos >= (s.ret_min_weight || 8) ? ach / pos : null;
  const abs = s.abs_enabled && bs >= (s.abs_min_days || 50) ? nn / bs : null;
  const st = [];
  if (rot != null) st.push(rot <= s.rot_green_max ? "G" : rot <= s.rot_amber_max ? "A" : "R");
  if (ret != null) st.push(ret >= s.ret_green_min ? "G" : ret >= s.ret_amber_min ? "A" : "R");
  if (abs != null) st.push(abs <= s.abs_green_max ? "G" : abs <= s.abs_amber_max ? "A" : "R");
  const status = st.includes("R") ? "R" : st.includes("A") ? "A" : st.includes("G") ? "G" : use.length ? "N" : "S";
  return {
    status, rot: rot == null ? null : +rot.toFixed(4), ret: ret == null ? null : +ret.toFixed(4),
    abs: bs > 0 ? +(nn / bs).toFixed(4) : null, hc: Math.round(hc), dep, sites: list.length,
    red: cnt.R, amber: cnt.A, green: cnt.G,
  };
}

router.get("/rag", async (req, res) => {
  try {
    const f = filters(req.query);
    const A = await anchor(f.to);
    const nWeeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 12, 4), 26);
    const [snap, s, names] = await Promise.all([
      query(
        `WITH ${SC},
         sk AS (SELECT DISTINCT site_key, region_id, coordinator_id FROM sc),
         wk AS (SELECT DISTINCT week_end FROM reg.rag_snapshots WHERE week_end <= $4::date
                 ORDER BY week_end DESC LIMIT $5::int)
         SELECT to_char(v.week_end, 'YYYY-MM-DD') AS w, v.site_key, sk.region_id, sk.coordinator_id,
                v.status, v.red_weeks, v.headcount_avg, v.headcount_end, v.departures, v.rotation,
                v.ret_possible, v.ret_achieved, v.abs_nn, v.abs_base, v.window_days
           FROM reg.v_snap v JOIN wk ON wk.week_end = v.week_end
           JOIN sk ON sk.site_key = v.site_key
          ORDER BY v.week_end`,
        [...base(f), A, nWeeks]),
      regSettings(),
      query(`SELECT id, name FROM reg.regions`),
    ]);
    const weeks = [...new Set(snap.rows.map((x) => x.w))];
    const regName = Object.fromEntries(names.rows.map((x) => [x.id, x.name]));
    const byW = (rows) => weeks.map((w) => {
      const l = rows.filter((x) => x.w === w);
      return l.length ? Object.assign({ w }, aggStatus(l, s)) : { w, status: null };
    });
    const rows = [];
    if (f.region == null) {
      rows.push({ type: "company", key: "all", label: "Cała firma", cells: byW(snap.rows) });
      const regs = [...new Set(snap.rows.map((x) => x.region_id))];
      regs.sort((a, b) => (a == null) - (b == null) || String(regName[a]).localeCompare(String(regName[b])));
      for (const id of regs) {
        rows.push({
          type: "region", key: id == null ? "none" : String(id), label: id == null ? "Bez regionu" : regName[id],
          cells: byW(snap.rows.filter((x) => x.region_id === id)),
        });
      }
    } else {
      rows.push({ type: "region", key: String(f.region), label: f.region === -1 ? "Bez regionu" : regName[f.region] || "Region", cells: byW(snap.rows) });
      const last = weeks[weeks.length - 1];
      const sites = [...new Set(snap.rows.map((x) => x.site_key))];
      const hcLast = (k) => { const x = snap.rows.find((r) => r.site_key === k && r.w === last); return x ? Number(x.headcount_end) : 0; };
      sites.sort((a, b) => hcLast(b) - hcLast(a));
      for (const k of sites) {
        rows.push({
          type: "site", key: k, label: k,
          cells: weeks.map((w) => {
            const x = snap.rows.find((r) => r.site_key === k && r.w === w);
            if (!x) return { w, status: null };
            return {
              w, status: x.status, red_weeks: x.red_weeks, hc: Math.round(Number(x.headcount_avg)), dep: x.departures, win: x.window_days,
              rot: x.rotation == null ? null : Number(x.rotation),
              ret: x.ret_possible ? x.ret_achieved / x.ret_possible : null,
              abs: x.abs_base ? x.abs_nn / x.abs_base : null,
            };
          }),
        });
      }
    }
    res.json({ ok: true, weeks, rows, abs_enabled: !!s.abs_enabled });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Рух кадрів по тижнях: прийняті, відходи, чисельність
// ══════════════════════════════════════════════════════════════════════
router.get("/trend", async (req, res) => {
  try {
    const f = filters(req.query);
    const A = await anchor(f.to);
    const r = await query(
      `WITH ${SC},
       wk AS (SELECT (ws.d)::date AS w FROM generate_series($4::date - 7 * 11, $4::date, INTERVAL '7 days') ws(d)),
       sp AS MATERIALIZED (SELECT * FROM board.v_spells),
       per AS MATERIALIZED (SELECT v.* FROM reg.v_periods v WHERE v.facility_id IN (SELECT facility_id FROM sc)),
       hi AS (SELECT wk.w, COUNT(*)::int AS n FROM wk
                JOIN sp ON sp.start_date > wk.w - 7 AND sp.start_date <= wk.w
               WHERE sp.start_facility IN (SELECT facility_id FROM sc) GROUP BY 1),
       de AS (SELECT wk.w, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE sp.end_date - sp.start_date < 30)::int AS early
                FROM wk JOIN sp ON sp.end_date > wk.w - 7 AND sp.end_date <= wk.w
               WHERE sp.end_facility IN (SELECT facility_id FROM sc) AND sp.end_status <> 'przeniesiony' GROUP BY 1),
       hc AS (SELECT wk.w, COUNT(DISTINCT per.worker_id)::int AS n FROM wk
                JOIN per ON per.bhp_date <= wk.w AND (per.last_work_date IS NULL OR per.last_work_date > wk.w)
               GROUP BY 1)
       SELECT to_char(wk.w, 'YYYY-MM-DD') AS w, COALESCE(hi.n, 0) AS hires, COALESCE(de.n, 0) AS dep,
              COALESCE(de.early, 0) AS dep_early, COALESCE(hc.n, 0) AS hc
         FROM wk LEFT JOIN hi ON hi.w = wk.w LEFT JOIN de ON de.w = wk.w LEFT JOIN hc ON hc.w = wk.w
        ORDER BY wk.w`,
      [...base(f), A],
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Когорти: з прийнятих у місяці — скільки працюють на 7/14/30/60/80 день
// ══════════════════════════════════════════════════════════════════════
router.get("/cohorts", async (req, res) => {
  try {
    const f = filters(req.query);
    const r = await query(
      `WITH ${SC},
       sp AS (SELECT * FROM board.v_spells
               WHERE start_facility IN (SELECT facility_id FROM sc)
                 AND start_date >= date_trunc('month', care.today()) - INTERVAL '6 months')
       SELECT to_char(date_trunc('month', sp.start_date), 'YYYY-MM') AS m, d.days,
              COUNT(*)::int AS hired,
              COUNT(*) FILTER (WHERE sp.start_date + d.days <= care.today() - 1
                                 AND NOT COALESCE(sp.end_status = 'przeniesiony' AND sp.end_date < sp.start_date + d.days, false))::int AS elig,
              COUNT(*) FILTER (WHERE sp.start_date + d.days <= care.today() - 1
                                 AND (sp.end_date IS NULL OR sp.end_date >= sp.start_date + d.days))::int AS ok
         FROM sp CROSS JOIN (VALUES (7), (14), (30), (60), (80)) d(days)
        GROUP BY 1, 2 ORDER BY 1, 2`,
      base(f),
    );
    const months = [...new Set(r.rows.map((x) => x.m))];
    const DAYS = [7, 14, 30, 60, 80];
    const rows = months.map((m) => {
      const l = r.rows.filter((x) => x.m === m);
      return {
        m, hired: l[0] ? l[0].hired : 0,
        cells: DAYS.map((d) => { const x = l.find((y) => y.days === d); return x ? { d, elig: x.elig, ok: x.ok } : { d, elig: 0, ok: 0 }; }),
      };
    });
    const total = {
      m: "all", hired: rows.reduce((a, x) => a + x.hired, 0),
      cells: DAYS.map((d, i) => ({ d, elig: rows.reduce((a, x) => a + x.cells[i].elig, 0), ok: rows.reduce((a, x) => a + x.cells[i].ok, 0) })),
    };
    res.json({ ok: true, days: DAYS, rows, total });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Причини: відходи (анкета), «що заважає» (анкета), розмови, червоні картки
// ══════════════════════════════════════════════════════════════════════
const CAT = {
  pay: "Wynagrodzenie", money: "Wynagrodzenie", housing: "Zakwaterowanie", transport: "Dojazd",
  schedule: "Grafik / godziny", team: "Zespół / brygadzista", work: "Praca / warunki u klienta",
  conditions: "Praca / warunki u klienta", other_job: "Inna praca", family: "Sprawy rodzinne",
  documents: "Dokumenty / legalizacja", legal: "Dokumenty / legalizacja", recruit: "Rekrutacja",
  coord: "Koordynator", client: "Klient / sezon", other: "Inne", none: "Bez wskazania",
};
router.get("/reasons", async (req, res) => {
  try {
    const f = filters(req.query);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 7), 365);
    const p = [...base(f), days];
    const [exit, prob, tasks, cards] = await Promise.all([
      query(
        `WITH ${SC}
         SELECT a.option_code AS code, COUNT(*)::int AS n
           FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
           JOIN care.questions q ON q.id = a.question_id
          WHERE q.survey_code = 'exit' AND q.code = 'reason' AND s.facility_id IN (SELECT facility_id FROM sc)
            AND a.answered_at > now() - make_interval(days => $4::int)
          GROUP BY 1`, p),
      query(
        `WITH ${SC}
         SELECT a.option_code AS code, COUNT(*)::int AS n
           FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
           JOIN care.questions q ON q.id = a.question_id
          WHERE q.code = 'problem' AND s.facility_id IN (SELECT facility_id FROM sc)
            AND a.answered_at > now() - make_interval(days => $4::int)
          GROUP BY 1`, p),
      query(
        `WITH ${SC}
         SELECT COALESCE(t.problem_code, 'none') AS code, t.outcome, COUNT(*)::int AS n
           FROM care.tasks t
          WHERE t.outcome IN ('problem','leaving') AND t.facility_id IN (SELECT facility_id FROM sc)
            AND t.done_at > now() - make_interval(days => $4::int)
          GROUP BY 1, 2`, p),
      query(
        `WITH ${SC}
         SELECT COALESCE(c.reason_code, 'none') AS code, COUNT(*)::int AS n
           FROM reg.red_cards c
          WHERE c.site_key IN (SELECT site_key FROM sc) AND c.opened_at > now() - make_interval(days => $4::int)
            AND c.reason_code IS NOT NULL
          GROUP BY 1`, p),
    ]);
    const sources = {
      exit: { label: "Odchodzący — ankieta", rows: exit.rows },
      problem: { label: "Pracujący — „co przeszkadza”", rows: prob.rows.filter((x) => x.code !== "nothing"), ok: (prob.rows.find((x) => x.code === "nothing") || {}).n || 0 },
      tasks: { label: "Koordynatorzy — rozmowy", rows: tasks.rows.filter((x) => x.outcome === "problem"), leaving: tasks.rows.filter((x) => x.outcome === "leaving").reduce((a, x) => a + x.n, 0) },
      cards: { label: "Regionalni — czerwone karty", rows: cards.rows },
    };
    const cats = {};
    for (const [k, src] of Object.entries(sources)) {
      src.total = src.rows.reduce((a, x) => a + x.n, 0);
      for (const x of src.rows) {
        const c = CAT[x.code] || CAT.other;
        cats[c] = cats[c] || { label: c, exit: 0, problem: 0, tasks: 0, cards: 0 };
        cats[c][k] += x.n;
      }
    }
    const list = Object.values(cats).map((c) => {
      const share = ["exit", "problem", "tasks", "cards"].map((k) => (sources[k].total ? c[k] / sources[k].total : 0));
      c.weight = share.reduce((a, x) => a + x, 0);
      return c;
    }).sort((a, b) => b.weight - a.weight);
    res.json({
      ok: true, days, categories: list,
      sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { label: v.label, total: v.total, ok: v.ok, leaving: v.leaving }])),
    });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Голос працівника: оцінки з анкет (з розбивкою по регіонах)
// ══════════════════════════════════════════════════════════════════════
router.get("/voice", async (req, res) => {
  try {
    const f = filters(req.query);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 7), 365);
    const p = [...base(f), days];
    const [ans, sends, names] = await Promise.all([
      query(
        `WITH ${SC}
         SELECT sc.region_id, q.code AS q, a.option_code AS c, COUNT(*)::int AS n
           FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
           JOIN care.questions q ON q.id = a.question_id
           JOIN sc ON sc.facility_id = s.facility_id
          WHERE a.answered_at > now() - make_interval(days => $4::int)
          GROUP BY 1, 2, 3`, p),
      query(
        `WITH ${SC}
         SELECT sc.region_id,
                COUNT(*) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sent,
                COUNT(*) FILTER (WHERE s.status = 'done')::int AS done,
                COUNT(*) FILTER (WHERE s.status = 'no_telegram')::int AS no_tg
           FROM care.survey_sends s JOIN sc ON sc.facility_id = s.facility_id
          WHERE s.planned_for > care.today() - $4::int
          GROUP BY 1`, p),
      query(`SELECT id, name FROM reg.regions`),
    ]);
    const regName = Object.fromEntries(names.rows.map((x) => [x.id, x.name]));
    function calc(rows, srows) {
      const get = (q) => rows.filter((x) => x.q === q);
      const avg = (q) => {
        const l = get(q).filter((x) => /^[1-5]$/.test(x.c));
        const n = l.reduce((a, x) => a + x.n, 0);
        return { n, v: n ? +(l.reduce((a, x) => a + Number(x.c) * x.n, 0) / n).toFixed(2) : null };
      };
      const share = (qs, good) => {
        const l = rows.filter((x) => qs.includes(x.q));
        const n = l.reduce((a, x) => a + x.n, 0);
        const g = l.filter((x) => good.includes(x.c)).reduce((a, x) => a + x.n, 0);
        return { n, v: n ? +(g / n).toFixed(3) : null };
      };
      const dist = (q) => Object.fromEntries(get(q).map((x) => [x.c, x.n]));
      const sent = srows.reduce((a, x) => a + x.sent, 0);
      const done = srows.reduce((a, x) => a + x.done, 0);
      return {
        work5: avg("work5"), housing5: avg("housing5"), coord5: avg("coord5"),
        stay_yes: share(["stay"], ["yes"]), stay_no: share(["stay"], ["no"]), stay: dist("stay"),
        housing3: share(["housing3"], ["yes", "own"]), transport3: share(["transport3"], ["yes"]),
        onboard3: share(["onboard3"], ["yes"]), coord_yes: share(["coord3", "coordx"], ["yes"]),
        back: share(["back"], ["yes"]), problem: dist("problem"),
        sent, done, no_tg: srows.reduce((a, x) => a + x.no_tg, 0), rate: sent ? +(done / sent).toFixed(3) : null,
      };
    }
    const all = calc(ans.rows, sends.rows);
    const regs = [...new Set([...ans.rows.map((x) => x.region_id), ...sends.rows.map((x) => x.region_id)])];
    const byRegion = regs.map((id) => Object.assign(
      { region_id: id, label: id == null ? "Bez regionu" : regName[id] },
      calc(ans.rows.filter((x) => x.region_id === id), sends.rows.filter((x) => x.region_id === id)),
    )).sort((a, b) => String(a.label).localeCompare(String(b.label)));
    res.json({ ok: true, days, all, by_region: byRegion });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Координатори: процес і результат
// ══════════════════════════════════════════════════════════════════════
router.get("/coordinators", async (req, res) => {
  try {
    const f = filters(req.query);
    const A = await anchor(f.to);
    const L = f.period;
    const r = await query(
      `WITH ${SC},
       co AS (SELECT DISTINCT coordinator_id FROM sc WHERE coordinator_id IS NOT NULL),
       per AS (SELECT v.*, sc.coordinator_id FROM reg.v_periods v JOIN sc ON sc.facility_id = v.facility_id),
       sites AS (SELECT sc.coordinator_id, COUNT(DISTINCT sc.site_key)::int AS sites,
                        string_agg(DISTINCT rg.name, ', ') AS regions
                   FROM sc LEFT JOIN reg.regions rg ON rg.id = sc.region_id
                  WHERE sc.coordinator_id IS NOT NULL GROUP BY 1),
       hc AS (
         SELECT coordinator_id,
                COUNT(DISTINCT worker_id) FILTER (WHERE bhp_date <= $4::date AND (last_work_date IS NULL OR last_work_date > $4::date))::int AS hc_end,
                COUNT(DISTINCT worker_id) FILTER (WHERE bhp_date <= $4::date - $5::int
                  AND (last_work_date IS NULL OR last_work_date > $4::date - $5::int))::int AS hc_start
           FROM per GROUP BY 1),
       dep AS (
         SELECT sc.coordinator_id, COUNT(*)::int AS dep,
                COUNT(*) FILTER (WHERE sp.end_date - sp.start_date < 30)::int AS dep_early
           FROM board.v_spells sp JOIN sc ON sc.facility_id = sp.end_facility
          WHERE sp.end_status <> 'przeniesiony' AND sp.end_date > $4::date - $5::int AND sp.end_date <= $4::date
          GROUP BY 1),
       s80 AS (
         SELECT sc.coordinator_id, COUNT(*)::int AS n80,
                COUNT(*) FILTER (WHERE sp.end_date IS NULL OR sp.end_date >= sp.start_date + 80)::int AS ok80
           FROM board.v_spells sp JOIN sc ON sc.facility_id = sp.start_facility
          WHERE sp.start_date + 80 > $4::date - GREATEST($5::int, 91) AND sp.start_date + 80 <= $4::date
            AND NOT COALESCE(sp.end_status = 'przeniesiony' AND sp.end_date < sp.start_date + 80, false)
          GROUP BY 1),
       days AS (
         SELECT DISTINCT p.coordinator_id, p.site_key, p.worker_id, d::date AS d
           FROM per p
           CROSS JOIN LATERAL generate_series(GREATEST(p.bhp_date, $4::date - $5::int + 1),
                                              LEAST(COALESCE(p.last_work_date, $4::date), $4::date), INTERVAL '1 day') d),
       tracked AS (
         SELECT DISTINCT d.site_key FROM days d
          WHERE EXISTS (SELECT 1 FROM public.hours_log hl WHERE hl.worker_id = d.worker_id AND hl.work_date = d.d)),
       fill AS (
         SELECT d.coordinator_id, COUNT(*)::int AS days,
                COUNT(hl.worker_id)::int AS filled,
                COUNT(*) FILTER (WHERE hl.absence_type::text = 'NN')::int AS nn,
                COUNT(*) FILTER (WHERE (hl.hours IS NOT NULL AND hl.hours > 0)
                                    OR hl.absence_type::text IN ('NN','UN','L4','URL'))::int AS nn_base
           FROM days d JOIN tracked t ON t.site_key = d.site_key
           LEFT JOIN public.hours_log hl ON hl.worker_id = d.worker_id AND hl.work_date = d.d
          GROUP BY 1),
       tk AS (
         SELECT t.coordinator_id,
                COUNT(*) FILTER (WHERE t.status <> 'cancelled')::int AS tasks,
                COUNT(*) FILTER (WHERE t.status IN ('done','missed') OR (t.status = 'open' AND t.escalated_at IS NOT NULL))::int AS due,
                COUNT(*) FILTER (WHERE t.status = 'done')::int AS done,
                COUNT(*) FILTER (WHERE t.status = 'done' AND (t.escalated_at IS NULL OR t.done_at < t.escalated_at))::int AS on_time,
                COUNT(*) FILTER (WHERE t.status = 'missed')::int AS missed,
                COUNT(*) FILTER (WHERE t.outcome = 'stays')::int AS o_stays,
                COUNT(*) FILTER (WHERE t.outcome = 'no_answer')::int AS o_no_answer,
                COUNT(*) FILTER (WHERE t.outcome = 'leaving')::int AS o_leaving,
                COUNT(*) FILTER (WHERE t.outcome = 'problem')::int AS o_problem
           FROM care.tasks t
          WHERE care.ldate(t.created_at) > $4::date - $5::int AND care.ldate(t.created_at) <= $4::date
            AND t.facility_id IN (SELECT facility_id FROM sc)
          GROUP BY 1),
       spot AS (
         SELECT x.coordinator_id, COUNT(*) FILTER (WHERE x.status = 'answered')::int AS spot_n,
                COUNT(*) FILTER (WHERE x.answer = 'no')::int AS spot_no
           FROM care.spot_checks x JOIN care.tasks t ON t.id = x.task_id
          WHERE x.answered_at > now() - make_interval(days => GREATEST($5::int, 30))
            AND t.facility_id IN (SELECT facility_id FROM sc)
          GROUP BY 1),
       cq AS (
         SELECT s.coordinator_id,
                COUNT(*) FILTER (WHERE q.code = 'coord5')::int AS c5_n,
                ROUND(AVG(a.option_code::numeric) FILTER (WHERE q.code = 'coord5' AND a.option_code ~ '^[1-5]$'), 2) AS c5_avg,
                COUNT(*) FILTER (WHERE q.code IN ('coord3','coordx'))::int AS cy_n,
                COUNT(*) FILTER (WHERE q.code IN ('coord3','coordx') AND a.option_code = 'yes')::int AS cy_yes
           FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
           JOIN care.questions q ON q.id = a.question_id
          WHERE a.answered_at > now() - INTERVAL '90 days' AND s.facility_id IN (SELECT facility_id FROM sc)
          GROUP BY 1),
       sv AS (
         SELECT s.coordinator_id,
                COUNT(*) FILTER (WHERE s.status IN ('sent','done','expired'))::int AS sv_sent,
                COUNT(*) FILTER (WHERE s.status = 'done')::int AS sv_done
           FROM care.survey_sends s
          WHERE s.planned_for > care.today() - 90 AND s.facility_id IN (SELECT facility_id FROM sc)
          GROUP BY 1),
       rday AS (SELECT MAX(day) AS d FROM care.risk_daily),
       rk AS (
         SELECT sc.coordinator_id, COUNT(*) FILTER (WHERE r.score >= care.setting('risk_min'))::int AS risk_n
           FROM care.risk_daily r JOIN sc ON sc.facility_id = r.facility_id, rday
          WHERE r.day = rday.d GROUP BY 1)
       SELECT c.id, c.full_name AS name, c.telegram_chat_id IS NOT NULL AS tg,
              COALESCE(cc.enabled, false) AS module_on, to_char(cc.enabled_at, 'YYYY-MM-DD') AS enabled_at,
              sites.sites, sites.regions,
              COALESCE(hc.hc_end, 0) AS hc_end, COALESCE(hc.hc_start, 0) AS hc_start,
              COALESCE(dep.dep, 0) AS dep, COALESCE(dep.dep_early, 0) AS dep_early,
              COALESCE(s80.n80, 0) AS n80, COALESCE(s80.ok80, 0) AS ok80,
              fill.days, fill.filled, fill.nn, fill.nn_base,
              COALESCE(tk.tasks, 0) AS tasks, COALESCE(tk.due, 0) AS due, COALESCE(tk.done, 0) AS done, COALESCE(tk.on_time, 0) AS on_time,
              COALESCE(tk.missed, 0) AS missed, COALESCE(tk.o_stays, 0) AS o_stays,
              COALESCE(tk.o_no_answer, 0) AS o_no_answer, COALESCE(tk.o_leaving, 0) AS o_leaving,
              COALESCE(tk.o_problem, 0) AS o_problem,
              COALESCE(spot.spot_n, 0) AS spot_n, COALESCE(spot.spot_no, 0) AS spot_no,
              COALESCE(cq.c5_n, 0) AS c5_n, cq.c5_avg, COALESCE(cq.cy_n, 0) AS cy_n, COALESCE(cq.cy_yes, 0) AS cy_yes,
              COALESCE(sv.sv_sent, 0) AS sv_sent, COALESCE(sv.sv_done, 0) AS sv_done,
              COALESCE(rk.risk_n, 0) AS risk_n
         FROM co JOIN public.coordinators c ON c.id = co.coordinator_id
         LEFT JOIN care.coordinators cc ON cc.coordinator_id = c.id
         LEFT JOIN sites ON sites.coordinator_id = c.id
         LEFT JOIN hc    ON hc.coordinator_id = c.id
         LEFT JOIN dep   ON dep.coordinator_id = c.id
         LEFT JOIN s80   ON s80.coordinator_id = c.id
         LEFT JOIN fill  ON fill.coordinator_id = c.id
         LEFT JOIN tk    ON tk.coordinator_id = c.id
         LEFT JOIN spot  ON spot.coordinator_id = c.id
         LEFT JOIN cq    ON cq.coordinator_id = c.id
         LEFT JOIN sv    ON sv.coordinator_id = c.id
         LEFT JOIN rk    ON rk.coordinator_id = c.id
        ORDER BY c.full_name`,
      [...base(f), A, L],
    );
    // Порівняння «з модулем / без модуля» — орієнтовне: різні об'єкти, різні люди
    const grp = (on) => {
      const l = r.rows.filter((x) => x.module_on === on);
      const hc = l.reduce((a, x) => a + (x.hc_start + x.hc_end) / 2, 0);
      const dep = l.reduce((a, x) => a + x.dep, 0);
      const n80 = l.reduce((a, x) => a + x.n80, 0);
      const ok80 = l.reduce((a, x) => a + x.ok80, 0);
      return { coords: l.length, hc: Math.round(hc), dep, rot: hc ? +(dep / hc).toFixed(4) : null, n80, ok80, s80: n80 ? +(ok80 / n80).toFixed(4) : null };
    };
    res.json({ ok: true, anchor: A, period: L, data: r.rows, compare: { on: grp(true), off: grp(false) } });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Деталі за клік на цифру
// ══════════════════════════════════════════════════════════════════════
router.get("/detail", async (req, res) => {
  try {
    const f = filters(req.query);
    const A = await anchor(f.to);
    const L = f.period;
    let kind = String(req.query.kind || "");
    // «early_now» — з «Do decyzji»: останні 28 днів до сьогодні, як у самому сигналі
    let AA = A, LL = L;
    if (kind === "early_now") {
      kind = "early";
      AA = (await query(`SELECT to_char(care.today(), 'YYYY-MM-DD') AS d`)).rows[0].d;
      LL = 28;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 20000);
    const p = [...base(f), AA, LL];
    const site = req.query.site ? String(req.query.site) : null;
    let q;
    const COORD = `(SELECT full_name FROM public.coordinators WHERE id = sc.coordinator_id)`;
    const REG = `(SELECT name FROM reg.regions WHERE id = sc.region_id)`;

    if (kind === "departures" || kind === "early") {
      if (site) p.push(site);
      q = `WITH ${SC}
        SELECT w.full_name AS name, w.login, sp.end_site AS site, ${COORD} AS coord,
               to_char(sp.start_date, 'YYYY-MM-DD') AS start, to_char(sp.end_date, 'YYYY-MM-DD') AS "end",
               (sp.end_date - sp.start_date + 1) AS tenure,
               (SELECT a.option_code FROM care.answers a JOIN care.survey_sends s ON s.id = a.send_id
                  JOIN care.questions qq ON qq.id = a.question_id
                 WHERE s.worker_id = sp.worker_id AND qq.code = 'reason' AND a.answered_at >= sp.start_date
                 ORDER BY a.answered_at DESC LIMIT 1) AS reason,
               (SELECT t.outcome FROM care.tasks t WHERE t.worker_id = sp.worker_id AND t.status = 'done'
                   AND t.done_at >= sp.start_date ORDER BY t.done_at DESC LIMIT 1) AS last_talk
          FROM board.v_spells sp JOIN sc ON sc.facility_id = sp.end_facility
          JOIN public.workers w ON w.id = sp.worker_id
         WHERE sp.end_status <> 'przeniesiony' AND sp.end_date > $4::date - $5::int AND sp.end_date <= $4::date
           ${kind === "early" ? "AND sp.end_date - sp.start_date < 30" : ""}
           ${site ? "AND sp.end_site = $6" : ""}
         ORDER BY sp.end_date DESC, w.full_name`;
    } else if (kind === "hires") {
      q = `WITH ${SC}
        SELECT w.full_name AS name, w.login, sp.start_site AS site, ${COORD} AS coord,
               to_char(sp.start_date, 'YYYY-MM-DD') AS start,
               CASE WHEN sp.end_date IS NULL OR sp.end_date > care.today() THEN 'pracuje'
                    WHEN sp.end_status = 'przeniesiony' THEN 'przeniesiony'
                    ELSE 'odszedł ' || to_char(sp.end_date, 'DD.MM') END AS now
          FROM board.v_spells sp JOIN sc ON sc.facility_id = sp.start_facility
          JOIN public.workers w ON w.id = sp.worker_id
         WHERE sp.start_date > $4::date - $5::int AND sp.start_date <= $4::date
         ORDER BY sp.start_date DESC, w.full_name`;
    } else if (kind === "rez") {
      q = `WITH ${SC}
        SELECT DISTINCT ON (h.worker_id) w.full_name AS name, w.login, sc.site_key AS site, ${COORD} AS coord,
               to_char(h.bhp_date, 'YYYY-MM-DD') AS start
          FROM public.worker_facility_history h JOIN sc ON sc.facility_id = h.facility_id
          JOIN public.workers w ON w.id = h.worker_id
         WHERE h.status::text = 'rezygnacja' AND h.bhp_date > $4::date - $5::int AND h.bhp_date <= $4::date
           AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
         ORDER BY h.worker_id, h.bhp_date DESC`;
    } else if (kind === "sites") {
      // По об'єктах: чисельність, рух, дожиття, NN
      q = `WITH ${SC},
        per AS (SELECT v.* FROM reg.v_periods v WHERE v.facility_id IN (SELECT facility_id FROM sc)),
        sk AS (SELECT site_key, MIN(region_id) AS region_id, MIN(coordinator_id) AS coordinator_id FROM sc GROUP BY 1),
        hc AS (SELECT site_key,
                      COUNT(DISTINCT worker_id) FILTER (WHERE bhp_date <= $4::date AND (last_work_date IS NULL OR last_work_date > $4::date))::int AS hc_end,
                      COUNT(DISTINCT worker_id) FILTER (WHERE bhp_date <= $4::date - $5::int
                        AND (last_work_date IS NULL OR last_work_date > $4::date - $5::int))::int AS hc_start
                 FROM per GROUP BY 1),
        dep AS (SELECT end_site AS site_key, COUNT(*)::int AS dep, COUNT(*) FILTER (WHERE end_date - start_date < 30)::int AS early
                  FROM board.v_spells WHERE end_facility IN (SELECT facility_id FROM sc) AND end_status <> 'przeniesiony'
                   AND end_date > $4::date - $5::int AND end_date <= $4::date GROUP BY 1),
        hi AS (SELECT start_site AS site_key, COUNT(*)::int AS hires FROM board.v_spells
                WHERE start_facility IN (SELECT facility_id FROM sc) AND start_date > $4::date - $5::int AND start_date <= $4::date GROUP BY 1),
        s80 AS (SELECT start_site AS site_key, COUNT(*)::int AS n80,
                       COUNT(*) FILTER (WHERE end_date IS NULL OR end_date >= start_date + 80)::int AS ok80
                  FROM board.v_spells WHERE start_facility IN (SELECT facility_id FROM sc)
                   AND start_date + 80 > $4::date - GREATEST($5::int, 91) AND start_date + 80 <= $4::date
                   AND NOT COALESCE(end_status = 'przeniesiony' AND end_date < start_date + 80, false) GROUP BY 1),
        rk AS (SELECT r.site_key, COUNT(*) FILTER (WHERE r.score >= care.setting('risk_min'))::int AS risk_n
                 FROM care.risk_daily r WHERE r.day = (SELECT MAX(day) FROM care.risk_daily WHERE day <= $4::date + 7)
                  AND r.facility_id IN (SELECT facility_id FROM sc) GROUP BY 1),
        nnd AS (SELECT DISTINCT ON (hl.worker_id, hl.work_date) p.site_key,
                       (hl.hours IS NOT NULL AND hl.hours > 0) AS worked, hl.absence_type::text AS abs
                  FROM public.hours_log hl
                  JOIN per p ON p.worker_id = hl.worker_id AND hl.work_date >= p.bhp_date
                            AND (p.last_work_date IS NULL OR hl.work_date <= p.last_work_date)
                 WHERE hl.work_date > $4::date - $5::int AND hl.work_date <= $4::date
                 ORDER BY hl.worker_id, hl.work_date, p.bhp_date DESC),
        nn AS (SELECT site_key, COUNT(*) FILTER (WHERE abs = 'NN')::int AS nn,
                      COUNT(*) FILTER (WHERE worked OR abs IN ('NN','UN','L4','URL'))::int AS nn_base
                 FROM nnd GROUP BY 1)
        SELECT sk.site_key AS site, (SELECT name FROM reg.regions WHERE id = sk.region_id) AS region,
               (SELECT full_name FROM public.coordinators WHERE id = sk.coordinator_id) AS coord,
               COALESCE(hc.hc_start, 0) AS hc_start, COALESCE(hc.hc_end, 0) AS hc_end,
               COALESCE(hi.hires, 0) AS hires, COALESCE(dep.dep, 0) AS dep, COALESCE(dep.early, 0) AS early,
               CASE WHEN COALESCE(hc.hc_start, 0) + COALESCE(hc.hc_end, 0) > 0
                    THEN ROUND(COALESCE(dep.dep, 0) * 2.0 / (hc.hc_start + hc.hc_end), 4) END AS rot,
               COALESCE(s80.n80, 0) AS n80, CASE WHEN s80.n80 > 0 THEN ROUND(s80.ok80::numeric / s80.n80, 4) END AS s80,
               COALESCE(nn.nn, 0) AS nn, CASE WHEN nn.nn_base > 0 THEN ROUND(nn.nn::numeric / nn.nn_base, 4) END AS nnr,
               COALESCE(rk.risk_n, 0) AS risk_n
          FROM sk
          LEFT JOIN hc ON hc.site_key = sk.site_key LEFT JOIN dep ON dep.site_key = sk.site_key
          LEFT JOIN hi ON hi.site_key = sk.site_key LEFT JOIN s80 ON s80.site_key = sk.site_key
          LEFT JOIN rk ON rk.site_key = sk.site_key
          LEFT JOIN nn ON nn.site_key = sk.site_key
         WHERE COALESCE(hc.hc_end, 0) + COALESCE(hc.hc_start, 0) + COALESCE(dep.dep, 0) + COALESCE(hi.hires, 0) > 0
         ORDER BY hc_end DESC, sk.site_key`;
    } else if (kind === "nocoord") {
      q = `WITH ${SC},
        act AS (SELECT site_key, COUNT(*)::int AS n FROM care.v_active GROUP BY site_key)
        SELECT DISTINCT sc.site_key AS site, ${REG} AS region, act.n AS hc_end
          FROM sc JOIN act ON act.site_key = sc.site_key WHERE sc.coordinator_id IS NULL
         ORDER BY hc_end DESC`;
    } else if (kind === "risk") {
      q = `WITH ${SC}
        SELECT w.full_name AS name, w.login, r.site_key AS site, ${COORD} AS coord, r.tenure, r.score,
               array_to_string(r.reasons, ' ') AS reasons,
               (SELECT t.status FROM care.tasks t WHERE t.worker_id = r.worker_id ORDER BY t.created_at DESC LIMIT 1) AS task
          FROM care.risk_daily r JOIN sc ON sc.facility_id = r.facility_id
          JOIN public.workers w ON w.id = r.worker_id
         WHERE r.day = (SELECT MAX(day) FROM care.risk_daily WHERE day <= $4::date + 7)
           AND r.score >= care.setting('risk_min')
         ORDER BY r.score DESC, r.tenure`;
    } else if (kind === "leaving" || kind === "leaving7") {
      const cond = kind === "leaving7"
        ? `t.done_at > now() - INTERVAL '7 days'`
        : `care.ldate(t.done_at) > $4::date - $5::int AND care.ldate(t.done_at) <= $4::date`;
      q = `WITH ${SC}
        SELECT w.full_name AS name, w.login, t.site_key AS site, (SELECT full_name FROM public.coordinators WHERE id = t.coordinator_id) AS coord,
               to_char(t.done_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD') AS date, t.problem_code AS problem, t.comment,
               (SELECT CASE WHEN MIN(s.end_date) IS NOT NULL THEN 'odszedł ' || to_char(MIN(s.end_date), 'DD.MM') END
                  FROM board.v_spells s WHERE s.worker_id = t.worker_id AND s.end_status <> 'przeniesiony'
                   AND s.end_date >= care.ldate(t.done_at) - 7 AND s.end_date <= LEAST(care.ldate(t.done_at) + 30, care.today())) AS result,
               care.ldate(t.done_at) + 30 > care.today() AS pending
          FROM care.tasks t JOIN public.workers w ON w.id = t.worker_id
         WHERE t.outcome = 'leaving' AND t.facility_id IN (SELECT facility_id FROM sc) AND ${cond}
         ORDER BY t.done_at DESC`;
    } else if (kind === "s80") {
      q = `WITH ${SC}
        SELECT w.full_name AS name, w.login, sp.start_site AS site, ${COORD} AS coord,
               to_char(sp.start_date, 'YYYY-MM-DD') AS start, to_char(sp.start_date + 80, 'YYYY-MM-DD') AS day80,
               CASE WHEN sp.end_date IS NULL OR sp.end_date >= sp.start_date + 80 THEN 'tak'
                    ELSE 'odszedł ' || to_char(sp.end_date, 'DD.MM') || ' (' || (sp.end_date - sp.start_date + 1) || ' dni)' END AS reached
          FROM board.v_spells sp JOIN sc ON sc.facility_id = sp.start_facility
          JOIN public.workers w ON w.id = sp.worker_id
         WHERE sp.start_date + 80 > $4::date - GREATEST($5::int, 28) AND sp.start_date + 80 <= $4::date
           AND NOT COALESCE(sp.end_status = 'przeniesiony' AND sp.end_date < sp.start_date + 80, false)
         ORDER BY (sp.end_date IS NULL OR sp.end_date >= sp.start_date + 80), sp.start_date`;
    } else {
      return fail(res, new Error("kind"), 400);
    }
    // лише ті параметри, що є в запиті (інакше Postgres не знає їх типу)
    const maxN = Math.max(...[...q.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    // загальна кількість до обрізання: COUNT(*) OVER () не змінює порядок рядків підзапиту
    const r = await query(`SELECT x.*, COUNT(*) OVER ()::int AS _total FROM (${q}) x LIMIT ${limit}`, p.slice(0, maxN));
    const total = r.rows.length ? r.rows[0]._total : 0;
    r.rows.forEach((x) => delete x._total);
    const fr = await query(`SELECT to_char($1::date - $2::int + 1, 'YYYY-MM-DD') AS f`, [AA, LL]);
    res.json({ ok: true, kind, anchor: AA, from: fr.rows[0].f, period: LL, total, limit, rows: r.rows });
  } catch (e) { fail(res, e); }
});

module.exports = { router };
