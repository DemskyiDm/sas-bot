// api/tg.js — мініпанель у Telegram (public/tg/) і привʼязка Telegram у панелі.
//
//   POST /api/tg/auth          { initData }  → вхід без пароля: підпис Telegram (HMAC з BOT_TOKEN) + привʼязаний чат
//   GET  /api/tg/home          цифри дня: приїзди, останні дні, без годин, що чекає рішення, план набору
//   GET  /api/tg/facilities    обʼєкти координатора (для годин)
//   GET  /api/tg/hours         ?facility_id=&from=&to=  години за кілька днів (дати рядками, без зсуву часового поясу)
//   POST /api/tg/remind/:id    нагадати працівнику в боті про пропущені дні (як щогодинне нагадування)
//   POST /api/tg/lang          { lang: uk|ru }
//   — панель (звичайний вхід) —
//   GET  /api/tg/status        чи привʼязаний Telegram
//   POST /api/tg/link-code     одноразове посилання на бота (30 хв)
//   POST /api/tg/unlink        відвʼязати
//
// Монтувати в index.js ДО app.use("/api", apiRoutes):  app.use("/api/tg", require("./api/tg").router);
// Години правляться звичайним POST /api/hours (сесія та сама), права — як у панелі.
"use strict";

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { sessions } = require("./admin");

const router = express.Router();
const coord = () => require("../bot/coord");

// ── Підпис Telegram WebApp (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) ──
const INIT_MAX_AGE_S = 24 * 60 * 60;
function verifyInitData(initData, botToken, nowS) {
  if (!initData || !botToken) return null;
  let params;
  try { params = new URLSearchParams(String(initData)); } catch (e) { return null; }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(calc, "hex"), Buffer.from(hash.toLowerCase(), "hex"))) return null;
  const authDate = Number(params.get("auth_date") || 0);
  const now = nowS || Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > INIT_MAX_AGE_S || authDate - now > 300) return null;
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
  if (!user || !user.id) return null;
  return { user, authDate, startParam: params.get("start_param") || null };
}

// ── Вебхук: заголовок X-Telegram-Bot-Api-Secret-Token = WEBHOOK_SECRET (задається в setWebhook, set-webhook.js) ──
// Без секрету в .env — пропускаємо все (як раніше); із секретом — лише запити, що його несуть.
function webhookSecretOk(given, secret) {
  if (!secret) return true;
  const a = Buffer.from(String(given || "")), b = Buffer.from(String(secret));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  const token = req.headers["x-session"] || req.query.session;
  if (!token || !sessions[token]) return res.status(401).json({ ok: false, error: "Unauthorized" });
  req.coordinator = sessions[token];
  next();
}
// Сесії панелі живуть у памʼяті сервера, а мініпанель входить при кожному відкритті —
// тримаємо до 3 останніх сесій Telegram на координатора (телефон, компʼютер…), старіші прибираємо.
const TG_TOKENS = new Map();
const TG_KEEP = 3;
const fail = (res, e) => {
  console.error("[tg api]", e.message);
  res.status(500).json({ ok: false, error: e.message });
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── Вхід без пароля ───────────────────────────────────────────────────
router.post("/auth", async (req, res) => {
  try {
    const v = verifyInitData(req.body && req.body.initData, process.env.BOT_TOKEN);
    if (!v) return res.status(401).json({ ok: false, error: "bad_init" });
    const c = await coord().coordByChat(v.user.id);
    if (!c) return res.status(403).json({ ok: false, error: "not_linked" });
    const a = await db.query(
      `SELECT id, username, is_admin FROM coordinator_auth WHERE coordinator_id = $1 ORDER BY is_admin DESC, id LIMIT 1`, [c.id]);
    if (!a.rows[0]) return res.status(403).json({ ok: false, error: "no_account" });
    await db.query(`UPDATE coordinator_auth SET last_login = now() WHERE id = $1`, [a.rows[0].id]).catch(() => {});
    const token = crypto.randomBytes(32).toString("hex");
    const list = (TG_TOKENS.get(c.id) || []).concat(token);
    while (list.length > TG_KEEP) delete sessions[list.shift()];
    TG_TOKENS.set(c.id, list);
    sessions[token] = {
      coordinator_id: c.id,
      username: a.rows[0].username,
      full_name: c.full_name,
      role: c.role,
      is_admin: a.rows[0].is_admin,
    };
    res.json({ ok: true, token, user: sessions[token], lang: coord().langOf(c) });
  } catch (e) { fail(res, e); }
});

async function me(req) {
  const c = await coord().coordById(req.coordinator.coordinator_id);
  if (!c) throw new Error("coordinator not found");
  c.is_admin = !!req.coordinator.is_admin;
  return c;
}

// ── Головна ───────────────────────────────────────────────────────────
router.get("/home", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const [d, medAccess] = await Promise.all([coord().digestData(c), require("../bot/office").medAccess(c)]);
    res.json({
      ok: true, lang: coord().langOf(c), full_name: c.full_name, linked: !!c.telegram_chat_id,
      digest: c.digest, advance_std: coord().CFG.advanceStd, med_access: medAccess, ...d,
    });
  } catch (e) { fail(res, e); }
});

