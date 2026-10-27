// ── WORKERS PAGE ─────────────────────────────────────────────
let allWorkersData = [];
let pageWorkers = 1;

let workersCurrentGroup = '';
let workersCurrentFac = '';

// Посада (Stanowisko) — з HRappka; ще немає — «—»
function escStan(s) {
  return s ? String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) : "—";
}

// ── Kolumny: які показувати в таблиці і які йдуть в Excel (окремо), вибір пам'ятає браузер ──
const plDate = (d) => (d ? new Date(d).toLocaleDateString("pl") : "—");
const WORKER_COLS = [
  { key: "login", label: "ID", cell: (w) => `<span style="font-family:var(--mono);font-size:11px">${w.login}</span>`, xls: (w) => w.login },
  { key: "name", label: "Imie i Nazwisko", cell: (w) => `<span class="worker-name">${escStan(w.full_name)}</span>`, xls: (w) => w.full_name },
  { key: "pesel", label: "PESEL", title: "Z HRappka", cell: (w) => `<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">${w.pesel || "—"}</span>`, xls: (w) => w.pesel || "—" },
  { key: "birth", label: "Data ur.", title: "Z HRappka", cell: (w) => `<span style="font-size:11px;color:var(--text3)">${plDate(w.birth_date)}</span>`, xls: (w) => plDate(w.birth_date) },
  { key: "group", label: "Grupa", off: true, cell: (w) => `<span style="color:var(--text2);font-size:12px">${escStan(w.group_name)}</span>`, xls: (w) => w.group_name || "—" },
  { key: "facility", label: "Obiekt", cell: (w) => `<span style="color:var(--text2);font-size:12px">${escStan(w.facility_name)}</span>`, xls: (w) => w.facility_name || "—" },
  { key: "stan", label: "Stanowisko", cell: (w) => `<span style="color:var(--text2);font-size:12px">${escStan(w.stanowisko)}</span>`, xls: (w) => w.stanowisko || "—" },
  { key: "status", label: "Status", cell: (w) => `<span class="badge ${w.status === "pracuje" ? "badge-green"
      : w.status === "urlop" || w.status === "l4" ? "badge-purple"
        : w.status === "przeniesiony" ? "badge-orange" : "badge-blue"}"><span class="badge-dot"></span>${w.status || "—"}</span>`, xls: (w) => w.status || "—" },
  { key: "tg", label: "Telegram", cell: (w) => `<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">${w.telegram_chat_id ? "✅" : "—"}</span>`, xls: (w) => (w.telegram_chat_id ? "TAK" : "NIE") },
  { key: "bhp", label: "BHP", cell: (w) => `<span style="font-size:11px;color:var(--text3)">${plDate(w.bhp_date)}</span>`, xls: (w) => plDate(w.bhp_date) },
  { key: "last", label: "Ostatni dzień", cell: (w) => `<span style="font-size:11px;color:var(--text3)">${plDate(w.last_work_date)}</span>`, xls: (w) => plDate(w.last_work_date) },
  { key: "docs", label: "Dokumenty", title: "Podpisy dokumentów w HRappka", cell: (w) => hrsCell(w), xls: null },
];
const COLS_KEY = { table: "sas_workers_cols", excel: "sas_workers_cols_xls" };
function colsGet(kind) {
  try {
    const v = JSON.parse(localStorage.getItem(COLS_KEY[kind]) || "null");
    if (Array.isArray(v)) return new Set(v);
  } catch (e) {}
  return new Set(WORKER_COLS.filter((c) => !c.off && (kind === "table" || c.xls)).map((c) => c.key));
}
function colsSet(kind, set) { try { localStorage.setItem(COLS_KEY[kind], JSON.stringify([...set])); } catch (e) {} }
const visibleCols = () => { const s = colsGet("table"); return WORKER_COLS.filter((c) => s.has(c.key)); };

function renderWorkersHead() {
  const h = document.getElementById("workersHead");
  if (h) h.innerHTML = visibleCols().map((c) => `<th${c.title ? ` title="${c.title}"` : ""}>${c.label}</th>`).join("") + "<th>Akcje</th>";
}

