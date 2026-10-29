// api/wapp.js — міні-застосунок працівника в Telegram (public/tgw/). Кнопка — у меню бота (bot/worker_app.js).
//
//  Вхід: кожен запит несе заголовок x-tg-init = Telegram.WebApp.initData (підпис HMAC з BOT_TOKEN, api/tg.js → verifyInitData).
//  Працівник — той, хто зараз увійшов у бот з цього Telegram (workers.telegram_chat_id + session_data.workerId).
//  Правила — ті самі, що в боті (bot/handlers.js): години лише в дні періоду роботи, аванс ADVANCE_STD (300 zł)
//  і одна заявка за раз, вихідні на 14 днів уперед з автовідмовою WOLNE_AUTO_REJECT, усе — за налаштуваннями обʼєкта.
//
//   GET  /api/wapp/me              головна: працівник, місяць, заявки, статус студента, документи
//   GET  /api/wapp/hours?month=    години за місяць (поточний і 3 попередні — перегляд; правка — HOURS_BACK дні назад … завтра)
//   POST /api/wapp/hours           { date, hours } або { date, abs }
//   POST /api/wapp/advance         заявка на аванс
//   POST /api/wapp/dayoff          { dates: [YYYY-MM-DD] }
//   POST /api/wapp/pages           тіло — JPEG (image/jpeg) або PDF (application/pdf), до 12 МБ → { id } (тимчасово, 24 год)
//   POST /api/wapp/docs            { kinds, pages: [id], cards?: [id], valid_until?, school? } → PDF в офіс (WORKER_DOCS_EMAIL) + статус студента
//                                  копія — координаторам об'єкта, які ввімкнули її в боті (coordCopies)
//                                  cards — обрізані сторони карти побиту: у PDF у реальному розмірі, дві на аркуш
//   POST /api/wapp/docs/:id/chat   надіслати PDF працівнику в чат з ботом
//   POST /api/wapp/camtest         звіт тесту камери (тимчасово) → лог сервера
//   — панель (сесія x-session) —
//   GET  /api/wapp/panel/docs?worker_id=   документи працівника
//   GET  /api/wapp/panel/docs/:id/file     PDF
//
// Файли: uploads/tmp/w<id>/ (сторінки до відправки), uploads/worker_docs/<ID>/ (зібрані PDF) — поза репозиторієм.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("../db");
const { verifyInitData } = require("./tg");
const { requireAuth } = require("./admin");
const pdf = require("../bot/pdf");
const student = require("../bot/student");
const wapp = require("../bot/worker_app");
const { getSettingsByFacility } = require("../bot/settings");

const router = express.Router();
const bot = () => require("../bot/handlers");

const UP = path.join(__dirname, "..", "uploads");
const TMP = path.join(UP, "tmp");
const DOCS = path.join(UP, "worker_docs");
const TMP_TTL_MS = 24 * 3600 * 1000;
const TMP_MAX = 30;                       // сторінок у чернетці одного працівника
const PAGES_MAX = 20;                     // сторінок в одному PDF
const ADV_STD = Number(process.env.ADVANCE_STD || 300) || 300;
const DOF_HORIZON = 14;                   // як календар вихідних у боті
const HOURS_MAX = 16;
const CODES = ["WZ", "DWZ", "URL", "L4", "NN", "UN"];
const KINDS = ["student", "passport", "karta", "other"];
const KIND_PL = { student: "Zaświadczenie studenta", passport: "Paszport", karta: "Karta pobytu", other: "Inny dokument" };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_ID = /^[0-9a-f]{16}$/;

