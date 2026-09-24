// ══════════════════════════════════════════════════════════════════════
//  Розділ «Rozmowy»: завдання координаторам на розмову, оцінка новачків,
//  анкети працівникам, вибіркова перевірка розмов.
//
//  Підключення:
//    index.js       →  require("./bot/care").schedule(bot);
//    handlers.js    →  у callback_query одразу після `if (!chatId) return;`
//                      if (/^(CR_|SV_|SC_)/.test(payload)) { await require("./care").handleCallback(bot, cq); return; }
//
//  Уся логіка відбору людей — у SQL (care.risk_scores / build_tasks / plan_day),
//  тут тільки розсилки, кнопки і запис відповідей.
// ══════════════════════════════════════════════════════════════════════
const db = require("../db");

let BOT = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Дати (локальний час сервера) ──────────────────────────────────────
function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function ddmm(v) {
  const d = v instanceof Date ? v : new Date(v);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function hhmm(d = new Date()) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Налаштування ─────────────────────────────────────────────────────
async function settings() {
  const r = await db.query(`SELECT key, value FROM care.settings`);
  const s = {};
  for (const x of r.rows) s[x.key] = Number(x.value);
  return s;
}

// ── Telegram ─────────────────────────────────────────────────────────
async function tgSend(chatId, text, extra = {}) {
  if (!BOT || !chatId) return { ok: false, error: "no bot/chat" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const msg = await BOT.telegram.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });
      await sleep(40);
      return { ok: true, messageId: msg.message_id };
    } catch (e) {
      const code = e?.response?.error_code;
      const retry = e?.response?.parameters?.retry_after;
      if (code === 429 && retry) {
        await sleep((retry + 1) * 1000);
        continue;
      }
      console.error("[care] send", chatId, e.message);
      return { ok: false, code, error: e.message };
    }
  }
  return { ok: false, code: 429, error: "rate limited" };
}

async function tgEdit(chatId, messageId, text, keyboard = null) {
  if (!BOT || !chatId || !messageId) return false;
  try {
    await BOT.telegram.editMessageText(chatId, messageId, undefined, text, {
      parse_mode: "HTML",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] },
    });
    return true;
  } catch (e) {
    if (/not modified/i.test(e.message)) return true;
    console.error("[care] edit", chatId, messageId, e.message);
    return false;
  }
}

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });

// ══════════════════════════════════════════════════════════════════════
//  Тексти для координаторів (uk / ru / pl)
// ══════════════════════════════════════════════════════════════════════
const TC = {
  uk: {
    head: (n) => `📋 <b>Розмови на сьогодні: ${n}</b>`,
    head_tip: "Після розмови натисніть одну кнопку під людиною — це все, що потрібно.",
    moved: (d) => `⤵️ перенесено в список ${d}`,
    day: (n) => `${n}-й день`,
    why: "Чому",
    ask: "Спитайте",
    survey_block: "Анкета",
    manual: "Доручення",
    urgent: "🔔 <b>Тривожна відповідь в анкеті — поговоріть сьогодні</b>",
    btn: { S: "✅ Залишається", P: "⚠️ Є проблема", L: "🚪 Хоче піти", N: "📵 Не додзвонився", B: "↩️ Назад", U: "↩️ Змінити" },
    prob: { housing: "🏠 Житло", money: "💰 Гроші", schedule: "🕐 Графік / години", team: "👥 Колектив", transport: "🚌 Дорога", other: "✏️ Інше" },
    pick_problem: "Яка проблема?",
    out: { stays: "✅ Залишається", problem: "⚠️ Проблема", leaving: "🚪 Хоче піти", no_answer: "📵 Не додзвонився" },
    closed: (label, t) => `<b>Закрито:</b> ${label} · ${t}`,
    reasons: {
      assess_bad: () => "ваша оцінка 👎",
      assess_mid: () => "ваша оцінка 😐",
      survey: () => "тривожна відповідь в анкеті",
      streak: (n) => `${n} NN поспіль`,
      nn: (n) => `${n}× NN за 2 тижні`,
      gap: (n) => `${n} дн. без годин`,
      drop: (v) => { const [a, b] = v.split("/"); return `годин за тиждень ${a} (було ${b})`; },
      pre80: () => "скоро 80 днів",
      new: () => "новачок",
      site_red: () => "обʼєкт червоний",
      manual: () => "доручення",
    },
    hints: {
      survey: "що саме не так і чим допомогти",
      assess_bad: "що змінилось, чи хоче працювати далі",
      assess_mid: "що заважає влитися",
      streak: "чому не виходить на роботу, що заважає",
      nn: "чому пропускає зміни",
      gap: "чи працює зараз, чому не вносить години",
      drop: "чи влаштовує кількість годин",
      pre80: "плани після 80 днів, що може втримати",
      new: "житло, дорога, чи пояснили роботу",
      site_red: "умови на обʼєкті",
    },
    assess_q: (name, site, n) => `🌱 Як вливається <b>${name}</b>?\n${site} · ${n}-й день`,
    assess_btn: { 3: "👍 Добре", 2: "😐 Так собі", 1: "👎 Погано" },
    assess_done: (name, v) => `🌱 <b>${name}</b>: ${{ 3: "👍", 2: "😐", 1: "👎" }[v]}`,
    esc_head: (n) => `⏰ <b>Не закриті розмови понад ${n} роб. дні</b>`,
    esc_coord: (n, d) => `⏰ Незакритих розмов понад ${d} роб. дні: ${n}. Регіонального повідомлено.`,
    leaving: (name, site, n, coord) => `🚪 <b>${name}</b> (${site}, ${n}-й день) хоче піти.\nКоординатор: ${coord}.\nЧи можна втримати?`,
    not_yours: "Це не ваше завдання",
    already: "Вже закрито",
    saved: "Збережено",
    too_late: "Змінити можна лише протягом доби",
    cancelled: "скасовано — модуль вимкнено",
  },
  ru: {
    head: (n) => `📋 <b>Разговоры на сегодня: ${n}</b>`,
    head_tip: "После разговора нажмите одну кнопку под человеком — больше ничего не нужно.",
    moved: (d) => `⤵️ перенесено в список ${d}`,
    day: (n) => `${n}-й день`,
    why: "Почему",
    ask: "Спросите",
    survey_block: "Анкета",
    manual: "Поручение",
    urgent: "🔔 <b>Тревожный ответ в анкете — поговорите сегодня</b>",
    btn: { S: "✅ Остаётся", P: "⚠️ Есть проблема", L: "🚪 Хочет уйти", N: "📵 Не дозвонился", B: "↩️ Назад", U: "↩️ Изменить" },
    prob: { housing: "🏠 Жильё", money: "💰 Деньги", schedule: "🕐 График / часы", team: "👥 Коллектив", transport: "🚌 Дорога", other: "✏️ Другое" },
    pick_problem: "Какая проблема?",
    out: { stays: "✅ Остаётся", problem: "⚠️ Проблема", leaving: "🚪 Хочет уйти", no_answer: "📵 Не дозвонился" },
    closed: (label, t) => `<b>Закрыто:</b> ${label} · ${t}`,
    reasons: {
      assess_bad: () => "ваша оценка 👎",
      assess_mid: () => "ваша оценка 😐",
      survey: () => "тревожный ответ в анкете",
      streak: (n) => `${n} NN подряд`,
      nn: (n) => `${n}× NN за 2 недели`,
      gap: (n) => `${n} дн. без часов`,
      drop: (v) => { const [a, b] = v.split("/"); return `часов за неделю ${a} (было ${b})`; },
      pre80: () => "скоро 80 дней",
      new: () => "новичок",
      site_red: () => "объект красный",
      manual: () => "поручение",
    },
    hints: {
      survey: "что именно не так и чем помочь",
      assess_bad: "что изменилось, хочет ли работать дальше",
      assess_mid: "что мешает влиться",
      streak: "почему не выходит на работу, что мешает",
      nn: "почему пропускает смены",
      gap: "работает ли сейчас, почему не вносит часы",
      drop: "устраивает ли количество часов",
      pre80: "планы после 80 дней, что может удержать",
      new: "жильё, дорога, объяснили ли работу",
      site_red: "условия на объекте",
    },
    assess_q: (name, site, n) => `🌱 Как вливается <b>${name}</b>?\n${site} · ${n}-й день`,
    assess_btn: { 3: "👍 Хорошо", 2: "😐 Так себе", 1: "👎 Плохо" },
    assess_done: (name, v) => `🌱 <b>${name}</b>: ${{ 3: "👍", 2: "😐", 1: "👎" }[v]}`,
    esc_head: (n) => `⏰ <b>Не закрытые разговоры дольше ${n} раб. дней</b>`,
    esc_coord: (n, d) => `⏰ Незакрытых разговоров дольше ${d} раб. дней: ${n}. Региональный уведомлён.`,
    leaving: (name, site, n, coord) => `🚪 <b>${name}</b> (${site}, ${n}-й день) хочет уйти.\nКоординатор: ${coord}.\nМожно ли удержать?`,
    not_yours: "Это не ваше задание",
    already: "Уже закрыто",
    saved: "Сохранено",
    too_late: "Изменить можно только в течение суток",
    cancelled: "отменено — модуль выключен",
  },
  pl: {
    head: (n) => `📋 <b>Rozmowy na dziś: ${n}</b>`,
    head_tip: "Po rozmowie naciśnij jeden przycisk pod osobą — to wszystko.",
    moved: (d) => `⤵️ przeniesione na listę ${d}`,
    day: (n) => `${n}. dzień`,
    why: "Dlaczego",
    ask: "Zapytaj",
    survey_block: "Ankieta",
    manual: "Zlecenie",
    urgent: "🔔 <b>Niepokojąca odpowiedź w ankiecie — porozmawiaj dziś</b>",
    btn: { S: "✅ Zostaje", P: "⚠️ Jest problem", L: "🚪 Chce odejść", N: "📵 Nie odebrał", B: "↩️ Wstecz", U: "↩️ Zmień" },
    prob: { housing: "🏠 Mieszkanie", money: "💰 Pieniądze", schedule: "🕐 Grafik / godziny", team: "👥 Zespół", transport: "🚌 Dojazd", other: "✏️ Inne" },
    pick_problem: "Jaki problem?",
    out: { stays: "✅ Zostaje", problem: "⚠️ Problem", leaving: "🚪 Chce odejść", no_answer: "📵 Nie odebrał" },
    closed: (label, t) => `<b>Zamknięte:</b> ${label} · ${t}`,
    reasons: {
      assess_bad: () => "twoja ocena 👎",
      assess_mid: () => "twoja ocena 😐",
      survey: () => "niepokojąca odpowiedź w ankiecie",
      streak: (n) => `${n} NN z rzędu`,
      nn: (n) => `${n}× NN w 2 tygodnie`,
      gap: (n) => `${n} dni bez godzin`,
      drop: (v) => { const [a, b] = v.split("/"); return `godzin w tygodniu ${a} (było ${b})`; },
      pre80: () => "zaraz 80 dni",
      new: () => "nowy",
      site_red: () => "obiekt czerwony",
      manual: () => "zlecenie",
    },
    hints: {
      survey: "co dokładnie jest nie tak i jak pomóc",
      assess_bad: "co się zmieniło, czy chce dalej pracować",
      assess_mid: "co przeszkadza się wdrożyć",
      streak: "dlaczego nie przychodzi, co przeszkadza",
      nn: "dlaczego opuszcza zmiany",
      gap: "czy teraz pracuje, dlaczego nie wpisuje godzin",
      drop: "czy liczba godzin mu odpowiada",
      pre80: "plany po 80 dniach, co może zatrzymać",
      new: "mieszkanie, dojazd, czy wyjaśniono pracę",
      site_red: "warunki na obiekcie",
    },
    assess_q: (name, site, n) => `🌱 Jak się wdraża <b>${name}</b>?\n${site} · ${n}. dzień`,
    assess_btn: { 3: "👍 Dobrze", 2: "😐 Średnio", 1: "👎 Źle" },
    assess_done: (name, v) => `🌱 <b>${name}</b>: ${{ 3: "👍", 2: "😐", 1: "👎" }[v]}`,
    esc_head: (n) => `⏰ <b>Niezamknięte rozmowy ponad ${n} dni robocze</b>`,
    esc_coord: (n, d) => `⏰ Niezamkniętych rozmów ponad ${d} dni robocze: ${n}. Regionalny został powiadomiony.`,
    leaving: (name, site, n, coord) => `🚪 <b>${name}</b> (${site}, ${n}. dzień) chce odejść.\nKoordynator: ${coord}.\nCzy da się zatrzymać?`,
    not_yours: "To nie jest twoje zadanie",
    already: "Już zamknięte",
    saved: "Zapisano",
    too_late: "Zmienić można tylko w ciągu doby",
    cancelled: "anulowane — moduł wyłączony",
  },
};
const tc = (lang) => TC[lang] || TC.uk;

