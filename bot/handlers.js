const db = require("../db");
const { T } = require("./i18n");
const { getSettingsByFacility } = require("./settings");
const {
  getSessionSafe,
  saveSessionSafe,
  clearSessionSafe,
} = require("./session");
const {
  langKeyboard,
  dayKeyboard,
  hoursKeyboard,
  wolneKeyboard,
  tabeleKeyboard,
} = require("./keyboards");
const campaign = require("./campaign");
const gaps = require("./gaps");

const ABS_COLORS = { WZ: "wz", DWZ: "dwz", URL: "url", L4: "l4", NN: "nn", UN: "un" };

// ── DB helpers ──────────────────────────────────────────────

async function findWorker(login) {
  const res = await db.query("SELECT * FROM workers WHERE login = $1", [
    String(login).trim(),
  ]);
  return res.rows[0] || null;
}

async function linkTelegram(workerId, chatId) {
  await db.query("UPDATE workers SET telegram_chat_id = $1 WHERE id = $2", [
    chatId,
    workerId,
  ]);
}

// Чи працював у цю дату хоч на одному об'єкті (враховує перенесення)
async function workedOnDate(workerId, date) {
  const r = await db.query(
    `SELECT 1
     FROM worker_facility_history h
     WHERE h.worker_id = $1
       AND h.bhp_date <= $2::date
       AND (h.last_work_date IS NULL OR h.last_work_date >= $2::date)
     LIMIT 1`,
    [workerId, date],
  );
  return r.rows.length > 0;
}

// Чи звільнений працівник зараз (для блокування авансів/вихідних)
async function isDismissed(workerId) {
  const r = await db.query(
    `SELECT status::text AS status
     FROM v_worker_current
     WHERE id = $1`,
    [workerId],
  );
  if (!r.rows[0]) return true; // немає активного запису → вважаємо неактивним
  return ["zwolniony", "rezygnacja"].includes(r.rows[0].status);
}

// ДДММ → YYYY-MM-DD з правильним роком на межі року
// (31.12 натиснуто 02.01 → минулий рік; 01.01 натиснуто 31.12 → наступний)
function resolveDate(ddmm) {
  const dd = parseInt(ddmm.substring(0, 2), 10);
  const mm = parseInt(ddmm.substring(2, 4), 10);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let year = now.getFullYear();
  const diff = (new Date(year, mm - 1, dd) - today) / 86400000;
  if (diff > 2) year -= 1;
  else if (diff < -300) year += 1;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

async function writeHours(workerId, ddmm, hours) {
  const date = resolveDate(ddmm);

  if (!(await workedOnDate(workerId, date))) {
    return { ok: false, reason: "outside_period" };
  }

  await db.query(
    `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
     VALUES ($1, $2, $3, NULL, 'telegram')
     ON CONFLICT (worker_id, work_date)
     DO UPDATE SET hours = $3, absence_type = NULL, updated_at = now()`,
    [workerId, date, hours],
  );
  return { ok: true };
}

async function writeAbsence(workerId, ddmm, absCode) {
  const date = resolveDate(ddmm);

  if (!(await workedOnDate(workerId, date))) {
    return { ok: false, reason: "outside_period" };
  }

  await db.query(
    `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
     VALUES ($1, $2, NULL, $3, 'telegram')
     ON CONFLICT (worker_id, work_date)
     DO UPDATE SET hours = NULL, absence_type = $3, updated_at = now()`,
    [workerId, date, absCode],
  );
  return { ok: true };
}

async function getMonthlySummary(workerId) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();

  const res = await db.query(
    `SELECT work_date, hours, absence_type
     FROM hours_log
     WHERE worker_id = $1
       AND DATE_TRUNC('month', work_date) = $2
     ORDER BY work_date`,
    [workerId, `${year}-${mm}-01`],
  );
  return res.rows;
}

async function writeWolne(workerId, days) {
  await db.query(
    `INSERT INTO day_off_requests (worker_id, days) VALUES ($1, $2)`,
    [workerId, days],
  );
}

// ── Telegram send helpers ────────────────────────────────────

async function sendMessage(bot, chatId, text, extra) {
  try {
    await bot.telegram.sendMessage(chatId, text, extra || {});
  } catch (e) {
    console.error("sendMessage error:", e.message);
  }
}

