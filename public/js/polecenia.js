// ══════════════════════════════════════════════════════════════════════
//  Sekcja «Poleć znajomego»: odpowiedzi nowych pracowników z bota,
//  zestawienie z bazą, premia za polecenie, ranking, źródła,
//  bezpieczeństwo (historia Telegram-ID), ustawienia, Excel.
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "list", me: null, from: null, to: null, preset: "60",
  list: null, sort: { key: "bhp", dir: -1 }, ranking: null, sources: null, security: null,
  item: null, seq: 0, iseq: 0,
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* prywatne okno */ } },
};

// ── Narzędzia ─────────────────────────────────────────────────────────
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
const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
function ts(x) {
  if (!x) return "";
  const d = new Date(x);
  if (isNaN(d)) return String(x);
  return d.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const xDate = (iso) => (iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : "");

async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch("/api/ref" + path, o);
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
  p.set("from", ST.from); p.set("to", ST.to);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== "") p.set(k, v); });
  return "?" + p.toString();
}

// ── Słowniki ──────────────────────────────────────────────────────────
const SRC = { friend: "znajomy", coord: "koordynator", recruit: "rekrutacja", other: "inne",
  facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", telegram: "Telegram", jobsite: "portal z ofertami" };
const SRC_CLS = { friend: "acc", coord: "warn", recruit: "", other: "" };
const ADS = ["facebook", "instagram", "tiktok", "telegram", "jobsite"];      // pilotaż: kanały reklamy
const START_Q = [["clarity5", "Warunki jasne 1–5"], ["recruit5", "Rekruter szybko 1–5"], ["housing_promise", "Mieszk. jak obiecano"], ["coord_start5", "Koord. 1–5"]];
const START_ST = { done: "wypełniona", sent: "w trakcie", expired: "bez odpowiedzi", failed: "nie doszła", planned: "w kolejce" };
const STATE = {
  answered: ["odpowiedział", "ok"],
  waiting: ["wysłano, czeka", "warn"],
  waiting_name: ["wybrał, bez imienia", "warn"],
  queued: ["do wysłania", ""],
  no_tg: ["nie wszedł do bota", "bad"],
  expired: ["brak odpowiedzi", "bad"],
  before: ["przed startem", ""],
};
const BONUS = {
  due: ["należy się", "fill-ok"],
  paid: ["wypłacona", "ok"],
  pending: ["w trakcie", "acc"],
  lost: ["odszedł przed terminem", "bad"],
  nomatch: ["bez zestawienia", "warn"],
  na: ["—", ""],
};
const FLAG = {
  coord_tg: (f) => [`⛔ próba z Telegrama koordynatora ×${f.n}`, "bad", "Ktoś próbował wypełnić anketę z Telegrama koordynatora — odpowiedź nie została przyjęta"],
  shared: (f) => [`👥 Telegram ${f.n} pracowników`, "bad", "Z Telegrama, z którego przyszła odpowiedź, logowało się kilku pracowników"],
  ref_chat: () => ["⚠️ Telegram polecającego", "bad", "Odpowiedź przyszła z Telegrama, z którego loguje się sam polecający"],
  self: () => ["polecił sam siebie", "bad", ""],
  multi_tg: (f) => [`📱 ${f.n} Telegramy`, "warn", "Pracownik logował się z kilku kont Telegram"],
  manual: () => ["✍️ wpisane ręcznie", "", "Odpowiedź wpisał administrator w panelu"],
};
const isSuspicious = (r) => (r.flags || []).some((f) => f.k !== "multi_tg" && f.k !== "manual");
const isTodo = (r) => r.state === "answered" && (r.source === "friend" || r.source === "coord") && (r.match_state || "none") === "none";
const tag = (txt, cls, title) => `<span class="tag ${cls || ""}"${title ? ` title="${esc(title)}"` : ""}>${esc(txt)}</span>`;

// ── Start ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", init);
async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  if (!me.ok || !me.has_access) {
    document.getElementById("toolbar").style.display = "none";
    document.querySelectorAll(".nav-item[data-view]").forEach((el) => (el.style.display = "none"));
    document.getElementById("content").innerHTML =
      `<div class="noaccess">🤝 Sekcja <b>Poleć znajomego</b> jest dostępna dla kierownictwa i koordynatorów regionalnych.<br>
       Koordynatorzy obiektów widzą ją, gdy administrator włączy to w ustawieniach sekcji.</div>`;
    return;
  }
  ST.me = me;
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
    const sv = store.get("sas_ref_region");
    if (sv && [...selR.options].some((o) => o.value === sv)) selR.value = sv;
  }
  if (me.sees_tg) { document.getElementById("navSecurity").style.display = ""; document.getElementById("fFlagBox").style.display = ""; }
  if (me.is_admin) document.getElementById("navSettings").style.display = "";
  setPreset(store.get("sas_ref_preset") || "60", true);
  renderBanner();
  const h = location.hash.replace("#", "");
  showView(["list", "ranking", "sources", "security", "settings"].includes(h) ? h : "list");
}

function renderBanner() {
  const me = ST.me, s = me.settings || {};
  const parts = [];
  if (s.enabled !== "1") parts.push(`<div class="banner warn">⏸️ Bot <b>nie pyta</b> nowych pracowników — sekcja wyłączona w ustawieniach. Dane poniżej to wcześniejsze odpowiedzi.</div>`);
  if (me.role === "coord") parts.push(`<div class="banner">👁️ Podgląd Twoich obiektów. Zestawienie z bazą i premie prowadzi koordynator regionalny / kierownictwo.</div>`);
  document.getElementById("topBanner").innerHTML = parts.join("");
}

// ── Okres (po dacie BHP) ──────────────────────────────────────────────
const PRESETS = [["30", "30 dni"], ["60", "60 dni"], ["90", "90 dni"], ["m0", "ten miesiąc"], ["m1", "poprzedni miesiąc"]];
function setPreset(p, silent) {
  const t = ST.me.today;
  const first = t.slice(0, 8) + "01";
  if (p === "m0") { ST.from = first; ST.to = t; }
  else if (p === "m1") { ST.to = addDays(first, -1); ST.from = ST.to.slice(0, 8) + "01"; }
  else if (/^\d+$/.test(p)) { ST.from = addDays(t, -Number(p)); ST.to = t; }
  ST.preset = p;
  store.set("sas_ref_preset", p);
  document.getElementById("dFrom").value = ST.from;
  document.getElementById("dTo").value = ST.to;
  renderPeriodChips();
  if (!silent) loadView();
}
function renderPeriodChips() {
  document.getElementById("periodChips").innerHTML = PRESETS.map(([k, l]) =>
    `<button class="chip${ST.preset === k ? " active" : ""}" onclick="setPreset('${k}')">${l}</button>`).join(" ");
}
function onPeriod() {
  const f = document.getElementById("dFrom").value, t = document.getElementById("dTo").value;
  if (!f || !t || f > t) return;
  ST.from = f; ST.to = t; ST.preset = "custom";
  renderPeriodChips();
  loadView();
}
function onFilter() {
  store.set("sas_ref_region", document.getElementById("selRegion").value);
  loadView();
}

