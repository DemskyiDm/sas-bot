// ══════════════════════════════════════════════════════════════════════
//  Rekrutacja → 📣 Wysyłka wiadomości — розсилка працівникам через бота.
//  app.use("/api/broadcast", broadcast.router); broadcast.schedule(bot)
//
//  Кому (audience.mode):
//    workers  — вибрані люди (ids — worker id), незалежно від статусу
//    facility — ті, хто працює зараз на вибраних закладах (ids — facility id)
//    region   — ті, хто працює зараз в обʼєктах вибраних регіонів (ids — region id)
//    inactive — ті, хто зараз не працює; ids — регіони останнього місця (порожньо = усі),
//               since — останній день роботи не раніше цієї дати (порожньо = будь-коли)
//  «Працює» = поточний запис (v_worker_current) зі статусом pracuje і без закінченого last_work_date.
//  Лист отримують лише ті, хто має Telegram (workers.telegram_chat_id); TEST_ — ніколи.
//
//  Доступ: адмін / head — уся фірма; регіональний — заклади своїх регіонів. Координатори — ні.
//  Таблиці: db/migration_broadcast.sql
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");

router.use(requireAuth);

const MAX_TEXT = 4000;            // ліміт Telegram — 4096 символів
const LANGS = ["uk", "ru", "pl"];
const MODES = ["workers", "facility", "region", "inactive"];

const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[broadcast api]", e);
  res.status(e.code || code).json({ ok: false, error: e.message || String(e) });
};
const bad = (msg) => Object.assign(new Error(msg), { code: 400 });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const ints = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];

// ── Доступ ────────────────────────────────────────────────────────────
// { role: all | lead | none, me, facilityIds: null (усе) | [id…], regionIds: null | [id…] }
async function scopeOf(c) {
  const me = c.coordinator_id;
  if (c.is_admin || c.role === "head") return { role: "all", me, facilityIds: null, regionIds: null };
  const r = await db.query(
    `SELECT rl.region_id FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
      WHERE rl.coordinator_id = $1 AND rg.is_active`, [me]).catch(() => ({ rows: [] }));
  if (!r.rows.length) return { role: "none", me, facilityIds: [], regionIds: [] };
  const regionIds = r.rows.map((x) => Number(x.region_id));
  const f = await db.query(
    `SELECT f.id FROM facilities f
       JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
      WHERE so.region_id = ANY($1::int[])`, [regionIds]);
  return { role: "lead", me, facilityIds: f.rows.map((x) => Number(x.id)), regionIds };
}
router.use(async (req, res, next) => {
  try { req.bs = await scopeOf(req.coordinator); } catch (e) { return fail(res, e); }
  if (req.path === "/me") return next();
  if (req.bs.role === "none") return res.status(403).json({ ok: false, error: "Brak dostępu" });
  next();
});

router.get("/me", (req, res) => res.json({ ok: true, has_access: req.bs.role !== "none", role: req.bs.role }));

// ── Аудиторія ─────────────────────────────────────────────────────────
// Працівники з поточним місцем, регіоном і ознакою «працює»; $1 — заклади в межах доступу (null = усі)
const PEOPLE_SQL = `
  WITH cur AS (
    SELECT w.id, w.full_name, w.login, w.telegram_chat_id, w.lang,
           v.facility_id, v.status, v.bhp_date, v.last_work_date,
           COALESCE(v.status = 'pracuje' AND (v.last_work_date IS NULL OR v.last_work_date >= CURRENT_DATE), false) AS working
      FROM workers w
      LEFT JOIN v_worker_current v ON v.id = w.id
     WHERE COALESCE(w.login, '') NOT LIKE 'TEST_%'
  )
  SELECT cur.*, f.name AS facility, f.group_name, so.region_id, rg.name AS region,
         to_char(COALESCE(cur.last_work_date, cur.bhp_date), 'YYYY-MM-DD') AS last_day
    FROM cur
    LEFT JOIN facilities f      ON f.id = cur.facility_id
    LEFT JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
    LEFT JOIN reg.regions rg    ON rg.id = so.region_id
   WHERE ($1::int[] IS NULL OR cur.facility_id = ANY($1::int[]))`;

