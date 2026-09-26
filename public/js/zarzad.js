// ══════════════════════════════════════════════════════════════════════
//  «Pulpit kierownika» — зведена панель для керівника відділу
//  і операційного директора. Кожна цифра відкриває деталі.
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  me: null,
  period: 28,
  coord: null,          // { id, name } — фільтр «тільки його дані»
  summary: null,
  coords: [],
  voice: null,
  decAll: false,
  coordSort: { key: "rot", dir: -1 },
  drawer: null,         // { rows, cols, title } — для сортування і CSV
  tips: [],
  seq: 0,               // номер завантаження: відповіді старих запитів ігноруються
  dseq: 0,              // те саме для бокової панелі
};

// ── Утиліти ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const nf = new Intl.NumberFormat("pl-PL");
function pl(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (n === 1) return one;
  if (b >= 2 && b <= 4 && !(a >= 12 && a <= 14)) return few;
  return many;
}
const fN = (v) => (v == null ? "—" : nf.format(Math.round(v)));
const pct = (v) => (v == null || !isFinite(v) ? "—" : Math.round(v * 100) + "%");
const pct1 = (v) => (v == null || !isFinite(v) ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%");
const dec1 = (v) => (v == null ? "—" : Number(v).toFixed(1).replace(".", ","));
const ratio = (a, b) => (b ? a / b : null);
const dd = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) : "");
const ddy = (s) => (s ? dd(s) + "." + s.slice(0, 4) : "");
const MONTHS = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
const monthLabel = (m) => MONTHS[Number(m.slice(5, 7)) - 1] + " " + m.slice(0, 4);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* prywatne okno */ } },
};

async function api(path) {
  try {
    const r = await fetch("/api/board" + path, { headers: { "x-session": SESSION } });
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function qs(extra) {
  const p = new URLSearchParams();
  const reg = document.getElementById("selRegion").value;
  const cli = document.getElementById("selClient").value;
  const to = document.getElementById("selTo").value;
  if (reg && reg !== "all") p.set("region", reg);
  if (cli) p.set("client", cli);
  if (to) p.set("to", to);
  p.set("period", ST.period);
  if (ST.coord) p.set("coord", ST.coord.id);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return "?" + p.toString();
}

// ── Підказка при наведенні ───────────────────────────────────────────
const tipEl = () => document.getElementById("tip");
function tipShow(e, html) {
  const t = tipEl();
  t.innerHTML = html;
  t.style.display = "block";
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = x + "px";
  t.style.top = y + "px";
}
function tipHide() { tipEl().style.display = "none"; }
// Елементи з data-tip="<індекс>" показують ST.tips[індекс]
document.addEventListener("mousemove", (e) => {
  const el = e.target.closest && e.target.closest("[data-tip]");
  if (el) tipShow(e, ST.tips[Number(el.dataset.tip)] || "");
  else tipHide();
});
function tip(html) { ST.tips.push(html); return ST.tips.length - 1; }

// ══════════════════════════════════════════════════════════════════════
//  Старт
// ══════════════════════════════════════════════════════════════════════
window.addEventListener("DOMContentLoaded", init);

async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  if (!me.ok || !me.has_access) {
    document.getElementById("toolbar").style.display = "none";
    document.querySelectorAll(".nav-item[data-sec]").forEach((el) => (el.style.display = "none"));
    document.getElementById("content").innerHTML =
      `<div class="noaccess">📊 <b>Pulpit kierownika</b> jest dostępny dla kierownika działu i administratorów panelu.</div>`;
    return;
  }
  ST.me = me;
  me.links = me.links || {};
  if (me.links.region) document.getElementById("navRegion").style.display = "";
  if (me.links.rozmowy) document.getElementById("navRozmowy").style.display = "";
  const selR = document.getElementById("selRegion");
  selR.innerHTML = `<option value="all">Wszystkie regiony</option>` +
    me.regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("") +
    `<option value="none">Bez regionu</option>`;
  const selC = document.getElementById("selClient");
  selC.innerHTML = `<option value="">Wszyscy klienci</option>` +
    me.clients.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const selT = document.getElementById("selTo");
  selT.innerHTML = me.weeks.map((w, i) => `<option value="${i === 0 ? "" : w}">${ddy(w)}${i === 0 ? " (ost. pełny tydzień)" : ""}</option>`).join("");

  const saved = store.get("sas_board_f");
  if (saved) {
    if (saved.region && [...selR.options].some((o) => o.value === saved.region)) selR.value = saved.region;
    if (saved.client && [...selC.options].some((o) => o.value === saved.client)) selC.value = saved.client;
    if ([7, 28, 91].includes(saved.period)) ST.period = saved.period;
  }
  paintPeriod();
  loadAll();
}

function onFilter() {
  store.set("sas_board_f", {
    region: document.getElementById("selRegion").value,
    client: document.getElementById("selClient").value,
    period: ST.period,
  });
  loadAll();
}
function setPeriod(p) { ST.period = p; paintPeriod(); onFilter(); }
function paintPeriod() {
  document.querySelectorAll("#periodChips .chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.p) === ST.period));
}
function setRegion(key, label) {
  const sel = document.getElementById("selRegion");
  if (![...sel.options].some((o) => o.value === String(key))) {
    const o = document.createElement("option");
    o.value = key; o.textContent = label || "Region";
    sel.appendChild(o);
  }
  sel.value = key;
  onFilter();
  goSec("sec-rag");
}
function setCoord(id, name) {
  ST.coord = { id, name };
  document.getElementById("coordChipName").textContent = "Koordynator: " + name;
  document.getElementById("coordChip").style.display = "inline-flex";
  closeDrawer();
  loadAll();
  document.getElementById("content").scrollTo({ top: 0, behavior: "smooth" });
}
function clearCoord() {
  ST.coord = null;
  document.getElementById("coordChip").style.display = "none";
  loadAll();
}
function goSec(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelectorAll(".nav-item[data-sec]").forEach((n) => n.classList.toggle("active", n.dataset.sec === id));
}
function siteLink(key) {
  window.open("region.html#site=" + encodeURIComponent(key), "_blank");
}

async function loadAll() {
  const content = document.getElementById("content");
  content.classList.add("busy");
  const my = ++ST.seq;
  ST.tips = [];
  const q = qs();
  const job = (path, ids, fn) => api(path + q).then((r) => { if (my === ST.seq) guard(r, ids, () => fn(r)); });
  await Promise.all([
    job("/summary", ["periodLine", "sec-kpi", "decList", "tenureChart"], (r) => { ST.summary = r; renderPeriodLine(); renderKpis(); renderDecisions(); renderTenure(); }),
    job("/rag", ["ragTable"], (r) => renderRag(r)),
    job("/trend", ["flowChart", "hcChart"], (r) => renderFlow(r.data)),
    job("/cohorts", ["cohTable"], (r) => renderCohorts(r)),
    job("/reasons", ["reasonTable"], (r) => renderReasons(r)),
    job("/voice", ["voiceBox"], (r) => { ST.voice = r; renderVoice(r); }),
    job("/coordinators", ["coordTable", "quadChart", "cmpBox"], (r) => { ST.coords = r.data; ST.compare = r.compare; renderCoords(); }),
  ]);
  if (my === ST.seq) content.classList.remove("busy");
}
function guard(r, ids, fn) {
  if (!r) return;
  if (!r.ok) {
    ids.forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = `<div class="error">${esc(r.error || "Błąd")}</div>`; });
    return;
  }
  try { fn(); } catch (e) {
    console.error(e);
    ids.forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = `<div class="error">${esc(e.message)}</div>`; });
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Період і плитки
// ══════════════════════════════════════════════════════════════════════
const PERIOD_NAME = { 7: "tydzień", 28: "4 tygodnie", 91: "13 tygodni" };
function renderPeriodLine() {
  const s = ST.summary;
  const reg = document.getElementById("selRegion");
  const cli = document.getElementById("selClient").value;
  const parts = [`Okres: <b>${dd(s.from)}–${ddy(s.anchor)}</b> (${PERIOD_NAME[s.period]}), porównanie z poprzednim takim okresem`];
  if (reg.value !== "all" && reg.selectedIndex >= 0) parts.push(`<span class="crumb"><a onclick="setRegion('all')">Cała firma</a> › <b>${esc(reg.options[reg.selectedIndex].text)}</b></span>`);
  if (cli) parts.push(`klient: <b>${esc(cli)}</b>`);
  if (ST.coord) parts.push(`koordynator: <b>${esc(ST.coord.name)}</b>`);
  let html = parts.join(" · ");
  if (document.getElementById("selTo").value)
    html += `<br><span class="muted">Do decyzji, przyczyny, głos pracownika, kohorty i lista ryzyka pokazują stan na dziś — nie na wybrany tydzień.</span>`;
  document.getElementById("periodLine").innerHTML = html;
}

