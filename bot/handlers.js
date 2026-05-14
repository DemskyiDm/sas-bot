const db = require('../db');
const { T } = require('./i18n');
const { getSessionSafe, saveSessionSafe, clearSessionSafe } = require('./session');
const { langKeyboard, dayKeyboard, hoursKeyboard, wolneKeyboard } = require('./keyboards');

const ABS_COLORS = { WZ: 'wz', URL: 'url', L4: 'l4', NN: 'nn' };

// ── DB helpers ──────────────────────────────────────────────

async function findWorker(login) {
  const res = await db.query(
    'SELECT * FROM workers WHERE login = $1',
    [String(login).trim()]
  );
  return res.rows[0] || null;
}

async function linkTelegram(workerId, chatId) {
  await db.query(
    'UPDATE workers SET telegram_chat_id = $1 WHERE id = $2',
    [chatId, workerId]
  );
}

async function writeHours(workerId, ddmm, hours) {
  const dd = ddmm.substring(0, 2);
  const mm = ddmm.substring(2, 4);
  const year = new Date().getFullYear();
  const date = `${year}-${mm}-${dd}`;

  await db.query(
    `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
     VALUES ($1, $2, $3, NULL, 'telegram')
     ON CONFLICT (worker_id, work_date)
     DO UPDATE SET hours = $3, absence_type = NULL, updated_at = now()`,
    [workerId, date, hours]
  );
}

async function writeAbsence(workerId, ddmm, absCode) {
  const dd = ddmm.substring(0, 2);
  const mm = ddmm.substring(2, 4);
  const year = new Date().getFullYear();
  const date = `${year}-${mm}-${dd}`;

  await db.query(
    `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
     VALUES ($1, $2, NULL, $3, 'telegram')
     ON CONFLICT (worker_id, work_date)
     DO UPDATE SET hours = NULL, absence_type = $3, updated_at = now()`,
    [workerId, date, absCode]
  );
}

async function getMonthlySummary(workerId) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();

  const res = await db.query(
    `SELECT work_date, hours, absence_type
     FROM hours_log
     WHERE worker_id = $1
       AND DATE_TRUNC('month', work_date) = $2
     ORDER BY work_date`,
    [workerId, `${year}-${mm}-01`]
  );
  return res.rows;
}

async function writeWolne(workerId, days) {
  await db.query(
    `INSERT INTO day_off_requests (worker_id, days) VALUES ($1, $2)`,
    [workerId, days]
  );
}

// ── Telegram send helpers ────────────────────────────────────

async function sendMessage(bot, chatId, text, extra) {
  try {
    await bot.telegram.sendMessage(chatId, text, extra || {});
  } catch (e) {
    console.error('sendMessage error:', e.message);
  }
}

async function sendDayKeyboard(bot, chatId, session) {
  await sendMessage(bot, chatId, T(session, 'choose_day'), {
    reply_markup: dayKeyboard(session),
  });
}

async function sendLangKeyboard(bot, chatId) {
  await sendMessage(bot, chatId, 'Choose language / Wybierz jezyk / Obeript movu:', {
    reply_markup: langKeyboard(),
  });
}

// ── Format helpers ───────────────────────────────────────────

