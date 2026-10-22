require("dotenv").config();
const { requireAuth } = require("./api/admin");
const crypto = require("crypto");
const express = require("express");
const path = require("path");
const db = require("./db");
const { Telegraf } = require("telegraf");
const {
  handleUpdate,
  sendMissingReminders,
  sendTabeleReminders,
  sendCoordinatorReports,
} = require("./bot/handlers");
const gaps = require("./bot/gaps");
const medcheck = require("./bot/medcheck");
const { requireAdmin } = require("./api/admin");
const apiRoutes = require("./api/routes");
const { router: adminRoutes } = require("./api/admin");
const regional = require("./api/regional");
const care = require("./api/care");
const board = require("./api/board");
const hoursReport = require("./bot/hours_report");
const flow = require("./api/flow");
const broadcast = require("./api/broadcast");   // Rekrutacja → Wysyłka wiadomości
const referral = require("./bot/referral");

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.set("bot", bot);



// ── Static dashboard ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.use(async (req, res, next) => {
  try {
    const session = req.headers["x-session"];
    if (!session) return next();

    const r = await db.query(
      `
      SELECT c.*
      FROM coordinator_sessions cs
      JOIN coordinators c ON c.id = cs.coordinator_id
      WHERE cs.token = $1
    `,
      [session],
    );

    if (r.rows[0]) {
      req.user = r.rows[0];
    }
  } catch (e) {
    console.error("auth error", e);
  }

  next();
});


// ── API routes ────────────────────────────────────────────────
app.use("/api", apiRoutes);
app.use("/api/tg", require("./api/tg").router);
app.use("/api/regional", regional.router);
app.use("/api/care", care.router);
app.use("/api/board", board.router);
app.use("/api/flow", flow.router);
app.use("/api/hours-report", hoursReport.router);
app.use("/api/ref", require("./api/ref").router);
app.use("/api/broadcast", broadcast.router);
app.use("/api/hrsign", require("./api/hr_sign").router);   // підписи документів HRappka (Pracownicy → Dokumenty)
app.use("/api", apiRoutes);
app.use("/api", require("./api/reports"));
app.use("/admin", adminRoutes);

// ── Webhook endpoint ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    // групи Telegram: запам'ятати чат для зведень «Wyjazdy / przyjazdy», боту працівників там робити нічого
    if (await flow.onUpdate(req.body)) return;
    if (await referral.onUpdate(bot, req.body)) return;
    if (await require("./bot/coord").onUpdate(bot, req.body)) return;
    await handleUpdate(bot, req.body);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date() }));

// ── Root — serve login page ───────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

