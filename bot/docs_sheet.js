// bot/docs_sheet.js — таблиця «Dokumenty pocztą 2026» (аркуші BEZPOSREDNIO і PRZENIESIENIE): о 6:00, після перевірки
// підписів у HRappka (bot/hr_sign.js), бот дописує в ПОРОЖНІ клітинки й позначає їх світло-помаранчевим:
//   • PASZPORT — для рядків від PASS_FROM (01.09.2026): працівник за ПІБ + період з BHP біля «UMOWA OD» (+ заклад, якщо однофамільці);
//   • рядки від hr.FROM (15.10.2026):
//       ANKIETA      — дата заповнення анкети ANKIETA DO PRACOWNIKA (LZ) або (LZ) udział w programie lojalnościowym;
//       DOKUMENTY    — дата, коли всі 5 документів підписані (załącznik nr 2, załącznik nr 1 PPK, potrącenie, PIT-2, kara);
//       PROGRAM LOJALNOŚCIOWY ( ZGODA/NIE ) — відповідь в анкеті: ZGODA / NIE;
//       PROGRAM LOJALNOŚCIOWY PODPISANY     — дата підпису документа program_lojalnosciowy;
//       Rezygnacja z ubezp. STUDENTA        — відповідь «zainteresowany prywatnym ubezpieczeniem zdrowotnym?»: TAK / NIE.
//     Рахуються документи й анкети, надіслані від 5 днів до «UMOWA OD» до 10 днів після (як у hr_sign).
//   • Те, що вписано руками («в бумаге», «rezygnacja», дати), не чіпаємо ніколи.
//   • Рядки, для яких працівника не знайшли (або знайшли кількох), — у hrs.sheet_issues → у лист о 7:00.
// Доступ: сервісний акаунт google-key.json має бути редактором таблиці. Таблиця — DOCS_SHEET_ID у .env.
"use strict";

const path = require("path");
const { google } = require("googleapis");
const db = require("../db");
const hr = require("./hr_sign");

const SHEET_ID = process.env.DOCS_SHEET_ID || "1k5AoF9jEx5FwfJgjdrJVB1RiFUU_LaWlQSvU8tlIDKk";
const TABS = ["BEZPOSREDNIO", "PRZENIESIENIE"];
const PASS_FROM = "2026-09-01";
const BHP_NEAR = 14;                                   // днів між «UMOWA OD» і BHP періоду в базі
const ORANGE = { red: 0.988, green: 0.898, blue: 0.804 };   // світло-помаранчевий (як «light orange 3» у Google)
const RECHECK_H = 3;                                   // працівників, яких HRappka не перевіряла стільки годин, — перевірити
// Документи, які мають бути підписані (частина назви файлу)
const DOCS = [
  ["zal2", /zalacznik_do_umowy_nr_2/i],
  ["zal1", /zalacznik_do_umowy_nr_1/i],
  ["potracenie", /potracen/i],
  ["pit2", /pit_2/i],
  ["kara", /kara_za_nieobecnosc/i],
];
const LOYAL_DOC = /program_lojal/i;
const SURVEYS = [72966, 87549];                        // «Ankieta do pracownika» — два види

let SHEETS = null;
function api() {
  if (!SHEETS) {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, "..", "google-key.json"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    SHEETS = google.sheets({ version: "v4", auth });
  }
  return SHEETS;
}

// ── Дрібниці ──────────────────────────────────────────────────────────
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[łŁ]/g, "l")
  .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const nameKey = (s) => norm(s).split(" ").filter(Boolean).sort().join(" ");   // порядок слів не важливий