function decToHM(dec) {
  const total = Math.round(dec * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function nextFriday() {
  const d = new Date();
  const day = d.getDay();
  const daysMap = [5, 4, 10, 9, 8, 7, 6];
  d.setDate(d.getDate() + daysMap[day]);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function isValidHHMM(s) {
  return /^(0?[0-9]|1\d|2[0-3]):[0-5]\d$/.test(s) || /^24:00$/.test(s);
}

// ── MAIN HANDLER ─────────────────────────────────────────────

async function handleUpdate(bot, update) {
 // console.log('UPDATE:', JSON.stringify(update).substring(0, 200));
  // ── CALLBACK QUERIES ──────────────────────────────────────
  if (update.callback_query) {
    const cq      = update.callback_query;
    const chatId  = cq.message?.chat?.id;
    const payload = String(cq.data || '');
    if (!chatId) return;

    const session = await getSessionSafe(chatId);

    const answer = (text) => bot.telegram.answerCbQuery(cq.id, text || '').catch(() => {});

    // LANG
    if (payload.startsWith('LANG_')) {
      const code = payload.split('_')[1];
      session.lang = ['pl', 'en', 'uk', 'ru'].includes(code) ? code : 'uk';
      await saveSessionSafe(chatId, session);
      await answer('OK');
      await sendMessage(bot, chatId, T(session, 'lang_set'));

      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, 'enter_id'));
      } else {
        await sendDayKeyboard(bot, chatId, session);
      }
      return;
    }

    // LOGOUT
    if (payload === 'CMD_0000') {
      await clearSessionSafe(chatId);
      await answer('OK');
      await sendMessage(bot, chatId, T(session, 'id_cleared'));
      await sendMessage(bot, chatId, T(session, 'enter_id'));
      return;
    }

    // SUMMARY
    if (payload === 'CMD_9999') {
      await answer('OK');
      if (!session.workerId) {
        await sendMessage(bot, chatId, T(session, 'need_id'));
        return;
      }
      const rows = await getMonthlySummary(session.workerId);
      if (rows.length === 0) {
        await sendMessage(bot, chatId, T(session, 'no_days'));
      } else {
        const lines = rows.map((r) => {
          const d = new Date(r.work_date);
          const dd = String(d.getDate()).padStart(2, '0');
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const val = r.absence_type || (Number.isInteger(r.hours) ? String(r.hours) : decToHM(r.hours));
          return `${dd}.${mm} - ${val}`;
        });
        const totalRes = await db.query(
          `SELECT COALESCE(SUM(hours), 0) AS total FROM hours_log
           WHERE worker_id = $1 AND DATE_TRUNC('month', work_date) = DATE_TRUNC('month', CURRENT_DATE)`,
          [session.workerId]
        );
        const total = parseFloat(totalRes.rows[0].total);
        await sendMessage(bot, chatId, T(session, 'summary_msg', lines.join('\n'), decToHM(total)));
      }
      await sendDayKeyboard(bot, chatId, session);
      return;
    }

    // WOLNE — show calendar
    if (payload === 'CMD_WOLNE') {
      await answer('OK');
      if (!session.workerId) { await sendMessage(bot, chatId, T(session, 'need_id')); return; }
      session.wolneDays = [];
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, 'wolne_choose'), { reply_markup: wolneKeyboard(session) });
      return;
    }

    // WOLNE — toggle day
    if (payload.startsWith('WOLNE_DAY_')) {
      await answer('OK');
      const key = payload.substring(10);
      session.wolneDays = session.wolneDays || [];
      const idx = session.wolneDays.indexOf(key);
      if (idx === -1) session.wolneDays.push(key);
      else session.wolneDays.splice(idx, 1);
      await saveSessionSafe(chatId, session);
      try {
        await bot.telegram.editMessageReplyMarkup(chatId, cq.message.message_id, null, wolneKeyboard(session));
      } catch (e) {}
      return;
    }

    // WOLNE — confirm
    if (payload === 'WOLNE_CONFIRM') {
      await answer('OK');
      const days = session.wolneDays || [];
      if (days.length === 0) {
        await sendMessage(bot, chatId, T(session, 'wolne_no_days'));
        return;
      }
      days.sort();
      // Convert DD.MM to dates
      const year = new Date().getFullYear();
      const dates = days.map((d) => {
        const [dd, mm] = d.split('.');
        return `${year}-${mm}-${dd}`;
      });
      await writeWolne(session.workerId, dates);
      delete session.wolneDays;
      await saveSessionSafe(chatId, session);
      await sendMessage(bot, chatId, T(session, 'wolne_confirmed'));
      await sendDayKeyboard(bot, chatId, session);
      return;
    }

    // WOLNE — cancel
    if (payload === 'WOLNE_CANCEL') {
      await answer('OK');
      delete session.wolneDays;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session);
      return;
    }

    // DAY select
    if (payload.startsWith('DAY_')) {
      if (!session.workerId) { await answer(T(session, 'need_id')); return; }
      const ddmm = payload.split('_')[1];
      session.dayOfMonth = ddmm;
      await saveSessionSafe(chatId, session);
      await answer(ddmm);
      await sendMessage(bot, chatId, T(session, 'choose_hours'), { reply_markup: hoursKeyboard(session) });
      return;
    }

    // HOURS select
    if (payload.startsWith('H_')) {
      if (!session.workerId)    { await answer(T(session, 'need_id')); return; }
      if (!session.dayOfMonth)  { await answer(T(session, 'ask_day')); return; }

      if (payload === 'H_OTHER') {
        session.awaitingHoursManual = true;
        await saveSessionSafe(chatId, session);
        await answer('');
        await sendMessage(bot, chatId, T(session, 'enter_hours_manual'));
        return;
      }

      const hrs = parseFloat(payload.substring(2).replace(',', '.'));
      if (isNaN(hrs) || hrs < 0 || hrs > 13) { await answer('0-13'); return; }

      await writeHours(session.workerId, session.dayOfMonth, Math.round(hrs * 100) / 100);
      await answer(T(session, 'hours_saved', hrs));
      await sendMessage(bot, chatId, T(session, 'record_done', session.dayOfMonth, hrs));
      delete session.dayOfMonth;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session);
      return;
    }

    // ABSENCE select
    if (payload.startsWith('ABS_')) {
      if (!session.workerId)   { await answer(T(session, 'need_id')); return; }
      if (!session.dayOfMonth) { await answer(T(session, 'abs_day_missing')); return; }

      const absCode = payload.split('_')[1];
      await writeAbsence(session.workerId, session.dayOfMonth, absCode);
      await answer(absCode);
      await sendMessage(bot, chatId, T(session, 'record_done', session.dayOfMonth, absCode));
      delete session.dayOfMonth;
      await saveSessionSafe(chatId, session);
      await sendDayKeyboard(bot, chatId, session);
      return;
    }

    await answer('');
    return;
  }

  // ── TEXT MESSAGES ──────────────────────────────────────────
  if (!update.message) return;

  const chatId  = update.message.chat.id;
  const textRaw = String(update.message.text || '');
  const textCmd = textRaw.trim().replace(/\s+/g, '').toLowerCase();
  const session = await getSessionSafe(chatId);

  // No lang yet → ask lang
  if (!session.lang && textCmd !== '0000') {
    if (!session.pendingLogin && textRaw.trim()) {
      session.pendingLogin = textRaw.trim();
      await saveSessionSafe(chatId, session);
    }
    await sendLangKeyboard(bot, chatId);
    return;
  }

  // LOGOUT
  if (textCmd === '0000') {
    await clearSessionSafe(chatId);
    await sendMessage(bot, chatId, T(session, 'id_cleared'));
    await sendMessage(bot, chatId, T(session, 'enter_id'));
    return;
  }

  // LANG
  if (textCmd === '/lang' || textCmd === 'lang') {
    await sendLangKeyboard(bot, chatId);
    return;
  }

  // SUMMARY
  if (textCmd === '9999' || textCmd === '/9999') {
    if (!session.workerId) { await sendMessage(bot, chatId, T(session, 'need_id')); return; }
    const rows = await getMonthlySummary(session.workerId);
    if (rows.length === 0) {
      await sendMessage(bot, chatId, T(session, 'no_days'));
    } else {
      const lines = rows.map((r) => {
        const d = new Date(r.work_date);
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const val = r.absence_type || decToHM(r.hours);
        return `${dd}.${mm} - ${val}`;
      });
      const totalRes = await db.query(
        `SELECT COALESCE(SUM(hours), 0) AS total FROM hours_log
         WHERE worker_id = $1 AND DATE_TRUNC('month', work_date) = DATE_TRUNC('month', CURRENT_DATE)`,
        [session.workerId]
      );
      const total = parseFloat(totalRes.rows[0].total);
      await sendMessage(bot, chatId, T(session, 'summary_msg', lines.join('\n'), decToHM(total)));
    }
    await sendDayKeyboard(bot, chatId, session);
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
      const n = parseFloat(s.replace(',', '.'));
      if (!isNaN(n) && n >= 0 && n <= 13) dec = n;
    }

    if (dec === null) {
      await sendMessage(bot, chatId, T(session, 'bad_hours_format'));
      return;
    }

    const rounded = Math.round(dec * 100) / 100;
    await writeHours(session.workerId, session.dayOfMonth, rounded);
    await sendMessage(bot, chatId, T(session, 'record_done', session.dayOfMonth, rounded));
    delete session.dayOfMonth;
    delete session.awaitingHoursManual;
    await saveSessionSafe(chatId, session);
    await sendDayKeyboard(bot, chatId, session);
    return;
  }

  // ID input
  if (!session.workerId) {
    const login = (session.pendingLogin || textRaw).trim();
    delete session.pendingLogin;

    const worker = await findWorker(login);
    if (!worker) {
      await sendMessage(bot, chatId, T(session, 'user_not_found'));
      return;
    }

    session.workerId  = worker.id;
    session.workerLogin = worker.login;
    if (!session.lang) session.lang = worker.lang || 'uk';
    await saveSessionSafe(chatId, session);
    await linkTelegram(worker.id, chatId);
    await sendMessage(bot, chatId, T(session, 'id_saved', worker.full_name));
    await sendDayKeyboard(bot, chatId, session);
    return;
  }

  // Day input as DDMM text
  if (!session.dayOfMonth) {
    const t = textRaw.trim().replace(/\s+/g, '');
    if (/^\d{4}$/.test(t)) {
      const dd = parseInt(t.substring(0, 2));
      const mm = parseInt(t.substring(2, 4));
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        session.dayOfMonth = t;
        await saveSessionSafe(chatId, session);
        await sendMessage(bot, chatId, T(session, 'choose_hours'), { reply_markup: hoursKeyboard(session) });
      } else {
        await sendMessage(bot, chatId, T(session, 'bad_date'));
        await sendDayKeyboard(bot, chatId, session);
      }
    } else {
      await sendDayKeyboard(bot, chatId, session);
    }
    return;
  }
}

// ── REMINDER — send to workers with missing days ──────────────
async function sendMissingReminders(bot) {
  const res = await db.query(`SELECT * FROM v_missing_days LIMIT 200`);
  for (const row of res.rows) {
    if (!row.telegram_chat_id) continue;
    const session = { lang: row.lang || 'uk' };
    const days = row.missing_dates
      .map((d) => { const dt = new Date(d); return `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}`; })
      .join(', ');
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    const msg = T(session, 'missing_days_msg', row.full_name.split(' ')[0], mm, days);
    await sendMessage(bot, row.telegram_chat_id, msg);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`Reminders sent: ${res.rows.length}`);
}

module.exports = { handleUpdate, sendMissingReminders };
