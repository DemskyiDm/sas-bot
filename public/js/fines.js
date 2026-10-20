// public/js/fines.js — strona «⚠️ Kary» (panel web). Logika i uprawnienia: bot/fines.js, API: /api/tg/fines…
//   • lista kar za miesiąc: Moje obiekty / Region / Cała firma (jak zaliczki), filtry, podsumowanie;
//   • «Nowa kara» / «Zmień» / «Anuluj» — okno z wyszukiwaniem pracownika (pracownik dostaje wiadomość w bocie);
//   • «Wyślij do biura» — mail z tabelą i Excelem, jak badania (bot/office.js, kind 'fin');
//   • «Typy kar» — nazwy i kwoty domyślne (admin / kierownik).
// Korzysta z ofcEsc / ofcToast / ofcDmy / OFC_ERR (public/js/office.js) i apiFetch (app.js).
"use strict";

const FIN = { data: null, off: null, sel: new Set(), to: new Set(), f: { month: "", facility: "", type: "", status: "" }, form: null, types: false };
const FIN_SCOPE_KEY = "sas_fin_scope";
const FIN_ST = { open: ["do wysłania", "warn"], sent: ["wysłano", "ok"], cancelled: ["anulowana", "dim"] };
const FIN_ERR = {
  bad_amount: "Podaj kwotę", bad_date: "Data — nie później niż dziś i nie wcześniej niż 120 dni", bad_type: "Wybierz rodzaj kary",
  forbidden: "Brak uprawnień na tym obiekcie", not_found: "Nie znaleziono", sent_admin_only: "Już wysłana do biura — zmienić może tylko admin",
  already_cancelled: "Już anulowana", name_required: "Wpisz nazwę (PL)",
};
const finErr = (r) => (r && (FIN_ERR[r.error] || OFC_ERR[r.error] || r.error)) || "Błąd połączenia";
const finZl = (v) => (Math.round(Number(v || 0) * 100) / 100).toLocaleString("pl-PL") + " zł";
const finStore = { get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* prywatne okno */ } } };
const finPost = (url, body) => apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => null);

async function loadFinesPage() {
  const box = document.getElementById("finBox");
  if (!FIN.data) box.innerHTML = `<div class="ofc-empty">Ładowanie…</div>`;
  if (!FIN.f.month) FIN.f.month = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date()).slice(0, 7);
  const sc = finStore.get(FIN_SCOPE_KEY);
  const q = new URLSearchParams({ month: FIN.f.month });
  if (sc) q.set("scope", sc);
  const [r, off] = await Promise.all([
    apiFetch("/api/tg/fines?" + q).catch(() => null),
    apiFetch("/api/tg/office?kind=fin" + (sc ? "&scope=" + sc : "")).catch(() => null),
  ]);
  if (!r || !r.ok) { box.innerHTML = `<div class="ofc-bad">${ofcEsc(finErr(r))}</div>`; return; }
  FIN.data = r;
  FIN.off = off && off.ok ? off : null;
  const openIds = new Set(r.rows.filter((x) => x.status === "open" && x.can_change && !x.is_test).map((x) => Number(x.id)));
  FIN.sel = new Set([...FIN.sel].filter((id) => openIds.has(id)));
  if (FIN.off && !FIN.to.size) {
    const known = new Set(FIN.off.recipients.map((x) => x.email.toLowerCase()));
    FIN.to = new Set((FIN.off.last || []).map((e) => String(e).toLowerCase()).filter((e) => known.has(e)));
  }
  drawFines();
}
function finSetScope(s) { finStore.set(FIN_SCOPE_KEY, s); FIN.sel.clear(); FIN.data = null; loadFinesPage(); }
function finFilter(k, v) { FIN.f[k] = v; if (k === "month") { FIN.data = null; loadFinesPage(); } else drawFines(); }

