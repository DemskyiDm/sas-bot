// bot/pesel_report.js — щопонеділка о 9:00 (Варшава) лист «хто працює без PESEL» (+ Excel).
// Хто: поточний період (v_worker_current) зі статусом pracuje, а workers.pesel порожній; TEST не рахуємо (як на Start) (PESEL приходить з картки HRappka, bot/hr_import.js).
// Кому — NO_PESEL_REPORT_TO у .env (через кому); без неї — ті самі адреси, що й звіт підписів (HR_SIGN_REPORT_TO).
"use strict";

const db = require("../db");

const WAW = "Europe/Warsaw";
const REPORT_TO = () => String(process.env.NO_PESEL_REPORT_TO || process.env.HR_SIGN_REPORT_TO || "")
  .split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /@/.test(x));
const escH = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dmyIso = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");

async function rows() {
  const r = await db.query(
    `SELECT w.full_name, f.name AS facility, to_char(v.bhp_date, 'YYYY-MM-DD') AS bhp
       FROM v_worker_current v
       JOIN workers w ON w.id = v.id
       LEFT JOIN facilities f ON f.id = v.facility_id
      WHERE v.status = 'pracuje' AND v.login NOT LIKE 'TEST_%' AND COALESCE(btrim(w.pesel), '') = ''`);
  const pl = (a, b) => (a == null) - (b == null) || String(a || "").localeCompare(String(b || ""), "pl");
  return r.rows.sort((a, b) => pl(a.facility, b.facility) || pl(a.full_name, b.full_name));
}

async function report() {
  const to = REPORT_TO();
  const mail = require("../api/mail");
  if (!to.length) return { ok: false, error: "no_recipients" };
  if (!mail.configured()) return { ok: false, error: "not_configured" };
  const list = await rows();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(new Date());
  const head = ["Nazwisko i imię", "Zakład", "Data BHP"];
  const th = (h) => `<th style="border:1px solid #c9d3e3;background:#e7eef8;padding:6px 8px;text-align:left">${escH(h)}</th>`;
  const td = (v) => `<td style="border:1px solid #d9dee8;padding:5px 8px;vertical-align:top">${v}</td>`;
  const table = list.length ? `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px">
<tr>${head.map(th).join("")}</tr>
${list.map((x) => `<tr>${td(escH(x.full_name))}${td(escH(x.facility || "—"))}${td(dmyIso(x.bhp))}</tr>`).join("\n")}
</table>` : "";
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1f2937">
<p>Dzień dobry,</p>
<p>${list.length ? `pracownicy ze statusem <b>pracuje</b> bez numeru <b>PESEL</b> w HRappka: <b>${list.length} os.</b> Ta sama lista jest w załączniku (Excel).` : `wszyscy pracownicy ze statusem pracuje mają PESEL.`}</p>
${table}
<p style="color:#8a94a6;font-size:12px">KoorPanel · ${dmyIso(today)}</p></div>`;
  const att = list.length ? [{
    name: `bez_pesel_${today}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: await mail.xlsx({ sheet: "Bez PESEL", header: head, widths: [32, 30, 12],
      rows: list.map((x) => [x.full_name, x.facility || "", dmyIso(x.bhp)]) }),
  }] : [];
  await mail.send({ to, subject: list.length ? `Pracownicy bez PESEL — ${dmyIso(today)} (${list.length} os.)` : `Bez PESEL — brak (${dmyIso(today)})`, html, attachments: att });
  console.log(`[pesel] звіт → ${to.join(", ")}: ${list.length} осіб`);
  return { ok: true, count: list.length, to };
}

function schedule() {
  const cron = require("node-cron");
  cron.schedule("0 9 * * 1", async () => {
    try { await report(); } catch (e) { console.error("[pesel] звіт:", e.message); }
  }, { timezone: WAW });
}

module.exports = { rows, report, schedule };
