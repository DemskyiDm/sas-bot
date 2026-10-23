// bot/hr_sign.js — підписи документів у HRappka (Pracownicy → «Dokumenty», картка працівника в боті).
// Новий працівник отримує листи з документами (umowa, załączniki, program lojalnościowy, aneksy…) і підписує їх у HRappka;
// у таблиці EMPLOYEE_ATTACHMENT_FULL поле eSignature: SEND — надіслано, не підписано; SIGN — підписано.
// Усієї бази HRappka (170 тис. вкладень) не тягнемо: питаємо лише за паспортами потрібних людей (фільтр на боці HRappka).
//   • щодня о 6:00 (Варшава) — працівники з BHP від HR_SIGN_FROM (15.10.2026), які ще не підписали все;
//     рахуються документи, надіслані ±10 днів від BHP (старі періоди — ні), повторний пакет — лише останній;
//   • о 7:00 — звіт «хто не підписав» листом з Excel на HR_SIGN_REPORT_TO (.env, через кому);
//   • о 10:00 — нагадування працівнику в боті «перевірте посилання в e-mail» (раз на пакет, наступного дня);
//   • з панелі — «Sprawdź podpisy» для вибраних / обʼєкта (не частіше ніж раз на хвилину на людину).
// Анкети — лише вибрані (HR_SIGN_SURVEYS у .env, id з HRappka → Ankiety): відповіді беремо пачкою по анкеті, не по людині.
// Доступ до HRappka — ті самі змінні .env, що й у sync_hrrappka_diff.js. Таблиці: db/migration_hr_sign.sql.
"use strict";

const axios = require("axios");
const db = require("../db");

const BASE = process.env.HRAPPKA_BASE_URL || "https://app.hrappka.pl";
const FROM = /^\d{4}-\d{2}-\d{2}$/.test(process.env.HR_SIGN_FROM || "") ? process.env.HR_SIGN_FROM : "2026-10-15";
const BATCH = 200;                 // паспортів в одному запиті
const PAGE = 2000;                 // рядків на сторінку відповіді
const COOLDOWN_S = 60;             // ручна перевірка тієї самої людини — не частіше
const normPass = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();
// «kovtun_oleksandra___program_lojalnosciowy_2026_10_22_12_04_32.pdf» → «program lojalnosciowy»;
// «mikhnova_iryna_wydruki_…pdf» → «wydruki» (на початку — слова з імені працівника)
function docLabel(name, fullName) {
  let s = String(name || "").replace(/\.pdf$/i, "").replace(/_?\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/, "");
  if (s.includes("___")) s = s.slice(s.indexOf("___") + 3);
  let words = s.replace(/_pdf$/i, "").split(/_+/).filter(Boolean);
  const own = new Set(String(fullName || "").toLowerCase().split(/[\s-]+/).filter(Boolean));
  while (words.length > 1 && own.has(words[0].toLowerCase())) words = words.slice(1);
  return words.join(" ").trim() || String(name || "");
}

// ── HRappka ───────────────────────────────────────────────────────────
let TOKEN = { value: null, at: 0 };
async function headers() {
  if (!TOKEN.value || Date.now() - TOKEN.at > 30 * 60 * 1000) {
    const r = await axios.post(`${BASE}/api/v1/auth/login`, {
      email: process.env.HRAPPKA_EMAIL, password: process.env.HRAPPKA_PASSWORD,
      companyId: Number(process.env.HRAPPKA_COMPANY_ID), authenticateOldApi: true,
    }, { timeout: 30000 });
    TOKEN = { value: r.data.data.token, at: Date.now() };
  }
  return { Authorization: `Bearer ${TOKEN.value}`, "x-app-token": process.env.HRAPPKA_APP_TOKEN, "Content-Type": "application/json" };
}
const COLS = ["id", "displayName", "creationTime", "eSignature", "user_EMPLOYEE_id", "user_EMPLOYEE_idsNumberValuePASSPORT"]
  .map((id) => ({ id, isLocked: false, width: null }));
