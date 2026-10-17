// bot/office.js — «Відправити в офіс»: схвалені аванси, ще не надіслані, одним листом (таблиця в листі + Excel у вкладенні)
// вибраним адресатам. Адресати запамʼятовуються: спільні (додає адмін — бачать усі координатори) і свої.
// Лист іде зі скриньки MAIL_FROM через Microsoft 365 (api/mail.js); координатор — у копії, «Відповісти» — йому.
// Надіслані аванси позначаються (tgc.office_items) і вдруге не пропонуються.
"use strict";

const db = require("../db");
const mail = require("../api/mail");

const coord = () => require("./coord");
const WINDOW_DAYS = 31;                 // аванси, схвалені за останні 31 день (старіші — не пропонуємо)
const MAX_TO = 10;
const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[a-z]{2,}$/i;
const normEmail = (s) => String(s || "").trim().toLowerCase();
const isEmail = (s) => EMAIL_RE.test(String(s || "").trim()) && String(s).length <= 200;

const WAW = "Europe/Warsaw";
const dmy = (d) => (d ? new Intl.DateTimeFormat("pl-PL", { timeZone: WAW, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d)) : "");
const dmyIso = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

async function myEmail(c) {
  const r = await db.query(`SELECT to_jsonb(c)->>'email' AS email FROM public.coordinators c WHERE c.id = $1`, [c.id]);
  const e = r.rows[0] && r.rows[0].email;
  return isEmail(e) ? String(e).trim() : null;
}

// Схвалені й ще не надіслані — на обʼєктах, де координатор вирішує заявки (у межах обраного зрізу)
async function pendingAdvances(c, f0) {
  const f = f0 || (await coord().facsOf(c));
  const r = await db.query(
    `SELECT a.id, a.worker_id, w.full_name, w.login, fa.name AS facility, to_char(vw.bhp_date, 'YYYY-MM-DD') AS bhp,
            a.requested_at, a.approved_at, ac.full_name AS approved_by,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = a.worker_id
                       AND date_trunc('month', h.work_date) = date_trunc('month', COALESCE(a.requested_at, a.approved_at))), 0) AS hours
       FROM advances a
       JOIN workers w ON w.id = a.worker_id
       JOIN v_worker_current vw ON vw.id = a.worker_id
       LEFT JOIN facilities fa ON fa.id = vw.facility_id
       LEFT JOIN public.coordinators ac ON ac.id = a.approved_by
      WHERE a.status = 'approved'
        AND a.approved_at > now() - ($2 || ' days')::interval
        AND ($1::int[] IS NULL OR vw.facility_id = ANY($1))
        AND NOT EXISTS (SELECT 1 FROM tgc.office_items i JOIN tgc.office_mails m ON m.id = i.mail_id AND m.status = 'sent'
                         WHERE i.kind = 'adv' AND i.ref_id = a.id)
      ORDER BY fa.name NULLS LAST, w.full_name`,
    [f.edit, String(WINDOW_DAYS)],
  );
  return r.rows.map((x) => ({
    id: x.id, worker_id: x.worker_id, full_name: x.full_name, login: x.login, facility: x.facility || "—", bhp: x.bhp,
    requested_at: x.requested_at, approved_at: x.approved_at, approved_by: x.approved_by, hours: num(x.hours),
  }));
}
async function unsentCount(c, f) {
  try { return (await pendingAdvances(c, f)).length; } catch (e) { return 0; }   // до міграції — 0
}

// ── Адресати ──────────────────────────────────────────────────────────
async function recipients(c) {
  const r = await db.query(
    `SELECT id, email, name, coordinator_id IS NULL AS shared FROM tgc.mail_recipients
      WHERE coordinator_id IS NULL OR coordinator_id = $1 ORDER BY (coordinator_id IS NULL) DESC, lower(email)`, [c.id]);
  const p = await db.query(`SELECT mail_last FROM tgc.prefs WHERE coordinator_id = $1`, [c.id]);
  return { list: r.rows, last: (p.rows[0] && p.rows[0].mail_last) || [] };
}
async function addRecipient(c, email, name, shared) {
  const e = String(email || "").trim();
  if (!isEmail(e)) return { ok: false, error: "bad_email" };
  if (shared && !c.is_admin) return { ok: false, error: "admin_only" };
  const r = await db.query(
    `INSERT INTO tgc.mail_recipients (email, name, coordinator_id, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email), COALESCE(coordinator_id, 0)) DO UPDATE SET name = COALESCE(EXCLUDED.name, tgc.mail_recipients.name)
     RETURNING id, email, name, coordinator_id IS NULL AS shared`,
    [e, String(name || "").trim().slice(0, 80) || null, shared ? null : c.id, c.id]);
  return { ok: true, recipient: r.rows[0] };
}
async function removeRecipient(c, id) {
  const r = await db.query(
    `DELETE FROM tgc.mail_recipients WHERE id = $1 AND (coordinator_id = $2 OR (coordinator_id IS NULL AND $3::boolean)) RETURNING id`,
    [id, c.id, !!c.is_admin]);
  return { ok: r.rowCount > 0 };
}

async function history(c) {
  const r = await db.query(
    `SELECT id, sent_at, mail_to, items, total, status, error FROM tgc.office_mails
      WHERE sent_by = $1 AND kind = 'adv' ORDER BY id DESC LIMIT 10`, [c.id]);
  return r.rows;
}

