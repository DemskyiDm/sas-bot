// ══════════════════════════════════════════════════════════════════════
//  Стартовий пакет анкет у боті (+ «Poleć znajomego»)
//
//  Новий працівник (перший період у компанії або після перерви > 14 днів)
//  одразу після входу в бот отримує ОДИН пакет із 6 питань:
//    1. «Як ви дізналися про компанію?» — тут (bot/referral.js): друг, координатор,
//       рекрутер, Facebook, Instagram, TikTok, Telegram, сайт вакансій, інше.
//       Для друга й координатора — ім'я та прізвище (тільки текст) → премія за полецення;
//    2–6. анкета care «start» (bot/care.js, db/migration_start_survey.sql):
//       умови, рекрутер, житло, координатор, «на скільки приїхали».
//
//  Хто отримує: нові на об'єктах координаторів, увімкнених у Rozmowy → Koordynatorzy,
//  коли в Rozmowy → Ustawienia увімкнена анкета «start» (і анкети загалом).
//  Решта нових не отримує нічого.
//
//  Правила:
//   • питання 1 — до BHP + window_days (5) включно, потім — заборонено;
//     нагадування раз на день о remind_time, не більше remind_max (3);
//   • питання 2–6 — одразу після 1; нагадування раз на день start_remind_days (2) дні;
//   • кожен вхід у бот під ID працівника записується в ref.tg_log
//     (Telegram-ID, username, ім'я) — історія Telegram працівника;
//   • з Telegram, який належить координатору, анкета не надсилається,
//     а відповідь не приймається (спроба записується як blocked).
//
//  Підключення (index.js):
//    if (await referral.onUpdate(bot, req.body)) return;   // у вебхуку
//    referral.schedule(bot);
//  bot/handlers.js після входу: require("./referral").onLogin(bot, worker, chatId, from)
// ══════════════════════════════════════════════════════════════════════
const db = require("../db");

let BOT = null;