// ── Тексти для працівників (uk / ru / pl / en) ───────────────────────
const TW = {
  uk: {
    thanks: "🙏 Дякуємо за відповіді! Якщо щось потрібно — пишіть своєму координатору.",
    thanks_flag: "🙏 Дякуємо! Координатор звʼяжеться з вами найближчим часом.",
    thanks_exit: "🙏 Дякуємо і успіхів! Будемо раді бачити вас знову.",
    remind: "⏰ Нагадуємо про коротку анкету — залишилось кілька кліків:",
    stale: "Ця анкета вже закрита",
    spot_q: "👋 Коротке питання: чи говорив з вами координатор протягом останніх днів?",
    spot_yes: "✅ Так", spot_no: "❌ Ні",
    spot_thanks: "Дякуємо!",
  },
  ru: {
    thanks: "🙏 Спасибо за ответы! Если что-то нужно — пишите своему координатору.",
    thanks_flag: "🙏 Спасибо! Координатор свяжется с вами в ближайшее время.",
    thanks_exit: "🙏 Спасибо и удачи! Будем рады видеть вас снова.",
    remind: "⏰ Напоминаем о короткой анкете — осталось несколько кликов:",
    stale: "Эта анкета уже закрыта",
    spot_q: "👋 Короткий вопрос: говорил ли с вами координатор в последние дни?",
    spot_yes: "✅ Да", spot_no: "❌ Нет",
    spot_thanks: "Спасибо!",
  },
  pl: {
    thanks: "🙏 Dziękujemy za odpowiedzi! Jeśli czegoś potrzebujesz — napisz do swojego koordynatora.",
    thanks_flag: "🙏 Dziękujemy! Koordynator wkrótce się z Tobą skontaktuje.",
    thanks_exit: "🙏 Dziękujemy i powodzenia! Chętnie zobaczymy Cię znowu.",
    remind: "⏰ Przypominamy o krótkiej ankiecie — zostało kilka kliknięć:",
    stale: "Ta ankieta jest już zamknięta",
    spot_q: "👋 Krótkie pytanie: czy koordynator rozmawiał z Tobą w ostatnich dniach?",
    spot_yes: "✅ Tak", spot_no: "❌ Nie",
    spot_thanks: "Dziękujemy!",
  },
  en: {
    thanks: "🙏 Thank you for your answers! If you need anything — message your coordinator.",
    thanks_flag: "🙏 Thank you! Your coordinator will contact you soon.",
    thanks_exit: "🙏 Thank you and good luck! We will be glad to see you again.",
    remind: "⏰ A reminder about the short survey — just a few taps left:",
    stale: "This survey is already closed",
    spot_q: "👋 Quick question: has your coordinator talked to you in the last few days?",
    spot_yes: "✅ Yes", spot_no: "❌ No",
    spot_thanks: "Thank you!",
  },
};
const tw = (lang) => TW[lang] || TW.uk;
const wLang = (l) => (["uk", "ru", "pl", "en"].includes(l) ? l : "uk");

// ══════════════════════════════════════════════════════════════════════
//  Повідомлення про завдання
// ══════════════════════════════════════════════════════════════════════
function reasonText(t, code) {
  const [k, v] = String(code).split(":");
  const f = t.reasons[k];
  return f ? f(v) : code;
}

function taskKeyboard(t, id) {
  return [
    [{ text: t.btn.S, callback_data: `CR_T_${id}_S` }, { text: t.btn.P, callback_data: `CR_T_${id}_P` }],
    [{ text: t.btn.L, callback_data: `CR_T_${id}_L` }, { text: t.btn.N, callback_data: `CR_T_${id}_N` }],
  ];
}
function problemKeyboard(t, id) {
  const codes = Object.keys(t.prob);
  const rows = [];
  for (let i = 0; i < codes.length; i += 2)
    rows.push(codes.slice(i, i + 2).map((c) => ({ text: t.prob[c], callback_data: `CR_T_${id}_P_${c}` })));
  rows.push([{ text: t.btn.B, callback_data: `CR_T_${id}_B` }]);
  return rows;
}

// Анкетні відповіді з прапорцем, які може бачити координатор
async function flaggedAnswers(workerId, lang) {
  const r = await db.query(
    `SELECT q.text->>$2 AS q, (SELECT o->'t'->>$2 FROM jsonb_array_elements(q.options) o WHERE o->>'c' = a.option_code) AS a
       FROM care.answers a
       JOIN care.survey_sends s ON s.id = a.send_id
       JOIN care.questions q ON q.id = a.question_id
      WHERE s.worker_id = $1 AND a.flag IS NOT NULL AND q.visibility = 'coordinator'
        AND a.answered_at > now() - INTERVAL '21 days'
      ORDER BY a.answered_at DESC, q.sort LIMIT 4`,
    [workerId, lang === "pl" ? "pl" : lang === "ru" ? "ru" : "uk"],
  );
  return r.rows;
}

