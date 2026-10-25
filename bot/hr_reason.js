// bot/hr_reason.js — причина звільнення з HRappka («Przyczyna zwolnienia 2.0», attrdef_id_75731) → рядок періоду history.
// У HRappka причина одна на працівника: при поверненні / переведенні лишається стара або затирається, історії немає.
// Тому:
//   • щодня о 5:00 (Варшава) — знімок усіх працівників HRappka (3 запити по 5000, ~30 с); зміну причини пишемо
//     в журнал hrz.reason_log з датою; потім розставляємо причини по закритих періодах за останні 60 днів;
//   • у понеділок о 5:00 — те саме по всіх періодах + підсумок тижня в Telegram;
//   • перший запуск (журнал порожній) — повний імпорт уже звільнених.
// Причина належить періоду zwolniony, якщо змінилася після BHP і не пізніше 10 днів після останнього дня
// (і до BHP наступного періоду). Записуємо перше значення й більше не чіпаємо.
// przeniesiony → «przeniesienie» (auto); якщо статус потім виправили на zwolniony — auto замінюється причиною з HRappka.
// Старі звільнення (до початку журналу + 35 днів) — поточне значення, якщо в HRappka людина звільнена і в нас це останній період.
// Не вдалося → przyczyna_problem і рядок у Telegram (HR_REASON_CHAT_ID у .env, через кому; інакше GAP_ADMIN_CHAT_ID).
// Вручну: node bot/hr_reason.js [--full] [--dry] [--send]   (--dry — усе в транзакції з ROLLBACK, нічого не пишемо)
// Таблиці: db/migration_dismissal_reason.sql. Доступ до HRappka — ті самі змінні .env, що й у bot/hr_sign.js.
"use strict";

const axios = require("axios");
const db = require("../db");

const BASE = process.env.HRAPPKA_BASE_URL || "https://app.hrappka.pl";
const ATTR = `attrdef_id_${process.env.HR_REASON_ATTR || "75731"}`;
const PAGE = 5000;
const WAIT_DAYS = 10;        // скільки днів після останнього дня чекаємо, поки HR внесе причину
const RECENT_DAYS = 60;      // щоденний прохід — періоди, що закінчилися за стільки днів
const FALLBACK_DAYS = 35;    // звільнення до початку журналу + стільки днів — беремо поточне значення HRappka
const REPORT_DAYS = 35;      // тижневий звіт — проблеми періодів за стільки днів
const AUTO = "przeniesienie";
// Статуси HRappka, за яких людина вже не працює (для старих звільнень)
const DISMISSED = /zwolnion|umowa zamkni|czarna lista|nie zatrudnia/i;
const normPass = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
const normText = (s) => (String(s || "").trim() || null);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayWarsaw = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── HRappka ───────────────────────────────────────────────────────────
async function headers() {
  const r = await axios.post(`${BASE}/api/v1/auth/login`, {
    email: process.env.HRAPPKA_EMAIL, password: process.env.HRAPPKA_PASSWORD,
    companyId: Number(process.env.HRAPPKA_COMPANY_ID), authenticateOldApi: true,
  }, { timeout: 30000 });
  return { Authorization: `Bearer ${r.data.data.token}`, "x-app-token": process.env.HRAPPKA_APP_TOKEN, "Content-Type": "application/json" };
}
// Усі працівники HRappka: id, статус, паспорт, PESEL, причина
async function fetchAll() {
  const h = await headers();
  const columns = ["id", "state", "idsNumberValuePASSPORT", "idsNumberValuePESEL", ATTR].map((id) => ({ id, isLocked: false, width: null }));
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = {
      id: "EMPLOYEE", offset, limit: PAGE, columns,
      filter: { logicOperator: "AND", conditions: [], subFilters: [] },
      customFilters: {}, order: { id: "ASC" }, additionalParameters: { fullConfig: false },
    };
    const r = await axios.post(`${BASE}/api/v1/table`, body, { headers: h, timeout: 180000 });
    const rows = (r.data.data && r.data.data.data) || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.map((x) => ({
    id: Number(x.id), state: normText(x.state), reason: normText(x[ATTR]),
    passport: normPass(x.idsNumberValuePASSPORT) || null, pesel: normText(x.idsNumberValuePESEL),
  })).filter((x) => x.id);
}

