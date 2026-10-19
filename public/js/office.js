// public/js/office.js — panel (wersja web):
//   • Zaliczki → «✉ Wyślij do biura»: zatwierdzone zaliczki z 31 dni, jeszcze niewysłane, jednym mailem (tabela + Excel);
//   • strona «🩺 Badania lekarskie»: osoby z BHP w wybrany dzień / zakres → zamówienie badań jednym mailem.
// Te same dane i adresaci co w mini-panelu Telegram (api/tg.js → bot/office.js). Wysłane są oznaczane i nie wracają.
// Adresaci osobno dla zaliczek i badań: wspólni (dodaje admin) + własni; ostatnio wybrani — zaznaczeni od razu.
"use strict";

const OFC = { adv: null, med: null, range: null, scope: { adv: null, med: null } };
const ofcEsc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ofcToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const ofcAdd = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ofcDmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
const ofcDhm = (ts) => {
  if (!ts) return "—";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};
const ofcMedDate = (bhp) => { const t = ofcToday(); return bhp && bhp < t ? bhp : t; };
const OFC_ERR = {
  not_configured: "Poczta nie jest skonfigurowana", no_recipients: "Wybierz adresata", bad_email: "Nieprawidłowy adres e-mail",
  no_items: "Zaznacz osoby", changed: "Lista się zmieniła (ktoś już wysłał) — odświeżono", busy: "Mail jest już wysyłany",
  admin_only: "Wspólnych adresatów dodaje admin",
  med_off: "Panel badań nie jest dla Ciebie włączony (Ustawienia badań)", forbidden: "Brak dostępu",
  bad_kind: "Nieprawidłowy typ badania", address_too_long: "Adres jest za długi", send_failed: "Nie udało się wysłać", range_too_long: "Zakres — maks. 31 dni",
};
const OFC_WHY = {
  no_nodemailer: "Na serwerze: npm install nodemailer, potem pm2 restart index.",
  no_gmail: "W .env brak GMAIL_USER lub GMAIL_APP_PASSWORD.",
  no_microsoft: "W .env brak MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MAIL_FROM.",
};
const OFC_SCOPE = { own: "Moje obiekty", region: "Region", all: "Cała firma" };
const ofcBox = (kind) => document.getElementById(kind === "med" ? "medBox" : "ofcModalBody");
function ofcToast(text, bad) {
  const t = document.createElement("div");
  t.textContent = text;
  t.className = "ofc-toast" + (bad ? " bad" : "");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function ofcQuick(k) {
  const t0 = ofcToday();
  const dow = new Date(t0 + "T12:00:00Z").getUTCDay();
  const mon = ofcAdd(t0, -((dow + 6) % 7));
  if (k === "today") return { from: t0, to: t0 };
  if (k === "tomorrow") { const d = ofcAdd(t0, 1); return { from: d, to: d }; }
  if (k === "week") return { from: mon, to: ofcAdd(mon, 6) };
  if (k === "next") return { from: ofcAdd(mon, 7), to: ofcAdd(mon, 13) };
  return OFC.range;
}

async function ofcLoad(kind, keepSel) {
  const box = ofcBox(kind);
  if (!box) return;
  if (!OFC[kind]) box.innerHTML = `<div class="ofc-empty">Ładowanie…</div>`;
  let q = `/api/tg/office?kind=${kind}`;
  if (OFC.scope[kind]) q += `&scope=${OFC.scope[kind]}`;
  if (kind === "med") {
    if (!OFC.range) OFC.range = ofcQuick("today");
    q += `&from=${OFC.range.from}&to=${OFC.range.to}`;
  }
  let r = null;
  try { r = await apiFetch(q); } catch (e) { r = null; }
  if (!r || !r.ok) {
    if (r && r.error === "Unauthorized") return;
    box.innerHTML = `<div class="ofc-empty">${ofcEsc((r && (OFC_ERR[r.error] || r.error)) || "Brak połączenia z serwerem")}</div>`;
    return;
  }
  const prev = OFC[kind];
  const free = r.items.filter((x) => !x.ordered_at).map((x) => x.id);
  const sel = new Set(keepSel && prev ? free.filter((id) => prev.sel.has(id)) : free);
  let to;
  if (keepSel && prev) to = prev.to;
  else {
    const known = new Set(r.recipients.map((x) => x.email.toLowerCase()));
    to = new Set((r.last || []).filter((e) => known.has(String(e).toLowerCase())).map((e) => String(e).toLowerCase()));
  }
  OFC[kind] = { data: r, sel, to };
  ofcDraw(kind);
}

function ofcDraw(kind) {
  const o = OFC[kind];
  const box = ofcBox(kind);
  if (!o || !box) return;
  const r = o.data;
  const med = kind === "med";
  const std = r.advance_std || 300;
  const free = r.items.filter((x) => !x.ordered_at);
  const n = free.filter((x) => o.sel.has(x.id)).length;
  const canSend = r.configured && n > 0 && o.to.size > 0;
  const allOn = free.length > 0 && n === free.length;
  const head = med
    ? ["Nazwisko", "Imię", "Paszport", "Obiekt", "Stanowisko", "Data BHP", "Data badania", "Status"]
    : ["Pracownik", "Paszport", "Obiekt", "Data BHP", "Data wniosku", "Zatwierdzono", "Godziny"];
  const row = (x) => {
    const done = !!x.ordered_at;
    const cb = `<input type="checkbox" ${done ? "disabled" : o.sel.has(x.id) ? "checked" : ""} onchange="ofcPick('${kind}', ${x.id}, this.checked)" />`;
    const cells = med
      ? [x.last_name, x.first_name, `<span class="ofc-mono">${ofcEsc(x.login)}</span>`, x.facility, x.stanowisko || "—", ofcDmy(x.bhp),
        done ? "—" : ofcDmy(ofcMedDate(x.bhp)), done ? `<span class="ofc-ok">✉ zamówiono ${ofcEsc(ofcDhm(x.ordered_at))}</span>` : `<span class="ofc-dim">do zamówienia</span>`]
      : [x.full_name, `<span class="ofc-mono">${ofcEsc(x.login)}</span>`, x.facility, ofcDmy(x.bhp), ofcDhm(x.requested_at),
        `${ofcEsc(ofcDhm(x.approved_at))}<div class="ofc-dim">${ofcEsc(x.approved_by || "")}</div>`, x.hours];
    const raw = med ? [0, 1, 3, 4, 5] : [0, 2, 3, 4, 6];
    return `<tr class="${done ? "done" : ""}"><td>${cb}</td>${cells.map((v, i) => `<td>${raw.includes(i) ? ofcEsc(v) : v}</td>`).join("")}</tr>`;
  };
  const rcpt = (x) => {
    const on = o.to.has(x.email.toLowerCase());
    const del = !x.shared || r.is_admin;
    return `<span class="ofc-chip ${on ? "on" : ""}"><button onclick="ofcTo('${kind}', '${ofcEsc(x.email.toLowerCase())}')">${on ? "✓ " : ""}${ofcEsc(x.name ? `${x.name} · ${x.email}` : x.email)}${x.shared ? ` <em>biuro / wspólny</em>` : ""}</button>${
      del ? `<button class="x" title="Usuń adresata" onclick="ofcDel('${kind}', ${x.id}, '${ofcEsc(x.email)}')">✕</button>` : ""}</span>`;
  };
  const rng = OFC.range || {};
  const quick = (k, label) => {
    const q = ofcQuick(k);
    return `<button class="btn btn-ghost btn-sm ${q.from === rng.from && q.to === rng.to ? "ofc-on" : ""}" onclick="ofcQuickSet('${k}')">${label}</button>`;
  };
  box.innerHTML = `
    ${r.configured ? "" : `<div class="ofc-warn">Poczta nie jest jeszcze skonfigurowana — listę można przejrzeć, „Wyślij” zadziała po konfiguracji.${
      r.mail && OFC_WHY[r.mail.reason] ? `<br>${ofcEsc(OFC_WHY[r.mail.reason])}` : ""}</div>`}
    <div class="ofc-bar">
      ${r.scopes && r.scopes.length > 1 ? `<label>Zakres <select onchange="ofcScope('${kind}', this.value)">${r.scopes.map((s) =>
        `<option value="${s}" ${s === r.scope ? "selected" : ""}>${OFC_SCOPE[s] || s}</option>`).join("")}</select></label>` : ""}
      ${med ? `<span class="ofc-lbl">BHP</span>
        <label>od <input type="date" value="${ofcEsc(rng.from)}" onchange="ofcDates(this.value, null)" /></label>
        <label>do <input type="date" value="${ofcEsc(rng.to)}" onchange="ofcDates(null, this.value)" /></label>
        ${quick("today", "Dziś")}${quick("tomorrow", "Jutro")}${quick("week", "Ten tydzień")}${quick("next", "Następny tydzień")}`
        : `<span class="ofc-dim">Zatwierdzone zaliczki z ostatnich ${r.window_days || 31} dni, jeszcze niewysłane · ${std} zł / os.</span>`}
    </div>
    <div class="table-wrap ofc-table"><table>
      <thead><tr><th style="width:32px">${free.length ? `<input type="checkbox" ${allOn ? "checked" : ""} onchange="ofcAll('${kind}', this.checked)" title="Zaznacz wszystkie" />` : ""}</th>
        ${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${r.items.length ? r.items.map(row).join("")
        : `<tr><td colspan="${head.length + 1}" class="ofc-empty">${med ? "W tych dniach nikt nie zaczyna pracy na Twoich obiektach." : "Wszystkie zatwierdzone zaliczki zostały już wysłane."}</td></tr>`}</tbody>
    </table></div>
    <div class="ofc-sec">
      <div class="ofc-h">${med ? "Do kogo (klinika)" : "Do kogo (biuro)"}</div>
      <div class="ofc-chips">${r.recipients.map(rcpt).join("") || `<span class="ofc-dim">Brak zapisanych adresatów — dodaj poniżej.</span>`}</div>
      <div class="ofc-add">
        <input id="ofcEmail_${kind}" type="email" placeholder="adres e-mail" onkeydown="if(event.key==='Enter')ofcAddRcpt('${kind}')" />
        <button class="btn btn-ghost btn-sm" onclick="ofcAddRcpt('${kind}')">Dodaj</button>
        ${r.is_admin ? `<label class="ofc-dim"><input id="ofcShared_${kind}" type="checkbox" /> dla wszystkich koordynatorów</label>` : ""}
      </div>
      <div class="ofc-dim">${r.my_email ? `Kopia i odpowiedzi: ${ofcEsc(r.my_email)}` : "Brak e-maila w Twojej karcie (Admin → Koordynatorzy) — kopii nie będzie."}${
        r.from ? ` · Od: ${ofcEsc(r.from)}` : ""}${med ? " · Data badania w mailu = data wysyłki, ale nie później niż BHP." : ""}</div>
    </div>
    <div class="ofc-send">
      <span>${n} os.${med ? "" : ` · razem ${n * std} zł`} · tabela w mailu + Excel</span>
      <button class="btn btn-primary" id="ofcSend_${kind}" ${canSend ? "" : "disabled"} onclick="ofcSend('${kind}')">${med ? "✉ Zamów badania" : "✉ Wyślij do biura"}</button>
    </div>
    ${r.history && r.history.length ? `<div class="ofc-sec"><div class="ofc-h">Wysłane wcześniej</div><table class="ofc-hist">
      ${r.history.map((h) => `<tr><td>${ofcEsc(ofcDhm(h.sent_at))}</td><td>${h.items} os.${h.total ? ` · ${ofcEsc(String(h.total))} zł` : ""}</td>
        <td>${ofcEsc((h.mail_to || []).join(", "))}</td><td>${h.status === "sent" ? `<span class="ofc-ok">wysłano</span>` : `<span class="ofc-bad">błąd: ${ofcEsc(h.error || "")}</span>`}</td></tr>`).join("")}
    </table></div>` : ""}`;
}

function ofcPick(kind, id, on) { const o = OFC[kind]; if (on) o.sel.add(id); else o.sel.delete(id); ofcDraw(kind); }
function ofcAll(kind, on) { const o = OFC[kind]; o.sel = new Set(on ? o.data.items.filter((x) => !x.ordered_at).map((x) => x.id) : []); ofcDraw(kind); }
function ofcTo(kind, email) { const o = OFC[kind]; if (o.to.has(email)) o.to.delete(email); else o.to.add(email); ofcDraw(kind); }
function ofcScope(kind, s) { OFC.scope[kind] = s; OFC[kind] = null; ofcLoad(kind, false); }
function ofcQuickSet(k) { OFC.range = ofcQuick(k); ofcLoad("med", false); }
function ofcDates(from, to) {
  const r = Object.assign({}, OFC.range);
  if (from) r.from = from;
  if (to) r.to = to;
  if (r.to < r.from) { if (from) r.to = r.from; else r.from = r.to; }
  OFC.range = r;
  ofcLoad("med", false);
}
async function ofcAddRcpt(kind) {
  const el = document.getElementById(`ofcEmail_${kind}`);
  const email = (el && el.value || "").trim();
  if (!email) return;
  const sh = document.getElementById(`ofcShared_${kind}`);
  const r = await apiFetch("/api/tg/office/recipients", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, email, shared: !!(sh && sh.checked) }),
  }).catch(() => null);
  if (!r || !r.ok) return ofcToast((r && OFC_ERR[r.error]) || "Nie udało się dodać", true);
  const o = OFC[kind];
  if (!o.data.recipients.some((x) => x.id === r.recipient.id)) o.data.recipients.push(r.recipient);
  o.to.add(r.recipient.email.toLowerCase());
  ofcDraw(kind);
}
async function ofcDel(kind, id, email) {
  if (!confirm(`Usunąć adresata ${email}?`)) return;
  const r = await apiFetch(`/api/tg/office/recipients/${id}`, { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) return ofcToast("Nie udało się usunąć", true);
  const o = OFC[kind];
  o.data.recipients = o.data.recipients.filter((x) => x.id !== id);
  o.to.delete(String(email).toLowerCase());
  ofcDraw(kind);
}
async function ofcSend(kind) {
  const o = OFC[kind];
  const ids = o.data.items.filter((x) => !x.ordered_at && o.sel.has(x.id)).map((x) => x.id);
  const to = o.data.recipients.filter((x) => o.to.has(x.email.toLowerCase())).map((x) => x.email);
  const btn = document.getElementById(`ofcSend_${kind}`);
  if (btn) { btn.disabled = true; btn.textContent = "Wysyłanie…"; }
  const r = await apiFetch("/api/tg/office/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ids, to, scope: OFC.scope[kind] || undefined }),
  }).catch(() => null);
  if (r && r.ok) {
    ofcToast(kind === "med" ? `Zamówienie wysłane: ${r.count} os.` : `Wysłano do biura: ${r.count} os. · ${r.total} zł`);
    await ofcLoad(kind, false);
    if (kind === "adv") ofcCount();
    return;
  }
  const e = r && r.error;
  ofcToast(`${OFC_ERR[e] || "Brak połączenia z serwerem"}${r && r.detail ? `: ${r.detail}` : ""}`, true);
  await ofcLoad(kind, e !== "changed");
}