function drawFines() {
  const r = FIN.data;
  const f = FIN.f;
  const rows = r.rows.filter((x) => (!f.facility || String(x.facility_id) === f.facility) && (!f.type || String(x.type_id) === f.type)
    && (!f.status || x.status === f.status));
  const live = rows.filter((x) => x.status !== "cancelled" && !x.is_test);   // TEST_ — nie liczą się
  const open = live.filter((x) => x.status === "open");
  const pickable = rows.filter((x) => x.status === "open" && x.can_change && !x.is_test);
  const selRows = pickable.filter((x) => FIN.sel.has(Number(x.id)));
  const selSum = selRows.reduce((a, x) => a + Number(x.amount), 0);
  const scope = r.scopes && r.scopes.length > 1 ? `<span class="adv-scope">${r.scopes.map((s) =>
    `<button class="btn btn-ghost btn-sm${s === r.scope ? " adv-scope-on" : ""}" onclick="finSetScope('${s}')">${{ own: "Moje obiekty", region: "Region", all: "Cała firma" }[s] || s}</button>`).join("")}</span>` : "";
  const sel = (k, opts, all) => `<select onchange="finFilter('${k}', this.value)" style="max-width:200px"><option value="">${all}</option>${opts.map(([v, l]) =>
    `<option value="${ofcEsc(v)}" ${String(f[k]) === String(v) ? "selected" : ""}>${ofcEsc(l)}</option>`).join("")}</select>`;
  const kpi = (l, v, s, cls) => `<div class="fin-kpi"><div class="l">${l}</div><div class="v ${cls || ""}">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
  const row = (x) => {
    const [st, cls] = FIN_ST[x.status];
    const can = x.status === "open" && x.can_change && !x.is_test;
    return `<tr class="${x.status === "cancelled" ? "done" : ""}">
      <td>${can ? `<input type="checkbox" ${FIN.sel.has(Number(x.id)) ? "checked" : ""} onchange="finPick(${Number(x.id)}, this.checked)" aria-label="Zaznacz">` : ""}</td>
      <td class="ofc-mono">${ofcDmy(x.fine_date)}</td>
      <td><b>${ofcEsc(x.full_name)}</b><div class="ofc-dim ofc-mono">${ofcEsc(x.login || "")}</div></td>
      <td>${ofcEsc(x.facility || "—")}</td>
      <td>${ofcEsc(x.type_name)}</td>
      <td class="ofc-mono" style="text-align:right;white-space:nowrap">${finZl(x.amount)}</td>
      <td class="ofc-dim" style="max-width:220px">${ofcEsc(x.note || "")}${x.cancel_reason ? `<div>anulowana: ${ofcEsc(x.cancel_reason)}</div>` : ""}</td>
      <td class="ofc-dim">${ofcEsc(x.created_by_name || "")}</td>
      <td>${x.is_test ? `<span class="fin-st dim" title="Pracownik testowy — nie liczy się i nie idzie do biura">TEST</span>` : `<span class="fin-st ${cls}">${st}</span>`}</td>
      <td style="white-space:nowrap">${x.can_change ? `<button class="btn btn-ghost btn-sm" onclick="finOpen(${x.worker_id}, ${Number(x.id)})" title="Zmień">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="finCancel(${Number(x.id)})" title="Anuluj">✕</button>` : ""}</td></tr>`;
  };
  const o = FIN.off;
  const rc = (x) => {
    const on = FIN.to.has(x.email.toLowerCase());
    return `<span class="ofc-chip ${on ? "on" : ""}"><button onclick="finTo('${ofcEsc(x.email.toLowerCase())}')">${on ? "✓ " : ""}${ofcEsc(x.name ? `${x.name} · ${x.email}` : x.email)}${x.shared ? " <em>wspólny</em>" : ""}</button>
      ${!x.shared || (o && o.is_admin) ? `<button class="x" onclick="finDelRcpt(${x.id}, '${ofcEsc(x.email)}')" aria-label="Usuń">✕</button>` : ""}</span>`;
  };
  document.getElementById("finBox").innerHTML = `
    <div class="ofc-bar">
      ${scope}
      <input type="month" value="${ofcEsc(f.month)}" onchange="finFilter('month', this.value)" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:6px;color-scheme:dark">
      ${sel("facility", r.facilities.map((x) => [x.id, x.name]), "Wszystkie obiekty")}
      ${sel("type", r.types.map((x) => [x.id, x.name_pl]), "Wszystkie rodzaje")}
      ${sel("status", [["open", "Do wysłania"], ["sent", "Wysłane"], ["cancelled", "Anulowane"]], "Każdy status")}
      <span style="margin-left:auto;display:flex;gap:6px">
        ${r.can_manage ? `<button class="btn btn-ghost btn-sm" onclick="finTypesToggle()">⚙️ Rodzaje kar</button>` : ""}
        ${r.can_issue_any ? `<button class="btn btn-primary btn-sm" onclick="finOpen()">＋ Nowa kara</button>` : ""}
      </span>
    </div>
    <div id="finTypesBox" style="display:${FIN.types ? "" : "none"}"></div>
    <div class="fin-kpis">
      ${kpi("Kar w miesiącu", live.length, "bez anulowanych i testowych")}
      ${kpi("Suma", finZl(live.reduce((a, x) => a + Number(x.amount), 0)))}
      ${kpi("Do wysłania", open.length, finZl(open.reduce((a, x) => a + Number(x.amount), 0)), open.length ? "warn" : "")}
    </div>
    <div class="ofc-table" style="max-height:none"><table><thead><tr>
      <th style="width:28px">${pickable.length ? `<input type="checkbox" ${selRows.length === pickable.length ? "checked" : ""} onchange="finAll(this.checked)" aria-label="Zaznacz wszystkie">` : ""}</th>
      <th style="text-align:left">Data</th><th style="text-align:left">Pracownik</th><th style="text-align:left">Obiekt</th><th style="text-align:left">Rodzaj</th>
      <th style="text-align:right">Kwota</th><th style="text-align:left">Uwagi</th><th style="text-align:left">Wystawił</th><th style="text-align:left">Status</th><th></th>
    </tr></thead><tbody>${rows.length ? rows.map(row).join("") : `<tr><td colspan="10" class="ofc-empty">W tym miesiącu nie ma kar</td></tr>`}</tbody></table></div>
    ${o ? `<div class="ofc-sec">
      <div class="ofc-h">✉ Wyślij do biura</div>
      ${o.configured ? "" : `<div class="ofc-warn">Poczta nie jest skonfigurowana.</div>`}
      <div class="ofc-chips">${o.recipients.map(rc).join("") || `<span class="ofc-dim">Dodaj adres biura</span>`}</div>
      <div class="ofc-add"><input type="email" id="finEmail" placeholder="adres@firma.pl" onkeydown="if(event.key==='Enter')finAddRcpt()">
        <button class="btn btn-ghost btn-sm" onclick="finAddRcpt()">Dodaj</button>
        ${o.is_admin ? `<label class="ofc-dim"><input type="checkbox" id="finShared"> wspólny dla wszystkich</label>` : ""}</div>
      <div class="ofc-send"><span>Zaznaczono ${selRows.length} · ${finZl(selSum)} · tabela w mailu + Excel${o.my_email ? ` · kopia: ${ofcEsc(o.my_email)}` : ""}</span>
        <button class="btn btn-primary btn-sm" id="finSend" ${o.configured && selRows.length && FIN.to.size ? "" : "disabled"} onclick="finSend()">Wyślij do biura</button></div>
    </div>` : ""}`;
  if (FIN.types) finTypesDraw();
}
function finPick(id, on) { if (on) FIN.sel.add(id); else FIN.sel.delete(id); drawFines(); }
function finAll(on) {
  FIN.data.rows.filter((x) => x.status === "open" && x.can_change && !x.is_test).forEach((x) => (on ? FIN.sel.add(Number(x.id)) : FIN.sel.delete(Number(x.id))));
  drawFines();
}
function finTo(email) { if (FIN.to.has(email)) FIN.to.delete(email); else FIN.to.add(email); drawFines(); }
async function finAddRcpt() {
  const email = (document.getElementById("finEmail").value || "").trim();
  if (!email) return;
  const shared = !!(document.getElementById("finShared") || {}).checked;
  const r = await finPost("/api/tg/office/recipients", { kind: "fin", email, shared });
  if (!r || !r.ok) return ofcToast(finErr(r), true);
  if (!FIN.off.recipients.some((x) => x.id === r.recipient.id)) FIN.off.recipients.push(r.recipient);
  FIN.to.add(r.recipient.email.toLowerCase());
  drawFines();
}
async function finDelRcpt(id, email) {
  if (!confirm(`Usunąć adresata ${email}?`)) return;
  const r = await apiFetch(`/api/tg/office/recipients/${id}`, { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) return ofcToast("Nie usunięto", true);
  FIN.off.recipients = FIN.off.recipients.filter((x) => x.id !== id);
  FIN.to.delete(String(email).toLowerCase());
  drawFines();
}
async function finSend() {
  const ids = [...FIN.sel];
  const to = FIN.off.recipients.filter((x) => FIN.to.has(x.email.toLowerCase())).map((x) => x.email);
  if (!confirm(`Wysłać ${ids.length} kar do biura (${to.join(", ")})?`)) return;
  document.getElementById("finSend").disabled = true;
  const r = await finPost("/api/tg/office/send", { kind: "fin", ids, to });
  if (r && r.ok) { ofcToast(`Wysłano do biura: ${r.count} kar, ${finZl(r.total)}`); FIN.sel.clear(); }
  else ofcToast(finErr(r) + (r && r.detail ? `: ${r.detail}` : ""), true);
  loadFinesPage();
}
async function finCancel(id) {
  const reason = prompt("Anulować karę? Pracownik dostanie wiadomość w bocie.\n\nPowód (opcjonalnie):", "");
  if (reason === null) return;
  const r = await finPost(`/api/tg/fines/${id}/cancel`, { reason });
  if (!r || !r.ok) return ofcToast(finErr(r), true);
  ofcToast("Kara anulowana" + (r.notified ? " · pracownik powiadomiony" : ""));
  loadFinesPage();
}

// ── Okno: nowa kara / zmiana ──────────────────────────────────────────
function finModal() {
  let ov = document.getElementById("finOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "finOverlay";
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal" style="width:520px" role="dialog" aria-label="Kara"><div id="finModalBody"></div></div>`;
    ov.addEventListener("click", (e) => { if (e.target === ov) finClose(); });
    document.body.appendChild(ov);
  }
  ov.classList.add("open");
  return document.getElementById("finModalBody");
}
function finClose() { const ov = document.getElementById("finOverlay"); if (ov) ov.classList.remove("open"); FIN.form = null; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && FIN.form) finClose(); });

