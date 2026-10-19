// bot/office.js — листи в офіс одним листом (таблиця в листі + Excel у вкладенні) вибраним адресатам:
//   adv — «Відправити в офіс»: схвалені аванси за 31 день, ще не надіслані;
//   med — «Замовити медогляд»: хто починає роботу (BHP) у вибраний день / діапазон, ще не замовлені.
// Адресати запамʼятовуються окремо для кожного виду: спільні (додає адмін — бачать усі координатори) і свої.
// Лист іде з MAIL_FROM / GMAIL_USER (api/mail.js); координатор — у копії, «Відповісти» — йому.
// Надіслане позначається (tgc.office_items: adv — id авансу, med — id періоду worker_facility_history) і вдруге не пропонується.
// Використовують мініпанель (public/tg/) і веб-панель (public/js/office.js) — через api/tg.js.
"use strict";

const db = require("../db");
const mail = require("../api/mail");

const coord = () => require("./coord");
const WINDOW_DAYS = 31;                 // аванси, схвалені за останні 31 день (старіші — не пропонуємо)
const MED_MAX_DAYS = 31;                // медогляд: діапазон BHP — до 31 дня
const MAX_TO = 10;
const KINDS = ["adv", "med"];
const EMAIL_RE = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[a-z]{2,}$/i;
const normEmail = (s) => String(s || "").trim().toLowerCase();
const isEmail = (s) => EMAIL_RE.test(String(s || "").trim()) && String(s).length <= 200;
const kindOf = (k) => (KINDS.includes(k) ? k : "adv");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const WAW = "Europe/Warsaw";
const dmy = (d) => (d ? new Intl.DateTimeFormat("pl-PL", { timeZone: WAW, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d)) : "");
const dmyIso = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(new Date());
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

// Прізвище / імʼя: з таблиці (workers.last_name / first_name), а поки імпорт їх не заповнив — з full_name («NAZWISKO IMIĘ»)
function splitName(x) {
  if (x.last_name) return { last: x.last_name, first: x.first_name || "" };
  const p = String(x.full_name || "").trim().split(/\s+/);
  return { last: p[0] || "", first: p.slice(1).join(" ") };
}
// Дата медогляду = дата відправки, але не пізніше BHP
const medDate = (bhp, sentIso) => (bhp && bhp < sentIso ? bhp : sentIso);

async function myEmail(c) {
  const r = await db.query(`SELECT to_jsonb(c)->>'email' AS email FROM public.coordinators c WHERE c.id = $1`, [c.id]);
  const e = r.rows[0] && r.rows[0].email;
  return isEmail(e) ? String(e).trim() : null;
}
const SENT_SQL = (kind, ref) => `(SELECT max(m.sent_at) FROM tgc.office_items i JOIN tgc.office_mails m ON m.id = i.mail_id AND m.status = 'sent'
                                  WHERE i.kind = '${kind}' AND i.ref_id = ${ref})`;

// ── Аванси: схвалені й ще не надіслані — на обʼєктах, де координатор вирішує заявки (у межах зрізу) ──
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
        AND ${SENT_SQL("adv", "a.id")} IS NULL
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

// ── Медогляд: періоди з BHP у [from, to] на обʼєктах координатора (крім rezygnacja); замовлені — з позначкою ──
async function medList(c, f0, opts) {
  const f = f0 || (await coord().facsOf(c));
  const ids = opts && opts.ids ? opts.ids : null;
  const from = opts && opts.from, to = opts && opts.to;
  const r = await db.query(
    `SELECT h.id, h.worker_id, w.full_name, w.login, to_jsonb(w)->>'last_name' AS last_name, to_jsonb(w)->>'first_name' AS first_name,
            h.facility_id, fa.name AS facility, to_jsonb(h)->>'stanowisko' AS stanowisko, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp,
            h.status::text AS status, ${SENT_SQL("med", "h.id")} AS ordered_at
       FROM worker_facility_history h
       JOIN workers w ON w.id = h.worker_id
       LEFT JOIN facilities fa ON fa.id = h.facility_id
      WHERE h.status::text <> 'rezygnacja' AND h.bhp_date IS NOT NULL
        AND ($1::int[] IS NULL OR h.facility_id = ANY($1))
        AND w.login NOT LIKE 'TEST_%'
        AND ${ids ? "h.id = ANY($2::int[])" : "h.bhp_date BETWEEN $2::date AND $3::date"}
      ORDER BY h.bhp_date, fa.name NULLS LAST, w.full_name`,
    ids ? [f.edit, ids] : [f.edit, from, to],
  );
  const sent = todayIso();
  const set = await medFacSettings([...new Set(r.rows.map((x) => x.facility_id))]);
  return r.rows.map((x) => {
    const n = splitName(x);
    const s = set[x.facility_id] || {};
    return {
      id: x.id, worker_id: x.worker_id, full_name: x.full_name, last_name: n.last, first_name: n.first, login: x.login,
      facility: x.facility || "—", stanowisko: x.stanowisko || "", bhp: x.bhp, status: x.status,
      ordered_at: x.ordered_at, med_date: medDate(x.bhp, sent),
      med_kind: s.kind || "badanie", address: s.address || "",
    };
  });
}