// ── Zaliczki: przycisk «✉ Wyślij do biura (N)» i okno ─────────────────
function openOfficeModal() {
  let ov = document.getElementById("ofcOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "ofcOverlay";
    ov.className = "ofc-overlay";
    ov.innerHTML = `<div class="ofc-modal" role="dialog" aria-label="Wyślij zaliczki do biura">
        <div class="ofc-mh"><b>✉ Wyślij zaliczki do biura</b><button class="btn btn-ghost btn-sm" onclick="closeOfficeModal()">✕ Zamknij</button></div>
        <div id="ofcModalBody" class="ofc-box"></div></div>`;
    ov.addEventListener("click", (e) => { if (e.target === ov) closeOfficeModal(); });
    document.body.appendChild(ov);
  }
  ov.style.display = "flex";
  OFC.adv = null;
  ofcLoad("adv", false);
}
function closeOfficeModal() {
  const ov = document.getElementById("ofcOverlay");
  if (ov) ov.style.display = "none";
}
async function ofcCount() {
  const b = document.getElementById("advOfficeBtn");
  if (!b) return;
  try {
    const r = await apiFetch(`/api/tg/office?kind=adv`);
    if (!r || !r.ok) { b.style.display = "none"; return; }
    b.style.display = "";
    b.textContent = `✉ Wyślij do biura${r.items.length ? ` (${r.items.length})` : ""}`;
  } catch (e) { b.style.display = "none"; }   // brak api/tg.js na serwerze — bez przycisku
}
// po każdym wczytaniu listy zaliczek — odśwież licznik na przycisku
if (typeof loadAdvances === "function") {
  const ofcOrigLoadAdvances = loadAdvances;
  // eslint-disable-next-line no-global-assign
  loadAdvances = async function () {
    const res = await ofcOrigLoadAdvances.apply(this, arguments);
    ofcCount();
    return res;
  };
}

