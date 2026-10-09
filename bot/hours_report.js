// ══════════════════════════════════════════════════════════════════════
//  Звіт координаторам «хто не заповнив години»
//  (раніше — жорстко о 17:00 в index.js через handlers.sendCoordinatorReports).
//
//  Що надсилається (тексти — як раніше):
//    1) хто не заповнив години вчора;
//    2) пропуски з 1-го числа місяця ДО ВЧОРА — сьогоднішній день не рахується, він ще триває.
//       1-го числа — увесь попередній місяць.
//  Кому: активні координатори з Telegram, крім вимкнених у панелі.
//    Охоплення за замовчуванням: роль head — уся фірма, інші — свої обʼєкти (coordinator_facilities).
//    У панелі можна змінити: свої обʼєкти / регіон (Region → регіональний) / уся фірма.
//  Налаштування — схема hrep (db/migration_hours_report.sql), сторінка raport-godzin.html.
//
//  Монтується в index.js:
//    const hoursReport = require("./bot/hours_report");
//    app.use("/api/hours-report", hoursReport.router);   // перед app.use("/api", apiRoutes)
//    hoursReport.schedule(bot);                            // у кінці, біля flow.schedule(bot)
//  і прибрати старий блок `if (current === "17:00") { … sendCoordinatorReports … }`.
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../api/admin");

const hmToMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "")); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };
const dd = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Markdown (старий режим Telegram): екрануємо _ * ` [ в іменах і назвах
const md = (s) => String(s == null ? "" : s).replace(/([_*`\[])/g, "\\$1");
const SCOPES = ["own", "region", "all"];