const rotOf = (x) => ratio(x.dep, (x.hc_start + x.hc_end) / 2);
function delta(cur, prev, good, kind) {
  if (cur == null || prev == null) return { t: "", c: "flat" };
  const d = cur - prev;
  const eps = kind === "pp" ? 0.0005 : 0.5;
  if (Math.abs(d) < eps) return { t: "= bez zmian", c: "flat" };
  const arrow = d > 0 ? "▲" : "▼";
  const t = kind === "pp" ? `${arrow} ${Math.abs(d * 100).toFixed(1).replace(".", ",")} pp` : `${arrow} ${nf.format(Math.abs(Math.round(d)))}`;
  const c = good === 0 ? "flat" : (d > 0) === (good > 0) ? "good" : "bad";
  return { t, c };
}

function renderKpis() {
  const s = ST.summary, c = s.cur, p = s.prev, me = ST.me;
  const short = s.period < 28 ? " (za 4 tyg.)" : "";
  const risk = c.dep_cov >= 5
    ? `lista ryzyka objęła ${pct(ratio(c.dep_flagged, c.dep_cov))} odejść`
    : "trafność listy — po 3 tygodniach danych";
  const leftL = c.leaving_left, stayL = c.leaving_stayed, pendL = c.leaving - c.leaving_left - c.leaving_stayed;
  const tiles = [
    { l: "Pracuje na koniec okresu", v: fN(c.hc_end), d: delta(c.hc_end, c.hc_start, 1), s: `na początku okresu ${fN(c.hc_start)}`, k: "sites", t: "Obiekty" },
    { l: "Przyjęci", v: fN(c.hires), d: delta(c.hires, p.hires, 0), s: `nie podjęło pracy: <a class="linkbtn" onclick="event.stopPropagation();openDetail('rez','Rezygnacje — nie podjęli pracy')">${fN(c.rez)}</a>`, k: "hires", t: "Przyjęci" },
    { l: "Odejścia", v: fN(c.dep), d: delta(c.dep, p.dep, -1), s: `rotacja ${pct1(rotOf(c))} · poprzednio ${pct1(rotOf(p))}`, k: "departures", t: "Odejścia" },
    { l: "Odeszli przed 30. dniem", v: fN(c.dep_early), d: delta(c.dep_early, p.dep_early, -1), s: `${pct(ratio(c.dep_early, c.dep))} wszystkich odejść — rekrutacja i pierwsze dni`, k: "early", t: "Odejścia przed 30. dniem" },
    { l: "Dożycie 80 dni" + short, v: pct(ratio(c.ok80, c.n80)), d: s.period < 28 ? { t: "", c: "flat" } : delta(ratio(c.ok80, c.n80), ratio(p.ok80, p.n80), 1, "pp"), s: `${fN(c.ok80)} z ${fN(c.n80)} osób, którym wypadł 80. dzień`, k: "s80", t: "Dożycie 80 dni" },
    { l: "Nieobecności NN", v: pct1(ratio(c.nn, c.nn_base)), d: delta(ratio(c.nn, c.nn_base), ratio(p.nn, p.nn_base), -1, "pp"), s: `${fN(c.nn)} dni NN z ${fN(c.nn_base)} dni pracy`, k: "sites", t: "Obiekty — nieobecności NN", sort: "nnr" },
    c.risk_day
      ? { l: "W strefie ryzyka", v: fN(c.risk_n), d: p.risk_day ? delta(c.risk_n, p.risk_n, -1) : { t: "", c: "flat" }, s: `${pct(ratio(c.risk_n, c.risk_all))} pracujących · ${risk}`, k: "risk", t: "W strefie ryzyka" }
      : { l: "W strefie ryzyka", v: "—", off: true, d: { t: "", c: "flat" }, s: "brak zapisanego ryzyka dla tego tygodnia (historia — 4 miesiące)", k: null },
    me.module_on
      ? { l: "„Chce odejść” (rozmowy)", v: fN(c.leaving), d: { t: "", c: "flat" }, s: `zostało ${stayL} · odeszło ${leftL} · czekamy 30 dni: ${pendL}`, k: "leaving", t: "„Chce odejść”" }
      : { l: "„Chce odejść” (rozmowy)", v: "moduł wyłączony", off: true, d: { t: "", c: "flat" }, s: "Rozmowy nie są włączone żadnemu koordynatorowi", k: null },
  ];
  document.getElementById("sec-kpi").innerHTML = tiles.map((x) => `
    <div class="kpi${x.off ? " off" : ""}" role="button" tabindex="0" ${x.k ? `onclick="openDetail('${x.k}','${esc(x.t)}'${x.sort ? `,null,'${x.sort}'` : ""})"` : ""}>
      <div class="l">${esc(x.l)}</div>
      <div class="row"><span class="v">${x.v}</span><span class="d ${x.d.c}">${x.d.t}</span></div>
      <div class="s">${x.s}</div>
    </div>`).join("");
}