function showView(v) {
  if (v === "settings" && !(ST.me && ST.me.is_admin)) v = "list";
  if (v === "security" && !(ST.me && ST.me.sees_tg)) v = "list";
  ST.view = v;
  location.hash = v;
  document.querySelectorAll(".fl-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent =
    { list: "Poleć znajomego — odpowiedzi", ranking: "Poleć znajomego — polecający", sources: "Poleć znajomego — źródła",
      security: "Poleć znajomego — bezpieczeństwo", settings: "Poleć znajomego — ustawienia" }[v];
  const noFilters = v === "settings" || v === "security";
  document.getElementById("toolbar").style.visibility = noFilters ? "hidden" : "";
  document.getElementById("periodBar").style.display = noFilters ? "none" : "";
  loadView();
}
function loadView() {
  if (ST.view === "list") loadList();
  if (ST.view === "ranking") loadRanking();
  if (ST.view === "sources") loadSources();
  if (ST.view === "security") loadSecurity();
  if (ST.view === "settings") loadSettings();
}

// ══════════════════════════════════════════════════════════════════════
//  Odpowiedzi
// ══════════════════════════════════════════════════════════════════════
async function loadList() {
  const my = ++ST.seq;
  document.getElementById("listTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/list" + qs());
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("listTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.list = r;
  renderList();
}
function filteredRows() {
  const all = (ST.list && ST.list.rows) || [];
  const q = document.getElementById("fQ").value.trim().toLowerCase();
  const src = document.getElementById("fSource").value;
  const mt = document.getElementById("fMatch").value;
  const bn = document.getElementById("fBonus").value;
  const fl = document.getElementById("fFlag").checked;
  let rows = all;
  if (q) rows = rows.filter((x) => [x.full_name, x.login, x.referrer_text, x.match && x.match.full_name, x.match && x.match.login,
    x.match_coordinator_name, x.facility_name, x.site_key].some((v) => String(v || "").toLowerCase().includes(q)));
  if (src === "none") rows = rows.filter((x) => x.state !== "answered");
  else if (src === "ads") rows = rows.filter((x) => x.state === "answered" && ADS.includes(x.source));
  else if (src) rows = rows.filter((x) => x.state === "answered" && x.source === src);
  if (mt === "todo") rows = rows.filter(isTodo);
  else if (mt) rows = rows.filter((x) => x.match_state === mt);
  if (bn) rows = rows.filter((x) => x.bonus.state === bn);
  if (fl) rows = rows.filter(isSuspicious);
  const k = ST.sort.key, d = ST.sort.dir;
  const val = (x) => ({
    bhp: x.bhp, full_name: x.full_name, site_key: x.site_key, state: x.state, source: x.state === "answered" ? x.source : "~",
    referrer: x.referrer_text || "~", match: (x.match && x.match.full_name) || x.match_coordinator_name || "~",
    bonus: ["due", "pending", "paid", "lost", "nomatch", "na"].indexOf(x.bonus.state) + "", flags: String((x.flags || []).length).padStart(2, "0"),
  })[k] || "";
  return rows.slice().sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * d || (a.full_name || "").localeCompare(b.full_name || ""));
}
function sortBy(k) {
  if (ST.sort.key === k) ST.sort.dir *= -1; else { ST.sort.key = k; ST.sort.dir = k === "bhp" || k === "flags" ? -1 : 1; }
  renderList();
}
function clearFilters() {
  ["fQ", "fSource", "fMatch", "fBonus"].forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("fFlag").checked = false;
  renderList();
}
function quick(kind) {
  clearFilters();
  if (kind === "todo") document.getElementById("fMatch").value = "todo";
  if (kind === "due") document.getElementById("fBonus").value = "due";
  if (kind === "flag") document.getElementById("fFlag").checked = true;
  if (kind === "none") document.getElementById("fSource").value = "none";
  if (SRC[kind] || kind === "ads") document.getElementById("fSource").value = kind;
  renderList();
}

function renderKpis() {
  const all = ST.list.rows;
  const counted = all.filter((x) => x.state !== "before");
  const ans = all.filter((x) => x.state === "answered");
  const bySrc = (s) => ans.filter((x) => x.source === s).length;
  const wait = all.filter((x) => ["waiting", "waiting_name", "queued"].includes(x.state)).length;
  const noTg = all.filter((x) => x.state === "no_tg").length;
  const todo = all.filter(isTodo).length;
  const due = all.filter((x) => x.bonus.state === "due").length;
  const paid = all.filter((x) => x.bonus.state === "paid").length;
  const pend = all.filter((x) => x.bonus.state === "pending").length;
  const susp = all.filter(isSuspicious).length;
  const N = ST.me.settings.bonus_days;
  const k = (l, v, s, click, cls) => `<div class="kpi${click ? " click" : ""}"${click ? ` onclick="quick('${click}')"` : ""}>
    <div class="l">${l}</div><div class="v ${cls || ""}">${v}</div><div class="s">${s || ""}</div></div>`;
  document.getElementById("listKpis").innerHTML = [
    k("Nowi pracownicy", all.length, `${noTg ? `nie weszło do bota: ${noTg}` : "wszyscy w bocie"}`),
    k("Odpowiedzieli", `${ans.length} <small>${pct(ans.length, counted.length)}</small>`, wait ? `czeka na odpowiedź: ${wait}` : "", "none"),
    k("👥 Znajomy", bySrc("friend"), pct(bySrc("friend"), ans.length) + " odpowiedzi", "friend"),
    k("🧑‍💼 Koordynator", bySrc("coord"), pct(bySrc("coord"), ans.length) + " odpowiedzi", "coord"),
    k("📢 Rekrutacja, reklama, inne", ans.length - bySrc("friend") - bySrc("coord"),
      `rekrutacja ${bySrc("recruit")}${ans.some((x) => ADS.includes(x.source)) ? ` · reklama ${ans.filter((x) => ADS.includes(x.source)).length}` : ""} · inne ${bySrc("other")}`, "recruit"),
    k("Do zestawienia", todo, ST.me.can_match ? "porównaj wpisane imię z bazą" : "czeka na regionalnego", "todo", todo ? "warn" : ""),
    k("💰 Do wypłaty", due, `premia po ${N} dniach · w trakcie ${pend} · wypłacono ${paid}`, "due", due ? "good" : ""),
    ST.me.sees_tg ? k("🛡️ Podejrzane", susp, "Telegram koordynatora / wspólny / polecającego", "flag", susp ? "bad" : "") : "",
  ].join("");
  document.getElementById("badgeTodo").textContent = ST.me.can_match && todo ? todo : "";
  document.getElementById("badgeDue").textContent = due || "";
}

function stateCell(x) {
  const [l, c] = STATE[x.state] || [x.state, ""];
  const sub = [];
  if (x.sends) sub.push(`wysł. ${x.sends}×`);
  if (x.state === "answered" && x.answered_at) sub.push(ts(x.answered_at));
  else if (["waiting", "waiting_name", "queued", "no_tg"].includes(x.state)) sub.push(`termin ${dd(x.deadline)}`);
  return `${tag(l, c)}${sub.length ? `<div class="sub">${esc(sub.join(" · "))}</div>` : ""}`;
}
function srcCell(x) {
  if (x.state === "answered" && x.source) {
    return `${tag(SRC[x.source], SRC_CLS[x.source])}${x.referrer_text ? `<div class="typed">„${esc(x.referrer_text)}”</div>` : ""}`;
  }
  if (x.state === "waiting_name" && x.source) return `${tag(SRC[x.source], "")} <span class="z">imię nie wpisane</span>`;
  return `<span class="z">—</span>`;
}
function matchCell(x) {
  if (x.state !== "answered" || !(x.source === "friend" || x.source === "coord")) return `<span class="z">—</span>`;
  if (x.match_state === "confirmed") {
    if (x.match) return `✓ ${esc(x.match.full_name)}<div class="sub">${esc(x.match.login || "")} · ${esc(x.match.site_key || "")}${x.match.working === false ? ` · <span class="bad">nie pracuje</span>` : ""}</div>`;
    if (x.match_coordinator_name) return `✓ ${esc(x.match_coordinator_name)}<div class="sub">koordynator</div>`;
  }
  if (x.match_state === "not_found") return tag("nie ma w bazie", "bad");
  return tag("do zestawienia", "warn");
}
function bonusCell(x) {
  const b = x.bonus;
  if (b.state === "na") return `<span class="z">—</span>`;
  const [l, c] = BONUS[b.state];
  let sub = "";
  const N = ST.me.settings.bonus_days;
  if (b.state === "pending") sub = `${b.days}/${N} dni · od ${dd(b.due_date)}`;
  else if (b.state === "due") sub = `${b.days} dni · od ${dd(b.due_date)}`;
  else if (b.state === "paid") sub = `${ddy(x.bonus_paid_at)}${x.bonus_note ? " · " + x.bonus_note : ""}`;
  else if (b.state === "lost") sub = `przepracował ${b.days} dni`;
  else if (b.state === "nomatch") sub = x.match_state === "not_found" ? "polecający nie znaleziony" : "najpierw zestaw";
  return `${tag(l, c)}${sub ? `<div class="sub">${esc(sub)}</div>` : ""}`;
}
function flagsCell(x) {
  if (!x.flags || !x.flags.length) return "";
  return x.flags.map((f) => { const [l, c, t] = FLAG[f.k] ? FLAG[f.k](f) : [f.k, ""]; return tag(l, c, t); }).join(" ");
}

function renderList() {
  if (!ST.list) return;
  renderKpis();
  const rows = filteredRows();
  const all = ST.list.rows;
  document.getElementById("listCnt").textContent = rows.length === all.length ? `${all.length}` : `${rows.length} z ${all.length}`;
  const tg = ST.me.sees_tg;
  const th = (k, l, cls) => `<th class="${cls || ""}" data-k="${k}" onclick="sortBy('${k}')">${l}${ST.sort.key === k ? (ST.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  if (!rows.length) {
    document.getElementById("listTable").innerHTML = `<div class="empty">${all.length ? "Nic nie pasuje do filtrów." : "Brak nowych pracowników z BHP w tym okresie."}</div>`;
  } else {
    document.getElementById("listTable").innerHTML = `<table class="fl"><thead><tr>
      ${th("bhp", "BHP", "l")}${th("full_name", "Pracownik", "l")}${th("site_key", "Obiekt", "l")}${th("state", "Ankieta", "l")}
      ${th("source", "Kto polecił", "l")}${th("match", "Zestawiono z", "l")}${th("bonus", "Premia", "l")}${tg ? th("flags", "Uwagi", "l") : ""}
      </tr></thead><tbody>
      ${rows.map((x) => `<tr class="rowlink${isSuspicious(x) ? " hl" : ""}" data-w="${x.worker_id}" data-b="${x.bhp}" onclick="openItem(Number(this.dataset.w), this.dataset.b)">
        <td class="l">${ddy(x.bhp)}</td>
        <td class="l">${esc(x.full_name)}<div class="sub">${esc(x.login)}</div></td>
        <td class="l">${esc(x.site_key)}<div class="sub">${x.coordinator_name ? esc(x.coordinator_name) : "— bez koordynatora —"}</div></td>
        <td class="l">${stateCell(x)}</td>
        <td class="l">${srcCell(x)}</td>
        <td class="l">${matchCell(x)}</td>
        <td class="l">${bonusCell(x)}</td>
        ${tg ? `<td class="l">${flagsCell(x)}</td>` : ""}
      </tr>`).join("")}</tbody></table>`;
  }
  const s = ST.me.settings;
  document.getElementById("listNote").innerHTML =
    `Nowy pracownik = pierwszy okres w firmie albo powrót po przerwie dłuższej niż 14 dni (przeniesienia między obiektami się nie liczą).
     Odpowiedzieć można do <b>BHP + ${esc(s.window_days)} dni</b>, potem bot nie przyjmuje odpowiedzi.
     Premia za znajomego należy się, gdy nowy przepracował <b>${esc(s.bonus_days)} dni</b> od BHP${s.bonus_amount ? ` — <b>${esc(s.bonus_amount)} zł</b>` : ""}.
     Kliknij wiersz — szczegóły, zestawienie z bazą${ST.me.sees_tg ? ", historia Telegrama" : ""}.`;
}

// ── Karta (szuflada) ─────────────────────────────────────────────────
async function openItem(wid, bhp) {
  const dw = document.getElementById("drawer");
  dw.innerHTML = `<div class="dw-head"><div><h2>Ładowanie…</h2></div><button class="dw-close" onclick="closeDrawer()">✕</button></div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  const my = ++ST.iseq;
  const r = await api(`/item?worker_id=${wid}&bhp=${bhp}`);
  if (my !== ST.iseq || !r) return;
  if (!r.ok) { dw.querySelector(".dw-head h2").textContent = r.error || "Błąd"; return; }
  ST.item = r;
  renderItem();
}
function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
  ST.item = null;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

function renderItem() {
  const { row: x, suggestions, tg } = ST.item;
  const me = ST.me;
  const N = me.settings.bonus_days;
  const named = x.state === "answered" && (x.source === "friend" || x.source === "coord");
  let h = `<div class="dw-head"><div>
      <h2>${esc(x.full_name)}</h2>
      <div class="sub">${esc(x.login)} · BHP ${ddy(x.bhp)} · ${esc(x.facility_name || x.site_key)}${x.coordinator_name ? " · " + esc(x.coordinator_name) : ""}</div>
    </div><button class="dw-close" onclick="closeDrawer()">✕</button></div><div class="dw-body">`;

  // Ankieta
  h += `<div class="section"><div class="section-head">📝 Ankieta</div><div class="kv">
    <span class="k">Stan</span><span>${stateCell(x)}</span>
    <span class="k">Odpowiedź</span><span>${x.state === "answered" ? `${tag(SRC[x.source], SRC_CLS[x.source])} ${x.referrer_text ? `<span class="typed">„${esc(x.referrer_text)}”</span>` : ""}` : `<span class="z">—</span>`}</span>
    <span class="k">Termin odpowiedzi</span><span>${ddy(x.deadline)} (BHP + ${esc(me.settings.window_days)} dni)</span>
    <span class="k">Wysłano</span><span>${x.sends ? `${x.sends}× · pierwsze ${ts(x.first_sent_at)} · ostatnie ${ts(x.last_sent_at)}` : `<span class="z">jeszcze nie</span>`}</span>
    ${x.manual_by ? `<span class="k">Wpisane ręcznie</span><span>${esc(x.manual_by_name || "")}</span>` : ""}
    ${x.flags && x.flags.length ? `<span class="k">Uwagi</span><span>${flagsCell(x)}</span>` : ""}
  </div></div>`;

  // Ankieta startowa (pilotaż)
  if (x.start || x.ext) {
    const sv = x.start;
    h += `<div class="section"><div class="section-head">📝 Ankieta startowa <span class="cnt">pilotaż · ${sv ? esc(START_ST[sv.status] || sv.status) : "jeszcze nie wysłana"}</span></div>`;
    if (sv && sv.answers.length) {
      h += `<div class="kv kv2">${sv.answers.map((a) => `<span class="k">${esc(a.q)}${a.mgr ? " 🔒" : ""}</span>
        <span class="${a.f === "high" ? "bad" : a.f === "low" ? "warn" : ""}"><b>${esc(a.a)}</b></span>`).join("")}</div>`;
    } else {
      h += `<div class="note" style="border-top:none">${sv ? "Brak odpowiedzi." : "Pytania 2–5 przychodzą zaraz po odpowiedzi na pierwsze pytanie."}</div>`;
    }
    if (sv && sv.hidden) h += `<div class="note">🔒 Ocena koordynatora ukryta — widzą ją tylko regionalni i kierownictwo.</div>`;
    h += `</div>`;
  }

  // Zestawienie
  if (named) {
    const isCoord = x.source === "coord";
    h += `<div class="section"><div class="section-head">🔗 Zestawienie z bazą <span class="cnt">wpisane: „${esc(x.referrer_text || "")}”</span></div>`;
    if (x.match_state === "confirmed") {
      const m = x.match;
      h += `<div class="cand cur"><span class="nm">✓ <b>${esc(m ? m.full_name : x.match_coordinator_name)}</b>
        <div class="sub">${m ? `${esc(m.login || "")} · ${esc(m.site_key || "")} · ${m.working ? `<span class="good">pracuje</span>` : `<span class="bad">nie pracuje${m.lwd ? " od " + ddy(m.lwd) : ""}</span>`}` : "koordynator"}
        · potwierdził ${esc(x.match_by_name || "")} ${ts(x.match_at)}</div></span></div>`;
    } else if (x.match_state === "not_found") {
      h += `<div class="cand"><span class="nm">${tag("nie ma w bazie", "bad")} <span class="sub">oznaczył ${esc(x.match_by_name || "")} ${ts(x.match_at)}</span></span></div>`;
    }
    if (me.can_match) {
      if (x.bonus_paid_at) {
        h += `<div class="note">Premia już wypłacona — żeby zmienić zestawienie, najpierw cofnij wypłatę.</div>`;
      } else {
        h += suggestions.length
          ? `<div class="note" style="border-top:none">Podobne ${isCoord ? "nazwiska koordynatorów" : "osoby z bazy (pracujące w ostatnim roku)"}:</div>` +
            suggestions.map((s) => candRow(s, x)).join("")
          : `<div class="note" style="border-top:none">Brak podobnych ${isCoord ? "koordynatorów" : "osób w bazie"} — wyszukaj ręcznie albo oznacz „nie ma w bazie”.</div>`;
        h += `<div class="row-in"><input type="text" class="inp" id="mSearch" placeholder="Szukaj ${isCoord ? "koordynatora" : "pracownika: nazwisko albo login"}…" style="flex:1;min-width:200px" oninput="searchMatch()" />
          <button class="btn btn-ghost btn-sm" onclick="doMatch({state:'not_found'})">Nie ma w bazie</button>
          ${x.match_state !== "none" ? `<button class="btn btn-ghost btn-sm" onclick="doMatch({state:'reset'})">Cofnij</button>` : ""}
          <span class="msg" id="mMsg"></span></div><div id="mResults"></div>`;
      }
    } else if (x.match_state === "none") {
      h += `<div class="note" style="border-top:none">Czeka na zestawienie przez koordynatora regionalnego.</div>`;
    }
    h += `</div>`;
  }

  // Premia
  if (x.state === "answered" && x.source === "friend") {
    const b = x.bonus;
    const [bl, bc] = BONUS[b.state];
    h += `<div class="section"><div class="section-head">💰 Premia za polecenie ${tag(bl, bc)}</div><div class="kv">
      <span class="k">Warunek</span><span>nowy przepracuje ${N} dni od BHP — od ${ddy(b.due_date)}</span>
      <span class="k">Przepracował</span><span>${b.days} dni${b.left ? ` · <span class="bad">zakończył pracę</span>` : ""}${x.emp_end === undefined ? ` · <span class="bad">okresu już nie ma w grafiku</span>` : ""}</span>
      <span class="k">Dla kogo</span><span>${x.match ? `${esc(x.match.full_name)} (${esc(x.match.login || "")})${x.match.working === false ? ` · <span class="bad">polecający już nie pracuje</span>` : ""}` : `<span class="z">najpierw zestaw polecającego</span>`}</span>
      ${me.settings.bonus_amount ? `<span class="k">Kwota</span><span>${esc(me.settings.bonus_amount)} zł</span>` : ""}
      ${x.bonus_paid_at ? `<span class="k">Wypłacono</span><span>${ddy(x.bonus_paid_at)}${x.bonus_note ? " · " + esc(x.bonus_note) : ""}</span>` : ""}
    </div>`;
    if (me.can_pay && (b.state === "due" || b.state === "paid")) {
      h += b.state === "due"
        ? `<div class="row-in"><span style="font-size:11px;color:var(--text2)">Data wypłaty</span><input type="date" id="pDate" value="${me.today}" />
           <input type="text" class="inp" id="pNote" placeholder="notatka (np. lista płac 10.2026)" style="flex:1;min-width:160px" />
           <button class="btn btn-primary btn-sm" onclick="doPaid(true)">Oznacz jako wypłaconą</button><span class="msg" id="pMsg"></span></div>`
        : `<div class="row-in"><button class="btn btn-ghost btn-sm" onclick="doPaid(false)">Cofnij wypłatę</button><span class="msg" id="pMsg"></span></div>`;
    }
    h += `</div>`;
  }

  // Telegram
  if (tg) {
    const refChats = new Set(tg.referrer_chats || []);
    h += `<div class="section"><div class="section-head">📱 Historia Telegrama <span class="cnt">z jakich kont logowano się pod ID ${esc(x.login)}</span></div>`;
    h += tg.chats.length ? `<div class="tblwrap"><table class="fl"><thead><tr>
        <th class="l">Telegram</th><th class="l">Pierwszy / ostatni raz</th><th>Logowań</th><th class="l">Uwagi</th></tr></thead><tbody>
        ${tg.chats.map((c) => {
          const notes = [];
          if (c.coordinator_name) notes.push(tag(`⛔ Telegram koordynatora: ${c.coordinator_name}`, "bad"));
          if (tg.answered_chat_id && c.chat_id === tg.answered_chat_id) notes.push(tag("odpowiedź z tego konta", "acc"));
          if (refChats.has(c.chat_id)) notes.push(tag("⚠️ loguje się tu też polecający", "bad"));
          if (c.blocked) notes.push(tag(`zablokowano ×${c.blocked}`, "bad"));
          if ((c.others && c.others.length) || c.others_hidden) notes.push(`<div class="sub">też: ${(c.others || []).map((o) => esc(o.full_name) + " (" + esc(o.login) + ")").join(", ")}${c.others_hidden ? `${c.others && c.others.length ? ", " : ""}+${c.others_hidden} z innych regionów` : ""}</div>`);
          return `<tr class="${c.coordinator_name || refChats.has(c.chat_id) ? "hl" : ""}">
            <td class="l">${esc(c.chat_id)}<div class="sub">${c.tg_username ? "@" + esc(c.tg_username) + " · " : ""}${esc(c.tg_name || "")}</div></td>
            <td class="l">${esc(c.first_at)}<div class="sub">${esc(c.last_at)}</div></td>
            <td>${c.logins}</td><td class="l">${notes.join(" ")}</td></tr>`;
        }).join("")}</tbody></table></div>`
      : `<div class="empty">Brak zapisów — pracownik nie logował się do bota od uruchomienia historii.</div>`;
    if (tg.blocked.length) {
      h += `<div class="note"><b>Zablokowane próby odpowiedzi:</b> ${tg.blocked.map((b) => `${esc(b.at)} — ${esc(b.coordinator_name || b.chat_id)}`).join("; ")}</div>`;
    }
    h += `</div>`;
  }

  // Ręcznie (admin)
  if (me.is_admin) {
    h += `<div class="section"><div class="section-head">✍️ Wpisz ręcznie <span class="cnt">np. pracownik bez Telegrama — oznaczone w tabeli jako „wpisane ręcznie”</span></div>
      <div class="row-in" style="border-top:none">
        <select class="inp" id="manSrc" onchange="document.getElementById('manText').style.display = ['friend','coord'].includes(this.value) ? '' : 'none'">
          ${Object.entries(SRC).filter(([k]) => x.ext || !ADS.includes(k)).map(([k, l]) => `<option value="${k}" ${x.source === k ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input type="text" class="inp" id="manText" placeholder="imię i nazwisko" value="${esc(x.referrer_text || "")}" style="flex:1;min-width:180px;${["friend", "coord"].includes(x.source || "friend") ? "" : "display:none"}" />
        <button class="btn btn-ghost btn-sm" onclick="doManual()">Zapisz</button><span class="msg" id="manMsg"></span>
      </div></div>`;
  }
  h += `</div>`;
  document.getElementById("drawer").innerHTML = h;
}
function candRow(s, x) {
  const pc = Math.round((s.score || 0) * 100) + "%";
  const body = s.kind === "coord"
    ? `<b>${esc(s.full_name)}</b><div class="sub">koordynator</div>`
    : `<b>${esc(s.full_name)}</b><div class="sub">${esc(s.login || "")} · ${esc(s.site_key || "")}${s.last_work_date ? ` · <span class="bad">ostatni dzień ${ddy(s.last_work_date)}</span>` : ` · <span class="good">pracuje</span>`}${s.site_key && s.site_key === x.site_key ? " · ten sam obiekt" : ""}</div>`;
  const cur = (s.kind === "coord" ? x.match_coordinator_id : x.match_worker_id) === s.id;
  const arg = s.kind === "coord" ? `{match_coordinator_id:${s.id}}` : `{match_worker_id:${s.id}}`;
  return `<div class="cand${cur ? " cur" : ""}"><span class="sc">${pc}</span><span class="nm">${body}</span>
    ${cur ? tag("wybrane", "ok") : `<button class="btn btn-ghost btn-sm" onclick="doMatch(${arg})">To ten</button>`}</div>`;
}
let searchT = null;
function searchMatch() {
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = document.getElementById("mSearch").value.trim();
    const box = document.getElementById("mResults");
    if (q.length < 2) { box.innerHTML = ""; return; }
    const x = ST.item.row;
    const r = await api(`/search?kind=${x.source === "coord" ? "coord" : "worker"}&q=${encodeURIComponent(q)}`);
    if (!r || !r.ok) { box.innerHTML = `<div class="error">${esc((r && r.error) || "Błąd")}</div>`; return; }
    box.innerHTML = r.rows.length ? r.rows.filter((s) => s.id !== x.worker_id).map((s) => candRow(s, x)).join("") : `<div class="empty">Nic nie znaleziono</div>`;
  }, 250);
}
async function afterAction(r, msgId) {
  if (!r || !r.ok) { const m = document.getElementById(msgId); if (m) { m.className = "msg err"; m.textContent = (r && r.error) || "Błąd"; } return; }
  const x = ST.item.row;
  await openItem(x.worker_id, x.bhp);
  if (ST.list) {
    const i = ST.list.rows.findIndex((y) => y.worker_id === x.worker_id && y.bhp === x.bhp);
    if (i >= 0 && r.row) { ST.list.rows[i] = r.row; renderList(); } else loadList();
  }
}
async function doMatch(body) {
  const x = ST.item.row;
  afterAction(await api("/match", { method: "POST", body: { worker_id: x.worker_id, bhp: x.bhp, ...body } }), "mMsg");
}
async function doPaid(paid) {
  const x = ST.item.row;
  const body = { worker_id: x.worker_id, bhp: x.bhp, paid };
  if (paid) { body.date = document.getElementById("pDate").value; body.note = document.getElementById("pNote").value.trim(); }
  afterAction(await api("/paid", { method: "POST", body }), "pMsg");
}
async function doManual() {
  const x = ST.item.row;
  const body = { worker_id: x.worker_id, bhp: x.bhp, source: document.getElementById("manSrc").value, text: document.getElementById("manText").value.trim() };
  afterAction(await api("/manual", { method: "POST", body }), "manMsg");
}

// ══════════════════════════════════════════════════════════════════════
//  Polecający
// ══════════════════════════════════════════════════════════════════════
async function loadRanking() {
  const my = ++ST.seq;
  document.getElementById("rankTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/ranking" + qs());
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("rankTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.ranking = r;
  const N = ST.me.settings.bonus_days;
  document.getElementById("rankCnt").textContent = r.rows.length ? `${r.rows.length} osób` : "";
  document.getElementById("rankTable").innerHTML = !r.rows.length
    ? `<div class="empty">W tym okresie nikt nie został zestawiony jako polecający.</div>`
    : `<table class="fl"><thead><tr><th class="l">#</th><th class="l">Polecający</th><th class="l">Obiekt</th>
        <th>Przyprowadził</th><th>Nadal pracują</th><th>${N} dni</th><th>Premia należy się</th><th>Wypłacono</th><th>Odeszli przed</th><th class="l">Kogo</th></tr></thead><tbody>
      ${r.rows.map((x, i) => `<tr>
        <td class="l">${i + 1}</td>
        <td class="l">${esc(x.referrer.full_name)}<div class="sub">${esc(x.referrer.login || "")}${x.referrer.working === false ? ` · <span class="bad">nie pracuje</span>` : ""}</div></td>
        <td class="l">${esc(x.referrer.site_key || "")}</td>
        <td><b>${x.brought}</b></td><td>${x.working}</td><td>${x.reached}</td>
        <td>${x.due ? `<span class="good"><b>${x.due}</b></span>` : `<span class="z">0</span>`}</td>
        <td>${x.paid || `<span class="z">0</span>`}</td><td>${x.lost ? `<span class="bad">${x.lost}</span>` : `<span class="z">0</span>`}</td>
        <td class="l"><details class="ppl"><summary>${x.people.length} os.</summary>${x.people.map((p) =>
          `<div>${esc(p.full_name)} · BHP ${dd(p.bhp)} · ${esc(p.site_key || "")} · ${esc(BONUS[p.bonus] ? BONUS[p.bonus][0] : p.bonus)} (${p.days} dni)</div>`).join("")}</details></td>
      </tr>`).join("")}</tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════
//  Źródła
// ══════════════════════════════════════════════════════════════════════
async function loadSources() {
  const my = ++ST.seq;
  document.getElementById("srcTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/sources" + qs());
  if (my !== ST.seq || !r) return;
  if (!r.ok) { document.getElementById("srcTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.sources = r;
  const N = r.bonus_days;
  const ret = (x, s) => { const e = x.ret[s]; return e && e.n ? `<span class="${e.ok / e.n >= 0.7 ? "good" : e.ok / e.n >= 0.4 ? "warn" : "bad"}">${pct(e.ok, e.n)}</span><div class="sub">${e.ok}/${e.n}</div>` : `<span class="z">—</span>`; };
  const n = (v) => (v ? v : `<span class="z">0</span>`);
  const ads = r.total.ads > 0;              // kolumna „Reklama” — gdy jest pilotaż
  const line = (x, tot) => `<tr class="${tot ? "tot" : ""}">
      <td class="l">${esc(x.site_key)}${!tot ? `<div class="sub">${esc(x.coordinator_name || "— bez koordynatora —")}${x.region_name ? " · " + esc(x.region_name) : ""}</div>` : ""}</td>
      <td>${x.hires}</td><td>${pct(x.answered, x.hires)}</td>
      <td class="sep">${n(x.friend)}</td><td>${n(x.coord)}</td><td>${n(x.recruit)}</td>${ads ? `<td>${n(x.ads)}</td>` : ""}<td>${n(x.other)}</td><td>${n(x.none)}</td>
      <td class="sep">${ret(x, "friend")}</td><td>${ret(x, "coord")}</td><td>${ret(x, "recruit")}</td>${ads ? `<td>${ret(x, "ads")}</td>` : ""}<td>${ret(x, "none")}</td></tr>`;
  document.getElementById("srcCnt").textContent = r.rows.length ? `${r.rows.length} obiektów` : "";
  document.getElementById("srcTable").innerHTML = !r.rows.length ? `<div class="empty">Brak nowych pracowników w tym okresie.</div>` :
    `<table class="fl"><thead><tr><th class="l" rowspan="2">Obiekt</th><th rowspan="2">Nowi</th><th rowspan="2">Odpowiedzi</th>
        <th class="sep" colspan="${ads ? 6 : 5}" style="text-align:center">Kto przyprowadził</th><th class="sep" colspan="${ads ? 5 : 4}" style="text-align:center">Przepracowało ${N} dni</th></tr>
      <tr><th class="sep">Znajomy</th><th>Koord.</th><th>Rekrut.</th>${ads ? `<th title="Facebook, Instagram, TikTok, Telegram, portale">Reklama</th>` : ""}<th>Inne</th><th>Brak odp.</th>
        <th class="sep">Znajomy</th><th>Koord.</th><th>Rekrut.</th>${ads ? `<th>Reklama</th>` : ""}<th>Brak odp.</th></tr></thead>
      <tbody>${r.rows.map((x) => line(x)).join("")}${line(r.total, true)}</tbody></table>`;
  document.getElementById("srcNote").innerHTML = `„Przepracowało ${N} dni” — tylko wśród tych, od których BHP minęło już ${N} dni. Pokazuje, z jakiego źródła ludzie zostają dłużej.`;
}

// ══════════════════════════════════════════════════════════════════════
//  Bezpieczeństwo
// ══════════════════════════════════════════════════════════════════════
async function loadSecurity() {
  const body = document.getElementById("secBody");
  body.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/security");
  if (!r) return;
  if (!r.ok) { body.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.security = r;
  const who = (x) => `${esc(x.full_name)}<div class="sub">${esc(x.login)}</div>`;
  const sec = (title, cnt, inner, note) => `<div class="section"><div class="section-head">${title} <span class="cnt">${cnt}</span></div>
    ${inner}${note ? `<div class="note">${note}</div>` : ""}</div>`;
  const tbl = (head, rows) => rows.length ? `<div class="tblwrap"><table class="fl"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<div class="empty">Brak — w porządku.</div>`;
  body.innerHTML = `
    <div class="banner">Każde wejście do bota pod ID pracownika zapisuje się z kontem Telegram (ID, @username, imię).
      Z Telegrama przypisanego do koordynatora (karta koordynatora) bot <b>nie pokazuje ankiety i nie przyjmuje odpowiedzi</b>.
      Jeśli koordynator użyje drugiego, nieprzypisanego konta — zobaczysz to w sekcji „Jeden Telegram — kilku pracowników”.</div>
    ${sec("⛔ Zablokowane próby odpowiedzi z Telegrama koordynatora", r.blocked.length,
      tbl(`<th class="l">Kiedy</th><th class="l">Pracownik</th><th class="l">BHP</th><th class="l">Koordynator</th><th class="l">Telegram</th>`,
        r.blocked.map((x) => `<tr class="rowlink" onclick="openItem(${x.worker_id}, '${esc(x.bhp || "")}')"><td class="l">${esc(x.at)}</td><td class="l">${who(x)}</td><td class="l">${ddy(x.bhp)}</td><td class="l">${esc(x.coordinator_name || "")}</td><td class="l">${esc(x.chat_id)}</td></tr>`)))}
    ${sec("🔑 Koordynator zalogował się pod ID pracownika", r.coord_logins.length,
      tbl(`<th class="l">Ostatnio</th><th class="l">Pod ID pracownika</th><th class="l">Koordynator</th><th>Razy</th>`,
        r.coord_logins.map((x) => `<tr><td class="l">${esc(x.at)}</td><td class="l">${who(x)}</td><td class="l">${esc(x.coordinator_name)}</td><td>${x.n}</td></tr>`)),
      "Samo zalogowanie nie jest błędem (np. pomoc przy godzinach), ale ankieta w tym czasie jest zablokowana.")}
    ${sec("👥 Jeden Telegram — kilku pracowników", r.shared.length,
      tbl(`<th class="l">Telegram</th><th>Pracowników</th><th class="l">Kto</th><th class="l">Ostatnio</th>`,
        r.shared.map((x) => `<tr class="${x.coordinator_name ? "hl" : ""}"><td class="l">${esc(x.chat_id)}${x.coordinator_name ? `<div class="sub bad">Telegram koordynatora: ${esc(x.coordinator_name)}</div>` : ""}</td><td>${x.workers}</td>
          <td class="l">${(x.list || []).map((w) => `${esc(w.full_name)} <span class="z">${esc(w.login)}</span>`).join("<br>")}${x.hidden ? `<div class="sub">+${x.hidden} z innych regionów</div>` : ""}</td><td class="l">${esc(x.last_at)}</td></tr>`)),
      "Rodzina na jednym telefonie to normalne. Podejrzane — gdy jedno konto wypełnia ankiety kilku nowych albo należy do polecającego.")}
    ${sec("⚠️ Odpowiedź z Telegrama polecającego", r.ref_chat.length,
      tbl(`<th class="l">Nowy pracownik</th><th class="l">BHP</th><th class="l">Polecający</th><th class="l">Telegram</th>`,
        r.ref_chat.map((x) => `<tr class="rowlink" onclick="openItem(${x.worker_id}, '${esc(x.bhp)}')"><td class="l">${who(x)}</td><td class="l">${ddy(x.bhp)}</td><td class="l">${esc(x.ref_name)}<div class="sub">${esc(x.ref_login)}</div></td><td class="l">${esc(x.chat_id)}</td></tr>`)),
      "Nowy pracownik „polecił” osobę, która sama loguje się z tego samego konta Telegram — sprawdź przed wypłatą premii.")}
    ${r.coords_no_tg && r.coords_no_tg.length ? sec("📵 Koordynatorzy bez Telegrama w karcie", r.coords_no_tg.length,
      `<div class="note" style="border-top:none">${r.coords_no_tg.map((c) => esc(c.full_name)).join(", ")}</div>`,
      "Bot rozpoznaje koordynatora po Telegramie z jego karty. Bez niego blokada nie działa — uzupełnij Telegram w karcie koordynatora (Admin panel).") : ""}`;
}

// ══════════════════════════════════════════════════════════════════════
//  Ustawienia (admin)
// ══════════════════════════════════════════════════════════════════════
async function loadSettings() {
  const body = document.getElementById("settingsBody");
  body.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/settings");
  if (!r) return;
  if (!r.ok) { body.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  const S = r.settings;
  body.innerHTML = `
  <div class="section">
    <div class="section-head">Ankieta w bocie i dostęp</div>
    <div class="cfg">
      <span class="k">Ankieta włączona</span><span><label><input type="checkbox" id="s_enabled" ${S.enabled === "1" ? "checked" : ""}/> bot pyta nowych pracowników „kto Cię polecił?”</label></span>
      <span class="h">Wyłączone — bot nie wysyła pytań ani przypomnień. Historia Telegrama zapisuje się dalej, panel działa.</span>
      <span class="k">Widoczne dla koordynatorów</span><span><label><input type="checkbox" id="s_visible_coords" ${S.visible_coords === "1" ? "checked" : ""}/> koordynatorzy obiektów widzą sekcję</label></span>
      <span class="h">Tylko swoje obiekty i tylko podgląd: bez zestawiania, bez premii, bez danych Telegrama. Regionalni i kierownictwo widzą sekcję zawsze.</span>
      <span class="k">Pytać pracowników z BHP od</span><span><input type="date" id="s_start_date" value="${esc(S.start_date)}"/></span>
      <span class="h">Starszych pracowników bot nie pyta — w tabeli mają stan „przed startem”.</span>
      <span class="k">Termin odpowiedzi</span><span>BHP + <input type="number" id="s_window_days" value="${esc(S.window_days)}" min="1" max="30"/> dni</span>
      <span class="h">Do tego dnia włącznie można odpowiedzieć lub zmienić odpowiedź. Potem bot odpowiada „czas minął”.</span>
      <span class="k">Przypomnienia</span><span><input type="number" id="s_remind_max" value="${esc(S.remind_max)}" min="0" max="5"/> razy, jedno dziennie, od <input type="time" id="s_remind_time" value="${esc(S.remind_time)}"/></span>
      <span class="h">Tylko tym, kto nie odpowiedział, i tylko w terminie odpowiedzi. Bot nie pisze między 20:00 a 8:00.</span>
    </div>
  </div>
  <div class="section">
    <div class="section-head">Premia za znajomego</div>
    <div class="cfg">
      <span class="k">Należy się po</span><span><input type="number" id="s_bonus_days" value="${esc(S.bonus_days)}" min="1" max="365"/> dniach pracy nowego (od BHP)</span>
      <span class="h">Przeniesienie na inny obiekt i przerwa do 14 dni nie przerywają stażu.</span>
      <span class="k">Kwota, zł</span><span><input type="text" class="inp" id="s_bonus_amount" value="${esc(S.bonus_amount)}" style="width:90px"/></span>
      <span class="h">Do Excela. Puste — kolumna kwoty pusta.</span>
    </div>
  </div>
  <div class="section">
    <div class="section-head">📝 Ankieta na starcie — pilotaż <span class="cnt">${pilotInfo(S, r)}</span></div>
    <div class="cfg">
      <span class="k">Co dostaje pracownik</span><span>1) <b>Skąd dowiedział się o firmie</b> (Facebook, Instagram, TikTok, Telegram, portale, rekruter, znajomy, koordynator)
        i od razu 2–5: jasność warunków, szybkość rekrutera, mieszkanie jak obiecano, ocena koordynatora.</span>
      <span class="h">Tylko nowi z wybranych obiektów. Pozostali dostają jak dotąd jedno pytanie „kto Cię polecił”. Wyniki — Rozmowy → Ankiety → „Start”.
        ${r.start_active ? "" : `<b class="bad">Ankieta „start” jest wyłączona w Rozmowy → Ustawienia — pilotaż nie działa.</b>`}</span>
      <span class="k">Przypomnienia pytań 2–5</span><span><input type="number" id="s_start_remind_days" value="${esc(S.start_remind_days || "2")}" min="0" max="5"/> dni, raz dziennie</span>
    </div>
    <div class="filters"><label><input type="checkbox" id="sp_all" ${S.start_sites === "*" ? "checked" : ""} onchange="togglePickAll()"/> <b>wszystkie obiekty</b></label>
      <input type="text" class="inp" id="sp_q" placeholder="Szukaj obiektu…" oninput="filterPick()" style="width:180px"/>
      <span id="sp_cnt"></span></div>
    <div class="sites-pick" id="sitesPick">${sitesPick(S, r.sites)}</div>
  </div>
  <div class="section">
    <div class="actions" style="border-top:none"><button class="btn btn-primary btn-sm" onclick="saveSettings()">Zapisz ustawienia</button><span class="msg" id="setMsg"></span>
      <span style="margin-left:auto;font-size:11px;color:var(--text3)">Ankiet: ${r.stats.answers} · odpowiedzi: ${r.stats.answered} · zapisów Telegrama: ${r.stats.tg_events}</span></div>
  </div>`;
  countPick();
}
function pickedSites(S) {
  if (S.start_sites === "*") return "*";
  try { return new Set(JSON.parse(S.start_sites || "[]")); } catch (e) { return new Set(); }
}
function pilotInfo(S) {
  const p = pickedSites(S);
  return p === "*" ? "wszystkie obiekty" : p.size ? `obiektów: ${p.size}` : "wyłączony";
}
function sitesPick(S, sites) {
  const p = pickedSites(S);
  let lastReg = null;
  return sites.map((x) => {
    const reg = x.region_name || "Bez regionu";
    const head = reg !== lastReg ? `<div class="rg">${esc(reg)}</div>` : "";
    lastReg = reg;
    return `${head}<label data-q="${esc((x.site_key + " " + (x.coordinator_name || "")).toLowerCase())}">
      <input type="checkbox" class="sp" value="${esc(x.site_key)}" ${p === "*" || (p.has && p.has(x.site_key)) ? "checked" : ""} ${p === "*" ? "disabled" : ""} onchange="countPick()"/>
      ${esc(x.site_key)}<span class="c">${esc(x.coordinator_name || "")}</span></label>`;
  }).join("") || `<div class="empty">Brak obiektów w Region → Ustawienia</div>`;
}
function togglePickAll() {
  const all = document.getElementById("sp_all").checked;
  document.querySelectorAll("#sitesPick input.sp").forEach((i) => { i.disabled = all; if (all) i.checked = true; });
  countPick();
}
function filterPick() {
  const q = document.getElementById("sp_q").value.trim().toLowerCase();
  document.querySelectorAll("#sitesPick label").forEach((l) => (l.style.display = !q || l.dataset.q.includes(q) ? "" : "none"));
}
function countPick() {
  const all = document.getElementById("sp_all").checked;
  const n = document.querySelectorAll("#sitesPick input.sp:checked").length;
  document.getElementById("sp_cnt").textContent = all ? "pilotaż na wszystkich obiektach" : n ? `zaznaczono: ${n}` : "pilotaż wyłączony";
}
async function saveSettings() {
  const v = (id) => document.getElementById(id).value.trim();
  const c = (id) => (document.getElementById(id).checked ? "1" : "0");
  const body = {
    enabled: c("s_enabled"), visible_coords: c("s_visible_coords"), start_date: v("s_start_date"),
    window_days: v("s_window_days"), remind_max: v("s_remind_max"), remind_time: v("s_remind_time"),
    bonus_days: v("s_bonus_days"), bonus_amount: v("s_bonus_amount"),
    start_remind_days: v("s_start_remind_days"),
    start_sites: document.getElementById("sp_all").checked ? "*"
      : JSON.stringify([...document.querySelectorAll("#sitesPick input.sp:checked")].map((i) => i.value)),
  };
  const msg = document.getElementById("setMsg");
  const res = await api("/settings", { method: "PATCH", body });
  if (!res || !res.ok) { msg.className = "msg err"; msg.textContent = (res && res.error) || "Błąd"; return; }
  msg.className = "msg ok"; msg.textContent = "Zapisano";
  const me = await api("/me");
  if (me && me.ok) { ST.me = me; renderBanner(); }
}

// ══════════════════════════════════════════════════════════════════════
//  Excel
// ══════════════════════════════════════════════════════════════════════
const XS = {
  title: { font: { bold: true, sz: 13 } },
  sub: { font: { color: { rgb: "666666" }, sz: 9 } },
  head: { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "2F5597" } },
    alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "999999" } } } },
  due: { fill: { patternType: "solid", fgColor: { rgb: "E2F0D9" } } },
  paid: { font: { color: { rgb: "548235" } } },
  lost: { font: { color: { rgb: "999999" } } },
  susp: { fill: { patternType: "solid", fgColor: { rgb: "FCE4D6" } } },
  todo: { fill: { patternType: "solid", fgColor: { rgb: "FFF2CC" } } },
  tot: { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: "D9E1F2" } } },
};
function haveXlsx() {
  if (typeof XLSX === "undefined") { alert("Biblioteka Excel nie załadowała się — odśwież stronę."); return false; }
  return true;
}
// aoa: wiersze; headRow: indeks nagłówka; styles: {rowIndex: styl}; widths: szerokości
function makeSheet(aoa, headRow, styles, widths, dateCols) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  const range = XLSX.utils.decode_range(ws["!ref"]);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const ref = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[ref];
      if (!cell) continue;
      let s = { alignment: { vertical: "top" } };
      if (R === 0) s = { ...s, ...XS.title };
      if (R === 1 && headRow > 1) s = { ...s, ...XS.sub };
      if (R === headRow) s = { ...s, ...XS.head };
      if (R > headRow && styles[R]) s = { ...s, ...styles[R] };
      if (R > headRow && dateCols && dateCols.includes(C) && cell.t === "d") cell.z = "dd.mm.yyyy";
      cell.s = s;
    }
  }
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  ws["!rows"] = [];
  ws["!rows"][headRow] = { hpt: 30 };
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headRow, c: 0 }, e: { r: range.e.r, c: range.e.c } }) };

  return ws;
}
function scopeLabel() {
  const r = document.getElementById("selRegion"), c = document.getElementById("selCoord");
  const parts = [];
  if (ST.me.role !== "coord") {
    if (r.value && r.selectedIndex >= 0) parts.push(r.options[r.selectedIndex].text);
    if (c.value) parts.push(c.options[c.selectedIndex].text);
  }
  return parts.join(" · ");
}
function fileName(kind) { return `polec_znajomego_${kind}_${ST.from}_${ST.to}.xlsx`; }
const amount = () => { const a = ST.me.settings.bonus_amount; return a ? Number(String(a).replace(",", ".")) : ""; };
const flagsText = (x) => (x.flags || []).map((f) => (FLAG[f.k] ? FLAG[f.k](f)[0] : f.k)).join("; ");

