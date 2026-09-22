// ══════════════════════════════════════════════════════════════════════
//  Розділ «Region» — RAG-дошка регіонального координатора
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "board",
  me: null,
  board: null,
  boardFilter: "all",
  cardFilter: "active",
  reasons: [],
  coordinators: [],
  config: null,
  siteKey: null,
};
const STATUS_LABEL = { R: "Czerwony", A: "Żółty", G: "Zielony", S: "Strukturalny", N: "Brak danych" };
const CLOSE_LABEL = { left_red: "wyszedł z czerwonego", structural: "przypadek strukturalny" };

// ── Утиліти ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function pct(v, d) {
  if (v == null || isNaN(v)) return "—";
  return (v * 100).toFixed(d == null ? 0 : d).replace(".", ",") + "%";
}
function dd(iso) { return iso ? iso.substring(8, 10) + "." + iso.substring(5, 7) : ""; }
// дата з роком, якщо рік інший, ніж у вибраному тижні
function ddr(iso) {
  if (!iso) return "";
  const wy = (document.getElementById("selWeek").value || "").substring(0, 4);
  return iso.substring(0, 4) === wy ? dd(iso) : dd(iso) + "." + iso.substring(2, 4);
}
function ddy(iso) { return iso ? dd(iso) + "." + iso.substring(0, 4) : ""; }
function pill(s) { return `<span class="pill ${s}" title="${STATUS_LABEL[s] || ""}">${s === "S" ? "S" : s === "N" ? "–" : s}</span>`; }
function dot(s) { return `<span class="dot ${s || "x"}"></span>`; }
function metric(value, st, d) {
  if (value == null) return `<span class="m" style="color:var(--text3)">—</span>`;
  return `<span class="m">${pct(value, d)} ${dot(st)}</span>`;
}

async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  const r = await fetch("/api/regional" + path, o);
  if (r.status === 401) { location.href = "/login.html"; return null; }
  return r.json();
}
function qs(extra) {
  const p = new URLSearchParams();
  const reg = document.getElementById("selRegion").value;
  const week = document.getElementById("selWeek").value;
  if (reg) p.set("region", reg);
  if (week) p.set("week", week);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return "?" + p.toString();
}

// ── Старт ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", init);

async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  ST.me = me;
  if (!me.has_access) {
    document.querySelector(".rg-toolbar").style.display = "none";
    document.querySelectorAll(".nav-item[data-view]").forEach((el) => (el.style.display = "none"));
    document.getElementById("content").innerHTML =
      `<div class="noaccess">🚦 Sekcja <b>Region</b> jest dostępna dla koordynatorów regionalnych.<br>
       Jeśli prowadzisz region, poproś kierownika działu o przypisanie w ustawieniach sekcji.</div>`;
    return;
  }
  const selR = document.getElementById("selRegion");
  const opts = [];
  if (me.is_admin) {
    opts.push(`<option value="all">Wszystkie regiony</option>`);
    opts.push(`<option value="none">Bez regionu</option>`);
  } else if (me.regions.length > 1) {
    opts.push(`<option value="all">Moje regiony</option>`);
  }
  me.regions.forEach((r) =>
    opts.push(`<option value="${r.id}">${esc(r.name)}${r.regional_name ? " — " + esc(r.regional_name) : ""}</option>`));
  selR.innerHTML = opts.join("");
  const savedRegion = localStorage.getItem("sas_region_sel");
  if (savedRegion && [...selR.options].some((o) => o.value === savedRegion)) selR.value = savedRegion;
  if (me.is_admin) document.getElementById("navSettings").style.display = "";

  const [weeks, reasons, coords] = await Promise.all([api("/weeks"), api("/reasons"), api("/coordinators-list")]);
  ST.reasons = (reasons && reasons.data) || [];
  ST.coordinators = (coords && coords.data) || [];
  const selW = document.getElementById("selWeek");
  const wl = (weeks && weeks.data) || [];
  selW.innerHTML = wl.length
    ? wl.map((w) => `<option value="${w}">${ddy(w)}</option>`).join("")
    : `<option value="">— brak danych —</option>`;

  if (!wl.length) {
    document.getElementById("kpis").innerHTML = "";
    document.getElementById("boardTable").innerHTML = me.is_admin
      ? `<div class="empty">Brak przeliczonych tygodni. Wejdź w <b>Ustawienia → Przeliczenie</b> i przelicz historię.</div>`
      : `<div class="empty">Brak przeliczonych tygodni. Pierwsze dane pojawią się w poniedziałek rano.</div>`;
    if (me.is_admin) showView("settings");
    return;
  }
  const h = location.hash.replace("#", "");
  showView(["board", "coords", "cards", "settings"].includes(h) ? h : "board");
}

function onFilterChange() {
  localStorage.setItem("sas_region_sel", document.getElementById("selRegion").value);
  loadView();
}

