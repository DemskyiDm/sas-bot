// bot/hr_import.js — імпорт людей з HRappka і щоденне порівняння з таблицями (замість sync_hrrappka_diff.js).
// Дані людей — з HRappka, поділ на об'єкти / періоди — з таблиць (import_sheets.js), тому об'єкт і BHP не порівнюємо.
//   • знімок усіх працівників HRappka → hrz.people (статус, останній день, посада, дата народження…);
//   • workers.pesel, workers.birth_date, workers.hr_employee_id ← картка HRappka. PESEL — лише з HRappka
//     (імпорт таблиць його не пише, тільки шукає за ним людину); людину без картки HRappka не чіпаємо;
//   • звіт: поточний період у БД ↔ HRappka — статус, останній день, інший паспорт, кого немає в одній із систем. CSV на пошту.
//     Щодня — відкриті періоди й закриті за останні 60 днів; у понеділок — усі.
// Статуси HRappka → наші (решта — кандидати / історичні, їх порівнюємо лише якщо в нас людина працює):
//   Pracuje → pracuje; Dotarł → pracuje або unknown (у таблиці ще без статусу); Urlop, Długi urlop → urlop; L4, Długi L4 → l4;
//   Przeniesienie, Przeniesienie – czekamy → przeniesiony; Zwolniony → zwolniony; Rezygnacja → rezygnacja;
//   Zwolniony, Umowa zamknięta → rezygnacja, якщо в таблиці rezygnacja, інакше zwolniony;
//   Zwolniony, przejście bezpośrednio → pracuje, поки сьогодні < останнього дня, потім zwolniony;
//   Do zatrudnienia (=Harmonogram) → unknown; Nie dotarł — окремий стан: розбіжність лише якщо в таблиці zwolniony.
// Останній день різниться до 7 днів — беремо HRappka; понад 7 — перевірити (примітка в звіті).
// Rezygnacja: останній день беремо, якщо він є в HRappka; «у HRappka не внесено» — не розбіжність.
// Останній день — attrdef_id_58419, одне значення на людину: до поточного періоду належить, лише якщо >= BHP.
// Людину шукаємо за паспортом, потім за PESEL, потім за ПІБ (лише якщо таке ПІБ одне і в HRappka, і в базі — тоді «Паспорт»).
// PERLIK не порівнюємо. Щодня о 8:00 (Варшава), index.js. Панель (hrappka.html, api/hr_import.js) рахує те саме зі знімка — current().
// Вручну: node bot/hr_import.js [--full] [--dry] [--send] [--csv <тека>]   (--dry — без запису в БД; --send — лист)
// Таблиці: db/migration_hr_import.sql. Доступ до HRappka — ті самі змінні .env, що й у bot/hr_reason.js.
"use strict";

const axios = require("axios");
const db = require("../db");

const BASE = process.env.HRAPPKA_BASE_URL || "https://app.hrappka.pl";
const PAGE = 5000;
const LAST_DAY = `attrdef_id_${process.env.HR_LAST_DAY_ATTR || "58419"}`;
const C = "newestUserContract_USER_CONTRACT_";
const EMAIL_TO = (process.env.HR_IMPORT_EMAIL_TO ||
  "d.demskyi@saslogistic.pl,m.rosliakova@saslogistic.pl,o.kapkan@saslogistic.pl,d.ivanova@saslogistic.pl").split(/[,;\s]+/).filter(Boolean);
const IGNORE = /PERLIK/i;
const RECENT_DAYS = 60;   // щоденний звіт — закриті періоди за стільки днів

const STATE = {
  "Pracuje": "pracuje", "Dotarł": "dotarl",
  "Urlop": "urlop", "Długi urlop": "urlop", "L4": "l4", "Długi L4": "l4",
  "Przeniesienie": "przeniesiony", "Przeniesienie – czekamy": "przeniesiony",
  "Zwolniony": "zwolniony", "Zwolniony, przejście bezpośrednio": "zwolniony", "Umowa zamknięta": "zwolniony",
  "Rezygnacja": "rezygnacja",
  "Nie dotarł": "nie_dotarl",                     // окремий стан — порівнюємо лише з zwolniony
  "Do zatrudnienia (=Harmonogram)": "unknown",
};
const HR_WORK = ["pracuje", "dotarl", "urlop", "l4"];
const DB_WORK = ["pracuje", "unknown", "urlop", "l4"];