router.get("/facilities", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const f = await coord().facsOf(c);
    let rows = f.rows || [];
    if (f.scope === "all") {
      rows = (await db.query(`SELECT id AS facility_id, name, group_name FROM facilities WHERE is_active ORDER BY name`)).rows
        .map((x) => ({ ...x, can_edit: f.edit === null || f.edit.includes(x.facility_id) }));
    }
    res.json({ ok: true, scope: f.scope, scopes: f.avail,
      data: rows.map((x) => ({ id: x.facility_id, name: x.name, group_name: x.group_name, can_edit: c.is_admin || !!x.can_edit })) });
  } catch (e) { fail(res, e); }
});

// Години за період (до 31 дня) по обʼєкту: хто працював на обʼєкті в ці дні + записи (дати рядками)
router.get("/hours", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const fac = parseInt(req.query.facility_id, 10);
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!fac || !ISO.test(from) || !ISO.test(to) || from > to) return res.status(400).json({ ok: false, error: "bad params" });
    if ((new Date(to) - new Date(from)) / 864e5 > 31) return res.status(400).json({ ok: false, error: "max 31 days" });
    const f = await coord().facsOf(c);
    if (f.all && !f.all.includes(fac)) return res.status(403).json({ ok: false, error: "Forbidden" });
    const canEdit = c.is_admin || !f.edit || f.edit.includes(fac);
    const w = await db.query(
      `SELECT DISTINCT ON (w.id) w.id, w.full_name, w.login, w.telegram_chat_id IS NOT NULL AS in_bot,
              h.status::text AS status, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(h.last_work_date, 'YYYY-MM-DD') AS lwd,
              w.login LIKE 'TEST_%' AS test
         FROM worker_facility_history h JOIN workers w ON w.id = h.worker_id
        WHERE h.facility_id = $1 AND h.status::text <> 'rezygnacja'
          AND h.bhp_date <= $3::date AND (h.last_work_date IS NULL OR h.last_work_date >= $2::date)
        ORDER BY w.id, h.bhp_date DESC`, [fac, from, to]);
    const ids = w.rows.map((x) => x.id);
    const h = ids.length ? await db.query(
      `SELECT worker_id, to_char(work_date, 'YYYY-MM-DD') AS d, hours, absence_type
         FROM hours_log WHERE worker_id = ANY($1::int[]) AND work_date BETWEEN $2::date AND $3::date`, [ids, from, to]) : { rows: [] };
    const m = ids.length ? await db.query(
      `SELECT worker_id, COALESCE(sum(hours), 0) AS total FROM hours_log
        WHERE worker_id = ANY($1::int[]) AND date_trunc('month', work_date) = date_trunc('month', $2::date) GROUP BY worker_id`, [ids, to]) : { rows: [] };
    const H = {};
    for (const x of h.rows) (H[x.worker_id] = H[x.worker_id] || {})[x.d] = { hours: x.hours == null ? null : Number(x.hours), abs: x.absence_type };
    const M = Object.fromEntries(m.rows.map((x) => [x.worker_id, Number(x.total)]));
    const gaps = new Map();
    try {
      for (const g of await require("../bot/gaps").findGapWorkers()) gaps.set(g.worker_id, g.dates.length);
    } catch (e) { /* без нагадувань */ }
    const data = w.rows
      .map((x) => ({ id: x.id, full_name: x.full_name, status: x.status, bhp: x.bhp, lwd: x.lwd, in_bot: x.in_bot, test: x.test,
        month: M[x.id] || 0, gap: gaps.get(x.id) || 0, days: H[x.id] || {} }))
      .sort((a, b) => (b.gap > 0) - (a.gap > 0) || a.full_name.localeCompare(b.full_name));
    res.json({ ok: true, can_edit: canEdit, from, to, data });
  } catch (e) { fail(res, e); }
});

