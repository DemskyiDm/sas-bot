// bot/coord.js — Telegram для координаторів (українська / русский)
//
//  • привʼязка Telegram до акаунта панелі: одноразове посилання з панелі → /start link_<код> → «Це ви?»
//  • кнопка «Panel» у чаті з ботом (мініпанель public/tg/, вхід без пароля — api/tg.js)
//  • нові заявки на аванс і вихідні — координаторам обʼєкта з кнопками «Схвалити / Відхилити» (+ причина)
//  • після рішення (у боті чи в панелі) повідомлення в усіх координаторів показують результат
//  • ранкова зведення (COORD_DIGEST_TIME, 07:30): приїзди / останні дні, без годин, що чекає рішення
//  • план набору в неділю (з api/flow.js): таблиця на 3 тижні, «Підтвердити як є», відсутні цифри — кнопками
//  • пошук картки працівника: координатор пише прізвище (кирилицею теж) або ID працівника
//  • номер полісу студентів (bot/student_policy.js): з 10 числа о 10:00 запит, номер — відповіддю; /polis, кнопка в меню
//
//  .env (pm2 restart після зміни):
//    TG_WEBAPP_URL=https://sas-panel.duckdns.org/tg/   адреса мініпанелі (HTTPS); без неї кнопки «Panel» не буде
//    COORD_DIGEST_TIME=07:30    COORD_DIGEST_ENABLED=1    COORD_NOTIFY=1    ADVANCE_STD=300
//
//  Telegram — напряму через Bot API (fetch), без Telegraf: модуль викликають і webhook, і api/routes.js.
"use strict";

const crypto = require("crypto");
const db = require("../db");

const CFG = {
  webapp: String(process.env.TG_WEBAPP_URL || "").trim(),
  digestTime: String(process.env.COORD_DIGEST_TIME || "07:30").trim(),
  digestEnabled: String(process.env.COORD_DIGEST_ENABLED ?? "1").trim() !== "0",
  notify: String(process.env.COORD_NOTIFY ?? "1").trim() !== "0",
  advanceStd: Number(process.env.ADVANCE_STD || 300) || 300,
  linkTtlMin: 30,
  listMax: 10,
};

// ══════════════════════════════════════════════════════════════════════
//  Telegram Bot API
// ══════════════════════════════════════════════════════════════════════
let TG = async (method, params) => {
  const token = process.env.BOT_TOKEN;
  if (!token) return { ok: false, description: "no BOT_TOKEN" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const j = await r.json();
    if (!j.ok && !/message is not modified/i.test(j.description || "")) {
      console.error(`[coord] ${method} ${params.chat_id || ""}: ${j.description}`);
    }
    return j;
  } catch (e) {
    console.error(`[coord] ${method}:`, e.message);
    return { ok: false, description: e.message };
  }
};
const tg = (method, params) => TG(method, params);
const kbOf = (kb) => ({ inline_keyboard: (kb || []).filter((row) => row && row.length) });
async function send(chatId, text, kb) {
  const r = await tg("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(kb ? { reply_markup: kbOf(kb) } : {}),
  });
  return r && r.ok ? r.result.message_id : null;
}
const edit = (chatId, messageId, text, kb) => tg("editMessageText", {
  chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true,
  reply_markup: kbOf(kb),
});
const editKb = (chatId, messageId, kb) => tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: kbOf(kb) });
const answer = (id, text, alert) => tg("answerCallbackQuery", { callback_query_id: id, text: text || "", show_alert: !!alert });

let BOT_USERNAME = null;
async function botUsername() {
  if (BOT_USERNAME) return BOT_USERNAME;
  const r = await tg("getMe", {});
  if (r && r.ok) BOT_USERNAME = r.result.username;
  return BOT_USERNAME;
}