const normPass = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const normName = (s) => String(s || "").toUpperCase().split(/\s+/).filter(Boolean).sort().join(" ");
const normPesel = (s) => { const p = String(s || "").replace(/\D/g, ""); return p.length === 11 ? p : null; };
const day = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || "")) ? String(s).slice(0, 10) : null);
const text = (s) => (String(s == null ? "" : s).replace(/\s+/g, " ").trim() || null);
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayWarsaw = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());

// ── HRappka ───────────────────────────────────────────────────────────
async function headers() {
  const r = await axios.post(`${BASE}/api/v1/auth/login`, {
    email: process.env.HRAPPKA_EMAIL, password: process.env.HRAPPKA_PASSWORD,
    companyId: Number(process.env.HRAPPKA_COMPANY_ID), authenticateOldApi: true,
  }, { timeout: 30000 });
  return { Authorization: `Bearer ${r.data.data.token}`, "x-app-token": process.env.HRAPPKA_APP_TOKEN, "Content-Type": "application/json" };
}

const COLUMNS = ["id", "name", "state", "birthDate", "citizenship", "idsNumberValuePASSPORT", "idsNumberValuePESEL", LAST_DAY,
  C + "startDate", C + "endDate", C + "userContract_company_COMPANY_name",
  C + "userContract_contractor_CONTRACTOR_DEPARTMENT_name", C + "userContract_position_POSITION_name"];

function toPerson(x) {
  const end = x[C + "endDate"] || {};
  const pos = x[C + "userContract_position_POSITION_name"];
  return {
    id: Number(x.id), name: text(x.name), state: text(x.state),
    passport: normPass(x.idsNumberValuePASSPORT) || null, pesel: normPesel(x.idsNumberValuePESEL),
    birth: day(x.birthDate), citizenship: text(x.citizenship), lastDay: day(x[LAST_DAY]),
    department: text(x[C + "userContract_contractor_CONTRACTOR_DEPARTMENT_name"]),
    firm: text(x[C + "userContract_company_COMPANY_name"]),
    position: text(pos && typeof pos === "object" ? pos.pl : pos),
    start: day(x[C + "startDate"]), end: day(end.terminationDate || end.cancelDate),
  };
}

async function fetchAll() {
  const h = await headers();
  const columns = COLUMNS.map((id) => ({ id, isLocked: false, width: null }));
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = {
      id: "EMPLOYEE", offset, limit: PAGE, columns,
      filter: { logicOperator: "AND", conditions: [], subFilters: [] },
      customFilters: {}, order: { id: "ASC" }, additionalParameters: { fullConfig: false },
    };
    const r = await axios.post(`${BASE}/api/v1/table`, body, { headers: h, timeout: 300000 });
    const rows = (r.data.data && r.data.data.data) || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.map(toPerson).filter((x) => x.id);
}

// ── БД: поточний період кожного працівника (як syncWorkerStatus в import_sheets.js) ──
async function loadWorkers(client) {
  const r = await client.query(
    `SELECT w.id, w.login, w.full_name, w.pesel, to_char(w.birth_date, 'YYYY-MM-DD') AS birth, w.hr_employee_id AS hr_id,
            c.status, to_char(c.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(c.last_work_date, 'YYYY-MM-DD') AS lwd,
            f.id AS facility_id, f.name AS facility, f.group_name AS grp
       FROM public.workers w
       LEFT JOIN LATERAL (
         SELECT h.status::text AS status, h.bhp_date, h.last_work_date, h.facility_id
           FROM public.worker_facility_history h
          WHERE h.worker_id = w.id
          ORDER BY (h.last_work_date IS NULL) DESC, h.bhp_date DESC NULLS LAST, h.id DESC
          LIMIT 1
       ) c ON true
       LEFT JOIN public.facilities f ON f.id = COALESCE(c.facility_id, w.facility_id)
      WHERE COALESCE(w.login, '') NOT LIKE 'TEST_%'`);
  return r.rows.map((w) => ({ ...w, status: w.status || "unknown" }));
}

// знімок hrz.people у тому ж вигляді, що й fetchAll
async function loadPeople(client) {
  const r = await client.query(
    `SELECT hr_employee_id AS id, name, state, passport, pesel, citizenship, department, firm, position,
            to_char(birth_date, 'YYYY-MM-DD') AS birth, to_char(last_day, 'YYYY-MM-DD') AS "lastDay",
            to_char(contract_start, 'YYYY-MM-DD') AS start, to_char(contract_end, 'YYYY-MM-DD') AS "end"
       FROM hrz.people`);
  return r.rows.map((x) => ({ ...x, id: Number(x.id) }));
}