// bez workerId — najpierw wyszukiwanie; z fineId — zmiana istniejącej kary
async function finOpen(workerId, fineId) {
  const body = finModal();
  if (!workerId) {
    FIN.form = { search: true };
    body.innerHTML = `<div class="modal-title">⚠️ Nowa kara</div>
      <div class="modal-field"><div class="modal-label">PRACOWNIK</div>
        <input class="modal-input" id="finQ" placeholder="Nazwisko lub paszport" oninput="finSearch(this.value)" autocomplete="off"></div>
      <div id="finFound"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="finClose()">Zamknij</button></div>`;
    setTimeout(() => document.getElementById("finQ").focus(), 30);
    return;
  }
  body.innerHTML = `<div class="ofc-empty">Ładowanie…</div>`;
  const r = await apiFetch(`/api/tg/fines/worker/${workerId}`).catch(() => null);
  if (!r || !r.ok) { body.innerHTML = `<div class="ofc-bad">${ofcEsc(finErr(r))}</div><div style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="finClose()">Zamknij</button></div>`; return; }
  const ed = fineId ? r.fines.find((x) => Number(x.id) === Number(fineId)) : null;
  const types = r.types.slice();
  if (ed && ed.type_id && !types.some((x) => x.id === ed.type_id)) types.push({ id: ed.type_id, name_pl: ed.type_name, amount: null });
  FIN.form = { w: r.worker.id, edit: ed ? Number(ed.id) : null, type: ed ? ed.type_id : null, types };
  const w = r.worker;
  const kv = (l, v) => `<div><div class="modal-label">${l}</div><div style="font-size:13px">${ofcEsc(v)}</div></div>`;
  body.innerHTML = `<div class="modal-title">${ed ? "✏️ Zmień karę" : "⚠️ Nowa kara"}</div>
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:6px">${ofcEsc(w.last_name)} ${ofcEsc(w.first_name)}</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px">
        ${kv("PASZPORT", w.login || "—")}${kv("PRZEDSIĘBIORSTWO", w.facility)}${kv("GODZINY W TYM MIESIĄCU", `${w.hours_month} h`)}${kv("GODZINY W POPRZEDNIM", `${w.hours_prev} h`)}
      </div></div>
    ${r.can_issue || ed ? `
    <div class="modal-field"><div class="modal-label">RODZAJ KARY</div>
      <div class="fin-types">${types.map((x) => `<button type="button" class="fin-ty ${FIN.form.type === x.id ? "on" : ""}" data-id="${x.id}" onclick="finType(${x.id})">
        <span>${ofcEsc(x.name_pl)}</span><span class="ofc-mono">${x.amount == null ? "wpisz" : finZl(x.amount)}</span></button>`).join("")}</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="modal-field"><div class="modal-label">KWOTA (ZŁ)</div><input class="modal-input" id="finAmount" type="number" min="1" step="1" value="${ed ? ed.amount : ""}"></div>
      <div class="modal-field"><div class="modal-label">DATA</div><input class="modal-input" id="finDate" type="date" min="${r.min_date}" max="${r.today}" value="${ed ? ed.fine_date : r.today}" style="color-scheme:dark"></div>
    </div>
    <div class="modal-field"><div class="modal-label">UWAGI</div><input class="modal-input" id="finNote" maxlength="300" placeholder="opcjonalnie" value="${ofcEsc(ed && ed.note ? ed.note : "")}"></div>
    <div id="finFormErr" class="ofc-bad" style="min-height:16px"></div>
    <div class="ofc-dim" style="margin-bottom:10px">${w.in_bot ? "Pracownik dostanie wiadomość w bocie." : "Pracownik nie ma bota — nie dostanie wiadomości."}</div>
    <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="finClose()">Anuluj</button>
      <button class="btn btn-primary btn-sm" id="finSave" onclick="finSave()">${ed ? "Zapisz zmiany" : "Wystaw karę"}</button></div>`
    : `<div class="ofc-warn">Na tym obiekcie nie możesz wystawiać kar.</div><div style="text-align:right;margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="finClose()">Zamknij</button></div>`}`;
}
let finSeq = 0, finTimer = null;
function finSearch(q) {
  clearTimeout(finTimer);
  finTimer = setTimeout(async () => {
    const box = document.getElementById("finFound");
    if (!box) return;
    if (String(q).trim().length < 2) { box.innerHTML = ""; return; }
    const my = ++finSeq;
    const r = await apiFetch("/api/tg/fines/search?q=" + encodeURIComponent(q)).catch(() => null);
    if (my !== finSeq || !document.getElementById("finFound")) return;
    box.innerHTML = r && r.ok && r.rows.length
      ? `<div class="fin-found">${r.rows.map((x) => `<button type="button" onclick="finOpen(${x.id})"><b>${ofcEsc(x.full_name)}</b>
          <span class="ofc-dim">${ofcEsc(x.login || "")} · ${ofcEsc(x.facility || "—")} · ${ofcEsc(x.status || "")}</span></button>`).join("")}</div>`
      : `<div class="ofc-dim" style="padding:6px 2px">Nikogo nie znaleziono</div>`;
  }, 250);
}
function finType(id) {
  FIN.form.type = id;
  document.querySelectorAll("#finModalBody .fin-ty").forEach((b) => b.classList.toggle("on", Number(b.dataset.id) === id));
  const t = FIN.form.types.find((x) => x.id === id);
  const a = document.getElementById("finAmount");
  a.value = t && t.amount != null ? t.amount : "";
  if (!a.value) a.focus();
  document.getElementById("finFormErr").textContent = "";
}
async function finSave() {
  const f = FIN.form;
  const errBox = document.getElementById("finFormErr");
  if (!f.type) { errBox.textContent = FIN_ERR.bad_type; return; }
  const amount = Number(document.getElementById("finAmount").value);
  if (!(amount > 0)) { errBox.textContent = FIN_ERR.bad_amount; document.getElementById("finAmount").focus(); return; }
  const body = { worker_id: f.w, type_id: f.type, amount, fine_date: document.getElementById("finDate").value, note: document.getElementById("finNote").value };
  document.getElementById("finSave").disabled = true;
  const r = await finPost(f.edit ? `/api/tg/fines/${f.edit}/update` : "/api/tg/fines", body);
  if (!r || !r.ok) { document.getElementById("finSave").disabled = false; errBox.textContent = finErr(r); return; }
  ofcToast((f.edit ? "Zapisano zmiany" : `Kara wystawiona: ${finZl(amount)}`) + (r.notified ? " · pracownik powiadomiony" : ""));
  finClose();
  loadFinesPage();
}

