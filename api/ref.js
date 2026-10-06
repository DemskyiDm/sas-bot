// ══════════════════════════════════════════════════════════════════════
//  Розділ «Poleć znajomego» — API панелі.  app.use("/api/ref", ref.router)
//
//  Доступ:
//    адмін / head  — усе, налаштування, позначка «бонус виплачено»
//    регіональний  — свої регіони: зіставлення, безпека, Excel
//    координатор   — лише якщо в налаштуваннях «visible_coords» = 1:
//                    свої об'єкти, тільки перегляд, без даних про Telegram
// ══════════════════════════════════════════════════════════════════════
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const refBot = require("../bot/referral");

router.use(requireAuth);

const fail = (res, e, code = 500) => {
  if (code === 500) console.error("[ref api]", e);
  res.status(code).json({ ok: false, error: e.message || String(e) });
};
const iso = (d) => (d == null ? null : d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  : String(d).slice(0, 10));
function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// ── Доступ ────────────────────────────────────────────────────────────
async function scopeOf(c) {
  const st = await refBot.settings();
  const me = c.coordinator_id;
  if (c.is_admin || c.role === "head") return { role: "all", admin: !!c.is_admin, me, regionIds: [], st };
  const r = await db.query(
    `SELECT rl.region_id FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
      WHERE rl.coordinator_id = $1 AND rg.is_active`, [me]);
  if (r.rows.length) return { role: "lead", admin: false, me, regionIds: r.rows.map((x) => Number(x.region_id)), st };
  if (st.visible_coords === "1") {
    const o = await db.query(`SELECT 1 FROM reg.site_owner WHERE valid_to IS NULL AND coordinator_id = $1 LIMIT 1`, [me]);
    if (o.rows.length) return { role: "coord", admin: false, me, regionIds: [], st };
  }
  return { role: "none", admin: false, me, regionIds: [], st };
}
router.use(async (req, res, next) => {
  try { req.rs = await scopeOf(req.coordinator); } catch (e) { return fail(res, e); }
  if (req.path === "/me") return next();
  if (req.rs.role === "none") return res.status(403).json({ ok: false, error: "Brak dostępu" });
  next();
});
const canMatch = (rs) => rs.role === "all" || rs.role === "lead";
const canPay = (rs) => rs.role === "all";
const seesTg = (rs) => rs.role === "all" || rs.role === "lead";

// об'єкти (site_key) → регіон, відповідальний
async function sitesMap() {
  const r = await db.query(
    `SELECT so.site_key, so.region_id, so.coordinator_id, c.full_name AS coordinator_name, rg.name AS region_name
       FROM reg.site_owner so
       LEFT JOIN public.coordinators c ON c.id = so.coordinator_id
       LEFT JOIN reg.regions rg ON rg.id = so.region_id
      WHERE so.valid_to IS NULL`);
  const m = new Map();
  r.rows.forEach((x) => m.set(x.site_key, { ...x, region_id: x.region_id == null ? null : Number(x.region_id) }));
  return m;
}
function siteAllowed(rs, s) {
  if (rs.role === "all") return true;
  if (!s) return false;
  if (rs.role === "lead") return (s.region_id != null && rs.regionIds.includes(s.region_id)) || s.coordinator_id === rs.me;
  return s.coordinator_id === rs.me;
}
function filterSites(rs, q, s) {
  if (!siteAllowed(rs, s)) return false;
  if (rs.role === "coord") return true;
  const reg = q.region;
  if (reg === "none" && rs.role === "all") { if (s && s.region_id != null) return false; }
  else if (reg && reg !== "all") { if (!s || s.region_id !== Number(reg)) return false; }
  if (q.coord) { if (!s || s.coordinator_id !== Number(q.coord)) return false; }
  return true;
}

// Працівники, які працювали (будь-коли) на об'єктах, доступних цій ролі
const SITE_SQL = `COALESCE(NULLIF(btrim(f.group_name), ''), btrim(f.name))`;
async function allowedKeys(rs) {
  if (rs.role === "all") return null;
  return [...(await sitesMap()).values()].filter((s) => siteAllowed(rs, s)).map((s) => s.site_key);
}
// SQL-умова «працівник ${col} з доступних об'єктів»; keys — параметр $${n}
const workerInSites = (col, n) => `EXISTS (SELECT 1 FROM public.worker_facility_history hh JOIN public.facilities f ON f.id = hh.facility_id
                                    WHERE hh.worker_id = ${col} AND ${SITE_SQL} = ANY($${n}::text[]))`;
async function allowedWorkers(keys, ids) {
  if (keys === null || !ids.length) return new Set(ids);
  const r = await db.query(
    `SELECT DISTINCT hh.worker_id FROM public.worker_facility_history hh JOIN public.facilities f ON f.id = hh.facility_id
      WHERE hh.worker_id = ANY($1::int[]) AND ${SITE_SQL} = ANY($2::text[])`, [ids, keys]);
  return new Set(r.rows.map((x) => x.worker_id));
}

