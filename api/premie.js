// ══════════════════════════════════════════════════════════════════════
//  Розділ «Premie koordynatorów» — API панелі.  app.use("/api/premie", require("./api/premie").router)
//  Розрахунок — bot/premie.js; таблиці — db/migration_premie.sql; опис — docs/PREMIE.md.
//
//  Доступ (премії — дані про зарплату):
//    керівник (coordinators.role = 'head') — усе: параметри, учасники й k-t, виключення, затвердження, виплата, доступ
//    решта, зокрема адміністратори панелі (is_admin), — лише кому увімкнено у вкладці «Dostęp» (prm.access), з рівнем:
//      own    — своя премія (блоки, відсотки, сума, об'єкти); регіональний — ще й координатори свого регіону
//      people — + люди: хто зарахований, хто ні й чому
//      excl   — + виключення працівників у своїй зоні (з причиною)
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const prm = require("../bot/premie");

router.use(requireAuth);

const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[premie api]", e);
  res.status(code).json({ ok: false, error: e.message || String(e) });
};
const LEVELS = ["own", "people", "excl"];
const atLeast = (ps, level) => LEVELS.indexOf(ps.level) >= LEVELS.indexOf(level);

// ── Доступ ────────────────────────────────────────────────────────────
async function scopeOf(c) {
  const me = c.coordinator_id;
  const full = c.role === "head";
  const r = await db.query(
    `SELECT (SELECT level FROM prm.access WHERE coordinator_id = $1) AS level,
            COALESCE((SELECT array_agg(rl.region_id) FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
                       WHERE rl.coordinator_id = $1 AND rg.is_active), '{}') AS regions`, [me]);
  const x = r.rows[0];
  return { me, full, level: full ? "excl" : x.level || null, regionIds: (x.regions || []).map(Number) };
}
router.use(async (req, res, next) => {
  try { req.ps = await scopeOf(req.coordinator); } catch (e) { return fail(res, e); }
  if (req.path === "/me") return next();
  if (!req.ps.level) return res.status(403).json({ ok: false, error: "Brak dostępu do premii koordynatorów" });
  next();
});
const requireFull = (req, res, next) =>
  (req.ps.full ? next() : res.status(403).json({ ok: false, error: "Tylko kierownik działu" }));

// Що бачить не-керівник: координатор — лише свій рядок; регіональний — ще й учасників з об'єктами його регіонів.
// Люди — з рівня people, лише з видимих об'єктів.
function scoped(ps, res) {
  if (ps.full) return res;
  const own = res.participants.find((p) => p.id === ps.me);
  const keys = new Set(own ? own.sites : []);
  if (ps.regionIds.length) res.sites.forEach((s) => { if (s.region_id != null && ps.regionIds.includes(s.region_id)) keys.add(s.key); });
  const parts = res.participants.filter((p) => p.id === ps.me || (ps.regionIds.length && p.sites.some((k) => keys.has(k))));
  const items = atLeast(ps, "people") ? res.items.filter((x) => keys.has(x.k)) : [];
  const skipped = { status: {}, reason: {}, manual: 0, moved: 0 };
  items.forEach((x) => {
    if (x.ex === "status") skipped.status[x.st] = (skipped.status[x.st] || 0) + 1;
    else if (x.ex === "reason") skipped.reason[x.rs] = (skipped.reason[x.rs] || 0) + 1;
    else if (x.ex === "manual") skipped.manual++;
    else if (x.ex === "moved") skipped.moved++;
  });
  const sum = (f) => Math.round(parts.reduce((a, p) => a + (f(p) || 0), 0) * 100) / 100;
  return {
    ...res, participants: parts, sites: res.sites.filter((s) => keys.has(s.key)), items, skipped,
    uncovered: [], config: undefined, total: sum((p) => p.total),
    range: res.range ? { min: sum((p) => p.live.total_min), max: sum((p) => p.live.total_max) } : null,
  };
}
const canSee = (ps, res, workerId) => ps.full || scoped(ps, res).items.some((x) => x.w === workerId);
async function approvedMonths() {
  const r = await db.query(`SELECT month FROM prm.runs`);
  return new Set(r.rows.map((x) => x.month));
}