async function loadTask(id) {
  const r = await db.query(
    `SELECT t.*, w.full_name, w.login, w.telegram_chat_id AS worker_chat,
            a.bhp_date, (care.today() - a.bhp_date)::int AS tenure,
            c.full_name AS coord_name, c.telegram_chat_id AS coord_chat, COALESCE(c.lang::text, 'uk') AS coord_lang
       FROM care.tasks t
       JOIN public.workers w ON w.id = t.worker_id
       LEFT JOIN care.v_active a ON a.worker_id = t.worker_id
       LEFT JOIN public.coordinators c ON c.id = t.coordinator_id
      WHERE t.id = $1`,
    [id],
  );
  return r.rows[0] || null;
}

async function taskText(task, lang) {
  const t = tc(lang);
  const lines = [];
  if (task.kind === "survey" && task.status === "open") lines.push(t.urgent);
  lines.push(`👤 <b>${esc(task.full_name)}</b>${task.login ? " · ID " + esc(task.login) : ""}`);
  lines.push(`🏭 ${esc(task.site_key || "—")}${task.tenure != null ? " · " + t.day(task.tenure) : ""}`);
  const reasons = (task.reasons || []).filter((x) => x !== "manual");
  if (reasons.length) lines.push(`${t.why}: ${reasons.slice(0, 4).map((x) => reasonText(t, x)).join("; ")}`);
  const hints = [];
  for (const x of reasons) {
    const h = t.hints[String(x).split(":")[0]];
    if (h && !hints.includes(h)) hints.push(h);
    if (hints.length >= 2) break;
  }
  if (hints.length) lines.push(`${t.ask}: ${hints.join("; ")}`);
  if (reasons.includes("survey")) {
    const ans = task._answers || await flaggedAnswers(task.worker_id, lang);
    if (ans.length) lines.push(`📝 ${t.survey_block}:\n` + ans.map((x) => `• ${esc(x.q)} → <b>${esc(x.a)}</b>`).join("\n"));
  }
  if (task.kind === "manual" && task.comment && task.status === "open") lines.push(`📝 ${t.manual}: ${esc(task.comment)}`);
  if (task.status === "done") {
    const label = t.out[task.outcome] + (task.problem_code ? ` — ${t.prob[task.problem_code] || esc(task.problem_code)}` : "");
    lines.push("", t.closed(label, `${ddmm(task.done_at)} ${hhmm(new Date(task.done_at))}`));
  }
  return lines.join("\n");
}

async function sendTask(task, chatId, lang) {
  const text = await taskText(task, lang);
  const r = await tgSend(chatId, text, kb(taskKeyboard(tc(lang), task.id)));
  if (r.ok)
    await db.query(`UPDATE care.tasks SET sent_at = now(), tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`,
      [task.id, chatId, r.messageId]);
  return r.ok;
}

// ── Ранкова розсилка координатору ────────────────────────────────────
async function sendMorningTo(coord, day) {
  const lang = coord.lang || "uk";
  const t = tc(lang);
  const tasks = await db.query(
    `SELECT id FROM care.tasks WHERE coordinator_id = $1 AND status = 'open'
      ORDER BY priority, score DESC NULLS LAST, id`,
    [coord.id],
  );
  const assess = await db.query(
    `SELECT a.id, a.day_mark, a.site_key, w.full_name
       FROM care.assessments a JOIN public.workers w ON w.id = a.worker_id
      WHERE a.coordinator_id = $1 AND a.value IS NULL AND a.sent_at IS NULL
        AND a.requested_at > now() - INTERVAL '7 days'
      ORDER BY a.day_mark, w.full_name`,
    [coord.id],
  );
  if (!tasks.rows.length && !assess.rows.length) return { tasks: 0, assess: 0 };
  if (!coord.telegram_chat_id) return { tasks: tasks.rows.length, assess: assess.rows.length, noChat: true };

  let sent = 0;
  const todayStart = new Date(`${day}T00:00:00`);
  const toSend = [];
  for (const row of tasks.rows) {
    const task = await loadTask(row.id);
    if (task.sent_at && new Date(task.sent_at) >= todayStart) continue;     // вже надіслано сьогодні
    toSend.push(task);
  }
  if (toSend.length) {
    await tgSend(coord.telegram_chat_id, `${t.head(tasks.rows.length)}\n${t.head_tip}`);
    for (const task of toSend) {
      // вчорашнє повідомлення — прибрати кнопки, щоб усі відкриті були внизу одним списком
      if (task.tg_message_id && task.tg_chat_id) {
        await tgEdit(task.tg_chat_id, task.tg_message_id,
          (await taskText(task, lang)) + `\n\n<i>${t.moved(ddmm(day))}</i>`);
      }
      if (await sendTask(task, coord.telegram_chat_id, lang)) sent++;
    }
  }
  for (const a of assess.rows) {
    const r = await tgSend(coord.telegram_chat_id, t.assess_q(esc(a.full_name), esc(a.site_key || "—"), a.day_mark),
      kb([[3, 2, 1].map((v) => ({ text: t.assess_btn[v], callback_data: `CR_A_${a.id}_${v}` }))]));
    if (r.ok)
      await db.query(`UPDATE care.assessments SET sent_at = now(), tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`,
        [a.id, coord.telegram_chat_id, r.messageId]);
  }
  return { tasks: tasks.rows.length, sent, assess: assess.rows.length };
}

async function runMorning(day) {
  const built = await db.query(`SELECT care.build_tasks($1::date) AS n`, [day]);
  const coords = await db.query(
    `SELECT c.id, c.full_name, c.telegram_chat_id, COALESCE(c.lang::text, 'uk') AS lang
       FROM public.coordinators c
      WHERE c.is_active AND care.is_on(c.id)
        AND (EXISTS (SELECT 1 FROM care.tasks t WHERE t.coordinator_id = c.id AND t.status = 'open')
                          OR EXISTS (SELECT 1 FROM care.assessments a WHERE a.coordinator_id = c.id AND a.value IS NULL AND a.sent_at IS NULL))`,
  );
  let sent = 0;
  for (const c of coords.rows) {
    const r = await sendMorningTo(c, day);
    sent += r.sent || 0;
  }
  console.log(`[care] morning ${day}: new tasks ${built.rows[0].n}, sent ${sent} to ${coords.rows.length} coordinators`);
  return { built: built.rows[0].n, sent, coordinators: coords.rows.length };
}

// Термінові (після тривожної анкети) — одразу, не чекаючи ранку
// Спершу «забираємо» завдання (sent_at), потім шлемо — без дублів і без повторів щохвилини.
// Не вдалося надіслати — завдання однаково в панелі, а вранці прийде ще раз.
async function sendUrgent() {
  const r = await db.query(
    `UPDATE care.tasks SET sent_at = now()
      WHERE status = 'open' AND priority = 0 AND sent_at IS NULL
        AND (coordinator_id IS NULL OR care.is_on(coordinator_id)) RETURNING id`,
  );
  for (const x of r.rows) {
    const task = await loadTask(x.id);
    let ok = false;
    if (task.coord_chat) ok = await sendTask(task, task.coord_chat, task.coord_lang);
    else for (const l of await leadChats(task.region_id)) ok = (await sendTask(task, l.telegram_chat_id, l.lang)) || ok;
    if (!ok) console.error(`[care] urgent task ${x.id}: not delivered`);
  }
  return r.rows.length;
}

// ══════════════════════════════════════════════════════════════════════
//  Закриття завдання (з бота і з панелі)
// ══════════════════════════════════════════════════════════════════════
async function leadChats(regionId) {
  const r = await db.query(
    `SELECT DISTINCT c.telegram_chat_id, COALESCE(c.lang::text, 'uk') AS lang FROM reg.region_leads rl
       JOIN public.coordinators c ON c.id = rl.coordinator_id AND c.is_active
      WHERE rl.region_id = $1 AND c.telegram_chat_id IS NOT NULL`,
    [regionId],
  );
  if (regionId && r.rows.length) return r.rows;
  const a = await db.query(
    `SELECT DISTINCT c.telegram_chat_id, COALESCE(c.lang::text, 'uk') AS lang FROM public.coordinator_auth ca
       JOIN public.coordinators c ON c.id = ca.coordinator_id
      WHERE ca.is_admin AND c.is_active AND c.telegram_chat_id IS NOT NULL`,
  );
  return a.rows;
}

