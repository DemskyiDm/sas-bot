require("dotenv").config();
const { https } = require("follow-redirects");
const db = require("./db");

// ── CONFIG ────────────────────────────────────────────────────
// Add your spreadsheets here:
// { ssId: 'Google Sheets ID', sheetName: 'Sheet tab name', facilityName: 'Name in DB' }

const SOURCES = [
  {
    ssId: "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4",
    gid: "1892808234",
    facilityName: "Ceva Nowy Świat APT",
  },
  {
    ssId: "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4",
    gid: "1609709378",
    facilityName: "Ceva Nowy Świat Well",
  },
  {
    ssId: "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4",
    gid: "1752399154",
    facilityName: "CEVA ŚWIEBODZIN APT",
  },
  {
    ssId: "1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c",
    gid: "1672298586",
    facilityName: "ID Psary APT",
  },
  {
    ssId: "1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c",
    gid: "0",
    facilityName: "ID Psary SAS",
  },
  {
    ssId: "1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c",
    gid: "1438986598",
    facilityName: "ID Psary WELL",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "1158031380",
    facilityName: "METLER Dipico",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "0",
    facilityName: "G&G APT",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "157070482",
    facilityName: "G&G Well",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "1672298586",
    facilityName: "Blachy Pruszyński APT",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "1302818157",
    facilityName: "Gerda Sokołów APT",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "481903758",
    facilityName: "Oldar Agencja Work",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "255214619",
    facilityName: "Aleksandra Dębska Oldar WP",
  },
  {
    ssId: "1xgOv39j82OHsGvhR53Y_IuYEN-S9KrIcLsDXvFN4fVA",
    gid: "1892808234",
    facilityName: "Ceva Krężoły APT",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "1609709378",
    facilityName: "Action Wypędy SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "2128388755",
    facilityName: "Action Zamienie SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "1653950425",
    facilityName: "Action Zamienie Przejęcie SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "2048237816",
    facilityName: "Action Production SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "852139785",
    facilityName: "ILS UZ",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "734840239",
    facilityName: "Inter Cars SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "1407856830",
    facilityName: "PolMlek SAS",
  },
  {
    ssId: "1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU",
    gid: "1657737296",
    facilityName: "Trans-Tok APT",
  },
  {
    ssId: "1K3AJ5BQIZ8k8Icug_pmGfRrA2_-VscV9HhO24vxQvz4",
    gid: "1910428329",
    facilityName: "Ligentia APT",
  },
  {
    ssId: "1K3AJ5BQIZ8k8Icug_pmGfRrA2_-VscV9HhO24vxQvz4",
    gid: "733408232",
    facilityName: "Ligentia Well",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "1324296168",
    facilityName: "Anpacars Sosnowiec SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "738760745",
    facilityName: "ANPACARS BĘDZIN SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "698091925",
    facilityName: "MIESZKO Services SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "366286180",
    facilityName: "Mieszko SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "1462112214",
    facilityName: "Mieszko APT",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "842318862",
    facilityName: "MIESZKO SERVICES APT",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "0",
    facilityName: "SGB JAROSZOWIEC SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "527726318",
    facilityName: "EkoOkna SAS",
  },
  {
    ssId: "193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4",
    gid: "377920864",
    facilityName: "EkoOkna Well",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "630359828",
    facilityName: "Fiege Goleniów Well",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "409362818",
    facilityName: "Rhenus Gol WELL",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "1302818157",
    facilityName: "CEVA APT",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "1407856830",
    facilityName: "CEVA Dipico",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "881937903",
    facilityName: "HULTAFORS WELL",
  },
  {
    ssId: "1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw",
    gid: "972884639",
    facilityName: "Lucky Union APT",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "0",
    facilityName: "Id Log Rokitno SAS",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "1672298586",
    facilityName: "Id Log Rokitno APT",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "1407856830",
    facilityName: "Id Log Rokitno Well",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "1163529905",
    facilityName: "CAINIAO APT",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "2027894673",
    facilityName: "CAINIAO APT 2",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "1302818157",
    facilityName: "CAINIAO Dipico",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "2005234934",
    facilityName: "CAINIAO Dipico 2",
  },
  {
    ssId: "1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM",
    gid: "618124367",
    facilityName: "Saint-Gobain SAS",
  },
  {
    ssId: "1yYaSyo96Z96H8CGHkVWvKglTFim-nC489vK2gxV-3T8",
    gid: "1228811347",
    facilityName: "Fiege ZG Well",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "159117149",
    facilityName: "IGP Operations PL APT",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "1871902412",
    facilityName: "IGP Operations PL SAS",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "996353161",
    facilityName: "Fiege NDM Well",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "1887777352",
    facilityName: "Gerda Starachowice APT",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "1247873024",
    facilityName: "Versal APT",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "2037649012",
    facilityName: "MAROPAK SAS",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "658536579",
    facilityName: "Wsip Dipico",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "1017133597",
    facilityName: "Domel SAS",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "938923789",
    facilityName: "ATS Display APT",
  },
  {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "1114876791",
    facilityName: "SGB Pruszków SAS",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "0",
    facilityName: "Id Logistics Wro SAS",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "1672298586",
    facilityName: "Id Logistics Wro APT",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "1407856830",
    facilityName: "Id Logistics Wro Well",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "1692725338",
    facilityName: "Id Logistics Tyniec APT",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "1609709378",
    facilityName: "DSV Dipico",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "2077894048",
    facilityName: "Fiege Logistics Stanowice Well",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "0",
    facilityName: "Hydro Łódź",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1672298586",
    facilityName: "Hydro Łódź Well",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "138437422",
    facilityName: "Klimor APT",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1407856830",
    facilityName: "Hydro Trzcianka",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1302818157",
    facilityName: "Hydro Trzcianka Well",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1609709378",
    facilityName: "DPD Lućmierz SAS",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1477908858",
    facilityName: "Notino Well",
  },
];
// ── FETCH CSV ─────────────────────────────────────────────────
function fetchCsv(ssId, gid) {
  return new Promise((resolve, reject) => {
    const url =
      gid !== undefined && gid !== ""
        ? `https://docs.google.com/spreadsheets/d/${ssId}/export?format=csv&gid=${gid}`
        : `https://docs.google.com/spreadsheets/d/${ssId}/export?format=csv`;

    console.log("  Fetching:", url);

    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept-Language": "en-US,en;q=0.9",
          },
          maxRedirects: 15,
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
          res.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

// ── PARSE CSV ─────────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let cells = [];
  let cell = "";
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuote && next === '"') {
        // Escaped quote ""
        cell += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cells.push(cell.trim());
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuote) {
      // End of row
      if (ch === "\r" && next === "\n") i++; // skip \r\n
      cells.push(cell.trim());
      if (cells.some((c) => c !== "")) rows.push(cells);
      cells = [];
      cell = "";
    } else {
      // Внутри кавычек заменяем переносы строк на пробел
      if ((ch === "\n" || ch === "\r") && inQuote) {
        cell += " ";
        if (ch === "\r" && next === "\n") i++;
      } else {
        cell += ch;
      }
    }
  }

  // Last row
  if (cell || cells.length) {
    cells.push(cell.trim());
    if (cells.some((c) => c !== "")) rows.push(cells);
  }

  return rows;
}