// ── Знімок: оновлюємо hrz.employees, зміни причини — у журнал ─────────
async function snapshot(client, rows) {
  const prev = new Map((await client.query(`SELECT hr_employee_id AS id, reason FROM hrz.employees`)).rows.map((x) => [Number(x.id), x.reason]));
  const first = prev.size === 0;
  // битий / неповний список від HRappka не повинен виглядати як «усім стерли причину»
  if (!first && rows.length < prev.size * 0.8) throw new Error(`HRappka віддала ${rows.length} працівників, у знімку ${prev.size} — пропускаю`);
  const changed = rows.filter((x) => (prev.has(x.id) ? prev.get(x.id) !== x.reason : x.reason !== null || first));
  if (changed.length) {
    await client.query(
      `INSERT INTO hrz.reason_log (hr_employee_id, reason, baseline)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::boolean[])`,
      [changed.map((x) => x.id), changed.map((x) => x.reason), changed.map(() => first)]);
  }
  await client.query(
    `INSERT INTO hrz.employees (hr_employee_id, passport, pesel, state, reason, seen_at)
     SELECT *, now() FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (hr_employee_id) DO UPDATE SET passport = EXCLUDED.passport, pesel = EXCLUDED.pesel,
       state = EXCLUDED.state, reason = EXCLUDED.reason, seen_at = now()`,
    [rows.map((x) => x.id), rows.map((x) => x.passport), rows.map((x) => x.pesel), rows.map((x) => x.state), rows.map((x) => x.reason)]);
  return { first, changed: changed.length, total: rows.length };
}

// ── Рішення для одного періоду (без БД) ───────────────────────────────
// p: { status, bhp, lwd, next_bhp } (дати YYYY-MM-DD); emp: { state, reason } з HRappka або null;
// log: зміни причини цього працівника [{ reason, baseline, d }] за часом; today, jstart — YYYY-MM-DD.
// → { value, source } | { wait: true } | { problem }
function decide(p, emp, log, { today, jstart }) {
  if (p.status === "przeniesiony") return { value: AUTO, source: "auto" };
  if (!emp) return { problem: "not_found" };
  const from = p.bhp || addDays(p.lwd, -RECENT_DAYS);
  const end = addDays(p.lwd, WAIT_DAYS);
  const to = p.next_bhp && p.next_bhp < end ? p.next_bhp : end;
  // причину внесли / змінили під час цього періоду (можна й за кілька тижнів до звільнення) — перше значення
  const hit = log.find((x) => !x.baseline && x.reason && x.d > from && x.d <= to);
  if (hit) return { value: hit.reason, source: "hrappka" };
  // старе звільнення: коли внесли причину — невідомо (значення з першого знімка), беремо поточне,
  // якщо в HRappka людина звільнена, у нас це останній період і після BHP причина не мінялась
  if (!p.next_bhp && emp.reason && DISMISSED.test(emp.state || "") && p.lwd < addDays(jstart, FALLBACK_DAYS)
      && !log.some((x) => !x.baseline && x.d > from)) return { value: emp.reason, source: "hrappka" };
  if (today <= to) return { wait: true };
  if (p.next_bhp && p.next_bhp <= end) return { problem: "next_period" };
  return { problem: emp.reason ? "stale" : "empty" };
}

const PROBLEM_TX = {
  not_found: () => "нет в HRappka (паспорт / PESEL)",
  next_period: () => "уже есть новый период, а причина в HRappka до него не менялась",
  stale: (r) => `причина в HRappka не обновлялась с начала периода (стоит «${r}»)`,
  empty: () => `в HRappka причина пустая (прошло ${WAIT_DAYS} дней после увольнения)`,
};

