// ══════════════════════════════════════════════════════════════════════
//  Raport „kto nie wypełnił godzin” (dawniej na sztywno o 17:00):
//  godzina, dni, które wiadomości, komu wysyłać i w jakim zakresie. Tylko admin.
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = { data: null };
const SCOPE_PL = { own: "Swoje obiekty", region: "Region (jako regionalny)", all: "Cała firma" };
const DAYS = [[1, "pn"], [2, "wt"], [3, "śr"], [4, "cz"], [5, "pt"], [6, "sb"], [7, "nd"]];

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const dd = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) : "");
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["content-type"] = "application/json"; }
  try {
    const r = await fetch("/api/hours-report" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const setMsg = (id, ok, text) => { const m = document.getElementById(id); if (m) { m.className = "msg " + (ok ? "ok" : "err"); m.textContent = text; } };

window.addEventListener("DOMContentLoaded", async () => {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  if (!me.ok || !me.is_admin) {
    document.getElementById("content").innerHTML = `<div class="noaccess">⏰ Ustawienia raportu godzin są dostępne tylko dla administratora.</div>`;
    return;
  }
  load();
});

async function load() {
  const r = await api("/settings");
  if (!r || !r.ok) { document.getElementById("content").innerHTML = `<div class="noaccess">${esc((r && r.error) || "Błąd")}</div>`; return; }
  ST.data = r;
  render();
}

function render() {
  const r = ST.data, S = r.settings;
  const days = String(S.days || "").split(",");
  const runs = r.runs.length
    ? r.runs.map((x) => `${dd(x.day)} ${esc(x.at)} → ${x.sent == null ? "w trakcie" : x.sent}${x.failed ? ` (+${x.failed} błąd)` : ""}`).join(" · ")
    : "jeszcze żadnego";
  document.getElementById("content").innerHTML = `
  <div class="banner">Codziennie o wybranej godzinie koordynatorzy dostają w Telegramie: <b>kto nie wypełnił godzin wczoraj</b>
    i <b>braki od 1. dnia miesiąca do wczoraj</b>. <b>Dzisiejszy dzień nie jest liczony</b> — jeszcze trwa.
    Pierwszego dnia miesiąca — cały poprzedni miesiąc.</div>

  <div class="section">
    <div class="section-head">Ustawienia raportu</div>
    <div class="cfg">
      <span class="k">Raport włączony</span><span><input type="checkbox" id="s_enabled" ${S.enabled === "1" ? "checked" : ""}/></span>
      <span class="k">Godzina</span><span><input type="time" id="s_time" value="${esc(S.time || "17:00")}"/></span>
      <span class="h">Czas polski. Jeśli serwer był wyłączony o tej godzinie, raport pójdzie po włączeniu (do 2 godzin później), raz dziennie.</span>
      <span class="k">Dni</span><span class="days">${DAYS.map(([v, l]) => `<label><input type="checkbox" class="sday" value="${v}" ${days.includes(String(v)) ? "checked" : ""}/> ${l}</label>`).join("")}</span>
      <span class="k">Wiadomości</span><span class="chk-row">
        <label><input type="checkbox" id="s_yesterday" ${S.yesterday_msg !== "0" ? "checked" : ""}/> kto nie wypełnił wczoraj</label>
        <label><input type="checkbox" id="s_month" ${S.month_msg !== "0" ? "checked" : ""}/> braki od 1. dnia miesiąca do wczoraj</label></span>
    </div>
    <div class="actions">
      <button class="btn btn-primary btn-sm" onclick="saveSettings()">Zapisz ustawienia</button><span class="msg" id="setMsg"></span>
      <span style="margin-left:auto;font-size:11px;color:var(--text3)">Ostatnie wysyłki: ${runs}</span>
    </div>
  </div>

  <div class="section">
    <div class="section-head">Odbiorcy <span class="cnt" id="recCnt"></span>
      <span class="spacer"></span>
      <input type="text" class="inp" id="recSearch" placeholder="Szukaj koordynatora…" oninput="renderRecipients()" style="width:170px"/>
      <label style="font-size:11px;color:var(--text2);font-weight:400"><input type="checkbox" id="onlyTg" onchange="renderRecipients()"/> tylko z Telegramem</label>
      <button class="btn btn-ghost btn-sm" onclick="bulk(true)" title="Włącz wszystkich widocznych w tabeli">✓ wszystkim</button>
      <button class="btn btn-ghost btn-sm" onclick="bulk(false)" title="Wyłącz wszystkich widocznych w tabeli">✕ nikomu</button>
      <span class="msg" id="recMsg"></span>
    </div>
    <div class="tblwrap" id="recTable"></div>
    <div class="note">Odznacz „Wysyłać” — koordynator nie dostanie raportu. Zakres domyślnie: rola <b>head</b> — cała firma, pozostali — swoje obiekty
      (przypisane w karcie koordynatora). „Region” — obiekty regionów, w których jest regionalnym (Region → Ustawienia), plus swoje.
      Bez Telegrama w karcie albo bez obiektów — nic nie dostaje. 🧪 — wysyła na Twój Telegram raport tak, jak zobaczy go ten koordynator.</div>
  </div>`;
  renderRecipients();
}

function visibleRows() {
  const q = (document.getElementById("recSearch").value || "").toLowerCase();
  const onlyTg = document.getElementById("onlyTg").checked;
  return ST.data.coordinators.filter((c) => (!q || c.full_name.toLowerCase().includes(q)) && (!onlyTg || c.has_tg));
}
function renderRecipients() {
  const all = ST.data.coordinators;
  const rows = visibleRows();
  const willGet = all.filter((c) => c.enabled && c.has_tg && (c.scope === "all" || c.own_n || (c.scope === "region" && c.lead_regions))).length;
  document.getElementById("recCnt").textContent = `${willGet} dostanie z ${all.length}`;
  if (!rows.length) { document.getElementById("recTable").innerHTML = `<div class="empty">Nikt nie pasuje</div>`; return; }
  const scopeOpts = (c) => `<option value="" ${!c.scope_set ? "selected" : ""}>domyślnie — ${SCOPE_PL[c.default_scope].toLowerCase()}</option>` +
    Object.entries(SCOPE_PL).map(([k, v]) => `<option value="${k}" ${c.scope_set && c.scope === k ? "selected" : ""} ${k === "region" && !c.lead_regions ? "disabled" : ""}>${v}</option>`).join("");
  const why = (c) => (!c.has_tg ? `<span class="tag bad">brak Telegrama</span>`
    : c.scope === "own" && !c.own_n ? `<span class="tag bad">brak obiektów</span>` : "");
  document.getElementById("recTable").innerHTML = `<table class="fl"><thead><tr>
      <th class="c">Wysyłać</th><th>Koordynator</th><th class="c">Telegram</th><th class="c">Swoje obiekty</th><th>Regionalny w</th><th>Zakres raportu</th><th></th>
    </tr></thead><tbody>
    ${rows.map((c) => `<tr class="${c.enabled ? "" : "off"}">
      <td class="c"><input type="checkbox" ${c.enabled ? "checked" : ""} data-id="${c.id}" onchange="saveRow(Number(this.dataset.id))" class="r_on"/></td>
      <td>${esc(c.full_name)} ${c.role === "head" ? `<span class="tag head">head</span>` : ""} ${why(c)}</td>
      <td class="c">${c.has_tg ? `<span class="good">✓</span>` : `<span class="dim">—</span>`}</td>
      <td class="c">${c.own_n || `<span class="dim">0</span>`}</td>
      <td>${c.lead_regions ? esc(c.lead_regions) : `<span class="dim">—</span>`}</td>
      <td><select class="sel r_scope" data-id="${c.id}" onchange="saveRow(Number(this.dataset.id))">${scopeOpts(c)}</select></td>
      <td><button class="btn btn-ghost btn-sm" data-id="${c.id}" onclick="testRow(Number(this.dataset.id))" title="Wyślij mi raport tak, jak zobaczy go ten koordynator">🧪</button></td>
    </tr>`).join("")}</tbody></table>`;
}

async function saveSettings() {
  const days = [...document.querySelectorAll(".sday:checked")].map((x) => x.value).join(",");
  if (!days) return setMsg("setMsg", false, "Zaznacz co najmniej jeden dzień");
  const body = {
    enabled: document.getElementById("s_enabled").checked ? "1" : "0",
    time: document.getElementById("s_time").value,
    days,
    yesterday_msg: document.getElementById("s_yesterday").checked ? "1" : "0",
    month_msg: document.getElementById("s_month").checked ? "1" : "0",
  };
  if (body.yesterday_msg === "0" && body.month_msg === "0") return setMsg("setMsg", false, "Zaznacz co najmniej jedną wiadomość");
  const r = await api("/settings", { method: "PATCH", body });
  if (!r || !r.ok) return setMsg("setMsg", false, (r && r.error) || "Błąd");
  setMsg("setMsg", true, "Zapisano");
  const keep = ST.data;
  Object.assign(keep.settings, body);
}

async function saveRow(id) {
  const tr = document.querySelector(`input.r_on[data-id="${id}"]`).closest("tr");
  const enabled = tr.querySelector(".r_on").checked;
  const scope = tr.querySelector(".r_scope").value;
  const r = await api(`/recipients/${id}`, { method: "PUT", body: { enabled, scope } });
  if (!r || !r.ok) return setMsg("recMsg", false, (r && r.error) || "Błąd");
  const c = ST.data.coordinators.find((x) => x.id === id);
  c.enabled = enabled; c.scope_set = !!scope; c.scope = scope || c.default_scope;
  setMsg("recMsg", true, `Zapisano: ${c.full_name}`);
  renderRecipients();
}

async function bulk(enabled) {
  const ids = visibleRows().map((c) => c.id);
  if (!ids.length) return;
  const r = await api("/recipients/bulk", { method: "POST", body: { ids, enabled } });
  if (!r || !r.ok) return setMsg("recMsg", false, (r && r.error) || "Błąd");
  setMsg("recMsg", true, `${enabled ? "Włączono" : "Wyłączono"}: ${ids.length}`);
  await load();
}

async function testRow(id) {
  setMsg("recMsg", true, "Wysyłanie testu…");
  const r = await api("/test", { method: "POST", body: { coordinator_id: id } });
  if (!r || !r.ok) return setMsg("recMsg", false, (r && r.error) || "Błąd");
  setMsg("recMsg", true, "Wysłano test — sprawdź swój Telegram");
}
