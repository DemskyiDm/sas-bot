// bot/hr_import.js — люди й поточні періоди з HRappka; таблиці — лише для порівняння (замість sync_hrrappka_diff.js).
//   • знімок усіх працівників HRappka → hrz.people (статус, останній день, договір, посада, дата народження…);
//   • у worker_facility_history пишемо лише те, що змінилось у HRappka відносно вже записаного (hrz.people_applied):
//     стан → статус, останній день, новий договір → новий період (відкритий попередній закриваємо днем раніше),
//     відділ → об'єкт, посада; hr_state — стан HRappka. Старі періоди не чіпаємо. Людину, яка стала працювати
//     в HRappka, а в базі її немає, — додаємо. Не записане (невідомий об'єкт, лише за ПІБ, помилка) — пробуємо знову;
//   • об'єкт: відділ + фірма HRappka; де один відділ — кілька наших об'єктів (CAINIAO APT / APT 2, Dipico / Dipico 2,
//     Action…), — об'єкт з таблиці (рядок того самого договору);
//   • workers.pesel, workers.birth_date, workers.hr_employee_id ← картка HRappka;
//   • таблиці (import_sheets.js) пишуть лише копію hrz.sheet_periods; одразу після кожного імпорту таблиць — імпорт
//     HRappka (afterSheets), тож порівняння бачить обидва джерела на один момент (hrz.runs — коли);
//   • звіт: таблиці ↔ HRappka — статус, останній день, об'єкт, інший паспорт, кого немає в одній із систем. CSV на пошту.
//     Щодня — відкриті періоди й закриті за останні 60 днів; у понеділок — усі.
// Статуси HRappka → наші (решта — кандидати / історичні: період не чіпаємо, у звіті — лише якщо в таблиці людина працює):
//   Pracuje → pracuje; Dotarł → pracuje (у таблиці може бути ще unknown); Urlop, Długi urlop → urlop; L4, Długi L4 → l4;
//   Przeniesienie, Przeniesienie – czekamy → przeniesiony; Rezygnacja → rezygnacja;
//   Zwolniony, Umowa zamknięta → rezygnacja, якщо в таблиці rezygnacja, інакше zwolniony;
//   Zwolniony, przejście bezpośrednio → pracuje, поки сьогодні < останнього дня, потім zwolniony;
//   Do zatrudnienia (=Harmonogram) → unknown; Nie dotarł → у базі rezygnacja (такого статусу немає), у звіті — лише проти zwolniony.
// Останній день різниться до 7 днів — беремо HRappka; понад 7 — перевірити (примітка в звіті).
// Rezygnacja — людина не почала працювати: останній день і BHP не порівнюємо (і в ротації такі періоди не рахуються — reg.v_periods).
// Останній день — attrdef_id_58419, одне значення на людину: до поточного періоду належить, лише якщо >= BHP.
// Людину шукаємо за паспортом, потім за PESEL, потім за ПІБ (лише якщо таке ПІБ одне з обох боків — тоді «Паспорт»).
// PERLIK не чіпаємо. Імпорт о 6, 8, 10, 12, 16, 20 (Варшава): таблиці → HRappka; лист — о 8:00; schedule() з index.js. Панель (hrappka.html, api/hr_import.js) рахує те саме зі знімка — current().
// Вручну: node bot/hr_import.js [--full] [--dry] [--send] [--csv <тека>]   (--dry — без запису в БД; --send — лист)
// Таблиці: db/migration_hr_import.sql, db/migration_hr_current.sql. Доступ до HRappka — ті самі змінні .env, що й у bot/hr_reason.js.
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
const SAME_DAYS = 31;     // договір HRappka і період у базі / таблиці — той самий, якщо початок і BHP різняться не більше

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
            c.hid, c.status, to_char(c.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(c.last_work_date, 'YYYY-MM-DD') AS lwd,
            c.stanowisko, c.hr_state, c.source_sheet, f.id AS facility_id, f.name AS facility, f.group_name AS grp
       FROM public.workers w
       LEFT JOIN LATERAL (
         SELECT h.id AS hid, h.status::text AS status, h.bhp_date, h.last_work_date, h.facility_id, h.stanowisko, h.hr_state, h.source_sheet
           FROM public.worker_facility_history h
          WHERE h.worker_id = w.id
          ORDER BY (h.last_work_date IS NULL) DESC, h.bhp_date DESC NULLS LAST, h.id DESC
          LIMIT 1
       ) c ON true
       LEFT JOIN public.facilities f ON f.id = COALESCE(c.facility_id, w.facility_id)
      WHERE COALESCE(w.login, '') NOT LIKE 'TEST_%'`);
  return r.rows.map((w) => ({ ...w, status: w.hid ? w.status : "unknown" }));
}

// ── Таблиці: копія рядків (hrz.sheet_periods, пише import_sheets.js) — поточний рядок кожного паспорта ──
// Той самий вигляд, що й loadWorkers: compare() порівнює HRappka саме з таблицями.
async function loadSheets(client) {
  const r = await client.query(
    `SELECT DISTINCT ON (s.passport)
            w.id, s.passport AS login, COALESCE(w.full_name, s.full_name) AS full_name, COALESCE(s.pesel, w.pesel) AS pesel,
            to_char(w.birth_date, 'YYYY-MM-DD') AS birth, w.hr_employee_id AS hr_id,
            s.status, to_char(s.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(s.last_work_date, 'YYYY-MM-DD') AS lwd,
            f.id AS facility_id, f.name AS facility, f.group_name AS grp
       FROM hrz.sheet_periods s
       LEFT JOIN public.workers w ON w.login = s.passport
       LEFT JOIN public.facilities f ON f.id = s.facility_id
      WHERE s.passport NOT LIKE 'TEST_%'
      ORDER BY s.passport, (s.last_work_date IS NULL) DESC, s.bhp_date DESC NULLS LAST, s.id DESC`);
  return r.rows;
}

// знімок hrz.people (або hrz.people_applied) у тому ж вигляді, що й fetchAll
async function loadPeople(client, table = "hrz.people") {
  const r = await client.query(
    `SELECT hr_employee_id AS id, name, state, passport, pesel, citizenship, department, firm, position,
            to_char(birth_date, 'YYYY-MM-DD') AS birth, to_char(last_day, 'YYYY-MM-DD') AS "lastDay",
            to_char(contract_start, 'YYYY-MM-DD') AS start, to_char(contract_end, 'YYYY-MM-DD') AS "end"
       FROM ${table}`);
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

// Об'єкт HRappka — відділ + фірма договору; один відділ буває кількома нашими об'єктами
// (CAINIAO APT / APT 2, Dipico / Dipico 2, Action Zamienie / Przejęcie…). Які об'єкти в кожного відділу — з таблиць:
// той самий договір (початок ≈ BHP), на якому об'єкті людина в таблиці. Об'єкт, що трапився лише раз, — помилка, не варіант.
const depKey = (p) => `${p.department || ""}|${p.firm || ""}`;
function facilityMap(pairs) {
  const m = new Map();
  for (const { w, p } of pairs) {
    if (!p || !p.department || !w.facility_id || !p.start || !w.bhp || Math.abs(Date.parse(p.start) - Date.parse(w.bhp)) > SAME_DAYS * 864e5) continue;
    if (!m.has(depKey(p))) m.set(depKey(p), new Map());
    const c = m.get(depKey(p));
    c.set(w.facility_id, (c.get(w.facility_id) || 0) + 1);
  }
  for (const c of m.values()) if (c.size > 1) for (const [id, n] of c) if (n < 2) c.delete(id);
  return m;
}
// об'єкт людини: перший з prefer (таблиця, база), що є серед об'єктів відділу; інакше найчастіший; відділ невідомий — перший з prefer
function pickFacility(p, fmap, ...prefer) {
  const c = fmap.get(depKey(p));
  if (!p.department || !c || !c.size) return prefer.find(Boolean) || null;
  return prefer.find((id) => id && c.has(id)) || [...c].sort((a, b) => b[1] - a[1])[0][0];
}

// people — з HRappka; workers — поточні рядки таблиць (loadSheets); fmap — facilityMap, без нього об'єкт не порівнюємо
function compare(people, workers, today, fmap = null) {
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
    if (fmap && p.department && w.facility_id && w.status !== "rezygnacja" && STATE[p.state] !== "rezygnacja") {
      const fac = pickFacility(p, fmap, w.facility_id);
      if (fac && fac !== w.facility_id) diffs.push({ type: "Об'єкт", w, p, fac });
    }
    if (how === "name") diffs.push({ type: "Паспорт", w, p, note: "знайдено за ПІБ, у HRappka інший паспорт / PESEL" });
    // останній день з HRappka належить цьому періоду, лише якщо він не раніше BHP
    const hrLast = p.lastDay && (!w.bhp || p.lastDay >= w.bhp) ? p.lastDay : null;
    const hr = expected(p.state, w.status, hrLast || w.lwd, today);
    if (hr ? !statusOk(w.status, hr) : dbWork) diffs.push({ type: "Статус", w, p, hr });
    // rezygnacja — людина не почала працювати: ні BHP, ні останній день не порівнюємо
    if (hr === "rezygnacja" || w.status === "rezygnacja") continue;
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
      diffs.push({ type: "Немає в таблиці", p });
  }
  return { pairs, diffs };
}

// ── Запис ─────────────────────────────────────────────────────────────
// table — hrz.people (знімок) або hrz.people_applied (те, що вже записано в базу)
async function snapshot(client, people, table = "hrz.people") {
  const prev = Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  // битий / неповний список від HRappka не повинен перезаписати знімок
  if (table === "hrz.people" && prev && people.length < prev * 0.8) throw new Error(`HRappka віддала ${people.length} працівників, у знімку ${prev} — пропускаю`);
  const col = (f) => people.map(f);
  await client.query(
    `INSERT INTO ${table} (hr_employee_id, name, passport, pesel, birth_date, citizenship, state, last_day,
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

// ── Поточний період з HRappka → worker_facility_history ─────────────────
// Старі періоди не чіпаємо. Договір HRappka і поточний період у базі — той самий, якщо BHP різняться до SAME_DAYS днів
// або це продовження договору на тому ж об'єкті: оновлюємо об'єкт, статус, BHP, останній день, посаду.
// Договір HRappka новіший — новий період, а відкритий попередній закриваємо днем раніше.
// Старіший (у базі вже новіший період) — не чіпаємо. Людину, що в HRappka працює, а в базі її немає, — додаємо.
// Статусу «Nie dotarł» у базі немає — пишемо rezygnacja (не почав працювати, ніде не рахується), сам стан — у hr_state.
const DB_STATUS = { dotarl: "pracuje", nie_dotarl: "rezygnacja" };

// rows — усі рядки таблиць по паспорту: для договору HRappka беремо рядок того самого договору (BHP ≈ початок),
// серед кількох (людина на двох аркушах з тим самим BHP) — на об'єкті, що вже в базі; немає такого — поточний рядок таблиці
// prev — HRappka, уже записана в базу (hrz.people_applied, id → людина): записуємо лише те, що змінилось після неї
// (стан → статус, останній день, початок договору → BHP / новий період, відділ → об'єкт, посада). Без prev — усе (тести).
// pending — люди, чию зміну не записали з причини, що може зникнути (невідомий об'єкт, лише за ПІБ, помилка):
// для них prev не оновлюємо, і наступний імпорт пробує знову.
// objectOnly — після імпорту таблиць: лише об'єкт періодів, які вже записала HRappka (APT / APT 2 тощо з таблиці).
function plan(people, dbWorkers, sheets, fmap, today, rows = new Map(), { prev = null, objectOnly = false } = {}) {
  const cur = new Map(match(people, sheets).filter((x) => x.p).map((x) => [x.p.id, x.w]));
  const sheetRow = (p, w) => {
    const c = cur.get(p.id);
    if (!c) return null;
    const same = (rows.get(c.login) || []).filter((r) => p.start && r.bhp && Math.abs(Date.parse(p.start) - Date.parse(r.bhp)) <= SAME_DAYS * 864e5);
    return same.find((r) => w && r.facility_id === w.facility_id) || same[0] || c;
  };
  const ops = [], skip = {}, pending = new Set();
  const no = (why, p = null) => { skip[why] = (skip[why] || 0) + 1; if (p) pending.add(p.id); };
  const dbNames = new Set(dbWorkers.map((w) => normName(w.full_name)).filter(Boolean));
  const near = (a, b) => !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_DAYS * 864e5;
  const WORKING = ["pracuje", "unknown", "urlop", "l4"];
  const done = new Set();
  const target = (p, w) => {
    const st = STATE[p.state];
    if (st === undefined) return no("стан HRappka не наш (кандидат тощо)");
    if (IGNORE.test(p.department || "") || (w && (IGNORE.test(w.facility || "") || IGNORE.test(w.grp || "")))) return no("PERLIK");
    const s = sheetRow(p, w);
    const bhp = p.start || (w && w.bhp) || (s && s.bhp);
    if (!bhp) return no("немає договору в HRappka", p);
    const facility_id = pickFacility(p, fmap, s && s.facility_id, w && w.facility_id);
    if (!facility_id) return no("невідомий об'єкт (відділ HRappka без відповідності)", p);
    const lwd = p.lastDay && p.lastDay >= bhp ? p.lastDay : null;
    // правила «Umowa zamknięta / Zwolniony + rezygnacja» — від статусу того самого договору: у базі, інакше в таблиці
    const base = w && w.hid && (!w.bhp || near(w.bhp, p.start)) ? w.status : s && near(s.bhp, p.start) ? s.status : w && w.hid ? w.status : null;
    const status = expected(p.state, base, lwd, today);
    return { facility_id, bhp, lwd, status: DB_STATUS[status] || status, stanowisko: p.position, hr_state: p.state };
  };
  // що змінилось у HRappka → які поля періоду можна міняти
  const ALL = { state: 1, lastDay: 1, start: 1, dep: 1, position: 1 };
  const delta = (p) => {
    if (objectOnly) return { dep: 1 };
    const o = prev && prev.get(p.id);
    if (!prev || !o) return ALL;
    const d = {};
    if (o.state !== p.state) d.state = 1;
    if (p.state === "Zwolniony, przejście bezpośrednio") d.tick = 1;   // pracuje → zwolniony, коли мине останній день
    if ((o.lastDay || null) !== (p.lastDay || null)) d.lastDay = 1;
    if ((o.start || null) !== (p.start || null)) d.start = 1;
    if (depKey(o) !== depKey(p)) d.dep = 1;
    if ((o.position || null) !== (p.position || null)) d.position = 1;
    return d;
  };
  const FIELD = { status: ["state", "lastDay", "tick"], hr_state: ["state"], lwd: ["lastDay"], bhp: ["start"], facility_id: ["dep", "start"], stanowisko: ["position", "start"] };
  for (const { w, p, how } of match(people, dbWorkers)) {
    if (!p || done.has(p.id)) continue;
    done.add(p.id);
    const d = delta(p);
    if (!Object.keys(d).length) continue;
    if (objectOnly && !(w.hid && w.source_sheet === "HRappka")) continue;
    // знайшли лише за ПІБ (паспорт інший) — може бути інша людина: не пишемо, доки паспорт не з'ясують (звіт «Паспорт»)
    if (how === "name") { no("знайдено лише за ПІБ — перевірити паспорт", p); continue; }
    const t = target(p, w);
    if (!t) continue;
    if (!w.hid) { if (d.start || d.state) ops.push({ op: "insert", w, p, t }); continue; }
    const gap = w.bhp ? (Date.parse(t.bhp) - Date.parse(w.bhp)) / 864e5 : 0;
    const renewal = gap > 0 && w.facility_id === t.facility_id && (!w.lwd || w.lwd >= addDays(t.bhp, -14));
    const same = Math.abs(gap) <= SAME_DAYS || renewal;
    if (!same && gap > 0 && d.start) {
      // новий договір — новий період; відкритий попередній закриваємо днем раніше
      ops.push({ op: "insert", w, p, t });
      if (!w.lwd) ops.push({ op: "close", w, p, t: { lwd: w.status === "rezygnacja" ? w.bhp : addDays(t.bhp, -1),
        status: w.status === "rezygnacja" ? "rezygnacja" : w.facility_id === t.facility_id ? "zwolniony" : "przeniesiony" } });
      continue;
    }
    if (gap < -SAME_DAYS) { no("у базі новіший період, ніж договір HRappka"); continue; }
    // той самий договір — або договір у HRappka давно новіший за період у базі (розбіжність була ще до імпорту з HRappka):
    // тоді в поточному періоді міняємо лише статус, останній день і посаду, а BHP і об'єкт — ні
    if (renewal && gap > SAME_DAYS) t.bhp = w.bhp;            // продовження договору — BHP періоду лишається
    const old = { facility_id: w.facility_id, bhp: w.bhp, lwd: w.lwd, status: w.status, stanowisko: w.stanowisko, hr_state: w.hr_state };
    let changed = Object.keys(t).filter((k) => (t[k] || null) !== (old[k] || null) && !(k === "stanowisko" && !t[k])
      && FIELD[k].some((x) => d[x]) && (same || !["bhp", "facility_id"].includes(k)));
    const lwd = changed.includes("lwd") ? t.lwd : old.lwd;
    // робочий статус на закритому періоді — швидше новий договір, якого HRappka ще не показала: не міняємо
    if (changed.includes("status") && WORKING.includes(t.status) && lwd && lwd < today) {
      changed = changed.filter((k) => k !== "status" && k !== "hr_state");
      no("період закрито, а в HRappka людина працює — перевірити");
    }
    for (const k of Object.keys(t)) if (!changed.includes(k)) t[k] = old[k];   // решту лишаємо як у базі
    if (changed.length) ops.push({ op: "update", w, p, t, changed });
  }
  // працює в HRappka, а в базі немає — додаємо людину
  for (const p of people) {
    if (objectOnly || done.has(p.id) || !p.passport || !["pracuje", "dotarl", "urlop", "l4", "unknown"].includes(STATE[p.state])) continue;
    if (prev && prev.has(p.id) && prev.get(p.id).state === p.state) continue;   // працював і раніше — не нова подія
    // у базі є людина з таким ПІБ (паспорт змінився?) — не дублюємо, доки не з'ясують
    if (dbNames.has(normName(p.name))) { no("у базі є людина з таким ПІБ — перевірити паспорт", p); continue; }
    const t = target(p, null);
    if (t) ops.push({ op: "create", p, t });
  }
  return { ops, skip, pending };
}

async function write(client, ops) {
  let ok = 0;
  const errors = [], failed = new Set(), pending = new Set();
  const set = (t) => [t.facility_id, t.status, t.bhp, t.lwd, t.stanowisko || null, t.hr_state];
  const ins = `INSERT INTO public.worker_facility_history (worker_id, facility_id, status, bhp_date, last_work_date, stanowisko, hr_state, source_sheet, imported_at)
               VALUES ($1, $2, $3::worker_status, $4, $5, $6, $7, 'HRappka', now())`;
  for (const x of ops) {
    if (x.op === "close" && failed.has(x.w.id)) continue;   // новий період не записався — попередній не закриваємо
    await client.query("SAVEPOINT op");
    try {
      if (x.op === "update") {
        await client.query(
          `UPDATE public.worker_facility_history SET facility_id = $2, status = $3::worker_status, bhp_date = $4, last_work_date = $5,
                  stanowisko = COALESCE($6, stanowisko), hr_state = $7, source_sheet = 'HRappka', imported_at = now() WHERE id = $1`,
          [x.w.hid, ...set(x.t)]);
      } else if (x.op === "close") {
        await client.query(`UPDATE public.worker_facility_history SET last_work_date = $2, status = $3::worker_status, imported_at = now() WHERE id = $1`,
          [x.w.hid, x.t.lwd, x.t.status]);
      } else {
        let id = x.w && x.w.id;
        if (x.op === "create") {
          const [last, ...first] = String(x.p.name || x.p.passport).split(" ");
          id = (await client.query(
            `INSERT INTO public.workers (login, full_name, last_name, first_name, pesel, birth_date, hr_employee_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [x.p.passport, x.p.name || x.p.passport, last, first.join(" ") || null, x.p.pesel, x.p.birth, x.p.id])).rows[0].id;
        }
        await client.query(ins, [id, ...set(x.t)]);
      }
      await client.query("RELEASE SAVEPOINT op");
      ok++;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT op");
      if (x.w) failed.add(x.w.id);
      pending.add(x.p.id);
      errors.push(`${x.op} ${(x.w && x.w.login) || x.p.passport} ${x.p.name}: ${e.message}`);
    }
  }
  return { ok, errors, pending };
}

// workers.status — статус поточного періоду (як було в import_sheets.js)
async function syncWorkerStatus(client) {
  const r = await client.query(`
    UPDATE public.workers w SET status = c.status
      FROM (SELECT DISTINCT ON (h.worker_id) h.worker_id, h.status FROM public.worker_facility_history h
             ORDER BY h.worker_id, (h.last_work_date IS NULL) DESC, h.bhp_date DESC NULLS LAST, h.id DESC) c
     WHERE w.id = c.worker_id AND w.status IS DISTINCT FROM c.status`);
  return r.rowCount;
}

// знімок → поточні періоди в базі. people — свіжі з HRappka або зі знімка
async function apply(client, people, today, { dry = false, prev = null, objectOnly = false } = {}) {
  const sheets = await loadSheets(client);
  const fmap = facilityMap(match(people, sheets));
  const dbWorkers = await loadWorkers(client);
  const rows = new Map();
  for (const r of (await client.query(
    `SELECT passport, facility_id, status, to_char(bhp_date, 'YYYY-MM-DD') AS bhp, to_char(last_work_date, 'YYYY-MM-DD') AS lwd
       FROM hrz.sheet_periods ORDER BY (last_work_date IS NULL) DESC, bhp_date DESC NULLS LAST, id DESC`)).rows) {
    if (!rows.has(r.passport)) rows.set(r.passport, []);
    rows.get(r.passport).push(r);
  }
  const { ops, skip, pending } = plan(people, dbWorkers, sheets, fmap, today, rows, { prev, objectOnly });
  const count = (op) => ops.filter((x) => x.op === op).length;
  const res = { update: count("update"), insert: count("insert"), close: count("close"), create: count("create"), skip, ops, pending };
  if (dry) return res;
  const w = await write(client, ops);
  for (const id of w.pending) pending.add(id);
  Object.assign(res, { ok: w.ok, errors: w.errors });
  res.births = await saveWorkers(client, match(people, await loadWorkers(client)));
  res.synced = await syncWorkerStatus(client);
  return res;
}

// ── Звіт ──────────────────────────────────────────────────────────────
const TYPES = ["Статус", "Останній день", "Об'єкт", "Паспорт", "Немає в таблиці", "Немає в HRappka"];
function toCsv(diffs) {
  const head = ["Тип", "Примітка", "ПІБ", "Паспорт", "Паспорт HRappka", "PESEL HRappka", "Дата народження", "Об'єкт (таблиця)", "Статус (таблиця)", "BHP",
    "Останній день (таблиця)", "Статус HRappka", "Має бути статус", "Останній день HRappka", "Об'єкт HRappka", "Відділ HRappka", "Фірма HRappka", "Посада HRappka", "Початок договору HRappka"];
  const rows = diffs.slice().sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type)).map((d) => [d, d.w || {}, d.p || {}]).map(([d, w, p]) => [
    d.type, d.note, w.full_name || p.name, w.login || p.passport, p.passport, p.pesel, p.birth || w.birth, w.facility, w.status, w.bhp, w.lwd,
    p.state, d.hr, p.lastDay, d.facName, p.department, p.firm, p.position, p.start]);
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
    text: `Доброго дня!\n\nПоточні періоди в базі — з HRappka. Порівняння таблиць з HRappka` +
      `${full ? " — усі періоди" : ` — відкриті періоди й закриті за ${RECENT_DAYS} днів`}.\n` +
      `HRappka: ${stats.people} людей, у таблицях: ${stats.workers}, знайдено в HRappka: ${stats.matched}.\n` +
      `${applySummary(stats.applied)}\n\n${summary(diffs)}\n\nДеталі — у CSV.`,
    attachments: diffs.length ? [{ filename: `hrappka_${today}.csv`, content: toCsv(diffs) }] : [],
  });
  console.log(`[hr import] лист надіслано: ${info.messageId}`);
}

// відкриті періоди й закриті за RECENT_DAYS днів
const recent = (diffs, today) => { const from = addDays(today, -RECENT_DAYS); return diffs.filter((d) => !d.w || !d.w.lwd || d.w.lwd >= from); };

// Знімок і запис з HRappka — по черзі (кнопка, імпорт після таблиць, cron): наступний чекає на попередній, а не пропускається
let CHAIN = Promise.resolve();
let BUSY = false;
function exclusive(fn) {
  const job = CHAIN.then(async () => { BUSY = true; try { return await fn(); } finally { BUSY = false; } });
  CHAIN = job.catch(() => {});
  return job;
}
let LAST = null;   // останній імпорт HRappka: { at, stats } — для листа о 8:00

// ── Запуск ────────────────────────────────────────────────────────────
// розбіжності таблиць з HRappka; d.facName — об'єкт за HRappka (для «Об'єкт»)
// у базі вже стоїть те, що каже HRappka (виправили базу, таблиця ще стара) — такої розбіжності не показуємо
function fixedInDb(d, cur) {
  if (!cur || !cur.hid) return false;
  if (d.type === "Статус") return !!d.hr && (d.hr === "nie_dotarl" ? cur.status === "rezygnacja" : statusOk(cur.status, d.hr));
  if (d.type === "Останній день") return d.note !== "у HRappka не внесено" && !!d.p.lastDay && cur.lwd === d.p.lastDay;
  if (d.type === "Об'єкт") return cur.facility_id === d.fac;
  return false;
}

async function diffsFor(client, people, today) {
  const sheets = await loadSheets(client);
  const pairs = match(people, sheets);
  const res = compare(people, sheets, today, facilityMap(pairs));
  // працівник у базі: за логіном рядка таблиці, інакше — за карткою HRappka (паспорт у таблиці інший, ніж логін)
  const dbw = await loadWorkers(client);
  const byId = new Map(dbw.map((w) => [w.id, w])), byHr = new Map(dbw.filter((w) => w.hr_id).map((w) => [String(w.hr_id), w]));
  const cur = (d) => (d.w && d.w.id && byId.get(d.w.id)) || (d.p && byHr.get(String(d.p.id))) || null;
  res.diffs = res.diffs.filter((d) => !(d.w && fixedInDb(d, cur(d))));
  const names = new Map((await client.query(`SELECT id, name FROM public.facilities`)).rows.map((x) => [x.id, x.name]));
  for (const d of res.diffs) if (d.fac) d.facName = names.get(d.fac) || String(d.fac);
  return res;
}

// Імпорт HRappka: знімок → зміни відносно вже записаного (hrz.people_applied) → база → розбіжності з таблицями.
// full — усі періоди (понеділок); dry — нічого не записати; notify — лист
async function run({ full = false, dry = false, notify = false } = {}) {
  const today = todayWarsaw();
  const people = await fetchAll();
  const client = await db.pool.connect();
  let res, applied;
  try {
    await client.query("BEGIN");
    const prev = new Map((await loadPeople(client, "hrz.people_applied")).map((x) => [x.id, x]));
    await snapshot(client, people);
    if (prev.size) {
      applied = await apply(client, people, today, { dry, prev });
      // об'єкт періодів, які записала HRappka, — з таблиці (новий працівник, а рядок у таблиці з'явився пізніше)
      const obj = await apply(client, people, today, { dry, objectOnly: true });
      applied.update += obj.update;
      if (obj.errors) applied.errors = [...(applied.errors || []), ...obj.errors];
    } else {
      // перший знімок — лише точка відліку: те, що вже було в HRappka, у базі не міняємо
      applied = { update: 0, insert: 0, close: 0, create: 0, skip: {}, ops: [], pending: new Set() };
    }
    // записане (і без змін) — нова точка відліку; не записане з причини, що може зникнути, — спробуємо знову
    await snapshot(client, people.filter((p) => !applied.pending.has(p.id)), "hrz.people_applied");
    res = await diffsFor(client, people, today);
    if (!dry) await client.query(`INSERT INTO hrz.runs (kind, at) VALUES ('hrappka', now()) ON CONFLICT (kind) DO UPDATE SET at = now()`);
    await client.query(dry ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  for (const e of (applied.errors || []).slice(0, 20)) console.warn(`[hr import] ${e}`);
  if (!full) res.diffs = recent(res.diffs, today);
  const stats = { people: people.length, workers: res.pairs.length, matched: res.pairs.filter((x) => x.p).length, applied };
  if (!dry) LAST = { at: Date.now(), stats };
  console.log(`[hr import] ${applySummary(applied)}${dry ? " — DRY, нічого не записано" : ""}\n` +
    `таблиці: ${stats.workers} людей, знайдено в HRappka ${stats.matched}; розбіжностей ${res.diffs.length}\n${summary(res.diffs)}`);
  if (notify) await sendEmail(res.diffs, stats, today, full);
  return { ...res, stats, today };
}

function applySummary(a) {
  const sk = Object.entries(a.skip).map(([k, v]) => `${k}: ${v}`).join("; ");
  return `HRappka → база: оновлено періодів ${a.update}, нових ${a.insert}, закрито попередніх ${a.close}, нових людей ${a.create}` +
    (a.errors ? `, помилок ${a.errors.length}` : "") + (sk ? ` (пропущено — ${sk})` : "");
}

// Одразу після імпорту таблиць (import_sheets.js): імпорт HRappka на той самий момент. sheetsAt — коли почався
// повний імпорт таблиць (частковий — null): панель показує, на який момент обидва джерела.
async function afterSheets({ sheetsAt = null } = {}) {
  if (sheetsAt) await db.query(`INSERT INTO hrz.runs (kind, at) VALUES ('sheets', $1) ON CONFLICT (kind) DO UPDATE SET at = $1`, [sheetsAt]);
  return exclusive(() => run());
}

// Для панелі: розбіжності між останнім знімком HRappka і таблицями (без запиту до HRappka)
async function current({ full = false } = {}) {
  const today = todayWarsaw();
  const client = await db.pool.connect();
  try {
    const people = await loadPeople(client);
    const at = (await client.query(`SELECT max(seen_at) AS at FROM hrz.people`)).rows[0].at;
    const runs = Object.fromEntries((await client.query(`SELECT kind, at FROM hrz.runs`)).rows.map((x) => [x.kind, x.at]));
    const { diffs } = await diffsFor(client, people, today);
    return { diffs: full ? diffs : recent(diffs, today), snapshotAt: at, sheetsAt: runs.sheets || null, today, recentDays: RECENT_DAYS };
  } finally {
    client.release();
  }
}

// Кнопки «Odśwież z HRappka» / «Import z HRappka»: лише HRappka (швидко), таблиці — з останнього імпорту таблиць
async function refresh() {
  if (BUSY) throw new Error("Import z HRappka już trwa — spróbuj za minutę");
  return exclusive(() => run());
}

// Лист о 8:00: розбіжності на момент щойно завершеного імпорту (таблиці + HRappka)
async function report({ full = false } = {}) {
  const r = await current({ full });
  const stats = LAST ? LAST.stats : { people: "?", workers: "?", matched: "?", applied: { update: 0, insert: 0, close: 0, create: 0, skip: {} } };
  await sendEmail(r.diffs, stats, r.today, full);
}

function schedule() {
  const cron = require("node-cron");
  // о 6, 8, 10, 12, 16, 20: таблиці, одразу за ними HRappka (afterSheets з import_sheets.js) — обидва на один момент.
  // Лист — о 8:00 (у понеділок — повний звіт), коли обидва імпорти завершились.
  cron.schedule("0 6,8,10,12,16,20 * * *", async () => {
    const part = (o) => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", ...o }).format(new Date());
    const notify = Number(part({ hour: "numeric", hourCycle: "h23" })) === 8;
    const monday = part({ weekday: "short" }) === "Mon";
    const started = Date.now();
    const err = (where, e) => console.error(`[hr import] ${where}:`, e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
    try {
      const r = await require("../import_sheets").runImport();   // через чергу імпортів (api/flow.js)
      if (r && r.skipped) console.warn("[hr import] імпорт таблиць пропущено (інший ще йде) — HRappka з попередньою копією таблиць");
    } catch (e) { err("таблиці", e); }
    // таблиці не дійшли до HRappka (пропуск, помилка) — HRappka все одно
    try { if (!LAST || LAST.at < started) await exclusive(() => run()); } catch (e) { err("HRappka", e); }
    try { if (notify) await report({ full: monday }); } catch (e) { err("лист", e); }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { run, schedule, compare, current, refresh, afterSheets, report, toCsv, STATE, TYPES, _test: { fetchAll, toPerson, match, plan, facilityMap, loadPeople } };

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