function toggleWorkersCols(e) {
  if (e) e.stopPropagation();
  const d = document.getElementById("workersColsDrop");
  if (d.style.display === "block") { d.style.display = "none"; return; }
  const t = colsGet("table"), x = colsGet("excel");
  d.innerHTML = `<div style="display:grid;grid-template-columns:1fr auto auto;gap:4px 12px;align-items:center;font-size:12px">
      <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">KOLUMNA</span>
      <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">TABELA</span>
      <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">EXCEL</span>
      ${WORKER_COLS.map((c) => `<span>${c.label}</span>
        <input type="checkbox" ${t.has(c.key) ? "checked" : ""} onchange="setWorkersCol('table','${c.key}',this.checked)" />
        ${c.xls ? `<input type="checkbox" ${x.has(c.key) ? "checked" : ""} onchange="setWorkersCol('excel','${c.key}',this.checked)" />` : "<span></span>"}`).join("")}
    </div>`;
  // fixed — щоб не ховалось під фільтрами нижче (свій контекст накладання в картці)
  const r = e && e.currentTarget ? e.currentTarget.getBoundingClientRect() : d.parentElement.getBoundingClientRect();
  Object.assign(d.style, { position: "fixed", top: `${r.bottom + 4}px`, right: `${Math.max(8, innerWidth - r.right)}px`,
    maxHeight: `${Math.max(160, innerHeight - r.bottom - 12)}px`, overflowY: "auto", display: "block" });
}
function setWorkersCol(kind, key, on) {
  const s = colsGet(kind);
  if (on) s.add(key); else s.delete(key);
  colsSet(kind, s);
  if (kind === "table") { renderWorkersHead(); filterWorkers(false); }
}
document.addEventListener("click", (e) => {
  const d = document.getElementById("workersColsDrop");
  if (d && d.style.display === "block" && !e.target.closest("#workersColsWrap")) d.style.display = "none";
});
document.addEventListener("scroll", (e) => {
  const d = document.getElementById("workersColsDrop");
  if (d && d.style.display === "block" && !d.contains(e.target)) d.style.display = "none";
}, true);

// рядок для Excel (modules.js → exportToExcel('workers')) — лише вибрані колонки
function workerExcelRow(w) {
  const s = colsGet("excel");
  const row = {};
  for (const c of WORKER_COLS) if (c.xls && s.has(c.key)) row[c.label === "Imie i Nazwisko" ? "Imię i Nazwisko" : c.label] = c.xls(w);
  return row;
}

