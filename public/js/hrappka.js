// ══════════════════════════════════════════════════════════════════════
//  Rozbieżności HRappka ↔ tabele (api/hr_import.js, bot/hr_import.js).
//  Dane ludzi — z HRappka (migawka codziennie o 8:00), podział na obiekty — z tabel.
//  Domyślnie: okresy otwarte i zamknięte w ostatnich 60 dniach; „Wszystkie okresy” — cała historia.
//  Koordynator widzi swoje obiekty; admin — wszystko i może odświeżyć migawkę z HRappka.
//  Jedna osoba — jeden wiersz (kilka rozbieżności = kilka znaczników).
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const TYPES = [
  ["status", "Status"], ["last_day", "Ostatni dzień"], ["passport", "Paszport"],
  ["not_in_db", "Brak w bazie"], ["not_in_hr", "Brak w HRappka"],
];
const TYPE_PL = Object.fromEntries(TYPES);
const NOTE_PL = {
  hr_only: "w HRappka jest, w tabeli brak",
  hr_missing: "w HRappka nie wpisano",
  by_name: "znaleziono po nazwisku — w HRappka inny paszport / PESEL",
  gap_small: "różnica do 7 dni — bierzemy HRappka",
  gap_big: "różnica ponad 7 dni — sprawdzić",
};
const STATUS_PL = { nie_dotarl: "Nie dotarł" };
const PAGE = 100;
const ST = { data: null, full: false, type: "", fac: "", q: "", page: 0 };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  try {
    const r = await fetch("/api/hrimport" + path, o);
    if (r.status === 401) { location.href = "/login.html"; return null; }
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

window.addEventListener("DOMContentLoaded", () => {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  load();
});

async function load() {
  document.getElementById("content").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/diffs" + (ST.full ? "?full=1" : ""));
  if (!r) return;
  if (!r.ok) { document.getElementById("content").innerHTML = `<div class="empty">${esc(r.error || "Błąd")}</div>`; return; }
  // grupujemy po osobie: { ...pierwszy wiersz, items: [{ code, note }] }
  const by = new Map();
  for (const x of r.rows) {
    const k = x.worker_id ? "w" + x.worker_id : "h" + x.hr_id;
    if (!by.has(k)) by.set(k, { ...x, items: [] });
    by.get(k).items.push({ code: x.code, note: x.note });
    if (x.hr_expected) by.get(k).hr_expected = x.hr_expected;
  }
  r.people = [...by.values()].sort((a, b) => (a.facility || "~").localeCompare(b.facility || "~", "pl") || String(a.name).localeCompare(String(b.name), "pl"));
  ST.data = r;
  ST.page = 0;
  render();
}

function filtered() {
  const q = ST.q.trim().toLowerCase();
  return ST.data.people.filter((x) =>
    (!ST.type || x.items.some((i) => i.code === ST.type)) &&
    (!ST.fac || (x.facility || "—") === ST.fac) &&
    (!q || [x.name, x.passport, x.hr_passport, x.pesel].some((v) => String(v || "").toLowerCase().includes(q))));
}

function render() {
  const r = ST.data;
  const at = r.snapshot_at ? new Date(r.snapshot_at).toLocaleString("pl", { dateStyle: "short", timeStyle: "short" }) : "brak";
  const facs = [...new Set(r.people.map((x) => x.facility || "—"))].sort((a, b) => a.localeCompare(b, "pl"));
  if (ST.fac && !facs.includes(ST.fac)) ST.fac = "";
  const base = r.people.filter((x) => !ST.fac || (x.facility || "—") === ST.fac);
  const cnt = (code) => base.filter((x) => x.items.some((i) => i.code === code)).length;

  document.getElementById("content").innerHTML = `
  <div class="banner">Porównanie bieżącego okresu w bazie (z tabel) z HRappka. Migawka HRappka: <b>${esc(at)}</b> — odświeżana codziennie o 8:00,
    wtedy też idzie mail z CSV. ${r.full ? "Pokazane <b>wszystkie okresy</b>." : `Pokazane okresy <b>otwarte i zamknięte w ostatnich ${r.recent_days} dniach</b>.`}
    Zmiany w tabelach widać od razu po imporcie tabel.</div>
  <div class="bar">
    <span class="chip ${ST.type ? "" : "on"}" onclick="setType('')">Wszystkie<b>${base.length}</b></span>
    ${TYPES.map(([c, l]) => `<span class="chip ${ST.type === c ? "on" : ""}" onclick="setType('${c}')">${l}<b>${cnt(c)}</b></span>`).join("")}
  </div>
  <div class="bar">
    <select class="sel" onchange="setFac(this.value)">
      <option value="">🏭 Wszystkie obiekty</option>
      ${facs.map((f) => `<option value="${esc(f)}" ${ST.fac === f ? "selected" : ""}>${esc(f)}</option>`).join("")}
    </select>
    <input class="inp" id="q" placeholder="Szukaj: nazwisko, paszport, PESEL" value="${esc(ST.q)}" oninput="setQ(this.value)" />
    <label class="chk"><input type="checkbox" ${ST.full ? "checked" : ""} onchange="setFull(this.checked)" /> Wszystkie okresy</label>
    <span class="spacer"></span>
    <button class="btn btn-ghost btn-sm" onclick="downloadCsv()">⬇ CSV</button>
    ${r.is_admin ? `<button class="btn btn-ghost btn-sm" id="refreshBtn" onclick="refresh()">🔄 Odśwież z HRappka</button>` : ""}
    <span class="msg" id="msg"></span>
  </div>
  <div class="section"><div id="tbl"></div></div>`;
  renderTable();
}

const has = (x, code) => x.items.some((i) => i.code === code);
// ostatni dzień w HRappka jest jeden na osobę: wcześniejszy niż BHP — to z poprzedniego okresu
const lastDayHr = (x) => (!x.hr_last_day ? null : x.bhp && x.hr_last_day < x.bhp ? `— (${dmy(x.hr_last_day)} — poprzedni okres)` : dmy(x.hr_last_day));
function cell(a, b) {
  // wartość z tabeli i z HRappka; różne — na czerwono
  const same = (a || "") === (b || "");
  return `${esc(a || "—")}<div class="sub ${same ? "" : "diff"}">HR: ${esc(b || "—")}</div>`;
}

function renderTable() {
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (ST.page >= pages) ST.page = pages - 1;
  const slice = list.slice(ST.page * PAGE, ST.page * PAGE + PAGE);
  const el = document.getElementById("tbl");
  if (!list.length) { el.innerHTML = `<div class="empty">Brak rozbieżności 🎉</div>`; return; }
  el.innerHTML = `<div class="tblwrap"><table class="fl">
    <thead><tr>
      <th>Typ</th><th>Imię i nazwisko</th><th>Obiekt (tabela)</th><th>Status tabela / HRappka</th>
      <th>BHP</th><th>Ostatni dzień tabela / HRappka</th><th>HRappka: dział, firma, umowa od</th>
    </tr></thead>
    <tbody>${slice.map((x) => `
      <tr>
        <td>${x.items.map((i) => `<div><span class="tag ${i.code}">${esc(TYPE_PL[i.code] || i.code)}</span>${i.note ? `<div class="sub">${esc(NOTE_PL[i.note] || i.note)}</div>` : ""}</div>`).join("")}</td>
        <td><b>${esc(x.name)}</b><div class="sub">${esc(x.passport || "")}${x.hr_passport && x.hr_passport !== x.passport ? ` → HR: ${esc(x.hr_passport)}` : ""}${x.pesel ? ` · PESEL ${esc(x.pesel)}` : ""}${x.birth ? ` · ur. ${dmy(x.birth)}` : ""}</div></td>
        <td>${esc(x.facility || "—")}</td>
        <td>${has(x, "status") ? `${cell(x.status, x.hr_state)}${x.hr_expected ? `<div class="sub">powinno być: <b>${esc(STATUS_PL[x.hr_expected] || x.hr_expected)}</b></div>` : ""}`
          : `${esc(x.status || "—")}<div class="sub">HR: ${esc(x.hr_state || "—")}</div>`}</td>
        <td>${dmy(x.bhp)}</td>
        <td>${has(x, "last_day") ? cell(x.lwd && dmy(x.lwd), lastDayHr(x)) : `${dmy(x.lwd)}<div class="sub">HR: ${esc(lastDayHr(x) || "—")}</div>`}</td>
        <td>${x.hr_id ? `${esc(x.hr_department || "—")}<div class="sub">${esc(x.hr_firm || "")}${x.hr_start ? ` · od ${dmy(x.hr_start)}` : ""}</div>` : `<span class="dim">—</span>`}</td>
      </tr>`).join("")}
    </tbody></table></div>
    ${pages > 1 ? `<div class="pager">
      <button class="btn btn-ghost btn-sm" ${ST.page ? "" : "disabled"} onclick="goPage(-1)">◀</button>
      ${ST.page + 1} / ${pages} · ${list.length} osób
      <button class="btn btn-ghost btn-sm" ${ST.page < pages - 1 ? "" : "disabled"} onclick="goPage(1)">▶</button></div>` : ""}`;
}

function setType(t) { ST.type = t; ST.page = 0; render(); }
function setFac(f) { ST.fac = f; ST.page = 0; render(); }
function setQ(q) { ST.q = q; ST.page = 0; renderTable(); }
function setFull(on) { ST.full = on; load(); }
function goPage(d) { ST.page += d; renderTable(); }

async function downloadCsv() {
  const r = await fetch("/api/hrimport/diffs.csv" + (ST.full ? "?full=1" : ""), { headers: { "x-session": SESSION } });
  if (!r.ok) { setMsg(false, "Błąd pobierania CSV"); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = (/filename="([^"]+)"/.exec(r.headers.get("content-disposition") || "") || [])[1] || "hrappka.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function refresh() {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Pobieranie z HRappka…";
  const r = await api("/refresh", { method: "POST" });
  if (r && r.ok) { await load(); setMsg(true, `Migawka odświeżona: ${r.people} osób w HRappka`); return; }
  btn.disabled = false;
  btn.textContent = "🔄 Odśwież z HRappka";
  setMsg(false, (r && r.error) || "Błąd");
}

function setMsg(ok, text) { const m = document.getElementById("msg"); if (m) { m.className = "msg " + (ok ? "ok" : "err"); m.textContent = text; } }
