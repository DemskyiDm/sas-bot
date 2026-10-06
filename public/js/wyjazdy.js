// ══════════════════════════════════════════════════════════════════════
//  Розділ «Wyjazdy / przyjazdy»: план–факт набору і виїздів, день,
//  план набору на 3 тижні, налаштування зведення.
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "week", me: null, week: null, wd: null, sort: { key: null, dir: -1 },
  orders: null, settings: null, seq: 0, dseq: 0,
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* prywatne okno */ } },
};

// ── Утиліти ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const dd = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) : "");
const ddy = (iso) => (iso ? dd(iso) + "." + iso.slice(0, 4) : "");
function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DOW = ["nd", "pn", "wt", "śr", "cz", "pt", "sb"];
const dow = (iso) => DOW[new Date(iso + "T00:00:00Z").getUTCDay()];
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
const STATUS_PL = { pracuje: "pracuje", zwolniony: "zwolniony", rezygnacja: "rezygnacja", przeniesiony: "przeniesiony", unknown: "bez statusu", urlop: "urlop" };

async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch("/api/flow" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function qs(extra) {
  const p = new URLSearchParams();
  const reg = document.getElementById("selRegion").value;
  const co = document.getElementById("selCoord").value;
  if (reg && reg !== "all") p.set("region", reg);
  if (co) p.set("coord", co);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== "") p.set(k, v); });
  return "?" + p.toString();
}

// ── Старт ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", init);
async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  if (!me.ok || !me.has_access) {
    document.getElementById("toolbar").style.display = "none";
    document.querySelectorAll(".nav-item[data-view]").forEach((el) => (el.style.display = "none"));
    document.getElementById("content").innerHTML =
      `<div class="noaccess">🚌 Sekcja <b>Wyjazdy / przyjazdy</b> jest dostępna dla koordynatorów obiektów,
       koordynatorów regionalnych i kierownictwa.<br>Jeśli prowadzisz obiekt, poproś o przypisanie w Region → Ustawienia.</div>`;
    return;
  }
  ST.me = me;
  ST.week = me.week;
  const selR = document.getElementById("selRegion");
  const selC = document.getElementById("selCoord");
  if (me.role === "coord") {
    document.getElementById("regBox").style.display = "none";
    document.getElementById("coordBox").style.display = "none";
  } else {
    const regs = me.regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    selR.innerHTML = me.role === "all"
      ? `<option value="all">Wszystkie regiony</option>${regs}<option value="none">Bez regionu</option>`
      : (me.regions.length > 1 ? `<option value="all">Moje regiony</option>` : "") + regs;
    selC.innerHTML = `<option value="">Wszyscy</option>` +
      me.coordinators.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    const sv = store.get("sas_flow_region");
    if (sv && [...selR.options].some((o) => o.value === sv)) selR.value = sv;
  }
  if (me.is_admin) document.getElementById("navSettings").style.display = "";
  buildWeekChips();
  document.getElementById("dayDate").value = me.today;
  const h = location.hash.replace("#", "");
  showView(["week", "day", "orders", "settings"].includes(h) ? h : "week");
  refreshOrdersBadge();
}

function onFilter() {
  store.set("sas_flow_region", document.getElementById("selRegion").value);
  loadView();
  refreshOrdersBadge();
}