const WAW = "Europe/Warsaw";
const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const monthStart = (iso) => iso.slice(0, 8) + "01";
const addMonths = (ym, n) => { const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const monthEnd = (ym) => addDays(`${addMonths(ym, 1)}-01`, -1);
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const safeName = (s) => String(s || "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "x";
// Виплата авансу — у пʼятницю, як у боті (bot/handlers.js → nextFriday): заявка в пн — цього тижня, з вт — наступного
const PAY_SHIFT = [5, 4, 10, 9, 8, 7, 6];
const payDate = (iso) => addDays(iso, PAY_SHIFT[dowOf(iso)]);
const fail = (res, e) => {
  console.error("[wapp]", e.message);
  res.status(500).json({ ok: false, error: "server" });
};

// ── Вхід ───────────────────────────────────────────────────────────────
const WORKER_SQL = `
  SELECT w.id, w.login, w.full_name, w.telegram_chat_id, COALESCE(w.session_data->>'lang', w.lang::text) AS lang,
         vc.facility_id, f.name AS facility, vc.status::text AS status,
         to_char(vc.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(vc.last_work_date, 'YYYY-MM-DD') AS lwd
    FROM workers w
    LEFT JOIN v_worker_current vc ON vc.id = w.id
    LEFT JOIN facilities f ON f.id = vc.facility_id
   WHERE w.telegram_chat_id = $1 AND w.session_data->>'workerId' = w.id::text
   ORDER BY w.updated_at DESC LIMIT 1`;

async function auth(req, res, next) {
  try {
    const v = verifyInitData(req.headers["x-tg-init"], process.env.BOT_TOKEN);
    if (!v) return res.status(401).json({ ok: false, error: "bad_init" });
    const r = await db.query(WORKER_SQL, [v.user.id]);
    const w = r.rows[0];
    if (!w) return res.status(403).json({ ok: false, error: "not_linked" });
    if (wapp.CFG.only.length && !wapp.CFG.only.includes(String(w.login).toUpperCase())) {
      return res.status(403).json({ ok: false, error: "not_enabled" });
    }
    w.dismissed = !w.status || ["zwolniony", "rezygnacja"].includes(w.status);
    req.worker = w;
    next();
  } catch (e) { fail(res, e); }
}

// Періоди роботи (усі обʼєкти), що зачіпають [from, to]
async function periodsOf(workerId, from, to) {
  const r = await db.query(
    `SELECT to_char(bhp_date, 'YYYY-MM-DD') AS f, to_char(last_work_date, 'YYYY-MM-DD') AS t
       FROM worker_facility_history
      WHERE worker_id = $1 AND status::text <> 'rezygnacja' AND bhp_date IS NOT NULL
        AND bhp_date <= $3::date AND (last_work_date IS NULL OR last_work_date >= $2::date)
      ORDER BY bhp_date`, [workerId, from, to]);
  return r.rows.map((x) => ({ from: x.f, to: x.t }));
}
const inPeriods = (ps, iso) => ps.some((p) => p.from <= iso && (!p.to || p.to >= iso));

async function monthHours(workerId, from, to) {
  const r = await db.query(
    `SELECT to_char(work_date, 'YYYY-MM-DD') AS d, hours, absence_type::text AS abs
       FROM hours_log WHERE worker_id = $1 AND work_date BETWEEN $2::date AND $3::date`, [workerId, from, to]);
  const days = {};
  let total = 0;
  for (const x of r.rows) {
    const h = x.hours == null ? null : Number(x.hours);
    if (h != null && x.abs == null) total += h;
    if (h != null || x.abs) days[x.d] = x.abs ? { abs: x.abs } : { h };
  }
  return { days, total: Math.round(total * 100) / 100 };
}

// Дати, на які вже є заявка на вихідний (чекає або схвалена)
async function takenDays(workerId, from) {
  const r = await db.query(
    `SELECT DISTINCT to_char(d, 'YYYY-MM-DD') AS d, r.status::text AS status
       FROM day_off_requests r, unnest(r.days) d
      WHERE r.worker_id = $1 AND r.status::text IN ('pending', 'approved') AND d >= $2::date`, [workerId, from]);
  const out = {};
  for (const x of r.rows) if (out[x.d] !== "approved") out[x.d] = x.status;
  return out;
}

// ── Головна ───────────────────────────────────────────────────────────
router.get("/me", auth, async (req, res) => {
  try {
    const w = req.worker;
    const today = todayIso();
    const from = monthStart(today);
    const s = (await getSettingsByFacility(w.facility_id)) || {};
    const horizon = Array.from({ length: DOF_HORIZON }, (_, i) => addDays(today, i + 1));
    const [hrs, ps, adv, dof, st, docs, near, taken] = await Promise.all([
      monthHours(w.id, from, today),
      periodsOf(w.id, from, today),
      db.query(`SELECT id, requested_at, to_char(requested_at AT TIME ZONE '${WAW}', 'YYYY-MM-DD') AS d, status::text AS status, note
                  FROM advances WHERE worker_id = $1 ORDER BY requested_at DESC LIMIT 5`, [w.id]),
      db.query(`SELECT id, requested_at, status::text AS status, note,
                       (SELECT array_agg(to_char(x, 'YYYY-MM-DD') ORDER BY x) FROM unnest(days) x) AS days
                  FROM day_off_requests WHERE worker_id = $1 ORDER BY requested_at DESC LIMIT 5`, [w.id]),
      student.get(w.id).catch(() => ({ state: "none" })),
      db.query(`SELECT id, kinds, pages, created_at, mailed_at IS NOT NULL AS mailed, to_char(valid_until, 'YYYY-MM-DD') AS valid_until
                  FROM wapp.docs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 5`, [w.id]).catch(() => ({ rows: [] })),
      bot().splitNearWolne(w.id, horizon).then((x) => x.near),
      takenDays(w.id, addDays(today, 1)),
    ]);
    // Без годин: від початку місяця до вчора, у дні періоду роботи
    const missing = [];
    for (let d = from; d < today; d = addDays(d, 1)) if (inPeriods(ps, d) && !hrs.days[d]) missing.push(d);
    res.json({
      ok: true, today, lang: w.lang,
      worker: { id: w.id, name: w.full_name, login: w.login, facility: w.facility, status: w.status, bhp: w.bhp, lwd: w.lwd, dismissed: w.dismissed },
      month: { total: hrs.total, missing, filled: Object.keys(hrs.days).length, edit: editWindow(today) },
      advance: {
        enabled: !!s.enable_advances, amount: ADV_STD, pay_date: payDate(today),
        pending: adv.rows.some((x) => x.status === "pending"),
        history: adv.rows.map((x) => ({ id: x.id, date: x.d, status: x.status, note: x.note, pay_date: payDate(x.d) })),
      },
      dayoff: {
        enabled: !!s.enable_wolne, horizon: DOF_HORIZON, min_days: bot().WOLNE_MIN_DAYS, near, taken,
        history: dof.rows.map((x) => ({ id: x.id, days: x.days || [], status: x.status, note: x.note })),
      },
      student: st,
      docs: docs.rows,
      office: { email: wapp.CFG.docsEmail.length > 0 },
    });
  } catch (e) { fail(res, e); }
});

// ── Години ────────────────────────────────────────────────────────────
// Правка: сьогодні й HOURS_BACK дні назад, плюс завтра (як кнопка «→» у боті); старіші дні — лише координатор у панелі
const HOURS_BACK = 2;
const editWindow = (today) => ({ from: addDays(today, -HOURS_BACK), to: addDays(today, 1) });

router.get("/hours", auth, async (req, res) => {
  try {
    const w = req.worker;
    const today = todayIso();
    const cur = today.slice(0, 7);
    let ym = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : cur;
    if (ym > cur) ym = cur;
    if (ym < addMonths(cur, -3)) ym = addMonths(cur, -3);
    const from = `${ym}-01`, to = monthEnd(ym);
    const s = (await getSettingsByFacility(w.facility_id)) || {};
    const [hrs, ps] = await Promise.all([monthHours(w.id, from, to), periodsOf(w.id, from, to)]);
    res.json({
      ok: true, today, month: ym, min_month: addMonths(cur, -3), ...hrs, periods: ps, edit: editWindow(today),
      hours_format: s.hours_format || "whole", hours_max: HOURS_MAX, codes: CODES,
    });
  } catch (e) { fail(res, e); }
});

router.post("/hours", auth, async (req, res) => {
  try {
    const w = req.worker;
    const b = req.body || {};
    const date = String(b.date || "");
    const win = editWindow(todayIso());
    if (!ISO.test(date) || date < win.from || date > win.to) return res.status(400).json({ ok: false, error: "bad_date" });
    let r;
    if (b.abs != null) {
      if (!CODES.includes(b.abs)) return res.status(400).json({ ok: false, error: "bad_code" });
      r = await bot().writeAbsenceOn(w.id, date, b.abs, "webapp");
    } else {
      const h = Math.round(Number(String(b.hours).replace(",", ".")) * 100) / 100;
      if (!(h > 0 && h <= HOURS_MAX)) return res.status(400).json({ ok: false, error: "bad_hours" });
      r = await bot().writeHoursOn(w.id, date, h, "webapp");
    }
    if (!r.ok) return res.status(400).json({ ok: false, error: r.reason || "outside_period" });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Аванс ─────────────────────────────────────────────────────────────
router.post("/advance", auth, async (req, res) => {
  try {
    const w = req.worker;
    const s = (await getSettingsByFacility(w.facility_id)) || {};
    if (!s.enable_advances) return res.status(400).json({ ok: false, error: "disabled" });
    if (w.dismissed) return res.status(400).json({ ok: false, error: "dismissed" });
    // одна заявка, що чекає; advisory-lock — два натискання поспіль не створять дві
    const client = await db.pool.connect();
    let id = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(7420312, $1)", [w.id]);
      const p = await client.query(`SELECT 1 FROM advances WHERE worker_id = $1 AND status = 'pending'`, [w.id]);
      if (!p.rows.length) {
        id = (await client.query(`INSERT INTO advances (worker_id, requested_at, status) VALUES ($1, now(), 'pending') RETURNING id`, [w.id])).rows[0].id;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
    if (!id) return res.status(400).json({ ok: false, error: "pending" });
    require("../bot/coord").notifyNew("adv", id).catch((e) => console.error("[coord] notify adv", e.message));
    res.json({ ok: true, id, amount: ADV_STD, pay_date: payDate(todayIso()) });
  } catch (e) { fail(res, e); }
});

// ── Вихідні ───────────────────────────────────────────────────────────
router.post("/dayoff", auth, async (req, res) => {
  try {
    const w = req.worker;
    const s = (await getSettingsByFacility(w.facility_id)) || {};
    if (!s.enable_wolne) return res.status(400).json({ ok: false, error: "disabled" });
    if (w.dismissed) return res.status(400).json({ ok: false, error: "dismissed" });
    const today = todayIso();
    const first = addDays(today, 1), last = addDays(today, DOF_HORIZON);
    const raw = Array.isArray((req.body || {}).dates) ? req.body.dates : [];
    let dates = [...new Set(raw.map(String))].filter((d) => ISO.test(d) && d >= first && d <= last).sort();
    if (!dates.length) return res.status(400).json({ ok: false, error: "no_days" });
    const taken = await takenDays(w.id, first);
    dates = dates.filter((d) => !taken[d]);
    if (!dates.length) return res.status(400).json({ ok: false, error: "taken" });
    const h = bot();
    const { near, rest } = await h.splitNearWolne(w.id, dates);
    if (near.length) await h.writeWolneRejected(w.id, near);
    if (rest.length) await h.writeWolne(w.id, rest);
    res.json({ ok: true, accepted: rest, rejected: near, min_days: h.WOLNE_MIN_DAYS });
  } catch (e) { fail(res, e); }
});

// ── Сторінки документів (чернетка) ─────────────────────────────────────
const tmpDir = (workerId) => path.join(TMP, `w${workerId}`);
function sweep(dir, keep) {
  let files = [];
  try { files = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })); } catch (e) { return; }
  const now = Date.now();
  files.sort((a, b) => b.t - a.t).forEach((x, i) => {
    if (now - x.t > TMP_TTL_MS || (keep != null && i >= keep)) fs.rmSync(path.join(dir, x.f), { force: true });
  });
}
const rawBody = express.raw({ type: ["image/jpeg", "application/pdf"], limit: "12mb" });

router.post("/pages", auth, (req, res) => {
  rawBody(req, res, (err) => {
    if (err) return res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: err.status === 413 ? "too_big" : "bad_body" });
    try {
      const buf = req.body;
      const type = String(req.headers["content-type"] || "").split(";")[0].trim();
      if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ ok: false, error: "empty" });
      const isJpeg = type === "image/jpeg" && !!pdf.jpegInfo(buf);
      const isPdf = type === "application/pdf" && pdf.isPdf(buf);
      if (!isJpeg && !isPdf) return res.status(400).json({ ok: false, error: "bad_type" });
      const dir = tmpDir(req.worker.id);
      fs.mkdirSync(dir, { recursive: true });
      sweep(dir, TMP_MAX - 1);
      const id = crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path.join(dir, `${id}.${isPdf ? "pdf" : "jpg"}`), buf);
      res.json({ ok: true, id, type: isPdf ? "pdf" : "jpg", size: buf.length });
    } catch (e) { fail(res, e); }
  });
});