// ── Транслітерація та схожість імен ──────────────────────────────────
const UK = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ё: "e", ы: "y", э: "e", ъ: "", "'": "", "’": "", "ʼ": "" };
const RU = { ...UK, г: "g", и: "i", е: "e", й: "y", х: "kh", ю: "yu", я: "ya", ы: "y" };
const PL = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
function translit(s, table) {
  return String(s || "").toLowerCase().split("").map((ch) => (table[ch] != null ? table[ch] : PL[ch] != null ? PL[ch] : ch)).join("")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s-]/g, " ");
}
const tokens = (s) => s.split(/[\s-]+/).filter((t) => t.length >= 2);
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);
// typed — те, що вписав працівник; cand — ПІБ з бази. Порядок слів не важливий.
function nameScore(typed, cand) {
  let best = 0;
  const ct = tokens(translit(cand, UK));
  for (const table of [UK, RU]) {
    const tt = tokens(translit(typed, table));
    if (!tt.length || !ct.length) continue;
    const used = new Set();
    const parts = [];
    for (const t of tt.slice(0, 3)) {
      let bi = -1, bs = 0;
      ct.forEach((c, i) => {
        if (used.has(i)) return;
        const s = c.startsWith(t) && t.length >= 3 ? Math.max(sim(t, c), 0.85) : sim(t, c);
        if (s > bs) { bs = s; bi = i; }
      });
      if (bi >= 0) used.add(bi);
      parts.push(bs);
    }
    parts.sort((a, b) => b - a);
    const top = parts.slice(0, 2);
    let sc = top.reduce((a, b) => a + b, 0) / top.length;
    if (tt.length === 1) sc *= 0.85;                     // лише одне слово — менша певність
    best = Math.max(best, sc);
  }
  return best;
}
let CAND = null, CAND_AT = 0;
async function candidates() {
  if (CAND && Date.now() - CAND_AT < 10 * 60 * 1000) return CAND;
  const r = await db.query(
    `SELECT w.id, w.login, w.full_name, lp.site_key, lp.status, to_char(lp.last_work_date, 'YYYY-MM-DD') AS last_work_date
       FROM public.workers w
       JOIN LATERAL (
         SELECT COALESCE(NULLIF(btrim(f.group_name), ''), btrim(f.name)) AS site_key, h.status::text AS status, h.last_work_date
           FROM public.worker_facility_history h JOIN public.facilities f ON f.id = h.facility_id
          WHERE h.worker_id = w.id AND h.status::text <> 'rezygnacja'
          ORDER BY (h.last_work_date IS NULL) DESC, h.last_work_date DESC NULLS FIRST, h.bhp_date DESC
          LIMIT 1) lp ON true
      WHERE w.login NOT LIKE 'TEST_%' AND (lp.last_work_date IS NULL OR lp.last_work_date >= ref.today() - 400)`);
  CAND = r.rows; CAND_AT = Date.now();
  return CAND;
}
async function suggest(row) {
  if (!row.referrer_text) return [];
  if (row.source === "coord") {
    const c = await db.query(`SELECT id, full_name FROM public.coordinators WHERE COALESCE(is_active, true)`);
    return c.rows.map((x) => ({ kind: "coord", id: x.id, full_name: x.full_name, score: nameScore(row.referrer_text, x.full_name) }))
      .filter((x) => x.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 5);
  }
  const list = await candidates();
  return list
    .filter((x) => x.id !== row.worker_id)
    .map((x) => {
      let sc = nameScore(row.referrer_text, x.full_name);
      if (sc >= 0.55 && x.site_key && x.site_key === row.site_key) sc += 0.05;   // той самий об'єкт
      return { kind: "worker", id: x.id, login: x.login, full_name: x.full_name, site_key: x.site_key, status: x.status,
        last_work_date: x.last_work_date, score: Math.min(1, sc) };
    })
    .filter((x) => x.score >= 0.62)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ── Стаж нового: кінець безперервної роботи від BHP (перерви ≤ 14 днів) ─
function employmentEnd(periods, bhp) {
  const ps = periods.filter((p) => p.bhp >= bhp).sort((a, b) => a.bhp.localeCompare(b.bhp));
  let end; let started = false;
  for (const p of ps) {
    if (!started) { if (p.bhp !== bhp) continue; started = true; end = p.lwd; continue; }
    if (end === null) break;
    if (p.bhp <= addDays(end, 14)) end = p.lwd === null ? null : (p.lwd > end ? p.lwd : end);
    else break;
  }
  return started ? end : undefined;
}
function bonusOf(r, st, today) {
  const N = Number(st.bonus_days) || 30;
  // N днів роботи включно з днем BHP: BHP 01.09, N=30 → 30.09
  const out = { days: null, reached: false, state: "na", due_date: addDays(r.bhp, N - 1) };
  const end = r.emp_end;                                   // undefined: періоду вже немає в графіку
  const stop = end === undefined ? r.bhp : end === null || end > today ? today : end;
  out.days = Math.max(0, daysBetween(r.bhp, stop) + 1);
  out.reached = today >= out.due_date && (end === null || (end !== undefined && end >= out.due_date));
  out.left = end !== null && end !== undefined && end <= today;
  if (r.state !== "answered" || r.source !== "friend") return out;   // лише записана відповідь «друг»
  if (r.match_state !== "confirmed" || !r.match_worker_id) { out.state = "nomatch"; return out; }
  if (r.bonus_paid_at) out.state = "paid";
  else if (out.reached) out.state = "due";
  else if (out.left || end === undefined) out.state = "lost";
  else out.state = "pending";
  return out;
}

// ── Анкета на старті (care «start») для рядків ───────────────────────
// Питання «про координатора» (visibility = manager): адмін / head — завжди,
// регіональний — не про себе, координатор — ніколи.
const mgrOk = (rs, coordId) => rs.role === "all" || (rs.role === "lead" && coordId !== rs.me);
async function startAnswers(rs, rows) {
  const out = new Map();
  if (!rows.length) return out;
  try {
    const r = await db.query(
      `SELECT s.worker_id, to_char(s.bhp_date, 'YYYY-MM-DD') AS bhp, s.status, s.flag, s.coordinator_id, s.sent_at, s.completed_at,
              q.sort, q.code, q.text->>'pl' AS q, q.visibility, q.options, a.option_code, a.flag AS aflag
         FROM care.survey_sends s
         LEFT JOIN care.answers a ON a.send_id = s.id
         LEFT JOIN care.questions q ON q.id = a.question_id
        WHERE s.survey_code = 'start' AND s.worker_id = ANY($1::int[])
        ORDER BY s.id, q.sort`, [[...new Set(rows.map((x) => x.worker_id))]]);
    for (const x of r.rows) {
      const k = `${x.worker_id}_${x.bhp}`;
      const e = out.get(k) || out.set(k, { status: x.status, flag: x.flag, sent_at: x.sent_at, completed_at: x.completed_at, answers: [], hidden: false }).get(k);
      if (!x.code) continue;
      if (x.visibility === "manager" && !mgrOk(rs, x.coordinator_id)) { e.hidden = true; continue; }
      const o = (x.options || []).find((y) => y.c === x.option_code);
      e.answers.push({ code: x.code, q: x.q, o: x.option_code, a: o ? (o.t.pl || o.t.uk) : x.option_code, f: x.aflag, mgr: x.visibility === "manager" });
    }
  } catch (e) { /* модуля Rozmowy немає */ }
  return out;
}

// ── Рядки: нові працевлаштування + відповіді ─────────────────────────
async function loadRows(rs, q) {
  const st = rs.st;
  const td = (await db.query(`SELECT to_char(ref.today(), 'YYYY-MM-DD') AS d`)).rows[0].d;
  const from = isDate(q.from) ? q.from : addDays(td, -30);
  const to = isDate(q.to) ? q.to : td;
  const sites = await sitesMap();
  const r = await db.query(
    `SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, h.facility_id, h.facility_name, h.site_key,
            w.login, w.full_name, (w.telegram_chat_id IS NOT NULL) AS has_tg,
            a.id AS answer_id, a.status AS a_status, a.source, a.referrer_text, a.answered_at, a.answered_chat_id,
            a.await_name, a.sends, a.first_sent_at, a.last_sent_at, a.blocked_attempts, a.manual_by, a.ext, a.stay_plan, a.stay_at,
            a.match_state, a.match_worker_id, a.match_coordinator_id, a.match_at, a.match_by,
            to_char(a.bonus_paid_at, 'YYYY-MM-DD') AS bonus_paid_at, a.bonus_note,
            mb.full_name AS match_by_name, mc.full_name AS match_coordinator_name, man.full_name AS manual_by_name
       FROM ref.v_hires h
       JOIN public.workers w ON w.id = h.worker_id
       LEFT JOIN ref.answers a ON a.worker_id = h.worker_id AND a.bhp_date = h.bhp_date
       LEFT JOIN public.coordinators mb ON mb.id = a.match_by
       LEFT JOIN public.coordinators mc ON mc.id = a.match_coordinator_id
       LEFT JOIN public.coordinators man ON man.id = a.manual_by
      WHERE h.bhp_date BETWEEN $1::date AND $2::date
      ORDER BY h.bhp_date DESC, w.full_name`, [from, to]);
  let rows = r.rows.filter((x) => filterSites(rs, q, sites.get(x.site_key)));
  const ids = [...new Set(rows.flatMap((x) => [x.worker_id, x.match_worker_id].filter(Boolean)))];
  const per = new Map();
  const cur = new Map();
  if (ids.length) {
    const p = await db.query(
      `SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(h.last_work_date, 'YYYY-MM-DD') AS lwd,
              h.status::text AS status, COALESCE(NULLIF(btrim(f.group_name), ''), btrim(f.name)) AS site_key
         FROM public.worker_facility_history h JOIN public.facilities f ON f.id = h.facility_id
        WHERE h.worker_id = ANY($1::int[]) AND h.status::text <> 'rezygnacja' AND h.bhp_date IS NOT NULL`, [ids]);
    p.rows.forEach((x) => { (per.get(x.worker_id) || per.set(x.worker_id, []).get(x.worker_id)).push(x); });
    for (const [wid, ps] of per) {
      const last = ps.slice().sort((a, b) => (a.lwd === null ? 1 : 0) - (b.lwd === null ? 1 : 0) || String(a.lwd).localeCompare(String(b.lwd)) || a.bhp.localeCompare(b.bhp)).pop();
      cur.set(wid, { site_key: last.site_key, status: last.status, working: last.lwd === null || last.lwd >= td, lwd: last.lwd });
    }
    const w = await db.query(`SELECT id, login, full_name FROM public.workers WHERE id = ANY($1::int[])`, [ids]);
    w.rows.forEach((x) => { const c = cur.get(x.id) || {}; cur.set(x.id, { ...c, login: x.login, full_name: x.full_name }); });
  }
  // Telegram-прапорці
  let tg = null;
  if (seesTg(rs) && rows.length) {
    const wids = rows.map((x) => x.worker_id);
    const chats = rows.map((x) => x.answered_chat_id).filter(Boolean).map(String);
    const [mine, shared, refChats] = await Promise.all([
      db.query(`SELECT worker_id, count(DISTINCT chat_id)::int AS n FROM ref.tg_log WHERE worker_id = ANY($1::int[]) GROUP BY 1`, [wids]),
      db.query(`SELECT chat_id::text AS chat, count(DISTINCT worker_id)::int AS n FROM ref.tg_log WHERE chat_id::text = ANY($1::text[]) GROUP BY 1`, [chats]),
      db.query(`SELECT DISTINCT worker_id, chat_id::text AS chat FROM ref.tg_log WHERE worker_id = ANY($1::int[])`,
        [rows.map((x) => x.match_worker_id).filter(Boolean)]),
    ]);
    tg = {
      mine: new Map(mine.rows.map((x) => [x.worker_id, x.n])),
      shared: new Map(shared.rows.map((x) => [x.chat, x.n])),
      refChats: refChats.rows.reduce((m, x) => m.set(x.worker_id, (m.get(x.worker_id) || new Set()).add(x.chat)), new Map()),
    };
  }
  rows = rows.map((x) => {
    const s = sites.get(x.site_key) || {};
    const ps = per.get(x.worker_id) || [];
    const row = {
      ...x,
      region_id: s.region_id ?? null, region_name: s.region_name || null,
      coordinator_id: s.coordinator_id ?? null, coordinator_name: s.coordinator_name || null,
      emp_end: employmentEnd(ps, x.bhp),
      deadline: addDays(x.bhp, Number(st.window_days) || 5),
    };
    row.state = !x.answer_id
      ? (x.bhp < (st.start_date || "2000-01-01") ? "before" : !x.has_tg ? "no_tg" : row.deadline < td ? "expired" : "queued")
      : x.a_status === "answered" ? "answered" : x.a_status === "expired" ? "expired" : x.source ? "waiting_name" : "waiting";
    row.bonus = bonusOf(row, st, td);
    if (x.match_worker_id) {
      const m = cur.get(x.match_worker_id) || {};
      row.match = { id: x.match_worker_id, login: m.login, full_name: m.full_name, site_key: m.site_key, status: m.status, working: m.working, lwd: m.lwd };
    }
    if (tg) {
      const f = [];
      if (x.blocked_attempts) f.push({ k: "coord_tg", n: x.blocked_attempts });
      const sh = x.answered_chat_id ? tg.shared.get(String(x.answered_chat_id)) : 0;
      if (sh > 1) f.push({ k: "shared", n: sh });
      if (x.match_worker_id && x.answered_chat_id && (tg.refChats.get(x.match_worker_id) || new Set()).has(String(x.answered_chat_id))) f.push({ k: "ref_chat" });
      if (x.match_worker_id && x.match_worker_id === x.worker_id) f.push({ k: "self" });
      if ((tg.mine.get(x.worker_id) || 0) > 1) f.push({ k: "multi_tg", n: tg.mine.get(x.worker_id) });
      if (x.manual_by) f.push({ k: "manual" });
      row.flags = f;
    } else {
      delete row.answered_chat_id;
      delete row.blocked_attempts;
    }
    return row;
  });
  const st0 = await startAnswers(rs, rows);
  rows.forEach((x) => { const e = st0.get(`${x.worker_id}_${x.bhp}`); if (e) x.start = e; });
  const qs = String(q.q || "").trim().toLowerCase();
  if (qs) rows = rows.filter((x) => [x.full_name, x.login, x.referrer_text, x.match && x.match.full_name, x.facility_name]
    .some((v) => String(v || "").toLowerCase().includes(qs)));
  if (q.source) rows = rows.filter((x) => (q.source === "none" ? !x.source || x.state !== "answered" : x.source === q.source && x.state === "answered"));
  if (q.match === "todo") rows = rows.filter((x) => x.state === "answered" && (x.source === "friend" || x.source === "coord") && x.match_state === "none");
  else if (q.match) rows = rows.filter((x) => x.match_state === q.match);
  if (q.bonus) rows = rows.filter((x) => x.bonus.state === q.bonus);
  if (q.flag === "1") rows = rows.filter((x) => x.flags && x.flags.some((f) => f.k !== "multi_tg" && f.k !== "manual"));
  return { rows, from, to, today: td };
}

// ── /me ───────────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  try {
    const rs = req.rs;
    if (rs.role === "none") return res.json({ ok: true, has_access: false });
    const sites = [...(await sitesMap()).values()].filter((s) => siteAllowed(rs, s));
    const regs = await db.query(`SELECT id, name FROM reg.regions WHERE is_active ORDER BY name`);
    const coordIds = new Map();
    sites.forEach((s) => { if (s.coordinator_id) coordIds.set(s.coordinator_id, s.coordinator_name); });
    res.json({
      ok: true, has_access: true, role: rs.role, is_admin: rs.admin,
      can_match: canMatch(rs), can_pay: canPay(rs), sees_tg: seesTg(rs),
      regions: regs.rows.filter((g) => rs.role === "all" || rs.regionIds.includes(Number(g.id))),
      coordinators: [...coordIds].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      settings: { bonus_days: rs.st.bonus_days, bonus_amount: rs.st.bonus_amount, window_days: rs.st.window_days, start_date: rs.st.start_date, enabled: rs.st.enabled,
        pilot: String(rs.st.start_sites || "") !== "" && (await refBot.startOn()) },
      today: (await db.query(`SELECT to_char(ref.today(), 'YYYY-MM-DD') AS d`)).rows[0].d,
    });
  } catch (e) { fail(res, e); }
});