function showView(v) {
  if (v === "settings" && !(ST.me && ST.me.is_admin)) v = "week";
  ST.view = v;
  location.hash = v;
  document.querySelectorAll(".fl-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent =
    { week: "Wyjazdy / przyjazdy — tydzień", day: "Wyjazdy / przyjazdy — dzień", orders: "Plan naboru", settings: "Wyjazdy / przyjazdy — ustawienia" }[v];
  document.getElementById("toolbar").style.visibility = v === "settings" ? "hidden" : "";
  loadView();
}
function loadView() {
  if (ST.view === "week") loadWeek();
  if (ST.view === "day") loadDay();
  if (ST.view === "orders") loadOrders();
  if (ST.view === "settings") loadSettings();
}

// ══════════════════════════════════════════════════════════════════════
//  Тиждень: план і факт
// ══════════════════════════════════════════════════════════════════════
function buildWeekChips() {
  const cur = ST.me.week;
  const list = [];
  for (let i = -6; i <= 3; i++) list.push(addDays(cur, i * 7));
  document.getElementById("weekChips").innerHTML = list.map((w) => {
    const tag = w === cur ? "bieżący" : w > cur ? "plan" : "";
    return `<button class="chip${w === ST.week ? " active" : ""}" data-w="${w}" onclick="setWeek(this.dataset.w)">${dd(w)}–${dd(addDays(w, 6))}${tag ? `<span class="s">${tag}</span>` : ""}</button>`;
  }).join("");
}
function setWeek(w) { ST.week = w; buildWeekChips(); loadWeek(); }

async function loadWeek() {
  const my = ++ST.seq;
  document.getElementById("weekTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/week" + qs({ week: ST.week }));
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("weekTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.wd = r;
  renderWeek();
}

const realCls = (f, p) => (p == null || !p ? "" : f >= p ? "good" : f >= p * 0.8 ? "warn" : "bad");

function renderWeek() {
  const r = ST.wd;
  if (!r) return;
  const fut = r.state === "future";
  const t = r.total;
  // банер про стан тижня
  let ban = "";
  if (fut) ban = `Tydzień jeszcze się nie zaczął: widać plan naboru i to, co już wpisano. Plan wyjazdów utrwali się w poniedziałek ${ddy(r.week)} o 00:00.`;
  else if (!r.fixed) ban = `Plan wyjazdów na ten tydzień nie był utrwalony (tydzień sprzed uruchomienia sekcji) — porównanie z planem niedostępne.`;
  else if (r.fixed.late) ban = `Plan wyjazdów utrwalony z opóźnieniem: ${esc(r.fixed.fixed_at)} (np. pierwszy tydzień po instalacji). Wyjazdy wpisane przed tym momentem liczą się jako planowane.`;
  document.getElementById("weekBanner").innerHTML = ban ? `<div class="banner${r.fixed && r.fixed.late ? " warn" : ""}">${ban}</div>` : "";

  const net = t.arr_fact + t.tr_fact - t.dep_fact;
  const kp = [
    { l: "Nabór: fakt / plan", v: `${t.arr_fact}<small> / ${t.sites_with_order ? t.order_qty : "—"}</small>`,
      s: t.sites_with_order ? `realizacja <b class="${realCls(t.arr_fact, t.order_qty)}">${pct(t.arr_fact, t.order_qty)}</b> · plan na ${t.sites_with_order} obiektach` : "plan naboru nie wpisany", k: "arr_fact" },
    { l: "Wpisano nowych", v: t.arr_entered, s: `${t.arr_unconf ? `${t.arr_unconf} bez statusu · ` : ""}${t.arr_rez ? `${t.arr_rez} nie dojechało` : "nikt nie zrezygnował"}`, k: "arr_entered" },
    { l: "Wyjazdy: fakt / plan", v: `${t.dep_fact}<small> / ${t.dep_plan == null ? "—" : t.dep_plan}</small>`,
      s: `wpisano na tydzień: ${t.dep_now}${t.dep_fact_tr ? ` · w tym przeniesienia ${t.dep_fact_tr}` : ""}`, k: "dep_fact" },
    { l: "Wyjazdy poza planem", v: t.dep_unplanned == null ? "—" : `<span class="${t.dep_unplanned ? "bad" : "good"}">${t.dep_unplanned}</span>`,
      s: t.dep_unplanned == null ? "brak utrwalonego planu" : `nie było ich w planie na początek tygodnia${t.plan_moved ? ` · ${t.plan_moved} z planu nie wyjechało` : ""}`, k: t.dep_unplanned ? "dep_unplanned" : null },
    { l: "Przeniesienia", v: `+${t.tr_fact} / −${t.dep_fact_tr}`, s: "przyszli / odeszli między obiektami", k: "tr_entered" },
    { l: "Liczebność", v: `<span class="${net > 0 ? "good" : net < 0 ? "bad" : ""}">${net > 0 ? "+" : ""}${net}</span>`,
      s: `nabór + przeniesienia − wyjazdy${fut ? "" : r.state === "current" ? ", do dziś" : ""}` },
  ];
  document.getElementById("weekKpis").innerHTML = kp.map((x) => `
    <div class="kpi${x.k && !fut ? " click" : ""}" ${x.k && !fut ? `data-k="${x.k}" onclick="openList(this.dataset.k)"` : ""}>
      <div class="l">${x.l}</div><div class="v">${x.v}</div><div class="s">${x.s}</div></div>`).join("");

  // таблиця
  const q = (document.getElementById("weekSearch").value || "").toLowerCase();
  const showEmpty = document.getElementById("showEmpty").checked;
  let rows = r.rows.filter((x) => (!q || x.site_key.toLowerCase().includes(q) || (x.coordinator_name || "").toLowerCase().includes(q)));
  const active = (x) => x.order_qty != null || x.arr_entered || x.arr_rez || x.tr_entered || x.dep_now || x.dep_plan;
  const hidden = rows.filter((x) => !active(x)).length;
  if (!showEmpty) rows = rows.filter(active);
  const gap = (x) => (x.order_qty || 0) - x.arr_fact;
  const key = ST.sort.key;
  rows.sort((a, b) => key
    ? ((key === "site_key" ? a.site_key.localeCompare(b.site_key) : (Number(a[key]) || 0) - (Number(b[key]) || 0)) * ST.sort.dir)
    : gap(b) - gap(a) || (b.dep_unplanned || 0) - (a.dep_unplanned || 0) || a.site_key.localeCompare(b.site_key));
  document.getElementById("weekCnt").textContent = `${rows.length}${hidden && !showEmpty ? ` (+${hidden} bez ruchu)` : ""}`;
  if (!rows.length) { document.getElementById("weekTable").innerHTML = `<div class="empty">Brak obiektów</div>`; return; }

  const n = (v, kind, site, cls) => {
    if (v == null) return `<span class="z">—</span>`;
    if (!v) return `<span class="z">0</span>`;
    return `<a class="n ${cls || ""}" data-k="${kind}" data-s="${esc(site)}" onclick="openList(this.dataset.k, this.dataset.s)">${v}</a>`;
  };
  const th = (k, label, cls) => `<th class="${cls || ""}" data-k="${k}" onclick="sortWeek(this.dataset.k)">${label}${ST.sort.key === k ? (ST.sort.dir < 0 ? " ▼" : " ▲") : ""}</th>`;
  const F = fut;
  const line = (x, tot) => {
    const site = tot ? "" : x.site_key;
    const real = x.order_qty ? `<span class="${realCls(x.arr_fact, x.order_qty)}">${pct(x.arr_fact, x.order_qty)}</span>` : `<span class="z">—</span>`;
    const net = x.arr_fact + x.tr_fact - x.dep_fact;
    return `<tr class="${tot ? "tot" : ""}">
      <td class="l">${tot ? "Razem" : `${esc(x.site_key)}<div class="sub">${x.coordinator_name ? esc(x.coordinator_name) : "— bez koordynatora —"}${x.region_name && document.getElementById("selRegion").value === "all" && ST.me.role !== "coord" ? " · " + esc(x.region_name) : ""}</div>`}</td>
      <td class="sep">${x.order_qty == null ? `<span class="z" title="Plan nie wpisany">—</span>` : x.order_qty}${!tot && x.order_in_week ? ` <span class="tag" title="Zmieniony w trakcie tygodnia: ${esc(x.order_at)}">zm.</span>` : ""}</td>
      <td>${n(x.arr_entered, "arr_entered", site)}</td>
      <td>${F ? `<span class="z">—</span>` : n(x.arr_fact, "arr_fact", site)}</td>
      <td>${F ? `<span class="z">—</span>` : real}</td>
      <td>${F ? `<span class="z">—</span>` : n(x.arr_unconf, "arr_unconf", site, "warn")}</td>
      <td>${n(x.arr_rez, "arr_rez", site, "bad")}</td>
      <td>${n(x.tr_entered, "tr_entered", site)}</td>
      <td class="sep">${F ? `<span class="z">—</span>` : n(x.dep_plan, "dep_plan", site)}</td>
      <td>${n(x.dep_now, "dep_now", site)}</td>
      <td>${F ? `<span class="z">—</span>` : n(x.dep_fact, "dep_fact", site)}</td>
      <td>${F ? `<span class="z">—</span>` : n(x.dep_unplanned, "dep_unplanned", site, "bad")}</td>
      <td>${F ? `<span class="z">—</span>` : n(x.dep_fact_tr, "dep_fact_tr", site)}</td>
      <td class="sep">${F ? `<span class="z">—</span>` : `<span class="${net > 0 ? "good" : net < 0 ? "bad" : "z"}">${net > 0 ? "+" : ""}${net}</span>`}</td>
    </tr>`;
  };
  document.getElementById("weekTable").innerHTML = `
    <table class="fl"><thead>
      <tr><th class="l grp"></th><th class="grp sep" colspan="7">Nabór</th><th class="grp sep" colspan="5">Wyjazdy</th><th class="grp sep"></th></tr>
      <tr>${th("site_key", "Obiekt", "l")}${th("order_qty", "Plan", "sep")}${th("arr_entered", "Wpisano")}${th("arr_fact", "Fakt")}
        <th title="Fakt / plan">Real.</th>${th("arr_unconf", "Bez<br>statusu")}${th("arr_rez", "Nie<br>dojechali")}${th("tr_entered", "Z przenie-<br>sienia")}
        ${th("dep_plan", "Plan", "sep")}${th("dep_now", "Wpisano")}${th("dep_fact", "Fakt")}${th("dep_unplanned", "Poza<br>planem")}${th("dep_fact_tr", "Przenie-<br>sienia")}
        <th class="sep">Liczeb-<br>ność</th></tr>
    </thead><tbody>${rows.map((x) => line(x, false)).join("")}${line(t, true)}</tbody></table>`;
  document.getElementById("weekNote").innerHTML = `
    <b>Nabór:</b> plan — ile ludzi trzeba zrekrutować (wpisuje koordynator w niedzielę); wpisano — nowi z pierwszym dniem w tym tygodniu,
    status „pracuje” lub bez statusu; fakt — zaczęli pracę (pierwszy dzień minął, status ustawiony); przeniesienia z innych obiektów liczone osobno.
    <b>Wyjazdy</b> — po ostatnim dniu pracy, bez rezygnacji. Plan — co było wpisane na tydzień w poniedziałek o 00:00;
    poza planem — wyjechali, a nie było ich w planie. Przeniesienie to wyjazd dla obiektu, ale nie dla firmy.
    Kliknij liczbę — lista ludzi.`;
}
function sortWeek(k) {
  if (ST.sort.key === k) ST.sort.dir = -ST.sort.dir; else { ST.sort.key = k; ST.sort.dir = k === "site_key" ? 1 : -1; }
  renderWeek();
}

// ── Списки людей ──────────────────────────────────────────────────────
const LIST_TITLE = {
  arr_entered: "Nowi wpisani na tydzień", arr_fact: "Nowi — zaczęli pracę", arr_unconf: "Nowi bez statusu (niepotwierdzeni)",
  arr_rez: "Nie dojechali (rezygnacja)", tr_entered: "Przyszli z przeniesienia", arr_all: "Przyjazdy",
  dep_plan: "Wyjazdy w planie (poniedziałek 00:00)", plan_moved: "Z planu nie wyjechali w tym tygodniu",
  dep_now: "Wyjazdy wpisane na tydzień", dep_fact: "Wyjechali", dep_unplanned: "Wyjazdy poza planem", dep_fact_tr: "Przeniesienia na inne obiekty",
};
async function openList(kind, site, date) {
  const dw = document.getElementById("drawer");
  const title = LIST_TITLE[kind] || "Lista";
  const sub = `${site ? esc(site) + " · " : ""}${date ? `${dow(date)} ${ddy(date)}` : `tydzień ${dd(ST.week)}–${ddy(addDays(ST.week, 6))}`}`;
  dw.innerHTML = `<div class="dw-head"><div><h2>${esc(title)}</h2><div class="sub">${sub}</div></div>
    <button class="dw-close" onclick="closeDrawer()" title="Zamknij (Esc)">✕</button></div><div class="dw-body"><div class="loading">Ładowanie…</div></div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  const my = ++ST.dseq;
  const r = await api("/list" + qs({ kind, site, week: date ? null : ST.week, date }));
  if (my !== ST.dseq || !r) return;
  const body = dw.querySelector(".dw-body");
  if (!r.ok) { body.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  if (!r.rows.length) { body.innerHTML = `<div class="empty">Brak osób</div>`; return; }
  const isDep = kind.startsWith("dep") || kind === "plan_moved";
  body.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:8px">${r.rows.length} os.</div>
    <div class="tblwrap"><table class="fl"><thead><tr>
      <th class="l">Pracownik</th><th class="l">Obiekt</th><th>${isDep ? "Ostatni dzień" : "Pierwszy dzień"}</th><th class="l">Status / uwagi</th><th>Wpisano</th>
    </tr></thead><tbody>${r.rows.map((x) => personRow(x, isDep, kind)).join("")}</tbody></table></div>`;
}
function personRow(x, isDep, kind) {
  const notes = [];
  if (x.status) notes.push(`<span class="tag ${x.status === "rezygnacja" ? "rez" : x.status === "unknown" ? "late" : ""}">${esc(STATUS_PL[x.status] || x.status)}</span>`);
  if (isDep && x.is_transfer) notes.push(`<span class="tag tr">przeniesienie${x.to_site ? " → " + esc(x.to_site) : ""}</span>`);
  if (!isDep && x.kind === "transfer") notes.push(`<span class="tag tr">z ${esc(x.from_site || "innego obiektu")}</span>`);
  if (kind === "dep_plan" || kind === "plan_moved") notes.push(x.still_leaving ? (x.now_date !== x.date ? `<span class="tag late">teraz ${dd(x.now_date)}</span>` : "") : `<span class="tag ok">nie wyjeżdża w tym tyg.</span>`);
  if (x.notice_days != null && isDep) notes.push(`<span class="${x.notice_days <= 1 ? "bad" : "dim"}" style="font-size:11px">wpisano ${x.notice_days <= 0 ? "w dniu wyjazdu lub później" : `${x.notice_days} dn. przed`}</span>`);
  return `<tr><td class="l">${esc(x.full_name)} <span class="sub">${esc(x.login || "")}</span></td>
    <td class="l">${esc(x.site_key)}${x.coordinator_name ? `<div class="sub">${esc(x.coordinator_name)}</div>` : ""}</td>
    <td>${x.date ? `${dow(x.date)} ${dd(x.date)}` : ""}</td>
    <td class="l">${notes.join(" ")}</td>
    <td>${x.baseline ? `<span class="z" title="Przed uruchomieniem dziennika">—</span>` : x.seen_at ? `<span style="font-size:11px">${esc(x.seen_at.slice(8, 10) + "." + x.seen_at.slice(5, 7) + " " + x.seen_at.slice(11))}</span>` : ""}</td></tr>`;
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ══════════════════════════════════════════════════════════════════════
//  День
// ══════════════════════════════════════════════════════════════════════
function shiftDay(n) {
  const el = document.getElementById("dayDate");
  el.value = addDays(el.value || ST.me.today, n);
  loadDay();
}
function setToday() { document.getElementById("dayDate").value = ST.me.today; loadDay(); }

async function loadDay() {
  const day = document.getElementById("dayDate").value || ST.me.today;
  const my = ++ST.seq;
  ["dayDeps", "dayArrs"].forEach((id) => (document.getElementById(id).innerHTML = `<div class="loading">Ładowanie…</div>`));
  const r = await api("/day" + qs({ date: day }));
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("dayDeps").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  const s = r.summary;
  document.getElementById("daySummary").innerHTML = `${dow(day)} ${ddy(day)} · ` + (s
    ? `podsumowanie wysłane ${esc(s.made_at.slice(11))} (${s.sent} odbiorców${s.failed ? `, ${s.failed} nie doszło` : ""})`
    : day > r.today ? "dzień w przyszłości — to, co już wpisano" : day === r.today ? "podsumowanie jeszcze nie wysłane" : "brak podsumowania z tego dnia");

  const deps = r.departures, arrs = r.arrivals;
  const out = deps.filter((x) => !x.is_transfer), trOut = deps.filter((x) => x.is_transfer);
  const aNew = arrs.filter((x) => x.kind === "new" && !["rezygnacja", "unknown"].includes(x.status));
  const aTr = arrs.filter((x) => x.kind === "transfer" && x.status !== "rezygnacja");
  const aUnc = arrs.filter((x) => x.kind === "new" && x.status === "unknown");
  const aRez = arrs.filter((x) => x.status === "rezygnacja");
  const after = deps.filter((x) => x.after_summary).length + arrs.filter((x) => x.after_summary).length;
  const kp = [
    { l: "Wyjechali", v: out.length, s: "bez przeniesień" },
    { l: "Przeniesienia", v: `${trOut.length} / ${aTr.length}`, s: "odeszli / przyszli" },
    { l: "Nowi zaczęli", v: aNew.length, s: aUnc.length ? `+ ${aUnc.length} bez statusu` : "status ustawiony" },
    { l: "Nie dojechali", v: aRez.length, s: "rezygnacja" },
    { l: "Wpisane po podsumowaniu", v: `<span class="${after ? "warn" : ""}">${after}</span>`, s: "pójdą w jutrzejszym jako „dopisane”" },
  ];
  document.getElementById("dayKpis").innerHTML = kp.map((x) => `<div class="kpi"><div class="l">${x.l}</div><div class="v">${x.v}</div><div class="s">${x.s}</div></div>`).join("");
  document.getElementById("dayDepCnt").textContent = deps.length ? `${deps.length} os.` : "";
  document.getElementById("dayArrCnt").textContent = arrs.length ? `${arrs.length} os.` : "";
  document.getElementById("dayDeps").innerHTML = deps.length ? dayTable(deps, true) : `<div class="empty">Brak wyjazdów</div>`;
  document.getElementById("dayArrs").innerHTML = arrs.length ? dayTable(arrs, false) : `<div class="empty">Brak przyjazdów</div>`;

  document.getElementById("dayLateBox").style.display = r.late.length ? "" : "none";
  document.getElementById("dayLate").innerHTML = r.late.length ? `<table class="fl"><thead><tr><th class="l">Pracownik</th><th class="l">Obiekt</th><th>Data</th><th class="l">Co</th></tr></thead><tbody>
    ${r.late.map((x) => `<tr><td class="l">${esc(x.full_name)} <span class="sub">${esc(x.login || "")}</span></td><td class="l">${esc(x.site_key)}</td>
      <td>${dow(x.date)} ${dd(x.date)}</td><td class="l">${x.kind === "out" ? "wyjazd" : x.status === "rezygnacja" ? "nie dojechał" : "przyjazd"}</td></tr>`).join("")}</tbody></table>` : "";
  document.getElementById("dayCorrBox").style.display = r.corrections.length ? "" : "none";
  document.getElementById("dayCorr").innerHTML = r.corrections.length ? `<table class="fl"><thead><tr><th class="l">Pracownik</th><th class="l">Obiekt</th><th>Było</th><th class="l">Teraz</th></tr></thead><tbody>
    ${r.corrections.map((x) => `<tr><td class="l">${esc(x.full_name)}</td><td class="l">${esc(x.site_key)}</td>
      <td>${x.kind === "out" ? "wyjazd" : "przyjazd"} ${dd(x.date)}</td>
      <td class="l">${x.corrected_to ? `przesunięty na ${dd(x.corrected_to)}` : x.kind === "in" ? "odwołany / nie dojechał" : "odwołany"}</td></tr>`).join("")}</tbody></table>` : "";
}
function dayTable(list, isDep) {
  return `<table class="fl"><thead><tr><th class="l">Pracownik</th><th class="l">Obiekt</th><th class="l">Uwagi</th><th>Wpisano</th></tr></thead><tbody>
    ${list.map((x) => {
      const notes = [];
      if (isDep && x.is_transfer) notes.push(`<span class="tag tr">→ ${esc(x.to_site || "inny obiekt")}</span>`);
      if (!isDep && x.kind === "transfer") notes.push(`<span class="tag tr">z ${esc(x.from_site || "innego obiektu")}</span>`);
      if (!isDep && x.status === "rezygnacja") notes.push(`<span class="tag rez">nie dojechał</span>`);
      if (!isDep && x.status === "unknown") notes.push(`<span class="tag late">bez statusu</span>`);
      if (x.after_summary) notes.push(`<span class="tag late" title="Wpisano po wysłaniu podsumowania — pójdzie w następnym">po podsumowaniu</span>`);
      return `<tr><td class="l">${esc(x.full_name)} <span class="sub">${esc(x.login || "")}</span></td>
        <td class="l">${esc(x.site_key)}${x.coordinator_name ? `<div class="sub">${esc(x.coordinator_name)}</div>` : ""}</td>
        <td class="l">${notes.join(" ")}</td>
        <td>${x.baseline ? `<span class="z">—</span>` : x.seen_at ? `<span style="font-size:11px">${esc(x.seen_at.slice(8, 10) + "." + x.seen_at.slice(5, 7) + " " + x.seen_at.slice(11))}</span>` : ""}</td></tr>`;
    }).join("")}</tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════
//  План набору
// ══════════════════════════════════════════════════════════════════════
async function refreshOrdersBadge() {
  const r = await api("/orders" + qs());
  const n = r && r.ok ? r.rows.filter((x) => !x.confirmed).length : 0;
  const b = document.getElementById("badgeOrders");
  b.textContent = n ? String(n) : "";
  b.title = n ? `${n} obiektów bez potwierdzonego planu na 3 tygodnie` : "";
}
async function loadOrders() {
  const my = ++ST.seq;
  document.getElementById("ordTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/orders" + qs());
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("ordTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.orders = r;
  renderOrders();
}
function renderOrders() {
  const r = ST.orders;
  const done = r.rows.filter((x) => x.confirmed).length;
  const sunday = addDays(r.weeks[0], -1);
  document.getElementById("ordBanner").innerHTML = `<div class="banner${done < r.rows.length ? " warn" : ""}">
    Wpisz do <b>niedzieli ${dd(sunday)}, ${esc(r.deadline)}</b>, ilu ludzi trzeba zrekrutować na tygodnie
    ${r.weeks.map((w) => `<b>${dd(w)}–${dd(addDays(w, 6))}</b>`).join(", ")}.
    Potwierdzone: <b>${done} z ${r.rows.length}</b> obiektów. Plan na bieżący tydzień (${dd(r.current_week)}) jest już zamknięty${r.can_edit_current ? " — może go zmienić tylko kierownictwo" : ""}.
    <div class="sub" style="margin-top:4px">W każdą sobotę o 0:00 potwierdzenia się zerują — liczby zostają, ale trzeba je sprawdzić i potwierdzić ponownie („Zapisz”).${r.confirm_from ? ` Liczą się zapisy od soboty ${dd(r.confirm_from)}.` : ""}</div></div>`;
  document.getElementById("ordCnt").textContent = `${r.rows.length} obiektów`;
  if (!r.rows.length) { document.getElementById("ordTable").innerHTML = `<div class="empty">Brak obiektów</div>`; return; }
  // Koordynator: propozycja z poprzedniego tygodnia wpisana szarym — „Zapisz wszystkie” = potwierdzenie.
  // Region / kierownictwo: propozycja tylko jako podpowiedź (placeholder), zapisują się tylko zmienione wiersze.
  const own = ST.me.role === "coord";
  const cell = (row, c, i, j, editable) => {
    const prev = j === 0 ? row.current.qty : row.weeks[j - 1].qty;
    const prop = c.qty == null && prev != null;
    const val = c.qty != null ? c.qty : prop && own ? prev : "";
    return `<div class="ord-cell"><input type="number" min="0" max="999" step="1" value="${val}" ${editable ? "" : "disabled"}
      ${prop && !own ? `placeholder="${prev}"` : ""} class="${prop && own ? "prop" : ""}" data-i="${i}" data-j="${j}"
      oninput="this.classList.remove('prop','bad'); this.dataset.dirty='1'" />
      <span class="h">wyj. ${c.dep} · wpis. ${c.arr}</span></div>`;
  };
  document.getElementById("ordTable").innerHTML = `<table class="fl"><thead><tr>
      <th class="l">Obiekt</th><th title="Pracuje dziś">Pracuje</th>
      <th class="sep" title="Bieżący tydzień — zamknięty">${dd(r.current_week)}–${dd(addDays(r.current_week, 6))}</th>
      ${r.weeks.map((w) => `<th class="sep">${dd(w)}–${dd(addDays(w, 6))}</th>`).join("")}
      <th class="l sep">Stan</th><th></th></tr></thead><tbody>
    ${r.rows.map((row, i) => `<tr>
      <td class="l">${esc(row.site_key)}<div class="sub">${row.coordinator_name ? esc(row.coordinator_name) : "— bez koordynatora —"}</div></td>
      <td>${row.headcount}</td>
      <td class="sep">${r.can_edit_current
        ? `<div class="ord-cell"><input type="number" min="0" max="999" value="${row.current.qty == null ? "" : row.current.qty}" data-i="${i}" data-j="cur" oninput="this.dataset.dirty='1'" /><span class="h">wyj. ${row.current.dep} · wpis. ${row.current.arr}</span></div>`
        : `${row.current.qty == null ? `<span class="z">—</span>` : row.current.qty}<div class="sub">wyj. ${row.current.dep} · wpis. ${row.current.arr}</div>`}</td>
      ${row.weeks.map((c, j) => `<td class="sep">${cell(row, c, i, j, true)}</td>`).join("")}
      <td class="l sep">${row.confirmed ? `<span class="ok-mark">✓ potwierdzone</span>`
        : row.weeks.every((c) => c.qty != null) ? `<span class="no-mark" title="Liczby są, ale od soboty nikt ich nie potwierdził">do potwierdzenia</span>`
        : `<span class="no-mark">do wpisania</span>`}
        <div class="sub">${row.weeks[0].entered_at ? "ost. zmiana " + esc(row.weeks[0].entered_at.slice(8, 10) + "." + row.weeks[0].entered_at.slice(5, 7) + " " + row.weeks[0].entered_at.slice(11)) : ""}</div></td>
      <td><button class="btn btn-ghost btn-sm" data-i="${i}" onclick="saveOrders(Number(this.dataset.i))">Zapisz</button></td>
    </tr>`).join("")}</tbody></table>`;
}
async function saveOrders(onlyRow) {
  const r = ST.orders;
  const msg = document.getElementById("ordMsg");
  const items = [];
  let bad = 0;
  const own = ST.me.role === "coord";
  r.rows.forEach((row, i) => {
    if (onlyRow != null && i !== onlyRow) return;
    const inputs = [...document.querySelectorAll(`#ordTable input[data-i="${i}"]`)];
    // „Zapisz wszystkie” u regionalnego / kierownictwa — tylko wiersze, które zmienił
    if (onlyRow == null && !own && !inputs.some((el) => el.dataset.dirty)) return;
    const weekInputs = inputs.filter((el) => el.dataset.j !== "cur");
    const vals = weekInputs.map((el) => el.value.trim());
    if (vals.every((v) => v === "")) { if (onlyRow != null) { bad++; weekInputs.forEach((el) => el.classList.add("bad")); } return; }
    let rowOk = true;
    weekInputs.forEach((el) => {
      const v = el.value.trim();
      if (v === "" || !/^\d{1,3}$/.test(v)) { el.classList.add("bad"); rowOk = false; }
    });
    if (!rowOk) { bad++; return; }
    weekInputs.forEach((el) => items.push({ site_key: row.site_key, week_start: r.weeks[Number(el.dataset.j)], qty: Number(el.value) }));
    const cur = inputs.find((el) => el.dataset.j === "cur");
    if (cur && cur.value.trim() !== "" && Number(cur.value) !== row.current.qty) {
      if (!/^\d{1,3}$/.test(cur.value.trim())) { cur.classList.add("bad"); bad++; return; }
      items.push({ site_key: row.site_key, week_start: r.current_week, qty: Number(cur.value) });
    }
  });
  if (bad && !items.length) { msg.className = "msg err"; msg.textContent = "Uzupełnij liczby 0–999 we wszystkich 3 tygodniach"; return; }
  if (!items.length) { msg.className = "msg err"; msg.textContent = own ? "Brak liczb do zapisania" : "Brak zmian — wpisz liczby albo użyj „Zapisz” w wierszu"; return; }
  msg.className = "msg"; msg.textContent = "Zapisywanie…";
  const res = await api("/orders", { method: "POST", body: { items } });
  if (!res || !res.ok) { msg.className = "msg err"; msg.textContent = (res && res.error) || "Błąd"; return; }
  msg.className = "msg ok";
  msg.textContent = `Zapisano${bad ? ` · ${bad} obiektów pominięto — uzupełnij wszystkie 3 tygodnie` : ""}`;
  await loadOrders();
  refreshOrdersBadge();
}

// ══════════════════════════════════════════════════════════════════════
//  Налаштування (адмін)
// ══════════════════════════════════════════════════════════════════════
const SCOPE_PL = { own: "Swoje obiekty", region: "Region", all: "Cała firma" };
async function loadSettings() {
  const body = document.getElementById("settingsBody");
  body.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/settings");
  if (!r) return;
  if (!r.ok) { body.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.settings = r;
  const S = Object.fromEntries(r.settings.map((x) => [x.key, x.value]));
  const days = (S.summary_days || "").split(",");
  const dayBoxes = [1, 2, 3, 4, 5, 6, 7].map((d) => `<label><input type="checkbox" class="sdays" value="${d}" ${days.includes(String(d)) ? "checked" : ""}/> ${["pn", "wt", "śr", "cz", "pt", "sb", "nd"][d - 1]}</label>`).join("");
  const last = r.summaries.length
    ? r.summaries.map((x) => `${dd(x.day)} ${esc(x.made_at.slice(11))} → ${x.sent}${x.failed ? ` (+${x.failed} błąd)` : ""}`).join(" · ")
    : "jeszcze żadnego";
  body.innerHTML = `
  <div class="section">
    <div class="section-head">Podsumowanie dzienne i przypomnienia</div>
    <div class="cfg">
      <span class="k">Sekcja włączona</span><span><input type="checkbox" id="s_enabled" ${S.enabled === "1" ? "checked" : ""}/></span>
      <span class="h">Wyłączone — nie idą podsumowania, przypomnienia i nie utrwala się plan tygodnia. Strona działa dalej.</span>
      <span class="k">Godzina podsumowania</span><span><input type="time" id="s_summary_time" value="${esc(S.summary_time)}"/></span>
      <span class="h">Codziennie o tej godzinie: wyjazdy i przyjazdy z dnia. Wpisane później pójdą w następnym jako „dopisane”.</span>
      <span class="k">Dni podsumowania</span><span class="days">${dayBoxes}</span>
      <span class="h">W dniu bez podsumowania (np. niedziela) jego wyjazdy pójdą w następnym — w głównej części, z datą.</span>
      <span class="k">Import tabeli przed podsumowaniem</span><span><input type="number" id="s_pre_import_min" value="${esc(S.pre_import_min)}" min="0" max="180"/> min wcześniej</span>
      <span class="h">Żeby podsumowanie było ze świeżej tabeli. 0 — nie uruchamiać (zwykły import co 4 godziny działa dalej).</span>
      <span class="k">Szukać dopisanych za</span><span><input type="number" id="s_late_days" value="${esc(S.late_days)}" min="1" max="60"/> dni wstecz</span>
      <span class="k">Koordynatorzy automatycznie</span><span><input type="checkbox" id="s_auto_coords" ${S.auto_coords === "1" ? "checked" : ""}/> każdy koordynator dostaje podsumowanie swoich obiektów i przypomnienie w niedzielę</span>
      <span class="h">${r.auto ? `Koordynatorów z obiektami: ${r.auto.n}${r.auto.no_tg ? `, bez Telegrama: ${r.auto.no_tg} (nic nie dostaną)` : ""}.` : ""}</span>
      <span class="k">Pomijać puste</span><span><input type="checkbox" id="s_skip_empty" ${S.skip_empty === "1" ? "checked" : ""}/> nie wysyłać koordynatorowi, jeśli na jego obiektach nic się nie stało</span>
      <span class="k">Przypomnienie o planie naboru</span><span><input type="text" class="inp" id="s_orders_remind" value="${esc(S.orders_remind)}" style="width:140px"/> w niedzielę</span>
      <span class="h">Godziny po przecinku, np. 12:00,18:00. Idzie tylko do tych, kto jeszcze nie wpisał planu.</span>
      <span class="k">Termin planu naboru</span><span>niedziela <input type="time" id="s_orders_deadline" value="${esc(S.orders_deadline)}"/></span>
      <span class="k">Raport poniedziałkowy</span><span><input type="time" id="s_monday_time" value="${esc(S.monday_time)}"/></span>
      <span class="h">Kto nie wpisał planu naboru i plan–fakt poprzedniego tygodnia — dla odbiorców z zaznaczonym „Plan naboru” / „Tydzień”.</span>
    </div>
    <div class="actions">
      <button class="btn btn-primary btn-sm" onclick="saveSettings()">Zapisz ustawienia</button><span class="msg" id="setMsg"></span>
      <span style="margin-left:auto;font-size:11px;color:var(--text3)">Ostatnie podsumowania: ${last}</span>
    </div>
  </div>

  <div class="section">
    <div class="section-head">Odbiorcy <span class="cnt">${r.recipients.length}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" onclick="testSend('daily')">🧪 Podsumowanie do mnie</button>
      <button class="btn btn-ghost btn-sm" onclick="testSend('remind')">🧪 Przypomnienie do mnie</button>
      <button class="btn btn-ghost btn-sm" onclick="testSend('monday')">🧪 Raport pn do mnie</button>
      <span class="msg" id="testMsg"></span>
    </div>
    <div class="tblwrap" id="recTable"></div>
    <div class="note">Koordynator — wiadomość idzie na jego Telegram z karty koordynatora. Grupa — dodaj bota do grupy Telegram,
      napisz w niej cokolwiek, grupa pojawi się na liście poniżej. Bot w grupach nic nie odpowiada.
      Zakres: „Swoje obiekty” — z imionami ludzi; „Region” i „Cała firma” — liczby po obiektach.</div>
  </div>

  <div class="section">
    <div class="section-head">Grupy Telegram z botem <span class="cnt">${r.chats.length}</span></div>
    <div class="tblwrap">${r.chats.length ? `<table class="fl"><thead><tr><th class="l">Grupa</th><th class="l">Chat ID</th><th class="l">Stan</th><th></th></tr></thead><tbody>
      ${r.chats.map((c) => `<tr><td class="l">${esc(c.title || "—")}</td><td class="l">${esc(c.chat_id)}</td>
        <td class="l">${c.is_member ? `<span class="tag ok">bot w grupie</span>` : `<span class="tag rez">bot usunięty</span>`} <span class="sub">${esc(c.updated_at)}</span></td>
        <td>${c.is_member ? `<button class="btn btn-ghost btn-sm" data-c="${esc(c.chat_id)}" data-t="${esc(c.title || "")}" onclick="addGroup(this.dataset.c, this.dataset.t)">Dodaj jako odbiorcę</button>` : ""}</td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">Bot nie jest jeszcze w żadnej grupie.</div>`}</div>
  </div>`;
  renderRecipients();
}

function renderRecipients() {
  const r = ST.settings;
  const coordOpts = (sel) => `<option value="">— grupa / chat ID —</option>` +
    r.coordinators.map((c) => `<option value="${c.id}" ${c.id === sel ? "selected" : ""}>${esc(c.full_name)}${c.has_tg ? "" : " (bez Telegrama)"}</option>`).join("");
  const regOpts = (sel) => `<option value="">—</option>` + r.regions.map((g) => `<option value="${g.id}" ${g.id === sel ? "selected" : ""}>${esc(g.name)}</option>`).join("");
  const row = (x, i) => `<tr data-i="${i}">
    <td class="l"><select class="r_coord" style="max-width:190px">${coordOpts(x.coordinator_id)}</select>
      <div class="sub">${x.coordinator_id ? (x.has_tg === false ? `<span class="bad">brak Telegrama w karcie</span>` : "") : esc(x.chat_title || "")}</div></td>
    <td class="l"><input type="text" class="inp r_chat" value="${esc(x.chat_id || "")}" placeholder="chat ID" style="width:130px"/></td>
    <td class="l"><select class="r_scope">${Object.entries(SCOPE_PL).map(([k, v]) => `<option value="${k}" ${x.scope === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select class="r_region">${regOpts(x.region_id)}</select></td>
    <td class="chk"><input type="checkbox" class="r_daily" ${x.daily ? "checked" : ""}/></td>
    <td class="chk"><input type="checkbox" class="r_orders" ${x.orders ? "checked" : ""}/></td>
    <td class="chk"><input type="checkbox" class="r_weekly" ${x.weekly ? "checked" : ""}/></td>
    <td class="l"><select class="r_lang">${["uk", "ru", "pl"].map((l) => `<option ${x.lang === l ? "selected" : ""}>${l}</option>`).join("")}</select></td>
    <td class="chk"><input type="checkbox" class="r_active" ${x.is_active !== false ? "checked" : ""}/></td>
    <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="saveRecipient(${i})">Zapisz</button>
      ${x.id ? `<button class="btn btn-ghost btn-sm" onclick="testSend('daily', ${x.id})" title="Wyślij temu odbiorcy test podsumowania">🧪</button>
      <button class="btn btn-ghost btn-sm" onclick="delRecipient(${x.id})" title="Usuń">✕</button>` : ""}</td></tr>`;
  const list = r.recipients.concat(r._new ? [r._new] : []);
  document.getElementById("recTable").innerHTML = `<table class="fl"><thead><tr>
      <th class="l">Koordynator</th><th class="l">albo chat ID</th><th class="l">Zakres</th>
      <th title="Podsumowanie dzienne">Dzień</th><th title="Poniedziałek: kto nie wpisał planu naboru">Plan<br>naboru</th>
      <th title="Poniedziałek: plan–fakt poprzedniego tygodnia">Tydzień</th><th class="l">Język</th><th>Aktywny</th><th></th></tr></thead>
    <tbody>${list.map(row).join("")}</tbody></table>
    <div class="actions"><button class="btn btn-ghost btn-sm" onclick="newRecipient()">+ Odbiorca</button><span class="msg" id="recMsg"></span></div>`;
}
function newRecipient(chat, title) {
  ST.settings._new = { id: null, coordinator_id: null, chat_id: chat || "", chat_title: title || "", scope: "all", region_id: null,
    daily: true, orders: false, weekly: true, lang: "uk", is_active: true };
  renderRecipients();
}
function addGroup(chat, title) { newRecipient(chat, title); document.getElementById("recTable").scrollIntoView({ behavior: "smooth" }); }
async function saveRecipient(i) {
  const tr = document.querySelector(`#recTable tr[data-i="${i}"]`);
  const all = ST.settings.recipients.concat(ST.settings._new ? [ST.settings._new] : []);
  const x = all[i];
  const g = (c) => tr.querySelector(c);
  const body = {
    coordinator_id: g(".r_coord").value || null, chat_id: g(".r_chat").value.trim() || null,
    scope: g(".r_scope").value, region_id: g(".r_region").value || null,
    daily: g(".r_daily").checked, orders: g(".r_orders").checked, weekly: g(".r_weekly").checked,
    lang: g(".r_lang").value, is_active: g(".r_active").checked,
  };
  const res = x.id ? await api(`/recipients/${x.id}`, { method: "PATCH", body }) : await api("/recipients", { method: "POST", body });
  const msg = document.getElementById("recMsg");
  if (!res || !res.ok) { msg.className = "msg err"; msg.textContent = (res && res.error) || "Błąd"; return; }
  ST.settings._new = null;
  await loadSettings();
}
async function delRecipient(id) {
  const res = await api(`/recipients/${id}`, { method: "DELETE" });
  if (res && res.ok) loadSettings();
}
async function saveSettings() {
  const v = (id) => document.getElementById(id).value;
  const c = (id) => (document.getElementById(id).checked ? "1" : "0");
  const days = [...document.querySelectorAll(".sdays:checked")].map((x) => x.value).join(",");
  const msg = document.getElementById("setMsg");
  if (!days) { msg.className = "msg err"; msg.textContent = "Zaznacz co najmniej jeden dzień"; return; }
  const body = {
    enabled: c("s_enabled"), summary_time: v("s_summary_time"), summary_days: days, pre_import_min: v("s_pre_import_min") || "0",
    late_days: v("s_late_days"), auto_coords: c("s_auto_coords"), skip_empty: c("s_skip_empty"),
    orders_remind: v("s_orders_remind"), orders_deadline: v("s_orders_deadline"), monday_time: v("s_monday_time"),
  };
  const res = await api("/settings", { method: "PATCH", body });
  if (!res || !res.ok) { msg.className = "msg err"; msg.textContent = (res && res.error) || "Błąd"; return; }
  msg.className = "msg ok"; msg.textContent = "Zapisano";
}
async function testSend(kind, recipientId) {
  const msg = document.getElementById("testMsg");
  msg.className = "msg"; msg.textContent = "Wysyłanie…";
  const res = await api("/test", { method: "POST", body: { kind, recipient_id: recipientId || null } });
  if (!res || !res.ok) { msg.className = "msg err"; msg.textContent = (res && res.error) || "Błąd"; return; }
  msg.className = "msg ok"; msg.textContent = res.sent ? "Wysłano — sprawdź Telegram" : "Nie wysłano (brak Telegrama?)";
}
