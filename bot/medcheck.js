// bot/medcheck.js — ежедневная сверка: BHP из базы ↔ таблица медосмотров (Google Sheets)
//
// Каждый вечер (MED_CHECK_TIME, по умолчанию 22:00) в Telegram уходит сводка:
//   1) у кого BHP сегодня — кто уже есть в таблице медосмотров, кого нет;
//   2) кто добавлен в таблицу сегодня из тех, кого не было на прошлых сверках;
//   3) кого всё ещё нет (BHP в прошлые дни окна MED_CHECK_DAYS);
//   4) кого сняли с проверки (rezygnacja / BHP перенесли / период удалён из базы).
//
// Кто начал — берётся из worker_facility_history.bhp_date (то, что видит панель).
// Ищем сразу на нескольких листах (MED_SHEET_TAB через запятую). Колонки — по заголовкам:
//   паспорт/PESEL — любая колонка, где в заголовке «paszport», «passport» или «pesel»
//   («paszport», «Pesel», «Nr paszportu/ pesel»); фамилия — «nazwisko…»; имя — «imię»;
//   даты — «odbiór…», «data …» (для пометки «старая запись»).
// Сопоставление: паспорт (workers.login) или PESEL (workers.pesel) → если нет, по ФИО
// (без учёта порядка слов). Состояние «кого не было» — в med_check_missing (db/migration_medcheck.sql).
// Повторный запуск в тот же день идемпотентен.
//
// .env (рестарт pm2 после изменения):
//   MED_SHEET_ID=1AbC...               — ID таблицы «badania lekarskie» (из URL между /d/ и /edit)
//   MED_SHEET_TAB=Orzeczenia lekarskie,SAL MED,ID Konin
//                                      — листы через запятую (названия как на вкладках);
//                                        лист из другой таблицы: <ID таблицы>!<лист>
//   MED_CHECK_CHAT_ID=-100123,456      — куда слать (группа или люди, через запятую);
//                                        пусто → админам панели с привязанным Telegram
//   MED_CHECK_TIME=22:00
//   MED_CHECK_DAYS=14                  — сколько дней назад держать «хвосты»
//   MED_CHECK_FROM_DATE=2026-10-13     — BHP раньше этой даты не проверяем вообще (старт системы)
//   MED_CHECK_SKIP_STATUSES=rezygnacja — статусы периода, которые не проверяем
//   MED_CHECK_OLD_DAYS=180             — пометить «старая запись», если в таблице человек есть,
//                                        но самая свежая дата его строки старше BHP на N дней (0 = выкл)
//   MED_CHECK_SHOW_PASSPORT=1          — показывать паспорт у тех, кого нет (чтобы внести)
//   MED_CHECK_SHOW_PRESENT=1           — перечислять поимённо тех, кто есть (0 = только число)
//   MED_CHECK_MIN_ROWS=100             — если на всех листах вместе меньше строк — считаем, что чтение битое
//
// Если какой-то лист не прочитался — сводка всё равно уходит, но с предупреждением сверху,
// и состояние за этот день НЕ сохраняется (иначе завтра люди с того листа попали бы в «добавлены»).
//   MED_CHECK_ENABLED=1                — 0 = выключить
//
// Таблица должна быть открыта на чтение для сервисного аккаунта из google-key.json (client_email).

const path = require("path");
const db = require("../db");