async function closeTask(id, outcome, problemCode, byCoordId, via, comment = null) {
  const OUT = { S: "stays", P: "problem", L: "leaving", N: "no_answer" };
  const o = OUT[outcome] || outcome;
  if (!["stays", "problem", "leaving", "no_answer"].includes(o)) throw new Error("bad outcome");
  const r = await db.query(
    `UPDATE care.tasks SET status = 'done', outcome = $2, problem_code = $3, done_at = now(), done_by = $4,
            done_via = $5, comment = COALESCE($6, comment)
      WHERE id = $1 AND status IN ('open','missed') RETURNING id`,
    [id, o, o === "problem" ? problemCode || "other" : null, byCoordId, via, comment],
  );
  if (!r.rows.length) return null;
  const task = await loadTask(id);

  // вибіркова перевірка в працівника
  if (["stays", "problem"].includes(o) && task.worker_chat) {
    const s = await settings();
    if (Math.random() < (s.spot_check_share ?? 0.1)) {
      await db.query(
        `INSERT INTO care.spot_checks (task_id, worker_id, coordinator_id, ask_after)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4::int)) ON CONFLICT (task_id) DO NOTHING`,
        [id, task.worker_id, task.coordinator_id, s.spot_check_delay_hours ?? 24],
      );
    }
  }
  // «хоче піти» — регіональному одразу
  if (o === "leaving" && !task.leaving_sent_at) {
    let ok = false;
    for (const l of await leadChats(task.region_id)) {
      const t = tc(l.lang);
      ok = (await tgSend(l.telegram_chat_id,
        t.leaving(esc(task.full_name), esc(task.site_key || "—"), task.tenure ?? "?", esc(task.coord_name || "—")))).ok || ok;
    }
    if (ok) await db.query(`UPDATE care.tasks SET leaving_sent_at = now() WHERE id = $1`, [id]);
  }
  // повідомлення в Telegram — показати, що закрито
  if (task.tg_chat_id && task.tg_message_id) {
    const t = tc(task.coord_lang);
    await tgEdit(task.tg_chat_id, task.tg_message_id, await taskText(task, task.coord_lang),
      [[{ text: t.btn.U, callback_data: `CR_T_${id}_U` }]]);
  }
  return task;
}

async function reopenTask(id) {
  const r = await db.query(
    `UPDATE care.tasks SET status = 'open', outcome = NULL, problem_code = NULL, done_at = NULL, done_by = NULL, done_via = NULL
      WHERE id = $1 AND status = 'done' AND done_at > now() - INTERVAL '24 hours'
        AND NOT EXISTS (SELECT 1 FROM care.tasks x WHERE x.worker_id = care.tasks.worker_id AND x.status = 'open')
      RETURNING id`,
    [id],
  );
  if (!r.rows.length) return false;
  await db.query(`DELETE FROM care.spot_checks WHERE task_id = $1 AND status = 'planned'`, [id]);
  return true;
}

async function rateAssessment(id, value, byCoordId) {
  const r = await db.query(
    `UPDATE care.assessments SET value = $2, answered_at = now(), answered_by = $3
      WHERE id = $1 RETURNING id, tg_chat_id, tg_message_id, worker_id`,
    [id, value, byCoordId],
  );
  return r.rows[0] || null;
}

// ══════════════════════════════════════════════════════════════════════
//  Анкети
// ══════════════════════════════════════════════════════════════════════
function optionRows(q, lang, sendId) {
  const opts = q.options.map((o) => ({ text: o.t[lang] || o.t.uk, callback_data: `SV_${sendId}_${q.sort}_${o.c}` }));
  const total = opts.reduce((n, o) => n + [...o.text].length, 0);
  const scale = opts.filter((o) => /^\d/.test(o.text));
  if (scale.length === 5) return [scale, ...opts.filter((o) => !/^\d/.test(o.text)).map((o) => [o])]; // 1…5 в один рядок
  if (opts.length <= 3 && total <= 22) return [opts];                    // короткі — в один рядок
  if (opts.length <= 4) return opts.map((o) => [o]);                     // по одній у рядку
  const rows = [];
  for (let i = 0; i < opts.length; i += 2) rows.push(opts.slice(i, i + 2));
  return rows;
}

async function questionCount(code) {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM care.questions WHERE survey_code = $1`, [code]);
  return r.rows[0].n;
}

async function sendQuestion(send, sort, chatId) {
  const q = (await db.query(`SELECT * FROM care.questions WHERE survey_code = $1 AND sort = $2`, [send.survey_code, sort])).rows[0];
  if (!q) return { ok: false };
  const lang = wLang(send.lang);
  const n = await questionCount(send.survey_code);
  return tgSend(chatId, `<b>${esc(q.text[lang] || q.text.uk)}</b>  <i>(${sort}/${n})</i>`, kb(optionRows(q, lang, send.id)));
}

async function runSurveys(day) {
  await db.query(`SELECT * FROM care.plan_day($1::date)`, [day]);
  const r = await db.query(
    `SELECT s.*, w.telegram_chat_id, COALESCE(w.lang::text, w.session_data->>'lang', 'uk') AS wlang, sv.intro
       FROM care.survey_sends s
       JOIN public.workers w ON w.id = s.worker_id
       JOIN care.surveys sv ON sv.code = s.survey_code
      WHERE s.status = 'planned' AND s.planned_for <= $1::date AND care.is_on(s.coordinator_id)
      ORDER BY s.id`,
    [day],
  );
  let sent = 0, failed = 0;
  for (const s of r.rows) {
    if (!s.telegram_chat_id) {
      await db.query(`UPDATE care.survey_sends SET status = 'no_telegram' WHERE id = $1`, [s.id]);
      continue;
    }
    const lang = wLang(s.wlang);
    s.lang = lang;
    const first = (await db.query(`SELECT MIN(sort) AS m FROM care.questions WHERE survey_code = $1`, [s.survey_code])).rows[0].m;
    const a = await tgSend(s.telegram_chat_id, esc(s.intro[lang] || s.intro.uk));
    const b = a.ok ? await sendQuestion(s, first, s.telegram_chat_id) : a;
    if (b.ok) {
      sent++;
      await db.query(`UPDATE care.survey_sends SET status = 'sent', sent_at = now(), lang = $2, current_q = $3 WHERE id = $1`,
        [s.id, lang, first]);
    } else {
      failed++;
      await db.query(`UPDATE care.survey_sends SET status = 'failed', lang = $2 WHERE id = $1`, [s.id, lang]);
    }
  }
  // нагадування один раз
  const s = await settings();
  const rem = await db.query(
    `SELECT s.*, w.telegram_chat_id FROM care.survey_sends s JOIN public.workers w ON w.id = s.worker_id
      WHERE s.status = 'sent' AND s.reminded_at IS NULL AND s.sent_at < now() - make_interval(hours => $1::int)
        AND w.telegram_chat_id IS NOT NULL`,
    [s.survey_remind_hours ?? 24],
  );
  for (const x of rem.rows) {
    await tgSend(x.telegram_chat_id, tw(x.lang).remind);
    await sendQuestion(x, x.current_q, x.telegram_chat_id);
    await db.query(`UPDATE care.survey_sends SET reminded_at = now() WHERE id = $1`, [x.id]);
  }
  console.log(`[care] surveys ${day}: sent ${sent}, failed ${failed}, reminded ${rem.rows.length}`);
  return { sent, failed, reminded: rem.rows.length };
}

// Тривожна відповідь → завдання координатору з найвищим пріоритетом
async function taskFromSurvey(send) {
  const act = await db.query(
    `SELECT a.facility_id, a.site_key, o.coordinator_id, o.region_id
       FROM care.v_active a LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
      WHERE a.worker_id = $1`,
    [send.worker_id],
  );
  if (!act.rows.length) return null;
  const a = act.rows[0];
  // модуль вимкнений для координатора об'єкта — завдання не ставимо (відповідь піде в бал ризику)
  if (a.coordinator_id && !(await db.query(`SELECT care.is_on($1) AS on`, [a.coordinator_id])).rows[0].on) return null;
  const prev = (await db.query(`SELECT id FROM care.tasks WHERE worker_id = $1 AND status = 'open'`, [send.worker_id])).rows[0];
  const prevTask = prev ? await loadTask(prev.id) : null;
  const up = await db.query(
    `UPDATE care.tasks SET kind = 'survey', priority = 0,
            reasons = CASE WHEN 'survey' = ANY(reasons) THEN reasons ELSE array_prepend('survey', reasons) END,
            sent_at = NULL
      WHERE worker_id = $1 AND status = 'open' RETURNING id, tg_chat_id, tg_message_id`,
    [send.worker_id],
  );
  if (up.rows.length) {
    const old = up.rows[0];
    if (old.tg_chat_id && old.tg_message_id && prevTask)
      await tgEdit(old.tg_chat_id, old.tg_message_id, (await taskText(prevTask, prevTask.coord_lang)) + "\n\n⤵️");
    return old.id;
  }
  const ins = await db.query(
    `INSERT INTO care.tasks (worker_id, facility_id, site_key, coordinator_id, region_id, kind, priority, score, reasons)
     VALUES ($1, $2, $3, $4, $5, 'survey', 0,
             (SELECT score FROM care.risk_daily WHERE worker_id = $1 ORDER BY day DESC LIMIT 1),
             (SELECT array_prepend('survey', COALESCE((SELECT reasons FROM care.risk_daily WHERE worker_id = $1 ORDER BY day DESC LIMIT 1), '{}')))
             )
     ON CONFLICT DO NOTHING RETURNING id`,
    [send.worker_id, a.facility_id, a.site_key, a.coordinator_id, a.region_id],
  );
  return ins.rows[0]?.id || null;
}

async function onSurveyAnswer(cq, chatId, parts) {
  const [sendId, sort, ...rest] = parts;
  const code = rest.join("_");
  const answer = (text) => BOT.telegram.answerCbQuery(cq.id, text || "").catch(() => {});
  const s = (await db.query(
    `SELECT s.*, w.telegram_chat_id FROM care.survey_sends s JOIN public.workers w ON w.id = s.worker_id WHERE s.id = $1`,
    [sendId])).rows[0];
  if (!s || String(s.telegram_chat_id) !== String(chatId)) return answer();
  const lang = wLang(s.lang);
  if (s.status !== "sent") return answer(tw(lang).stale);
  const q = (await db.query(`SELECT * FROM care.questions WHERE survey_code = $1 AND sort = $2`, [s.survey_code, sort])).rows[0];
  const opt = q && q.options.find((o) => o.c === code);
  if (!opt) return answer();
  // захист від подвійного натискання: просуваємо тільки з поточного питання
  const next = (await db.query(`SELECT MIN(sort) AS m FROM care.questions WHERE survey_code = $1 AND sort > $2`, [s.survey_code, sort])).rows[0].m;
  const flagRank = { high: 2, low: 1 };
  const worst = (flagRank[opt.f] || 0) > (flagRank[s.flag] || 0) ? opt.f : s.flag;
  const adv = await db.query(
    `UPDATE care.survey_sends SET current_q = COALESCE($3, current_q), flag = $4,
            status = CASE WHEN $3::int IS NULL THEN 'done' ELSE status END,
            completed_at = CASE WHEN $3::int IS NULL THEN now() ELSE completed_at END
      WHERE id = $1 AND current_q = $2 AND status = 'sent' RETURNING id`,
    [s.id, sort, next, worst],
  );
  if (!adv.rows.length) return answer();
  await db.query(
    `INSERT INTO care.answers (send_id, question_id, option_code, flag) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [s.id, q.id, code, opt.f || null],
  );
  await answer();
  await tgEdit(chatId, cq.message.message_id, `${esc(q.text[lang] || q.text.uk)}\n→ <b>${esc(opt.t[lang] || opt.t.uk)}</b>`);

  const isExit = (await db.query(`SELECT day_offset FROM care.surveys WHERE code = $1`, [s.survey_code])).rows[0]?.day_offset == null;
  const cfg = await settings();
  const tasksOn = cfg.tasks_enabled !== 0;
  // тривожна відповідь — завдання координатору одразу, не чекаючи кінця анкети (один раз на анкету)
  if (opt.f === "high" && !isExit && tasksOn) {
    const mine = await db.query(`UPDATE care.survey_sends SET task_id = 0 WHERE id = $1 AND task_id IS NULL RETURNING id`, [s.id]);
    if (mine.rows.length) {
      const taskId = await taskFromSurvey(s);
      await db.query(`UPDATE care.survey_sends SET task_id = $2 WHERE id = $1`, [s.id, taskId || 0]);
      const h = new Date().getHours();
      if (taskId && h >= 8 && h < 21) await sendUrgent();
    }
  }
  if (next) {
    await sendQuestion({ ...s, lang }, next, chatId);
    return;
  }
  if (isExit) await tgSend(chatId, tw(lang).thanks_exit);
  else await tgSend(chatId, worst === "high" && tasksOn ? tw(lang).thanks_flag : tw(lang).thanks);
}

