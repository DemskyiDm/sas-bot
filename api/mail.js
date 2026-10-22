// api/mail.js — відправка листів (Gmail або Microsoft 365) і простий Excel (.xlsx) без нових бібліотек.
//
// .env (pm2 restart після зміни). MAIL_PROVIDER=gmail | microsoft (без нього — за тим, що заповнено):
//
//   Gmail (пароль застосунку; потрібен пакет: npm install nodemailer):
//     MAIL_PROVIDER=gmail
//     GMAIL_USER=sas.zaliczki@gmail.com
//     GMAIL_APP_PASSWORD=abcd efgh ijkl mnop    Google-акаунт → Безпека → Паролі застосунків (потрібна двоетапна перевірка)
//     MAIL_FROM_NAME=SAS Zaliczki               (необовʼязково) імʼя відправника
//     SMTP_HOST / SMTP_PORT                     (необовʼязково) інший SMTP замість smtp.gmail.com:465
//
//   Microsoft 365 (Microsoft Graph, без пароля скриньки):
//     MAIL_PROVIDER=microsoft
//     MS_TENANT_ID=…        Directory (tenant) ID  — Entra ID → App registrations → застосунок → Overview
//     MS_CLIENT_ID=…        Application (client) ID
//     MS_CLIENT_SECRET=…    Certificates & secrets → Client secret → Value (діє до дати, вказаної при створенні)
//     MAIL_FROM=zaliczki@…  скринька, з якої йдуть листи (спільна скринька, ліцензія не потрібна)
//     Дозвіл застосунку: Microsoft Graph → Application permissions → Mail.Send (+ Grant admin consent).
"use strict";

const archiver = require("archiver");
const { PassThrough } = require("stream");

const env = (k) => String(process.env[k] || "").trim();
const CFG = () => ({
  tenant: env("MS_TENANT_ID"),
  client: env("MS_CLIENT_ID"),
  secret: env("MS_CLIENT_SECRET"),
  from: env("MAIL_FROM"),
});
const GMAIL = () => ({
  user: env("GMAIL_USER"),
  pass: env("GMAIL_APP_PASSWORD").replace(/\s+/g, ""),      // Google показує пароль групами по 4 — пробіли не потрібні
  host: env("SMTP_HOST") || "smtp.gmail.com",
  port: Number(env("SMTP_PORT")) || 465,
  name: env("MAIL_FROM_NAME") || "SAS Zaliczki",
});
function provider() {
  const p = env("MAIL_PROVIDER").toLowerCase();
  if (p === "gmail" || p === "smtp") return "gmail";
  if (p === "microsoft" || p === "ms" || p === "graph") return "microsoft";
  return env("GMAIL_USER") ? "gmail" : "microsoft";
}
let NM = undefined;
function nodemailer() {
  if (NM === undefined) { try { NM = require("nodemailer"); } catch (e) { NM = null; } }
  return NM;
}
// { ok, provider, from, reason }: reason — що не так (для екрана «Відправити в офіс»)
function status() {
  if (provider() === "gmail") {
    const g = GMAIL();
    if (!nodemailer()) return { ok: false, provider: "gmail", from: g.user, reason: "no_nodemailer" };
    if (!g.user || !g.pass) return { ok: false, provider: "gmail", from: g.user, reason: "no_gmail" };
    return { ok: true, provider: "gmail", from: g.user };
  }
  const c = CFG();
  if (!(c.tenant && c.client && c.secret && c.from)) return { ok: false, provider: "microsoft", from: c.from, reason: "no_microsoft" };
  return { ok: true, provider: "microsoft", from: c.from };
}
const configured = () => status().ok;
const fromAddress = () => status().from || "";

let TOKEN = { value: null, exp: 0 };
async function token() {
  if (TOKEN.value && Date.now() < TOKEN.exp - 60 * 1000) return TOKEN.value;
  const c = CFG();
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client, client_secret: c.secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // AADSTS7000222 — секрет прострочений; AADSTS700016 — неправильний MS_CLIENT_ID; AADSTS90002 — неправильний MS_TENANT_ID
    throw new Error(`Microsoft login: ${j.error_description ? String(j.error_description).split("\r\n")[0] : `HTTP ${r.status}`}`);
  }
  TOKEN = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return TOKEN.value;
}

const addr = (list) => (list || []).filter(Boolean).map((a) => ({ emailAddress: { address: a } }));

