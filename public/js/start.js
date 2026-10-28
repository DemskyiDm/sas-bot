// ── START — strona startowa panelu (GET /api/start, api/routes.js) ─────
// Na górze: pracują, przyjęcia i zwolnienia w tym tygodniu, zwolnienia do końca miesiąca, godziny w miesiącu.
// Niżej «Do zrobienia». Każda liczba otwiera zakładkę od razu z filtrem (te same definicje co na kartach «Pracownicy»).
// Zakres jak w zakładkach: admin — cała firma, pozostali — swoje obiekty (koordynator regionu — region).

const startNum = (n) => Number(n || 0).toLocaleString("pl-PL");
// 1 osoba, 2–4 osoby, 5+ osób; 1 dzień, 2+ dni
const startOs = (n) => (n === 1 ? "osoba" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "osoby" : "osób");
const startDays = (n) => (n === 1 ? "dzień" : "dni");
const startDm = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const startEsc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let START = null;

async function loadStartPage() {
  const box = document.getElementById("startBody");
  if (!START) box.innerHTML = '<div class="loading"><div class="spinner"></div>Ładowanie…</div>';
  let r;
  try { r = await apiFetch("/api/start"); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r) return;
  if (!r.ok) {
    // serwer jeszcze bez /api/start (pliki strony już nowe) — przy otwarciu panelu od razu Godziny, jak dawniej
    if (!START && currentPage === "start") { showPage("hours"); return; }
    box.innerHTML = `<div class="start-empty">Nie udało się wczytać: ${startEsc(r.error)}</div>`;
    return;
  }
  START = r;
  renderStart();
}