// ── Порівняння (без БД) ───────────────────────────────────────────────
// people — з fetchAll; workers — з loadWorkers. → { pairs: [{ w, p }], diffs: [{ type, w?, p?, note? }] }
const RANK = (p) => (HR_WORK.includes(STATE[p.state]) ? 2 : STATE[p.state] ? 1 : 0);
function match(people, workers) {
  const byPass = new Map(), byPesel = new Map();
  const better = (a, b) => (!a || RANK(b) > RANK(a) || (RANK(b) === RANK(a) && b.id > a.id) ? b : a);
  for (const p of people) {
    if (p.passport) byPass.set(p.passport, better(byPass.get(p.passport), p));
    if (p.pesel) byPesel.set(p.pesel, better(byPesel.get(p.pesel), p));
  }
  const pairs = workers.map((w) => {
    const p = byPass.get(normPass(w.login)) || byPesel.get(normPesel(w.pesel)) || null;
    return { w, p, how: p ? "id" : null };
  });
  // паспорт змінився — за ПІБ, якщо воно однозначне з обох боків
  const used = new Set(pairs.filter((x) => x.p).map((x) => x.p.id));
  const count = (list, f) => list.reduce((m, x) => m.set(f(x), (m.get(f(x)) || 0) + 1), new Map());
  const freeHr = people.filter((p) => !used.has(p.id));
  const hrNames = count(freeHr, (p) => normName(p.name)), dbNames = count(workers, (w) => normName(w.full_name));
  const byName = new Map(freeHr.filter((p) => hrNames.get(normName(p.name)) === 1).map((p) => [normName(p.name), p]));
  for (const x of pairs) {
    const k = normName(x.w.full_name);
    if (!x.p && k && dbNames.get(k) === 1 && byName.has(k)) { x.p = byName.get(k); x.how = "name"; }
  }
  return pairs;
}

// статус, який має бути в таблиці за станом HRappka; залежить і від статусу в таблиці, і від останнього дня
function expected(state, dbStatus, lastDay, today) {
  if (state === "Umowa zamknięta" || state === "Zwolniony") return dbStatus === "rezygnacja" ? "rezygnacja" : "zwolniony";
  if (state === "Zwolniony, przejście bezpośrednio") return lastDay && today < lastDay ? "pracuje" : "zwolniony";
  return STATE[state];
}

function statusOk(dbStatus, hr) {
  if (hr === "dotarl") return dbStatus === "pracuje" || dbStatus === "unknown";
  return dbStatus === hr;
}

function compare(people, workers, today) {
  const pairs = match(people, workers);
  const diffs = [];
  const seen = new Set();
  for (const { w, p, how } of pairs) {
    const ignored = IGNORE.test(w.facility || "") || IGNORE.test(w.grp || "") || (p && IGNORE.test(p.department || ""));
    if (p) seen.add(p.id);
    if (ignored) continue;
    const dbWork = DB_WORK.includes(w.status) && (!w.lwd || w.lwd >= today);
    if (!p) {
      if (dbWork) diffs.push({ type: "Немає в HRappka", w });
      continue;
    }
    if (STATE[p.state] === "nie_dotarl") {
      if (w.status === "zwolniony") diffs.push({ type: "Статус", w, p, hr: "nie_dotarl" });
      continue;
    }
    if (how === "name") diffs.push({ type: "Паспорт", w, p, note: "знайдено за ПІБ, у HRappka інший паспорт / PESEL" });
    // останній день з HRappka належить цьому періоду, лише якщо він не раніше BHP
    const hrLast = p.lastDay && (!w.bhp || p.lastDay >= w.bhp) ? p.lastDay : null;
    const hr = expected(p.state, w.status, hrLast || w.lwd, today);
    if (hr ? !statusOk(w.status, hr) : dbWork) diffs.push({ type: "Статус", w, p, hr });
    // rezygnacja: день беремо, якщо він є в HRappka; якщо немає — не важливо
    if (w.lwd && hrLast && w.lwd !== hrLast) {
      const gap = Math.abs(Date.parse(w.lwd) - Date.parse(hrLast)) / 864e5;
      diffs.push({ type: "Останній день", w, p, note: gap <= 7 ? "до 7 днів — беремо HRappka" : "понад 7 днів — перевірити" });
    }
    else if (!w.lwd && hrLast) diffs.push({ type: "Останній день", w, p, note: "у HRappka є, у таблиці немає" });
    else if (w.lwd && !hrLast && w.lwd <= today && (hr === "zwolniony" || hr === "przeniesiony"))
      diffs.push({ type: "Останній день", w, p, note: "у HRappka не внесено" });
  }
  for (const p of people) {
    if (!seen.has(p.id) && HR_WORK.includes(expected(p.state, null, p.lastDay, today)) && !IGNORE.test(p.department || ""))
      diffs.push({ type: "Немає в БД", p });
  }
  return { pairs, diffs };
}