// ══════════════════════════════════════════════════════════════════════
//  Тексти: українська / русский
// ══════════════════════════════════════════════════════════════════════
const TX = {
  uk: {
    menu: (n) => `Бот координатора · <b>${n}</b>\n\nПанель відкривається кнопкою <b>Panel</b> внизу — без пароля.\nПошук працівника: напишіть прізвище (можна кирилицею) або ID.`,
    menu_nowebapp: "Мініпанель ще не налаштована (TG_WEBAPP_URL).",
    b_panel: "Відкрити панель", b_digest: "Зведення зараз", b_adv: (n) => `Аванси (${n})`, b_dof: (n) => `Вихідні (${n})`,
    b_gaps: (n) => `Без годин (${n})`, b_plan: "План набору", b_lang: "Мова → русский",
    b_digest_on: "Ранкова зведення: увімк.", b_digest_off: "Ранкова зведення: вимк.",
    b_docs_on: "📎 Документи на пошту: увімк.", b_docs_off: "📎 Документи на пошту: вимк.",
    docs_on: (e) => `Копії документів, які працівники ваших об'єктів надсилають із застосунку, надходитимуть на ${e}.`,
    docs_off: "Копії документів працівників більше не надходитимуть на пошту.",
    docs_noemail: "У панелі немає вашого e-mail — попросіть адміністратора додати його, тоді ввімкніть ще раз.",
    lang_set: "Мову змінено: українська.",
    link_ask: (name, facs) => `<b>Підтвердіть вхід у панель</b>\n${name}\n${facs}\n\nЦе ви?`,
    link_yes: "Так, привʼязати", link_no: "Ні, це не я",
    link_ok: "✅ <b>Акаунт привʼязано</b>\nПанель відкривається кнопкою <b>Panel</b> внизу — без логіна і пароля.\nСюди ж приходитимуть ранкова зведення, аванси і вихідні на рішення.",
    link_bad: "Посилання недійсне або застаріло. Створіть нове в панелі: кнопка «Telegram».",
    link_cancel: "Скасовано, акаунт не привʼязано.",
    facs: (n, list) => `${n} обʼєкт(и): ${list}`, no_facs: "обʼєктів немає",
    adv: "Аванс", std: (z) => `${z} zł (стандарт)`, hours_m: (m, h) => `Годин за ${m}: ${h}`,
    adv_m: (n, last) => (n ? `Авансів цього місяця: ${n} (останній ${last})` : "Авансів цього місяця не було"),
    req_at: (t) => `Заявка: ${t}`,
    approve: "✅ Схвалити", reject: "❌ Відхилити", back: "‹ Назад",
    r_hours: "Замало годин", r_had: "Вже був аванс", r_leaving: "Завершує роботу", r_none: "Без причини",
    r_staff: "Мало людей на зміні", r_late: "Пізно подано",
    reason_q: "Оберіть причину — працівник побачить її в боті:",
    ok_by: (who, t) => `✅ <b>Схвалено</b> · ${who} · ${t}`,
    no_by: (who, t, why) => `❌ <b>Відхилено</b> · ${who} · ${t}${why ? `\nПричина: ${why}` : ""}`,
    decided: "Вже вирішено", no_right: "Немає права редагування на цьому обʼєкті", gone: "Заявку не знайдено",
    dof: "Вихідні", days: (list, n) => `${list} · ${n} дн.`, load: (d, off, staff) => `${d}: вже вільні ${off} з ${staff}`,
    all: (n) => `✅ Схвалити всі ${n}`, all_q: (n) => `<b>Заявок на вихідні: ${n}</b>`,
    all_ok: (n) => `✅ Схвалено ${n}. Працівники отримали відповідь у боті, дні в табелі позначено URL.`,
    more: (n) => `… і ще ${n} — у панелі`,
    none_adv: "Авансів на рішення немає.", none_dof: "Заявок на вихідні немає.",
    dg_hello: (n, d) => `<b>Доброго ранку, ${n}</b> · ${d}`,
    dg_arr: (n) => `<b>Сьогодні приїжджають · ${n}</b>`, dg_dep: (n) => `<b>Сьогодні останній день · ${n}</b>`,
    dg_gaps: (n, d) => `Без годин ${d}+ дн.: <b>${n}</b>`, dg_wait: (a, d) => `Чекають рішення: <b>${a}</b> аванс. · <b>${d}</b> вихідн.`,
    dg_plan: (n, dl) => `План набору: не підтверджено ${n} обʼєкт(и) — до неділі ${dl}`, dg_quiet: "Сьогодні без подій.",
    transfer: "переведення",
    gaps_t: (n, d) => `<b>Без годин ${d}+ дн. · ${n}</b>`, gaps_tip: "Нагадування в боті працівникам ідуть щогодини 8–18.", gaps_none: "Усі години заповнені.",
    plan_t: "<b>План набору на 3 тижні</b>", plan_sub: (dl) => `Скільки людей треба набрати. Підтвердіть або змініть до неділі ${dl}.`,
    plan_leg: "* — пропозиція з попереднього тижня, «—» — не введено, ✓ — вже підтверджено.",
    plan_ok: "✅ Підтвердити як є", plan_edit: "✏️ Змінити в панелі", plan_site: "Обʼєкт",
    plan_done: (list) => `✅ Підтверджено: ${list}`, plan_ask: (s, w) => `<b>${s}</b>: на ${w} цифр немає. Скільки людей потрібно?`,
    plan_wk: (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} і ${a[a.length - 1]}` : a[0]), plan_skip: "Пропустити", plan_skipped: (list) => `Пропущено: ${list} — заповніть у панелі.`,
    plan_other: "Інше", plan_type: "Напишіть число від 0 до 999.", plan_all: "✅ План на 3 тижні підтверджено.",
    plan_nothing: "Усі ваші обʼєкти вже підтверджені.", plan_none: "За вами немає обʼєктів у плані набору.",
    s_short: "Напишіть щонайменше 3 літери прізвища або ID.",
    s_none: (q) => `За «${q}» нікого не знайдено на ваших обʼєктах.`, s_found: (n) => `Знайдено ${n} на ваших обʼєктах:`,
    st: { pracuje: "працює", zwolniony: "звільнений", rezygnacja: "відмовився", przeniesiony: "переведений", unknown: "без статусу", do_zatrudnienia: "у графіку (Do zatrudnienia)", urlop: "відпустка", l4: "L4" },
    since: (d) => `з ${d}`, c_pos: "Посада", c_hours: "Годин за місяць", c_last: "Останні години", c_adv: "Аванси цього місяця",
    c_bot: (b) => (b ? "Бот: підключений" : "Бот: не підключений"), c_hist: "Заклади",
    b_hours: "Години за місяць", b_hist: "Історія", b_open: "Відкрити в панелі", b_fine: "⚠️ Штраф",
    c_docs: (s, n) => `Документи HRappka: ${s === n ? "✅" : "❌"} підписано ${s} з ${n}`, c_docs_none: "Документи HRappka: не знайдено", c_docs_wait: "не підписані",
    c_student: (st, d) => `Студент: ${{ active: `✅ довідка до ${d}`, expiring: `⚠️ довідка до ${d}`, expired: `❌ довідка закінчилась ${d}`, unknown: "так, без дати довідки" }[st]}`,
    c_pol: (n, m) => `Поліс (${m}): <code>${n}</code>`, c_pol_none: "Поліс: так, номер ще не внесено", c_pol_no: "Поліс: відмовився",
    pol_ask: (m) => `🎓 <b>Номер полісу студентів на ${m}</b>\nНадішліть номер відповіддю на це повідомлення.`,
    pol_cur: (m, n) => `Зараз: ${m} — <code>${n}</code>`, pol_bad: "Це не схоже на номер полісу (латиниця і цифри, 3–40 знаків). Надішліть ще раз відповіддю.",
    pol_saved: (m, n, k) => `✅ Поліс на ${m}: <code>${n}</code>\nПобачать студенти, які погодились на страхування: ${k}.`,
    b_pol_edit: "✏️ Змінити", pol_ph: "Номер полісу", b_pol: "🎓 Поліс студентів",
    h_title: (n, m) => `<b>${n}</b> · години за ${m}`, h_none: "Цього місяця записів немає.", total: "Разом",
    hist_t: (n) => `<b>${n}</b> · історія закладів`, now: "досі",
  },
  ru: {
    menu: (n) => `Бот координатора · <b>${n}</b>\n\nПанель открывается кнопкой <b>Panel</b> внизу — без пароля.\nПоиск работника: напишите фамилию (можно кириллицей) или ID.`,
    menu_nowebapp: "Мини-панель ещё не настроена (TG_WEBAPP_URL).",
    b_panel: "Открыть панель", b_digest: "Сводка сейчас", b_adv: (n) => `Авансы (${n})`, b_dof: (n) => `Выходные (${n})`,
    b_gaps: (n) => `Без часов (${n})`, b_plan: "План набора", b_lang: "Мова → українська",
    b_digest_on: "Утренняя сводка: вкл.", b_digest_off: "Утренняя сводка: выкл.",
    b_docs_on: "📎 Документы на почту: вкл.", b_docs_off: "📎 Документы на почту: выкл.",
    docs_on: (e) => `Копии документов, которые работники ваших объектов отправляют из приложения, будут приходить на ${e}.`,
    docs_off: "Копии документов работников больше не будут приходить на почту.",
    docs_noemail: "В панели нет вашего e-mail — попросите администратора добавить его, потом включите ещё раз.",
    lang_set: "Язык изменён: русский.",
    link_ask: (name, facs) => `<b>Подтвердите вход в панель</b>\n${name}\n${facs}\n\nЭто вы?`,
    link_yes: "Да, привязать", link_no: "Нет, это не я",
    link_ok: "✅ <b>Аккаунт привязан</b>\nПанель открывается кнопкой <b>Panel</b> внизу — без логина и пароля.\nСюда же будут приходить утренняя сводка, авансы и выходные на решение.",
    link_bad: "Ссылка недействительна или устарела. Создайте новую в панели: кнопка «Telegram».",
    link_cancel: "Отменено, аккаунт не привязан.",
    facs: (n, list) => `${n} объект(а): ${list}`, no_facs: "объектов нет",
    adv: "Аванс", std: (z) => `${z} zł (стандарт)`, hours_m: (m, h) => `Часов за ${m}: ${h}`,
    adv_m: (n, last) => (n ? `Авансов в этом месяце: ${n} (последний ${last})` : "Авансов в этом месяце не было"),
    req_at: (t) => `Заявка: ${t}`,
    approve: "✅ Одобрить", reject: "❌ Отклонить", back: "‹ Назад",
    r_hours: "Мало часов", r_had: "Уже был аванс", r_leaving: "Заканчивает работу", r_none: "Без причины",
    r_staff: "Мало людей на смене", r_late: "Поздно подано",
    reason_q: "Выберите причину — работник увидит её в боте:",
    ok_by: (who, t) => `✅ <b>Одобрено</b> · ${who} · ${t}`,
    no_by: (who, t, why) => `❌ <b>Отклонено</b> · ${who} · ${t}${why ? `\nПричина: ${why}` : ""}`,
    decided: "Уже решено", no_right: "Нет права редактирования на этом объекте", gone: "Заявка не найдена",
    dof: "Выходные", days: (list, n) => `${list} · ${n} дн.`, load: (d, off, staff) => `${d}: уже свободны ${off} из ${staff}`,
    all: (n) => `✅ Одобрить все ${n}`, all_q: (n) => `<b>Заявок на выходные: ${n}</b>`,
    all_ok: (n) => `✅ Одобрено ${n}. Работники получили ответ в боте, дни в табеле отмечены URL.`,
    more: (n) => `… и ещё ${n} — в панели`,
    none_adv: "Авансов на решение нет.", none_dof: "Заявок на выходные нет.",
    dg_hello: (n, d) => `<b>Доброе утро, ${n}</b> · ${d}`,
    dg_arr: (n) => `<b>Сегодня приезжают · ${n}</b>`, dg_dep: (n) => `<b>Сегодня последний день · ${n}</b>`,
    dg_gaps: (n, d) => `Без часов ${d}+ дн.: <b>${n}</b>`, dg_wait: (a, d) => `Ждут решения: <b>${a}</b> аванс. · <b>${d}</b> выходн.`,
    dg_plan: (n, dl) => `План набора: не подтверждено ${n} объект(а) — до воскресенья ${dl}`, dg_quiet: "Сегодня без событий.",
    transfer: "перевод",
    gaps_t: (n, d) => `<b>Без часов ${d}+ дн. · ${n}</b>`, gaps_tip: "Напоминания в боте работникам идут каждый час 8–18.", gaps_none: "Все часы заполнены.",
    plan_t: "<b>План набора на 3 недели</b>", plan_sub: (dl) => `Сколько людей нужно набрать. Подтвердите или измените до воскресенья ${dl}.`,
    plan_leg: "* — предложение с прошлой недели, «—» — не введено, ✓ — уже подтверждено.",
    plan_ok: "✅ Подтвердить как есть", plan_edit: "✏️ Изменить в панели", plan_site: "Объект",
    plan_done: (list) => `✅ Подтверждено: ${list}`, plan_ask: (s, w) => `<b>${s}</b>: на ${w} цифр нет. Сколько людей нужно?`,
    plan_wk: (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} и ${a[a.length - 1]}` : a[0]), plan_skip: "Пропустить", plan_skipped: (list) => `Пропущено: ${list} — заполните в панели.`,
    plan_other: "Другое", plan_type: "Напишите число от 0 до 999.", plan_all: "✅ План на 3 недели подтверждён.",
    plan_nothing: "Все ваши объекты уже подтверждены.", plan_none: "За вами нет объектов в плане набора.",
    s_short: "Напишите минимум 3 буквы фамилии или ID.",
    s_none: (q) => `По «${q}» никого не найдено на ваших объектах.`, s_found: (n) => `Найдено ${n} на ваших объектах:`,
    st: { pracuje: "работает", zwolniony: "уволен", rezygnacja: "отказался", przeniesiony: "переведён", unknown: "без статуса", do_zatrudnienia: "в графике (Do zatrudnienia)", urlop: "отпуск", l4: "L4" },
    since: (d) => `с ${d}`, c_pos: "Должность", c_hours: "Часов за месяц", c_last: "Последние часы", c_adv: "Авансы в этом месяце",
    c_bot: (b) => (b ? "Бот: подключён" : "Бот: не подключён"), c_hist: "Объекты",
    b_hours: "Часы за месяц", b_hist: "История", b_open: "Открыть в панели", b_fine: "⚠️ Штраф",
    c_docs: (s, n) => `Документы HRappka: ${s === n ? "✅" : "❌"} подписано ${s} из ${n}`, c_docs_none: "Документы HRappka: не найдены", c_docs_wait: "не подписаны",
    c_student: (st, d) => `Студент: ${{ active: `✅ справка до ${d}`, expiring: `⚠️ справка до ${d}`, expired: `❌ справка закончилась ${d}`, unknown: "да, без даты справки" }[st]}`,
    c_pol: (n, m) => `Полис (${m}): <code>${n}</code>`, c_pol_none: "Полис: да, номер ещё не внесён", c_pol_no: "Полис: отказался",
    pol_ask: (m) => `🎓 <b>Номер полиса студентов на ${m}</b>\nОтправьте номер ответом на это сообщение.`,
    pol_cur: (m, n) => `Сейчас: ${m} — <code>${n}</code>`, pol_bad: "Это не похоже на номер полиса (латиница и цифры, 3–40 знаков). Отправьте ещё раз ответом.",
    pol_saved: (m, n, k) => `✅ Полис на ${m}: <code>${n}</code>\nУвидят студенты, согласившиеся на страховку: ${k}.`,
    b_pol_edit: "✏️ Изменить", pol_ph: "Номер полиса", b_pol: "🎓 Полис студентов",
    h_title: (n, m) => `<b>${n}</b> · часы за ${m}`, h_none: "В этом месяце записей нет.", total: "Итого",
    hist_t: (n) => `<b>${n}</b> · история объектов`, now: "по сей день",
  },
};
const REASONS = { adv: ["hours", "had", "leaving", "none"], dof: ["staff", "late", "none"] };
const reasonLabel = (t, code) => t["r_" + code] || code;

