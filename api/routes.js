const express = require("express");
const router = express.Router();
const db = require("../db");
const { sessions } = require("./admin");

// Auth middleware for coordinator panel
function requireAuth(req, res, next) {
  const token = req.headers["x-session"] || req.query.session;
  if (!token || !sessions[token])
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  req.coordinator = sessions[token];
  next();
}

// Facility filter — admin sees all, coordinator sees only assigned
async function getFacilityFilter(coordinator) {
  if (coordinator.is_admin) return null; // null = no filter
  const result = await db.query(
    `SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`,
    [coordinator.coordinator_id]
  );
  return result.rows.map((r) => r.facility_id);
}

// ── Workers list with monthly hours ──────────────────────────
router.get("/workers", requireAuth, async (req, res) => {
  try {
    const { facility_id, month } = req.query;
    const m = month || new Date().toISOString().substring(0, 7);
    const allowedFacilities = await getFacilityFilter(req.coordinator);

    let query = `
      SELECT w.id, w.login, w.full_name, w.status, w.lang,
             w.bhp_date, w.telegram_chat_id,
             f.name AS facility_name, f.id AS facility_id
      FROM workers w
      LEFT JOIN facilities f ON f.id = w.facility_id
      WHERE w.status = 'pracuje'
    `;
    const params = [];

    if (facility_id) {
      params.push(facility_id);
      query += ` AND w.facility_id = $${params.length}`;
    } else if (allowedFacilities !== null) {
      if (allowedFacilities.length === 0)
        return res.json({ ok: true, data: [] });
      params.push(allowedFacilities);
      query += ` AND w.facility_id = ANY($${params.length})`;
    }

    query += ` ORDER BY f.name, w.full_name`;
    const workers = await db.query(query, params);

    const hoursRes = await db.query(
      `SELECT worker_id, work_date, hours, absence_type
       FROM hours_log
       WHERE DATE_TRUNC('month', work_date) = $1::date
       ORDER BY work_date`,
      [`${m}-01`]
    );

    const hoursMap = {};
    hoursRes.rows.forEach((h) => {
      if (!hoursMap[h.worker_id]) hoursMap[h.worker_id] = [];
      hoursMap[h.worker_id].push(h);
    });

    const result = workers.rows.map((w) => ({
      ...w,
      hours: hoursMap[w.id] || [],
    }));
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Facilities list ───────────────────────────────────────────
router.get("/facilities", requireAuth, async (req, res) => {
  try {
    const res2 = await db.query(
      `SELECT f.*, COUNT(w.id) AS worker_count
       FROM facilities f
       LEFT JOIN workers w ON w.facility_id = f.id AND w.status = 'pracuje'
       WHERE f.is_active = true
       GROUP BY f.id
       ORDER BY f.name`
    );
    res.json({ ok: true, data: res2.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Missing days ──────────────────────────────────────────────
router.get("/missing", requireAuth, async (req, res) => {
  try {
    const { facility_id } = req.query;
    let query = `SELECT * FROM v_missing_days`;
    const params = [];
    if (facility_id) {
      params.push(facility_id);
      query += ` WHERE facility_id = $1`;
    }
    query += ` ORDER BY missing_count DESC`;
    const result = await db.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Monthly stats ─────────────────────────────────────────────
router.get("/stats", requireAuth, async (req, res) => {
  try {
    const { month, facility_id } = req.query;
    const m = month || new Date().toISOString().substring(0, 7);
    const allowedFacilities = await getFacilityFilter(req.coordinator);

    // Строим WHERE для workers
    let whereParts = [`w.status = 'pracuje'`];
    const params = [`${m}-01`];

    if (facility_id) {
      params.push(facility_id);
      whereParts.push(`w.facility_id = $${params.length}`);
    } else if (allowedFacilities !== null) {
      if (allowedFacilities.length === 0) {
        return res.json({
          ok: true,
          data: { workers: 0, hours: 0, missing: 0, advances: 0 },
        });
      }
      params.push(allowedFacilities);
      whereParts.push(`w.facility_id = ANY($${params.length})`);
    }

    const where = whereParts.join(" AND ");

    const [workers, hours, missing, advances] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM workers w WHERE ${where}`,
        params.slice(1)
      ),
      db.query(
        `SELECT COALESCE(SUM(h.hours), 0) AS total
         FROM hours_log h
         JOIN workers w ON w.id = h.worker_id
         WHERE DATE_TRUNC('month', h.work_date) = $1::date AND ${where}`,
        params
      ),
      db.query(
        `SELECT COUNT(DISTINCT w.id) AS cnt
         FROM workers w
         WHERE ${where}
           AND NOT EXISTS (
             SELECT 1 FROM hours_log h
             WHERE h.worker_id = w.id
               AND DATE_TRUNC('month', h.work_date) = $1::date
           )`,
        params
      ),
      db.query(`SELECT COUNT(*) FROM advances WHERE status = 'pending'`),
    ]);

    res.json({
      ok: true,
      data: {
        workers: parseInt(workers.rows[0].count),
        hours: parseFloat(hours.rows[0].total),
        missing: parseInt(missing.rows[0].cnt),
        advances: parseInt(advances.rows[0].count),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Edit hours (web) ──────────────────────────────────────────
router.post("/hours", requireAuth, async (req, res) => {
  try {
    const { worker_id, work_date, hours, absence_type } = req.body;
    await db.query(
      `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
       VALUES ($1, $2, $3, $4, 'web')
       ON CONFLICT (worker_id, work_date)
       DO UPDATE SET hours = $3, absence_type = $4, updated_at = now()`,
      [worker_id, work_date, hours || null, absence_type || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Send reminder to one worker ───────────────────────────────
router.post("/remind/:worker_id", requireAuth, async (req, res) => {
  try {
    const { worker_id } = req.params;
    const w = await db.query(`SELECT * FROM workers WHERE id = $1`, [
      worker_id,
    ]);
    if (!w.rows[0] || !w.rows[0].telegram_chat_id) {
      return res.json({ ok: false, error: "No telegram_chat_id" });
    }
    res.json({ ok: true, queued: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Advances list ─────────────────────────────────────────────
router.get("/advances", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, w.full_name, w.login
       FROM advances a
       JOIN workers w ON w.id = a.worker_id
       ORDER BY a.requested_at DESC
       LIMIT 100`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Worker history ────────────────────────────────────────────
router.get("/workers/:id/history", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT h.*, f.name AS facility_name
       FROM worker_facility_history h
       LEFT JOIN facilities f ON f.id = h.facility_id
       WHERE h.worker_id = $1
       ORDER BY h.imported_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/history", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT h.*, w.full_name, w.login, f.name AS facility_name
       FROM worker_facility_history h
       JOIN workers w ON w.id = h.worker_id
       LEFT JOIN facilities f ON f.id = h.facility_id
       ORDER BY h.imported_at DESC
       LIMIT 5000`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/workers/all", requireAuth, async (req, res) => {
  try {
    const allowedFacilities = await getFacilityFilter(req.coordinator);
    let query = `
      SELECT w.id, w.login, w.full_name, w.status, w.bhp_date, w.telegram_chat_id,
             f.name AS facility_name, f.id AS facility_id
      FROM workers w
      LEFT JOIN facilities f ON f.id = w.facility_id
      WHERE 1=1
    `;
    const params = [];
    if (allowedFacilities !== null) {
      if (allowedFacilities.length === 0)
        return res.json({ ok: true, data: [] });
      params.push(allowedFacilities);
      query += ` AND w.facility_id = ANY($${params.length})`;
    }
    query += ` ORDER BY f.name, w.full_name`;
    const result = await db.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
