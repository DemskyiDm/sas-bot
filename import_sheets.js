require("dotenv").config();
const { https } = require("follow-redirects");
const db = require("./db");
const crypto = require("crypto");
const csvHashCache = new Map();
// Який аркуш останнім писав в об'єкт: якщо прив'язку змінили, «без змін» не пропускаємо.
const facilityWriter = new Map();

const { google } = require("googleapis");
const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "google-key.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheetsApi = google.sheets({ version: "v4", auth });

// ── CONFIG ────────────────────────────────────────────────────
// Таблиці, з яких імпортуються ВСІ видимі аркуші.
// Новий аркуш у цих таблицях підхоплюється сам. Нову таблицю — дописати сюди
// (сервісному акаунту з google-key.json потрібен доступ на читання).
//
// Який аркуш у який об'єкт іде — таблиця import_sheet_map у БД
// (db/migration_import_sheets.sql). Прив'язка за gid аркуша, тому
// перейменування аркуша НЕ змінює ні об'єкт, ні його назву в панелі.
const SPREADSHEETS = [
  "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4", // Ceva Nowy Świat, Świebodzin, Ligentia
  "1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c", // ID Psary, Hydro Chrzanów
  "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI", // Metler, Punto, G&G, Blachy, Gerda Sokołów, Oldar
  "1xgOv39j82OHsGvhR53Y_IuYEN-S9KrIcLsDXvFN4fVA", // Ceva Krężoły
  "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU", // Action, ILS, Inter Cars, PolMlek, Trans-Tok
  "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4", // Anpacars, Mieszko, SGB Jaroszowiec, EkoOkna
  "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw", // Fiege Goleniów, Rhenus, CEVA, Hultafors, Lucky Union
  "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM", // Id Log Rokitno, Cainiao, Saint-Gobain
  "1yYaSyo96Z96H8CGHkVWvKglTFim-nC489vK2gxV-3T8", // Fiege ZG
  "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw", // IGP, Fiege NDM, Gerda Starachowice, Versal, Maropak…
  "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs", // Id Logistics Wro/Tyniec, ID Krajków, DSV, Fiege Stanowice
  "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ", // Hydro Łódź/Trzcianka, Klimor, DPD, Notino, Partners, CEVA Piotrków
  "1UHwrLJyb6P2Zc4j1ibC8Vif7uLR2_0tiYGHXpApsp_A", // ID Konin Żagański
];

// Аркуші, у назві яких є ці слова, не імпортуються (регістр не важливий).
// /zwolni/ ловить «zwolnienie», «Zwolnienia», «ZWOLNIENI».
const EXCLUDE_TITLES = [/zwolni/i];

// Свіжа копія аркуша («Kopia arkusza …», «Copy of …», «Копия …») —
// не імпортується, поки її не перейменують.
const COPY_TITLE = /^\s*(kopia|copy of|копия|копія)(\s|$)/i;

// Новий аркуш вважається копією іншого об'єкта (і не імпортується), якщо
// щонайменше COPY_SHARE його людей з тією ж датою BHP уже є на одному
// іншому об'єкті (мінімум COPY_MIN людей). Так дубль аркуша з чужими людьми
// не створить об'єкт-двійник.
const COPY_SHARE = 0.6;
const COPY_MIN = 3;

// Запобіжник: більше нових об'єктів за один імпорт не створюється
// (решта — наступного разу). Захист від масового створення через помилку.
const MAX_NEW_FACILITIES = Number(process.env.IMPORT_MAX_NEW_FACILITIES || 10);

// Пауза між аркушами (ліміт Google Sheets API).
const SHEET_PAUSE_MS = Number(process.env.IMPORT_SHEET_PAUSE_MS || 2500);

// ── GOOGLE SHEETS ─────────────────────────────────────────────
// Список аркушів таблиці читається заново на кожному імпорті —
// інакше новий аркуш не було б видно до перезапуску сервера.
async function fetchSheetList(ssId) {
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: ssId,
    fields:
      "properties(title),sheets(properties(sheetId,title,index,hidden,sheetType))",
  });
  const props = meta.data.properties || {};
  const sheets = (meta.data.sheets || [])
    .map((s) => s.properties || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  return { title: props.title || ssId, sheets };
}

async function fetchRows(ssId, title) {
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `'${String(title).replace(/'/g, "''")}'`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return resp.data.values || [];
}

// ── PARSE DATE ────────────────────────────────────────────────
function parseDate(str) {
  if (!str || str === "---" || str === "----" || str === "?" || str === "")
    return null;
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  let day = parseInt(m[1], 10),
    month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12) month = 12;
  if (day < 1 || day > 31) day = 31;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime()) || date.getMonth() !== month - 1)
    day = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── CLEAN PASSPORT ────────────────────────────────────────────
