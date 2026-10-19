// KoorPanel у Telegram (мініпанель). Українська / русский.
// Вхід: Telegram.WebApp.initData → POST /api/tg/auth → звичайна сесія панелі (x-session),
// тож години правляться тим самим POST /api/hours, що й у панелі, з тими самими правами.
// Адреси: #home, #hours, #hours:fac=<id>, #adv, #dof, #req, #go=<шлях панелі> (напр. /wyjazdy.html#orders).
// Telegram дописує до адреси свої параметри (#…&tgWebAppData=… або #tgWebAppData=…) — їх відкидаємо.
"use strict";

const TGW = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;

// 1 особа, 2 особи, 5 осіб (11–14 — осіб)
const ppl = (n) => { const a = n % 10, b = n % 100; return `${n} ${a === 1 && b !== 11 ? "особа" : a >= 2 && a <= 4 && (b < 12 || b > 14) ? "особи" : "осіб"}`; };
const L = {
  uk: {
    tab_home: "Головна", tab_hours: "Години", tab_dec: "Рішення", tab_req: "Заявки", tab_panel: "Панель",
    hi_m: "Доброго ранку", hi_d: "Добрий день", hi_e: "Добрий вечір",
    facs: (n) => `${n} ${n === 1 ? "обʼєкт" : n < 5 && n > 1 ? "обʼєкти" : "обʼєктів"}`, company: "уся фірма",
    sc: { own: "Свої обʼєкти", region: "Регіон", all: "Уся фірма" },
    via_tg: "Вхід через Telegram — без пароля",
    k_arr: "Приїзди сьогодні", k_dep: "Останній день", k_gaps: (d) => `Без годин ${d}+ дн.`, k_wait: "Чекають рішення",
    k_wait_s: (a, d) => `${a} аванс. · ${d} вихідн.`,
    l_hours: "Години працівників", l_adv: "Аванси", l_dof: "Вихідні", l_flow: "Виїзди / приїзди", l_plan: "План набору", l_req: "Заявки",
    plan_unc: (n, dl) => `не підтверджено ${n} · до нд ${dl}`, plan_ok: "підтверджено",
    s_arr: "Сьогодні приїжджають", s_dep: "Сьогодні останній день", s_gaps: (d) => `Без годин ${d}+ дн.`,
    transfer: "переведення", days: (n) => `${n} дн. без годин`, remind: "Нагадати в боті", remind_s: "Нагадати", no_bot: "немає бота",
    nothing: "Нічого", more: (n) => `… і ще ${n}`,
    h_title: "Години", h_month: (h) => `${h} год за місяць`, h_gap: (n) => `⚠ ${n} дн. без годин`, h_nogap: (n) => `Без годин: ${n}`,
    h_ro: "Тільки перегляд — на цьому обʼєкті немає права правки (Region → Przypisania).",
    h_none: "На цьому обʼєкті в ці дні нікого немає.", h_nofacs: "За вами немає обʼєктів.",
    who: "Працівник", hours_lbl: "Години", abs_lbl: "або код відсутності", save: "Зберегти", saved: "Збережено",
    bad_hours: "Години від 0,25 до 13. Якщо не працював — оберіть код.", need_val: "Введіть години або оберіть код.",
    sent: "Нагадування надіслано", r_not_in_bot: "Працівник не підключений до бота", r_no_gaps: "У працівника немає серії пропущених днів",
    r_blocked: "Працівник заблокував бота", r_busy: "Розсилка вже йде — спробуйте за хвилину", r_disabled: "Нагадування вимкнені (GAP_ENABLED)",
    r_err: "Не вдалося надіслати",
    // аванси / вихідні
    adv_title: "Аванси", dof_title: "Вихідні", f_pending: (n) => `Чекають · ${n}`, f_all: "Усі за 30 днів",
    bhp: "BHP", req_at: "Заявка", hrs: "Години", m_cur: "цей міс.", m_prev: "мин. міс.", days_l: "Дні", n_days: (n) => `${n} дн.`,
    free: (off, staff) => `вже вільні ${off} з ${staff}`, std: (z) => `${z} zł`,
    st: { pending: "Чекає", approved: "Схвалено", rejected: "Відхилено" },
    approve: "Схвалити", reject: "Відхилити", all_ok: (n) => `Схвалити всі · ${n}`,
    all_q: (n, f) => `Схвалити всі ${n} заявки на обʼєкті ${f}?`,
    by: (who, t) => `${who} · ${t}`, why: "Причина", view_only: "Тільки перегляд — не ваш обʼєкт",
    done_ok: "Схвалено", done_no: "Відхилено", done_n: (n) => `Схвалено: ${n}`, already: "Вже вирішено іншим координатором",
    no_right: "Немає права рішення на цьому обʼєкті", none_p: "Немає заявок, що чекають рішення.", none_a: "За 30 днів заявок немає.",
    reason_q: "Причина відмови — працівник побачить її в боті", cancel: "Скасувати",
    r: { hours: "Замало годин", had: "Вже був аванс", leaving: "Завершує роботу", staff: "Мало людей на зміні", late: "Пізно подано", none: "Без причини" },
    // відправка в офіс
    off_btn: (n) => `Відправити в офіс · ${n}`, off_title: "Відправити в офіс", off_sub: (d) => `Схвалені аванси за ${d} днів, ще не надіслані`,
    off_items: (n) => `Аванси · ${n}`, off_all: "Усі", off_none: "Жодного", off_empty: "Усі схвалені аванси вже надіслані.",
    off_appr: (d, h) => `схвалено ${d} · ${h} год`, off_to: "Кому", off_add: "Додати", off_email_ph: "e-mail адресата",
    off_shared: "для всіх координаторів", off_tag: "офіс", off_cc: (e) => `Копія і відповіді — вам: ${e}`,
    off_nocc: "У вашій картці в панелі немає e-mail — копії вам не буде.", off_from: (e) => `Від: ${e}`,
    off_sum: (n, z) => `${ppl(n)} · разом ${z} zł · таблиця в листі + Excel`, off_send: "Надіслати", off_hist: "Надіслано раніше",
    off_ok: (n) => `Лист надіслано: ${ppl(n)}`, off_del_q: (e) => `Прибрати адресата ${e}?`,
    off_nocfg: "Пошта ще не налаштована — список можна переглянути, «Надіслати» запрацює після налаштування.",
    off_why: { no_nodemailer: "На сервері: npm install nodemailer, потім pm2 restart index.", no_gmail: "У .env немає GMAIL_USER або GMAIL_APP_PASSWORD.",
      no_microsoft: "У .env немає MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MAIL_FROM." },
    off_err: { not_configured: "Пошта не налаштована", no_recipients: "Оберіть адресата", bad_email: "Неправильна адреса e-mail",
      no_items: "Оберіть аванси", changed: "Список змінився (хтось уже надіслав) — оновлено", busy: "Лист уже надсилається",
      admin_only: "Спільних адресатів додає адмін", send_failed: "Не вдалося надіслати", range_too_long: "Діапазон — не більше 31 дня" },
    off_sent: (t) => `в офісі ${t}`, off_st_err: "помилка",
    req_title: "Заявки", req_sub: "Заявки до офісу",
    req_med: "Медогляд", req_med_d: "Замовлення медогляду для тих, хто починає роботу",
    med_title: "Медогляд", med_sub: "Хто починає роботу (BHP) у вибрані дні — одним листом у клініку",
    med_q: { today: "Сьогодні", tomorrow: "Завтра", week: "Цей тиждень", next: "Наступний тиждень" }, med_from: "з", med_to: "по",
    med_items: (n) => `BHP у ці дні · ${n}`, med_empty: "У ці дні ніхто не починає роботу на ваших обʼєктах.",
    med_done: (t) => `замовлено ${t}`, med_to_h: "Кому (клініка)", med_send: "Замовити медогляд",
    med_sum: (n) => `${ppl(n)} · таблиця в листі + Excel`, med_ok: (n) => `Замовлення надіслано: ${ppl(n)}`,
    med_date_note: "Дата медогляду в листі — дата відправки, але не пізніше BHP.",
    req_fine: "Штрафи", req_fine_d: "Штрафи й утримання працівників",
    soon: "Розділ у розробці",
    e_title: "Вхід не вдався", e_not_linked: "Цей Telegram не привʼязаний до панелі. Увійдіть у панель на компʼютері → кнопка «Telegram» → відкрийте посилання тут.",
    e_no_account: "Для вашого профілю немає облікового запису панелі. Зверніться до адміністратора.",
    e_bad_init: "Не вдалося перевірити вхід Telegram. Закрийте панель і відкрийте знову кнопкою «Panel».",
    e_outside: "Мініпанель відкривається кнопкою «Panel» у чаті з ботом.", e_login: "Увійти з паролем", e_net: "Немає звʼязку з сервером. Спробуйте ще раз.",
    retry: "Спробувати ще раз", fac_pick: "Обʼєкт",
    wd: ["нд", "пн", "вт", "ср", "чт", "пт", "сб"],
    wdl: ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"],
    codes: { WZ: "DW", DWZ: "DWZ", URL: "URL", L4: "L4", NN: "NN", UN: "UN" },
    codes_t: { WZ: "вихідний", DWZ: "вихідн. зав.", URL: "відпустка", L4: "лікарн.", NN: "прогул", UN: "поважна" },
  },
  ru: {
    tab_home: "Главная", tab_hours: "Часы", tab_dec: "Решения", tab_req: "Заявки", tab_panel: "Панель",
    hi_m: "Доброе утро", hi_d: "Добрый день", hi_e: "Добрый вечер",
    facs: (n) => `${n} ${n === 1 ? "объект" : n < 5 && n > 1 ? "объекта" : "объектов"}`, company: "вся фирма",
    sc: { own: "Свои объекты", region: "Регион", all: "Вся фирма" },
    via_tg: "Вход через Telegram — без пароля",
    k_arr: "Приезды сегодня", k_dep: "Последний день", k_gaps: (d) => `Без часов ${d}+ дн.`, k_wait: "Ждут решения",
    k_wait_s: (a, d) => `${a} аванс. · ${d} выходн.`,
    l_hours: "Часы работников", l_adv: "Авансы", l_dof: "Выходные", l_flow: "Выезды / приезды", l_plan: "План набора", l_req: "Заявки",
    plan_unc: (n, dl) => `не подтверждено ${n} · до вс ${dl}`, plan_ok: "подтверждено",
    s_arr: "Сегодня приезжают", s_dep: "Сегодня последний день", s_gaps: (d) => `Без часов ${d}+ дн.`,
    transfer: "перевод", days: (n) => `${n} дн. без часов`, remind: "Напомнить в боте", remind_s: "Напомнить", no_bot: "нет бота",
    nothing: "Ничего", more: (n) => `… и ещё ${n}`,
    h_title: "Часы", h_month: (h) => `${h} ч за месяц`, h_gap: (n) => `⚠ ${n} дн. без часов`, h_nogap: (n) => `Без часов: ${n}`,
    h_ro: "Только просмотр — на этом объекте нет права правки (Region → Przypisania).",
    h_none: "На этом объекте в эти дни никого нет.", h_nofacs: "За вами нет объектов.",
    who: "Работник", hours_lbl: "Часы", abs_lbl: "или код отсутствия", save: "Сохранить", saved: "Сохранено",
    bad_hours: "Часы от 0,25 до 13. Если не работал — выберите код.", need_val: "Введите часы или выберите код.",
    sent: "Напоминание отправлено", r_not_in_bot: "Работник не подключён к боту", r_no_gaps: "У работника нет серии пропущенных дней",
    r_blocked: "Работник заблокировал бота", r_busy: "Рассылка уже идёт — попробуйте через минуту", r_disabled: "Напоминания выключены (GAP_ENABLED)",
    r_err: "Не удалось отправить",
    adv_title: "Авансы", dof_title: "Выходные", f_pending: (n) => `Ждут · ${n}`, f_all: "Все за 30 дней",
    bhp: "BHP", req_at: "Заявка", hrs: "Часы", m_cur: "этот мес.", m_prev: "прош. мес.", days_l: "Дни", n_days: (n) => `${n} дн.`,
    free: (off, staff) => `уже свободны ${off} из ${staff}`, std: (z) => `${z} zł`,
    st: { pending: "Ждёт", approved: "Одобрено", rejected: "Отклонено" },
    approve: "Одобрить", reject: "Отклонить", all_ok: (n) => `Одобрить все · ${n}`,
    all_q: (n, f) => `Одобрить все ${n} заявки на объекте ${f}?`,
    by: (who, t) => `${who} · ${t}`, why: "Причина", view_only: "Только просмотр — не ваш объект",
    done_ok: "Одобрено", done_no: "Отклонено", done_n: (n) => `Одобрено: ${n}`, already: "Уже решено другим координатором",
    no_right: "Нет права решения на этом объекте", none_p: "Нет заявок, ждущих решения.", none_a: "За 30 дней заявок нет.",
    reason_q: "Причина отказа — работник увидит её в боте", cancel: "Отмена",
    r: { hours: "Мало часов", had: "Уже был аванс", leaving: "Заканчивает работу", staff: "Мало людей на смене", late: "Поздно подано", none: "Без причины" },
    off_btn: (n) => `Отправить в офис · ${n}`, off_title: "Отправить в офис", off_sub: (d) => `Одобренные авансы за ${d} дней, ещё не отправленные`,
    off_items: (n) => `Авансы · ${n}`, off_all: "Все", off_none: "Ни одного", off_empty: "Все одобренные авансы уже отправлены.",
    off_appr: (d, h) => `одобрено ${d} · ${h} ч`, off_to: "Кому", off_add: "Добавить", off_email_ph: "e-mail адресата",
    off_shared: "для всех координаторов", off_tag: "офис", off_cc: (e) => `Копия и ответы — вам: ${e}`,
    off_nocc: "В вашей карточке в панели нет e-mail — копии вам не будет.", off_from: (e) => `От: ${e}`,
    off_sum: (n, z) => `${n} чел. · всего ${z} zł · таблица в письме + Excel`, off_send: "Отправить", off_hist: "Отправлено ранее",
    off_ok: (n) => `Письмо отправлено: ${n} чел.`, off_del_q: (e) => `Убрать адресата ${e}?`,
    off_nocfg: "Почта ещё не настроена — список можно посмотреть, «Отправить» заработает после настройки.",
    off_why: { no_nodemailer: "На сервере: npm install nodemailer, затем pm2 restart index.", no_gmail: "В .env нет GMAIL_USER или GMAIL_APP_PASSWORD.",
      no_microsoft: "В .env нет MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MAIL_FROM." },
    off_err: { not_configured: "Почта не настроена", no_recipients: "Выберите адресата", bad_email: "Неправильный адрес e-mail",
      no_items: "Выберите авансы", changed: "Список изменился (кто-то уже отправил) — обновлено", busy: "Письмо уже отправляется",
      admin_only: "Общих адресатов добавляет админ", send_failed: "Не удалось отправить", range_too_long: "Диапазон — не больше 31 дня" },
    off_sent: (t) => `в офисе ${t}`, off_st_err: "ошибка",
    req_title: "Заявки", req_sub: "Заявки в офис",
    req_med: "Медосмотр", req_med_d: "Заказ медосмотра для тех, кто начинает работу",
    med_title: "Медосмотр", med_sub: "Кто начинает работу (BHP) в выбранные дни — одним письмом в клинику",
    med_q: { today: "Сегодня", tomorrow: "Завтра", week: "Эта неделя", next: "Следующая неделя" }, med_from: "с", med_to: "по",
    med_items: (n) => `BHP в эти дни · ${n}`, med_empty: "В эти дни никто не начинает работу на ваших объектах.",
    med_done: (t) => `заказано ${t}`, med_to_h: "Кому (клиника)", med_send: "Заказать медосмотр",
    med_sum: (n) => `${n} чел. · таблица в письме + Excel`, med_ok: (n) => `Заказ отправлен: ${n} чел.`,
    med_date_note: "Дата медосмотра в письме — дата отправки, но не позже BHP.",
    req_fine: "Штрафы", req_fine_d: "Штрафы и удержания работников",
    soon: "Раздел в разработке",
    e_title: "Вход не удался", e_not_linked: "Этот Telegram не привязан к панели. Войдите в панель на компьютере → кнопка «Telegram» → откройте ссылку здесь.",
    e_no_account: "Для вашего профиля нет учётной записи панели. Обратитесь к администратору.",
    e_bad_init: "Не удалось проверить вход Telegram. Закройте панель и откройте снова кнопкой «Panel».",
    e_outside: "Мини-панель открывается кнопкой «Panel» в чате с ботом.", e_login: "Войти с паролем", e_net: "Нет связи с сервером. Попробуйте ещё раз.",
    retry: "Попробовать ещё раз", fac_pick: "Объект",
    wd: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
    wdl: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
    codes: { WZ: "DW", DWZ: "DWZ", URL: "URL", L4: "L4", NN: "NN", UN: "UN" },
    codes_t: { WZ: "выходной", DWZ: "выходн. зав.", URL: "отпуск", L4: "больнич.", NN: "прогул", UN: "уважит." },
  },
};
const CODES = ["WZ", "DWZ", "URL", "L4", "NN", "UN"];
const REASONS = { adv: ["hours", "had", "leaving", "none"], dof: ["staff", "late", "none"] };
const LIST_MAX = 15;
const MANY_FACS = 10;      // більше обʼєктів — вибір списком замість «таблеток»

