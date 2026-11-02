// ══════════════════════════════════════════════════════════════════════
//  Sekcja «Premie koordynatorów»: blok A (dożycie) + blok B (rdzeń) za miesiąc,
//  lista koordynatorów i k-t, wykluczenia pracowników, parametry, dostęp, zatwierdzanie, Excel.
//  API: /api/premie (api/premie.js), wyliczenie: bot/premie.js, opis: docs/PREMIE.md.
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  me: null, months: [], today: null, month: null, view: "month",
  data: null, can: {}, sort: null, dw: null, dwFilter: "all", dwQ: "",
  coords: null, edit: null, exclusions: null, params: null, pedit: null, log: null, accQ: "",
};

// ── Narzędzia ─────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const MONTHS_PL = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];
const mname = (m) => (m ? `${MONTHS_PL[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}` : "");
const ym = (m) => (m ? `${m.slice(5, 7)}.${m.slice(0, 4)}` : "");
const dd = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const ddy = (iso) => (iso ? `${dd(iso)}.${iso.slice(0, 4)}` : "");
function ts(x) {
  if (!x) return "";
  const d = new Date(x);
  if (isNaN(d)) return String(x);
  return d.toLocaleString("pl-PL", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const zl = (v) => (v == null ? "—" : `${Number(v).toLocaleString("pl-PL", { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 })} zł`);
const pc = (x, d = 1) => (x == null ? "—" : `${(x * 100).toLocaleString("pl-PL", { maximumFractionDigits: d })}%`);
const num = (v) => Number(v || 0).toLocaleString("pl-PL");
const tag = (txt, cls, title) => `<span class="tag ${cls || ""}"${title ? ` title="${esc(title)}"` : ""}>${esc(txt)}</span>`;
const stepCls = (p) => (p >= 1 ? "s2" : p > 0 ? "s1" : "s0");
const step = (p) => `<span class="step ${stepCls(p)}">${pc(p, 0)}</span>`;
function addMonths(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + mo - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* prywatne okno */ } },
};

