// bot/fines_sheet.js — штрафи в Google-таблицю «Штрафы от координаторов», вкладка «штрафы».
// Коли лист зі штрафами пішов в офіс (bot/office.js, kind 'fin'), ті самі штрафи дописуються рядками в кінець таблиці:
//   Дата | Фамилия | Имя | Предприятие | Фирма | Сумма штрафа | Причина штрафа | Удержано | З/П за месяц | Коментарии
//   «Удержано» і «З/П за месяц» лишаються порожні — їх заповнює офіс. Тестові (TEST_…) у таблицю не йдуть.
// Не вдалося (немає доступу, Google не відповів) — лист однаково надіслано; штраф позначено error і повтор кожні 10 хв.
// Доступ: сервісний акаунт з google-key.json має бути в таблиці «Редактором».
// Налаштування (.env, необовʼязково): FINES_SHEET_ID, FINES_SHEET_TAB. Таблиці: db/migration_fines.sql (sheet_state…).
"use strict";

const path = require("path");
const db = require("../db");

const SHEET_ID = (process.env.FINES_SHEET_ID || "15PalqM2g6Q0IhXmyTUSK8gE76VwppFLnbGo-p0U65ug").trim();
const SHEET_TAB = (process.env.FINES_SHEET_TAB || "штрафы").trim();
const RETRY_MS = 10 * 60 * 1000;
// Агентство — з назви закладу (як у колонці «Фирма» таблиці)
// Порядок важливий: перше збігання; «Hydro Trzcianka Well» → WELL DONE, а сам «Hydro Trzcianka» (без агентства в назві) — SAS
const AGENCY = [[/\bSAS\b/i, "SAS LOGISTIC"], [/\bAPT\b/i, "APT EAST STAFF"], [/\bWELL\b/i, "WELL DONE"], [/\bDIPICO\b/i, "DIPICO"],
  [/\bOLDAR\b/i, "WORK PLACES"], [/\bTRZCIANKA\b/i, "SAS LOGISTIC"]];
const agencyOf = (facility) => (AGENCY.find(([re]) => re.test(String(facility || ""))) || [null, ""])[1];
// «Прогул» → «прогул», як у таблиці; латиниця (RCP, Bonifikata…) — без змін
const reasonOf = (x) => {
  const s = String(x.name_ru || x.type_name || "").trim();
  return /^[А-ЯЁІЇЄҐ][а-яёіїєґ]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
};
const dmy = (iso) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}.${iso.slice(0, 4)}`;   // 1.8.2026

let API = null;
function api() {
  if (!API) {
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, "..", "google-key.json"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],     // запис — лише тут; імпорт працівників читає (import_sheets.js)
    });
    API = google.sheets({ version: "v4", auth });
  }
  return API;
}
const office = () => require("./office");

// Після листа в офіс: позначити й одразу спробувати записати. Повертає { state: done | error | skip, error? }
async function afterSend(ids) {
  try {
    await db.query(`UPDATE fin.fines SET sheet_state = 'pending', sheet_error = NULL WHERE id = ANY($1::bigint[]) AND sheet_state IS DISTINCT FROM 'done'`, [ids]);
  } catch (e) {
    console.error("[fines sheet] без колонок sheet_state — запустіть db/migration_fines.sql:", e.message);
    return { state: "skip", error: "migration" };
  }
  return flush();
}

let BUSY = null;
// Записати всі pending / error — по черзі (два листи підряд не пишуть в один рядок)
function flush() {
  if (!BUSY) BUSY = doFlush().finally(() => { BUSY = null; });
  return BUSY;
}
async function doFlush() {
  let r;
  try {
    r = await db.query(
      `SELECT f.id, to_char(f.fine_date, 'YYYY-MM-DD') AS fine_date, f.type_name, t.name_ru, f.amount, f.note, fa.name AS facility,
              w.full_name, w.login, to_jsonb(w)->>'last_name' AS last_name, to_jsonb(w)->>'first_name' AS first_name
         FROM fin.fines f
         JOIN workers w ON w.id = f.worker_id
         LEFT JOIN facilities fa ON fa.id = f.facility_id
         LEFT JOIN fin.types t ON t.id = f.type_id
        WHERE f.sheet_state IN ('pending', 'error')
        ORDER BY f.fine_date, f.id`);
  } catch (e) {
    return { state: "skip", error: "migration" };
  }
  const test = r.rows.filter((x) => /^TEST_/i.test(x.login || ""));
  if (test.length) await db.query(`UPDATE fin.fines SET sheet_state = NULL WHERE id = ANY($1::bigint[])`, [test.map((x) => x.id)]);
  const rows = r.rows.filter((x) => !/^TEST_/i.test(x.login || ""));
  if (!rows.length) return { state: "done", count: 0 };
  const values = rows.map((x) => {
    const n = office().splitName(x);
    return [dmy(x.fine_date), n.last, n.first, x.facility || "", agencyOf(x.facility), Number(x.amount), reasonOf(x), "", "", x.note || ""];
  });
  const ids = rows.map((x) => x.id);
  try {
    const s = api();
    // перший порожній рядок після останнього заповненого (у таблиці бувають порожні рядки посередині)
    const cur = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_TAB}'!A:J` });
    const all = cur.data.values || [];
    let last = 0;
    all.forEach((row, i) => { if (row.some((c) => String(c).trim())) last = i + 1; });
    const from = last + 1, to = last + values.length;
    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A${from}:J${to}`,
      valueInputOption: "USER_ENTERED",          // дата й сума — як ввів би людина (формат колонок таблиці)
      requestBody: { values },
    });
    await db.query(`UPDATE fin.fines SET sheet_state = 'done', sheet_at = now(), sheet_error = NULL WHERE id = ANY($1::bigint[])`, [ids]);
    console.log(`[fines sheet] записано ${values.length} рядк. (${from}–${to})`);
    return { state: "done", count: values.length, from, to };
  } catch (e) {
    const msg = String((e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message).slice(0, 300);
    await db.query(`UPDATE fin.fines SET sheet_state = 'error', sheet_error = $2 WHERE id = ANY($1::bigint[])`, [ids, msg]).catch(() => {});
    console.error("[fines sheet] не вдалося записати:", msg);
    return { state: "error", error: msg };
  }
}

function schedule() {
  setInterval(() => { flush().catch((e) => console.error("[fines sheet]", e.message)); }, RETRY_MS);
}

module.exports = { afterSend, flush, schedule, agencyOf, reasonOf, SHEET_ID, SHEET_TAB };
