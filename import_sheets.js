require("dotenv").config();
const { https } = require("follow-redirects");
const db = require("./db");
const crypto = require("crypto");
const csvHashCache = new Map();

const { google } = require("googleapis");
const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "google-key.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheetsApi = google.sheets({ version: "v4", auth });
const spreadsheetMetaCache = new Map();

// ── CONFIG ────────────────────────────────────────────────────
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
    ssId: "1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c",
    gid: "1238085682",
    facilityName: "Hydro Chrzanów SAS",
  },
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "1158031380",
    facilityName: "METLER Dipico",
  },
  
  {
    ssId: "1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI",
    gid: "1407856830",
    facilityName: "Punto Pruszyński APT",
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
    gid: "1416932837",
    facilityName: "Action Zamienie SAS EAST BRIDGE",
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
    ssId: "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4",
    gid: "1335952904",
    facilityName: "Ligentia APT",
  },
  {
    ssId: "1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4",
    gid: "314279664",
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
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "606490412",
    facilityName: "Cerrad Sas",
  },
    {
    ssId: "13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw",
    gid: "856011641",
    facilityName: "Marc Sas",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "0",
    facilityName: "Id Logistics Wro SAS",
  },
  {
    ssId: "1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs",
    gid: "710429418",
    facilityName: "ID Krajków SAS",
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
    gid: "749697850",
    facilityName: "Id Logistics Tyniec WELL",
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
   {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1883894702",
    facilityName: "Partners Lowicz SAS ",
  },
  {
    ssId: "1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ",
    gid: "1622778445",
    facilityName: "CEVA Piotrków Trybunalski well",
  },
  {
    ssId: "1UHwrLJyb6P2Zc4j1ibC8Vif7uLR2_0tiYGHXpApsp_A",
    gid: "1228811347",
    facilityName: "ID Konin Żagański Well",
  },
  {
    ssId: "1UHwrLJyb6P2Zc4j1ibC8Vif7uLR2_0tiYGHXpApsp_A",
    gid: "224713029",
    facilityName: "ID Konin Żagański SAS",
  },
  
];