// ── Медогляд: налаштування (db/migration_med_settings.sql) ─────────────
// Тип медогляду (колонка «Typ badania») і адреса закладу (колонка «Adres») — однакові для всіх працівників закладу.
// Панель «Badania lekarskie»: адмін / head і регіональні — завжди; координатори — якщо увімкнено в налаштуваннях.
const MED_KINDS = { badanie: "badanie", badanie_sanepid: "badanie + sanepid", sanepid: "sanepid" };
const ADDRESS_MAX = 300;
// Хто керує налаштуваннями: адмін / head — усе ({ regionIds: null }); регіональний — свої регіони; інші — null
async function medManager(c) {
  if (c.is_admin || c.role === "head") return { regionIds: null };
  const r = await db.query(
    `SELECT rl.region_id FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id
      WHERE rl.coordinator_id = $1 AND rg.is_active`, [c.id]).catch(() => ({ rows: [] }));
  return r.rows.length ? { regionIds: r.rows.map((x) => Number(x.region_id)) } : null;
}
async function medAccess(c) {
  if (await medManager(c)) return true;
  try {
    const r = await db.query(`SELECT enabled FROM tgc.med_coords WHERE coordinator_id = $1`, [c.id]);
    return !!(r.rows[0] && r.rows[0].enabled);
  } catch (e) {
    return true;   // міграції ще немає — як було: панель бачать усі
  }
}
// { facility_id: { kind, address } }; без міграції — порожньо (тип «badanie», адреси немає)
async function medFacSettings(ids) {
  if (!ids.length) return {};
  const r = await db.query(`SELECT facility_id, kind, address FROM tgc.med_facility WHERE facility_id = ANY($1::int[])`, [ids])
    .catch(() => ({ rows: [] }));
  return Object.fromEntries(r.rows.map((x) => [x.facility_id, x]));
}
// Заклади, якими керує c: регіон → координатор → обʼєкт → заклад (обʼєкти в архіві — ні)
const MED_SITES_SQL = `
  SELECT f.id AS facility_id, f.name AS facility, COALESCE(f.group_name, f.name) AS object,
         so.region_id, rg.name AS region, so.coordinator_id, co.full_name AS coordinator
    FROM facilities f
    LEFT JOIN reg.site_owner so      ON so.site_key = reg.site_key(f.group_name, f.name) AND so.valid_to IS NULL
    LEFT JOIN reg.regions rg         ON rg.id = so.region_id
    LEFT JOIN public.coordinators co ON co.id = so.coordinator_id
   WHERE ($1::int[] IS NULL OR so.region_id = ANY($1::int[]))
     AND NOT EXISTS (SELECT 1 FROM reg.site_archive a WHERE a.site_key = reg.site_key(f.group_name, f.name))`;