// ── Список ────────────────────────────────────────────────────────────
router.get("/list", async (req, res) => {
  try {
    const d = await loadRows(req.rs, req.query);
    res.json({ ok: true, ...d, role: req.rs.role });
  } catch (e) { fail(res, e); }
});

// ── Картка: деталі, Telegram, підказки ───────────────────────────────
async function oneRow(rs, workerId, bhp) {
  const d = await loadRows(rs, { from: bhp, to: bhp });
  return d.rows.find((x) => x.worker_id === workerId) || null;
}
router.get("/item", async (req, res) => {
  try {
    const wid = parseInt(req.query.worker_id, 10), bhp = req.query.bhp;
    if (!wid || !isDate(bhp)) return fail(res, new Error("worker_id, bhp"), 400);
    const row = await oneRow(req.rs, wid, bhp);
    if (!row) return fail(res, new Error("Brak dostępu lub brak rekordu"), 404);
    const out = { ok: true, row, suggestions: [], tg: null };
    if (canMatch(req.rs) && row.state === "answered" && (row.source === "friend" || row.source === "coord")) {
      out.suggestions = await suggest(row);
    }
    if (seesTg(req.rs)) {
      const mine = await db.query(
        `SELECT t.chat_id::text AS chat_id, t.tg_user_id::text AS tg_user_id, t.tg_username, t.tg_name,
                to_char(t.first_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS first_at,
                to_char(t.last_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS last_at,
                t.logins::int, t.blocked::int, c.full_name AS coordinator_name,
                (SELECT json_agg(json_build_object('id', w.id, 'login', w.login, 'full_name', w.full_name) ORDER BY w.full_name)
                   FROM (SELECT DISTINCT worker_id FROM ref.tg_log l WHERE l.chat_id = t.chat_id AND l.worker_id <> t.worker_id) o
                   JOIN public.workers w ON w.id = o.worker_id) AS others
           FROM ref.v_tg_ids t
           LEFT JOIN public.coordinators c ON c.telegram_chat_id = t.chat_id
          WHERE t.worker_id = $1
          ORDER BY t.first_at`, [wid]);
      const blocked = await db.query(
        `SELECT to_char(l.at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS at, l.chat_id::text AS chat_id, c.full_name AS coordinator_name
           FROM ref.tg_log l LEFT JOIN public.coordinators c ON c.id = l.coordinator_id
          WHERE l.worker_id = $1 AND l.event = 'blocked' ORDER BY l.at DESC LIMIT 20`, [wid]);
      // інші працівники на тому ж Telegram — лише з доступних об'єктів, решта — числом
      const keys = await allowedKeys(req.rs);
      const ids = [...new Set(mine.rows.flatMap((c) => (c.others || []).map((o) => o.id)))];
      const okIds = await allowedWorkers(keys, ids);
      mine.rows.forEach((c) => {
        const all = c.others || [];
        c.others = all.filter((o) => okIds.has(o.id));
        c.others_hidden = all.length - c.others.length;
      });
      let refChats = [];
      if (row.match_worker_id) {
        const rc = await db.query(`SELECT DISTINCT chat_id::text AS chat_id FROM ref.tg_log WHERE worker_id = $1`, [row.match_worker_id]);
        refChats = rc.rows.map((x) => x.chat_id);
      }
      out.tg = { chats: mine.rows, blocked: blocked.rows, answered_chat_id: row.answered_chat_id ? String(row.answered_chat_id) : null, referrer_chats: refChats };
    }
    res.json(out);
  } catch (e) { fail(res, e); }
});

