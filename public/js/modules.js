// ── ADVANCES ─────────────────────────────────────────────────
let allAdvancesData = [];
let selectedAdvances = new Set();

// TEST-працівники: видимі у списках панелі, але виключені
// з Excel-експортів і лічильників (щоб не впливати на результати)
function isTestLogin(login) {
  return /^TEST_/i.test(login || "");
}

async function loadAdvances() {
  try {
    const res = await apiFetch("/api/advances");
    if (!res) return;
    allAdvancesData = res.data;
    const facSel = document.getElementById("advancesFacility");
    const facSet = new Set();
    allAdvancesData.forEach((a) => {
      if (a.facility_name) facSet.add(a.facility_name);
    });
    const prevFac = facSel.value;                    // ← перед перебудовою
    facSel.innerHTML = '<option value="">Wszystkie obiekty</option>';
    [...facSet].sort().forEach((name) => {
      facSel.innerHTML += `<option value="${name}">${name}</option>`;
    });
    facSel.value = prevFac;                           // ← відновити
    filterAdvances();
  } catch (e) { }
}

function filterAdvances() {
  const fac = document.getElementById("advancesFacility").value;
  const status = document.getElementById("advancesStatus").value;
  const from = document.getElementById("advancesDateFrom").value;
  const to = document.getElementById("advancesDateTo").value;
  const filtered = allAdvancesData.filter((a) => {
    if (fac && a.facility_name !== fac) return false;
    if (status && a.status !== status) return false;
    if (from && a.requested_at.substring(0, 10) < from) return false;
    if (to && a.requested_at.substring(0, 10) > to) return false;
    return true;
  });
  document.getElementById("advancesCount").textContent = filtered.length;

  // прибрати з виділення тих, кого зараз не видно
  const visibleIds = new Set(filtered.map((a) => a.id));
  selectedAdvances.forEach((id) => { if (!visibleIds.has(id)) selectedAdvances.delete(id); });

  const statusColor = {
    pending: "orange",
    approved: "green",
    rejected: "red",
    paid: "blue",
  };
  document.getElementById("advancesTable").innerHTML = filtered.length
    ? filtered
      .map(
        (a) => `
      <tr>
        <td>${a.status === "pending"
            ? `<input type="checkbox" class="adv-check" data-id="${a.id}" ${selectedAdvances.has(a.id) ? "checked" : ""} onchange="toggleAdvance(${a.id}, this.checked)">`
            : ""}</td>
        <td><div class="worker-name">${a.full_name}</div></td>
        <td><span style="font-family:var(--mono);font-size:11px;color:var(--text3)">#${a.login}</span></td>
        <td style="color:var(--text2);font-size:12px">${a.facility_name || "—"}</td>
        <td style="font-size:12px">${a.bhp_date ? new Date(a.bhp_date).toLocaleDateString("pl") : "—"}</td>
        <td>${new Date(a.requested_at).toLocaleDateString("pl")}</td>
        <td style="font-family:var(--mono);font-weight:600;color:var(--accent2)">
        ${a.hours_this_month > 0 ? parseFloat(a.hours_this_month).toFixed(1) + 'h' : '—'}
        </td>
        <td><span class="badge badge-${statusColor[a.status] || "blue"}">${a.status}</span></td>
        <td style="display:flex;gap:4px">
          ${a.status === "pending"
            ? `
            <button class="btn btn-ghost btn-sm" style="color:var(--green);border-color:var(--green)" onclick="updateAdvance(${a.id},'approved')">✓</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" onclick="updateAdvance(${a.id},'rejected')">✕</button>
          `
            : "—"
          }
        </td>
      </tr>`,
      )
      .join("")
    : `<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:20px">Brak zaliczek</td></tr>`;

  updateBatchBar();
}

function toggleAdvance(id, checked) {
  if (checked) selectedAdvances.add(id);
  else selectedAdvances.delete(id);
  updateBatchBar();
}

function toggleAllAdvances(checked) {
  document.querySelectorAll(".adv-check").forEach((cb) => {
    cb.checked = checked;
    const id = parseInt(cb.dataset.id);
    if (checked) selectedAdvances.add(id);
    else selectedAdvances.delete(id);
  });
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById("advBatchBar");
  if (!bar) return;
  const n = selectedAdvances.size;
  bar.style.display = n > 0 ? "flex" : "none";
  const cnt = document.getElementById("advBatchCount");
  if (cnt) cnt.textContent = n;
  const selAll = document.getElementById("advSelectAll");
  if (selAll && n === 0) selAll.checked = false;  // зняти галку, коли порожньо
}

function updateBatchBar() {
  const bar = document.getElementById("advBatchBar");
  if (!bar) return;
  const n = selectedAdvances.size;
  bar.style.display = n > 0 ? "flex" : "none";
  const cnt = document.getElementById("advBatchCount");
  if (cnt) cnt.textContent = n;
}