// ══════════════════════════════════════════════════════════════════════
//  Do decyzji
// ══════════════════════════════════════════════════════════════════════
const SEV = { 1: "PILNE", 2: "WAŻNE", 3: "INFO" };
function renderDecisions() {
  const list = ST.summary.decisions || [];
  ST.decisions = list;
  const lim = ST.decAll ? list.length : 8;
  document.getElementById("decCnt").textContent = list.length ? `${list.length}` : "";
  document.getElementById("decMore").textContent = list.length > 8 ? (ST.decAll ? "Pokaż mniej" : `Pokaż wszystkie (${list.length})`) : "";
  document.getElementById("decList").innerHTML = list.length
    ? list.slice(0, lim).map((d, i) => `
      <div class="dec" onclick="openDecision(${i})">
        <span class="sev s${d.sev}">${SEV[d.sev]}</span>
        <div><div class="t">${esc(d.text)}</div>${d.sub ? `<div class="sub">${esc(d.sub)}</div>` : ""}</div>
      </div>`).join("")
    : `<div class="empty">Nic pilnego — brak czerwonych obiektów bez planu, skupisk skarg i zaległości.</div>`;
}
function toggleDec() { ST.decAll = !ST.decAll; renderDecisions(); }
function openDecision(i) {
  const d = ST.decisions[i];
  if (d.detail === "early_now" && d.site) return openDetail("early_now", "Odejścia przed 30. dniem — " + d.site, { site: d.site });
  if (d.detail) return openDetail(d.detail, d.text);
  if (d.site && ST.me.links.region) return siteLink(d.site);
  if (d.coord) return openCoord(d.coord);
}