function audienceOf(b) {
  const a = b && typeof b === "object" ? b : {};
  const mode = MODES.includes(a.mode) ? a.mode : null;
  if (!mode) throw bad("Wybierz, do kogo wysłać");
  const ids = ints(a.ids);
  if (mode !== "inactive" && !ids.length) throw bad("Nic nie wybrano");
  return { mode, ids, since: mode === "inactive" && isDate(a.since) ? a.since : null };
}
// Список отримувачів (з Telegram і без) у межах доступу
async function resolve(bs, a) {
  let where, params = [bs.facilityIds];
  if (a.mode === "workers") { where = "cur.id = ANY($2::int[])"; params.push(a.ids); }
  else if (a.mode === "facility") { where = "cur.working AND cur.facility_id = ANY($2::int[])"; params.push(a.ids); }
  else if (a.mode === "region") { where = "cur.working AND so.region_id = ANY($2::int[])"; params.push(a.ids); }
  else {
    where = `NOT cur.working AND cur.facility_id IS NOT NULL
             AND (cardinality($2::int[]) = 0 OR so.region_id = ANY($2::int[]))
             AND ($3::date IS NULL OR COALESCE(cur.last_work_date, cur.bhp_date) >= $3::date)`;
    params.push(a.ids, a.since);
  }
  // регіональний — лише свої регіони навіть для «вибраних регіонів»
  if (bs.regionIds && (a.mode === "region" || a.mode === "inactive")) {
    params.push(bs.regionIds);
    where += ` AND so.region_id = ANY($${params.length}::int[])`;
  }
  const r = await db.query(`${PEOPLE_SQL} AND ${where} ORDER BY cur.full_name`, params);
  return r.rows;
}
// Підпис для історії: «Pracujący — Notino, CEVA»
async function labelOf(a) {
  if (a.mode === "workers") return `Wybrane osoby (${a.ids.length})`;
  if (a.mode === "facility") {
    const r = await db.query(`SELECT name FROM facilities WHERE id = ANY($1::int[]) ORDER BY name`, [a.ids]);
    return `Pracujący — ${r.rows.map((x) => x.name).join(", ")}`;
  }
  const names = a.ids.length
    ? (await db.query(`SELECT name FROM reg.regions WHERE id = ANY($1::int[]) ORDER BY name`, [a.ids])).rows.map((x) => x.name).join(", ")
    : "";
  if (a.mode === "region") return `Pracujący w regionie — ${names}`;
  return `Niepracujący${names ? ` — ${names}` : ""}${a.since ? ` · ostatni dzień od ${a.since.split("-").reverse().join(".")}` : ""}`;
}
function textsOf(b) {
  const body = String((b && b.body) || "").trim();
  if (!body) throw bad("Wpisz treść wiadomości");
  const texts = {};
  LANGS.forEach((l) => { const t = String((b.texts && b.texts[l]) || "").trim(); if (t) texts[l] = t; });
  if ([body, ...Object.values(texts)].some((t) => t.length > MAX_TEXT)) throw bad(`Wiadomość jest za długa (max ${MAX_TEXT} znaków)`);
  return { body, texts };
}
const textFor = (m, lang) => (m.texts && m.texts[lang]) || m.body;

// Довідники для вибору: заклади (з обʼєктом і регіоном) і регіони — у межах доступу
router.get("/options", async (req, res) => {
  try {
    const [fac, reg] = await Promise.all([
      db.query(
        `SELECT f.id, f.name, COALESCE(f.group_name, f.name) AS group_name, rg.name AS region, so.region_id,
                c.full_name AS coordinator,
                (SELECT COUNT(*)::int FROM v_worker_current v
                  WHERE v.facility_id = f.id AND v.status = 'pracuje' AND (v.last_work_date IS NULL OR v.last_work_date >= CURRENT_DATE)) AS working
           FROM facilities f
           LEFT JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
           LEFT JOIN reg.regions rg    ON rg.id = so.region_id
           LEFT JOIN coordinators c    ON c.id = so.coordinator_id
          WHERE ($1::int[] IS NULL OR f.id = ANY($1::int[]))`, [req.bs.facilityIds]),
      db.query(`SELECT id, name FROM reg.regions WHERE is_active AND ($1::int[] IS NULL OR id = ANY($1::int[])) ORDER BY name`, [req.bs.regionIds]),
    ]);
    // порядок: регіон → координатор → обʼєкт → заклад (як у звітах)
    const pl = (a, b) => (a == null) - (b == null) || String(a || "").localeCompare(String(b || ""), "pl");
    const facilities = fac.rows.sort((a, b) => pl(a.region, b.region) || pl(a.coordinator, b.coordinator)
      || pl(a.group_name, b.group_name) || pl(a.name, b.name));
    res.json({ ok: true, role: req.bs.role, facilities, regions: reg.rows, max_text: MAX_TEXT });
  } catch (e) { fail(res, e); }
});

