require("dotenv").config();
const { requireAuth } = require("./api/admin");
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
const { requireAdmin } = require("./api/admin");
const apiRoutes = require("./api/routes");
const { router: adminRoutes } = require("./api/admin");

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
app.use("/api", require("./api/reports"));
app.use("/admin", adminRoutes);

// ── Webhook endpoint ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
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
app.get("/api/facility-settings/:id", async (req, res) => {
  const r = await db.query(
    "SELECT * FROM facility_settings WHERE facility_id = $1",
    [req.params.id],
  );
  res.json(r.rows[0]);
});

// ── Reminder trigger ──────────────────────────────────────────
app.post("/trigger/reminders", async (req, res) => {
  res.json({ status: "started" });
  try {
    await sendMissingReminders(bot);
  } catch (err) {
    console.error("Reminder error:", err.message);
  }
});
// ── Coordinator report trigger (тест) ─────────────────────────
app.post("/trigger/coord-report", async (req, res) => {
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

// ── Start ─────────────────────────────────────────────────────
// ── Start (HTTP + HTTPS) ──────────────────────────────────────
const fs = require("fs");
const http = require("http");
const https = require("https");

const HTTP_PORT = process.env.PORT || 12080;        // дашборд / локалка
const HTTPS_PORT = process.env.HTTPS_PORT || 8443;  // вебхук Telegram

const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, "certs", "private.key")),
  cert: fs.readFileSync(path.join(__dirname, "certs", "public.pem")),
};

https.createServer(httpsOptions, app).listen(HTTPS_PORT, "0.0.0.0", () => {
  console.log(`HTTPS (webhook) on ${HTTPS_PORT}`);
});

http.createServer(app).listen(HTTP_PORT, "0.0.0.0", () => {
  console.log(`HTTP (dashboard) on ${HTTP_PORT}`);
});

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
      if (current === "17:00") {
        const key = `coord_report_${current}`;
        if (!sentThisMinute.has(key)) {
          await sendCoordinatorReports(bot);
          sentThisMinute.add(key);
          setTimeout(() => sentThisMinute.delete(key), 2 * 60 * 1000);
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

app.patch("/api/facility-settings/:id", async (req, res) => {
  const { field, value } = req.body;

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