//Bot settings
// тільки з логіном; id — число (сканери смикають адреси з JS буквально: «/api/facility-settings/${facilityId}»)
app.get("/api/facility-settings/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
  try {
    const r = await db.query("SELECT * FROM facility_settings WHERE facility_id = $1", [id]);
    res.json(r.rows[0] || null);
  } catch (err) {
    console.error("facility-settings error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Ручний запуск розсилок: сесія адміна (?session=…, як /trigger/med-check) або заголовок x-trigger-token = TRIGGER_TOKEN з .env
// (для зовнішнього планувальника). Без цього будь-хто з інтернету міг запустити розсилку всім.
// Виняток «з localhost» не робимо: Caddy проксує всі запити з інтернету саме з localhost.
function triggerAuth(req, res, next) {
  const tok = String(process.env.TRIGGER_TOKEN || "");
  const given = String(req.headers["x-trigger-token"] || "");
  if (tok.length >= 16 && given.length === tok.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) return next();
  requireAuth(req, res, () => requireAdmin(req, res, next));
}

// ── Reminder trigger ──────────────────────────────────────────
app.post("/trigger/reminders", triggerAuth, async (req, res) => {
  res.json({ status: "started" });
  try {
    await sendMissingReminders(bot);
  } catch (err) {
    console.error("Reminder error:", err.message);
  }
});
// ── Coordinator report trigger (тест) ─────────────────────────
app.post("/trigger/coord-report", triggerAuth, async (req, res) => {
  res.json({ status: "started" });
  try {
    await sendCoordinatorReports(bot);
  } catch (err) {
    console.error("Coord report error:", err.message);
  }
});

// ── Серії незаповнених днів (>3 підряд) ───────────────────────
// Перегляд без відправки: GET /api/gaps/preview?session=<токен адміна>
app.get("/api/gaps/preview", requireAuth, requireAdmin, async (req, res) => {
  try {
    const list = await gaps.findGapWorkers();
    res.json({
      config: { ...gaps.CFG, adminChatIds: gaps.CFG.adminChatIds.length },
      total: list.length,
      willSpam: list.filter((w) => w.inBot && w.spamAllowed).length,
      notInBot: list.filter((w) => !w.inBot).length,
      fused: list.filter((w) => w.inBot && !w.spamAllowed).length,
      workers: list.map((w) => ({
        worker_id: w.worker_id, full_name: w.full_name, login: w.login,
        facility: w.facility_name, coordinators: w.coordinators,
        inBot: w.inBot, spamAllowed: w.spamAllowed, runs: w.runs,
      })),
    });
  } catch (e) {
    console.error("[Gaps] preview error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// Зведення адміну зараз
app.post("/trigger/gap-admin", requireAuth, requireAdmin, async (req, res) => {
  res.json({ status: "started" });
  try { await gaps.sendAdminGapSummary(bot); } catch (e) { console.error("[Gaps] admin error:", e.message); }
});
// Спам зараз (поза годинами теж). ?worker_id=123 — тільки одному працівнику (для тесту)
app.post("/trigger/gap-spam", requireAuth, requireAdmin, async (req, res) => {
  try {
    const workerId = req.query.worker_id ? parseInt(req.query.worker_id, 10) : null;
    const stats = await gaps.sendGapSpam(bot, { workerId, ignoreHours: true });
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Медосмотры: BHP из базы ↔ таблица badania lekarskie ──────
// Просмотр без отправки и без записи: GET /api/med-check/preview?session=<токен админа>[&date=2026-10-13]
app.get("/api/med-check/preview", requireAuth, requireAdmin, async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? req.query.date : undefined;
    const r = await medcheck.runCheck({ date, dryRun: true });
    res.json({ date: r.date, window: r.window, sheet: r.sheet, counts: r.counts, text: r.text });
  } catch (e) {
    console.error("[MedCheck] preview error:", e.message);
    res.status(500).json({ error: e.message });
  }
});
// Отправить сводку сейчас: POST /trigger/med-check?session=<токен админа>  (&dry=1 — не сохранять состояние)
app.post("/trigger/med-check", requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await medcheck.sendReport(bot, { dryRun: req.query.dry === "1" }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
// ── Start (HTTP + HTTPS) ──────────────────────────────────────
const fs = require("fs");
const http = require("http");
const https = require("https");

// Нові міграції db/migration_*.sql — автоматично при старті (db/migrate.js); помилка не зупиняє сервер
require("./db/migrate").run().catch((e) => console.error("[migrate]", e.message));

const HTTP_PORT = process.env.PORT || 12080;        // дашборд / локалка
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;  // вебхук Telegram

const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, "certs", "private.key")),
  cert: fs.readFileSync(path.join(__dirname, "certs", "public.pem")),
};

// ── Старт серверів: самовідновлення після «осиротілого» процесу ──────
// pm2 на Windows іноді не добиває старий index при restart (зайнятий імпортом): той лишається з портами й розкладом
// (розсилки йшли б двічі), а кожен новий екземпляр падає з EADDRINUSE по колу. Тому:
//   • після старту пишемо свій PID у .index.pid;
//   • на старті: якщо порт тримає саме процес з .index.pid (перевірка netstat) — завершуємо його і займаємо порти;
//     чужі процеси не чіпаємо ніколи;
//   • порт зайнятий кимось іншим — зрозуміле повідомлення в лог і пауза 5 с перед виходом (не шалений цикл pm2).
const PID_FILE = path.join(__dirname, ".index.pid");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function portOwners(ports) {
  const owners = new Map();   // port → PID
  try {
    const out = require("child_process").execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
      if (m && ports.includes(Number(m[1]))) owners.set(Number(m[1]), Number(m[2]));
    }
  } catch (e) { /* немає netstat — пропускаємо */ }
  return owners;
}
async function freePortsFromOldInstance(ports) {
  let old = 0;
  try { old = Number(fs.readFileSync(PID_FILE, "utf8").trim()); } catch (e) { return; }
  if (!old || old === process.pid) return;
  const holds = () => [...portOwners(ports).values()].includes(old);
  if (!holds()) return;
  console.warn(`[start] порти ${ports.join(", ")} тримає попередній екземпляр index (PID ${old}) — завершую його`);
  try { process.kill(old); } catch (e) { /* уже завершився */ }
  for (let i = 0; i < 20 && holds(); i++) await sleepMs(500);
}
function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => { console.log(`${label} on ${port}`); resolve(); });
  });
}
(async () => {
  const ports = [Number(HTTPS_PORT), Number(HTTP_PORT)];
  await freePortsFromOldInstance(ports);
  try {
    await listen(https.createServer(httpsOptions, app), HTTPS_PORT, "HTTPS (webhook)");
    await listen(http.createServer(app), HTTP_PORT, "HTTP (dashboard)");
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      const owner = portOwners(ports).get(Number(e.port));
      console.error(`[start] порт ${e.port} зайнятий іншим процесом${owner ? ` (PID ${owner})` : ""} — не наш index; вихід через 5 с. ` +
        `Перевірте: netstat -ano | findstr :${e.port}`);
    } else console.error("[start]", e);
    await sleepMs(5000);
    process.exit(1);
  }
})();

// ── Daily reminder via setInterval (18:30 Warsaw time) ───────
function scheduleReminder() {
  const sentThisMinute = new Set();

  setInterval(async () => {
    try {
      const now = new Date();
      const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

      // ── Нагадування про години ────────────────────────────
      const res = await db.query(`
        SELECT fs.facility_id, fs.reminder_times
        FROM facility_settings fs
        WHERE fs.reminders_enabled = true
          AND fs.reminder_times IS NOT NULL
      `);

      for (const s of res.rows) {
        const times = s.reminder_times || [];
        for (const t of times) {
          if (t.substring(0, 5) === current) {
            const key = `${s.facility_id}_${current}`;
            if (sentThisMinute.has(key)) break;
            await sendMissingReminders(bot, [s.facility_id]);
            sentThisMinute.add(key);
            setTimeout(() => sentThisMinute.delete(key), 2 * 60 * 1000);
            break;
          }
        }
      }

      // ── Нагадування про табель о 10:00 ───────────────────
      if (current === "10:00") {
        const today = now.getDate();
        const lastDay = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
        ).getDate();
        if (today === lastDay || today === lastDay - 1) {
          await sendTabeleReminders(bot);
        }
      }
      
    } catch (e) {
      console.error("[Reminder] Error:", e.message);
    }

    // ── Серії >3 днів: зведення адміну + щогодинний спам 08–18 ──
    try {
      await gaps.tick(bot);
    } catch (e) {
      console.error("[Gaps] tick error:", e.message);
    }
  }, 60000);
}