function exportList() {
  if (!haveXlsx() || !ST.list) return;
  const rows = filteredRows();
  const tg = ST.me.sees_tg;
  const N = ST.me.settings.bonus_days;
  const info = `BHP ${ddy(ST.from)} – ${ddy(ST.to)}${scopeLabel() ? " · " + scopeLabel() : ""} · stan na ${ddy(ST.me.today)} · premia po ${N} dniach pracy`;
  const wb = XLSX.utils.book_new();

  // 1) Odpowiedzi
  const head = ["BHP", "Login", "Pracownik", "Obiekt", "Region", "Koordynator obiektu", "Ankieta", "Termin odpowiedzi", "Wysłano (razy)",
    "Data odpowiedzi", "Źródło", "Wpisane imię i nazwisko", "Zestawiono: login", "Zestawiono: imię i nazwisko", "Zestawiono: obiekt",
    "Polecający pracuje", "Dni pracy nowego", "Premia: stan", "Premia od dnia", "Kwota, zł", "Wypłacono", "Notatka"];
  const pilot = rows.some((x) => x.ext || x.start);
  if (pilot) head.push("Ankieta startowa", ...START_Q.map((q) => q[1]));
  if (tg) head.push("Uwagi (Telegram)");
  const aoa = [["Poleć znajomego — odpowiedzi nowych pracowników"], [info], head];
  const styles = {};
  rows.forEach((x) => {
    const named = x.state === "answered" && (x.source === "friend" || x.source === "coord");
    const m = x.match;
    const line = [
      xDate(x.bhp), x.login, x.full_name, x.site_key, x.region_name || "", x.coordinator_name || "",
      (STATE[x.state] || [x.state])[0], xDate(x.deadline), x.sends || 0,
      x.state === "answered" && x.answered_at ? ts(x.answered_at) : "",
      x.state === "answered" ? SRC[x.source] || "" : "", x.referrer_text || "",
      named ? (m ? m.login || "" : x.match_coordinator_name ? "koordynator" : "") : "",
      named ? (m ? m.full_name || "" : x.match_coordinator_name || (x.match_state === "not_found" ? "nie ma w bazie" : "do zestawienia")) : "",
      named && m ? m.site_key || "" : "",
      named && m ? (m.working ? "tak" : "nie") : "",
      x.bonus.days,
      x.bonus.state === "na" ? "" : BONUS[x.bonus.state][0],
      x.source === "friend" && x.state === "answered" ? xDate(x.bonus.due_date) : "",
      x.bonus.state === "due" || x.bonus.state === "paid" ? amount() : "",
      x.bonus_paid_at ? xDate(x.bonus_paid_at) : "", x.bonus_note || "",
    ];
    if (pilot) {
      const sv = x.start;
      const val = (c) => { const a = sv && sv.answers.find((y) => y.code === c); if (!a) return ""; return /^[1-5]$/.test(a.o) ? Number(a.o) : a.a; };
      line.push(sv ? START_ST[sv.status] || sv.status : x.ext ? "nie wysłana" : "", ...START_Q.map(([c]) => val(c)));
    }
    if (tg) line.push(flagsText(x));
    const R = aoa.length;
    if (isSuspicious(x)) styles[R] = XS.susp;
    else if (x.bonus.state === "due") styles[R] = XS.due;
    else if (x.bonus.state === "paid") styles[R] = XS.paid;
    else if (isTodo(x)) styles[R] = XS.todo;
    aoa.push(line);
  });
  const w1 = [11, 11, 26, 22, 12, 22, 18, 11, 8, 16, 12, 26, 12, 26, 20, 9, 8, 18, 11, 9, 11, 22];
  if (pilot) w1.push(14, 12, 12, 16, 10);
  if (tg) w1.push(40);
  XLSX.utils.book_append_sheet(wb, makeSheet(aoa, 2, styles, w1, [0, 7, 18, 20]), "Odpowiedzi");

  // 2) Premie — dla polecających
  const order = { due: 0, pending: 1, paid: 2, lost: 3 };
  const pr = rows.filter((x) => x.state === "answered" && x.source === "friend" && x.match_state === "confirmed" && x.match && order[x.bonus.state] != null)
    .sort((a, b) => order[a.bonus.state] - order[b.bonus.state] || (a.match.full_name || "").localeCompare(b.match.full_name || ""));
  const aoa2 = [["Premie za polecenie znajomego"], [info],
    ["Premia: stan", "Polecający: login", "Polecający", "Obiekt polecającego", "Polecający pracuje", "Nowy: login", "Nowy pracownik",
      "Obiekt nowego", "BHP nowego", "Dni pracy nowego", "Premia od dnia", "Kwota, zł", "Wypłacono", "Notatka", ...(tg ? ["Uwagi (Telegram)"] : [])]];
  const st2 = {};
  pr.forEach((x) => {
    const R = aoa2.length;
    st2[R] = isSuspicious(x) ? XS.susp : x.bonus.state === "due" ? XS.due : x.bonus.state === "paid" ? XS.paid : x.bonus.state === "lost" ? XS.lost : null;
    aoa2.push([BONUS[x.bonus.state][0], x.match.login || "", x.match.full_name || "", x.match.site_key || "", x.match.working ? "tak" : "nie",
      x.login, x.full_name, x.site_key, xDate(x.bhp), x.bonus.days, xDate(x.bonus.due_date),
      x.bonus.state === "due" || x.bonus.state === "paid" ? amount() : "", x.bonus_paid_at ? xDate(x.bonus_paid_at) : "", x.bonus_note || "",
      ...(tg ? [flagsText(x)] : [])]);
  });
  const dueN = pr.filter((x) => x.bonus.state === "due").length;
  const a = amount();
  aoa2.push([]);
  aoa2.push([`Do wypłaty: ${dueN}${a ? ` × ${a} zł = ${dueN * a} zł` : ""}`]);
  st2[aoa2.length - 1] = XS.tot;
  XLSX.utils.book_append_sheet(wb, makeSheet(aoa2, 2, st2, [18, 11, 26, 22, 9, 11, 26, 22, 11, 8, 11, 9, 11, 24, 40], [8, 10, 12]), "Premie");

  XLSX.writeFile(wb, fileName("odpowiedzi"));
}