const num = (v, d) => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : d;
};
const csv = (v) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const CFG = {
  enabled: String(process.env.MED_CHECK_ENABLED ?? "1").trim() !== "0",
  sheetId: String(process.env.MED_SHEET_ID || "").trim(),
  sheetTabs: csv(process.env.MED_SHEET_TAB || "Orzeczenia lekarskie"),
  time: String(process.env.MED_CHECK_TIME || "22:00").trim(),
  chatIds: csv(process.env.MED_CHECK_CHAT_ID),
  days: num(process.env.MED_CHECK_DAYS, 14),
  fromDate: ISO_RE.test(String(process.env.MED_CHECK_FROM_DATE || "").trim())
    ? String(process.env.MED_CHECK_FROM_DATE).trim()
    : null,
  skipStatuses: csv(process.env.MED_CHECK_SKIP_STATUSES ?? "rezygnacja"),
  skipFacilities: csv(process.env.MED_CHECK_SKIP_FACILITIES).map((s) => s.toLowerCase() + "%"),
  transferDays: num(process.env.MED_CHECK_TRANSFER_DAYS, 30),
  freshDays: num(process.env.MED_CHECK_FRESH_DAYS, 3),
  transferTag: String(process.env.MED_CHECK_TRANSFER_TAG || "").trim(),
  oldDays: num(process.env.MED_CHECK_OLD_DAYS, 180),
  showPassport: String(process.env.MED_CHECK_SHOW_PASSPORT ?? "1").trim() !== "0",
  showPresent: String(process.env.MED_CHECK_SHOW_PRESENT ?? "1").trim() !== "0",
  minRows: num(process.env.MED_CHECK_MIN_ROWS, 100),
  keyFile: process.env.GOOGLE_KEY_FILE || path.join(__dirname, "..", "google-key.json"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Даты (локальное время сервера = Варшава) ─────────────────
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseIso(s) {
  const [y, m, d] = String(s).substring(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso, n) {
  const d = parseIso(iso);
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}
function daysBetween(aIso, bIso) {
  return Math.round((parseIso(bIso) - parseIso(aIso)) / 86400000);
}
function ddmm(iso) {
  return `${iso.substring(8, 10)}.${iso.substring(5, 7)}`;
}
function ddmmyyyy(iso) {
  return `${iso.substring(8, 10)}.${iso.substring(5, 7)}.${iso.substring(0, 4)}`;
}
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Дата из ячейки таблицы: 08.10.2026, 8.10.26, 08/10/2026, 2026-10-08
function parseSheetDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return fmtYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (m) return fmtYmd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}
function fmtYmd(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Нормализация ключей ──────────────────────────────────────
// Кириллица, похожая на латиницу, часто попадает в номер паспорта.
const CYR2LAT = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P",
  С: "C", Т: "T", Х: "X", І: "I", Ї: "I", У: "Y",
};
// Ключи для паспорта / PESEL. Варианты: как в import_sheets.cleanPassport (кириллица выбрасывается)
// и с заменой похожих букв. PESEL (только цифры) дополняем нулём слева до 11 — Google Sheets
// и импорт теряют ведущий ноль (03212911316 → 3212911316).
function idKeys(raw) {
  const up = String(raw ?? "").toUpperCase();
  const stripped = up.replace(/[^A-Z0-9]/g, "");
  const mapped = up.replace(/./g, (ch) => CYR2LAT[ch] || ch).replace(/[^A-Z0-9]/g, "");
  const out = new Set();
  for (const k of [stripped, mapped]) {
    const dig = k.replace(/O/g, "0"); // PESEL, набранный с буквой O вместо нуля
    if (/^\d{9,11}$/.test(dig)) out.add(dig.padStart(11, "0"));
    else if (k.length >= 5) out.add(k);
  }
  return [...out];
}
const passportKeys = idKeys; // старое имя
// ФИО → набор слов без диакритики, отсортированный (порядок фамилия/имя не важен)
function nameKey(...parts) {
  const s = parts
    .join(" ")
    .replace(/[łŁ]/g, "L")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim();
  const words = s ? s.split(" ") : [];
  return words.length >= 2 ? words.sort().join(" ") : "";
}

// ── Google Sheets ────────────────────────────────────────────
let sheetsApi = null;
function getSheetsApi() {
  if (!sheetsApi) {
    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      keyFile: CFG.keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    sheetsApi = google.sheets({ version: "v4", auth });
  }
  return sheetsApi;
}

// MED_SHEET_TAB: «Лист» (в таблице MED_SHEET_ID) или «<ID таблицы>!Лист»
function tabSources() {
  return CFG.sheetTabs.map((t) => {
    const m = t.match(/^([A-Za-z0-9_-]{25,})!(.+)$/);
    return m ? { ssId: m[1], tab: m[2].trim() } : { ssId: CFG.sheetId, tab: t };
  });
}

async function fetchTab(ssId, tab) {
  if (!ssId) throw new Error("MED_SHEET_ID не задан в .env");
  const resp = await getSheetsApi().spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `'${tab.replace(/'/g, "''")}'!A:Z`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return resp.data.values || [];
}

// Все листы: [{ tab, rows }] или [{ tab, error }]
async function fetchAllTabs() {
  const out = [];
  for (const s of tabSources()) {
    try {
      out.push({ tab: s.tab, rows: await fetchTab(s.ssId, s.tab) });
    } catch (e) {
      out.push({ tab: s.tab, error: e.message });
    }
  }
  return out;
}

const hnorm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const isIdHeader = (x) => x.includes("paszport") || x.includes("passport") || x.includes("pesel");
const isSurname = (x) => x.startsWith("nazwisko");

// Один лист → в общий индекс. Возвращает число строк с данными; ошибка — throw.
function indexTab(idx, rows, tab) {
  let h = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const hr = (rows[i] || []).map(hnorm);
    if (hr.some(isIdHeader) || hr.some(isSurname)) {
      h = i;
      break;
    }
  }
  if (h < 0) throw new Error("нет строки заголовков (paszport / pesel / nazwisko)");

  const hdr = (rows[h] || []).map(hnorm);
  const all = (pred) => hdr.map((x, i) => (pred(x) ? i : -1)).filter((i) => i >= 0);
  const col = {
    ids: all(isIdHeader),
    surname: hdr.findIndex(isSurname),
    name: hdr.findIndex((x) => x === "imie" || x === "imię"),
    facility: hdr.findIndex((x) => x.startsWith("zakład") || x.startsWith("zaklad")),
    dates: all((x) => x.startsWith("data") || x.includes("odbiór") || x.includes("odbior")),
    reported: hdr.findIndex((x) => x.includes("zgłosz") || x.includes("zglosz")),
  };
  if (!col.ids.length && col.surname < 0) throw new Error("нет колонок paszport / pesel / nazwisko");

  const cell = (r, i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
  const push = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };

  let dataRows = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const ids = col.ids.map((c) => cell(r, c)).filter(Boolean);
    const sur = cell(r, col.surname);
    const nm = cell(r, col.name);
    if (!ids.length && !sur) continue;
    dataRows++;
    const dates = col.dates.map((c) => parseSheetDate(cell(r, c))).filter(Boolean);
    const newest = dates.length ? dates.sort().pop() : null;
    const entry = {
      tab,
      row: i + 1,
      id: ids[0] || "",
      facility: cell(r, col.facility),
      date: newest,
      // дата заявки: «data zgłoszenia przez koordyntora»; пустая или такой колонки нет — другие даты строки
      fresh: (col.reported >= 0 && parseSheetDate(cell(r, col.reported))) || newest,
    };
    for (const v of ids) for (const k of idKeys(v)) push(idx.byId, k, entry);
    const nk = nameKey(sur, nm);
    if (nk) push(idx.byName, nk, entry);
  }
  return dataRows;
}