function cleanPassport(str) {
  return String(str || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

// PESEL з таблиці — лише щоб знайти людину; у workers.pesel його пише bot/hr_import.js з HRappka.
// У таблиці PESEL часто як число — без нуля на початку.
function cleanPesel(str) {
  const p = String(str || "").trim().replace(/[^0-9]/g, "").substring(0, 20);
  return (p.length === 10 ? "0" + p : p) || null;
}

// ── STATUS PRIORITY ───────────────────────────────────────────
const STATUS_PRIORITY = {
  pracuje: 5,
  urlop: 4,
  l4: 4,
  przeniesiony: 3,
  rezygnacja: 2,
  zwolniony: 1,
  unknown: 0,
};

function parseStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s.includes("urlop")) return "urlop";
  if (s.includes("l4")) return "l4";
  if (s.includes("rezygnacja")) return "rezygnacja";
  if (s.includes("zwolniony")) return "zwolniony";
  if (s.includes("przenies")) return "przeniesiony";
  if (s.includes("pracuje")) return "pracuje";
  return "unknown";
}

// ── PARSE SHEET ───────────────────────────────────────────────
// strict = true (нові аркуші): без рядка заголовків з Paszport/Nazwisko
// аркуш не вважається списком людей. Для вже прив'язаних аркушів —
// як і раніше, стандартні позиції колонок.
function parseSheet(rows, strict = false) {
  const res = { ok: false, reason: null, workerMap: {}, skipped: 0 };

  if (rows.length < 2) {
    res.reason = "no_data";
    return res;
  }

  // Find header row
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (
      rows[i].some(
        (c) =>
          String(c || "").toLowerCase().includes("paszport") ||
          String(c || "").toLowerCase().includes("nazwisko"),
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const headers = rows[headerIdx].map((h) => String(h || "").toLowerCase().trim());
  let iPassport = headers.findIndex(
    (h) => h.includes("paszport") || h.includes("passport"),
  );
  let iNazwisko = headers.findIndex((h) => h === "nazwisko");
  let iImie = headers.findIndex((h) => h === "imię" || h === "imie");
  let iStatus = headers.findIndex((h) => h === "status");
  let iBhp = headers.findIndex(
    (h) =>
      h.includes("bhp") ||
      h.includes("rozpoczęcie") ||
      h.includes("rozpoczecie"),
  );
  let iLastDay = headers.findIndex(
    (h) => h.includes("ostatni roboczy") || h.includes("ostatni rob"),
  );
  // Посада (колонка «Stanowisko»). Немає колонки — посаду в базі не чіпаємо.
  const iStan = headers.findIndex((h) => h.includes("stanowisk"));

  if (iPassport === -1 && iNazwisko === -1) {
    if (strict) {
      res.reason = "no_header";
      return res;
    }
    console.warn("  Headers not found — using default column positions");
    iPassport = 1;
    iNazwisko = 3;
    iImie = 4;
    iStatus = 7;
    iBhp = 10;
    iLastDay = 12;
    headerIdx = 0;
  }

  if (iPassport === -1 || iNazwisko === -1) {
    res.reason = "no_columns";
    return res;
  }

  res.headerIdx = headerIdx;
  res.cols = { iPassport, iNazwisko, iStatus, iBhp, iStan };

  const MAX_COL = 26;

  // Збираємо унікальні записи з CSV (ключ: паспорт + bhp)
  const workerMap = res.workerMap;
  let skipped = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i].slice(0, MAX_COL);
    if (row.every((c) => !c || !String(c).trim())) continue;

    const passport = cleanPassport(row[iPassport]);
    const pesel = cleanPesel(row[2]);

    if (!passport || passport.length < 3 || passport.length > 30) {
      skipped++;
      continue;
    }

    const nazwisko = String(row[iNazwisko] || "").trim();
    const imie = iImie !== -1 ? String(row[iImie] || "").trim() : "";
    if (!nazwisko) {
      skipped++;
      continue;
    }

    const fullName = imie ? `${nazwisko} ${imie}` : nazwisko;
    // undefined — колонки немає (не чіпати), null — порожня клітинка
    const stanowisko = iStan === -1 ? undefined
      : String(rows[i][iStan] || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const status = parseStatus(iStatus !== -1 ? row[iStatus] : "");
    const bhpDate = iBhp !== -1 ? parseDate(row[iBhp]) : null;
    const lastWorkDay = iLastDay !== -1 ? parseDate(row[iLastDay]) : null;
    const safeBhp = bhpDate || null;
    const safeLastDay = lastWorkDay || null;

    // Унікальний ключ: паспорт + BHP (один працівник може бути кілька разів)
    const mapKey = `${passport}_${safeBhp}`;
    const data = { passport, fullName, nazwisko, imie: imie || null, stanowisko, status, safeBhp, safeLastDay, pesel };
    const prev = workerMap[mapKey];

    if (!prev) {
      workerMap[mapKey] = data;
    } else if (!prev.safeLastDay && data.safeLastDay) {
      workerMap[mapKey] = data;
    } else if (
      data.safeLastDay &&
      prev.safeLastDay &&
      data.safeLastDay > prev.safeLastDay
    ) {
      workerMap[mapKey] = data;
    } else if (
      (STATUS_PRIORITY[data.status] || 0) > (STATUS_PRIORITY[prev.status] || 0)
    ) {
      workerMap[mapKey] = data;
    }
  }

  res.skipped = skipped;
  res.ok = true;
  return res;
}

// ── IMPORT ONE SOURCE ─────────────────────────────────────────
// source: { ssId, gid, title, facilityName (→ source_sheet), strict, rows?, parsed? }
async function importSource(source, facilityId, cache) {
  const shown =
    source.title && source.title.trim() !== source.facilityName.trim()
      ? ` (аркуш «${source.title}»)`
      : "";
  console.log(`\nImporting: ${source.facilityName}${shown}`);
  let rows = source.rows;

  if (!rows) {
    try {
      rows = await fetchRows(source.ssId, source.title);
    } catch (e) {
      console.error(`  ERROR fetching sheet: ${e.message}`);
      return;
    }
  }

  // Проверяем хеш
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify(rows))
    .digest("hex");

  const cacheKey = `${source.ssId}_${source.gid}`;

  if (csvHashCache.get(cacheKey) === hash && facilityWriter.get(facilityId) === cacheKey) {
    console.log(`  No changes — skipping`);
    return;
  }

  csvHashCache.set(cacheKey, hash);
  facilityWriter.set(facilityId, cacheKey);

  if (rows.length < 2) {
    console.log("  No data rows found");
    return;
  }

  const parsed = source.parsed || parseSheet(rows, source.strict);
  if (!parsed.ok) {
    console.error(
      parsed.reason === "no_header"
        ? "  ERROR: Header row not found"
        : "  ERROR: Cannot find required columns",
    );
    return;
  }

  console.log(
    `  Header row: ${parsed.headerIdx}, passport=${parsed.cols.iPassport} nazwisko=${parsed.cols.iNazwisko} status=${parsed.cols.iStatus} bhp=${parsed.cols.iBhp}` +
      (parsed.cols.iStan !== undefined && parsed.cols.iStan !== -1 ? ` stanowisko=${parsed.cols.iStan}` : ""),
  );

  // Рядки аркуша → hrz.sheet_periods (лише для порівняння з HRappka, bot/hr_import.js).
  // Працівників і історію таблиці більше не пишуть: поточний період — з HRappka, старі періоди лишаються як є.
  const rows2 = Object.values(parsed.workerMap).map((d) => [d.passport, d.pesel || null, d.fullName, d.status, d.safeBhp, d.safeLastDay, d.stanowisko == null ? null : d.stanowisko]);
  const skipped = parsed.skipped;
  const client = await db.pool.connect();
  try {
    const prev = Number((await client.query(`SELECT count(*) AS n FROM hrz.sheet_periods WHERE facility_id = $1`, [facilityId])).rows[0].n);
    // битий CSV від Google не повинен знести об'єкт
    if (prev > 10 && rows2.length < prev * 0.5) {
      console.warn(`  ⚠ на аркуші ${rows2.length} рядків, у копії ${prev} — ЗАБАГАТО зникло, копію не оновлено (можливо битий CSV)`);
      return;
    }
    const col = (i) => rows2.map((r) => r[i]);
    await client.query("BEGIN");
    await client.query(`DELETE FROM hrz.sheet_periods WHERE facility_id = $1`, [facilityId]);
    await client.query(
      `INSERT INTO hrz.sheet_periods (facility_id, source_sheet, passport, pesel, full_name, status, bhp_date, last_work_date, stanowisko)
       SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::date[], $9::text[])`,
      [facilityId, source.facilityName, col(0), col(1), col(2), col(3), col(4), col(5), col(6)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.warn(`  SHEET COPY error: ${err.message}`);
    return;
  } finally {
    client.release();
  }

  console.log(`  Done: rows = ${rows2.length} skipped = ${skipped}`);
}

// ── CACHE ─────────────────────────────────────────────────────
async function loadCache() {
  console.log("  Loading cache from DB...");
  // Нові колонки (db/migration_tg_coord.sql): є — заповнюємо, немає — імпорт як раніше
  const colsRes = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'workers' AND column_name IN ('last_name', 'first_name'))
          OR (table_name = 'worker_facility_history' AND column_name = 'stanowisko'))`,
  );
  const hasNames = colsRes.rows.filter((r) => r.table_name === "workers").length === 2;
  const hasStan = colsRes.rows.some((r) => r.column_name === "stanowisko");
  const [workersRes, historyRes, facilitiesRes] = await Promise.all([
    db.query(`SELECT id, login, pesel, full_name${hasNames ? ", last_name, first_name" : ""} FROM workers`),
    db.query(`SELECT worker_id, facility_id, status::text, last_work_date, bhp_date FROM worker_facility_history`),
    db.query(`SELECT id, name FROM facilities ORDER BY id`),
  ]);

  // Будуємо індекси
  const cache = {
    hasNames,
    hasStan,
    byLogin: new Map(),
    byPesel: new Map(),
    historySet: new Set(),
    facilityByName: new Map(), // lower(name) — як шукав старий імпорт
    facilityByTrim: new Map(), // lower(trim(name)) — для нових аркушів
    facilityName: new Map(), // id → name
  };

  workersRes.rows.forEach((w) => {
    cache.byLogin.set(w.login, w);
    if (w.pesel) cache.byPesel.set(w.pesel, w);
  });

  historyRes.rows.forEach((h) => {
    const bhp = h.bhp_date ? h.bhp_date.toISOString().split("T")[0] : "null";
    const key = `${h.worker_id}_${h.facility_id}_${bhp}`;
    cache.historySet.add(key);
  });

  facilitiesRes.rows.forEach((f) => {
    cache.facilityByName.set(f.name.toLowerCase(), f.id);
    const t = f.name.trim().toLowerCase();
    if (!cache.facilityByTrim.has(t)) cache.facilityByTrim.set(t, f.id);
    cache.facilityName.set(f.id, f.name);
  });

  console.log(
    `  Cache: ${workersRes.rows.length} workers, ${historyRes.rows.length} history, ${facilitiesRes.rows.length} facilities`,
  );
  return cache;
}

// ── SHEET → FACILITY MAP ──────────────────────────────────────
const mapKey = (ssId, sheetId) => `${ssId}_${String(sheetId)}`;

async function loadSheetMap() {
  let res;
  try {
    res = await db.query(`SELECT * FROM import_sheet_map`);
  } catch (e) {
    // Без таблиці прив'язок усі аркуші виглядали б новими, і імпорт створив
    // би об'єкти з назвами аркушів. Тому — стоп.
    throw new Error(
      `import_sheet_map недоступна (${e.message}). Спершу запустіть db/migration_import_sheets.sql`,
    );
  }
  if (res.rows.length === 0) {
    throw new Error("import_sheet_map порожня. Спершу запустіть db/migration_import_sheets.sql");
  }
  const map = new Map();
  for (const r of res.rows) {
    r.facility_id = r.facility_id === null ? null : Number(r.facility_id);
    map.set(mapKey(r.ss_id, r.sheet_id), r);
  }
  return map;
}

async function updateMapRow(ssId, sheetId, { title, state, note, seen }) {
  await db.query(
    `UPDATE import_sheet_map
        SET sheet_title  = COALESCE($3, sheet_title),
            state        = $4,
            note         = $5,
            last_seen_at = CASE WHEN $6 THEN now() ELSE last_seen_at END
      WHERE ss_id = $1 AND sheet_id = $2`,
    [ssId, String(sheetId), title || null, state, note || null, !!seen],
  );
}

async function upsertMapRow(ssId, sheetId, f) {
  await db.query(
    `INSERT INTO import_sheet_map
       (ss_id, sheet_id, facility_id, source_name, sheet_title, origin, state, note,
        last_seen_at, facility_created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), CASE WHEN $9 THEN now() END)
     ON CONFLICT (ss_id, sheet_id) DO UPDATE SET
       facility_id  = EXCLUDED.facility_id,
       source_name  = EXCLUDED.source_name,
       sheet_title  = EXCLUDED.sheet_title,
       state        = EXCLUDED.state,
       note         = EXCLUDED.note,
       last_seen_at = now(),
       facility_created_at = COALESCE(import_sheet_map.facility_created_at, EXCLUDED.facility_created_at)`,
    [
      ssId,
      String(sheetId),
      f.facilityId || null,
      f.sourceName,
      f.title,
      f.origin || "auto",
      f.state,
      f.note || null,
      !!f.created,
    ],
  );
}

// ── SCAN: які аркуші є і що з кожним робити ───────────────────
// action: import (прив'язаний), new (новий або без об'єкта), skip (reason)
// Пріоритет, якщо два видимі аркуші прив'язані до одного об'єкта:
// прив'язаний вручну, далі зі старого списку, далі — раніше знайдений.
const ORIGIN_RANK = { manual: 0, legacy: 1, auto: 2 };
function mapPriority(m) {
  const rank = m.origin in ORIGIN_RANK ? ORIGIN_RANK[m.origin] : 2;
  return [rank, new Date(m.first_seen_at || 0).getTime()];
}
function betterMap(a, b) {
  const pa = mapPriority(a);
  const pb = mapPriority(b);
  return pa[0] !== pb[0] ? pa[0] < pb[0] : pa[1] < pb[1];
}

async function scanSheets(sheetMap, allowed) {
  const entries = [];
  const errors = [];
  const claimed = new Map(); // facility_id → аркуш, що його імпортує
  const missingKeys = new Set(); // прив'язані аркуші, яких у таблиці більше немає
  const failedSs = new Set();

  let ssList = SPREADSHEETS;
  if (allowed) {
    const ids = new Set();
    for (const m of sheetMap.values())
      if (m.facility_id && allowed.has(m.facility_id)) ids.add(m.ss_id);
    ssList = SPREADSHEETS.filter((id) => ids.has(id));
  }

  for (const ssId of ssList) {
    let meta;
    try {
      meta = await fetchSheetList(ssId);
    } catch (e) {
      console.error(`  ERROR reading spreadsheet ${ssId}: ${e.message}`);
      errors.push({ ssId, error: e.message });
      failedSs.add(ssId);
      continue;
    }

    const seen = new Set();
    for (const sh of meta.sheets) {
      const sheetId = String(sh.sheetId);
      const key = mapKey(ssId, sheetId);
      seen.add(key);
      const m = sheetMap.get(key) || null;
      const title = String(sh.title || "");
      const e = { ssId, ssTitle: meta.title, sheetId, title, map: m };

      if (allowed && !(m && m.facility_id && allowed.has(m.facility_id))) {
        // Ручний імпорт координатора: тільки його об'єкти, нові аркуші —
        // лише при повному імпорті, стани інших аркушів не чіпаємо.
        e.action = "skip";
        e.reason = "filtered";
      } else if (m && m.disabled) {
        e.action = "skip";
        e.reason = "disabled";
      } else if (sh.hidden) {
        e.action = "skip";
        e.reason = "hidden";
      } else if (EXCLUDE_TITLES.some((re) => re.test(title))) {
        e.action = "skip";
        e.reason = "excluded";
      } else if (sh.sheetType && sh.sheetType !== "GRID") {
        e.action = "skip";
        e.reason = "not_grid";
      } else if (m && m.facility_id) {
        const prev = claimed.get(m.facility_id);
        if (!prev) {
          e.action = "import";
          claimed.set(m.facility_id, e);
        } else if (betterMap(m, prev.map)) {
          prev.action = "skip";
          prev.reason = "conflict";
          prev.other = e;
          e.action = "import";
          claimed.set(m.facility_id, e);
        } else {
          e.action = "skip";
          e.reason = "conflict";
          e.other = prev;
        }
      } else {
        e.action = "new";
      }
      entries.push(e);
    }

    if (!allowed) {
      for (const m of sheetMap.values()) {
        const key = mapKey(m.ss_id, m.sheet_id);
        if (m.ss_id !== ssId || seen.has(key)) continue;
        missingKeys.add(key);
        entries.push({
          ssId,
          ssTitle: meta.title,
          sheetId: String(m.sheet_id),
          title: m.sheet_title || m.source_name,
          map: m,
          action: "skip",
          reason: "missing",
        });
      }
    }
  }

  // Таблиця не відкрилася (помилка Google) — її об'єкти все одно зайняті,
  // щоб новий аркуш з такою ж назвою в іншій таблиці їх не перехопив.
  for (const m of sheetMap.values()) {
    if (failedSs.has(m.ss_id) && m.facility_id && !m.disabled && !claimed.has(m.facility_id)) {
      claimed.set(m.facility_id, { title: m.sheet_title || m.source_name, ssTitle: m.ss_id, map: m, unavailable: true });
    }
  }

  // Об'єкт вільний: його не імпортує жоден аркуш у цьому запуску і всі
  // прив'язані до нього аркуші видалені з таблиць.
  const rowsByFacility = new Map();
  for (const m of sheetMap.values()) {
    if (!m.facility_id) continue;
    if (!rowsByFacility.has(m.facility_id)) rowsByFacility.set(m.facility_id, []);
    rowsByFacility.get(m.facility_id).push(m);
  }
  const isFree = (fid) =>
    !claimed.has(fid) &&
    (rowsByFacility.get(fid) || []).every((m) => missingKeys.has(mapKey(m.ss_id, m.sheet_id)));
  const entryByKey = new Map(entries.map((e) => [mapKey(e.ssId, e.sheetId), e]));
  const STATE_LABEL = {
    hidden: "прихований",
    excluded: "zwolnienie",
    not_grid: "не таблиця",
    disabled: "вимкнений",
    conflict: "конфлікт",
    filtered: "не перевірявся",
  };
  const boundTo = (fid) => {
    const c = claimed.get(fid);
    if (c) return `«${c.title}»`;
    const r = (rowsByFacility.get(fid) || []).find((m) => !missingKeys.has(mapKey(m.ss_id, m.sheet_id)));
    if (!r) return "інший аркуш";
    const se = entryByKey.get(mapKey(r.ss_id, r.sheet_id));
    const st = se ? (se.action === "skip" ? se.reason : "active") : r.disabled ? "disabled" : r.state;
    return `«${r.sheet_title || r.source_name}» (${STATE_LABEL[st] || st})`;
  };

  // Нові аркуші — в кінці, і спершу ті, що зі старого списку:
  // назва зі списку має перевагу над випадковим аркушем з такою ж назвою.
  const isAutoNew = (e) => e.action === "new" && !(e.map && e.map.origin === "legacy");
  const ordered = entries.filter((e) => !isAutoNew(e)).concat(entries.filter(isAutoNew));

  return { entries: ordered, errors, claimed, isFree, boundTo };
}

// Чи новий аркуш — копія іншого об'єкта: ті самі люди з тими самими BHP.
async function findCopySource(parsed, cache) {
  const wids = [];
  const bhps = [];
  let total = 0;
  for (const d of Object.values(parsed.workerMap)) {
    if (!d.safeBhp) continue;
    total++;
    let w = d.pesel ? cache.byPesel.get(d.pesel) : null;
    if (!w) w = cache.byLogin.get(d.passport);
    if (w) {
      wids.push(w.id);
      bhps.push(d.safeBhp);
    }
  }
  if (wids.length < COPY_MIN) return null;
  const r = await db.query(
    `SELECT h.facility_id, f.name, count(DISTINCT (h.worker_id, h.bhp_date))::int AS n
       FROM unnest($1::int[], $2::date[]) AS p(wid, bhp)
       JOIN worker_facility_history h ON h.worker_id = p.wid AND h.bhp_date = p.bhp
       JOIN facilities f ON f.id = h.facility_id
      GROUP BY h.facility_id, f.name
      ORDER BY n DESC, h.facility_id
      LIMIT 1`,
    [wids, bhps],
  );
  const top = r.rows[0];
  if (top && top.n >= COPY_MIN && top.n >= total * COPY_SHARE) {
    return { facilityId: Number(top.facility_id), name: top.name, n: top.n, total };
  }
  return null;
}

// Новий аркуш: чи імпортувати, у який об'єкт, чи створювати об'єкт.
// ctx: { cache, claimed, isFree, boundTo, canAdd }. dry = true — нічого не записує (--plan).
async function evaluateNew(e, ctx, dry) {
  const { cache, claimed, isFree, boundTo } = ctx;
  const m = e.map;
  const legacy = !!(m && m.origin === "legacy");
  const hold = (code, note) => ({ hold: true, code, note });

  if (!legacy && COPY_TITLE.test(e.title)) {
    return hold("copy_title", "свіжа копія аркуша — чекаю, поки перейменують");
  }

  let rows;
  try {
    rows = await fetchRows(e.ssId, e.title);
  } catch (err) {
    return hold("fetch_error", `не вдалося прочитати: ${err.message}`);
  }

  const parsed = parseSheet(rows, !legacy);
  const people = parsed.ok ? Object.keys(parsed.workerMap).length : 0;

  let facilityId = null;
  let name;
  let replaced = null;

  if (legacy) {
    // Аркуш зі старого списку, об'єкта ще не було — назва зі списку (як раніше).
    name = m.source_name;
    facilityId =
      cache.facilityByName.get(name.toLowerCase()) ||
      cache.facilityByTrim.get(name.trim().toLowerCase()) ||
      null;
    if (facilityId && !isFree(facilityId)) {
      return hold("name_taken", `об'єкт «${cache.facilityName.get(facilityId)}» уже прив'язаний до аркуша ${boundTo(facilityId)}`);
    }
  } else {
    if (!parsed.ok) {
      return hold("no_header", "немає заголовків Paszport / Nazwisko — не список людей");
    }
    if (people === 0) {
      return hold("empty", "ще немає жодної людини — об'єкт з'явиться з першою");
    }

    name = e.title.trim();
    const ex = cache.facilityByTrim.get(name.toLowerCase()) || null;
    const copy = await findCopySource(parsed, cache);

    if (copy && copy.facilityId !== ex) {
      if (isFree(copy.facilityId)) {
        // Аркуш об'єкта видалили, а копію перейменували — той самий об'єкт.
        facilityId = copy.facilityId;
        replaced = copy.name;
      } else {
        return hold(
          "copy",
          `${copy.n} з ${copy.total} людей (з тими ж BHP) уже є на «${copy.name}» — схоже на копію` +
            (claimed.has(copy.facilityId)
              ? ""
              : `; якщо це заміна аркуша ${boundTo(copy.facilityId)} — прив'яжіть вручну`),
        );
      }
    } else if (ex) {
      if (!isFree(ex)) {
        return hold("name_taken", `об'єкт «${cache.facilityName.get(ex)}» уже прив'язаний до аркуша ${boundTo(ex)}`);
      }
      facilityId = ex;
    } else if (claimed.has(`new:${name.toLowerCase()}`)) {
      const o = claimed.get(`new:${name.toLowerCase()}`);
      return hold("name_taken", `аркуш «${o.title}» з такою ж назвою вже стає новим об'єктом`);
    }

    if (!ctx.canAdd()) {
      return hold("limit", `за один імпорт додається не більше ${MAX_NEW_FACILITIES} нових аркушів — решта наступного разу`);
    }
  }

  const sourceName = facilityId && !legacy ? cache.facilityName.get(facilityId) : name;
  let created = false;
  if (!facilityId) {
    created = true;
    if (!dry) {
      const ins = await db.query(
        `INSERT INTO facilities(name, group_name) VALUES($1, $1) RETURNING id`,
        [name],
      );
      facilityId = ins.rows[0].id;
      cache.facilityByName.set(name.toLowerCase(), facilityId);
      cache.facilityByTrim.set(name.trim().toLowerCase(), facilityId);
      cache.facilityName.set(facilityId, name);
      console.log(`  Facility created: ${name} id = ${facilityId} (аркуш «${e.title}»)`);
    }
  }

  return { hold: false, legacy, facilityId, created, replaced, name, sourceName, rows, parsed, people };
}