// Пошук працівника / координатора для ручного зіставлення
router.get("/search", async (req, res) => {
  try {
    if (!canMatch(req.rs)) return fail(res, new Error("Brak uprawnień"), 403);
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, rows: [] });
    if (req.query.kind === "coord") {
      const c = await db.query(`SELECT id, full_name FROM public.coordinators WHERE COALESCE(is_active, true)`);
      return res.json({ ok: true, rows: c.rows.map((x) => ({ kind: "coord", ...x, score: nameScore(q, x.full_name) }))
        .filter((x) => x.score >= 0.5 || x.full_name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.score - a.score).slice(0, 15) });
    }
    const up = q.toUpperCase();
    const rows = (await candidates())
      .map((x) => ({ kind: "worker", ...x, score: x.login && x.login.toUpperCase() === up ? 1 : x.login && x.login.toUpperCase().startsWith(up) ? 0.99 : nameScore(q, x.full_name) }))
      .filter((x) => x.score >= 0.55).sort((a, b) => b.score - a.score).slice(0, 20);
    res.json({ ok: true, rows });
  } catch (e) { fail(res, e); }
});

// ── Дії ───────────────────────────────────────────────────────────────
async function actionRow(req, res) {
  const wid = parseInt(req.body.worker_id, 10), bhp = req.body.bhp;
  if (!wid || !isDate(bhp)) { fail(res, new Error("worker_id, bhp"), 400); return null; }
  const row = await oneRow(req.rs, wid, bhp);
  if (!row) { fail(res, new Error("Brak dostępu lub brak rekordu"), 404); return null; }
  return row;
}
router.post("/match", async (req, res) => {
  try {
    if (!canMatch(req.rs)) return fail(res, new Error("Brak uprawnień"), 403);
    const row = await actionRow(req, res); if (!row) return;
    if (!row.answer_id || row.state !== "answered" || !["friend", "coord"].includes(row.source)) return fail(res, new Error("Brak odpowiedzi z imieniem"), 400);
    if (row.bonus_paid_at) return fail(res, new Error("Premia już wypłacona — najpierw cofnij wypłatę"), 400);
    const b = req.body;
    if (b.state === "reset") {
      await db.query(`UPDATE ref.answers SET match_state = 'none', match_worker_id = NULL, match_coordinator_id = NULL, match_by = $2, match_at = now(), updated_at = now() WHERE id = $1`, [row.answer_id, req.rs.me]);
    } else if (b.state === "not_found") {
      await db.query(`UPDATE ref.answers SET match_state = 'not_found', match_worker_id = NULL, match_coordinator_id = NULL, match_by = $2, match_at = now(), updated_at = now() WHERE id = $1`, [row.answer_id, req.rs.me]);
    } else if (row.source === "friend") {
      const mw = parseInt(b.match_worker_id, 10);
      if (!mw) return fail(res, new Error("match_worker_id"), 400);
      if (mw === row.worker_id) return fail(res, new Error("Pracownik nie może polecić sam siebie"), 400);
      const ex = await db.query(`SELECT 1 FROM public.workers WHERE id = $1`, [mw]);
      if (!ex.rows.length) return fail(res, new Error("Nie ma takiego pracownika"), 400);
      await db.query(`UPDATE ref.answers SET match_state = 'confirmed', match_worker_id = $2, match_coordinator_id = NULL, match_by = $3, match_at = now(), updated_at = now() WHERE id = $1`, [row.answer_id, mw, req.rs.me]);
    } else {
      const mc = parseInt(b.match_coordinator_id, 10);
      if (!mc) return fail(res, new Error("match_coordinator_id"), 400);
      await db.query(`UPDATE ref.answers SET match_state = 'confirmed', match_coordinator_id = $2, match_worker_id = NULL, match_by = $3, match_at = now(), updated_at = now() WHERE id = $1`, [row.answer_id, mc, req.rs.me]);
    }
    res.json({ ok: true, row: await oneRow(req.rs, row.worker_id, row.bhp) });
  } catch (e) { fail(res, e); }
});
router.post("/paid", async (req, res) => {
  try {
    if (!canPay(req.rs)) return fail(res, new Error("Tylko kierownictwo"), 403);
    const row = await actionRow(req, res); if (!row) return;
    if (!row.answer_id) return fail(res, new Error("Brak odpowiedzi"), 400);
    if (req.body.paid) {
      if (row.bonus.state !== "due" && row.bonus.state !== "paid") return fail(res, new Error("Premia jeszcze się nie należy"), 400);
      const d = isDate(req.body.date) ? req.body.date : null;
      await db.query(`UPDATE ref.answers SET bonus_paid_at = COALESCE($2::date, ref.today()), bonus_paid_by = $3, bonus_note = $4, updated_at = now() WHERE id = $1`,
        [row.answer_id, d, req.rs.me, req.body.note ? String(req.body.note).slice(0, 300) : null]);
    } else {
      await db.query(`UPDATE ref.answers SET bonus_paid_at = NULL, bonus_paid_by = NULL, bonus_note = NULL, updated_at = now() WHERE id = $1`, [row.answer_id]);
    }
    res.json({ ok: true, row: await oneRow(req.rs, row.worker_id, row.bhp) });
  } catch (e) { fail(res, e); }
});
// Ручне внесення відповіді (лише адміністратор; напр. працівник без Telegram)
router.post("/manual", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    const row = await actionRow(req, res); if (!row) return;
    const src = req.body.source;
    if (!refBot.SOURCES_X.includes(src)) return fail(res, new Error("source"), 400);
    if (row.bonus_paid_at) return fail(res, new Error("Premia już wypłacona — najpierw cofnij wypłatę"), 400);
    const text = (src === "friend" || src === "coord") ? String(req.body.text || "").trim().slice(0, 80) : null;
    if ((src === "friend" || src === "coord") && text.length < 3) return fail(res, new Error("Wpisz imię i nazwisko"), 400);
    const stay = req.body.stay ? String(req.body.stay) : null;               // «na ile przyjechał»
    if (stay && !refBot.STAYS.includes(stay)) return fail(res, new Error("stay"), 400);
    await db.query(
      `INSERT INTO ref.answers (worker_id, bhp_date, facility_id, status, source, referrer_text, answered_at, manual_by, stay_plan, stay_at)
       VALUES ($1, $2::date, $3, 'answered', $4, $5, now(), $6, $7, CASE WHEN $7::text IS NOT NULL THEN now() END)
       ON CONFLICT (worker_id, bhp_date) DO UPDATE SET status = 'answered', source = EXCLUDED.source, referrer_text = EXCLUDED.referrer_text,
         stay_plan = COALESCE(EXCLUDED.stay_plan, ref.answers.stay_plan), stay_at = COALESCE(EXCLUDED.stay_at, ref.answers.stay_at),
         answered_at = now(), manual_by = EXCLUDED.manual_by, await_name = false, pending_source = NULL,
         answered_chat_id = NULL, answered_tg_user = NULL, match_state = 'none', match_worker_id = NULL,
         match_coordinator_id = NULL, updated_at = now()`,
      [row.worker_id, row.bhp, row.facility_id, src, text, req.rs.me, stay]);
    res.json({ ok: true, row: await oneRow(req.rs, row.worker_id, row.bhp) });
  } catch (e) { fail(res, e); }
});