// ── FETCH CSV ─────────────────────────────────────────────────
async function fetchRows(ssId, gid) {
  let sheets;

  if (spreadsheetMetaCache.has(ssId)) {
    sheets = spreadsheetMetaCache.get(ssId);
  } else {
    const meta = await sheetsApi.spreadsheets.get({
      spreadsheetId: ssId,
      fields: "sheets(properties(sheetId,title))",
    });

    sheets = meta.data.sheets || [];

    spreadsheetMetaCache.set(ssId, sheets);
  }

  const sh = sheets.find(
    (s) => String(s.properties.sheetId) === String(gid || "0"),
  );

  if (!sh) {
    throw new Error(`gid ${gid} not found in ${ssId}`);
  }

  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: `'${sh.properties.title}'`,
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

function cleanPesel(str) {
  return (
    String(str || "")
      .trim()
      .replace(/[^0-9]/g, "")
      .substring(0, 20) || null
  );
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

// ── IMPORT ONE SOURCE ─────────────────────────────────────────
async function importSource(source, facilityId, cache) {
  console.log(`\nImporting: ${source.facilityName}`);
  let rows;

  try {
    rows = await fetchRows(source.ssId, source.gid);
  } catch (e) {
    console.error(`  ERROR fetching sheet: ${e.message}`);
    return;
  }

  // Проверяем хеш
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify(rows))
    .digest("hex");

  const cacheKey = `${source.ssId}_${source.gid}`;

  if (csvHashCache.get(cacheKey) === hash) {
    console.log(`  No changes — skipping`);
    return;
  }

  csvHashCache.set(cacheKey, hash);

  if (rows.length < 2) {
    console.log("  No data rows found");
    return;
  }

  // Find header row
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    if (
      rows[i].some(
        (c) =>
          c.toLowerCase().includes("paszport") ||
          c.toLowerCase().includes("nazwisko"),
      )
    ) {
      headerIdx = i;
      break;
    }
  }

  const headers = rows[headerIdx].map((h) => h.toLowerCase().trim());
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

  if (iPassport === -1 && iNazwisko === -1) {
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
    console.error("  ERROR: Cannot find required columns");
    return;
  }

  console.log(
    `  Header row: ${headerIdx}, passport=${iPassport} nazwisko=${iNazwisko} status=${iStatus} bhp=${iBhp}`,
  );


  const MAX_COL = 26;

  // Збираємо унікальні записи з CSV (ключ: паспорт + bhp)
  const workerMap = {};
  let skipped = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i].slice(0, MAX_COL);
    if (row.every((c) => !c || !c.trim())) continue;

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
    const status = parseStatus(iStatus !== -1 ? row[iStatus] : "");
    const bhpDate = iBhp !== -1 ? parseDate(row[iBhp]) : null;
    const lastWorkDay = iLastDay !== -1 ? parseDate(row[iLastDay]) : null;
    const safeBhp = bhpDate || null;
    const safeLastDay = lastWorkDay || null;

    // Унікальний ключ: паспорт + BHP (один працівник може бути кілька разів)
    const mapKey = `${passport}_${safeBhp}`;
    const data = { passport, fullName, status, safeBhp, safeLastDay, pesel };
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

  let added = 0,
    updated = 0,
    historyAdded = 0;
  const dbInserts = []; // Батч upsert для history
  const processedWorkerIds = new Set();

  for (const [mapKey, data] of Object.entries(workerMap)) {
    const { passport, fullName, status, safeBhp, safeLastDay, pesel } = data;

    try {
      // ── 1. Знаходимо worker з кешу (без запитів до БД) ──
      let worker = pesel ? cache.byPesel.get(pesel) : null;
      if (!worker) worker = cache.byLogin.get(passport);

      let workerId;

      if (worker) {
        workerId = worker.id;

        // login оновлюємо ТІЛЬКИ якщо працівника знайдено по login (не по PESEL),
        // інакше зберігаємо login з бази (щоб ручні зміни не відкочувались)
        const foundByPesel = pesel && cache.byPesel.get(pesel);
        const loginToSave = foundByPesel ? worker.login : passport;

        const needsUpdate =
          worker.full_name !== fullName ||
          (pesel && worker.pesel !== pesel) ||
          (worker.login !== loginToSave);

        if (needsUpdate) {
          await db.query(
            `UPDATE workers SET full_name = $1, login = $2, pesel = COALESCE($3, pesel), updated_at = now() WHERE id = $4`,
            [fullName, loginToSave, pesel, workerId],
          );
          // Оновлюємо кеш
          worker.full_name = fullName;
          worker.login = loginToSave;
          if (pesel) {
            worker.pesel = pesel;
            cache.byPesel.set(pesel, worker);
          }
          cache.byLogin.set(loginToSave, worker);
          updated++;
        }
      } else {
        // Новий працівник
        const insertRes = await db.query(
          `INSERT INTO workers (login, full_name, pesel) VALUES ($1, $2, $3) RETURNING id`,
          [passport, fullName, pesel],
        );
        workerId = insertRes.rows[0].id;
        const newWorker = {
          id: workerId,
          login: passport,
          full_name: fullName,
          pesel,
        };
        cache.byLogin.set(passport, newWorker);
        if (pesel) cache.byPesel.set(pesel, newWorker);
        added++;
      }
      processedWorkerIds.add(workerId);

      // ── 2. Завжди обробляємо рядок (щоб ловити зміни статусу/дат) ──
      dbInserts.push([
        workerId,
        facilityId,
        status,
        source.facilityName,
        safeBhp,
        safeLastDay,
      ]);
      historyAdded++;
    } catch (err) {
      console.warn(`  SKIP ${passport}: ${err.message}`);
      skipped++;
    }
  }

  // ── 3. Upsert в history ──
  // Логіка: (1) якщо є період з такою ж bhp_date — оновлюємо статус/дати;
  // (2) інакше якщо є ВІДКРИТИЙ період (lwd IS NULL) і вхідний рядок теж
  //     відкритий — це той самий період, у якого виправили BHP → оновлюємо;
  // (3) інакше — новий період, вставляємо.
  if (dbInserts.length > 0) {
    for (const row of dbInserts) {
      const [rowWorkerId, rowFacilityId, status, sourceSheet, bhpDate, lastWorkDate] = row;

      try {
        if (bhpDate === null) {
          // Без BHP — оновлюємо запис без дати або вставляємо
          await db.query(
            `INSERT INTO worker_facility_history
               (worker_id, facility_id, status, source_sheet, bhp_date, last_work_date, imported_at)
             VALUES ($1, $2, $3::worker_status, $4, NULL, $5, now())
             ON CONFLICT DO NOTHING`,
            [rowWorkerId, rowFacilityId, status, sourceSheet, lastWorkDate],
          );
          await db.query(
            `UPDATE worker_facility_history
               SET status = $3::worker_status,
                   last_work_date = $5,
                   source_sheet = $4,
                   imported_at = now()
             WHERE worker_id = $1
               AND facility_id = $2
               AND bhp_date IS NULL`,
            [rowWorkerId, rowFacilityId, status, sourceSheet, lastWorkDate],
          );
          continue;
        }

        // (1) Той самий період за bhp_date → оновлюємо статус і дату звільнення
        const byBhp = await db.query(
          `UPDATE worker_facility_history
             SET status = $3::worker_status,
                 last_work_date = $5,
                 source_sheet = $4,
                 imported_at = now()
           WHERE id = (
             SELECT id FROM worker_facility_history
             WHERE worker_id = $1 AND facility_id = $2 AND bhp_date = $6
             ORDER BY imported_at DESC LIMIT 1
           )
           RETURNING id`,
          [rowWorkerId, rowFacilityId, status, sourceSheet, lastWorkDate, bhpDate],
        );
        if (byBhp.rowCount > 0) continue;

        // (2) BHP змінили в джерелі → оновлюємо відкритий період.
        // Тільки якщо вхідний рядок сам відкритий, щоб історичний закритий
        // рядок не захопив поточний період.
        if (lastWorkDate === null) {
          const openRow = await db.query(
            `UPDATE worker_facility_history
               SET bhp_date = $6,
                   status = $3::worker_status,
                   last_work_date = $5,
                   source_sheet = $4,
                   imported_at = now()
             WHERE id = (
               SELECT id FROM worker_facility_history
               WHERE worker_id = $1 AND facility_id = $2 AND last_work_date IS NULL
               ORDER BY bhp_date DESC LIMIT 1
             )
             RETURNING id`,
            [rowWorkerId, rowFacilityId, status, sourceSheet, lastWorkDate, bhpDate],
          );
          if (openRow.rowCount > 0) continue;
        }

        // (3) Новий період (повторний найм тощо) → вставляємо
        await db.query(
          `INSERT INTO worker_facility_history
             (worker_id, facility_id, status, source_sheet, bhp_date, last_work_date, imported_at)
           VALUES ($1, $2, $3::worker_status, $4, $6, $5, now())
           ON CONFLICT (worker_id, facility_id, status, COALESCE(last_work_date, '9999-12-31'))
           DO UPDATE SET
             bhp_date = EXCLUDED.bhp_date,
             source_sheet = EXCLUDED.source_sheet,
             imported_at = now()`,
          [rowWorkerId, rowFacilityId, status, sourceSheet, lastWorkDate, bhpDate],
        );
      } catch (err) {
        console.warn(`  HISTORY SKIP worker=${rowWorkerId} fac=${rowFacilityId}: ${err.message}`);
      }
    }
  }

  // ── 4. Зворотна перевірка: відкриті періоди в БД, яких НЕМАЄ на листі ──
  // Людини немає на листі → її не брали на роботу → видаляємо рядок history.
  // Запобіжники:
  //  - НЕ видаляємо, якщо в періоді є внесені години (людина реально працювала);
  //  - НЕ видаляємо масово (>10% об'єкта або порожній лист) — лише лог,
  //    щоб битий CSV від Google не зніс цілий об'єкт.
  try {
    const openInDb = await db.query(
      `SELECT h.id, h.worker_id, w.login, w.full_name,
              h.bhp_date, h.status::text AS status,
              EXISTS (
                SELECT 1 FROM hours_log hl
                WHERE hl.worker_id = h.worker_id
                  AND hl.work_date >= h.bhp_date
              ) AS has_hours
       FROM worker_facility_history h
       JOIN workers w ON w.id = h.worker_id
       WHERE h.facility_id = $1
         AND h.last_work_date IS NULL
         AND h.status::text NOT IN ('rezygnacja')
         AND w.login NOT LIKE 'TEST_%'`,
      [facilityId],
    );

    const missingFromSheet = openInDb.rows.filter(
      (r) => !processedWorkerIds.has(r.worker_id),
    );

    if (missingFromSheet.length > 0) {
      const tooMany =
        processedWorkerIds.size === 0 ||
        missingFromSheet.length > Math.max(3, openInDb.rows.length * 0.1);

      if (tooMany) {
        console.warn(
          `  ⚠ REVERSE CHECK: ${missingFromSheet.length}/${openInDb.rows.length} відкритих періодів відсутні на листі "${source.facilityName}" — ЗАБАГАТО, видалення пропущено (можливо битий CSV). Перевірте вручну.`,
        );
      } else {
        for (const r of missingFromSheet) {
          const bhp = r.bhp_date
            ? r.bhp_date.toISOString().substring(0, 10)
            : "—";

          if (r.has_hours) {
            // Є години → людина працювала, видаляти небезпечно
            console.warn(
              `  ⚠ REVERSE CHECK: ${r.login} ${r.full_name} немає на листі, але МАЄ ГОДИНИ (bhp=${bhp}, history_id=${r.id}) — НЕ видалено, перевірте вручну`,
            );
            continue;
          }

          await db.query(
            `DELETE FROM worker_facility_history WHERE id = $1`,
            [r.id],
          );
          console.log(
            `  REVERSE CHECK: видалено ${r.login} ${r.full_name} (status=${r.status}, bhp=${bhp}) — немає на листі, годин немає`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(`  REVERSE CHECK error: ${err.message}`);
  }

  console.log(
    `  Done: added = ${added} updated = ${updated} history = ${historyAdded} skipped = ${skipped}`,
  );
}

// ── RUN IMPORT ────────────────────────────────────────────────
async function runImport(allowedFacilities = null) {
  console.log(`\n === IMPORT STARTED === `);

  // ── Завантажуємо все з БД одним разом ──
  console.log("  Loading cache from DB...");
  const [workersRes, historyRes, facilitiesRes] = await Promise.all([
    db.query(`SELECT id, login, pesel, full_name FROM workers`),
    db.query(`SELECT worker_id, facility_id, status::text, last_work_date, bhp_date FROM worker_facility_history`),
    db.query(`SELECT id, name FROM facilities`),
  ]);

  // Будуємо індекси
  const cache = {
    byLogin: new Map(),
    byPesel: new Map(),
    historySet: new Set(),
    facilityByName: new Map(),
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
  });

  console.log(
    `  Cache: ${workersRes.rows.length} workers, ${historyRes.rows.length} history, ${facilitiesRes.rows.length} facilities`,
  );

  // Фільтруємо джерела
  let sources = SOURCES;
  if (allowedFacilities !== null && allowedFacilities.length > 0) {
    const facNames = await db.query(
      `SELECT LOWER(name) AS name FROM facilities WHERE id = ANY($1)`,
      [allowedFacilities],
    );
    const allowedNames = new Set(facNames.rows.map((r) => r.name));
    sources = SOURCES.filter((s) =>
      allowedNames.has(s.facilityName.toLowerCase()),
    );
    console.log(`Importing ${sources.length} of ${SOURCES.length} sources`);
  }

  for (const source of sources) {
    try {
      // Знаходимо або створюємо facility
      let facilityId = cache.facilityByName.get(
        source.facilityName.toLowerCase(),
      );
      if (!facilityId) {
        const ins = await db.query(
          `INSERT INTO facilities(name, group_name) VALUES($1, $1) RETURNING id`,
          [source.facilityName],
        );
        facilityId = ins.rows[0].id;
        cache.facilityByName.set(source.facilityName.toLowerCase(), facilityId);
        console.log(
          `  Facility created: ${source.facilityName} id = ${facilityId}`,
        );
      }

      await importSource(source, facilityId, cache);
      await sleep(2500);
    } catch (e) {
      console.error(`ERROR in ${source.facilityName}: `, e.message);
    }
  }

  // Чистимо unknown, які вже вирішилися
  await recheckUnknowns();

  // Синхронізуємо workers.status з актуальним періодом історії
  await syncWorkerStatus();

  console.log(`\n === IMPORT DONE === `);
}

if (require.main === module) {
  runImport()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

// ── RE-CHECK UNKNOWN ──────────────────────────────────────────
// Після імпорту шукаємо рядки зі статусом 'unknown' і перевіряємо,
// чи не з'явився в того ж працівника на тому ж об'єкті рядок
// з нормальним статусом. Якщо так — видаляємо unknown.
async function recheckUnknowns() {
  const result = await db.query(`
    DELETE FROM worker_facility_history u
    WHERE u.status = 'unknown'
      AND EXISTS (
        SELECT 1 FROM worker_facility_history h
        WHERE h.worker_id = u.worker_id
          AND h.facility_id = u.facility_id
          AND h.id <> u.id
          AND h.status::text <> 'unknown'
      )
    RETURNING u.id
  `);
  if (result.rowCount > 0) {
    console.log(`  Cleaned ${result.rowCount} resolved 'unknown' entries`);
  }
}

function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SYNC WORKER STATUS ────────────────────────────────────────
// workers.status — денормалізована копія статусу з актуального періоду
// worker_facility_history. Актуальним вважаємо: спершу відкритий період
// (last_work_date IS NULL) з найбільшою bhp_date, інакше — останній
// закритий період. Без цього список Pracownicy показує 'unknown'.
async function syncWorkerStatus() {
  const result = await db.query(`
    UPDATE workers w
       SET status = c.status
      FROM (
        SELECT DISTINCT ON (h.worker_id)
               h.worker_id,
               h.status
          FROM worker_facility_history h
         ORDER BY h.worker_id,
                  (h.last_work_date IS NULL) DESC,
                  h.bhp_date DESC NULLS LAST,
                  h.id DESC
      ) c
     WHERE w.id = c.worker_id
       AND w.status IS DISTINCT FROM c.status
    RETURNING w.id
  `);
  if (result.rowCount > 0) {
    console.log(`  Synced status for ${result.rowCount} workers`);
  }
}

module.exports = { runImport };