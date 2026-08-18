// ── WORKERS PAGE ─────────────────────────────────────────────
let allWorkersData = [];
let pageWorkers = 1;

let workersCurrentGroup = '';
let workersCurrentFac = '';

async function loadWorkersPage() {
  try {
    const res = await apiFetch("/api/workers/all");
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
    if (q && !w.full_name.toLowerCase().includes(q) && !w.login.toLowerCase().includes(q)) return false;
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
    return true;
  });

  const { slice, pages } = paginate(filtered, pageWorkers, pageSizeWorkers);
  document.getElementById("workersCount").textContent = filtered.length;
  document.getElementById("workersTable").innerHTML = slice.map((w) => `
    <tr>
      <td><span style="font-family:var(--mono);font-size:11px">${w.login}</span></td>
      <td class="worker-name">${w.full_name}</td>
      <td style="color:var(--text2);font-size:12px">${w.facility_name || "—"}</td>
      <td><span class="badge ${w.status === "pracuje" ? "badge-green"
      : w.status === "urlop" || w.status === "l4" ? "badge-purple"
        : w.status === "przeniesiony" ? "badge-orange"
          : w.status === "rezygnacja" ? "badge-blue"
            : "badge-blue"
    }"><span class="badge-dot"></span>${w.status || "—"}</span></td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text3)">${w.telegram_chat_id ? "✅" : "—"}</td>
      <td style="font-size:11px;color:var(--text3)">${w.bhp_date ? new Date(w.bhp_date).toLocaleDateString("pl") : "—"}</td>
      <td style="font-size:11px;color:var(--text3)">${w.last_work_date ? new Date(w.last_work_date).toLocaleDateString("pl") : "—"}</td>
      <td style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" onclick='openWorkerModal(${JSON.stringify(w)})'>Edytuj</button>
        <button class="btn btn-ghost btn-sm" onclick="openHistoryModal(${w.id},'${w.full_name.replace(/'/g, "\\'").replace(/"/g, "&quot;")}')">Historia</button>
      </td>
    </tr>`).join("") ||
    `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">Brak wynikow</td></tr>`;

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
  loadWorkersPage(); loadWorkers(); loadStats();
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
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text3);font-family:var(--mono);font-size:10px">IMPORT</th>
      </tr></thead>
      <tbody>${res.data.map((h) => `
        <tr style="border-bottom:1px solid rgba(42,51,71,.3)">
          <td style="padding:8px 12px;font-weight:500">${h.facility_name || h.source_sheet || "—"}</td>
          <td style="padding:8px 12px"><span class="badge ${statusColor[h.status] || "badge-blue"}">${h.status}</span></td>
          <td style="padding:8px 12px;font-family:var(--mono);font-size:11px;color:var(--text2)">${h.bhp_date ? new Date(h.bhp_date).toLocaleDateString("pl") : "—"}</td>
          <td style="padding:8px 12px;font-family:var(--mono);font-size:11px;color:var(--text2)">${h.last_work_date ? new Date(h.last_work_date).toLocaleDateString("pl") : "—"}</td>
          <td style="padding:8px 12px;font-size:11px;color:var(--text3)">${new Date(h.imported_at).toLocaleDateString("pl")}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function closeHistoryModal() { document.getElementById("historyModal").classList.remove("open"); }

async function startImport() {
  const btn = document.getElementById("importBtn");
  btn.textContent = "⏳ Importowanie..."; btn.disabled = true;
  try {
    const res = await apiFetch("/api/import", { method: "POST" });
    if (res && res.ok) {
      btn.textContent = "✅ Gotowe";
      setTimeout(() => { btn.textContent = "⬇ Import"; btn.disabled = false; }, 5000);
      loadWorkersPage(); loadWorkerStats(); loadStats();
    } else { btn.textContent = "❌ Blad"; setTimeout(() => { btn.textContent = "⬇ Import"; btn.disabled = false; }, 3000); }
  } catch (e) { btn.textContent = "❌ Blad"; setTimeout(() => { btn.textContent = "⬇ Import"; btn.disabled = false; }, 3000); }
}