// У HRappka паспорт записаний з пробілом («AA 123456»), у нас — без; фільтр порівнює точно — шлемо обидва написання
const passVariants = (list) => [...new Set(list.flatMap((p) => [p, p.replace(/^([A-Z]+)(\d+)$/, "$1 $2")]))];
// Документи на підпис (SEND / SIGN) для цих паспортів — усі сторінки
async function fetchDocs(passportsRaw) {
  const passports = passVariants(passportsRaw);
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = {
      id: "EMPLOYEE_ATTACHMENT_FULL", offset, limit: PAGE, columns: COLS,
      filter: { logicOperator: "AND", subFilters: [], conditions: [
        { key: { columnId: "eSignature" }, operator: "IN", value: ["SEND", "SIGN"] },
        { key: { columnId: "user_EMPLOYEE_idsNumberValuePASSPORT" }, operator: "IN", value: passports },
      ] },
      customFilters: {}, order: { creationTime: "ASC" }, additionalParameters: { fullConfig: false },
    };
    let r;
    try {
      r = await axios.post(`${BASE}/api/v1/table`, body, { headers: await headers(), timeout: 60000 });
    } catch (e) {
      if (e.response && e.response.status === 401 && TOKEN.value) { TOKEN.value = null; offset -= PAGE; continue; }   // токен прострочився
      throw e;
    }
    const rows = (r.data.data && r.data.data.data) || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Працівники HRappka за паспортами (для тих, у кого ще немає документів, — щоб знайти їхні анкети)
async function fetchEmployees(passportsRaw) {
  const body = {
    id: "EMPLOYEE", offset: 0, limit: PAGE,
    columns: ["id", "idsNumberValuePASSPORT"].map((id) => ({ id, isLocked: false, width: null })),
    filter: { logicOperator: "AND", subFilters: [], conditions: [
      { key: { columnId: "idsNumberValuePASSPORT" }, operator: "IN", value: passVariants(passportsRaw) },
    ] },
    customFilters: {}, order: {}, additionalParameters: { fullConfig: false },
  };
  const r = await axios.post(`${BASE}/api/v1/table`, body, { headers: await headers(), timeout: 60000 });
  return (r.data.data && r.data.data.data) || [];
}
// Запит до таблиці HRappka; токен прострочився — раз повторюємо з новим
async function table(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await axios.post(`${BASE}/api/v1/table`, body, { headers: await headers(), timeout: 60000 });
      return (r.data.data && r.data.data.data) || [];
    } catch (e) {
      if (e.response && e.response.status === 401 && attempt === 0) { TOKEN.value = null; continue; }
      throw e;
    }
  }
}
// Анкети, які рахуємо: nowe OŚWIADCZENIE (EES), do podpisy OŚWIADCZENIE (EES), ANKIETA DO PRACOWNIKA (LZ), (LZ) udział w programie lojalnościowym
const SURVEY_IDS = String(process.env.HR_SIGN_SURVEYS || "85586,87232,72966,87549").split(/[,;\s]+/).map(Number).filter(Boolean);
const ANSWER_PAGE = 500;
const ANSWER_COLS = ["id", "entity", "state", "fillingDate", "creationTime"].map((id) => ({ id, isLocked: false, width: null }));
// Відповіді вибраних анкет, створені від since (YYYY-MM-DD): усі працівники разом, від найновіших → Map(id працівника HRappka → [відповіді])
async function fetchAnswers(since) {
  const names = new Map((await table({
    id: "QUESTIONNAIRE", offset: 0, limit: 50, columns: [{ id: "name", isLocked: false, width: null }], customFilters: {}, order: {}, search: null,
    filter: { logicOperator: "AND", subFilters: [], conditions: [{ key: { columnId: "id" }, operator: "IN", value: SURVEY_IDS }] },
    additionalParameters: { fullConfig: false },
  })).map((q) => [Number(q.id), q.name]));
  const byEmp = new Map();
  await Promise.all(SURVEY_IDS.map(async (qid) => {   // анкети — паралельно (HRappka ~4 с на запит)
    for (let offset = 0; ; offset += ANSWER_PAGE) {
      const rows = await table({
        id: "QUESTIONNAIRE_ANSWER", offset, limit: ANSWER_PAGE, columns: ANSWER_COLS,
        filter: { logicOperator: "AND", conditions: [], subFilters: [] }, customFilters: { questionnaireId: qid },
        order: { creationTime: "DESC" }, search: null, additionalParameters: { fullConfig: false },
      });
      for (const r of rows) {
        if (r.entityType !== "EMPLOYEE" || !r.entityFkey || String(r.creationTime || "") < since) continue;
        const k = String(r.entityFkey);
        if (!byEmp.has(k)) byEmp.set(k, []);
        byEmp.get(k).push({ ...r, name: names.get(qid) || "" });
      }
      if (rows.length < ANSWER_PAGE || String(rows[rows.length - 1].creationTime || "") < since) break;
    }
  }));
  return byEmp;
}
// Анкети для партії працівників: id у HRappka — з документів, з попередніх перевірок або за паспортом;
// answers() — відповіді вибраних анкет (одні на всю перевірку)
async function syncSurveys(partIds, passports, byPass, docRows, answers) {
  const emp = new Map();   // worker_id → Set(id працівника в HRappka)
  const add = (wid, eid) => { if (!wid || !eid) return; if (!emp.has(wid)) emp.set(wid, new Set()); emp.get(wid).add(String(eid)); };
  docRows.forEach((d) => add(byPass.get(normPass(d.user_EMPLOYEE_idsNumberValuePASSPORT)), d.user_EMPLOYEE_id));
  const known = await db.query(`SELECT worker_id, hr_employee_id FROM hrs.checks WHERE worker_id = ANY($1::int[]) AND hr_employee_id IS NOT NULL`, [partIds]);
  known.rows.forEach((x) => add(x.worker_id, x.hr_employee_id));
  const missing = passports.filter((p) => !emp.has(byPass.get(p)));
  if (missing.length) (await fetchEmployees(missing)).forEach((r) => add(byPass.get(normPass(r.idsNumberValuePASSPORT)), r.id));
  const all = await answers();
  const got = new Map();
  emp.forEach((set, wid) => got.set(wid, [...set].flatMap((eid) => (all.get(eid) || []).map((r) => ({ ...r, eid })))));
  let n = 0;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (const [wid, rows] of got) {
      for (const s of rows) {
        if (!["SENT", "FILLED"].includes(s.state)) continue;   // інші стани (чернетки тощо) не рахуємо
        await client.query(
          `INSERT INTO hrs.surveys (hr_answer_id, worker_id, hr_employee_id, name, state, hr_created_at, filled_at, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (hr_answer_id) DO UPDATE SET worker_id = EXCLUDED.worker_id, name = EXCLUDED.name, state = EXCLUDED.state,
             filled_at = EXCLUDED.filled_at, checked_at = now()`,
          [s.id, wid, s.eid, s.name, s.state, s.creationTime || null, s.fillingDate || null]);
        n++;
      }
    }
    // анкети, яких більше немає (або це не вибрані анкети) — прибираємо
    await client.query(`DELETE FROM hrs.surveys WHERE worker_id = ANY($1::int[]) AND checked_at < now() - interval '1 second'`, [[...emp.keys()]]);
    for (const [wid, set] of emp) {
      await client.query(
        `UPDATE hrs.checks SET hr_employee_id = $2,
                found = found OR EXISTS (SELECT 1 FROM hrs.surveys s WHERE s.worker_id = $1)
          WHERE worker_id = $1`, [wid, [...set][0]]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { surveys: n };
}

// ── Перевірка ─────────────────────────────────────────────────────────
// ids — працівники нашої бази. Повертає { checked, docs, signed_now, error? }
async function check(ids) {
  ids = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!ids.length) return { checked: 0, docs: 0, signed_now: 0 };
  const w = await db.query(`SELECT id, login FROM workers WHERE id = ANY($1::int[]) AND COALESCE(login, '') NOT LIKE 'TEST_%'`, [ids]);
  const byPass = new Map();
  w.rows.forEach((x) => { const p = normPass(x.login); if (p) byPass.set(p, x.id); });
  const passes = [...byPass.keys()];
  let docs = 0, surveys = 0, signedNow = 0;
  const m = await db.query(`SELECT to_char(min(bhp_date) - $2::int, 'YYYY-MM-DD') AS d FROM v_worker_current WHERE id = ANY($1::int[])`, [ids, WINDOW_DAYS]);
  const since = m.rows[0].d || FROM;
  let cache = null;
  const answers = () => (cache = cache || fetchAnswers(since));
  for (let i = 0; i < passes.length; i += BATCH) {
    const part = passes.slice(i, i + BATCH);
    const partIds = part.map((p) => byPass.get(p));
    let rows;
    try {
      rows = await fetchDocs(part);
    } catch (e) {
      const msg = String((e.response && JSON.stringify(e.response.data)) || e.message).slice(0, 300);
      await db.query(
        `INSERT INTO hrs.checks (worker_id, checked_at, found, error) SELECT unnest($1::int[]), now(), false, $2
         ON CONFLICT (worker_id) DO UPDATE SET checked_at = now(), error = EXCLUDED.error`, [partIds, msg]);
      console.error("[hr sign] HRappka:", msg);
      return { checked: i, docs, signed_now: signedNow, error: msg };
    }
    const found = new Set();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      for (const d of rows) {
        const wid = byPass.get(normPass(d.user_EMPLOYEE_idsNumberValuePASSPORT));
        if (!wid) continue;
        found.add(wid);
        const r = await client.query(
          `INSERT INTO hrs.docs (hr_doc_id, worker_id, hr_employee_id, passport, display_name, hr_created_at, status, signed_seen_at, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'SIGN' THEN now() END, now())
           ON CONFLICT (hr_doc_id) DO UPDATE SET worker_id = EXCLUDED.worker_id, display_name = EXCLUDED.display_name, status = EXCLUDED.status,
             signed_seen_at = COALESCE(hrs.docs.signed_seen_at, EXCLUDED.signed_seen_at), checked_at = now()
           RETURNING (xmax <> 0) AS updated, signed_seen_at = checked_at AS newly_signed`,
          [d.id, wid, d.user_EMPLOYEE_id || null, normPass(d.user_EMPLOYEE_idsNumberValuePASSPORT), d.displayName, d.creationTime || null, d.eSignature]);
        docs++;
        if (r.rows[0] && r.rows[0].newly_signed && r.rows[0].updated) signedNow++;
      }
      // документи, яких HRappka більше не повертає (видалені там) — прибираємо
      await client.query(
        `DELETE FROM hrs.docs WHERE worker_id = ANY($1::int[]) AND checked_at < now() - interval '1 second'`, [partIds]);
      await client.query(
        `INSERT INTO hrs.checks (worker_id, checked_at, found, error)
         SELECT x, now(), x = ANY($2::int[]), NULL FROM unnest($1::int[]) AS x
         ON CONFLICT (worker_id) DO UPDATE SET checked_at = now(), found = EXCLUDED.found, error = NULL`, [partIds, [...found]]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // анкети тієї ж партії; не вдалося — документи вже збережені, анкети спробуємо наступного разу
    try {
      surveys += (await syncSurveys(partIds, part, byPass, rows, answers)).surveys;
    } catch (e) {
      console.error("[hr sign] анкети:", e.message);
    }
  }
  return { checked: passes.length, docs, surveys, signed_now: signedNow };
}

// Щоденна: BHP від FROM, ще не все підписано (або ще не перевіряли / документів не знайшли)
const inScopeIds = async () => (await db.query(
  `SELECT v.id FROM v_worker_current v
    WHERE v.bhp_date >= $1::date AND COALESCE(v.login, '') NOT LIKE 'TEST_%' AND v.status::text <> 'rezygnacja'`, [FROM])).rows.map((x) => x.id);
async function daily() {
  const all = await inScopeIds();
  const s = await summary(all);
  const t0 = Date.now();
  const res = await check(all.filter((id) => !fullySigned(s[id])));   // хто все підписав (у межах вікна) — більше не питаємо
  console.log(`[hr sign] щоденна: ${res.checked} осіб, ${res.docs} док., нових підписів ${res.signed_now} (${Math.round((Date.now() - t0) / 1000)} с)${res.error ? " · помилка: " + res.error : ""}`);
  return res;
}
// Ручна: лише ті, кого не перевіряли останню хвилину
async function manual(ids) {
  const r = await db.query(
    `SELECT x AS id FROM unnest($1::int[]) AS x
      WHERE NOT EXISTS (SELECT 1 FROM hrs.checks k WHERE k.worker_id = x AND k.checked_at > now() - ($2 || ' seconds')::interval)`,
    [ids, String(COOLDOWN_S)]);
  const res = await check(r.rows.map((x) => x.id));
  return { ...res, skipped: ids.length - r.rows.length };
}

// ── Зведення для панелі / бота ────────────────────────────────────────
// { worker_id: { total, signed, found, checked_at, error, docs: [{ label, status, created }] } }
// Рахуються лише документи, надіслані в межах ±WINDOW_DAYS від BHP поточного періоду (старі — з минулих періодів роботи —
// ігноруються); той самий документ надіслано двічі (повторний пакет) — береться останній.
// found — у HRappka є документи на підпис саме для цього періоду.
const WINDOW_DAYS = 10;
async function summary(ids) {
  if (!ids.length) return {};
  const [d, k] = await Promise.all([
    db.query(`SELECT d.worker_id, d.display_name, d.status, to_char(d.hr_created_at, 'YYYY-MM-DD') AS created, w.full_name
                FROM hrs.docs d
                JOIN workers w ON w.id = d.worker_id
                JOIN v_worker_current v ON v.id = d.worker_id
               WHERE d.worker_id = ANY($1::int[])
                 AND v.bhp_date IS NOT NULL
                 AND d.hr_created_at::date BETWEEN v.bhp_date - $2::int AND v.bhp_date + $2::int
               ORDER BY d.hr_created_at, d.hr_doc_id`, [ids, WINDOW_DAYS]),
    db.query(`SELECT worker_id, checked_at, found, error FROM hrs.checks WHERE worker_id = ANY($1::int[])`, [ids]),
  ]);
  // анкети — те саме вікно; без таблиці hrs.surveys (міграцію ще не перезапустили) — без анкет
  const sv = await db.query(
    `SELECT s.worker_id, s.name, s.state, to_char(s.hr_created_at, 'YYYY-MM-DD') AS created
       FROM hrs.surveys s JOIN v_worker_current v ON v.id = s.worker_id
      WHERE s.worker_id = ANY($1::int[]) AND v.bhp_date IS NOT NULL
        AND s.hr_created_at::date BETWEEN v.bhp_date - $2::int AND v.bhp_date + $2::int
      ORDER BY s.hr_created_at, s.hr_answer_id`, [ids, WINDOW_DAYS]).catch(() => ({ rows: [] }));
  const out = {};
  k.rows.forEach((x) => { out[x.worker_id] = { total: 0, signed: 0, found: false, checked_at: x.checked_at, error: x.error, docs: [] }; });
  // worker → назва → останній (рядки впорядковані за датою — пізніший перезаписує); kind: survey (анкета) | doc
  // status: SIGN — підписано / заповнено, SEND — ні (анкети FILLED / SENT зводимо до того самого)
  const latest = {};
  const put = (wid, key, item) => { (latest[wid] = latest[wid] || new Map()).set(key, item); };
  sv.rows.forEach((x) => put(x.worker_id, "s:" + x.name.toLowerCase(),
    { kind: "survey", label: x.name, status: x.state === "FILLED" ? "SIGN" : "SEND", created: x.created }));
  d.rows.forEach((x) => {
    const label = docLabel(x.display_name, x.full_name);
    put(x.worker_id, "d:" + label.toLowerCase(), { kind: "doc", label, status: x.status, created: x.created });
  });
  Object.entries(latest).forEach(([wid, m]) => {
    const s = (out[wid] = out[wid] || { total: 0, signed: 0, found: false, checked_at: null, error: null, docs: [] });
    s.docs = [...m.values()];
    s.total = s.docs.length;
    s.signed = s.docs.filter((x) => x.status === "SIGN").length;
    s.found = s.total > 0;
  });
  return out;
}
const fullySigned = (s) => !!(s && !s.error && s.found && s.signed >= s.total);

// ── Звіт о 7:00: хто не підписав (лист + Excel) ─────────────────────
// Кому — HR_SIGN_REPORT_TO у .env (через кому). Порядок: регіон → координатор → обʼєкт → працівник.
const REPORT_TO = () => String(process.env.HR_SIGN_REPORT_TO || "").split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /@/.test(x));
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dmyIso = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
async function reportRows() {
  const ids = await inScopeIds();
  const s = await summary(ids);
  const bad = ids.filter((id) => s[id] && !fullySigned(s[id]));
  if (!bad.length) return [];
  const w = await db.query(
    `SELECT v.id, w.full_name, w.login, to_char(v.bhp_date, 'YYYY-MM-DD') AS bhp, f.name AS facility, rg.name AS region, co.full_name AS coordinator
       FROM v_worker_current v
       JOIN workers w ON w.id = v.id
       LEFT JOIN facilities f ON f.id = v.facility_id
       LEFT JOIN reg.site_owner so ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
       LEFT JOIN reg.regions rg ON rg.id = so.region_id
       LEFT JOIN coordinators co ON co.id = so.coordinator_id
      WHERE v.id = ANY($1::int[])`, [bad]);
  const pl = (a, b) => (a == null) - (b == null) || String(a || "").localeCompare(String(b || ""), "pl");
  return w.rows.map((x) => ({ ...x, s: s[x.id] }))
    .sort((a, b) => pl(a.region, b.region) || pl(a.coordinator, b.coordinator) || pl(a.facility, b.facility) || pl(a.full_name, b.full_name));
}
async function report() {
  const to = REPORT_TO();
  const mail = require("../api/mail");
  if (!to.length) return { ok: false, error: "no_recipients" };
  if (!mail.configured()) return { ok: false, error: "not_configured" };
  const rows = await reportRows();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  // анкети — першими, з позначкою «Ankieta:»
  const unsigned = (x) => x.s.docs.filter((d) => d.status !== "SIGN").sort((a, b) => (a.kind !== "survey") - (b.kind !== "survey"))
    .map((d) => (d.kind === "survey" ? `Ankieta: ${d.label}` : d.label));
  const state = (x) => (x.s.error ? "błąd HRappka" : !x.s.found ? "brak dokumentów w HRappka" : `${x.s.signed} z ${x.s.total}`);
  const head = ["Region", "Koordynator", "Obiekt", "Nazwisko i imię", "Paszport", "BHP", "Podpisano", "Niepodpisane dokumenty"];
  const th = (h) => `<th style="border:1px solid #c9d3e3;background:#e7eef8;padding:6px 8px;text-align:left">${escH(h)}</th>`;
  const td = (v, red) => `<td style="border:1px solid #d9dee8;padding:5px 8px;vertical-align:top${red ? ";color:#c5221f;font-weight:bold" : ""}">${v}</td>`;
  const table = rows.length ? `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px">
<tr>${head.map(th).join("")}</tr>
${rows.map((x) => `<tr>${td(escH(x.region || "—"))}${td(escH(x.coordinator || "—"))}${td(escH(x.facility || "—"))}${td(escH(x.full_name))}${td(escH(x.login || ""))}${td(dmyIso(x.bhp))}${td(escH(state(x)))}${td(escH(unsigned(x).join(", ")), true)}</tr>`).join("\n")}
</table>` : "";
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1f2937">
<p>Dzień dobry,</p>
<p>${rows.length ? `pracownicy z BHP od ${dmyIso(FROM)}, którzy <b>nie podpisali dokumentów lub nie wypełnili ankiet</b> w HRappka: <b>${rows.length} os.</b>
Liczą się dokumenty i ankiety wysłane ±${WINDOW_DAYS} dni od BHP; przy powtórnej wysyłce — ostatnia. Ta sama lista jest w załączniku (Excel).` : `wszyscy pracownicy z BHP od ${dmyIso(FROM)} podpisali dokumenty i wypełnili ankiety w HRappka.`}</p>
${table}
<p style="color:#8a94a6;font-size:12px">KoorPanel · stan po sprawdzeniu o 6:00 · ${dmyIso(today)}</p></div>`;
  const att = rows.length ? [{
    name: `podpisy_${today}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: await mail.xlsx({ sheet: "Niepodpisane", header: head, widths: [16, 22, 26, 28, 13, 11, 14, 60],
      rows: rows.map((x) => [x.region || "", x.coordinator || "", x.facility || "", x.full_name, x.login || "", dmyIso(x.bhp), state(x), unsigned(x).join(", ")]) }),
  }] : [];
  await mail.send({ to, subject: rows.length ? `Niepodpisane dokumenty HRappka — ${dmyIso(today)} (${rows.length} os.)` : `Dokumenty HRappka — wszyscy podpisali (${dmyIso(today)})`, html, attachments: att });
  console.log(`[hr sign] звіт → ${to.join(", ")}: ${rows.length} осіб`);
  return { ok: true, count: rows.length, to };
}