function scheduleImport() {
  // Перший запуск через 5 хвилин після старту сервера
  setTimeout(
    async () => {
      // console.log(`[AutoImport] First run...`);
      try {
        const { runImport } = require("./import_sheets");
        await runImport();
      } catch (e) {
        console.error(`[AutoImport] Error:`, e.message);
      }
    },
    5 * 60 * 1000,
  );

  // Далі кожну годину
  setInterval(
    async () => {
      //  console.log(`[AutoImport] Hourly run...`);
      try {
        const { runImport } = require("./import_sheets");
        await runImport();
      } catch (e) {
        console.error(`[AutoImport] Error:`, e.message);
      }
    },
    60 * 60 * 1000 * 4,
  );
}

const cron = require('node-cron');
const { main: runHrappkaAudit } = require('./sync_hrrappka_diff');

// Щотижневий аудит HRappka: щопонеділка о 08:00 за Варшавою ('0 8 * * 1'; четвер — '0 8 * * 4').
// Помилку (HRappka не відповіла, пошта) лише пишемо в лог — інакше необроблена помилка могла б зупинити процес.
let hrappkaAuditRunning = false;
cron.schedule('0 8 * * 1', async () => {
  if (hrappkaAuditRunning) return;
  hrappkaAuditRunning = true;
  console.log('--- Запуск щотижневого аудиту HRappka ---');
  try {
    await runHrappkaAudit();
  } catch (err) {
    console.error('[HRappka audit] Error:', err.message);
  } finally {
    hrappkaAuditRunning = false;
  }
}, {
  timezone: "Europe/Warsaw"
});