// Лист в офіс з PDF у вкладенні. Помилка пошти не скасовує відправку: документ збережено, лист можна повторити з панелі.
// Копія — координаторам об'єкта працівника (головний і помічники), які ввімкнули це кнопкою в боті
// (bot/coord.js → «📎 Документи на пошту», tgc.prefs.docs_mail); адреси з офісного списку не дублюємо
async function coordCopies(facilityId, to) {
  if (!facilityId) return [];
  const r = await db.query(
    `SELECT DISTINCT lower(trim(c.email)) AS email
       FROM reg.v_access v
       JOIN public.coordinators c ON c.id = v.coordinator_id
       JOIN tgc.prefs p ON p.coordinator_id = c.id
      WHERE v.facility_id = $1 AND v.kinds && ARRAY['main', 'helper'] AND p.docs_mail AND COALESCE(trim(c.email), '') <> ''`,
    [facilityId]).catch((e) => { console.error("[wapp] копія координаторам:", e.message); return { rows: [] }; });
  const office = new Set(to.map((x) => x.toLowerCase()));
  return r.rows.map((x) => x.email).filter((x) => !office.has(x));
}

async function mailOffice(w, doc, kinds, buf, name) {
  const to = wapp.CFG.docsEmail;
  const mail = require("./mail");
  if (!to.length) return { mailed: false, error: "no_email" };
  if (!mail.configured()) return { mailed: false, error: "mail_not_configured" };
  const rows = [
    ["Pracownik", w.full_name], ["ID", w.login], ["Zakład", w.facility || "—"],
    ["Dokumenty", kinds.map((k) => KIND_PL[k]).join(", ")], ["Stron", String(doc.pages)],
    ...(doc.valid_until ? [["Ważne do", dmy(doc.valid_until)]] : []),
    ...(doc.school ? [["Uczelnia / szkoła", doc.school]] : []),
  ];
  const html = `<p>Dokumenty wysłane przez pracownika z aplikacji Telegram (SAS Praca).</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
    ${rows.map(([k, v]) => `<tr><td style="color:#555;border-bottom:1px solid #eee">${esc(k)}</td><td style="border-bottom:1px solid #eee"><b>${esc(v)}</b></td></tr>`).join("")}
    </table>`;
  const cc = await coordCopies(w.facility_id, to);
  try {
    await mail.send({
      to, cc, subject: `Dokumenty pracownika: ${w.full_name} (${w.login}) — ${kinds.map((k) => KIND_PL[k]).join(", ")}`,
      html, attachments: [{ name, contentType: "application/pdf", content: buf }],
    });
    await db.query(`UPDATE wapp.docs SET mailed_to = $2, mailed_at = now(), mail_error = NULL WHERE id = $1`, [doc.id, [...to, ...cc].join(", ")]);
    return { mailed: true };
  } catch (e) {
    console.error("[wapp] mail", doc.id, e.message);
    await db.query(`UPDATE wapp.docs SET mail_error = $2 WHERE id = $1`, [doc.id, String(e.message).slice(0, 500)]).catch(() => {});
    return { mailed: false, error: "send_failed" };
  }
}

