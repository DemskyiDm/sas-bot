// ══════════════════════════════════════════════════════════════════════
//  Zamówienia · Rekrutacja: nowe zamówienie (koordynator), zatwierdzanie (główny rekruter),
//  tablica terminów i braków (rekrutacja), ustawienia oformienia. API: /api/rec (na razie tylko admin).
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "new", opt: null, board: "active", rows: null, settings: null,
  f: { qty: 10, any: false, men: 0, women: 0, pairs: 0, bhp: null, form: null },
};
const DOW = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];
const STATUS = { new: ["czeka na zatwierdzenie", "blue"], approved: ["w rekrutacji", ""], done: ["zrealizowane", "green"], rejected: ["odrzucone", "red"], cancelled: ["anulowane", ""] };

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
const dayLabel = (iso) => (iso ? `${DOW[new Date(iso + "T12:00:00Z").getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "—");
function ts(x) { return x ? new Date(x).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""; }
function toast(text, bad) {
  const t = document.createElement("div");
  t.className = "toast" + (bad ? " bad" : "");
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["content-type"] = "application/json"; }
  try {
    const r = await fetch("/api/rec" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}
const post = (path, body) => api(path, { method: "POST", body: body || {} });

// ── Start ─────────────────────────────────────────────────────────────
async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me || !me.has_access) {
    document.getElementById("noAccess").style.display = "";
    document.querySelectorAll(".fl-view").forEach((v) => (v.style.display = "none"));
    return;
  }
  const r = await api("/options");
  if (!r || !r.ok) { toast((r && r.error) || "Błąd", true); return; }
  ST.opt = r;
  const sel = document.getElementById("fFac");
  sel.innerHTML = `<option value="">— wybierz obiekt —</option>` + r.facilities.map((f) =>
    `<option value="${f.id}">${esc(f.name)}${f.coordinator ? " · " + esc(f.coordinator) : ""}</option>`).join("");
  document.getElementById("posList").innerHTML = r.positions.map((p) => `<option value="${esc(p)}"></option>`).join("");
  document.getElementById("fBhp").min = r.today;
  drawDateChips();
  drawForm();
  const h = (location.hash || "").replace("#", "");
  showView(["new", "pending", "board", "settings"].includes(h) ? h : "new");
  refreshBadge();
}
function showView(v) {
  ST.view = v;
  document.querySelectorAll(".fl-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent = { new: "Nowe zamówienie", pending: "Do zatwierdzenia", board: "Tablica rekrutacji", settings: "Ustawienia zamówień" }[v];
  history.replaceState(null, "", "#" + v);
  if (v === "pending") loadPending();
  if (v === "board") loadBoard();
  if (v === "settings") loadSettings();
}
async function refreshBadge() {
  const r = await api("/orders?view=pending");
  document.getElementById("badgePending").textContent = r && r.ok && r.rows.length ? r.rows.length : "";
}

// ── Nowe zamówienie ───────────────────────────────────────────────────
function step(k, d) {
  const f = ST.f;
  f[k] = Math.max(k === "qty" ? 1 : 0, Math.min(500, f[k] + d));
  drawForm();
}
function setMode(any) { ST.f.any = any; drawForm(); }
function drawForm() {
  const f = ST.f;
  document.getElementById("vQty").textContent = f.qty;
  document.getElementById("mAny").classList.toggle("on", f.any);
  document.getElementById("mMix").classList.toggle("on", !f.any);
  document.getElementById("mixBox").style.display = f.any ? "none" : "";
  ["men", "women", "pairs"].forEach((k) => (document.getElementById("v" + k[0].toUpperCase() + k.slice(1)).textContent = f[k]));
  const pct = (n) => (f.qty ? Math.round((n / f.qty) * 100) + "%" : "");
  document.getElementById("pMen").textContent = pct(f.men);
  document.getElementById("pWomen").textContent = pct(f.women);
  document.getElementById("pPairs").textContent = pct(2 * f.pairs);
  const people = f.men + f.women + 2 * f.pairs, diff = f.qty - people;
  const m = document.getElementById("splitMsg");
  m.className = diff === 0 ? "ok" : diff > 0 ? "hint" : "bad";
  m.style.fontSize = "12px";
  m.textContent = diff === 0 ? `✓ Rozpisano wszystkich: ${people} z ${f.qty}`
    : diff > 0 ? `Rozpisano ${people} z ${f.qty} — pozostali (${diff}) bez różnicy`
    : `Za dużo o ${-diff}: rozpisano ${people}, zamówienie na ${f.qty}`;
}
function drawDateChips() {
  const box = document.getElementById("dateChips");
  box.innerHTML = ST.opt.quick_dates.map((d) =>
    `<button type="button" class="chip ${ST.f.bhp === d ? "on" : ""}" onclick="pickDate('${d}')">${dayLabel(d)}</button>`).join("");
}
function pickDate(d) {
  ST.f.bhp = d || null;
  document.getElementById("fBhp").value = ST.opt.quick_dates.includes(d) ? "" : d || "";
  drawDateChips();
  calcForm();
}
async function calcForm() {
  const fac = document.getElementById("fFac").value;
  const out = document.getElementById("vForm"), hint = document.getElementById("vFormHint");
  if (!ST.f.bhp) { out.textContent = "—"; hint.textContent = "wybierz datę BHP"; ST.f.form = null; return; }
  const r = await api(`/form-date?bhp=${ST.f.bhp}&facility=${fac || 0}`);
  if (!r || !r.ok) { out.textContent = "—"; return; }
  ST.f.form = r.form_date;
  out.textContent = dayLabel(r.form_date);
  hint.textContent = r.form_days === 0 ? "w dniu BHP (ustawienie obiektu) · termin dla rekrutacji"
    : `${r.form_days} ${r.form_days === 1 ? "dzień roboczy" : "dni robocze"} przed BHP (ustawienie obiektu) · termin dla rekrutacji`;
}
async function saveOrder() {
  const f = ST.f, msg = document.getElementById("saveMsg");
  const fac = document.getElementById("fFac").value;
  if (!fac) { msg.innerHTML = `<span class="bad">Wybierz obiekt</span>`; return; }
  if (!f.bhp) { msg.innerHTML = `<span class="bad">Wybierz datę BHP</span>`; return; }
  if (!f.any && f.men + f.women + 2 * f.pairs > f.qty) { msg.innerHTML = `<span class="bad">Skład większy niż ilość</span>`; return; }
  const btn = document.getElementById("btnSave");
  btn.disabled = true;
  const r = await post("/orders", {
    facility_id: Number(fac), qty: f.qty, any_gender: f.any, men: f.men, women: f.women, pairs: f.pairs, bhp_date: f.bhp,
    position: document.getElementById("fPos").value, requirements: document.getElementById("fReq").value, client_mail: document.getElementById("fMail").value,
  });
  btn.disabled = false;
  if (!r || !r.ok) { msg.innerHTML = `<span class="bad">${esc((r && r.error) || "Błąd")}</span>`; return; }
  msg.innerHTML = "";
  toast(`Zapisano zamówienie #${r.id} · oformienie ${dayLabel(r.form_date)} · czeka na zatwierdzenie`);
  ST.f = { qty: 10, any: false, men: 0, women: 0, pairs: 0, bhp: null, form: null };
  ["fPos", "fReq", "fMail", "fBhp"].forEach((id) => (document.getElementById(id).value = ""));
  drawDateChips(); drawForm(); calcForm();
  refreshBadge();
}