// ── Розставляємо причини ──────────────────────────────────────────────
async function assign(client, { full, today }) {
  const per = await client.query(
    `SELECT h.id, h.worker_id, h.status::text AS status, h.przyczyna_zwolnienia AS cur, h.przyczyna_zrodlo AS src, h.przyczyna_problem AS problem,
            to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(h.last_work_date, 'YYYY-MM-DD') AS lwd,
            to_char(nx.bhp, 'YYYY-MM-DD') AS next_bhp, w.login, w.pesel, w.full_name, f.name AS facility
       FROM public.worker_facility_history h
       JOIN public.workers w ON w.id = h.worker_id
       LEFT JOIN public.facilities f ON f.id = h.facility_id
       LEFT JOIN LATERAL (
         SELECT min(n.bhp_date) AS bhp FROM public.worker_facility_history n
          WHERE n.worker_id = h.worker_id AND n.id <> h.id AND n.status <> 'rezygnacja'
            AND n.bhp_date > COALESCE(h.bhp_date, h.last_work_date - ${RECENT_DAYS})
       ) nx ON true
      WHERE h.last_work_date IS NOT NULL
        AND (h.status = 'przeniesiony' AND h.przyczyna_zwolnienia IS NULL
             OR h.status = 'zwolniony' AND (h.przyczyna_zwolnienia IS NULL OR h.przyczyna_zrodlo = 'auto'))
        AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
        ${full ? "" : `AND h.last_work_date >= $1::date - ${RECENT_DAYS}`}`, full ? [] : [today]);

  const emps = (await client.query(`SELECT hr_employee_id AS id, passport, pesel, state, reason FROM hrz.employees`)).rows;
  const byPass = new Map(), byPesel = new Map();
  for (const e of emps) {
    if (e.passport && !byPass.has(e.passport)) byPass.set(e.passport, e);
    if (e.pesel && !byPesel.has(e.pesel)) byPesel.set(e.pesel, e);
  }
  const logs = new Map();
  const lr = await client.query(
    `SELECT hr_employee_id AS id, reason, baseline, to_char(seen_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD') AS d
       FROM hrz.reason_log ORDER BY seen_at, id`);
  for (const x of lr.rows) { const k = String(x.id); if (!logs.has(k)) logs.set(k, []); logs.get(k).push(x); }
  const js = lr.rows.length ? lr.rows[0].d : today;

  const set = [], clear = [], problems = [];
  const stats = { checked: per.rows.length, hrappka: 0, auto: 0, wait: 0, problems: 0 };
  for (const p of per.rows) {
    const emp = byPass.get(normPass(p.login)) || (p.pesel && byPesel.get(String(p.pesel).trim())) || null;
    const r = decide(p, emp, emp ? logs.get(String(emp.id)) || [] : [], { today, jstart: js });
    if (r.value) {
      if (!(p.src === "auto" && r.source === "auto")) set.push([p.id, r.value, r.source]);
      stats[r.source]++;
      continue;
    }
    if (r.wait) stats.wait++;
    else { stats.problems++; problems.push({ ...p, code: r.problem, hrReason: emp && emp.reason, isNew: p.problem !== r.problem }); }
    // статус виправили з przeniesiony на zwolniony — «przeniesienie» вже неправда
    if (p.src === "auto" || p.problem !== (r.problem || null)) clear.push([p.id, r.problem || null, p.src === "auto"]);
  }
  if (set.length) {
    await client.query(
      `UPDATE public.worker_facility_history h
          SET przyczyna_zwolnienia = v.val, przyczyna_zrodlo = v.src, przyczyna_at = now(), przyczyna_problem = NULL
         FROM unnest($1::int[], $2::text[], $3::text[]) AS v(id, val, src)
        WHERE h.id = v.id`, [set.map((x) => x[0]), set.map((x) => x[1]), set.map((x) => x[2])]);
  }
  if (clear.length) {
    await client.query(
      `UPDATE public.worker_facility_history h
          SET przyczyna_problem = v.problem,
              przyczyna_zwolnienia = CASE WHEN v.drop THEN NULL ELSE h.przyczyna_zwolnienia END,
              przyczyna_zrodlo = CASE WHEN v.drop THEN NULL ELSE h.przyczyna_zrodlo END,
              przyczyna_at = CASE WHEN v.drop THEN NULL ELSE h.przyczyna_at END
         FROM unnest($1::int[], $2::text[], $3::boolean[]) AS v(id, problem, drop)
        WHERE h.id = v.id`, [clear.map((x) => x[0]), clear.map((x) => x[1]), clear.map((x) => x[2])]);
  }
  return { stats, problems };
}

// ── Telegram ──────────────────────────────────────────────────────────
let BOT = null;
const chats = () => String(process.env.HR_REASON_CHAT_ID || process.env.GAP_ADMIN_CHAT_ID || "").split(/[,;\s]+/).filter(Boolean);
const line = (x) => `• ${esc(x.full_name)} (${esc(x.login)}) — ${esc(x.facility || "?")}, уволен ${dmy(x.lwd)}: ${esc(PROBLEM_TX[x.code](x.hrReason))}`;
const csv = (list) => "﻿" + [["ФИО", "Паспорт", "Объект", "BHP", "Последний день", "Что не так"],
  ...list.map((x) => [x.full_name, x.login, x.facility || "", dmy(x.bhp), dmy(x.lwd), PROBLEM_TX[x.code](x.hrReason)])]
  .map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
const MAX_LINES = 40;

async function send(head, list, filename) {
  const ids = chats();
  if (!BOT || !ids.length) { console.warn("[hr reason] Telegram: немає бота або HR_REASON_CHAT_ID — звіт не надіслано"); return; }
  const sorted = list.slice().sort((a, b) => (b.lwd || "").localeCompare(a.lwd || ""));
  const body = sorted.slice(0, MAX_LINES).map(line);
  if (sorted.length > MAX_LINES) body.push(`… ещё ${sorted.length - MAX_LINES} — в файле`);
  const chunks = [];
  let cur = head;
  for (const l of body) { if ((cur + "\n" + l).length > 3900) { chunks.push(cur); cur = l; } else cur += "\n" + l; }
  chunks.push(cur);
  for (const id of ids) {
    try {
      for (const c of chunks) await BOT.telegram.sendMessage(id, c, { parse_mode: "HTML", disable_web_page_preview: true });
      if (sorted.length > MAX_LINES) await BOT.telegram.sendDocument(id, { source: Buffer.from(csv(sorted), "utf8"), filename });
    } catch (e) {
      console.error(`[hr reason] Telegram ${id}:`, (e.response && e.response.description) || e.message);
    }
  }
}