// Индекс по всем листам: ID (паспорт/PESEL) → строки, ФИО → строки.
// input: [{ tab, rows } | { tab, error }] или просто rows одного листа (для тестов).
function buildSheetIndex(input) {
  const tabs = Array.isArray(input?.[0]) || !input?.length
    ? [{ tab: CFG.sheetTabs[0] || "лист", rows: input || [] }]
    : input;
  const idx = { byId: new Map(), byName: new Map(), dataRows: 0, tabs: [], errors: [] };
  for (const t of tabs) {
    if (t.error) {
      idx.errors.push({ tab: t.tab, error: t.error });
      continue;
    }
    try {
      const n = indexTab(idx, t.rows || [], t.tab);
      idx.tabs.push({ tab: t.tab, rows: n });
      idx.dataRows += n;
    } catch (e) {
      idx.errors.push({ tab: t.tab, error: e.message });
    }
  }
  if (!idx.tabs.length) {
    throw new Error(idx.errors.map((e) => `«${e.tab}»: ${e.error}`).join("; ") || "листы не заданы");
  }
  return idx;
}

// Ищем работника в таблице. null — нет ни на одном листе.
function matchWorker(idx, w) {
  let how = null;
  let hits = [];
  for (const k of [...idKeys(w.login), ...idKeys(w.pesel)]) hits.push(...(idx.byId.get(k) || []));
  if (hits.length) how = "id";
  else {
    const nk = nameKey(w.full_name);
    if (nk && idx.byName.has(nk)) {
      hits = idx.byName.get(nk);
      how = "name";
    }
  }
  if (!hits.length) return null;

  const uniq = [...new Map(hits.map((e) => [`${e.tab}|${e.row}`, e])).values()];
  // «Старая запись»: у всех найденных строк есть дата, и самая свежая старше BHP на oldDays
  let old = null;
  if (CFG.oldDays > 0 && uniq.every((e) => e.date)) {
    const newest = uniq.map((e) => e.date).sort().pop();
    if (daysBetween(newest, w.bhp) > CFG.oldDays) old = newest;
  }
  // Показываем самую свежую строку (по дате, иначе последнюю)
  const best = [...uniq].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || b.row - a.row)[0];
  const freshest = uniq.map((e) => e.fresh).filter(Boolean).sort().pop() || null;
  return { how, tab: best.tab, row: best.row, sheetId: best.id, old, freshest };
}

