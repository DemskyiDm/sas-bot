// api/hr_import.js — розбіжності HRappka ↔ таблиці для панелі (hrappka.html). app.use("/api/hrimport", hrImport.router)
//   GET  /diffs[?full=1]  — розбіжності з останнього знімка HRappka (щодня о 8:00); full — усі періоди, інакше відкриті й закриті за 60 днів
//   GET  /diffs.csv[?full=1] — те саме CSV-файлом (як у листі)
//   POST /refresh          — новий знімок з HRappka зараз (лише адмін, ~1 хв)
// Видимість — як у Pracownicy: адмін — усі, інші — свої заклади; «Немає в БД» (закладу немає) — лише адмін. Логіка — bot/hr_import.js.
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const hr = require("../bot/hr_import");

router.use(requireAuth);
const fail = (res, e) => {
  console.error("[hr import api]", e.message);
  const missing = /hrz\.people|hr_employee_id/.test(e.message) && /nie istnieje|does not exist/.test(e.message);
  res.status(500).json({ ok: false, error: missing ? "Brak tabel — uruchom db/migration_hr_import.sql" : e.message });
};

// типи й примітки з bot/hr_import.js (українською, для листа) → коди для панелі
const CODE = { "Статус": "status", "Останній день": "last_day", "Паспорт": "passport", "Немає в БД": "not_in_db", "Немає в HRappka": "not_in_hr" };
const NOTE = {
  "у HRappka є, у таблиці немає": "hr_only",
  "у HRappka не внесено": "hr_missing",
  "знайдено за ПІБ, у HRappka інший паспорт / PESEL": "by_name",
  "до 7 днів — беремо HRappka": "gap_small",
  "понад 7 днів — перевірити": "gap_big",
};

async function visibleDiffs(c, full) {
  const r = await hr.current({ full });
  let facs = null;
  if (!c.is_admin) {
    facs = new Set((await db.query(`SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`, [c.coordinator_id])).rows
      .map((x) => x.facility_id));
  }
  r.diffs = r.diffs.filter((d) => (facs ? d.w && facs.has(d.w.facility_id) : true));
  return r;
}

router.get("/diffs", async (req, res) => {
  try {
    const r = await visibleDiffs(req.coordinator, req.query.full === "1");
    const rows = r.diffs.map(({ type, note, w = {}, p = {}, hr: expected }) => ({
      code: CODE[type] || type, note: NOTE[note] || note || null, hr_expected: expected || null,
      worker_id: w.id || null, name: w.full_name || p.name, passport: w.login || p.passport, hr_passport: p.passport || null,
      pesel: p.pesel || null, birth: p.birth || w.birth || null,
      facility_id: w.facility_id || null, facility: w.facility || null, status: w.status || null, bhp: w.bhp || null, lwd: w.lwd || null,
      hr_id: p.id || null, hr_state: p.state || null, hr_last_day: p.lastDay || null, hr_department: p.department || null,
      hr_firm: p.firm || null, hr_position: p.position || null, hr_start: p.start || null,
    }));
    res.json({ ok: true, snapshot_at: r.snapshotAt, today: r.today, recent_days: r.recentDays, full: req.query.full === "1",
      is_admin: !!req.coordinator.is_admin, rows });
  } catch (e) { fail(res, e); }
});

router.get("/diffs.csv", async (req, res) => {
  try {
    const r = await visibleDiffs(req.coordinator, req.query.full === "1");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="hrappka_${r.today}${req.query.full === "1" ? "_full" : ""}.csv"`);
    res.send(hr.toCsv(r.diffs));
  } catch (e) { fail(res, e); }
});

router.post("/refresh", async (req, res) => {
  if (!req.coordinator.is_admin) return res.status(403).json({ ok: false, error: "Tylko administrator" });
  try {
    const r = await hr.refresh();
    res.json({ ok: true, people: r.stats.people, matched: r.stats.matched });
  } catch (e) { fail(res, e); }
});

module.exports = { router };