// ══════════════════════════════════════════════════════════════════════
//  Вибіркова перевірка, ескалація
// ══════════════════════════════════════════════════════════════════════
async function runSpotChecks() {
  const r = await db.query(
    `SELECT sc.id, w.telegram_chat_id, COALESCE(w.lang::text, w.session_data->>'lang', 'uk') AS lang
       FROM care.spot_checks sc JOIN public.workers w ON w.id = sc.worker_id
      WHERE sc.status = 'planned' AND sc.ask_after <= now() ORDER BY sc.ask_after LIMIT 50`,
  );
  for (const x of r.rows) {
    if (!x.telegram_chat_id) {
      await db.query(`UPDATE care.spot_checks SET status = 'skipped' WHERE id = $1`, [x.id]);
      continue;
    }
    const t = tw(wLang(x.lang));
    const s = await tgSend(x.telegram_chat_id, t.spot_q,
      kb([[{ text: t.spot_yes, callback_data: `SC_${x.id}_Y` }, { text: t.spot_no, callback_data: `SC_${x.id}_N` }]]));
    await db.query(`UPDATE care.spot_checks SET status = $2, asked_at = now() WHERE id = $1`, [x.id, s.ok ? "asked" : "skipped"]);
  }
  return r.rows.length;
}

async function runEscalation(day) {
  const s = await settings();
  const n = s.escalate_bdays ?? 2;
  const r = await db.query(
    `SELECT t.id, t.region_id, t.coordinator_id, c.full_name AS coord, c.telegram_chat_id AS coord_chat,
            COALESCE(c.lang::text, 'uk') AS coord_lang, w.full_name AS worker, t.created_at
       FROM care.tasks t
       JOIN public.workers w ON w.id = t.worker_id
       LEFT JOIN public.coordinators c ON c.id = t.coordinator_id
      WHERE t.status = 'open' AND t.escalated_at IS NULL AND care.bdays(care.ldate(t.created_at), $1::date) >= $2
      ORDER BY c.full_name, t.created_at`,
    [day, n],
  );
  if (!r.rows.length) return 0;
  const byRegion = new Map();
  const byCoord = new Map();
  for (const x of r.rows) {
    const k = x.region_id || 0;
    if (!byRegion.has(k)) byRegion.set(k, new Map());
    const m = byRegion.get(k);
    const ck = x.coord || "—";
    if (!m.has(ck)) m.set(ck, []);
    m.get(ck).push(x);
    if (x.coord_chat) {
      if (!byCoord.has(x.coord_chat)) byCoord.set(x.coord_chat, { lang: x.coord_lang, n: 0 });
      byCoord.get(x.coord_chat).n++;
    }
  }
  // одне повідомлення на кожного отримувача, навіть якщо в нього кілька регіонів
  const perChat = new Map();
  for (const [regionId, m] of byRegion) {
    for (const l of await leadChats(regionId || null)) {
      if (!perChat.has(l.telegram_chat_id)) perChat.set(l.telegram_chat_id, { lang: l.lang, lines: [] });
      for (const [coord, list] of m.entries())
        perChat.get(l.telegram_chat_id).lines.push(
          `• <b>${esc(coord)}</b>: ${list.length} — ${list.slice(0, 5).map((x) => esc(x.worker)).join(", ")}${list.length > 5 ? "…" : ""}`);
    }
  }
  for (const [chat, v] of perChat) {
    // Telegram приймає до 4096 символів — довгий список ділимо
    let buf = tc(v.lang).esc_head(n);
    for (const line of v.lines) {
      if (buf.length + line.length > 3500) { await tgSend(chat, buf); buf = ""; }
      buf += (buf ? "\n" : "") + line;
    }
    if (buf) await tgSend(chat, buf);
  }
  for (const [chat, v] of byCoord) await tgSend(chat, tc(v.lang).esc_coord(v.n, n));
  await db.query(`UPDATE care.tasks SET escalated_at = now() WHERE id = ANY($1::int[])`, [r.rows.map((x) => x.id)]);
  console.log(`[care] escalated ${r.rows.length} tasks`);
  return r.rows.length;
}

// ══════════════════════════════════════════════════════════════════════
//  Кнопки
// ══════════════════════════════════════════════════════════════════════
async function coordByChat(chatId) {
  const r = await db.query(
    `SELECT c.id, c.full_name, COALESCE(c.lang::text, 'uk') AS lang, COALESCE(bool_or(ca.is_admin), false) AS is_admin
       FROM public.coordinators c LEFT JOIN public.coordinator_auth ca ON ca.coordinator_id = c.id
      WHERE c.telegram_chat_id = $1 AND c.is_active GROUP BY c.id`,
    [chatId],
  );
  return r.rows[0] || null;
}

async function canHandle(coord, coordinatorId, regionId) {
  if (!coord) return false;
  if (coord.is_admin || coord.id === coordinatorId) return true;
  if (!regionId) return false;
  const r = await db.query(`SELECT 1 FROM reg.region_leads WHERE region_id = $1 AND coordinator_id = $2`, [regionId, coord.id]);
  return r.rows.length > 0;
}