// ── Нагадування працівнику (о 10:00): документи надіслано вчора або раніше, а ще не підписано ─────
// Раз на пакет: якщо після нагадування прийшов новий пакет (пізніша дата надсилання) — нагадаємо ще раз.
// hrs.checks.reminded_at — db/migration_hr_remind.sql (без колонки нагадування просто не йдуть).
const REMIND_TX = {
  uk: {
    hi: "👋 Доброго дня!",
    body: "Вам на e-mail надіслано документи для підпису від SAS (HRappka), і ще не все підписано / заповнено.",
    ask: "Будь ласка, перевірте пошту (також папку «Спам») і перейдіть за посиланнями в листах.",
    list: "Ще не підписано:", survey: "анкета", none: "Якщо листів немає — напишіть своєму координатору.",
  },
  ru: {
    hi: "👋 Добрый день!",
    body: "Вам на e-mail отправлены документы для подписи от SAS (HRappka), и ещё не всё подписано / заполнено.",
    ask: "Пожалуйста, проверьте почту (также папку «Спам») и перейдите по ссылкам в письмах.",
    list: "Ещё не подписано:", survey: "анкета", none: "Если писем нет — напишите своему координатору.",
  },
  pl: {
    hi: "👋 Dzień dobry!",
    body: "Na Twój e-mail wysłaliśmy dokumenty do podpisu od SAS (HRappka) — nie wszystko jest jeszcze podpisane / wypełnione.",
    ask: "Sprawdź pocztę (także folder „Spam”) i otwórz linki z wiadomości.",
    list: "Jeszcze niepodpisane:", survey: "ankieta", none: "Jeśli nie ma wiadomości — napisz do swojego koordynatora.",
  },
};
let BOT = null;
async function reminders() {
  const ids = await inScopeIds();
  const s = await summary(ids);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
  const cand = ids.filter((id) => s[id] && s[id].found && !s[id].error && !fullySigned(s[id]));
  if (!cand.length) return [];
  const w = await db.query(
    `SELECT w.id, w.telegram_chat_id AS chat, w.lang, to_char(k.reminded_at AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD') AS reminded
       FROM workers w LEFT JOIN hrs.checks k ON k.worker_id = w.id WHERE w.id = ANY($1::int[])`, [cand]);
  return w.rows.map((x) => {
    const open = s[x.id].docs.filter((d) => d.status !== "SIGN");
    const latest = open.map((d) => d.created || "").sort().pop() || "";
    return { ...x, open, latest };
  }).filter((x) => x.chat && x.latest && x.latest < today && (!x.reminded || x.reminded < x.latest));
}
async function remind() {
  if (!BOT) return { sent: 0, error: "no_bot" };
  let list;
  try { list = await reminders(); } catch (e) { console.error("[hr sign] нагадування:", e.message); return { sent: 0, error: e.message }; }
  let sent = 0, failed = 0;
  for (const x of list) {
    const t = REMIND_TX[x.lang] || REMIND_TX.uk;
    const items = x.open.slice().sort((a, b) => (a.kind !== "survey") - (b.kind !== "survey"))
      .map((d) => `• ${d.kind === "survey" ? `${t.survey}: ` : ""}${d.label}`);
    const text = [t.hi, t.body, t.ask, "", t.list, ...items.slice(0, 8), ...(items.length > 8 ? ["…"] : []), "", t.none].join("\n");
    try {
      await BOT.telegram.sendMessage(String(x.chat), text);
      await db.query(`UPDATE hrs.checks SET reminded_at = now() WHERE worker_id = $1`, [x.id]);
      sent++;
    } catch (e) {
      failed++;
      console.error(`[hr sign] нагадування ${x.id}:`, (e.response && e.response.description) || e.message);
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  console.log(`[hr sign] нагадування: надіслано ${sent}${failed ? `, помилок ${failed}` : ""}`);
  return { sent, failed };
}

let RUNNING = false;
function schedule(bot) {
  BOT = bot || null;
  const cron = require("node-cron");
  cron.schedule("0 7 * * *", async () => {
    try { await report(); } catch (e) { console.error("[hr sign] звіт:", e.message); }
  }, { timezone: "Europe/Warsaw" });
  cron.schedule("0 6 * * *", async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await daily(); } catch (e) { console.error("[hr sign] щоденна:", e.message); } finally { RUNNING = false; }
  }, { timezone: "Europe/Warsaw" });
  cron.schedule("0 10 * * *", async () => {
    try { await remind(); } catch (e) { console.error("[hr sign] нагадування:", e.message); }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { check, daily, manual, summary, report, reportRows, reminders, remind, schedule, docLabel, FROM, COOLDOWN_S, WINDOW_DAYS,
  _test: { setBot: (b) => { BOT = b; } } };
