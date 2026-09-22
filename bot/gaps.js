// bot/gaps.js — серії незаповнених днів (>3 дні підряд):
//   1) щоденна зведена відправка адміну (одне повідомлення, ріжеться по 4000 символів)
//   2) щогодинний «спам» працівнику 08:00–18:00 з кнопками конкретних дат
//
// Без окремих таблиць — все рахується з worker_facility_history + hours_log.
//
// Налаштування в .env (рестарт pm2 після зміни):
//   GAP_ADMIN_CHAT_ID=123456789        — кому слати зведення (можна кілька через кому)
//   GAP_MIN_DAYS=4                     — «більше 3 днів підряд» = від 4
//   GAP_FROM_DATE=2026-09-01           — все, що раніше цієї дати, ігноруємо; від неї дивимось завжди
//   GAP_LOOKBACK_DAYS=45               — вікно назад, якщо GAP_FROM_DATE не задано
//   GAP_SPAM_MAX_DAYS=5                — запобіжник: скільки днів максимум спамимо по одній серії
//   GAP_SPAM_FROM=8                    — перша година спаму
//   GAP_SPAM_TO=18                     — остання година спаму
//   GAP_ADMIN_TIME=08:00               — коли слати зведення адміну
//   GAP_SEND_DELAY_MS=50               — пауза між повідомленнями (~20 msg/s, ліміт Telegram 30/s)
//   GAP_SPAM_START=2026-09-21          — дата запуску: запобіжник рахує дні спаму не раніше неї
//                                        (щоб старі довгі серії теж отримали свої 5 днів спаму)
//   GAP_ENABLED=1                      — 0 = повністю вимкнути

const db = require("../db");

const num = (v, d) => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : d;
};