async function batchAdvances(action) {
  const ids = [...selectedAdvances];
  if (!ids.length) return;
  const res = await apiFetch("/api/advances/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  if (res && res.ok) {
    showToast(action === "approve"
      ? `✅ Zatwierdzono: ${res.updated}`
      : `❌ Odrzucono: ${res.updated}`);
    selectedAdvances.clear();
    loadAdvances();
  } else {
    showToast("⚠️ Błąd");
  }
}

function clearAdvancesFilters() {
  [
    "advancesFacility",
    "advancesStatus",
    "advancesDateFrom",
    "advancesDateTo",
  ].forEach((id) => {
    document.getElementById(id).value = "";
  });
  filterAdvances();
}

async function updateAdvance(id, status) {
  const label = status === "approved" ? "zatwierdź" : "odrzuć";
  //if (!confirm(`Czy chcesz ${label} tę zaliczkę?`)) return;
  const res = await apiFetch(`/api/advances/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (res && res.ok) {
    showToast(
      status === "approved"
        ? "✅ Zaliczka zatwierdzona"
        : "❌ Zaliczka odrzucona",
    );
    loadAdvances();
  } else {
    showToast("⚠️ Błąd");
  }
}

// ── DAYOFF ────────────────────────────────────────────────────
let allDayoff = [];
let selectedDayoff = new Set();


function toggleDayoff(id, checked) {
  if (checked) selectedDayoff.add(id);
  else selectedDayoff.delete(id);
  updateDayoffBar();
}

function toggleAllDayoff(checked) {
  document.querySelectorAll(".dayoff-check").forEach((cb) => {
    cb.checked = checked;
    const id = parseInt(cb.dataset.id);
    if (checked) selectedDayoff.add(id);
    else selectedDayoff.delete(id);
  });
  updateDayoffBar();
}

function updateDayoffBar() {
  const bar = document.getElementById("dayoffBatchBar");
  if (!bar) return;
  const n = selectedDayoff.size;
  bar.style.display = n > 0 ? "flex" : "none";
  const cnt = document.getElementById("dayoffBatchCount");
  if (cnt) cnt.textContent = n;
  const selAll = document.getElementById("dayoffSelectAll");
  if (selAll && n === 0) selAll.checked = false;
}

async function batchDayoff(action) {
  const ids = [...selectedDayoff];
  if (!ids.length) return;
  const res = await apiFetch("/api/day-off/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  if (res && res.ok) {
    showToast(action === "approve" ? `✅ Zatwierdzono: ${res.updated}` : `❌ Odrzucono: ${res.updated}`);
    selectedDayoff.clear();
    loadDayoffPage();
  } else {
    showToast("⚠️ Błąd");
  }
}



async function loadDayoffPage() {
  try {
    const res = await apiFetch("/api/day-off");
    if (!res) return;
    allDayoff = res.data;
    const facSel = document.getElementById("dayoffFacility");
    const facSet = new Set();
    allDayoff.forEach((d) => {
      if (d.facility_name) facSet.add(d.facility_name);
    });
    const prevFac = facSel.value;
    facSel.innerHTML = '<option value="">Wszystkie obiekty</option>';
    [...facSet].sort().forEach((name) => {
      facSel.innerHTML += `<option value="${name}">${name}</option>`;
    });
    facSel.value = prevFac;
    filterDayoff();
  } catch (e) {
    console.error(e);
  }
}

function filterDayoff() {
  const q = (document.getElementById("dayoffSearch").value || "").toLowerCase();
  const fac = document.getElementById("dayoffFacility").value;
  const status = document.getElementById("dayoffStatus").value;
  const from = document.getElementById("dayoffDateFrom").value;
  const to = document.getElementById("dayoffDateTo").value;
  const filtered = allDayoff.filter((d) => {
    if (
      q &&
      !d.full_name.toLowerCase().includes(q) &&
      !d.login.toLowerCase().includes(q)
    )
      return false;
    if (fac && d.facility_name !== fac) return false;
    if (status && d.status !== status) return false;
    if (from || to) {
      const match = (d.days || []).some((day) => {
        const dt = day.substring(0, 10);
        if (from && dt < from) return false;
        if (to && dt > to) return false;
        return true;
      });
      if (!match) return false;
    }
    return true;
  });
  document.getElementById("dayoffCount").textContent = filtered.length;

  // прибрати з виділення тих, кого не видно
  const visibleIds = new Set(filtered.map((d) => d.id));
  selectedDayoff.forEach((id) => { if (!visibleIds.has(id)) selectedDayoff.delete(id); });

  const statusColor = {
    pending: "badge-orange",
    approved: "badge-green",
    rejected: "badge-red",
  };
  document.getElementById("dayoffTable").innerHTML =
    filtered
      .map((d) => {
        const days = (d.days || [])
          .map((day) => {
            const dt = new Date(day);
            return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
          })
          .join(", ");
        return `<tr>
      <td>${d.status === "pending"
            ? `<input type="checkbox" class="dayoff-check" data-id="${d.id}" ${selectedDayoff.has(d.id) ? "checked" : ""} onchange="toggleDayoff(${d.id}, this.checked)">`
            : ""}</td>
      <td><div class="worker-name">${d.full_name}</div><div class="worker-id">#${d.login}</div></td>
      <td style="color:var(--text2);font-size:12px">${d.facility_name || "—"}</td>
      <td style="font-family:var(--mono);font-size:11px">${days}</td>
      <td style="font-size:11px;color:var(--text3)">${new Date(d.requested_at).toLocaleDateString("pl")}</td>
      <td><span class="badge ${statusColor[d.status] || "badge-blue"}">${d.status}</span></td>
      <td style="display:flex;gap:4px">
        ${d.status === "pending"
            ? `<button class="btn btn-ghost btn-sm" style="color:var(--green);border-color:var(--green)" onclick="updateDayoff(${d.id},'approved')">✓</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" onclick="updateDayoff(${d.id},'rejected')">✕</button>`
            : "—"}
      </td>
    </tr>`;
      })
      .join("") ||
    `<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">Brak wniosków</td></tr>`;

  updateDayoffBar();
}

async function updateDayoff(id, status) {
  const label = status === "approved" ? "підтвердити" : "відхилити";
  // if (!confirm(`Ви впевнені, що хочете ${label} цей вихідний?`)) return;
  const res = await apiFetch(`/api/day-off/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (res && res.ok) {
    showToast(status === "approved" ? "✅ Підтверджено" : "❌ Відхилено");
    loadDayoffPage();
  } else {
    showToast("⚠️ Помилка при оновленні");
  }
}

// ── HISTORY PAGE ──────────────────────────────────────────────
let allHistory = [];
let pageHistory = 1;

async function loadHistoryPage() {
  allHistory = [];
  document.getElementById("historyTable").innerHTML =
    `<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:40px">
      Введіть фільтри і натисніть "Szukaj"
    </td></tr>`;
  document.getElementById("historyCount").textContent = "0";

  try {
    const res = await apiFetch("/api/facilities");
    if (!res) return;
    // Старий select більше не потрібен — просто будуємо dropdown
    buildHistoryGroupFacDropdowns();
  } catch (e) { console.error(e); }
}

let historyCurrentGroup = '';
let historyCurrentFac = '';

function buildHistoryGroupFacDropdowns() {
  const groups = {};
  // Беремо з facilities які вже завантажені
  apiFetch('/api/facilities').then(res => {
    if (!res) return;
    res.data.forEach(f => {
      const gname = f.group_name || f.name;
      if (!groups[gname]) groups[gname] = [];
      groups[gname].push(f.name);
    });
    window._historyGroups = groups;

    const groupList = document.getElementById('historyGroupList');
    if (!groupList) return;
    const sortedGroups = Object.keys(groups).sort();
    groupList.innerHTML = `
      <div onclick="selectHistoryGroup('')" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--accent);background:rgba(59,130,246,.08)">Wszystkie grupy</div>
      ${sortedGroups.map(g => `
        <div onclick="selectHistoryGroup('${g.replace(/'/g, "\\'")}');" data-gsearch="${g.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">📁 ${g}</div>
      `).join('')}`;

    buildHistoryFacList();
  });
}

function buildHistoryFacList() {
  const groups = window._historyGroups || {};
  const facList = document.getElementById('historyFacList');
  if (!facList) return;

  let facs = [];
  if (historyCurrentGroup) {
    facs = (groups[historyCurrentGroup] || []).sort();
  } else {
    const all = new Set();
    Object.values(groups).forEach(arr => arr.forEach(f => all.add(f)));
    facs = [...all].sort();
  }

  facList.innerHTML = `
    <div onclick="selectHistoryFac('')" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--accent);background:rgba(59,130,246,.08)">Wszystkie obiekty</div>
    ${facs.map(f => `
      <div onclick="selectHistoryFac('${f.replace(/'/g, "\\'")}');" data-fsearch="${f.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">${f}</div>
    `).join('')}`;
}

function selectHistoryGroup(gname) {
  historyCurrentGroup = gname;
  historyCurrentFac = '';
  document.getElementById('historyGroupLabel').textContent = gname ? `📁 ${gname}` : '📁 Grupa...';
  document.getElementById('historyGroupLabel').style.color = gname ? 'var(--accent)' : 'var(--text2)';
  document.getElementById('historyFacLabel').textContent = '🏭 Obiekt...';
  document.getElementById('historyFacLabel').style.color = 'var(--text2)';
  document.getElementById('historyGroupDrop').style.display = 'none';
  buildHistoryFacList();
}

function selectHistoryFac(fname) {
  historyCurrentFac = fname;
  document.getElementById('historyFacLabel').textContent = fname ? `🏭 ${fname}` : '🏭 Obiekt...';
  document.getElementById('historyFacLabel').style.color = fname ? 'var(--accent)' : 'var(--text2)';
  document.getElementById('historyFacDrop').style.display = 'none';
}

function toggleHistoryGroupDrop() {
  const menu = document.getElementById('historyGroupDrop');
  document.getElementById('historyFacDrop').style.display = 'none';
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  if (menu.style.display !== 'none') setTimeout(() => document.getElementById('historyGroupSearch')?.focus(), 50);
}

function toggleHistoryFacDrop() {
  const menu = document.getElementById('historyFacDrop');
  document.getElementById('historyGroupDrop').style.display = 'none';
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  if (menu.style.display !== 'none') setTimeout(() => document.getElementById('historyFacSearch')?.focus(), 50);
}

function filterHistoryGroupList() {
  const q = document.getElementById('historyGroupSearch').value.toLowerCase();
  document.querySelectorAll('#historyGroupList > div[data-gsearch]').forEach(el => {
    el.style.display = el.dataset.gsearch.includes(q) ? '' : 'none';
  });
}

function filterHistoryFacList() {
  const q = document.getElementById('historyFacSearch').value.toLowerCase();
  document.querySelectorAll('#historyFacList > div[data-fsearch]').forEach(el => {
    el.style.display = el.dataset.fsearch.includes(q) ? '' : 'none';
  });
}
async function searchHistory() {
  try {
    const q = document.getElementById("historySearch").value;
    const bhpFrom = document.getElementById("historyBhpFrom").value;
    const bhpTo = document.getElementById("historyBhpTo").value;
    const lastFrom = document.getElementById("historyLastFrom").value;
    const lastTo = document.getElementById("historyLastTo").value;

    const params = new URLSearchParams();
    if (q) params.set("search", q);
    if (historyCurrentFac) {
      params.set("facility_name", historyCurrentFac);
    } else if (historyCurrentGroup) {
      const groups = window._historyGroups || {};
      const facs = groups[historyCurrentGroup] || [];
      if (facs.length > 0) params.set("facility_names", facs.join(','));
    }
    if (bhpFrom) params.set("bhp_from", bhpFrom);
    if (bhpTo) params.set("bhp_to", bhpTo);
    if (lastFrom) params.set("last_from", lastFrom);
    if (lastTo) params.set("last_to", lastTo);

    document.getElementById("historyTable").innerHTML =
      '<tr><td colspan="6"><div class="loading"><div class="spinner"></div>Ladowanie...</div></td></tr>';

    const result = await apiFetch(`/api/history?${params.toString()}`);
    if (!result) return;
    allHistory = result.data;

    filterHistory();
  } catch (e) {
    console.error(e);
  }
}


function filterHistory(reset = true) {
  if (reset) pageHistory = 1;
  const q = (document.getElementById("historySearch").value || "").toLowerCase();

  const statusSet = selectedStatuses.history;
  const bhpFrom = document.getElementById("historyBhpFrom").value;
  const bhpTo = document.getElementById("historyBhpTo").value;
  const lastFrom = document.getElementById("historyLastFrom").value;
  const lastTo = document.getElementById("historyLastTo").value;

  const filtered = allHistory.filter((h) => {
    if (q && !h.full_name.toLowerCase().includes(q) && !h.login.toLowerCase().includes(q)) return false;
    if (historyCurrentFac && h.facility_name !== historyCurrentFac) return false;
    if (!historyCurrentFac && historyCurrentGroup) {
      const groups = window._historyGroups || {};
      const facs = groups[historyCurrentGroup] || [];
      if (!facs.includes(h.facility_name)) return false;
    }
    if (statusSet.size > 0) {
      const s = (h.status || '').toLowerCase();
      const match =
        (statusSet.has('pracuje') && s === 'pracuje') ||
        (statusSet.has('zwolniony') && s === 'zwolniony') ||
        (statusSet.has('rezygnacja') && s === 'rezygnacja') ||
        (statusSet.has('przeniesiony') && s === 'przeniesiony') ||
        (statusSet.has('urlop_l4') && (s === 'urlop' || s === 'l4')) ||
        (statusSet.has('unknown') && (!s || s === 'unknown'));
      if (!match) return false;
    }
    if (bhpFrom && (!h.bhp_date || localDate(h.bhp_date) < bhpFrom)) return false;
    if (bhpTo && (!h.bhp_date || localDate(h.bhp_date) > bhpTo)) return false;
    if (lastFrom && (!h.last_work_date || localDate(h.last_work_date) < lastFrom)) return false;
    if (lastTo && (!h.last_work_date || localDate(h.last_work_date) > lastTo)) return false;
    return true;
  });

  const { slice, pages } = paginate(filtered, pageHistory, pageSizeHistory);
  document.getElementById("historyCount").textContent = filtered.length;
  const statusColor = {
    pracuje: "badge-green",
    zwolniony: "badge-red",
    rezygnacja: "badge-blue",
    przeniesiony: "badge-orange",
  };

  document.getElementById("historyTable").innerHTML =
    slice
      .map(
        (h) => `
    <tr>
      <td><div class="worker-name">${h.full_name}</div><div class="worker-id">#${h.login}</div></td>
      <td style="color:var(--text2);font-size:12px">${h.facility_name || h.source_sheet || "—"}</td>
      <td><span class="badge ${statusColor[h.status] || "badge-blue"}">${h.status}</span></td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text2)">${h.bhp_date ? new Date(h.bhp_date).toLocaleDateString("pl") : "—"}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--text2)">${h.last_work_date ? new Date(h.last_work_date).toLocaleDateString("pl") : "—"}</td>
      <td style="font-size:11px;color:var(--text3)">${new Date(h.imported_at).toLocaleDateString("pl")}</td>
    </tr>`,
      )
      .join("") ||
    `<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">Brak wynikow</td></tr>`;

  renderPagination("paginationHistory", pageHistory, pages, "goPageHistory");
}