// ── Запуск ────────────────────────────────────────────────────────────
// full — усі періоди (понеділок / перший запуск); dry — нічого не записати; notify — звіт у Telegram
async function run({ full = false, dry = false, notify = true } = {}) {
  const today = todayWarsaw();
  const rows = await fetchAll();
  const client = await db.pool.connect();
  let snap, res, week;
  try {
    await client.query("BEGIN");
    snap = await snapshot(client, rows);
    const isFull = full || snap.first;
    res = await assign(client, { full: isFull, today });
    week = (await client.query(
      `SELECT count(*) FILTER (WHERE przyczyna_zrodlo = 'hrappka')::int AS hrappka, count(*) FILTER (WHERE przyczyna_zrodlo = 'auto')::int AS auto
         FROM public.worker_facility_history WHERE przyczyna_at >= now() - interval '7 days'`)).rows[0];
    await client.query(dry ? "ROLLBACK" : "COMMIT");
    res.isFull = isFull;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const s = res.stats;
  console.log(`[hr reason] HRappka ${snap.total}, змін причини ${snap.changed}${snap.first ? " (перший знімок)" : ""}; ` +
    `періодів ${s.checked}: з HRappka ${s.hrappka}, przeniesienie ${s.auto}, чекаємо ${s.wait}, не вдалося ${s.problems}${dry ? " — DRY, нічого не записано" : ""}`);
  if (!notify || dry) return { snap, ...res, week };

  const sum = `записано из HRappka: <b>${s.hrappka}</b>, «przeniesienie»: <b>${s.auto}</b>, не удалось: <b>${s.problems}</b>`;
  if (snap.first) {
    await send(`📋 <b>Причины увольнения — первый импорт</b>\nпроверено периодов: ${s.checked}\n${sum}`, res.problems, `przyczyny_${today}.csv`);
  } else if (res.isFull) {
    const recent = res.problems.filter((x) => x.lwd >= addDays(today, -REPORT_DAYS));
    const older = res.problems.length - recent.length;
    await send(`📋 <b>Причины увольнения — неделя до ${dmy(today)}</b>\n` +
      `за 7 дней записано из HRappka: <b>${week.hrappka}</b>, «przeniesienie»: <b>${week.auto}</b>\n` +
      `не удалось (уволены за ${REPORT_DAYS} дней): <b>${recent.length}</b>${older ? ` · старше: ${older}` : ""}`, recent, `przyczyny_${today}.csv`);
  } else {
    const fresh = res.problems.filter((x) => x.isNew);
    if (fresh.length) await send(`⚠️ <b>Причина увольнения — не удалось (${fresh.length})</b>`, fresh, `przyczyny_${today}.csv`);
  }
  return { snap, ...res, week };
}

let RUNNING = false;
function schedule(bot) {
  BOT = bot || null;
  const cron = require("node-cron");
  // щодня о 5:00; у понеділок — повний прохід і підсумок тижня
  cron.schedule("0 5 * * *", async () => {
    if (RUNNING) return;
    RUNNING = true;
    const monday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", weekday: "short" }).format(new Date()) === "Mon";
    try { await run({ full: monday }); } catch (e) { console.error("[hr reason]:", e.message); } finally { RUNNING = false; }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { run, schedule, decide, PROBLEM_TX, _test: { setBot: (b) => { BOT = b; }, fetchAll, snapshot, assign, todayWarsaw } };

if (require.main === module) {
  require("dotenv").config();
  const a = process.argv.slice(2);
  (async () => {
    if (a.includes("--send")) {
      const { Telegraf } = require("telegraf");
      BOT = new Telegraf(process.env.BOT_TOKEN);
    }
    const r = await run({ full: a.includes("--full"), dry: a.includes("--dry"), notify: a.includes("--send") });
    const by = {};
    for (const x of r.problems) by[x.code] = (by[x.code] || 0) + 1;
    console.log("проблеми:", by);
    for (const x of r.problems.slice(0, 15)) console.log(" ", x.full_name, x.login, x.facility, x.bhp, "→", x.lwd, x.code, x.hrReason || "");
    process.exit(0);
  })().catch((e) => { console.error(e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.stack); process.exit(1); });
}