async function sendDayKeyboard(bot, chatId, session, settings) {
  // Акція: кнопки показуються тільки працівникам обраних об'єктів і тільки поки не відповіли
  let campaignRows = null;
  if (session?.workerId && (await campaign.isEligible(session.workerId))) {
    campaignRows = campaign.campaignRows(session);
  }
  // Серії незаповнених днів (>3 підряд) — кнопки з конкретними датами
  const gapRows = session?.workerId
    ? await gaps.gapRowsForWorker(session.workerId, session.lang)
    : null;
  const extraRows = [...(gapRows || []), ...(campaignRows || [])];
  await sendMessage(bot, chatId, T(session, "choose_day"), {
    reply_markup: dayKeyboard(session, settings, extraRows.length ? extraRows : null), // ← передаємо весь settings
  });
}

async function sendLangKeyboard(bot, chatId) {
  await sendMessage(
    bot,
    chatId,
    "Choose language / Wybierz jezyk / Obeript movu:",
    {
      reply_markup: langKeyboard(),
    },
  );
}

// ── Format helpers ───────────────────────────────────────────

function decToHM(dec) {
  const total = Math.round(dec * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function nextFriday() {
  const d = new Date();
  const day = d.getDay();
  const daysMap = [5, 4, 10, 9, 8, 7, 6];
  d.setDate(d.getDate() + daysMap[day]);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

function isValidHHMM(s) {
  return /^(0?[0-9]|1\d|2[0-3]):[0-5]\d$/.test(s) || /^24:00$/.test(s);
}

// ── MAIN HANDLER ─────────────────────────────────────────────

async function handleUpdate(bot, update) {
  // console.log('UPDATE:', JSON.stringify(update).substring(0, 200));
  // ── CALLBACK QUERIES ──────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const payload = String(cq.data || "");
    if (!chatId) return;

    const session = await getSessionSafe(chatId);

    let settings = null;

    if (session.workerId) {
      const worker = await db.query(
        "SELECT facility_id FROM v_worker_current WHERE id = $1",
        [session.workerId],
      );
      settings = await getSettingsByFacility(worker.rows[0]?.facility_id);
    }

    const answer = (text) =>
      bot.telegram.answerCbQuery(cq.id, text || "").catch(() => { });

    if (session.awaitingTabele && !payload.startsWith("TABELE")) {
      delete session.awaitingTabele;
      await saveSessionSafe(chatId, session);
    }


    // LANG
    if (payload.startsWith("LANG_")) {
      const code = payload.split("_")[1];
      session.lang = ["pl", "en", "uk", "ru"].includes(code) ? code : "uk";
      await saveSessionSafe(chatId, session);
      await answer("OK");
      await sendMessage(bot, chatId, T(session, "lang_set"));

      if (session.workerId) {
        // Уже авторизован
        await sendDayKeyboard(bot, chatId, session);
      } else if (session.pendingLogin) {
        // Уже есть ID — регистрируем сразу
        const login = session.pendingLogin.trim();
        delete session.pendingLogin;
        const worker = await findWorker(login);
        if (!worker) {
          await sendMessage(bot, chatId, T(session, "user_not_found"));
          await sendMessage(bot, chatId, T(session, "enter_id"));
        } else {
          session.workerId = worker.id;
          session.workerLogin = worker.login;
          await saveSessionSafe(chatId, session);
          await linkTelegram(worker.id, chatId);
          await sendMessage(
            bot,
            chatId,
            T(session, "id_saved", worker.full_name),
          );
          await sendDayKeyboard(bot, chatId, session);
        }
      } else {
        // Нет ID — просим
        await sendMessage(bot, chatId, T(session, "enter_id"));
      }
      return;
    }

    // LOGOUT
    if (payload === "CMD_0000") {
      await clearSessionSafe(chatId);
      await answer("OK");
      await sendMessage(bot, chatId, T(session, "id_cleared"));
      await sendMessage(bot, chatId, T(session, "enter_id"));
      return;
    }

    // SUMMARY
    if (payload === "CMD_9999") {
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      const rows = await getMonthlySummary(session.workerId);
      if (rows.length === 0) {
        await sendMessage(bot, chatId, T(session, "no_days"));
      } else {
        const lines = rows.map((r) => {
          const d = new Date(r.work_date);
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const val =
            r.absence_type ||
            (Number.isInteger(r.hours) ? String(r.hours) : decToHM(r.hours));
          return `${dd}.${mm} - ${val}`;
        });
        const totalRes = await db.query(
          `SELECT COALESCE(SUM(hours), 0) AS total FROM hours_log
           WHERE worker_id = $1 AND DATE_TRUNC('month', work_date) = DATE_TRUNC('month', CURRENT_DATE)`,
          [session.workerId],
        );
        const total = parseFloat(totalRes.rows[0].total);
        await sendMessage(
          bot,
          chatId,
          T(session, "summary_msg", lines.join("\n"), decToHM(total)),
        );
      }
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // WOLNE — show calendar

    if (payload === "CMD_WOLNE") {
      if (!settings?.enable_wolne) {
        await sendMessage(bot, chatId, "Modul wolne wylaczony");
        return;
      }

      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      if (await isDismissed(session.workerId)) {
        await sendMessage(bot, chatId, T(session, "dismissed_blocked"));
        return;
      }
      session.wolneDays = [];
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, "wolne_choose"), {
        reply_markup: wolneKeyboard(session),
      });
      return;
    }

    // WOLNE — toggle day
    if (payload.startsWith("WOLNE_DAY_")) {
      await answer("OK");
      const key = payload.substring(10);
      session.wolneDays = session.wolneDays || [];
      const idx = session.wolneDays.indexOf(key);
      if (idx === -1) session.wolneDays.push(key);
      else session.wolneDays.splice(idx, 1);
      await saveSessionSafe(chatId, session);
      try {
        await bot.telegram.editMessageReplyMarkup(
          chatId,
          cq.message.message_id,
          null,
          wolneKeyboard(session),
        );
      } catch (e) { }
      return;
    }

    // WOLNE — confirm
    if (payload === "WOLNE_CONFIRM") {
      await answer("OK");
      const days = session.wolneDays || [];
      if (days.length === 0) {
        await sendMessage(bot, chatId, T(session, "wolne_no_days"));
        return;
      }
      days.sort();
      // Convert DD.MM to dates
      const year = new Date().getFullYear();
      const dates = days.map((d) => {
        const [dd, mm] = d.split(".");
        return `${year}-${mm}-${dd}`;
      });
      await writeWolne(session.workerId, dates);
      delete session.wolneDays;
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, "wolne_confirmed"));
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // WOLNE — cancel
    if (payload === "WOLNE_CANCEL") {
      await answer("OK");
      delete session.wolneDays;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // TABELE — cancel
    if (payload === "TABELE_CANCEL") {
      await answer("OK");
      delete session.awaitingTabele;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // ADVANCES — request
    if (payload === "CMD_ADVANCES") {
      if (!settings?.enable_advances) {
        await sendMessage(bot, chatId, T(session, "advances_disabled"));
        return;
      }
      if (await isDismissed(session.workerId)) {
        await sendMessage(bot, chatId, T(session, "dismissed_blocked"));
        return;
      }
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }

      // Перевіряємо чи немає вже pending заявки
      const existing = await db.query(
        `SELECT id FROM advances WHERE worker_id = $1 AND status = 'pending'`,
        [session.workerId],
      );
      if (existing.rows.length) {
        await sendMessage(bot, chatId, T(session, "advances_already_pending"));
        return;
      }

      // Зберігаємо заявку
      await db.query(
        `INSERT INTO advances (worker_id, requested_at, status) VALUES ($1, now(), 'pending')`,
        [session.workerId],
      );
      await sendMessage(bot, chatId, T(session, "advances_requested"));
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // TABELE — request photo
    if (payload === "CMD_TABELE") {
      if (!settings?.enable_tabele) {
        await sendMessage(bot, chatId, T(session, "tabele_error"));
        return;
      }
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      session.awaitingTabele = true;
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, "tabele_ask"), {
        reply_markup: tabeleKeyboard(session),
      });
      return;
    }

    // 800+ — записати згоду
    /*
    if (payload === "CMD_800PLUS") {
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      try {
        const wq = await db.query(
          `SELECT w.id, w.full_name, w.login, w.pesel,
                  vc.facility_id, f.name AS facility_name
           FROM workers w
           LEFT JOIN v_worker_current vc ON vc.id = w.id
           LEFT JOIN facilities f ON f.id = vc.facility_id
           WHERE w.id = $1`,
          [session.workerId],
        );
        const w = wq.rows[0];
        await db.query(
          `INSERT INTO program_800plus
             (worker_id, full_name, login, pesel, facility_id, facility_name)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (worker_id)
           DO UPDATE SET full_name = $2, login = $3, pesel = $4,
                         facility_id = $5, facility_name = $6, submitted_at = now()`,
          [w.id, w.full_name, w.login, w.pesel, w.facility_id, w.facility_name],
        );
        await sendMessage(bot, chatId, T(session, "msg_800plus_thanks"));
      } catch (e) {
        console.error("800plus error:", e.message);
        await sendMessage(bot, chatId, T(session, "tabele_error"));
      }
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }
*/

    // АКЦІЯ — крок 1: обрано варіант → уточнююче питання
    if (payload.startsWith("AKC_PICK_")) {
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      const choice = payload.substring(9) === "yes" ? "yes" : "no";

      // Кнопки могли залишитись у старому повідомленні — не даємо відповісти двічі
      if (await campaign.hasAnswered(session.workerId)) {
        await sendMessage(bot, chatId, T(session, "akc_already"));
        await sendDayKeyboard(bot, chatId, session, settings);
        return;
      }

      const label =
        choice === "yes"
          ? T(session, "akc_choice_yes", campaign.DEADLINE)
          : T(session, "akc_choice_no");

      await sendMessage(bot, chatId, T(session, "akc_confirm", label), {
        reply_markup: campaign.confirmKeyboard(session, choice),
      });
      return;
    }

    // АКЦІЯ — «Назад»: повертаємо вибір варіанту
    if (payload === "AKC_BACK") {
      await answer("OK");
      try {
        await bot.telegram.editMessageText(
          chatId,
          cq.message.message_id,
          null,
          T(session, "akc_prompt"),
          { reply_markup: campaign.promptKeyboard(session) },
        );
      } catch (e) {
        await sendMessage(bot, chatId, T(session, "akc_prompt"), {
          reply_markup: campaign.promptKeyboard(session),
        });
      }
      return;
    }

    // АКЦІЯ — крок 2: підтверджено → запис у campaign_responses, кнопки зникають
    if (payload.startsWith("AKC_OK_")) {
      await answer("OK");
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, "need_id"));
        return;
      }
      const choice = payload.substring(7) === "yes" ? "yes" : "no";

      try {
        await campaign.saveResponse(session.workerId, choice, session.lang);
      } catch (e) {
        console.error("campaign save error:", e.message);
        await sendMessage(bot, chatId, T(session, "tabele_error"));
        return;
      }

      // прибираємо кнопки з повідомлення з уточнюючим питанням
      try {
        await bot.telegram.editMessageText(
          chatId,
          cq.message.message_id,
          null,
          T(session, "akc_thanks"),
        );
      } catch (e) {
        await sendMessage(bot, chatId, T(session, "akc_thanks"));
      }

      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // GAP — дата з нагадування про незаповнені дні (GAP_YYYYMMDD)
    if (payload.startsWith("GAP_")) {
      if (payload === "GAP_NOOP") {
        await answer("");
        return;
      }
      if (!session.workerId) {
        await answer(T(session, "need_id"));
        return;
      }
      const g = gaps.parseGapPayload(payload);
      if (!g) {
        await answer("");
        await sendDayKeyboard(bot, chatId, session, settings);
        return;
      }
      session.dayOfMonth = g.ddmm;
      delete session.awaitingHoursManual;
      await saveSessionSafe(chatId, session);
      await answer(g.label);
      await sendMessage(
        bot,
        chatId,
        `${gaps.tx(session.lang).day_picked(g.label)}\n${T(session, "choose_hours")}`,
        { reply_markup: hoursKeyboard(session, settings) },
      );
      return;
    }

    // DAY select
    if (payload.startsWith("DAY_")) {
      if (!session.workerId) {
        await answer(T(session, "need_id"));
        return;
      }
      const ddmm = payload.split("_")[1];
      session.dayOfMonth = ddmm;
      await saveSessionSafe(chatId, session);
      await answer(ddmm);
      await sendMessage(bot, chatId, T(session, "choose_hours"), {
        reply_markup: hoursKeyboard(session, settings),
      });
      return;
    }

    // HOURS select
    if (payload.startsWith("H_")) {
      if (!session.workerId) {
        await answer(T(session, "need_id"));
        return;
      }
      if (!session.dayOfMonth) {
        await answer(T(session, "ask_day"));
        return;
      }

      if (payload === "H_OTHER") {
        session.awaitingHoursManual = true;
        await saveSessionSafe(chatId, session);
        await answer("");
        await sendMessage(bot, chatId, T(session, "enter_hours_manual"));
        return;
      }

      const hrs = parseFloat(payload.substring(2).replace(",", "."));
      if (isNaN(hrs) || hrs <= 0 || hrs > 16) {
        await answer("0.25-16");
        return;
      }

      const wh = await writeHours(
        session.workerId,
        session.dayOfMonth,
        Math.round(hrs * 100) / 100,
      );
      if (!wh.ok) {
        await answer("");
        await sendMessage(bot, chatId, T(session, "outside_period"));
        delete session.dayOfMonth;
        await saveSessionSafe(chatId, session);
        await sendDayKeyboard(bot, chatId, session, settings);
        return;
      }
      await answer(T(session, "hours_saved", hrs));
      await sendMessage(
        bot,
        chatId,
        T(session, "record_done", session.dayOfMonth, hrs),
      );
      delete session.dayOfMonth;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    // ABSENCE select
    if (payload.startsWith("ABS_")) {
      if (!session.workerId) {
        await answer(T(session, "need_id"));
        return;
      }
      if (!session.dayOfMonth) {
        await answer(T(session, "abs_day_missing"));
        return;
      }

      const absCode = payload.split("_")[1];
      const wa = await writeAbsence(session.workerId, session.dayOfMonth, absCode);
      if (!wa.ok) {
        await answer("");
        await sendMessage(bot, chatId, T(session, "outside_period"));
        delete session.dayOfMonth;
        await saveSessionSafe(chatId, session);
        await sendDayKeyboard(bot, chatId, session, settings);
        return;
      }
      await answer(absCode);
      await sendMessage(
        bot,
        chatId,
        T(session, "record_done", session.dayOfMonth, absCode),
      );
      delete session.dayOfMonth;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }

    await answer("");
    return;
  }

  // ── TEXT MESSAGES ──────────────────────────────────────────
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const textRaw = String(update.message.text || "");
  const textCmd = textRaw.trim().replace(/\s+/g, "").toLowerCase();
  const session = await getSessionSafe(chatId);

  let settings = null;
  if (session.workerId) {
    const workerRes = await db.query(
      "SELECT facility_id FROM v_worker_current WHERE id = $1",
      [session.workerId],
    );
    settings = await getSettingsByFacility(workerRes.rows[0]?.facility_id);
  }

  // ── ФОТО ТАБЕЛЮ ──────────────────────────────────────────
  if (session.awaitingTabele && session.workerId && update.message.photo) {
    try {
      const path = require("path");
      const fs = require("fs");

      // Отримуємо інфо про працівника і заклад
      const workerRes = await db.query(
        `SELECT w.login, w.full_name, vc.facility_id, f.name AS facility_name
         FROM workers w
         JOIN v_worker_current vc ON vc.id = w.id
         JOIN facilities f ON f.id = vc.facility_id
         WHERE w.id = $1`,
        [session.workerId],
      );
      const worker = workerRes.rows[0];

      // Формуємо місяць і папку
      const now = new Date();
      const month = `${String(now.getMonth() + 1).padStart(2, "0")}${now.getFullYear()}`;
      const facilityFolder = (worker.facility_name || "unknown").replace(
        /[\/\\:*?"<>|]/g,
        "_",
      );
      const folderPath = path.join(
        "C:\\sas-bot\\tabele",
        facilityFolder,
        month,
      );

      // Створюємо папку якщо немає
      fs.mkdirSync(folderPath, { recursive: true });

      // Визначаємо номер файлу (якщо повторна відправка)
      const existing = await db.query(
        `SELECT COUNT(*) FROM timesheets WHERE worker_id = $1 AND month = $2`,
        [
          session.workerId,
          `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
        ],
      );
      const fileNumber = parseInt(existing.rows[0].count) + 1;

      // Формуємо ім'я файлу
      const namePart = (worker.full_name || "unknown")
        .replace(/\s+/g, "_")
        .toUpperCase();
      const suffix = fileNumber > 1 ? `_${fileNumber}` : "";
      const fileName = `${namePart}_${worker.login}${suffix}.jpg`;
      const filePath = path.join(folderPath, fileName);

      // Завантажуємо фото з Telegram
      const photo = update.message.photo[update.message.photo.length - 1];
      const fileLink = await bot.telegram.getFileLink(photo.file_id);
      const https = require("follow-redirects").https;

      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https
          .get(fileLink.href, (res) => {
            res.pipe(file);
            file.on("finish", () => {
              file.close();
              resolve();
            });
          })
          .on("error", reject);
      });

      // Зберігаємо в БД
      const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      await db.query(
        `INSERT INTO timesheets (worker_id, facility_id, month, file_path, file_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.workerId, worker.facility_id, monthStr, filePath, fileNumber],
      );

      delete session.awaitingTabele;
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, "tabele_saved"));
      await sendDayKeyboard(bot, chatId, session, settings);
    } catch (e) {
      console.error("Tabele save error:", e.message);
      await sendMessage(bot, chatId, T(session, "tabele_error"));
    }
    
    return;
  }

  // Якщо чекаємо фото але надіслали не фото
  if (session.awaitingTabele && !update.message.photo) {
    const escapeCmds = ["0000", "/start", "/lang", "lang", "9999", "/9999"];
    if (escapeCmds.includes(textCmd)) {
      delete session.awaitingTabele;
      await saveSessionSafe(chatId, session);
      // далі виконання йде як звичайно — команда обробиться нижче
    } else {
      await sendMessage(bot, chatId, T(session, "tabele_not_photo"), {
        reply_markup: tabeleKeyboard(session),
      });
      return;
    }
  }

  // No lang yet → ask lang
  if (!session.lang && textCmd !== "0000") {
    if (!session.pendingLogin && textRaw.trim()) {
      session.pendingLogin = textRaw.trim();
      await saveSessionSafe(chatId, session);
    }
    await sendLangKeyboard(bot, chatId);
    return;
  }

  // LOGOUT
  if (textCmd === "0000") {
    await clearSessionSafe(chatId);
    await sendMessage(bot, chatId, T(session, "id_cleared"));
    await sendMessage(bot, chatId, T(session, "enter_id"));
    return;
  }

  // LANG
  if (textCmd === "/lang" || textCmd === "lang") {
    await sendLangKeyboard(bot, chatId);
    return;
  }

  // SUMMARY
  if (textCmd === "9999" || textCmd === "/9999") {
    if (!session.workerId) {
      await sendMessage(bot, chatId, T(session, "need_id"));
      return;
    }
    const rows = await getMonthlySummary(session.workerId);
    if (rows.length === 0) {
      await sendMessage(bot, chatId, T(session, "no_days"));
    } else {
      const lines = rows.map((r) => {
        const d = new Date(r.work_date);
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const val = r.absence_type || decToHM(r.hours);
        return `${dd}.${mm} - ${val}`;
      });
      const totalRes = await db.query(
        `SELECT COALESCE(SUM(hours), 0) AS total FROM hours_log
         WHERE worker_id = $1 AND DATE_TRUNC('month', work_date) = DATE_TRUNC('month', CURRENT_DATE)`,
        [session.workerId],
      );
      const total = parseFloat(totalRes.rows[0].total);
      await sendMessage(
        bot,
        chatId,
        T(session, "summary_msg", lines.join("\n"), decToHM(total)),
      );
    }
    await sendDayKeyboard(bot, chatId, session, settings);
    return;
  }

  // Manual hours input
  if (session.awaitingHoursManual && session.workerId && session.dayOfMonth) {
    const s = textRaw.trim();
    let dec = null;

    if (isValidHHMM(s)) {
      const m = s.match(/^(\d{1,2}):([0-5]\d)$/);
      if (m) dec = parseInt(m[1]) + parseInt(m[2]) / 60;
      else dec = 24;
    } else {
      const n = parseFloat(s.replace(",", "."));
      if (!isNaN(n) && n >= 0 && n <= 16) dec = n;
    }

    if (dec === null || dec <= 0 || dec > 16) {
      await sendMessage(bot, chatId, T(session, "zero_hours"));
      return;
    }

    const rounded = Math.round(dec * 100) / 100;
    const whm = await writeHours(session.workerId, session.dayOfMonth, rounded);
    if (!whm.ok) {
      await sendMessage(bot, chatId, T(session, "outside_period"));
      delete session.dayOfMonth;
      delete session.awaitingHoursManual;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session, settings);
      return;
    }
    await sendMessage(
      bot,
      chatId,
      T(session, "record_done", session.dayOfMonth, rounded),
    );
    delete session.dayOfMonth;
    delete session.awaitingHoursManual;
    await saveSessionSafe(chatId, session);
    await sendDayKeyboard(bot, chatId, session, settings);
    return;
  }

  // ID input
  if (!session.workerId) {
    const login = (session.pendingLogin || textRaw).trim();
    delete session.pendingLogin;

    const worker = await findWorker(login);
    if (!worker) {
      await sendMessage(bot, chatId, T(session, "user_not_found"));
      return;
    }

    session.workerId = worker.id;
    session.workerLogin = worker.login;
    if (!session.lang) session.lang = worker.lang || "uk";
    await saveSessionSafe(chatId, session);
    await linkTelegram(worker.id, chatId);
    await sendMessage(bot, chatId, T(session, "id_saved", worker.full_name));
    await sendDayKeyboard(bot, chatId, session, settings);
    return;
  }

  // Day input as DDMM text
  if (!session.dayOfMonth) {
    const t = textRaw.trim().replace(/\s+/g, "");
    if (/^\d{4}$/.test(t)) {
      const dd = parseInt(t.substring(0, 2));
      const mm = parseInt(t.substring(2, 4));
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        session.dayOfMonth = t;
        await saveSessionSafe(chatId, session);
        await sendMessage(bot, chatId, T(session, "choose_hours"), {
          reply_markup: hoursKeyboard(session, settings),
        });
      } else {
        await sendMessage(bot, chatId, T(session, "bad_date"));
        await sendDayKeyboard(bot, chatId, session, settings);
      }
    } else {
      await sendDayKeyboard(bot, chatId, session, settings);
    }
    return;
  }
}