const cleanPass = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const FAC_STOP = new Set(["SAS", "APT", "WELL", "SP", "Z", "O", "DO", "Z"]);
const facTokens = (s) => new Set(norm(s).split(" ").filter((t) => t.length >= 2 && !FAC_STOP.has(t)));
// Дата з клітинки: число (серійна дата Google) або «dd.mm.yyyy» → YYYY-MM-DD
function cellDate(v) {
  if (typeof v === "number" && v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(v || "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
const serial = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 864e5);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const warsawDate = (d) => (d ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(d)) : null);
const isEmpty = (v) => v == null || String(v).trim() === "";

// Колонки за заголовками (на двох аркушах вони зсунуті)
function columns(head) {
  const h = head.map((x) => norm(x));
  const find = (fn) => h.findIndex(fn);
  const c = {
    sent: find((x) => x.startsWith("DATA WYSLANIA")),
    pass: find((x) => x === "PASZPORT"),
    name: find((x) => x.startsWith("NAZWISKO")),
    fac: find((x) => x === "ZAKLAD DO"),
    umowa: find((x) => x.startsWith("UMOWA OD")),
    ankieta: find((x) => x === "ANKIETA"),
    docs: find((x) => x === "DOKUMENTY"),
    loyal: find((x) => x.startsWith("PROGRAM LOJALNOSCIOWY") && !x.includes("PODPISANY")),
    loyalSigned: find((x) => x.startsWith("PROGRAM LOJALNOSCIOWY") && x.includes("PODPISANY")),
    student: find((x) => x.startsWith("REZYGNACJA Z UBEZP")),
  };
  if (c.fac === -1) c.fac = find((x) => x === "ZAKLAD");
  return c;
}

// ── Працівники з бази ─────────────────────────────────────────────────
async function loadWorkers() {
  const [w, h] = await Promise.all([
    db.query(`SELECT id, full_name, login FROM workers WHERE COALESCE(login, '') NOT LIKE 'TEST_%'`),
    db.query(`SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, f.name AS fac
                FROM worker_facility_history h JOIN facilities f ON f.id = h.facility_id WHERE h.bhp_date IS NOT NULL`),
  ]);
  const byId = new Map(w.rows.map((x) => [x.id, { ...x, periods: [] }]));
  h.rows.forEach((p) => { const x = byId.get(p.worker_id); if (x) x.periods.push(p); });
  const byName = new Map(), byPass = new Map();
  byId.forEach((x) => {
    const k = nameKey(x.full_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(x);
    const p = cleanPass(x.login);
    if (p) byPass.set(p, x);
  });
  return { byName, byPass };
}
// Рядок → працівник: паспорт у таблиці; інакше ПІБ + період з BHP біля «UMOWA OD»; кілька — за назвою закладу
function match(W, r) {
  if (r.pass) { const x = W.byPass.get(cleanPass(r.pass)); if (x) return { worker: x }; }
  const all = W.byName.get(nameKey(r.name)) || [];
  if (!all.length) return { reason: "not_found" };
  const anchor = r.umowa || r.sent;
  const near = (x) => x.periods.filter((p) => anchor && Math.abs(Date.parse(p.bhp) - Date.parse(anchor)) <= BHP_NEAR * 864e5);
  let c = all.filter((x) => near(x).length);
  if (!c.length) return { reason: all.length > 1 ? "ambiguous" : "no_period" };
  if (c.length > 1) {
    const ft = facTokens(r.fac);
    const score = (x) => Math.max(0, ...near(x).map((p) => [...facTokens(p.fac)].filter((t) => ft.has(t)).length));
    const best = Math.max(...c.map(score));
    c = c.filter((x) => score(x) === best);
  }
  return c.length === 1 ? { worker: c[0] } : { reason: "ambiguous" };
}

// BHP періоду перед тим, що найближчий до anchor («UMOWA OD»)
function prevBhp(worker, anchor) {
  const ps = worker.periods.map((p) => p.bhp).sort();
  if (!ps.length) return null;
  const dist = (b) => Math.abs(Date.parse(b) - Date.parse(anchor));
  const cur = ps.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  return ps.filter((b) => b < cur).pop() || null;
}

// ── Стан працівника в HRappka (з hrs.docs / hrs.surveys) у вікні від anchor ──
async function states(pairs) {
  // pairs: [{ wid, anchor, prevBhp }] — prevBhp: BHP попереднього періоду (документи до нього включно не рахуємо)
  if (!pairs.length) return new Map();
  const ids = [...new Set(pairs.map((p) => p.wid))];
  const [d, s] = await Promise.all([
    db.query(`SELECT worker_id, display_name, status, hr_created_at, to_char(hr_created_at, 'YYYY-MM-DD') AS created, signed_seen_at
                FROM hrs.docs WHERE worker_id = ANY($1::int[]) ORDER BY hr_created_at, hr_doc_id`, [ids]),
    db.query(`SELECT worker_id, qid, state, answers, to_char(hr_created_at, 'YYYY-MM-DD') AS created, filled_at
                FROM hrs.surveys WHERE worker_id = ANY($1::int[]) AND qid = ANY($2::int[]) ORDER BY hr_created_at, hr_answer_id`, [ids, SURVEYS]),
  ]);
  const out = new Map();
  for (const { wid, anchor, prevBhp } of pairs) {
    let from = addDays(anchor, -hr.WINDOW_BEFORE);
    const to = addDays(anchor, hr.WINDOW_AFTER);
    if (prevBhp && addDays(prevBhp, 1) > from) from = addDays(prevBhp, 1);
    const inWin = (x) => x.worker_id === wid && x.created >= from && x.created <= to;
    const docs = d.rows.filter(inWin), surveys = s.rows.filter(inWin);
    const st = {};
    // документи: остання відправка кожного з 5 — підписана
    const last = DOCS.map(([, re]) => docs.filter((x) => re.test(x.display_name)).pop());
    if (last.every((x) => x && x.status === "SIGN")) st.docs = warsawDate(last.map((x) => x.signed_seen_at || x.hr_created_at).sort().pop());
    const loyalDoc = docs.filter((x) => LOYAL_DOC.test(x.display_name)).pop();
    if (loyalDoc && loyalDoc.status === "SIGN") st.loyalSigned = warsawDate(loyalDoc.signed_seen_at || loyalDoc.hr_created_at);
    // анкети: заповнена будь-яка з двох (остання)
    const filled = surveys.filter((x) => x.state === "FILLED");
    const lastFilled = filled[filled.length - 1];
    if (lastFilled) st.ankieta = lastFilled.filled_at ? new Intl.DateTimeFormat("sv-SE").format(lastFilled.filled_at) : lastFilled.created;
    const ans = (k) => (filled.filter((x) => x.answers && x.answers[k]).pop() || { answers: {} }).answers[k];
    if (ans("loyalty")) st.loyal = ans("loyalty");
    if (ans("insurance")) st.student = ans("insurance");
    out.set(`${wid}_${anchor}`, st);
  }
  return out;
}

// ── Головне ───────────────────────────────────────────────────────────
// dry = true — нічого не пише, повертає план; refresh = false — не питати HRappka;
// workerIds — лише рядки цих працівників (кнопка «Sprawdź podpisy»: їх щойно перевірили — без refresh, список «не знайдено» не чіпаємо)
async function sync({ dry = false, refresh = !dry, workerIds = null } = {}) {
  const only = workerIds ? new Set(workerIds.map(Number)) : null;
  const sh = api();
  const meta = await sh.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: "sheets(properties(sheetId,title))" });
  const W = await loadWorkers();
  const today = warsawDate(new Date());
  const tabs = [];
  for (const want of TABS) {
    const p = meta.data.sheets.map((x) => x.properties).find((x) => norm(x.title) === want);
    if (!p) { console.warn(`[docs sheet] немає аркуша ${want}`); continue; }
    const v = (await sh.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${p.title.replace(/'/g, "''")}'`, valueRenderOption: "UNFORMATTED_VALUE" })).data.values || [];
    const c = columns(v[0] || []);
    if ([c.sent, c.pass, c.name, c.umowa].some((i) => i === -1)) { console.warn(`[docs sheet] ${p.title}: не знайшов колонок`, c); continue; }
    const rows = [];
    for (let i = 1; i < v.length; i++) {
      const r = v[i];
      const sent = cellDate(r[c.sent]);
      if (!sent || sent < PASS_FROM || isEmpty(r[c.name])) continue;
      rows.push({ i, raw: r, sent, umowa: cellDate(r[c.umowa]), pass: isEmpty(r[c.pass]) ? "" : String(r[c.pass]), name: String(r[c.name]).trim(), fac: c.fac !== -1 ? String(r[c.fac] || "") : "" });
    }
    tabs.push({ p, c, rows });
  }
  // зіставлення
  const issues = [], matched = [];
  for (const t of tabs) for (const r of t.rows) {
    const m = match(W, r);
    if (m.worker && (!only || only.has(m.worker.id))) { r.worker = m.worker; matched.push(r); }
    else if (!m.worker && !only && r.sent >= hr.FROM && r.sent < today) issues.push({ t, r, reason: m.reason });
  }
  // свіжі дані з HRappka для тих, кого давно не перевіряли (щоденна перевірка бере лише непідписаних)
  const fillRows = matched.filter((r) => r.sent >= hr.FROM);
  const wids = [...new Set(fillRows.map((r) => r.worker.id))];
  if (wids.length && refresh) {
    const stale = (await db.query(
      `SELECT x FROM unnest($1::int[]) AS x WHERE NOT EXISTS (SELECT 1 FROM hrs.checks k WHERE k.worker_id = x AND k.checked_at > now() - ($2 || ' hours')::interval)`,
      [wids, String(RECHECK_H)])).rows.map((x) => x.x);
    if (stale.length) await hr.check(stale);
  }
  const st = await states(fillRows.map((r) => ({ wid: r.worker.id, anchor: r.umowa || r.sent, prevBhp: prevBhp(r.worker, r.umowa || r.sent) })));
  // що писати: лише порожні клітинки
  const writes = [];
  const put = (t, r, col, kind, value) => {
    if (col === -1 || value == null || !isEmpty(r.raw[col])) return;
    writes.push({ t, r, col, kind, value });
  };
  for (const t of tabs) for (const r of t.rows) {
    if (!r.worker) continue;
    put(t, r, t.c.pass, "text", r.worker.login);
    if (r.sent < hr.FROM) continue;
    const s = st.get(`${r.worker.id}_${r.umowa || r.sent}`) || {};
    put(t, r, t.c.ankieta, "date", s.ankieta);
    put(t, r, t.c.docs, "date", s.docs);
    put(t, r, t.c.loyal, "text", s.loyal);
    put(t, r, t.c.loyalSigned, "date", s.loyalSigned);
    put(t, r, t.c.student, "text", s.student);
  }
  if (!dry && writes.length) {
    const requests = writes.map((w) => ({
      updateCells: {
        range: { sheetId: w.t.p.sheetId, startRowIndex: w.r.i, endRowIndex: w.r.i + 1, startColumnIndex: w.col, endColumnIndex: w.col + 1 },
        rows: [{ values: [{
          userEnteredValue: w.kind === "date" ? { numberValue: serial(w.value) } : { stringValue: String(w.value) },
          userEnteredFormat: { backgroundColor: ORANGE, ...(w.kind === "date" ? { numberFormat: { type: "DATE", pattern: "d.m.yyyy" } } : {}) },
        }] }],
        fields: w.kind === "date" ? "userEnteredValue,userEnteredFormat.backgroundColor,userEnteredFormat.numberFormat" : "userEnteredValue,userEnteredFormat.backgroundColor",
      },
    }));
    for (let i = 0; i < requests.length; i += 500) {
      await sh.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: requests.slice(i, i + 500) } });
    }
  }
  if (!dry && !only) {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM hrs.sheet_issues");
      for (const x of issues) {
        await client.query(`INSERT INTO hrs.sheet_issues (sheet, row_no, full_name, facility, umowa_od, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
          [x.t.p.title.trim(), x.r.i + 1, x.r.name, x.r.fac.trim() || null, x.r.umowa, x.reason]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  const by = {};
  writes.forEach((w) => { const k = w.t.c ? Object.keys(w.t.c).find((n) => w.t.c[n] === w.col) : "?"; by[k] = (by[k] || 0) + 1; });
  const res = { rows: tabs.reduce((n, t) => n + t.rows.length, 0), matched: matched.length, issues: issues.length, written: writes.length, by };
  console.log(`[docs sheet] ${dry ? "(próba) " : ""}рядків ${res.rows}, знайдено ${res.matched}, не знайдено ${res.issues}, вписано ${res.written}`, JSON.stringify(by));
  return dry ? { ...res, writes: writes.map((w) => ({ sheet: w.t.p.title.trim(), row: w.r.i + 1, name: w.r.name, col: Object.keys(w.t.c).find((n) => w.t.c[n] === w.col), value: w.value })),
    issues: issues.map((x) => ({ sheet: x.t.p.title.trim(), row: x.r.i + 1, name: x.r.name, fac: x.r.fac, reason: x.reason })) } : res;
}

// Для листа о 7:00
async function issues() {
  return (await db.query(`SELECT sheet, row_no, full_name, facility, to_char(umowa_od, 'YYYY-MM-DD') AS umowa, reason FROM hrs.sheet_issues ORDER BY sheet, row_no`)
    .catch(() => ({ rows: [] }))).rows;
}

module.exports = { sync, issues, SHEET_ID, _test: { cellDate, serial, nameKey, columns, match, prevBhp } };