const TX = {
  uk: {
    ask: "👋 Вітаємо в SAS Logistic!\n\nСкажіть, будь ласка, <b>хто вас привів до нас?</b>",
    remind: "⏰ Нагадування: дайте відповідь до <b>{dl}</b>.\n\nХто вас привів до SAS Logistic?",
    o_friend: "👥 Друг / знайомий, який у нас працює",
    o_coord: "🧑‍💼 Координатор",
    o_recruit: "📢 Рекрутер / оголошення",
    o_other: "🔎 Інше / знайшов сам",
    name_friend: "✍️ Напишіть <b>ім'я та прізвище</b> друга, який вас привів.\nНаприклад: <i>Іван Коваленко</i>",
    name_coord: "✍️ Напишіть <b>ім'я та прізвище</b> координатора.",
    two_words: "Напишіть, будь ласка, і ім'я, і прізвище — два слова.",
    thanks: "✅ Дякуємо! Записали: <b>{v}</b>.\nЗмінити відповідь можна до {dl}.",
    s_friend: "друг", s_coord: "координатор", s_recruit: "рекрутер / оголошення", s_other: "інше",
    edit: "✏️ Змінити відповідь",
    expired: "Час на відповідь минув ({dl}). Відповідь уже не можна внести або змінити.",
    blocked: "⛔ Цю анкету має заповнити сам працівник зі свого телефона.\nВідповідь із Telegram координатора не приймається.",
    other_worker: "Ця анкета для іншого працівника.",
    stay_saved: "✅ Записали: {v}.",
    stay_m1: "1 місяць", stay_m2: "2 місяці", stay_m3: "3 місяці", stay_m6: "6 місяців", stay_more: "Довше",
    ask_x: "👋 Вітаємо в SAS Logistic!\n\n6 коротких питань — займе хвилину.\n\n<b>Як ви дізналися про нашу компанію?</b>  <i>(1/6)</i>",
    remind_x: "⏰ Нагадування: дайте відповідь до <b>{dl}</b>.\n\n<b>Як ви дізналися про SAS Logistic?</b>  <i>(1/6)</i>",
    o_recruit_x: "📞 Мені подзвонив / написав рекрутер",
    o_facebook: "📘 Facebook", o_instagram: "📸 Instagram", o_tiktok: "🎵 TikTok",
    o_telegram: "✈️ Telegram-канал / група", o_jobsite: "🌐 Сайт вакансій (OLX, Work.ua…)", o_other_x: "🔎 Інше",
    s_recruit_x: "рекрутер", s_facebook: "Facebook", s_instagram: "Instagram", s_tiktok: "TikTok", s_telegram: "Telegram", s_jobsite: "сайт вакансій",
  },
  ru: {
    ask: "👋 Добро пожаловать в SAS Logistic!\n\nСкажите, пожалуйста, <b>кто вас привёл к нам?</b>",
    remind: "⏰ Напоминание: ответьте до <b>{dl}</b>.\n\nКто вас привёл в SAS Logistic?",
    o_friend: "👥 Друг / знакомый, который у нас работает",
    o_coord: "🧑‍💼 Координатор",
    o_recruit: "📢 Рекрутер / объявление",
    o_other: "🔎 Другое / нашёл сам",
    name_friend: "✍️ Напишите <b>имя и фамилию</b> друга, который вас привёл.\nНапример: <i>Иван Коваленко</i>",
    name_coord: "✍️ Напишите <b>имя и фамилию</b> координатора.",
    two_words: "Напишите, пожалуйста, и имя, и фамилию — два слова.",
    thanks: "✅ Спасибо! Записали: <b>{v}</b>.\nИзменить ответ можно до {dl}.",
    s_friend: "друг", s_coord: "координатор", s_recruit: "рекрутер / объявление", s_other: "другое",
    edit: "✏️ Изменить ответ",
    expired: "Время для ответа истекло ({dl}). Ответ уже нельзя внести или изменить.",
    blocked: "⛔ Эту анкету должен заполнить сам работник со своего телефона.\nОтвет с Telegram координатора не принимается.",
    other_worker: "Эта анкета для другого работника.",
    stay_saved: "✅ Записали: {v}.",
    stay_m1: "1 месяц", stay_m2: "2 месяца", stay_m3: "3 месяца", stay_m6: "6 месяцев", stay_more: "Дольше",
    ask_x: "👋 Добро пожаловать в SAS Logistic!\n\n6 коротких вопросов — займёт минуту.\n\n<b>Как вы узнали о нашей компании?</b>  <i>(1/6)</i>",
    remind_x: "⏰ Напоминание: ответьте до <b>{dl}</b>.\n\n<b>Как вы узнали о SAS Logistic?</b>  <i>(1/6)</i>",
    o_recruit_x: "📞 Мне позвонил / написал рекрутер",
    o_facebook: "📘 Facebook", o_instagram: "📸 Instagram", o_tiktok: "🎵 TikTok",
    o_telegram: "✈️ Telegram-канал / группа", o_jobsite: "🌐 Сайт вакансий (OLX, Work.ua…)", o_other_x: "🔎 Другое",
    s_recruit_x: "рекрутер", s_facebook: "Facebook", s_instagram: "Instagram", s_tiktok: "TikTok", s_telegram: "Telegram", s_jobsite: "сайт вакансий",
  },
  pl: {
    ask: "👋 Witamy w SAS Logistic!\n\nPowiedz, proszę: <b>kto Cię do nas polecił?</b>",
    remind: "⏰ Przypomnienie: odpowiedz do <b>{dl}</b>.\n\nKto polecił Ci SAS Logistic?",
    o_friend: "👥 Znajomy, który u nas pracuje",
    o_coord: "🧑‍💼 Koordynator",
    o_recruit: "📢 Rekruter / ogłoszenie",
    o_other: "🔎 Inne / sam znalazłem",
    name_friend: "✍️ Napisz <b>imię i nazwisko</b> znajomego, który Cię polecił.\nNp.: <i>Jan Kowalski</i>",
    name_coord: "✍️ Napisz <b>imię i nazwisko</b> koordynatora.",
    two_words: "Napisz, proszę, imię i nazwisko — dwa słowa.",
    thanks: "✅ Dziękujemy! Zapisaliśmy: <b>{v}</b>.\nOdpowiedź można zmienić do {dl}.",
    s_friend: "znajomy", s_coord: "koordynator", s_recruit: "rekruter / ogłoszenie", s_other: "inne",
    edit: "✏️ Zmień odpowiedź",
    expired: "Czas na odpowiedź minął ({dl}). Nie można już jej wpisać ani zmienić.",
    blocked: "⛔ Tę ankietę wypełnia sam pracownik ze swojego telefonu.\nOdpowiedź z Telegrama koordynatora nie jest przyjmowana.",
    other_worker: "Ta ankieta jest dla innego pracownika.",
    stay_saved: "✅ Zapisaliśmy: {v}.",
    stay_m1: "1 miesiąc", stay_m2: "2 miesiące", stay_m3: "3 miesiące", stay_m6: "6 miesięcy", stay_more: "Dłużej",
    ask_x: "👋 Witamy w SAS Logistic!\n\n6 krótkich pytań — zajmie minutę.\n\n<b>Skąd dowiedziałeś się o naszej firmie?</b>  <i>(1/6)</i>",
    remind_x: "⏰ Przypomnienie: odpowiedz do <b>{dl}</b>.\n\n<b>Skąd dowiedziałeś się o SAS Logistic?</b>  <i>(1/6)</i>",
    o_recruit_x: "📞 Zadzwonił / napisał do mnie rekruter",
    o_facebook: "📘 Facebook", o_instagram: "📸 Instagram", o_tiktok: "🎵 TikTok",
    o_telegram: "✈️ Kanał / grupa w Telegramie", o_jobsite: "🌐 Portal z ofertami (OLX, Pracuj.pl…)", o_other_x: "🔎 Inne",
    s_recruit_x: "rekruter", s_facebook: "Facebook", s_instagram: "Instagram", s_tiktok: "TikTok", s_telegram: "Telegram", s_jobsite: "portal z ofertami",
  },
  en: {
    ask: "👋 Welcome to SAS Logistic!\n\nPlease tell us: <b>who referred you to us?</b>",
    remind: "⏰ Reminder: please answer by <b>{dl}</b>.\n\nWho referred you to SAS Logistic?",
    o_friend: "👥 A friend who works here",
    o_coord: "🧑‍💼 Coordinator",
    o_recruit: "📢 Recruiter / job ad",
    o_other: "🔎 Other / found it myself",
    name_friend: "✍️ Please type the <b>first and last name</b> of the friend who referred you.",
    name_coord: "✍️ Please type the coordinator's <b>first and last name</b>.",
    two_words: "Please type both first and last name — two words.",
    thanks: "✅ Thank you! Saved: <b>{v}</b>.\nYou can change the answer until {dl}.",
    s_friend: "friend", s_coord: "coordinator", s_recruit: "recruiter / job ad", s_other: "other",
    edit: "✏️ Change answer",
    expired: "The time to answer has passed ({dl}). The answer can no longer be entered or changed.",
    blocked: "⛔ This survey must be filled in by the worker from their own phone.\nAnswers from a coordinator's Telegram are not accepted.",
    other_worker: "This survey is for another worker.",
    stay_saved: "✅ Saved: {v}.",
    stay_m1: "1 month", stay_m2: "2 months", stay_m3: "3 months", stay_m6: "6 months", stay_more: "Longer",
    ask_x: "👋 Welcome to SAS Logistic!\n\n6 short questions — takes a minute.\n\n<b>How did you hear about our company?</b>  <i>(1/6)</i>",
    remind_x: "⏰ Reminder: please answer by <b>{dl}</b>.\n\n<b>How did you hear about SAS Logistic?</b>  <i>(1/6)</i>",
    o_recruit_x: "📞 A recruiter called / messaged me",
    o_facebook: "📘 Facebook", o_instagram: "📸 Instagram", o_tiktok: "🎵 TikTok",
    o_telegram: "✈️ Telegram channel / group", o_jobsite: "🌐 Job website (OLX, Work.ua…)", o_other_x: "🔎 Other",
    s_recruit_x: "recruiter", s_facebook: "Facebook", s_instagram: "Instagram", s_tiktok: "TikTok", s_telegram: "Telegram", s_jobsite: "job website",
  },
};
// SOURCES — старе питання «хто привів» (4 кнопки; рядки до пакета, ext = false)
const SOURCES = ["friend", "coord", "recruit", "other"];
// пакет: «як дізналися» з каналами (ext = true)
const SOURCES_X = ["friend", "coord", "recruit", "facebook", "instagram", "tiktok", "telegram", "jobsite", "other"];
// «на скільки приїхали» — тепер питання 6 анкети care «start»; тут — назви для панелі й старих кнопок RF_T_
const STAYS = ["m1", "m2", "m3", "m6", "more"];
const srcLabel = (t, src, ext) => (ext && t["s_" + src + "_x"]) || t["s_" + src] || src;
const langOf = (l) => (TX[l] ? l : l === "ua" ? "uk" : "uk");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => (o[k] == null ? "" : o[k]));
const ddmm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const toISO = (d) => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  : String(d).slice(0, 10));
function addDaysISO(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Налаштування (кеш 60 с) ───────────────────────────────────────────
let SET = null, SET_AT = 0;
async function settings() {
  if (SET && Date.now() - SET_AT < 60000) return SET;
  const r = await db.query(`SELECT key, value FROM ref.settings`);
  SET = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  SET_AT = Date.now();
  return SET;
}
function resetSettingsCache() { SET = null; }

// Стартовий пакет увімкнений: анкета care «start» активна і анкети в Rozmowy не вимкнені
async function startOn() {
  try {
    const r = await db.query(
      `SELECT sv.is_active, COALESCE((SELECT value FROM care.settings WHERE key = 'surveys_enabled'), 1) AS surveys_on
         FROM care.surveys sv WHERE sv.code = 'start'`);
    return !!(r.rows[0] && r.rows[0].is_active && Number(r.rows[0].surveys_on) !== 0);   // + загальний вимикач анкет у Rozmowy
  } catch (e) { return false; }                       // модуля Rozmowy немає
}
// Об'єкт у пакеті: його координатор увімкнений у Rozmowy → Koordynatorzy
const PKG_SQL = (site) => `EXISTS (SELECT 1 FROM reg.site_owner o WHERE o.site_key = ${site} AND o.valid_to IS NULL AND care.is_on(o.coordinator_id))`;
async function inPackage(siteKey) {
  if (!siteKey || !(await startOn())) return false;
  try {
    return (await db.query(`SELECT ${PKG_SQL("$1")} AS on`, [siteKey])).rows[0].on === true;
  } catch (e) { return false; }
}

async function today() {
  const r = await db.query(`SELECT to_char(ref.today(), 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE 'Europe/Warsaw', 'HH24:MI') AS hm`);
  return r.rows[0];
}

// ── Telegram ──────────────────────────────────────────────────────────
async function send(chatId, text, keyboard) {
  if (!BOT || !chatId) return false;
  try {
    await BOT.telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
    return true;
  } catch (e) {
    console.error("[ref] send", chatId, e.message);
    return false;
  }
}
function askKeyboard(t, id, ext) {
  const b = (s, label) => ({ text: label || t["o_" + s], callback_data: `RF_S_${id}_${s}` });
  if (!ext) return SOURCES.map((s) => [b(s)]);
  return [[b("friend")], [b("coord")], [b("recruit", t.o_recruit_x)], [b("facebook"), b("instagram")],
    [b("tiktok"), b("telegram")], [b("jobsite")], [b("other", t.o_other_x)]];
}

// ── Хто стоїть за Telegram ───────────────────────────────────────────
async function coordByChat(chatId, tgUserId) {
  const ids = [chatId, tgUserId].filter((x) => x != null).map(String);
  if (!ids.length) return null;
  const r = await db.query(
    `SELECT id, full_name FROM public.coordinators WHERE telegram_chat_id::text = ANY($1::text[]) LIMIT 1`, [ids]);
  return r.rows[0] || null;
}
async function logTg(workerId, chatId, from, event, coordId, answerId) {
  try {
    const name = from ? [from.first_name, from.last_name].filter(Boolean).join(" ") : null;
    await db.query(
      `INSERT INTO ref.tg_log (worker_id, chat_id, tg_user_id, tg_username, tg_name, event, coordinator_id, answer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [workerId, chatId, from && from.id ? from.id : null, from && from.username ? from.username : null,
        name || null, event, coordId || null, answerId || null]);
  } catch (e) {
    console.error("[ref] tg_log", e.message);
  }
}

// Імпорт міг виправити дату BHP — переносимо відповіді (див. ref.relink у міграції)
async function relink() {
  try { await db.query(`SELECT ref.relink()`); } catch (e) { console.error("[ref] relink", e.message); }
}
// Останній, хто входив у бот з цього Telegram (null — історії ще немає)
async function lastLoginWorker(chatId) {
  const r = await db.query(
    `SELECT worker_id FROM ref.tg_log WHERE chat_id = $1 AND event = 'login' ORDER BY at DESC, id DESC LIMIT 1`, [chatId]);
  return r.rows[0] ? r.rows[0].worker_id : null;
}

// ── Нове працевлаштування, на яке ще можна відповісти ────────────────
async function openHire(workerId) {
  const st = await settings();
  const win = Number(st.window_days) || 5;
  const r = await db.query(
    `SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, h.facility_id, h.site_key
       FROM ref.v_hires h
      WHERE h.worker_id = $1
        AND h.bhp_date >= $2::date
        AND ref.today() <= h.bhp_date + $3::int
      ORDER BY h.bhp_date DESC LIMIT 1`,
    [workerId, st.start_date || "2000-01-01", win]);
  return r.rows[0] || null;
}
async function deadlineOf(row) {
  const st = await settings();
  return addDaysISO(toISO(row.bhp_date), Number(st.window_days) || 5);
}
// Рядок відповіді створюється лише для об'єктів у пакеті (решта нових не отримує нічого).
// Старий рядок без відповіді (4 кнопки, до пакета) на об'єкті в пакеті переходить у пакет.
async function ensureRow(workerId, hire, chatId, lang, pkg) {
  if (pkg === undefined) pkg = await inPackage(hire.site_key);
  if (pkg) {
    await db.query(
      `INSERT INTO ref.answers (worker_id, bhp_date, facility_id, sent_chat_id, lang, ext)
       VALUES ($1, $2::date, $3, $4, $5, true)
       ON CONFLICT (worker_id, bhp_date) DO UPDATE SET ext = true, updated_at = now()
        WHERE ref.answers.status = 'sent' AND NOT ref.answers.ext`,
      [workerId, hire.bhp, hire.facility_id, chatId, lang]);
  }
  const r = await db.query(`SELECT * FROM ref.answers WHERE worker_id = $1 AND bhp_date = $2::date`, [workerId, hire.bhp]);
  return r.rows[0] || null;
}
async function workerLang(workerId) {
  const r = await db.query(`SELECT lang::text AS lang, session_data->>'lang' AS slang FROM public.workers WHERE id = $1`, [workerId]);
  const x = r.rows[0] || {};
  return langOf(x.slang || x.lang || "uk");
}

// Надіслати питання 1 пакета (перше або нагадування). Якщо джерело вже обране
// (друг/координатор), а ім'я не вписане — питаємо одразу ім'я.
async function sendAsk(row, chatId, reminder) {
  const t = TX[langOf(row.lang)];
  const dl = ddmm(await deadlineOf(row));
  const src = row.pending_source || (row.status !== "answered" ? row.source : null);
  await db.query(`UPDATE ref.answers SET last_try_at = now() WHERE id = $1`, [row.id]);   // невдала спроба — наступна завтра
  let ok;
  if (src === "friend" || src === "coord") {
    const head = reminder ? fmt(row.ext ? t.remind_x : t.remind, { dl }).split("\n\n")[0] + "\n\n" : "";
    ok = await send(chatId, head + (src === "friend" ? t.name_friend : t.name_coord));
    if (ok) await db.query(`UPDATE ref.answers SET await_name = true WHERE id = $1`, [row.id]);
  } else {
    ok = await send(chatId, reminder ? fmt(row.ext ? t.remind_x : t.remind, { dl }) : (row.ext ? t.ask_x : t.ask), askKeyboard(t, row.id, row.ext));
  }
  if (ok) {
    await db.query(
      `UPDATE ref.answers SET sends = sends + 1, reminders = reminders + $3, last_sent_at = now(),
              first_sent_at = COALESCE(first_sent_at, now()), sent_chat_id = $2, updated_at = now() WHERE id = $1`,
      [row.id, chatId, reminder ? 1 : 0]);
  }
  return ok;
}

// ── Вхід у бот ────────────────────────────────────────────────────────
// Викликається з bot/handlers.js одразу після того, як працівник увів ID.
async function onLogin(bot, worker, chatId, from) {
  if (bot) BOT = bot;
  try {
    const coord = await coordByChat(chatId, from && from.id);
    await logTg(worker.id, chatId, from, "login", coord && coord.id, null);
    if (coord) return;                                 // Telegram координатора — анкету не показуємо
    if (!(await startOn())) return;                    // пакет вимкнений у Rozmowy → Ustawienia
    await relink();
    const hire = await openHire(worker.id);
    if (!hire) return;
    const lang = await workerLang(worker.id);
    const pkg = await inPackage(hire.site_key);
    const row = await ensureRow(worker.id, hire, chatId, lang, pkg);
    // об'єкт не в пакеті (координатора вимкнули в Rozmowy) або старий рядок до пакета — нічого не надсилаємо
    if (!row || !row.ext || !pkg) return;
    // питання 1 вже є — продовжити пакет (питання 2–6), якщо ще не надсилали
    if (row.status === "answered") { if (!row.manual_by) await startSurvey(row, chatId); return; }
    if (row.status !== "sent") return;
    // повторний вхід протягом години — не дублюємо питання
    if (row.last_sent_at && Date.now() - new Date(row.last_sent_at).getTime() < 3600 * 1000 && String(row.sent_chat_id) === String(chatId)) return;
    if (row.lang !== lang) { await db.query(`UPDATE ref.answers SET lang = $2 WHERE id = $1`, [row.id, lang]); row.lang = lang; }
    await sendAsk(row, chatId, false);
  } catch (e) {
    console.error("[ref] onLogin", e.message);
  }
}

// ── Перевірки перед записом відповіді ────────────────────────────────
// Повертає { row, t } або null (якщо вже відповіли повідомленням)
async function guard(row, chatId, from) {
  const t = TX[langOf(row.lang)];
  const coord = await coordByChat(chatId, from && from.id);
  if (coord) {
    await db.query(`UPDATE ref.answers SET blocked_attempts = blocked_attempts + 1, await_name = false, updated_at = now() WHERE id = $1`, [row.id]);
    await logTg(row.worker_id, chatId, from, "blocked", coord.id, row.id);
    await send(chatId, t.blocked);
    return null;
  }
  // працевлаштування ще є в графіку? (імпорт міг змінити дату BHP або видалити період)
  const hireOk = async (r) => (await db.query(
    `SELECT 1 FROM ref.v_hires WHERE worker_id = $1 AND bhp_date = $2::date`, [r.worker_id, toISO(r.bhp_date)])).rows.length > 0;
  if (!(await hireOk(row))) {
    await relink();
    const r2 = (await db.query(`SELECT * FROM ref.answers WHERE id = $1`, [row.id])).rows[0];
    if (r2) row = r2;
  }
  const dl = await deadlineOf(row);
  const td = (await today()).d;
  if (td > dl || row.status === "expired" || !(await hireOk(row))) {
    await db.query(`UPDATE ref.answers SET await_name = false, pending_source = NULL WHERE id = $1`, [row.id]);
    await send(chatId, fmt(t.expired, { dl: ddmm(dl) }));
    return null;
  }
  // відповідає той, хто зараз увійшов у бот з цього Telegram (за історією входів);
  // для входів до запуску історії — за прив'язкою Telegram у картці працівника
  const lw = await lastLoginWorker(chatId);
  const mine = lw != null
    ? lw === row.worker_id
    : (await db.query(`SELECT 1 FROM public.workers WHERE id = $1 AND telegram_chat_id = $2`, [row.worker_id, chatId])).rows.length > 0;
  if (!mine) {
    await db.query(`UPDATE ref.answers SET await_name = false, pending_source = NULL WHERE id = $1`, [row.id]);
    await send(chatId, t.other_worker);
    return null;
  }
  return { row, t, dl };
}

async function saveAnswer(row, chatId, from, source, text) {
  await db.query(
    `UPDATE ref.answers
        SET status = 'answered', source = $2, referrer_text = $3, answered_at = now(),
            answered_chat_id = $4, answered_tg_user = $5, await_name = false, pending_source = NULL, manual_by = NULL,
            match_state = CASE WHEN source IS DISTINCT FROM $2 OR referrer_text IS DISTINCT FROM $3 THEN 'none' ELSE match_state END,
            match_worker_id = CASE WHEN source IS DISTINCT FROM $2 OR referrer_text IS DISTINCT FROM $3 THEN NULL ELSE match_worker_id END,
            match_coordinator_id = CASE WHEN source IS DISTINCT FROM $2 OR referrer_text IS DISTINCT FROM $3 THEN NULL ELSE match_coordinator_id END,
            updated_at = now()
      WHERE id = $1`,
    [row.id, source, text, chatId, from && from.id ? from.id : null]);
  await logTg(row.worker_id, chatId, from, "answer", null, row.id);
}
async function thanks(chatId, t, row, label, dl) {
  await send(chatId, fmt(t.thanks, { v: esc(label), dl: ddmm(dl) }), [[{ text: t.edit, callback_data: `RF_E_${row.id}` }]]);
}

// Після питання 1 — одразу питання 2–6 (анкета care «start»)
async function afterQ1(row, chatId) {
  const r = (await db.query(`SELECT * FROM ref.answers WHERE id = $1`, [row.id])).rows[0] || row;
  await startSurvey(r, chatId);
}

// ── Питання 2–6 пакета — анкета care «start» ─────────────────────────
// Створюється один раз на прийом, одразу після відповіді на питання 1.
async function startSurvey(row, chatId) {
  if (!row.ext || !(await startOn())) return false;
  // відповіді анкети бот приймає тільки з Telegram у картці працівника — туди й надсилаємо;
  // якщо там інший чат, анкету надішле планувальник (крок 4) з перевіркою власника
  const w = (await db.query(`SELECT telegram_chat_id FROM public.workers WHERE id = $1`, [row.worker_id])).rows[0];
  if (!w || String(w.telegram_chat_id) !== String(chatId)) return false;
  // уже була (у т.ч. до виправлення дати BHP імпортом) — не повторюємо
  const was = await db.query(
    `SELECT 1 FROM care.survey_sends s JOIN ref.answers a ON a.id = $1
      WHERE s.worker_id = a.worker_id AND s.survey_code = 'start' AND abs(s.bhp_date - a.bhp_date) <= 14 LIMIT 1`, [row.id]);
  if (was.rows.length) return false;
  const ins = await db.query(
    `INSERT INTO care.survey_sends (survey_code, worker_id, bhp_date, facility_id, site_key, coordinator_id, region_id,
                                   planned_for, status, lang)
     SELECT 'start', a.worker_id, a.bhp_date, a.facility_id, h.site_key, o.coordinator_id, o.region_id, ref.today(), 'planned', a.lang
       FROM ref.answers a
       LEFT JOIN ref.v_hires h ON h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date
       LEFT JOIN reg.site_owner o ON o.site_key = h.site_key AND o.valid_to IS NULL
      WHERE a.id = $1 AND care.is_on(o.coordinator_id)        -- координатора об'єкта вимкнули в Rozmowy — не надсилаємо
     ON CONFLICT (worker_id, survey_code, bhp_date) DO NOTHING
     RETURNING id`, [row.id]);
  if (!ins.rows[0]) return false;                     // уже надсилали
  const care = require("./care");
  if (BOT) care.setBot(BOT);
  return care.startSurveyNow(ins.rows[0].id, chatId);
}

// ── Кнопки ────────────────────────────────────────────────────────────
async function onCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = String(cq.data || "");
  const ack = () => BOT && BOT.telegram.answerCbQuery(cq.id).catch(() => {});
  const m = data.match(/^RF_([SET])_(\d+)(?:_(\w+))?$/);
  if (!m || !chatId) return ack();
  const r = await db.query(`SELECT * FROM ref.answers WHERE id = $1`, [Number(m[2])]);
  if (!r.rows[0]) return ack();
  const g = await guard(r.rows[0], chatId, cq.from);
  await ack();
  if (!g) return;
  const { row, t, dl } = g;
  // прибрати кнопки з попереднього повідомлення
  if (cq.message && cq.message.message_id) {
    BOT.telegram.editMessageReplyMarkup(chatId, cq.message.message_id, undefined, { inline_keyboard: [] }).catch(() => {});
  }
  if (m[1] === "T") {
    // «на скільки приїхали» — кнопки старих повідомлень (до пакета); тепер це питання 6 анкети «start»
    const v = m[3];
    if (!STAYS.includes(v)) return;
    await db.query(`UPDATE ref.answers SET stay_plan = $2, stay_at = now(), updated_at = now() WHERE id = $1`, [row.id, v]);
    await send(chatId, fmt(t.stay_saved, { v: t["stay_" + v] }));
    if (row.status === "answered") await startSurvey({ ...row, stay_plan: v }, chatId);
    return;
  }
  if (m[1] === "E") {
    // попередня відповідь лишається, поки працівник не дасть нову
    await db.query(`UPDATE ref.answers SET await_name = false, pending_source = NULL, updated_at = now() WHERE id = $1`, [row.id]);
    await send(chatId, row.ext ? t.ask_x : t.ask, askKeyboard(t, row.id, row.ext));
    return;
  }
  const src = m[3];
  if (!(row.ext ? SOURCES_X : SOURCES).includes(src)) return;
  if (src === "friend" || src === "coord") {
    // ще без імені: уже записана відповідь не стирається (pending_source)
    await db.query(
      `UPDATE ref.answers SET pending_source = $2, await_name = true, sent_chat_id = $3, updated_at = now(),
              source = CASE WHEN status = 'answered' THEN source ELSE $2 END
        WHERE id = $1`,
      [row.id, src, chatId]);
    await send(chatId, src === "friend" ? t.name_friend : t.name_coord);
    return;
  }
  await saveAnswer(row, chatId, cq.from, src, null);
  await thanks(chatId, t, row, srcLabel(t, src, row.ext), dl);
  await afterQ1(row, chatId);
}

// ── Текст (ім'я) ─────────────────────────────────────────────────────
const RETRIED = new Set();
const COMMANDS = new Set(["0000", "9999", "/9999", "/start", "/lang", "lang"]);
function looksLikeName(s) {
  if (!s || s.length > 100 || s.startsWith("/")) return false;
  if (COMMANDS.has(s.replace(/\s+/g, "").toLowerCase())) return false;
  if (/\d/.test(s)) return false;          // ID працівника (GG342209), години — не ім'я
  return (s.match(/\p{L}/gu) || []).length >= 2;
}
function cleanName(s) {
  return s.replace(/[\u0000-\u001f]/g, " ").replace(/[^\p{L}\p{M}\s'’\-.]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
async function onText(update) {
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  const r = await db.query(
    `SELECT * FROM ref.answers WHERE await_name AND sent_chat_id = $1 ORDER BY updated_at DESC, id DESC LIMIT 1`, [chatId]);
  const row0 = r.rows[0];
  if (!row0 || !looksLikeName(text)) return false;
  const g = await guard(row0, chatId, msg.from);
  if (!g) return true;
  const { row, t, dl } = g;
  const src = row.pending_source || row.source;
  if (src !== "friend" && src !== "coord") {
    await db.query(`UPDATE ref.answers SET await_name = false WHERE id = $1`, [row.id]);
    return false;
  }
  const name = cleanName(text);
  const words = name.split(" ").filter((w) => (w.match(/\p{L}/gu) || []).length >= 2);
  if (words.length < 2 && !RETRIED.has(row.id)) {
    RETRIED.add(row.id);
    await send(chatId, t.two_words);
    return true;
  }
  RETRIED.delete(row.id);
  await saveAnswer(row, chatId, msg.from, src, name);
  await thanks(chatId, t, row, `${srcLabel(t, src, row.ext)}: ${name}`, dl);
  await afterQ1(row, chatId);
  return true;
}

// ══════════════════════════════════════════════════════════════════════
//  Тест (Rozmowy → 🧪 Test → «Pakiet startowy»): весь пакет собі в Telegram —
//  так, як його бачить новий працівник. Кнопки й ім'я працюють, але нічого
//  не записується (care.test_msgs, кнопки RF_X_…, питання 2–6 — тестові SV_X_…).
// ══════════════════════════════════════════════════════════════════════
const TOAST = { uk: "🧪 Тест: нічого не записано", ru: "🧪 Тест: ничего не записано", pl: "🧪 Test: nic nie zapisano", en: "🧪 Test: nothing saved" };
function testKeyboard(t, id, ext) {
  return askKeyboard(t, id, ext).map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data.replace(/^RF_S_\d+_/, `RF_X_${id}_S_`) })));
}
function careTest() {
  const care = require("./care");
  if (BOT) care.setBot(BOT);
  return care._testApi;
}
async function testDeadline() {
  const st = await settings();
  return ddmm(addDaysISO((await today()).d, Number(st.window_days) || 5));
}
// Викликає bot/care.js (sendTestSet) — ctx того ж тесту
async function testPackage(ctx, wl) {
  const api = careTest();
  const lang = TX[wl] ? wl : "uk";
  const t = TX[lang];
  return api.tSend(ctx, "ref_ask", lang, t.ask_x, (id) => testKeyboard(t, id, true), { ext: true });
}
// Подяка за питання 1; потім — питання 2–6 (крім повторної відповіді через «змінити»)
async function testThanks(api, ctx, lang, askId, again, label) {
  const t = TX[langOf(lang)];
  await api.tSend(ctx, "info", lang, fmt(t.thanks, { v: esc(label), dl: await testDeadline() }),
    () => [[{ text: t.edit, callback_data: `RF_X_${askId}_E` }]]);
  if (!again) await api.testSurvey(ctx, "start", lang);
}
async function onTestCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const ack = (txt) => BOT && BOT.telegram.answerCbQuery(cq.id, txt || "").catch(() => {});
  const m = String(cq.data || "").match(/^RF_X_(\d+)_([SE])(?:_(\w+))?$/);
  if (!m || !chatId) return ack();
  const api = careTest();
  await api.ensureTestTable();
  const row = (await db.query(`SELECT * FROM care.test_msgs WHERE id = $1`, [Number(m[1])])).rows[0];
  if (!row || String(row.chat_id) !== String(chatId)) return ack();
  const lang = langOf(row.lang);
  const t = TX[lang];
  const p = row.payload || {};
  const ext = !!p.ext;
  const ctx = { chat: chatId, coordId: row.coordinator_id, by: row.sent_by, sent: 0 };
  if (m[2] === "E") {
    await ack();
    return api.tSend(ctx, "ref_ask", lang, ext ? t.ask_x : t.ask, (id) => testKeyboard(t, id, ext), { ext, again: true });
  }
  const src = m[3];
  if (!(ext ? SOURCES_X : SOURCES).includes(src)) return ack();
  // подвійне натискання — один раз (інакше пакет 2–6 прийшов би двічі)
  const once = await db.query(`UPDATE care.test_msgs SET payload = payload || '{"done": true}'::jsonb WHERE id = $1 AND NOT (payload ? 'done') RETURNING id`, [row.id]);
  if (!once.rows.length) return ack();
  await ack(TOAST[lang] || TOAST.uk);
  if (cq.message.message_id) BOT.telegram.editMessageReplyMarkup(chatId, cq.message.message_id, undefined, { inline_keyboard: [] }).catch(() => {});
  if (src === "friend" || src === "coord") {
    await db.query(`UPDATE care.test_msgs SET payload = payload || '{"await": false}'::jsonb WHERE chat_id = $1 AND kind = 'ref_name'`, [chatId]);
    return api.tSend(ctx, "ref_name", lang, src === "friend" ? t.name_friend : t.name_coord, null, { await: true, src, ext, ask: row.id, again: !!p.again });
  }
  return testThanks(api, ctx, lang, row.id, !!p.again, srcLabel(t, src, ext));
}
// Тестове ім'я: true — оброблено
const TEST_RETRIED = new Set();
async function onTestText(chatId, text) {
  let row;
  try {
    row = (await db.query(
      `SELECT * FROM care.test_msgs WHERE chat_id = $1 AND kind = 'ref_name' AND payload->>'await' = 'true'
          AND sent_at > now() - interval '2 hours' ORDER BY id DESC LIMIT 1`, [chatId])).rows[0];
  } catch (e) { return false; }                       // немає таблиці тестів
  if (!row || !looksLikeName(text)) return false;
  const api = careTest();
  const lang = langOf(row.lang);
  const t = TX[lang];
  const p = row.payload;
  const ctx = { chat: chatId, coordId: row.coordinator_id, by: row.sent_by, sent: 0 };
  const name = cleanName(text);
  const words = name.split(" ").filter((w) => (w.match(/\p{L}/gu) || []).length >= 2);
  if (words.length < 2 && !TEST_RETRIED.has(row.id)) {
    TEST_RETRIED.add(row.id);
    await api.tSend(ctx, "info", lang, t.two_words);
    return true;
  }
  TEST_RETRIED.delete(row.id);
  await db.query(`UPDATE care.test_msgs SET payload = payload || '{"await": false}'::jsonb WHERE id = $1`, [row.id]);
  await testThanks(api, ctx, lang, p.ask, !!p.again, `${srcLabel(t, p.src, p.ext)}: ${name}`);
  return true;
}

async function guardStartSurvey(cq) {
  const sendId = Number(String(cq.data).split("_")[1]);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  let s;
  try {
    s = (await db.query(`SELECT id, worker_id, to_char(bhp_date, 'YYYY-MM-DD') AS bhp, survey_code FROM care.survey_sends WHERE id = $1`, [sendId])).rows[0];
  } catch (e) { return false; }
  if (!s || s.survey_code !== "start") return false;
  const coord = await coordByChat(chatId, cq.from && cq.from.id);
  if (!coord) return false;
  const a = (await db.query(`SELECT * FROM ref.answers WHERE worker_id = $1 AND bhp_date = $2::date`, [s.worker_id, s.bhp])).rows[0];
  if (a) await db.query(`UPDATE ref.answers SET blocked_attempts = blocked_attempts + 1, updated_at = now() WHERE id = $1`, [a.id]);
  await logTg(s.worker_id, chatId, cq.from, "blocked", coord.id, a ? a.id : null);
  if (BOT) BOT.telegram.answerCbQuery(cq.id).catch(() => {});
  await send(chatId, TX[langOf(a && a.lang)].blocked);
  return true;
}

// ── Вебхук ────────────────────────────────────────────────────────────
// true — оновлення оброблене тут, далі не передавати
async function onUpdate(bot, update) {
  if (bot) BOT = bot;
  try {
    if (update.callback_query && /^RF_X_/.test(String(update.callback_query.data || ""))) {
      await onTestCallback(update.callback_query);          // тест з панелі — нічого не записується
      return true;
    }
    if (update.callback_query && /^RF_/.test(String(update.callback_query.data || ""))) {
      await onCallback(update.callback_query);
      return true;
    }
    // анкета «start»: з Telegram координатора відповіді не приймаються (далі — bot/care.js)
    if (update.callback_query && /^SV_\d+_/.test(String(update.callback_query.data || ""))) {
      return await guardStartSurvey(update.callback_query);
    }
    if (update.message && update.message.chat && update.message.chat.type === "private" && typeof update.message.text === "string") {
      if (await onTestText(update.message.chat.id, String(update.message.text).trim())) return true;
      return await onText(update);
    }
  } catch (e) {
    console.error("[ref] onUpdate", e.message);
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
//  Планувальник: перше надсилання, нагадування, закриття
// ══════════════════════════════════════════════════════════════════════
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
let RUNNING = false;
// opt.hm — лише для тестів (підставити годину «HH:MM»)
async function tick(opt) {
  if (RUNNING || !BOT) return;
  RUNNING = true;
  try {
    const st = await settings();
    const win = Number(st.window_days) || 5;
    const remindMax = Math.max(0, Number(st.remind_max) || 0);
    // 0) імпорт міг змінити дату BHP — перенести відповіді
    await relink();
    // 1) після дедлайну — закрито
    await db.query(
      `UPDATE ref.answers SET status = 'expired', await_name = false, pending_source = NULL, updated_at = now()
        WHERE status = 'sent' AND bhp_date + $1::int < ref.today()`, [win]);
    await db.query(
      `UPDATE ref.answers SET await_name = false, pending_source = NULL
        WHERE status = 'answered' AND (await_name OR pending_source IS NOT NULL) AND bhp_date + $1::int < ref.today()`, [win]);
    if (!(await startOn())) return;                    // пакет вимкнений у Rozmowy → Ustawienia
    const now = await today();
    const nowMin = hm((opt && opt.hm) || now.hm);
    const day = nowMin >= 8 * 60 && nowMin < 20 * 60;           // уночі не пишемо
    const remindAt = hm(st.remind_time) ?? 600;
    // Telegram «належить» працівнику: не координатор і останній вхід з нього — цей працівник
    const chatOk = (chat, wid) => `
            NOT EXISTS (SELECT 1 FROM public.coordinators c WHERE c.telegram_chat_id = ${chat})
        AND NOT EXISTS (SELECT 1 FROM (SELECT l.worker_id FROM ref.tg_log l WHERE l.chat_id = ${chat} AND l.event = 'login'
                                        ORDER BY l.at DESC, l.id DESC LIMIT 1) z WHERE z.worker_id <> ${wid})`;
    // 2) перше надсилання тим, хто вже в боті (вийшов на роботу, а пакета ще не було) — лише об'єкти в пакеті
    if (day) {
      const fresh = await db.query(
        `SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, h.facility_id, h.site_key, w.telegram_chat_id AS chat
           FROM ref.v_hires h JOIN public.workers w ON w.id = h.worker_id
          WHERE h.bhp_date >= $1::date AND h.bhp_date <= ref.today() AND ref.today() <= h.bhp_date + $2::int
            AND w.telegram_chat_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ref.answers a WHERE a.worker_id = h.worker_id AND a.bhp_date = h.bhp_date)
            AND ${PKG_SQL("h.site_key")}
            AND ${chatOk("w.telegram_chat_id", "h.worker_id")}`,
        [st.start_date || "2000-01-01", win]);
      for (const x of fresh.rows) {
        const lang = await workerLang(x.worker_id);
        const row = await ensureRow(x.worker_id, x, x.chat, lang, true);   // PKG_SQL уже перевірено в запиті
        if (row && row.ext && row.status === "sent" && !row.sends) await sendAsk(row, x.chat, false);
      }
    }
    // старі рядки без відповіді (4 кнопки, до пакета) на об'єктах у пакеті — переходять у пакет
    await db.query(
      `UPDATE ref.answers a SET ext = true, updated_at = now() FROM ref.v_hires h
        WHERE a.status = 'sent' AND NOT a.ext AND a.manual_by IS NULL AND h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date
          AND ref.today() <= a.bhp_date + $1::int AND ${PKG_SQL("h.site_key")}`, [win]);
    // 3) нагадування питання 1 — раз на день після remind_time, з дня BHP, не більше remind_max;
    //    сюди ж — повтор першого питання, якщо воно не дійшло (sends = 0)
    if (day && nowMin >= remindAt) {
      const due = await db.query(
        `SELECT a.*
           FROM ref.answers a
          WHERE a.status = 'sent' AND a.ext
            AND a.sent_chat_id IS NOT NULL
            AND (a.reminders < $1::int OR a.sends = 0)
            AND a.bhp_date <= ref.today() AND ref.today() <= a.bhp_date + $2::int
            AND (COALESCE(a.last_try_at, a.last_sent_at) IS NULL
                 OR (COALESCE(a.last_try_at, a.last_sent_at) AT TIME ZONE 'Europe/Warsaw')::date < ref.today())
            AND EXISTS (SELECT 1 FROM ref.v_hires h WHERE h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date AND ${PKG_SQL("h.site_key")})
            AND ${chatOk("a.sent_chat_id", "a.worker_id")}`,
        [remindMax, win]);
      for (const row of due.rows) await sendAsk(row, row.sent_chat_id, row.sends > 0);
    }
    // 4) питання 2–6: не надіслані (напр. питання 1 відповіли з іншого Telegram) — надіслати;
    //    не закінчені — нагадування раз на день упродовж start_remind_days днів
    if (day) {
      const late = await db.query(
        `SELECT a.*, w.telegram_chat_id AS chat FROM ref.answers a JOIN public.workers w ON w.id = a.worker_id
          WHERE a.ext AND a.status = 'answered' AND a.manual_by IS NULL AND w.telegram_chat_id IS NOT NULL
            AND ref.today() <= a.bhp_date + $1::int
            AND EXISTS (SELECT 1 FROM ref.v_hires h WHERE h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date AND ${PKG_SQL("h.site_key")})
            AND NOT EXISTS (SELECT 1 FROM care.survey_sends s WHERE s.worker_id = a.worker_id AND s.survey_code = 'start'
                               AND abs(s.bhp_date - a.bhp_date) <= 14)
            AND ${chatOk("w.telegram_chat_id", "a.worker_id")}`, [win]);
      for (const row of late.rows) await startSurvey(row, row.chat);
      if (nowMin >= remindAt) {
        const days = Math.max(0, Number(st.start_remind_days) || 0);
        const rem = await db.query(
          `SELECT s.id, w.telegram_chat_id AS chat
             FROM care.survey_sends s JOIN public.workers w ON w.id = s.worker_id
            WHERE s.survey_code = 'start' AND s.status = 'sent' AND w.telegram_chat_id IS NOT NULL AND care.is_on(s.coordinator_id)
              AND (s.sent_at AT TIME ZONE 'Europe/Warsaw')::date < ref.today()
              AND ref.today() <= (s.sent_at AT TIME ZONE 'Europe/Warsaw')::date + $1::int
              AND (s.reminded_at IS NULL OR (s.reminded_at AT TIME ZONE 'Europe/Warsaw')::date < ref.today())
              AND ${chatOk("w.telegram_chat_id", "s.worker_id")}`, [days]);
        if (rem.rows.length) {
          const care = require("./care");
          care.setBot(BOT);
          for (const x of rem.rows) await care.remindSurveyNow(x.id, x.chat);
        }
      }
    }
  } catch (e) {
    console.error("[ref] tick", e.message);
  } finally {
    RUNNING = false;
  }
}
function schedule(bot) {
  BOT = bot;
  setTimeout(tick, 45 * 1000);
  setInterval(tick, 5 * 60 * 1000);
}
function setBot(bot) { BOT = bot; }

module.exports = { onUpdate, onLogin, schedule, setBot, tick, settings, resetSettingsCache, startOn, inPackage, PKG_SQL, TX, SOURCES_X, STAYS,
  testPackage,
  _test: { looksLikeName, cleanName } };