// ── Podpisy dokumentów w HRappka (api/hr_sign.js) ─────────────────
// HRS.rows: { worker_id: { total, signed, found, checked_at, error, docs: [{ label, status, created }] } }
const HRS = { rows: {}, from: "2026-10-15" };
async function loadSignatures() {
  try {
    const r = await apiFetch("/api/hrsign/status");
    if (r && r.ok) { HRS.rows = r.rows || {}; HRS.from = r.from || HRS.from; }
  } catch (e) { /* bez migracji — kolumna pusta */ }
}
const hrsInScope = (w) => w.bhp_date && localDate(w.bhp_date) >= HRS.from;
// unsigned | signed | missing | none (nie sprawdzano / poza zakresem)
function hrsState(w) {
  const s = HRS.rows[w.id];
  if (!s) return "none";
  if (!s.found || !s.total) return "missing";
  return s.signed >= s.total ? "signed" : "unsigned";
}
function hrsCell(w) {
  const s = HRS.rows[w.id];
  if (!s) return hrsInScope(w) ? `<span style="color:var(--text3);font-size:11px" title="Jeszcze nie sprawdzano">…</span>` : `<span style="color:var(--text3)">—</span>`;
  const when = s.checked_at ? new Date(s.checked_at).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  if (s.error) return `<span class="badge badge-orange" title="Błąd HRappka: ${escStan(s.error)}">błąd</span>`;
  if (!s.found || !s.total) return `<span class="badge badge-blue" title="Brak dokumentów do podpisu w HRappka · sprawdzono ${when}">brak w HRappka</span>`;
  const cls = s.signed >= s.total ? "badge-green" : s.signed === 0 ? "badge-red" : "badge-orange";
  return `<span class="badge ${cls}" style="cursor:pointer" onclick="hrsShow(${w.id})"
    onmouseenter="hrsHover(this, ${w.id})" onmouseleave="hrsHoverOut()">${s.signed >= s.total ? "✓" : "✗"} ${s.signed}/${s.total}</span>`;
}
// Lista dokumentów: niepodpisane — na czerwono, na górze (od 5 dni przed BHP do 10 dni po, przy powtórnej wysyłce — ostatnia)
function hrsListHtml(w, s) {
  const when = s.checked_at ? new Date(s.checked_at).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  // najpierw ankiety, potem (pod kreską) dokumenty; w każdej grupie niepodpisane / niewypełnione na górze
  const byState = (a, b) => (a.status === "SIGN") - (b.status === "SIGN");
  const surveys = s.docs.filter((d) => d.kind === "survey").sort(byState);
  const docs = s.docs.filter((d) => d.kind !== "survey").sort(byState);
  const row = (d) => `<div style="display:flex;gap:8px;align-items:baseline;font-size:13px;color:${d.status === "SIGN" ? "var(--green)" : "var(--red)"};${d.status === "SIGN" ? "" : "font-weight:600"}">
        <span>${d.status === "SIGN" ? "✓" : "✗"}</span><span style="flex:1">${d.kind === "survey" ? "📝 " : ""}${escStan(d.label)}</span>
        <span style="font-size:11px;color:var(--text3);font-weight:400">${d.created ? d.created.split("-").reverse().join(".") : ""}</span></div>`;
  const head = (t) => `<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--text3);margin-top:2px">${t}</div>`;
  return `
    <div style="font-size:13px;font-weight:600;margin-bottom:2px">📄 ${escStan(w.full_name)} · gotowe ${s.signed} z ${s.total}</div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:8px">BHP ${w.bhp_date ? new Date(w.bhp_date).toLocaleDateString("pl") : "—"} · sprawdzono ${when} · wysłane od 5 dni przed BHP do 10 po</div>
    <div style="display:flex;flex-direction:column;gap:4px;max-height:50vh;overflow-y:auto">
      ${surveys.length ? head(`Ankiety · wypełniono ${surveys.filter((d) => d.status === "SIGN").length} z ${surveys.length}`) + surveys.map(row).join("") : ""}
      ${surveys.length && docs.length ? `<div style="border-top:1px solid var(--border);margin:6px 0 2px"></div>` : ""}
      ${docs.length ? head(`Dokumenty · podpisano ${docs.filter((d) => d.status === "SIGN").length} z ${docs.length}`) + docs.map(row).join("") : ""}
    </div>`;
}
// Po najechaniu kursorem (z opóźnieniem) — dymek; kursor można przenieść na dymek (przewijanie długiej listy)
const HRS_HOVER_MS = 350;
let hrsTimer = null, hrsHideTimer = null;
function hrsPop() {
  let p = document.getElementById("hrsPop");
  if (!p) {
    p = document.createElement("div");
    p.id = "hrsPop";
    p.style.cssText = "position:fixed;z-index:120;display:none;width:440px;max-width:90vw;background:var(--surface);border:1px solid var(--border);"
      + "border-radius:10px;padding:12px 14px;box-shadow:0 10px 28px rgba(0,0,0,.45)";
    p.addEventListener("mouseenter", () => clearTimeout(hrsHideTimer));
    p.addEventListener("mouseleave", hrsHoverOut);
    document.body.appendChild(p);
  }
  return p;
}
function hrsHover(el, id) {
  clearTimeout(hrsTimer); clearTimeout(hrsHideTimer);
  hrsTimer = setTimeout(() => {
    const w = (allWorkersData || []).find((x) => x.id === id);
    const s = HRS.rows[id];
    if (!w || !s || !el.isConnected) return;
    const p = hrsPop();
    p.innerHTML = hrsListHtml(w, s);
    p.style.display = "block";
    // pod plakietką; brak miejsca — nad nią; nie wychodzi poza ekran z prawej
    const r = el.getBoundingClientRect(), ph = p.offsetHeight, pw = p.offsetWidth;
    const top = r.bottom + 6 + ph > window.innerHeight ? Math.max(8, r.top - 6 - ph) : r.bottom + 6;
    p.style.top = top + "px";
    p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
  }, HRS_HOVER_MS);
}
function hrsHoverOut() {
  clearTimeout(hrsTimer);
  clearTimeout(hrsHideTimer);
  hrsHideTimer = setTimeout(() => { const p = document.getElementById("hrsPop"); if (p) p.style.display = "none"; }, 200);
}
// Kliknięcie — to samo w oknie (telefon / gdy trzeba dłużej popatrzeć)
function hrsShow(id) {
  const w = (allWorkersData || []).find((x) => x.id === id);
  const s = HRS.rows[id];
  if (!w || !s) return;
  clearTimeout(hrsTimer);
  const pop = document.getElementById("hrsPop");
  if (pop) pop.style.display = "none";
  let ov = document.getElementById("hrsOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "hrsOverlay";
    ov.className = "modal-overlay";
    ov.innerHTML = `<div class="modal" style="width:520px" role="dialog" aria-label="Dokumenty HRappka"><div id="hrsBody"></div></div>`;
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("open"); });
    document.body.appendChild(ov);
  }
  document.getElementById("hrsBody").innerHTML = hrsListHtml(w, s) + `
    <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-ghost btn-sm" onclick="document.getElementById('hrsOverlay').classList.remove('open')">Zamknij</button></div>`;
  ov.classList.add("open");
}
// Esc — zamyka okno i dymek
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ov = document.getElementById("hrsOverlay");
  if (ov) ov.classList.remove("open");
  const p = document.getElementById("hrsPop");
  if (p) p.style.display = "none";
  clearTimeout(hrsTimer);
});
async function refreshSignatures() {
  const btn = document.getElementById("workersDocsBtn");
  const ids = (window._workersFiltered || []).filter(hrsInScope).map((w) => w.id).slice(0, 500);
  if (!ids.length) { alert("Na liście nie ma pracowników z BHP od " + HRS.from.split("-").reverse().join(".") + "."); return; }
  btn.disabled = true;
  btn.textContent = `⏳ Sprawdzam ${ids.length}…`;
  try {
    const r = await apiFetch("/api/hrsign/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
    if (!r || !r.ok) alert("HRappka: " + ((r && r.error) || "błąd"));
    else {
      Object.assign(HRS.rows, r.rows || {});
      if (r.skipped && !r.checked) alert("Ci pracownicy byli sprawdzani przed chwilą — spróbuj za minutę.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Sprawdź podpisy";
    filterWorkers(false);
  }
}

async function loadWorkersPage() {
  try {
    const [res] = await Promise.all([apiFetch("/api/workers/all"), loadSignatures()]);
    if (!res) return;
    allWorkersData = res.data;
    buildWorkersGroupFacDropdowns();
    filterWorkers();
  } catch (e) { console.error(e); }
}

function buildWorkersGroupFacDropdowns() {
  const groups = {};
  allWorkersData.forEach(w => {
    const gname = w.group_name || w.facility_name || '—';
    const fname = w.facility_name || '—';
    if (!groups[gname]) groups[gname] = new Set();
    groups[gname].add(fname);
  });
  window._workersGroups = groups;

  // Будуємо список груп
  const groupList = document.getElementById('workersGroupList');
  const sortedGroups = Object.keys(groups).sort();
  groupList.innerHTML = `
    <div onclick="selectWorkersGroup('')" style="padding:7px 14px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;color:var(--accent);background:rgba(59,130,246,.08)">
      <span>Wszystkie grupy</span>
    </div>
    ${sortedGroups.map(g => `
      <div onclick="selectWorkersGroup('${g.replace(/'/g, "\\'")}');" data-gsearch="${g.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">
        📁 ${g}
      </div>`).join('')}`;

  buildWorkersFacList();
}

function buildWorkersFacList() {
  const groups = window._workersGroups || {};
  const facList = document.getElementById('workersFacList');
  let facs = [];

  if (workersCurrentGroup) {
    facs = [...(groups[workersCurrentGroup] || [])].sort();
  } else {
    const all = new Set();
    Object.values(groups).forEach(s => s.forEach(f => all.add(f)));
    facs = [...all].sort();
  }

  facList.innerHTML = `
    <div onclick="selectWorkersFac('')" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--accent);background:rgba(59,130,246,.08)">
      Wszystkie obiekty
    </div>
    ${facs.map(f => `
      <div onclick="selectWorkersFac('${f.replace(/'/g, "\\'")}');" data-fsearch="${f.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">
        ${f}
      </div>`).join('')}`;
}

function selectWorkersGroup(gname) {
  workersCurrentGroup = gname;
  workersCurrentFac = '';
  document.getElementById('workersGroupLabel').textContent = gname ? `📁 ${gname}` : '📁 Grupa...';
  document.getElementById('workersGroupLabel').style.color = gname ? 'var(--accent)' : 'var(--text2)';
  document.getElementById('workersFacLabel').textContent = '🏭 Obiekt...';
  document.getElementById('workersFacLabel').style.color = 'var(--text2)';
  document.getElementById('workersGroupDrop').style.display = 'none';
  buildWorkersFacList();
  filterWorkers();
}

function selectWorkersFac(fname) {
  workersCurrentFac = fname;
  document.getElementById('workersFacLabel').textContent = fname ? `🏭 ${fname}` : '🏭 Obiekt...';
  document.getElementById('workersFacLabel').style.color = fname ? 'var(--accent)' : 'var(--text2)';
  document.getElementById('workersFacDrop').style.display = 'none';
  filterWorkers();
}

function toggleWorkersGroupDrop() {
  const menu = document.getElementById('workersGroupDrop');
  document.getElementById('workersFacDrop').style.display = 'none';
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  if (menu.style.display !== 'none') setTimeout(() => document.getElementById('workersGroupSearch')?.focus(), 50);
}

function toggleWorkersFacDrop() {
  const menu = document.getElementById('workersFacDrop');
  document.getElementById('workersGroupDrop').style.display = 'none';
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  if (menu.style.display !== 'none') setTimeout(() => document.getElementById('workersFacSearch')?.focus(), 50);
}

function filterWorkersGroupList() {
  const q = document.getElementById('workersGroupSearch').value.toLowerCase();
  document.querySelectorAll('#workersGroupList > div[data-gsearch]').forEach(el => {
    el.style.display = el.dataset.gsearch.includes(q) ? '' : 'none';
  });
}

function filterWorkersFacList() {
  const q = document.getElementById('workersFacSearch').value.toLowerCase();
  document.querySelectorAll('#workersFacList > div[data-fsearch]').forEach(el => {
    el.style.display = el.dataset.fsearch.includes(q) ? '' : 'none';
  });
}

async function loadWorkerStats() {
  try {
    const res = await apiFetch("/api/workers/stats");
    if (!res || !res.data) return;
    const { data } = res;
    document.getElementById("statAllWorkers").textContent = data.total;
    // координатор / регіональний: перший рядок — свої обʼєкти (регіон), нижче — уся фірма; адмін — як було
    const allSub = document.getElementById("statAllSub");
    const allCo = document.getElementById("statAllCompany");
    if (allSub && allCo) {
      const two = data.company_total != null;
      allSub.textContent = !two ? "aktywnych" : data.scope === "region" ? "aktywnych w regionie" : "aktywnych na Twoich obiektach";
      allCo.innerHTML = two ? `Cała firma: <b style="color:var(--text)">${Number(data.company_total)}</b>` : "";
      allCo.hidden = !two;
    }
    document.getElementById("statNewWorkers").textContent = data.new_this_week;
    document.getElementById("statStartedWorkers").textContent = data.started_this_week ?? "—";
    document.getElementById("statLeavingWeek").textContent = data.leaving_this_week;
    document.getElementById("statLeavingMonth").textContent = data.leaving_this_month;
  } catch (e) { console.error(e); }
}
function filterWorkers(reset = true) {
  if (reset) pageWorkers = 1;
  const q = (document.getElementById("workersSearch").value || "").toLowerCase();

  const statusSet = selectedStatuses.workers;
  const bhpFrom = document.getElementById("workersBhpFrom").value;
  const bhpTo = document.getElementById("workersBhpTo").value;
  const lastFrom = document.getElementById("workersLastFrom").value;
  const lastTo = document.getElementById("workersLastTo").value;

  const filtered = allWorkersData.filter((w) => {
    if (q && !w.full_name.toLowerCase().includes(q) && !w.login.toLowerCase().includes(q) && !(w.pesel || "").includes(q)) return false;
    if (workersCurrentFac && w.facility_name !== workersCurrentFac) return false;
    if (!workersCurrentFac && workersCurrentGroup && (w.group_name || w.facility_name) !== workersCurrentGroup) return false;
    if (statusSet.size > 0) {
      const s = (w.status || '').toLowerCase();
      const match =
        (statusSet.has('pracuje') && s === 'pracuje') ||
        (statusSet.has('zwolniony') && s === 'zwolniony') ||
        (statusSet.has('rezygnacja') && s === 'rezygnacja') ||
        (statusSet.has('przeniesiony') && s === 'przeniesiony') ||
        (statusSet.has('urlop_l4') && (s === 'urlop' || s === 'l4')) ||
        (statusSet.has('unknown') && (!s || s === 'unknown'));
      if (!match) return false;
    }
    if (bhpFrom && (!w.bhp_date || localDate(w.bhp_date) < bhpFrom)) return false;
    if (bhpTo && (!w.bhp_date || localDate(w.bhp_date) > bhpTo)) return false;
    if (lastFrom && (!w.last_work_date || localDate(w.last_work_date) < lastFrom)) return false;
    if (lastTo && (!w.last_work_date || localDate(w.last_work_date) > lastTo)) return false;
    const docs = document.getElementById("workersDocs") ? document.getElementById("workersDocs").value : "";
    if (docs && !(hrsInScope(w) && hrsState(w) === docs)) return false;
    return true;
  });
  window._workersFiltered = filtered;

  const { slice, pages } = paginate(filtered, pageWorkers, pageSizeWorkers);
  document.getElementById("workersCount").textContent = filtered.length;
  const cols = visibleCols();
  renderWorkersHead();
  document.getElementById("workersTable").innerHTML = slice.map((w) => `
    <tr>
      ${cols.map((c) => `<td>${c.cell(w)}</td>`).join("")}
      <td style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" onclick='openWorkerModal(${JSON.stringify(w)})'>Edytuj</button>
        <button class="btn btn-ghost btn-sm" onclick="openHistoryModal(${w.id},'${w.full_name.replace(/'/g, "\\'").replace(/"/g, "&quot;")}')">Historia</button>
      </td>
    </tr>`).join("") ||
    `<tr><td colspan="${cols.length + 1}" style="text-align:center;color:var(--text3);padding:20px">Brak wynikow</td></tr>`;

  renderPagination("paginationWorkers", pageWorkers, pages, "goPageWorkers");
}

function goPageWorkers(p) { pageWorkers = p; filterWorkers(false); }

function changeWorkersPageSize() {
  pageSizeWorkers = parseInt(document.getElementById("workersPageSize").value);
  pageWorkers = 1;
  filterWorkers(false);
}

function clearWorkersFilters() {
  workersCurrentGroup = '';
  workersCurrentFac = '';
  document.getElementById('workersGroupLabel').textContent = '📁 Grupa...';
  document.getElementById('workersGroupLabel').style.color = 'var(--text2)';
  document.getElementById('workersFacLabel').textContent = '🏭 Obiekt...';
  document.getElementById('workersFacLabel').style.color = 'var(--text2)';
  buildWorkersFacList();
  ["workersSearch", "workersBhpFrom", "workersBhpTo", "workersLastFrom", "workersLastTo"]
    .forEach((id) => { document.getElementById(id).value = ""; });
  selectedStatuses.workers.clear();
  updateStatusUI('workers');
  filterWorkers();
}

// ── WORKER MODAL ──────────────────────────────────────────────
async function openWorkerModal(worker) {
  document.getElementById("wm_err").textContent = "";
  const facSel = document.getElementById("wm_facility");
  facSel.innerHTML = '<option value="">— brak —</option>';
  const facRes = await apiFetch("/api/facilities");
  if (facRes && facRes.data) {
    facRes.data.forEach((f) => { facSel.innerHTML += `<option value="${f.id}">${f.name}</option>`; });
  }
  if (worker) {
    document.getElementById("workerModalTitle").textContent = "Edytuj pracownika";
    document.getElementById("wm_id").value = worker.id;
    document.getElementById("wm_login").value = worker.login;
    document.getElementById("wm_name").value = worker.full_name;
    document.getElementById("wm_status").value = worker.status;
    document.getElementById("wm_bhp").value = worker.bhp_date ? worker.bhp_date.substring(0, 10) : "";
    if (worker.facility_id) facSel.value = worker.facility_id;
  } else {
    document.getElementById("workerModalTitle").textContent = "Nowy pracownik";
    ["wm_id", "wm_login", "wm_name", "wm_bhp"].forEach((id) => { document.getElementById(id).value = ""; });
    document.getElementById("wm_status").value = "pracuje";
    facSel.value = "";
  }
  document.getElementById("workerModal").classList.add("open");
}

function closeWorkerModal() { document.getElementById("workerModal").classList.remove("open"); }

async function saveWorker() {
  const id = document.getElementById("wm_id").value;
  const login = document.getElementById("wm_login").value.trim();
  const fullName = document.getElementById("wm_name").value.trim();
  const facId = document.getElementById("wm_facility").value;
  const status = document.getElementById("wm_status").value;
  const bhp = document.getElementById("wm_bhp").value;

  if (!login || !fullName) { document.getElementById("wm_err").textContent = "Login i nazwisko sa wymagane"; return; }

  const body = { login, full_name: fullName, facility_id: facId || null, status, bhp_date: bhp || null };
  const res = id
    ? await apiFetch(`/admin/workers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    : await apiFetch("/admin/workers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (!res || !res.ok) { document.getElementById("wm_err").textContent = res?.error || "Blad zapisu"; return; }
  closeWorkerModal();
  loadWorkersPage(); loadWorkers(); loadStats(); loadWorkerStats();
}

// ── HISTORY MODAL ─────────────────────────────────────────────
async function openHistoryModal(workerId, workerName) {
  document.getElementById("historyModalTitle").textContent = `Historia: ${workerName}`;
  document.getElementById("historyModal").classList.add("open");
  document.getElementById("historyContent").innerHTML = '<div class="loading"><div class="spinner"></div>Ladowanie...</div>';

  const res = await apiFetch(`/api/workers/${workerId}/history`);
  if (!res || !res.data || !res.data.length) {
    document.getElementById("historyContent").innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">Brak historii</div>';
    return;
  }

  const statusColor = { pracuje: "badge-green", zwolniony: "badge-red", przeniesiony: "badge-orange" };
  document.getElementById("historyContent").innerHTML = `
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <thead><tr>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">OBIEKT</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">STATUS</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">BHP</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">OSTATNI DZIEŃ</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">PRZYCZYNA</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">IMPORT</th>
      </tr></thead>
      <tbody>${res.data.map((h) => `
        <tr style="border-bottom:1px solid rgba(42,51,71,.3)">
          <td style="padding:8px 12px;font-weight:500">${h.facility_name || h.source_sheet || "—"}</td>
          <td style="padding:8px 12px"><span class="badge ${statusColor[h.status] || "badge-blue"}">${h.status}</span></td>
          <td style="padding:8px 12px;font-family:var(--mono);font-size:11px;color:var(--text2)">${h.bhp_date ? new Date(h.bhp_date).toLocaleDateString("pl") : "—"}</td>
          <td style="padding:8px 12px;font-family:var(--mono);font-size:11px;color:var(--text2)">${h.last_work_date ? new Date(h.last_work_date).toLocaleDateString("pl") : "—"}</td>
          <td style="padding:8px 12px;font-size:11px;color:var(--text2)">${escStan(h.przyczyna_zwolnienia)}</td>
          <td style="padding:8px 12px;font-size:11px;color:var(--text3)">${new Date(h.imported_at).toLocaleDateString("pl")}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function closeHistoryModal() { document.getElementById("historyModal").classList.remove("open"); }

async function startImport() {
  const btn = document.getElementById("importBtn");
  btn.textContent = "⏳ Pobieranie z HRappka…"; btn.disabled = true;
  try {
    const res = await apiFetch("/api/import", { method: "POST" });
    if (res && res.ok) {
      btn.textContent = "✅ Gotowe"; btn.title = res.message || "";
      setTimeout(() => { btn.textContent = "⬇ Import z HRappka"; btn.disabled = false; }, 5000);
      loadWorkersPage(); loadWorkerStats(); loadStats();
    } else {
      btn.textContent = "❌ Blad"; setTimeout(() => { btn.textContent = "⬇ Import z HRappka"; btn.disabled = false; }, 3000);
      if (res && res.error) alert(res.error);
    }
  } catch (e) { btn.textContent = "❌ Blad"; setTimeout(() => { btn.textContent = "⬇ Import z HRappka"; btn.disabled = false; }, 3000); }
}