router.post("/docs", auth, async (req, res) => {
  try {
    const w = req.worker;
    const b = req.body || {};
    const today = todayIso();
    const kinds = [...new Set((Array.isArray(b.kinds) ? b.kinds : []).map(String))].filter((k) => KINDS.includes(k));
    if (!kinds.length) return res.status(400).json({ ok: false, error: "no_kinds" });
    const isStudent = kinds.includes("student");
    if (isStudent && kinds.length > 1) return res.status(400).json({ ok: false, error: "student_alone" });
    const valid = isStudent ? String(b.valid_until || "") : null;
    if (isStudent && (!ISO.test(valid) || valid < today || valid > addDays(today, 2 * 366))) {
      return res.status(400).json({ ok: false, error: "bad_valid_until" });
    }
    const ids = (Array.isArray(b.pages) ? b.pages : []).map(String);
    if (!ids.length || ids.length > PAGES_MAX || ids.some((x) => !PAGE_ID.test(x))) return res.status(400).json({ ok: false, error: "bad_pages" });
    const dir = tmpDir(w.id);
    const files = ids.map((id) => {
      const jpg = path.join(dir, `${id}.jpg`), pf = path.join(dir, `${id}.pdf`);
      return fs.existsSync(jpg) ? { id, p: jpg, pdf: false } : fs.existsSync(pf) ? { id, p: pf, pdf: true } : null;
    });
    if (files.some((x) => !x)) return res.status(400).json({ ok: false, error: "pages_gone" });
    // PDF з телефона — лише один файл (злити кілька PDF без бібліотеки не можемо), інакше — фото
    if (files.some((x) => x.pdf) && files.length > 1) return res.status(400).json({ ok: false, error: "one_pdf" });
    const title = `${w.login} ${kinds.map((k) => KIND_PL[k]).join(", ")}`;
    // обрізані сторони карти побиту — у реальному розмірі, дві на аркуш (bot/pdf.js)
    const cards = new Set(kinds.includes("karta") && Array.isArray(b.cards) ? b.cards.map(String) : []);
    const buf = files[0].pdf ? fs.readFileSync(files[0].p)
      : pdf.jpegsToPdf(files.map((x) => ({ jpg: fs.readFileSync(x.p), card: cards.has(x.id) })), title);
    const pages = files[0].pdf ? 1 : files.length;
    const outDir = path.join(DOCS, safeName(w.login));
    fs.mkdirSync(outDir, { recursive: true });
    const name = `${today}_${kinds.join("-")}_${crypto.randomBytes(3).toString("hex")}.pdf`;
    const full = path.join(outDir, name);
    fs.writeFileSync(full, buf);
    const school = isStudent && b.school ? String(b.school).trim().slice(0, 200) : null;
    const ins = await db.query(
      `INSERT INTO wapp.docs (worker_id, kinds, pages, file_path, file_size, valid_until, school)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [w.id, kinds, pages, full, buf.length, valid, school]);
    const doc = { id: ins.rows[0].id, pages, valid_until: valid, school };
    if (isStudent) await student.fromUpload(w.id, doc.id, valid, school);
    for (const x of files) fs.rmSync(x.p, { force: true });
    const m = await mailOffice(w, doc, kinds, buf, `${safeName(w.login)}_${kinds.join("-")}_${today}.pdf`);
    res.json({ ok: true, id: doc.id, pages, size: buf.length, ...m });
  } catch (e) { fail(res, e); }
});

// PDF — працівнику в чат з ботом (у Telegram файл з міні-застосунку інакше не зберегти)
router.post("/docs/:id/chat", auth, async (req, res) => {
  try {
    const w = req.worker;
    const r = await db.query(`SELECT id, kinds, file_path FROM wapp.docs WHERE id = $1 AND worker_id = $2`, [parseInt(req.params.id, 10) || 0, w.id]);
    const d = r.rows[0];
    if (!d || !fs.existsSync(d.file_path)) return res.status(404).json({ ok: false, error: "not_found" });
    const fd = new FormData();
    fd.append("chat_id", String(w.telegram_chat_id));
    fd.append("document", new Blob([fs.readFileSync(d.file_path)], { type: "application/pdf" }), path.basename(d.file_path));
    const t = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
    const j = await t.json().catch(() => ({ ok: false }));
    if (!j.ok) return res.status(502).json({ ok: false, error: "send_failed" });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ── Тест камери (#camtest, команда /camtest у боті): звіт з телефона — один рядок у лог сервера ──
// Без входу працівника: лише підпис Telegram. Тимчасово — поки вирішуємо, чи робити живий видошукач.
router.post("/camtest", (req, res) => {
  const v = verifyInitData(req.headers["x-tg-init"], process.env.BOT_TOKEN);
  if (!v) return res.status(401).json({ ok: false, error: "bad_init" });
  const r = (req.body && req.body.report) || {};
  console.log(`[camtest] ${v.user.id} ${String(v.user.first_name || "").slice(0, 40)}: ${JSON.stringify(r).slice(0, 3000)}`);
  res.json({ ok: true });
});

// ── Панель: документи працівника ──────────────────────────────────────
async function canSee(req, workerId) {
  if (req.coordinator.is_admin) return true;
  return require("./routes").workerInScope(req.coordinator, workerId);
}
router.get("/panel/docs", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.query.worker_id, 10);
    if (!id) return res.status(400).json({ ok: false, error: "worker_id" });
    if (!(await canSee(req, id))) return res.status(403).json({ ok: false, error: "Forbidden" });
    const [d, st] = await Promise.all([
      db.query(`SELECT id, kinds, pages, file_size, to_char(valid_until, 'YYYY-MM-DD') AS valid_until, school, mailed_to, mailed_at, mail_error, created_at
                  FROM wapp.docs WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      student.get(id),
    ]);
    res.json({ ok: true, docs: d.rows, student: st });
  } catch (e) { fail(res, e); }
});
router.get("/panel/docs/:id/file", requireAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT d.worker_id, d.file_path FROM wapp.docs d WHERE d.id = $1`, [parseInt(req.params.id, 10) || 0]);
    const d = r.rows[0];
    if (!d) return res.status(404).json({ ok: false, error: "not_found" });
    if (!(await canSee(req, d.worker_id))) return res.status(403).json({ ok: false, error: "Forbidden" });
    if (!fs.existsSync(d.file_path)) return res.status(404).json({ ok: false, error: "file_gone" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${path.basename(d.file_path)}"`);
    fs.createReadStream(d.file_path).pipe(res);
  } catch (e) { fail(res, e); }
});

// Чернетки старші за добу — щогодини геть
function schedule() {
  const run = () => {
    let dirs = [];
    try { dirs = fs.readdirSync(TMP); } catch (e) { return; }
    for (const d of dirs) {
      const p = path.join(TMP, d);
      sweep(p, null);
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch (e) { /* зайнято */ }
    }
  };
  setInterval(run, 3600 * 1000).unref();
  run();
}

module.exports = { router, schedule, _test: { payDate, editWindow, inPeriods, monthEnd, addMonths } };
