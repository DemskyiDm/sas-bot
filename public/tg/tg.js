// KoorPanel у Telegram (мініпанель). Українська / русский.
// Вхід: Telegram.WebApp.initData → POST /api/tg/auth → звичайна сесія панелі (x-session),
// тож години правляться тим самим POST /api/hours, що й у панелі, з тими самими правами.
// Адреси: #home, #hours, #hours:fac=<id>, #req, #go=<шлях панелі> (відкрити повну панель, напр. /wyjazdy.html#orders).
"use strict";

const TGW = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;

const L = {
  uk: {
    tab_home: "Головна", tab_hours: "Години", tab_req: "Заявки", tab_panel: "Панель",
    hi_m: "Доброго ранку", hi_d: "Добрий день", hi_e: "Добрий вечір",
    facs: (n) => `${n} ${n === 1 ? "обʼєкт" : n < 5 && n > 1 ? "обʼєкти" : "обʼєктів"}`, company: "уся фірма",
    via_tg: "Вхід через Telegram — без пароля",
    k_arr: "Приїзди сьогодні", k_dep: "Останній день", k_gaps: (d) => `Без годин ${d}+ дн.`, k_wait: "Чекають рішення",
    k_wait_s: (a, d) => `${a} аванс. · ${d} вихідн.`,
    l_hours: "Години працівників", l_adv: "Аванси", l_dof: "Вихідні", l_flow: "Виїзди / приїзди", l_plan: "План набору", l_req: "Заявки",
    plan_unc: (n, dl) => `не підтверджено ${n} · до нд ${dl}`, plan_ok: "підтверджено", plan_none: "",
    s_arr: "Сьогодні приїжджають", s_dep: "Сьогодні останній день", s_gaps: (d) => `Без годин ${d}+ дн.`,
    transfer: "переведення", days: (n) => `${n} дн. без годин`, remind: "Нагадати в боті", remind_s: "Нагадати", no_bot: "немає бота",
    nothing: "Нічого", more: (n) => `… і ще ${n}`,
    h_title: "Години", h_month: (h) => `${h} год за місяць`, h_gap: (n) => `⚠ ${n} дн. без год.`, h_nogap: (n) => `Без годин: ${n}`,
    h_ro: "Тільки перегляд — на цьому обʼєкті немає права правки (Region → Przypisania).",
    h_none: "На цьому обʼєкті в ці дні нікого немає.", h_nofacs: "За вами немає обʼєктів.",
    who: "Працівник", hours_lbl: "Години", abs_lbl: "або код відсутності", save: "Зберегти", saved: "Збережено",
    bad_hours: "Години від 0,25 до 13. Якщо не працював — оберіть код.", need_val: "Введіть години або оберіть код.",
    sent: "Нагадування надіслано", r_not_in_bot: "Працівник не підключений до бота", r_no_gaps: "У працівника немає серії пропущених днів",
    r_blocked: "Працівник заблокував бота", r_busy: "Розсилка вже йде — спробуйте за хвилину", r_disabled: "Нагадування вимкнені (GAP_ENABLED)",
    r_err: "Не вдалося надіслати",
    req_title: "Заявки", req_sub: "Заявки до офісу",
    req_med: "Медогляд", req_med_d: "Запис працівників на медичний огляд",
    req_fine: "Штрафи", req_fine_d: "Штрафи й утримання працівників",
    soon: "Розділ у розробці",
    e_title: "Вхід не вдався", e_not_linked: "Цей Telegram не привʼязаний до панелі. Увійдіть у панель на компʼютері → кнопка «Telegram» → відкрийте посилання тут.",
    e_no_account: "Для вашого профілю немає облікового запису панелі. Зверніться до адміністратора.",
    e_bad_init: "Не вдалося перевірити вхід Telegram. Закрийте панель і відкрийте знову кнопкою «Panel».",
    e_outside: "Мініпанель відкривається кнопкою «Panel» у чаті з ботом.", e_login: "Увійти з паролем", e_net: "Немає звʼязку з сервером. Спробуйте ще раз.",
    retry: "Спробувати ще раз",
    wd: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
    wdl: ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"],
    codes: { WZ: "DW", DWZ: "DWZ", URL: "URL", L4: "L4", NN: "NN", UN: "UN" },
    codes_t: { WZ: "вихідний", DWZ: "вихідн. зав.", URL: "відпустка", L4: "лікарн.", NN: "прогул", UN: "поважна" },
  },
  ru: {
    tab_home: "Главная", tab_hours: "Часы", tab_req: "Заявки", tab_panel: "Панель",
    hi_m: "Доброе утро", hi_d: "Добрый день", hi_e: "Добрый вечер",
    facs: (n) => `${n} ${n === 1 ? "объект" : n < 5 && n > 1 ? "объекта" : "объектов"}`, company: "вся фирма",
    via_tg: "Вход через Telegram — без пароля",
    k_arr: "Приезды сегодня", k_dep: "Последний день", k_gaps: (d) => `Без часов ${d}+ дн.`, k_wait: "Ждут решения",
    k_wait_s: (a, d) => `${a} аванс. · ${d} выходн.`,
    l_hours: "Часы работников", l_adv: "Авансы", l_dof: "Выходные", l_flow: "Выезды / приезды", l_plan: "План набора", l_req: "Заявки",
    plan_unc: (n, dl) => `не подтверждено ${n} · до вс ${dl}`, plan_ok: "подтверждено", plan_none: "",
    s_arr: "Сегодня приезжают", s_dep: "Сегодня последний день", s_gaps: (d) => `Без часов ${d}+ дн.`,
    transfer: "перевод", days: (n) => `${n} дн. без часов`, remind: "Напомнить в боте", remind_s: "Напомнить", no_bot: "нет бота",
    nothing: "Ничего", more: (n) => `… и ещё ${n}`,
    h_title: "Часы", h_month: (h) => `${h} ч за месяц`, h_gap: (n) => `⚠ ${n} дн. без час.`, h_nogap: (n) => `Без часов: ${n}`,
    h_ro: "Только просмотр — на этом объекте нет права правки (Region → Przypisania).",
    h_none: "На этом объекте в эти дни никого нет.", h_nofacs: "За вами нет объектов.",
    who: "Работник", hours_lbl: "Часы", abs_lbl: "или код отсутствия", save: "Сохранить", saved: "Сохранено",
    bad_hours: "Часы от 0,25 до 13. Если не работал — выберите код.", need_val: "Введите часы или выберите код.",
    sent: "Напоминание отправлено", r_not_in_bot: "Работник не подключён к боту", r_no_gaps: "У работника нет серии пропущенных дней",
    r_blocked: "Работник заблокировал бота", r_busy: "Рассылка уже идёт — попробуйте через минуту", r_disabled: "Напоминания выключены (GAP_ENABLED)",
    r_err: "Не удалось отправить",
    req_title: "Заявки", req_sub: "Заявки в офис",
    req_med: "Медосмотр", req_med_d: "Запись работников на медицинский осмотр",
    req_fine: "Штрафы", req_fine_d: "Штрафы и удержания работников",
    soon: "Раздел в разработке",
    e_title: "Вход не удался", e_not_linked: "Этот Telegram не привязан к панели. Войдите в панель на компьютере → кнопка «Telegram» → откройте ссылку здесь.",
    e_no_account: "Для вашего профиля нет учётной записи панели. Обратитесь к администратору.",
    e_bad_init: "Не удалось проверить вход Telegram. Закройте панель и откройте снова кнопкой «Panel».",
    e_outside: "Мини-панель открывается кнопкой «Panel» в чате с ботом.", e_login: "Войти с паролем", e_net: "Нет связи с сервером. Попробуйте ещё раз.",
    retry: "Попробовать ещё раз",
    wd: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
    wdl: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
    codes: { WZ: "DW", DWZ: "DWZ", URL: "URL", L4: "L4", NN: "NN", UN: "UN" },
    codes_t: { WZ: "выходной", DWZ: "выходн. зав.", URL: "отпуск", L4: "больнич.", NN: "прогул", UN: "уважит." },
  },
};
const CODES = ["WZ", "DWZ", "URL", "L4", "NN", "UN"];
const LIST_MAX = 15;