// ── База ─────────────────────────────────────────────────────
async function loadCandidates(fromIso, toIso) {
  const r = await db.query(
    `
    SELECT h.worker_id,
           to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp,
           h.status::text AS status,
           w.full_name, w.login, w.pesel,
           h.facility_id, f.name AS facility_name,
           (SELECT string_agg(DISTINCT c.full_name, ', ')
              FROM coordinator_facilities cf
              JOIN coordinators c ON c.id = cf.coordinator_id
             WHERE cf.facility_id = h.facility_id AND c.is_active = true) AS coordinators
    FROM worker_facility_history h
    JOIN workers w    ON w.id = h.worker_id
    JOIN facilities f ON f.id = h.facility_id
    WHERE h.bhp_date BETWEEN $1::date AND $2::date
      AND NOT (h.status::text = ANY($3::text[]))
      AND NOT (lower(f.name) LIKE ANY ($4::text[]))
      AND w.login NOT LIKE 'TEST_%'
    ORDER BY h.bhp_date, f.name, w.full_name
    `,
    [fromIso, toIso, CFG.skipStatuses, CFG.skipFacilities],
  );
  // Один человек + одна дата BHP = одна запись (если периодов несколько — объекты через запятую)
  const map = new Map();
  for (const x of r.rows) {
    const key = `${x.worker_id}|${x.bhp}`;
    const prev = map.get(key);
    if (!prev) map.set(key, { ...x, key });
    else if (!prev.facility_name.split(", ").includes(x.facility_name)) {
      prev.facility_name += `, ${x.facility_name}`;
      if (x.coordinators && !String(prev.coordinators || "").includes(x.coordinators)) {
        prev.coordinators = [prev.coordinators, x.coordinators].filter(Boolean).join(", ");
      }
    }
  }
  return [...map.values()];
}

// Отслеживаемые: ещё открытые + закрытые сегодня (чтобы повторный запуск дал тот же отчёт)
async function loadTracked(todayIso) {
  const r = await db.query(
    `
    SELECT m.worker_id,
           to_char(m.bhp_date, 'YYYY-MM-DD')    AS bhp,
           to_char(m.first_seen, 'YYYY-MM-DD')  AS first_seen,
           to_char(m.resolved_on, 'YYYY-MM-DD') AS resolved_on,
           m.resolved_how,
           w.full_name, w.login,
           f.name AS facility_name
    FROM med_check_missing m
    LEFT JOIN workers w    ON w.id = m.worker_id
    LEFT JOIN facilities f ON f.id = m.facility_id
    WHERE m.resolved_on IS NULL OR m.resolved_on = $1::date
    `,
    [todayIso],
  );
  return r.rows.map((x) => ({ ...x, key: `${x.worker_id}|${x.bhp}` }));
}

async function saveState(todayIso, missing, resolutions) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    if (missing.length) {
      await client.query(
        `
        INSERT INTO med_check_missing (worker_id, bhp_date, facility_id, first_seen, last_seen)
        SELECT t.worker_id, t.bhp_date, t.facility_id, $4::date, $4::date
        FROM unnest($1::int[], $2::date[], $3::int[]) AS t(worker_id, bhp_date, facility_id)
        ON CONFLICT (worker_id, bhp_date) DO UPDATE
          SET last_seen    = GREATEST(med_check_missing.last_seen, EXCLUDED.last_seen),
              facility_id  = EXCLUDED.facility_id,
              resolved_on  = NULL,
              resolved_how = NULL
        `,
        [
          missing.map((x) => x.worker_id),
          missing.map((x) => x.bhp),
          missing.map((x) => x.facility_id),
          todayIso,
        ],
      );
    }
    if (resolutions.length) {
      await client.query(
        `
        UPDATE med_check_missing m
           SET resolved_on = $4::date, resolved_how = t.how
          FROM unnest($1::int[], $2::date[], $3::text[]) AS t(worker_id, bhp_date, how)
         WHERE m.worker_id = t.worker_id AND m.bhp_date = t.bhp_date
           AND (m.resolved_on IS NULL OR m.resolved_on = $4::date)
        `,
        [
          resolutions.map((x) => x.worker_id),
          resolutions.map((x) => x.bhp),
          resolutions.map((x) => x.how),
          todayIso,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { });
    throw e;
  } finally {
    client.release();
  }
}
// ── Переводы с другого объекта ───────────────────────────────
// Перевод = у человека есть период на ДРУГОМ объекте, который начался раньше нового BHP,
// не rezygnacja и закончился не раньше чем за MED_CHECK_TRANSFER_DAYS до нового BHP (или ещё открыт).
// Тот же BHP на другом объекте — это перенос строки между листами, не перевод.
async function markTransfers(cands) {
  if (!cands.length || CFG.transferDays <= 0) return;
  const r = await db.query(
    `
    SELECT DISTINCT ON (t.worker_id, t.bhp)
           t.worker_id, to_char(t.bhp, 'YYYY-MM-DD') AS bhp,
           f.name AS from_facility, o.status::text AS from_status,
                      to_char(o.last_work_date, 'YYYY-MM-DD') AS from_last,
           to_char(o.bhp_date, 'YYYY-MM-DD') AS from_bhp
    FROM unnest($1::int[], $2::date[], $3::text[]) AS t(worker_id, bhp, facs)
    JOIN worker_facility_history o ON o.worker_id = t.worker_id
    JOIN facilities f ON f.id = o.facility_id
    WHERE NOT (f.name = ANY (string_to_array(t.facs, ', ')))
      AND o.bhp_date < t.bhp
      AND o.status::text <> 'rezygnacja'
      AND (o.last_work_date IS NULL OR o.last_work_date >= t.bhp - $4::int)
    ORDER BY t.worker_id, t.bhp, o.last_work_date DESC NULLS FIRST, o.bhp_date DESC
    `,
    [cands.map((c) => c.worker_id), cands.map((c) => c.bhp), cands.map((c) => c.facility_name), CFG.transferDays],
  );
  const m = new Map(r.rows.map((x) => [`${x.worker_id}|${x.bhp}`, x]));
  for (const c of cands) {
    const t = m.get(c.key);
       if (t) c.transfer = { from: t.from_facility, bhp: t.from_bhp, status: t.from_status, last: t.from_last };
  }
}