// Нагадування працівнику (лише якщо в нього серія пропущених днів, GAP_MIN_DAYS — як щогодинне нагадування з кнопками днів)
router.post("/remind/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const routes = require("./routes");
    if (!(await routes.workerInEditScope(req.coordinator, id))) return res.status(403).json({ ok: false, error: "Forbidden" });
    const bot = req.app.get("bot");
    if (!bot) return res.json({ ok: false, error: "no bot" });
    const r = await require("../bot/gaps").sendGapSpam(bot, { workerId: id, ignoreHours: true, force: true });
    if (r && r.sent) return res.json({ ok: true, sent: r.sent });
    const why = !r ? "error" : r.skipped ? r.skipped : r.notInBot ? "not_in_bot" : r.candidates === 0 ? "no_gaps" : r.blocked ? "blocked" : r.error || "not_sent";
    res.json({ ok: false, error: why });
  } catch (e) { fail(res, e); }
});

// Зріз: own — свої обʼєкти, region — регіон (для регіональних), all — уся фірма (адмін / керівник)
router.post("/scope", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const want = String((req.body && req.body.scope) || "");
    const f = await coord().facsOf(c, want);
    if (f.scope !== want) return res.status(400).json({ ok: false, error: "scope not available", scopes: f.avail });
    await db.query(`INSERT INTO tgc.prefs (coordinator_id, lang, scope) VALUES ($1, $2, $3)
                    ON CONFLICT (coordinator_id) DO UPDATE SET scope = EXCLUDED.scope, updated_at = now()`,
      [c.id, coord().langOf(c), want]);
    res.json({ ok: true, scope: want, scopes: f.avail });
  } catch (e) { fail(res, e); }
});

// Аванси / вихідні в мініпанелі
router.get("/requests", requireAuth, async (req, res) => {
  try {
    const kind = req.query.kind === "dof" ? "dof" : "adv";
    const c = await me(req);
    res.json({ ok: true, kind, ...(await coord().listRequests(c, kind, req.query.status === "all" ? "all" : "pending")) });
  } catch (e) { fail(res, e); }
});
// Рішення: ті самі функції, що в панелі (права — головний обʼєкт / адмін), причина відмови — як у боті
const REASON_CODES = { adv: ["hours", "had", "leaving"], dof: ["staff", "late"] };
router.post("/decide", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const kind = b.kind === "dof" ? "dof" : "adv";
    const status = b.status === "approved" ? "approved" : b.status === "rejected" ? "rejected" : null;
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 100);
    if (!status || !ids.length) return res.status(400).json({ ok: false, error: "bad params" });
    const reason = status === "rejected" && REASON_CODES[kind].includes(b.reason) ? b.reason : null;
    const routes = require("./routes");
    const fn = kind === "adv" ? routes.decideAdvance : routes.decideDayOff;
    const done = [], failed = [];
    for (const id of ids) {
      // лише заявки, що ще чекають (двоє координаторів одночасно — друге натискання нічого не міняє)
      const t = kind === "adv" ? "advances" : "day_off_requests";
      const p = await db.query(`SELECT status::text AS s FROM ${t} WHERE id = $1`, [id]);
      if (!p.rows[0] || p.rows[0].s !== "pending") { failed.push({ id, error: "decided" }); continue; }
      const r = await fn(req.coordinator, id, status, null, reason);
      if (r.ok) done.push(id); else failed.push({ id, error: "forbidden" });
    }
    res.json({ ok: failed.length === 0, done, failed });
  } catch (e) { fail(res, e); }
});