async function getSettings() {
  const r = await db.query(`SELECT key, value FROM hrep.settings`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}
async function clock() {
  const r = await db.query(
    `SELECT to_char((now() AT TIME ZONE 'Europe/Warsaw')::date, 'YYYY-MM-DD') AS today,
            to_char((now() AT TIME ZONE 'Europe/Warsaw')::date - 1, 'YYYY-MM-DD') AS yesterday,
            to_char(now() AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') AS hm,
            EXTRACT(ISODOW FROM (now() AT TIME ZONE 'Europe/Warsaw'))::int AS dow`);
  return r.rows[0];
}

// ── Координатори і їхнє охоплення ─────────────────────────────────────
async function leadRegions() {
  try {
    const r = await db.query(
      `SELECT l.coordinator_id, string_agg(rg.name, ', ' ORDER BY rg.name) AS names
         FROM reg.region_leads l JOIN reg.regions rg ON rg.id = l.region_id
        WHERE rg.is_active GROUP BY 1`);
    return Object.fromEntries(r.rows.map((x) => [x.coordinator_id, x.names]));
  } catch (e) {
    return {};   // розділу Region немає — охоплення «регіон» недоступне
  }
}
async function coordinators() {
  const [r, leads] = await Promise.all([
    db.query(
      `SELECT c.id, c.full_name, c.role, c.telegram_chat_id::text AS chat,
              (SELECT count(*) FROM coordinator_facilities cf WHERE cf.coordinator_id = c.id)::int AS own_n,
              hr.enabled AS r_enabled, hr.scope AS r_scope
         FROM coordinators c
         LEFT JOIN hrep.recipients hr ON hr.coordinator_id = c.id
        WHERE c.is_active
        ORDER BY c.full_name`),
    leadRegions(),
  ]);
  return r.rows.map((c) => {
    const def = c.role === "head" ? "all" : "own";
    return { ...c, lead_regions: leads[c.id] || null, default_scope: def,
      scope: c.r_scope || def, enabled: c.r_enabled == null ? true : c.r_enabled };
  });
}
// Обʼєкти (facility_id) для охоплення; null = уся фірма
async function facilitiesFor(c, scope) {
  if (scope === "all") return null;
  const own = await db.query(`SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`, [c.id]);
  const ids = new Set(own.rows.map((x) => x.facility_id).filter((x) => x != null));
  if (scope === "region") {
    try {
      const r = await db.query(
        `SELECT f.id FROM facilities f
          WHERE reg.site_key(f.group_name, f.name) IN (
                SELECT o.site_key FROM reg.site_owner o
                  JOIN reg.region_leads l ON l.region_id = o.region_id
                 WHERE o.valid_to IS NULL AND l.coordinator_id = $1)`, [c.id]);
      r.rows.forEach((x) => ids.add(x.id));
    } catch (e) {
      console.error("[HoursReport] region scope:", e.message);
    }
  }
  return [...ids];
}

// ── Тексти (як у старому звіті) ───────────────────────────────────────
async function buildMessages(facIds, y, st) {
  const out = [];
  const fac = facIds == null ? null : facIds;
  if (st.yesterday_msg !== "0") {
    const r = await db.query(
      `SELECT DISTINCT w.full_name, f.name AS facility_name
         FROM worker_facility_history h
         JOIN workers w ON w.id = h.worker_id
         JOIN facilities f ON f.id = h.facility_id
        WHERE h.status::text = 'pracuje'
          AND h.bhp_date <= $1::date
          AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
          AND ($2::int[] IS NULL OR h.facility_id = ANY($2::int[]))
          AND NOT EXISTS (SELECT 1 FROM hours_log hl WHERE hl.worker_id = w.id AND hl.work_date = $1::date)
        ORDER BY f.name, w.full_name`, [y, fac]);
    if (!r.rows.length) out.push(`✅ *Вчора (${dd(y)})*\nВсі заповнили години!`);
    else {
      const byFac = {};
      r.rows.forEach((x) => { (byFac[x.facility_name] = byFac[x.facility_name] || []).push(x.full_name); });
      const lines = Object.entries(byFac).map(([f, names]) =>
        `\n🏭 *${md(f)}* (${names.length}):\n` + names.map((n) => `  • ${md(n)}`).join("\n")).join("\n");
      out.push(`⚠️ *Не заповнили вчора (${dd(y)})*\nВсього: ${r.rows.length}\n${lines}`);
    }
  }
  if (st.month_msg !== "0") {
    // з 1-го числа місяця вчорашнього дня по вчора включно (1-го числа — увесь попередній місяць)
    const from = y.slice(0, 8) + "01";
    const r = await db.query(
      `SELECT w.full_name, f.name AS facility_name,
              ARRAY(SELECT to_char(gs::date, 'DD.MM')
                      FROM generate_series($1::date, $2::date, interval '1 day') gs
                     WHERE gs::date >= h.bhp_date
                       AND (h.last_work_date IS NULL OR gs::date <= h.last_work_date)
                       AND NOT EXISTS (SELECT 1 FROM hours_log hl WHERE hl.worker_id = w.id AND hl.work_date = gs::date)
                     ORDER BY gs) AS missing_dates
         FROM worker_facility_history h
         JOIN workers w ON w.id = h.worker_id
         JOIN facilities f ON f.id = h.facility_id
        WHERE h.status::text = 'pracuje'
          AND h.bhp_date <= $2::date
          AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
          AND ($3::int[] IS NULL OR h.facility_id = ANY($3::int[]))
        ORDER BY f.name, w.full_name`, [from, y, fac]);
    const withMissing = r.rows.filter((x) => (x.missing_dates || []).length);
    if (!withMissing.length) out.push(`✅ *Місяць (${dd(from)}–${dd(y)})*\nНемає пропусків!`);
    else {
      const byFac = {};
      withMissing.forEach((x) => {
        (byFac[x.facility_name] = byFac[x.facility_name] || []).push(`  • ${md(x.full_name)}: ${x.missing_dates.join(", ")}`);
      });
      const lines = Object.entries(byFac).map(([f, items]) => `\n🏭 *${md(f)}*:\n` + items.join("\n")).join("\n");
      out.push(`📋 *Пропуски з початку місяця (${dd(from)}–${dd(y)}, без сьогодні)*\nПрацівників: ${withMissing.length}\n${lines}`);
    }
  }
  return out;
}

// ── Telegram ──────────────────────────────────────────────────────────
let BOT = null;
async function sendMd(chatId, text) {
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > 3900) { parts.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    try {
      await BOT.telegram.sendMessage(chatId, p, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch (e) {
      // розмітка не пройшла — шлемо простим текстом, щоб звіт не загубився
      if (!/parse|entit/i.test(e.message)) throw e;
      await BOT.telegram.sendMessage(chatId, p.replace(/\\([_*`\[])/g, "$1").replace(/\*/g, ""), { disable_web_page_preview: true });
    }
    if (parts.length > 1) await sleep(300);
  }
}

// Звіт усім (або одному — тест). opts: { day, only: coordinator_id, toChat, prefix }
async function sendAll(opts = {}) {
  if (!BOT) throw new Error("Bot niedostępny");
  const st = await getSettings();
  const ck = await clock();
  const y = opts.day ? opts.day : ck.yesterday;
  let list = await coordinators();
  if (opts.only) list = list.filter((c) => c.id === Number(opts.only));
  let sent = 0, failed = 0, skipped = 0;
  for (const c of list) {
    if (!opts.only && (!c.enabled || !c.chat)) { skipped++; continue; }
    const facIds = await facilitiesFor(c, c.scope);
    if (facIds && !facIds.length) { skipped++; continue; }   // немає обʼєктів — як раніше, пропускаємо
    try {
      const msgs = await buildMessages(facIds, y, st);
      const chat = opts.toChat || c.chat;
      for (let i = 0; i < msgs.length; i++) {
        await sendMd(chat, (i === 0 && opts.prefix ? opts.prefix : "") + msgs[i]);
        await sleep(400);
      }
      sent++;
    } catch (e) {
      failed++;
      console.error("[HoursReport]", c.full_name, e.message);
    }
  }
  return { sent, failed, skipped };
}

// ── Планувальник: раз на хвилину; запізнення до 2 годин (перезапуск сервера) ──
async function tick() {
  const st = await getSettings();
  if (st.enabled !== "1") return;
  const ck = await clock();
  const days = String(st.days || "").split(",").map(Number);
  if (!days.includes(ck.dow)) return;
  const at = hmToMin(st.time), now = hmToMin(ck.hm);
  if (at == null || now < at || now >= at + 120) return;
  const claim = await db.query(`INSERT INTO hrep.runs (day) VALUES ($1::date) ON CONFLICT DO NOTHING RETURNING day`, [ck.today]);
  if (!claim.rowCount) return;
  const r = await sendAll({});
  await db.query(`UPDATE hrep.runs SET finished_at = now(), sent = $2, failed = $3, skipped = $4 WHERE day = $1::date`,
    [ck.today, r.sent, r.failed, r.skipped]);
  console.log(`[HoursReport] ${ck.today}: sent ${r.sent}, failed ${r.failed}, skipped ${r.skipped}`);
}
let RUNNING = false;
function schedule(bot) {
  BOT = bot;
  setInterval(async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await tick(); } catch (e) { console.error("[HoursReport] tick:", e.message); } finally { RUNNING = false; }
  }, 60 * 1000);
}

// ══════════════════════════════════════════════════════════════════════
//  API (/api/hours-report) — налаштування бачить і змінює тільки адмін
// ══════════════════════════════════════════════════════════════════════
router.use(requireAuth);
router.get("/me", (req, res) => res.json({ ok: true, is_admin: !!req.coordinator.is_admin }));
router.use((req, res, next) => (req.coordinator.is_admin ? next() : res.status(403).json({ ok: false, error: "Tylko administrator" })));
const fail = (res, e, code = 500) => { if (code === 500) console.error("[HoursReport api]", e); res.status(code).json({ ok: false, error: e.message || String(e) }); };

router.get("/settings", async (req, res) => {
  try {
    const [st, list, runs, ck] = await Promise.all([
      db.query(`SELECT key, value, note FROM hrep.settings ORDER BY key`),
      coordinators(),
      db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(started_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') AS at,
                       sent, failed, skipped FROM hrep.runs ORDER BY day DESC LIMIT 7`),
      clock(),
    ]);
    res.json({ ok: true, settings: Object.fromEntries(st.rows.map((x) => [x.key, x.value])), today: ck.today, yesterday: ck.yesterday,
      coordinators: list.map((c) => ({ id: c.id, full_name: c.full_name, role: c.role, has_tg: !!c.chat, own_n: c.own_n,
        lead_regions: c.lead_regions, default_scope: c.default_scope, scope: c.scope, scope_set: !!c.r_scope, enabled: c.enabled })),
      runs: runs.rows });
  } catch (e) { fail(res, e); }
});

const RULES = {
  enabled: (v) => ["0", "1"].includes(v),
  time: (v) => hmToMin(v) != null,
  days: (v) => /^[1-7](,[1-7])*$/.test(v),
  yesterday_msg: (v) => ["0", "1"].includes(v),
  month_msg: (v) => ["0", "1"].includes(v),
};
router.patch("/settings", async (req, res) => {
  try {
    const b = req.body || {};
    const keys = Object.keys(b).filter((k) => RULES[k]);
    if (!keys.length) return res.status(400).json({ ok: false, error: "Brak zmian" });
    for (const k of keys) {
      let v = String(b[k]).trim().replace(/\s+/g, "");
      if (k === "time" && hmToMin(v) != null) { const m = hmToMin(v); v = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }
      if (!RULES[k](v)) return res.status(400).json({ ok: false, error: `Nieprawidłowa wartość: ${k}` });
      b[k] = v;
    }
    for (const k of keys) {
      await db.query(
        `INSERT INTO hrep.settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [k, b[k], req.coordinator.coordinator_id]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Wysyłać / nie wysyłać i zakres dla koordynatora (scope "" = domyślny)
router.put("/recipients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const scope = SCOPES.includes(b.scope) ? b.scope : null;
    const enabled = b.enabled !== false;
    if (enabled && !scope) await db.query(`DELETE FROM hrep.recipients WHERE coordinator_id = $1`, [id]);
    else {
      await db.query(
        `INSERT INTO hrep.recipients (coordinator_id, enabled, scope, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (coordinator_id) DO UPDATE SET enabled = EXCLUDED.enabled, scope = EXCLUDED.scope,
                updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [id, enabled, scope, req.coordinator.coordinator_id]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
// Kilku naraz: { ids: [...], enabled }
router.post("/recipients/bulk", async (req, res) => {
  try {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter(Boolean);
    const enabled = req.body.enabled !== false;
    for (const id of ids) {
      await db.query(
        `INSERT INTO hrep.recipients (coordinator_id, enabled, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (coordinator_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [id, enabled, req.coordinator.coordinator_id]);
    }
    await db.query(`DELETE FROM hrep.recipients WHERE enabled AND scope IS NULL`);
    res.json({ ok: true, n: ids.length });
  } catch (e) { fail(res, e); }
});

// Test: raport „jak dla koordynatora X” — na mój Telegram (nic nie zapisuje)
router.post("/test", async (req, res) => {
  try {
    if (!BOT) return res.status(400).json({ ok: false, error: "Bot niedostępny" });
    const me = await db.query(`SELECT telegram_chat_id::text AS chat FROM coordinators WHERE id = $1`, [req.coordinator.coordinator_id]);
    const chat = me.rows[0] && me.rows[0].chat;
    if (!chat) return res.status(400).json({ ok: false, error: "Brak Telegrama w Twojej karcie koordynatora" });
    const id = parseInt((req.body && req.body.coordinator_id) || req.coordinator.coordinator_id, 10);
    const c = (await coordinators()).find((x) => x.id === id);
    if (!c) return res.status(404).json({ ok: false, error: "Nie ma takiego koordynatora" });
    const label = { own: "swoje obiekty", region: "region", all: "cała firma" }[c.scope];
    const r = await sendAll({ only: id, toChat: chat, prefix: `🧪 TEST — jak dla: ${md(c.full_name)} (${label})${c.enabled ? "" : " — wyłączony"}\n\n` });
    if (!r.sent) return res.status(400).json({ ok: false, error: r.skipped ? "Ten koordynator nie ma obiektów w tym zakresie" : "Nie wysłano — sprawdź log" });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = { router, schedule, sendAll, _test: { buildMessages, coordinators, facilitiesFor, tick, clock, setBot: (b) => { BOT = b; } } };