// ── Рейтинг тих, хто приводить ───────────────────────────────────────
router.get("/ranking", async (req, res) => {
  try {
    const d = await loadRows(req.rs, req.query);
    const g = new Map();
    for (const r of d.rows) {
      if (r.state !== "answered" || r.source !== "friend" || r.match_state !== "confirmed" || !r.match) continue;
      const k = r.match.id;
      const x = g.get(k) || { referrer: r.match, brought: 0, working: 0, reached: 0, due: 0, paid: 0, lost: 0, people: [] };
      x.brought++;
      if (!r.bonus.left && r.emp_end !== undefined) x.working++;
      if (r.bonus.reached) x.reached++;
      if (r.bonus.state === "due") x.due++;
      if (r.bonus.state === "paid") x.paid++;
      if (r.bonus.state === "lost") x.lost++;
      x.people.push({ full_name: r.full_name, login: r.login, bhp: r.bhp, site_key: r.site_key, bonus: r.bonus.state, days: r.bonus.days });
      g.set(k, x);
    }
    res.json({ ok: true, from: d.from, to: d.to, rows: [...g.values()].sort((a, b) => b.brought - a.brought || b.reached - a.reached) });
  } catch (e) { fail(res, e); }
});

// ── Джерела по об'єктах ───────────────────────────────────────────────
router.get("/sources", async (req, res) => {
  try {
    const d = await loadRows(req.rs, req.query);
    const N = Number(req.rs.st.bonus_days) || 30;
    const by = new Map();
    const tot = { site_key: "Razem", hires: 0, answered: 0, friend: 0, coord: 0, recruit: 0, ads: 0, other: 0, none: 0, ret: {}, stay: {} };
    const ADS = new Set(["facebook", "instagram", "tiktok", "telegram", "jobsite"]);   // пілот: канали реклами
    const add = (x, r) => {
      x.hires++;
      const src = r.state !== "answered" ? "none" : ADS.has(r.source) ? "ads" : r.source;
      if (r.state === "answered") x.answered++;
      x[src]++;
      if (r.state === "answered") { const k = r.stay_plan || "none"; x.stay[k] = (x.stay[k] || 0) + 1; }
      // утримання: серед тих, у кого вже минуло N днів
      if (d.today >= r.bonus.due_date) {
        const e = (x.ret[src] = x.ret[src] || { n: 0, ok: 0 });
        e.n++; if (r.bonus.reached) e.ok++;
      }
    };
    for (const r of d.rows) {
      const k = r.site_key;
      const x = by.get(k) || { site_key: k, coordinator_name: r.coordinator_name, region_name: r.region_name, hires: 0, answered: 0, friend: 0, coord: 0, recruit: 0, ads: 0, other: 0, none: 0, ret: {}, stay: {} };
      add(x, r); add(tot, r);
      by.set(k, x);
    }
    res.json({ ok: true, from: d.from, to: d.to, bonus_days: N, rows: [...by.values()].sort((a, b) => b.hires - a.hires), total: tot });
  } catch (e) { fail(res, e); }
});

