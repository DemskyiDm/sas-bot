// ══════════════════════════════════════════════════════════════════════
//  Rekrutacja → Wysyłka wiadomości: wiadomość do pracowników przez bota.
//  Do kogo: pracujący na obiektach / w regionach, niepracujący, wybrane osoby. API: /api/broadcast
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "compose", mode: "facility", opt: null,
  fac: new Set(), reg: new Set(), inReg: new Set(), since: "", people: new Map(),   // people: id → osoba
  aud: null, audKey: null, wseq: 0, hist: null, timer: null,
};

// ── Narzędzia ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const ddy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
function ts(x) {
  if (!x) return "";
  const d = new Date(x);
  return isNaN(d) ? String(x) : d.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function isoMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch("/api/broadcast" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const STATUS_PL = { pracuje: "pracuje", zwolniony: "zwolniony", rezygnacja: "rezygnacja", urlop: "urlop", przeniesiony: "przeniesiony", unknown: "bez statusu" };
const LANG_PL = { uk: "ukraiński", ru: "rosyjski", pl: "polski", inne: "inny / brak" };

// ── Start ─────────────────────────────────────────────────────────────
async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || CURRENT_USER.username || "";
  const me = await api("/me");
  if (!me || !me.has_access) {
    document.getElementById("noAccess").style.display = "";
    document.querySelectorAll(".fl-view").forEach((v) => (v.style.display = "none"));
    return;
  }
  const r = await api("/options");
  if (!r || !r.ok) { document.getElementById("facList").innerHTML = `<div class="error">${esc(r ? r.error : "Błąd")}</div>`; return; }
  ST.opt = r;
  document.getElementById("scopeNote").textContent = r.role === "all" ? "cała firma" : "Twoje regiony: " + r.regions.map((x) => x.name).join(", ");
  renderFacilities();
  renderRegions();
  onText();
  showView(location.hash === "#history" ? "history" : "compose");
  loadHistory(true);
}

function showView(v) {
  ST.view = v;
  document.querySelectorAll(".fl-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent = v === "history" ? "Historia wysyłek" : "Wysyłka wiadomości";
  history.replaceState(null, "", v === "history" ? "#history" : "#");
  if (v === "history") loadHistory();
}

// ── 1. Do kogo ────────────────────────────────────────────────────────
function setMode(m) {
  ST.mode = m;
  document.querySelectorAll("#modes .chip").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  ["facility", "region", "inactive", "workers"].forEach((k) => (document.getElementById("pick-" + k).style.display = k === m ? "" : "none"));
  changed();
}
// Wybór się zmienił — stary podgląd nieaktualny
function changed() {
  ST.aud = null;
  document.getElementById("btnSend").disabled = true;
  document.getElementById("btnSend").textContent = "📣 Wyślij";
  document.getElementById("audLabel").textContent = audienceText();
  document.getElementById("audBox").innerHTML = `<div class="dim" style="font-size:12px">${audienceReady() ? "Kliknij „Pokaż odbiorców”, żeby sprawdzić listę przed wysłaniem." : "Wybierz, do kogo wysłać."}</div>`;
}
function audience() {
  if (ST.mode === "facility") return { mode: "facility", ids: [...ST.fac] };
  if (ST.mode === "region") return { mode: "region", ids: [...ST.reg] };
  if (ST.mode === "workers") return { mode: "workers", ids: [...ST.people.keys()] };
  return { mode: "inactive", ids: [...ST.inReg], since: ST.since || null };
}
const audienceReady = () => ST.mode === "inactive" || audience().ids.length > 0;
function audienceText() {
  const a = audience();
  if (a.mode === "facility") return a.ids.length ? `zakładów: ${a.ids.length}` : "";
  if (a.mode === "region") return a.ids.length ? `regionów: ${a.ids.length}` : "";
  if (a.mode === "workers") return a.ids.length ? `osób: ${a.ids.length}` : "";
  return `niepracujący${a.ids.length ? `, regionów: ${a.ids.length}` : ""}${a.since ? `, od ${ddy(a.since)}` : ""}`;
}

// Zakłady: region → (koordynator) obiekt → zakład; obiekt z jednym zakładem — jednym wierszem
function renderFacilities() {
  const q = (document.getElementById("facSearch").value || "").toLowerCase();
  const list = ST.opt.facilities.filter((f) => !q || [f.name, f.group_name, f.coordinator, f.region].some((s) => (s || "").toLowerCase().includes(q)));
  if (!list.length) { document.getElementById("facList").innerHTML = `<div class="empty">Nic nie znaleziono</div>`; return; }
  const groups = [];
  list.forEach((f) => {
    const last = groups[groups.length - 1];
    if (last && last.name === f.group_name && last.region === f.region) last.items.push(f);
    else groups.push({ name: f.group_name, region: f.region, coordinator: f.coordinator, items: [f] });
  });
  const multiReg = new Set(groups.map((g) => g.region || null)).size > 1;
  let cur, html = "";
  groups.forEach((g, gi) => {
    if (multiReg && (g.region || null) !== cur) { html += `<div class="pk-reg">📍 ${esc(g.region || "Bez regionu")}</div>`; cur = g.region || null; }
    const ids = g.items.map((f) => f.id);
    const on = ids.filter((id) => ST.fac.has(id)).length;
    const n = g.items.reduce((a, f) => a + f.working, 0);
    html += `<label class="pk-row grp"><input type="checkbox" data-g="${gi}" ${on === ids.length ? "checked" : ""} onchange="toggleGroup(this)">
      ${esc(g.name)}${g.coordinator ? ` <span class="dim" style="font-weight:400">· ${esc(g.coordinator)}</span>` : ""}<span class="meta">${n}</span></label>`;
    if (g.items.length > 1) g.items.forEach((f) => {
      html += `<label class="pk-row sub"><input type="checkbox" data-f="${f.id}" ${ST.fac.has(f.id) ? "checked" : ""} onchange="toggleFac(this)">${esc(f.name)}<span class="meta">${f.working}</span></label>`;
    });
  });
  ST.groups = groups;
  document.getElementById("facList").innerHTML = html;
  // obiekt zaznaczony częściowo
  groups.forEach((g, gi) => {
    const on = g.items.filter((f) => ST.fac.has(f.id)).length;
    const el = document.querySelector(`#facList input[data-g="${gi}"]`);
    if (el) el.indeterminate = on > 0 && on < g.items.length;
  });
}
function toggleGroup(el) {
  ST.groups[Number(el.dataset.g)].items.forEach((f) => (el.checked ? ST.fac.add(f.id) : ST.fac.delete(f.id)));
  renderFacilities(); changed();
}
function toggleFac(el) {
  const id = Number(el.dataset.f);
  if (el.checked) ST.fac.add(id); else ST.fac.delete(id);
  renderFacilities(); changed();
}

function renderRegions() {
  const row = (set, r, fn) => `<label class="pk-row"><input type="checkbox" data-r="${r.id}" ${set.has(r.id) ? "checked" : ""} onchange="${fn}(this)">${esc(r.name)}</label>`;
  const empty = `<div class="empty">Brak regionów</div>`;
  document.getElementById("regList").innerHTML = ST.opt.regions.map((r) => row(ST.reg, r, "toggleReg")).join("") || empty;
  document.getElementById("inRegList").innerHTML = ST.opt.regions.map((r) => row(ST.inReg, r, "toggleInReg")).join("") || empty;
}
function toggleReg(el) { const id = Number(el.dataset.r); if (el.checked) ST.reg.add(id); else ST.reg.delete(id); changed(); }
function toggleInReg(el) { const id = Number(el.dataset.r); if (el.checked) ST.inReg.add(id); else ST.inReg.delete(id); changed(); }
function setSince(d) {
  const inp = document.getElementById("sinceDate");
  if (d === "date") ST.since = inp.value || "";
  else { ST.since = d ? isoMinus(Number(d)) : ""; inp.value = ST.since; }
  document.querySelectorAll("#sincePresets .chip").forEach((b) => b.classList.toggle("active", d !== "date" && b.dataset.d === d));
  changed();
}

// Wybrane osoby: wyszukiwanie
let wTimer = null;
function searchWorkers() {
  clearTimeout(wTimer);
  wTimer = setTimeout(async () => {
    const q = document.getElementById("wSearch").value.trim();
    const box = document.getElementById("wFound");
    if (q.length < 2) { box.innerHTML = ""; return; }
    const my = ++ST.wseq;
    const r = await api("/workers?q=" + encodeURIComponent(q));
    if (my !== ST.wseq || !r) return;
    if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
    ST.found = r.rows;
    box.innerHTML = r.rows.length ? `<div class="picklist" style="max-height:240px">${r.rows.map((x, i) => `
      <div class="pk-row" onclick="addPerson(${i})">${ST.people.has(x.id) ? "✓" : "＋"} ${esc(x.full_name)}
        <span class="dim">#${esc(x.login || "")} · ${esc(x.facility || "—")} · ${x.working ? "pracuje" : esc(STATUS_PL[x.status] || x.status || "—")}</span>
        <span class="meta">${x.has_tg ? "Telegram" : '<span class="bad">bez Telegrama</span>'}</span></div>`).join("")}</div>`
      : `<div class="empty">Nikogo nie znaleziono</div>`;
  }, 250);
}
function addPerson(i) {
  const x = ST.found[i];
  if (!x) return;
  if (ST.people.has(x.id)) ST.people.delete(x.id); else ST.people.set(x.id, x);
  renderPeople(); searchWorkers(); changed();
}
function removePerson(id) { ST.people.delete(id); renderPeople(); changed(); }
function renderPeople() {
  document.getElementById("wSelected").innerHTML = [...ST.people.values()].map((x) => `
    <span class="sel-chip">${esc(x.full_name)}${x.has_tg ? "" : ' <span class="bad" title="Bez Telegrama — nie dostanie">⚠</span>'}
      <button title="Usuń" onclick="removePerson(${x.id})">✕</button></span>`).join("");
}

// ── 2. Treść ──────────────────────────────────────────────────────────
function texts() {
  const t = {};
  ["uk", "ru", "pl"].forEach((l) => { const v = document.getElementById("t_" + l).value.trim(); if (v) t[l] = v; });
  return { body: document.getElementById("body").value.trim(), texts: t };
}
function onText() {
  const max = (ST.opt && ST.opt.max_text) || 4000;
  const n = document.getElementById("body").value.length;
  const el = document.getElementById("bodyCnt");
  el.textContent = `${n} / ${max}`;
  el.className = "counter" + (n > max ? " bad" : "");
}

// ── 3. Podgląd i wysyłka ──────────────────────────────────────────────
async function preview() {
  if (!audienceReady()) { changed(); return; }
  const box = document.getElementById("audBox");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const a = audience();
  const r = await api("/audience", { method: "POST", body: { audience: a } });
  if (!r || !r.ok) { box.innerHTML = `<div class="error">${esc(r ? r.error : "Błąd")}</div>`; return; }
  ST.aud = r; ST.audKey = JSON.stringify(a);
  const langs = Object.entries(r.langs).sort((x, y) => y[1] - x[1]).map(([l, n]) => `${LANG_PL[l] || l}: ${n}`).join(" · ");
  box.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="l">Wybrano osób</div><div class="v">${r.total}</div></div>
      <div class="kpi"><div class="l">Dostaną wiadomość</div><div class="v good">${r.with_tg}</div><div class="s">mają Telegram</div></div>
      <div class="kpi"><div class="l">Bez Telegrama</div><div class="v ${r.without_tg ? "warn" : ""}">${r.without_tg}</div><div class="s">nie dostaną</div></div>
      <div class="kpi"><div class="l">Języki w bocie</div><div class="s" style="margin-top:6px;font-size:12px;color:var(--text2)">${langs || "—"}</div></div>
    </div>
    ${r.rows.length ? `<details class="more"><summary>Lista osób (${r.total})</summary><div class="tblwrap" style="max-height:360px;overflow-y:auto;margin-top:8px">
      <table class="fl"><thead><tr><th>Pracownik</th><th>Obiekt</th><th>Status</th><th>Ostatni dzień</th><th>Telegram</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td>${esc(x.full_name)} <span class="sub">#${esc(x.login || "")}</span></td>
        <td>${esc(x.facility || "—")}${x.region ? `<div class="sub">${esc(x.region)}</div>` : ""}</td>
        <td>${x.working ? "pracuje" : esc(STATUS_PL[x.status] || x.status || "—")}</td>
        <td>${x.working ? "" : ddy(x.last_day)}</td>
        <td>${x.has_tg ? `<span class="tag ok">tak</span>` : `<span class="tag bad">brak</span>`}</td></tr>`).join("")}
      ${r.more ? `<tr><td colspan="5" class="dim">… i jeszcze ${r.more}</td></tr>` : ""}
      </tbody></table></div></details>` : ""}`;
  const btn = document.getElementById("btnSend");
  btn.disabled = !r.with_tg;
  btn.textContent = `📣 Wyślij (${r.with_tg})`;
}
async function sendTest() {
  const msg = document.getElementById("sendMsg");
  const t = texts();
  if (!t.body) { msg.innerHTML = `<span class="bad">Wpisz treść wiadomości</span>`; return; }
  msg.innerHTML = `<span class="dim">Wysyłam test…</span>`;
  const r = await api("/test", { method: "POST", body: t });
  msg.innerHTML = r && r.ok ? `<span class="good">Test wysłany — sprawdź Telegram</span>` : `<span class="bad">${esc(r ? r.error : "Błąd")}</span>`;
}
async function sendAll() {
  const msg = document.getElementById("sendMsg");
  const t = texts();
  if (!t.body) { msg.innerHTML = `<span class="bad">Wpisz treść wiadomości</span>`; return; }
  const a = audience();
  if (!ST.aud || ST.audKey !== JSON.stringify(a)) { msg.innerHTML = `<span class="bad">Najpierw „Pokaż odbiorców”</span>`; return; }
  if (!confirm(`Wysłać wiadomość do ${ST.aud.with_tg} os. przez bota?\n\nTego nie da się cofnąć — można tylko zatrzymać niewysłane.`)) return;
  const btn = document.getElementById("btnSend");
  btn.disabled = true;
  msg.innerHTML = `<span class="dim">Wysyłam…</span>`;
  const r = await api("/send", { method: "POST", body: { audience: a, ...t, expected: ST.aud.with_tg } });
  if (!r || !r.ok) { btn.disabled = false; msg.innerHTML = `<span class="bad">${esc(r ? r.error : "Błąd")}</span>`; return; }
  msg.innerHTML = `<span class="good">Wysyłka #${r.id} ruszyła: ${r.count} os.</span> <a href="#history" onclick="showView('history');return false" style="color:var(--accent)">Historia →</a>`;
  document.getElementById("body").value = "";
  ["uk", "ru", "pl"].forEach((l) => (document.getElementById("t_" + l).value = ""));
  onText(); changed();
  loadHistory(true);
}

// ── Historia ──────────────────────────────────────────────────────────
const MSG_STATUS = { sending: ["wysyłanie", "run"], done: ["wysłano", "ok"], cancelled: ["zatrzymano", "bad"] };
async function loadHistory(quiet) {
  const r = await api("/messages");
  if (!r) return;
  const box = document.getElementById("histTable");
  if (!r.ok) { if (!quiet) box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.hist = r.rows;
  const running = r.rows.filter((x) => x.status === "sending").length;
  document.getElementById("badgeRun").textContent = running || "";
  document.getElementById("histCnt").textContent = r.rows.length ? `${r.rows.length}` : "";
  box.innerHTML = r.rows.length ? `<table class="fl"><thead><tr>
      <th>Kiedy</th><th>Do kogo</th><th>Treść</th><th class="r">Wysłano</th><th class="r">Błędy</th><th>Stan</th><th></th></tr></thead><tbody>
    ${r.rows.map((x) => {
      const [st, cls] = MSG_STATUS[x.status] || [x.status, ""];
      return `<tr class="rowlink" onclick="openMessage(${x.id})">
        <td style="white-space:nowrap">${ts(x.created_at)}<div class="sub">${esc(x.author || "")}</div></td>
        <td>${esc(x.audience_label || "")}</td>
        <td><div class="txt">${esc(x.body.length > 140 ? x.body.slice(0, 140) + "…" : x.body)}</div></td>
        <td class="r">${x.sent} / ${x.total}</td>
        <td class="r ${x.failed ? "bad" : "dim"}">${x.failed || ""}</td>
        <td><span class="tag ${cls}">${st}${x.status === "sending" ? ` · ${x.queued}` : ""}</span></td>
        <td>${x.status === "sending" ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();cancelMessage(${x.id})">⏹ Zatrzymaj</button>` : ""}</td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">Jeszcze nic nie wysłano</div>`;
  // w trakcie wysyłki — odświeżaj co 5 s
  clearTimeout(ST.timer);
  if (running) ST.timer = setTimeout(() => loadHistory(true), 5000);
}
async function cancelMessage(id) {
  if (!confirm("Zatrzymać wysyłkę? Kto już dostał — ma wiadomość; reszta nie dostanie.")) return;
  const r = await api(`/messages/${id}/cancel`, { method: "POST" });
  if (!r || !r.ok) { alert(r ? r.error : "Błąd"); return; }
  loadHistory();
  if (document.getElementById("drawer").classList.contains("open")) openMessage(id);
}

const DLV = { sent: ["dostarczono", "ok"], queued: ["w kolejce", "run"], failed: ["błąd", "bad"], blocked: ["zablokował bota", "bad"], cancelled: ["zatrzymano", ""] };
async function openMessage(id) {
  const dw = document.getElementById("drawer");
  dw.innerHTML = `<div class="dw-head"><div><h2>Wysyłka #${id}</h2></div><button class="dw-close" onclick="closeDrawer()" title="Zamknij (Esc)">✕</button></div>
    <div class="dw-body"><div class="loading">Ładowanie…</div></div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  const r = await api(`/messages/${id}`);
  const body = dw.querySelector(".dw-body");
  if (!r || !r.ok) { body.innerHTML = `<div class="error">${esc(r ? r.error : "Błąd")}</div>`; return; }
  const m = r.message;
  const [st, cls] = MSG_STATUS[m.status] || [m.status, ""];
  dw.querySelector(".dw-head > div").innerHTML = `<h2>Wysyłka #${m.id}</h2><div class="sub">${ts(m.created_at)} · ${esc(m.author || "")} · ${esc(m.audience_label || "")}</div>`;
  const tr = Object.entries(m.texts || {}).map(([l, t]) => `<div class="lbl" style="margin-top:10px">${esc(LANG_PL[l] || l)}</div><div class="txt">${esc(t)}</div>`).join("");
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="l">Dostarczono</div><div class="v good">${m.sent}</div><div class="s">z ${m.total}</div></div>
      <div class="kpi"><div class="l">Błędy</div><div class="v ${m.failed ? "bad" : ""}">${m.failed}</div><div class="s">m.in. zablokowali bota</div></div>
      <div class="kpi"><div class="l">Stan</div><div class="v" style="font-size:15px;margin-top:8px"><span class="tag ${cls}">${st}</span></div>
        ${m.status === "sending" ? `<div class="s"><a href="#" style="color:var(--red)" onclick="cancelMessage(${m.id});return false">⏹ Zatrzymaj</a></div>` : ""}</div>
    </div>
    <div class="lbl">Treść</div><div class="txt">${esc(m.body)}</div>${tr}
    <div class="tblwrap" style="margin-top:14px"><table class="fl"><thead><tr><th>Pracownik</th><th>Obiekt teraz</th><th>Stan</th><th>Kiedy</th></tr></thead><tbody>
    ${r.rows.map((x) => {
      const [s, c] = DLV[x.status] || [x.status, ""];
      return `<tr><td>${esc(x.full_name)} <span class="sub">#${esc(x.login || "")}</span></td><td>${esc(x.facility || "—")}</td>
        <td><span class="tag ${c}">${s}</span>${x.error ? `<div class="sub">${esc(x.error)}</div>` : ""}</td>
        <td style="white-space:nowrap">${x.status === "sent" ? ts(x.sent_at) : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

init();
