// bot/hr_sign.js — підписи документів у HRappka (Pracownicy → «Dokumenty», картка працівника в боті).
// Новий працівник отримує листи з документами (umowa, załączniki, program lojalnościowy, aneksy…) і підписує їх у HRappka;
// у таблиці EMPLOYEE_ATTACHMENT_FULL поле eSignature: SEND — надіслано, не підписано; SIGN — підписано.
// Усієї бази HRappka (170 тис. вкладень) не тягнемо: питаємо лише за паспортами потрібних людей (фільтр на боці HRappka).
//   • щодня о 6:00 (Варшава) — працівники з BHP від HR_SIGN_FROM (15.10.2026), які ще не підписали все;
//   • з панелі — «Sprawdź podpisy» для вибраних / обʼєкта (не частіше ніж раз на хвилину на людину).
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

// ── Перевірка ─────────────────────────────────────────────────────────
// ids — працівники нашої бази. Повертає { checked, docs, signed_now, error? }
async function check(ids) {
  ids = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!ids.length) return { checked: 0, docs: 0, signed_now: 0 };
  const w = await db.query(`SELECT id, login FROM workers WHERE id = ANY($1::int[]) AND COALESCE(login, '') NOT LIKE 'TEST_%'`, [ids]);
  const byPass = new Map();
  w.rows.forEach((x) => { const p = normPass(x.login); if (p) byPass.set(p, x.id); });
  const passes = [...byPass.keys()];
  let docs = 0, signedNow = 0;
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
  }
  return { checked: passes.length, docs, signed_now: signedNow };
}

// Щоденна: BHP від FROM, ще не все підписано (або ще не перевіряли / документів не знайшли)
async function daily() {
  const r = await db.query(
    `SELECT v.id FROM v_worker_current v
      WHERE v.bhp_date >= $1::date AND COALESCE(v.login, '') NOT LIKE 'TEST_%' AND v.status::text <> 'rezygnacja'
        AND NOT EXISTS (SELECT 1 FROM hrs.checks k WHERE k.worker_id = v.id AND k.found AND k.error IS NULL
                         AND NOT EXISTS (SELECT 1 FROM hrs.docs d WHERE d.worker_id = v.id AND d.status = 'SEND'))`, [FROM]);
  const t0 = Date.now();
  const res = await check(r.rows.map((x) => x.id));
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
async function summary(ids) {
  if (!ids.length) return {};
  const [d, k] = await Promise.all([
    db.query(`SELECT d.worker_id, d.display_name, d.status, to_char(d.hr_created_at, 'YYYY-MM-DD') AS created, w.full_name
                FROM hrs.docs d JOIN workers w ON w.id = d.worker_id
               WHERE d.worker_id = ANY($1::int[]) ORDER BY d.hr_created_at, d.hr_doc_id`, [ids]),
    db.query(`SELECT worker_id, checked_at, found, error FROM hrs.checks WHERE worker_id = ANY($1::int[])`, [ids]),
  ]);
  const out = {};
  k.rows.forEach((x) => { out[x.worker_id] = { total: 0, signed: 0, found: x.found, checked_at: x.checked_at, error: x.error, docs: [] }; });
  d.rows.forEach((x) => {
    const s = (out[x.worker_id] = out[x.worker_id] || { total: 0, signed: 0, found: true, checked_at: null, error: null, docs: [] });
    s.total++;
    if (x.status === "SIGN") s.signed++;
    s.docs.push({ label: docLabel(x.display_name, x.full_name), status: x.status, created: x.created });
  });
  return out;
}

let RUNNING = false;
function schedule() {
  const cron = require("node-cron");
  cron.schedule("0 6 * * *", async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await daily(); } catch (e) { console.error("[hr sign] щоденна:", e.message); } finally { RUNNING = false; }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { check, daily, manual, summary, schedule, docLabel, FROM, COOLDOWN_S };