// ── REMINDER — send to workers with missing days ──────────────
// facilityIds: null = всі (адмін/глобально), масив = тільки ці об'єкти
async function sendMissingReminders(bot, facilityIds = null) {
  try {
    let query = `
      SELECT 
        v.worker_id,
        v.full_name,
        v.telegram_chat_id,
        v.missing_dates,
        w.lang,
        v.facility_id
      FROM v_missing_days v
      JOIN workers w ON w.id = v.worker_id
      WHERE v.telegram_chat_id IS NOT NULL
    `;
    const params = [];

    if (facilityIds !== null) {
      if (!facilityIds.length) {
        console.log("Reminders: no facilities for this coordinator");
        return;
      }
      params.push(facilityIds);
      query += ` AND v.facility_id = ANY($${params.length})`;
    }

    query += ` LIMIT 500`;
    const res = await db.query(query, params);

    for (const row of res.rows) {
      const session = { lang: row.lang || "uk" };
      const days = (row.missing_dates || [])
        .map((d) => {
          const dt = new Date(d);
          return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
        })
        .join(", ");
      if (!days) continue;
      const mm = String(new Date().getMonth() + 1).padStart(2, "0");
      const msg = T(session, "missing_days_msg", row.full_name.split(" ")[0], mm, days);
      await sendMessage(bot, row.telegram_chat_id, msg);
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`Reminders sent: ${res.rows.length} workers`);
  } catch (e) {
    console.error("sendMissingReminders error:", e.message);
  }
}