const SKIP_STATE = {
  hidden: "hidden",
  excluded: "excluded",
  missing: "missing",
  conflict: "conflict",
  not_grid: "excluded",
};

// ── RUN IMPORT ────────────────────────────────────────────────
// Одночасно йде лише один імпорт (advisory lock у БД): другий запуск,
// наприклад з консолі під час роботи сервера, пропускається.
const IMPORT_LOCK = "hashtext('sas_import_sheets')";

async function runImport(allowedFacilities = null) {
  if (!db.pool || typeof db.pool.connect !== "function") {
    return runImportUnlocked(allowedFacilities);
  }
  const client = await db.pool.connect();
  let locked = false;
  try {
    const r = await client.query(`SELECT pg_try_advisory_lock(${IMPORT_LOCK}) AS ok`);
    locked = !!r.rows[0].ok;
    if (!locked) {
      console.warn(`\n === IMPORT SKIPPED: інший імпорт ще працює === `);
      return { skipped: "locked" };
    }
    return await runImportUnlocked(allowedFacilities);
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(${IMPORT_LOCK})`).catch(() => {});
    client.release();
  }
}

async function runImportUnlocked(allowedFacilities) {
  console.log(`\n === IMPORT STARTED === `);

  const sheetMap = await loadSheetMap();
  const cache = await loadCache();

  // Фільтр за об'єктами (ручний імпорт координатора)
  let allowed = null;
  if (allowedFacilities !== null && allowedFacilities.length > 0) {
    allowed = new Set(allowedFacilities.map(Number));
  }

  const scan = await scanSheets(sheetMap, allowed);
  const { entries, errors, claimed } = scan;
  if (allowed) {
    const n = entries.filter((e) => e.action === "import").length;
    console.log(`Importing ${n} sheets for ${allowed.size} facilities`);
  }

  const stats = { imported: 0, created: [], linked: [], held: [], renamed: [], skipped: {} };
  let added = 0;
  const ctx = { ...scan, cache, canAdd: () => added < MAX_NEW_FACILITIES };
  let fetched = false;

  // Назви аркушів перечитуються перед обробкою кожної таблиці: значення
  // читаються за назвою, і між скануванням і читанням минають хвилини.
  let freshSs = null;
  let fresh = null;
  async function currentTitle(e) {
    if (freshSs !== e.ssId) {
      freshSs = e.ssId;
      try {
        const meta = await fetchSheetList(e.ssId);
        fresh = new Map(meta.sheets.map((s) => [String(s.sheetId), s]));
      } catch (err) {
        fresh = null;
      }
    }
    if (!fresh) return e.title;
    const s = fresh.get(e.sheetId);
    if (!s || s.hidden) return null;
    return String(s.title || "");
  }

  for (const e of entries) {
    try {
      if (e.action === "skip") {
        stats.skipped[e.reason] = (stats.skipped[e.reason] || 0) + 1;
        if (e.map && SKIP_STATE[e.reason]) {
          await updateMapRow(e.ssId, e.sheetId, {
            title: e.reason === "missing" ? null : e.title,
            state: SKIP_STATE[e.reason],
            note: e.reason === "conflict" ? `об'єкт імпортується з аркуша «${e.other.title}»` : null,
            seen: e.reason !== "missing",
          });
        }
        if (e.reason === "conflict") {
          console.warn(`  ⚠ Аркуш «${e.title}» прив'язаний до об'єкта, який імпортується з «${e.other.title}» — пропущено`);
        }
        continue;
      }

      const title = await currentTitle(e);
      if (title === null) {
        console.warn(`  Аркуш «${e.title}» зник або прихований під час імпорту — пропущено`);
        continue;
      }
      if (title !== e.title) {
        if (EXCLUDE_TITLES.some((re) => re.test(title))) continue;
        e.title = title;
      }

      if (fetched) await sleep(SHEET_PAUSE_MS);
      fetched = true;

      if (e.action === "import") {
        const m = e.map;
        if (m.sheet_title && m.sheet_title !== e.title) {
          stats.renamed.push(`${m.sheet_title} → ${e.title}`);
          console.log(`  Аркуш перейменовано: «${m.sheet_title}» → «${e.title}», об'єкт «${m.source_name}» без змін`);
        }
        await importSource(
          { ssId: e.ssId, gid: e.sheetId, title: e.title, facilityName: m.source_name },
          m.facility_id,
          cache,
        );
        await updateMapRow(e.ssId, e.sheetId, { title: e.title, state: "active", seen: true });
        stats.imported++;
        continue;
      }

      // new
      const r = await evaluateNew(e, ctx, false);
      if (r.hold) {
        stats.held.push(`«${e.title}»: ${r.note}`);
        console.log(`\n  Новий аркуш «${e.title}» (${e.ssTitle}) — не імпортується: ${r.note}`);
        const legacy = !!(e.map && e.map.origin === "legacy");
        await upsertMapRow(e.ssId, e.sheetId, {
          facilityId: null,
          sourceName: legacy ? e.map.source_name : e.title,
          title: e.title,
          origin: e.map ? e.map.origin : "auto",
          state: "held",
          note: r.note,
        });
        continue;
      }

      claimed.set(r.facilityId, e);
      claimed.set(`new:${r.name.trim().toLowerCase()}`, e);
      if (!r.legacy) added++;
      if (r.created) stats.created.push(`${r.name} (аркуш «${e.title}», ${e.ssTitle})`);
      else if (r.replaced) stats.linked.push(`«${e.title}» → ${r.replaced} (заміна видаленого аркуша)`);
      else stats.linked.push(`«${e.title}» → ${cache.facilityName.get(r.facilityId)}`);

      await upsertMapRow(e.ssId, e.sheetId, {
        facilityId: r.facilityId,
        sourceName: r.sourceName,
        title: e.title,
        origin: e.map ? e.map.origin : "auto",
        state: "active",
        created: r.created,
      });
      await importSource(
        {
          ssId: e.ssId,
          gid: e.sheetId,
          title: e.title,
          facilityName: r.sourceName,
          strict: !r.legacy,
          rows: r.rows,
          parsed: r.parsed,
        },
        r.facilityId,
        cache,
      );
      stats.imported++;
    } catch (err) {
      console.error(`ERROR in «${e.title}» (${e.ssTitle}): `, err.message);
    }
  }

  // Поточні періоди — з HRappka; копія таблиць змінилась → перераховуємо (поділ APT / APT 2 тощо, rezygnacja)
  try {
    await require("./bot/hr_import").applySnapshot();
  } catch (err) {
    console.error(`  HRappka apply error: ${err.message}`);
  }

  const sk = Object.entries(stats.skipped).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`\n  Аркушів імпортовано: ${stats.imported}${sk ? `; пропущено: ${sk}` : ""}`);
  if (stats.created.length) console.log(`  Нові об'єкти: ${stats.created.join("; ")}`);
  if (stats.linked.length) console.log(`  Нові аркуші до існуючих об'єктів: ${stats.linked.join("; ")}`);
  if (stats.held.length) console.log(`  Очікують: ${stats.held.join("; ")}`);
  if (errors.length) console.log(`  Таблиці з помилкою: ${errors.map((x) => x.ssId).join(", ")}`);

  console.log(`\n === IMPORT DONE === `);
  return { ...stats, errors };
}