async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  try {
    const r = await fetch("/api/premie" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
function flash(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "msg " + (ok ? "ok" : "err");
  el.textContent = text;
  if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

// ── Słowniki ──────────────────────────────────────────────────────────
const BASIS = { own: "własne obiekty", region: "region", as: "jak inny koordynator" };
const LEVELS = {
  own: ["👁 Moja premia", "Bloki, procenty, kwota i postęp bieżącego miesiąca; regionalny — także koordynatorzy swojego regionu"],
  people: ["🔍 + Ludzie", "Do tego lista pracowników: kto zaliczony, kto nie dotrwał i dlaczego"],
  excl: ["✋ + Wykluczenia", "Do tego wykluczanie pracowników ze swoich obiektów (z przyczyną)"],
};
const STATUS_PL = { pracuje: "pracuje", zwolniony: "zwolniony", przeniesiony: "przeniesiony", urlop: "urlop", rezygnacja: "rezygnacja",
  l4: "L4", unknown: "nieznany", do_zatrudnienia: "do zatrudnienia" };
const ACTION_PL = { params: "Parametry", params_delete: "Usunięto zestaw parametrów", coords: "Lista koordynatorów", excl_add: "Wykluczenie",
  excl_remove: "Przywrócenie", access: "Dostęp", approve: "Zatwierdzenie", unapprove: "Cofnięcie zatwierdzenia", paid: "Wypłata",
  unpaid: "Cofnięcie wypłaty", notify: "Telegram", settings: "Ustawienia" };
const basisText = (p) => (p.basis === "as" ? `jak ${p.as_name || "?"}` : p.basis === "region" ? `region${p.region ? " " + p.region : ""}` : "własne obiekty");

// ══════════════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════════════
async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || CURRENT_USER.username || "";
  const me = await api("/me");
  if (!me || !me.ok || !me.has_access) {
    document.getElementById("monthBar").style.display = "none";
    document.getElementById("content").innerHTML = `<div class="noaccess">🔒 <b>Brak dostępu do premii koordynatorów.</b><br>
      ${esc(me && me.error ? me.error : "Dostęp włącza administrator lub kierownik działu w sekcji Premie → Dostęp.")}</div>`;
    return;
  }
  ST.me = me;
  if (me.full) ["navCoords", "navAccess", "navLog"].forEach((id) => { document.getElementById(id).style.display = ""; });
  if (me.full || me.level === "excl" || me.level === "people") document.getElementById("navExcl").style.display = "";
  document.getElementById("navParams").innerHTML = me.full ? "⚙️ Parametry" : "📖 Jak liczymy";
  const ms = await api("/months");
  if (!ms || !ms.ok) return showError(ms);
  ST.months = ms.data;
  ST.today = ms.today;
  const h = new URLSearchParams(location.hash.slice(1));
  const cur = ms.today.slice(0, 7);
  const prev = addMonths(cur, -1);
  const def = me.full && ms.data.some((x) => x.month === prev) ? prev : cur;
  ST.month = ms.data.some((x) => x.month === h.get("m")) ? h.get("m") : def;
  ST.view = ["month", "coords", "excl", "params", "access", "log"].includes(h.get("v")) ? h.get("v") : "month";
  fillMonths();
  showView(ST.view);
}
function showError(r) {
  document.getElementById("content").innerHTML = `<div class="error">${esc((r && r.error) || "Błąd połączenia")}</div>`;
}
function fillMonths() {
  const sel = document.getElementById("selMonth");
  const lbl = { live: " · trwa", draft: " · roboczy", approved: " · ✅", paid: " · 💸" };
  sel.innerHTML = ST.months.map((x) => `<option value="${x.month}">${mname(x.month)}${lbl[x.status] || ""}</option>`).join("");
  sel.value = ST.month;
}
function syncHash() {
  history.replaceState(null, "", `#v=${ST.view}&m=${ST.month}`);
}
function setMonth(m) {
  ST.month = m;
  ST.data = null; ST.exclusions = null; ST.edit = null; ST.params = null; ST.pedit = null;
  document.getElementById("selMonth").value = m;
  closeDrawer();
  showView(ST.view);
}
function stepMonth(d) {
  const i = ST.months.findIndex((x) => x.month === ST.month);
  const n = ST.months[i - d];               // lista od najnowszego
  if (n) setMonth(n.month);
}
function showView(v) {
  ST.view = v;
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.querySelectorAll(".pv").forEach((el) => el.classList.toggle("active", el.id === `view-${v}`));
  document.getElementById("monthBar").style.display = v === "access" || v === "log" ? "none" : "";
  syncHash();
  if (v === "month") loadMonth();
  else if (v === "coords") loadCoords();
  else if (v === "excl") loadExclusions();
  else if (v === "params") loadParams();
  else if (v === "access") loadAccess();
  else if (v === "log") loadLog();
}

// ══════════════════════════════════════════════════════════════════════
//  Miesiąc
// ══════════════════════════════════════════════════════════════════════
async function getMonthData(force) {
  if (ST.data && ST.data.month === ST.month && !force) return ST.data;
  const r = await api(`/month/${ST.month}`);
  if (!r || !r.ok) { showError(r); return null; }
  ST.data = r.data;
  ST.can = r.can;
  return ST.data;
}
async function loadMonth(force) {
  if (!ST.data || force) document.getElementById("partTable").innerHTML = '<div class="loading">Liczę premie…</div>';
  const d = await getMonthData(force);
  if (!d) return;
  renderMonth();
}
function statusPill(d) {
  if (d.run) return d.run.status === "paid" ? '<span class="pill paid">💸 wypłacony</span>' : '<span class="pill ok">✅ zatwierdzony</span>';
  if (d.live) return `<span class="pill live">⏳ trwa · stan na ${dd(d.end)}</span>`;
  return '<span class="pill draft">✏️ wersja robocza</span>';
}
// Sumy po obiektach (bez podwójnego liczenia regionów i «jak u»)
function totals(d) {
  const t = { kadr: 0, core: 0, poss: 0, ach: 0, dep: 0, upN: 0, upKeep: 0 };
  d.sites.forEach((s) => { t.kadr += s.kadr; t.core += s.core; t.poss += s.poss; t.ach += s.ach; t.dep += s.dep; t.upN += s.upN || 0; t.upKeep += s.upKeep || 0; });
  return t;
}
function renderMonth() {
  const d = ST.data;
  const P = d.params;
  document.getElementById("monthPill").innerHTML = statusPill(d);
  // ── banery
  const b = [];
  if (d.run) {
    let t = `✅ <b>Zatwierdzony ${ts(d.run.approved_at)}</b>${d.run.approved_by_name ? " — " + esc(d.run.approved_by_name) : ""}. ` +
      "Wynik jest zamrożony: późniejsze zmiany w danych, wykluczeniach i parametrach go nie zmieniają.";
    if (d.run.status === "paid") t += `<br>💸 <b>Wypłacony ${ts(d.run.paid_at)}</b>${d.run.paid_by_name ? " — " + esc(d.run.paid_by_name) : ""}.`;
    if (d.run.notified_at) t += `<br>✉️ Wynik wysłany koordynatorom w Telegramie ${ts(d.run.notified_at)} (${d.run.notified_n || 0}).`;
    b.push(`<div class="banner ok">${t}</div>`);
  } else if (d.live) {
    b.push(`<div class="banner info">⏳ <b>Bieżący miesiąc — stan na ${ddy(d.end)}.</b> Wynik zmienia się każdego dnia. ` +
      `Progi, które wypadną do końca miesiąca, są oznaczone ⏳ — ich pracowników warto utrzymać. ` +
      `Zatwierdzić miesiąc można od ${ddy(addMonths(d.month, 1) + "-01")}.</div>`);
  } else if (ST.me.full) {
    b.push(`<div class="banner warn">✏️ <b>Wersja robocza</b> — liczona na bieżąco z bazy. Sprawdź listę, k-t i wykluczenia, potem zatwierdź miesiąc.</div>`);
  }
  if (ST.me.full && !d.run && d.config_from && d.config_from !== d.month)
    b.push(`<div class="banner">Lista koordynatorów odziedziczona z <b>${ym(d.config_from)}</b>. Zmiany w zakładce
      <a href="#" onclick="showView('coords');return false">👥 Koordynatorzy</a> zapiszą listę dla ${ym(d.month)}.</div>`);
  if (ST.me.full && d.uncovered && d.uncovered.length) {
    const list = d.uncovered.slice(0, 8).map((u) => `${esc(u.key)}${u.owner ? " (" + esc(u.owner) + ")" : " (bez koordynatora)"}`).join(", ");
    b.push(`<div class="banner warn">⚠️ <b>${d.uncovered.length} obiekt(ów) z ludźmi nikt nie liczy:</b> ${list}${d.uncovered.length > 8 ? "…" : ""}
      <a class="act" href="#" onclick="showView('coords');return false">Uzupełnij listę →</a></div>`);
  }
  if (!ST.me.full && !d.participants.some((p) => p.id === ST.me.me) && !ST.me.lead)
    b.push(`<div class="banner">Nie ma Cię na liście premii za ${ym(d.month)}.</div>`);
  document.getElementById("monthBanners").innerHTML = b.join("");
  document.getElementById("badgeUnc").textContent = ST.me.full && d.uncovered && d.uncovered.length ? d.uncovered.length : "";

  // ── KPI
  const t = totals(d);
  const vA = t.poss ? t.ach / t.poss : null;
  const vB = t.kadr ? t.core / t.kadr : null;
  const withBonus = d.participants.filter((p) => p.total > 0).length;
  const sk = d.skipped || { status: {}, reason: {}, manual: 0 };
  const nSkip = Object.values(sk.status).reduce((a, x) => a + x, 0) + Object.values(sk.reason).reduce((a, x) => a + x, 0) + (sk.manual || 0);
  const k = [
    d.range
      ? `<div class="kpi hero" title="min — nikt z progami do końca miesiąca nie dotrwa; max — wszyscy zostaną i wejdą do rdzenia">
          <div class="l">Premie razem — na koniec miesiąca</div><div class="v" style="font-size:19px">${zl(d.range.min)} – ${zl(d.range.max)}</div>
          <div class="s">przedział; ostateczna kwota — po zakończeniu miesiąca</div></div>`
      : `<div class="kpi hero"><div class="l">Premie razem</div><div class="v">${zl(d.total)}</div>
          <div class="s">${withBonus} z ${d.participants.length} koordynatorów z premią</div></div>`,
    `<div class="kpi"><div class="l">Blok A — wykonanie</div><div class="v">${pc(vA)}</div>
      <div class="s">zdobyte ${num(t.ach)} z ${num(t.poss)} wag</div></div>`,
    `<div class="kpi"><div class="l">Blok B — rdzeń</div><div class="v">${pc(vB)}</div>
      <div class="s">${num(t.core)} z ${num(t.kadr)} osób ze stażem ≥ ${P.core_days} dni</div></div>`,
    `<div class="kpi"><div class="l">Kadr na ${dd(d.end)}</div><div class="v">${num(t.kadr)}</div>
      <div class="s">odejścia w miesiącu: ${num(t.dep)}</div></div>`,
  ];
  if (d.live) k.push(`<div class="kpi"><div class="l">⏳ Do utrzymania</div><div class="v">${num(t.upN)} <small>os.</small></div>
      <div class="s">progi do końca miesiąca · wagi ${num(t.upKeep)}</div></div>`);
  k.push(`<div class="kpi"><div class="l">Pominięci</div><div class="v">${num(nSkip)}</div>
      <div class="s">statusy, przyczyny, wykluczeni</div></div>`);
  document.getElementById("monthKpis").innerHTML = k.join("");

  // ── akcje
  const a = [];
  if (ST.can.approve) a.push(`<button class="btn btn-ok btn-sm" onclick="approveMonth()">✅ Zatwierdź miesiąc</button>`);
  if (ST.can.unapprove) a.push(`<button class="btn btn-ghost btn-sm" onclick="unapproveMonth()">↩️ Cofnij zatwierdzenie</button>`);
  if (ST.can.pay && d.run && d.run.status === "approved") a.push(`<button class="btn btn-primary btn-sm" onclick="markPaid(true)">💸 Oznacz jako wypłacony</button>`);
  if (ST.can.unpay) a.push(`<button class="btn btn-ghost btn-sm" onclick="markPaid(false)">↩️ Cofnij wypłatę</button>`);
  if (ST.can.notify) a.push(`<button class="btn btn-ghost btn-sm" onclick="notifyMonth()">✉️ ${d.run.notified_at ? "Wyślij ponownie" : "Wyślij w Telegramie"}</button>`);
  a.push('<span class="msg" id="monthMsg"></span>');
  document.getElementById("monthActions").innerHTML = a.join(" ");
  renderParts();
  renderSites();
}

const PART_COLS = [
  ["name", "Koordynator", "l"], ["n_sites", "Obiekty"], ["kadr", "Kadr"], ["dep", "Odejścia"],
  ["poss", "Wagi zdob./możl.", "sep"], ["vyp", "Wykonanie"], ["pct_a", "Skala A"], ["a", "Blok A"],
  ["core", "Rdzeń", "sep"], ["share", "Udział"], ["pct_b", "Skala B"], ["b", "Blok B"],
  ["kt", "k-t", "sep"], ["total", "Premia"],
];
function sortParts(list) {
  if (!ST.sort) return list;
  const { key, dir } = ST.sort;
  return [...list].sort((x, y) => {
    const a = x[key], b = y[key];
    if (typeof a === "string" || typeof b === "string") return dir * String(a || "").localeCompare(String(b || ""), "pl");
    return dir * ((a == null ? -Infinity : a) - (b == null ? -Infinity : b));
  });
}
function sortBy(key) {
  ST.sort = ST.sort && ST.sort.key === key ? (ST.sort.dir === -1 ? { key, dir: 1 } : null) : { key, dir: key === "name" ? 1 : -1 };
  renderParts();
}
function renderParts() {
  const d = ST.data;
  const box = document.getElementById("partTable");
  document.getElementById("partCnt").textContent = `${d.participants.length} koordynatorów · ${mname(d.month)}`;
  if (!d.participants.length) {
    box.innerHTML = `<div class="empty">${ST.me.full ? "Lista koordynatorów na ten miesiąc jest pusta — dodaj ich w zakładce 👥 Koordynatorzy." : "Brak danych do pokazania."}</div>`;
    return;
  }
  const showPen = d.params.penalty.enabled || d.participants.some((p) => p.pen);
  const cols = PART_COLS.filter((c) => c[0] !== "pen");
  if (showPen) cols.splice(8, 0, ["pen", "Kary"]);
  const arrow = (k) => (ST.sort && ST.sort.key === k ? (ST.sort.dir === 1 ? " ▲" : " ▼") : "");
  let h = `<table class="pt"><thead><tr>${cols.map(([k, l, c]) => `<th class="${c || ""}" data-k="${k}" onclick="sortBy('${k}')">${l}${arrow(k)}</th>`).join("")}</tr></thead><tbody>`;
  let region = null;
  for (const p of sortParts(d.participants)) {
    if (!ST.sort && p.region !== region) {
      region = p.region;
      h += `<tr><td class="l" colspan="${cols.length}" style="background:var(--bg);font-size:10px;letter-spacing:.8px;color:var(--text3);text-transform:uppercase;font-family:var(--mono)">${esc(region || "bez regionu")}</td></tr>`;
    }
    const tags = [];
    if (p.basis !== "own") tags.push(tag(basisText(p), p.basis === "region" ? "pur" : "acc"));
    if (!p.active) tags.push(tag("nieaktywny", "bad"));
    if (p.n_sites === 0) tags.push(tag("brak ludzi", "warn", "Na obiektach nie ma kadru — premii nie ma (jak w Excelu)"));
    const lv = p.live;
    const upTo = (v) => `<span title="Maks. na koniec miesiąca, jeśli wszyscy z progami zostaną">do ${zl(v)}</span>`;
    h += `<tr class="rowlink${p.kt === 0 ? " off" : ""}" onclick="openPart(${p.id})">
      <td class="l"><b>${esc(p.name)}</b> ${tags.join("")}${p.note ? `<div class="sub">${esc(p.note)}</div>` : ""}</td>
      <td>${p.n_sites}</td><td>${num(p.kadr)}</td><td>${num(p.dep)}</td>
      <td class="sep">${num(p.ach)} / ${num(p.poss)}</td><td>${pc(p.vyp)}</td><td>${step(p.pct_a)}</td><td>${lv ? upTo(lv.a_max) : zl(p.a)}</td>
      ${showPen ? `<td class="${p.pen ? "bad" : "z"}">${p.pen ? zl(p.pen) : "—"}</td>` : ""}
      <td class="sep">${num(p.core)}</td><td>${pc(p.share)}</td><td>${step(p.pct_b)}</td><td>${lv ? upTo(lv.b_max) : zl(p.b)}</td>
      <td class="sep">${String(p.kt).replace(".", ",")}</td>
      <td class="big">${lv ? `<span title="min — nikt z progami nie dotrwa · max — wszyscy zostaną">${zl(lv.total_min)} – ${zl(lv.total_max)}</span>` : zl(p.total)}</td>
    </tr>`;
  }
  h += `<tr class="tot"><td class="l">Razem</td><td colspan="${cols.length - 2}"></td>
    <td class="big">${d.range ? `${zl(d.range.min)} – ${zl(d.range.max)}` : zl(d.total)}</td></tr></tbody></table>`;
  box.innerHTML = h;
  const P = d.params;
  document.getElementById("partNote").innerHTML = (d.live
    ? `Bieżący miesiąc: procenty — stan na ${dd(d.end)}; kwoty — przedział na koniec miesiąca (min: nikt z progami do końca miesiąca nie dotrwa,
       max: wszyscy zostaną). `
    : "") + `Premia = (blok A + blok B) × k-t, maksymalnie ${zl(P.max_bonus)}. Blok A — do ${zl(P.limit_a)}: wykonanie = zdobyte ÷ możliwe wagi progów
     ${P.thresholds.map((x) => `${x.days} dni (waga ${String(x.weight).replace(".", ",")})`).join(" i ")}. Blok B — do ${zl(P.limit_b)}: udział osób
     ze stażem ≥ ${P.core_days} dni w kadrze na koniec miesiąca. Parametry od ${ym(d.params_from) || "—"} ·
     <a href="#" onclick="showView('params');return false" style="color:var(--accent)">jak liczymy</a>. Kliknij wiersz — szczegóły i ludzie.`;
}
function renderSites() {
  const d = ST.data;
  if (!d) return;
  const q = (document.getElementById("fSite").value || "").trim().toLowerCase();
  const list = d.sites.filter((s) => (s.kadr || s.poss || s.dep || s.n) &&
    (!q || `${s.key} ${s.owner || ""} ${(s.facilities || []).join(" ")} ${s.region || ""}`.toLowerCase().includes(q)));
  document.getElementById("siteCnt").textContent = `${list.length}`;
  document.getElementById("sitesSection").style.display = d.sites.length ? "" : "none";
  if (!list.length) { document.getElementById("siteTable").innerHTML = '<div class="empty">Brak obiektów.</div>'; return; }
  document.getElementById("siteTable").innerHTML = sitesTable(list, d.live);
}
function sitesTable(list, live) {
  let h = `<table class="pt"><thead><tr><th class="l">Obiekt</th><th class="l">Koordynator</th><th class="l">Region</th><th>Kadr</th><th>Odejścia</th>
    <th class="sep">Wagi zdob./możl.</th><th>Wykonanie</th><th class="sep">Rdzeń</th><th>Udział</th>${live ? '<th class="sep">⏳ Wagi</th>' : ""}</tr></thead><tbody>`;
  for (const s of list) {
    h += `<tr><td class="l"><b>${esc(s.key)}</b>${s.facilities && s.facilities.length ? `<div class="sub">${esc(s.facilities.join(" · "))}</div>` : ""}</td>
      <td class="l">${s.owner ? esc(s.owner) : '<span class="bad">— brak</span>'}</td><td class="l">${esc(s.region || "—")}</td>
      <td>${num(s.kadr)}</td><td>${num(s.dep)}</td>
      <td class="sep">${num(s.ach)} / ${num(s.poss)}</td><td>${s.vyp == null ? '<span class="z">—</span>' : pc(s.vyp)}</td>
      <td class="sep">${num(s.core)}</td><td>${s.share == null ? '<span class="z">—</span>' : pc(s.share)}</td>
      ${live ? `<td class="sep">${s.upKeep ? num(s.upKeep) : '<span class="z">—</span>'}</td>` : ""}</tr>`;
  }
  return h + "</tbody></table>";
}

// ── Zatwierdzanie, wypłata, Telegram ─────────────────────────────────
async function approveMonth() {
  const d = ST.data;
  if (!confirm(`Zatwierdzić premie za ${mname(d.month)}?\n\nRazem: ${zl(d.total)} · ${d.participants.length} koordynatorów.\n` +
    "Wynik zostanie zamrożony — późniejsze zmiany danych go nie zmienią.")) return;
  flash("monthMsg", "Zatwierdzam…", true);
  const r = await api(`/month/${d.month}/approve`, { method: "POST" });
  if (!r || !r.ok) return flash("monthMsg", (r && r.error) || "Błąd", false);
  let msg = `Zatwierdzono: ${zl(r.total)}`;
  if (r.notified) msg += r.notified.ok ? ` · Telegram: wysłano ${r.notified.sent}` : ` · Telegram: ${r.notified.error}`;
  await refreshMonths();
  await loadMonth(true);
  flash("monthMsg", msg, true);
}
async function unapproveMonth() {
  if (!confirm(`Cofnąć zatwierdzenie ${mname(ST.data.month)}? Miesiąc znów będzie liczony na bieżąco z bazy.`)) return;
  const r = await api(`/month/${ST.data.month}/unapprove`, { method: "POST" });
  if (!r || !r.ok) return flash("monthMsg", (r && r.error) || "Błąd", false);
  await refreshMonths();
  await loadMonth(true);
}
async function markPaid(paid) {
  if (!confirm(paid ? `Oznaczyć premie za ${mname(ST.data.month)} jako wypłacone?` : "Cofnąć oznaczenie wypłaty?")) return;
  const r = await api(`/month/${ST.data.month}/paid`, { method: "POST", body: { paid } });
  if (!r || !r.ok) return flash("monthMsg", (r && r.error) || "Błąd", false);
  await refreshMonths();
  await loadMonth(true);
}
async function notifyMonth() {
  const again = !!ST.data.run.notified_at;
  if (!confirm(again ? "Wynik już wysłano. Wysłać jeszcze raz wszystkim koordynatorom z premią?"
    : "Wysłać każdemu koordynatorowi z premią jego wynik w Telegramie?")) return;
  const r = await api(`/month/${ST.data.month}/notify`, { method: "POST", body: { force: again } });
  if (!r || !r.ok) return flash("monthMsg", (r && r.error) || "Błąd", false);
  await loadMonth(true);
  flash("monthMsg", `Wysłano: ${r.sent}${r.no_tg ? ` · bez Telegramu: ${r.no_tg}` : ""}${r.failed ? ` · błędy: ${r.failed}` : ""}`, !r.failed);
}
async function refreshMonths() {
  const ms = await api("/months");
  if (ms && ms.ok) { ST.months = ms.data; fillMonths(); }
}

// ══════════════════════════════════════════════════════════════════════
//  Szuflada: koordynator — bloki, obiekty, ludzie
// ══════════════════════════════════════════════════════════════════════
// Drabinka skali: każdy próg — osobny odcinek tej samej szerokości (zakres i wypłata), bieżący podświetlony;
// znacznik — dokładna wartość w swoim odcinku; przerywany zakres — gdzie może skończyć się miesiąc
function scaleBar(steps, value, limit, kt, range) {
  const st = [...steps].sort((a, b) => a.from - b.from).filter((s) => s.from > 0 && s.from < 1);
  const bnd = [0, ...st.map((s) => s.from), 1];
  const pays = [scaleLow(steps), ...st.map((s) => s.pct)];
  const n = bnd.length - 1;
  const segOf = (v) => { let k = 0; while (k < n - 1 && v >= bnd[k + 1]) k++; return k; };
  const pos = (v) => {
    const x = Math.max(0, Math.min(1, v));
    const k = segOf(x);
    return ((k + (x - bnd[k]) / (bnd[k + 1] - bnd[k])) / n) * 100;
  };
  const cls = (p) => (p <= 0 ? "p0" : p < 0.5 ? "p1" : p < 1 ? "p2" : "p3");
  const cur = segOf(Math.max(0, Math.min(1, value)));
  const segs = pays.map((p, k) => `<div class="sg ${cls(p)}${k === cur ? " cur" : ""}" title="${pc(bnd[k], 0)}–${pc(bnd[k + 1], 0)} → ${pc(p, 0)} bloku">
      <span>${k === 0 ? `&lt; ${pc(bnd[1], 0)}` : `od ${pc(bnd[k], 0)}`}</span><b>${pc(p, 0)}</b><span class="zl">${zl(p * limit * kt)}</span></div>`).join("");
  const rng = range && range[1] > range[0] + 1e-9
    ? `<div class="range" style="left:${pos(range[0])}%;width:${pos(range[1]) - pos(range[0])}%" title="Do końca miesiąca: od ${pc(range[0])} do ${pc(range[1])}"></div>` : "";
  return `<div class="ladder">${rng}<div class="mk" style="left:${pos(value)}%">${pc(value)}</div><div class="sgs">${segs}</div></div>`;
}
// Wypłata poniżej najniższego progu (zwykle 0; próg «od 0%» — jego wartość)
function scaleLow(steps) {
  const z = steps.find((s) => s.from <= 0);
  return z ? z.pct : 0;
}
// Ile brakuje do następnego progu skali: n jednostek (wag / osób) przy mianowniku den
function nextStep(steps, value, have, den) {
  const nx = [...steps].sort((a, b) => a.from - b.from).find((s) => s.from > value + 1e-12);
  if (!nx || !den) return null;
  return { step: nx, need: Math.max(1, Math.ceil(nx.from * den - have - 1e-9)) };
}
function openPart(id) {
  ST.dw = id;
  ST.dwFilter = "all";
  ST.dwQ = "";
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawerBg").classList.add("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "false");
  renderDrawer();
}
function closeDrawer() {
  ST.dw = null;
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawerBg").classList.remove("open");
  document.getElementById("drawer").setAttribute("aria-hidden", "true");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeDrawer(); } });