function goPageHistory(p) {
  pageHistory = p;
  filterHistory(false);
}
function changeHistoryPageSize() {
  pageSizeHistory = parseInt(document.getElementById("historyPageSize").value);
  pageHistory = 1;
  filterHistory(false);
}

// ── SETTINGS ─────────────────────────────────────────────────
async function loadSettingsTable() {
  const fid = document.getElementById("facilitySelect")?.value || "";
  const res = await fetch("/api/facility-settings-all", {
    headers: { "x-session": localStorage.getItem("sas_session") },
  });
  let data = await res.json();
  if (fid) data = data.filter((f) => String(f.facility_id) === String(fid));
  const tbody = document.getElementById("settingsTable");
  tbody.innerHTML = "";
  data.forEach((f) => {
    const fmt = f.hours_format || 'whole';
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${f.name}</td>
      <td><label class="switch"><input type="checkbox" ${f.enable_advances ? "checked" : ""} onchange="updateField(${f.facility_id},'enable_advances',this.checked)"><span class="slider"></span></label></td>
      <td><label class="switch"><input type="checkbox" ${f.enable_wolne ? "checked" : ""} onchange="updateField(${f.facility_id},'enable_wolne',this.checked)"><span class="slider"></span></label></td>
      <td><label class="switch"><input type="checkbox" ${f.enable_tabele ? "checked" : ""} onchange="updateField(${f.facility_id},'enable_tabele',this.checked)"><span class="slider"></span></label></td>
      <td>
        <select class="input-small" onchange="updateField(${f.facility_id},'hours_format',this.value)" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:4px 6px;font-size:12px;">
          <option value="whole" ${fmt === 'whole' ? 'selected' : ''}>Цілі (1,2,3)</option>
          <option value="quarter" ${fmt === 'quarter' ? 'selected' : ''}>З .75</option>
          <option value="both" ${fmt === 'both' ? 'selected' : ''}>Обидва</option>
        </select>
      </td>
      <td><input type="number" value="${f.days_keyboard}" class="input-small" onchange="updateField(${f.facility_id},'days_keyboard',this.value)"></td>
      <td><label class="switch"><input type="checkbox" ${f.reminders_enabled ? "checked" : ""} onchange="updateField(${f.facility_id},'reminders_enabled',this.checked)"><span class="slider"></span></label></td>
      <td>
        <div class="time-list" id="times-${f.facility_id}">
            ${(f.reminder_times || ["18:00"])
        .filter(t => t)
        .map(
          (t) => `
            <div class="time-row">
              <input type="time" value="${t}" onchange="updateTime(${f.facility_id})">
              <button onclick="removeTime(this)">✕</button>
            </div>`,
        )
        .join("")}
          <button onclick="addTime(${f.facility_id})" class="btn btn-sm">＋</button>
        </div>
      </td>`;
    tbody.appendChild(row);
  });
}

async function updateField(facilityId, field, value) {
  await fetch(`/api/facility-settings/${facilityId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  });
  showToast("✔ Zapisano");
}

function addTime(fid) {
  const container = document.getElementById(`times-${fid}`);
  const div = document.createElement("div");
  div.className = "time-row";
  div.innerHTML = `<input type="time" value="18:00" onchange="updateTime(${fid})"><button onclick="removeTime(this)">✕</button>`;
  container.appendChild(div);
}

function removeTime(btn) {
  btn.parentElement.remove();
}

async function updateTime(fid) {
  const container = document.getElementById(`times-${fid}`);
  const times = [...container.querySelectorAll("input")]
    .map((i) => i.value)
    .filter((v) => v);
  await updateField(fid, "reminder_times", times);
}

// ── EXCEL EXPORT ──────────────────────────────────────────────
function getFilteredWorkers() {
  const q = (
    document.getElementById("workersSearch").value || ""
  ).toLowerCase();
  const statusSet = selectedStatuses.workers;
  const bhpFrom = document.getElementById("workersBhpFrom").value;
  const bhpTo = document.getElementById("workersBhpTo").value;
  const lastFrom = document.getElementById("workersLastFrom").value;
  const lastTo = document.getElementById("workersLastTo").value;

  return allWorkersData.filter((w) => {
    if (
      q &&
      !w.full_name.toLowerCase().includes(q) &&
      !w.login.toLowerCase().includes(q)
    )
      return false;
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
    if (bhpFrom && (!w.bhp_date || localDate(w.bhp_date) < bhpFrom))
      return false;
    if (bhpTo && (!w.bhp_date || localDate(w.bhp_date) > bhpTo)) return false;
    if (
      lastFrom &&
      (!w.last_work_date || localDate(w.last_work_date) < lastFrom)
    )
      return false;
    if (lastTo && (!w.last_work_date || localDate(w.last_work_date) > lastTo))
      return false;
    return true;
  });
}

function getFilteredDayoff() {
  const q = (document.getElementById("dayoffSearch").value || "").toLowerCase();
  const fac = document.getElementById("dayoffFacility").value;
  const status = document.getElementById("dayoffStatus").value;
  const from = document.getElementById("dayoffDateFrom").value;
  const to = document.getElementById("dayoffDateTo").value;
  return allDayoff.filter((d) => {
    if (
      q &&
      !d.full_name.toLowerCase().includes(q) &&
      !d.login.toLowerCase().includes(q)
    )
      return false;
    if (fac && d.facility_name !== fac) return false;
    if (status && d.status !== status) return false;
    if (from || to) {
      const match = (d.days || []).some((day) => {
        const dt = day.substring(0, 10);
        if (from && dt < from) return false;
        if (to && dt > to) return false;
        return true;
      });
      if (!match) return false;
    }
    return true;
  });
}

function getFilteredAdvances() {
  const fac = document.getElementById("advancesFacility").value;
  const status = document.getElementById("advancesStatus").value;
  const from = document.getElementById("advancesDateFrom").value;
  const to = document.getElementById("advancesDateTo").value;
  return allAdvancesData.filter((a) => {
    if (fac && a.facility_name !== fac) return false;
    if (status && a.status !== status) return false;
    if (from && a.requested_at.substring(0, 10) < from) return false;
    if (to && a.requested_at.substring(0, 10) > to) return false;
    return true;
  });
}

function exportToExcel(type) {
  if (typeof XLSX === "undefined") {
    showToast("⚠️ Biblioteka Excel nie jest załadowana");
    return;
  }
  let data = [],
    filename = "";
  const today = new Date().toISOString().substring(0, 10);

  if (type === "workers") {
    // TEST не потрапляють у експорт (не впливають на чисельність)
    data = getFilteredWorkers()
      .filter((w) => !isTestLogin(w.login))
      .map((w) => ({
        ID: w.login,
        "Imię i Nazwisko": w.full_name,
        Obiekt: w.facility_name || "—",
        Status: w.status || "—",
        Telegram: w.telegram_chat_id ? "TAK" : "NIE",
        BHP: w.bhp_date ? new Date(w.bhp_date).toLocaleDateString("pl") : "—",
        "Ostatni dzień": w.last_work_date
          ? new Date(w.last_work_date).toLocaleDateString("pl")
          : "—",
      }));
    filename = `pracownicy_${today}.xlsx`;
  } else if (type === "dayoff") {
    data = getFilteredDayoff()
      .filter((d) => !isTestLogin(d.login))
      .map((d) => ({
        Pracownik: d.full_name,
        Login: d.login,
        Obiekt: d.facility_name || "—",
        "Dni wolne": (d.days || [])
          .map((day) => {
            const dt = new Date(day);
            return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
          })
          .join(", "),
        "Data wniosku": new Date(d.requested_at).toLocaleDateString("pl"),
        Status: d.status,
      }));
    filename = `wychodne_${today}.xlsx`;
  } else if (type === "advances") {
    data = getFilteredAdvances()
      .filter((a) => !isTestLogin(a.login))
      .map((a) => ({
        Pracownik: a.full_name,
        Login: a.login,
        Obiekt: a.facility_name || "—",
        "Data BHP": a.bhp_date ? new Date(a.bhp_date).toLocaleDateString("pl") : "—",
        "Data wniosku": new Date(a.requested_at).toLocaleDateString("pl"),
        "Godziny (mies.)": a.hours_this_month > 0 ? parseFloat(a.hours_this_month).toFixed(1) : "0",
        Status: a.status,
      }));
    filename = `zaliczki_${today}.xlsx`;

  } else if (type === "hours") {
    const month = document.getElementById("monthSelect").value;
    const [year, mm] = month.split("-");
    const daysInMonth = new Date(parseInt(year), parseInt(mm), 0).getDate();

    const q = document.getElementById("searchInput").value.toLowerCase();

    const currentGroup = window._currentGroup || '';
    const workers = currentFacility
      ? allWorkers.filter((w) => w.facility_id == currentFacility)
      : currentGroup
        ? allWorkers.filter((w) => (w.group_name || w.facility_name) === currentGroup)
        : allWorkers;

    // TEST не потрапляють у експорт годин (не впливають на суми)
    const filtered = workers.filter((w) =>
      !isTestLogin(w.login) &&
      (!q || w.full_name.toLowerCase().includes(q) || w.login.includes(q))
    );

    // Заголовки днів
    const dayHeaders = Array.from({ length: daysInMonth }, (_, i) =>
      String(i + 1).padStart(2, "0")
    );

    data = filtered.map((w) => {
      const dayMap = {};
      (w.hours || []).forEach((h) => {
        const d = new Date(h.work_date).getDate();
        dayMap[d] = h;
      });

      let total = 0;
      const dayCells = {};
      dayHeaders.forEach((day) => {
        const h = dayMap[parseInt(day)];
        if (h) {
          if (h.hours !== null) {
            dayCells[day] = parseFloat(h.hours);
            total += parseFloat(h.hours);
          } else {
            dayCells[day] = h.absence_type || "";
          }
        } else {
          dayCells[day] = null;
        }
      });

      const row = {};
      row["Pracownik"] = w.full_name;
      row["Login"] = w.login;
      row["Obiekt"] = w.facility_name || "—";
      dayHeaders.forEach((day) => {
        row[` ${day}`] = dayCells[day];
      });
      row["Suma"] = Math.round(total * 100) / 100;
      return row;
    });
    filename = `godziny_${month}.xlsx`;
  } else if (type === "history") {
    const q = (document.getElementById("historySearch").value || "").toLowerCase();
    const statusSet = selectedStatuses.history;
    const bhpFrom = document.getElementById("historyBhpFrom").value;
    const bhpTo = document.getElementById("historyBhpTo").value;
    const lastFrom = document.getElementById("historyLastFrom").value;
    const lastTo = document.getElementById("historyLastTo").value;
    data = allHistory.filter((h) => {
      if (isTestLogin(h.login)) return false;
      if (q && !h.full_name.toLowerCase().includes(q) && !h.login.toLowerCase().includes(q)) return false;
      if (historyCurrentFac && h.facility_name !== historyCurrentFac) return false;
      if (!historyCurrentFac && historyCurrentGroup) {
        const groups = window._historyGroups || {};
        const facs = groups[historyCurrentGroup] || [];
        if (!facs.includes(h.facility_name)) return false;
      }
      if (statusSet.size > 0) {
        const s = (h.status || '').toLowerCase();
        const match =
          (statusSet.has('pracuje') && s === 'pracuje') ||
          (statusSet.has('zwolniony') && s === 'zwolniony') ||
          (statusSet.has('rezygnacja') && s === 'rezygnacja') ||
          (statusSet.has('przeniesiony') && s === 'przeniesiony') ||
          (statusSet.has('urlop_l4') && (s === 'urlop' || s === 'l4')) ||
          (statusSet.has('unknown') && (!s || s === 'unknown'));
        if (!match) return false;
      }
      if (bhpFrom && (!h.bhp_date || localDate(h.bhp_date) < bhpFrom)) return false;
      if (bhpTo && (!h.bhp_date || localDate(h.bhp_date) > bhpTo)) return false;
      if (lastFrom && (!h.last_work_date || localDate(h.last_work_date) < lastFrom)) return false;
      if (lastTo && (!h.last_work_date || localDate(h.last_work_date) > lastTo)) return false;
      return true;
    }).map((h) => ({
      "Pracownik": h.full_name,
      "Login": h.login,
      "Obiekt": h.facility_name || "—",
      "Status": h.status || "—",
      "BHP": h.bhp_date ? new Date(h.bhp_date).toLocaleDateString("pl") : "—",
      "Ostatni dzień": h.last_work_date ? new Date(h.last_work_date).toLocaleDateString("pl") : "—",
      "Import": new Date(h.imported_at).toLocaleDateString("pl"),
    }));
    filename = `historia_${today}.xlsx`;
  }

  if (!data.length) {
    showToast("⚠️ Brak danych do eksportu");
    return;
  }
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!cols"] = Object.keys(data[0]).map((key) => ({
    wch:
      Math.max(
        key.length,
        ...data.map((row) => String(row[key] || "").length),
      ) + 2,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
  showToast(`✅ Eksport: ${data.length} wierszy`);
}

// ── TABELE ────────────────────────────────────────────────────
let allTabeleData = [];

async function loadTabelePage() {
  try {
    const monthSel = document.getElementById("tabeleMonth");
    const facSel = document.getElementById("tabeleFacility");

    // Місяці — тільки один раз
    if (!monthSel.options.length) {
      const now = new Date();
      for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleString("pl", { month: "long", year: "numeric" });
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        if (i === 0) opt.selected = true;
        monthSel.appendChild(opt);
      }
    }

    // Об'єкти — тільки один раз
    if (facSel.options.length <= 1) {
      const facRes = await apiFetch("/api/facilities");
      if (facRes && facRes.data) {
        facSel.innerHTML = '<option value="">Wszystkie obiekty</option>';
        facRes.data.forEach((f) => {
          facSel.innerHTML += `<option value="${f.name}">${f.name}</option>`;
        });
      }
    }

    const month = monthSel.value;
    const res = await apiFetch(`/api/tabele?month=${month}`);
    if (!res) return;
    allTabeleData = res.data;

    filterTabele();
  } catch (e) {
    console.error(e);
  }
}

