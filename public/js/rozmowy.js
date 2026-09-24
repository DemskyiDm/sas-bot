// ══════════════════════════════════════════════════════════════════════
//  Розділ «Rozmowy» — завдання на розмову, ризик, анкети, контроль
// ══════════════════════════════════════════════════════════════════════
const SESSION = localStorage.getItem("sas_session");
const CURRENT_USER = JSON.parse(localStorage.getItem("sas_user") || "null");
if (!SESSION) location.href = "/login.html";

const ST = {
  view: "tasks",
  me: null,
  taskFilter: "open",
  tasks: [],
  assessments: [],
  riskMode: "list",
  risk: null,
  openProblem: null,
  openComment: null,
  pickedWorker: null,
};
const OUT = {
  stays: { l: "✅ Zostaje", c: "green" },
  problem: { l: "⚠️ Problem", c: "amber" },
  leaving: { l: "🚪 Chce odejść", c: "red" },
  no_answer: { l: "📵 Nie odebrał", c: "muted" },
};
const TITLES = { tasks: "Do rozmowy", risk: "Ryzyko odejścia", surveys: "Ankiety", control: "Kontrola koordynacji", settings: "Ustawienia" };
const SURVEY_NAME = { d3: "3. dzień", d14: "14 dni", d30: "30 dni", d60: "60 dni", exit: "Po odejściu" };

// ── Утиліти ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function pct(a, b) {
  if (!b) return "—";
  return Math.round((a / b) * 100) + "%";
}
function dd(v) {
  if (!v) return "";
  const d = new Date(v);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0");
}
function ddt(v) {
  if (!v) return "";
  const d = new Date(v);
  return dd(v) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function reasonChip(code) {
  const [k, v] = String(code).split(":");
  const map = {
    assess_bad: ["ocena 👎", "hot"], assess_mid: ["ocena 😐", "warm"], survey: ["ankieta ⚠️", "hot"],
    streak: [`${v}× NN z rzędu`, "hot"], nn: [`${v}× NN / 14 dni`, "warm"], gap: [`${v} dni bez godzin`, "warm"],
    drop: [v ? `godz. ${v.split("/")[0]} (było ${v.split("/")[1]})` : "spadek godzin", "warm"],
    pre80: ["przed 80 dniem", ""], new: ["nowy", ""], site_red: ["obiekt czerwony", ""],
    manual: ["zlecenie", "warm"],
  };
  const m = map[k] || [code, ""];
  return `<span class="r ${m[1]}">${esc(m[0])}</span>`;
}
const HINTS = {
  survey: "co dokładnie jest nie tak i jak pomóc", assess_bad: "co się zmieniło, czy chce dalej pracować",
  assess_mid: "co przeszkadza się wdrożyć", streak: "dlaczego nie przychodzi, co przeszkadza",
  nn: "dlaczego opuszcza zmiany", gap: "czy teraz pracuje, dlaczego nie wpisuje godzin",
  drop: "czy liczba godzin mu odpowiada", pre80: "plany po 80 dniach, co może zatrzymać",
  new: "mieszkanie, dojazd, czy wyjaśniono pracę", site_red: "warunki na obiekcie",
};
function hintsFor(reasons) {
  const out = [];
  for (const r of reasons || []) {
    const h = HINTS[String(r).split(":")[0]];
    if (h && !out.includes(h)) out.push(h);
    if (out.length >= 2) break;
  }
  return out;
}

async function api(path, opts) {
  const o = opts || {};
  o.headers = Object.assign({ "x-session": SESSION }, o.headers || {});
  if (o.body && typeof o.body !== "string") {
    o.body = JSON.stringify(o.body);
    o.headers["content-type"] = "application/json";
  }
  const r = await fetch("/api/care" + path, o);
  if (r.status === 401) { location.href = "/login.html"; return null; }
  return r.json();
}
function qs(extra) {
  const p = new URLSearchParams();
  const reg = document.getElementById("selRegion").value;
  const co = document.getElementById("selCoord").value;
  if (reg) p.set("region", reg);
  if (co) p.set("coordinator", co);
  Object.entries(extra || {}).forEach(([k, v]) => p.set(k, v));
  return "?" + p.toString();
}
function days() { return document.getElementById("selDays").value; }

// ── Старт ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", init);
window.addEventListener("hashchange", () => {
  const h = (location.hash || "").replace("#", "");
  if (ST.me && TITLES[h] && h !== ST.view) showView(h);
});

async function init() {
  if (CURRENT_USER) document.getElementById("userName").textContent = CURRENT_USER.full_name || "";
  const me = await api("/me");
  if (!me) return;
  if (!me.ok) { document.getElementById("content").innerHTML = `<div class="error">${esc(me.error)}</div>`; return; }
  ST.me = me;
  document.getElementById("lgEsc").textContent = me.settings.escalate_bdays;
  document.getElementById("lgPerDay").textContent = me.settings.tasks_per_day;
  if (me.is_manager) {
    document.getElementById("selRegionBox").style.display = "";
    document.getElementById("selCoordBox").style.display = "";
    const rs = document.getElementById("selRegion");
    rs.innerHTML = `<option value="">Wszystkie</option>` + me.regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    fillCoords();
  }
  if (me.is_admin) document.getElementById("navSettings").style.display = "";
  const h = (location.hash || "").replace("#", "");
  showView(TITLES[h] ? h : "tasks");
}

function fillCoords() {
  const cs = document.getElementById("selCoord");
  const cur = cs.value;
  cs.innerHTML = `<option value="">Wszyscy</option>` +
    ST.me.coordinators.map((c) => `<option value="${c.id}" ${String(c.id) === cur ? "selected" : ""}>${esc(c.name)}</option>`).join("");
}

function showView(v) {
  ST.view = v;
  document.querySelectorAll(".rz-view").forEach((el) => el.classList.toggle("active", el.id === "view-" + v));
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === v));
  document.getElementById("topTitle").textContent = TITLES[v];
  document.getElementById("selDaysBox").style.display = v === "surveys" || v === "control" ? "" : "none";
  document.getElementById("toolbar").style.visibility = v === "settings" ? "hidden" : "";
  if (v === "surveys" && !document.getElementById("selDays").dataset.touched) document.getElementById("selDays").value = "90";
  if (v === "control" && !document.getElementById("selDays").dataset.touched) document.getElementById("selDays").value = "28";
  history.replaceState(null, "", "#" + v);
  load();
}
function onFilterChange(el) {
  if (el && el.id === "selDays") el.dataset.touched = "1";
  load();
}
function load() {
  if (ST.view === "tasks") loadTasks();
  else if (ST.view === "risk") loadRisk();
  else if (ST.view === "surveys") loadSurveys();
  else if (ST.view === "control") loadControl();
  else if (ST.view === "settings") loadSettings();
}