// ══════════════════════════════════════════════════════════════════════
//  Допоміжне
// ══════════════════════════════════════════════════════════════════════
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const WAW = "Europe/Warsaw";
const isoDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: WAW }).format(d || new Date());
const todayISO = () => isoDay(new Date());
// «Сьогодні» як у Wyjazdy (flow.today(): у тестовій базі можна підмінити дату)
async function flowToday() {
  try { return (await require("../api/flow").planApi.clock()).today; } catch (e) { return todayISO(); }
}
const toISO = (v) => (v instanceof Date ? isoDay(v) : String(v || "").substring(0, 10));
const dd = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const hmNow = (d) => new Intl.DateTimeFormat("pl-PL", { timeZone: WAW, hour: "2-digit", minute: "2-digit" }).format(d || new Date());
const ddhm = (d) => (d ? `${dd(isoDay(new Date(d)))} ${hmNow(new Date(d))}` : "");
const hmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const monthName = (lang, d) => new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "uk-UA", { timeZone: WAW, month: "long" }).format(d || new Date());
const polMonth = (c, ym) => `${monthName(langOf(c), new Date(ym + "-15T12:00:00Z"))} ${ym.slice(0, 4)}`;
const weekdayDate = (lang, iso) => {
  const d = new Date(iso + "T12:00:00Z");
  const wd = new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "uk-UA", { weekday: "short", timeZone: "UTC" }).format(d);
  return `${wd} ${dd(iso)}`;
};
const firstName = (full) => {
  const p = String(full || "").trim().split(/\s+/);
  return p.length > 1 ? p[0] : p[0] || "";
};
const maskLogin = (l) => { const s = String(l || ""); return s.length >= 6 ? `${s.slice(0, 2)}••••${s.slice(-2)}` : "••••"; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

function langOf(c) {
  if (!c) return "uk";
  if (c.pref_lang === "ru" || c.pref_lang === "uk") return c.pref_lang;
  return String(c.lang || "").toLowerCase() === "ru" ? "ru" : "uk";
}
const T = (c) => TX[langOf(c)];

function webAppBtn(text, hash) {
  if (!CFG.webapp) return null;
  return { text, web_app: { url: CFG.webapp + (hash || "") } };
}

// ── Координатор ──────────────────────────────────────────────────────
const COORD_SQL = `
  SELECT c.id, c.full_name, c.role, c.telegram_chat_id, to_jsonb(c)->>'lang' AS lang, COALESCE(c.is_active, true) AS is_active, c.email,
         COALESCE(ca.is_admin, false) AS is_admin, ca.username,
         p.lang AS pref_lang, COALESCE(p.digest, true) AS digest, COALESCE(p.notify, true) AS notify, p.scope,
         COALESCE(to_jsonb(p)->>'docs_mail', 'false')::boolean AS docs_mail
    FROM public.coordinators c
    LEFT JOIN LATERAL (SELECT is_admin, username FROM public.coordinator_auth WHERE coordinator_id = c.id
                        ORDER BY is_admin DESC LIMIT 1) ca ON true
    LEFT JOIN tgc.prefs p ON p.coordinator_id = c.id`;
async function coordByChat(chatId) {
  const r = await db.query(`${COORD_SQL} WHERE c.telegram_chat_id = $1 AND COALESCE(c.is_active, true) LIMIT 1`, [chatId]);
  return r.rows[0] || null;
}
async function coordById(id) {
  const r = await db.query(`${COORD_SQL} WHERE c.id = $1`, [id]);
  return r.rows[0] || null;
}
// Сесія для спільних функцій api/routes.js (decideAdvance / decideDayOff)
const sessionOf = (c) => ({ coordinator_id: c.id, full_name: c.full_name, role: c.role, is_admin: !!c.is_admin });

// Обʼєкти координатора в межах обраного зрізу:
//   own    — свої (головний / помічник з Region → Przypisania);
//   region — свої + обʼєкти регіонів, де він регіональний (лише перегляд, як у панелі);
//   all    — уся фірма (адмін / керівник);
//   wide   — найширший доступний (пошук працівника).
// all — id обʼєктів (null = уся фірма), edit — де може вирішувати заявки (null = будь-де, адмін).
let HAS_V_ACCESS = null;
async function hasVAccess() {
  if (HAS_V_ACCESS === null) {
    try { HAS_V_ACCESS = !!(await db.query(`SELECT to_regclass('reg.v_access') AS t`)).rows[0].t; } catch (e) { HAS_V_ACCESS = false; }
  }
  return HAS_V_ACCESS;
}
async function facsOf(c, want) {
  const va = await hasVAccess();
  const r = await db.query(
    `SELECT cf.facility_id, bool_or(cf.is_primary) AS can_edit, f.name, f.group_name,
            ${va ? `(SELECT v.kinds FROM reg.v_access v WHERE v.coordinator_id = $1 AND v.facility_id = cf.facility_id)` : "NULL::text[]"} AS kinds
       FROM coordinator_facilities cf JOIN facilities f ON f.id = cf.facility_id
      WHERE cf.coordinator_id = $1 GROUP BY cf.facility_id, f.name, f.group_name ORDER BY f.name`,
    [c.id],
  );
  const isOwn = (x) => (x.kinds && x.kinds.length ? x.kinds.some((k) => k === "main" || k === "helper") : x.can_edit);
  const own = r.rows.filter(isOwn);
  const avail = [];
  if (own.length) avail.push("own");
  if (r.rows.length > own.length) avail.push("region");
  if (c.is_admin || c.role === "head") avail.push("all");
  if (!avail.length) avail.push("own");
  let scope = want === "wide" ? avail[avail.length - 1] : want || c.scope;
  if (!avail.includes(scope)) scope = avail[0];
  const pick = scope === "own" ? own : r.rows;
  const editIds = r.rows.filter((x) => x.can_edit || c.is_admin).map((x) => x.facility_id);
  if (scope === "all") {
    return { scope, avail, all: null, edit: c.is_admin ? null : editIds, names: [], rows: r.rows, company: true };
  }
  const ids = pick.map((x) => x.facility_id);
  return {
    scope, avail,
    all: ids,
    edit: editIds.filter((id) => ids.includes(id)),
    names: [...new Set(pick.map((x) => x.group_name || x.name))],
    rows: pick,
    company: false,
  };
}

// ── Стан діалогу ──────────────────────────────────────────────────────
async function getState(chatId) {
  const r = await db.query(`SELECT data FROM tgc.state WHERE chat_id = $1`, [chatId]);
  return r.rows[0] ? r.rows[0].data || {} : {};
}
async function setState(chatId, data) {
  await db.query(
    `INSERT INTO tgc.state (chat_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (chat_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [chatId, JSON.stringify(data || {})],
  );
}
async function claim(job, key) {
  const r = await db.query(`INSERT INTO tgc.job_runs (job, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job`, [job, key]);
  return r.rowCount > 0;
}

// ══════════════════════════════════════════════════════════════════════
//  Привʼязка і кнопка «Panel»
// ══════════════════════════════════════════════════════════════════════
async function createLinkCode(coordinatorId) {
  const code = crypto.randomBytes(9).toString("base64url");
  await db.query(`INSERT INTO tgc.link_codes (code, coordinator_id) VALUES ($1, $2)`, [code, coordinatorId]);
  const u = await botUsername();
  return { code, link: u ? `https://t.me/${u}?start=link_${code}` : null, ttl_min: CFG.linkTtlMin };
}
async function validCode(code) {
  const r = await db.query(
    `SELECT l.code, l.coordinator_id FROM tgc.link_codes l
      WHERE l.code = $1 AND l.used_at IS NULL AND l.created_at > now() - ($2 || ' minutes')::interval`,
    [code, String(CFG.linkTtlMin)],
  );
  return r.rows[0] || null;
}
async function setMenuButton(chatId) {
  if (!CFG.webapp) return false;
  const r = await tg("setChatMenuButton", {
    chat_id: chatId,
    menu_button: { type: "web_app", text: "Panel", web_app: { url: CFG.webapp } },
  });
  return !!(r && r.ok);
}
async function clearMenuButton(chatId) {
  return tg("setChatMenuButton", { chat_id: chatId, menu_button: { type: "default" } });
}
async function syncMenuButtons() {
  if (!CFG.webapp) return 0;
  const r = await db.query(`SELECT telegram_chat_id FROM public.coordinators
                             WHERE telegram_chat_id IS NOT NULL AND COALESCE(is_active, true)`);
  let n = 0;
  for (const x of r.rows) {
    if (await setMenuButton(x.telegram_chat_id)) n++;
    await new Promise((res) => setTimeout(res, 120));
  }
  console.log(`[coord] menu button «Panel»: ${n}/${r.rows.length}`);
  return n;
}
async function onLinkStart(msg, code) {
  const chatId = msg.chat.id;
  const lang = /^ru/i.test(msg.from && msg.from.language_code) ? "ru" : "uk";
  const t = TX[lang];
  const l = await validCode(code);
  if (!l) return send(chatId, t.link_bad);
  const c = await coordById(l.coordinator_id);
  if (!c || !c.is_active) return send(chatId, t.link_bad);
  const f = await facsOf(c, "own");
  const facs = f.company ? "" : f.names.length ? t.facs(f.names.length, esc(f.names.join(", "))) : t.no_facs;
  return send(chatId, t.link_ask(esc(c.full_name), facs), [[
    { text: t.link_yes, callback_data: `KC:lk:y:${code}` },
    { text: t.link_no, callback_data: `KC:lk:n:${code}` },
  ]]);
}
async function onLinkAnswer(cq, code, yes) {
  const chatId = cq.message.chat.id;
  const lang = /^ru/i.test(cq.from && cq.from.language_code) ? "ru" : "uk";
  const t = TX[lang];
  if (!yes) {
    await db.query(`UPDATE tgc.link_codes SET used_at = now(), chat_id = $2 WHERE code = $1 AND used_at IS NULL`, [code, chatId]);
    await answer(cq.id);
    return edit(chatId, cq.message.message_id, t.link_cancel);
  }
  const l = await validCode(code);
  if (!l) { await answer(cq.id); return edit(chatId, cq.message.message_id, t.link_bad); }
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE tgc.link_codes SET used_at = now(), chat_id = $2 WHERE code = $1`, [code, chatId]);
    // один чат — один координатор
    await client.query(`UPDATE public.coordinators SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 AND id <> $2`, [chatId, l.coordinator_id]);
    await client.query(`UPDATE public.coordinators SET telegram_chat_id = $1 WHERE id = $2`, [chatId, l.coordinator_id]);
    await client.query(
      `INSERT INTO tgc.prefs (coordinator_id, lang) VALUES ($1, $2)
       ON CONFLICT (coordinator_id) DO UPDATE SET updated_at = now()`, [l.coordinator_id, lang]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await answer(cq.id, "OK");
  await setMenuButton(chatId);
  await edit(chatId, cq.message.message_id, t.link_ok, [[webAppBtn(t.b_panel)].filter(Boolean)]);
  console.log(`[coord] Telegram linked: coordinator ${l.coordinator_id} → chat ${chatId}`);
}

// ══════════════════════════════════════════════════════════════════════
//  Меню
// ══════════════════════════════════════════════════════════════════════
async function pendingCounts(c, f0) {
  const f = f0 || (await facsOf(c));
  const r = await db.query(
    `SELECT (SELECT count(*) FROM advances a JOIN v_worker_current vw ON vw.id = a.worker_id
              WHERE a.status = 'pending' AND ($1::int[] IS NULL OR vw.facility_id = ANY($1)))::int AS adv,
            (SELECT count(*) FROM day_off_requests d JOIN v_worker_current vw ON vw.id = d.worker_id
              WHERE d.status = 'pending' AND ($1::int[] IS NULL OR vw.facility_id = ANY($1)))::int AS dof`,
    [f.edit],
  );
  return r.rows[0];
}
async function sendMenu(c) {
  const t = T(c);
  const p = await pendingCounts(c);
  const kb = [
    [webAppBtn(t.b_panel)].filter(Boolean),
    [{ text: t.b_adv(p.adv), callback_data: "KC:ls:adv" }, { text: t.b_dof(p.dof), callback_data: "KC:ls:dof" }],
    [{ text: t.b_digest, callback_data: "KC:dg" }, { text: t.b_plan, callback_data: "KC:pl:show" }],
    [{ text: c.digest ? t.b_digest_on : t.b_digest_off, callback_data: "KC:dgt" }, { text: t.b_lang, callback_data: "KC:lang" }],
    // копія документів працівників своїх об'єктів на пошту (api/wapp.js → mailOffice)
    [{ text: c.docs_mail ? t.b_docs_on : t.b_docs_off, callback_data: "KC:dmt" }],
    // номер полісу студентів — лише тому, хто його вносить (STUDENT_POLICY_COORD)
    require("./student_policy").isEditor(c.id) ? [{ text: t.b_pol, callback_data: "KC:po:e" }] : [],
  ];
  return send(c.telegram_chat_id, t.menu(esc(c.full_name)) + (CFG.webapp ? "" : `\n\n${t.menu_nowebapp}`), kb);
}

// ══════════════════════════════════════════════════════════════════════
//  Заявки: аванс (adv) і вихідні (dof)
// ══════════════════════════════════════════════════════════════════════
async function loadAdv(id) {
  const r = await db.query(
    `SELECT a.id, a.status, a.requested_at, a.worker_id, a.note, a.approved_at AS decided_at,
            w.full_name, vw.facility_id, f.name AS facility, dc.full_name AS decided_by,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = a.worker_id
                       AND date_trunc('month', h.work_date) = date_trunc('month', CURRENT_DATE)), 0) AS hours_month,
            (SELECT count(*) FROM advances x WHERE x.worker_id = a.worker_id AND x.id <> a.id AND x.status = 'approved'
               AND date_trunc('month', COALESCE(x.approved_at, x.requested_at)) = date_trunc('month', CURRENT_DATE))::int AS adv_month,
            (SELECT max(COALESCE(x.approved_at, x.requested_at)) FROM advances x WHERE x.worker_id = a.worker_id AND x.id <> a.id
               AND x.status = 'approved') AS adv_last
       FROM advances a
       JOIN workers w ON w.id = a.worker_id
       LEFT JOIN v_worker_current vw ON vw.id = a.worker_id
       LEFT JOIN facilities f ON f.id = vw.facility_id
       LEFT JOIN public.coordinators dc ON dc.id = a.approved_by
      WHERE a.id = $1`,
    [id],
  );
  return r.rows[0] || null;
}
async function loadDof(id) {
  const r = await db.query(
    `SELECT d.id, d.status, d.requested_at, d.worker_id, d.days, d.note, d.reviewed_at AS decided_at,
            w.full_name, vw.facility_id, f.name AS facility, dc.full_name AS decided_by
       FROM day_off_requests d
       JOIN workers w ON w.id = d.worker_id
       LEFT JOIN v_worker_current vw ON vw.id = d.worker_id
       LEFT JOIN facilities f ON f.id = vw.facility_id
       LEFT JOIN public.coordinators dc ON dc.id = d.reviewed_by
      WHERE d.id = $1`,
    [id],
  );
  const x = r.rows[0];
  if (!x) return null;
  x.dayList = [...new Set((Array.isArray(x.days) ? x.days : []).map(toISO))].filter(Boolean).sort();
  // скільки людей обʼєкта вже вільні (URL у табелі, у т.ч. схвалені вихідні) з усіх, хто працює того дня
  if (x.facility_id && x.dayList.length) {
    x.load = await dayLoad(x.facility_id, x.dayList, x.worker_id);
  } else x.load = [];
  return x;
}
// Скільки людей обʼєкта вже вільні (URL у табелі, у т.ч. схвалені вихідні) з усіх, хто працює того дня
async function dayLoad(facilityId, days, exceptWorker) {
  const l = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day,
            (SELECT count(DISTINCT h.worker_id) FROM worker_facility_history h
              WHERE h.facility_id = $1 AND h.status::text <> 'rezygnacja'
                AND h.bhp_date <= d AND (h.last_work_date IS NULL OR h.last_work_date >= d))::int AS staff,
            (SELECT count(DISTINCT hl.worker_id) FROM hours_log hl
               JOIN worker_facility_history h ON h.worker_id = hl.worker_id AND h.facility_id = $1
                AND h.bhp_date <= hl.work_date AND (h.last_work_date IS NULL OR h.last_work_date >= hl.work_date)
              WHERE hl.work_date = d AND hl.absence_type = 'URL' AND hl.worker_id <> $3)::int AS off
       FROM unnest($2::date[]) AS t(d)`,
    [facilityId, days, exceptWorker || 0],
  );
  return l.rows;
}