function filterTabele() {
  const fac = document.getElementById("tabeleFacility").value;
  const status = document.getElementById("tabeleStatus").value;

  const filtered = allTabeleData.filter((w) => {
    if (fac && w.facility_name !== fac) return false;
    if (status === "received" && !w.received) return false;
    if (status === "missing" && w.received) return false;
    return true;
  });

  // Лічильники — без TEST (список нижче показує всіх, включно з TEST)
  const countable = filtered.filter((w) => !isTestLogin(w.login));
  const received = countable.filter((w) => w.received).length;
  const missing = countable.filter((w) => !w.received).length;

  document.getElementById("tabeleCount").textContent = filtered.length;
  document.getElementById("tabeleTotal").textContent = countable.length;
  document.getElementById("tabeleReceived").textContent = received;
  document.getElementById("tabeleMissing").textContent = missing;

  document.getElementById("tabeleTable").innerHTML =
    filtered
      .map(
        (w) => `
    <tr>
      <td><div class="worker-name">${w.full_name}</div><div class="worker-id">#${w.login}</div></td>
      <td style="color:var(--text2);font-size:12px">${w.facility_name || "—"}</td>
      <td style="font-family:var(--mono);font-size:11px">${w.month || "—"}</td>
      <td>
        ${w.received
            ? `<button class="btn btn-ghost btn-sm" onclick="viewTabele(${w.id},'${w.full_name}')">📷 Переглянути</button>`
            : "—"
          }
        ${w.file_count > 1 ? `<span style="font-size:10px;color:var(--text3);margin-left:4px">(${w.file_count} фото)</span>` : ""}
      </td>
      <td style="font-size:11px;color:var(--text3)">${w.sent_at ? new Date(w.sent_at).toLocaleDateString("pl") : "—"}</td>
      <td>${w.received
            ? `<span class="badge badge-green">✅ отримано</span>`
            : `<span class="badge badge-red">❌ не отримано</span>`
          }
      </td>
    </tr>`,
      )
      .join("") ||
    `<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">Brak danych</td></tr>`;
}

