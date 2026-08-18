const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');

// Simple password hash (SHA256 + salt) — no external deps needed
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return { hash: `${salt}:${hash}`, salt };
}

function verifyPassword(password, stored) {
  const [salt] = stored.split(':');
  const { hash } = hashPassword(password, salt);
  return hash === stored;
}

// Simple session store (in-memory, replace with DB for production)
const sessions = {};

function requireAuth(req, res, next) {
  const token = req.headers['x-session'] || req.query.session;
  if (!token || !sessions[token]) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  req.coordinator = sessions[token];
  next();
}

function requireAdmin(req, res, next) {
  if (!req.coordinator.is_admin) return res.status(403).json({ ok: false, error: 'Admin only' });
  next();
}

// ── AUTH ──────────────────────────────────────────────────────

// POST /admin/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Missing fields' });

    const result = await db.query(
      `SELECT ca.*, c.full_name, c.role
       FROM coordinator_auth ca
       JOIN coordinators c ON c.id = ca.coordinator_id
       WHERE ca.username = $1`,
      [username]
    );

    if (!result.rows[0]) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const auth = result.rows[0];
    if (!verifyPassword(password, auth.password_hash)) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    await db.query(`UPDATE coordinator_auth SET last_login = now() WHERE id = $1`, [auth.id]);

    const token = crypto.randomBytes(32).toString('hex');
    sessions[token] = {
      coordinator_id: auth.coordinator_id,
      username:       auth.username,
      full_name:      auth.full_name,
      role:           auth.role,
      is_admin:       auth.is_admin,
    };

    res.json({ ok: true, token, user: sessions[token] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /admin/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['x-session'];
  delete sessions[token];
  res.json({ ok: true });
});

// GET /admin/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.coordinator });
});

// ── COORDINATORS ──────────────────────────────────────────────