app.get("/api/facility-settings-all", requireAuth, async (req, res) => {
  try {
    const user = req.coordinator;

    let r;

    if (user.is_admin) {
      r = await db.query(`
        SELECT f.id AS facility_id, f.name,
          fs.enable_advances, fs.enable_wolne, fs.enable_tabele,
          fs.hours_format, fs.days_keyboard, fs.reminders_enabled, fs.reminder_times
        FROM facilities f
        LEFT JOIN facility_settings fs ON fs.facility_id = f.id
        ORDER BY f.name
      `);
    } else {
      r = await db.query(
        `
        SELECT f.id AS facility_id, f.name,
          fs.enable_advances, fs.enable_wolne, fs.enable_tabele,
          fs.hours_format, fs.days_keyboard, fs.reminders_enabled, fs.reminder_times
        FROM coordinator_facilities cf
        JOIN facilities f ON f.id = cf.facility_id
        LEFT JOIN facility_settings fs ON fs.facility_id = f.id
        WHERE cf.coordinator_id = $1
        ORDER BY f.name
      `,
        [user.coordinator_id],
      );
    }

    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.patch("/api/facility-settings/:id", requireAuth, async (req, res) => {
  const { field, value } = req.body;

  // Admin — każdy zakład; koordynator — tylko z prawem edycji (główny / pomocniczy z edycją,
  // Region → Przypisania). Pomocniczy „tylko podgląd” i regionalny widzą ustawienia, ale ich nie zmieniają.
  if (!req.coordinator.is_admin) {
    const can = await db.query(
      `SELECT 1 FROM coordinator_facilities WHERE coordinator_id = $1 AND facility_id = $2 AND is_primary`,
      [req.coordinator.coordinator_id, parseInt(req.params.id, 10) || 0],
    );
    if (!can.rows.length) return res.status(403).json({ error: "Tylko podgląd — brak prawa edycji na tym zakładzie" });
  }

  const allowed = [
    "enable_advances",
    "enable_wolne",
    "enable_tabele",
    "hours_format",
    "days_keyboard",
    "reminders_enabled",
    "reminder_times",
  ];

  if (!allowed.includes(field)) {
    return res.status(400).json({ error: "Invalid field" });
  }

  try {
    const jsonbFields = ["reminder_times"];
    const val = jsonbFields.includes(field) ? JSON.stringify(value) : value;
    const cast = jsonbFields.includes(field) ? "::jsonb" : "";

    await db.query(
      `INSERT INTO facility_settings (facility_id, ${field})
       VALUES ($1, $2${cast})
       ON CONFLICT (facility_id)
       DO UPDATE SET ${field} = $2${cast}, updated_at = NOW()`,
      [req.params.id, val],
    );

    // Очищаємо кеш бота
    const { clearCacheForFacility } = require("./bot/settings");
    clearCacheForFacility(parseInt(req.params.id));

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

scheduleReminder();
scheduleImport();
regional.schedule(bot);
require("./bot/care").schedule(bot);
flow.schedule(bot);
require("./bot/coord").schedule(bot);
hoursReport.schedule(bot);
referral.schedule(bot);
medcheck.schedule(bot);
broadcast.schedule(bot);
require("./bot/fines").schedule(bot);   // штрафи: повідомлення працівнику
require("./bot/fines_sheet").schedule();  // штрафи → Google-таблиця: повтор незаписаних
require("./bot/hr_sign").schedule(bot);    // підписи HRappka: 6:00 перевірка, 7:00 звіт, 10:00 нагадування працівникам

//new