// ── Strona «Badania lekarskie» ─────────────────────────────────────────
function loadMedicalPage() {
  ofcLoad("med", !!OFC.med);
}

// ── Ustawienia badań (admin i regionalni): komu panel badań, typ badania i adres zakładu ──────────
// Jedna tabela: region → koordynator → obiekt → zakład. Panel włącza się koordynatorowi (pierwszy wiersz jego grupy),
// typ i adres — dla zakładu; trafiają do kolumn «Typ badania» i «Adres» w mailu i Excelu.
const MEDSET = { data: null, q: "" };
async function loadMedSettingsPage() {
  const box = document.getElementById("medSetBox");
  box.innerHTML = `<div class="ofc-empty">Ładowanie…</div>`;
  let r;
  try { r = await apiFetch("/api/tg/office/med-settings"); } catch (e) { r = null; }
  if (!r || !r.ok) { box.innerHTML = `<div class="ofc-bad">${ofcEsc((r && (OFC_ERR[r.error] || r.error)) || "Błąd")}</div>`; return; }
  MEDSET.data = r;
  box.innerHTML = `
    <div class="ofc-bar">
      <input type="text" id="medSetQ" placeholder="Szukaj: obiekt, zakład, koordynator…" value="${ofcEsc(MEDSET.q)}"
        oninput="MEDSET.q=this.value;drawMedSettings()" style="min-width:260px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 9px;border-radius:6px;font-size:12px">
      <span class="ofc-dim">${r.all ? "cała firma" : "Twoje regiony"} · zapis od razu po zmianie</span>
    </div>
    <div class="ofc-table" style="max-height:none"><table><thead><tr>
      <th style="text-align:left">Koordynator</th><th>Panel badań</th><th style="text-align:left">Obiekt / zakład</th>
      <th style="text-align:left">Typ badania</th><th style="text-align:left">Adres (dla wszystkich z zakładu)</th><th></th>
    </tr></thead><tbody id="medSetBody"></tbody></table></div>
    <div class="ofc-dim">Panel badań: admin, kierownictwo i koordynatorzy regionalni widzą go zawsze. Koordynator bez obiektu nie pojawia się w tabeli.</div>`;
  drawMedSettings();
}
function drawMedSettings() {
  const r = MEDSET.data;
  const q = MEDSET.q.trim().toLowerCase();
  const rows = r.rows.filter((x) => !q || [x.object, x.facility, x.coordinator, x.region].some((s) => (s || "").toLowerCase().includes(q)));
  const body = document.getElementById("medSetBody");
  if (!rows.length) { body.innerHTML = `<tr><td colspan="6" class="ofc-empty">Nic nie znaleziono</td></tr>`; return; }
  const multiReg = new Set(rows.map((x) => x.region || null)).size > 1;
  const kinds = Object.entries(r.kinds);
  let reg, co, html = "";
  rows.forEach((x) => {
    const rg = x.region || null;
    if (multiReg && rg !== reg) {
      html += `<tr><td colspan="6" style="background:var(--surface2);font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text3)">📍 ${ofcEsc(rg || "Bez regionu")}</td></tr>`;
      reg = rg; co = undefined;
    }
    const first = x.coordinator_id !== co;
    co = x.coordinator_id;
    const panel = !first ? "" : !x.coordinator_id ? `<span class="ofc-dim">—</span>`
      : x.always ? `<span class="ofc-dim" title="Admin / kierownik / regionalny — zawsze">zawsze</span>`
      : `<label style="display:inline-flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" ${x.enabled ? "checked" : ""}
           onchange="medSetCoord(${x.coordinator_id}, this)"> <span>${x.enabled ? "włączony" : "wyłączony"}</span></label>`;
    const name = x.object === x.facility ? ofcEsc(x.facility) : `${ofcEsc(x.object)} <span class="ofc-dim">· ${ofcEsc(x.facility)}</span>`;
    html += `<tr data-f="${x.facility_id}">
      <td style="${first ? "font-weight:600" : ""}">${first ? ofcEsc(x.coordinator || "— bez koordynatora —") : ""}</td>
      <td style="text-align:center">${panel}</td>
      <td>${name}</td>
      <td><select onchange="medSetFac(${x.facility_id})" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:5px;font-size:12px">
        ${kinds.map(([k, l]) => `<option value="${k}" ${x.kind === k ? "selected" : ""}>${ofcEsc(l)}</option>`).join("")}</select></td>
      <td><input type="text" maxlength="${r.address_max}" value="${ofcEsc(x.address || "")}" placeholder="np. ul. Lekarska 1, 00-001 Warszawa"
        onchange="medSetFac(${x.facility_id})" style="width:100%;min-width:260px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:5px;font-size:12px"></td>
      <td class="st" style="white-space:nowrap;font-size:12px"></td></tr>`;
  });
  body.innerHTML = html;
}
async function medSetCoord(id, el) {
  el.disabled = true;
  const r = await apiFetch("/api/tg/office/med-settings/coord", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coordinator_id: id, enabled: el.checked }),
  }).catch(() => null);
  el.disabled = false;
  if (!r || !r.ok) { el.checked = !el.checked; ofcToast((r && (OFC_ERR[r.error] || r.error)) || "Nie zapisano", true); return; }
  MEDSET.data.rows.forEach((x) => { if (x.coordinator_id === id) x.enabled = el.checked; });
  el.nextElementSibling.textContent = el.checked ? "włączony" : "wyłączony";
  ofcToast(el.checked ? "Panel badań włączony" : "Panel badań wyłączony");
}
async function medSetFac(id) {
  const tr = document.querySelector(`#medSetBody tr[data-f="${id}"]`);
  const kind = tr.querySelector("select").value;
  const address = tr.querySelector("input[type=text]").value;
  const st = tr.querySelector(".st");
  st.innerHTML = `<span class="ofc-dim">zapis…</span>`;
  const r = await apiFetch("/api/tg/office/med-settings/facility", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ facility_id: id, kind, address }),
  }).catch(() => null);
  if (!r || !r.ok) { st.innerHTML = `<span class="ofc-bad">${ofcEsc((r && (OFC_ERR[r.error] || r.error)) || "Nie zapisano")}</span>`; return; }
  const row = MEDSET.data.rows.find((x) => x.facility_id === id);
  if (row) { row.kind = kind; row.address = address.trim(); }
  st.innerHTML = `<span class="ofc-ok">✓ zapisano</span>`;
}