// ── Do zatwierdzenia ──────────────────────────────────────────────────
const mixText = (o) => (o.any_gender ? "bez różnicy"
  : [o.men ? `M ${o.men}` : "", o.women ? `K ${o.women}` : "", o.pairs ? `pary ${o.pairs}` : ""].filter(Boolean).join(" · ")
    + (o.qty - (o.men + o.women + 2 * o.pairs) > 0 ? ` · reszta bez różnicy` : ""));
function dueTag(o) {
  if (o.status === "done" || o.complete) return `<span class="tag green">gotowe</span>`;
  const d = o.days_left;
  const t = d < 0 ? `${-d} dni po terminie` : d === 0 ? "dziś" : d === 1 ? "jutro" : `${d} dni`;
  return `<span class="tag ${d <= 2 ? "red" : d <= 5 ? "amber" : ""}">${t}</span>`;
}
async function loadPending() {
  const box = document.getElementById("pendingBox");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/orders?view=pending");
  if (!r || !r.ok) { box.innerHTML = `<div class="empty bad">${esc((r && r.error) || "Błąd")}</div>`; return; }
  document.getElementById("badgePending").textContent = r.rows.length || "";
  box.innerHTML = r.rows.length ? r.rows.map((o) => `
    <div class="pend">
      <div class="row"><b style="font-size: 16px">${esc(o.facility)}</b>
        <span class="hint">${esc(o.created_by_name || "")} · ${ts(o.created_at)}</span>
        <span style="margin-left: auto">oformienie ${dueTag(o)}</span></div>
      <div class="facts">
        <div class="fact"><div class="l">Ile</div><div class="v">${o.qty}</div></div>
        <div class="fact"><div class="l">Skład</div><div class="v" style="font-size: 13px">${esc(mixText(o))}</div></div>
        <div class="fact"><div class="l">BHP klienta</div><div class="v">${dayLabel(o.bhp)}</div></div>
        <div class="fact"><div class="l">Nasze oformienie</div><div class="v" style="color:#a9c8ff">${dayLabel(o.form)}</div></div>
      </div>
      ${o.position || o.requirements ? `<div class="hint" style="margin-bottom: 8px">${esc([o.position, o.requirements].filter(Boolean).join(" · "))}</div>` : ""}
      ${o.note ? `<div class="warn" style="font-size: 12px; margin-bottom: 8px">Pytanie: ${esc(o.note)}</div>` : ""}
      ${o.client_mail ? `<details style="margin-bottom: 10px"><summary class="hint" style="cursor: pointer">Mail od klienta</summary><div class="hint" style="white-space: pre-line; margin-top: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px">${esc(o.client_mail)}</div></details>` : ""}
      <div class="row">
        <button type="button" class="btn btn-ok btn-sm" style="height: 38px; padding: 0 18px" onclick="approve(${o.id})">✓ Zatwierdź</button>
        <button type="button" class="btn btn-ghost btn-sm" style="height: 38px" onclick="openOrder(${o.id}, true)">Zmień ilość / datę</button>
        <button type="button" class="btn btn-ghost btn-sm" style="height: 38px" onclick="ask(${o.id})">Pytanie do koordynatora</button>
        <button type="button" class="btn btn-ghost btn-sm btn-no" style="height: 38px; margin-left: auto" onclick="reject(${o.id})">Odrzuć</button>
      </div>
    </div>`).join("") : `<div class="card2"><div class="empty">Nie ma zamówień do zatwierdzenia</div></div>`;
}
async function approve(id) {
  const r = await post(`/orders/${id}/approve`);
  if (!r || !r.ok) return toast((r && r.error) || "Błąd", true);
  toast("Zatwierdzono" + (r.notified ? " · koordynator dostał wiadomość w bocie" : " · koordynator nie ma bota — powiadom go sam"));
  afterChange(id);
}
async function ask(id) {
  const q = prompt("Pytanie do koordynatora (dostanie je w bocie):", "");
  if (!q) return;
  const r = await post(`/orders/${id}/question`, { text: q });
  if (!r || !r.ok) return toast((r && r.error) || "Błąd", true);
  toast("Wysłano pytanie" + (r.notified ? "" : " · koordynator nie ma bota"));
  afterChange(id);
}
async function reject(id) {
  const reason = prompt("Odrzucić zamówienie? Powód (koordynator dostanie go w bocie):", "");
  if (reason === null) return;
  const r = await post(`/orders/${id}/reject`, { reason });
  if (!r || !r.ok) return toast((r && r.error) || "Błąd", true);
  toast("Odrzucono");
  afterChange(id);
}
async function setStatus(id, status, question) {
  if (question && !confirm(question)) return;
  const r = await post(`/orders/${id}/status`, { status });
  if (!r || !r.ok) return toast((r && r.error) || "Błąd", true);
  toast("Zapisano");
  afterChange(id);
}
function afterChange(id) {
  refreshBadge();
  if (ST.view === "pending") loadPending();
  if (ST.view === "board") loadBoard();
  if (document.getElementById("drawer").classList.contains("open")) openOrder(id);
}

