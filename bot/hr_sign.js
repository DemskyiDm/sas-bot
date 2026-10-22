// bot/hr_sign.js — підписи документів у HRappka (Pracownicy → «Dokumenty», картка працівника в боті).
// Новий працівник отримує листи з документами (umowa, załączniki, program lojalnościowy, aneksy…) і підписує їх у HRappka;
// у таблиці EMPLOYEE_ATTACHMENT_FULL поле eSignature: SEND — надіслано, не підписано; SIGN — підписано.
// Усієї бази HRappka (170 тис. вкладень) не тягнемо: питаємо лише за паспортами потрібних людей (фільтр на боці HRappka).
//   • щодня о 6:00 (Варшава) — працівники з BHP від HR_SIGN_FROM (15.10.2026), які ще не підписали все;
//     рахуються документи, надіслані ±10 днів від BHP (старі періоди — ні), повторний пакет — лише останній;
//   • о 7:00 — звіт «хто не підписав» листом з Excel на HR_SIGN_REPORT_TO (.env, через кому);
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
  const out = {};
  k.rows.forEach((x) => { out[x.worker_id] = { total: 0, signed: 0, found: false, checked_at: x.checked_at, error: x.error, docs: [] }; });
  const latest = {};   // worker → назва документа → останній (рядки впорядковані за датою — пізніший перезаписує)
  d.rows.forEach((x) => {
    const label = docLabel(x.display_name, x.full_name);
    (latest[x.worker_id] = latest[x.worker_id] || new Map()).set(label.toLowerCase(), { label, status: x.status, created: x.created });
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
  const unsigned = (x) => x.s.docs.filter((d) => d.status !== "SIGN").map((d) => d.label);
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
<p>${rows.length ? `pracownicy z BHP od ${dmyIso(FROM)}, którzy <b>nie podpisali dokumentów</b> w HRappka: <b>${rows.length} os.</b>
Liczą się dokumenty wysłane ±${WINDOW_DAYS} dni od BHP; przy powtórnej wysyłce — ostatnia. Ta sama lista jest w załączniku (Excel).` : `wszyscy pracownicy z BHP od ${dmyIso(FROM)} podpisali dokumenty w HRappka.`}</p>
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

let RUNNING = false;
function schedule() {
  const cron = require("node-cron");
  cron.schedule("0 7 * * *", async () => {
    try { await report(); } catch (e) { console.error("[hr sign] звіт:", e.message); }
  }, { timezone: "Europe/Warsaw" });
  cron.schedule("0 6 * * *", async () => {
    if (RUNNING) return;
    RUNNING = true;
    try { await daily(); } catch (e) { console.error("[hr sign] щоденна:", e.message); } finally { RUNNING = false; }
  }, { timezone: "Europe/Warsaw" });
}

module.exports = { check, daily, manual, summary, report, reportRows, schedule, docLabel, FROM, COOLDOWN_S, WINDOW_DAYS };