// ── PARSE DATE DD.MM.YYYY ─────────────────────────────────────
/*function parseDate(str) {
  if (!str || str === "---" || str === "----" || str === "?" || str === "")
    return null;
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}*/

function parseDate(str) {
  if (!str || str === "---" || str === "----" || str === "?" || str === "")
    return null;
  const m = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;

  let day = parseInt(m[1], 10);
  let month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);

  // Исправляем невалидные значения
  if (month < 1 || month > 12) month = 12;
  if (day < 1 || day > 31) day = 31;

  // Проверяем что дата реально существует
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime()) || date.getMonth() !== month - 1) {
    // Дата не существует (напр. 31.02) — ставим последний день месяца
    day = new Date(year, month, 0).getDate();
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
}

// ── CLEAN PASSPORT ────────────────────────────────────────────
function cleanPassport(str) {
  return String(str || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

// ── IMPORT ONE SOURCE ─────────────────────────────────────────
async function importSource(source) {
  console.log(`\nImporting: ${source.facilityName}`);

  // Find or create facility
  let facRes = await db.query(
    `SELECT id FROM facilities WHERE LOWER(name) = LOWER($1)`,
    [source.facilityName]
  );
  let facilityId;
  if (facRes.rows.length) {
    facilityId = facRes.rows[0].id;
    console.log(`  Facility found: id=${facilityId}`);
  } else {
    const ins = await db.query(
      `INSERT INTO facilities (name, group_name) VALUES ($1, $1) RETURNING id`,
      [source.facilityName]
    );
    facilityId = ins.rows[0].id;
    console.log(`  Facility created: id=${facilityId}`);
  }

  // Fetch CSV
  let csvText;
  try {
    csvText = await fetchCsv(source.ssId, source.gid);
  } catch (e) {
    console.error(`  ERROR fetching CSV: ${e.message}`);
    return;
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    console.log("  No data rows found");
    return;
  }

  // Find header row (row with 'Nr paszportu' or 'Nazwisko')
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    if (
      row.some(
        (c) =>
          c.toLowerCase().includes("paszportu") ||
          c.toLowerCase().includes("nazwisko")
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const headers = rows[headerIdx].map((h) => h.toLowerCase().trim());

  // Column indices by name
  let iPassport = headers.findIndex(
    (h) => h.includes("paszportu") || h.includes("passport")
  );
  let iNazwisko = headers.findIndex((h) => h === "nazwisko");
  let iImie = headers.findIndex((h) => h === "imię" || h === "imie");
  let iStatus = headers.findIndex((h) => h === "status");
  let iBhp = headers.findIndex(
    (h) =>
      h.includes("bhp") ||
      h.includes("rozpoczęcie") ||
      h.includes("rozpoczecie")
  );
  let iLastDay = headers.findIndex(
    (h) => h.includes("ostatni roboczy") || h.includes("ostatni rob")
  );

  // Fallback — стандартная структура если заголовки не найдены
  // A=0 B=1 C=2 D=3 E=4 F=5 G=6 H=7 I=8 J=9 K=10 L=11 M=12
  if (iPassport === -1 && iNazwisko === -1) {
    console.warn("  Headers not found — using default column positions");
    iPassport = 1; // B — Nr paszportu
    iNazwisko = 3; // D — Nazwisko
    iImie = 4; // E — Imię
    iStatus = 7; // H — Status
    iBhp = 10; // K — rozpoczęcie pracy
    iLastDay = 12; // M — Ostatni roboczy dzień
    headerIdx = 0; // данные с первой строки
  }

  // Limit columns to AA (column 26)
  const MAX_COL = 26;

  console.log(
    `  Header row: ${headerIdx}, columns: passport=${iPassport} nazwisko=${iNazwisko} imie=${iImie} status=${iStatus} bhp=${iBhp}`
  );

  if (iPassport === -1 || iNazwisko === -1) {
    console.error(
      "  ERROR: Cannot find required columns (Nr paszportu, Nazwisko)"
    );
    return;
  }

  let added = 0,
    updated = 0,
    skipped = 0;

  // Сначала собираем все записи по паспорту — берём последнюю
  const workerMap = {};

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i].slice(0, MAX_COL);
    if (row.every((cell) => !cell || !cell.trim())) continue;

    const passport = cleanPassport(row[iPassport]);
    if (!passport || passport.length < 3) {
      console.warn(`  SKIP row ${i}: empty/short passport "${passport}"`);
      skipped++;
      continue;
    }
    if (passport.length > 30) {
      console.warn(
        `  SKIP long passport (${passport.length}): "${passport}" row ${i}`
      );
      skipped++;
      continue;
    }

    const nazwisko = String(row[iNazwisko] || "").trim();
    const imie = iImie !== -1 ? String(row[iImie] || "").trim() : "";
    if (!nazwisko) {
      console.warn(`  SKIP row ${i}: empty nazwisko (passport="${passport}")`);
      skipped++;
      continue;
    }

    const fullName = imie ? `${nazwisko} ${imie}` : nazwisko;
    const statusRaw =
      iStatus !== -1
        ? String(row[iStatus] || "")
            .trim()
            .toLowerCase()
        : "";
    const status = statusRaw.includes("pracuje")
      ? "pracuje"
      : statusRaw.includes("zwolniony")
      ? "zwolniony"
      : statusRaw.includes("rezygnacja")
      ? "zwolniony"
      : statusRaw.includes("przeniesiony")
      ? "przeniesiony"
      : statusRaw.includes("przeniesienie")
      ? "przeniesiony"
      : statusRaw.includes("urlop")
      ? "pracuje"
      : statusRaw.includes("l4")
      ? "pracuje"
      : "pracuje";

    const currentYear = new Date().getFullYear();
    const bhpDate = iBhp !== -1 ? parseDate(row[iBhp]) : null;
    const lastWorkDay = iLastDay !== -1 ? parseDate(row[iLastDay]) : null;
    const safeBhp = bhpDate ? bhpDate : `${currentYear}-12-31`;
    const safeLastDay = lastWorkDay ? lastWorkDay : null;

    // Сохраняем последнюю запись по паспорту
    // Приоритет: pracuje > przeniesiony > zwolniony
    const prev = workerMap[passport];
    const statusPriority = { pracuje: 3, przeniesiony: 2, zwolniony: 1 };
    const newPriority = statusPriority[status] || 1;
    const prevPriority = prev ? statusPriority[prev.status] || 1 : 0;

    if (!prev || newPriority >= prevPriority) {
      workerMap[passport] = {
        fullName,
        status,
        safeBhp,
        safeLastDay,
        rowIdx: i,
      };
    }
  }

  // Теперь делаем upsert по собранным данным
  for (const [passport, data] of Object.entries(workerMap)) {
    try {
      const existing = await db.query(
        `SELECT id FROM workers WHERE login = $1`,
        [passport]
      );
      if (existing.rows.length) {
        await db.query(
          `UPDATE workers SET
     full_name      = $1,
     facility_id    = CASE WHEN $3::worker_status = 'pracuje' THEN $2 ELSE facility_id END,
     status         = CASE 
                        WHEN status = 'pracuje' AND $3::worker_status != 'pracuje' THEN status
                        ELSE $3::worker_status
                      END,
     bhp_date       = COALESCE($4, bhp_date),
     last_work_date = COALESCE($5, last_work_date),
     updated_at     = now()
   WHERE login = $6`,
          [
            data.fullName,
            facilityId,
            data.status,
            data.safeBhp,
            data.safeLastDay,
            passport,
          ]
        );
        updated++;
      } else {
        await db.query(
          `INSERT INTO workers (login, full_name, facility_id, status, bhp_date, last_work_date)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            passport,
            data.fullName,
            facilityId,
            data.status,
            data.safeBhp,
            data.safeLastDay,
          ]
        );
        added++;
      }

      // Записываем историю
      const existingHistory = await db.query(
        `SELECT id FROM worker_facility_history 
   WHERE worker_id = (SELECT id FROM workers WHERE login = $1)
     AND facility_id = $2
     AND status = $3::worker_status
     AND DATE_TRUNC('day', imported_at) = CURRENT_DATE`,
        [passport, facilityId, data.status]
      );
      if (existingHistory.rows.length === 0) {
        await db.query(
          `INSERT INTO worker_facility_history (worker_id, facility_id, status, source_sheet, bhp_date, last_work_date, import_date)
   SELECT id, $2, $3::worker_status, $4, $5, $6, CURRENT_DATE FROM workers WHERE login = $1
   ON CONFLICT (worker_id, facility_id, status, import_date) DO NOTHING`,
          [
            passport,
            facilityId,
            data.status,
            source.facilityName,
            data.safeBhp,
            data.safeLastDay,
          ]
        );
      }
    } catch (rowErr) {
      //console.warn(`  SKIP ${passport}: ${rowErr.message}`);
      skipped++;
    }
  }

  console.log(`  Done: added=${added} updated=${updated} skipped=${skipped}`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log("Starting import...");
  for (const source of SOURCES) {
    await importSource(source);
  }
  console.log("\nImport complete!");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