// ── Хто я ─────────────────────────────────────────────────────────────
router.get("/me", (req, res) => {
  res.json({ ok: true, has_access: !!req.ps.level, full: req.ps.full, level: req.ps.level,
    lead: req.ps.regionIds.length > 0, me: req.ps.me, name: req.coordinator.full_name });
});

// Місяці: від першого з параметрами / учасниками до поточного, зі статусом затвердження
router.get("/months", async (req, res) => {
  try {
    const t = await prm.today();
    const cur = t.slice(0, 7);
    const r = await db.query(
      `SELECT LEAST((SELECT min(valid_from) FROM prm.params), (SELECT min(month) FROM prm.month_coords)) AS first`);
    const first = r.rows[0].first || cur;
    const runs = await db.query(`SELECT month, status, total::float AS total FROM prm.runs`);
    const by = new Map(runs.rows.map((x) => [x.month, x]));
    const out = [];
    for (let m = cur; m >= first && out.length < 60; m = prm.addMonths(m, -1)) {
      const x = by.get(m);
      out.push({ month: m, status: x ? x.status : m === cur ? "live" : "draft", total: x && req.ps.full ? x.total : null });
    }
    res.json({ ok: true, data: out, today: t });
  } catch (e) { fail(res, e); }
});

// Місяць: затверджений — знімок, інакше розрахунок «зараз»
router.get("/month/:m", async (req, res) => {
  if (!prm.isMonth(req.params.m)) return fail(res, new Error("Nieprawidłowy miesiąc"), 400);
  try {
    const data = scoped(req.ps, await prm.getMonth(req.params.m));
    res.json({ ok: true, data, can: {
      people: atLeast(req.ps, "people"), exclude: atLeast(req.ps, "excl") && !data.run,
      edit: req.ps.full && !data.run, approve: req.ps.full && !data.run && !data.live,
      unapprove: req.ps.full && !!data.run && data.run.status === "approved",
      pay: req.ps.full && !!data.run, unpay: req.ps.full && !!data.run && data.run.status === "paid",
      notify: req.ps.full && !!data.run,
    } });
  } catch (e) { fail(res, e, /Nieprawidłowy|jeszcze się nie zaczął/.test(e.message) ? 400 : 500); }
});

// ── Учасники місяця (керівник) ───────────────────────────────────────
// Усі координатори: регіони, де регіональний, і об'єкти, де головний зараз
router.get("/coordinators", requireFull, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.full_name AS name, COALESCE(c.is_active, true) AS active, c.role::text AS role,
              (c.telegram_chat_id IS NOT NULL) AS has_tg, COALESCE(ca.is_admin, false) AS is_admin,
              (SELECT array_agg(rg.name ORDER BY rg.name) FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
                WHERE rl.coordinator_id = c.id AND rg.is_active) AS regions,
              (SELECT array_agg(so.site_key ORDER BY so.site_key) FROM reg.site_owner so
                WHERE so.coordinator_id = c.id AND so.valid_to IS NULL) AS sites,
              (SELECT level FROM prm.access a WHERE a.coordinator_id = c.id) AS level
         FROM public.coordinators c
         LEFT JOIN public.coordinator_auth ca ON ca.coordinator_id = c.id
        ORDER BY COALESCE(c.is_active, true) DESC, c.full_name`);
    res.json({ ok: true, data: r.rows });
  } catch (e) { fail(res, e); }
});

router.put("/month/:m/coords", requireFull, async (req, res) => {
  const m = req.params.m;
  if (!prm.isMonth(m)) return fail(res, new Error("Nieprawidłowy miesiąc"), 400);
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return fail(res, new Error("Brak listy koordynatorów"), 400);
  const ids = new Set();
  for (const x of rows) {
    const id = Number(x.coordinator_id);
    if (!Number.isInteger(id) || ids.has(id)) return fail(res, new Error("Koordynator powtarza się na liście"), 400);
    ids.add(id);
    if (!["own", "region", "as"].includes(x.basis)) return fail(res, new Error("Nieznana podstawa wyliczenia"), 400);
    if (x.basis === "as" && (!Number.isInteger(Number(x.as_id)) || Number(x.as_id) === id))
      return fail(res, new Error("«Jak u» — wybierz innego koordynatora"), 400);
    const kt = Number(x.kt);
    if (!Number.isFinite(kt) || kt < 0 || kt > 2) return fail(res, new Error("k-t: od 0 do 2"), 400);
  }
  const client = await db.pool.connect();
  try {
    if ((await approvedMonths()).has(m)) return fail(res, new Error("Miesiąc jest zatwierdzony — najpierw cofnij zatwierdzenie"), 409);
    await client.query("BEGIN");
    const before = await client.query(`SELECT count(*)::int AS n FROM prm.month_coords WHERE month = $1`, [m]);
    await client.query(`DELETE FROM prm.month_coords WHERE month = $1`, [m]);
    for (const x of rows)
      await client.query(
        `INSERT INTO prm.month_coords (month, coordinator_id, basis, as_id, kt, note, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m, Number(x.coordinator_id), x.basis, x.basis === "as" ? Number(x.as_id) : null, Number(x.kt),
          x.note ? String(x.note).slice(0, 300) : null, req.ps.me]);
    await client.query(`INSERT INTO prm.log (by_id, action, month, details) VALUES ($1, 'coords', $2, $3)`,
      [req.ps.me, m, JSON.stringify({ n: rows.length, before: before.rows[0].n, rows })]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    fail(res, e, e.code === "23503" ? 400 : 500);
  } finally {
    client.release();
  }
});