function renderDrawer() {
  const d = ST.data;
  const p = d && d.participants.find((x) => x.id === ST.dw);
  if (!p) return closeDrawer();
  const P = d.params;
  const past = !d.live;
  const lv = p.live;
  // ── blok A
  const nA = nextStep(P.scale_a, p.vyp, p.ach, p.poss);
  let hintA = "";
  if (!p.poss) hintA = "W tym miesiącu nikt nie miał progu stażu — wykonanie 0%, blok A = 0 (jak w Excelu).";
  else if (nA) hintA = `Do progu ${pc(nA.step.from, 0)} (${pc(nA.step.pct, 0)} bloku = ${zl(nA.step.pct * P.limit_a * p.kt)}) ${past ? "zabrakło" : "brakuje"} <b>${nA.need}</b> wag.`;
  else hintA = "Najwyższy próg skali osiągnięty. 🎉";
  if (lv && (lv.up_keep || lv.up_lost)) {
    hintA += `<br>⏳ Do końca miesiąca progi ma jeszcze <b>${lv.up_n}</b> os. (wagi ${lv.up_keep})` +
      (lv.up_lost ? `, a ${lv.up_lost} wag już przepadnie (odeszli przed progiem)` : "") +
      `. Jeśli wszyscy zostaną: wykonanie ${pc(lv.vyp_max)} → ${pc(lv.pct_a_max, 0)} bloku.`;
  }
  // ── blok B
  const nB = nextStep(P.scale_b, p.share, p.core, p.kadr);
  let hintB = "";
  if (!p.kadr) hintB = "Brak kadru na koniec miesiąca.";
  else if (nB) hintB = `Do progu ${pc(nB.step.from, 0)} (${pc(nB.step.pct, 0)} bloku = ${zl(nB.step.pct * P.limit_b * p.kt)}) ${past ? "zabrakło" : "brakuje"} <b>${nB.need}</b> os. w rdzeniu.`;
  else hintB = "Najwyższy próg skali osiągnięty. 🎉";
  if (lv && lv.core_up) hintB += `<br>⏳ Do końca miesiąca do rdzenia wejdzie jeszcze <b>${lv.core_up}</b> os., jeśli zostaną: udział ${pc(lv.share_max)} → ${pc(lv.pct_b_max, 0)} bloku.`;
  const ktTxt = p.kt !== 1 ? ` × k-t ${String(p.kt).replace(".", ",")}` : "";
  const basisLine = p.basis === "region" ? `Suma obiektów regionu${p.region ? " " + esc(p.region) : ""}`
    : p.basis === "as" ? `Liczone z obiektów: ${esc(p.as_name || "?")} (k-t własny)` : "Własne obiekty (główny koordynator)";
  let h = `<div class="dw-head">
      <div><h2>${esc(p.name)} ${!p.active ? tag("nieaktywny", "bad") : ""}</h2>
        <div class="sub">${basisLine} · ${p.n_sites} obiekt(ów) z kadrem · k-t ${String(p.kt).replace(".", ",")} · ${mname(d.month)}${d.live ? ` · stan na ${dd(d.end)}` : ""}</div>
        ${p.note ? `<div class="sub">📝 ${esc(p.note)}</div>` : ""}</div>
      <div class="tot">${lv
        ? `<div class="v" style="font-size:18px" title="min — nikt z progami nie dotrwa · max — wszyscy zostaną">${zl(lv.total_min)} – ${zl(lv.total_max)}</div>
           <div class="s">na koniec miesiąca · ostateczna po jego zakończeniu</div>`
        : `<div class="v">${zl(p.total)}</div><div class="s">maks. ${zl(P.max_bonus)}</div>`}</div>
      <button class="dw-close" onclick="closeDrawer()" title="Zamknij (Esc)">✕</button>
    </div><div class="dw-body">
    <div class="blocks">
      <div class="blk"><h3>Blok A — dożycie <span class="amt">${lv ? `${zl(lv.a_min)} – ${zl(lv.a_max)}` : zl(p.a)}</span></h3>
        <div class="big">Wykonanie${lv ? " na dziś" : ""} <b>${pc(p.vyp)}</b> → ${step(p.pct_a)} bloku${ktTxt} · zdobyte ${num(p.ach)} z ${num(p.poss)} wag</div>
        ${scaleBar(P.scale_a, p.vyp, P.limit_a, p.kt, lv ? [lv.vyp_min, lv.vyp_max] : null)}
        <div class="hint">${hintA}${p.pen ? `<br>Kary za wczesne odejścia: <b class="bad">${zl(p.pen)}</b> (wliczone w blok A).` : ""}</div></div>
      <div class="blk"><h3>Blok B — rdzeń <span class="amt">${lv ? `do ${zl(lv.b_max)}` : zl(p.b)}</span></h3>
        <div class="big">Udział${lv ? " na dziś" : ""} <b>${pc(p.share)}</b> → ${step(p.pct_b)} bloku${ktTxt} · ${num(p.core)} z ${num(p.kadr)} os. ze stażem ≥ ${P.core_days} dni</div>
        ${scaleBar(P.scale_b, p.share, P.limit_b, p.kt, lv ? [p.share, lv.share_max] : null)}
        <div class="hint">${hintB}</div></div>
    </div>`;
  const sites = d.sites.filter((s) => p.sites.includes(s.key) && (s.kadr || s.poss || s.dep || s.n));
  h += `<div class="section"><div class="section-head">Obiekty <span class="cnt">${sites.length}</span></div>
    <div class="tblwrap">${sites.length ? sitesTable(sites, d.live) : '<div class="empty">Brak obiektów z ludźmi.</div>'}</div></div>`;
  if (ST.can.people) h += `<div class="section" id="dwPeople">${peopleSection(p)}</div>`;
  else h += `<div class="note" style="border:none">Lista pracowników jest dostępna od poziomu „🔍 + Ludzie”.</div>`;
  h += "</div>";
  document.getElementById("drawer").innerHTML = h;
}