// ── Листи в офіс (bot/office.js, пошта — api/mail.js): kind=adv — аванси, kind=med — замовлення медогляду ──
// Ті самі запити — з мініпанелі й з веб-панелі (public/js/office.js). scope (необовʼязково) — зріз лише для цього запиту.
const office = () => require("../bot/office");
const kindOf = (k) => (k === "med" || k === "fin" ? k : "adv");
async function scoped(req, c) {
  const want = String(req.query.scope || (req.body && req.body.scope) || "");
  return coord().facsOf(c, ["own", "region", "all"].includes(want) ? want : undefined);
}
// Панель «Badania lekarskie» — лише кому увімкнено (Ustawienia badań); адмін / head і регіональні — завжди
const MED_OFF = { ok: false, error: "med_off" };
router.get("/office/med-access", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const [access, manage] = await Promise.all([office().medAccess(c), office().medManager(c)]);
    res.json({ ok: true, access, manage: !!manage });
  } catch (e) { fail(res, e); }
});
router.get("/office/med-settings", requireAuth, async (req, res) => {
  try {
    const r = await office().medSettings(await me(req));
    if (!r) return res.status(403).json({ ok: false, error: "forbidden" });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});
router.post("/office/med-settings/coord", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await office().medSaveCoord(await me(req), b.coordinator_id, !!b.enabled);
    res.status(r.ok ? 200 : r.error === "forbidden" ? 403 : 400).json(r);
  } catch (e) { fail(res, e); }
});
router.post("/office/med-settings/facility", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await office().medSaveFacility(await me(req), b.facility_id, b.kind, b.address);
    res.status(r.ok ? 200 : r.error === "forbidden" ? 403 : 400).json(r);
  } catch (e) { fail(res, e); }
});

router.get("/office", requireAuth, async (req, res) => {
  try {
    const kind = kindOf(req.query.kind);
    const c = await me(req);
    if (kind === "med" && !(await office().medAccess(c))) return res.status(403).json(MED_OFF);
    const f = await scoped(req, c);
    let items, range = null;
    if (kind === "med") {
      range = office().medRange(req.query.from, req.query.to);
      if (range.error) return res.status(400).json({ ok: false, error: range.error });
      items = await office().medList(c, f, range);
    } else if (kind === "fin") {
      items = (await fines().unsent(c, f)).map((x) => ({ ...x, id: Number(x.id), ordered_at: null }));
    } else items = await office().pendingAdvances(c, f);
    const [rc, hist, my] = await Promise.all([office().recipients(c, kind), office().history(c, kind), office().myEmail(c)]);
    const m = require("./mail");
    res.json({
      ok: true, kind, configured: m.configured(), mail: m.status(), from: m.fromAddress(), is_admin: !!c.is_admin,
      scope: f.scope, scopes: f.avail, advance_std: coord().CFG.advanceStd, window_days: office().WINDOW_DAYS,
      range, my_email: my, items, recipients: rc.list, last: rc.last, history: hist,
    });
  } catch (e) { fail(res, e); }
});
router.post("/office/recipients", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await office().addRecipient(await me(req), b.email, b.name, !!b.shared, kindOf(b.kind));
    res.status(r.ok ? 200 : 400).json(r);
  } catch (e) { fail(res, e); }
});
router.delete("/office/recipients/:id", requireAuth, async (req, res) => {
  try {
    res.json(await office().removeRecipient(await me(req), parseInt(req.params.id, 10)));
  } catch (e) { fail(res, e); }
});
router.post("/office/send", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const c = await me(req);
    if (kindOf(b.kind) === "med" && !(await office().medAccess(c))) return res.status(403).json(MED_OFF);
    const r = await office().send(kindOf(b.kind), c, b.ids, b.to, await scoped(req, c));
    res.status(r.ok ? 200 : r.error === "send_failed" ? 502 : 400).json(r);
  } catch (e) { fail(res, e); }
});