async function medSettings(c) {
  const m = await medManager(c);
  if (!m) return null;
  const r = await db.query(
    `WITH s AS (${MED_SITES_SQL})
     SELECT s.*, COALESCE(mc.enabled, false) AS enabled, COALESCE(mf.kind, 'badanie') AS kind, mf.address,
            (co.role = 'head'
              OR EXISTS (SELECT 1 FROM coordinator_auth ca WHERE ca.coordinator_id = s.coordinator_id AND ca.is_admin)
              OR EXISTS (SELECT 1 FROM reg.region_leads rl WHERE rl.coordinator_id = s.coordinator_id)) AS always
       FROM s
       LEFT JOIN public.coordinators co ON co.id = s.coordinator_id
       LEFT JOIN tgc.med_coords mc      ON mc.coordinator_id = s.coordinator_id
       LEFT JOIN tgc.med_facility mf    ON mf.facility_id = s.facility_id`, [m.regionIds]);
  const pl = (a, b) => (a == null) - (b == null) || String(a || "").localeCompare(String(b || ""), "pl");
  r.rows.sort((a, b) => pl(a.region, b.region) || pl(a.coordinator, b.coordinator) || pl(a.object, b.object) || pl(a.facility, b.facility));
  return { rows: r.rows.map((x) => ({ ...x, always: !!x.always })), kinds: MED_KINDS, address_max: ADDRESS_MAX, all: m.regionIds == null };
}
// Чи заклад / координатор у межах керування c
async function medInScope(m, where, id) {
  if (m.regionIds == null) return true;
  const r = await db.query(`SELECT 1 FROM (${MED_SITES_SQL}) s WHERE s.${where} = $2 LIMIT 1`, [m.regionIds, id]);
  return r.rows.length > 0;
}
async function medSaveCoord(c, coordinatorId, enabled) {
  const m = await medManager(c);
  const id = parseInt(coordinatorId, 10);
  if (!m) return { ok: false, error: "forbidden" };
  if (!id || !(await medInScope(m, "coordinator_id", id))) return { ok: false, error: "forbidden" };
  await db.query(
    `INSERT INTO tgc.med_coords (coordinator_id, enabled, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (coordinator_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, !!enabled, c.id]);
  return { ok: true };
}
async function medSaveFacility(c, facilityId, kind, address) {
  const m = await medManager(c);
  const id = parseInt(facilityId, 10);
  if (!m) return { ok: false, error: "forbidden" };
  if (!MED_KINDS[kind]) return { ok: false, error: "bad_kind" };
  const addr = String(address == null ? "" : address).replace(/\s+/g, " ").trim();
  if (addr.length > ADDRESS_MAX) return { ok: false, error: "address_too_long" };
  if (!id || !(await medInScope(m, "facility_id", id))) return { ok: false, error: "forbidden" };
  await db.query(
    `INSERT INTO tgc.med_facility (facility_id, kind, address, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (facility_id) DO UPDATE SET kind = EXCLUDED.kind, address = EXCLUDED.address, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, kind, addr || null, c.id]);
  return { ok: true };
}
function medRange(from, to) {
  const t = todayIso();
  let a = ISO.test(String(from || "")) ? String(from) : t;
  let b = ISO.test(String(to || "")) ? String(to) : a;
  if (b < a) [a, b] = [b, a];
  if ((new Date(b) - new Date(a)) / 864e5 > MED_MAX_DAYS) return { error: "range_too_long" };
  return { from: a, to: b };
}

// ── Адресати (окремо для авансів і медогляду) ─────────────────────────
async function recipients(c, kind) {
  kind = kindOf(kind);
  const r = await db.query(
    `SELECT id, email, name, coordinator_id IS NULL AS shared FROM tgc.mail_recipients
      WHERE kind = $2 AND (coordinator_id IS NULL OR coordinator_id = $1)
      ORDER BY (coordinator_id IS NULL) DESC, lower(email)`, [c.id, kind]);
  const p = await db.query(`SELECT mail_last, mail_last_med FROM tgc.prefs WHERE coordinator_id = $1`, [c.id]);
  const row = p.rows[0] || {};
  return { list: r.rows, last: (kind === "med" ? row.mail_last_med : row.mail_last) || [] };
}
async function addRecipient(c, email, name, shared, kind) {
  kind = kindOf(kind);
  const e = String(email || "").trim();
  if (!isEmail(e)) return { ok: false, error: "bad_email" };
  if (shared && !c.is_admin) return { ok: false, error: "admin_only" };
  const r = await db.query(
    `INSERT INTO tgc.mail_recipients (kind, email, name, coordinator_id, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, lower(email), COALESCE(coordinator_id, 0)) DO UPDATE SET name = COALESCE(EXCLUDED.name, tgc.mail_recipients.name)
     RETURNING id, email, name, coordinator_id IS NULL AS shared`,
    [kind, e, String(name || "").trim().slice(0, 80) || null, shared ? null : c.id, c.id]);
  return { ok: true, recipient: r.rows[0] };
}
async function removeRecipient(c, id) {
  const r = await db.query(
    `DELETE FROM tgc.mail_recipients WHERE id = $1 AND (coordinator_id = $2 OR (coordinator_id IS NULL AND $3::boolean)) RETURNING id`,
    [id, c.id, !!c.is_admin]);
  return { ok: r.rowCount > 0 };
}