// Каждый перевод показываем один раз — в первый вечер, когда он попал в окно.
// Повторный запуск в тот же день показывает тот же список.
async function trackTransfers(todayIso, transfers, save) {
  if (!transfers.length) return [];
  const r = await db.query(
    `SELECT m.worker_id, to_char(m.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(m.first_seen, 'YYYY-MM-DD') AS first_seen
       FROM med_check_transfer m
       JOIN unnest($1::int[], $2::date[]) AS t(worker_id, bhp)
         ON t.worker_id = m.worker_id AND t.bhp = m.bhp_date`,
    [transfers.map((c) => c.worker_id), transfers.map((c) => c.bhp)],
  );
  const seen = new Map(r.rows.map((x) => [`${x.worker_id}|${x.bhp}`, x.first_seen]));
  const show = transfers.filter((c) => !seen.has(c.key) || seen.get(c.key) === todayIso);
  const fresh = show.filter((c) => !seen.has(c.key));
  if (save && fresh.length) {
    await db.query(
      `INSERT INTO med_check_transfer (worker_id, bhp_date, first_seen)
       SELECT t.worker_id, t.bhp, $3::date FROM unnest($1::int[], $2::date[]) AS t(worker_id, bhp)
       ON CONFLICT DO NOTHING`,
      [fresh.map((c) => c.worker_id), fresh.map((c) => c.bhp), todayIso],
    );
  }
  return show.sort((a, b) => a.bhp.localeCompare(b.bhp) || a.facility_name.localeCompare(b.facility_name));
}