// ── Безпека: Telegram ─────────────────────────────────────────────────
router.get("/security", async (req, res) => {
  try {
    if (!seesTg(req.rs)) return fail(res, new Error("Brak uprawnień"), 403);
    const keys = await allowedKeys(req.rs);           // null — усі об'єкти
    const p = keys === null ? [] : [keys];
    const w = (col) => (keys === null ? "true" : workerInSites(col, 1));
    const blocked = await db.query(
      `SELECT to_char(l.at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS at, l.chat_id::text AS chat_id,
              l.worker_id, w.login, w.full_name, c.full_name AS coordinator_name, to_char(a.bhp_date, 'YYYY-MM-DD') AS bhp
         FROM ref.tg_log l JOIN public.workers w ON w.id = l.worker_id
         LEFT JOIN public.coordinators c ON c.id = l.coordinator_id
         LEFT JOIN ref.answers a ON a.id = l.answer_id
        WHERE l.event = 'blocked' AND ${w("l.worker_id")} ORDER BY l.at DESC LIMIT 300`, p);
    const coordLogins = await db.query(
      `SELECT to_char(max(l.at) AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS at, l.chat_id::text AS chat_id,
              l.worker_id, w.login, w.full_name, c.full_name AS coordinator_name, count(*)::int AS n
         FROM ref.tg_log l JOIN public.workers w ON w.id = l.worker_id
         JOIN public.coordinators c ON c.id = l.coordinator_id
        WHERE l.event = 'login' AND ${w("l.worker_id")}
        GROUP BY l.chat_id, l.worker_id, w.login, w.full_name, c.full_name ORDER BY 1 DESC LIMIT 300`, p);
    const shared = await db.query(
      `SELECT s.chat_id::text AS chat_id, s.workers::int, to_char(s.last_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI') AS last_at,
              c.full_name AS coordinator_name,
              (SELECT json_agg(json_build_object('id', w.id, 'login', w.login, 'full_name', w.full_name) ORDER BY w.full_name)
                 FROM (SELECT DISTINCT worker_id FROM ref.tg_log l WHERE l.chat_id = s.chat_id) o JOIN public.workers w ON w.id = o.worker_id) AS list
         FROM ref.v_shared_chats s LEFT JOIN public.coordinators c ON c.telegram_chat_id = s.chat_id
        WHERE ${keys === null ? "true" : `EXISTS (SELECT 1 FROM ref.tg_log l2 WHERE l2.chat_id = s.chat_id AND ${workerInSites("l2.worker_id", 1)})`}
        ORDER BY s.workers DESC, s.last_at DESC LIMIT 200`, p);
    const refChat = await db.query(
      `SELECT a.worker_id, w.login, w.full_name, to_char(a.bhp_date, 'YYYY-MM-DD') AS bhp,
              r.login AS ref_login, r.full_name AS ref_name, a.answered_chat_id::text AS chat_id
         FROM ref.answers a JOIN public.workers w ON w.id = a.worker_id JOIN public.workers r ON r.id = a.match_worker_id
        WHERE a.answered_chat_id IS NOT NULL AND a.status = 'answered' AND ${w("a.worker_id")}
          AND EXISTS (SELECT 1 FROM ref.tg_log l WHERE l.worker_id = a.match_worker_id AND l.chat_id = a.answered_chat_id)
        ORDER BY a.bhp_date DESC LIMIT 200`, p);
    // у спільних Telegram — лише працівники доступних об'єктів, інші — числом
    const ids = [...new Set(shared.rows.flatMap((x) => (x.list || []).map((o) => o.id)))];
    const okIds = await allowedWorkers(keys, ids);
    shared.rows.forEach((x) => {
      const all = x.list || [];
      x.list = all.filter((o) => okIds.has(o.id));
      x.hidden = all.length - x.list.length;
    });
    // координатори без Telegram у картці — їх неможливо розпізнати в боті
    const noTg = req.rs.role === "all"
      ? (await db.query(`SELECT id, full_name FROM public.coordinators WHERE COALESCE(is_active, true) AND telegram_chat_id IS NULL ORDER BY full_name`)).rows
      : [];
    res.json({ ok: true, blocked: blocked.rows, coord_logins: coordLogins.rows, shared: shared.rows, ref_chat: refChat.rows, coords_no_tg: noTg });
  } catch (e) { fail(res, e); }
});