async function handleCallback(bot, cq) {
  if (bot) BOT = bot;
  const chatId = cq.message?.chat?.id;
  const payload = String(cq.data || "");
  const answer = (text) => BOT.telegram.answerCbQuery(cq.id, text || "").catch(() => {});
  try {
    const parts = payload.split("_");
    if (parts[1] === "X") return await onTestCallback(cq, chatId, parts);   // тестовий набір
    if (parts[0] === "SV") return await onSurveyAnswer(cq, chatId, parts.slice(1));

    if (parts[0] === "SC") {
      const [, id, v] = parts;
      const r = await db.query(
        `UPDATE care.spot_checks sc SET answer = $2, answered_at = now(), status = 'answered'
           FROM public.workers w
          WHERE sc.id = $1 AND w.id = sc.worker_id AND w.telegram_chat_id = $3 AND sc.status = 'asked'
          RETURNING COALESCE(w.lang::text, w.session_data->>'lang', 'uk') AS lang`,
        [id, v === "Y" ? "yes" : "no", chatId],
      );
      await answer();
      if (r.rows.length) {
        const t = tw(wLang(r.rows[0].lang));
        await tgEdit(chatId, cq.message.message_id, `${t.spot_q}\n→ <b>${v === "Y" ? t.spot_yes : t.spot_no}</b>\n\n${t.spot_thanks}`);
      }
      return;
    }

    // CR_* — координатор
    const coord = await coordByChat(chatId);
    const t = tc(coord?.lang);
    if (parts[1] === "A") {
      const [, , id, v] = parts;
      const a = (await db.query(`SELECT a.*, w.full_name, o.region_id FROM care.assessments a JOIN public.workers w ON w.id = a.worker_id
                                   LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL WHERE a.id = $1`, [id])).rows[0];
      if (!a) return answer();
      if (!(await canHandle(coord, a.coordinator_id, a.region_id))) return answer(t.not_yours);
      await rateAssessment(id, parseInt(v, 10), coord.id);
      await answer(t.saved);
      await tgEdit(chatId, cq.message.message_id, t.assess_done(esc(a.full_name), v));
      return;
    }
    if (parts[1] === "T") {
      const [, , id, action, sub] = parts;
      const task = await loadTask(id);
      if (!task) return answer();
      if (!(await canHandle(coord, task.coordinator_id, task.region_id))) return answer(t.not_yours);
      const msgId = cq.message.message_id;
      if (action === "U") {
        if (!(await reopenTask(id))) return answer(t.too_late);
        await answer();
        const fresh = await loadTask(id);
        await tgEdit(chatId, msgId, await taskText(fresh, coord.lang), taskKeyboard(t, id));
        await db.query(`UPDATE care.tasks SET tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`, [id, chatId, msgId]);
        return;
      }
      if (task.status !== "open" && task.status !== "missed") return answer(t.already);
      if (!["S", "P", "L", "N", "B"].includes(action) || (sub && !TC.uk.prob[sub])) return answer();
      if (action === "P" && !sub) {
        await answer();
        await tgEdit(chatId, msgId, (await taskText(task, coord.lang)) + `\n\n<b>${t.pick_problem}</b>`, problemKeyboard(t, id));
        return;
      }
      if (action === "B") {
        await answer();
        await tgEdit(chatId, msgId, await taskText(task, coord.lang), taskKeyboard(t, id));
        return;
      }
      // натиснули в іншому чаті (регіональний/адмін) — оновлюємо саме це повідомлення
      if (String(task.tg_chat_id) !== String(chatId) || String(task.tg_message_id) !== String(msgId))
        await db.query(`UPDATE care.tasks SET tg_chat_id = $2, tg_message_id = $3 WHERE id = $1`, [id, chatId, msgId]);
      const done = await closeTask(id, action, sub || null, coord.id, "telegram");
      await answer(done ? t.saved : t.already);
      return;
    }
    return answer();
  } catch (e) {
    console.error("[care] callback", payload, e.message);
    return answer();
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Планувальник
// ══════════════════════════════════════════════════════════════════════
// Щоденна задача виконується один раз. Якщо процес упав посеред роботи (перезапуск, помилка),
// через 15 хвилин її можна взяти знову: уже надіслане не повториться (sent_at).
async function claim(job, day) {
  const r = await db.query(
    `INSERT INTO care.job_runs (job, day) VALUES ($1, $2::date)
     ON CONFLICT (job, day) DO UPDATE SET ran_at = now()
       WHERE care.job_runs.finished_at IS NULL AND care.job_runs.ran_at < now() - INTERVAL '15 minutes'
     RETURNING job`,
    [job, day],
  );
  return r.rows.length > 0;
}

async function once(job, day, fn) {
  if (!(await claim(job, day))) return;
  try {
    await fn();
    await db.query(`UPDATE care.job_runs SET finished_at = now() WHERE job = $1 AND day = $2::date`, [job, day]);
  } catch (e) {
    console.error(`[care] ${job}`, e.message);   // повтор — через 15 хв, у межах вікна задачі
  }
}

let busy = false;
async function tick(now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    const s = await settings();
    const day = localISO(now);
    const h = now.getHours();
    const dow = now.getDay(); // 0 нд … 6 сб
    const workday = (dow >= 1 && dow <= 5) || (dow === 6 && s.task_saturday === 1);

    if (h >= 5) await once("nightly", day, async () => {
      const r = await db.query(`SELECT care.take_risk($1::date) AS n`, [day]);
      const p = await db.query(`SELECT * FROM care.plan_day($1::date)`, [day]);
      console.log(`[care] nightly ${day}: risk ${r.rows[0].n}, plan`, p.rows[0]);
    });
    const th = s.task_hour ?? 8;
    const tasksOn = s.tasks_enabled !== 0;
    // ранкова розсилка — тільки в перші 3 години після task_hour (після встановлення вдень чекає до ранку)
    if (tasksOn && workday && h >= th && h < th + 3) await once("morning", day, () => runMorning(day));
    if (tasksOn && workday && h >= 10 && h < 20) await once("escalate", day, () => runEscalation(day));
    if (s.surveys_enabled !== 0 && h >= (s.survey_hour ?? 18) && h < 21) await once("surveys", day, () => runSurveys(day));
    if (h >= 10 && h < 20) await runSpotChecks();
    if (tasksOn && h >= 8 && h < 21) await sendUrgent();
  } catch (e) {
    console.error("[care] tick", e.message);
  } finally {
    busy = false;
  }
}

function schedule(bot) {
  BOT = bot;
  setTimeout(() => tick(), 15 * 1000);
  setInterval(() => tick(), 60 * 1000);
}

function setBot(bot) { BOT = bot; }

// Модуль вимкнули координатору: відкриті завдання знімаємо і прибираємо кнопки в Telegram
async function cancelForCoordinators(ids) {
  if (!ids.length) return 0;
  const r = await db.query(
    `UPDATE care.tasks SET status = 'cancelled'
      WHERE status = 'open' AND coordinator_id = ANY($1::int[]) RETURNING id, tg_chat_id, tg_message_id`,
    [ids],
  );
  // заплановані, але ще не надіслані анкети на його об'єктах — теж не надсилаємо
  await db.query(`UPDATE care.survey_sends SET status = 'expired' WHERE status = 'planned' AND coordinator_id = ANY($1::int[])`, [ids]);
  for (const x of r.rows) {
    if (!x.tg_chat_id || !x.tg_message_id) continue;
    const task = await loadTask(x.id);
    await tgEdit(x.tg_chat_id, x.tg_message_id, (await taskText(task, task.coord_lang)) + `\n\n<i>${tc(task.coord_lang).cancelled}</i>`);
  }
  return r.rows.length;
}

// Доручення з панелі — одразу в Telegram координатору
async function sendTaskNow(id) {
  const task = await loadTask(id);
  if (!task || task.status !== "open" || !task.coord_chat) return false;
  return sendTask(task, task.coord_chat, task.coord_lang);
}

// Оцінку поставили в панелі — прибрати кнопки в Telegram
async function refreshAssessmentMsg(id) {
  const a = (await db.query(
    `SELECT a.value, a.tg_chat_id, a.tg_message_id, w.full_name, COALESCE(c.lang::text, 'uk') AS lang
       FROM care.assessments a JOIN public.workers w ON w.id = a.worker_id
       LEFT JOIN public.coordinators c ON c.id = a.coordinator_id WHERE a.id = $1`, [id])).rows[0];
  if (!a || !a.value || !a.tg_message_id) return false;
  return tgEdit(a.tg_chat_id, a.tg_message_id, tc(a.lang).assess_done(esc(a.full_name), a.value));
}


// ══════════════════════════════════════════════════════════════════════
//  Тестовий набір: усі повідомлення модуля — вибраному координатору,
//  з робочими кнопками, але БЕЗ запису в завдання, анкети чи статистику.
//  Кнопки мають вигляд CR_X_… / SV_X_… / SC_X_…; потім усе можна прибрати з чату.
// ══════════════════════════════════════════════════════════════════════
const TEST_ITEMS = {
  coordinator: ["morning", "urgent", "manual", "assess", "esc_coord", "lead_leaving", "lead_esc"],
  worker: ["d3", "d14", "d30", "d60", "exit", "remind", "spot"],
};
const TT = {
  uk: { mark: "🧪 ТЕСТ — нічого не записується", coordPart: "🧪 <b>Тест Rozmowy.</b> Далі — повідомлення, які отримує координатор. Кнопки працюють, але нічого не записується.",
        workerPart: (l) => `🧪 <b>Далі — як це бачить працівник</b> (мова анкет: ${l}). Відповідайте кнопками, щоб пройти анкету.`,
        leadNote: "так це бачить регіональний", gone: "🧪 тест прибрано", toast: "🧪 Тест: нічого не записано",
        toastLeaving: "🧪 Тест: у робочому режимі регіональний отримав би повідомлення" },
  ru: { mark: "🧪 ТЕСТ — ничего не записывается", coordPart: "🧪 <b>Тест Rozmowy.</b> Дальше — сообщения, которые получает координатор. Кнопки работают, но ничего не записывается.",
        workerPart: (l) => `🧪 <b>Дальше — как это видит работник</b> (язык анкет: ${l}). Отвечайте кнопками, чтобы пройти анкету.`,
        leadNote: "так это видит региональный", gone: "🧪 тест убран", toast: "🧪 Тест: ничего не записано",
        toastLeaving: "🧪 Тест: в рабочем режиме региональный получил бы сообщение" },
  pl: { mark: "🧪 TEST — nic nie jest zapisywane", coordPart: "🧪 <b>Test Rozmowy.</b> Dalej — wiadomości, które dostaje koordynator. Przyciski działają, ale nic nie jest zapisywane.",
        workerPart: (l) => `🧪 <b>Dalej — tak to widzi pracownik</b> (język ankiet: ${l}). Odpowiadaj przyciskami, żeby przejść ankietę.`,
        leadNote: "tak to widzi regionalny", gone: "🧪 test usunięty", toast: "🧪 Test: nic nie zapisano",
        toastLeaving: "🧪 Test: w trybie roboczym regionalny dostałby wiadomość" },
  en: { mark: "🧪 TEST — nothing is saved", coordPart: "🧪 <b>Rozmowy test.</b>", workerPart: (l) => `🧪 <b>How the worker sees it</b> (${l}).`,
        leadNote: "as the regional lead sees it", gone: "🧪 test removed", toast: "🧪 Test: nothing saved", toastLeaving: "🧪 Test" },
};
const tt = (l) => TT[l] || TT.uk;
const LANG_NAME = { uk: "українська", ru: "русский", pl: "polski", en: "English" };

let testTableReady = false;
async function ensureTestTable() {
  if (testTableReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS care.test_msgs (
      id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, coordinator_id INT, kind TEXT NOT NULL, lang TEXT,
      message_id BIGINT, payload JSONB NOT NULL DEFAULT '{}', sent_by INT, sent_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  testTableReady = true;
}

// Надіслати одне тестове повідомлення; keyboardFn(id) будує кнопки з id запису
async function tSend(ctx, kind, lang, text, keyboardFn = null, payload = {}) {
  const row = (await db.query(
    `INSERT INTO care.test_msgs (chat_id, coordinator_id, kind, lang, payload, sent_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ctx.chat, ctx.coordId, kind, lang, JSON.stringify(payload), ctx.by])).rows[0];
  const body = kind === "part" ? text : `<i>${tt(lang).mark}</i>\n${text}`;   // заголовки розділів — без позначки
  const r = await tgSend(ctx.chat, body, keyboardFn ? kb(keyboardFn(row.id)) : {});
  if (r.ok) await db.query(`UPDATE care.test_msgs SET message_id = $2 WHERE id = $1`, [row.id, r.messageId]);
  else await db.query(`DELETE FROM care.test_msgs WHERE id = $1`, [row.id]);
  ctx.sent += r.ok ? 1 : 0;
  await sleep(250);   // не більше ~4 повідомлень на секунду в один чат
  return r.ok ? row.id : null;
}

function fakeTask(kind, lang, site, extra = {}) {
  const base = {
    id: 0, worker_id: null, kind, status: "open", priority: kind === "survey" ? 0 : kind === "manual" ? 1 : 5,
    full_name: "TEST OKSANA", login: "TEST001", site_key: site, tenure: 64,
    reasons: ["streak:2", "nn:3", "drop:18/42", "pre80:64"], comment: null,
  };
  return { ...base, ...extra };
}
function testTaskKeyboard(t, id) {
  return [
    [{ text: t.btn.S, callback_data: `CR_X_${id}_S` }, { text: t.btn.P, callback_data: `CR_X_${id}_P` }],
    [{ text: t.btn.L, callback_data: `CR_X_${id}_L` }, { text: t.btn.N, callback_data: `CR_X_${id}_N` }],
  ];
}
function testProblemKeyboard(t, id) {
  const codes = Object.keys(t.prob);
  const rows = [];
  for (let i = 0; i < codes.length; i += 2)
    rows.push(codes.slice(i, i + 2).map((c) => ({ text: t.prob[c], callback_data: `CR_X_${id}_P_${c}` })));
  rows.push([{ text: t.btn.B, callback_data: `CR_X_${id}_B` }]);
  return rows;
}

async function sendTestTask(ctx, lang, task) {
  const t = tc(lang);
  return tSend(ctx, "task", lang, await taskText(task, lang), (id) => testTaskKeyboard(t, id), { task });
}

async function testQuestion(ctx, sid, survey, sort, lang) {
  const q = (await db.query(`SELECT * FROM care.questions WHERE survey_code = $1 AND sort = $2`, [survey, sort])).rows[0];
  if (!q) return null;
  const n = await questionCount(survey);
  const opts = optionRows(q, lang, 0).map((row) => row.map((b) => {
    const code = b.callback_data.split("_").slice(3).join("_");
    return { text: b.text, callback_data: `SV_X_${sid}_${sort}_${code}` };
  }));
  return tSend(ctx, "survey_q", lang, `<b>${esc(q.text[lang] || q.text.uk)}</b>  <i>(${sort}/${n})</i>`, () => opts, { sid, sort });
}

async function testSurvey(ctx, code, wlang, withReminder = false) {
  const sv = (await db.query(`SELECT * FROM care.surveys WHERE code = $1`, [code])).rows[0];
  if (!sv) return;
  const first = (await db.query(`SELECT MIN(sort) AS m FROM care.questions WHERE survey_code = $1`, [code])).rows[0].m;
  if (!first) return;
  // «сесія» анкети: тут зберігається, на якому питанні людина
  const sid = await tSend(ctx, "survey", wlang, withReminder ? tw(wlang).remind : esc(sv.intro[wlang] || sv.intro.uk), null,
    { survey: code, q: first, flag: null, isExit: sv.day_offset == null });
  if (sid) await testQuestion(ctx, sid, code, first, wlang);
}

// Головна: надіслати вибране вибраним координаторам
async function sendTestSet({ coordinatorIds, items, coordLang = "profile", workerLang = "uk", by = null }) {
  await ensureTestTable();
  const coords = (await db.query(
    `SELECT c.id, c.full_name, c.telegram_chat_id, COALESCE(c.lang::text, 'uk') AS lang,
            (SELECT o.site_key FROM reg.site_owner o WHERE o.coordinator_id = c.id AND o.valid_to IS NULL ORDER BY o.site_key LIMIT 1) AS site
       FROM public.coordinators c WHERE c.id = ANY($1::int[])`, [coordinatorIds])).rows;
  const want = new Set(items);
  const result = [];
  for (const c of coords) {
    if (!c.telegram_chat_id) { result.push({ id: c.id, name: c.full_name, sent: 0, error: "no_telegram" }); continue; }
    const lang = ["uk", "ru", "pl"].includes(coordLang) ? coordLang : (["uk", "ru", "pl"].includes(c.lang) ? c.lang : "uk");
    const wl = ["uk", "ru", "pl", "en"].includes(workerLang) ? workerLang : "uk";
    const t = tc(lang);
    const site = c.site || "HYDRO LODZ";
    const ctx = { chat: c.telegram_chat_id, coordId: c.id, by, sent: 0 };
    const coordItems = TEST_ITEMS.coordinator.filter((k) => want.has(k));
    const workerItems = TEST_ITEMS.worker.filter((k) => want.has(k));
    try {
      if (coordItems.length) await tSend(ctx, "part", lang, tt(lang).coordPart);
      if (want.has("morning")) {
        await tSend(ctx, "info", lang, `${t.head(2)}\n${t.head_tip}`);
        await sendTestTask(ctx, lang, fakeTask("risk", lang, site));
        await sendTestTask(ctx, lang, fakeTask("risk", lang, site, { full_name: "TEST PETRO", login: "TEST002", tenure: 11, reasons: ["gap:4", "new:11"] }));
      }
      if (want.has("urgent")) {
        const sq = (await db.query(`SELECT text, options FROM care.questions WHERE survey_code = 'd3' AND code = 'housing3'`)).rows[0];
        const no = sq && sq.options.find((o) => o.c === "no");
        await sendTestTask(ctx, lang, fakeTask("survey", lang, site, {
          tenure: 3, reasons: ["survey", "new:3"],
          _answers: sq ? [{ q: sq.text[lang] || sq.text.uk, a: no.t[lang] || no.t.uk }] : [],
        }));
      }
      if (want.has("manual")) {
        const note = { uk: "скарга бригадира на запізнення", ru: "жалоба бригадира на опоздания", pl: "skarga brygadzisty na spóźnienia" }[lang];
        await sendTestTask(ctx, lang, fakeTask("manual", lang, site, { reasons: ["manual", "nn:1"], comment: note, tenure: 40 }));
      }
      if (want.has("assess")) {
        await tSend(ctx, "assess", lang, t.assess_q("TEST OKSANA", esc(site), 7),
          (id) => [[3, 2, 1].map((v) => ({ text: t.assess_btn[v], callback_data: `CR_X_${id}_A_${v}` }))], { name: "TEST OKSANA" });
      }
      if (want.has("esc_coord")) await tSend(ctx, "info", lang, t.esc_coord(2, 2));
      if (want.has("lead_leaving"))
        await tSend(ctx, "info", lang, `<i>(${tt(lang).leadNote})</i>\n` + t.leaving("TEST OKSANA", esc(site), 64, esc(c.full_name)));
      if (want.has("lead_esc"))
        await tSend(ctx, "info", lang, `<i>(${tt(lang).leadNote})</i>\n${t.esc_head(2)}\n• <b>${esc(c.full_name)}</b>: 2 — TEST OKSANA, TEST PETRO`);

      if (workerItems.length) await tSend(ctx, "part", lang, tt(lang).workerPart(LANG_NAME[wl]));
      for (const code of ["d3", "d14", "d30", "d60", "exit"]) if (want.has(code)) await testSurvey(ctx, code, wl);
      if (want.has("remind")) await testSurvey(ctx, "d14", wl, true);
      if (want.has("spot")) {
        const w = tw(wl);
        await tSend(ctx, "spot", wl, w.spot_q,
          (id) => [[{ text: w.spot_yes, callback_data: `SC_X_${id}_Y` }, { text: w.spot_no, callback_data: `SC_X_${id}_N` }]]);
      }
      result.push({ id: c.id, name: c.full_name, sent: ctx.sent });
    } catch (e) {
      console.error("[care] test", c.id, e.message);
      result.push({ id: c.id, name: c.full_name, sent: ctx.sent, error: e.message });
    }
  }
  return result;
}

// Кнопки в тестових повідомленнях — поводяться як справжні, але пишуть лише в test_msgs
async function onTestCallback(cq, chatId, parts) {
  const answer = (text) => BOT.telegram.answerCbQuery(cq.id, text || "").catch(() => {});
  await ensureTestTable();
  const [kind0, , idRaw, action, ...rest] = parts;
  const row = (await db.query(`SELECT * FROM care.test_msgs WHERE id = $1`, [idRaw])).rows[0];
  if (!row || String(row.chat_id) !== String(chatId)) return answer();
  const msgId = cq.message.message_id;
  const lang = row.lang || "uk";
  const mark = `<i>${tt(lang).mark}</i>\n`;

  if (kind0 === "CR" && action === "A") {                         // оцінка новачка
    const v = parseInt(rest[0], 10);
    await answer(tt(lang).toast);
    await tgEdit(chatId, msgId, mark + tc(lang).assess_done(esc(row.payload.name || "TEST"), v));
    return;
  }
  if (kind0 === "CR") {                                            // завдання
    const t = tc(lang);
    const task = row.payload.task;
    if (!task) return answer();
    const save = (tk) => db.query(`UPDATE care.test_msgs SET payload = $2 WHERE id = $1`, [row.id, JSON.stringify({ task: tk })]);
    if (action === "U") {
      Object.assign(task, { status: "open", outcome: null, problem_code: null, done_at: null });
      await save(task); await answer();
      return tgEdit(chatId, msgId, mark + await taskText(task, lang), testTaskKeyboard(t, row.id));
    }
    if (task.status !== "open") return answer(t.already);
    if (action === "P" && !rest.length) {
      await answer();
      return tgEdit(chatId, msgId, mark + (await taskText(task, lang)) + `\n\n<b>${t.pick_problem}</b>`, testProblemKeyboard(t, row.id));
    }
    if (action === "B") { await answer(); return tgEdit(chatId, msgId, mark + await taskText(task, lang), testTaskKeyboard(t, row.id)); }
    const OUT = { S: "stays", P: "problem", L: "leaving", N: "no_answer" };
    if (!OUT[action] || (rest.length && !t.prob[rest[0]])) return answer();
    Object.assign(task, { status: "done", outcome: OUT[action], problem_code: action === "P" ? rest[0] : null, done_at: new Date().toISOString() });
    await save(task);
    await answer(action === "L" ? tt(lang).toastLeaving : tt(lang).toast);
    return tgEdit(chatId, msgId, mark + await taskText(task, lang), [[{ text: t.btn.U, callback_data: `CR_X_${row.id}_U` }]]);
  }
  if (kind0 === "SC") {                                            // контрольне питання
    const w = tw(lang);
    await answer(tt(lang).toast);
    return tgEdit(chatId, msgId, `${mark}${w.spot_q}\n→ <b>${action === "Y" ? w.spot_yes : w.spot_no}</b>\n\n${w.spot_thanks}`);
  }
  if (kind0 === "SV") {                                            // анкета
    const sort = parseInt(action, 10);
    const code = rest.join("_");
    const st = row.payload;
    if (!st.survey || st.q !== sort) return answer(tw(lang).stale);
    const q = (await db.query(`SELECT * FROM care.questions WHERE survey_code = $1 AND sort = $2`, [st.survey, sort])).rows[0];
    const opt = q && q.options.find((o) => o.c === code);
    if (!opt) return answer();
    const next = (await db.query(`SELECT MIN(sort) AS m FROM care.questions WHERE survey_code = $1 AND sort > $2`, [st.survey, sort])).rows[0].m;
    const rank = { high: 2, low: 1 };
    st.flag = (rank[opt.f] || 0) > (rank[st.flag] || 0) ? opt.f : st.flag;
    st.q = next || -1;
    const upd = await db.query(`UPDATE care.test_msgs SET payload = $2 WHERE id = $1 AND (payload->>'q')::int = $3 RETURNING id`,
      [row.id, JSON.stringify(st), sort]);
    if (!upd.rows.length) return answer();
    await answer();
    await tgEdit(chatId, msgId, `${mark}${esc(q.text[lang] || q.text.uk)}\n→ <b>${esc(opt.t[lang] || opt.t.uk)}</b>`);
    const ctx = { chat: chatId, coordId: row.coordinator_id, by: row.sent_by, sent: 0 };
    if (next) return testQuestion(ctx, row.id, st.survey, next, lang);
    const w = tw(lang);
    return tSend(ctx, "info", lang, st.isExit ? w.thanks_exit : st.flag === "high" ? w.thanks_flag : w.thanks);
  }
  return answer();
}

// Прибрати тестові повідомлення з чатів (Telegram дозволяє видаляти до 48 годин; старші — замінюємо на позначку)
async function clearTests(coordinatorIds = null) {
  await ensureTestTable();
  const rows = (await db.query(
    `SELECT id, chat_id, message_id, lang FROM care.test_msgs WHERE $1::int[] IS NULL OR coordinator_id = ANY($1::int[])`,
    [coordinatorIds && coordinatorIds.length ? coordinatorIds : null])).rows;
  let deleted = 0, edited = 0;
  for (const r of rows) {
    if (!r.message_id || !BOT) continue;
    try {
      await BOT.telegram.deleteMessage(r.chat_id, r.message_id);
      deleted++;
    } catch (e) {
      if (await tgEdit(r.chat_id, r.message_id, `<i>${tt(r.lang).gone}</i>`)) edited++;
    }
    await sleep(60);
  }
  if (rows.length) await db.query(`DELETE FROM care.test_msgs WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)]);
  return { messages: rows.length, deleted, edited };
}

async function testSummary() {
  await ensureTestTable();
  const r = await db.query(
    `SELECT t.coordinator_id, c.full_name, COUNT(*)::int AS n, MIN(t.sent_at) AS first_at, MAX(t.sent_at) AS last_at
       FROM care.test_msgs t LEFT JOIN public.coordinators c ON c.id = t.coordinator_id
      GROUP BY t.coordinator_id, c.full_name ORDER BY MAX(t.sent_at) DESC`);
  return r.rows;
}

module.exports = {
  schedule, setBot, handleCallback, tick,
  runMorning, runSurveys, runEscalation, runSpotChecks, sendUrgent,
  closeTask, reopenTask, rateAssessment, loadTask, taskText, sendTaskNow, refreshAssessmentMsg, cancelForCoordinators,
  sendTestSet, clearTests, testSummary, TEST_ITEMS,
};