async function history(c, kind) {
  const r = await db.query(
    `SELECT id, sent_at, mail_to, items, total, status, error FROM tgc.office_mails
      WHERE sent_by = $1 AND kind = $2 ORDER BY id DESC LIMIT 10`, [c.id, kindOf(kind)]);
  return r.rows;
}

// ── Листи ─────────────────────────────────────────────────────────────
const HEAD = {
  adv: ["Lp", "Nazwisko i imię", "Paszport", "Obiekt", "Data BHP", "Data wniosku", "Kwota (zł)", "Godziny (m-c wniosku)", "Zatwierdził"],
  med: ["Lp", "Nazwisko", "Imię", "Paszport", "Przedsiębiorstwo", "Stanowisko", "Data BHP", "Data badania", "Typ badania", "Koordynator", "Adres"],
};
const WIDTHS = { adv: [5, 30, 14, 26, 12, 13, 11, 12, 24], med: [5, 20, 18, 14, 26, 22, 12, 13, 18, 24, 30] };
const RIGHT = { adv: [0, 6, 7], med: [0] };

function rowsOf(kind, items, std, sentIso, c) {
  if (kind === "med") {
    return items.map((x, i) => [i + 1, x.last_name, x.first_name, x.login || "", x.facility, x.stanowisko || "",
      dmyIso(x.bhp), dmyIso(medDate(x.bhp, sentIso)), MED_KINDS[x.med_kind] || MED_KINDS.badanie,
      (c && c.full_name) || "", x.address || ""]);   // Koordynator — хто замовляє; тип і адреса — з налаштувань закладу
  }
  return items.map((x, i) => [i + 1, x.full_name, x.login || "", x.facility, dmyIso(x.bhp), dmy(x.requested_at), std, x.hours, x.approved_by || ""]);
}
function tableHtml(kind, rows, totalRow) {
  const th = (s, right) => `<th style="border:1px solid #c9d3e3;background:#e7eef8;padding:6px 8px;text-align:${right ? "right" : "left"};font-weight:bold">${esc(s)}</th>`;
  const td = (s, right) => `<td style="border:1px solid #d9dee8;padding:5px 8px;text-align:${right ? "right" : "left"};white-space:nowrap">${esc(s)}</td>`;
  const right = RIGHT[kind];
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px">
<tr>${HEAD[kind].map((h, i) => th(h, right.includes(i))).join("")}</tr>
${rows.map((r) => `<tr>${r.map((v, i) => td(v, right.includes(i))).join("")}</tr>`).join("\n")}
${totalRow || ""}
</table>`;
}
const wrapHtml = (c, intro, table) => `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1f2937">
<p>Dzień dobry,</p>
<p>${intro}</p>
${table}
<p>Pozdrawiam<br>${esc(c.full_name)}</p>
<p style="color:#8a94a6;font-size:12px">Wysłano z KoorPanel. Odpowiedź trafi do koordynatora.</p>
</div>`;
const fileDate = (iso) => iso;   // YYYY-MM-DD у назві файлу
const lastWord = (s) => String(s || "").trim().split(/\s+/).pop() || "";

const BUSY = new Set();
// kind: adv | med. ids — аванси (adv) або періоди history (med). f — зріз (facsOf). Повертає { ok, count, … } або { ok:false, error }.
async function send(kind, c, ids, to, f0) {
  kind = kindOf(kind);
  const toList = [...new Set((to || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!mail.configured()) return { ok: false, error: "not_configured" };
  if (!toList.length) return { ok: false, error: "no_recipients" };
  if (toList.length > MAX_TO || !toList.every(isEmail)) return { ok: false, error: "bad_email" };
  const want = new Set((ids || []).map((x) => parseInt(x, 10)).filter(Boolean));
  if (!want.size) return { ok: false, error: "no_items" };
  const lockKey = `${kind}:${c.id}`;
  if (BUSY.has(lockKey)) return { ok: false, error: "busy" };
  BUSY.add(lockKey);
  try {
    const f = f0 || (await coord().facsOf(c));
    let items;
    if (kind === "adv") items = (await pendingAdvances(c, f)).filter((x) => want.has(x.id));
    else items = (await medList(c, f, { ids: [...want] })).filter((x) => !x.ordered_at);
    if (items.length !== want.size) return { ok: false, error: "changed" };   // хтось уже надіслав / змінилось
    const std = coord().CFG.advanceStd;
    const sentIso = todayIso();
    const rows = rowsOf(kind, items, std, sentIso, c);
    const me = await myEmail(c);
    let subject, html, file, total = null;
    if (kind === "adv") {
      total = std * items.length;
      subject = `Zaliczki do wypłaty — ${c.full_name} — ${dmyIso(sentIso)} (${items.length} os.)`;
      const totalRow = `<tr><td style="border:1px solid #d9dee8;padding:5px 8px"></td><td colspan="5" style="border:1px solid #d9dee8;padding:5px 8px;font-weight:bold">Razem</td>
<td style="border:1px solid #d9dee8;padding:5px 8px;text-align:right;font-weight:bold">${total}</td><td style="border:1px solid #d9dee8"></td><td style="border:1px solid #d9dee8"></td></tr>`;
      html = wrapHtml(c, `przesyłam listę zatwierdzonych zaliczek do wypłaty: <b>${items.length} os.</b>, łącznie <b>${total} zł</b> (${std} zł na osobę). Ta sama lista jest w załączniku (Excel).`,
        tableHtml("adv", rows, totalRow));
      file = {
        name: `zaliczki_${fileDate(sentIso)}_${lastWord(c.full_name)}.xlsx`,
        content: await mail.xlsx({ sheet: "Zaliczki", header: HEAD.adv, rows, widths: WIDTHS.adv, footer: ["", "Razem", "", "", "", "", total, "", ""] }),
      };
    } else {
      const bhps = items.map((x) => x.bhp).sort();
      const range = bhps[0] === bhps[bhps.length - 1] ? dmyIso(bhps[0]) : `${dmyIso(bhps[0])}–${dmyIso(bhps[bhps.length - 1])}`;
      subject = `Badania lekarskie — BHP ${range} — ${c.full_name} (${items.length} os.)`;
      html = wrapHtml(c, `proszę o wykonanie wstępnych badań lekarskich dla <b>${items.length} os.</b> (rozpoczęcie pracy / BHP: ${range}). Ta sama lista jest w załączniku (Excel).`,
        tableHtml("med", rows));
      file = {
        name: `badania_${fileDate(sentIso)}_${lastWord(c.full_name)}.xlsx`,
        content: await mail.xlsx({ sheet: "Badania", header: HEAD.med, rows, widths: WIDTHS.med }),
      };
    }
    let error = null;
    try {
      await mail.send({
        to: toList,
        cc: me && !toList.map(normEmail).includes(normEmail(me)) ? [me] : [],
        replyTo: me ? [me] : [],
        subject,
        html,
        attachments: [{ name: file.name.replace(/[^\w.\-]+/g, "_"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: file.content }],
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [kind, c.id, toList, me ? [me] : [], subject, items.length, total, error ? "error" : "sent", error])).rows[0].id;
      for (const x of items) {
        await client.query(`INSERT INTO tgc.office_items (mail_id, kind, ref_id) VALUES ($1, $2, $3)`, [mailId, kind, x.id]);
      }
      if (!error) {
        const col = kind === "med" ? "mail_last_med" : "mail_last";
        await client.query(
          `INSERT INTO tgc.prefs (coordinator_id, lang, ${col}) VALUES ($1, $2, $3)
           ON CONFLICT (coordinator_id) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_at = now()`,
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
      console.error(`[office] ${kind} coordinator ${c.id}: ${error}`);
      return { ok: false, error: "send_failed", detail: error, mail_id: mailId };
    }
    console.log(`[office] ${kind} coordinator ${c.id} → ${toList.join(", ")}: ${items.length}`);
    return { ok: true, mail_id: mailId, count: items.length, total, cc: me };
  } finally {
    BUSY.delete(lockKey);
  }
}
const sendAdvances = (c, ids, to, f) => send("adv", c, ids, to, f);

module.exports = {
  pendingAdvances, unsentCount, medList, medRange, recipients, addRecipient, removeRecipient, history,
  send, sendAdvances, myEmail, isEmail, medDate, splitName, WINDOW_DAYS, MED_MAX_DAYS, KINDS,
  medAccess, medManager, medSettings, medSaveCoord, medSaveFacility, MED_KINDS,
};
