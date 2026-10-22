// db/migrate.js — міграції БД при старті сервера (index.js), щоб не забувати запускати psql вручну.
//   • public.schema_migrations — що вже застосовано: назва файлу, контрольна сума (sha256), коли;
//   • новий файл db/migration_*.sql — застосовується автоматично;
//   • змінений файл — повторно, лише якщо в ньому позначка «(можна повторно)» (міграція безпечна для повтору);
//     без позначки — тільки попередження в лог (запустіть вручну, якщо треба);
//   • перший запуск (таблиці ще немає) — усі наявні файли вважаються вже застосованими (у робочій БД вони є),
//     нічого не виконується.
// Помилка міграції не зупиняє сервер: пишемо в лог і не позначаємо файл застосованим — наступний старт спробує знову.
// Вручну: node db/migrate.js            — застосувати
//         node db/migrate.js --status   — лише показати, що буде зроблено
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./index");

const DIR = __dirname;
const LOCK = 7_420_311;   // pg_advisory_lock — два процеси одночасно не мігрують
const REPEATABLE = /\(можна повторно\)/;
const files = () => fs.readdirSync(DIR).filter((f) => /^migration_.+\.sql$/.test(f)).sort();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function plan(client) {
  const exists = (await client.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
  const done = new Map();
  if (exists) (await client.query(`SELECT name, checksum FROM public.schema_migrations`)).rows.forEach((x) => done.set(x.name, x.checksum));
  return files().map((name) => {
    const sql = fs.readFileSync(path.join(DIR, name), "utf8");
    const sum = sha(sql);
    let action = "ok";
    if (!exists) action = "baseline";
    else if (!done.has(name)) action = "apply";
    else if (done.get(name) !== sum) action = REPEATABLE.test(sql) ? "reapply" : "changed";
    return { name, sql, sum, action };
  });
}

async function run({ dry = false, log = console.log } = {}) {
  const client = await db.pool.connect();
  const summary = { applied: [], baseline: 0, changed: [], failed: [] };
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [LOCK]);
    const items = await plan(client);
    if (dry) return items.map(({ name, action }) => ({ name, action }));
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), mode TEXT NOT NULL)`);
    const mark = (x, mode) => client.query(
      `INSERT INTO public.schema_migrations (name, checksum, mode) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now(), mode = EXCLUDED.mode`, [x.name, x.sum, mode]);
    for (const x of items) {
      if (x.action === "baseline") { await mark(x, "baseline"); summary.baseline++; continue; }
      if (x.action === "changed") { summary.changed.push(x.name); continue; }
      if (x.action !== "apply" && x.action !== "reapply") continue;
      try {
        // файл сам має BEGIN / COMMIT (і SET client_encoding) — виконуємо як є, одним запитом
        await client.query(x.sql);
        await mark(x, x.action);
        summary.applied.push(`${x.name}${x.action === "reapply" ? " (повторно)" : ""}`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});   // якщо файл упав посеред своєї транзакції
        summary.failed.push(`${x.name}: ${e.message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK]).catch(() => {});
    client.release();
  }
  if (summary.baseline) log(`[migrate] перший запуск: ${summary.baseline} наявних міграцій позначено як застосовані`);
  if (summary.applied.length) log(`[migrate] застосовано: ${summary.applied.join(", ")}`);
  if (summary.changed.length) log(`[migrate] змінені без позначки «(можна повторно)» — не запускаю, перевірте вручну: ${summary.changed.join(", ")}`);
  summary.failed.forEach((f) => console.error(`[migrate] ПОМИЛКА ${f}`));
  return summary;
}

module.exports = { run, plan };

if (require.main === module) {
  require("dotenv").config();
  const dry = process.argv.includes("--status");
  run({ dry }).then((r) => {
    if (dry) r.forEach((x) => console.log(`${x.action.padEnd(9)} ${x.name}`));
    process.exit(r.failed && r.failed.length ? 1 : 0);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
