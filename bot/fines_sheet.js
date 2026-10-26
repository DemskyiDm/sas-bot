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

//const SHEET_ID = (process.env.FINES_SHEET_ID || "15PalqM2g6Q0IhXmyTUSK8gE76VwppFLnbGo-p0U65ug").trim();
const SHEET_ID = (process.env.FINES_SHEET_ID || "19f6wbpd0yNi9HFBplJELCbwkf9VZfYV6qSoBVcjtBSU").trim();
const SHEET_TAB = (process.env.FINES_SHEET_TAB || "штрафы").trim();
const RETRY_MS = 10 * 60 * 1000;
// Агентство — з назви закладу (як у колонці «Фирма» таблиці)
// Порядок важливий: перше збігання; «Hydro Trzcianka Well» → WELL DONE, а сам «Hydro Trzcianka» (без агентства в назві) — SAS
const AGENCY = [[/\bSAS\b/i, "SAS LOGISTIC"], [/\bAPT\b/i, "APT EAST STAFF"], [/\bWELL\b/i, "WELL DONE"], [/\bDIPICO\b/i, "DIPICO"],
  [/\bOLDAR\b/i, "WORK PLACES"], [/\bTRZCIANKA\b/i, "SAS LOGISTIC"]];
const agencyOf = (facility) => (AGENCY.find(([re]) => re.test(String(facility || ""))) || [null, ""])[1];
// «Предприятие» — як у списку офісу, а не як у базі: назва в таблиці → назви закладів у базі (регістр і пробіли не важливі).
// Закладу тут немає — пишемо назву з бази й попереджаємо в Telegram (FINES_SHEET_ALERT_CHAT_ID, інакше GAP_ADMIN_CHAT_ID) — додайте його сюди.
const SHEET_FACILITY = {
  "ACTION Wypędy": ["Action Wypędy SAS"],
  "ACTION Wypędy Produkcja": ["Action Production SAS"],
  "ACTION Zamienie": ["Action Zamienie SAS", "Action Zamienie Przejęcie SAS", "Action Zamienie SAS EAST BRIDGE"],
  "Anpacars": ["Anpacars Sosnowiec SAS"],
  "Anpacars Bedzin": ["ANPACARS BĘDZIN SAS"],
  "ATS DISPLAY": ["ATS Display APT"],
  "BLACHY PRUSZYŃSKI": ["Blachy Pruszyński APT", "Punto Pruszyński APT"],
  "Cainiao": ["CAINIAO APT", "CAINIAO Dipico"],
  "Cainiao 2": ["CAINIAO APT 2", "CAINIAO Dipico 2"],
  "Cerrad": ["Cerrad Sas"],
  "Ceva Łozienica": ["CEVA APT", "CEVA Dipico"],
  "Ceva Krężoly": ["Ceva Krężoły APT"],
  "Ceva Nowy Świat": ["Ceva Nowy Świat APT", "Ceva Nowy Świat Well"],
  "Ceva Swiebodzin": ["CEVA ŚWIEBODZIN APT"],
  "Domel": ["Domel SAS"],
  "DPD Lucmież": ["DPD Lućmierz SAS"],
  "DSV": ["DSV Dipico"],
  "EKO OKNA": ["EkoOkna SAS", "EkoOkna Well"],
  "FIEGE GOLENIÓW": ["Fiege Goleniów Well"],
  "FIEGE NDM": ["Fiege NDM Well"],
  "FIEGE Stanowice": ["Fiege Logistics Stanowice Well"],
  "FIEGE ZIELONA GÓRA": ["Fiege ZG Well"],
  "G&G": ["G&G APT", "G&G Well"],
  "GERDA Sokołów": ["Gerda Sokołów APT"],
  "GERDA Starachowice": ["Gerda Starachowice APT"],
  "HULTAFORS": ["HULTAFORS WELL"],
  "Hydro Chrzanów": ["Hydro Chrzanów SAS"],
  "HYDRO ŁÓDŹ": ["Hydro Łódź SAS", "Hydro Łódź SAS (stary)", "Hydro Łódź Well"],
  "HYDRO TRZCIANKA": ["Hydro Trzcianka", "Hydro Trzcianka Well"],
  "ID Konin Żagański": ["ID Konin Żagański SAS", "ID Konin Żagański Well"],
  "IDL Krajków": ["ID Krajków SAS"],
  "IDL Pietrzykowice": ["Id Logistics Wro APT", "Id Logistics Wro SAS", "Id Logistics Wro Well"],
  "IDL Psary": ["ID Psary APT", "ID Psary SAS", "ID Psary WELL"],
  "IDL Rokitno": ["Id Log Rokitno APT", "Id Log Rokitno SAS", "Id Log Rokitno Well"],
  "IDL Świecko": ["ID Słubice SAS"],
  "IDL Tyniec Mały": ["Id Logistics Tyniec APT", "Id Logistics Tyniec WELL"],
  "IGP Operations": ["IGP Operations PL APT", "IGP Operations PL SAS"],
  "ILS Błonie": ["ILS Błonie SAS"],
  "INTERCARS UoP": ["Inter Cars SAS"],
  "INTERCARS UZ": ["ILS UZ SAS"],
  "Klimor": ["Klimor APT"],
  "Ligentia": ["Ligentia APT", "Ligentia Well"],
  "LUCKY UNION": ["Lucky Union APT"],
  "Marc-Th": ["Marc Sas"],
  "Maropak": ["MAROPAK SAS"],
  "Metler": ["METLER Dipico"],
  "Mieszko": ["Mieszko APT", "Mieszko SAS"],
  "Mieszko Services": ["MIESZKO SERVICES APT", "MIESZKO Services SAS"],
  "Notino": ["Notino Well"],
  "OLDAR": ["Oldar Agencja Work", "Aleksandra Dębska Oldar WP"],
  "Partners": ["Partners Lowicz SAS", "Rawa Mazowiecka SAS"],
  "POLMLEK": ["PolMlek SAS"],
  "RHENUS GOLENIÓW": ["Rhenus Gol WELL"],
  "SGB JAROSZOWIEC": ["SGB JAROSZOWIEC SAS"],
  "SGB PRUSZKÓW": ["SGB Pruszków SAS"],
  "SGB SZCZECIN": ["Saint-Gobain SAS"],
  "Trans-Tok": ["Trans-Tok APT"],
  "VERSAL": ["Versal APT"],
  "Wsip": ["Wsip Dipico"],
};
const facKey = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const SHEET_FACILITY_BY_DB = new Map(Object.entries(SHEET_FACILITY).flatMap(([sheet, names]) => names.map((n) => [facKey(n), sheet])));
const knownFacility = (facility) => !facility || SHEET_FACILITY_BY_DB.has(facKey(facility));
const sheetFacilityOf = (facility) => (facility ? SHEET_FACILITY_BY_DB.get(facKey(facility)) || facility : "");
const alertChats = () => String(process.env.FINES_SHEET_ALERT_CHAT_ID || process.env.GAP_ADMIN_CHAT_ID || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
let BOT = null;
async function alertUnknown(names) {
  console.warn(`[fines sheet] заклади не зі списку таблиці (записано як у базі): ${names.join(", ")}`);
  if (!BOT || !alertChats().length) return;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = `⚠️ Штрафи → Google-таблиця: заклад не зі списку, «Предприятие» записано як у базі:\n`
    + names.map((n) => `• <b>${esc(n)}</b>`).join("\n") + `\nДодайте відповідність у bot/fines_sheet.js (SHEET_FACILITY).`;
  for (const chat of alertChats()) {
    await BOT.telegram.sendMessage(chat, text, { parse_mode: "HTML" }).catch((e) => console.error("[fines sheet] alert:", e.message));
  }
}
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
    return [dmy(x.fine_date), n.last, n.first, sheetFacilityOf(x.facility), agencyOf(x.facility), Number(x.amount), reasonOf(x), "", "", x.note || ""];
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
    const unknown = [...new Set(rows.filter((x) => !knownFacility(x.facility)).map((x) => x.facility))];
    if (unknown.length) await alertUnknown(unknown);
    return { state: "done", count: values.length, from, to };
  } catch (e) {
    const msg = String((e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message).slice(0, 300);
    await db.query(`UPDATE fin.fines SET sheet_state = 'error', sheet_error = $2 WHERE id = ANY($1::bigint[])`, [ids, msg]).catch(() => {});
    console.error("[fines sheet] не вдалося записати:", msg);
    return { state: "error", error: msg };
  }
}

function schedule(bot) {
  BOT = bot || null;
  setInterval(() => { flush().catch((e) => console.error("[fines sheet]", e.message)); }, RETRY_MS);
}

module.exports = { afterSend, flush, schedule, agencyOf, sheetFacilityOf, reasonOf, SHEET_ID, SHEET_TAB };