function showView(v) {
  if (v === "settings" && !(ST.me && ST.me.is_admin)) v = "board";
  ST.view = v;
  location.hash = v;
  document.querySelectorAll(".rg-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent =
    { board: "Region — tablica", coords: "Region — koordynatorzy", cards: "Region — karty", settings: "Region — ustawienia" }[v];
  loadView();
}

function loadView() {
  if (ST.view === "board") loadBoard();
  if (ST.view === "coords") loadCoords();
  if (ST.view === "cards") loadCards();
  if (ST.view === "settings") loadSettings();
  refreshCardBadge();
}

async function refreshCardBadge() {
  const r = await api("/cards" + qs({ status: "overdue" }));
  const n = r && r.ok ? r.data.length : 0;
  document.getElementById("badgeCards").textContent = n ? String(n) : "";
  document.getElementById("badgeCards").title = n ? `${n} kart po terminie` : "";
}

// ══════════════════════════════════════════════════════════════════════
//  Tablica
// ══════════════════════════════════════════════════════════════════════
async function loadBoard() {
  document.getElementById("boardTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/board" + qs());
  if (!r) return;
  if (!r.ok) { document.getElementById("boardTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.board = r;
  renderKpis();
  renderBoard();
  renderLegend();
}

function renderKpis() {
  const k = ST.board.kpi;
  if (!k) { document.getElementById("kpis").innerHTML = ""; return; }
  const onTime = k.cards_due ? k.cards_on_time / k.cards_due : null;
  document.getElementById("kpis").innerHTML = `
    <div class="kpi"><div class="l">Ludzie w czerwonych obiektach</div>
      <div class="v" style="color:${k.share_red > 0.3 ? "var(--rag-r)" : k.share_red > 0.1 ? "var(--rag-a)" : "var(--rag-g)"}">${pct(k.share_red)}</div>
      <div class="s">${k.hc_red || 0} z ${k.hc || 0} osób, tydzień do ${ddy(ST.board.week)}</div></div>
    <div class="kpi"><div class="l">Średnio w kwartale</div>
      <div class="v">${pct(k.share_red_quarter)}</div>
      <div class="s">od ${ddy(k.quarter_start)}, ${k.weeks_in_quarter} tyg.</div></div>
    <div class="kpi"><div class="l">Obiekty: czerwone / żółte / zielone</div>
      <div class="v"><span class="r">${k.sites_red}</span><span class="sep">/</span><span class="a">${k.sites_amber}</span><span class="sep">/</span><span class="g">${k.sites_green}</span></div>
      <div class="s">${k.sites_other ? k.sites_other + " bez oceny (strukturalne / brak danych)" : "wszystkie ocenione"}</div></div>
    <div class="kpi"><div class="l">Wyszły z czerwonego w kwartale</div>
      <div class="v">${k.red_exited}<span class="sep">z</span>${k.red_at_start}</div>
      <div class="s">czerwone na początku kwartału</div></div>
    <div class="kpi"><div class="l">Karty wypełnione w terminie</div>
      <div class="v">${onTime == null ? "—" : pct(onTime)}</div>
      <div class="s">${k.cards_on_time} z ${k.cards_due}${k.cards_overdue ? ` · <span style="color:var(--rag-r)">${k.cards_overdue} po terminie</span>` : ""}</div></div>`;
}

function setBoardFilter(f) {
  ST.boardFilter = f;
  document.querySelectorAll("#boardChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.f === f));
  renderBoard();
}

function cardTag(s) {
  if (!s.card_id) return `<span class="muted">—</span>`;
  if (s.card_status === "filled") return `<span class="card-tag filled">✓ wypełniona</span>`;
  if (s.card_overdue) return `<span class="card-tag late">po terminie</span>`;
  return `<span class="card-tag open">do ${dd(s.card_due.substring(0, 10))}</span>`;
}

function trendHtml(t, week) {
  const list = t || [];
  return `<span class="trend">${list.map((x) => `<i class="${x.s}" title="${ddy(x.w)}: ${STATUS_LABEL[x.s] || x.s}"></i>`).join("")}</span>`;
}

function renderBoard() {
  if (!ST.board) return;
  const q = (document.getElementById("boardSearch").value || "").toLowerCase();
  const multi = document.getElementById("selRegion").value === "all" && (ST.me.is_admin || ST.me.regions.length > 1);
  const rows = ST.board.sites.filter(
    (s) => (ST.boardFilter === "all" || s.status === ST.boardFilter) &&
      (!q || s.site_key.toLowerCase().includes(q) || (s.coordinator_name || "").toLowerCase().includes(q)));
  document.getElementById("boardCnt").textContent = `${rows.length} z ${ST.board.sites.length}`;
  if (!rows.length) { document.getElementById("boardTable").innerHTML = `<div class="empty">Brak obiektów</div>`; return; }
  document.getElementById("boardTable").innerHTML = `
    <table class="rg"><thead><tr>
      <th></th><th>Obiekt</th><th>Koordynator</th>${multi ? "<th>Region</th>" : ""}
      <th class="num">Ludzie</th><th class="num">Rotacja</th><th class="num">Dożycie</th><th class="num">NN</th>
      <th class="num">Tyg. czerw.</th><th>Trend 8 tyg.</th><th>Karta</th>
    </tr></thead><tbody>
    ${rows.map((s) => `
      <tr class="click" onclick="openSite('${encodeURIComponent(s.site_key)}')">
        <td>${pill(s.status)}</td>
        <td><b>${esc(s.site_key)}</b>${s.window_days !== 28 ? ` <span class="muted" title="Mały obiekt — okno ${s.window_days} dni">·${s.window_days}d</span>` : ""}
            ${s.status === "R" && s.raw_status !== "R" ? ` <span class="muted" title="Wskaźniki już poniżej progu, obiekt wychodzi z czerwonego">↗</span>` : ""}</td>
        <td>${s.coordinator_name ? esc(s.coordinator_name) : `<span class="muted">— nieprzypisany —</span>`}</td>
        ${multi ? `<td>${s.region_name ? esc(s.region_name) : `<span class="muted">—</span>`}</td>` : ""}
        <td class="num">${s.headcount_end}</td>
        <td class="num" title="${s.departures} odejść przy średnio ${String(s.headcount_avg).replace(".", ",")} osobach">${metric(s.rotation, s.st_rot)}</td>
        <td class="num" title="${s.ret_achieved} z ${s.ret_possible} wag">${metric(s.ret_possible ? s.retention : null, s.st_ret)}</td>
        <td class="num" title="${s.abs_nn} dni NN z ${s.abs_base}">${metric(s.abs_base ? s.absence : null, s.st_abs, 1)}</td>
        <td class="num">${s.red_weeks || ""}</td>
        <td>${trendHtml(s.trend)}</td>
        <td>${cardTag(s)}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

function renderLegend() {
  const s = ST.board.settings || {};
  const absOn = s.abs_enabled === 1;
  document.getElementById("legend").innerHTML =
    `Status = najgorszy z kryteriów. Rotacja (na 28 dni): zielony ≤${pct(s.rot_green_max)}, czerwony >${pct(s.rot_amber_max)}. ` +
    `Dożycie do ${s.ret_days_1}/${s.ret_days_2} dni: zielony ≥${pct(s.ret_green_min)}, czerwony <${pct(s.ret_amber_min)}. ` +
    `NN: zielony ≤${pct(s.abs_green_max)}, czerwony >${pct(s.abs_amber_max)}${absOn ? "" : " — <b>tylko informacyjnie, nie wpływa na status</b>"}. ` +
    `Wyjście z czerwonego: ${s.exit_red_weeks} tyg. z rzędu poniżej progu. Obiekty poniżej ${s.small_site_headcount} osób liczone w oknie ${s.small_site_window_days} dni.`;
}

// ══════════════════════════════════════════════════════════════════════
//  Панель об'єкта
// ══════════════════════════════════════════════════════════════════════
async function openSite(encKey) {
  const key = decodeURIComponent(encKey);
  ST.siteKey = key;
  const dw = document.getElementById("drawer");
  dw.innerHTML = `<div class="dw-head"><h2>${esc(key)}</h2><button class="dw-close" onclick="closeDrawer()">✕</button></div>
                  <div class="loading">Ładowanie…</div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  const week = document.getElementById("selWeek").value;
  const r = await api(`/site?key=${encodeURIComponent(key)}&week=${week}`);
  if (!r) return;
  if (!r.ok) { dw.innerHTML += `<div class="error">${esc(r.error)}</div>`; return; }
  renderSite(r);
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
  ST.siteKey = null;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

function renderSite(r) {
  const s = r.snapshot;
  const owner = r.owner || {};
  const dw = document.getElementById("drawer");
  const status = s ? s.status : "N";
  const crit = (label, v, st, sub, d) => `
    <div class="${st || "x"}"><div class="l">${label}</div>
      <div class="v">${v == null ? "—" : pct(v, d)}</div><div class="s">${sub}</div></div>`;

  dw.innerHTML = `
    <div class="dw-head">
      ${pill(status)}
      <div><h2>${esc(r.site_key)}</h2>
        <div class="sub">${esc(owner.region_name || (s && s.region_name) || "bez regionu")} ·
          ${esc(owner.coordinator_name || (s && s.coordinator_name) || "koordynator nieprzypisany")} ·
          tydzień do ${ddy(r.week)}${s ? ` · okno ${s.window_days} dni` : ""}</div></div>
      <button class="dw-close" onclick="closeDrawer()" title="Zamknij (Esc)">✕</button>
    </div>
    <div class="dw-body">
      ${s ? `
      <div class="crit">
        ${crit("Rotacja (na 28 dni)", s.rotation, s.st_rot, `${s.departures} odejść przy średnio ${String(s.headcount_avg).replace(".", ",")} osobach`)}
        ${crit(`Dożycie do ${r.thresholds.d1}/${r.thresholds.d2} dni`, s.ret_possible ? s.retention : null, s.st_ret,
               s.ret_possible ? `${s.ret_achieved} z ${s.ret_possible} wag` : "za mało osób przy progach")}
        ${crit("Nieobecności NN" + ((ST.board && ST.board.settings && ST.board.settings.abs_enabled === 1) ? "" : " · informacyjnie"),
               s.abs_base ? s.absence : null, s.st_abs,
               s.abs_base ? `${s.abs_nn} dni NN z ${s.abs_base} dni` : "brak danych o godzinach", 1)}
      </div>` : `<div class="empty">Brak danych za ten tydzień</div>`}

      <div class="h3">Historia statusu <span class="c">12 tygodni</span></div>
      <div class="hist">${r.history.map((h) => `
        <div class="${h.w === r.week ? "cur" : ""}" title="${ddy(h.w)}: ${STATUS_LABEL[h.status]} · rotacja ${pct(h.rotation)} · dożycie ${pct(h.retention)} · ${h.headcount_end} os.">
          <i class="${h.status}"></i>${dd(h.w)}</div>`).join("")}</div>

      <div id="cardBox">${renderCardBox(r.card)}</div>

      <div class="h3">Zbliżają się do progu <span class="c">następne 14 dni — tych ludzi trzeba utrzymać</span></div>
      ${r.approaching.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th>Obiekt</th><th class="num">Start</th><th class="num">Próg</th><th class="num">Data</th><th class="num">Zostało</th></tr></thead><tbody>
        ${r.approaching.map((a) => `<tr><td>${esc(a.full_name)} <span class="muted">${esc(a.login)}</span></td><td class="muted">${esc(a.facility)}</td>
          <td class="num">${ddr(a.bhp)}</td><td class="num">${a.threshold} dni</td><td class="num">${dd(a.date)}</td>
          <td class="num">${a.days_left} d</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Nikt nie przekracza progu w najbliższych 14 dniach</div>`}

      <div class="h3">Odejścia w oknie <span class="c">${r.departures.length} osób, od najkrótszego stażu</span></div>
      ${r.departures.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th>Obiekt</th><th class="num">Start</th><th class="num">Ostatni dzień</th><th class="num">Staż</th></tr></thead><tbody>
        ${r.departures.map((d) => `<tr><td>${esc(d.full_name)} <span class="muted">${esc(d.login)}</span></td><td class="muted">${esc(d.facility)}</td>
          <td class="num">${ddr(d.bhp)}</td><td class="num">${ddr(d.last_day)}</td>
          <td class="num ${d.tenure <= 30 ? "tag-short" : ""}">${d.tenure} d</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Brak odejść w oknie</div>`}

      <div class="h3">Nieobecności bez przyczyny (NN) <span class="c">w oknie</span></div>
      ${r.absences.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th class="num">Dni NN</th><th>Daty</th></tr></thead><tbody>
        ${r.absences.map((a) => `<tr><td>${esc(a.full_name)} <span class="muted">${esc(a.login)}</span></td>
          <td class="num">${a.nn}</td><td class="muted">${esc(a.days)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Brak NN w oknie</div>`}
    </div>`;
}

function renderCardBox(c) {
  if (!c) return "";
  if (c.status === "closed") {
    return `<div class="h3">Karta czerwonego obiektu</div>
      <div class="redcard filled"><div class="top"><b>Ostatnia karta zamknięta</b>
        <span class="muted">tydzień ${ddy(c.closed_week || "")} — ${esc(CLOSE_LABEL[c.close_reason] || c.close_reason || "")}</span></div>
        ${c.action_plan ? `<div style="font-size:12px">Plan: ${esc(c.action_plan)}</div>` : ""}</div>`;
  }
  const state = c.status === "filled"
    ? `<span class="card-tag filled">✓ wypełniona ${esc(c.filled_at_txt)}</span>`
    : c.overdue ? `<span class="card-tag late">po terminie (${esc(c.due_at_txt)})</span>`
    : `<span class="card-tag open">termin: ${esc(c.due_at_txt)}</span>`;
  const reasonOpts = [`<option value="">— wybierz —</option>`]
    .concat(ST.reasons.map((x) => `<option value="${x.code}" ${x.code === c.reason_code ? "selected" : ""}>${esc(x.label)}</option>`)).join("");
  const ownerId = c.owner_coordinator_id || (ST.board && (ST.board.sites.find((x) => x.site_key === c.site_key) || {}).coordinator_id);
  const ownerOpts = [`<option value="">— wybierz —</option>`]
    .concat(ST.coordinators.map((x) => `<option value="${x.id}" ${x.id === ownerId ? "selected" : ""}>${esc(x.full_name)}</option>`)).join("");
  return `
    <div class="h3">Karta czerwonego obiektu <span class="c">otwarta w tygodniu do ${ddy(c.opened_week)}</span></div>
    <div class="redcard ${c.status === "filled" ? "filled" : ""}">
      <div class="top"><b>Co się dzieje i co robimy</b> ${state}</div>
      <div class="form">
        <div><label for="cReason">Przyczyna</label><select id="cReason">${reasonOpts}</select></div>
        <div><label for="cOwner">Odpowiedzialny</label><select id="cOwner">${ownerOpts}</select></div>
        <div class="full"><label for="cNote">Komentarz do przyczyny</label>
          <input type="text" id="cNote" value="${esc(c.reason_note || "")}" placeholder="np. hostel 25 km od zakładu" /></div>
        <div class="full"><label for="cPlan">Plan działań</label>
          <textarea id="cPlan" placeholder="Konkretnie: co, kto, kiedy">${esc(c.action_plan || "")}</textarea></div>
        <div><label for="cDue">Termin wykonania</label><input type="date" id="cDue" value="${esc(c.action_due || "")}" /></div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" onclick="saveCard(${c.id})">${c.status === "filled" ? "Zapisz zmiany" : "Wypełnij kartę"}</button>
        <span class="form-msg" id="cMsg"></span>
      </div>
      <div class="notes">
        ${(c.notes || []).map((n) => `<div class="note"><div class="meta">${esc(n.at)} · ${esc(n.by || "")}</div>${esc(n.text)}</div>`).join("")
          || `<div class="note" style="color:var(--text3)">Brak notatek o postępie</div>`}
        <div class="note-add"><input type="text" id="cNewNote" placeholder="Notatka o postępie…" onkeydown="if(event.key==='Enter')addNote(${c.id})" />
          <button class="btn btn-ghost btn-sm" onclick="addNote(${c.id})">Dodaj</button></div>
      </div>
    </div>`;
}

async function saveCard(id) {
  const body = {
    reason_code: document.getElementById("cReason").value,
    reason_note: document.getElementById("cNote").value,
    action_plan: document.getElementById("cPlan").value,
    action_due: document.getElementById("cDue").value,
    owner_coordinator_id: document.getElementById("cOwner").value,
  };
  const msg = document.getElementById("cMsg");
  const r = await api(`/cards/${id}`, { method: "PATCH", body });
  if (!r) return;
  if (!r.ok) { msg.className = "form-msg err"; msg.textContent = r.error; return; }
  msg.className = "form-msg ok"; msg.textContent = "Zapisano";
  await reloadSite();
  if (ST.view === "board") loadBoard();
  if (ST.view === "cards") loadCards();
  refreshCardBadge();
}

async function addNote(id) {
  const inp = document.getElementById("cNewNote");
  const text = inp.value.trim();
  if (!text) return;
  const r = await api(`/cards/${id}/notes`, { method: "POST", body: { text } });
  if (r && r.ok) reloadSite();
}

async function reloadSite() {
  if (!ST.siteKey) return;
  const week = document.getElementById("selWeek").value;
  const r = await api(`/site?key=${encodeURIComponent(ST.siteKey)}&week=${week}`);
  if (r && r.ok) renderSite(r);
}

// ══════════════════════════════════════════════════════════════════════
//  Koordynatorzy
// ══════════════════════════════════════════════════════════════════════
async function loadCoords() {
  const box = document.getElementById("coordsTable");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/coordinators" + qs());
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  document.getElementById("coordsCnt").textContent = `${r.data.length} · tydzień do ${ddy(r.week)}`;
  if (!r.data.length) { box.innerHTML = `<div class="empty">Brak danych</div>`; return; }
  box.innerHTML = `
    <table class="rg"><thead><tr><th>Koordynator</th><th>Obiekty</th><th class="num">Ludzie</th>
      <th class="num">W czerwonych</th><th class="num">Rotacja</th><th class="num">Dożycie</th><th class="num">NN</th></tr></thead><tbody>
    ${r.data.map((c) => `<tr>
        <td><b>${esc(c.coordinator_name)}</b></td>
        <td>${c.site_list.map((x) => `<span class="m" style="margin-right:10px;cursor:pointer" onclick="openSite('${encodeURIComponent(x.site)}')" title="${STATUS_LABEL[x.status]}">${dot(x.status)} ${esc(x.site)}</span>`).join("")}</td>
        <td class="num">${c.headcount || 0}</td>
        <td class="num">${c.headcount ? pct((c.headcount_red || 0) / c.headcount) : "—"}</td>
        <td class="num">${pct(c.rotation)}</td>
        <td class="num">${pct(c.retention)}</td>
        <td class="num">${pct(c.absence, 1)}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════
//  Karty
// ══════════════════════════════════════════════════════════════════════
function setCardFilter(s) {
  ST.cardFilter = s;
  document.querySelectorAll("#cardChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.s === s));
  loadCards();
}

async function loadCards() {
  const box = document.getElementById("cardsTable");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const reg = document.getElementById("selRegion").value;
  const r = await api(`/cards?region=${encodeURIComponent(reg)}&status=${ST.cardFilter}`);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  document.getElementById("cardsCnt").textContent = String(r.data.length);
  if (!r.data.length) { box.innerHTML = `<div class="empty">Brak kart</div>`; return; }
  const stTag = (c) => c.status === "closed" ? `<span class="muted">zamknięta ${dd(c.closed_week)}</span>`
    : c.status === "filled" ? `<span class="card-tag filled">✓ wypełniona${c.filled_late ? " (po terminie)" : ""}</span>`
    : c.overdue ? `<span class="card-tag late">po terminie</span>` : `<span class="card-tag open">do wypełnienia</span>`;
  box.innerHTML = `
    <table class="rg"><thead><tr><th>Obiekt</th><th>Region</th><th class="num">Od tyg.</th><th class="num">Termin</th>
      <th>Status</th><th>Przyczyna</th><th>Plan działań</th><th>Odpowiedzialny</th><th class="num">Do kiedy</th><th class="num">Tyg. czerw.</th></tr></thead><tbody>
    ${r.data.map((c) => `<tr class="click" onclick="openSite('${encodeURIComponent(c.site_key)}')">
        <td><b>${esc(c.site_key)}</b></td><td>${esc(c.region_name || "—")}</td>
        <td class="num">${dd(c.opened_week)}</td><td class="num">${dd(c.due_at.substring(0, 10))}</td>
        <td>${stTag(c)}</td><td>${esc(c.reason || "")}</td>
        <td style="max-width:280px">${esc(c.action_plan || "")}</td><td>${esc(c.owner_name || "")}</td>
        <td class="num">${dd(c.action_due)}</td><td class="num">${c.red_weeks || ""}</td></tr>`).join("")}
    </tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════
//  Ustawienia (admin)
// ══════════════════════════════════════════════════════════════════════
const SETTING_GROUPS = [
  ["Rotacja", ["rot_green_max", "rot_amber_max"]],
  ["Dożycie", ["ret_days_1", "ret_weight_1", "ret_days_2", "ret_weight_2", "ret_green_min", "ret_amber_min", "ret_min_weight"]],
  ["Nieobecności NN", ["abs_enabled", "abs_green_max", "abs_amber_max", "abs_min_days"]],
  ["Okno i reguły", ["window_days", "small_site_headcount", "small_site_window_days", "exit_red_weeks", "card_due_workdays", "escalate_red_weeks"]],
];
const SETTING_PL = {
  rot_green_max: "Rotacja: zielony do", rot_amber_max: "Rotacja: żółty do (powyżej — czerwony)",
  ret_days_1: "Próg stażu 1 (dni)", ret_weight_1: "Waga progu 1", ret_days_2: "Próg stażu 2 (dni)", ret_weight_2: "Waga progu 2",
  ret_green_min: "Dożycie: zielony od", ret_amber_min: "Dożycie: żółty od (poniżej — czerwony)",
  ret_min_weight: "Min. wag, żeby liczyć dożycie",
  abs_enabled: "NN wpływa na status (1 = tak, 0 = tylko informacja)", abs_green_max: "NN: zielony do",
  abs_amber_max: "NN: żółty do (powyżej — czerwony)", abs_min_days: "Min. dni pracy, żeby liczyć NN",
  window_days: "Okno liczenia (dni)", small_site_headcount: "Mały obiekt: poniżej osób",
  small_site_window_days: "Okno dla małych obiektów (dni)", exit_red_weeks: "Wyjście z czerwonego po tygodniach",
  card_due_workdays: "Dni robocze na wypełnienie karty", escalate_red_weeks: "Eskalacja po tygodniach w czerwonym",
};
const FRACTION_KEYS = ["rot_green_max", "rot_amber_max", "ret_green_min", "ret_amber_min", "abs_green_max", "abs_amber_max"];

async function loadSettings() {
  const box = document.getElementById("settingsBody");
  const r = await api("/admin/config");
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.config = r;
  const coordOpts = (sel) => `<option value="">—</option>` +
    ST.coordinators.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.full_name)}</option>`).join("");
  const regionOpts = (sel) => `<option value="">— bez regionu —</option>` +
    r.regions.map((g) => `<option value="${g.id}" ${g.id === sel ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  const sundays = [];
  const d = new Date(); d.setDate(d.getDate() - (d.getDay() === 0 ? 7 : d.getDay()));
  for (let i = 0; i < 26; i++) {
    const x = new Date(d); x.setDate(d.getDate() - 7 * i);
    sundays.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`);
  }
  const sv = Object.fromEntries(r.settings.map((x) => [x.key, x]));
  const unassigned = r.sites.filter((s) => !s.region_id && s.headcount > 0).length;

  box.innerHTML = `
    <div class="cfg-grid">
    <div class="section">
      <div class="section-head">Przeliczenie tygodnia</div>
      <div class="cfg-row">
        <label>Tydzień do</label>
        <select id="snapWeek">${sundays.map((w) => `<option value="${w}">${ddy(w)}</option>`).join("")}</select>
        <button class="btn btn-primary" onclick="runSnapshot(1)">Przelicz tydzień</button>
        <button class="btn btn-ghost" onclick="runSnapshot(12)">Przelicz 12 tygodni wstecz</button>
        <span class="form-msg" id="snapMsg"></span>
      </div>
      <div class="hint">Automatycznie: w poniedziałek o 6:00 za poprzedni tydzień. Zapisane tygodnie się nie zmieniają —
        po zmianie progów lub przypisań przelicz historię ręcznie. Karty otwierają się tylko dla najnowszego tygodnia.</div>
    </div>

    <div class="section">
      <div class="section-head">Regiony</div>
      <table class="rg"><thead><tr><th>Nazwa</th><th>Koordynator regionalny</th><th>Aktywny</th><th></th></tr></thead><tbody>
      ${r.regions.map((g) => `<tr>
        <td><input type="text" id="rgName${g.id}" value="${esc(g.name)}" /></td>
        <td><select id="rgCoord${g.id}">${coordOpts(g.regional_coordinator_id)}</select></td>
        <td><input type="checkbox" id="rgAct${g.id}" ${g.is_active ? "checked" : ""} /></td>
        <td><button class="btn btn-ghost btn-sm" onclick="saveRegion(${g.id})">Zapisz</button></td></tr>`).join("")}
      <tr><td><input type="text" id="rgNameNew" placeholder="Nowy region" /></td>
        <td><select id="rgCoordNew">${coordOpts(null)}</select></td><td></td>
        <td><button class="btn btn-primary btn-sm" onclick="addRegion()">Dodaj</button></td></tr>
      </tbody></table>
    </div>

    <div class="section">
      <div class="section-head">Obiekty — region i odpowiedzialny koordynator
        <span class="cnt">${unassigned ? `<span style="color:var(--rag-r)">${unassigned} obiektów z ludźmi bez regionu</span>` : ""}</span>
        <span class="spacer"></span>
        <label style="font-size:11px;color:var(--text2)"><input type="checkbox" id="onlyUnassigned" onchange="renderSitesCfg()" /> tylko bez regionu</label>
      </div>
      <div id="sitesCfg"></div>
      <div class="hint">Obiekt = grupa z pola <i>group_name</i> (np. IDL Psary = APT + SAS + WELL). Zmiana działa od podanej daty
        i na ostatnim tygodniu tablicy widać ją od razu. Wcześniejsze tygodnie zostają przy starym przypisaniu —
        żeby przypisać na całą historię, ustaw wcześniejszą datę i przelicz 12 tygodni.</div>
    </div>

    <div class="section">
      <div class="section-head">Progi statusu</div>
      <table class="rg"><tbody>
      ${SETTING_GROUPS.map(([title, keys]) => `
        <tr><td colspan="3" style="background:var(--surface2);font-weight:600">${title}</td></tr>
        ${keys.filter((k) => sv[k]).map((k) => `<tr>
          <td>${esc(SETTING_PL[k] || k)}</td>
          <td style="width:140px"><input type="number" step="${FRACTION_KEYS.includes(k) ? "1" : "1"}" min="0" id="set_${k}"
            value="${FRACTION_KEYS.includes(k) ? Math.round(sv[k].value * 1000) / 10 : sv[k].value}" style="width:90px" />
            ${FRACTION_KEYS.includes(k) ? "%" : ""}</td>
          <td class="muted">${esc(sv[k].note || "")}</td></tr>`).join("")}`).join("")}
      </tbody></table>
      <div class="cfg-row"><button class="btn btn-primary" onclick="saveSettings()">Zapisz progi</button><span class="form-msg" id="setMsg"></span></div>
    </div>

    <div class="section">
      <div class="section-head">Przypadki strukturalne <span class="cnt">klient zamyka lub tnie obiekt — obiekt szary, nie liczy się do wskaźników</span></div>
      ${r.flags.length ? `<table class="rg"><thead><tr><th>Obiekt</th><th class="num">Od</th><th class="num">Do</th><th>Notatka</th><th></th></tr></thead><tbody>
        ${r.flags.map((f) => `<tr><td>${esc(f.site_key)}</td><td class="num">${ddy(f.date_from)}</td>
          <td class="num">${f.date_to ? ddy(f.date_to) : "—"}</td><td>${esc(f.note || "")}</td>
          <td>${f.date_to ? "" : `<button class="btn btn-ghost btn-sm" onclick="endFlag(${f.id})">Zakończ dziś</button>`}</td></tr>`).join("")}
        </tbody></table>` : ""}
      <div class="cfg-row">
        <select id="flSite">${r.sites.map((s) => `<option value="${esc(s.site_key)}">${esc(s.site_key)}</option>`).join("")}</select>
        <label>od</label><input type="date" id="flFrom" />
        <label>do</label><input type="date" id="flTo" />
        <input type="text" id="flNote" placeholder="Powód" style="width:220px" />
        <button class="btn btn-primary btn-sm" onclick="addFlag()">Dodaj</button>
        <span class="form-msg" id="flMsg"></span>
      </div>
    </div>
    </div>`;
  renderSitesCfg();
}

function renderSitesCfg() {
  const r = ST.config;
  const only = document.getElementById("onlyUnassigned") && document.getElementById("onlyUnassigned").checked;
  const rows = r.sites.filter((s) => !only || !s.region_id);
  const coordOpts = (sel) => `<option value="">—</option>` +
    ST.coordinators.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.full_name)}</option>`).join("");
  const regionOpts = (sel) => `<option value="">— bez regionu —</option>` +
    r.regions.map((g) => `<option value="${g.id}" ${g.id === sel ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  const today = new Date().toISOString().substring(0, 10);
  document.getElementById("sitesCfg").innerHTML = `
    <table class="rg"><thead><tr><th>Obiekt</th><th class="num">Ludzie</th><th>Region</th><th>Koordynator</th><th>Od</th><th></th></tr></thead><tbody>
    ${rows.map((s, i) => `<tr>
      <td title="${esc(s.facilities || "")}"><b>${esc(s.site_key)}</b></td>
      <td class="num">${s.headcount}</td>
      <td><select id="stR${i}">${regionOpts(s.region_id)}</select></td>
      <td><select id="stC${i}">${coordOpts(s.coordinator_id)}</select></td>
      <td><input type="date" id="stF${i}" value="${today}" title="Obowiązuje od" /></td>
      <td><button class="btn btn-ghost btn-sm" onclick="saveSite(${i}, '${encodeURIComponent(s.site_key)}')">Zapisz</button>
        <span class="form-msg" id="stM${i}"></span></td></tr>`).join("")}
    </tbody></table>`;
}

async function runSnapshot(weeks) {
  const msg = document.getElementById("snapMsg");
  msg.className = "form-msg"; msg.textContent = "Liczę…";
  const r = await api("/admin/snapshot", { method: "POST", body: { week: document.getElementById("snapWeek").value, weeks } });
  if (!r) return;
  if (!r.ok) { msg.className = "form-msg err"; msg.textContent = r.error; return; }
  msg.className = "form-msg ok";
  msg.textContent = `Gotowe: ${r.data.length} tyg., ${r.data[r.data.length - 1].sites} obiektów w ostatnim`;
  const w = await api("/weeks");
  if (w && w.ok) {
    const sel = document.getElementById("selWeek");
    sel.innerHTML = w.data.map((x) => `<option value="${x}">${ddy(x)}</option>`).join("");
  }
  refreshCardBadge();
}

async function saveRegion(id) {
  const body = {
    name: document.getElementById("rgName" + id).value,
    regional_coordinator_id: parseInt(document.getElementById("rgCoord" + id).value, 10) || null,
    is_active: document.getElementById("rgAct" + id).checked,
  };
  const r = await api(`/admin/regions/${id}`, { method: "PATCH", body });
  if (r && r.ok) loadSettings(); else alertBox(r);
}
async function addRegion() {
  const body = {
    name: document.getElementById("rgNameNew").value,
    regional_coordinator_id: parseInt(document.getElementById("rgCoordNew").value, 10) || null,
  };
  const r = await api(`/admin/regions`, { method: "POST", body });
  if (r && r.ok) location.reload(); else alertBox(r);
}
async function saveSite(i, encKey) {
  const body = {
    site_key: decodeURIComponent(encKey),
    region_id: parseInt(document.getElementById("stR" + i).value, 10) || null,
    coordinator_id: parseInt(document.getElementById("stC" + i).value, 10) || null,
    valid_from: document.getElementById("stF" + i).value,
  };
  const r = await api(`/admin/sites`, { method: "PUT", body });
  const m = document.getElementById("stM" + i);
  if (r && r.ok) { m.className = "form-msg ok"; m.textContent = "✓"; }
  else { m.className = "form-msg err"; m.textContent = (r && r.error) || "błąd"; }
}
async function saveSettings() {
  const body = {};
  ST.config.settings.forEach((s) => {
    const el = document.getElementById("set_" + s.key);
    if (!el) return;
    const v = parseFloat(String(el.value).replace(",", "."));
    body[s.key] = FRACTION_KEYS.includes(s.key) ? v / 100 : v;
  });
  const r = await api(`/admin/settings`, { method: "PATCH", body });
  const m = document.getElementById("setMsg");
  if (r && r.ok) { m.className = "form-msg ok"; m.textContent = "Zapisano. Nowe progi zadziałają przy następnym przeliczeniu."; }
  else { m.className = "form-msg err"; m.textContent = (r && r.error) || "błąd"; }
}
async function addFlag() {
  const body = {
    site_key: document.getElementById("flSite").value,
    date_from: document.getElementById("flFrom").value,
    date_to: document.getElementById("flTo").value,
    note: document.getElementById("flNote").value,
  };
  const r = await api(`/admin/flags`, { method: "POST", body });
  if (r && r.ok) loadSettings();
  else { const m = document.getElementById("flMsg"); m.className = "form-msg err"; m.textContent = (r && r.error) || "błąd"; }
}
async function endFlag(id) {
  const r = await api(`/admin/flags/${id}`, { method: "PATCH", body: {} });
  if (r && r.ok) loadSettings(); else alertBox(r);
}
function alertBox(r) { window.alert((r && r.error) || "Błąd"); }