// ── Тест: анкета собі в Telegram (адмін) ─────────────────────────────
const careBotOrNull = () => { try { return require("../bot/care"); } catch (e) { return null; } };
router.get("/test", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    const care = careBotOrNull();
    const c = await db.query(
      `SELECT c.id, c.full_name, (c.telegram_chat_id IS NOT NULL) AS has_tg
         FROM public.coordinators c WHERE COALESCE(c.is_active, true) ORDER BY (c.id = $1) DESC, c.full_name`, [req.rs.me]);
    let sent = [];
    try { if (care) sent = await care.testSummary(); } catch (e) { sent = []; }
    res.json({ ok: true, me: req.rs.me, coordinators: c.rows, items: refBot.TEST_ITEMS, start_on: await refBot.startOn(), sent });
  } catch (e) { fail(res, e); }
});
router.post("/test/send", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    if (!careBotOrNull()) return fail(res, new Error("Brak modułu Rozmowy (bot/care.js) — test korzysta z jego tabeli"), 400);
    const ids = (req.body?.coordinators || []).map((x) => parseInt(x, 10)).filter(Boolean);
    const items = (req.body?.items || []).filter((x) => refBot.TEST_ITEMS.includes(x));
    if (!ids.length) return fail(res, new Error("Wybierz odbiorcę"), 400);
    if (!items.length) return fail(res, new Error("Wybierz, co wysłać"), 400);
    if (ids.length > 10) return fail(res, new Error("Maksymalnie 10 odbiorców naraz"), 400);
    const result = await refBot.sendTest({ coordinatorIds: ids, items, workerLang: String(req.body?.worker_lang || "uk"), by: req.rs.me });
    res.json({ ok: true, result });
  } catch (e) { fail(res, e); }
});
router.post("/test/clear", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    const care = careBotOrNull();
    if (!care) return fail(res, new Error("Brak modułu Rozmowy"), 400);
    const ids = (req.body?.coordinators || []).map((x) => parseInt(x, 10)).filter(Boolean);
    res.json({ ok: true, result: await care.clearTests(ids.length ? ids : null), sent: await care.testSummary() });
  } catch (e) { fail(res, e); }
});