// ── Tablica ───────────────────────────────────────────────────────────
function setBoard(b) {
  ST.board = b;
  document.querySelectorAll("[data-b]").forEach((x) => x.classList.toggle("on", x.dataset.b === b));
  loadBoard();
}
async function loadBoard() {
  const box = document.getElementById("boardTable");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/orders?view=" + ST.board);
  if (!r || !r.ok) { box.innerHTML = `<div class="empty bad">${esc((r && r.error) || "Błąd")}</div>`; return; }
  const rows = r.rows;
  const open = rows.filter((o) => o.status === "approved" || o.status === "new");
  const soon = open.filter((o) => o.days_left <= 7);
  const urgent = open.filter((o) => o.days_left <= 2 && o.miss > 0);
  const sum = (a, k) => a.reduce((s, o) => s + o[k], 0);
  document.getElementById("boardKpis").innerHTML = `
    <div class="kpi"><div class="l">Brakuje osób (7 dni)</div><div class="v warn">${sum(soon, "miss")}</div><div class="s">M ${sum(soon, "miss_men")} · K ${sum(soon, "miss_women")}</div></div>
    <div class="kpi"><div class="l">Pilne (≤ 2 dni)</div><div class="v ${urgent.length ? "bad" : ""}">${urgent.length} zam.</div><div class="s">brakuje ${sum(urgent, "miss")} osób</div></div>
    <div class="kpi"><div class="l">Aktywne zamówienia</div><div class="v">${open.length}</div><div class="s">razem ${sum(open, "qty")} osób</div></div>
    <div class="kpi"><div class="l">Czeka na zatwierdzenie</div><div class="v">${rows.filter((o) => o.status === "new").length}</div><div class="s">u głównego rekrutera</div></div>`;
  box.innerHTML = rows.length ? `<table class="ord"><thead><tr><th>Oformienie</th><th>BHP klienta</th><th>Obiekt · koordynator</th>
      <th>Zamówiono</th><th>Jest</th><th>Brakuje</th><th>Termin</th><th>Stan</th></tr></thead><tbody>
    ${rows.map((o) => {
      const [st, cls] = STATUS[o.status];
      const missMix = o.any_gender ? "" : [o.miss_men ? `M ${o.miss_men}` : "", o.miss_women ? `K ${o.miss_women}` : ""].filter(Boolean).join(" · ");
      const hot = (o.status === "approved" || o.status === "new") && o.days_left <= 2 && o.miss > 0;
      return `<tr class="${hot ? "hot" : ""}" onclick="openOrder(${o.id})">
        <td class="mono"><b>${dayLabel(o.form)}</b></td>
        <td class="mono dim">${dayLabel(o.bhp)}</td>
        <td><b>${esc(o.facility)}</b><div class="sub">${esc(o.coordinator || "—")}${o.position ? " · " + esc(o.position) : ""}</div></td>
        <td><b>${o.qty}</b><div class="sub">${esc(mixText(o))}</div></td>
        <td class="mono">${o.have}${o.have_unknown ? `<div class="sub">${o.have_unknown} bez PESEL</div>` : ""}</td>
        <td><b class="mono ${o.miss ? (hot ? "bad" : "warn") : "ok"}">${o.miss || "—"}</b><div class="sub">${esc(missMix)}</div></td>
        <td>${dueTag(o)}</td>
        <td><span class="tag ${cls}">${st}</span></td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">Brak zamówień</div>`;
}