// ══════════════════════════════════════════════════════════════════════
//  Світлофор
// ══════════════════════════════════════════════════════════════════════
const ST_LABEL = { R: "czerwony", A: "żółty", G: "zielony", S: "strukturalny", N: "brak danych" };
function renderRag(r) {
  const reg = document.getElementById("selRegion");
  document.getElementById("ragCrumb").innerHTML = reg.value === "all" || reg.selectedIndex < 0
    ? "cała firma i regiony"
    : `<span class="crumb"><a onclick="setRegion('all')">Cała firma</a> › ${esc(reg.options[reg.selectedIndex].text)}</span>`;
  if (!r.weeks.length) {
    document.getElementById("ragTable").innerHTML = `<div class="empty">Brak przeliczonych tygodni w sekcji Region.</div>`;
    return;
  }
  const head = `<tr><th class="l">${reg.value === "all" ? "Region" : "Obiekt"}</th><th>osób</th>${r.weeks.map((w) => `<th>${dd(w)}</th>`).join("")}</tr>`;
  const body = r.rows.map((row) => {
    const last = row.cells[row.cells.length - 1] || {};
    let label;
    if (row.type === "region" && reg.value === "all") label = `<a data-k="${esc(row.key)}" data-l="${esc(row.label)}" onclick="setRegion(this.dataset.k, this.dataset.l)">${esc(row.label)}</a>`;
    else if (row.type === "site" && ST.me.links.region) label = `<a data-site="${esc(row.key)}" onclick="siteLink(this.dataset.site)" title="Otwórz kartę obiektu">${esc(row.label)}</a>`;
    else label = esc(row.label);
    const cells = row.cells.map((c) => {
      if (!c.status) return `<td><div class="cell x"></div></td>`;
      const agg = row.type !== "site";
      const lines = [`<b>${esc(row.label)}</b> · tydzień do ${ddy(c.w)}`, `Status: <b>${ST_LABEL[c.status]}</b>${c.red_weeks ? ` (${c.red_weeks} tyg.)` : ""}`,
        `Rotacja (na 28 dni): <b>${pct1(c.rot)}</b>`, `Dożycie (30/80 dni): <b>${pct(c.ret)}</b>`, `NN: <b>${pct1(c.abs)}</b>`,
        agg ? `Średnio osób: ${fN(c.hc)}` : `Średnio osób: ${fN(c.hc)} · odejścia: ${fN(c.dep)} w oknie ${c.win} dni`];
      if (agg) lines.push(`Obiekty: ${c.sites} — 🔴 ${c.red} · 🟡 ${c.amber} · 🟢 ${c.green}`);
      return `<td><div class="cell ${c.status}" data-tip="${tip(lines.join("<br>"))}">${agg && c.red ? c.red : ""}</div></td>`;
    }).join("");
    return `<tr class="${row.type}"><td class="l">${label}</td><td class="hc">${fN(last.hc)}</td>${cells}</tr>`;
  }).join("");
  document.getElementById("ragTable").innerHTML = `<table class="hm"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ══════════════════════════════════════════════════════════════════════
//  Рух кадрів і стаж
// ══════════════════════════════════════════════════════════════════════
function renderFlow(data) {
  const W = 640, H = 190, padL = 34, padB = 22, padT = 14;
  const n = data.length;
  const max = Math.max(10, ...data.map((d) => Math.max(d.hires, d.dep)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const gw = (W - padL) / n;
  const bw = Math.min(16, (gw - 8) / 2);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Przyjęci i odejścia tydzień po tygodniu">`;
  for (let v = 0; v <= top; v += step) s += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  data.forEach((d, i) => {
    const cx = padL + gw * i + gw / 2;
    const x1 = cx - bw - 1, x2 = cx + 1;
    s += bar(x1, y(d.hires), bw, y(0) - y(d.hires), "var(--s-hire)");
    s += bar(x2, y(d.dep), bw, y(0) - y(d.dep), "var(--s-dep)");
    if (i === n - 1 || i % 2 === (n - 1) % 2) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${dd(d.w)}</text>`;
    if (i === n - 1) {
      s += `<text class="val" x="${x1 + bw / 2}" y="${y(d.hires) - 4}" text-anchor="middle">${d.hires}</text>`;
      s += `<text class="val" x="${x2 + bw / 2}" y="${y(d.dep) - 4}" text-anchor="middle">${d.dep}</text>`;
    }
    const net = d.hires - d.dep;
    const t = tip(`<b>Tydzień do ${ddy(d.w)}</b><br><span class="k" style="background:var(--s-hire)"></span><b>${d.hires}</b> ${pl(d.hires, "przyjęty", "przyjętych", "przyjętych")}<br>
      <span class="k" style="background:var(--s-dep)"></span><b>${d.dep}</b> ${pl(d.dep, "odejście", "odejścia", "odejść")} (w tym ${d.dep_early} przed 30. dniem)<br>
      Saldo: <b>${net > 0 ? "+" : ""}${net}</b> · pracuje: <b>${fN(d.hc)}</b>`);
    s += `<rect class="hit" data-tip="${t}" x="${padL + gw * i}" y="${padT}" width="${gw}" height="${H - padT - padB}"/>`;
  });
  s += `</svg>`;
  document.getElementById("flowChart").innerHTML = s;

  // Чисельність — окремий графік (своя шкала, без другої осі)
  const H2 = 80, pT = 16, pB = 6;
  const hv = data.map((d) => d.hc);
  const mn = Math.min(...hv), mx = Math.max(...hv);
  const span = Math.max(mx - mn, 10);
  const y2 = (v) => pT + (H2 - pT - pB) * (1 - (v - mn + span * 0.1) / (span * 1.2));
  const xs = (i) => padL + gw * i + gw / 2;
  let l = `<svg viewBox="0 0 ${W} ${H2}" role="img" aria-label="Liczba pracujących na koniec tygodnia">`;
  l += `<text x="${padL}" y="10" class="lbl">Pracuje na koniec tygodnia</text>`;
  l += `<polyline fill="none" stroke="var(--text2)" stroke-width="2" stroke-linejoin="round" points="${hv.map((v, i) => `${xs(i)},${y2(v)}`).join(" ")}"/>`;
  [0, n - 1].forEach((i) => { l += `<circle cx="${xs(i)}" cy="${y2(hv[i])}" r="3" fill="var(--text2)"/><text class="val" x="${xs(i)}" y="${y2(hv[i]) - 6}" text-anchor="${i ? "end" : "start"}">${fN(hv[i])}</text>`; });
  data.forEach((d, i) => { l += `<rect class="hit" data-tip="${tip(`<b>${ddy(d.w)}</b><br>Pracuje: <b>${fN(d.hc)}</b>`)}" x="${padL + gw * i}" y="0" width="${gw}" height="${H2}"/>`; });
  l += `</svg>`;
  document.getElementById("hcChart").innerHTML = l;
}
function bar(x, y, w, h, color) {
  if (h <= 0) return "";
  const r = Math.min(3, h / 2, w / 2);
  // заокруглений верх, рівна основа
  return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${color}"/>`;
}
function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function renderTenure() {
  const t = ST.summary.tenure;
  const total = t.reduce((a, x) => a + x.n, 0);
  document.getElementById("tenureCnt").textContent = `${fN(total)} ${pl(total, "odejście", "odejścia", "odejść")} w okresie`;
  if (!total) { document.getElementById("tenureChart").innerHTML = `<div class="empty">Brak odejść w wybranym okresie.</div>`; return; }
  const W = 560, rowH = 26, padL = 78, padR = 70;
  const max = Math.max(...t.map((x) => x.n));
  let s = `<svg viewBox="0 0 ${W} ${rowH * t.length + 4}" role="img" aria-label="Odejścia według stażu">`;
  t.forEach((x, i) => {
    const yy = i * rowH + 4;
    const w = max ? (W - padL - padR) * (x.n / max) : 0;
    s += `<text class="lbl" x="${padL - 8}" y="${yy + 14}" text-anchor="end">${esc(x.label)}</text>`;
    if (w > 0) s += `<path d="M${padL},${yy + 3} H${padL + w - 3} Q${padL + w},${yy + 3} ${padL + w},${yy + 6} V${yy + 15} Q${padL + w},${yy + 18} ${padL + w - 3},${yy + 18} H${padL} Z" fill="var(--s-dep)"/>`;
    s += `<text class="val" x="${padL + w + 6}" y="${yy + 14}">${x.n} <tspan class="lbl" style="font-weight:400">· ${pct(x.n / total)}</tspan></text>`;
    s += `<rect class="hit" data-tip="${tip(`Staż <b>${esc(x.label)}</b> dni<br><b>${x.n}</b> ${pl(x.n, "odejście", "odejścia", "odejść")} · ${pct(x.n / total)} wszystkich`)}" x="0" y="${yy}" width="${W}" height="${rowH}"/>`;
  });
  s += `</svg>`;
  document.getElementById("tenureChart").innerHTML = s;
}

// ══════════════════════════════════════════════════════════════════════
//  Когорти і причини
// ══════════════════════════════════════════════════════════════════════
const seqBg = (v, lo, hi) => {
  if (v == null) return "";
  const a = 0.08 + 0.55 * Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return `background: rgba(var(--seq), ${a.toFixed(2)})`;
};
function renderCohorts(r) {
  if (!r.rows.length) { document.getElementById("cohTable").innerHTML = `<div class="empty">Brak przyjęć w ostatnich 6 miesiącach.</div>`; return; }
  const cell = (c, hired, m) => {
    if (!c.elig) return `<td class="num muted">·</td>`;
    const v = c.ok / c.elig;
    const part = c.elig < hired ? ` (na razie ${c.elig} z ${hired} osób)` : "";
    return `<td class="num"><span class="seq" style="${seqBg(v, 0.4, 1)}" data-tip="${tip(`<b>${m}</b>, ${c.d}. dzień<br>pracuje: <b>${c.ok}</b> z ${c.elig}${part}`)}">${pct(v)}</span></td>`;
  };
  const rows = r.rows.map((x) => `<tr><td>${monthLabel(x.m)}</td><td class="num">${fN(x.hired)}</td>${x.cells.map((c) => cell(c, x.hired, monthLabel(x.m))).join("")}</tr>`).join("");
  const tot = r.total;
  document.getElementById("cohTable").innerHTML = `<table class="rg">
    <thead><tr><th>Przyjęci w</th><th class="num">osób</th>${r.days.map((d) => `<th class="num">${d}. dzień</th>`).join("")}</tr></thead>
    <tbody>${rows}<tr class="total"><td>Razem</td><td class="num">${fN(tot.hired)}</td>${tot.cells.map((c) => cell(c, tot.hired, "Razem")).join("")}</tr></tbody></table>`;
}

function renderReasons(r) {
  const S = r.sources;
  const keys = ["exit", "problem", "tasks", "cards"];
  const any = keys.some((k) => S[k].total > 0);
  if (!any) {
    document.getElementById("reasonTable").innerHTML = `<div class="empty">Brak danych za 90 dni. Przyczyny zbierają ankiety i rozmowy (moduł Rozmowy) oraz czerwone karty (Region).</div>`;
    return;
  }
  const SH = { exit: ["Odchodzący", "ankieta"], problem: ["Pracujący", "„co przeszkadza”"], tasks: ["Koordynatorzy", "rozmowy"], cards: ["Regionalni", "czerwone karty"] };
  const head = keys.map((k) => `<th class="num src" title="${esc(S[k].label)}">${SH[k][0]}<br><span class="muted">${SH[k][1]} · n=${S[k].total}</span></th>`).join("");
  const rows = r.categories.map((c) => `<tr><td>${esc(c.label)}</td>${keys.map((k) => {
    if (!S[k].total) return `<td class="num muted">—</td>`;
    const v = c[k] / S[k].total;
    return `<td class="num">${c[k] ? `<span class="seq" style="${seqBg(v, 0, 0.6)}" data-tip="${tip(`<b>${esc(c.label)}</b><br>${esc(S[k].label)}: <b>${c[k]}</b> z ${S[k].total}`)}">${pct(v)}</span>` : `<span class="muted">·</span>`}</td>`;
  }).join("")}</tr>`).join("");
  const notes = [];
  if (S.problem.ok) notes.push(`pracujący „wszystko OK”: ${S.problem.ok}`);
  if (S.tasks.leaving) notes.push(`rozmowy „chce odejść”: ${S.tasks.leaving}`);
  document.getElementById("reasonTable").innerHTML = `<table class="rg"><thead><tr><th>Przyczyna</th>${head}</tr></thead><tbody>${rows}</tbody></table>` +
    (notes.length ? `<div class="legend" style="border-top:1px solid var(--border)">${notes.join(" · ")}</div>` : "");
}

// ══════════════════════════════════════════════════════════════════════
//  Голос працівника
// ══════════════════════════════════════════════════════════════════════
function voiceTiles(v) {
  const sc = (x) => (x.v == null ? "" : x.v < 3 ? "red" : x.v < 3.6 ? "amber" : "");
  const sh = (x, lo, hi) => (x.v == null ? "" : x.v < lo ? "red" : x.v < hi ? "amber" : "");
  const t = [
    { l: "Praca (1–5)", v: dec1(v.work5.v), c: sc(v.work5), s: `n=${v.work5.n}` },
    { l: "Mieszkanie (1–5)", v: dec1(v.housing5.v), c: sc(v.housing5), s: `n=${v.housing5.n}` },
    { l: "Pomoc koordynatora (1–5) 🔒", v: dec1(v.coord5.v), c: sc(v.coord5), s: `n=${v.coord5.n} · widzi tylko kierownictwo` },
    { l: "Planują zostać", v: pct(v.stay_yes.v), c: sh(v.stay_yes, 0.6, 0.8), s: `„nie”: ${pct(v.stay_no.v)} · n=${v.stay_yes.n}` },
    { l: "Pierwsze dni: mieszkanie OK", v: pct(v.housing3.v), c: sh(v.housing3, 0.6, 0.8), s: `n=${v.housing3.n}` },
    { l: "Pierwsze dni: dojazd OK", v: pct(v.transport3.v), c: sh(v.transport3, 0.6, 0.8), s: `n=${v.transport3.n}` },
    { l: "Wyjaśniono pracę na miejscu", v: pct(v.onboard3.v), c: sh(v.onboard3, 0.6, 0.8), s: `n=${v.onboard3.n}` },
    { l: "Koordynator dostępny 🔒", v: pct(v.coord_yes.v), c: sh(v.coord_yes, 0.6, 0.8), s: `n=${v.coord_yes.n}` },
    { l: "Odchodzący: wróciłby", v: pct(v.back.v), c: "", s: `n=${v.back.n}` },
    { l: "Odpowiadają na ankiety", v: pct(v.rate), c: "", s: `${v.done} z ${v.sent} · bez Telegrama ${v.no_tg}` },
  ];
  return `<div class="vtiles">${t.map((x) => `<div class="vt"><div class="l">${x.l}</div><div class="v ${x.c}">${x.v}</div><div class="s">${esc(x.s)}</div></div>`).join("")}</div>`;
}
function renderVoice(r) {
  const v = r.all;
  const box = document.getElementById("voiceBox");
  if (!v.sent && !v.work5.n && !v.stay_yes.n) {
    box.innerHTML = `<div class="empty">Brak ankiet w tym zakresie. Ankiety dostają pracownicy koordynatorów z włączonym modułem Rozmowy (3., 14., 30., 60. dzień i po odejściu).</div>`;
    return;
  }
  const PROB = { housing: "mieszkanie", money: "pieniądze", schedule: "grafik / godziny", team: "zespół", transport: "dojazd", other: "inne" };
  const pr = Object.entries(v.problem || {}).filter(([k]) => k !== "nothing").sort((a, b) => b[1] - a[1]);
  const prTot = Object.values(v.problem || {}).reduce((a, x) => a + x, 0);
  box.innerHTML = voiceTiles(v) + (prTot ? `<div class="legend">Co przeszkadza najbardziej (14–60 dni): ${pr.length ? pr.map(([k, n]) => `${PROB[k] || k} ${pct(n / prTot)}`).join(" · ") : "—"}${v.problem.nothing ? ` · wszystko OK ${pct(v.problem.nothing / prTot)}` : ""}</div>` : "");
}
function openVoiceRegions() {
  const r = ST.voice;
  if (!r) return;
  const cols = [
    ["label", "Region"], ["rate", "Odpowiedzi", "pct"], ["work5", "Praca 1–5", "avg"], ["housing5", "Mieszkanie 1–5", "avg"],
    ["coord5", "Koordynator 1–5 🔒", "avg"], ["stay_yes", "Planują zostać", "share"], ["housing3", "Mieszk. OK (3. dzień)", "share"],
    ["transport3", "Dojazd OK", "share"], ["onboard3", "Wyjaśniono pracę", "share"],
  ];
  const rows = r.by_region.map((x) => {
    const o = { label: x.label, rate: x.rate };
    ["work5", "housing5", "coord5"].forEach((k) => (o[k] = x[k].v));
    ["stay_yes", "housing3", "transport3", "onboard3"].forEach((k) => (o[k] = x[k].v));
    return o;
  });
  const colDefs = cols.map(([k, l, f]) => ({ k, l, f: f === "pct" || f === "share" ? "pct" : f === "avg" ? "dec" : null }));
  showDrawer("Głos pracownika po regionach", "ankiety z 90 dni", colDefs, rows);
}

// ══════════════════════════════════════════════════════════════════════
//  Координатори
// ══════════════════════════════════════════════════════════════════════
function coordDerived(x) {
  return Object.assign({}, x, {
    rot: rotOf(x),
    s80: x.n80 >= 5 ? x.ok80 / x.n80 : null,
    fill: x.days ? x.filled / x.days : null,
    nnr: x.nn_base ? x.nn / x.nn_base : null,
    ontime: x.due >= 3 ? x.on_time / x.due : null,
    noans: x.done ? x.o_no_answer / x.done : null,
    spot: x.spot_n ? x.spot_no / x.spot_n : null,
    c5: x.c5_n >= 3 ? Number(x.c5_avg) : null,
    svr: x.sv_sent ? x.sv_done / x.sv_sent : null,
  });
}
function renderCoords() {
  ST.cd = ST.coords.map(coordDerived);
  document.getElementById("coordCnt").textContent = `${ST.cd.length} · z modułem Rozmowy: ${ST.cd.filter((x) => x.module_on).length}`;
  renderQuad();
  renderCompare();
  renderCoordTable();
}
function median(a) {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function renderQuad() {
  const xk = document.getElementById("selX").value, yk = document.getElementById("selY").value;
  const XL = { fill: "Godziny wpisane w bocie", ontime: "Rozmowy zamknięte na czas" };
  const YL = { s80: "Dożycie 80 dni", rot: "Rotacja w okresie (mniej = lepiej)" };
  const pts = (ST.cd || []).filter((x) => x[xk] != null && x[yk] != null);
  const miss = (ST.cd || []).length - pts.length;
  const box = document.getElementById("quadChart");
  if (pts.length < 2) {
    box.innerHTML = `<div class="empty">Za mało danych na wykres (${pts.length}). ${xk === "ontime" ? "Rozmowy są liczone tylko dla koordynatorów z włączonym modułem — przełącz oś X na „Godziny wpisane w bocie”." : ""}</div>`;
    return;
  }
  const W = 480, H = 330, pL = 40, pB = 34, pT = 12, pR = 12;
  const xv = pts.map((p) => p[xk]), yv = pts.map((p) => (yk === "rot" ? -p.rot : p[yk]));
  const rng = (a) => { let lo = Math.min(...a), hi = Math.max(...a); const pad = Math.max((hi - lo) * 0.12, 0.03); return [lo - pad, hi + pad]; };
  const [x0, x1] = rng(xv), [y0, y1] = rng(yv);
  const X = (v) => pL + (W - pL - pR) * ((v - x0) / (x1 - x0));
  const Y = (v) => pT + (H - pT - pB) * (1 - (v - y0) / (y1 - y0));
  const mx = median(xv), my = median(yv);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Koordynatorzy: proces i wynik">`;
  // осі з підписами у відсотках
  for (let i = 0; i <= 4; i++) {
    const vx = x0 + (x1 - x0) * i / 4, vy = y0 + (y1 - y0) * i / 4;
    s += `<text x="${X(vx)}" y="${H - pB + 14}" text-anchor="middle">${pct(vx)}</text>`;
    s += `<text x="${pL - 5}" y="${Y(vy) + 3}" text-anchor="end">${pct(yk === "rot" ? -vy : vy)}</text>`;
  }
  s += `<line class="grid" x1="${X(mx)}" x2="${X(mx)}" y1="${pT}" y2="${H - pB}" stroke-dasharray="4 4"/>`;
  s += `<line class="grid" x1="${pL}" x2="${W - pR}" y1="${Y(my)}" y2="${Y(my)}" stroke-dasharray="4 4"/>`;
  s += `<text x="${W - pR}" y="${pT + 10}" text-anchor="end" class="lbl">wzór</text>`;
  s += `<text x="${pL + 4}" y="${pT + 10}" class="lbl">wynik bez procesu</text>`;
  s += `<text x="${W - pR}" y="${H - pB - 6}" text-anchor="end" class="lbl">proces bez wyniku</text>`;
  s += `<text x="${pL + 4}" y="${H - pB - 6}" class="lbl" style="fill:var(--red)">wymaga uwagi</text>`;
  s += `<text x="${(pL + W) / 2}" y="${H - 4}" text-anchor="middle" class="lbl">${XL[xk]} →</text>`;
  s += `<text x="10" y="${(pT + H - pB) / 2}" transform="rotate(-90 10 ${(pT + H - pB) / 2})" text-anchor="middle" class="lbl">${YL[yk]} →</text>`;
  const placed = [];
  const sorted = pts.slice().sort((a, b) => b.hc_end - a.hc_end);
  for (const p of sorted) {
    const cx = X(p[xk]), cy = Y(yk === "rot" ? -p.rot : p[yk]);
    const r = Math.max(4, Math.min(14, 3 + Math.sqrt(p.hc_end) / 1.6));
    const t = tip(`<b>${esc(p.name)}</b> · ${esc(p.regions || "")}<br>${XL[xk]}: <b>${pct(p[xk])}</b><br>Dożycie 80 dni: <b>${pct(p.s80)}</b> (n=${p.n80}) · rotacja: <b>${pct1(p.rot)}</b><br>Pracuje: ${fN(p.hc_end)} · moduł Rozmowy: ${p.module_on ? "tak" : "nie"}`);
    s += p.module_on
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--accent)" fill-opacity=".85" stroke="var(--surface)" stroke-width="2"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    s += `<circle class="hit" data-tip="${t}" cx="${cx}" cy="${cy}" r="${Math.max(r + 4, 12)}" style="cursor:pointer" onclick="openCoord(${p.id})"/>`;
    // підпис лише якщо не налазить на інші
    const label = p.name.length > 18 ? p.name.slice(0, 17) + "…" : p.name;
    const lw = label.length * 5.2, lx = cx + r + 3, ly = cy + 3;
    const box2 = { x: lx, y: ly - 9, w: lw, h: 11 };
    const hit = placed.some((b) => !(box2.x > b.x + b.w || box2.x + box2.w < b.x || box2.y > b.y + b.h || box2.y + box2.h < b.y));
    if (!hit && lx + lw < W) { placed.push(box2); s += `<text x="${lx}" y="${ly}" class="lbl" style="pointer-events:none">${esc(label)}</text>`; }
  }
  s += `</svg>`;
  box.innerHTML = s + (miss ? `<div class="muted" style="font-size:11px;padding:0 0 4px 4px">Bez danych na wykresie: ${miss} (mało osób albo brak rozmów w okresie)</div>` : "");
}

function renderCompare() {
  const c = ST.compare;
  const box = document.getElementById("cmpBox");
  if (!c || !c.on.coords) {
    box.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:6px">Efekt modułu Rozmowy</div>
      <div class="muted" style="line-height:1.55">${ST.me.module_on
        ? "W tym zakresie nikt nie ma włączonego modułu — porównanie niedostępne."
        : "Moduł nie jest jeszcze nikomu włączony. Włączaj go falami — najpierw połowie koordynatorów z podobnymi obiektami — a tu po 6–8 tygodniach zobaczysz porównanie rotacji i dożycia 80 dni."}</div>`;
    return;
  }
  const row = (l, a, b, f) => `<tr><td>${l}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`;
  box.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:6px">Efekt modułu Rozmowy <span class="muted" style="font-weight:400">— orientacyjnie</span></div>
    <table><thead><tr><th></th><th>włączony</th><th>wyłączony</th></tr></thead><tbody>
      ${row("Koordynatorów", c.on.coords, c.off.coords, fN)}
      ${row("Pracowników (śr.)", c.on.hc, c.off.hc, fN)}
      ${row("Odejścia w okresie", c.on.dep, c.off.dep, fN)}
      ${row("Rotacja", c.on.rot, c.off.rot, pct1)}
      ${row("Dożycie 80 dni", c.on.s80, c.off.s80, pct)}
    </tbody></table>
    <div class="muted" style="margin-top:8px;line-height:1.5">Różne obiekty i różni ludzie — to nie jest dowód. Wiarygodne porównanie:
      włączać falami i patrzeć na podobne obiekty przed i po włączeniu.</div>`;
}

const COORD_COLS = [
  { k: "name", l: "Koordynator" }, { k: "regions", l: "Region" }, { k: "sites", l: "Obiekty", f: "n" },
  { k: "hc_end", l: "Pracuje", f: "n" }, { k: "dep", l: "Odejścia", f: "n" }, { k: "rot", l: "Rotacja", f: "pct1" },
  { k: "dep_early", l: "Przed 30. dniem", f: "n" }, { k: "s80", l: "Dożycie 80 (13 tyg.)", f: "pct" }, { k: "nnr", l: "NN", f: "pct1" },
  { k: "fill", l: "Godziny w bocie", f: "pct" }, { k: "risk_n", l: "Ryzyko", f: "n" },
  { k: "tasks", l: "Rozmowy", f: "n" }, { k: "ontime", l: "Na czas", f: "pct" }, { k: "noans", l: "Nie odebrał", f: "pct" },
  { k: "missed", l: "Pominięte", f: "n" }, { k: "spot", l: "„Nie było rozmowy”", f: "pct" }, { k: "c5", l: "Ocena 1–5 🔒", f: "dec" },
  { k: "svr", l: "Ankiety odp.", f: "pct" }, { k: "module_on", l: "Moduł", f: "mod" },
];
function fmt(v, f, row) {
  if (f === "n") return fN(v);
  if (f === "pct") return pct(v);
  if (f === "pct1") return pct1(v);
  if (f === "dec") return dec1(v);
  if (f === "d") return v ? ddy(v) : "";
  if (f === "mod") return v ? `<span class="tag on">włączony${row && row.enabled_at ? " " + dd(row.enabled_at) : ""}</span>` : `<span class="tag">wyłączony</span>`;
  return esc(v == null ? "" : v);
}
function sortRows(rows, key, dir) {
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y), "pl") * dir;
    return (x - y) * dir;
  });
}
function renderCoordTable() {
  const { key, dir } = ST.coordSort;
  const rows = sortRows(ST.cd || [], key, dir);
  if (!rows.length) { document.getElementById("coordTable").innerHTML = `<div class="empty">Brak koordynatorów w tym zakresie.</div>`; return; }
  const th = COORD_COLS.map((c) => `<th class="sort ${c.f && c.f !== "mod" ? "num" : ""}" onclick="sortCoords('${c.k}')">${esc(c.l)}${key === c.k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
  const td = (x) => COORD_COLS.map((c) => {
    let v = fmt(x[c.k], c.f, x);
    if (c.k === "spot" && x.spot_n) v = `<span class="${x.spot_no >= 2 ? "red" : ""}">${v}</span> <span class="muted">(${x.spot_no}/${x.spot_n})</span>`;
    if (c.k === "s80" && x.n80) v += ` <span class="muted">(${x.n80})</span>`;
    if (c.k === "name") v = `<b style="white-space:nowrap">${v}</b>${x.tg ? "" : ` <span class="tag" title="Brak Telegrama">bez TG</span>`}`;
    return `<td class="${c.f && c.f !== "mod" ? "num" : ""}">${v}</td>`;
  }).join("");
  document.getElementById("coordTable").innerHTML = `<table class="rg"><thead><tr>${th}</tr></thead><tbody>
    ${rows.map((x) => `<tr class="click" onclick="openCoord(${x.id})">${td(x)}</tr>`).join("")}</tbody></table>`;
}
function sortCoords(k) {
  const s = ST.coordSort;
  if (s.key === k) s.dir = -s.dir; else { s.key = k; s.dir = ["name", "regions"].includes(k) ? 1 : -1; }
  renderCoordTable();
}

async function openCoord(id) {
  const x = (ST.cd || []).find((c) => c.id === id);
  const name = x ? x.name : "Koordynator";
  const my = ++ST.dseq;
  const dw = openDrawerShell(name, x ? `${x.regions || "bez regionu"} · ${x.sites} ${pl(x.sites, "obiekt", "obiekty", "obiektów")} · moduł Rozmowy ${x.module_on ? "włączony" : "wyłączony"}` : "");
  const extra = { kind: "sites", coord: id };
  const r = await api("/detail" + qs(extra));
  if (!r || my !== ST.dseq) return;
  if (!r.ok) { dw.querySelector(".dw-body").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  const kp = x ? `<div class="vtiles" style="padding:0 0 12px">
      ${[["Pracuje", fN(x.hc_end)], ["Odejścia / rotacja", `${fN(x.dep)} · ${pct1(x.rot)}`], ["Dożycie 80 dni (13 tyg.)", pct(x.s80)],
         ["Godziny w bocie", pct(x.fill)], ["Rozmowy na czas", pct(x.ontime)], ["„Nie było rozmowy”", x.spot_n ? `${x.spot_no} z ${x.spot_n}` : "—"],
         ["Ocena od pracowników 🔒", dec1(x.c5)], ["W strefie ryzyka", fN(x.risk_n)]]
        .map(([l, v]) => `<div class="vt"><div class="l">${l}</div><div class="v" style="font-size:17px">${v}</div></div>`).join("")}
    </div>` : "";
  ST.drawer = { rows: r.rows, cols: DETAIL_COLS.sites, title: name, sort: null, total: r.total, extra };
  dw.querySelector(".dw-body").innerHTML = kp +
    `<div style="margin-bottom:10px"><button class="btn btn-primary btn-sm" data-name="${esc(name)}" onclick="setCoord(${id}, this.dataset.name)">Pokaż cały pulpit tylko dla ${esc(name)}</button></div>` +
    `<div class="section"><div class="section-head">Obiekty</div><div class="tblwrap" id="dwTable"></div></div>`;
  renderDrawerTable();
}

// ══════════════════════════════════════════════════════════════════════
//  Деталі (бокова панель)
// ══════════════════════════════════════════════════════════════════════
const REASON = { pay: "wypłata", housing: "mieszkanie", transport: "dojazd", work: "praca", schedule: "godziny/grafik",
  team: "zespół", other_job: "inna praca", family: "rodzina", documents: "dokumenty", other: "inne" };
const OUTCOME = { stays: "✅ zostaje", problem: "⚠️ problem", leaving: "🚪 chce odejść", no_answer: "📵 nie odebrał" };
const PROBLEM = { housing: "mieszkanie", money: "pieniądze", schedule: "grafik", team: "zespół", transport: "dojazd", other: "inne" };
const RISK_R = { assess_bad: "ocena 👎", assess_mid: "ocena 😐", survey: "ankieta", streak: "NN z rzędu", nn: "NN", gap: "dni bez godzin",
  drop: "spadek godzin", pre80: "przed 80. dniem", new: "nowy", site_red: "czerwony obiekt" };
const TASK_ST = { open: "otwarta", done: "zamknięta", missed: "pominięta", cancelled: "anulowana" };
const DETAIL_COLS = {
  departures: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" },
    { k: "start", l: "Start", f: "d" }, { k: "end", l: "Koniec", f: "d" }, { k: "tenure", l: "Staż, dni", f: "n" },
    { k: "reason", l: "Powód (ankieta)", f: "map", m: REASON }, { k: "last_talk", l: "Ostatnia rozmowa", f: "map", m: OUTCOME }],
  hires: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" },
    { k: "start", l: "Start", f: "d" }, { k: "now", l: "Teraz" }],
  rez: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" }, { k: "start", l: "Planowany start", f: "d" }],
  sites: [{ k: "site", l: "Obiekt", f: "site" }, { k: "region", l: "Region" }, { k: "coord", l: "Koordynator" },
    { k: "hc_start", l: "Na początku", f: "n" }, { k: "hc_end", l: "Na koniec", f: "n" }, { k: "hires", l: "Przyjęci", f: "n" },
    { k: "dep", l: "Odejścia", f: "n" }, { k: "early", l: "Przed 30. dniem", f: "n" }, { k: "rot", l: "Rotacja", f: "pct1" },
    { k: "nnr", l: "NN", f: "pct1" }, { k: "n80", l: "80. dzień w 13 tyg.", f: "n" }, { k: "s80", l: "Dożycie 80", f: "pct" }, { k: "risk_n", l: "Ryzyko", f: "n" }],
  nocoord: [{ k: "site", l: "Obiekt", f: "site" }, { k: "region", l: "Region" }, { k: "hc_end", l: "Pracuje", f: "n" }],
  risk: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" },
    { k: "tenure", l: "Staż", f: "n" }, { k: "score", l: "Bal", f: "n" }, { k: "reasons", l: "Sygnały", f: "risk" }, { k: "task", l: "Rozmowa", f: "map", m: TASK_ST }],
  leaving: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" },
    { k: "date", l: "Data", f: "d" }, { k: "problem", l: "Problem", f: "map", m: PROBLEM }, { k: "comment", l: "Komentarz" }, { k: "result", l: "Wynik", f: "leav" }],
  s80: [{ k: "name", l: "Pracownik" }, { k: "login", l: "ID" }, { k: "site", l: "Obiekt", f: "site" }, { k: "coord", l: "Koordynator" },
    { k: "start", l: "Start", f: "d" }, { k: "day80", l: "80. dzień", f: "d" }, { k: "reached", l: "Doszedł?" }],
};
DETAIL_COLS.early = DETAIL_COLS.departures;
DETAIL_COLS.leaving7 = DETAIL_COLS.leaving;

function openDrawerShell(title, sub) {
  ST.drawer = null;   // CSV nie może wyeksportować poprzedniej listy
  const dw = document.getElementById("drawer");
  dw.innerHTML = `<div class="dw-head"><div><h2>${esc(title)}</h2><div class="sub" id="dwSub">${esc(sub || "")}</div></div>
      <div class="dw-tools"><span class="form-msg muted" id="csvMsg" style="font-size:11px"></span>
      <button class="btn btn-ghost btn-sm" onclick="exportCsv()">⬇ CSV</button>
      <button class="dw-close" onclick="closeDrawer()" aria-label="Zamknij">✕</button></div></div>
    <div class="dw-body"><div class="loading">Ładowanie…</div></div>`;
  dw.classList.add("open"); dw.setAttribute("aria-hidden", "false");
  document.getElementById("drawerBg").classList.add("open");
  return dw;
}
function closeDrawer() {
  ST.dseq++;
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
  document.getElementById("drawerBg").classList.remove("open");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

async function openDetail(kind, title, extra, sortKey) {
  const my = ++ST.dseq;
  const dw = openDrawerShell(title, "");
  const ex = Object.assign({ kind }, extra || {});
  const r = await api("/detail" + qs(ex));
  if (!r || my !== ST.dseq) return;
  if (!r.ok) { dw.querySelector(".dw-body").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  if (!["risk", "nocoord", "leaving7"].includes(kind)) document.getElementById("dwSub").textContent = `${dd(r.from)}–${ddy(r.anchor)}`;
  const k = kind === "early_now" ? "early" : kind;
  ST.drawer = { rows: r.rows, cols: DETAIL_COLS[k], title, sort: sortKey ? { key: sortKey, dir: -1 } : null, total: r.total, extra: ex };
  const cut = r.total > r.rows.length;
  dw.querySelector(".dw-body").innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">${cut
      ? `Pokazano ${fN(r.rows.length)} z ${fN(r.total)} — sortowanie dotyczy pokazanych, CSV pobiera wszystkie`
      : `${fN(r.total)} ${pl(r.total, "pozycja", "pozycje", "pozycji")}`}</div>
    <div class="section"><div class="tblwrap" id="dwTable"></div></div>` +
    (kind === "risk" && ST.me.links.rozmowy ? `<div class="muted" style="font-size:11px">Pełna lista z filtrami — <a class="linkbtn" href="rozmowy.html#risk">Rozmowy → Ryzyko</a>.</div>` : "");
  renderDrawerTable();
}
function showDrawer(title, sub, cols, rows) {
  const dw = openDrawerShell(title, sub);
  ST.drawer = { rows, cols, title, sort: null, total: rows.length };
  dw.querySelector(".dw-body").innerHTML = `<div class="section"><div class="tblwrap" id="dwTable"></div></div>`;
  renderDrawerTable();
}
const riskText = (v) => String(v || "").split(" ").filter(Boolean)
  .map((x) => { const [k, n] = x.split(":"); return (RISK_R[k] || k) + (n && k !== "pre80" && k !== "new" ? " " + n : ""); }).join(", ");
const leavText = (v, row) => (v ? v : row.pending ? "czekamy 30 dni" : "został");
function dfmt(v, c, row) {
  switch (c.f) {
    case "site":
      if (!v) return "";
      return ST.me.links.region
        ? `<a class="linkbtn" style="font-size:12px" data-site="${esc(v)}" onclick="event.stopPropagation();siteLink(this.dataset.site)">${esc(v)}</a>`
        : esc(v);
    case "map": return v ? esc(c.m[v] || v) : `<span class="muted">—</span>`;
    case "risk": return esc(riskText(v));
    case "leav": return v ? `<span class="red">${esc(v)}</span>` : row.pending ? `<span class="muted">czekamy 30 dni</span>` : `<span class="green">został</span>`;
    case "dec": return dec1(v);
    default: return fmt(v, c.f);
  }
}
function viewRows(d, rows) {
  return d.sort ? sortRows(rows.map((r) => Object.assign({}, r, numify(r, d.cols))), d.sort.key, d.sort.dir) : rows;
}
function renderDrawerTable() {
  const d = ST.drawer;
  const el = document.getElementById("dwTable");
  if (!el || !d) return;
  if (!d.rows.length) { el.innerHTML = `<div class="empty">Brak pozycji.</div>`; return; }
  const rows = viewRows(d, d.rows);
  const num = (c) => ["n", "pct", "pct1", "dec"].includes(c.f);
  el.innerHTML = `<table class="rg"><thead><tr>${d.cols.map((c) => `<th class="sort ${num(c) ? "num" : ""}" onclick="sortDrawer('${c.k}')">${esc(c.l)}${d.sort && d.sort.key === c.k ? (d.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${d.cols.map((c) => `<td class="${num(c) ? "num" : ""}">${dfmt(r[c.k], c, r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function numify(r, cols) {
  const o = {};
  cols.forEach((c) => { if (["n", "pct", "pct1", "dec"].includes(c.f) && r[c.k] != null) o[c.k] = Number(r[c.k]); });
  return o;
}
function sortDrawer(k) {
  const d = ST.drawer;
  if (!d) return;
  d.sort = d.sort && d.sort.key === k ? { key: k, dir: -d.sort.dir } : { key: k, dir: 1 };
  renderDrawerTable();
}
async function exportCsv() {
  const d = ST.drawer;
  const msg = document.getElementById("csvMsg");
  if (!d || !d.rows.length) { if (msg) msg.textContent = "Brak danych do eksportu"; return; }
  let rows = d.rows;
  if (d.total > d.rows.length && d.extra) {
    if (msg) msg.textContent = "Pobieram wszystkie…";
    const r = await api("/detail" + qs(Object.assign({}, d.extra, { limit: 20000 })));
    if (!r || !r.ok || ST.drawer !== d) { if (msg) msg.textContent = r && r.error ? r.error : ""; return; }
    rows = r.rows;
  }
  // Excel: tekst zaczynający się od = + - @ nie może stać się formułą
  const safe = (s) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);
  const q = (v) => { const s = safe(v == null ? "" : String(v)); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [d.cols.map((c) => q(c.l)).join(";")];
  viewRows(d, rows).forEach((r) => lines.push(d.cols.map((c) => {
    let v = r[c.k];
    if (c.f === "map" && v) v = c.m[v] || v;
    else if (c.f === "risk") v = riskText(v);
    else if (c.f === "leav") v = leavText(v, r);
    else if ((c.f === "pct" || c.f === "pct1") && v != null) v = String((Number(v) * 100).toFixed(1)).replace(".", ",");
    else if (c.f === "dec" && v != null) v = String(Number(v).toFixed(2)).replace(".", ",");
    return q(v);
  }).join(";")));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (d.title || "dane").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60) + ".csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  if (msg) msg.textContent = `${fN(rows.length)} wierszy`;
}