async function sendTabeleReminders(bot) {
  try {
    // Отримуємо всіх працівників де enable_tabele = true і є telegram
    const res = await db.query(`
      SELECT w.id, w.full_name, w.telegram_chat_id, w.lang,
             vc.facility_id
      FROM workers w
      JOIN v_worker_current vc ON vc.id = w.id
      JOIN facility_settings fs ON fs.facility_id = vc.facility_id
      WHERE fs.enable_tabele = true
        AND w.telegram_chat_id IS NOT NULL
    `);

    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    for (const row of res.rows) {
      // Перевіряємо чи вже надіслав табель цього місяця
      const sent = await db.query(
        `SELECT 1 FROM timesheets WHERE worker_id = $1 AND month = $2 LIMIT 1`,
        [row.id, monthStr]
      );
      if (sent.rows.length) continue; // вже надіслав — не нагадуємо

      const session = { lang: row.lang || "uk" };
      await sendMessage(bot, row.telegram_chat_id, T(session, "tabele_ask"));
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`[Tabele] Reminders sent: ${res.rows.length}`);
  } catch (e) {
    console.error("[Tabele] Reminder error:", e.message);
  }
}

// ── COORDINATOR DAILY REPORT (18:00) ──────────────────────────
async function sendCoordinatorReports(bot) {
  try {
    const coords = await db.query(`
      SELECT id, full_name, telegram_chat_id, role, lang
      FROM coordinators
      WHERE telegram_chat_id IS NOT NULL AND is_active = true
    `);

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const yStr = yesterday.toISOString().substring(0, 10);
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const todayStr = now.toISOString().substring(0, 10);

    for (const coord of coords.rows) {
      // Визначаємо об'єкти координатора
      let facFilter = "";
      const baseParams = [];

      if (coord.role !== "head") {
        const facRes = await db.query(
          `SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`,
          [coord.id]
        );
        const facIds = facRes.rows.map(r => r.facility_id);
        if (facIds.length === 0) continue; // немає об'єктів — пропускаємо
        baseParams.push(facIds);
        facFilter = `AND h.facility_id = ANY($${baseParams.length})`;
      }

      // ── ПОВІДОМЛЕННЯ 1: хто вчора не заповнив ──────────────
      const yParams = [yStr, ...baseParams];
      const yFilter = facFilter.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 1}`);

      const missedYesterday = await db.query(`
          SELECT DISTINCT w.full_name, f.name AS facility_name
          FROM worker_facility_history h
          JOIN workers w ON w.id = h.worker_id
          JOIN facilities f ON f.id = h.facility_id
          WHERE h.status::text = 'pracuje'
            AND h.bhp_date <= $1::date
            AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
            ${yFilter}
            AND NOT EXISTS (
              SELECT 1 FROM hours_log hl
              WHERE hl.worker_id = w.id AND hl.work_date = $1::date
            )
          ORDER BY f.name, w.full_name
        `, yParams);

      let msg1;
      if (missedYesterday.rows.length === 0) {
        msg1 = `✅ *Вчора (${formatDate(yesterday)})*\nВсі заповнили години!`;
      } else {
        const byFac = {};
        missedYesterday.rows.forEach(r => {
          if (!byFac[r.facility_name]) byFac[r.facility_name] = [];
          byFac[r.facility_name].push(r.full_name);
        });
        const lines = Object.entries(byFac).map(([fac, names]) =>
          `\n🏭 *${fac}* (${names.length}):\n` + names.map(n => `  • ${n}`).join("\n")
        ).join("\n");
        msg1 = `⚠️ *Не заповнили вчора (${formatDate(yesterday)})*\nВсього: ${missedYesterday.rows.length}\n${lines}`;
      }
      console.log("msg1 length:", msg1.length);
      console.log(
        "Sending to:",
        coord.full_name,
        coord.telegram_chat_id
      );
      ``
      await sendLong(
        coord.telegram_chat_id,
        msg1,
        { parse_mode: "Markdown" }
      );

      await new Promise(r => setTimeout(r, 400));

      // ── ПОВІДОМЛЕННЯ 2: пропуски з початку місяця ──────────
      const mParams = [monthStart, todayStr, ...baseParams];
      const mFilter = facFilter.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 2}`);

      const missedMonth = await db.query(`
            SELECT w.full_name, f.name AS facility_name,
              ARRAY(
                SELECT gs::date
                FROM generate_series($1::date, $2::date, '1 day') gs
                WHERE gs::date >= h.bhp_date
                  AND (h.last_work_date IS NULL OR gs::date <= h.last_work_date)
                  AND NOT EXISTS (
                    SELECT 1 FROM hours_log hl
                    WHERE hl.worker_id = w.id AND hl.work_date = gs::date
                  )
              ) AS missing_dates
            FROM worker_facility_history h
            JOIN workers w ON w.id = h.worker_id
            JOIN facilities f ON f.id = h.facility_id
            WHERE h.status::text = 'pracuje'
              AND h.bhp_date <= $2::date
              AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
              ${mFilter}
            ORDER BY f.name, w.full_name
          `, mParams);

      const withMissing = missedMonth.rows.filter(r => (r.missing_dates || []).length > 0);

      let msg2;
      if (withMissing.length === 0) {
        msg2 = `✅ *Місяць (з ${formatDate(new Date(monthStart))})*\nНемає пропусків!`;
      } else {
        const byFac = {};
        withMissing.forEach(r => {
          if (!byFac[r.facility_name]) byFac[r.facility_name] = [];
          const dates = r.missing_dates.map(d => {
            const dt = new Date(d);
            return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
          }).join(", ");
          byFac[r.facility_name].push(`  • ${r.full_name}: ${dates}`);
        });
        const lines = Object.entries(byFac).map(([fac, items]) =>
          `\n🏭 *${fac}*:\n` + items.join("\n")
        ).join("\n");
        msg2 = `📋 *Пропуски з початку місяця*\nПрацівників: ${withMissing.length}\n${lines}`;
      }
      console.log("msg2 length:", msg2.length);
      await sendLong(
        coord.telegram_chat_id,
        msg2,
        { parse_mode: "Markdown" })

      // Telegram має ліміт 4096 символів — ріжемо якщо треба
      /*if (msg2.length > 4000) {
        const chunks = msg2.match(/[\s\S]{1,3900}/g) || [];
        for (const chunk of chunks) {
          console.log("msg2 length if :", msg2.length);
          await sendMessage(bot, coord.telegram_chat_id, chunk, { parse_mode: "Markdown" });
          await new Promise(r => setTimeout(r, 400));
        }
      } else {
        console.log("msg2 length:", msg2.length);
        await sendLong(
          coord.telegram_chat_id,
          msg2,
          { parse_mode: "Markdown" }
        );
      }*/

      await new Promise(r => setTimeout(r, 400));
    }

    console.log(`[CoordReport] Sent to ${coords.rows.length} coordinators`);
  } catch (e) {
    console.error("[CoordReport] Error:", e.message);
  }
}

function formatDate(d) {
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}


// Надіслати довгий текст частинами (Telegram ліміт 4096)
async function sendLong(chatId, text, extra = {}) {
  const LIMIT = 4000;
  const send = (t) =>
    fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: t, ...extra }),
    });

  if (text.length <= LIMIT) return send(text);

  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > LIMIT) {
      await send(chunk);
      await new Promise((r) => setTimeout(r, 300));
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) await send(chunk);
}

module.exports = { handleUpdate, sendMissingReminders, sendTabeleReminders, sendCoordinatorReports };

