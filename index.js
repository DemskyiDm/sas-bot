require('dotenv').config();
const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const { handleUpdate, sendMissingReminders } = require('./bot/handlers');
const apiRoutes = require('./api/routes');
const { router: adminRoutes } = require('./api/admin');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// ── Static dashboard ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ────────────────────────────────────────────────
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

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
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── Root — serve login page ───────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Reminder trigger ──────────────────────────────────────────
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});

bot.use(async (ctx) => {
  try {
    await handleUpdate(bot, ctx.update);
  } catch (err) {
    console.error('Bot error:', err.message);
  }
});

bot.launch();
console.log('Bot started in polling mode');

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