// ── Ludzie koordynatora ───────────────────────────────────────────────
const PF = {
  all: ["Wszyscy", () => true],
  thr: ["Progi w miesiącu", (x) => !x.ex && x.thr && x.thr.length],
  fail: ["✗ Nie dotrwali", (x) => !x.ex && x.thr && x.thr.some((t) => t.st === "fail" || t.st === "lost")],
  up: ["⏳ Do utrzymania", (x) => !x.ex && x.thr && x.thr.some((t) => t.st === "up")],
  core: ["Rdzeń", (x) => !x.ex && x.core],
  staff: ["Kadr na koniec", (x) => !x.ex && x.staff],
  dep: ["Odejścia", (x) => !x.ex && x.dep],
  ex: ["Pominięci", (x) => !!x.ex],
};
function peopleOf(p) {
  const keys = new Set(p.sites);
  return ST.data.items.filter((x) => keys.has(x.k));
}
function peopleSection(p) {
  const all = peopleOf(p);
  const chips = Object.entries(PF).filter(([k]) => k !== "up" || ST.data.live).map(([k, [l, f]]) =>
    `<button class="chip${ST.dwFilter === k ? " active" : ""}" onclick="setDwFilter('${k}')">${l}<span class="n">${all.filter(f).length}</span></button>`).join("");
  return `<div class="section-head">Ludzie <span class="cnt">${all.length}</span><span class="spacer"></span>
      <input type="search" class="inp" id="dwQ" placeholder="Szukaj: nazwisko, login, zakład…" value="${esc(ST.dwQ)}" oninput="ST.dwQ=this.value;renderPeople()" style="width:220px" /></div>
    <div class="filters">${chips}</div>
    <div class="tblwrap" id="dwPeopleTable">${peopleTable(p)}</div>
    <div class="note">Progi: ✓ dotrwał · ✗ odszedł przed progiem${ST.data.live ? " · ⏳ próg jeszcze przed nim (do końca miesiąca)" : ""}. Staż — od daty rozpoczęcia pracy
      na obiekcie (po przeniesieniu — od daty przeniesienia). Pominięci nie liczą się ani w bloku A, ani w B.</div>`;
}
function setDwFilter(k) {
  ST.dwFilter = k;
  const p = ST.data.participants.find((x) => x.id === ST.dw);
  document.getElementById("dwPeople").innerHTML = peopleSection(p);
}
function renderPeople() {
  const p = ST.data.participants.find((x) => x.id === ST.dw);
  if (p) document.getElementById("dwPeopleTable").innerHTML = peopleTable(p);
}
function thrCell(x, days) {
  const t = (x.thr || []).find((y) => y.d === days);
  if (!t) return '<span class="z">—</span>';
  const ico = { ok: '<span class="good">✓</span>', fail: '<span class="bad">✗</span>', up: '<span class="warn">⏳</span>', lost: '<span class="bad">✗</span>' }[t.st];
  return `<span class="thr" title="${days} dni: ${ddy(t.date)} · waga ${t.wt}">${ico} <span class="d">${dd(t.date)}</span></span>`;
}
function exclText(x) {
  if (x.ex === "status") return tag(`pominięty: status ${STATUS_PL[x.st] || x.st}`, "", "Status z listy pomijanych (parametry)");
  if (x.ex === "reason") return tag(`pominięty: ${x.rs}`, "", "Przyczyna zwolnienia z listy ignorowanych (parametry)");
  if (x.ex === "manual") return tag(`wykluczony: ${x.exr}`, "bad", "Wykluczony ręcznie");
  return "";
}
function peopleTable(p) {
  const P = ST.data.params;
  const q = ST.dwQ.trim().toLowerCase();
  const f = PF[ST.dwFilter] ? PF[ST.dwFilter][1] : PF.all[1];
  const list = peopleOf(p).filter(f).filter((x) => !q || `${x.n} ${x.lg} ${x.f}`.toLowerCase().includes(q))
    .sort((a, b) => String(a.n).localeCompare(String(b.n), "pl") || String(a.s).localeCompare(String(b.s)));
  if (!list.length) return '<div class="empty">Nikogo.</div>';
  const exc = ST.can.exclude;
  let h = `<table class="pt"><thead><tr><th class="l">Pracownik</th><th class="l">Zakład</th><th>Od</th><th>Do</th><th class="l">Status</th>
    <th>Staż</th>${P.thresholds.map((t) => `<th class="c">${t.days} dni</th>`).join("")}<th class="c">Rdzeń</th><th class="l">Uwagi</th>${exc ? "<th></th>" : ""}</tr></thead><tbody>`;
  for (const x of list.slice(0, 1500)) {
    const notes = [exclText(x)];
    if (!x.ex && x.dep) notes.push(tag(`odejście · staż ${x.tExit} dni`, "warn"));
    if (!x.ex && x.pen) notes.push(tag(`kara ${zl(x.pen)}`, "bad"));
    const coreCell = x.ex ? "" : x.core ? '<span class="good">✓</span>' : x.coreUp ? '<span class="warn" title="Wejdzie do rdzenia do końca miesiąca, jeśli zostanie">⏳</span>' : '<span class="z">·</span>';
    const act = !exc ? "" : x.ex === "manual"
      ? `<button class="ico" title="Przywróć do premii" onclick="restoreWorker(${x.w})">↩️</button>`
      : x.ex ? "" : `<button class="ico" title="Wyklucz z premii" onclick="askExclude(${x.w})">🚫</button>`;
    h += `<tr${x.ex ? ' class="off"' : ""}><td class="l"><b>${esc(x.n)}</b><div class="sub">${esc(x.lg || "")}</div></td>
      <td class="l">${esc(x.f)}</td><td>${dd(x.s)}</td><td>${x.l ? ddy(x.l) : '<span class="z">—</span>'}</td>
      <td class="l">${esc(STATUS_PL[x.st] || x.st)}${x.rs ? `<div class="sub">${esc(x.rs)}</div>` : ""}</td>
      <td>${x.ex ? '<span class="z">—</span>' : x.staff ? `${x.tEnd} dni` : x.tExit != null
        ? `<span title="Staż w dniu odejścia">${x.tExit} dni</span>` : '<span class="z">—</span>'}</td>
      ${P.thresholds.map((t) => `<td class="c">${x.ex ? '<span class="z">—</span>' : thrCell(x, t.days)}</td>`).join("")}
      <td class="c">${coreCell}</td><td class="l">${notes.join("")}</td>${exc ? `<td>${act}</td>` : ""}</tr>`;
  }
  h += "</tbody></table>";
  if (list.length > 1500) h += `<div class="note">Pokazano 1500 z ${list.length} — zawęź filtr albo pobierz Excel.</div>`;
  return h;
}