// ── Налаштування (адмін) ─────────────────────────────────────────────
const VALID = {
  enabled: (v) => v === "0" || v === "1",
  visible_coords: (v) => v === "0" || v === "1",
  window_days: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 30,
  remind_max: (v) => /^\d+$/.test(v) && +v >= 0 && +v <= 5,
  remind_time: (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(v),
  bonus_days: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 365,
  bonus_amount: (v) => v === "" || (/^\d+([.,]\d{1,2})?$/.test(v) && parseFloat(v.replace(",", ".")) <= 100000),
  start_date: (v) => isDate(v),
  start_remind_days: (v) => /^\d+$/.test(v) && +v >= 0 && +v <= 5,
  start_sites: (v) => {
    if (v === "" || v === "*") return true;
    try { const a = JSON.parse(v); return Array.isArray(a) && a.length <= 1000 && a.every((x) => typeof x === "string" && x.length <= 200); }
    catch (e) { return false; }
  },
};
router.get("/settings", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    const r = await db.query(`SELECT key, value FROM ref.settings ORDER BY key`);
    const stats = await db.query(
      `SELECT count(*)::int AS answers, count(*) FILTER (WHERE status = 'answered')::int AS answered,
              (SELECT count(*)::int FROM ref.tg_log) AS tg_events FROM ref.answers`);
    const sites = [...(await sitesMap()).values()]
      .map((x) => ({ site_key: x.site_key, region_name: x.region_name, coordinator_name: x.coordinator_name }))
      .sort((a, b) => (a.region_name ? 0 : 1) - (b.region_name ? 0 : 1) || String(a.region_name || "").localeCompare(String(b.region_name || "")) || a.site_key.localeCompare(b.site_key));
    const startActive = await refBot.startOn();
    res.json({ ok: true, settings: Object.fromEntries(r.rows.map((x) => [x.key, x.value])), stats: stats.rows[0], sites, start_active: startActive });
  } catch (e) { fail(res, e); }
});
router.patch("/settings", async (req, res) => {
  try {
    if (!req.rs.admin) return fail(res, new Error("Tylko administrator"), 403);
    const b = req.body || {};
    for (const [k, v] of Object.entries(b)) {
      if (!VALID[k]) return fail(res, new Error(`Nieznane ustawienie: ${k}`), 400);
      if (!VALID[k](String(v))) return fail(res, new Error(`Błędna wartość: ${k}`), 400);
    }
    for (const [k, v] of Object.entries(b)) {
      await db.query(`INSERT INTO ref.settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [k, k === "start_sites" ? String(v) : String(v).replace(",", "."), req.rs.me]);
    }
    refBot.resetSettingsCache();
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = { router, _test: { nameScore, translit, employmentEnd, bonusOf } };