// ── Виключення працівників ────────────────────────────────────────────
// Діють на місяць: на цей місяць і безстрокові. Видно — у межах зони доступу.
router.get("/exclusions", async (req, res) => {
  const m = req.query.month;
  if (!prm.isMonth(m)) return fail(res, new Error("Nieprawidłowy miesiąc"), 400);
  try {
    const r = await db.query(
      `SELECT e.id, e.worker_id, w.full_name AS worker, w.login, e.month, e.reason,
              to_char(e.created_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS created_at, cb.full_name AS created_by,
              to_char(e.removed_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS removed_at, rb.full_name AS removed_by
         FROM prm.exclusions e
         JOIN public.workers w ON w.id = e.worker_id
         LEFT JOIN public.coordinators cb ON cb.id = e.created_by
         LEFT JOIN public.coordinators rb ON rb.id = e.removed_by
        WHERE (e.month IS NULL OR e.month = $1)
        ORDER BY e.removed_at IS NOT NULL, e.created_at DESC
        LIMIT 500`, [m]);
    let rows = r.rows;
    if (!req.ps.full) {
      const vis = new Set(scoped(req.ps, await prm.getMonth(m)).items.map((x) => x.w));
      rows = rows.filter((x) => vis.has(x.worker_id));
    }
    res.json({ ok: true, data: rows });
  } catch (e) { fail(res, e); }
});