// «Есть в таблице» = есть строка, и дата заявки (data zgłoszenia) не раньше чем за MED_CHECK_FRESH_DAYS до BHP
function formatTransfers(r) {
  if (!r.transfers.length) return [];
  const isFresh = (c) => !!(c.match && c.match.freshest && c.match.freshest >= addDays(c.bhp, -CFG.freshDays));
  const yes = r.transfers.filter(isFresh);
  const no = r.transfers.filter((c) => !isFresh(c));
  const route = (c) =>
    `${bold(c.transfer.from)}${c.transfer.bhp ? ` (BHP ${ddmmyyyy(c.transfer.bhp)})` : ""}` +
    ` → ${bold(c.facility_name)} (BHP ${ddmmyyyy(c.bhp)})`;
  const L = [
    "",
    `🔁 <b>Переведены с другого объекта (${r.transfers.length})</b> — проверить, нужен ли он вообще` +
      (CFG.transferTag ? ` · ${escHtml(CFG.transferTag)}` : ""),
  ];
  if (yes.length) {
    L.push(`✅ <b>Есть в таблице (${yes.length})</b>`);
    for (const c of yes) {
      L.push(
        `• ${bold(c.full_name)} — ${route(c)} · zgłoszenie ${ddmmyyyy(c.match.freshest)}${tabTag(c.match)}` +
          (c.match.how === "name" ? " ⚠️ по ФИО" : ""),
      );
    }
  }
  if (no.length) {
    L.push(`❌ <b>Нет в таблице (${no.length})</b>`);
    for (const c of no) {
      const note = !c.match
        ? ""
        : c.match.freshest
          ? ` <i>(в таблице только старая запись ${ddmmyyyy(c.match.freshest)})</i>`
          : " <i>(в таблице есть, но без даты)</i>";
      L.push(`• ${bold(c.full_name)}${passTag(c)} — ${route(c)}${note}`);
    }
  }
  return L;
}
// ── Сверка ───────────────────────────────────────────────────
// opts.date  — дата сверки (YYYY-MM-DD), по умолчанию сегодня
// opts.dryRun — ничего не записывать в med_check_missing
// opts.rows  — готовые строки таблицы (для тестов), иначе читаем Google Sheets
async function runCheck(opts = {}) {
  const today = opts.date && ISO_RE.test(opts.date) ? opts.date : isoLocal(new Date());
  let winStart = addDays(today, -CFG.days);
  if (CFG.fromDate && CFG.fromDate > winStart) winStart = CFG.fromDate;

  const input = opts.tabs || opts.rows || (await fetchAllTabs());
  const idx = buildSheetIndex(input);
  if (idx.dataRows < CFG.minRows) {
    throw new Error(
      `на листах всего ${idx.dataRows} строк (минимум ${CFG.minRows}) — похоже, чтение битое, сверку пропускаю`,
    );
  }
  // Не все листы прочитаны → отчёт неполный, состояние не сохраняем
  const partial = idx.errors.length > 0;

  const all = winStart <= today ? await loadCandidates(winStart, today) : [];
  for (const c of all) c.match = matchWorker(idx, c);
  await markTransfers(all);
  // Переведённые — отдельным разделом на проверку, в ❌ / хвосты не попадают
  const transfersAll = all.filter((c) => c.transfer);
  const transferKeys = new Set(transfersAll.map((c) => c.key));
  const candidates = all.filter((c) => !c.transfer);
  const candByKey = new Map(candidates.map((c) => [c.key, c]));

  const missingAll = candidates.filter((c) => !c.match);
  const missingKeys = new Set(missingAll.map((c) => c.key));

  // Что стало с теми, кого не было раньше
  const tracked = await loadTracked(today);
  const resolutions = [];
  const added = [];
  const gone = [];
  let expired = 0;
  for (const t of tracked) {
    if (missingKeys.has(t.key)) continue; // всё ещё нет — останется открытым
    if (transferKeys.has(t.key)) {
      // оказался переводом — дальше только в разделе 🔁
      resolutions.push({ worker_id: t.worker_id, bhp: t.bhp, how: "gone" });
      continue;
    }
    const c = candByKey.get(t.key);
    const how = c ? "sheet" : t.bhp < winStart ? "expired" : "gone";
    resolutions.push({ worker_id: t.worker_id, bhp: t.bhp, how });
    if (how === "sheet" && t.first_seen < today) added.push({ ...c, first_seen: t.first_seen });
    else if (how === "gone") gone.push(t);
    else if (how === "expired") expired++;
  }

  const save = !opts.dryRun && !partial;
  if (save) await saveState(today, missingAll, resolutions);
  const transfers = await trackTransfers(today, transfersAll, save);

  const todayList = candidates.filter((c) => c.bhp === today);
  const res = {
    date: today,
    window: { from: winStart, to: today },
    sheet: { rows: idx.dataRows, tabs: idx.tabs, errors: idx.errors },
    partial,
    today: todayList,
    todayPresent: todayList.filter((c) => c.match),
    todayMissing: todayList.filter((c) => !c.match),
    backlog: missingAll.filter((c) => c.bhp < today),
    added,
    gone,
    expired,
    transfers,
    dryRun: !!opts.dryRun,
  };
  res.counts = {
    today: res.today.length,
    todayPresent: res.todayPresent.length,
    todayMissing: res.todayMissing.length,
    flagged: res.todayPresent.filter((c) => c.match.how === "name" || c.match.old).length,
    backlog: res.backlog.length,
    added: added.length,
    gone: gone.length,
    expired,
    transfers: transfers.length,
  };
  res.text = formatReport(res);
  return res;
}

// ── Текст отчёта (HTML) ──────────────────────────────────────
function groupByFacility(list) {
  const m = new Map();
  for (const x of list) {
    if (!m.has(x.facility_name)) m.set(x.facility_name, { coords: x.coordinators, items: [] });
    m.get(x.facility_name).items.push(x);
  }
  return m;
}
const statusTag = (c) => (c.status && c.status !== "pracuje" ? ` <i>(${escHtml(c.status)})</i>` : "");
const bold = (s) => `<b>${escHtml(s)}</b>`;
const passTag = (c) => (CFG.showPassport && c.login ? ` · <code>${escHtml(c.login)}</code>` : "");
const plural = (n) => `${n} дн.`;
// Лист, где нашли, — если это не первый (основной) лист
const tabTag = (m) => (m && m.tab && m.tab !== CFG.sheetTabs[0] ? ` · <i>${escHtml(m.tab)}</i>` : "");
const fmtNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