// ══════════════════════════════════════════════════════════════════════
//  Wykluczenia
// ══════════════════════════════════════════════════════════════════════
function openModal(html) {
  document.getElementById("modal").innerHTML = html;
  document.getElementById("modalBg").classList.add("open");
}
function closeModal() { document.getElementById("modalBg").classList.remove("open"); }
function workerInfo(wid) {
  const its = (ST.data && ST.data.items || []).filter((x) => x.w === wid);
  return { name: its[0] ? its[0].n : `#${wid}`, login: its[0] ? its[0].lg : "", facs: [...new Set(its.map((x) => x.f))] };
}
function askExclude(wid) {
  const w = workerInfo(wid);
  openModal(`<h3>🚫 Wyklucz z premii</h3>
    <div class="sub"><b>${esc(w.name)}</b> ${esc(w.login)} · ${esc(w.facs.join(", "))}</div>
    <label class="opt"><input type="radio" name="exScope" value="month" checked /> <span>Tylko ${mname(ST.month)}</span></label>
    <label class="opt"><input type="radio" name="exScope" value="all" /> <span>Na stałe — we wszystkich niezatwierdzonych miesiącach</span></label>
    <textarea id="exReason" maxlength="300" placeholder="Przyczyna (obowiązkowo): np. błąd w dacie BHP, przeniesienie bez statusu…"></textarea>
    <div class="acts"><span class="msg" id="exMsg"></span><button class="btn btn-ghost btn-sm" onclick="closeModal()">Anuluj</button>
      <button class="btn btn-primary btn-sm" onclick="doExclude(${wid})">Wyklucz</button></div>`);
  setTimeout(() => document.getElementById("exReason").focus(), 30);
}
async function doExclude(wid) {
  const reason = document.getElementById("exReason").value.trim();
  if (!reason) return flash("exMsg", "Podaj przyczynę", false);
  const scope = document.querySelector('input[name="exScope"]:checked').value;
  const r = await api("/exclusions", { method: "POST", body: { worker_id: wid, month: scope === "month" ? ST.month : null, reason, context_month: ST.month } });
  if (!r || !r.ok) return flash("exMsg", (r && r.error) || "Błąd", false);
  closeModal();
  await afterExclusionChange();
}
async function restoreWorker(wid) {
  const ex = await api(`/exclusions?month=${ST.month}`);
  if (!ex || !ex.ok) return alert((ex && ex.error) || "Błąd");
  const act = ex.data.filter((x) => x.worker_id === wid && !x.removed_at);
  if (!act.length) return alert("Nie znaleziono aktywnego wykluczenia");
  if (!confirm(`Przywrócić ${act[0].worker} do premii?\nPrzyczyna wykluczenia: ${act[0].reason}`)) return;
  for (const x of act) {
    const r = await api(`/exclusions/${x.id}?month=${ST.month}`, { method: "DELETE" });
    if (!r || !r.ok) return alert((r && r.error) || "Błąd");
  }
  await afterExclusionChange();
}
async function removeExclusion(id) {
  if (!confirm("Przywrócić pracownika do premii?")) return;
  const r = await api(`/exclusions/${id}?month=${ST.month}`, { method: "DELETE" });
  if (!r || !r.ok) return alert((r && r.error) || "Błąd");
  await afterExclusionChange();
}
async function afterExclusionChange() {
  ST.exclusions = null;
  await getMonthData(true);
  if (ST.view === "month") renderMonth();
  if (ST.view === "excl") loadExclusions();
  if (ST.dw) renderDrawer();
}
async function loadExclusions() {
  const box = document.getElementById("exclBody");
  box.innerHTML = '<div class="loading">Ładowanie…</div>';
  const [d, ex] = await Promise.all([getMonthData(), api(`/exclusions?month=${ST.month}`)]);
  if (!d) return;
  if (!ex || !ex.ok) return showError(ex);
  ST.exclusions = ex.data;
  const sk = d.skipped || { status: {}, reason: {}, manual: 0 };
  const can = ST.can.exclude;
  let h = "";
  if (d.run) h += `<div class="banner ok">Miesiąc zatwierdzony — wykluczeń nie można zmieniać.</div>`;
  h += `<div class="section"><div class="section-head">🚫 Wykluczeni ręcznie — ${mname(ST.month)} <span class="cnt">${ex.data.filter((x) => !x.removed_at).length}</span></div>`;
  if (can) h += `<div class="filters"><input type="search" class="inp" id="exFind" placeholder="Wyklucz pracownika: wpisz nazwisko lub login…" oninput="findWorker()" style="width:300px" />
    <span id="exFound"></span></div>`;
  if (!ex.data.length) h += '<div class="empty">Brak wykluczeń.</div>';
  else {
    h += `<div class="tblwrap"><table class="pt"><thead><tr><th class="l">Pracownik</th><th class="l">Zakres</th><th class="l">Przyczyna</th>
      <th class="l">Dodał</th><th class="l">Stan</th>${can ? "<th></th>" : ""}</tr></thead><tbody>`;
    for (const x of ex.data) {
      h += `<tr${x.removed_at ? ' class="off"' : ""}><td class="l"><b>${esc(x.worker)}</b><div class="sub">${esc(x.login || "")}</div></td>
        <td class="l">${x.month ? ym(x.month) : tag("na stałe", "warn")}</td><td class="l">${esc(x.reason)}</td>
        <td class="l">${esc(x.created_by || "—")}<div class="sub">${esc(x.created_at)}</div></td>
        <td class="l">${x.removed_at ? `przywrócony<div class="sub">${esc(x.removed_by || "")} ${esc(x.removed_at)}</div>` : tag("aktywne", "bad")}</td>
        ${can ? `<td>${x.removed_at ? "" : `<button class="btn btn-ghost btn-sm" onclick="removeExclusion(${x.id})">↩️ Przywróć</button>`}</td>` : ""}</tr>`;
    }
    h += "</tbody></table></div>";
  }
  h += `<div class="note">Wykluczony pracownik nie liczy się w żadnym bloku ani u żadnego koordynatora. „Na stałe” — we wszystkich
    miesiącach, które nie są jeszcze zatwierdzone. Każde wykluczenie i przywrócenie jest zapisane w historii.</div></div>`;
  const rows = [
    ...Object.entries(sk.status).map(([k, n]) => [`status: ${STATUS_PL[k] || k}`, n]),
    ...Object.entries(sk.reason).map(([k, n]) => [`przyczyna zwolnienia: ${k}`, n]),
  ].sort((a, b) => b[1] - a[1]);
  h += `<div class="section"><div class="section-head">Pominięci automatycznie <span class="cnt">według parametrów</span></div>
    ${rows.length ? `<div class="tblwrap"><table class="pt"><tbody>${rows.map(([l, n]) => `<tr><td class="l">${esc(l)}</td><td>${n}</td></tr>`).join("")}</tbody></table></div>`
      : '<div class="empty">Nikt.</div>'}
    <div class="note">Listę pomijanych statusów i ignorowanych przyczyn zwolnienia zmienia administrator w ⚙️ Parametrach.
      Status i przyczyna liczą się tylko, gdy odejście nastąpiło w tym miesiącu lub wcześniej.</div></div>`;
  document.getElementById("exclBody").innerHTML = h;
}
function findWorker() {
  const q = document.getElementById("exFind").value.trim().toLowerCase();
  const out = document.getElementById("exFound");
  if (q.length < 2) { out.innerHTML = ""; return; }
  const seen = new Map();
  for (const x of ST.data.items) if (!x.ex && `${x.n} ${x.lg}`.toLowerCase().includes(q) && !seen.has(x.w)) seen.set(x.w, x);
  const list = [...seen.values()].slice(0, 8);
  out.innerHTML = list.length ? list.map((x) => `<button class="chip" onclick="askExclude(${x.w})">${esc(x.n)} · ${esc(x.f)}</button>`).join(" ")
    : '<span class="z">nie znaleziono wśród pracowników tego miesiąca</span>';
}