router.post("/exclusions", async (req, res) => {
  if (!atLeast(req.ps, "excl")) return fail(res, new Error("Brak uprawnień do wykluczeń"), 403);
  const b = req.body || {};
  const ctx = b.context_month;
  const month = b.month == null || b.month === "" ? null : b.month;
  const workerId = Number(b.worker_id);
  const reason = String(b.reason || "").trim();
  if (!prm.isMonth(ctx) || (month !== null && month !== ctx)) return fail(res, new Error("Nieprawidłowy miesiąc"), 400);
  if (!Number.isInteger(workerId)) return fail(res, new Error("Nie wybrano pracownika"), 400);
  if (!reason || reason.length > 300) return fail(res, new Error("Podaj przyczynę (do 300 znaków)"), 400);
  try {
    if ((await approvedMonths()).has(ctx)) return fail(res, new Error("Miesiąc jest zatwierdzony — wykluczeń nie można zmieniać"), 409);
    if (!canSee(req.ps, await prm.getMonth(ctx), workerId)) return fail(res, new Error("Pracownik spoza Twoich obiektów"), 403);
    const w = await db.query(`SELECT full_name FROM public.workers WHERE id = $1`, [workerId]);
    if (!w.rows.length) return fail(res, new Error("Nie znaleziono pracownika"), 404);
    const dup = await db.query(
      `SELECT 1 FROM prm.exclusions WHERE worker_id = $1 AND removed_at IS NULL AND month IS NOT DISTINCT FROM $2`, [workerId, month]);
    if (dup.rows.length) return fail(res, new Error("Pracownik jest już wykluczony"), 409);
    const r = await db.query(
      `INSERT INTO prm.exclusions (worker_id, month, reason, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [workerId, month, reason, req.ps.me]);
    await prm.log(req.ps.me, "excl_add", month || ctx, { worker_id: workerId, worker: w.rows[0].full_name, month, reason });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { fail(res, e); }
});

router.delete("/exclusions/:id", async (req, res) => {
  if (!atLeast(req.ps, "excl")) return fail(res, new Error("Brak uprawnień do wykluczeń"), 403);
  const ctx = req.query.month;
  if (!prm.isMonth(ctx)) return fail(res, new Error("Nieprawidłowy miesiąc"), 400);
  try {
    const r = await db.query(
      `SELECT e.id, e.worker_id, e.month, w.full_name AS worker
         FROM prm.exclusions e JOIN public.workers w ON w.id = e.worker_id
        WHERE e.id = $1 AND e.removed_at IS NULL`, [Number(req.params.id)]);
    const x = r.rows[0];
    if (!x) return fail(res, new Error("Nie znaleziono wykluczenia"), 404);
    if ((await approvedMonths()).has(x.month || ctx)) return fail(res, new Error("Miesiąc jest zatwierdzony — wykluczeń nie można zmieniać"), 409);
    if (!canSee(req.ps, await prm.getMonth(ctx), x.worker_id)) return fail(res, new Error("Pracownik spoza Twoich obiektów"), 403);
    await db.query(`UPDATE prm.exclusions SET removed_at = now(), removed_by = $2 WHERE id = $1`, [x.id, req.ps.me]);
    await prm.log(req.ps.me, "excl_remove", x.month || ctx, { id: x.id, worker_id: x.worker_id, worker: x.worker });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Параметри ─────────────────────────────────────────────────────────
// Для всіх з доступом (тільки перегляд «Jak liczymy»); змінює керівник
router.get("/params", async (req, res) => {
  const m = prm.isMonth(req.query.month) ? req.query.month : (await prm.today()).slice(0, 7);
  try {
    const cur = await prm.paramsFor(m);
    const out = { valid_from: cur.from, data: cur.P };
    if (req.ps.full) {
      const [sets, reasons, statuses, st] = await Promise.all([
        db.query(`SELECT p.valid_from, to_char(p.updated_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS updated_at,
                         c.full_name AS updated_by
                    FROM prm.params p LEFT JOIN public.coordinators c ON c.id = p.updated_by ORDER BY p.valid_from DESC`),
        db.query(`SELECT btrim(przyczyna_zwolnienia) AS reason, count(*)::int AS n
                    FROM public.worker_facility_history
                   WHERE NULLIF(btrim(przyczyna_zwolnienia), '') IS NOT NULL
                     AND last_work_date >= (now() AT TIME ZONE 'Europe/Warsaw')::date - 365
                   GROUP BY 1 ORDER BY 2 DESC`),
        prm.statuses(),
        prm.settings(),
      ]);
      Object.assign(out, { sets: sets.rows, reasons: reasons.rows, statuses, settings: st });
    }
    res.json({ ok: true, data: out });
  } catch (e) { fail(res, e); }
});

router.put("/params", requireFull, async (req, res) => {
  const b = req.body || {};
  if (!prm.isMonth(b.valid_from)) return fail(res, new Error("Nieprawidłowy miesiąc „od”"), 400);
  const data = b.data || {};
  if (Array.isArray(data.ignored_reasons)) data.ignored_reasons = [...new Set(data.ignored_reasons.map((x) => String(x).trim()).filter(Boolean))];
  try {
    const err = prm.checkParams(data, await prm.statuses());
    if (err) return fail(res, new Error(err), 400);
    const clean = prm.paramsOf(data);
    await db.query(
      `INSERT INTO prm.params (valid_from, data, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (valid_from) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [b.valid_from, JSON.stringify(clean), req.ps.me]);
    await prm.log(req.ps.me, "params", b.valid_from, clean);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

router.delete("/params/:from", requireFull, async (req, res) => {
  try {
    const n = await db.query(`SELECT count(*)::int AS n FROM prm.params`);
    if (n.rows[0].n <= 1) return fail(res, new Error("To jedyny zestaw parametrów"), 409);
    const r = await db.query(`DELETE FROM prm.params WHERE valid_from = $1 RETURNING data`, [req.params.from]);
    if (!r.rows.length) return fail(res, new Error("Nie znaleziono"), 404);
    await prm.log(req.ps.me, "params_delete", req.params.from, r.rows[0].data);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

router.put("/settings", requireFull, async (req, res) => {
  const v = req.body && req.body.notify_tg;
  if (v !== "0" && v !== "1") return fail(res, new Error("notify_tg: 0 lub 1"), 400);
  try {
    await db.query(`INSERT INTO prm.settings (key, value) VALUES ('notify_tg', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
    await prm.log(req.ps.me, "settings", null, { notify_tg: v });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Доступ ────────────────────────────────────────────────────────────
router.put("/access", requireFull, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isInteger) : [];
  const level = b.level == null || b.level === "" ? null : b.level;
  if (!ids.length) return fail(res, new Error("Nie wybrano koordynatorów"), 400);
  if (level !== null && !LEVELS.includes(level)) return fail(res, new Error("Nieznany poziom dostępu"), 400);
  try {
    if (level === null) await db.query(`DELETE FROM prm.access WHERE coordinator_id = ANY($1::int[])`, [ids]);
    else
      await db.query(
        `INSERT INTO prm.access (coordinator_id, level, updated_by)
         SELECT id, $2, $3 FROM public.coordinators WHERE id = ANY($1::int[])
         ON CONFLICT (coordinator_id) DO UPDATE SET level = EXCLUDED.level, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [ids, level, req.ps.me]);
    await prm.log(req.ps.me, "access", null, { ids, level });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Затвердження, виплата, повідомлення ──────────────────────────────
router.post("/month/:m/approve", requireFull, async (req, res) => {
  try {
    const r = await prm.approve(req.params.m, req.ps.me);
    if (!r.ok) return fail(res, new Error(r.error), 409);
    let notified = null;
    if ((await prm.settings()).notify_tg === "1") notified = await prm.notify(req.app.get("bot"), req.params.m, req.ps.me);
    res.json({ ok: true, total: r.total, n: r.n, notified });
  } catch (e) { fail(res, e); }
});
router.post("/month/:m/unapprove", requireFull, async (req, res) => {
  try {
    const r = await prm.unapprove(req.params.m, req.ps.me);
    if (!r.ok) return fail(res, new Error(r.error), 409);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.post("/month/:m/paid", requireFull, async (req, res) => {
  const paid = !!(req.body && req.body.paid);
  try {
    const r = await prm.setPaid(req.params.m, paid, req.ps.me);
    if (!r.ok) return fail(res, new Error(r.error), 409);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
router.post("/month/:m/notify", requireFull, async (req, res) => {
  try {
    const r = await prm.notify(req.app.get("bot"), req.params.m, req.ps.me, !!(req.body && req.body.force));
    if (!r.ok) return fail(res, new Error(r.error), 409);
    res.json(r);
  } catch (e) { fail(res, e); }
});

// Журнал змін
router.get("/log", requireFull, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT l.id, to_char(l.at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS at, c.full_name AS by_name,
              l.action, l.month, l.details
         FROM prm.log l LEFT JOIN public.coordinators c ON c.id = l.by_id
        ORDER BY l.id DESC LIMIT 200`);
    res.json({ ok: true, data: r.rows });
  } catch (e) { fail(res, e); }
});

module.exports = { router, _test: { scoped } };