// ── Rodzaje kar (admin / kierownik) ───────────────────────────────────
async function finTypesToggle() {
  FIN.types = !FIN.types;
  document.getElementById("finTypesBox").style.display = FIN.types ? "" : "none";
  if (FIN.types) finTypesDraw();
}
async function finTypesDraw() {
  const box = document.getElementById("finTypesBox");
  const r = await apiFetch("/api/tg/fines/types").catch(() => null);
  if (!r || !r.ok) { box.innerHTML = `<div class="ofc-bad">${ofcEsc(finErr(r))}</div>`; return; }
  const inp = (v, w, ph, type) => `<input ${type ? `type="${type}" step="1" min="1"` : ""} value="${ofcEsc(v == null ? "" : v)}" placeholder="${ph || ""}" style="width:${w};background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:5px;font-size:12px">`;
  const tr = (x) => `<tr data-id="${x.id || ""}">
    <td>${inp(x.name_pl, "100%", "nazwa PL")}</td><td>${inp(x.name_uk, "100%", "UA")}</td><td>${inp(x.name_ru, "100%", "RU")}</td>
    <td>${inp(x.amount, "80px", "wpisz", "number")}</td><td>${inp(x.sort, "54px", "", "number")}</td>
    <td style="text-align:center"><input type="checkbox" ${x.is_active !== false ? "checked" : ""}></td>
    <td><button class="btn btn-ghost btn-sm" onclick="finTypeSave(this)">Zapisz</button></td></tr>`;
  box.innerHTML = `<div class="ofc-sec" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
    <div class="ofc-h">Rodzaje kar · kwota pusta — wpisywana przy wystawianiu</div>
    <div class="ofc-table" style="max-height:none"><table><thead><tr><th style="text-align:left">Nazwa (PL — mail, Excel)</th><th style="text-align:left">Українською</th>
      <th style="text-align:left">По-русски</th><th>Kwota</th><th>Kolejność</th><th>Aktywny</th><th></th></tr></thead>
      <tbody>${r.types.map(tr).join("")}${tr({ sort: (r.types.length + 1) * 10 })}</tbody></table></div>
    <div class="ofc-dim">Zmiana nie dotyczy już wystawionych kar. Nieaktywny rodzaj znika z listy przy wystawianiu.</div></div>`;
}
async function finTypeSave(btn) {
  const tr = btn.closest("tr");
  const v = [...tr.querySelectorAll("input")];
  const body = { id: tr.dataset.id || null, name_pl: v[0].value, name_uk: v[1].value, name_ru: v[2].value, amount: v[3].value, sort: v[4].value, is_active: v[5].checked };
  const r = await finPost("/api/tg/fines/types", body);
  if (!r || !r.ok) return ofcToast(finErr(r), true);
  ofcToast("Zapisano rodzaj kary");
  FIN.data = null;
  loadFinesPage();
}