// Пошук людей для «вибраних осіб»
router.get("/workers", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, rows: [] });
    const r = await db.query(
      `${PEOPLE_SQL} AND (cur.full_name ILIKE $2 OR cur.login ILIKE $2) ORDER BY cur.working DESC, cur.full_name LIMIT 30`,
      [req.bs.facilityIds, `%${q.replace(/[%_\\]/g, "\\$&")}%`]);
    res.json({ ok: true, rows: r.rows.map(personOut) });
  } catch (e) { fail(res, e); }
});
const personOut = (x) => ({
  id: x.id, full_name: x.full_name, login: x.login, facility: x.facility, region: x.region,
  status: x.status, working: x.working, last_day: x.last_day, has_tg: !!x.telegram_chat_id, lang: x.lang,
});

// Попередній перегляд: скільки отримають, хто без Telegram
router.post("/audience", async (req, res) => {
  try {
    const a = audienceOf(req.body && req.body.audience);
    const rows = await resolve(req.bs, a);
    const withTg = rows.filter((x) => x.telegram_chat_id);
    const langs = {};
    withTg.forEach((x) => { const l = LANGS.includes(x.lang) ? x.lang : "inne"; langs[l] = (langs[l] || 0) + 1; });
    res.json({ ok: true, total: rows.length, with_tg: withTg.length, without_tg: rows.length - withTg.length, langs,
      rows: rows.slice(0, 500).map(personOut), more: Math.max(0, rows.length - 500) });
  } catch (e) { fail(res, e, 400); }
});

// Тест — собі в Telegram (coordinators.telegram_chat_id)
router.post("/test", async (req, res) => {
  try {
    const t = textsOf(req.body);
    const lang = LANGS.includes(req.body.lang) ? req.body.lang : null;
    const c = await db.query(`SELECT telegram_chat_id FROM coordinators WHERE id = $1`, [req.bs.me]);
    const chat = c.rows[0] && c.rows[0].telegram_chat_id;
    if (!chat) throw bad("Nie masz podłączonego Telegrama w panelu (Admin → koordynatorzy)");
    if (!BOT) throw new Error("Bot niedostępny");
    await BOT.telegram.sendMessage(chat, textFor(t, lang), { disable_web_page_preview: false });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 400); }
});