const CFG = {
  enabled: String(process.env.GAP_ENABLED ?? "1").trim() !== "0",
  adminChatIds: String(process.env.GAP_ADMIN_CHAT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  minDays: num(process.env.GAP_MIN_DAYS, 4),
  lookback: num(process.env.GAP_LOOKBACK_DAYS, 45),
  spamMaxDays: num(process.env.GAP_SPAM_MAX_DAYS, 5),
  spamFrom: num(process.env.GAP_SPAM_FROM, 8),
  spamTo: num(process.env.GAP_SPAM_TO, 18),
  adminTime: (process.env.GAP_ADMIN_TIME || "08:00").trim(),
  delayMs: num(process.env.GAP_SEND_DELAY_MS, 50),
  fromDate: /^\d{4}-\d{2}-\d{2}$/.test(String(process.env.GAP_FROM_DATE || "").trim())
    ? String(process.env.GAP_FROM_DATE).trim()
    : null,
  spamStart: /^\d{4}-\d{2}-\d{2}$/.test(String(process.env.GAP_SPAM_START || "").trim())
    ? String(process.env.GAP_SPAM_START).trim()
    : null,
};

const MAX_BUTTONS = 15; // 3 ряди по 5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Дати (локальний час сервера = Варшава) ───────────────────
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseIso(s) {
  const [y, m, d] = String(s).substring(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(a, b) {
  // b - a у днях, a/b — Date з 00:00
  return Math.round((b - a) / 86400000);
}
function ddmm(iso) {
  const d = parseIso(iso);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function todayLocal() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function yesterdayIso() {
  const t = todayLocal();
  t.setDate(t.getDate() - 1);
  return isoLocal(t);
}
// Початок вікна: GAP_FROM_DATE (фіксовано) або вчора - (LOOKBACK-1)
function windowStartIso() {
  if (CFG.fromDate) return CFG.fromDate;
  const t = todayLocal();
  t.setDate(t.getDate() - CFG.lookback);
  return isoLocal(t);
}
function eachDay(startIso, endIso) {
  const out = [];
  const d = parseIso(startIso);
  const end = parseIso(endIso);
  while (d <= end) {
    out.push(isoLocal(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Основний запит: серії >= GAP_MIN_DAYS пропущених днів ─────
// Активний = статус 'pracuje' на вчора (як у звіті координаторам).
// День «покритий», якщо входить у будь-який період працівника (крім zwolniony/rezygnacja),
// тобто переведення між об'єктами серію не рвуть, а дні до BHP / між роботами — рвуть.
// День «заповнений», якщо є будь-який запис у hours_log (години або код відсутності).
async function findGapWorkers(workerId = null) {
  const res = await db.query(
    `
    WITH active AS (
      SELECT DISTINCT ON (h.worker_id) h.worker_id, h.facility_id
      FROM worker_facility_history h
      JOIN workers w ON w.id = h.worker_id
      WHERE h.status::text = 'pracuje'
        AND h.bhp_date <= $1::date
        AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
        AND w.login NOT LIKE 'TEST_%'
        AND ($4::int IS NULL OR h.worker_id = $4::int)
      ORDER BY h.worker_id, h.bhp_date DESC
    ),
    missing AS (
      SELECT a.worker_id, gs::date AS d
      FROM active a
      CROSS JOIN generate_series($2::date, $1::date, interval '1 day') gs
      WHERE EXISTS (
              SELECT 1 FROM worker_facility_history h2
              WHERE h2.worker_id = a.worker_id
                AND h2.status::text NOT IN ('zwolniony', 'rezygnacja')
                AND h2.bhp_date <= gs::date
                AND (h2.last_work_date IS NULL OR h2.last_work_date >= gs::date)
            )
        AND NOT EXISTS (
              SELECT 1 FROM hours_log hl
              WHERE hl.worker_id = a.worker_id AND hl.work_date = gs::date
            )
    ),
    grouped AS (
      SELECT worker_id, d,
             d - (ROW_NUMBER() OVER (PARTITION BY worker_id ORDER BY d))::int AS grp
      FROM missing
    ),
    runs AS (
      SELECT worker_id, MIN(d) AS run_start, MAX(d) AS run_end, COUNT(*)::int AS run_len
      FROM grouped
      GROUP BY worker_id, grp
      HAVING COUNT(*) >= $3::int
    )
    SELECT w.id AS worker_id, w.full_name, w.login, w.telegram_chat_id, w.lang,
           a.facility_id, f.name AS facility_name,
           (SELECT string_agg(DISTINCT c.full_name, ', ')
              FROM coordinator_facilities cf
              JOIN coordinators c ON c.id = cf.coordinator_id
             WHERE cf.facility_id = a.facility_id AND c.is_active = true) AS coordinators,
           json_agg(json_build_object(
             'start', to_char(r.run_start, 'YYYY-MM-DD'),
             'end',   to_char(r.run_end,   'YYYY-MM-DD'),
             'len',   r.run_len
           ) ORDER BY r.run_start) AS runs
    FROM runs r
    JOIN active a     ON a.worker_id = r.worker_id
    JOIN workers w    ON w.id = r.worker_id
    JOIN facilities f ON f.id = a.facility_id
    GROUP BY w.id, w.full_name, w.login, w.telegram_chat_id, w.lang, a.facility_id, f.name
    ORDER BY f.name, w.full_name
    `,
    [yesterdayIso(), windowStartIso(), CFG.minDays, workerId],
  );

  const today = todayLocal();
  const yIso = yesterdayIso();
  const winStart = windowStartIso();

  return res.rows.map((r) => {
    const runs = (r.runs || []).map((run) => {
      // Серію «помічено» на наступний день після MIN-го пропущеного дня.
      // spamDay = який це день спаму по цій серії (1, 2, ...). Запобіжник — spamDay > MAX.
      const detected = parseIso(run.start);
      detected.setDate(detected.getDate() + CFG.minDays);
      const from = CFG.spamStart && parseIso(CFG.spamStart) > detected ? parseIso(CFG.spamStart) : detected;
      const spamDay = daysBetween(from, today) + 1;
      return {
        ...run,
        open: run.end === yIso, // триває досі
        truncated: !CFG.fromDate && run.start === winStart, // почалась раніше за вікно
        spamDay,
        spamAllowed: spamDay >= 1 && spamDay <= CFG.spamMaxDays,
      };
    });
    const dates = runs.flatMap((run) => eachDay(run.start, run.end));
    return {
      ...r,
      runs,
      dates,
      maxLen: Math.max(...runs.map((x) => x.len)),
      inBot: !!r.telegram_chat_id,
      spamAllowed: runs.some((x) => x.spamAllowed),
    };
  });
}

// ── Тексти для працівника ─────────────────────────────────────
const TXT = {
  uk: {
    msg: (name, n, dates, more) =>
      `⚠️ ${name}, у тебе не заповнені години за ${n} дн.: ${dates}${more}.\n\n` +
      `Без цих днів координатор не зможе перевірити години, і зарплата може бути нарахована не вчасно або не в повному обсязі.\n\n` +
      `👇 Натисни на дату і вкажи години або причину відсутності. Нагадування приходитимуть щогодини, доки не заповниш.`,
    more: (k) => ` і ще ${k}`,
    gaps_title: "⚠️ Незаповнені дні:",
    day_picked: (d) => `📅 ${d}`,
  },
  ru: {
    msg: (name, n, dates, more) =>
      `⚠️ ${name}, у тебя не заполнены часы за ${n} дн.: ${dates}${more}.\n\n` +
      `Без этих дней координатор не сможет проверить часы, и зарплата может быть начислена не вовремя или не в полном объёме.\n\n` +
      `👇 Нажми на дату и укажи часы или причину отсутствия. Напоминания будут приходить каждый час, пока не заполнишь.`,
    more: (k) => ` и ещё ${k}`,
    gaps_title: "⚠️ Незаполненные дни:",
    day_picked: (d) => `📅 ${d}`,
  },
  pl: {
    msg: (name, n, dates, more) =>
      `⚠️ ${name}, masz nieuzupełnione godziny za ${n} dni: ${dates}${more}.\n\n` +
      `Bez tych dni koordynator nie może sprawdzić godzin, a wynagrodzenie może zostać naliczone z opóźnieniem lub nie w pełnej kwocie.\n\n` +
      `👇 Kliknij datę i wpisz godziny lub powód nieobecności. Przypomnienia będą przychodzić co godzinę, dopóki nie uzupełnisz.`,
    more: (k) => ` i jeszcze ${k}`,
    gaps_title: "⚠️ Nieuzupełnione dni:",
    day_picked: (d) => `📅 ${d}`,
  },
  en: {
    msg: (name, n, dates, more) =>
      `⚠️ ${name}, your hours are missing for ${n} days: ${dates}${more}.\n\n` +
      `Without these days your coordinator can't verify your hours, and your salary may be paid late or not in full.\n\n` +
      `👇 Tap a date and enter hours or the absence reason. Reminders will come every hour until you fill them in.`,
    more: (k) => ` and ${k} more`,
    gaps_title: "⚠️ Missing days:",
    day_picked: (d) => `📅 ${d}`,
  },
};
const tx = (lang) => TXT[lang] || TXT.uk;

// Кнопки з датами: callback GAP_YYYYMMDD
function gapButtons(dates) {
  const shown = dates.slice(0, MAX_BUTTONS);
  const rows = [];
  for (let i = 0; i < shown.length; i += 5) {
    rows.push(
      shown.slice(i, i + 5).map((iso) => ({
        text: ddmm(iso),
        callback_data: `GAP_${iso.replace(/-/g, "")}`,
      })),
    );
  }
  return rows;
}

// Для головної клавіатури бота: рядки кнопок пропущених днів (або null)
async function gapRowsForWorker(workerId, lang) {
  if (!CFG.enabled || !workerId) return null;
  try {
    const list = await findGapWorkers(workerId);
    if (!list.length) return null;
    return [[{ text: tx(lang).gaps_title, callback_data: "GAP_NOOP" }], ...gapButtons(list[0].dates)];
  } catch (e) {
    console.error("[Gaps] rows error:", e.message);
    return null;
  }
}

// Розбір callback GAP_YYYYMMDD → { iso, ddmm } або null (дата поза вікном / майбутня)
function parseGapPayload(payload) {
  const m = /^GAP_(\d{4})(\d{2})(\d{2})$/.exec(payload);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = parseIso(iso);
  if (isNaN(d)) return null;
  const age = daysBetween(d, todayLocal());
  if (age < 1 || iso < windowStartIso()) return null;
  return { iso, ddmm: `${m[3]}${m[2]}`, label: `${m[3]}.${m[2]}.${m[1]}` };
}

// ── Telegram з троттлінгом і повтором на 429 ──────────────────
async function tgSend(bot, chatId, text, extra = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const msg = await bot.telegram.sendMessage(chatId, text, extra);
      return { ok: true, messageId: msg.message_id };
    } catch (e) {
      const code = e?.response?.error_code;
      const retry = e?.response?.parameters?.retry_after;
      if (code === 429 && retry) {
        await sleep((retry + 1) * 1000);
        continue;
      }
      return { ok: false, code, error: e.message };
    }
  }
  return { ok: false, code: 429, error: "rate limited" };
}

async function sendLongHtml(bot, chatId, text) {
  const LIMIT = 4000;
  const chunks = [];
  let chunk = "";
  for (const line of text.split("\n")) {
    if (chunk && (chunk + "\n" + line).length > LIMIT) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk) chunks.push(chunk);
  for (const c of chunks) {
    const r = await tgSend(bot, chatId, c, { parse_mode: "HTML", disable_web_page_preview: true });
    if (!r.ok) console.error("[Gaps] admin send error:", r.error);
    await sleep(300);
  }
}

// ── 1) Зведення адміну (одне повідомлення) ────────────────────
function fmtRun(run) {
  const range = run.start === run.end ? ddmm(run.start) : `${ddmm(run.start)}–${ddmm(run.end)}`;
  return `${range} (${run.truncated ? "≥" : ""}${run.len} дн.${run.open ? "" : ", закрита"})`;
}

async function sendAdminGapSummary(bot) {
  if (!CFG.enabled) return;
  if (!CFG.adminChatIds.length) {
    console.warn("[Gaps] GAP_ADMIN_CHAT_ID не задано в .env — зведення не відправлено");
    return;
  }
  const list = await findGapWorkers();
  const today = todayLocal();
  const dateLbl = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}`;

  let text;
  if (!list.length) {
    text = `✅ <b>${dateLbl}</b> — немає працівників з пропуском більше ${CFG.minDays - 1} днів підряд.`;
  } else {
    const notInBot = list.filter((w) => !w.inBot).length;
    const fused = list.filter((w) => w.inBot && !w.spamAllowed).length;
    const spam = list.filter((w) => w.inBot && w.spamAllowed).length;

    const byFac = new Map();
    for (const w of list) {
      if (!byFac.has(w.facility_name)) byFac.set(w.facility_name, { coords: w.coordinators, items: [] });
      byFac.get(w.facility_name).items.push(w);
    }

    const lines = [
      `🚨 <b>Не заповнено більше ${CFG.minDays - 1} днів підряд — ${dateLbl}</b>`,
      `Працівників: <b>${list.length}</b>`,
      `📨 отримують нагадування щогодини: ${spam}`,
      `🔕 не в боті: ${notInBot}`,
      `⛔ запобіжник (спамили вже ${CFG.spamMaxDays} дн., далі — тільки тут): ${fused}`,
    ];
    for (const [fac, g] of byFac) {
      lines.push("");
      lines.push(`🏭 <b>${escHtml(fac)}</b> (${g.items.length})${g.coords ? ` — ${escHtml(g.coords)}` : ""}`);
      for (const w of g.items) {
        const flag = !w.inBot ? " 🔕" : !w.spamAllowed ? " ⛔" : "";
        lines.push(
          `• ${escHtml(w.full_name)} (${escHtml(w.login)})${flag}: ${w.runs.map(fmtRun).join("; ")}`,
        );
      }
    }
    text = lines.join("\n");
  }

  for (const chatId of CFG.adminChatIds) {
    await sendLongHtml(bot, chatId, text);
  }
  console.log(`[Gaps] Admin summary sent: ${list.length} workers`);
}

// ── 2) Щогодинний спам працівникам ────────────────────────────
const lastSpamMsg = new Map(); // chatId → message_id попереднього нагадування (видаляємо, щоб не засмічувати чат)
let spamRunning = false;

async function sendGapSpam(bot, { workerId = null, ignoreHours = false, force = false } = {}) {
  if (!CFG.enabled) return { skipped: "disabled" };
  const h = new Date().getHours();
  if (!ignoreHours && (h < CFG.spamFrom || h > CFG.spamTo)) return { skipped: "outside hours" };
  if (spamRunning) return { skipped: "already running" };
  spamRunning = true;

  const stats = { candidates: 0, sent: 0, blocked: 0, failed: 0, fused: 0, notInBot: 0 };
  try {
    // Список перераховується перед КОЖНОЮ розсилкою — заповнив дні → серія зникла → спам зупинився
    const list = await findGapWorkers(workerId);
    stats.candidates = list.length;

    for (const w of list) {
      if (!w.inBot) { stats.notInBot++; continue; }
      if (!w.spamAllowed && !force) { stats.fused++; continue; } // force — тільки для тесту одному працівнику

      const t = tx(w.lang);
      const firstName = String(w.full_name || "").split(" ")[0] || "";
      const shown = w.dates.slice(0, MAX_BUTTONS);
      const rest = w.dates.length - shown.length;
      const text = t.msg(firstName, w.dates.length, shown.map(ddmm).join(", "), rest > 0 ? t.more(rest) : "");

      const prev = lastSpamMsg.get(String(w.telegram_chat_id));
      if (prev) {
        bot.telegram.deleteMessage(w.telegram_chat_id, prev).catch(() => {});
      }

      const r = await tgSend(bot, w.telegram_chat_id, text, {
        reply_markup: { inline_keyboard: gapButtons(w.dates) },
      });
      if (r.ok) {
        stats.sent++;
        lastSpamMsg.set(String(w.telegram_chat_id), r.messageId);
      } else if (r.code === 403) {
        stats.blocked++; // заблокував бота / видалив чат
      } else {
        stats.failed++;
        console.error(`[Gaps] spam error worker ${w.worker_id}:`, r.error);
      }
      await sleep(CFG.delayMs);
    }
    console.log("[Gaps] Spam:", JSON.stringify(stats));
    return stats;
  } catch (e) {
    console.error("[Gaps] spam error:", e.message);
    return { ...stats, error: e.message };
  } finally {
    spamRunning = false;
  }
}

// ── Планувальник: викликати з існуючого щохвилинного setInterval ──
const firedKeys = new Set();
async function tick(bot, now = new Date()) {
  if (!CFG.enabled) return;
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const current = `${hh}:${mi}`;
  const day = isoLocal(now);

  const once = async (key, fn) => {
    const k = `${day}_${key}`;
    if (firedKeys.has(k)) return;
    firedKeys.add(k);
    if (firedKeys.size > 200) {
      for (const x of firedKeys) if (!x.startsWith(day)) firedKeys.delete(x);
    }
    await fn();
  };

  // Спочатку зведення адміну, потім перша хвиля спаму
  if (current === CFG.adminTime) {
    await once(`admin_${current}`, () => sendAdminGapSummary(bot));
  }
  if (mi === "00" && now.getHours() >= CFG.spamFrom && now.getHours() <= CFG.spamTo) {
    await once(`spam_${current}`, () => sendGapSpam(bot));
  }
}

module.exports = {
  CFG,
  findGapWorkers,
  gapRowsForWorker,
  parseGapPayload,
  sendAdminGapSummary,
  sendGapSpam,
  tick,
  tx,
};