const ST = {
  lang: "uk", token: null, user: null, viaTg: false,
  home: null, facs: null, fac: null, end: null, hours: null, onlyGaps: false,
  sheet: null,
};
const T = () => L[ST.lang] || L.uk;

// ── Допоміжне ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* немає сховища */ } },
};
const warsawToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const dd = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const fmtH = (h) => { const n = Number(h); return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(".", ","); };
const today = () => (ST.home && ST.home.today) || warsawToday();
const CHEV = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`;

function toast(text, bad) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (bad ? " bad" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  haptic(bad ? "error" : "success");
}
function haptic(kind) {
  try { if (TGW && TGW.HapticFeedback) TGW.HapticFeedback.notificationOccurred(kind); } catch (e) { /* старий клієнт */ }
}

async function api(path, opts) {
  const o = Object.assign({}, opts || {});
  o.headers = Object.assign({ "x-session": ST.token || "" }, o.body ? { "Content-Type": "application/json" } : {}, o.headers || {});
  if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
  let r = await fetch(path, o);
  // сесії панелі живуть у памʼяті сервера: після перезапуску — увійти ще раз тим самим initData
  if (r.status === 401 && TGW && !o._retry) {
    if (await authTelegram()) { o.headers["x-session"] = ST.token; o._retry = true; r = await fetch(path, o); }
  }
  let j = null;
  try { j = await r.json(); } catch (e) { j = { ok: false, error: `HTTP ${r.status}` }; }
  if (r.status === 401 && !TGW) { location.href = "/login.html"; }
  return j;
}

// ── Вхід ────────────────────────────────────────────────────────────────
async function authTelegram() {
  const r = await fetch("/api/tg/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: TGW.initData }) });
  const j = await r.json().catch(() => ({ ok: false, error: "net" }));
  if (!j.ok) { ST.authError = j.error || "bad_init"; return false; }
  ST.token = j.token;
  ST.user = j.user;
  ST.lang = j.lang === "ru" ? "ru" : "uk";
  ST.viaTg = true;
  store.set("sas_session", j.token);       // повна панель (/index.html, /wyjazdy.html) бере сесію звідси
  store.set("sas_user", JSON.stringify(j.user));
  return true;
}

async function boot() {
  if (TGW) {
    try {
      TGW.ready();
      TGW.expand();
      TGW.setHeaderColor("#181b24");
      TGW.setBackgroundColor("#0f1117");
      if (TGW.setBottomBarColor) TGW.setBottomBarColor("#181b24");
    } catch (e) { /* старий клієнт Telegram */ }
    TGW.BackButton.onClick(() => { if (!$("sheet").hidden) closeSheet(); else go("home"); });
    const code = TGW.initDataUnsafe && TGW.initDataUnsafe.user && TGW.initDataUnsafe.user.language_code;
    if (/^ru/i.test(code || "")) ST.lang = "ru";
    let ok = false;
    try { ok = await authTelegram(); } catch (e) { ST.authError = "net"; }
    if (!ok) return showError(ST.authError);
  } else {
    // відкрито не з Telegram (тест у браузері): звичайна сесія панелі
    ST.token = store.get("sas_session");
    if (!ST.token) return showError("outside");
  }
  const go0 = /^#go=(.+)$/.exec(location.hash);
  if (go0) {
    const path = decodeURIComponent(go0[1]);
    if (/^\/[\w\-./]*(#[\w\-=:]*)?$/.test(path)) { location.replace(path); return; }
  }
  applyStatic();
  $("tabs").hidden = false;
  window.addEventListener("hashchange", route);
  route();
}

function showError(code) {
  const t = T();
  const d = { not_linked: t.e_not_linked, no_account: t.e_no_account, bad_init: t.e_bad_init, outside: t.e_outside, net: t.e_net }[code] || t.e_bad_init;
  $("tabs").hidden = true;
  $("view").innerHTML = `<div class="msg">
      <div class="t">${esc(code === "outside" ? "KoorPanel" : t.e_title)}</div>
      <div class="d">${esc(d)}</div>
      ${code === "outside" ? `<a class="btn primary wide" style="display:flex;align-items:center;justify-content:center;text-decoration:none;max-width:260px" href="/login.html">${esc(t.e_login)}</a>`
        : `<button class="btn ghost wide" style="max-width:260px" onclick="location.reload()">${esc(t.retry)}</button>`}
    </div>`;
}

function applyStatic() {
  const t = T();
  document.documentElement.lang = ST.lang;
  document.querySelectorAll("[data-t]").forEach((el) => { el.textContent = t[el.dataset.t] || ""; });
}

// ── Маршрути ───────────────────────────────────────────────────────────
function go(v) {
  const h = "#" + v;
  if (location.hash === h) route(); else location.hash = h;
}
// Повна панель у тому ж вікні Telegram (сесія вже в localStorage)
function openPanel(path) {
  location.href = path;
}
function route() {
  const h = (location.hash || "").replace(/^#/, "");
  const [v, arg] = h.split(":");
  const view = ["home", "hours", "req"].includes(v) ? v : "home";
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === view));
  if (TGW) { if (view === "home") TGW.BackButton.hide(); else TGW.BackButton.show(); }
  closeSheet();
  window.scrollTo(0, 0);
  if (view === "hours") {
    const m = /fac=(\d+)/.exec(arg || "");
    if (m) ST.fac = Number(m[1]);
    return renderHours(true);
  }
  if (view === "req") return renderReq();
  return renderHome();
}
function loading() { $("view").innerHTML = `<div class="center"><div class="spin" aria-hidden="true"></div></div>`; }

async function setLang(lang) {
  if (lang === ST.lang) return;
  ST.lang = lang;
  applyStatic();
  route();
  api("/api/tg/lang", { method: "POST", body: { lang } }).catch(() => {});
}
const langSeg = () => `<div class="seg" role="group" aria-label="Мова / Язык">
    <button class="${ST.lang === "uk" ? "on" : ""}" onclick="setLang('uk')">УКР</button>
    <button class="${ST.lang === "ru" ? "on" : ""}" onclick="setLang('ru')">РУС</button></div>`;

// ── Головна ────────────────────────────────────────────────────────────
async function renderHome() {
  if (!ST.home) loading();
  const j = await api("/api/tg/home");
  if (!j || !j.ok) { if (!ST.home) showError("net"); return; }
  if (!ST.viaTg && j.lang) { ST.lang = j.lang; applyStatic(); }
  ST.home = j;
  if (!/^(#home)?$/.test(location.hash || "")) return;        // користувач уже пішов на інший екран
  const t = T();
  const hr = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const hi = hr < 12 ? t.hi_m : hr < 18 ? t.hi_d : t.hi_e;
  const first = String(j.full_name || "").trim().split(/\s+/)[0] || "";
  const fl = j.facilities || [];
  const scope = j.company ? t.company : fl.length && fl.length <= 2 ? fl.join(", ") : t.facs(fl.length);
  const p = j.pending || { adv: 0, dof: 0 };
  const wait = (p.adv || 0) + (p.dof || 0);
  const plan = j.plan && j.plan.sites && j.plan.sites.length ? j.plan : null;
  const planNote = !plan ? "" : plan.unconfirmed
    ? `<span class="note warn">${esc(t.plan_unc(plan.unconfirmed, plan.deadline))}</span>` : `<span class="note">${esc(t.plan_ok)}</span>`;
  const kpi = (k, v, cls, on, sub) => `<button class="kpi ${v ? cls : "zero"}" onclick="${on}">
      <div class="k">${esc(k)}</div><div class="v">${v}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</button>`;
  const pill = (n) => (n ? `<span class="pill">${n}</span>` : "");
  const lst = (arr, row) => (arr.length
    ? `<div class="list">${arr.slice(0, LIST_MAX).map(row).join("")}${arr.length > LIST_MAX ? `<div class="empty">${esc(t.more(arr.length - LIST_MAX))}</div>` : ""}</div>`
    : `<div class="list"><div class="empty">${esc(t.nothing)}</div></div>`);

  $("view").innerHTML = `
    <div class="top">
      <div class="ttl">
        <h1>${esc(hi)}${first ? `, ${esc(first)}` : ""}</h1>
        <div class="sub">${esc(t.wdl[dow(j.today)])} ${dd(j.today)} · ${esc(scope)}</div>
        ${ST.viaTg ? `<div class="badge-ok"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>${esc(t.via_tg)}</div>` : ""}
      </div>
      ${langSeg()}
    </div>
    <div class="kpis">
      ${kpi(t.k_arr, j.arrivals.length, "", "jump('sArr')")}
      ${kpi(t.k_dep, j.departures.length, "", "jump('sDep')")}
      ${kpi(t.k_gaps(j.gap_min || 4), j.gaps.length, "warn", "go('hours')")}
      ${kpi(t.k_wait, wait, "info", `openPanel('/index.html#page=${p.adv || !p.dof ? "advances" : "dayoff"}')`, wait ? t.k_wait_s(p.adv || 0, p.dof || 0) : "")}
    </div>
    <nav class="links" aria-label="${esc(t.tab_home)}">
      <button onclick="go('hours')"><span class="l">${esc(t.l_hours)}</span>${j.gaps.length ? `<span class="note warn">${esc(t.h_nogap(j.gaps.length))}</span>` : ""}${CHEV}</button>
      <button onclick="openPanel('/index.html#page=advances')"><span class="l">${esc(t.l_adv)}</span>${pill(p.adv)}${CHEV}</button>
      <button onclick="openPanel('/index.html#page=dayoff')"><span class="l">${esc(t.l_dof)}</span>${pill(p.dof)}${CHEV}</button>
      <button onclick="openPanel('/wyjazdy.html')"><span class="l">${esc(t.l_flow)}</span>${CHEV}</button>
      ${plan ? `<button onclick="openPanel('/wyjazdy.html#orders')"><span class="l">${esc(t.l_plan)}</span>${planNote}${CHEV}</button>` : ""}
      <button onclick="go('req')"><span class="l">${esc(t.l_req)}</span>${CHEV}</button>
    </nav>
    <section class="sec" id="sArr"><h2>${esc(t.s_arr)} · ${j.arrivals.length}</h2>
      ${lst(j.arrivals, (a) => `<div class="row"><div class="nm"><b>${esc(a.full_name)}</b><span>${esc(a.facility || "—")}${a.kind === "transfer" ? ` · ${esc(t.transfer)}` : ""}</span></div></div>`)}
    </section>
    <section class="sec" id="sDep"><h2>${esc(t.s_dep)} · ${j.departures.length}</h2>
      ${lst(j.departures, (a) => `<div class="row"><div class="nm"><b>${esc(a.full_name)}</b><span>${esc(a.facility || "—")}${a.is_transfer ? ` → ${esc(a.to_site || t.transfer)}` : ""}</span></div></div>`)}
    </section>
    <section class="sec" id="sGaps"><h2>${esc(t.s_gaps(j.gap_min || 4))} · ${j.gaps.length}</h2>
      ${lst(j.gaps, (g) => `<div class="row"><div class="nm"><b>${esc(g.full_name)}</b><span class="warn">${esc(g.facility || "—")} · ${esc(t.days(g.days))}</span></div>
        <button class="mini" ${g.in_bot ? "" : "disabled"} onclick="remind(${g.worker_id}, this)">${esc(g.in_bot ? t.remind_s : t.no_bot)}</button></div>`)}
    </section>`;
}
function jump(id) { const el = $(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

async function remind(workerId, btn) {
  const t = T();
  if (btn) btn.disabled = true;
  const r = await api(`/api/tg/remind/${workerId}`, { method: "POST" }).catch(() => null);
  if (r && r.ok) { toast(t.sent); return; }
  if (btn) btn.disabled = false;
  const e = r && r.error;
  toast({ not_in_bot: t.r_not_in_bot, no_gaps: t.r_no_gaps, blocked: t.r_blocked, "already running": t.r_busy, disabled: t.r_disabled }[e] || t.r_err, true);
}

// ── Години ─────────────────────────────────────────────────────────────
async function renderHours(reload) {
  const t = T();
  if (!ST.facs) {
    loading();
    const f = await api("/api/tg/facilities");
    if (!f || !f.ok) return showError("net");
    ST.facs = f.data;
  }
  if (!ST.facs.length) { $("view").innerHTML = `<div class="top"><div class="ttl"><h1>${esc(t.h_title)}</h1></div>${langSeg()}</div><div class="list"><div class="empty">${esc(t.h_nofacs)}</div></div>`; return; }
  if (!ST.fac || !ST.facs.some((x) => x.id === ST.fac)) {
    const saved = Number(store.get("tg_fac"));
    ST.fac = ST.facs.some((x) => x.id === saved) ? saved : ST.facs[0].id;
  }
  if (!ST.end) ST.end = today();
  if (reload || !ST.hours) {
    if (!ST.hours) loading();
    const from = addDays(ST.end, -6);
    const r = await api(`/api/tg/hours?facility_id=${ST.fac}&from=${from}&to=${ST.end}`);
    if (!r || !r.ok) { toast(r && r.error ? r.error : t.e_net, true); return; }
    ST.hours = r;
  }
  drawHours();
}
function drawHours() {
  const t = T();
  const r = ST.hours;
  const now = today();
  const days = Array.from({ length: 7 }, (_, i) => addDays(r.from, i));
  const fac = ST.facs.find((x) => x.id === ST.fac) || {};
  const gapsN = r.data.filter((x) => x.gap > 0).length;
  const rows = ST.onlyGaps ? r.data.filter((x) => x.gap > 0) : r.data;
  const cell = (w, d) => {
    if (d > now) return `<div class="c off" aria-hidden="true"></div>`;
    if ((w.bhp && d < w.bhp) || (w.lwd && d > w.lwd)) return `<div class="c off" title="${dd(d)}">–</div>`;
    const x = w.days[d];
    const sel = ST.sheet && ST.sheet.worker === w.id && ST.sheet.date === d ? " sel" : "";
    const on = r.can_edit ? `onclick="openSheet(${w.id}, '${d}')"` : "disabled";
    const label = `${esc(w.full_name)} ${dd(d)}`;
    if (x && x.abs) return `<button class="c abs${sel}" ${on} aria-label="${label}: ${esc(x.abs)}">${esc(t.codes[x.abs] || x.abs)}</button>`;
    if (x && x.hours != null) return `<button class="c${sel}" ${on} aria-label="${label}: ${fmtH(x.hours)}">${fmtH(x.hours)}</button>`;
    if (x) return `<button class="c${sel}" ${on} aria-label="${label}">·</button>`;
    return d < now ? `<button class="c miss${sel}" ${on} aria-label="${label}: ?">?</button>` : `<button class="c${sel}" ${on} aria-label="${label}">+</button>`;
  };
  $("view").innerHTML = `
    <div class="top"><div class="ttl"><h1>${esc(t.h_title)}</h1><div class="sub">${esc(fac.name || "")}</div></div>${langSeg()}</div>
    <div class="chips" role="tablist">
      ${ST.facs.map((f) => `<button class="chip ${f.id === ST.fac ? "on" : ""}" role="tab" aria-selected="${f.id === ST.fac}" onclick="pickFac(${f.id})">${esc(f.name)}</button>`).join("")}
    </div>
    <div class="weekbar">
      <button class="arrow" onclick="shiftWeek(-7)" aria-label="‹">‹</button>
      <div class="rng">${dd(r.from)} – ${dd(r.to)}</div>
      <button class="arrow" onclick="shiftWeek(7)" ${r.to >= now ? "disabled" : ""} aria-label="›">›</button>
      ${gapsN ? `<button class="chip warn ${ST.onlyGaps ? "on" : ""}" onclick="ST.onlyGaps=!ST.onlyGaps; drawHours()">${esc(t.h_nogap(gapsN))}</button>` : ""}
    </div>
    ${r.can_edit ? "" : `<div class="note-ro">${esc(t.h_ro)}</div>`}
    <div class="grid">
      <div class="gr hd"><div>${esc(t.who)}</div>${days.map((d) => `<div class="${d === now ? "today" : ""}">${esc(t.wd[dow(d)])}<br>${d.slice(8, 10)}</div>`).join("")}</div>
      ${rows.length ? rows.map((w) => `<div class="gr ${w.gap ? "gap" : ""}">
          <div class="who"><b>${esc(w.full_name)}</b>${w.gap ? `<span class="warn">${esc(t.h_gap(w.gap))}</span>` : `<span>${esc(t.h_month(fmtH(w.month)))}</span>`}</div>
          ${days.map((d) => cell(w, d)).join("")}</div>`).join("") : `<div class="empty">${esc(t.h_none)}</div>`}
    </div>`;
}
function pickFac(id) {
  ST.fac = id;
  store.set("tg_fac", String(id));
  ST.onlyGaps = false;
  renderHours(true);
}
function shiftWeek(n) {
  const e = addDays(ST.end || today(), n);
  ST.end = e > today() ? today() : e;
  renderHours(true);
}

// ── Аркуш правки ───────────────────────────────────────────────────────
function openSheet(workerId, date) {
  const t = T();
  const w = ST.hours.data.find((x) => x.id === workerId);
  if (!w) return;
  const x = w.days[date] || {};
  ST.sheet = { worker: workerId, date, abs: x.abs || null };
  const fac = ST.facs.find((f) => f.id === ST.fac) || {};
  $("shName").textContent = w.full_name;
  $("shSub").textContent = `${t.wdl[dow(date)]} ${dd(date)} · ${fac.name || ""}`;
  $("shHours").value = x.hours != null ? fmtH(x.hours) : "";
  $("shCodes").innerHTML = CODES.map((c) => `<button type="button" data-code="${c}" class="${x.abs === c ? "on" : ""}" onclick="pickCode('${c}')">${esc(t.codes[c])}<small>${esc(t.codes_t[c])}</small></button>`).join("");
  $("shErr").hidden = true;
  $("shRemind").disabled = !(w.in_bot && w.gap > 0);
  $("shSave").disabled = false;
  $("sheet").hidden = false;
  $("sheetBg").hidden = false;
  if (TGW) TGW.BackButton.show();
  drawHours();
  setTimeout(() => { if (!ST.sheet.abs) $("shHours").focus(); }, 50);
}
function closeSheet() {
  if (!$("sheet") || $("sheet").hidden) return;
  $("sheet").hidden = true;
  $("sheetBg").hidden = true;
  ST.sheet = null;
  if (ST.hours && /^#hours/.test(location.hash)) drawHours();
}
function pickCode(c) {
  ST.sheet.abs = ST.sheet.abs === c ? null : c;
  $("shHours").value = "";
  document.querySelectorAll("#shCodes button").forEach((b) => b.classList.toggle("on", b.dataset.code === ST.sheet.abs));
  $("shErr").hidden = true;
}
function onHoursInput() {
  if (ST.sheet && ST.sheet.abs && $("shHours").value.trim()) {
    ST.sheet.abs = null;
    document.querySelectorAll("#shCodes button").forEach((b) => b.classList.remove("on"));
  }
  $("shErr").hidden = true;
}
function sheetError(text) {
  $("shErr").textContent = text;
  $("shErr").hidden = false;
  haptic("error");
}
async function saveSheet() {
  const t = T();
  const s = ST.sheet;
  if (!s) return;
  const raw = $("shHours").value.trim().replace(",", ".");
  let hours = null;
  if (raw) {
    hours = Number(raw);
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 13) return sheetError(t.bad_hours);
  } else if (!s.abs) return sheetError(t.need_val);
  $("shSave").disabled = true;
  const r = await api("/api/hours", { method: "POST", body: { worker_id: s.worker, work_date: s.date, hours, absence_type: hours != null ? null : s.abs } }).catch(() => null);
  $("shSave").disabled = false;
  if (!r || !r.ok) return sheetError((r && r.error) || t.e_net);
  const w = ST.hours.data.find((x) => x.id === s.worker);
  if (w) {
    const prev = w.days[s.date];
    const was = prev && prev.hours != null ? Number(prev.hours) : 0;
    w.days[s.date] = { hours, abs: hours != null ? null : s.abs };
    if (s.date.slice(0, 7) === ST.hours.to.slice(0, 7)) w.month = Math.round((Number(w.month) - was + (hours || 0)) * 100) / 100;
  }
  closeSheet();
  toast(t.saved);
}
async function remindFromSheet() {
  if (!ST.sheet) return;
  await remind(ST.sheet.worker, $("shRemind"));
}

// ── Заявки (розділи заповнимо пізніше) ─────────────────────────────────
function renderReq() {
  const t = T();
  const card = (title, desc, icon) => `<div class="req">
      <div class="ic">${icon}</div>
      <div class="b"><div class="t">${esc(title)}</div><div class="d">${esc(desc)}</div><span class="soon">${esc(t.soon)}</span></div>
    </div>`;
  $("view").innerHTML = `
    <div class="top"><div class="ttl"><h1>${esc(t.req_title)}</h1><div class="sub">${esc(t.req_sub)}</div></div>${langSeg()}</div>
    <section id="reqMed">${card(t.req_med, t.req_med_d, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`)}</section>
    <section id="reqFine">${card(t.req_fine, t.req_fine_d, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>`)}</section>`;
}

boot();