// ── Штрафи (bot/fines.js): виписка з картки працівника (мініпанель) і з веб-панелі (Kary) ──
const fines = () => require("../bot/fines");
const FIN_CODE = { forbidden: 403, not_found: 404, sent_admin_only: 403 };
const finOut = (res, r) => res.status(r.ok ? 200 : FIN_CODE[r.error] || 400).json(r);
router.get("/fines", requireAuth, async (req, res) => {
  try { res.json(await fines().page(await me(req), req.query || {})); } catch (e) { fail(res, e); }
});
router.get("/fines/search", requireAuth, async (req, res) => {
  try { res.json({ ok: true, rows: await fines().search(await me(req), req.query.q) }); } catch (e) { fail(res, e); }
});
router.get("/fines/worker/:id", requireAuth, async (req, res) => {
  try { finOut(res, await fines().workerInfo(await me(req), req.params.id)); } catch (e) { fail(res, e); }
});
router.get("/fines/types", requireAuth, async (req, res) => {
  try {
    const c = await me(req);
    const all = fines().isManager(c);
    res.json({ ok: true, types: await fines().types(all), can_manage: all });
  } catch (e) { fail(res, e); }
});
router.post("/fines/types", requireAuth, async (req, res) => {
  try { finOut(res, await fines().saveType(await me(req), req.body || {})); } catch (e) { fail(res, e); }
});
router.post("/fines", requireAuth, async (req, res) => {
  try { finOut(res, await fines().issue(await me(req), req.body || {})); } catch (e) { fail(res, e); }
});
router.post("/fines/:id/update", requireAuth, async (req, res) => {
  try { finOut(res, await fines().update(await me(req), req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});
router.post("/fines/:id/cancel", requireAuth, async (req, res) => {
  try { finOut(res, await fines().cancel(await me(req), req.params.id, (req.body || {}).reason)); } catch (e) { fail(res, e); }
});

router.post("/lang", requireAuth, async (req, res) => {
  try {
    const lang = req.body && req.body.lang === "ru" ? "ru" : "uk";
    await db.query(`INSERT INTO tgc.prefs (coordinator_id, lang) VALUES ($1, $2)
                    ON CONFLICT (coordinator_id) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`,
      [req.coordinator.coordinator_id, lang]);
    res.json({ ok: true, lang });
  } catch (e) { fail(res, e); }
});

// ── Панель: привʼязка Telegram ─────────────────────────────────────────
router.get("/status", requireAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT telegram_chat_id FROM public.coordinators WHERE id = $1`, [req.coordinator.coordinator_id]);
    res.json({ ok: true, linked: !!(r.rows[0] && r.rows[0].telegram_chat_id), webapp: !!coord().CFG.webapp, bot: await coord().botUsername() });
  } catch (e) { fail(res, e); }
});
router.post("/link-code", requireAuth, async (req, res) => {
  try {
    const x = await coord().createLinkCode(req.coordinator.coordinator_id);
    if (!x.link) return res.status(503).json({ ok: false, error: "Bot niedostępny (getMe) — sprawdź BOT_TOKEN" });
    res.json({ ok: true, link: x.link, ttl_min: x.ttl_min });
  } catch (e) { fail(res, e); }
});
router.post("/unlink", requireAuth, async (req, res) => {
  try {
    const old = await db.query(`SELECT telegram_chat_id FROM public.coordinators WHERE id = $1`, [req.coordinator.coordinator_id]);
    const chat = old.rows[0] && old.rows[0].telegram_chat_id;
    await db.query(`UPDATE public.coordinators SET telegram_chat_id = NULL WHERE id = $1`, [req.coordinator.coordinator_id]);
    if (chat) await coord().clearMenuButton(chat).catch(() => {});
    res.json({ ok: true, unlinked: !!chat });
  } catch (e) { fail(res, e); }
});

module.exports = { router, verifyInitData, webhookSecretOk };
