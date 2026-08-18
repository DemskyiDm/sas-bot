// ── SHARED STATE ─────────────────────────────────────────────
let allWorkers = [];
let facilities = [];
let currentFacility = "";
let editState = {};
let currentPage = "hours";
let SESSION = localStorage.getItem("sas_session");
let CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");

let pageSizeWorkers = 10;
let pageSizeHistory = 10;
let pageSizeHours = 10;

// ── UTILS ─────────────────────────────────────────────────────
function localDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function normalizeDate(dateStr) {
  return localDate(dateStr);
}

function paginate(items, page, size) {
  size = size || 10;
  const total = items.length;
  const pages = Math.ceil(total / size) || 1;
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  return { slice, pages, total };
}

function renderPagination(containerId, currentPage, totalPages, onPageChange) {
  if (totalPages <= 1) {
    document.getElementById(containerId).innerHTML = "";
    return;
  }
  const maxVisible = 5;
  let start = Math.max(1, currentPage - 2);
  let end = Math.min(totalPages, start + maxVisible - 1);
  if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

  let html = `<div class="pagination">
    <button class="page-btn" ${currentPage === 1 ? "disabled" : ""} onclick="${onPageChange}(${currentPage - 1})">←</button>`;

  if (start > 1)
    html += `<button class="page-btn" onclick="${onPageChange}(1)">1</button>${start > 2 ? '<span style="color:var(--text3)">...</span>' : ""}`;

  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === currentPage ? "active" : ""}" onclick="${onPageChange}(${i})">${i}</button>`;
  }

  if (end < totalPages)
    html += `${end < totalPages - 1 ? '<span style="color:var(--text3)">...</span>' : ""}<button class="page-btn" onclick="${onPageChange}(${totalPages})">${totalPages}</button>`;

  html += `<button class="page-btn" ${currentPage === totalPages ? "disabled" : ""} onclick="${onPageChange}(${currentPage + 1})">→</button>
    <span style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-left:8px">${currentPage}/${totalPages}</span>
  </div>`;

  document.getElementById(containerId).innerHTML = html;
}

function showToast(text) {
  const t = document.createElement("div");
  t.innerText = text;
  t.style.cssText =
    "position:fixed;bottom:20px;right:20px;background:#2ecc71;color:#fff;padding:8px 12px;border-radius:6px;z-index:9999;font-size:13px;";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

async function apiFetch(url, options) {
  const opts = options || {};
  opts.headers = opts.headers || {};
  opts.headers["x-session"] = SESSION;
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location = "/login.html";
    return null;
  }
  return res.json();
}

// ── AUTH ──────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  if (!SESSION) {
    window.location = "/login.html";
    return;
  }
  try {
    const res = await fetch("/admin/me", { headers: { "x-session": SESSION } });
    const data = await res.json();
    if (!data.ok) {
      window.location = "/login.html";
      return;
    }
    CURRENT_USER = data.user;
    localStorage.setItem("sas_user", JSON.stringify(CURRENT_USER));
    document.getElementById("userName").textContent = CURRENT_USER.full_name;
    document.getElementById("userRole").textContent = CURRENT_USER.role;
    document.getElementById("userAvatar").textContent = CURRENT_USER.full_name
      .charAt(0)
      .toUpperCase();
    if (CURRENT_USER.is_admin)
      document.getElementById("adminLink").style.display = "";
  } catch (e) {
    window.location = "/login.html";
    return;
  }
  initMonthSelect();
  loadFacilities();
  loadAll();
});

function doLogout() {
  fetch("/admin/logout", {
    method: "POST",
    headers: { "x-session": SESSION },
  }).catch(() => { });
  localStorage.removeItem("sas_session");
  localStorage.removeItem("sas_user");
  window.location = "/login.html";
}