// ── Лист ──────────────────────────────────────────────────────────────
const HEAD = ["Lp", "Nazwisko i imię", "Paszport", "Obiekt", "Data BHP", "Data wniosku", "Kwota (zł)", "Godziny (m-c wniosku)", "Zatwierdził"];
function tableRows(items, std) {
  return items.map((x, i) => [i + 1, x.full_name, x.login || "", x.facility, dmyIso(x.bhp), dmy(x.requested_at), std, x.hours, x.approved_by || ""]);
}
function html(c, rows, total, std) {
  const th = (s, right) => `<th style="border:1px solid #c9d3e3;background:#e7eef8;padding:6px 8px;text-align:${right ? "right" : "left"};font-weight:bold">${esc(s)}</th>`;
  const td = (s, right) => `<td style="border:1px solid #d9dee8;padding:5px 8px;text-align:${right ? "right" : "left"};white-space:nowrap">${esc(s)}</td>`;
  const right = [0, 6, 7];
  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1f2937">
<p>Dzień dobry,</p>
<p>przesyłam listę zatwierdzonych zaliczek do wypłaty: <b>${rows.length} os.</b>, łącznie <b>${total} zł</b> (${std} zł na osobę).
Ta sama lista jest w załączniku (Excel).</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px">
<tr>${HEAD.map((h, i) => th(h, right.includes(i))).join("")}</tr>
${rows.map((r) => `<tr>${r.map((v, i) => td(v, right.includes(i))).join("")}</tr>`).join("\n")}
<tr>${td("")}${`<td colspan="5" style="border:1px solid #d9dee8;padding:5px 8px;font-weight:bold">Razem</td>`}${`<td style="border:1px solid #d9dee8;padding:5px 8px;text-align:right;font-weight:bold">${total}</td>`}${td("", true)}${td("")}</tr>
</table>
<p>Pozdrawiam<br>${esc(c.full_name)}</p>
<p style="color:#8a94a6;font-size:12px">Wysłano z KoorPanel. Odpowiedź trafi do koordynatora.</p>
</div>`;
}

const BUSY = new Set();
async function sendAdvances(c, ids, to) {
  const toList = [...new Set((to || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!mail.configured()) return { ok: false, error: "not_configured" };
  if (!toList.length) return { ok: false, error: "no_recipients" };
  if (toList.length > MAX_TO || !toList.every(isEmail)) return { ok: false, error: "bad_email" };
  const want = new Set((ids || []).map((x) => parseInt(x, 10)).filter(Boolean));
  if (!want.size) return { ok: false, error: "no_items" };
  if (BUSY.has(c.id)) return { ok: false, error: "busy" };
  BUSY.add(c.id);
  try {
    const items = (await pendingAdvances(c)).filter((x) => want.has(x.id));
    if (items.length !== want.size) return { ok: false, error: "changed" };   // хтось уже надіслав / скасовано
    const std = coord().CFG.advanceStd;
    const rows = tableRows(items, std);
    const total = std * items.length;
    const me = await myEmail(c);
    const today = dmy(new Date());
    const subject = `Zaliczki do wypłaty — ${c.full_name} — ${today} (${items.length} os.)`;
    const file = await mail.xlsx({
      sheet: "Zaliczki", header: HEAD, rows,
      widths: [5, 30, 14, 26, 12, 13, 11, 12, 24],
      footer: ["", "Razem", "", "", "", "", total, "", ""],
    });
    const fileName = `zaliczki_${today.split(".").reverse().join("-")}_${String(c.full_name || "").split(/\s+/).pop()}.xlsx`
      .replace(/[^\w.\-]+/g, "_");
    let error = null;
    try {
      await mail.send({
        to: toList,
        cc: me && !toList.map(normEmail).includes(normEmail(me)) ? [me] : [],
        replyTo: me ? [me] : [],
        subject,
        html: html(c, rows, total, std),
        attachments: [{ name: fileName, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: file }],
      });
    } catch (e) {
      error = e.message;
    }
    const client = await db.pool.connect();
    let mailId = null;
    try {
      await client.query("BEGIN");
      mailId = (await client.query(
        `INSERT INTO tgc.office_mails (kind, sent_by, mail_to, mail_cc, subject, items, total, status, error)
         VALUES ('adv', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [c.id, toList, me ? [me] : [], subject, items.length, total, error ? "error" : "sent", error])).rows[0].id;
      for (const x of items) {
        await client.query(`INSERT INTO tgc.office_items (mail_id, kind, ref_id) VALUES ($1, 'adv', $2)`, [mailId, x.id]);
      }
      if (!error) {
        await client.query(
          `INSERT INTO tgc.prefs (coordinator_id, lang, mail_last) VALUES ($1, $2, $3)
           ON CONFLICT (coordinator_id) DO UPDATE SET mail_last = EXCLUDED.mail_last, updated_at = now()`,
          [c.id, coord().langOf(c), toList]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (error) {
      console.error(`[office] coordinator ${c.id}: ${error}`);
      return { ok: false, error: "send_failed", detail: error, mail_id: mailId };
    }
    console.log(`[office] coordinator ${c.id} → ${toList.join(", ")}: ${items.length} zaliczek`);
    return { ok: true, mail_id: mailId, count: items.length, total, cc: me };
  } finally {
    BUSY.delete(c.id);
  }
}

module.exports = { pendingAdvances, unsentCount, recipients, addRecipient, removeRecipient, history, sendAdvances, myEmail, isEmail, WINDOW_DAYS };