// ── Gmail / інший SMTP ────────────────────────────────────────────────
let TRANSPORT = null;
async function sendSmtp(m) {
  const g = GMAIL();
  if (!TRANSPORT || TRANSPORT._key !== `${g.user}|${g.pass}|${g.host}|${g.port}`) {
    TRANSPORT = nodemailer().createTransport({
      host: g.host, port: g.port, secure: g.port === 465, auth: { user: g.user, pass: g.pass },
      connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
    });
    TRANSPORT._key = `${g.user}|${g.pass}|${g.host}|${g.port}`;
  }
  try {
    await TRANSPORT.sendMail({
      from: { name: g.name, address: g.user },
      to: m.to, cc: m.cc && m.cc.length ? m.cc : undefined, replyTo: m.replyTo && m.replyTo.length ? m.replyTo : undefined,
      subject: m.subject, html: m.html,
      attachments: (m.attachments || []).map((a) => ({ filename: a.name, content: Buffer.from(a.content), contentType: a.contentType })),
    });
    return true;
  } catch (e) {
    const raw = String((e && (e.response || e.message)) || e);
    // 535 5.7.8 — Gmail не прийняв логін / пароль застосунку; 534 — потрібен пароль застосунку
    if (e && (e.code === "EAUTH" || /^53[45]/.test(String(e.responseCode || "")))) {
      throw new Error(`Gmail не прийняв вхід — потрібен пароль застосунку (16 символів) і двоетапна перевірка: ${raw.split("\n")[0]}`);
    }
    throw new Error(`SMTP: ${raw.split("\n")[0]}`);
  }
}

// { to:[], cc:[], replyTo:[], subject, html, attachments:[{ name, contentType, content: Buffer }] }
async function send(m) {
  const st = status();
  if (!st.ok) throw new Error(`Пошта не налаштована (${st.reason})`);
  if (st.provider === "gmail") return sendSmtp(m);
  const t = await token();
  const body = {
    message: {
      subject: m.subject,
      body: { contentType: "HTML", content: m.html },
      toRecipients: addr(m.to),
      ccRecipients: addr(m.cc),
      replyTo: addr(m.replyTo),
      attachments: (m.attachments || []).map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: Buffer.from(a.content).toString("base64"),
      })),
    },
    saveToSentItems: true,
  };
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromAddress())}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 202 || r.ok) return true;
  const j = await r.json().catch(() => ({}));
  const msg = (j.error && (j.error.message || j.error.code)) || `HTTP ${r.status}`;
  // ErrorAccessDenied — немає дозволу Mail.Send / згоди адміна або політика доступу не включає MAIL_FROM;
  // ResourceNotFound / MailboxNotEnabledForRESTAPI — скриньки MAIL_FROM немає
  throw new Error(`Microsoft Graph: ${msg}`);
}

// ── Excel (.xlsx): один аркуш, жирний заголовок, ширина колонок, фільтр. Комірки — текст або число. ──────
const xmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  // символи, заборонені в XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
const colName = (i) => { let s = ""; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function sheetXml(header, rows, widths, footer) {
  const cell = (v, r, c, style) => {
    const ref = `${colName(c)}${r}`;
    const s = style ? ` s="${style}"` : "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
    if (v == null || v === "") return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const all = [header, ...rows];
  const lines = all.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cell(v, ri + 1, ci, ri === 0 ? 1 : 0)).join("")}</row>`);
  if (footer) lines.push(`<row r="${all.length + 1}">${footer.map((v, ci) => cell(v, all.length + 1, ci, 1)).join("")}</row>`);
  const last = `${colName(header.length - 1)}${all.length}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${(widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>
<sheetData>${lines.join("")}</sheetData>
<autoFilter ref="A1:${last}"/>
</worksheet>`;
}

function xlsx({ sheet, header, rows, widths, footer }) {
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc(String(sheet || "Arkusz1").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(String(sheet || "Arkusz1").slice(0, 31))}'!$A$1:$${colName(header.length - 1)}$${rows.length + 1}</definedName></definedNames>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXml(header, rows, widths, footer),
  };
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    const chunks = [];
    out.on("data", (c) => chunks.push(c));
    out.on("end", () => resolve(Buffer.concat(chunks)));
    out.on("error", reject);
    const z = archiver("zip", { zlib: { level: 9 } });
    z.on("error", reject);
    z.pipe(out);
    for (const [name, content] of Object.entries(files)) z.append(content, { name });
    z.finalize();
  });
}

module.exports = { configured, status, fromAddress, send, xlsx, _test: { reset: () => { TOKEN = { value: null, exp: 0 }; TRANSPORT = null; NM = undefined; } } };
