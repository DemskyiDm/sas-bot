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
  mode: "week",      // week | period (od–do)
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* prywatne okno */ } },
};
const STATUS_LABEL = { R: "Czerwony", A: "Żółty", G: "Zielony", S: "Strukturalny", N: "Brak danych" };
const CLOSE_LABEL = { left_red: "wyszedł z czerwonego", structural: "przypadek strukturalny" };

// ── Утиліти ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
// Nazwa obiektu jako argument w onclick="f('…')": encodeURIComponent nie koduje apostrofu,
// a nazwy przychodzą z zakładek arkusza („D'Amico”) — bez tego przycisk się psuje (albo wstrzyknięcie kodu).
function encK(s) {
  return encodeURIComponent(String(s == null ? "" : s)).replace(/'/g, "%27");
}
function pct(v, d) {
  if (v == null || isNaN(v)) return "—";
  return (v * 100).toFixed(d == null ? 0 : d).replace(".", ",") + "%";
}
function dd(iso) { return iso ? iso.substring(8, 10) + "." + iso.substring(5, 7) : ""; }
// дата з роком, якщо рік інший, ніж у вибраному тижні
function ddr(iso) {
  if (!iso) return "";
  const wy = (ST.mode === "period" ? document.getElementById("perTo").value : document.getElementById("selWeek").value || "").substring(0, 4);
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
  if (reg) p.set("region", reg);
  if (ST.mode === "period") {
    p.set("from", document.getElementById("perFrom").value);
    p.set("to", document.getElementById("perTo").value);
  } else {
    const week = document.getElementById("selWeek").value;
    if (week) p.set("week", week);
  }
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
      `<div class="noaccess">🚦 Sekcja <b>Region</b> jest dostępna dla koordynatorów regionalnych
       i koordynatorów przypisanych do obiektów.<br>
       Jeśli prowadzisz region lub obiekt, poproś kierownika działu o przypisanie w ustawieniach sekcji.</div>`;
    return;
  }
  // koordynator obiektu: tylko podgląd swoich obiektów + notatki do kart
  ST.ro = me.role === "coord";
  const selR = document.getElementById("selRegion");
  const opts = [];
  if (ST.ro) {
    opts.push(`<option value="all">Moje obiekty</option>`);
    selR.disabled = true;
    document.querySelector('.nav-item[data-view="coords"]').style.display = "none";
  } else if (me.is_admin) {
    opts.push(`<option value="all">Wszystkie regiony</option>`);
    opts.push(`<option value="none">Bez regionu</option>`);
  } else if (me.regions.length > 1) {
    opts.push(`<option value="all">Moje regiony</option>`);
  }
  me.regions.forEach((r) => {
    const leads = (r.leads || []).map((x) => x.name).join(", ");
    opts.push(`<option value="${r.id}">${esc(r.name)}${leads ? " — " + esc(leads) : ""}</option>`);
  });
  selR.innerHTML = opts.join("");
  const savedRegion = localStorage.getItem("sas_region_sel");
  if (savedRegion && [...selR.options].some((o) => o.value === savedRegion)) selR.value = savedRegion;
  if (me.is_admin) {
    document.getElementById("navSettings").style.display = "";
    document.getElementById("navAssign").style.display = "";
    refreshAssignBadge();
  }

  const [weeks, reasons, coords] = await Promise.all([api("/weeks"), api("/reasons"), ST.ro ? null : api("/coordinators-list")]);
  ST.reasons = (reasons && reasons.data) || [];
  ST.coordinators = (coords && coords.data) || [];
  const selW = document.getElementById("selWeek");
  const wl = (weeks && weeks.data) || [];
  selW.innerHTML = wl.length
    ? wl.map((w) => `<option value="${w}">${ddy(w)}</option>`).join("")
    : `<option value="">— brak danych —</option>`;

  // okres od–do: domyślnie od początku kwartału do ostatniego przeliczonego tygodnia
  const last = wl[0] || new Date().toISOString().slice(0, 10);
  const qStart = last.slice(0, 5) + String(Math.floor((Number(last.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0") + "-01";
  document.getElementById("perFrom").value = store.get("sas_region_from") || qStart;
  document.getElementById("perTo").value = store.get("sas_region_to") || last;
  if (store.get("sas_region_mode") === "period") applyMode("period");

  if (!wl.length) {
    document.getElementById("kpis").innerHTML = "";
    document.getElementById("boardTable").innerHTML = me.is_admin
      ? `<div class="empty">Brak przeliczonych tygodni. Wejdź w <b>Ustawienia → Przeliczenie</b> i przelicz historię.</div>`
      : `<div class="empty">Brak przeliczonych tygodni. Pierwsze dane pojawią się w poniedziałek rano.</div>`;
    if (me.is_admin) showView(location.hash === "#assign" ? "assign" : "settings");
    return;
  }
  const h = location.hash.replace("#", "");
  // region.html#site=<obiekt>[&week=<data>|last][&from=&to=] — odnośnik z pulpitu kierownika:
  // od razu karta obiektu, z tym samym okresem co na pulpicie
  if (h.startsWith("site=")) {
    openFromLink(new URLSearchParams(h), wl);
    return;
  }
  showView(["board", "coords", "cards", "settings", "assign"].includes(h) ? h : "board");
}

// Tydzień, jeśli jest przeliczony; inaczej okres od–do. Wybór z odnośnika nie nadpisuje zapisanych ustawień.
function openFromLink(hp, weeks) {
  const key = hp.get("site") || "";
  const w = hp.get("week"), f = hp.get("from"), t = hp.get("to");
  const iso = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
  const wk = w === "last" ? weeks[0] : weeks.includes(w) ? w : null;
  if (wk) {
    document.getElementById("selWeek").value = wk;
    applyMode("week");
  } else if (iso(f) && iso(t)) {
    document.getElementById("perFrom").value = f;
    document.getElementById("perTo").value = t;
    applyMode("period");
    if (!periodValid()) applyMode("week");
  }
  showView("board");
  if (key) openSite(encodeURIComponent(key));
}

function onFilterChange() {
  store.set("sas_region_sel", document.getElementById("selRegion").value);
  loadView();
}

// ── Tydzień / okres od–do ──
function applyMode(m) {
  ST.mode = m;
  document.querySelectorAll("#modeChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.m === m));
  document.getElementById("weekBox").style.display = m === "week" ? "" : "none";
  document.getElementById("periodBox").style.display = m === "period" ? "" : "none";
}
function setMode(m) {
  applyMode(m);
  store.set("sas_region_mode", m);
  if (m === "period" && !periodValid()) return;
  loadView();
}
function periodValid() {
  const f = document.getElementById("perFrom").value, t = document.getElementById("perTo").value;
  const msg = document.getElementById("perMsg");
  let err = "";
  if (!f || !t) err = "podaj obie daty";
  else if (f > t) err = "„od” jest późniejsze niż „do”";
  else if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > 731) err = "maksymalnie 2 lata";
  msg.textContent = err;
  return !err;
}
function onPeriodChange() {
  if (!periodValid()) return;
  store.set("sas_region_from", document.getElementById("perFrom").value);
  store.set("sas_region_to", document.getElementById("perTo").value);
  loadView();
}
const isPeriod = () => ST.board && ST.board.mode === "period";

function showView(v) {
  if ((v === "settings" || v === "assign") && !(ST.me && ST.me.is_admin)) v = "board";
  if (v === "coords" && ST.ro) v = "board";
  ST.view = v;
  location.hash = v;
  document.querySelectorAll(".rg-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent = (ST.ro
    ? { board: "Moje obiekty", cards: "Moje obiekty — karty" }
    : { board: "Region — tablica", coords: "Region — koordynatorzy", cards: "Region — karty", settings: "Region — ustawienia",
        assign: "Przypisania — obiekty, regiony, koordynatorzy" })[v];
  // przypisania nie zależą od regionu ani tygodnia — pasek filtrów ukryty
  document.querySelector(".rg-toolbar").style.visibility = v === "assign" ? "hidden" : "";
  loadView();
}

function loadView() {
  if (ST.view === "board") loadBoard();
  if (ST.view === "coords") loadCoords();
  if (ST.view === "cards") loadCards();
  if (ST.view === "settings") loadSettings();
  if (ST.view === "assign") loadAssign();
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
      <div class="s">${k.hc_red || 0} z ${k.hc || 0} osób, ${isPeriod() ? `status za okres ${dd(ST.board.period.from)}–${ddy(ST.board.period.to)}` : `tydzień do ${ddy(ST.board.week)}`}</div></div>
    <div class="kpi"><div class="l">${isPeriod() ? "Średnio w okresie" : "Średnio w kwartale"}</div>
      <div class="v">${pct(k.share_red_quarter)}</div>
      <div class="s">${isPeriod() ? `${k.weeks_in_quarter} tyg. w okresie (z cotygodniowych przeliczeń)` : `od ${ddy(k.quarter_start)}, ${k.weeks_in_quarter} tyg.`}</div></div>
    <div class="kpi"><div class="l">Obiekty: czerwone / żółte / zielone</div>
      <div class="v"><span class="r">${k.sites_red}</span><span class="sep">/</span><span class="a">${k.sites_amber}</span><span class="sep">/</span><span class="g">${k.sites_green}</span></div>
      <div class="s">${k.sites_other ? k.sites_other + " bez oceny (strukturalne / brak danych)" : "wszystkie ocenione"}</div></div>
    <div class="kpi"><div class="l">Wyszły z czerwonego w ${isPeriod() ? "okresie" : "kwartale"}</div>
      <div class="v">${k.red_exited}<span class="sep">z</span>${k.red_at_start}</div>
      <div class="s">czerwone na początku ${isPeriod() ? "okresu" : "kwartału"}</div></div>
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
  const mine = ST.ro && s.card_owner_id != null && s.card_owner_id === ST.me.me
    ? ` <span class="card-tag mine" title="Jesteś odpowiedzialny za plan">👤 Ty</span>` : "";
  if (s.card_status === "filled") return `<span class="card-tag filled">✓ wypełniona</span>${mine}`;
  if (s.card_overdue) return `<span class="card-tag late">po terminie</span>${mine}`;
  return `<span class="card-tag open">do ${dd(s.card_due.substring(0, 10))}</span>${mine}`;
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
      <th class="num">${isPeriod() ? "Tyg. czerw. w okresie" : "Tyg. czerw."}</th><th>${isPeriod() ? "Tygodnie w okresie" : "Trend 8 tyg."}</th><th>Karta</th>
    </tr></thead><tbody>
    ${rows.map((s) => `
      <tr class="click" onclick="openSite('${encK(s.site_key)}')">
        <td>${pill(s.status)}</td>
        <td><b>${esc(s.site_key)}</b>${!isPeriod() && s.window_days !== 28 ? ` <span class="muted" title="Mały obiekt — okno ${s.window_days} dni">·${s.window_days}d</span>` : ""}
            ${s.status === "R" && s.raw_status !== "R" ? ` <span class="muted" title="Wskaźniki już poniżej progu, obiekt wychodzi z czerwonego">↗</span>` : ""}</td>
        <td>${s.coordinator_name ? esc(s.coordinator_name) : `<span class="muted">— nieprzypisany —</span>`}</td>
        ${multi ? `<td>${s.region_name ? esc(s.region_name) : `<span class="muted">—</span>`}</td>` : ""}
        <td class="num">${s.headcount_end}</td>
        <td class="num" title="${s.departures} odejść przy średnio ${String(s.headcount_avg).replace(".", ",")} osobach${isPeriod() ? " — w przeliczeniu na 28 dni" : ""}">${metric(s.rotation, s.st_rot)}</td>
        <td class="num" title="${s.ret_achieved} z ${s.ret_possible} wag">${metric(s.ret_possible ? s.retention : null, s.st_ret)}</td>
        <td class="num" title="${s.abs_nn} dni NN z ${s.abs_base}">${metric(s.abs_base ? s.absence : null, s.st_abs, 1)}</td>
        <td class="num">${isPeriod() ? (s.weeks_n ? `${s.red_weeks} z ${s.weeks_n}` : "") : s.red_weeks || ""}</td>
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
    (isPeriod()
      ? `<br><b>Okres od–do:</b> status liczony za cały wybrany okres tymi samymi progami (rotacja przeliczona na 28 dni), bez reguły wyjścia z czerwonego i bez dłuższego okna dla małych obiektów. „Tygodnie w okresie” — statusy z cotygodniowych przeliczeń. Karta obiektu pokazuje wskaźniki, odejścia i NN za cały okres; historia statusu — tygodnie z cotygodniowych przeliczeń.`
      : `Wyjście z czerwonego: ${s.exit_red_weeks} tyg. z rzędu poniżej progu. Obiekty poniżej ${s.small_site_headcount} osób liczone w oknie ${s.small_site_window_days} dni.`);
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
  const r = await api(`/site?key=${encodeURIComponent(key)}&${siteWhen()}`);
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
  // okres od–do: wskaźniki, odejścia i NN za cały okres; historia i karta — z cotygodniowych przeliczeń
  const P = r.mode === "period" && r.period ? r.period : null;
  const ws = r.snapshot;
  const s = P ? r.pstat : ws;
  const owner = r.owner || {};
  const dw = document.getElementById("drawer");
  const status = s ? s.status : "N";
  const crit = (label, v, st, sub, d) => `
    <div class="${st || "x"}"><div class="l">${label}</div>
      <div class="v">${v == null ? "—" : pct(v, d)}</div><div class="s">${sub}</div></div>`;
  const span = P ? `${P.from.slice(0, 4) === P.to.slice(0, 4) ? dd(P.from) : ddy(P.from)}–${ddy(P.to)}` : "";
  const inWin = P ? "w okresie" : "w oknie";
  const many = r.history.length > 14;

  dw.innerHTML = `
    <div class="dw-head">
      ${pill(status)}
      <div><h2>${esc(r.site_key)}</h2>
        <div class="sub">${esc(owner.region_name || (ws && ws.region_name) || "bez regionu")} ·
          ${esc(owner.coordinator_name || (ws && ws.coordinator_name) || "koordynator nieprzypisany")} ·
          ${P ? `okres ${span} (${P.days} ${P.days === 1 ? "dzień" : "dni"})`
              : `tydzień do ${ddy(r.week)}${s ? ` · okno ${s.window_days} dni` : ""}`}</div></div>
      <button class="dw-close" onclick="closeDrawer()" title="Zamknij (Esc)">✕</button>
    </div>
    <div class="dw-body">
      ${s ? `
      <div class="crit">
        ${crit("Rotacja (na 28 dni)", s.rotation, s.st_rot,
               `${s.departures} odejść przy średnio ${String(s.headcount_avg).replace(".", ",")} osobach${P && P.days !== 28 ? ` w ciągu ${P.days} dni` : ""}`)}
        ${crit(`Dożycie do ${r.thresholds.d1}/${r.thresholds.d2} dni`, s.ret_possible ? s.retention : null, s.st_ret,
               s.ret_possible ? `${s.ret_achieved} z ${s.ret_possible} wag` : "za mało osób przy progach")}
        ${crit("Nieobecności NN" + ((ST.board && ST.board.settings && ST.board.settings.abs_enabled === 1) ? "" : " · informacyjnie"),
               s.abs_base ? s.absence : null, s.st_abs,
               s.abs_base ? `${s.abs_nn} dni NN z ${s.abs_base} dni` : "brak danych o godzinach", 1)}
      </div>` : `<div class="empty">Brak danych za ${P ? "ten okres" : "ten tydzień"}</div>`}
      ${P ? `<div style="font-size:12px;color:var(--text2);margin:-4px 0 10px;line-height:1.7">Status za cały okres, te same progi co w tygodniu.
        ${ws ? `Ostatnie cotygodniowe przeliczenie (tydzień do ${ddy(r.week)}, okno ${ws.window_days} dni): ${pill(ws.status)} ${STATUS_LABEL[ws.status]}${ws.status === "R" && ws.red_weeks ? `, ${ws.red_weeks} tyg. z rzędu` : ""}.` : ""}</div>` : ""}

      <div class="h3">Historia statusu <span class="c">${r.history.length} ${r.history.length === 1 ? "tydzień" : "tyg."}${P ? " · wyblakłe — poza okresem" : ""}</span></div>
      <div class="hist">${r.history.map((h, i) => `
        <div class="${h.w === r.week ? "cur" : ""}${P && (h.w < P.from || h.w > P.to) ? " out" : ""}" title="${ddy(h.w)}: ${STATUS_LABEL[h.status]} · rotacja ${pct(h.rotation)} · dożycie ${pct(h.retention)} · ${h.headcount_end} os.">
          <i class="${h.status}"></i>${many && (r.history.length - 1 - i) % 2 ? "&nbsp;" : dd(h.w)}</div>`).join("")}</div>

      <div id="cardBox">${renderCardBox(r.card)}</div>

      <div id="careBox"></div>

      <div class="h3">Zbliżają się do progu <span class="c">${P ? `14 dni po ${ddy(P.to)}` : "następne 14 dni"} — tych ludzi trzeba utrzymać</span></div>
      ${r.approaching.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th>Obiekt</th><th class="num">Start</th><th class="num">Próg</th><th class="num">Data</th><th class="num">Zostało</th></tr></thead><tbody>
        ${r.approaching.map((a) => `<tr><td>${esc(a.full_name)} <span class="muted">${esc(a.login)}</span></td><td class="muted">${esc(a.facility)}</td>
          <td class="num">${ddr(a.bhp)}</td><td class="num">${a.threshold} dni</td><td class="num">${dd(a.date)}</td>
          <td class="num">${a.days_left} d</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Nikt nie przekracza progu w najbliższych 14 dniach</div>`}

      <div class="h3">Odejścia ${inWin} <span class="c">${r.departures.length} osób, od najkrótszego stażu</span></div>
      ${r.departures.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th>Obiekt</th><th class="num">Start</th><th class="num">Ostatni dzień</th><th class="num">Staż</th></tr></thead><tbody>
        ${r.departures.map((d) => `<tr><td>${esc(d.full_name)} <span class="muted">${esc(d.login)}</span></td><td class="muted">${esc(d.facility)}</td>
          <td class="num">${ddr(d.bhp)}</td><td class="num">${ddr(d.last_day)}</td>
          <td class="num ${d.tenure <= 30 ? "tag-short" : ""}">${d.tenure} d</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Brak odejść ${inWin}</div>`}

      <div class="h3">Nieobecności bez przyczyny (NN) <span class="c">${inWin}</span></div>
      ${r.absences.length ? `<div class="tblwrap"><table class="rg"><thead><tr><th>Pracownik</th><th class="num">Dni NN</th><th>Daty</th></tr></thead><tbody>
        ${r.absences.map((a) => `<tr><td>${esc(a.full_name)} <span class="muted">${esc(a.login)}</span></td>
          <td class="num">${a.nn}</td><td class="muted">${esc(a.days)}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">Brak NN ${inWin}</div>`}
    </div>`;
  loadCareBox(r.site_key);
}

// ── Rozmowy i ankiety po obiekcie (sekcja Rozmowy) ─────────────────────
async function loadCareBox(siteKey) {
  const box = document.getElementById("careBox");
  if (!box) return;
  let r = null;
  try {
    const res = await fetch("/api/care/site?site=" + encodeURIComponent(siteKey), { headers: { "x-session": SESSION } });
    r = await res.json();
  } catch (e) { return; }
  if (!r || !r.ok || document.getElementById("careBox") !== box) return;
  const t = r.tasks, sv = r.surveys;
  const PR = { housing: "mieszkanie", money: "pieniądze", schedule: "grafik", team: "zespół", transport: "dojazd", other: "inne" };
  const pc = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
  const list = (arr) => arr.map((x) => `${esc(x.label || PR[x.code] || x.code)} (${x.n})`).join(", ");
  box.innerHTML = `
    <div class="h3">Rozmowy i ankiety <span class="c">stan na dziś: rozmowy — ostatnie 28 dni, ankiety — 90 dni ·
      <a href="rozmowy.html" style="color:var(--accent)">otwórz sekcję</a></span></div>
    <div class="crit">
      <div class="${t.late ? "A" : "x"}"><div class="l">Rozmowy</div>
        <div class="v">${t.done28}</div>
        <div class="s">zamknięte · otwarte ${t.open_now}${t.late ? `, po terminie ${t.late}` : ""}${t.missed ? `, pominięte ${t.missed}` : ""}<br>
          ✅ ${t.stays} · ⚠️ ${t.problem} · 🚪 ${t.leaving} · 📵 ${t.no_answer}</div></div>
      <div class="${sv.sent && sv.done / sv.sent < 0.4 ? "A" : "x"}"><div class="l">Ankiety — odpowiedzi</div>
        <div class="v">${pc(sv.done, sv.sent)}</div>
        <div class="s">${sv.done} z ${sv.sent}${sv.no_tg ? ` · bez bota ${sv.no_tg}` : ""}</div></div>
      <div class="${(sv.work5 != null && sv.work5 < 3) || (sv.housing5 != null && sv.housing5 < 3) ? "R" : "x"}"><div class="l">Oceny w ankietach</div>
        <div class="v" style="font-size:18px">${sv.work5 ?? "—"} <span style="font-size:11px;color:var(--text3)">praca</span>
          · ${sv.housing5 ?? "—"} <span style="font-size:11px;color:var(--text3)">mieszk.</span></div>
        <div class="s">${sv.stay_n ? `waha się / odejdzie: ${pc(sv.stay_doubt, sv.stay_n)}` : "brak odpowiedzi"}</div></div>
    </div>
    ${r.problems.length || r.top_problems.length || r.exit_reasons.length ? `<div style="font-size:12px; line-height:1.7; margin-bottom:6px">
      ${r.problems.length ? `<div><span class="muted">Problemy z rozmów:</span> ${list(r.problems)}</div>` : ""}
      ${r.top_problems.length ? `<div><span class="muted">Problemy z ankiet:</span> ${list(r.top_problems)}</div>` : ""}
      ${r.exit_reasons.length ? `<div><span class="muted">Powody odejść (ankieta):</span> ${list(r.exit_reasons)}</div>` : ""}
      <div class="muted" style="font-size:11px">Podpowiedź do karty czerwonego obiektu.</div></div>` : ""}`;
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
  if (ST.ro) return renderCardView(c, state);
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

// Koordynator obiektu: karta tylko do odczytu, może dopisywać notatki o postępie
function notesHtml(c) {
  return `<div class="notes">
      ${(c.notes || []).map((n) => `<div class="note"><div class="meta">${esc(n.at)} · ${esc(n.by || "")}</div>${esc(n.text)}</div>`).join("")
        || `<div class="note" style="color:var(--text3)">Brak notatek o postępie</div>`}
      <div class="note-add"><input type="text" id="cNewNote" placeholder="Notatka o postępie — co zrobiono, z kim rozmawiano…" onkeydown="if(event.key==='Enter')addNote(${c.id})" />
        <button class="btn btn-ghost btn-sm" onclick="addNote(${c.id})">Dodaj</button></div>
    </div>`;
}
function renderCardView(c, state) {
  const mine = c.owner_coordinator_id != null && c.owner_coordinator_id === ST.me.me;
  const reason = (ST.reasons.find((x) => x.code === c.reason_code) || {}).label || c.reason_code || "";
  const row = (label, v) => `<div class="${label === "Plan działań" || label === "Komentarz do przyczyny" ? "full" : ""}">
      <label>${label}</label><div class="ro">${v ? esc(v) : `<span class="muted">—</span>`}</div></div>`;
  return `
    <div class="h3">Karta czerwonego obiektu <span class="c">otwarta w tygodniu do ${ddy(c.opened_week)}</span></div>
    <div class="redcard ${c.status === "filled" ? "filled" : ""}${mine ? " mine" : ""}">
      <div class="top"><b>Co się dzieje i co robimy</b> ${state}
        ${mine ? `<span class="card-tag mine">👤 jesteś odpowiedzialny</span>` : ""}</div>
      ${c.status === "filled" ? `<div class="form">
        ${row("Przyczyna", reason)}
        ${row("Odpowiedzialny", (c.owner_name || "") + (mine ? " (Ty)" : ""))}
        ${row("Komentarz do przyczyny", c.reason_note)}
        ${row("Plan działań", c.action_plan)}
        ${row("Termin wykonania", c.action_due ? ddy(c.action_due) : "")}
      </div>` : `<div class="muted" style="font-size:12px;margin:6px 0 10px">Kartę wypełnia koordynator regionalny: przyczyna, plan działań, termin i odpowiedzialny.
        Możesz już dopisać notatkę — co widzisz na obiekcie i co robisz.</div>`}
      ${notesHtml(c)}
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

// Karta obiektu: tydzień z listy albo cały wybrany okres od–do
function siteWhen() {
  return ST.mode === "period"
    ? "from=" + encodeURIComponent(document.getElementById("perFrom").value) +
      "&to=" + encodeURIComponent(document.getElementById("perTo").value)
    : "week=" + encodeURIComponent(document.getElementById("selWeek").value);
}

async function reloadSite() {
  if (!ST.siteKey) return;
  const r = await api(`/site?key=${encodeURIComponent(ST.siteKey)}&${siteWhen()}`);
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
  document.getElementById("coordsCnt").textContent = r.mode === "period"
    ? `${r.data.length} · okres ${dd(r.period.from)}–${ddy(r.period.to)} (status za cały okres)`
    : `${r.data.length} · tydzień do ${ddy(r.week)}`;
  if (!r.data.length) { box.innerHTML = `<div class="empty">Brak danych</div>`; return; }
  box.innerHTML = `
    <table class="rg"><thead><tr><th>Koordynator</th><th>Obiekty</th><th class="num">Ludzie</th>
      <th class="num">W czerwonych</th><th class="num">Rotacja</th><th class="num">Dożycie</th><th class="num">NN</th></tr></thead><tbody>
    ${r.data.map((c) => `<tr>
        <td><b>${esc(c.coordinator_name)}</b></td>
        <td>${c.site_list.map((x) => `<span class="m" style="margin-right:10px;cursor:pointer" onclick="openSite('${encK(x.site)}')" title="${STATUS_LABEL[x.status]}">${dot(x.status)} ${esc(x.site)}</span>`).join("")}</td>
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
    ${r.data.map((c) => `<tr class="click" onclick="openSite('${encK(c.site_key)}')">
        <td><b>${esc(c.site_key)}</b></td><td>${esc(c.region_name || "—")}</td>
        <td class="num">${dd(c.opened_week)}</td><td class="num">${dd(c.due_at.substring(0, 10))}</td>
        <td>${stTag(c)}</td><td>${esc(c.reason || "")}</td>
        <td style="max-width:280px">${esc(c.action_plan || "")}</td>
        <td>${esc(c.owner_name || "")}${ST.ro && c.owner_coordinator_id != null && c.owner_coordinator_id === ST.me.me ? ` <span class="card-tag mine">(Ty)</span>` : ""}</td>
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
      <div class="section-head">Regiony, obiekty, koordynatorzy, archiwum</div>
      <div class="cfg-row"><button class="btn btn-primary" onclick="showView('assign')">🔗 Przejdź do Przypisań</button></div>
      <div class="hint">Wszystkie przypisania są teraz w jednym miejscu — <b>🔗 Przypisania</b>: region i główny koordynator obiektu,
        koordynatorzy pomocniczy (podgląd / edycja), koordynatorzy regionalni, aktywacja koordynatorów i archiwum obiektów.</div>
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
}

async function archiveSite(encKey, headcount) {
  const site = decodeURIComponent(encKey);
  const note = window.prompt(`Przenieść „${site}” do archiwum?\n\n` +
    (headcount ? `Uwaga: wg grafiku pracuje tam jeszcze ${headcount} os.\n\n` : "") +
    "Obiekt zniknie z Wyjazdów, Regionu, Tablicy i Rozmów; przypisanie do regionu i koordynatora się zamknie. " +
    "Dane zostają — można przywrócić.\n\nPowód (opcjonalnie):", "");
  if (note === null) return;
  const r = await api(`/admin/archive`, { method: "POST", body: { site_key: site, note } });
  if (r && r.ok) loadView(); else alertBox(r);
}
async function unarchiveSite(encKey) {
  const site = decodeURIComponent(encKey);
  if (!window.confirm(`Przywrócić „${site}” z archiwum? Wróci poprzedni region i koordynator.`)) return;
  const r = await api(`/admin/unarchive`, { method: "POST", body: { site_key: site } });
  if (r && r.ok) loadView(); else alertBox(r);
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
    is_active: document.getElementById("rgAct" + id).checked,
  };
  const r = await api(`/admin/regions/${id}`, { method: "PATCH", body });
  if (r && r.ok) loadView(); else alertBox(r);
}
async function addRegion() {
  const body = {
    name: document.getElementById("rgNameNew").value,
    coordinator_id: parseInt(document.getElementById("rgCoordNew").value, 10) || null,
  };
  const r = await api(`/admin/regions`, { method: "POST", body });
  if (r && r.ok) location.reload(); else alertBox(r);
}
async function addLead(regionId) {
  const sel = document.getElementById("rgAdd" + regionId);
  const coordinator_id = parseInt(sel.value, 10) || null;
  if (!coordinator_id) return;
  const r = await api(`/admin/regions/${regionId}/leads`, { method: "POST", body: { coordinator_id } });
  if (r && r.ok) loadView(); else alertBox(r);
}
async function removeLead(regionId, coordinatorId) {
  const r = await api(`/admin/regions/${regionId}/leads/${coordinatorId}`, { method: "DELETE" });
  if (r && r.ok) loadView(); else alertBox(r);
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
  if (r && r.ok) {
    m.className = "form-msg ok"; m.textContent = "✓";
    if (ST.view === "assign") { await loadAssign(true); asFlash(`✓ Zapisano: ${body.site_key}`); }
  }
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

// ══════════════════════════════════════════════════════════════════════
//  🔗 Przypisania (admin) — jedno miejsce na wszystkie przypisania:
//  obiekt → region, główny koordynator (od daty), pomocniczy (podgląd / edycja);
//  region → koordynatorzy regionalni; koordynator → aktywny / nieaktywny; archiwum obiektów.
//  Dostęp w panelu głównym przelicza się sam (reg.sync_access w bazie).
// ══════════════════════════════════════════════════════════════════════
ST.asf = { q: "", coord: "", noRegion: false, noMain: false, empty: false, review: false, problems: false, cq: "", inactive: false };
const ROLE_PL = { coordinator: "Koordynator", regional_coordinator: "Regionalny", head: "Kierownik" };
const cName = (id) => { const c = ST.coordById && ST.coordById[id]; return c ? c.full_name : "—"; };
const cActive = (id) => { const c = ST.coordById && ST.coordById[id]; return !c || c.is_active; };

async function refreshAssignBadge(data) {
  const r = data || (await api("/admin/assign"));
  const b = document.getElementById("badgeAssign");
  if (!b || !r || !r.ok) return;
  const byId = Object.fromEntries(r.coordinators.map((c) => [c.id, c]));
  const offMain = r.sites.filter((s) => s.coordinator_id && byId[s.coordinator_id] && !byId[s.coordinator_id].is_active).length;
  const n = r.review_n + offMain;
  b.textContent = n ? String(n) : "";
  b.title = n ? `${r.review_n} do sprawdzenia · ${offMain} obiektów z nieaktywnym głównym koordynatorem` : "";
}

async function loadAssign(keep) {
  const box = document.getElementById("assignBody");
  if (!keep) box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/admin/assign");
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.assign = r;
  ST.coordById = Object.fromEntries(r.coordinators.map((c) => [c.id, c]));
  const sc = document.getElementById("content") || document.scrollingElement;
  const y = sc.scrollTop;
  renderAssign();
  if (keep) sc.scrollTop = y;
  refreshAssignBadge(r);
}

function renderAssign() {
  const r = ST.assign, f = ST.asf;
  const active = r.coordinators.filter((c) => c.is_active);
  const offMain = r.sites.filter((s) => s.coordinator_id && !cActive(s.coordinator_id));
  const noMain = r.sites.filter((s) => !s.coordinator_id && s.headcount > 0).length;
  const banners = [];
  if (r.review_n) {
    banners.push(`<div class="as-banner">⚠️ <b>${r.review_n} przypisań przeniesionych z panelu admina</b> — ci koordynatorzy są teraz <b>pomocniczymi
      z prawem edycji</b> (żeby nikt nie stracił dostępu). Sprawdź i zdecyduj: zostaw edycję albo zmień na „tylko podgląd” — w wierszu obiektu
      (żółte) albo wszystkim naraz:<br>
      <button class="btn btn-ghost btn-sm" onclick="setAsFilter('review', true)">Pokaż tylko do sprawdzenia</button>
      <button class="btn btn-ghost btn-sm" onclick="reviewAll('view')">Wszystkim → tylko podgląd</button>
      <button class="btn btn-ghost btn-sm" onclick="reviewAll('edit')">Wszystkim zostaw edycję</button></div>`);
  }
  if (offMain.length) {
    banners.push(`<div class="as-banner">⛔ <b>${offMain.length} obiektów ma nieaktywnego głównego koordynatora:</b>
      ${offMain.map((s) => esc(s.site_key)).join(", ")} — przypisz innego.
      <button class="btn btn-ghost btn-sm" onclick="setAsFilter('problems', true)">Pokaż je</button></div>`);
  }
  const coordFilterOpts = `<option value="">wszyscy koordynatorzy</option>` +
    r.coordinators.map((c) => `<option value="${c.id}" ${String(c.id) === f.coord ? "selected" : ""}>${esc(c.full_name)}${c.is_active ? "" : " (nieaktywny)"}</option>`).join("");
  const coordOpts = (sel) => `<option value="">—</option>` +
    active.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.full_name)}</option>`).join("");
  const chk = (k, label) => `<label><input type="checkbox" ${f[k] ? "checked" : ""} onchange="setAsFilter('${k}', this.checked)" /> ${label}</label>`;

  document.getElementById("assignBody").innerHTML = `
    ${banners.join("")}
    <div class="section">
      <div class="section-head">Obiekty — region, główny i pomocniczy koordynatorzy
        <span class="cnt" id="asSitesCnt"></span>
        ${noMain ? `<span class="cnt" style="color:var(--rag-r)">${noMain} z ludźmi bez głównego</span>` : ""}
        <span class="spacer"></span>
        <div class="as-filters">
          <input type="text" id="asQ" placeholder="Szukaj obiektu / osoby…" value="${esc(f.q)}" oninput="ST.asf.q = this.value; renderAsSites()" style="width:170px" />
          <select id="asCoord" onchange="ST.asf.coord = this.value; renderAsSites()">${coordFilterOpts}</select>
          ${chk("noRegion", "bez regionu")} ${chk("noMain", "bez głównego")} ${chk("empty", "bez ludzi")}
          ${chk("review", "do sprawdzenia")} ${chk("problems", "nieaktywni")}
        </div>
      </div>
      <div id="asSites"></div>
      <div class="hint"><b>Główny</b> — odpowiada za obiekt (wskaźniki Regionu, premie, Wyjazdy, Rozmowy), w panelu głównym widzi i edytuje.
        Zmiana działa od podanej daty — wcześniejsze tygodnie zostają przy poprzednim (żeby zmienić historię, ustaw wcześniejszą datę
        i przelicz 12 tygodni w Ustawieniach). <b>Pomocniczy</b> — w panelu głównym widzi obiekt; 👁 tylko podgląd, ✎ może też edytować
        (godziny, zaliczki, wolne, pracownicy). Regionalny widzi cały swój region (podgląd). Obiekt = grupa z pola <i>group_name</i>
        (np. IDL Psary = APT + SAS + WELL).</div>
    </div>

    <div class="section">
      <div class="section-head">Regiony i koordynatorzy regionalni</div>
      <table class="rg"><thead><tr><th>Nazwa</th><th>Koordynatorzy regionalni</th><th>Aktywny</th><th></th></tr></thead><tbody>
      ${r.regions.map((g) => `<tr>
        <td><input type="text" id="rgName${g.id}" value="${esc(g.name)}" /></td>
        <td>
          <div class="leads">${(g.leads || []).map((l) => `<span class="lead-chip ${l.is_active ? "" : "off"}">${esc(l.name)}${l.is_active ? "" : " (nieaktywny)"}
            <button title="Usuń z regionu" onclick="removeLead(${g.id}, ${l.id})">✕</button></span>`).join("")
            || `<span class="muted" style="font-size:11px">— brak —</span>`}</div>
          <select id="rgAdd${g.id}" onchange="addLead(${g.id})" style="margin-top:6px">
            <option value="">+ dodaj koordynatora regionalnego</option>
            ${active.filter((c) => !(g.leads || []).some((l) => l.id === c.id)).map((c) => `<option value="${c.id}">${esc(c.full_name)}</option>`).join("")}
          </select>
        </td>
        <td><input type="checkbox" id="rgAct${g.id}" ${g.is_active ? "checked" : ""} /></td>
        <td><button class="btn btn-ghost btn-sm" onclick="saveRegion(${g.id})">Zapisz</button></td></tr>`).join("")}
      <tr><td><input type="text" id="rgNameNew" placeholder="Nowy region" /></td>
        <td><select id="rgCoordNew">${coordOpts(null)}</select></td><td></td>
        <td><button class="btn btn-primary btn-sm" onclick="addRegion()">Dodaj</button></td></tr>
      </tbody></table>
      <div class="hint">Region może prowadzić kilku koordynatorów regionalnych — każdy widzi region w Regionie, Wyjazdach i Rozmowach,
        dostaje powiadomienia i wypełnia karty, a w panelu głównym widzi obiekty regionu (podgląd).</div>
    </div>

    <div class="section">
      <div class="section-head">Koordynatorzy <span class="cnt">${active.length} aktywnych z ${r.coordinators.length}</span>
        <span class="spacer"></span>
        <div class="as-filters">
          <input type="text" placeholder="Szukaj…" value="${esc(f.cq)}" oninput="ST.asf.cq = this.value; renderAsCoords()" style="width:150px" />
          ${chk("inactive", "pokaż nieaktywnych")}
        </div>
      </div>
      <div id="asCoords"></div>
      <div class="hint"><b>Nieaktywny</b> — nie zaloguje się do panelu, nie ma dostępu do obiektów i nie dostaje wiadomości w Telegramie.
        Jego przypisania zostają i wracają po aktywacji; obiekty, gdzie był głównym, przypisz innemu (podświetlone w tabeli obiektów).
        Nowe konto, login i hasło — Admin panel → Koordynatorzy. Kliknij imię — zobaczysz jego obiekty.</div>
    </div>

    <div class="section">
      <div class="section-head">📦 Archiwum obiektów <span class="cnt">${(r.archive || []).length ? `${r.archive.length} — z nimi już nie pracujemy` : "puste"}</span></div>
      ${(r.archive || []).length ? `<table class="rg"><thead><tr><th>Obiekt</th><th class="num">W archiwum od</th><th>Kto</th><th>Powód</th>
          <th>Było przypisane</th><th class="num">Ludzie wg grafiku</th><th></th></tr></thead><tbody>
        ${r.archive.map((a) => `<tr><td><b>${esc(a.site_key)}</b></td><td class="num">${ddy(a.archived_at)}</td>
          <td>${esc(a.archived_by_name || "")}</td><td>${esc(a.note || "")}</td>
          <td>${esc([a.prev_region, a.prev_coordinator].filter(Boolean).join(" · ") || "—")}</td>
          <td class="num">${a.headcount ? `<span style="color:var(--rag-r)" title="W grafiku nadal ktoś pracuje — sprawdź daty ostatniego dnia">${a.headcount}</span>` : "0"}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="unarchiveSite('${encK(a.site_key)}')">Przywróć</button></td></tr>`).join("")}
        </tbody></table>` : ""}
      <div class="hint">Obiekt w archiwum znika z: Wyjazdy / przyjazdy, Region (tablica i historia tygodni, karty), Tablicy zarządu, Rozmów
        i pakietu startowego dla nowych; w panelu głównym nikt poza adminem go nie widzi. Przypisanie do regionu i koordynatora się zamyka.
        Dane nie są usuwane: „Przywróć” wraca obiekt z poprzednim regionem i koordynatorem. Do archiwum — 📦 w tabeli obiektów.</div>
    </div>`;
  renderAsSites();
  renderAsCoords();
}

// krótki komunikat po akcji (tabela przerysowuje się, więc „✓” w wierszu by zniknęło)
function asFlash(text, bad) {
  let el = document.getElementById("asFlash");
  if (!el) {
    el = document.createElement("div");
    el.id = "asFlash";
    el.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:999;padding:9px 14px;border-radius:8px;font-size:12px;" +
      "background:var(--surface2,#1e2535);border:1px solid var(--border,#2a3347);box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .3s";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.color = bad ? "var(--red,#ef4444)" : "var(--green,#22c55e)";
  el.style.opacity = "1";
  clearTimeout(asFlash.t);
  asFlash.t = setTimeout(() => { el.style.opacity = "0"; }, 2600);
}

function setAsFilter(k, v) {
  ST.asf[k] = v;
  if (k === "review" || k === "problems") renderAssign();
  else if (k === "inactive") renderAsCoords();
  else renderAsSites();
  if (v && (k === "review" || k === "problems")) document.getElementById("asSites").scrollIntoView({ behavior: "smooth", block: "start" });
}
function filterSitesBy(id) {
  ST.asf.coord = String(id);
  renderAssign();
  document.getElementById("asSites").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAsSites() {
  const r = ST.assign, f = ST.asf;
  const q = (f.q || "").trim().toLowerCase();
  const cid = parseInt(f.coord, 10) || null;
  const rows = r.sites.filter((s) => {
    const people = [cName(s.coordinator_id), ...s.helpers.map((h) => cName(h.coordinator_id))].join(" ").toLowerCase();
    if (q && !(s.site_key.toLowerCase().includes(q) || (s.facilities || "").toLowerCase().includes(q) || people.includes(q))) return false;
    if (cid && s.coordinator_id !== cid && !s.helpers.some((h) => h.coordinator_id === cid)) return false;
    if (f.noRegion && s.region_id) return false;
    if (f.noMain && s.coordinator_id) return false;
    if (f.empty && s.headcount) return false;
    if (f.review && !s.helpers.some((h) => h.review)) return false;
    if (f.problems && !((s.coordinator_id && !cActive(s.coordinator_id)) || s.helpers.some((h) => !cActive(h.coordinator_id)))) return false;
    return true;
  });
  document.getElementById("asSitesCnt").textContent = `${rows.length} z ${r.sites.length}`;
  const active = r.coordinators.filter((c) => c.is_active);
  const regionOpts = (sel) => `<option value="">— bez regionu —</option>` +
    r.regions.map((g) => `<option value="${g.id}" ${g.id === sel ? "selected" : ""}>${esc(g.name)}${g.is_active ? "" : " (nieaktywny)"}</option>`).join("");
  const mainOpts = (sel) => `<option value="">—</option>` +
    (sel && !cActive(sel) ? `<option value="${sel}" selected>${esc(cName(sel))} (nieaktywny)</option>` : "") +
    active.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.full_name)}</option>`).join("");
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().substring(0, 10); // lokalna data, nie UTC
  if (!rows.length) { document.getElementById("asSites").innerHTML = `<div class="empty">Nic nie pasuje do filtrów</div>`; return; }
  document.getElementById("asSites").innerHTML = `
    <table class="rg"><thead><tr><th>Obiekt</th><th class="num">Ludzie</th><th>Region</th><th>Główny koordynator</th><th>Od</th><th></th>
      <th>Pomocniczy</th><th></th></tr></thead><tbody>
    ${rows.map((s, i) => {
      const enc = encK(s.site_key);
      const used = new Set([s.coordinator_id, ...s.helpers.map((h) => h.coordinator_id)]);
      const chips = s.helpers.map((h) => {
        const off = !cActive(h.coordinator_id);
        return `<span class="lead-chip ${h.can_edit ? "edit" : ""} ${h.review ? "review" : ""} ${off ? "off" : ""}"
            title="${h.review ? "Przeniesione z panelu admina — sprawdź. " : ""}${h.can_edit ? "Widzi i edytuje" : "Tylko podgląd"}${off ? " · nieaktywny" : ""}">
          ${esc(cName(h.coordinator_id))}
          <button class="mode" onclick="setHelperEdit('${enc}', ${h.coordinator_id}, ${!h.can_edit})"
            title="${h.can_edit ? "Zmień na: tylko podgląd" : "Zmień na: może edytować"}">${h.can_edit ? "✎ edycja" : "👁 podgląd"}</button>
          ${h.review ? `<button class="mode" onclick="setHelperEdit('${enc}', ${h.coordinator_id}, true)" title="Zostaw edycję i zdejmij „do sprawdzenia”">✓</button>` : ""}
          <button title="Usuń z obiektu" onclick="removeHelper('${enc}', ${h.coordinator_id})">✕</button></span>`;
      }).join("");
      const mainOff = s.coordinator_id && !cActive(s.coordinator_id);
      return `<tr>
      <td><b>${esc(s.site_key)}</b>${s.facilities && s.facilities !== s.site_key ? `<div class="sub">${esc(s.facilities)}</div>` : ""}</td>
      <td class="num">${s.headcount}${!s.headcount && s.last_work ? `<div class="muted" style="font-size:10px" title="Ostatni dzień pracy wg grafiku">ost. ${ddy(s.last_work)}</div>` : ""}</td>
      <td><select id="stR${i}">${regionOpts(s.region_id)}</select></td>
      <td><select id="stC${i}" ${mainOff ? `style="border-color:var(--red)"` : ""}>${mainOpts(s.coordinator_id)}</select>
        ${s.valid_from ? `<div class="sub">od ${ddy(s.valid_from)}</div>` : ""}${mainOff ? `<div><span class="tag-off">nieaktywny — przypisz innego</span></div>` : ""}</td>
      <td><input type="date" id="stF${i}" value="${today}" max="${today}" title="Obowiązuje od (dziś albo wcześniej)" /></td>
      <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="saveSite(${i}, '${enc}')">Zapisz</button>
        <span class="form-msg" id="stM${i}"></span></td>
      <td><div class="leads">${chips}</div>
        <select onchange="addHelper('${enc}', this)" style="margin-top:${chips ? 6 : 0}px;max-width:200px">
          <option value="">+ pomocniczy</option>
          ${active.filter((c) => !used.has(c.id)).map((c) => `<option value="${c.id}">${esc(c.full_name)}</option>`).join("")}
        </select></td>
      <td><button class="btn btn-ghost btn-sm" title="Do archiwum — już nie pracujemy z tym obiektem"
        onclick="archiveSite('${enc}', ${Number(s.headcount) || 0})">📦</button></td></tr>`;
    }).join("")}
    </tbody></table>`;
}

function renderAsCoords() {
  const r = ST.assign, f = ST.asf;
  const q = (f.cq || "").trim().toLowerCase();
  const rows = r.coordinators.filter((c) => (f.inactive || c.is_active) && (!q || c.full_name.toLowerCase().includes(q) || (c.username || "").toLowerCase().includes(q)));
  if (!rows.length) { document.getElementById("asCoords").innerHTML = `<div class="empty">Brak</div>`; return; }
  document.getElementById("asCoords").innerHTML = `
    <table class="rg"><thead><tr><th>Koordynator</th><th>Rola</th><th>Login</th><th>Telegram</th><th>Główny na</th><th>Pomocniczy na</th>
      <th>Regionalny w</th><th class="num">Dostęp w panelu</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((c) => {
      const he = c.helper_sites.filter((h) => h.can_edit).length;
      return `<tr class="${c.is_active ? "" : "off"}">
      <td><a href="javascript:void(0)" onclick="filterSitesBy(${c.id})" style="color:inherit">${esc(c.full_name)}</a>
        ${c.is_admin ? `<span class="tag-adm">admin</span>` : ""}</td>
      <td>${esc(ROLE_PL[c.role] || c.role || "—")}</td>
      <td>${esc(c.username || "—")}${c.last_login ? `<div class="sub">ost. ${ddy(c.last_login)}</div>` : ""}</td>
      <td>${c.has_tg ? "✓" : `<span class="muted">—</span>`}</td>
      <td title="${esc(c.main_sites.join(", "))}">${c.main_sites.length || `<span class="muted">0</span>`}
        ${c.main_sites.length ? `<div class="sub">${esc(c.main_sites.slice(0, 3).join(", "))}${c.main_sites.length > 3 ? ` +${c.main_sites.length - 3}` : ""}</div>` : ""}</td>
      <td title="${esc(c.helper_sites.map((h) => h.site_key + (h.can_edit ? " (edycja)" : " (podgląd)")).join(", "))}">
        ${c.helper_sites.length || `<span class="muted">0</span>`}${c.helper_sites.length ? `<div class="sub">${he ? `${he} z edycją` : "podgląd"}</div>` : ""}</td>
      <td>${c.lead_regions.length ? esc(c.lead_regions.join(", ")) : `<span class="muted">—</span>`}</td>
      <td class="num" title="Zakładów w panelu głównym: z edycją / razem">${c.access_n ? `${c.edit_n} / ${c.access_n}` : `<span class="muted">0</span>`}</td>
      <td>${c.is_active ? `<span style="color:var(--green)">aktywny</span>` : `<span class="tag-off">nieaktywny</span>`}</td>
      <td>${c.id === r.me ? "" : c.is_active
        ? `<button class="btn btn-ghost btn-sm" onclick="setCoordActive(${c.id}, false)">Dezaktywuj</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="setCoordActive(${c.id}, true)">Aktywuj</button>`}</td></tr>`;
    }).join("")}
    </tbody></table>`;
}

async function addHelper(enc, sel) {
  const id = parseInt(sel.value, 10);
  if (!id) return;
  const r = await api("/admin/helpers", { method: "PUT", body: { site_key: decodeURIComponent(enc), coordinator_id: id, can_edit: false } });
  if (r && r.ok) { await loadAssign(true); asFlash(`✓ ${cName(id)} — pomocniczy (podgląd) na ${decodeURIComponent(enc)}`); }
  else { alertBox(r); sel.value = ""; }
}
async function setHelperEdit(enc, id, canEdit) {
  const r = await api("/admin/helpers", { method: "PUT", body: { site_key: decodeURIComponent(enc), coordinator_id: id, can_edit: !!canEdit } });
  if (r && r.ok) { await loadAssign(true); asFlash(`✓ ${cName(id)} na ${decodeURIComponent(enc)}: ${canEdit ? "może edytować" : "tylko podgląd"}`); }
  else alertBox(r);
}
async function removeHelper(enc, id) {
  const site = decodeURIComponent(enc);
  if (!window.confirm(`Usunąć ${cName(id)} z obiektu „${site}”? Straci do niego dostęp w panelu.`)) return;
  const r = await api("/admin/helpers", { method: "DELETE", body: { site_key: site, coordinator_id: id } });
  if (r && r.ok) { await loadAssign(true); asFlash(`✓ ${cName(id)} usunięty z ${site}`); }
  else alertBox(r);
}
async function reviewAll(mode) {
  const n = ST.assign.review_n;
  const text = mode === "view"
    ? `Zmienić ${n} przeniesionych przypisań na „tylko podgląd”? Ci koordynatorzy przestaną móc edytować godziny, zaliczki, wolne i pracowników na tych obiektach.`
    : `Zostawić prawo edycji wszystkim ${n} przeniesionym przypisaniom i zdjąć „do sprawdzenia”?`;
  if (!window.confirm(text)) return;
  const r = await api("/admin/helpers/review", { method: "POST", body: { mode } });
  if (r && r.ok) { ST.asf.review = false; await loadAssign(true); asFlash(`✓ Zmieniono: ${r.n != null ? r.n : n}`); }
  else alertBox(r);
}
async function setCoordActive(id, active) {
  const c = ST.coordById[id];
  if (!active && !window.confirm(`Dezaktywować: ${c.full_name}?\n\nNie zaloguje się do panelu, straci dostęp do obiektów i nie będzie dostawać wiadomości w Telegramie. ` +
    `Przypisania zostaną i wrócą po aktywacji.` + (c.main_sites.length ? `\n\nJest głównym na: ${c.main_sites.join(", ")} — po dezaktywacji przypisz tam innego koordynatora.` : ""))) return;
  const r = await api(`/admin/coordinators/${id}/active`, { method: "POST", body: { active } });
  if (!r || !r.ok) return alertBox(r);
  if (!active && r.main_sites.length) ST.asf.problems = true;
  await loadAssign(true);
  asFlash(`✓ ${c.full_name}: ${active ? "aktywny" : "nieaktywny"}${!active && r.sessions_closed ? ` (wylogowano: ${r.sessions_closed})` : ""}`);
}