// GET /admin/coordinators
router.get('/coordinators', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.*, ca.username, ca.is_admin, ca.last_login,
              COUNT(DISTINCT cf.facility_id) AS facility_count
       FROM coordinators c
       LEFT JOIN coordinator_auth ca ON ca.coordinator_id = c.id
       LEFT JOIN coordinator_facilities cf ON cf.coordinator_id = c.id
       WHERE c.is_active = true
       GROUP BY c.id, ca.username, ca.is_admin, ca.last_login
       ORDER BY c.full_name`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /admin/coordinators — create coordinator + login
router.post('/coordinators', requireAuth, requireAdmin, async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { full_name, email, role, username, password, is_admin, telegram_chat_id } = req.body;
    if (!full_name || !username || !password) {
      return res.status(400).json({ ok: false, error: 'full_name, username, password required' });
    }

    await client.query('BEGIN');

    const coord = await client.query(
      `INSERT INTO coordinators (full_name, email, role, telegram_chat_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [full_name, email || null, role || 'coordinator', telegram_chat_id || null]
    );
    const coordId = coord.rows[0].id;

    const { hash } = hashPassword(password);
    await client.query(
      `INSERT INTO coordinator_auth (coordinator_id, username, password_hash, is_admin)
       VALUES ($1, $2, $3, $4)`,
      [coordId, username, hash, is_admin || false]
    );

    await client.query('COMMIT');
    res.json({ ok: true, coordinator_id: coordId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /admin/coordinators/:id — update password or role
router.patch('/coordinators/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password, role, is_admin, email, full_name, telegram_chat_id } = req.body;

    if (full_name) await db.query(`UPDATE coordinators SET full_name=$1 WHERE id=$2`, [full_name, id]);
    if (email)     await db.query(`UPDATE coordinators SET email=$1 WHERE id=$2`, [email, id]);
    if (role)      await db.query(`UPDATE coordinators SET role=$1 WHERE id=$2`, [role, id]);
    if (telegram_chat_id !== undefined) await db.query(`UPDATE coordinators SET telegram_chat_id=$1 WHERE id=$2`, [telegram_chat_id || null, id]);
    if (is_admin !== undefined) await db.query(`UPDATE coordinator_auth SET is_admin=$1 WHERE coordinator_id=$2`, [is_admin, id]);
    if (password) {
      const { hash } = hashPassword(password);
      await db.query(`UPDATE coordinator_auth SET password_hash=$1 WHERE coordinator_id=$2`, [hash, id]);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /admin/coordinators/:id
router.delete('/coordinators/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query(`UPDATE coordinators SET is_active=false WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── FACILITIES ────────────────────────────────────────────────

// GET /admin/facilities
router.get('/facilities', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT f.*,
              COUNT(DISTINCT w.id)  AS worker_count,
              COUNT(DISTINCT cf.coordinator_id) AS coordinator_count
       FROM facilities f
       LEFT JOIN workers w ON w.facility_id = f.id AND w.status = 'pracuje'
       LEFT JOIN coordinator_facilities cf ON cf.facility_id = f.id
       WHERE f.is_active = true
       GROUP BY f.id
       ORDER BY f.name`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /admin/facilities — create facility
router.post('/facilities', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, client_name, city, group_name, telegram_chat_id } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });

    const result = await db.query(
      `INSERT INTO facilities (name, client_name, city, group_name, telegram_chat_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [name, client_name || null, city || null, group_name || null, telegram_chat_id || null]
    );
    res.json({ ok: true, facility_id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /admin/facilities/:id
router.patch('/facilities/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, client_name, city, group_name, telegram_chat_id } = req.body;
    await db.query(
      `UPDATE facilities SET
         name = COALESCE($1, name),
         client_name = COALESCE($2, client_name),
         city = COALESCE($3, city),
         group_name = COALESCE($4, group_name),
         telegram_chat_id = COALESCE($5, telegram_chat_id)
       WHERE id = $6`,
      [name, client_name, city, group_name, telegram_chat_id, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── COORDINATOR ↔ FACILITY assignments ───────────────────────

// GET /admin/assignments
router.get('/assignments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT cf.*, c.full_name AS coordinator_name, f.name AS facility_name
       FROM coordinator_facilities cf
       JOIN coordinators c ON c.id = cf.coordinator_id
       JOIN facilities f ON f.id = cf.facility_id
       ORDER BY c.full_name, f.name`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /admin/assignments
router.post('/assignments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { coordinator_id, facility_id, is_primary } = req.body;
    await db.query(
      `INSERT INTO coordinator_facilities (coordinator_id, facility_id, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (coordinator_id, facility_id) DO UPDATE SET is_primary = $3`,
      [coordinator_id, facility_id, is_primary || false]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /admin/assignments/:coordinator_id/:facility_id
router.delete('/assignments/:coordinator_id/:facility_id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM coordinator_facilities WHERE coordinator_id=$1 AND facility_id=$2`,
      [req.params.coordinator_id, req.params.facility_id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WORKERS — change login ────────────────────────────────────

// GET /admin/workers
router.get('/workers', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT w.id, w.login, w.full_name, w.status, w.telegram_chat_id,
              f.name AS facility_name, f.id AS facility_id
       FROM workers w
       LEFT JOIN facilities f ON f.id = w.facility_id
       ORDER BY f.name, w.full_name`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /admin/workers — create new worker (admin or coordinator)
router.post('/workers', requireAuth, async (req, res) => {
  try {
    const { login, full_name, facility_id, status, lang, bhp_date } = req.body;
    if (!login || !full_name) return res.status(400).json({ ok: false, error: 'login and full_name required' });

    // Coordinator can only add to their own facilities
    if (!req.coordinator.is_admin && facility_id) {
      const check = await db.query(
        `SELECT 1 FROM coordinator_facilities WHERE coordinator_id=$1 AND facility_id=$2`,
        [req.coordinator.coordinator_id, facility_id]
      );
      if (!check.rows.length) return res.status(403).json({ ok: false, error: 'No access to this facility' });
    }

    // Check login uniqueness
    const exists = await db.query(`SELECT id FROM workers WHERE login=$1`, [login]);
    if (exists.rows.length) return res.status(400).json({ ok: false, error: 'Login already exists' });

    const result = await db.query(
      `INSERT INTO workers (login, full_name, facility_id, status, lang, bhp_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [login, full_name, facility_id || null, status || 'pracuje', lang || 'uk', bhp_date || null]
    );
    res.json({ ok: true, worker_id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PATCH /admin/workers/:id — coordinator can also edit (own facility only)
router.patch('/workers/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { login, full_name, facility_id, status } = req.body;

    // Check access for non-admin
    if (!req.coordinator.is_admin) {
      const worker = await db.query(`SELECT facility_id FROM workers WHERE id=$1`, [id]);
      if (!worker.rows.length) return res.status(404).json({ ok: false, error: 'Worker not found' });
      const fid = worker.rows[0].facility_id;
      if (fid) {
        const check = await db.query(
          `SELECT 1 FROM coordinator_facilities WHERE coordinator_id=$1 AND facility_id=$2`,
          [req.coordinator.coordinator_id, fid]
        );
        if (!check.rows.length) return res.status(403).json({ ok: false, error: 'No access' });
      }
    }

    if (login) {
      const exists = await db.query(`SELECT id FROM workers WHERE login=$1 AND id!=$2`, [login, id]);
      if (exists.rows.length) return res.status(400).json({ ok: false, error: 'Login already exists' });
    }

    await db.query(
      `UPDATE workers SET
         login       = COALESCE($1, login),
         full_name   = COALESCE($2, full_name),
         facility_id = COALESCE($3, facility_id),
         status      = COALESCE($4, status),
         updated_at  = now()
       WHERE id = $5`,
      [login || null, full_name || null, facility_id || null, status || null, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// GET /admin/my-facilities
router.get('/my-facilities', requireAuth, async (req, res) => {
  try {
    if (req.coordinator.is_admin) {
      const result = await db.query(`SELECT id FROM facilities WHERE is_active = true`);
      return res.json({ ok: true, facility_ids: result.rows.map(r => r.id), is_admin: true });
    }
    const result = await db.query(
      `SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`,
      [req.coordinator.coordinator_id]
    );
    res.json({ ok: true, facility_ids: result.rows.map(r => r.facility_id), is_admin: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router, requireAuth, requireAdmin, sessions };