function formatReport(r) {
  const d = parseIso(r.date);
  const L = [];
  L.push(`🩺 <b>Медосмотры · ${ddmmyyyy(r.date)} (${WD[d.getDay()]})</b>`);
  L.push("");
  if (r.partial) {
    for (const e of r.sheet.errors) L.push(`⚠️ Лист «${escHtml(e.tab)}» не прочитан: ${escHtml(e.error)}`);
    L.push("⚠️ Сверка неполная: кто есть только на этом листе — показан как «нет». Состояние за сегодня не сохранено.");
    L.push("");
  }
  if (r.counts.today) {
    L.push(
      `BHP сегодня: <b>${r.counts.today}</b> — ✅ ${r.counts.todayPresent}` +
        (r.counts.flagged ? ` (⚠️ проверить ${r.counts.flagged})` : "") +
        ` · ❌ ${r.counts.todayMissing}`,
    );
  } else {
    L.push("BHP сегодня: никого.");
  }
  if (r.counts.added) L.push(`🟢 Добавлены сегодня: <b>${r.counts.added}</b>`);
  if (r.counts.backlog) L.push(`🔴 С прошлых дней всё ещё нет: <b>${r.counts.backlog}</b>`);
  if (r.counts.transfers) L.push(`🔁 Переведены с другого объекта: <b>${r.counts.transfers}</b> — на проверку`);

  if (r.todayMissing.length) {
    L.push("");
    L.push(`❌ <b>BHP сегодня — нет в таблице (${r.todayMissing.length})</b>`);
    for (const [fac, g] of groupByFacility(r.todayMissing)) {
      L.push(`🏭 <b>${escHtml(fac)}</b>${g.coords ? ` — ${escHtml(g.coords)}` : ""}`);
      for (const c of g.items) L.push(`• ${bold(c.full_name)}${passTag(c)}${statusTag(c)}`);
    }
  }

  if (r.todayPresent.length) {
    L.push("");
    if (CFG.showPresent) {
      L.push(`✅ <b>BHP сегодня — есть в таблице (${r.todayPresent.length})</b>`);
      for (const c of r.todayPresent) {
        const flags = [];
        if (c.match.how === "name") {
          flags.push(
            CFG.showPassport
              ? `⚠️ найден по ФИО, в таблице <code>${escHtml(c.match.sheetId || "—")}</code>`
              : "⚠️ найден по ФИО, паспорт/PESEL не совпал",
          );
        }
        if (c.match.old) flags.push(`⚠️ старая запись (${ddmmyyyy(c.match.old)})`);
        L.push(
          `• ${bold(c.full_name)} — ${bold(c.facility_name)}${tabTag(c.match)}${statusTag(c)}` +
            (flags.length ? ` ${flags.join(", ")}` : ""),
        );
      }
    } else {
      const flagged = r.todayPresent.filter((c) => c.match.how === "name" || c.match.old);
      if (flagged.length) {
        L.push(`⚠️ <b>Есть в таблице, но проверить (${flagged.length})</b>`);
        for (const c of flagged) {
          const why = c.match.how === "name" ? "по ФИО, паспорт/PESEL не совпал" : `старая запись (${ddmmyyyy(c.match.old)})`;
          L.push(`• ${bold(c.full_name)} — ${bold(c.facility_name)}: ${why}`);
        }
      }
    }
  }

  L.push(...formatTransfers(r));

  if (r.added.length) {
    L.push("");
    L.push(`🟢 <b>Добавлены в таблицу сегодня (${r.added.length})</b>`);
    for (const c of r.added) {
      L.push(
        `• ${bold(c.full_name)} — ${bold(c.facility_name)} · BHP ${ddmm(c.bhp)}, внесён через ${plural(daysBetween(c.bhp, r.date))}${tabTag(c.match)}`,
      );
    }
  }

  if (r.backlog.length) {
    L.push("");
    L.push(`🔴 <b>Всё ещё нет в таблице — BHP в прошлые дни (${r.backlog.length})</b>`);
    const sorted = [...r.backlog].sort((a, b) => (a.bhp < b.bhp ? -1 : a.bhp > b.bhp ? 1 : 0));
    for (const [fac, g] of groupByFacility(sorted)) {
      L.push(`🏭 <b>${escHtml(fac)}</b>${g.coords ? ` — ${escHtml(g.coords)}` : ""}`);
      for (const c of g.items) {
        L.push(
          `• ${bold(c.full_name)}${passTag(c)} — BHP ${ddmm(c.bhp)} (${plural(daysBetween(c.bhp, r.date))})${statusTag(c)}`,
        );
      }
    }
  }

  if (r.gone.length) {
    L.push("");
    L.push(`➖ <b>Сняты с проверки (${r.gone.length})</b> — rezygnacja, BHP перенесли или период удалён из базы`);
    for (const t of r.gone) {
      L.push(`• ${bold(t.full_name || `#${t.worker_id}`)}${t.facility_name ? ` — ${bold(t.facility_name)}` : ""} · BHP ${ddmm(t.bhp)}`);
    }
  }

  if (!r.counts.today && !r.counts.backlog && !r.counts.added && !r.counts.gone && !r.counts.transfers) {
    L.push("Хвостов нет ✅");
  }
  if (r.sheet.tabs.length > 1 || r.partial) {
    L.push("");
    L.push(`<i>Листы: ${r.sheet.tabs.map((t) => `${escHtml(t.tab)} ${fmtNum(t.rows)}`).join(" · ")}</i>`);
  }
  if (r.dryRun) {
    L.push("");
    L.push("<i>тестовый прогон — состояние не сохранено</i>");
  }
  return L.join("\n");
}

// ── Telegram ─────────────────────────────────────────────────
async function tgSend(bot, chatId, text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML", disable_web_page_preview: true });
      return true;
    } catch (e) {
      const retry = e?.response?.parameters?.retry_after;
      if (e?.response?.error_code === 429 && retry) {
        await sleep((retry + 1) * 1000);
        continue;
      }
      console.error(`[MedCheck] send to ${chatId}:`, e.message);
      return false;
    }
  }
  return false;
}