const ST = {
  lang: "uk", token: null, user: null, viaTg: false, view: "home",
  home: null, facs: null, fac: null, end: null, hours: null, onlyGaps: false,
  sheet: null, req: { adv: null, dof: null }, reqStatus: "pending", lastDec: "adv", reject: null,
  off: {}, medRange: null,
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
const ddY = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "—");
const ddhm = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};
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
function ask(text) {
  return new Promise((res) => {
    try { if (TGW && TGW.showConfirm) return TGW.showConfirm(text, (ok) => res(!!ok)); } catch (e) { /* нижче */ }
    res(window.confirm(text));
  });
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

// ── Адреса: наш маршрут без параметрів Telegram ─────────────────────────
function hashRoute() {
  const raw = (location.hash || "").replace(/^#/, "");
  const mine = raw.replace(/(^|[#&?])tgWebApp[\s\S]*$/, "");
  return mine.split("&")[0] || "";
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
  try { sessionStorage.setItem("sas_tg", "1"); } catch (e) { /* повна панель покаже «Назад» у Telegram */ }
  return true;
}

function onBack() {
  if (!$("sheet").hidden || !$("rsheet").hidden) return closeSheets();
  if (ST.view === "office") return go("adv");
  if (ST.view === "med") return go("req");
  if (ST.view !== "home") return go("home");
}

async function boot() {
  const first = hashRoute();
  if (TGW) {
    try {
      TGW.ready();
      TGW.expand();
      TGW.setHeaderColor("#181b24");
      TGW.setBackgroundColor("#0f1117");
      if (TGW.setBottomBarColor) TGW.setBottomBarColor("#181b24");
    } catch (e) { /* старий клієнт Telegram */ }
    try {
      TGW.BackButton.onClick(onBack);
    } catch (e) {
      try { TGW.onEvent("backButtonClicked", onBack); } catch (e2) { /* без кнопки «Назад» */ }
    }
    // параметри Telegram вже прочитані SDK (і збережені ним для перезавантаження) — прибрати з адреси
    try { history.replaceState(null, "", location.pathname + location.search + (first ? "#" + first : "#home")); } catch (e) { /* не страшно */ }
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
  const go0 = /^go=(.+)$/.exec(first);
  if (go0) {
    let path = "";
    try { path = decodeURIComponent(go0[1]); } catch (e) { path = ""; }
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
  if (hashRoute() === v) route(); else location.hash = "#" + v;
}
// Повна панель у тому ж вікні Telegram (сесія вже в localStorage; «Назад» Telegram поверне сюди — /tg/back.js)
function openPanel(path) {
  location.href = path;
}
function route() {
  const [v, arg] = hashRoute().split(":");
  const view = ["home", "hours", "req", "adv", "dof", "office", "med"].includes(v) ? v : "home";
  ST.view = view;
  const tab = view === "adv" || view === "dof" || view === "office" ? "dec" : view === "med" ? "req" : view;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (TGW) { try { if (view === "home") TGW.BackButton.hide(); else TGW.BackButton.show(); } catch (e) { /* старий клієнт */ } }
  closeSheets();
  window.scrollTo(0, 0);
  if (view === "hours") {
    const m = /fac=(\d+)/.exec(arg || "");
    if (m) ST.fac = Number(m[1]);
    return renderHours(true);
  }
  if (view === "adv" || view === "dof") { ST.lastDec = view; return renderDec(view); }
  if (view === "office") return renderOffice("adv");
  if (view === "med") return renderOffice("med");
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

// Зріз: свої обʼєкти / регіон (регіональні) / уся фірма (адмін)
function scopeSeg(scope, scopes) {
  if (!scopes || scopes.length < 2) return "";
  const t = T();
  return `<div class="seg wide" role="group" aria-label="${esc(t.sc.own)}">
    ${scopes.map((s) => `<button class="${s === scope ? "on" : ""}" onclick="setScope('${s}')">${esc(t.sc[s] || s)}</button>`).join("")}</div>`;
}
async function setScope(s) {
  const r = await api("/api/tg/scope", { method: "POST", body: { scope: s } });
  if (!r || !r.ok) return toast((r && r.error) || T().e_net, true);
  ST.home = null; ST.facs = null; ST.hours = null; ST.fac = null; ST.req = { adv: null, dof: null }; ST.off = {};
  route();
}

// ── Головна ────────────────────────────────────────────────────────────
async function renderHome() {
  if (!ST.home) loading();
  const j = await api("/api/tg/home");
  if (!j || !j.ok) { if (!ST.home) showError("net"); return; }
  if (!ST.viaTg && j.lang) { ST.lang = j.lang; applyStatic(); }
  ST.home = j;
  if (ST.view !== "home") return;        // користувач уже пішов на інший екран
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
    ${scopeSeg(j.scope, j.scopes)}
    <div class="kpis">
      ${kpi(t.k_arr, j.arrivals.length, "", "jump('sArr')")}
      ${kpi(t.k_dep, j.departures.length, "", "jump('sDep')")}
      ${kpi(t.k_gaps(j.gap_min || 4), j.gaps.length, "warn", "go('hours')")}
      ${kpi(t.k_wait, wait, "info", `go('${p.adv || !p.dof ? "adv" : "dof"}')`, wait ? t.k_wait_s(p.adv || 0, p.dof || 0) : "")}
    </div>
    <nav class="links" aria-label="${esc(t.tab_home)}">
      <button onclick="go('hours')"><span class="l">${esc(t.l_hours)}</span>${j.gaps.length ? `<span class="note warn">${esc(t.h_nogap(j.gaps.length))}</span>` : ""}${CHEV}</button>
      <button onclick="go('adv')"><span class="l">${esc(t.l_adv)}</span>${pill(p.adv)}${CHEV}</button>
      <button onclick="go('dof')"><span class="l">${esc(t.l_dof)}</span>${pill(p.dof)}${CHEV}</button>
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
    ST.facScope = { scope: f.scope, scopes: f.scopes };
  }
  if (ST.view !== "hours") return;
  if (!ST.facs.length) {
    $("view").innerHTML = `<div class="top"><div class="ttl"><h1>${esc(t.h_title)}</h1></div>${langSeg()}</div>
      ${scopeSeg(ST.facScope.scope, ST.facScope.scopes)}<div class="list"><div class="empty">${esc(t.h_nofacs)}</div></div>`;
    return;
  }
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
  if (ST.view === "hours") drawHours();
}
function facPicker() {
  const t = T();
  if (ST.facs.length > MANY_FACS) {
    const groups = {};
    ST.facs.forEach((f) => { (groups[f.group_name || f.name] = groups[f.group_name || f.name] || []).push(f); });
    return `<label class="facsel"><span>${esc(t.fac_pick)}</span><select onchange="pickFac(Number(this.value))">
      ${Object.keys(groups).sort((a, b) => a.localeCompare(b)).map((g) => `<optgroup label="${esc(g)}">${groups[g].map((f) =>
        `<option value="${f.id}" ${f.id === ST.fac ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</optgroup>`).join("")}
    </select></label>`;
  }
  return `<div class="chips" role="tablist">
      ${ST.facs.map((f) => `<button class="chip ${f.id === ST.fac ? "on" : ""}" role="tab" aria-selected="${f.id === ST.fac}" onclick="pickFac(${f.id})">${esc(f.name)}</button>`).join("")}
    </div>`;
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
    ${scopeSeg(ST.facScope.scope, ST.facScope.scopes)}
    ${facPicker()}
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

// ── Аркуші (правка години / причина відмови) ───────────────────────────
function showSheet(id) {
  $(id).hidden = false;
  $("sheetBg").hidden = false;
  if (TGW) { try { TGW.BackButton.show(); } catch (e) { /* старий клієнт */ } }
}
function closeSheets() {
  const was = !$("sheet").hidden;
  $("sheet").hidden = true;
  $("rsheet").hidden = true;
  $("sheetBg").hidden = true;
  ST.reject = null;
  if (was) {
    ST.sheet = null;
    if (ST.hours && ST.view === "hours") drawHours();
  }
  if (TGW && ST.view === "home") { try { TGW.BackButton.hide(); } catch (e) { /* старий клієнт */ } }
}
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
  showSheet("sheet");
  drawHours();
  setTimeout(() => { if (ST.sheet && !ST.sheet.abs) $("shHours").focus(); }, 50);
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
  closeSheets();
  toast(t.saved);
}
async function remindFromSheet() {
  if (!ST.sheet) return;
  await remind(ST.sheet.worker, $("shRemind"));
}

// ── Рішення: аванси / вихідні ──────────────────────────────────────────
// Згруповано по обʼєктах; у картці: прізвище, паспорт, BHP, під ним дата заявки, години, статус, під ними кнопки.
async function renderDec(kind, keep) {
  if (!ST.req[kind] || !keep) {
    if (!ST.req[kind]) loading();
    const r = await api(`/api/tg/requests?kind=${kind}&status=${ST.reqStatus}`);
    if (!r || !r.ok) { if (!ST.req[kind]) showError("net"); else toast((r && r.error) || T().e_net, true); return; }
    ST.req[kind] = r;
  }
  if (ST.view === kind) drawDec(kind);
}
function setReqStatus(s) {
  if (ST.reqStatus === s) return;
  ST.reqStatus = s;
  ST.req = { adv: null, dof: null };
  renderDec(ST.view);
}
function drawDec(kind) {
  const t = T();
  const r = ST.req[kind];
  const items = r.items;
  const pending = items.filter((x) => x.status === "pending").length;
  const groups = [];
  const G = {};
  items.forEach((x) => {
    if (!G[x.facility]) { G[x.facility] = { name: x.facility, items: [] }; groups.push(G[x.facility]); }
    G[x.facility].items.push(x);
  });
  const stBadge = (s) => `<span class="badge st-${esc(s)}">${esc(t.st[s] || s)}</span>`;
  const card = (x) => {
    const lines = [];
    if (kind === "adv") {
      lines.push(`<div class="kv"><span>${esc(t.bhp)}</span><b>${ddY(x.bhp)}</b></div>`);
      lines.push(`<div class="kv"><span>${esc(t.req_at)}</span><b>${esc(ddhm(x.requested_at))}</b></div>`);
      lines.push(`<div class="kv"><span>${esc(t.hrs)}</span><b>${fmtH(x.hours_month)}</b><em>${esc(t.m_cur)}</em><b class="dim">${fmtH(x.hours_prev)}</b><em>${esc(t.m_prev)}</em></div>`);
    } else {
      lines.push(`<div class="kv"><span>${esc(t.days_l)}</span><b>${(x.days || []).map((d) => `${esc(t.wd[dow(d)])} ${dd(d)}`).join(", ") || "—"}</b><em>${esc(t.n_days((x.days || []).length))}</em></div>`);
      lines.push(`<div class="kv"><span>${esc(t.req_at)}</span><b>${esc(ddhm(x.requested_at))}</b></div>`);
      lines.push(`<div class="kv"><span>${esc(t.bhp)}</span><b>${ddY(x.bhp)}</b></div>`);
      if (x.load && x.load.length) {
        lines.push(`<div class="load">${x.load.map((l) => `<span class="${l.staff && l.off / l.staff >= 0.2 ? "warn" : ""}">${dd(l.day)}: ${esc(t.free(l.off, l.staff))}</span>`).join("")}</div>`);
      }
    }
    let foot = "";
    if (x.status === "pending") {
      foot = x.can_edit
        ? `<div class="acts"><button class="btn no" onclick="rejectReq('${kind}', ${x.id})">${esc(t.reject)}</button>
             <button class="btn yes" onclick="decide('${kind}', [${x.id}], 'approved')">${esc(t.approve)}</button></div>`
        : `<div class="ro">${esc(t.view_only)}</div>`;
    } else {
      foot = `<div class="dec">${esc(t.by(x.decided_by || "—", ddhm(x.decided_at)))}${x.status === "rejected" && x.note ? `<br>${esc(t.why)}: ${esc(x.note)}` : ""}${
        x.office_at ? `<br><span class="sent">✉ ${esc(t.off_sent(ddhm(x.office_at)))}</span>` : ""}</div>`;
    }
    return `<article class="rq ${x.status}" id="rq-${kind}-${x.id}">
        <div class="rq-h"><div class="nm"><b>${esc(x.full_name)}</b><span class="pass">${esc(x.login || "")}</span></div>${stBadge(x.status)}</div>
        <div class="rq-b">${lines.join("")}</div>${foot}</article>`;
  };
  const groupHtml = (g) => {
    const ok = g.items.filter((x) => x.status === "pending" && x.can_edit);
    return `<section class="grp">
      <div class="grp-h"><h2>${esc(g.name)} · ${g.items.length}</h2>
        ${ok.length >= 2 ? `<button class="mini" onclick="decideGroup('${kind}', ${JSON.stringify(ok.map((x) => x.id))}, '${esc(g.name).replace(/'/g, "")}')">${esc(t.all_ok(ok.length))}</button>` : ""}</div>
      ${g.items.map(card).join("")}</section>`;
  };
  $("view").innerHTML = `
    <div class="top"><div class="ttl"><h1>${esc(kind === "adv" ? t.adv_title : t.dof_title)}</h1>
      <div class="sub">${kind === "adv" ? esc(t.std(r.advance_std || 300)) + " · " : ""}${esc(t.sc[r.scope] || "")}</div></div>${langSeg()}</div>
    <div class="seg wide two" role="tablist">
      <button class="${kind === "adv" ? "on" : ""}" onclick="go('adv')">${esc(t.adv_title)}</button>
      <button class="${kind === "dof" ? "on" : ""}" onclick="go('dof')">${esc(t.dof_title)}</button>
    </div>
    ${scopeSeg(r.scope, r.scopes)}
    ${kind === "adv" ? `<button class="btn office ${r.office_unsent ? "" : "quiet"}" onclick="go('office')">✉ ${esc(t.off_btn(r.office_unsent || 0))}</button>` : ""}
    <div class="chips">
      <button class="chip ${ST.reqStatus === "pending" ? "on" : ""}" onclick="setReqStatus('pending')">${esc(t.f_pending(ST.reqStatus === "pending" ? pending : "…"))}</button>
      <button class="chip ${ST.reqStatus === "all" ? "on" : ""}" onclick="setReqStatus('all')">${esc(t.f_all)}</button>
    </div>
    ${groups.length ? groups.map(groupHtml).join("") : `<div class="list"><div class="empty">${esc(ST.reqStatus === "pending" ? t.none_p : t.none_a)}</div></div>`}`;
}
function rejectReq(kind, id) {
  const t = T();
  const x = (ST.req[kind] && ST.req[kind].items.find((i) => i.id === id)) || {};
  ST.reject = { kind, id };
  $("rsName").textContent = x.full_name || "";
  $("rsList").innerHTML = REASONS[kind].map((code) => `<button class="btn ghost" onclick="pickReason('${code}')">${esc(t.r[code])}</button>`).join("");
  showSheet("rsheet");
}
function pickReason(code) {
  const r = ST.reject;
  closeSheets();
  if (r) decide(r.kind, [r.id], "rejected", code === "none" ? null : code);
}
async function decideGroup(kind, ids, facName) {
  const t = T();
  if (!(await ask(t.all_q(ids.length, facName)))) return;
  decide(kind, ids, "approved");
}
async function decide(kind, ids, status, reason) {
  const t = T();
  ids.forEach((id) => { const el = $(`rq-${kind}-${id}`); if (el) el.classList.add("busy"); });
  const r = await api("/api/tg/decide", { method: "POST", body: { kind, ids, status, reason: reason || null } }).catch(() => null);
  ST.home = null;                                            // лічильники на головній — заново
  if (!r) { toast(t.e_net, true); return renderDec(kind); }
  const done = r.done || [];
  const failed = r.failed || [];
  if (done.length) toast(ids.length > 1 ? t.done_n(done.length) : status === "approved" ? t.done_ok : t.done_no);
  if (failed.length) toast(failed[0].error === "decided" ? t.already : t.no_right, true);
  await renderDec(kind);
}

// ── Листи в офіс: аванси (kind adv, #office) і замовлення медогляду (kind med, #med) ──────
// Таблиця в листі + Excel; адресати окремі для кожного виду (спільні від адміна + свої), минулі — вибрані одразу.
const offState = (kind) => (ST.off[kind] = ST.off[kind] || { data: null, sel: null, to: null });
function medRangeQuick(k) {
  const t0 = today();
  const mon = (iso) => addDays(iso, -((dow(iso) + 6) % 7));
  if (k === "today") return { from: t0, to: t0 };
  if (k === "tomorrow") { const d = addDays(t0, 1); return { from: d, to: d }; }
  if (k === "week") { const m = mon(t0); return { from: m, to: addDays(m, 6) }; }
  if (k === "next") { const m = addDays(mon(t0), 7); return { from: m, to: addDays(m, 6) }; }
  return ST.medRange;
}
async function renderOffice(kind, keepSel) {
  const o = offState(kind);
  if (!o.data) loading();
  let q = `/api/tg/office?kind=${kind}`;
  if (kind === "med") {
    if (!ST.medRange) ST.medRange = medRangeQuick("today");
    q += `&from=${ST.medRange.from}&to=${ST.medRange.to}`;
  }
  const r = await api(q);
  if (!r || !r.ok) { if (!o.data) showError("net"); else toast((r && T().off_err[r.error]) || (r && r.error) || T().e_net, true); return; }
  const prevSel = o.sel;
  o.data = r;
  const ids = r.items.filter((x) => !x.ordered_at).map((x) => x.id);
  o.sel = new Set(keepSel && prevSel ? ids.filter((id) => prevSel.has(id)) : ids);
  if (!o.to || !keepSel) {
    const known = new Set(r.recipients.map((x) => x.email.toLowerCase()));
    o.to = new Set((r.last || []).filter((e) => known.has(String(e).toLowerCase())).map((e) => String(e).toLowerCase()));
  }
  if (ST.view === (kind === "med" ? "med" : "office")) drawOffice(kind);
}
function drawOffice(kind) {
  const t = T();
  const o = offState(kind);
  const r = o.data;
  const med = kind === "med";
  const std = r.advance_std || 300;
  const free = r.items.filter((x) => !x.ordered_at);
  const n = free.filter((x) => o.sel.has(x.id)).length;
  const canSend = r.configured && n > 0 && o.to.size > 0;
  const rcpt = (x) => {
    const on = o.to.has(x.email.toLowerCase());
    const del = !x.shared || r.is_admin;
    return `<span class="chip rc ${on ? "on" : ""}">
        <button class="rc-b" onclick="toggleTo('${kind}', '${esc(x.email.toLowerCase())}')">${on ? "✓ " : ""}${esc(x.name ? `${x.name} · ${x.email}` : x.email)}${x.shared ? ` <em>${esc(t.off_tag)}</em>` : ""}</button>
        ${del ? `<button class="rc-x" aria-label="✕" onclick="delRcpt('${kind}', ${x.id}, '${esc(x.email)}')">✕</button>` : ""}</span>`;
  };
  const row = (x) => {
    const done = !!x.ordered_at;
    const line2 = med
      ? `${esc(x.facility)} · BHP ${esc(dd(x.bhp))}${done ? ` · <span class="sent">✉ ${esc(t.med_done(ddhm(x.ordered_at)))}</span>` : ""}`
      : `${esc(x.facility)} · ${esc(t.off_appr(ddhm(x.approved_at), fmtH(x.hours)))}`;
    const name = med ? `${x.last_name} ${x.first_name}`.trim() : x.full_name;
    return `<label class="ck ${done ? "done" : ""}">
        <input type="checkbox" ${done ? "disabled" : o.sel.has(x.id) ? "checked" : ""} onchange="offPick('${kind}', ${x.id}, this.checked)" />
        <div class="nm"><b>${esc(name)}</b><span class="pass">${esc(x.login || "")}</span><span>${line2}</span></div></label>`;
  };
  const rng = ST.medRange || {};
  const quick = (k, label) => {
    const q = medRangeQuick(k);
    return `<button class="chip ${q.from === rng.from && q.to === rng.to ? "on" : ""}" onclick="medQuick('${k}')">${esc(label)}</button>`;
  };
  $("view").innerHTML = `
    <div class="top"><div class="ttl"><h1>${esc(med ? t.med_title : t.off_title)}</h1>
      <div class="sub">${esc(med ? t.med_sub : t.off_sub(r.window_days || 31))}</div></div>${langSeg()}</div>
    ${r.configured ? "" : `<div class="note-ro">${esc(t.off_nocfg)}${r.mail && r.mail.reason && t.off_why[r.mail.reason] ? `<br>${esc(t.off_why[r.mail.reason])}` : ""}</div>`}
    ${scopeSeg(r.scope, r.scopes)}
    ${med ? `<section class="sec">
      <div class="chips">${quick("today", t.med_q.today)}${quick("tomorrow", t.med_q.tomorrow)}${quick("week", t.med_q.week)}${quick("next", t.med_q.next)}</div>
      <div class="daterow">
        <label><span>${esc(t.med_from)}</span><input type="date" value="${esc(rng.from)}" onchange="medDates(this.value, null)" /></label>
        <label><span>${esc(t.med_to)}</span><input type="date" value="${esc(rng.to)}" onchange="medDates(null, this.value)" /></label>
      </div></section>` : ""}
    <section class="sec">
      <div class="grp-h"><h2>${esc(med ? t.med_items(r.items.length) : t.off_items(r.items.length))}</h2>
        ${free.length ? `<button class="mini" onclick="offAll('${kind}', ${n < free.length})">${esc(n < free.length ? t.off_all : t.off_none)}</button>` : ""}</div>
      ${r.items.length ? `<div class="list">${r.items.map(row).join("")}</div>`
        : `<div class="list"><div class="empty">${esc(med ? t.med_empty : t.off_empty)}</div></div>`}
    </section>
    <section class="sec">
      <h2>${esc(med ? t.med_to_h : t.off_to)}</h2>
      <div class="rcpts">${r.recipients.map(rcpt).join("")}</div>
      <div class="addrow">
        <input id="offEmail" type="email" inputmode="email" autocomplete="email" placeholder="${esc(t.off_email_ph)}" onkeydown="if(event.key==='Enter')addRcpt('${kind}')" />
        <button class="btn ghost" onclick="addRcpt('${kind}')">${esc(t.off_add)}</button>
      </div>
      ${r.is_admin ? `<label class="shared"><input id="offShared" type="checkbox" /> ${esc(t.off_shared)}</label>` : ""}
      <div class="sub">${esc(r.my_email ? t.off_cc(r.my_email) : t.off_nocc)}${r.from ? `<br>${esc(t.off_from(r.from))}` : ""}${med ? `<br>${esc(t.med_date_note)}` : ""}</div>
    </section>
    <div class="sendbar">
      <div class="sum">${esc(med ? t.med_sum(n) : t.off_sum(n, n * std))}</div>
      <button id="offSend" class="btn primary wide" ${canSend ? "" : "disabled"} onclick="sendOffice('${kind}')">${esc(med ? t.med_send : t.off_send)}</button>
    </div>
    ${r.history && r.history.length ? `<section class="sec"><h2>${esc(t.off_hist)}</h2><div class="list">${r.history.map((h) => `<div class="row"><div class="nm">
        <b>${esc(ddhm(h.sent_at))} · ${esc(ppl(h.items))}${h.total ? ` · ${esc(String(h.total))} zł` : ""}</b>
        <span class="${h.status === "sent" ? "" : "warn"}">${esc((h.mail_to || []).join(", "))}${h.status === "sent" ? "" : ` · ${esc(t.off_st_err)}: ${esc(h.error || "")}`}</span></div></div>`).join("")}</div></section>` : ""}`;
}
const redraw = (kind) => drawOffice(kind);
function offPick(kind, id, on) { const o = offState(kind); if (on) o.sel.add(id); else o.sel.delete(id); redraw(kind); }
function offAll(kind, on) { const o = offState(kind); o.sel = new Set(on ? o.data.items.filter((x) => !x.ordered_at).map((x) => x.id) : []); redraw(kind); }
function toggleTo(kind, email) { const o = offState(kind); if (o.to.has(email)) o.to.delete(email); else o.to.add(email); redraw(kind); }
function medQuick(k) { ST.medRange = medRangeQuick(k); renderOffice("med", false); }
function medDates(from, to) {
  const r = Object.assign({}, ST.medRange);
  if (from) r.from = from;
  if (to) r.to = to;
  if (r.to < r.from) { if (from) r.to = r.from; else r.from = r.to; }
  ST.medRange = r;
  renderOffice("med", false);
}
async function addRcpt(kind) {
  const t = T();
  const o = offState(kind);
  const email = ($("offEmail").value || "").trim();
  if (!email) return;
  const shared = !!($("offShared") && $("offShared").checked);
  const r = await api("/api/tg/office/recipients", { method: "POST", body: { kind, email, shared } }).catch(() => null);
  if (!r || !r.ok) return toast((r && t.off_err[r.error]) || t.e_net, true);
  if (!o.data.recipients.some((x) => x.id === r.recipient.id)) o.data.recipients.push(r.recipient);
  o.to.add(r.recipient.email.toLowerCase());
  redraw(kind);
}
async function delRcpt(kind, id, email) {
  const t = T();
  const o = offState(kind);
  if (!(await ask(t.off_del_q(email)))) return;
  const r = await api(`/api/tg/office/recipients/${id}`, { method: "DELETE" }).catch(() => null);
  if (!r || !r.ok) return toast(t.e_net, true);
  o.data.recipients = o.data.recipients.filter((x) => x.id !== id);
  o.to.delete(String(email).toLowerCase());
  redraw(kind);
}
async function sendOffice(kind) {
  const t = T();
  const o = offState(kind);
  const ids = o.data.items.filter((x) => !x.ordered_at && o.sel.has(x.id)).map((x) => x.id);
  const to = o.data.recipients.filter((x) => o.to.has(x.email.toLowerCase())).map((x) => x.email);
  $("offSend").disabled = true;
  const r = await api("/api/tg/office/send", { method: "POST", body: { kind, ids, to } }).catch(() => null);
  if (kind === "adv") ST.req.adv = null;
  if (r && r.ok) {
    toast(kind === "med" ? t.med_ok(r.count) : t.off_ok(r.count));
    return renderOffice(kind, false);
  }
  const e = r && r.error;
  toast(`${t.off_err[e] || t.e_net}${r && r.detail ? `: ${r.detail}` : ""}`, true);
  return renderOffice(kind, e !== "changed");
}

// ── Заявки (розділи заповнимо пізніше) ─────────────────────────────────
function renderReq() {
  const t = T();
  const card = (title, desc, icon, go) => `<${go ? `button onclick="go('${go}')"` : "div"} class="req ${go ? "link" : ""}">
      <div class="ic">${icon}</div>
      <div class="b"><div class="t">${esc(title)}</div><div class="d">${esc(desc)}</div>${go ? "" : `<span class="soon">${esc(t.soon)}</span>`}</div>
      ${go ? CHEV : ""}
    </${go ? "button" : "div"}>`;
  $("view").innerHTML = `
    <div class="top"><div class="ttl"><h1>${esc(t.req_title)}</h1><div class="sub">${esc(t.req_sub)}</div></div>${langSeg()}</div>
    <section id="reqMed">${card(t.req_med, t.req_med_d, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/><rect x="3" y="3" width="18" height="18" rx="4"/></svg>`, "med")}</section>
    <section id="reqFine">${card(t.req_fine, t.req_fine_d, `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>`)}</section>`;
}

boot();