function initMonthSelect() {
  const sel = document.getElementById("monthSelect");
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("pl", { month: "long", year: "numeric" });
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (i === 0) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ── NAVIGATION ────────────────────────────────────────────────
function showPage(page) {
  currentPage = page;
  [
    "hours",
    "missing",
    "advances",
    "workers",
    "dayoff",
    "tabele",
    "history",
    "settings",
  ].forEach((p) => {
    const el = document.getElementById(
      "page" + p.charAt(0).toUpperCase() + p.slice(1),
    );
    if (el) el.style.display = p === page ? "" : "none";
  });
  document.querySelectorAll(".nav-item").forEach((el, i) => {
    el.classList.toggle(
      "active",
      [
        "hours",
        "advances",
        "workers",
        "dayoff",
        "tabele",
        "history",
        "settings",
      ][i] === page,
    );
  });
  const titles = {
    hours: "Przeglad godzin",
    advances: "Zaliczki",
    workers: "Pracownicy",
    history: "Historia pracownikow",
    settings: "Ustawienia",
    dayoff: "Вихідні",
  };
  document.getElementById("statsHours").style.display =
    page === "hours" ? "" : "none";
  document.getElementById("statsMissing").style.display =
    page === "missing" ? "" : "none";
  document.getElementById("statsWorkers").style.display =
    page === "workers" ? "" : "none";
  loadPage(page);
}

async function loadAll() {
  loadStats();
  loadPage(currentPage);
}

async function loadPage(page) {
  if (page === "hours") loadWorkers();
  if (page === "advances") loadAdvances();
  if (page === "workers") {
    loadWorkersPage();
    loadWorkerStats();
  }
  if (page === "dayoff") loadDayoffPage();
  if (page === "tabele") loadTabelePage();
  if (page === "history") loadHistoryPage();
  if (page === "settings") loadSettingsTable();
}

// ── FACILITIES ────────────────────────────────────────────────
async function loadFacilities() {
  try {
    const res = await apiFetch("/api/facilities");
    if (!res) return;
    facilities = res.data;
  } catch (e) { }
}

// ── STATS ─────────────────────────────────────────────────────
async function loadStats() {
  try {
    const month = document.getElementById("monthSelect").value;
    const fid = document.getElementById("facilitySelect")?.value || "";
    const data_res = await apiFetch(
      `/api/stats?month=${month}${fid ? "&facility_id=" + fid : ""}`,
    );
    if (!data_res) return;
    const { data } = data_res;
    document.getElementById("statWorkers").textContent = data.workers;
    document.getElementById("statHours").textContent = Math.round(data.hours);
    document.getElementById("statMissing").textContent = data.missing;
    document.getElementById("statMissingWorkers").textContent = data.workers;
    document.getElementById("statMissingHours").textContent = Math.round(
      data.hours,
    );
    document.getElementById("statMissingCount").textContent = data.missing;
    document.getElementById("statAllWorkers").textContent = data.workers;
    document.getElementById("statNewWorkers").textContent = "—";
    document.getElementById("statLeavingWeek").textContent = "—";
    document.getElementById("statLeavingMonth").textContent = "—";
  } catch (e) {
    console.error(e);
  }
}

async function loadStatsByFacility(facilityId) {
  try {
    const month = document.getElementById("monthSelect").value;
    const fid = facilityId || "";
    const data_res = await apiFetch(
      `/api/stats?month=${month}${fid ? "&facility_id=" + fid : ""}`,
    );
    if (!data_res || !data_res.data) return;
    const { data } = data_res;
    document.getElementById("statWorkers").textContent = data.workers;
    document.getElementById("statHours").textContent = Math.round(data.hours);
    document.getElementById("statMissing").textContent = data.missing;
  } catch (e) {
    console.error(e);
  }
}

// ── REMINDERS ─────────────────────────────────────────────────
async function pingWorker(workerId) {
  await apiFetch(`/api/remind/${workerId}`, { method: "POST" });
  alert("Przypomnienie wyslane!");
}

async function sendReminders() {
  if (!confirm("Wyslac przypomnienia do pracownikow z brakami (Twoje obiekty)?"))
    return;
  await apiFetch("/api/remind-missing", { method: "POST" });
  alert("Przypomnienia wyslane!");
}

// Close modals on overlay click
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("editModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById("workerModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeWorkerModal();
  });
  document.getElementById("historyModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeHistoryModal();
  });
});

document.getElementById("tabeleModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeTabeleModal();
});


// ── MULTI STATUS FILTER ───────────────────────────────────────
const selectedStatuses = { workers: new Set(), history: new Set() };




function toggleStatusDrop(page) {
  const drops = { workers: 'workersStatusDrop', history: 'historyStatusDrop' };
  const drop = document.getElementById(drops[page]);
  if (!drop) return;
  drop.style.display = drop.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', (e) => {
  const configs = [
    { wrap: 'statusDropWrap', drop: 'workersStatusDrop' },
    { wrap: 'historyStatusDropWrap', drop: 'historyStatusDrop' },
  ];
  configs.forEach(({ wrap, drop }) => {
    const wrapEl = document.getElementById(wrap);
    const dropEl = document.getElementById(drop);
    if (dropEl && wrapEl && !wrapEl.contains(e.target)) {
      dropEl.style.display = 'none';
    }
  });
});

function toggleStatus(page, value) {
  const set = selectedStatuses[page];
  if (value === '') {
    set.clear();
  } else {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }
  updateStatusUI(page);
  if (page === 'workers') filterWorkers();
  if (page === 'history') filterHistory();
}

function updateStatusUI(page) {
  const set = selectedStatuses[page];
  const prefix = page === 'workers' ? 'wst' : 'hst';
  const statuses = ['pracuje', 'zwolniony', 'rezygnacja', 'przeniesiony', 'urlop_l4', 'unknown'];
  const green = '#22c55e';
  statuses.forEach(s => {
    const el = document.getElementById(`${prefix}_${s}_check`);
    if (el) {
      el.style.background = set.has(s) ? green : 'transparent';
      el.style.borderColor = set.has(s) ? green : 'var(--border)';
    }
  });
  const allEl = document.getElementById(`${prefix}_all_check`);
  if (allEl) {
    allEl.style.background = set.size === 0 ? green : 'transparent';
    allEl.style.borderColor = set.size === 0 ? green : 'var(--border)';
  }
  const label = document.getElementById(`${page}StatusLabel`);
  if (label) label.textContent = set.size === 0 ? 'Wszystkie statusy' : `Statusy (${set.size})`;
}

document.addEventListener('click', (e) => {
  const gWrap = document.getElementById('groupDropWrap');
  const gMenu = document.getElementById('groupDropMenu');
  if (gMenu && gWrap && !gWrap.contains(e.target)) gMenu.style.display = 'none';

  const fWrap = document.getElementById('facDropWrap');
  const fMenu = document.getElementById('facDropMenu');
  if (fMenu && fWrap && !fWrap.contains(e.target)) fMenu.style.display = 'none';
});

document.addEventListener('click', (e) => {
  [
    { wrap: 'workersGroupDropWrap', drop: 'workersGroupDrop' },
    { wrap: 'workersFacDropWrap', drop: 'workersFacDrop' },
    { wrap: 'historyGroupDropWrap', drop: 'historyGroupDrop' },
    { wrap: 'historyFacDropWrap', drop: 'historyFacDrop' },
  ].forEach(({ wrap, drop }) => {
    const w = document.getElementById(wrap);
    const d = document.getElementById(drop);
    if (d && w && !w.contains(e.target)) d.style.display = 'none';
  });
});