async function viewTabele(workerId, workerName) {
  document.getElementById("tabeleModalTitle").textContent =
    `Табелі: ${workerName}`;
  document.getElementById("tabeleModalContent").innerHTML =
    '<div class="loading"><div class="spinner"></div>Ladowanie...</div>';
  document.getElementById("tabeleModal").classList.add("open");

  const month = document.getElementById("tabeleMonth").value;
  const session = localStorage.getItem("sas_session");
  const res = await apiFetch(`/api/tabele/worker/${workerId}?month=${month}`);
  if (!res || !res.data.length) {
    document.getElementById("tabeleModalContent").innerHTML =
      '<div style="color:var(--text3);padding:20px">Немає фото</div>';
    return;
  }

  document.getElementById("tabeleModalContent").innerHTML = res.data
    .map(
      (t, i) => `
    <div style="text-align:center;">
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px;">
        Фото ${i + 1} • ${new Date(t.sent_at).toLocaleDateString("pl")} ${new Date(t.sent_at).toLocaleTimeString("pl", { hour: "2-digit", minute: "2-digit" })}
      </div>
      <img src="/api/tabele/photo/${t.id}?session=${session}" 
           style="max-width:300px;max-height:400px;border-radius:6px;border:1px solid var(--border);cursor:pointer;"
           onclick="window.open(this.src,'_blank')"
           alt="Табель ${i + 1}" />
      <div style="margin-top:6px;">
        <a href="/api/tabele/photo/${t.id}?session=${session}" download 
           class="btn btn-ghost btn-sm" style="font-size:11px;">⬇ Завантажити</a>
      </div>
    </div>
  `,
    )
    .join("");
}

function closeTabeleModal() {
  document.getElementById("tabeleModal").classList.remove("open");
}

function clearHistoryFilters() {
  historyCurrentGroup = '';
  historyCurrentFac = '';
  document.getElementById('historyGroupLabel').textContent = '📁 Grupa...';
  document.getElementById('historyGroupLabel').style.color = 'var(--text2)';
  document.getElementById('historyFacLabel').textContent = '🏭 Obiekt...';
  document.getElementById('historyFacLabel').style.color = 'var(--text2)';
  buildHistoryFacList();
  ["historySearch", "historyBhpFrom", "historyBhpTo", "historyLastFrom", "historyLastTo"]
    .forEach((id) => { document.getElementById(id).value = ""; });
  selectedStatuses.history.clear();
  updateStatusUI('history');
  filterHistory();
}

function downloadAllTabele() {
  const month = document.getElementById("tabeleMonth").value
    || new Date().toISOString().substring(0, 7);
  const session = SESSION || localStorage.getItem("sas_session") || "";
  // Прямий перехід — браузер сам завантажить ZIP
  const url = `/api/tabele/download-all?month=${encodeURIComponent(month)}&session=${encodeURIComponent(session)}`;
  window.location.href = url;
}