// ── PLAN (node import_sheets.js --plan) ───────────────────────
// Показує, що зробить імпорт: які аркуші в які об'єкти, які об'єкти
// будуть створені, що пропущено. Нічого не записує.
async function planImport() {
  const sheetMap = await loadSheetMap();
  const cache = await loadCache();
  const scan = await scanSheets(sheetMap, null);
  const { entries, errors, claimed } = scan;
  let added = 0;
  const ctx = { ...scan, cache, canAdd: () => added < MAX_NEW_FACILITIES };

  const REASON = {
    hidden: "прихований",
    excluded: "zwolnienie — не імпортується",
    not_grid: "не таблиця (діаграма)",
    disabled: "вимкнено вручну (disabled)",
    missing: "аркуша в таблиці більше немає",
    conflict: "об'єкт уже імпортується з іншого аркуша",
  };

  let fetched = false;
  for (const e of entries) {
    const m = e.map;
    const fac = m && m.facility_id ? `${cache.facilityName.get(m.facility_id)} [id ${m.facility_id}]` : null;

    if (e.action === "import") {
      const ren = m.sheet_title && m.sheet_title !== e.title ? `  (раніше «${m.sheet_title}»)` : "";
      e.line = `  ✓ «${e.title}» → ${fac}${ren}`;
    } else if (e.action === "skip") {
      const warn = fac && ["hidden", "excluded", "missing", "conflict", "not_grid"].includes(e.reason);
      const tail =
        e.reason === "conflict"
          ? `: ${fac} імпортується з «${e.other.title}», цей аркуш пропущено`
          : fac
            ? `; об'єкт ${fac} НЕ оновлюватиметься`
            : "";
      e.line = `  ${warn ? "⚠" : "–"} «${e.title}» [gid ${e.sheetId}] — ${REASON[e.reason] || e.reason}${tail}`;
    } else {
      if (fetched) await sleep(SHEET_PAUSE_MS);
      fetched = true;
      const r = await evaluateNew(e, ctx, true);
      e.result = r;
      if (r.hold) {
        e.line = `  … «${e.title}» [gid ${e.sheetId}] — новий, НЕ імпортується: ${r.note}`;
      } else {
        if (!r.legacy) added++;
        if (r.facilityId) claimed.set(r.facilityId, e);
        claimed.set(`new:${r.name.trim().toLowerCase()}`, e);
        e.line = r.created
          ? `  + «${e.title}» [gid ${e.sheetId}] — НОВИЙ об'єкт «${r.name}»${r.legacy ? " (назва зі старого списку)" : ""} (${r.people} людей)`
          : `  + «${e.title}» [gid ${e.sheetId}] → існуючий об'єкт ${cache.facilityName.get(r.facilityId)} [id ${r.facilityId}]${r.replaced ? " — заміна видаленого аркуша" : ""} (${r.people} людей)`;
      }
    }
  }

  // Друк у порядку таблиць
  const out = [];
  for (const ssId of SPREADSHEETS) {
    const list = entries.filter((e) => e.ssId === ssId);
    if (!list.length) continue;
    out.push(`\n■ ${list[0].ssTitle}  (${ssId})`);
    for (const e of list) out.push(e.line);
  }
  for (const er of errors) out.push(`\n✗ ${er.ssId}: ${er.error}`);

  const cnt = (f) => entries.filter(f).length;
  out.push(
    `\nРазом: імпорт ${cnt((e) => e.action === "import")}, ` +
      `нових об'єктів ${cnt((e) => e.result && !e.result.hold && e.result.created)}, ` +
      `нових аркушів до існуючих об'єктів ${cnt((e) => e.result && !e.result.hold && !e.result.created)}, ` +
      `очікують ${cnt((e) => e.result && e.result.hold)}, ` +
      `пропущено ${cnt((e) => e.action === "skip")}`,
  );
  console.log(out.join("\n"));
  return entries;
}

if (require.main === module) {
  const job = process.argv.includes("--plan") ? planImport() : runImport();
  job
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runImport, planImport };