// Список заявок для мініпанелі (Аванси / Вихідні): у межах обраного зрізу, згруповано на клієнті по обʼєктах.
// status: pending — чекають рішення; all — чекають + вирішені за 30 днів.
async function listRequests(c, kind, status) {
  const f = await facsOf(c);
  const adv = kind === "adv";
  const r = await db.query(
    `SELECT x.id, x.status::text AS status, x.worker_id, x.requested_at, x.note,
            ${adv ? "x.approved_at" : "x.reviewed_at"} AS decided_at, dc.full_name AS decided_by,
            ${adv ? "NULL::date[]" : "x.days"} AS days,
            ${adv ? `(SELECT max(m.sent_at) FROM tgc.office_items i JOIN tgc.office_mails m ON m.id = i.mail_id AND m.status = 'sent'
                       WHERE i.kind = 'adv' AND i.ref_id = x.id)` : "NULL::timestamptz"} AS office_at,
            w.full_name, w.login, vw.facility_id, fa.name AS facility, fa.group_name,
            to_char(vw.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(vw.last_work_date, 'YYYY-MM-DD') AS lwd, vw.status::text AS wstatus,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = x.worker_id
                       AND date_trunc('month', h.work_date) = date_trunc('month', CURRENT_DATE)), 0) AS hours_month,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = x.worker_id
                       AND date_trunc('month', h.work_date) = date_trunc('month', CURRENT_DATE) - interval '1 month'), 0) AS hours_prev
       FROM ${adv ? "advances" : "day_off_requests"} x
       JOIN workers w ON w.id = x.worker_id
       JOIN v_worker_current vw ON vw.id = x.worker_id
       LEFT JOIN facilities fa ON fa.id = vw.facility_id
       LEFT JOIN public.coordinators dc ON dc.id = ${adv ? "x.approved_by" : "x.reviewed_by"}
      WHERE ($1::int[] IS NULL OR vw.facility_id = ANY($1))
        AND ${status === "all" ? "(x.status = 'pending' OR COALESCE(x.requested_at, now()) > now() - interval '30 days')" : "x.status = 'pending'"}
      ORDER BY fa.name NULLS LAST, (x.status = 'pending') DESC, x.requested_at DESC
      LIMIT 400`,
    [f.all],
  );
  const items = [];
  for (const x of r.rows) {
    const it = {
      id: x.id, status: x.status, worker_id: x.worker_id, full_name: x.full_name, login: x.login,
      facility_id: x.facility_id, facility: x.facility || "—", group: x.group_name || x.facility || "—",
      bhp: x.bhp, lwd: x.lwd, wstatus: x.wstatus,
      requested_at: x.requested_at, decided_at: x.decided_at, decided_by: x.decided_by, note: x.note,
      hours_month: num(x.hours_month), hours_prev: num(x.hours_prev),
      can_edit: f.edit === null || f.edit.includes(x.facility_id),
      office_at: x.office_at,
    };
    if (!adv) {
      it.days = [...new Set((Array.isArray(x.days) ? x.days : []).map(toISO))].filter(Boolean).sort();
      if (x.status === "pending" && x.facility_id && it.days.length) it.load = await dayLoad(x.facility_id, it.days, x.worker_id);
    }
    items.push(it);
  }
  const office = adv ? await require("./office").unsentCount(c, f) : 0;
  return { scope: f.scope, scopes: f.avail, advance_std: CFG.advanceStd, office_unsent: office, items };
}
const loadReq = (kind, id) => (kind === "adv" ? loadAdv(id) : loadDof(id));

function renderReq(kind, x, t, lang) {
  const L = [];
  if (kind === "adv") {
    L.push(`<b>${t.adv}</b> · ${esc(x.facility || "—")}`);
    L.push(`<b>${esc(x.full_name)}</b> — ${t.std(CFG.advanceStd)}`);
    L.push(t.hours_m(monthName(lang), num(x.hours_month)));
    L.push(t.adv_m(x.adv_month, x.adv_last ? dd(isoDay(new Date(x.adv_last))) : ""));
    L.push(t.req_at(ddhm(x.requested_at)));
  } else {
    L.push(`<b>${t.dof}</b> · ${esc(x.facility || "—")}`);
    L.push(`<b>${esc(x.full_name)}</b>`);
    L.push(t.days(x.dayList.map((d) => weekdayDate(lang, d)).join(", "), x.dayList.length));
    for (const l of (x.load || []).slice(0, 7)) L.push(t.load(dd(l.day), l.off, l.staff));
    if (x.requested_at) L.push(t.req_at(ddhm(x.requested_at)));
  }
  if (x.status === "approved") L.push("", t.ok_by(esc(x.decided_by || "—"), ddhm(x.decided_at)));
  else if (x.status === "rejected") L.push("", t.no_by(esc(x.decided_by || "—"), ddhm(x.decided_at), esc(x.note || "")));
  return L.join("\n");
}
const pendingKb = (kind, id, t) => {
  const k = kind === "adv" ? "a" : "d";
  return [[{ text: t.approve, callback_data: `KC:${k}:ok:${id}` }, { text: t.reject, callback_data: `KC:${k}:no:${id}` }]];
};
const reasonsKb = (kind, id, t) => {
  const k = kind === "adv" ? "a" : "d";
  const rows = [];
  const list = REASONS[kind];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(list.slice(i, i + 2).map((code) => ({ text: reasonLabel(t, code), callback_data: `KC:${k}:r:${id}:${code}` })));
  }
  rows.push([{ text: t.back, callback_data: `KC:${k}:bk:${id}` }]);
  return rows;
};