function renderStart() {
  const r = START, w = r.workers, t = r.todo;
  const name = ((CURRENT_USER && CURRENT_USER.full_name) || "").trim().split(/\s+/)[0];
  const day = new Date().toLocaleDateString("pl-PL", { weekday: "long", day: "numeric", month: "long" });
  const scope = { all: "Cała firma", region: "Twój region", own: "Twoje obiekty" }[r.scope] || "Twoje obiekty";
  document.getElementById("startHello").textContent = name ? `Dzień dobry, ${name}` : "Dzień dobry";
  document.getElementById("startDate").textContent = `${day} · ${scope}`;

  // godziny: ten miesiąc do dziś i poprzedni do tego samego dnia
  const diff = r.hours.prev > 0 ? Math.round(((r.hours.cur - r.hours.prev) / r.hours.prev) * 100) : null;
  const prevLabel = new Date(r.prev_to + "T12:00:00").toLocaleDateString("pl-PL", { day: "numeric", month: "long" });
  const week = `${startDm(r.week_from)}–${startDm(r.week_to)}`;
  const tiles = [
    { c: "blue", l: "Pracuje", v: w.total, s: r.company_total != null ? `Cała firma: <b>${startNum(r.company_total)}</b>` : "aktywnych",
      go: "startWorkers({ status: ['pracuje'] })" },
    { c: "green", l: "Przyjęcia w tym tygodniu", v: w.new_this_week,
      s: `podjęli pracę: <a class="start-link" onclick="event.stopPropagation(); startWorkers({ status: ['pracuje'], bhp: [START.week_from, START.week_to] })">${startNum(w.started_this_week)}</a>`,
      go: "startWorkers({ status: START_NOT_REZ, bhp: [START.week_from, START.week_to] })" },
    { c: "orange", l: "Zwolnienia w tym tygodniu", v: w.leaving_this_week, s: `ostatni dzień ${week}`,
      go: "startWorkers({ last: [START.week_from, START.week_to] })" },
    { c: "red", l: "Do końca miesiąca", v: w.leaving_this_month, s: `ostatni dzień do ${startDm(r.month_end)}`,
      go: "startWorkers({ last: [START.today, START.month_end] })" },
    { c: "green", l: "Godziny w tym miesiącu", v: Math.round(r.hours.cur),
      s: `1–${prevLabel}: ${startNum(Math.round(r.hours.prev))}${diff == null ? "" : ` · <span class="${diff >= 0 ? "start-up" : "start-down"}">${diff > 0 ? "+" : ""}${diff}%</span>`}`,
      go: "showPage('hours')" },
  ];
  document.getElementById("startTiles").innerHTML = tiles.map((x) => `
    <div class="stat-card ${x.c}" role="button" tabindex="0" onclick="${x.go}" onkeydown="if(event.key==='Enter')this.click()">
      <div class="stat-label">${x.l}</div>
      <div class="stat-value">${startNum(x.v)}</div>
      <div class="stat-sub">${x.s}</div>
    </div>`).join("");

  // Do zrobienia: zero — wyszarzone z ✓
  const todo = [
    { i: "🕐", n: t.yesterday, l: `Nie wpisali godzin za wczoraj (${startDm(r.y)})`, u: startOs(t.yesterday), go: "showPage('hours')" },
    { i: "📋", n: t.gaps, l: `Braki godzin od ${startDm(r.gaps_from)} do ${startDm(r.y)}`, u: `${startOs(t.gaps)} · ${startNum(t.gap_days)} ${startDays(t.gap_days)}`, go: "showPage('hours')" },
    // zaliczki — w zakresie wybranym w zakładce «Zaliczki» (Moje obiekty / Region / Cała firma); inny niż strony — dopisek
    { i: "💰", n: t.advances, l: "Zaliczki czekają na decyzję" + (t.adv_scope && t.adv_scope !== r.scope ? ` · ${{ all: "cała firma", region: "region", own: "twoje obiekty" }[t.adv_scope] || ""}` : ""),
      u: "", go: "startRequests('advances')" },
    { i: "🏖️", n: t.dayoff, l: "Wnioski o wolne czekają na decyzję", u: "", go: "startRequests('dayoff')" },
    { i: "📄", n: t.unsigned, l: `Nie podpisali dokumentów w HRappka (BHP od ${startDm(t.sign_from)})`, u: startOs(t.unsigned), go: "startWorkers({ docs: 'unsigned' })" },
    { i: "🎓", n: t.students_soon, l: `Status studenta kończy się w ciągu ${t.student_days} dni`, u: startOs(t.students_soon),
      go: "startWorkers({ student: 'expiring', status: ['pracuje', 'urlop_l4'] })" },
    { i: "🎓", n: t.students_expired, l: "Status studenta wygasł — a pracują", u: startOs(t.students_expired),
      go: "startWorkers({ student: 'expired', status: ['pracuje', 'urlop_l4'] })" },
    { i: "🗓️", n: t.do_zatrudnienia, l: "Do zatrudnienia (w grafiku HRappka)", u: startOs(t.do_zatrudnienia), go: "startWorkers({ status: ['do_zatrudnienia'] })" },
  ];
  const open = todo.filter((x) => x.n > 0).length;
  document.getElementById("startTodoCount").textContent = open ? String(open) : "✓";
  document.getElementById("startTodo").innerHTML = todo.map((x) => `
    <div class="start-row${x.n ? "" : " done"}" role="button" tabindex="0" onclick="${x.go}" onkeydown="if(event.key==='Enter')this.click()">
      <span class="start-ic">${x.n ? x.i : "✓"}</span>
      <span class="start-l">${x.l}</span>
      <span class="start-n">${startNum(x.n)}${x.u && x.n ? `<small>${x.u}</small>` : ""}</span>
      <span class="start-chev">›</span>
    </div>`).join("");
  document.getElementById("startBody").innerHTML = "";
}

// Wszystkie statusy oprócz rezygnacji — jak liczba «Przyjęcia» (rezygnacja = nie podjął pracy)
const START_NOT_REZ = ["pracuje", "zwolniony", "przeniesiony", "urlop_l4", "unknown", "do_zatrudnienia"];

// Pracownicy z filtrem: { status: [...], bhp: [od, do], last: [od, do], student, docs }
function startWorkers(o) {
  clearWorkersFilters();
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("workersDocs", o.docs);
  set("workersStudent", o.student);
  if (o.bhp) { set("workersBhpFrom", o.bhp[0]); set("workersBhpTo", o.bhp[1]); }
  if (o.last) { set("workersLastFrom", o.last[0]); set("workersLastTo", o.last[1]); }
  (o.status || []).forEach((s) => selectedStatuses.workers.add(s));
  updateStatusUI("workers");
  showPage("workers");
}

// Zaliczki / wolne — tylko czekające na decyzję
function startRequests(page) {
  const p = page === "advances" ? "advances" : "dayoff";
  ["Facility", "DateFrom", "DateTo"].forEach((k) => { const el = document.getElementById(p + k); if (el) el.value = ""; });
  document.getElementById(p + "Status").value = "pending";
  showPage(p);
}
