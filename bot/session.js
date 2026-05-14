const db = require('../db');

async function getSession(chatId) {
  const res = await db.query(
    'SELECT session_data FROM workers WHERE telegram_chat_id = $1',
    [chatId]
  );
  if (res.rows.length === 0) return {};
  return res.rows[0].session_data || {};
}

async function saveSession(chatId, session) {
  await db.query(
    `UPDATE workers SET session_data = $1 WHERE telegram_chat_id = $2`,
    [JSON.stringify(session), chatId]
  );
}

async function clearSession(chatId) {
  await db.query(
    `UPDATE workers SET session_data = '{}' WHERE telegram_chat_id = $1`,
    [chatId]
  );
}

// For users not yet in DB — use temp in-memory store
const tempSessions = {};

async function getSessionSafe(chatId) {
  try {
    const s = await getSession(chatId);
    if (s && Object.keys(s).length > 0) return s;
  } catch (e) {}
  return tempSessions[chatId] || {};
}

async function saveSessionSafe(chatId, session) {
  tempSessions[chatId] = session;
  try { await saveSession(chatId, session); } catch (e) {}
}

async function clearSessionSafe(chatId) {
  delete tempSessions[chatId];
  try { await clearSession(chatId); } catch (e) {}
}

module.exports = { getSessionSafe, saveSessionSafe, clearSessionSafe };