function exportRanking() {
  if (!haveXlsx() || !ST.ranking) return;
  const N = ST.me.settings.bonus_days;
  const aoa = [["Poleć znajomego — polecający"], [`BHP ${ddy(ST.from)} – ${ddy(ST.to)}${scopeLabel() ? " · " + scopeLabel() : ""} · stan na ${ddy(ST.me.today)}`],
    ["#", "Login", "Polecający", "Obiekt", "Pracuje", "Przyprowadził", "Nadal pracują", `Przepracowało ${N} dni`, "Premia należy się", "Wypłacono", "Odeszli przed", "Kogo przyprowadził"]];
  ST.ranking.rows.forEach((x, i) => aoa.push([i + 1, x.referrer.login || "", x.referrer.full_name || "", x.referrer.site_key || "", x.referrer.working ? "tak" : "nie",
    x.brought, x.working, x.reached, x.due, x.paid, x.lost,
    x.people.map((p) => `${p.full_name} (BHP ${dd(p.bhp)}, ${BONUS[p.bonus] ? BONUS[p.bonus][0] : p.bonus})`).join("; ")]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(aoa, 2, {}, [5, 11, 26, 22, 8, 10, 10, 12, 12, 10, 10, 70]), "Polecający");
  XLSX.writeFile(wb, fileName("polecajacy"));
}

function exportSources() {
  if (!haveXlsx() || !ST.sources) return;
  const r = ST.sources, N = r.bonus_days;
  const ads = r.total.ads > 0;
  const rt = (x, s) => { const e = x.ret[s]; return e && e.n ? Math.round((e.ok / e.n) * 100) / 100 : ""; };
  const SRCS = ["friend", "coord", "recruit", ...(ads ? ["ads"] : []), "other", "none"];
  const RETS = ["friend", "coord", "recruit", ...(ads ? ["ads"] : []), "none"];
  const L = { friend: "znajomy", coord: "koordynator", recruit: "rekrutacja", ads: "reklama", other: "inne", none: "brak odp." };
  const aoa = [["Poleć znajomego — źródła nowych pracowników"], [`BHP ${ddy(ST.from)} – ${ddy(ST.to)}${scopeLabel() ? " · " + scopeLabel() : ""} · utrzymanie = przepracowało ${N} dni (wśród tych, u kogo minęło ${N} dni)${ads ? " · reklama = Facebook, Instagram, TikTok, Telegram, portale" : ""}`],
    ["Obiekt", "Koordynator", "Region", "Nowi", "Odpowiedzieli", ...SRCS.map((k) => L[k].replace(/^./, (c) => c.toUpperCase())),
      ...RETS.map((k) => "Utrzymanie: " + L[k])]];
  const line = (x) => [x.site_key, x.coordinator_name || "", x.region_name || "", x.hires, x.answered, ...SRCS.map((k) => x[k] || 0), ...RETS.map((k) => rt(x, k))];
  r.rows.forEach((x) => aoa.push(line(x)));
  aoa.push(line(r.total));
  const c0 = 5 + SRCS.length;
  const ws = makeSheet(aoa, 2, { [aoa.length - 1]: XS.tot }, [24, 22, 12, 7, 11, ...SRCS.map(() => 10), ...RETS.map(() => 12)]);
  for (let R = 3; R < aoa.length; R++) for (let C = c0; C < c0 + RETS.length; C++) { const c = ws[XLSX.utils.encode_cell({ r: R, c: C })]; if (c && c.t === "n") c.z = "0%"; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Źródła");
  XLSX.writeFile(wb, fileName("zrodla"));
}