async function sendLongHtml(bot, chatId, text) {
  const LIMIT = 4000;
  const chunks = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if (chunk && (chunk + "\n" + line).length > LIMIT) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) chunks.push(chunk);
  let ok = true;
  for (const c of chunks) {
    ok = (await tgSend(bot, chatId, c)) && ok;
    await sleep(300);
  }
  return ok;
}

async function recipients() {
  if (CFG.chatIds.length) return CFG.chatIds;
  const r = await db.query(
    `SELECT DISTINCT c.telegram_chat_id
       FROM coordinator_auth ca
       JOIN coordinators c ON c.id = ca.coordinator_id
      WHERE ca.is_admin AND c.is_active AND c.telegram_chat_id IS NOT NULL`,
  );
  return r.rows.map((x) => String(x.telegram_chat_id));
}

let running = false;
async function sendReport(bot, opts = {}) {
  if (running) return { skipped: "already running" };
  running = true;
  try {
    const chats = await recipients();
    if (!chats.length) {
      console.warn("[MedCheck] получателей нет: задайте MED_CHECK_CHAT_ID в .env");
    }
    let r;
    try {
      r = await runCheck(opts);
    } catch (e) {
      console.error("[MedCheck] check error:", e.message);
      const today = opts.date && ISO_RE.test(opts.date) ? opts.date : isoLocal(new Date());
      const msg = `⚠️ <b>Медосмотры · ${ddmmyyyy(today)}</b>\nСверка не сделана: ${escHtml(e.message)}`;
      for (const chat of chats) await sendLongHtml(bot, chat, msg);
      return { error: e.message };
    }
    let delivered = 0;
    for (const chat of chats) if (await sendLongHtml(bot, chat, r.text)) delivered++;
    console.log(`[MedCheck] ${r.date}: ${JSON.stringify(r.counts)}, отправлено в ${delivered}/${chats.length} чатов`);
    return { date: r.date, counts: r.counts, delivered, recipients: chats.length };
  } finally {
    running = false;
  }
}

// ── Планировщик: раз в день в MED_CHECK_TIME ─────────────────
function schedule(bot) {
  if (!CFG.enabled) {
    console.log("[MedCheck] выключено (MED_CHECK_ENABLED=0)");
    return;
  }
  let lastRunDay = null;
  setInterval(async () => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const day = isoLocal(now);
    if (hm !== CFG.time || lastRunDay === day) return;
    lastRunDay = day;
    try {
      await sendReport(bot);
    } catch (e) {
      console.error("[MedCheck] schedule error:", e.message);
    }
  }, 30 * 1000);
}

module.exports = {
  CFG,
  runCheck,
  sendReport,
  schedule,
  // для тестов
  buildSheetIndex,
  matchWorker,
  passportKeys,
  idKeys,
  nameKey,
  parseSheetDate,
};