// ── Запис ─────────────────────────────────────────────────────────────
async function snapshot(client, people) {
  const prev = Number((await client.query(`SELECT count(*) AS n FROM hrz.people`)).rows[0].n);
  // битий / неповний список від HRappka не повинен перезаписати знімок
  if (prev && people.length < prev * 0.8) throw new Error(`HRappka віддала ${people.length} працівників, у знімку ${prev} — пропускаю`);
  const col = (f) => people.map(f);
  await client.query(
    `INSERT INTO hrz.people (hr_employee_id, name, passport, pesel, birth_date, citizenship, state, last_day,
                             department, firm, position, contract_start, contract_end, seen_at)
     SELECT *, now() FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::date[], $6::text[], $7::text[], $8::date[],
                                 $9::text[], $10::text[], $11::text[], $12::date[], $13::date[])
     ON CONFLICT (hr_employee_id) DO UPDATE SET name = EXCLUDED.name, passport = EXCLUDED.passport, pesel = EXCLUDED.pesel,
       birth_date = EXCLUDED.birth_date, citizenship = EXCLUDED.citizenship, state = EXCLUDED.state, last_day = EXCLUDED.last_day,
       department = EXCLUDED.department, firm = EXCLUDED.firm, position = EXCLUDED.position,
       contract_start = EXCLUDED.contract_start, contract_end = EXCLUDED.contract_end, seen_at = now()`,
    [col((x) => x.id), col((x) => x.name), col((x) => x.passport), col((x) => x.pesel), col((x) => x.birth), col((x) => x.citizenship),
      col((x) => x.state), col((x) => x.lastDay), col((x) => x.department), col((x) => x.firm), col((x) => x.position),
      col((x) => x.start), col((x) => x.end)]);
  return prev;
}

// PESEL, дата народження і картка HRappka. Знайшли за ПІБ (інший паспорт) — PESEL не чіпаємо, поки не з'ясують.
// Не знайшли — зв'язок прибираємо, PESEL і дату лишаємо.
async function saveWorkers(client, pairs) {
  const pesel = ({ w, p, how }) => (how === "id" ? p.pesel : w.pesel || null);
  const set = pairs.filter((x) => (x.p ? x.p.birth && x.p.birth !== x.w.birth || String(x.p.id) !== String(x.w.hr_id) || pesel(x) !== (x.w.pesel || null) : x.w.hr_id));
  if (set.length) {
    await client.query(
      `UPDATE public.workers w SET birth_date = COALESCE(v.d, w.birth_date), hr_employee_id = v.hr,
              pesel = CASE WHEN v.hr IS NULL THEN w.pesel ELSE v.pesel END, updated_at = now()
         FROM unnest($1::int[], $2::date[], $3::bigint[], $4::text[]) AS v(id, d, hr, pesel) WHERE w.id = v.id`,
      [set.map((x) => x.w.id), set.map((x) => (x.p && x.p.birth) || null), set.map((x) => (x.p ? x.p.id : null)),
        set.map((x) => (x.p ? pesel(x) : null))]);
  }
  return set.length;
}

// ── Звіт ──────────────────────────────────────────────────────────────
const TYPES = ["Статус", "Останній день", "Паспорт", "Немає в БД", "Немає в HRappka"];
function toCsv(diffs) {
  const head = ["Тип", "Примітка", "ПІБ", "Паспорт", "Паспорт HRappka", "PESEL HRappka", "Дата народження", "Об'єкт (таблиця)", "Статус (таблиця)", "BHP",
    "Останній день (таблиця)", "Статус HRappka", "Має бути статус", "Останній день HRappka", "Відділ HRappka", "Фірма HRappka", "Посада HRappka", "Початок договору HRappka"];
  const rows = diffs.slice().sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type)).map(({ type, note, w = {}, p = {}, hr }) => [
    type, note, w.full_name || p.name, w.login || p.passport, p.passport, p.pesel, p.birth || w.birth, w.facility, w.status, w.bhp, w.lwd,
    p.state, hr, p.lastDay, p.department, p.firm, p.position, p.start]);
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  return "﻿" + [head, ...rows].map((r) => r.map(esc).join(";")).join("\r\n");
}

function summary(diffs) {
  const by = {};
  for (const d of diffs) by[d.type] = (by[d.type] || 0) + 1;
  return TYPES.filter((t) => by[t]).map((t) => `${t}: ${by[t]}`).join("\n") || "розбіжностей немає";
}