// ── Szczegóły / zmiana ────────────────────────────────────────────────
const ACT = { created: "utworzono", approved: "zatwierdzono", rejected: "odrzucono", question: "pytanie", updated: "zmieniono", done: "zrealizowano", cancelled: "anulowano", reopened: "otwarto ponownie" };
async function openOrder(id, editNow) {
  const dw = document.getElementById("drawer");
  dw.innerHTML = `<div class="dw-head"><h2>Zamówienie #${id}</h2><button class="dw-close" aria-label="Zamknij" onclick="closeDrawer()">✕</button></div><div class="dw-body"><div class="loading">Ładowanie…</div></div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  const r = await api(`/orders/${id}`);
  const body = dw.querySelector(".dw-body");
  if (!r || !r.ok) { body.innerHTML = `<div class="bad">${esc((r && r.error) || "Błąd")}</div>`; return; }
  const o = r.order;
  const [st, cls] = STATUS[o.status];
  const openSt = o.status === "new" || o.status === "approved";
  dw.querySelector(".dw-head h2").innerHTML = `${esc(o.facility)} <span class="tag ${cls}" style="margin-left: 6px">${st}</span>`;
  body.innerHTML = `
    <div class="pend" style="margin: 0">
      <div class="facts" style="margin: 0">
        <div class="fact"><div class="l">Zamówiono</div><div class="v">${o.qty}</div><div class="sub">${esc(mixText(o))}</div></div>
        <div class="fact"><div class="l">Jest</div><div class="v">${o.have}</div><div class="sub">M ${o.have_men} · K ${o.have_women}${o.have_unknown ? ` · ? ${o.have_unknown}` : ""}</div></div>
        <div class="fact"><div class="l">BHP klienta</div><div class="v">${dayLabel(o.bhp)}</div></div>
        <div class="fact"><div class="l">Oformienie</div><div class="v" style="color:#a9c8ff">${dayLabel(o.form)}</div><div class="sub">${dueTag(o)}</div></div>
      </div>
    </div>
    ${o.position || o.requirements ? `<div class="hint">${esc([o.position, o.requirements].filter(Boolean).join(" · "))}</div>` : ""}
    ${o.note ? `<div class="warn" style="font-size: 13px">${o.status === "rejected" ? "Powód" : "Pytanie"}: ${esc(o.note)}</div>` : ""}
    ${o.client_mail ? `<details><summary class="hint" style="cursor: pointer">Mail od klienta</summary><div class="hint" style="white-space: pre-line; margin-top: 6px">${esc(o.client_mail)}</div></details>` : ""}
    ${openSt ? `<div class="card2" style="margin: 0; padding: 14px 16px" id="editBox">
      <div class="lbl">Zmień</div>
      <div class="row">
        <label class="hint" for="eQty">Ile</label><input class="inp" type="number" id="eQty" min="1" max="500" value="${o.qty}" style="width: 80px">
        <label class="hint" for="eBhp">BHP</label><input class="inp" type="date" id="eBhp" value="${o.bhp}">
        <button type="button" class="btn btn-ghost btn-sm" onclick="saveEdit(${o.id})">Zapisz zmiany</button>
      </div>
      <div class="hint" style="margin-top: 6px">Oformienie przeliczy się samo z nowej daty BHP.</div>
    </div>` : ""}
    <div class="row">
      ${o.status === "new" ? `<button type="button" class="btn btn-ok btn-sm" style="height: 36px" onclick="approve(${o.id})">✓ Zatwierdź</button>` : ""}
      ${o.status === "approved" ? `<button type="button" class="btn btn-ok btn-sm" style="height: 36px" onclick="setStatus(${o.id}, 'done', 'Oznaczyć jako zrealizowane?')">✓ Zrealizowane</button>` : ""}
      ${o.status === "done" ? `<button type="button" class="btn btn-ghost btn-sm" style="height: 36px" onclick="setStatus(${o.id}, 'approved')">Otwórz ponownie</button>` : ""}
      ${openSt ? `<button type="button" class="btn btn-ghost btn-sm btn-no" style="height: 36px; margin-left: auto" onclick="setStatus(${o.id}, 'cancelled', 'Anulować zamówienie (klient zrezygnował)?')">Anuluj</button>` : ""}
    </div>
    <div><div class="lbl">Historia</div>
      ${r.log.map((l) => `<div class="hint" style="padding: 3px 0">${ts(l.at)} · ${esc(l.by_name || "")} · ${esc(ACT[l.action] || l.action)}${l.details && l.details.reason ? ": " + esc(l.details.reason) : ""}${l.details && l.details.text ? ": " + esc(l.details.text) : ""}${l.action === "updated" && l.details ? `: ${l.details.from.qty} → ${l.details.to.qty} os., BHP ${dayLabel(l.details.to.bhp)}` : ""}</div>`).join("")}
    </div>
    ${o.status !== "new" && o.approved_at ? `<div class="hint">Koordynator ${o.notified_at ? `dostał wiadomość w bocie ${ts(o.notified_at)}` : "nie dostał wiadomości (brak bota)"} — prośba o poinformowanie klienta.</div>` : ""}`;
  if (editNow && openSt) document.getElementById("eQty").focus();
}
async function saveEdit(id) {
  const r = await post(`/orders/${id}/update`, { qty: Number(document.getElementById("eQty").value), bhp_date: document.getElementById("eBhp").value });
  if (!r || !r.ok) return toast((r && r.error) || "Błąd", true);
  toast("Zapisano zmiany");
  afterChange(id);
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ── Ustawienia ────────────────────────────────────────────────────────
async function loadSettings() {
  const r = await api("/settings");
  if (!r || !r.ok) { document.getElementById("setTable").innerHTML = `<div class="empty bad">${esc((r && r.error) || "Błąd")}</div>`; return; }
  ST.settings = r.rows;
  drawSettings();
}
function drawSettings() {
  if (!ST.settings) return;
  const q = (document.getElementById("setQ").value || "").toLowerCase();
  const rows = ST.settings.filter((x) => !q || x.name.toLowerCase().includes(q));
  document.getElementById("setTable").innerHTML = `<table class="ord"><thead><tr><th>Obiekt</th><th>Oformienie przed BHP</th><th></th></tr></thead><tbody>
    ${rows.map((x) => `<tr style="cursor: default"><td>${esc(x.name)}</td>
      <td><select class="inp" aria-label="Dni przed BHP: ${esc(x.name)}" onchange="saveSetting(${x.id}, this)">
        ${[0, 1, 2, 3].map((n) => `<option value="${n}" ${x.form_days === n ? "selected" : ""}>${n === 0 ? "w dniu BHP" : `${n} ${n === 1 ? "dzień roboczy" : "dni robocze"}`}</option>`).join("")}
      </select></td><td class="st hint"></td></tr>`).join("")}</tbody></table>`;
}
async function saveSetting(id, el) {
  const st = el.closest("tr").querySelector(".st");
  st.textContent = "zapis…";
  const r = await post("/settings", { facility_id: id, form_days: Number(el.value) });
  st.innerHTML = r && r.ok ? `<span class="ok">✓ zapisano</span>` : `<span class="bad">${esc((r && r.error) || "błąd")}</span>`;
  const row = ST.settings.find((x) => x.id === id);
  if (row && r && r.ok) row.form_days = Number(el.value);
}

init();