// ══════════════════════════════════════════════════════════════════════
//  Do rozmowy
// ══════════════════════════════════════════════════════════════════════
function setTaskFilter(f) {
  ST.taskFilter = f;
  document.querySelectorAll("#taskChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.s === f));
  loadTasks();
}

async function loadTasks() {
  const box = document.getElementById("taskList");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const [r, open] = await Promise.all([
    api("/tasks" + qs({ status: ST.taskFilter, days: 14 })),
    ST.taskFilter === "open" ? null : api("/tasks" + qs({ status: "open" })),
  ]);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.tasks = r.data;
  ST.assessments = r.assessments;
  const openList = open && open.ok ? open.data : ST.taskFilter === "open" ? r.data : [];
  renderTaskKpis(openList);
  renderAssess();
  renderTasks();
}

function renderTaskKpis(openList) {
  const late = openList.filter((t) => t.escalated_at).length;
  const urgent = openList.filter((t) => t.priority === 0).length;
  document.getElementById("badgeTasks").textContent = openList.length || "";
  document.getElementById("taskKpis").innerHTML = `
    <div class="kpi"><div class="l">Otwarte rozmowy</div><div class="v">${openList.length}</div>
      <div class="s">limit ${ST.me.settings.tasks_per_day} na koordynatora dziennie</div></div>
    <div class="kpi ${urgent ? "bad" : ""}"><div class="l">Pilne (z ankiety)</div><div class="v">${urgent}</div><div class="s">porozmawiać dziś</div></div>
    <div class="kpi ${late ? "warn" : ""}"><div class="l">Po terminie</div><div class="v">${late}</div>
      <div class="s">ponad ${ST.me.settings.escalate_bdays} dni robocze — regionalny wie</div></div>
    <div class="kpi ${ST.assessments.length ? "warn" : ""}"><div class="l">Oceny nowych</div><div class="v">${ST.assessments.length}</div>
      <div class="s">👍 😐 👎 po 7 i 30 dniach</div></div>`;
}

function renderAssess() {
  const box = document.getElementById("assessBox");
  box.style.display = ST.assessments.length ? "" : "none";
  const manager = ST.me.is_manager;
  const limit = ST.assessAll ? 1e9 : 5;
  const more = ST.assessments.length - limit;
  document.getElementById("assessList").innerHTML = ST.assessments.slice(0, limit).map((a) => `
    <div class="assess" id="as${a.id}">
      <div class="who"><b>${esc(a.full_name)}</b> <span class="muted">${esc(a.login || "")}</span>
        <div class="meta">${esc(a.site_key || "—")} · ${a.day_mark}. dzień${manager ? " · " + esc(a.coord_name || "bez koordynatora") : ""}</div></div>
      <button title="Dobrze" onclick="rate(${a.id}, 3)">👍</button>
      <button title="Średnio" onclick="rate(${a.id}, 2)">😐</button>
      <button title="Źle" onclick="rate(${a.id}, 1)">👎</button>
    </div>`).join("") + (more > 0 ? `<div class="assess"><button class="linkbtn" style="font-size:12px; border:none; background:none"
      onclick="ST.assessAll=true; renderAssess()">pokaż wszystkie (${ST.assessments.length})</button></div>` : "");
}

async function rate(id, v) {
  const r = await api(`/assessments/${id}`, { method: "POST", body: { value: v } });
  if (!r || !r.ok) { alert(r ? r.error : "Błąd"); return; }
  ST.assessments = ST.assessments.filter((a) => a.id !== id);
  renderAssess();
  const k = document.querySelector("#taskKpis .kpi:last-child .v");
  if (k) k.textContent = ST.assessments.length;
}

function renderTasks() {
  const list = ST.tasks;
  document.getElementById("taskCnt").textContent = list.length ? `${list.length}` : "";
  const box = document.getElementById("taskList");
  if (!list.length) {
    box.innerHTML = `<div class="empty">${ST.taskFilter === "open" ? "Brak otwartych rozmów 👌 Nowa lista przychodzi codziennie rano." : "Brak rozmów w tym widoku"}</div>`;
    return;
  }
  box.innerHTML = `<div class="tasks">${list.map(taskCard).join("")}</div>`;
}

function taskCard(t) {
  const cls = t.status === "done" ? "done" : t.status === "missed" ? "missed" : t.priority === 0 ? "p0" : t.escalated_at ? "late" : "";
  const manager = ST.me.is_manager;
  const reasons = (t.reasons || []);
  const hints = hintsFor(reasons);
  const answers = (t.answers || []).slice(0, 4);
  let body = "";
  if (t.status === "open") {
    if (ST.openProblem === t.id) {
      body = `<div class="probs">${Object.entries(ST.me.problems).map(([c, l]) =>
        `<button onclick="closeTask(${t.id}, 'problem', '${c}')">${esc(l)}</button>`).join("")}</div>
        <div><button class="linkbtn" onclick="ST.openProblem=null; renderTasks()">↩️ wstecz</button></div>`;
    } else {
      body = `<div class="acts">
        <button onclick="closeTask(${t.id}, 'stays')">✅ Zostaje</button>
        <button onclick="ST.openProblem=${t.id}; renderTasks()">⚠️ Jest problem</button>
        <button onclick="closeTask(${t.id}, 'leaving')">🚪 Chce odejść</button>
        <button onclick="closeTask(${t.id}, 'no_answer')">📵 Nie odebrał</button></div>`;
    }
    body += ST.openComment === t.id
      ? `<div class="cmt"><input type="text" id="cm${t.id}" maxlength="500" placeholder="Komentarz (opcjonalnie)" value="${esc(t.comment || "")}" />
           <button class="btn btn-ghost btn-sm" onclick="saveComment(${t.id})">Zapisz</button></div>`
      : `<div><button class="linkbtn" onclick="ST.openComment=${t.id}; renderTasks(); document.getElementById('cm${t.id}').focus()">💬 ${t.comment ? "zmień komentarz" : "dodaj komentarz"}</button></div>`;
  } else if (t.status === "done") {
    const o = OUT[t.outcome] || { l: t.outcome, c: "" };
    const recent = Date.now() - new Date(t.done_at).getTime() < 24 * 3600 * 1000;
    body = `<div class="closed-line"><b class="${o.c}">${o.l}${t.problem_code ? " — " + esc(ST.me.problems[t.problem_code] || t.problem_code) : ""}</b>
      <span class="muted">${ddt(t.done_at)} · ${t.done_via === "telegram" ? "Telegram" : "panel"}${t.done_by_name && manager ? " · " + esc(t.done_by_name) : ""}</span>
      ${recent ? `<button class="linkbtn" onclick="reopen(${t.id})">↩️ zmień</button>` : ""}</div>`;
  } else if (t.status === "missed") {
    body = `<div class="closed-line"><span class="muted">Pominięte — nie zamknięto w terminie. Można jeszcze wpisać wynik:</span></div>
      <div class="acts">
        <button onclick="closeTask(${t.id}, 'stays')">✅ Zostaje</button>
        <button onclick="ST.openProblem=${t.id}; ST.taskFilter='missed'; renderTasks()">⚠️ Jest problem</button>
        <button onclick="closeTask(${t.id}, 'leaving')">🚪 Chce odejść</button>
        <button onclick="closeTask(${t.id}, 'no_answer')">📵 Nie odebrał</button></div>`;
    if (ST.openProblem === t.id) body = `<div class="probs">${Object.entries(ST.me.problems).map(([c, l]) =>
      `<button onclick="closeTask(${t.id}, 'problem', '${c}')">${esc(l)}</button>`).join("")}</div>`;
  }
  return `<div class="task ${cls}" id="tk${t.id}">
    <div class="top"><span class="name">${esc(t.full_name)}</span><span class="id">${esc(t.login || "")}</span>
      <span class="score" title="Bal ryzyka">${t.priority === 0 ? "🔔 pilne" : t.score != null ? "bal " + t.score : ""}</span></div>
    <div class="meta">🏭 ${esc(t.site_key || "—")}${t.tenure != null ? ` · ${t.tenure}. dzień` : ""}
      ${manager ? ` · 👤 ${esc(t.coord_name || "bez koordynatora")}` : ""}
      · od ${dd(t.created_at)}${t.status === "open" && t.age_bdays > 0 ? ` (${t.age_bdays} d.rob.)` : ""}
      ${t.escalated_at && t.status === "open" ? ` · <span class="amber">po terminie</span>` : ""}
      ${!t.has_tg ? ` · <span class="muted" title="Pracownik nie ma bota — ankiety i kontrola nie dojdą">bez Telegrama</span>` : ""}</div>
    <div class="rs">${reasons.filter((x) => x !== "manual" || t.kind === "manual").map(reasonChip).join("")}</div>
    ${hints.length && t.status === "open" ? `<div class="ask"><b>Zapytaj:</b> ${esc(hints.join("; "))}</div>` : ""}
    ${answers.length ? `<div class="ans">📝 ${answers.map((a) =>
      `${esc(a.q)} → <span class="${a.f === "high" ? "hi" : "lo"}">${esc(a.a)}</span>`).join("<br>")}</div>` : ""}
    ${t.comment && ST.openComment !== t.id ? `<div class="ask">💬 ${esc(t.comment)}</div>` : ""}
    ${body}
  </div>`;
}

async function closeTask(id, outcome, problem) {
  const card = document.getElementById("tk" + id);
  if (card) card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  const cm = document.getElementById("cm" + id);
  const r = await api(`/tasks/${id}/close`, {
    method: "POST", body: { outcome, problem_code: problem || null, comment: cm ? cm.value : null },
  });
  if (!r || !r.ok) { alert(r ? r.error : "Błąd"); loadTasks(); return; }
  ST.openProblem = null;
  ST.openComment = null;
  loadTasks();
}
async function reopen(id) {
  const r = await api(`/tasks/${id}/reopen`, { method: "POST" });
  if (!r || !r.ok) { alert(r ? r.error : "Błąd"); return; }
  loadTasks();
}
async function saveComment(id) {
  const v = document.getElementById("cm" + id).value;
  const r = await api(`/tasks/${id}/comment`, { method: "POST", body: { comment: v } });
  if (!r || !r.ok) { alert(r ? r.error : "Błąd"); return; }
  const t = ST.tasks.find((x) => x.id === id);
  if (t) t.comment = v;
  ST.openComment = null;
  renderTasks();
}

// ── Доручення ─────────────────────────────────────────────────────────
function openNewTask(worker) {
  const box = document.getElementById("newTaskBox");
  ST.pickedWorker = worker || null;
  box.style.display = "";
  box.innerHTML = `<div class="section-head">➕ Zleć rozmowę
      <span class="cnt">koordynator dostanie ją w Telegramie i na liście</span></div>
    <div class="form">
      <div class="full"><label>Pracownik (nazwisko lub ID)</label>
        <input type="text" id="ntQ" placeholder="min. 2 znaki…" oninput="searchWorker()" autocomplete="off"
          value="${worker ? esc(worker.full_name) : ""}" />
        <div class="found" id="ntFound" style="display:none"></div></div>
      <div class="full"><label>Co ustalić (zobaczy koordynator)</label>
        <input type="text" id="ntC" maxlength="500" placeholder="np. zapytać o mieszkanie po skardze" /></div>
      <div class="full" style="display:flex; gap:8px; align-items:center">
        <button class="btn btn-primary btn-sm" onclick="createTask()">Zleć</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('newTaskBox').style.display='none'">Anuluj</button>
        <span class="form-msg" id="ntMsg">${worker ? `🏭 ${esc(worker.site_key || "")}` : ""}</span></div>
    </div>`;
  box.scrollIntoView({ block: "nearest" });
  document.getElementById(worker ? "ntC" : "ntQ").focus();
}
let searchTimer = null;
function searchWorker() {
  clearTimeout(searchTimer);
  ST.pickedWorker = null;
  searchTimer = setTimeout(async () => {
    const q = document.getElementById("ntQ").value.trim();
    const f = document.getElementById("ntFound");
    if (q.length < 2) { f.style.display = "none"; return; }
    const r = await api("/workers?q=" + encodeURIComponent(q));
    if (!r || !r.ok) return;
    ST.found = r.data;
    f.style.display = r.data.length ? "" : "none";
    f.innerHTML = r.data.map((w, i) => `<div onclick="pickWorker(${i})"><b>${esc(w.full_name)}</b> <span class="muted">${esc(w.login || "")}</span>
      · ${esc(w.site_key || "")} · ${w.tenure}. dzień${ST.me.is_manager ? " · " + esc(w.coord_name || "—") : ""}</div>`).join("");
  }, 250);
}
function pickWorker(i) {
  const w = ST.found[i];
  ST.pickedWorker = w;
  document.getElementById("ntQ").value = w.full_name;
  document.getElementById("ntFound").style.display = "none";
  document.getElementById("ntMsg").className = "form-msg";
  document.getElementById("ntMsg").textContent = `🏭 ${w.site_key || ""} · koordynator: ${w.coord_name || "—"}`;
}
async function createTask() {
  const msg = document.getElementById("ntMsg");
  if (!ST.pickedWorker) { msg.className = "form-msg err"; msg.textContent = "Wybierz pracownika z listy"; return; }
  const r = await api("/tasks", { method: "POST", body: { worker_id: ST.pickedWorker.worker_id, comment: document.getElementById("ntC").value } });
  if (!r || !r.ok) { msg.className = "form-msg err"; msg.textContent = r ? r.error : "Błąd"; return; }
  document.getElementById("newTaskBox").style.display = "none";
  if (ST.view === "tasks") loadTasks(); else loadRisk();
}

// ══════════════════════════════════════════════════════════════════════
//  Ryzyko
// ══════════════════════════════════════════════════════════════════════
function setRiskFilter(m) {
  ST.riskMode = m;
  document.querySelectorAll("#riskChips .chip").forEach((c) => c.classList.toggle("active", c.dataset.m === m));
  loadRisk();
}
async function loadRisk() {
  const box = document.getElementById("riskTable");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/risk" + qs({ min: ST.riskMode === "list" ? ST.me.settings.risk_min : 1 }));
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  ST.risk = r;
  renderRisk();
}
function renderRisk() {
  const r = ST.risk;
  if (!r) return;
  const q = (document.getElementById("riskSearch").value || "").toLowerCase();
  const rows = r.data.filter((x) => !q || (x.full_name + " " + x.login + " " + x.site_key).toLowerCase().includes(q));
  document.getElementById("riskCnt").textContent = `${rows.length} os.${r.data[0] ? " · przeliczone " + dd(r.data[0].day) : ""}`;
  const box = document.getElementById("riskTable");
  if (!rows.length) { box.innerHTML = `<div class="empty">Brak osób z sygnałem ryzyka</div>`; return; }
  const manager = ST.me.is_manager;
  const max = Math.max(...rows.map((x) => x.score), 1);
  box.innerHTML = `<table class="rg"><thead><tr><th>Pracownik</th><th>Obiekt</th><th class="num">Dzień</th><th>Bal</th><th>Dlaczego</th>
    ${manager ? "<th>Koordynator</th>" : ""}<th>Rozmowa</th><th></th></tr></thead><tbody>
    ${rows.map((x, i) => `<tr>
      <td><b>${esc(x.full_name)}</b> <span class="muted">${esc(x.login || "")}</span></td>
      <td class="muted">${esc(x.site_key || "")}</td>
      <td class="num">${x.tenure}</td>
      <td style="white-space:nowrap"><span class="bar ${x.score >= 50 ? "hot" : x.score >= r.risk_min ? "warm" : ""}" style="width:${Math.round(60 * x.score / max)}px"></span>
        <span style="font-family:var(--mono); font-size:11px">${x.score}</span></td>
      <td><div class="rs">${(x.reasons || []).map(reasonChip).join("")}</div></td>
      ${manager ? `<td class="muted">${esc(x.coord_name || "—")}</td>` : ""}
      <td style="font-size:11px">${x.open_task ? `<span class="amber">otwarta od ${dd(x.open_since)}</span>`
        : x.last_outcome ? `<span class="${(OUT[x.last_outcome] || {}).c || ""}">${(OUT[x.last_outcome] || {}).l || x.last_outcome}</span> <span class="muted">${dd(x.last_done)}</span>`
        : `<span class="muted">—</span>`}</td>
      <td>${x.open_task ? "" : `<button class="btn btn-ghost btn-sm" onclick="assignFromRisk(${i})">Zleć</button>`}</td>
    </tr>`).join("")}</tbody></table>`;
  ST.riskRows = rows;
}
function assignFromRisk(i) {
  const x = ST.riskRows[i];
  showView("tasks");
  openNewTask({ worker_id: x.worker_id, full_name: x.full_name, site_key: x.site_key, coord_name: x.coord_name });
}

// ══════════════════════════════════════════════════════════════════════
//  Ankiety
// ══════════════════════════════════════════════════════════════════════
async function loadSurveys() {
  document.getElementById("recentTable").innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/surveys" + qs({ days: days() }));
  if (!r) return;
  if (!r.ok) { document.getElementById("recentTable").innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }

  document.getElementById("surveyKpis").innerHTML = r.rates.map((x) => {
    const rate = x.sent ? x.done / x.sent : null;
    return `<div class="kpi ${rate == null ? "" : rate < 0.4 ? "bad" : rate < 0.6 ? "warn" : "good"}">
      <div class="l">Ankieta: ${esc(SURVEY_NAME[x.code] || x.name)}</div>
      <div class="v">${rate == null ? "—" : Math.round(rate * 100) + "%"}</div>
      <div class="s">odpowiedziało ${x.done} z ${x.sent}${x.no_tg ? ` · bez bota ${x.no_tg}` : ""}${x.high ? ` · <span class="red">⚠️ ${x.high}</span>` : ""}</div></div>`;
  }).join("");

  document.getElementById("recentCnt").textContent = r.recent.length ? `${r.recent.length}` : "";
  document.getElementById("recentTable").innerHTML = r.recent.length ? `<table class="rg"><thead><tr><th>Kiedy</th><th>Pracownik</th><th>Obiekt</th>
    <th>Ankieta</th><th>Pytanie → odpowiedź</th><th>Rozmowa</th></tr></thead><tbody>
    ${r.recent.map((x) => {
      const [st, out] = String(x.task || "").split(":");
      const task = !x.task ? `<span class="muted">—</span>` : st === "open" ? `<span class="amber">otwarta</span>`
        : st === "done" ? `<span class="${(OUT[out] || {}).c || ""}">${(OUT[out] || {}).l || out}</span>` : `<span class="muted">${esc(st)}</span>`;
      return `<tr><td class="muted">${ddt(x.answered_at)}</td><td><b>${esc(x.full_name)}</b> <span class="muted">${esc(x.login || "")}</span></td>
        <td class="muted">${esc(x.site_key || "")}</td><td class="muted">${esc(SURVEY_NAME[x.survey_code] || x.survey_code)}</td>
        <td>${esc(x.q)} → <b class="${x.flag === "high" ? "red" : "amber"}">${esc(x.a)}</b></td><td>${task}</td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">Brak niepokojących odpowiedzi w tym okresie</div>`;

  const probL = ST.me.problems;
  const PR = { housing: "Mieszkanie", money: "Wypłata", schedule: "Grafik", team: "Zespół", transport: "Dojazd", other: "Inne" };
  document.getElementById("siteSurveyTable").innerHTML = r.sites.length ? `<table class="rg"><thead><tr><th>Obiekt</th>
    <th class="num">Wysłane</th><th class="num">Odpowiedzi</th><th class="num">⚠️</th><th class="num">Praca 1–5</th>
    <th class="num">Mieszk. 1–5</th><th class="num">Nie zostanie</th><th>Najczęstszy problem</th></tr></thead><tbody>
    ${r.sites.map((x) => `<tr><td><b>${esc(x.site_key)}</b></td><td class="num">${x.sent}</td>
      <td class="num">${pct(x.done, x.sent)}</td><td class="num ${x.high ? "red" : ""}">${x.high || ""}</td>
      <td class="num ${x.work5 != null && x.work5 < 3 ? "red" : ""}">${x.work5 ?? "—"}</td>
      <td class="num ${x.housing5 != null && x.housing5 < 3 ? "red" : ""}">${x.housing5 ?? "—"}</td>
      <td class="num">${x.stay_n ? `${pct(x.stay_no, x.stay_n)}${x.stay_unsure ? ` <span class="muted">(+${pct(x.stay_unsure, x.stay_n)} ?)</span>` : ""}` : "—"}</td>
      <td class="muted">${esc(PR[x.top_problem] || probL[x.top_problem] || x.top_problem || "—")}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">Brak odpowiedzi w tym okresie</div>`;

  const bySurvey = {};
  for (const q of r.questions) (bySurvey[q.survey] = bySurvey[q.survey] || []).push(q);
  const order = ["d3", "d14", "d30", "d60", "exit"];
  const html = order.filter((k) => bySurvey[k]).map((k) => `<div class="qgroup">${esc(SURVEY_NAME[k] || k)}</div>` +
    bySurvey[k].map((q) => {
      const lock = q.visibility === "manager" ? `<span class="lock">🔒 tylko regionalni · zbiorczo</span>` : "";
      if (q.hidden) return `<div class="qcard"><div class="qt">${esc(q.text)} ${lock}<span class="n">za mało odpowiedzi — pokazujemy od ${r.min_answers} na koordynatora</span></div></div>`;
      const max = Math.max(...q.options.map((o) => o.n), 1);
      return `<div class="qcard"><div class="qt">${esc(q.text)} ${lock}<span class="n">${q.n} odp.</span></div>
        ${q.options.map((o) => `<div class="qopt"><span class="lab" title="${esc(o.t)}">${esc(o.t)}</span>
          <span><span class="bar ${o.f === "high" ? "hot" : o.f === "low" ? "warm" : ""}" style="width:${Math.max(2, Math.round(100 * o.n / max))}%"></span></span>
          <span class="val">${o.n} · ${pct(o.n, q.n)}</span></div>`).join("")}</div>`;
    }).join("")).join("");
  document.getElementById("questionsBox").innerHTML = html || `<div class="empty">Brak odpowiedzi w tym okresie</div>`;
  document.getElementById("questionsLegend").innerHTML =
    `Czerwony — odpowiedź tworzy pilną rozmowę tego samego dnia. Pomarańczowy — podnosi bal ryzyka.
     ${r.is_manager ? `Pytania o koordynatora (🔒) widzą tylko regionalni i kierownik, zawsze zbiorczo i dopiero od ${r.min_answers} odpowiedzi.` : ""}`;
}

// ══════════════════════════════════════════════════════════════════════
//  Kontrola
// ══════════════════════════════════════════════════════════════════════
async function loadControl() {
  const box = document.getElementById("controlTable");
  box.innerHTML = `<div class="loading">Ładowanie…</div>`;
  const r = await api("/control" + qs({ days: days() }));
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  const rows = r.data;
  const sum = (k) => rows.reduce((n, x) => n + (Number(x[k]) || 0), 0);
  const created = sum("created"), done = sum("done"), onTime = sum("on_time"), spotA = sum("spot_answered"), spotNo = sum("spot_no");
  const tN = sum("ef_t_n"), tOk = sum("ef_t_ok"), nN = sum("ef_n_n"), nOk = sum("ef_n_ok");
  document.getElementById("controlKpis").innerHTML = `
    <div class="kpi"><div class="l">Rozmowy zamknięte</div><div class="v">${pct(done, created)}</div><div class="s">${done} z ${created} w ${r.days} dni</div></div>
    <div class="kpi ${created && onTime / created < 0.7 ? "warn" : ""}"><div class="l">W terminie</div><div class="v">${pct(onTime, created)}</div>
      <div class="s">zamknięte przed eskalacją</div></div>
    ${r.is_manager ? `<div class="kpi ${spotA && spotNo / spotA > 0.2 ? "bad" : ""}"><div class="l">Pracownik potwierdza rozmowę</div>
      <div class="v">${spotA ? pct(spotA - spotNo, spotA) : "—"}</div><div class="s">${spotA ? `${spotNo} × „nie” z ${spotA} odpowiedzi` : "brak odpowiedzi kontrolnych"}</div></div>` : ""}
    <div class="kpi"><div class="l">Dożycie do 80 dni</div>
      <div class="v">${tN ? pct(tOk, tN) : "—"} <span style="font-size:13px; color:var(--text3)">vs ${nN ? pct(nOk, nN) : "—"}</span></div>
      <div class="s">z rozmową (${tN}) vs bez rozmowy (${nN}) — przy sygnale ryzyka</div></div>`;
  document.getElementById("controlCnt").textContent = `${rows.length}`;
  const m = r.is_manager;
  box.innerHTML = rows.length ? `<table class="rg"><thead><tr><th>Koordynator</th><th class="num">Zadania</th><th class="num">Zamkn.</th>
    <th class="num">W terminie</th><th class="num">Otwarte</th><th class="num">Eskal.</th><th class="num">Pomin.</th>
    <th>Wyniki ✅ ⚠️ 🚪 📵</th><th class="num">Nie odebrał</th>${m ? `<th class="num">Kontrola „nie”</th>` : ""}
    <th class="num">Oceny nowych</th><th class="num">Ankiety</th>
    ${m ? `<th class="num" title="Pytanie w ankiecie 30 dni, 1–5">Ocena koord.</th><th class="num" title="„Czy koordynator jest dostępny / pomagał” — tak">Dostępny</th>` : ""}
    <th class="num" title="Dożycie do 80 dni przy sygnale ryzyka: z rozmową / bez">80 dni: z / bez</th></tr></thead><tbody>
    ${rows.map((x) => {
      const closedRate = x.created ? x.done / x.created : null;
      const na = x.done ? x.o_no_answer / x.done : 0;
      return `<tr><td class="nw"><b>${esc(x.coord_name || "bez koordynatora")}</b></td>
        <td class="num">${x.created}</td>
        <td class="num ${closedRate != null && closedRate < 0.6 ? "red" : ""}">${pct(x.done, x.created)}</td>
        <td class="num">${pct(x.on_time, x.created)}</td>
        <td class="num">${x.open_now || ""}</td>
        <td class="num ${x.escalated ? "amber" : ""}">${x.escalated || ""}</td>
        <td class="num ${x.missed ? "red" : ""}">${x.missed || ""}</td>
        <td style="font-family:var(--mono); font-size:11px; white-space:nowrap">${x.o_stays} · ${x.o_problem} · ${x.o_leaving} · ${x.o_no_answer}</td>
        <td class="num ${na > 0.4 ? "amber" : ""}">${x.done ? pct(x.o_no_answer, x.done) : "—"}</td>
        ${m ? `<td class="num ${x.spot_no ? "red" : ""}">${x.spot_answered ? `${x.spot_no} / ${x.spot_answered}` : "—"}</td>` : ""}
        <td class="num">${x.assess_req ? pct(x.assess_done, x.assess_req) : "—"}</td>
        <td class="num">${x.sv_sent ? pct(x.sv_done, x.sv_sent) : "—"}</td>
        ${m ? `<td class="num ${x.c5_avg != null && x.c5_avg < 3.5 ? "red" : ""}">${x.c5_avg ?? "—"}</td>
               <td class="num">${x.cy_yes != null ? pct(x.cy_yes, x.cy_n) : "—"}</td>` : ""}
        <td class="num">${x.ef_t_n ? pct(x.ef_t_ok, x.ef_t_n) : "—"} / ${x.ef_n_n ? pct(x.ef_n_ok, x.ef_n_n) : "—"}</td></tr>`;
    }).join("")}</tbody></table>` : `<div class="empty">Brak zadań w tym okresie</div>`;
  document.getElementById("controlLegend").innerHTML = `
    <b>W terminie</b> — zamknięte, zanim poszła informacja do regionalnego. <b>Pomin.</b> — nie zamknięte w 4 dni robocze.
    ${m ? `<b>Kontrola „nie”</b> — bot zapytał pracownika po zamkniętej rozmowie, a on odpowiedział, że rozmowy nie było (liczba „nie” / wszystkie odpowiedzi). Swoich wyników koordynator nie widzi.` : ""}
    <b>Oceny nowych</b> — ile ocen 👍😐👎 wystawiono. <b>Ankiety</b> — ile osób odpowiedziało na obiektach koordynatora.
    ${m ? `<b>Ocena koord. / Dostępny</b> — z ankiet, zbiorczo, od ${r.min_answers} odpowiedzi.` : ""}
    <b>80 dni</b> — ludzie z sygnałem ryzyka przed 80. dniem: ilu dożyło do 80 dni, jeśli była rozmowa / jeśli nie było. Dane zbierają się od startu sekcji.`;
}

// ══════════════════════════════════════════════════════════════════════
//  Ustawienia (admin)
// ══════════════════════════════════════════════════════════════════════
const CFG_GROUPS = [
  ["Włączone (1 = tak, 0 = nie)", ["tasks_enabled", "surveys_enabled"]],
  ["Rozmowy", ["tasks_per_day", "task_hour", "task_saturday", "escalate_bdays", "expire_bdays", "cooldown_days", "cooldown_problem_days", "cooldown_no_answer_days", "risk_min"]],
  ["Kontrola u pracownika", ["spot_check_share", "spot_check_delay_hours"]],
  ["Bal ryzyka", ["window_days", "new_days", "w_new", "pre_from", "pre_to", "w_pre", "w_nn", "w_nn_streak", "w_gap", "gap_cap", "w_drop", "w_survey", "w_assess_bad", "w_assess_mid", "w_site_red"]],
  ["Oceny nowych", ["assess_day_1", "assess_day_2"]],
  ["Ankiety", ["survey_hour", "survey_catchup_days", "survey_remind_hours", "survey_expire_days", "coord_min_answers"]],
];
async function loadSettings() {
  const body = document.getElementById("settingsBody");
  const r = await api("/settings");
  if (!r) return;
  if (!r.ok) { body.innerHTML = `<div class="error">${esc(r.error)}</div>`; return; }
  const map = Object.fromEntries(r.settings.map((s) => [s.key, s]));
  const used = new Set();
  const group = (title, keys) => `<div class="section"><div class="section-head">${esc(title)}</div>
    ${keys.filter((k) => map[k]).map((k) => { used.add(k); const s = map[k]; return `<div class="cfg-row"><span class="k">${esc(k)}</span>
      <input type="number" step="any" min="0" data-k="${esc(k)}" value="${Number(s.value)}" /><span class="note">${esc(s.note || "")}</span></div>`; }).join("")}</div>`;
  let html = CFG_GROUPS.map(([t, k]) => group(t, k)).join("");
  const rest = r.settings.filter((s) => !used.has(s.key)).map((s) => s.key);
  if (rest.length) html += group("Inne", rest);
  html += `<div class="section"><div class="section-head">Ankiety — włączone</div>
    ${r.surveys.map((s) => `<div class="cfg-row"><span class="k">${esc(s.code)}</span>
      <label style="display:flex; gap:6px; align-items:center"><input type="checkbox" data-sv="${esc(s.code)}" ${s.is_active ? "checked" : ""}/> aktywna</label>
      <span class="note">${esc(s.name)} · ${s.day_offset == null ? "po odejściu" : s.day_offset + ". dzień"} · pytań: ${s.questions}</span></div>`).join("")}
    <div class="legend">Treść pytań (4 języki) jest w tabeli care.questions — zmiany przez administratora bazy.</div></div>`;
  html += `<div class="section"><div class="section-head">Uruchomienia</div>
    <div class="cfg-row" style="grid-template-columns:1fr"><span class="note">Ostatnio: ${r.jobs.map((j) => `${esc(j.job)} ${esc(j.last)}`).join(" · ") || "—"}</span></div>
    <div class="cfg-row" style="grid-template-columns:auto auto 1fr">
      <button class="btn btn-ghost btn-sm" onclick="runJob('risk')">Przelicz ryzyko teraz</button>
      <button class="btn btn-ghost btn-sm" onclick="runJob('build')">Utwórz zadania teraz</button>
      <span class="form-msg" id="jobMsg"></span></div></div>`;
  html += `<div style="display:flex; gap:8px; align-items:center; margin-bottom:24px">
    <button class="btn btn-primary" onclick="saveSettings()">Zapisz ustawienia</button><span class="form-msg" id="cfgMsg"></span></div>`;
  body.innerHTML = html;
}
async function saveSettings() {
  const values = {};
  document.querySelectorAll("#settingsBody input[data-k]").forEach((i) => (values[i.dataset.k] = i.value));
  const surveys = {};
  document.querySelectorAll("#settingsBody input[data-sv]").forEach((i) => (surveys[i.dataset.sv] = i.checked));
  const r = await api("/settings", { method: "PUT", body: { values, surveys } });
  const m = document.getElementById("cfgMsg");
  m.className = "form-msg " + (r && r.ok ? "ok" : "err");
  m.textContent = r && r.ok ? "Zapisano" : r ? r.error : "Błąd";
}
async function runJob(job) {
  const m = document.getElementById("jobMsg");
  m.className = "form-msg"; m.textContent = "Liczę…";
  const r = await api("/run/" + job, { method: "POST" });
  m.className = "form-msg " + (r && r.ok ? "ok" : "err");
  m.textContent = r && r.ok ? JSON.stringify(r.result) : r ? r.error : "Błąd";
}