// Нова заявка → координаторам обʼєкта з правом рішення
async function notifyNew(kind, id) {
  if (!CFG.notify) return 0;
  const x = await loadReq(kind, id);
  if (!x || x.status !== "pending" || !x.facility_id) return 0;
  const cs = await db.query(
    `${COORD_SQL}
      WHERE c.telegram_chat_id IS NOT NULL AND COALESCE(c.is_active, true) AND COALESCE(p.notify, true)
        AND EXISTS (SELECT 1 FROM coordinator_facilities cf
                     WHERE cf.coordinator_id = c.id AND cf.facility_id = $1 AND cf.is_primary)`,
    [x.facility_id],
  );
  let n = 0;
  for (const c of cs.rows) {
    const t = T(c);
    const mid = await send(c.telegram_chat_id, renderReq(kind, x, t, langOf(c)), pendingKb(kind, id, t));
    if (mid) {
      n++;
      await db.query(`INSERT INTO tgc.msgs (kind, ref_id, chat_id, message_id) VALUES ($1, $2, $3, $4)`, [kind, id, c.telegram_chat_id, mid]);
    }
  }
  return n;
}
// Відправити заявку окремим повідомленням (зі списку «Аванси / Вихідні»)
async function sendReq(c, kind, x) {
  const t = T(c);
  const mid = await send(c.telegram_chat_id, renderReq(kind, x, t, langOf(c)), x.status === "pending" ? pendingKb(kind, x.id, t) : null);
  if (mid) await db.query(`INSERT INTO tgc.msgs (kind, ref_id, chat_id, message_id) VALUES ($1, $2, $3, $4)`, [kind, x.id, c.telegram_chat_id, mid]);
  return mid;
}
// Після рішення (бот або панель): у всіх надісланих повідомленнях — результат замість кнопок
async function afterDecision(kind, id) {
  const ms = await db.query(`SELECT m.chat_id, m.message_id, to_jsonb(c)->>'lang' AS lang, p.lang AS pref_lang
                               FROM tgc.msgs m
                               LEFT JOIN public.coordinators c ON c.telegram_chat_id = m.chat_id
                               LEFT JOIN tgc.prefs p ON p.coordinator_id = c.id
                              WHERE m.kind = $1 AND m.ref_id = $2`, [kind, id]);
  if (!ms.rows.length) return 0;
  const x = await loadReq(kind, id);
  if (!x) return 0;
  for (const m of ms.rows) {
    const lang = langOf(m);
    await edit(m.chat_id, m.message_id, renderReq(kind, x, TX[lang], lang), x.status === "pending" ? pendingKb(kind, id, TX[lang]) : null);
  }
  return ms.rows.length;
}

async function onDecisionCb(cq, c, kind, act, id, code) {
  const t = T(c);
  const chatId = cq.message.chat.id;
  const x = await loadReq(kind, id);
  if (!x) return answer(cq.id, t.gone, true);
  if (x.status !== "pending") {
    await answer(cq.id, t.decided);
    return edit(chatId, cq.message.message_id, renderReq(kind, x, t, langOf(c)), null);
  }
  if (act === "no") { await answer(cq.id); return editKb(chatId, cq.message.message_id, [[{ text: t.reason_q, callback_data: "KC:nop" }], ...reasonsKb(kind, id, t)]); }
  if (act === "bk") { await answer(cq.id); return editKb(chatId, cq.message.message_id, pendingKb(kind, id, t)); }
  const routes = require("../api/routes");
  const fn = kind === "adv" ? routes.decideAdvance : routes.decideDayOff;
  const status = act === "ok" ? "approved" : "rejected";
  const reason = act === "r" && code && code !== "none" ? code : null;
  const r = await fn(sessionOf(c), id, status, null, reason);
  if (!r.ok) return answer(cq.id, t.no_right, true);
  await answer(cq.id, "OK");
  // decideAdvance / decideDayOff самі оновлюють усі повідомлення (afterDecision); це — якщо повідомлення не з tgc.msgs
  const y = await loadReq(kind, id);
  return edit(chatId, cq.message.message_id, renderReq(kind, y, t, langOf(c)), null);
}

async function pendingIds(c, kind) {
  const f = await facsOf(c);
  const table = kind === "adv" ? "advances" : "day_off_requests";
  const r = await db.query(
    `SELECT x.id FROM ${table} x JOIN v_worker_current vw ON vw.id = x.worker_id
      WHERE x.status = 'pending' AND ($1::int[] IS NULL OR vw.facility_id = ANY($1))
      ORDER BY x.requested_at, x.id`,
    [f.edit],
  );
  return r.rows.map((x) => x.id);
}
async function listPending(c, kind) {
  const t = T(c);
  const ids = await pendingIds(c, kind);
  if (!ids.length) return send(c.telegram_chat_id, kind === "adv" ? t.none_adv : t.none_dof);
  for (const id of ids.slice(0, CFG.listMax)) {
    const x = await loadReq(kind, id);
    if (x) await sendReq(c, kind, x);
  }
  if (ids.length > CFG.listMax) await send(c.telegram_chat_id, t.more(ids.length - CFG.listMax), [[webAppBtn(t.b_panel, "#" + kind)].filter(Boolean)]);
  if (kind === "dof" && ids.length > 1) {
    const batch = ids.slice(0, CFG.listMax);
    const st = await getState(c.telegram_chat_id);
    st.dofBatch = batch;
    await setState(c.telegram_chat_id, st);
    await send(c.telegram_chat_id, t.all_q(batch.length), [[{ text: t.all(batch.length), callback_data: "KC:d:all" }]]);
  }
  return true;
}
async function approveDofBatch(cq, c) {
  const t = T(c);
  const st = await getState(c.telegram_chat_id);
  const ids = Array.isArray(st.dofBatch) ? st.dofBatch : [];
  const routes = require("../api/routes");
  let n = 0;
  for (const id of ids) {
    const x = await loadDof(id);
    if (!x || x.status !== "pending") continue;
    const r = await routes.decideDayOff(sessionOf(c), id, "approved", null, null);
    if (r.ok) n++;
  }
  delete st.dofBatch;
  await setState(c.telegram_chat_id, st);
  await answer(cq.id, "OK");
  return edit(c.telegram_chat_id, cq.message.message_id, t.all_ok(n), null);
}