// ══════════════════════════════════════════════════════════════════════
//  Koordynatorzy na liście miesiąca (admin / head)
// ══════════════════════════════════════════════════════════════════════
async function loadCoords() {
  const box = document.getElementById("coordsBody");
  box.innerHTML = '<div class="loading">Ładowanie…</div>';
  const [d, co] = await Promise.all([getMonthData(), ST.coords ? Promise.resolve({ ok: true, data: ST.coords }) : api("/coordinators")]);
  if (!d) return;
  if (!co || !co.ok) return showError(co);
  ST.coords = co.data;
  if (!ST.edit || ST.edit.month !== ST.month) {
    ST.edit = { month: ST.month, dirty: false, rows: (d.config || d.participants.map((p) => ({ coordinator_id: p.id, basis: p.basis, as_id: p.as_id, kt: p.kt, note: p.note })))
      .map((x) => ({ coordinator_id: x.coordinator_id, basis: x.basis, as_id: x.as_id || null, kt: Number(x.kt), note: x.note || "" })) };
  }
  renderCoords();
}
const coordById = (id) => (ST.coords || []).find((c) => c.id === id) || { name: `#${id}` };
function renderCoords() {
  const d = ST.data;
  const ro = !!d.run;
  const e = ST.edit;
  const inList = new Set(e.rows.map((x) => x.coordinator_id));
  const active = ST.coords.filter((c) => c.active);
  const part = new Map(d.participants.map((p) => [p.id, p]));
  let h = "";
  if (ro) h += `<div class="banner ok">Miesiąc zatwierdzony — lista jest zamrożona. Aby ją zmienić, cofnij zatwierdzenie.</div>`;
  else if (d.config_from && d.config_from !== d.month) h += `<div class="banner">Lista odziedziczona z <b>${ym(d.config_from)}</b>. Po zapisaniu powstanie lista dla ${ym(d.month)}; następne miesiące odziedziczą ją.</div>`;
  else if (!d.config_from) h += `<div class="banner warn">Brak listy — dodaj koordynatorów.</div>`;
  if (d.uncovered && d.uncovered.length && !ro) {
    h += `<div class="banner warn">⚠️ <b>Obiekty z ludźmi, których nikt nie liczy:</b><br>${d.uncovered.map((u) =>
      `${esc(u.key)} — ${u.owner ? esc(u.owner) : "bez koordynatora"} · kadr ${u.kadr}${u.owner_id && !inList.has(u.owner_id)
        ? ` <a href="#" onclick="addCoord(${u.owner_id});return false">➕ dodaj ${esc(u.owner)}</a>` : ""}`).join("<br>")}</div>`;
  }
  h += `<div class="section"><div class="section-head">👥 Koordynatorzy na liście — ${mname(ST.month)} <span class="cnt">${e.rows.length}</span>
      <span class="spacer"></span>${ro ? "" : `<span class="msg" id="coMsg"></span>
      <button class="btn btn-ghost btn-sm" onclick="ST.edit=null;loadCoords()">Anuluj zmiany</button>
      <button class="btn btn-primary btn-sm" onclick="saveCoords()">💾 Zapisz listę</button>`}</div>
    <div class="tblwrap"><table class="pt"><thead><tr><th class="l">Koordynator</th><th class="l">Rola teraz</th><th class="l">Podstawa wyliczenia</th>
      <th class="l">Jak kto</th><th>k-t</th><th class="l">Uwagi</th><th>Premia${d.live ? " (dziś)" : ""}</th>${ro ? "" : "<th></th>"}</tr></thead><tbody>`;
  const sorted = [...e.rows].sort((a, b) => coordById(a.coordinator_id).name.localeCompare(coordById(b.coordinator_id).name, "pl"));
  for (const r of sorted) {
    const c = coordById(r.coordinator_id);
    const roles = [];
    if (c.is_admin) roles.push(tag("admin", "acc"));
    if (c.role === "head") roles.push(tag("kierownik", "acc"));
    if (c.regions && c.regions.length) roles.push(tag(`regionalny: ${c.regions.join(", ")}`, "pur"));
    if (c.sites && c.sites.length) roles.push(`<span class="sub" style="display:block">główny: ${esc(c.sites.join(", "))}</span>`);
    if (!c.active) roles.push(tag("nieaktywny", "bad"));
    const i = e.rows.indexOf(r);
    const dis = ro ? "disabled" : "";
    const p = part.get(r.coordinator_id);
    h += `<tr><td class="l"><b>${esc(c.name)}</b></td><td class="l">${roles.join(" ") || '<span class="z">—</span>'}</td>
      <td class="l"><select class="inp" ${dis} onchange="editRow(${i},'basis',this.value)">${Object.entries(BASIS).map(([k, l]) =>
        `<option value="${k}"${r.basis === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="l">${r.basis === "as" ? `<select class="inp" ${dis} onchange="editRow(${i},'as_id',Number(this.value))"><option value="">— wybierz —</option>${active
        .filter((x) => x.id !== r.coordinator_id).map((x) => `<option value="${x.id}"${r.as_id === x.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`
        : r.basis === "region" ? (c.regions && c.regions.length ? esc(c.regions.join(", ")) : '<span class="bad">nie jest regionalnym</span>') : '<span class="z">—</span>'}</td>
      <td><input type="number" ${dis} min="0" max="2" step="0.05" value="${r.kt}" onchange="editRow(${i},'kt',Number(this.value))" /></td>
      <td class="l"><input type="text" class="inp" ${dis} value="${esc(r.note)}" maxlength="300" onchange="editRow(${i},'note',this.value)" style="width:100%;min-width:140px" /></td>
      <td class="big">${p ? zl(p.total) : '<span class="z">—</span>'}</td>
      ${ro ? "" : `<td><button class="ico" title="Usuń z listy" onclick="dropRow(${i})">✕</button></td>`}</tr>`;
  }
  h += `</tbody></table></div>`;
  if (!ro) {
    h += `<div class="actions"><select class="inp" id="coAdd"><option value="">— dodaj koordynatora —</option>${active.filter((c) => !inList.has(c.id))
      .map((c) => `<option value="${c.id}">${esc(c.name)}${c.regions && c.regions.length ? " · regionalny" : c.sites && c.sites.length ? ` · ${c.sites.length} ob.` : ""}</option>`).join("")}</select>
      <button class="btn btn-ghost btn-sm" onclick="addCoord(Number(document.getElementById('coAdd').value))">➕ Dodaj</button>
      <span class="z" style="font-size:11px">${e.dirty ? "● niezapisane zmiany" : ""}</span></div>`;
  }
  h += `<div class="note"><b>Własne obiekty</b> — obiekty, gdzie jest głównym koordynatorem na ostatni dzień miesiąca (🔗 Przypisania).
    <b>Region</b> — suma wszystkich obiektów regionów, gdzie jest regionalnym (jak Brychka w Excelu).
    <b>Jak kto</b> — te same obiekty co wybrany koordynator, k-t własny (jak Polishchuk = Hordiichuk).
    k-t mnoży oba bloki: 1 — pełna, 0,5 — połowa, 0 — bez premii.</div></div>`;
  document.getElementById("coordsBody").innerHTML = h;
}
function editRow(i, k, v) {
  const r = ST.edit.rows[i];
  r[k] = v;
  if (k === "basis" && v !== "as") r.as_id = null;
  ST.edit.dirty = true;
  renderCoords();
}
function dropRow(i) {
  ST.edit.rows.splice(i, 1);
  ST.edit.dirty = true;
  renderCoords();
}
function addCoord(id) {
  if (!id || ST.edit.rows.some((x) => x.coordinator_id === id)) return;
  const c = coordById(id);
  ST.edit.rows.push({ coordinator_id: id, basis: c.sites && c.sites.length ? "own" : c.regions && c.regions.length ? "region" : "own", as_id: null, kt: 1, note: "" });
  ST.edit.dirty = true;
  renderCoords();
}
async function saveCoords() {
  const bad = ST.edit.rows.find((x) => x.basis === "as" && !x.as_id);
  if (bad) return flash("coMsg", `${coordById(bad.coordinator_id).name}: wybierz, od kogo liczyć`, false);
  const r = await api(`/month/${ST.month}/coords`, { method: "PUT", body: { rows: ST.edit.rows } });
  if (!r || !r.ok) return flash("coMsg", (r && r.error) || "Błąd", false);
  ST.edit = null;
  await getMonthData(true);
  await loadCoords();
  flash("coMsg", "Zapisano — premie przeliczone", true);
}

// ══════════════════════════════════════════════════════════════════════
//  Parametry / Jak liczymy
// ══════════════════════════════════════════════════════════════════════
async function loadParams() {
  const box = document.getElementById("paramsBody");
  box.innerHTML = '<div class="loading">Ładowanie…</div>';
  const r = await api(`/params?month=${ST.month}`);
  if (!r || !r.ok) return showError(r);
  ST.params = r.data;
  ST.pedit = JSON.parse(JSON.stringify(r.data.data));
  ST.pedit._from = ST.month;
  renderParams();
}
function howHtml(P, from) {
  const sc = (s) => [...s].sort((a, b) => b.from - a.from).map((x) => `od ${pc(x.from, 0)} — ${pc(x.pct, 0)} bloku`).join(", ");
  return `<div class="how">
    <b>Premia = (blok A + blok B) × k-t</b>, maksymalnie <b>${zl(P.max_bonus)}</b>${from ? ` · parametry od ${ym(from)}` : ""}.
    <br><br><b>Blok A — dożycie (do ${zl(P.limit_a)})</b>
    <ul><li>Każdy pracownik, któremu w miesiącu mija ${P.thresholds.map((t) => `<b>${t.days} dni</b> pracy (waga ${String(t.weight).replace(".", ",")})`).join(" albo ")},
      daje tę wagę do „możliwych”.</li>
      <li>Waga jest „zdobyta”, jeśli tego dnia pracownik jeszcze pracuje.</li>
      <li>Wykonanie = zdobyte ÷ możliwe → skala: ${sc(P.scale_a)}, niżej — 0.</li></ul>
    <b>Blok B — rdzeń (do ${zl(P.limit_b)})</b>
    <ul><li>Kadr — kto pracuje na ostatni dzień miesiąca; rdzeń — z nich ze stażem co najmniej <b>${P.core_days} dni</b>.</li>
      <li>Udział rdzenia → skala: ${sc(P.scale_b)}, niżej — 0.</li></ul>
    ${P.penalty.enabled ? `<b>Kara</b>: ${zl(P.penalty.amount)} za każde odejście (status ${esc(P.exit_status)}) przy stażu ${P.penalty.from_days}–${P.penalty.to_days} dni, dolicza się do bloku A.<br><br>` : ""}
    <b>Nie liczą się</b>: statusy ${P.excluded_statuses.map((s) => esc(STATUS_PL[s] || s)).join(", ")};
    zwolnienia z przyczyną ${P.ignored_reasons.length ? P.ignored_reasons.map((x) => `„${esc(x)}”`).join(", ") : "—"}; pracownicy wykluczeni ręcznie.
    <br>Staż liczy się od rozpoczęcia pracy na obiekcie, po przeniesieniu — od daty przeniesienia. Koordynator i region obiektu —
    według przypisania na ostatni dzień miesiąca. Bez ludzi na obiektach (kadr 0) premii nie ma.
  </div>`;
}
function renderParams() {
  const r = ST.params;
  if (!ST.me.full) {
    document.getElementById("paramsBody").innerHTML = `<div class="section"><div class="section-head">📖 Jak liczymy premię — ${mname(ST.month)}</div>${howHtml(r.data, r.valid_from)}</div>`;
    return;
  }
  const P = ST.pedit;
  const numIn = (path, v, step, w) => `<input type="number" step="${step || 1}" value="${v}" style="${w ? "width:" + w + "px" : ""}" onchange="setP('${path}', this.value)" />`;
  const pctIn = (path, v) => `<input type="number" step="0.1" min="0" max="100" value="${Math.round(v * 1000) / 10}" onchange="setP('${path}', this.value, 'pct')" /> %`;
  const rows = (k, label) => `<div class="rows-ed">${P[k].map((s, i) => `<div class="r">od ${pctIn(`${k}.${i}.from`, s.from)} → ${pctIn(`${k}.${i}.pct`, s.pct)} bloku
      <button class="ico" title="Usuń próg" onclick="delStep('${k}',${i})">✕</button></div>`).join("")}
    <div class="r"><button class="btn btn-ghost btn-sm" onclick="addStep('${k}')">➕ próg ${label}</button></div></div>`;
  const reasons = new Map((r.reasons || []).map((x) => [x.reason, x.n]));
  P.ignored_reasons.forEach((x) => { if (!reasons.has(x)) reasons.set(x, 0); });
  const months = [...new Set([...(ST.months || []).map((x) => x.month), addMonths(ST.today.slice(0, 7), 1)])].sort().reverse();
  let h = `<div class="section"><div class="section-head">📖 Jak liczymy — ${mname(ST.month)} (parametry od ${ym(r.valid_from)})</div>${howHtml(r.data, r.valid_from)}</div>`;
  h += `<div class="section"><div class="section-head">⚙️ Zmień parametry <span class="spacer"></span>
      <span>Obowiązują od</span> <select class="inp" onchange="ST.pedit._from=this.value">${months.map((m) => `<option value="${m}"${m === P._from ? " selected" : ""}>${ym(m)}</option>`).join("")}</select>
      <span class="msg" id="pMsg"></span><button class="btn btn-primary btn-sm" onclick="saveParams()">💾 Zapisz</button></div>
    <div class="pgrid"><div>
      <div class="cfg">
        <span class="k">Stawka bazowa</span><span>${numIn("base_rate", P.base_rate, 50)} zł</span>
        <span class="h">Tylko informacyjnie (Excel jej nie używa w wyliczeniu).</span>
        <span class="k">Maksymalna premia</span><span>${numIn("max_bonus", P.max_bonus, 50)} zł</span>
        <span class="k">Limit bloku A</span><span>${numIn("limit_a", P.limit_a, 50)} zł</span>
        <span class="k">Limit bloku B</span><span>${numIn("limit_b", P.limit_b, 50)} zł</span>
        <span class="k">Próg stażu rdzenia</span><span>${numIn("core_days", P.core_days)} dni</span>
      </div>
      <div class="section-head" style="border-top:1px solid var(--border)">Progi stażu (blok A)</div>
      <div class="rows-ed">${P.thresholds.map((t, i) => `<div class="r">${numIn(`thresholds.${i}.days`, t.days)} dni · waga ${numIn(`thresholds.${i}.weight`, t.weight, 0.5)}
        <button class="ico" title="Usuń próg" onclick="delThr(${i})">✕</button></div>`).join("")}
        ${P.thresholds.length < 4 ? `<div class="r"><button class="btn btn-ghost btn-sm" onclick="addThr()">➕ próg stażu</button></div>` : ""}</div>
      <div class="section-head" style="border-top:1px solid var(--border)">Kara za wczesne odejście</div>
      <div class="cfg">
        <span class="k">Liczyć karę</span><span><label><input type="checkbox" ${P.penalty.enabled ? "checked" : ""} onchange="ST.pedit.penalty.enabled=this.checked" /> tak</label></span>
        <span class="k">Kwota</span><span>${numIn("penalty.amount", P.penalty.amount, 10)} zł</span>
        <span class="k">Staż od – do</span><span>${numIn("penalty.from_days", P.penalty.from_days)} – ${numIn("penalty.to_days", P.penalty.to_days)} dni</span>
        <span class="k">Status odejścia</span><span><select class="inp" onchange="ST.pedit.exit_status=this.value">${(r.statuses || []).map((s) =>
          `<option value="${s}"${s === P.exit_status ? " selected" : ""}>${esc(STATUS_PL[s] || s)}</option>`).join("")}</select></span>
        <span class="h">Odejście = ostatni dzień w miesiącu i ten status (liczba odejść, kara).</span>
      </div>
    </div><div>
      <div class="section-head">Skala bloku A — wykonanie</div>${rows("scale_a", "A")}
      <div class="section-head" style="border-top:1px solid var(--border)">Skala bloku B — udział rdzenia</div>${rows("scale_b", "B")}
    </div></div>
    <div class="section-head" style="border-top:1px solid var(--border)">Pomijane statusy</div>
    <div class="checks">${(r.statuses || []).map((s) => `<label><input type="checkbox" ${P.excluded_statuses.includes(s) ? "checked" : ""}
      onchange="toggleList('excluded_statuses','${s}',this.checked)" ${s === P.exit_status ? "disabled" : ""} /> ${esc(STATUS_PL[s] || s)}</label>`).join("")}</div>
    <div class="section-head" style="border-top:1px solid var(--border)">Ignorowane przyczyny zwolnienia <span class="cnt">— takie odejście nie liczy się ani w A, ani w B</span></div>
    <div class="checks">${[...reasons].map(([x, n]) => `<label><input type="checkbox" ${P.ignored_reasons.includes(x) ? "checked" : ""}
      onchange='toggleList("ignored_reasons", ${JSON.stringify(x).replace(/'/g, "&#39;")}, this.checked)' /> ${esc(x)}<span class="c" title="Zwolnień z tą przyczyną w ostatnich 12 miesiącach">${n || ""}</span></label>`).join("")}</div>
    <div class="actions"><input type="text" class="inp" id="newReason" placeholder="Inna przyczyna (dokładnie jak w HRappka)…" style="width:280px" />
      <button class="btn btn-ghost btn-sm" onclick="addReason()">➕ Dodaj przyczynę</button></div>
    <div class="note">Zmiana działa od wybranego miesiąca do następnego zestawu. Zatwierdzone miesiące mają własną kopię parametrów i się nie zmieniają.
      Liczby w ostatniej kolumnie — ile zwolnień z daną przyczyną było w ostatnich 12 miesiącach.</div></div>`;
  h += `<div class="pgrid"><div class="section"><div class="section-head">Zestawy parametrów</div>
      <div class="tblwrap"><table class="pt"><thead><tr><th class="l">Od miesiąca</th><th class="l">Zmienił</th><th></th></tr></thead><tbody>
      ${(r.sets || []).map((s) => `<tr><td class="l"><b>${ym(s.valid_from)}</b></td><td class="l">${esc(s.updated_by || "—")}<div class="sub">${esc(s.updated_at)}</div></td>
        <td>${(r.sets || []).length > 1 ? `<button class="ico" title="Usuń zestaw" onclick="delParams('${s.valid_from}')">🗑️</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div></div>
    <div class="section"><div class="section-head">✉️ Powiadomienia</div>
      <div class="cfg"><span class="k">Po zatwierdzeniu miesiąca</span>
        <span><label><input type="checkbox" ${r.settings && r.settings.notify_tg === "1" ? "checked" : ""} onchange="saveNotify(this.checked)" />
          wyślij każdemu koordynatorowi jego premię w Telegramie</label> <span class="msg" id="nMsg"></span></span>
        <span class="h">Dostają koordynatorzy z premią i k-t &gt; 0, z Telegramem w karcie. Wiadomość: kwota, blok A i B z procentami.
          Można też wysłać ręcznie przyciskiem w zatwierdzonym miesiącu.</span></div></div></div>`;
  document.getElementById("paramsBody").innerHTML = h;
}
function setP(path, v, kind) {
  let n = Number(String(v).replace(",", "."));
  if (kind === "pct") n = Math.round(n * 10) / 1000;
  const ks = path.split(".");
  let o = ST.pedit;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
  o[ks[ks.length - 1]] = n;
}
function addStep(k) { ST.pedit[k].push({ from: 0, pct: 0 }); renderParams(); }
function delStep(k, i) { ST.pedit[k].splice(i, 1); renderParams(); }
function addThr() { ST.pedit.thresholds.push({ days: 60, weight: 1 }); renderParams(); }
function delThr(i) { ST.pedit.thresholds.splice(i, 1); renderParams(); }
function toggleList(k, v, on) {
  const s = new Set(ST.pedit[k]);
  if (on) s.add(v); else s.delete(v);
  ST.pedit[k] = [...s];
}
function addReason() {
  const v = document.getElementById("newReason").value.trim();
  if (!v) return;
  toggleList("ignored_reasons", v, true);
  renderParams();
}
async function saveParams() {
  const { _from, ...data } = ST.pedit;
  data.thresholds = [...data.thresholds].sort((a, b) => a.days - b.days);
  if (!confirm(`Zapisać parametry od ${ym(_from)}?\nZatwierdzone miesiące się nie zmienią.`)) return;
  const r = await api("/params", { method: "PUT", body: { valid_from: _from, data } });
  if (!r || !r.ok) return flash("pMsg", (r && r.error) || "Błąd", false);
  ST.data = null;
  await loadParams();
  flash("pMsg", "Zapisano", true);
}
async function delParams(from) {
  if (!confirm(`Usunąć zestaw parametrów od ${ym(from)}? Miesiące od ${ym(from)} wezmą poprzedni zestaw.`)) return;
  const r = await api(`/params/${from}`, { method: "DELETE" });
  if (!r || !r.ok) return alert((r && r.error) || "Błąd");
  ST.data = null;
  loadParams();
}
async function saveNotify(on) {
  const r = await api("/settings", { method: "PUT", body: { notify_tg: on ? "1" : "0" } });
  flash("nMsg", r && r.ok ? "Zapisano" : (r && r.error) || "Błąd", !!(r && r.ok));
}

// ══════════════════════════════════════════════════════════════════════
//  Dostęp (admin / head)
// ══════════════════════════════════════════════════════════════════════
async function loadAccess() {
  const box = document.getElementById("accessBody");
  box.innerHTML = '<div class="loading">Ładowanie…</div>';
  const [co, d] = await Promise.all([api("/coordinators"), getMonthData()]);
  if (!co || !co.ok) return showError(co);
  ST.coords = co.data;
  renderAccess();
}
function renderAccess() {
  const q = ST.accQ.trim().toLowerCase();
  const inList = new Set(((ST.data && ST.data.participants) || []).map((p) => p.id));
  const list = ST.coords.filter((c) => c.active && (!q || c.name.toLowerCase().includes(q)));
  const full = (c) => c.is_admin || c.role === "head";
  let h = `<div class="section"><div class="section-head">🔐 Kto widzi premie <span class="cnt">${list.length}</span><span class="spacer"></span>
      <input type="search" class="inp" placeholder="Szukaj…" value="${esc(ST.accQ)}" oninput="ST.accQ=this.value;renderAccess()" style="width:180px" /></div>
    <div class="lvl-legend">${Object.entries(LEVELS).map(([k, [l, t]]) => `<div><b>${l}</b>${esc(t)}</div>`).join("")}
      <div><b>🛡️ Pełny</b>Administrator i kierownik działu — zawsze: parametry, lista i k-t, zatwierdzanie, wypłata, dostęp.</div></div>
    <div class="filters">Szybko: <button class="chip" onclick="bulkAccess('list','own')">wszyscy z listy premii (${ym(ST.month)}) → 👁 Moja premia</button>
      <button class="chip" onclick="bulkAccess('leads','people')">regionalni → 🔍 + Ludzie</button>
      <button class="chip" onclick="bulkAccess('all',null)">wyłącz wszystkim</button><span class="msg" id="aMsg"></span></div>
    <div class="tblwrap"><table class="pt"><thead><tr><th class="l">Koordynator</th><th class="l">Rola</th><th class="c">Na liście premii</th><th class="c">Telegram</th><th class="l">Dostęp</th></tr></thead><tbody>`;
  for (const c of list) {
    const roles = [];
    if (c.is_admin) roles.push(tag("admin", "acc"));
    if (c.role === "head") roles.push(tag("kierownik", "acc"));
    if (c.regions && c.regions.length) roles.push(tag(`regionalny: ${c.regions.join(", ")}`, "pur"));
    if (c.sites && c.sites.length) roles.push(`<span class="sub" style="display:block">główny: ${c.sites.length} ob.</span>`);
    h += `<tr><td class="l"><b>${esc(c.name)}</b></td><td class="l">${roles.join(" ") || '<span class="z">—</span>'}</td>
      <td class="c">${inList.has(c.id) ? '<span class="good">✓</span>' : '<span class="z">—</span>'}</td>
      <td class="c">${c.has_tg ? "✓" : '<span class="z">—</span>'}</td>
      <td class="l">${full(c) ? tag("🛡️ pełny", "ok") : `<select class="inp" onchange="setAccess([${c.id}], this.value)">
        <option value="">— brak —</option>${Object.entries(LEVELS).map(([k, [l]]) => `<option value="${k}"${c.level === k ? " selected" : ""}>${l}</option>`).join("")}</select>`}</td></tr>`;
  }
  h += `</tbody></table></div><div class="note">Koordynator widzi tylko siebie. Regionalny — także koordynatorów z obiektami swojego regionu.
    Bez dostępu nie widzi sekcji w menu. Zmiany działają od razu.</div></div>`;
  document.getElementById("accessBody").innerHTML = h;
}
async function setAccess(ids, level) {
  const r = await api("/access", { method: "PUT", body: { ids, level: level || null } });
  if (!r || !r.ok) return flash("aMsg", (r && r.error) || "Błąd", false);
  ids.forEach((id) => { const c = ST.coords.find((x) => x.id === id); if (c) c.level = level || null; });
  renderAccess();
  flash("aMsg", "Zapisano", true);
}
function bulkAccess(who, level) {
  const full = (c) => c.is_admin || c.role === "head";
  const inList = new Set(((ST.data && ST.data.participants) || []).map((p) => p.id));
  const ids = ST.coords.filter((c) => c.active && !full(c) && (who === "all" || (who === "list" ? inList.has(c.id) : c.regions && c.regions.length)))
    // «wszyscy z listy → Moja premia» nie obniża tym, którzy mają już więcej
    .filter((c) => !(who === "list" && c.level && c.level !== "own")).map((c) => c.id);
  if (!ids.length) return flash("aMsg", "Nikogo do zmiany", false);
  if (!confirm(`Zmienić dostęp ${ids.length} osobom na: ${level ? LEVELS[level][0] : "brak"}?`)) return;
  setAccess(ids, level);
}

// ══════════════════════════════════════════════════════════════════════
//  Historia zmian
// ══════════════════════════════════════════════════════════════════════
async function loadLog() {
  const box = document.getElementById("logBody");
  box.innerHTML = '<div class="loading">Ładowanie…</div>';
  const [r, co] = await Promise.all([api("/log"), ST.coords ? Promise.resolve({ ok: true, data: ST.coords }) : api("/coordinators")]);
  if (!r || !r.ok) return showError(r);
  if (co && co.ok) ST.coords = co.data;
  const nm = (id) => (ST.coords.find((c) => c.id === id) || {}).name || `#${id}`;
  const det = (x) => {
    const d = x.details || {};
    switch (x.action) {
      case "excl_add": return `${esc(d.worker || "#" + d.worker_id)} · ${d.month ? ym(d.month) : "na stałe"} · ${esc(d.reason)}`;
      case "excl_remove": return esc(d.worker || "#" + d.worker_id);
      case "access": return `${(d.ids || []).map(nm).map(esc).join(", ")} → ${d.level ? LEVELS[d.level][0] : "brak"}`;
      case "coords": return `${d.n} koordynatorów${d.before && d.before !== d.n ? ` (było ${d.before})` : ""}`;
      case "approve": case "unapprove": return d.total != null ? zl(d.total) : "";
      case "notify": return `wysłano ${d.sent}${d.no_tg ? `, bez Telegramu ${d.no_tg}` : ""}${d.failed ? `, błędy ${d.failed}` : ""}`;
      case "settings": return d.notify_tg === "1" ? "Telegram po zatwierdzeniu: włączony" : "Telegram po zatwierdzeniu: wyłączony";
      case "params": return `max ${zl(d.max_bonus)}, A ${zl(d.limit_a)}, B ${zl(d.limit_b)}, ignorowane: ${(d.ignored_reasons || []).map(esc).join(", ") || "—"}`;
      default: return "";
    }
  };
  document.getElementById("logBody").innerHTML = `<div class="section"><div class="section-head">📜 Historia zmian <span class="cnt">ostatnie ${r.data.length}</span></div>
    ${r.data.length ? `<div class="tblwrap"><table class="pt"><thead><tr><th class="l">Kiedy</th><th class="l">Kto</th><th class="l">Co</th><th class="l">Miesiąc</th><th class="l">Szczegóły</th></tr></thead><tbody>
    ${r.data.map((x) => `<tr><td class="l">${esc(x.at)}</td><td class="l">${esc(x.by_name || "system")}</td><td class="l">${esc(ACTION_PL[x.action] || x.action)}</td>
      <td class="l">${x.month ? ym(x.month) : ""}</td><td class="l">${det(x)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Pusto.</div>'}</div>`;
}

// ══════════════════════════════════════════════════════════════════════
//  Excel
// ══════════════════════════════════════════════════════════════════════
const XS = {
  title: { font: { bold: true, sz: 13 } },
  sub: { font: { color: { rgb: "666666" }, sz: 9 } },
  head: { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "2F5597" } },
    alignment: { vertical: "center", wrapText: true }, border: { bottom: { style: "thin", color: { rgb: "999999" } } } },
  tot: { font: { bold: true }, fill: { patternType: "solid", fgColor: { rgb: "D9E1F2" } } },
  off: { font: { color: { rgb: "999999" } } },
  ex: { fill: { patternType: "solid", fgColor: { rgb: "EDEDED" } }, font: { color: { rgb: "777777" } } },
  bad: { fill: { patternType: "solid", fgColor: { rgb: "FCE4D6" } } },
};
function haveXlsx() {
  if (typeof XLSX === "undefined") { alert("Biblioteka Excel nie załadowała się — odśwież stronę."); return false; }
  return true;
}
// aoa: wiersze; headRow: indeks nagłówka; styles: {rowIndex: styl}; widths; fmt: {col: format liczbowy}
function makeSheet(aoa, headRow, styles, widths, fmt) {
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
      if (R > headRow && fmt && fmt[C] && cell.t === "n") cell.z = fmt[C];
      if (R > headRow && cell.t === "d") cell.z = "dd.mm.yyyy";
      cell.s = s;
    }
  }
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  ws["!rows"] = [];
  ws["!rows"][headRow] = { hpt: 30 };
  if (range.e.r > headRow) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: headRow, c: 0 }, e: { r: range.e.r, c: range.e.c } }) };
  return ws;
}
const xDate = (iso) => (iso ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) : "");
async function exportMonth() {
  if (!haveXlsx()) return;
  const d = await getMonthData();
  if (!d) return;
  const P = d.params;
  const status = d.run ? (d.run.status === "paid" ? `wypłacony ${ts(d.run.paid_at)}` : `zatwierdzony ${ts(d.run.approved_at)}`) : d.live ? `stan na ${ddy(d.end)}` : "wersja robocza";
  const wb = XLSX.utils.book_new();
  const PCT = "0.0%", ZL = '#,##0.00 "zł"';
  // Premie — jak arkusz «Model»
  const a1 = [[`Premie koordynatorów — ${mname(d.month)}`], [`${status} · maks. ${P.max_bonus} zł · limit A ${P.limit_a} zł · limit B ${P.limit_b} zł · parametry od ${ym(d.params_from) || "—"}`],
    ["Koordynator", "Podstawa", "Region", "Obiektów", "Kadr", "Odejść", "Wagi możliwe", "Wagi zdobyte", "Wykonanie", "Skala A", "Blok A przed karami", "Kary",
      "Blok A", "Rdzeń, os.", "Udział rdzenia", "Skala B", "Blok B", "k-t", d.live ? "PREMIA na dziś" : "PREMIA", "Uwagi",
      ...(d.live ? ["Min na koniec miesiąca", "Maks na koniec miesiąca"] : [])]];
  const st1 = {};
  d.participants.forEach((p) => {
    a1.push([p.name, basisText(p), p.region || "", p.n_sites, p.kadr, p.dep, p.poss, p.ach, p.vyp, p.pct_a, p.a_raw, p.pen || 0, p.a, p.core, p.share,
      p.pct_b, p.b, p.kt, p.total == null ? "" : p.total, p.note || "",
      ...(d.live ? [p.live ? p.live.total_min : "", p.live ? p.live.total_max : ""] : [])]);
    if (p.kt === 0 || p.total == null) st1[a1.length - 1] = XS.off;
  });
  a1.push(["Razem", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", d.total, "", ...(d.range ? [d.range.min, d.range.max] : [])]);
  st1[a1.length - 1] = XS.tot;
  XLSX.utils.book_append_sheet(wb, makeSheet(a1, 2, st1, [26, 20, 12, 9, 7, 8, 9, 9, 10, 8, 11, 8, 10, 9, 10, 8, 10, 6, 11, 30, 14, 14],
    { 8: PCT, 9: "0%", 10: ZL, 11: ZL, 12: ZL, 14: PCT, 15: "0%", 16: ZL, 18: ZL, 20: ZL, 21: ZL }), "Premie");
  // Obiekty
  const a2 = [[`Obiekty — ${mname(d.month)}`], [status],
    ["Obiekt", "Zakłady", "Koordynator", "Region", "Kadr", "Odejścia", "Wagi możliwe", "Wagi zdobyte", "Wykonanie", "Rdzeń, os.", "Udział rdzenia"]];
  d.sites.filter((s) => s.kadr || s.poss || s.dep || s.n).forEach((s) =>
    a2.push([s.key, (s.facilities || []).join(", "), s.owner || "", s.region || "", s.kadr, s.dep, s.poss, s.ach, s.vyp == null ? "" : s.vyp, s.core, s.share == null ? "" : s.share]));
  XLSX.utils.book_append_sheet(wb, makeSheet(a2, 2, {}, [24, 40, 22, 12, 7, 8, 9, 9, 10, 9, 10], { 8: PCT, 10: PCT }), "Obiekty");
  // Ludzie
  if (d.items && d.items.length) {
    const thr = P.thresholds;
    const owner = new Map(d.sites.map((s) => [s.key, s.owner || ""]));
    const RES = { ok: "dotrwał", fail: "nie dotrwał", up: "przed progiem", lost: "nie dotrwa" };
    const a3 = [[`Ludzie — ${mname(d.month)}`], [status],
      ["Pracownik", "Login", "Zakład", "Obiekt", "Koordynator", "Od", "Do", "Status", "Przyczyna zwolnienia", "Staż, dni (na koniec / w dniu odejścia)",
        ...thr.flatMap((t) => [`${t.days} dni — data`, `${t.days} dni — wynik`]), "W kadrze", "Rdzeń", "Odejście", "Kara", "Pominięty"]];
    const st3 = {};
    [...d.items].sort((x, y) => String(x.n).localeCompare(String(y.n), "pl")).forEach((x) => {
      const cells = thr.flatMap((t) => { const v = (x.thr || []).find((y) => y.d === t.days); return v && !x.ex ? [xDate(v.date), RES[v.st]] : ["", ""]; });
      a3.push([x.n, x.lg || "", x.f, x.k, owner.get(x.k) || "", xDate(x.s), xDate(x.l), STATUS_PL[x.st] || x.st, x.rs || "",
        x.ex ? "" : x.staff ? x.tEnd : x.tExit == null ? "" : x.tExit, ...cells,
        x.ex ? "" : x.staff ? "tak" : "", x.ex ? "" : x.core ? "tak" : "", x.ex ? "" : x.dep ? "tak" : "", x.ex ? "" : x.pen || "",
        x.ex === "manual" ? `wykluczony: ${x.exr}` : x.ex === "status" ? `status ${STATUS_PL[x.st] || x.st}` : x.ex === "reason" ? `przyczyna: ${x.rs}` : ""]);
      if (x.ex) st3[a3.length - 1] = XS.ex;
      else if ((x.thr || []).some((t) => t.st === "fail")) st3[a3.length - 1] = XS.bad;
    });
    XLSX.utils.book_append_sheet(wb, makeSheet(a3, 2, st3, [26, 12, 22, 18, 20, 11, 11, 12, 20, 10, ...thr.flatMap(() => [11, 12]), 8, 7, 8, 7, 28]), "Ludzie");
  }
  // Parametry
  const sc = (s) => [...s].sort((a, b) => b.from - a.from).map((x) => `od ${Math.round(x.from * 1000) / 10}% → ${Math.round(x.pct * 100)}%`).join("; ");
  const a4 = [["Parametry"], [`${mname(d.month)} · od ${ym(d.params_from) || "—"}`], ["Parametr", "Wartość"],
    ["Stawka bazowa (informacyjnie)", P.base_rate], ["Maksymalna premia", P.max_bonus], ["Limit bloku A", P.limit_a], ["Limit bloku B", P.limit_b],
    ["Progi stażu", P.thresholds.map((t) => `${t.days} dni × waga ${t.weight}`).join("; ")], ["Skala bloku A", sc(P.scale_a)],
    ["Próg rdzenia, dni", P.core_days], ["Skala bloku B", sc(P.scale_b)],
    ["Kara za odejście", P.penalty.enabled ? `${P.penalty.amount} zł przy stażu ${P.penalty.from_days}–${P.penalty.to_days} dni` : "wyłączona"],
    ["Status odejścia", P.exit_status], ["Pomijane statusy", P.excluded_statuses.join(", ")], ["Ignorowane przyczyny", P.ignored_reasons.join(", ")]];
  XLSX.utils.book_append_sheet(wb, makeSheet(a4, 2, {}, [30, 90]), "Parametry");
  XLSX.writeFile(wb, `premie_koordynatorow_${d.month}.xlsx`);
}

init();