// Відправка: створює розсилку і чергу; expected — скільки бачив у попередньому перегляді (захист від «раптом інші люди»)
router.post("/send", async (req, res) => {
  const client = await db.pool.connect();
  try {
    const a = audienceOf(req.body && req.body.audience);
    const t = textsOf(req.body);
    const rows = (await resolve(req.bs, a)).filter((x) => x.telegram_chat_id);
    if (!rows.length) throw bad("Nikt z wybranych nie ma Telegrama");
    if (req.body.expected != null && Number(req.body.expected) !== rows.length) {
      throw bad(`Lista odbiorców się zmieniła (teraz ${rows.length}) — sprawdź podgląd i wyślij ponownie`);
    }
    const label = await labelOf(a);
    await client.query("BEGIN");
    const m = await client.query(
      `INSERT INTO bc.messages (body, texts, audience, audience_label, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [t.body, t.texts, a, label, req.bs.me]);
    const id = m.rows[0].id;
    await client.query(
      `INSERT INTO bc.deliveries (message_id, worker_id, chat_id, lang)
       SELECT $1, x.worker_id, x.chat_id, x.lang FROM unnest($2::int[], $3::bigint[], $4::text[]) AS x(worker_id, chat_id, lang)
       ON CONFLICT DO NOTHING`,
      [id, rows.map((x) => x.id), rows.map((x) => x.telegram_chat_id), rows.map((x) => x.lang || null)]);
    await client.query("COMMIT");
    console.log(`[broadcast] #${id} by coordinator ${req.bs.me}: ${rows.length} — ${label}`);
    kick();
    res.json({ ok: true, id, count: rows.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    fail(res, e, 400);
  } finally {
    client.release();
  }
});

// Історія: адмін — усі розсилки, регіональний — свої
const STATS_SQL = `
  SELECT m.id, m.body, m.texts, m.audience_label, m.status, m.created_at, m.finished_at, c.full_name AS author,
         COUNT(d.*)::int AS total,
         COUNT(*) FILTER (WHERE d.status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE d.status = 'queued')::int AS queued,
         COUNT(*) FILTER (WHERE d.status IN ('failed', 'blocked'))::int AS failed,
         COUNT(*) FILTER (WHERE d.status = 'cancelled')::int AS cancelled
    FROM bc.messages m
    LEFT JOIN bc.deliveries d ON d.message_id = m.id
    LEFT JOIN coordinators c  ON c.id = m.created_by`;
router.get("/messages", async (req, res) => {
  try {
    const mine = req.bs.role !== "all";
    const r = await db.query(`${STATS_SQL} ${mine ? "WHERE m.created_by = $1" : ""} GROUP BY m.id, c.full_name ORDER BY m.id DESC LIMIT 100`,
      mine ? [req.bs.me] : []);
    res.json({ ok: true, rows: r.rows });
  } catch (e) { fail(res, e); }
});
async function ownMessage(bs, id) {
  const r = await db.query(`${STATS_SQL} WHERE m.id = $1 GROUP BY m.id, c.full_name`, [id]);
  const m = r.rows[0];
  if (!m) throw Object.assign(new Error("Nie ma takiej wysyłki"), { code: 404 });
  if (bs.role !== "all") {
    const o = await db.query(`SELECT created_by FROM bc.messages WHERE id = $1`, [id]);
    if (o.rows[0].created_by !== bs.me) throw Object.assign(new Error("Brak dostępu"), { code: 403 });
  }
  return m;
}
router.get("/messages/:id", async (req, res) => {
  try {
    const m = await ownMessage(req.bs, parseInt(req.params.id, 10));
    const d = await db.query(
      `SELECT d.worker_id, d.status, d.error, d.sent_at, d.lang, w.full_name, w.login, f.name AS facility
         FROM bc.deliveries d
         JOIN workers w ON w.id = d.worker_id
         LEFT JOIN v_worker_current v ON v.id = d.worker_id
         LEFT JOIN facilities f ON f.id = v.facility_id
        WHERE d.message_id = $1
        ORDER BY (d.status = 'sent'), w.full_name`, [m.id]);
    res.json({ ok: true, message: m, rows: d.rows });
  } catch (e) { fail(res, e); }
});
router.post("/messages/:id/cancel", async (req, res) => {
  try {
    const m = await ownMessage(req.bs, parseInt(req.params.id, 10));
    await db.query(`UPDATE bc.deliveries SET status = 'cancelled' WHERE message_id = $1 AND status = 'queued'`, [m.id]);
    await db.query(`UPDATE bc.messages SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'sending'`, [m.id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
//  Черга відправки: ~20 повідомлень на секунду (ліміт Telegram — 30), 429 — чекаємо, скільки скаже Telegram
// ══════════════════════════════════════════════════════════════════════
let BOT = null;
let RUNNING = false;
const PAUSE_MS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain() {
  if (RUNNING || !BOT) return;
  RUNNING = true;
  try {
    for (;;) {
      const r = await db.query(
        `SELECT d.message_id, d.worker_id, d.chat_id, d.lang, m.body, m.texts
           FROM bc.deliveries d JOIN bc.messages m ON m.id = d.message_id
          WHERE d.status = 'queued' AND m.status = 'sending'
          ORDER BY d.message_id, d.worker_id LIMIT 50`);
      if (!r.rows.length) break;
      for (const x of r.rows) {
        let status = "sent", error = null;
        try {
          await BOT.telegram.sendMessage(String(x.chat_id), textFor(x, x.lang));
        } catch (e) {
          const code = e.response && e.response.error_code;
          if (code === 429) {   // забагато — чекаємо і пробуємо цей самий рядок ще раз
            await sleep(((e.response.parameters && e.response.parameters.retry_after) || 5) * 1000);
            break;
          }
          status = code === 403 ? "blocked" : "failed";
          error = String((e.response && e.response.description) || e.message).slice(0, 300);
        }
        await db.query(`UPDATE bc.deliveries SET status = $3, error = $4, sent_at = now() WHERE message_id = $1 AND worker_id = $2 AND status = 'queued'`,
          [x.message_id, x.worker_id, status, error]);
        await sleep(PAUSE_MS);
      }
    }
    await db.query(
      `UPDATE bc.messages m SET status = 'done', finished_at = now()
        WHERE m.status = 'sending' AND NOT EXISTS (SELECT 1 FROM bc.deliveries d WHERE d.message_id = m.id AND d.status = 'queued')`);
  } catch (e) {
    console.error("[broadcast] queue:", e.message);
  } finally {
    RUNNING = false;
  }
}
const kick = () => { drain(); };

function schedule(bot) {
  BOT = bot;
  setInterval(drain, 30 * 1000);   // підхопити чергу після перезапуску і випадкові збої
  setTimeout(drain, 10 * 1000);
}

module.exports = { router, schedule, _test: { resolve, audienceOf, labelOf, textsOf, scopeOf, drain } };