async function sendEmail(diffs, stats, today, full) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const info = await transporter.sendMail({
    from: `"SAS Bot Audit" <${process.env.GMAIL_USER}>`,
    to: EMAIL_TO,
    subject: `HRappka vs таблиці (${today}${full ? ", повний" : ""}) — розбіжностей: ${diffs.length}`,
    text: `Доброго дня!\n\nПорівняння поточних періодів у базі (з таблиць) з HRappka` +
      `${full ? " — усі періоди" : ` — відкриті періоди й закриті за ${RECENT_DAYS} днів`}.\n` +
      `HRappka: ${stats.people} людей, у базі: ${stats.workers}, знайдено в HRappka: ${stats.matched}.\n\n${summary(diffs)}\n\nДеталі — у CSV.`,
    attachments: diffs.length ? [{ filename: `hrappka_${today}.csv`, content: toCsv(diffs) }] : [],
  });
  console.log(`[hr import] лист надіслано: ${info.messageId}`);
}

// відкриті періоди й закриті за RECENT_DAYS днів
const recent = (diffs, today) => { const from = addDays(today, -RECENT_DAYS); return diffs.filter((d) => !d.w || !d.w.lwd || d.w.lwd >= from); };

// ── Запуск ────────────────────────────────────────────────────────────
// full — усі періоди (понеділок); dry — нічого не записати; notify — лист
async function run({ full = false, dry = false, notify = true } = {}) {
  const today = todayWarsaw();
  const people = await fetchAll();
  const client = await db.pool.connect();
  let res, births;
  try {
    await client.query("BEGIN");
    await snapshot(client, people);
    const workers = await loadWorkers(client);
    res = compare(people, workers, today);
    births = await saveWorkers(client, res.pairs);
    await client.query(dry ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!full) res.diffs = recent(res.diffs, today);
  const stats = { people: people.length, workers: res.pairs.length, matched: res.pairs.filter((x) => x.p).length, births };
  console.log(`[hr import] HRappka ${stats.people}, у базі ${stats.workers}, знайдено ${stats.matched}, працівників оновлено (PESEL, дата народження, картка HRappka) ${births}; ` +
    `розбіжностей ${res.diffs.length}${dry ? " — DRY, нічого не записано" : ""}\n${summary(res.diffs)}`);
  if (notify) await sendEmail(res.diffs, stats, today, full);
  return { ...res, stats, today };
}

// Для панелі: розбіжності між останнім знімком HRappka і поточними даними таблиць (без запиту до HRappka)
async function current({ full = false } = {}) {
  const today = todayWarsaw();
  const client = await db.pool.connect();
  try {
    const people = await loadPeople(client);
    const at = (await client.query(`SELECT max(seen_at) AS at FROM hrz.people`)).rows[0].at;
    const { diffs } = compare(people, await loadWorkers(client), today);
    return { diffs: full ? diffs : recent(diffs, today), snapshotAt: at, today, recentDays: RECENT_DAYS };
  } finally {
    client.release();
  }
}

let RUNNING = false;
// Кнопка «Odśwież z HRappka»: новий знімок без листа; паралельно з cron не запускаємо
async function refresh() {
  if (RUNNING) throw new Error("Import z HRappka już trwa — spróbuj za minutę");
  RUNNING = true;
  try { return await run({ notify: false }); } finally { RUNNING = false; }
}

function schedule() {
  const cron = require("node-cron");
  // щодня о 8:00; у понеділок — повний звіт
  cron.schedule("0 8 * * *", async () => {
    if (RUNNING) return;
    RUNNING = true;
    const monday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", weekday: "short" }).format(new Date()) === "Mon";
    try { await run({ full: monday }); } catch (e) { console.error("[hr import]:", e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message); } finally { RUNNING = false; }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { run, schedule, compare, current, refresh, toCsv, STATE, TYPES, _test: { fetchAll, toPerson, match } };

if (require.main === module) {
  require("dotenv").config();
  const a = process.argv.slice(2);
  (async () => {
    const r = await run({ full: a.includes("--full"), dry: a.includes("--dry"), notify: a.includes("--send") });
    const i = a.indexOf("--csv");
    if (i !== -1 && a[i + 1]) {
      const file = require("path").join(a[i + 1], `hrappka_${r.today}.csv`);
      require("fs").writeFileSync(file, toCsv(r.diffs));
      console.log("CSV:", file);
    }
    process.exit(0);
  })().catch((e) => { console.error(e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.stack); process.exit(1); });
}
