require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { handleUpdate, sendMissingReminders } = require('./bot/handlers');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// ── Webhook endpoint ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    await handleUpdate(bot, req.body);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Reminder trigger (call manually or via cron) ──────────────
app.post('/trigger/reminders', async (req, res) => {
  res.json({ status: 'started' });
  try {
    await sendMissingReminders(bot);
  } catch (err) {
    console.error('Reminder error:', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot server running on port ${PORT}`);

  // Set webhook
  const url = process.env.WEBHOOK_URL;
  if (url) {
    await bot.telegram.setWebhook(`${url}/webhook`);
    console.log(`Webhook set: ${url}/webhook`);
  } else {
    console.warn('WEBHOOK_URL not set in .env — webhook not registered');
  }
});
/*
app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});

scheduleReminder();

// Polling mode — для теста без HTTPS
bot.on('update', async (update) => {
  await handleUpdate(bot, update);
});
bot.launch();
console.log('Bot started in polling mode');*/


// ── Daily reminder via setInterval (18:30 Warsaw time) ───────
function scheduleReminder() {
  const checkInterval = 60 * 1000;
  setInterval(async () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
    if (now.getHours() === 18 && now.getMinutes() === 30) {
      console.log('Running daily reminder...');
      await sendMissingReminders(bot).catch(console.error);
    }
  }, checkInterval);
}
scheduleReminder();