// ══════════════════════════════════════════════════════════════════════
//  Ранкова зведення (також дані для головної мініпанелі — api/tg.js)
// ══════════════════════════════════════════════════════════════════════
let GAPS_CACHE = { at: 0, list: [] };
async function gapsCached() {
  if (Date.now() - GAPS_CACHE.at < 10 * 60 * 1000) return GAPS_CACHE.list;
  try {
    GAPS_CACHE = { at: Date.now(), list: await require("./gaps").findGapWorkers() };
  } catch (e) {
    console.error("[coord] gaps", e.message);
    GAPS_CACHE = { at: Date.now(), list: [] };
  }
  return GAPS_CACHE.list;
}
async function planStatus(coordId, today) {
  today = today || (await flowToday());
  let api;
  try { api = require("../api/flow").planApi; } catch (e) { return null; }
  if (!api) return null;
  const weeks = api.orderWeeks(today);
  const cur = api.mondayOf(today);
  const from = api.confirmFrom(today);
  const sites = (await db.query(`SELECT site_key FROM flow.sites() WHERE coordinator_id = $1 ORDER BY site_key`, [coordId])).rows.map((x) => x.site_key);
  const dl = (await db.query(`SELECT COALESCE(flow.setting('orders_deadline'), '20:00') AS v`)).rows[0].v;
  if (!sites.length) return { weeks, sites: [], deadline: dl, unconfirmed: 0 };
  const o = await db.query(
    `SELECT site_key, to_char(week_start, 'YYYY-MM-DD') AS week, qty,
            entered_at >= ($3::date)::timestamp AT TIME ZONE 'Europe/Warsaw' AS confirmed
       FROM flow.v_orders WHERE site_key = ANY($1::text[]) AND week_start BETWEEN $2::date AND $2::date + 21`,
    [sites, cur, from],
  );
  const O = {};
  for (const x of o.rows) O[`${x.site_key}|${x.week}`] = x;
  const rows = sites.map((s) => {
    const curO = O[`${s}|${cur}`];
    let prev = curO ? curO.qty : null;
    const cells = weeks.map((w) => {
      const x = O[`${s}|${w}`];
      // пропозиція — як у панелі: збережене значення попереднього тижня
      const cell = x ? { week: w, qty: Number(x.qty), confirmed: !!x.confirmed } : { week: w, qty: null, proposal: prev == null ? null : Number(prev), confirmed: false };
      prev = x ? x.qty : null;
      return cell;
    });
    return {
      site: s, cells,
      confirmed: cells.every((x) => x.confirmed),
      complete: cells.every((x) => x.qty != null || x.proposal != null),
    };
  });
  return { weeks, sites: rows, deadline: dl, unconfirmed: rows.filter((x) => !x.confirmed).length };
}
async function digestData(c) {
  const today = await flowToday();
  const f = await facsOf(c);
  let gapMin = 4;
  try { gapMin = require("./gaps").CFG.minDays; } catch (e) { /* без модуля */ }
  const out = { today, scope: f.scope, scopes: f.avail, company: f.company, facilities: f.names, arrivals: [], departures: [], gaps: [], gap_min: gapMin,
    pending: { adv: 0, dof: 0 }, plan: null };
  try {
    const a = await db.query(
      `SELECT a.worker_id, w.full_name, fa.name AS facility, a.kind, a.status
         FROM flow.arrivals($1::date, $1::date) a JOIN workers w ON w.id = a.worker_id
         LEFT JOIN facilities fa ON fa.id = a.facility_id
        WHERE a.status <> 'rezygnacja' AND ($2::int[] IS NULL OR a.facility_id = ANY($2)) AND w.login NOT LIKE 'TEST_%'
        ORDER BY fa.name, w.full_name`, [today, f.all]);
    out.arrivals = a.rows;
    const d = await db.query(
      `SELECT d.worker_id, w.full_name, fa.name AS facility, d.is_transfer, d.to_site
         FROM flow.departures($1::date, $1::date) d JOIN workers w ON w.id = d.worker_id
         LEFT JOIN facilities fa ON fa.id = d.facility_id
        WHERE ($2::int[] IS NULL OR d.facility_id = ANY($2)) AND w.login NOT LIKE 'TEST_%'
        ORDER BY fa.name, w.full_name`, [today, f.all]);
    out.departures = d.rows;
  } catch (e) {
    console.error("[coord] digest flow", e.message);
  }
  const g = await gapsCached();
  out.gaps = g.filter((x) => !f.all || f.all.includes(x.facility_id))
    .map((x) => ({ worker_id: x.worker_id, full_name: x.full_name, facility: x.facility_name, facility_id: x.facility_id,
      days: (x.dates || []).length, runs: x.runs, in_bot: !!x.inBot }));
  out.pending = await pendingCounts(c, f);
  try {
    out.plan = await planStatus(c.id, today);
  } catch (e) {
    console.error("[coord] digest plan", e.message);
  }
  return out;
}
function namesBlock(list, t, fmt) {
  const L = list.slice(0, CFG.listMax).map(fmt);
  if (list.length > CFG.listMax) L.push(t.more(list.length - CFG.listMax));
  return L;
}
async function sendDigest(c, opts) {
  const t = T(c);
  const lang = langOf(c);
  const x = await digestData(c);
  const L = [t.dg_hello(esc(firstName(c.full_name)), weekdayDate(lang, x.today))];
  if (x.facilities.length) L.push(`<i>${esc(x.facilities.join(", "))}</i>`);
  if (x.arrivals.length) {
    L.push("", t.dg_arr(x.arrivals.length));
    L.push(...namesBlock(x.arrivals, t, (a) => `• ${esc(a.full_name)} — ${esc(a.facility || "")}${a.kind === "transfer" ? ` (${t.transfer})` : ""}`));
  }
  if (x.departures.length) {
    L.push("", t.dg_dep(x.departures.length));
    L.push(...namesBlock(x.departures, t, (a) => `• ${esc(a.full_name)} — ${esc(a.facility || "")}${a.is_transfer ? ` → ${esc(a.to_site || t.transfer)}` : ""}`));
  }
  const parts = [];
  if (x.gaps.length) parts.push(t.dg_gaps(x.gaps.length, x.gap_min));
  if (x.pending.adv || x.pending.dof) parts.push(t.dg_wait(x.pending.adv, x.pending.dof));
  const dow = new Date(x.today + "T12:00:00Z").getUTCDay(); // 0 = нд, 6 = сб
  if (x.plan && x.plan.unconfirmed && (dow === 6 || dow === 0)) parts.push(t.dg_plan(x.plan.unconfirmed, x.plan.deadline));
  if (parts.length) L.push("", ...parts);
  const quiet = !x.arrivals.length && !x.departures.length && !parts.length;
  if (quiet) {
    if (!(opts && opts.force)) return "quiet";
    L.push("", t.dg_quiet);
  }
  const kb = [
    [x.pending.adv ? { text: t.b_adv(x.pending.adv), callback_data: "KC:ls:adv" } : null,
     x.pending.dof ? { text: t.b_dof(x.pending.dof), callback_data: "KC:ls:dof" } : null].filter(Boolean),
    [x.gaps.length ? { text: t.b_gaps(x.gaps.length), callback_data: "KC:ls:gaps" } : null,
     x.plan && x.plan.sites.length ? { text: t.b_plan, callback_data: "KC:pl:show" } : null].filter(Boolean),
    [webAppBtn(t.b_panel)].filter(Boolean),
  ];
  return (await send(c.telegram_chat_id, L.join("\n"), kb)) ? "sent" : "fail";
}
async function sendDigestAll() {
  const r = await db.query(`${COORD_SQL}
     WHERE c.telegram_chat_id IS NOT NULL AND COALESCE(c.is_active, true) AND COALESCE(p.digest, true)`);
  const stat = { sent: 0, quiet: 0, fail: 0 };
  GAPS_CACHE.at = 0;
  for (const c of r.rows) {
    try {
      const s = await sendDigest(c, {});
      stat[s] = (stat[s] || 0) + 1;
    } catch (e) {
      stat.fail++;
      console.error(`[coord] digest ${c.id}:`, e.message);
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  console.log(`[coord] digest: ${JSON.stringify(stat)}`);
  return stat;
}
async function listGaps(c) {
  const t = T(c);
  const x = await digestData(c);
  if (!x.gaps.length) return send(c.telegram_chat_id, t.gaps_none);
  const L = [t.gaps_t(x.gaps.length, x.gap_min)];
  let fac = null;
  for (const g of x.gaps.slice(0, 40)) {
    if (g.facility !== fac) { fac = g.facility; L.push("", `<b>${esc(fac || "—")}</b>`); }
    const run = (g.runs || []).slice(-1)[0];
    L.push(`• ${esc(g.full_name)} — ${g.days} дн.${run ? ` (${dd(run.start)}–${dd(run.end)})` : ""}`);
  }
  if (x.gaps.length > 40) L.push(t.more(x.gaps.length - 40));
  L.push("", `<i>${t.gaps_tip}</i>`);
  return send(c.telegram_chat_id, L.join("\n"), [[webAppBtn(t.b_open, "#hours")].filter(Boolean)]);
}

// ══════════════════════════════════════════════════════════════════════
//  План набору (неділя: api/flow.js → sendPlanReminder; або кнопка «План набору»)
// ══════════════════════════════════════════════════════════════════════
function planTable(p, t) {
  const W = 15;
  const head = `${t.plan_site.padEnd(W)} ${p.weeks.map((w) => dd(w).padStart(6)).join("")}`;
  const lines = p.sites.map((s) => {
    const name = s.site.length > W ? s.site.slice(0, W - 1) + "…" : s.site.padEnd(W);
    const cells = s.cells.map((x) => {
      const v = x.qty != null ? String(x.qty) + (x.confirmed ? "✓" : " ") : x.proposal != null ? `${x.proposal}*` : "— ";
      return v.padStart(6);
    }).join("");
    return `${esc(name)} ${cells}`;
  });
  return `<pre>${esc(head)}\n${lines.join("\n")}</pre>`;
}
async function planMessage(c, today) {
  const t = T(c);
  const p = await planStatus(c.id, today);
  if (!p) return null;
  if (!p.sites.length) return { text: t.plan_none, kb: null, p };
  if (!p.unconfirmed) return { text: t.plan_nothing + "\n" + planTable(p, t), kb: null, p, nothing: true };
  const text = [t.plan_t, t.plan_sub(p.deadline), planTable(p, t), `<i>${t.plan_leg}</i>`].join("\n");
  const kb = [[{ text: t.plan_ok, callback_data: "KC:pl:ok" }, webAppBtn(t.plan_edit, "#go=" + encodeURIComponent("/wyjazdy.html#orders"))].filter(Boolean)];
  return { text, kb, p };
}
async function sendPlanReminder(coordinatorId, today) {
  const c = await coordById(coordinatorId);
  if (!c || !c.telegram_chat_id || !c.is_active) return "skip";
  const m = await planMessage(c, today);
  if (!m) return "skip";
  if (m.nothing || !m.p.sites.length) return "nothing";
  return (await send(c.telegram_chat_id, m.text, m.kb)) ? "sent" : "fail";
}
async function saveSite(c, site, weeks, values) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < weeks.length; i++) {
      await client.query(`INSERT INTO flow.orders (site_key, week_start, qty, entered_by) VALUES ($1, $2::date, $3, $4)`,
        [site, weeks[i], values[i], c.id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function planConfirm(cq, c) {
  const t = T(c);
  const p = await planStatus(c.id);
  await answer(cq.id, "OK");
  if (!p || !p.sites.length) return send(c.telegram_chat_id, t.plan_none);
  const done = [];
  const queue = [];   // обʼєкти, де бракує цифр: питаємо раз на обʼєкт, відповідь — на всі тижні без цифри
  for (const s of p.sites) {
    if (s.confirmed) continue;
    if (s.complete) {
      await saveSite(c, s.site, p.weeks, s.cells.map((x) => (x.qty != null ? x.qty : x.proposal)));
      done.push(s.site);
    } else {
      queue.push({ site: s.site, weeks: s.cells.filter((x) => x.qty == null && x.proposal == null).map((x) => x.week) });
    }
  }
  await editKb(c.telegram_chat_id, cq.message.message_id, []);
  if (done.length) await send(c.telegram_chat_id, t.plan_done(esc(done.join(", "))));
  const st = await getState(c.telegram_chat_id);
  st.plan = { queue, skipped: [] };
  delete st.planAwait;
  await setState(c.telegram_chat_id, st);
  if (!queue.length) return done.length ? send(c.telegram_chat_id, t.plan_all) : send(c.telegram_chat_id, t.plan_nothing);
  return planAsk(c);
}
async function planAsk(c) {
  const t = T(c);
  const st = await getState(c.telegram_chat_id);
  const q = st.plan && st.plan.queue && st.plan.queue[0];
  if (!q) return planFinish(c, st);
  const nums = [0, 1, 2, 3, 5];
  return send(c.telegram_chat_id, t.plan_ask(esc(q.site), t.plan_wk(q.weeks.map(dd))), [
    nums.map((n) => ({ text: String(n), callback_data: `KC:pl:n:${n}` })),
    [{ text: t.plan_other, callback_data: "KC:pl:x" }, { text: t.plan_skip, callback_data: "KC:pl:s" }],
  ]);
}
async function planFinish(c, st) {
  const t = T(c);
  const skipped = (st.plan && st.plan.skipped) || [];
  delete st.plan;
  delete st.planAwait;
  await setState(c.telegram_chat_id, st);
  if (skipped.length) {
    return send(c.telegram_chat_id, t.plan_skipped(esc(skipped.join(", "))),
      [[webAppBtn(t.plan_edit, "#go=" + encodeURIComponent("/wyjazdy.html#orders"))].filter(Boolean)]);
  }
  return send(c.telegram_chat_id, t.plan_all);
}
// value = число (на всі тижні обʼєкта без цифри) або null = пропустити обʼєкт
async function planAnswer(c, value) {
  const t = T(c);
  const st = await getState(c.telegram_chat_id);
  const plan = st.plan;
  if (!plan || !plan.queue || !plan.queue.length) return planFinish(c, st);
  const q = plan.queue.shift();
  delete st.planAwait;
  if (value == null) plan.skipped.push(q.site);
  else {
    // зберегти всі 3 тижні (наявні цифри / пропозиції + відповідь), як «Zapisz» у панелі
    const p = await planStatus(c.id);
    const s = p && p.sites.find((x) => x.site === q.site);
    if (s) {
      const vals = s.cells.map((x) => (x.qty != null ? x.qty : x.proposal != null ? x.proposal : value));
      await saveSite(c, q.site, p.weeks, vals);
      await send(c.telegram_chat_id, t.plan_done(esc(q.site)) + ` · ${vals.join(" · ")}`);
    }
  }
  await setState(c.telegram_chat_id, st);
  return plan.queue.length ? planAsk(c) : planFinish(c, st);
}

// ══════════════════════════════════════════════════════════════════════
//  Поліс страхування студентів (bot/student_policy.js): нагадування з полем відповіді, номер — відповіддю на нього
// ══════════════════════════════════════════════════════════════════════
const POL_MARK = "🎓";   // з цього починається запит номера — так впізнаємо відповідь на нього
async function policyAsk(c, withCurrent) {
  const t = T(c);
  const pol = require("./student_policy");
  const ym = todayISO().slice(0, 7);
  let text = t.pol_ask(polMonth(c, ym));
  const cur = withCurrent && (await pol.latest());
  if (cur) text += "\n" + t.pol_cur(polMonth(c, cur.month), esc(cur.number));
  const r = await tg("sendMessage", {
    chat_id: c.telegram_chat_id, text, parse_mode: "HTML",
    reply_markup: { force_reply: true, input_field_placeholder: t.pol_ph },
  });
  return r && r.ok ? r.result.message_id : null;
}
async function policyAnswer(c, text) {
  const t = T(c);
  const pol = require("./student_policy");
  if (!pol.valid(text)) return tg("sendMessage", {
    chat_id: c.telegram_chat_id, text: t.pol_bad, reply_markup: { force_reply: true, input_field_placeholder: t.pol_ph },
  });
  const ym = todayISO().slice(0, 7);
  await pol.save(ym, text, c.id);
  const k = await db.query(
    `SELECT count(DISTINCT s.worker_id)::int AS n FROM hrs.surveys s JOIN v_worker_current v ON v.id = s.worker_id
      WHERE s.answers->>'insurance' = 'TAK' AND v.status::text IN ('pracuje', 'urlop', 'l4')`).catch(() => ({ rows: [{ n: "?" }] }));
  return send(c.telegram_chat_id, t.pol_saved(polMonth(c, ym), esc(pol.clean(text)), k.rows[0].n),
    [[{ text: t.b_pol_edit, callback_data: "KC:po:e" }]]);
}
// з DUE_DAY числа о REMIND_AT — поки номера на поточний місяць немає (tick, раз на день)
async function policyRemind(now = new Date()) {
  const pol = require("./student_policy");
  if (Number(isoDay(now).slice(8, 10)) < pol.DUE_DAY) return 0;
  if (await pol.ofMonth(isoDay(now).slice(0, 7))) return 0;
  let n = 0;
  for (const id of pol.COORDS) {
    const c = await coordById(id);
    if (c && c.is_active && c.telegram_chat_id && (await policyAsk(c, true))) n++;
  }
  return n;
}

// ══════════════════════════════════════════════════════════════════════
//  Пошук і картка працівника
// ══════════════════════════════════════════════════════════════════════
// Кирилиця → латиниця (як у паспортах / в базі): «коваль» → koval; кілька варіантів для г/и/е
const TR = { а: "a", б: "b", в: "v", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ъ: "",
  ю: "iu", я: "ia", ы: "y", э: "e", ё: "e", "'": "", "ʼ": "", "’": "" };
function latinVariants(q) {
  const s = q.toLowerCase();
  if (!/[а-яіїєґё]/.test(s)) return [q];
  const out = new Set();
  for (const g of ["h", "g"]) for (const y of ["y", "i"]) {
    out.add([...s].map((ch) => (ch === "г" ? g : ch === "и" ? y : TR[ch] != null ? TR[ch] : ch)).join(""));
  }
  return [...out];
}
async function search(c, qRaw) {
  const t = T(c);
  const q = String(qRaw || "").trim().replace(/\s+/g, " ");
  if (q.replace(/\s/g, "").length < 3) return send(c.telegram_chat_id, t.s_short);
  const f = await facsOf(c, "wide");
  const vars = latinVariants(q).map((v) => `%${v}%`);
  const r = await db.query(
    `SELECT w.id, w.full_name, f.name AS facility, vw.status::text AS status
       FROM workers w
       JOIN v_worker_current vw ON vw.id = w.id
       LEFT JOIN facilities f ON f.id = vw.facility_id
      WHERE (w.full_name ILIKE ANY($1::text[]) OR w.login ILIKE $2)
        AND ($3::int[] IS NULL OR vw.facility_id = ANY($3))
      ORDER BY (vw.status::text = 'pracuje') DESC, (w.login LIKE 'TEST_%'), w.full_name   -- TEST_ — для перевірок, у кінці
      LIMIT 8`,
    [vars, `${q.replace(/\s/g, "")}%`, f.all],
  );
  if (!r.rows.length) return send(c.telegram_chat_id, t.s_none(esc(q)));
  if (r.rows.length === 1) return card(c, r.rows[0].id);
  return send(c.telegram_chat_id, t.s_found(r.rows.length),
    r.rows.map((x) => [{ text: `${x.full_name} · ${x.facility || "—"}`.slice(0, 60), callback_data: `KC:cd:${x.id}` }]));
}
async function workerVisible(c, workerId) {
  const f = await facsOf(c, "wide");
  if (!f.all) return true;
  const r = await db.query(`SELECT 1 FROM v_worker_current WHERE id = $1 AND facility_id = ANY($2::int[])`, [workerId, f.all]);
  return r.rows.length > 0;
}
async function card(c, workerId) {
  const t = T(c);
  if (!(await workerVisible(c, workerId))) return send(c.telegram_chat_id, t.s_none("#" + workerId));
  const r = await db.query(
    `SELECT w.id, w.full_name, w.login, w.telegram_chat_id IS NOT NULL AS in_bot,
            vw.status::text AS status, vw.bhp_date, vw.last_work_date, vw.facility_id, f.name AS facility,
            COALESCE((SELECT sum(h.hours) FROM hours_log h WHERE h.worker_id = w.id
                       AND date_trunc('month', h.work_date) = date_trunc('month', CURRENT_DATE)), 0) AS hours_month,
            (SELECT max(h.work_date) FROM hours_log h WHERE h.worker_id = w.id AND (h.hours IS NOT NULL OR h.absence_type IS NOT NULL)) AS last_hours,
            (SELECT count(*) FROM advances a WHERE a.worker_id = w.id AND a.status = 'approved'
               AND date_trunc('month', COALESCE(a.approved_at, a.requested_at)) = date_trunc('month', CURRENT_DATE))::int AS adv_month,
            (SELECT to_jsonb(h)->>'stanowisko' FROM worker_facility_history h
              WHERE h.worker_id = w.id AND h.facility_id = vw.facility_id AND h.bhp_date IS NOT DISTINCT FROM vw.bhp_date
              ORDER BY h.imported_at DESC LIMIT 1) AS stanowisko
       FROM workers w JOIN v_worker_current vw ON vw.id = w.id LEFT JOIN facilities f ON f.id = vw.facility_id
      WHERE w.id = $1`, [workerId]);
  const x = r.rows[0];
  if (!x) return send(c.telegram_chat_id, t.s_none("#" + workerId));
  const hist = await db.query(
    `SELECT f.name FROM worker_facility_history h JOIN facilities f ON f.id = h.facility_id
      WHERE h.worker_id = $1 AND h.facility_id <> $2 AND h.status::text <> 'rezygnacja'
      ORDER BY h.bhp_date DESC NULLS LAST LIMIT 3`, [workerId, x.facility_id || 0]);
  const L = [
    `<b>${esc(x.full_name)}</b>`,
    `<code>${esc(maskLogin(x.login))}</code>`,
    `${t.st[x.status] || esc(x.status)} · ${esc(x.facility || "—")} · ${t.since(dd(toISO(x.bhp_date)))}${x.last_work_date ? ` – ${dd(toISO(x.last_work_date))}` : ""}`,
    ...(x.stanowisko ? [`${t.c_pos}: ${esc(x.stanowisko)}`] : []),
    "",
    `${t.c_hours}: <b>${num(x.hours_month)}</b>`,
    `${t.c_last}: ${x.last_hours ? dd(toISO(x.last_hours)) : "—"}`,
    `${t.c_adv}: ${x.adv_month ? `${x.adv_month} × ${CFG.advanceStd} zł` : "—"}`,
    t.c_bot(x.in_bot),
  ];
  if (hist.rows.length) L.push(`${t.c_hist}: ${esc([...new Set(hist.rows.map((h) => h.name))].join(", "))}`);
  // підписи документів у HRappka (bot/hr_sign.js) — з нашої бази, оновлюються щодня й з панелі
  try {
    const hs = (await require("./hr_sign").summary([x.id]))[x.id];
    if (hs && !hs.error) {
      if (!hs.found || !hs.total) L.push(t.c_docs_none);
      else {
        L.push(t.c_docs(hs.signed, hs.total));
        const open = hs.docs.filter((d) => d.status !== "SIGN").sort((a, b) => (a.kind !== "survey") - (b.kind !== "survey"))
          .map((d) => (d.kind === "survey" ? `Анкета: ${d.label}` : d.label));
        if (open.length) L.push(`<i>${t.c_docs_wait}: ${esc(open.slice(0, 6).join(", "))}${open.length > 6 ? "…" : ""}</i>`);
      }
    }
  } catch (e) { /* без міграції — без рядка */ }
  // статус студента (bot/student.js: довідка з міні-застосунку працівника, пізніше — HRappka)
  try {
    const st = await require("./student").get(x.id);
    if (st.state !== "none") L.push(t.c_student(st.state, st.valid_until ? dd(st.valid_until) + "." + st.valid_until.slice(0, 4) : ""));
    // поліс страхування студентів (bot/student_policy.js): лише тим, кого питали в анкеті
    const pol = await require("./student_policy").forWorker(x.id);
    if (pol) L.push(pol.consent !== "TAK" ? t.c_pol_no : pol.number ? t.c_pol(esc(pol.number), polMonth(c, pol.month)) : t.c_pol_none);
  } catch (e) { /* без міграції — без рядка */ }
  // «Штраф» — мініпанель з формою (bot/fines.js); лише там, де координатор може виписувати
  let fineBtn = null;
  try {
    const ff = await require("./fines").issueFacs(c);
    if (ff === null || ff.includes(Number(x.facility_id))) fineBtn = webAppBtn(t.b_fine, `#fine:w=${x.id}`);
  } catch (e) { /* без міграції штрафів — без кнопки */ }
  return send(c.telegram_chat_id, L.join("\n"), [
    [{ text: t.b_hours, callback_data: `KC:hm:${x.id}` }, { text: t.b_hist, callback_data: `KC:hi:${x.id}` }],
    [webAppBtn(t.b_open, `#hours:fac=${x.facility_id || ""}`), fineBtn].filter(Boolean),
  ]);
}
async function cardHours(c, workerId) {
  const t = T(c);
  const lang = langOf(c);
  if (!(await workerVisible(c, workerId))) return send(c.telegram_chat_id, t.s_none("#" + workerId));
  const w = await db.query(`SELECT full_name FROM workers WHERE id = $1`, [workerId]);
  const r = await db.query(
    `SELECT to_char(work_date, 'YYYY-MM-DD') AS d, hours, absence_type FROM hours_log
      WHERE worker_id = $1 AND date_trunc('month', work_date) = date_trunc('month', CURRENT_DATE) ORDER BY work_date`, [workerId]);
  const L = [t.h_title(esc(w.rows[0] ? w.rows[0].full_name : ""), monthName(lang))];
  if (!r.rows.length) L.push(t.h_none);
  else {
    const lines = r.rows.map((x) => `${dd(x.d)}  ${x.absence_type || num(x.hours)}`);
    const sum = r.rows.reduce((a, x) => a + (Number(x.hours) || 0), 0);
    L.push(`<pre>${esc(lines.join("\n"))}\n${t.total}: ${num(sum)}</pre>`);
  }
  return send(c.telegram_chat_id, L.join("\n"));
}
async function cardHistory(c, workerId) {
  const t = T(c);
  if (!(await workerVisible(c, workerId))) return send(c.telegram_chat_id, t.s_none("#" + workerId));
  const w = await db.query(`SELECT full_name FROM workers WHERE id = $1`, [workerId]);
  const r = await db.query(
    `SELECT f.name, h.status::text AS status, h.bhp_date, h.last_work_date FROM worker_facility_history h
       JOIN facilities f ON f.id = h.facility_id WHERE h.worker_id = $1 ORDER BY h.bhp_date DESC NULLS LAST LIMIT 12`, [workerId]);
  const L = [t.hist_t(esc(w.rows[0] ? w.rows[0].full_name : ""))];
  for (const h of r.rows) {
    L.push(`• ${esc(h.name)} — ${t.st[h.status] || esc(h.status)}, ${dd(toISO(h.bhp_date))} – ${h.last_work_date ? dd(toISO(h.last_work_date)) : t.now}`);
  }
  return send(c.telegram_chat_id, L.join("\n"));
}

// ══════════════════════════════════════════════════════════════════════
//  Вхідні оновлення (з index.js /webhook — ДО обробника працівників)
// ══════════════════════════════════════════════════════════════════════
async function onCallback(cq) {
  const data = String(cq.data || "");
  const p = data.split(":");
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!chatId) return;
  if (p[1] === "lk") return onLinkAnswer(cq, p[3], p[2] === "y");
  if (p[1] === "nop") return answer(cq.id);
  const c = await coordByChat(chatId);
  if (!c) return answer(cq.id, "—", false);
  const t = T(c);
  switch (p[1]) {
    case "a":
    case "d": {
      const kind = p[1] === "a" ? "adv" : "dof";
      if (p[2] === "all") return approveDofBatch(cq, c);
      return onDecisionCb(cq, c, kind, p[2], parseInt(p[3], 10), p[4]);
    }
    case "ls":
      await answer(cq.id);
      if (p[2] === "adv" || p[2] === "dof") return listPending(c, p[2]);
      if (p[2] === "gaps") return listGaps(c);
      return null;
    case "dg":
      await answer(cq.id);
      return sendDigest(c, { force: true });
    case "dgt":
      await db.query(`INSERT INTO tgc.prefs (coordinator_id, lang, digest) VALUES ($1, $2, $3)
                      ON CONFLICT (coordinator_id) DO UPDATE SET digest = EXCLUDED.digest, updated_at = now()`,
        [c.id, langOf(c), !c.digest]);
      await answer(cq.id, !c.digest ? t.b_digest_on : t.b_digest_off);
      return sendMenu(await coordById(c.id));
    case "dmt": {
      const email = String(c.email || "").trim();
      if (!c.docs_mail && !email) return answer(cq.id, t.docs_noemail, true);
      await db.query(`INSERT INTO tgc.prefs (coordinator_id, lang, docs_mail) VALUES ($1, $2, $3)
                      ON CONFLICT (coordinator_id) DO UPDATE SET docs_mail = EXCLUDED.docs_mail, updated_at = now()`,
        [c.id, langOf(c), !c.docs_mail]);
      await answer(cq.id, !c.docs_mail ? t.docs_on(email) : t.docs_off, true);
      return sendMenu(await coordById(c.id));
    }
    case "lang": {
      const nl = langOf(c) === "ru" ? "uk" : "ru";
      await db.query(`INSERT INTO tgc.prefs (coordinator_id, lang) VALUES ($1, $2)
                      ON CONFLICT (coordinator_id) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`, [c.id, nl]);
      await answer(cq.id, TX[nl].lang_set);
      return sendMenu(await coordById(c.id));
    }
    case "pl":
      if (p[2] === "ok") return planConfirm(cq, c);
      if (p[2] === "n") { await answer(cq.id); await editKb(chatId, cq.message.message_id, []); return planAnswer(c, Math.max(0, Math.min(999, parseInt(p[3], 10) || 0))); }
      if (p[2] === "s") { await answer(cq.id); await editKb(chatId, cq.message.message_id, []); return planAnswer(c, null); }
      if (p[2] === "x") {
        const st = await getState(chatId);
        st.planAwait = true;
        await setState(chatId, st);
        await answer(cq.id);
        return send(chatId, t.plan_type);
      }
      if (p[2] === "show") {
        await answer(cq.id);
        const m = await planMessage(c);
        return m ? send(chatId, m.text, m.kb) : null;
      }
      return answer(cq.id);
    case "po":
      await answer(cq.id);
      return require("./student_policy").isEditor(c.id) ? policyAsk(c, true) : null;
    case "cd": await answer(cq.id); return card(c, parseInt(p[2], 10));
    case "hm": await answer(cq.id); return cardHours(c, parseInt(p[2], 10));
    case "hi": await answer(cq.id); return cardHistory(c, parseInt(p[2], 10));
    default:
      return answer(cq.id);
  }
}

async function onUpdate(bot, u) {
  try {
    if (!u) return false;
    if (u.callback_query && /^KC:/.test(String(u.callback_query.data || ""))) {
      await onCallback(u.callback_query);
      return true;
    }
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== "private" || typeof m.text !== "string") return false;
    const text = m.text.trim();
    const link = /^\/start\s+link_([A-Za-z0-9_-]{6,40})$/.exec(text);
    if (link) {
      await onLinkStart(m, link[1]);
      return true;
    }
    const c = await coordByChat(m.chat.id);
    if (!c) return false;
    // той самий чат може бути й «працівником» (напр. тест бота адміном) — тоді лише явні команди
    let isWorker = false;
    try {
      const s = await require("./session").getSessionSafe(m.chat.id);
      isWorker = !!(s && s.workerId);
    } catch (e) { /* без сесії працівника */ }
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");
    if (cmd === "/start" && text.split(/\s+/).length > 1) return false;   // інші посилання /start … — як раніше
    if (["/panel", "/menu", "/coord"].includes(cmd) || (cmd === "/start" && !isWorker)) {
      await setMenuButton(c.telegram_chat_id);
      await sendMenu(c);
      return true;
    }
    if (["/s", "/search", "/szukaj", "/пошук", "/поиск"].includes(cmd)) {
      await search(c, text.slice(cmd.length));
      return true;
    }
    if (["/digest", "/zvedennia", "/svodka"].includes(cmd)) {
      await sendDigest(c, { force: true });
      return true;
    }
    // поліс студентів: /polis — запит номера; відповідь на запит (🎓 …) — номер
    const polEditor = require("./student_policy").isEditor(c.id);
    if (polEditor && ["/polis", "/поліс", "/полис"].includes(cmd)) {
      await policyAsk(c, true);
      return true;
    }
    const re = m.reply_to_message;
    if (polEditor && re && re.from && re.from.is_bot && String(re.text || "").startsWith(POL_MARK) && !text.startsWith("/")) {
      await policyAnswer(c, text);
      return true;
    }
    if (isWorker) return false;
    if (text.startsWith("/")) {
      await sendMenu(c);
      return true;
    }
    const st = await getState(m.chat.id);
    if ((st.planAwait || (st.plan && st.plan.queue && st.plan.queue.length)) && /^\d{1,3}$/.test(text)) {
      await planAnswer(c, Math.min(999, parseInt(text, 10)));
      return true;
    }
    await search(c, text);
    return true;
  } catch (e) {
    console.error("[coord] onUpdate", e.message);
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
//  Планувальник
// ══════════════════════════════════════════════════════════════════════
let TIMER = null;
async function tick(now = new Date()) {
  const day = isoDay(now);
  const hm = hmNow(now);
  const min = hmToMin(hm);
  const at = hmToMin(CFG.digestTime);
  if (CFG.digestEnabled && at != null && min >= at && min < at + 180 && (await claim("digest", day))) {
    await sendDigestAll();
  }
  if (min >= 4 * 60 + 10 && min < 4 * 60 + 40 && (await claim("menu", day))) await syncMenuButtons();
  const pol = hmToMin(require("./student_policy").REMIND_AT);
  if (min >= pol && min < pol + 180 && (await claim("policy", day))) await policyRemind(now);
}
function schedule() {
  if (TIMER) return;
  setTimeout(() => syncMenuButtons().catch((e) => console.error("[coord] menu", e.message)), 30 * 1000);
  TIMER = setInterval(() => tick().catch((e) => console.error("[coord] tick", e.message)), 60 * 1000);
}

module.exports = {
  CFG, onUpdate, notifyNew, afterDecision, sendPlanReminder, schedule, digestData, createLinkCode, botUsername,
  coordByChat, coordById, langOf, facsOf, listRequests, setMenuButton, clearMenuButton, syncMenuButtons, sendDigestAll,
  _test: { setTg: (fn) => { TG = fn; }, tick, policyRemind, latinVariants, planStatus, search, card, sendDigest, sendMenu, onCallback, TX },
};
