// api/hr_sign.js — підписи документів HRappka для панелі. app.use("/api/hrsign", hrSign.router)
//   GET  /status            — зведення по видимих працівниках, яких уже перевіряли (Pracownicy → «Dokumenty»)
//   POST /refresh {ids}     — перевірити зараз (кнопка «Sprawdź podpisy»; не частіше ніж раз на хвилину на людину)
// Видимість — як у Pracownicy: адмін — усі, інші — свої заклади (coordinator_facilities). Логіка — bot/hr_sign.js.
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("./admin");
const hr = require("../bot/hr_sign");

router.use(requireAuth);
const MAX_IDS = 500;
const fail = (res, e) => {
  console.error("[hr sign api]", e.message);
  const missing = /hrs\.(docs|checks)/.test(e.message) && /nie istnieje|does not exist/.test(e.message);
  res.status(500).json({ ok: false, error: missing ? "Brak tabel — uruchom db/migration_hr_sign.sql" : e.message });
};
async function facs(c) {
  if (c.is_admin) return null;
  const r = await db.query(`SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`, [c.coordinator_id]);
  return r.rows.map((x) => x.facility_id);
}
// з ids — лише видимі цьому користувачу
async function visible(c, ids) {
  const f = await facs(c);
  const r = await db.query(
    `SELECT id FROM v_worker_current WHERE id = ANY($1::int[]) AND ($2::int[] IS NULL OR facility_id = ANY($2::int[]))`, [ids, f]);
  return r.rows.map((x) => x.id);
}

router.get("/status", async (req, res) => {
  try {
    const f = await facs(req.coordinator);
    const r = await db.query(
      `SELECT k.worker_id FROM hrs.checks k JOIN v_worker_current v ON v.id = k.worker_id
        WHERE ($1::int[] IS NULL OR v.facility_id = ANY($1::int[]))`, [f]);
    res.json({ ok: true, from: hr.FROM, rows: await hr.summary(r.rows.map((x) => x.worker_id)) });
  } catch (e) { fail(res, e); }
});

router.post("/refresh", async (req, res) => {
  try {
    const want = [...new Set(((req.body && req.body.ids) || []).map(Number).filter(Boolean))];
    if (!want.length) return res.status(400).json({ ok: false, error: "Brak pracowników" });
    if (want.length > MAX_IDS) return res.status(400).json({ ok: false, error: `Maks. ${MAX_IDS} osób naraz` });
    const ids = await visible(req.coordinator, want);
    const r = await hr.manual(ids);
    res.json({ ok: !r.error, error: r.error || null, checked: r.checked, skipped: r.skipped, signed_now: r.signed_now,
      rows: await hr.summary(ids) });
  } catch (e) { fail(res, e); }
});

module.exports = { router };
