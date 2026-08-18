// const express = require("express");
// const router = express.Router();
// const db = require("../db");
// const { sessions } = require("./admin");
// const archiver = require("archiver");

// function requireAuth(req, res, next) {
//   const token = req.headers["x-session"] || req.query.session;
//   if (!token || !sessions[token])
//     return res.status(401).json({ ok: false, error: "Unauthorized" });
//   req.coordinator = sessions[token];
//   next();
// }

// async function getFacilityFilter(coordinator) {
//   if (coordinator.is_admin) return null;
//   const result = await db.query(
//     `SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`,
//     [coordinator.coordinator_id],
//   );
//   return result.rows.map((r) => r.facility_id);
// }

// // true, если работник в зоне ответственности координатора (админ — всегда)
// async function workerInScope(coordinator, workerId) {
//   if (coordinator.is_admin) return true;
//   const r = await db.query(
//     `SELECT 1
//      FROM v_worker_current w
//      JOIN coordinator_facilities cf ON cf.facility_id = w.facility_id
//      WHERE w.id = $1 AND cf.coordinator_id = $2
//      LIMIT 1`,
//     [workerId, coordinator.coordinator_id],
//   );
//   return r.rows.length > 0;
// }

// // ── Facilities list ───────────────────────────────────────────
// router.get("/facilities", requireAuth, async (req, res) => {
//   try {
//     const res2 = await db.query(
//       `SELECT f.*, f.group_name, COUNT(w.id) AS worker_count
//        FROM facilities f
//        LEFT JOIN v_worker_current w ON w.facility_id = f.id AND w.status = 'pracuje'
//        WHERE f.is_active = true
//        GROUP BY f.id
//        ORDER BY f.group_name, f.name`,
//     );
//     res.json({ ok: true, data: res2.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Missing days ──────────────────────────────────────────────
// router.get("/missing", requireAuth, async (req, res) => {
//   try {
//     const { facility_id } = req.query;
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     const where = [];
//     const params = [];

//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0) return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       where.push(`facility_id = ANY($${params.length})`);
//     }
//     if (facility_id) {
//       params.push(facility_id);
//       where.push(`facility_id = $${params.length}`);
//     }

//     let query = `SELECT * FROM v_missing_days`;
//     if (where.length) query += ` WHERE ${where.join(" AND ")}`;
//     query += ` ORDER BY missing_count DESC`;

//     const result = await db.query(query, params);
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Monthly stats ─────────────────────────────────────────────
// router.get("/stats", requireAuth, async (req, res) => {
//   try {
//     const { month, facility_id } = req.query;
//     const m = month || new Date().toISOString().substring(0, 7);
//     const allowedFacilities = await getFacilityFilter(req.coordinator);

//     let facWhere = `w.status = 'pracuje'`;
//     const facParams = [];
//     const dateParams = [`${m}-01`];

//     if (facility_id) {
//       facParams.push(facility_id);
//       dateParams.push(facility_id);
//       facWhere += ` AND w.facility_id = $${facParams.length}`;
//     } else if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0) {
//         return res.json({
//           ok: true,
//           data: { workers: 0, hours: 0, missing: 0, advances: 0 },
//         });
//       }
//       facParams.push(allowedFacilities);
//       dateParams.push(allowedFacilities);
//       facWhere += ` AND w.facility_id = ANY($${facParams.length})`;
//     }

//     const dateWhere = facWhere.replace(
//       /\$(\d+)/g,
//       (_, n) => `$${parseInt(n) + 1}`,
//     );

//     let advWhere = `a.status = 'pending'`;
//     const advParams = [];
//     if (facility_id) {
//       advParams.push(facility_id);
//       advWhere += ` AND w.facility_id = $${advParams.length}`;
//     } else if (allowedFacilities !== null) {
//       advParams.push(allowedFacilities);
//       advWhere += ` AND w.facility_id = ANY($${advParams.length})`;
//     }


//     const [workers, hours, missing, advances] = await Promise.all([
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w WHERE ${facWhere}`,
//         facParams,
//       ),
//       db.query(
//         `SELECT COALESCE(SUM(h.hours), 0) AS total
//          FROM hours_log h
//          JOIN v_worker_current w ON w.id = h.worker_id
//          WHERE DATE_TRUNC('month', h.work_date) = $1::date AND ${dateWhere}`,
//         dateParams,
//       ),
//       db.query(
//         `SELECT COUNT(DISTINCT w.id) AS cnt
//          FROM v_worker_current w
//          WHERE ${dateWhere}
//            AND NOT EXISTS (
//              SELECT 1 FROM hours_log h
//              WHERE h.worker_id = w.id
//                AND DATE_TRUNC('month', h.work_date) = $1::date
//            )`,
//         dateParams,
//       ),
//       db.query(
//         `SELECT COUNT(*) AS count
//    FROM advances a
//    JOIN v_worker_current w ON w.id = a.worker_id
//    WHERE ${advWhere}`,
//         advParams,
//       ),
//     ]);

//     res.json({
//       ok: true,
//       data: {
//         workers: parseInt(workers.rows[0].count),
//         hours: parseFloat(hours.rows[0].total),
//         missing: parseInt(missing.rows[0].cnt),
//         advances: parseInt(advances.rows[0].count),
//       },
//     });
//   } catch (err) {
//     console.error("Stats error:", err.message);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Edit hours (web) ──────────────────────────────────────────
// // ── Edit hours (web) ──────────────────────────────────────────
// router.post("/hours", requireAuth, async (req, res) => {
//   try {
//     const { worker_id, work_date, hours, absence_type } = req.body;
//     if (!(await workerInScope(req.coordinator, worker_id)))
//       return res.status(403).json({ ok: false, error: "Forbidden" });

//     // Перевірка: чи працював у цю дату хоч на одному об'єкті
//     // (враховує перенесення — об'єднання всіх періодів роботи)
//     const periodCheck = await db.query(
//       `SELECT 1
//        FROM worker_facility_history h
//        WHERE h.worker_id = $1
//          AND h.bhp_date <= $2::date
//          AND (h.last_work_date IS NULL OR h.last_work_date >= $2::date)
//        LIMIT 1`,
//       [worker_id, work_date],
//     );
//     if (periodCheck.rows.length === 0) {
//       return res.status(422).json({
//         ok: false,
//         error: "Pracownik nie pracował w tym dniu (poza okresem zatrudnienia)",
//       });
//     }

//     await db.query(
//       `INSERT INTO hours_log (worker_id, work_date, hours, absence_type, source)
//        VALUES ($1, $2, $3, $4, 'web')
//        ON CONFLICT (worker_id, work_date)
//        DO UPDATE SET hours = $3, absence_type = $4, updated_at = now()`,
//       [worker_id, work_date, hours || null, absence_type || null],
//     );
//     res.json({ ok: true });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Send reminder ─────────────────────────────────────────────
// router.post("/remind/:worker_id", requireAuth, async (req, res) => {
//   try {
//     const { worker_id } = req.params;
//     if (!(await workerInScope(req.coordinator, worker_id)))
//       return res.status(403).json({ ok: false, error: "Forbidden" });
//     const w = await db.query(`SELECT * FROM workers WHERE id = $1`, [
//       worker_id,
//     ]);
//     if (!w.rows[0] || !w.rows[0].telegram_chat_id) {
//       return res.json({ ok: false, error: "No telegram_chat_id" });
//     }
//     res.json({ ok: true, queued: true });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Advances list ─────────────────────────────────────────────
// router.get("/advances", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     let query = `
//       SELECT a.*, w.full_name, w.login, f.name AS facility_name,
//         COALESCE((
//           SELECT SUM(h.hours)
//           FROM hours_log h
//           WHERE h.worker_id = a.worker_id
//             AND DATE_TRUNC('month', h.work_date) = DATE_TRUNC('month', CURRENT_DATE)
//         ), 0) AS hours_this_month
//       FROM advances a
//       JOIN v_worker_current w ON w.id = a.worker_id
//       LEFT JOIN facilities f ON f.id = w.facility_id
//       WHERE 1=1
//     `;
//     const params = [];
//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       query += ` AND w.facility_id = ANY($${params.length})`;
//     }
//     query += ` ORDER BY a.requested_at DESC LIMIT 500`;
//     const result = await db.query(query, params);
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// router.patch("/advances/:id", requireAuth, async (req, res) => {
//   try {
//     const { status, note } = req.body;
//     if (!["approved", "rejected"].includes(status)) {
//       return res.status(400).json({ ok: false, error: "Invalid status" });
//     }

//     const result = await db.query(
//       `UPDATE advances a
//        SET status = $1, note = $2, approved_by = $3, approved_at = now()
//        WHERE a.id = $4
//          AND (
//            $5::boolean
//            OR EXISTS (
//              SELECT 1 FROM v_worker_current vw
//              JOIN coordinator_facilities cf ON cf.facility_id = vw.facility_id
//              WHERE vw.id = a.worker_id AND cf.coordinator_id = $3
//            )
//          )
//        RETURNING worker_id`,
//       [status, note || null, req.coordinator.coordinator_id,
//         req.params.id, !!req.coordinator.is_admin],
//     );

//     if (!result.rows.length)
//       return res.status(404).json({ ok: false, error: "Not found or forbidden" });

//     const { worker_id } = result.rows[0];

//     const workerRes = await db.query(
//       `SELECT full_name, telegram_chat_id, lang FROM workers WHERE id = $1`,
//       [worker_id],
//     );
//     const worker = workerRes.rows[0];

//     if (worker?.telegram_chat_id) {
//       try {
//         const session = { lang: worker.lang || "uk" };
//         const { T } = require("../bot/i18n");
//         const emoji = status === "approved" ? "✅" : "❌";
//         const statusText =
//           status === "approved"
//             ? T(session, "advances_approved")
//             : T(session, "advances_rejected");

//         await fetch(
//           `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
//           {
//             method: "POST",
//             headers: { "Content-Type": "application/json" },
//             body: JSON.stringify({
//               chat_id: worker.telegram_chat_id,
//               text: `${emoji} ${statusText}`,
//               parse_mode: "Markdown",
//             }),
//           },
//         );
//       } catch (tgErr) {
//         console.error("Telegram notify failed (advances):", tgErr.message);
//       }
//     }

//     res.json({ ok: true });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── History page ──────────────────────────────────────────────
// router.get("/history", requireAuth, async (req, res) => {
//   try {
//     const { search, facility_id, status, bhp_from, bhp_to, last_from, last_to } = req.query;
//     const allowedFacilities = await getFacilityFilter(req.coordinator);

//     let where = ["1=1"];
//     const params = [];

//     if (search) {
//       params.push(`%${search}%`);
//       where.push(`(w.full_name ILIKE $${params.length} OR w.login ILIKE $${params.length})`);
//     }
//     if (req.query.facility_name) {
//       params.push(req.query.facility_name);
//       where.push(`f.name = $${params.length}`);
//     }
//     if (status) {
//       params.push(status);
//       where.push(`h.status = $${params.length}::worker_status`);
//     }
//     if (bhp_from) {
//       params.push(bhp_from);
//       where.push(`h.bhp_date >= $${params.length}`);
//     }
//     if (bhp_to) {
//       params.push(bhp_to);
//       where.push(`h.bhp_date <= $${params.length}`);
//     }
//     if (last_from) {
//       params.push(last_from);
//       where.push(`h.last_work_date >= $${params.length}`);
//     }
//     if (last_to) {
//       params.push(last_to);
//       where.push(`h.last_work_date <= $${params.length}`);
//     }
//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0) return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       where.push(`h.facility_id = ANY($${params.length})`);
//     }

//     const result = await db.query(
//       `SELECT h.*, w.full_name, w.login, f.name AS facility_name
//        FROM worker_facility_history h
//        JOIN workers w ON w.id = h.worker_id
//        LEFT JOIN facilities f ON f.id = h.facility_id
//        WHERE ${where.join(" AND ")}
//        ORDER BY h.imported_at DESC
//        `,
//       params
//     );
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Workers stats ─────────────────────────────────────────────
// router.get("/workers/stats", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     let facFilter = "";
//     const params = [];

//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0) {
//         return res.json({
//           ok: true,
//           data: {
//             total: 0,
//             new_this_week: 0,
//             leaving_this_week: 0,
//             leaving_this_month: 0,
//           },
//         });
//       }
//       params.push(allowedFacilities);
//       facFilter = `AND w.facility_id = ANY($${params.length})`;
//     }

//     const [total, newWeek, leavingWeek, leavingMonth, startedWeek] = await Promise.all([
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w WHERE w.status = 'pracuje' ${facFilter}`,
//         params,
//       ),
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w
//      WHERE w.bhp_date >= DATE_TRUNC('week', CURRENT_DATE)
//        AND w.status != 'rezygnacja'
//        AND w.bhp_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
//        ${facFilter}`,
//         params,
//       ),
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w
//      WHERE w.last_work_date IS NOT NULL
//        AND w.last_work_date >= DATE_TRUNC('week', CURRENT_DATE)
//        AND w.last_work_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
//        ${facFilter}`,
//         params,
//       ),
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w
//      WHERE w.last_work_date >= CURRENT_DATE
//        AND w.last_work_date <= DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day'
//        ${facFilter}`,
//         params,
//       ),
//       // ← НОВЫЙ ЗАПРОС
//       db.query(
//         `SELECT COUNT(*) FROM v_worker_current w
//      WHERE w.bhp_date >= DATE_TRUNC('week', CURRENT_DATE)
//        AND w.bhp_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
//        AND w.status = 'pracuje'
//        ${facFilter}`,
//         params,
//       ),
//     ]);

//     res.json({
//       ok: true,
//       data: {
//         total: parseInt(total.rows[0].count),
//         new_this_week: parseInt(newWeek.rows[0].count),
//         leaving_this_week: parseInt(leavingWeek.rows[0].count),
//         leaving_this_month: parseInt(leavingMonth.rows[0].count),
//         started_this_week: parseInt(startedWeek.rows[0].count), // ← ДОБАВЬ
//       },
//     });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Workers all (Pracownicy tab) ──────────────────────────────
// router.get("/workers/all", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     let query = `
//      SELECT w.id, w.login, w.full_name, w.status, w.bhp_date, w.last_work_date, w.telegram_chat_id,
//        f.name AS facility_name, f.id AS facility_id, f.group_name AS group_name
// FROM v_worker_current w
// LEFT JOIN facilities f ON f.id = w.facility_id
// WHERE 1=1
//     `;
//     const params = [];
//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       query += ` AND w.facility_id = ANY($${params.length})`;
//     }
//     query += ` ORDER BY f.name, w.full_name`;
//     const result = await db.query(query, params);
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Worker history modal ──────────────────────────────────────
// router.get("/workers/:id/history", requireAuth, async (req, res) => {
//   try {
//     if (!(await workerInScope(req.coordinator, req.params.id)))
//       return res.status(403).json({ ok: false, error: "Forbidden" });
//     const result = await db.query(
//       `SELECT h.*, f.name AS facility_name
//        FROM worker_facility_history h
//        LEFT JOIN facilities f ON f.id = h.facility_id
//        WHERE h.worker_id = $1
//        ORDER BY h.imported_at DESC`,
//       [req.params.id],
//     );
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Workers with hours (Godziny tab) ──────────────────────────
// // ── Workers with hours (Godziny tab) ──────────────────────────
// router.get("/workers", requireAuth, async (req, res) => {
//   try {
//     const { facility_id, month } = req.query;
//     const m = month || new Date().toISOString().substring(0, 7);
//     const monthStart = `${m}-01`;
//     const allowedFacilities = await getFacilityFilter(req.coordinator);

//     // Беремо всіх, хто працював на об'єкті у вибраному місяці —
//     // незалежно від статусу (zwolniony, rezygnacja, urlop, przeniesiony тощо).
//     // Період роботи (bhp_date … last_work_date) має перетинатися з місяцем.
//     const params = [monthStart];
//     let facFilter = "";

//     if (facility_id) {
//       params.push(facility_id);
//       facFilter = `AND h.facility_id = $${params.length}`;
//     } else if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       facFilter = `AND h.facility_id = ANY($${params.length})`;
//     }

//     const query = `
//       SELECT DISTINCT ON (h.worker_id, h.facility_id)
//         w.id, w.login, w.full_name, w.telegram_chat_id, w.lang,
//         h.status::text AS status,
//         h.bhp_date, h.last_work_date,
//         f.name AS facility_name, f.id AS facility_id,
//         f.group_name AS group_name
//       FROM worker_facility_history h
//       JOIN workers w ON w.id = h.worker_id
//       JOIN facilities f ON f.id = h.facility_id
//       WHERE h.status::text <> 'rezygnacja'
//         AND h.bhp_date <= ($1::date + INTERVAL '1 month - 1 day')
//         AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
//         ${facFilter}
//       ORDER BY h.worker_id, h.facility_id, h.bhp_date DESC
//     `;

//     const workers = await db.query(query, params);

//     const hoursRes = await db.query(
//       `SELECT worker_id, work_date, hours, absence_type
//        FROM hours_log
//        WHERE DATE_TRUNC('month', work_date) = $1::date
//        ORDER BY work_date`,
//       [monthStart],
//     );

//     const hoursMap = {};
//     hoursRes.rows.forEach((h) => {
//       if (!hoursMap[h.worker_id]) hoursMap[h.worker_id] = [];
//       hoursMap[h.worker_id].push(h);
//     });

//     const result = workers.rows.map((w) => {
//       const allHours = hoursMap[w.id] || [];
//       const bhp = w.bhp_date ? new Date(w.bhp_date) : null;
//       const last = w.last_work_date ? new Date(w.last_work_date) : null;

//       // Години тільки в межах роботи на цьому об'єкті:
//       // від bhp_date до last_work_date (для звільнених — до останнього дня роботи)
//       const filteredHours = allHours.filter((h) => {
//         const d = new Date(h.work_date);
//         if (bhp && d < bhp) return false;
//         if (last && d > last) return false;
//         return true;
//       });

//       return { ...w, hours: filteredHours };
//     });

//     result.sort((a, b) =>
//       (a.facility_name || "").localeCompare(b.facility_name || "") ||
//       (a.full_name || "").localeCompare(b.full_name || "")
//     );

//     res.json({ ok: true, data: result });
//   } catch (err) {
//     console.error("Workers (godziny) error:", err.message);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Import ────────────────────────────────────────────────────
// router.post("/import", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     const { runImport } = require("../import_sheets");
//     await runImport(allowedFacilities);
//     res.json({ ok: true, message: "Import finished" });
//   } catch (err) {
//     console.error("Import error:", err.message);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Day off list ──────────────────────────────────────────────
// router.get("/day-off", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     let query = `
//       SELECT d.id, d.worker_id, d.requested_at, d.days, d.status, d.note,
//              w.full_name, w.login,
//              f.name AS facility_name, f.id AS facility_id
//       FROM day_off_requests d
//       JOIN v_worker_current w ON w.id = d.worker_id
//       LEFT JOIN facilities f ON f.id = w.facility_id
//       WHERE 1=1
//     `;
//     const params = [];
//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       query += ` AND w.facility_id = ANY($${params.length})`;
//     }
//     query += ` ORDER BY d.requested_at DESC `;
//     const result = await db.query(query, params);
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Day off approve/reject ────────────────────────────────────
// router.patch("/day-off/:id", requireAuth, async (req, res) => {
//   try {
//     const { status, note } = req.body;
//     if (!["approved", "rejected"].includes(status)) {
//       return res.status(400).json({ ok: false, error: "Invalid status" });
//     }

//     const result = await db.query(
//       `UPDATE day_off_requests d
//        SET status=$1, note=$2, reviewed_at=now(), reviewed_by=$3
//        WHERE d.id=$4
//          AND (
//            $5::boolean
//            OR EXISTS (
//              SELECT 1 FROM v_worker_current vw
//              JOIN coordinator_facilities cf ON cf.facility_id = vw.facility_id
//              WHERE vw.id = d.worker_id AND cf.coordinator_id = $3
//            )
//          )
//        RETURNING worker_id, days`,
//       [status, note || null, req.coordinator.coordinator_id,
//         req.params.id, !!req.coordinator.is_admin],
//     );

//     if (!result.rows.length)
//       return res.status(404).json({ ok: false, error: "Not found or forbidden" });

//     const { worker_id, days } = result.rows[0];

//     const workerRes = await db.query(
//       `SELECT full_name, telegram_chat_id FROM workers WHERE id = $1`,
//       [worker_id],
//     );
//     const worker = workerRes.rows[0];

//     if (worker?.telegram_chat_id) {
//       try {
//         const daysFormatted = (days || [])
//           .map((d) => {
//             const dt = new Date(d);
//             return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
//           })
//           .join(", ");

//         const emoji = status === "approved" ? "✅" : "❌";
//         const statusText = status === "approved" ? "підтверджено" : "відхилено";
//         const message = `${emoji} Ваш запит на вихідний *${statusText}*!\n\n📅 Дні: *${daysFormatted}*`;

//         await fetch(
//           `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,
//           {
//             method: "POST",
//             headers: { "Content-Type": "application/json" },
//             body: JSON.stringify({
//               chat_id: worker.telegram_chat_id,
//               text: message,
//               parse_mode: "Markdown",
//             }),
//           },
//         );
//       } catch (tgErr) {
//         console.error("Telegram notify failed (day-off):", tgErr.message);
//       }
//     }

//     res.json({ ok: true });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Tabele list ───────────────────────────────────────────────
// router.get("/tabele", requireAuth, async (req, res) => {
//   try {
//     const { month } = req.query;
//     const m = month || new Date().toISOString().substring(0, 7);

//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     /*
//     let query = `
//   SELECT 
//     w.id, w.login, w.full_name,
//     f.name AS facility_name,
//     $1 AS month,

//     (SELECT id 
//     FROM timesheets 
//     WHERE worker_id = w.id AND month = $1 
//     ORDER BY sent_at DESC 
//     LIMIT 1) AS timesheet_id,

//     (SELECT file_path 
//     FROM timesheets 
//     WHERE worker_id = w.id AND month = $1 
//     ORDER BY sent_at DESC 
//     LIMIT 1) AS file_path,

//     (SELECT sent_at 
//     FROM timesheets 
//     WHERE worker_id = w.id AND month = $1 
//     ORDER BY sent_at DESC 
//     LIMIT 1) AS sent_at,


//     (SELECT COUNT(*) 
//     FROM timesheets 
//     WHERE worker_id = w.id AND month = $1) AS file_count,


//     CASE 
//       WHEN (SELECT COUNT(*) 
//             FROM timesheets 
//             WHERE worker_id = w.id AND month = $1) > 0 
//       THEN true 
//       ELSE false 
//     END AS received

//   FROM v_worker_current vc
//   JOIN workers w ON w.id = vc.id
//   JOIN facilities f ON f.id = vc.facility_id
//   JOIN facility_settings fs ON fs.facility_id = vc.facility_id
//   WHERE fs.enable_tabele = true
    
// `;

//     let query = `
// SELECT 
//     w.id, w.login, w.full_name,
//     f.name AS facility_name,
//     $1 AS month,

//     (SELECT id FROM timesheets 
//      WHERE worker_id = w.id AND month = $1 
//      ORDER BY sent_at DESC LIMIT 1) AS timesheet_id,

//     (SELECT file_path FROM timesheets 
//      WHERE worker_id = w.id AND month = $1 
//      ORDER BY sent_at DESC LIMIT 1) AS file_path,

//     (SELECT sent_at FROM timesheets 
//      WHERE worker_id = w.id AND month = $1 
//      ORDER BY sent_at DESC LIMIT 1) AS sent_at,

//     (SELECT COUNT(*) FROM timesheets 
//      WHERE worker_id = w.id AND month = $1) AS file_count,

//     CASE 
//       WHEN (SELECT COUNT(*) FROM timesheets 
//             WHERE worker_id = w.id AND month = $1) > 0 
//       THEN true 
//       ELSE false 
//     END AS received

// FROM v_worker_current vc
// JOIN workers w ON w.id = vc.id
// JOIN facilities f ON f.id = vc.facility_id
// JOIN facility_settings fs ON fs.facility_id = vc.facility_id

// WHERE fs.enable_tabele = true

// -- ✅ ВОТ ГЛАВНАЯ ЧАСТЬ

// AND vc.bhp_date <= (
//     DATE_TRUNC('month', ($1 || '-01')::date) + INTERVAL '1 month - 1 day'
// )

// AND (
//     vc.last_work_date IS NULL 
//     OR vc.last_work_date >= DATE_TRUNC('month', ($1 || '-01')::date)  
// )
// `;*/

//     let query = `
//   SELECT DISTINCT ON (w.id)
//     w.id, w.login, w.full_name,
//     f.name AS facility_name,
//     $1 AS month,
//     (SELECT id FROM timesheets WHERE worker_id = w.id AND month = $1 ORDER BY sent_at DESC LIMIT 1) AS timesheet_id,
//     (SELECT file_path FROM timesheets WHERE worker_id = w.id AND month = $1 ORDER BY sent_at DESC LIMIT 1) AS file_path,
//     (SELECT sent_at FROM timesheets WHERE worker_id = w.id AND month = $1 ORDER BY sent_at DESC LIMIT 1) AS sent_at,
//     (SELECT COUNT(*) FROM timesheets WHERE worker_id = w.id AND month = $1) AS file_count,
//     CASE WHEN (SELECT COUNT(*) FROM timesheets WHERE worker_id = w.id AND month = $1) > 0 THEN true ELSE false END AS received
//   FROM workers w
//   JOIN worker_facility_history h ON h.worker_id = w.id
//   JOIN facilities f ON f.id = h.facility_id
//   JOIN facility_settings fs ON fs.facility_id = h.facility_id
//   WHERE fs.enable_tabele = true
//     AND h.bhp_date <= ($1 || '-01')::date + INTERVAL '1 month - 1 day'
//     AND (h.last_work_date IS NULL OR h.last_work_date >= ($1 || '-01')::date)
//   ORDER BY w.id, f.name
// `;
//     const params = [m];

//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.json({ ok: true, data: [] });
//       params.push(allowedFacilities);
//       query = query.replace(
//         'ORDER BY w.id, f.name',
//         `AND h.facility_id = ANY($${params.length}) ORDER BY w.id, f.name`
//       );
//     }

//     const result = await db.query(query, params);
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     console.error("[Tabele] ERROR:", err.message);
//     console.error("[Tabele] STACK:", err.stack);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Tabele photo ──────────────────────────────────────────────
// router.get("/tabele/photo/:id", requireAuth, async (req, res) => {
//   try {
//     const fs = require("fs");
//     const result = await db.query(
//       `SELECT file_path, facility_id, worker_id FROM timesheets WHERE id = $1`,
//       [req.params.id],
//     );
//     if (!result.rows.length)
//       return res.status(404).json({ error: "Not found" });

//     const ts = result.rows[0];

//     // Доступ: адмін — завжди; координатор — якщо об'єкт табеля в його зоні
//     if (!req.coordinator.is_admin) {
//       const allowed = await db.query(
//         `SELECT 1 FROM coordinator_facilities
//          WHERE coordinator_id = $1 AND facility_id = $2 LIMIT 1`,
//         [req.coordinator.coordinator_id, ts.facility_id],
//       );
//       if (!allowed.rows.length)
//         return res.status(403).json({ error: "Forbidden" });
//     }

//     const filePath = ts.file_path;
//     if (!fs.existsSync(filePath))
//       return res.status(404).json({ error: "File not found" });

//     // Визначаємо тип за розширенням (jpg/png), щоб браузер показував, а не качав
//     const ext = (filePath.split(".").pop() || "").toLowerCase();
//     const mime = ext === "png" ? "image/png"
//       : ext === "webp" ? "image/webp"
//       : "image/jpeg";
//     res.setHeader("Content-Type", mime);
//     res.setHeader("Content-Disposition", "inline");
//     fs.createReadStream(filePath).pipe(res);
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// router.get("/tabele/worker/:workerId", requireAuth, async (req, res) => {
//   try {
//     if (!(await workerInScope(req.coordinator, req.params.workerId)))
//       return res.status(403).json({ ok: false, error: "Forbidden" });
//     const { month } = req.query;
//     const result = await db.query(
//       `SELECT id, file_path, sent_at, file_number
//        FROM timesheets
//        WHERE worker_id = $1 AND month = $2
//        ORDER BY sent_at ASC`,
//       [req.params.workerId, month],
//     );
//     res.json({ ok: true, data: result.rows });
//   } catch (err) {
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Analytics chart data ──────────────────────────────────────
// router.get("/analytics/chart", requireAuth, async (req, res) => {
//   try {
//     const { date_from, date_to, facility_id } = req.query;
//     const allowedFacilities = await getFacilityFilter(req.coordinator);

//     let facFilter = "";
//     const baseParams = [date_from, date_to];

//     if (facility_id) {
//       baseParams.push(facility_id);
//       facFilter = `AND h.facility_id = $${baseParams.length}`;
//     } else if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0) return res.json({ ok: true, data: {} });
//       baseParams.push(allowedFacilities);
//       facFilter = `AND h.facility_id = ANY($${baseParams.length})`;
//     }
//     const [hired, fired, moved, urlop, l4, rezygnacja] = await Promise.all([
//       // hired — прийняті по bhp_date
//       db.query(`
//     SELECT bhp_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//     FROM worker_facility_history h
//     WHERE h.bhp_date BETWEEN $1::date AND $2::date
//       AND h.status::text NOT IN ('zwolniony','rezygnacja')
//       ${facFilter}
//     GROUP BY bhp_date::date ORDER BY bhp_date::date
//   `, baseParams),
//       // fired — звільнені по last_work_date
//       // moved — перенесені по last_work_date
//       db.query(`
//       SELECT last_work_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.last_work_date BETWEEN $1::date AND $2::date
//         AND h.last_work_date IS NOT NULL
//         AND h.status::text = 'zwolniony'
//         ${facFilter}
//       GROUP BY last_work_date::date ORDER BY last_work_date::date
//     `, baseParams),
//       // moved
//       db.query(`
//     SELECT bhp_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//     FROM worker_facility_history h
//     WHERE h.bhp_date BETWEEN $1::date AND $2::date
//       AND h.status::text = 'przeniesiony'
//       ${facFilter}
//     GROUP BY bhp_date::date ORDER BY bhp_date::date
//   `, baseParams),
//       // urlop
//       db.query(`
//     SELECT bhp_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//     FROM worker_facility_history h
//     WHERE h.bhp_date BETWEEN $1::date AND $2::date
//       AND h.status::text = 'urlop'
//       ${facFilter}
//     GROUP BY bhp_date::date ORDER BY bhp_date::date
//   `, baseParams),
//       // l4
//       db.query(`
//     SELECT bhp_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//     FROM worker_facility_history h
//     WHERE h.bhp_date BETWEEN $1::date AND $2::date
//       AND h.status::text = 'l4'
//       ${facFilter}
//     GROUP BY bhp_date::date ORDER BY bhp_date::date
//   `, baseParams),
//       db.query(`
//     SELECT last_work_date::date AS period, COUNT(DISTINCT h.worker_id) AS cnt
//     FROM worker_facility_history h
//     WHERE h.last_work_date BETWEEN $1::date AND $2::date
//       AND h.last_work_date IS NOT NULL
//       AND h.status::text = 'rezygnacja'
//       ${facFilter}
//     GROUP BY last_work_date::date ORDER BY last_work_date::date
//   `, baseParams),
//     ]);


//     const firedByFacility = await db.query(`
//       SELECT h.facility_id, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.last_work_date BETWEEN $1::date AND $2::date
//         AND h.last_work_date IS NOT NULL
//         AND h.status::text = 'zwolniony'
//         ${facFilter}
//       GROUP BY h.facility_id
//     `, baseParams);

//     const rezygnacjaByFacility = await db.query(`
//       SELECT h.facility_id, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.last_work_date BETWEEN $1::date AND $2::date
//         AND h.last_work_date IS NOT NULL
//         AND h.status::text = 'rezygnacja'
//         ${facFilter}
//       GROUP BY h.facility_id
// `, baseParams);

//     const movedByFacility = await db.query(`
//       SELECT h.facility_id, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.last_work_date BETWEEN $1::date AND $2::date
//         AND h.last_work_date IS NOT NULL
//         AND h.status::text = 'przeniesiony'
//         ${facFilter}
//       GROUP BY h.facility_id
// `, baseParams);

//     const totalParams = [date_to, ...baseParams.slice(2)];
//     const totalOnDate = await db.query(`
//   SELECT COUNT(DISTINCT h.worker_id) AS cnt
//   FROM worker_facility_history h
//   WHERE h.bhp_date <= $1::date
//     AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
//     AND h.status::text NOT IN ('zwolniony','rezygnacja')
//     ${facFilter.replace(/\$3/g, '$2').replace(/\$4/g, '$3')}
// `, totalParams);

//     const toMap = rows => {
//       const m = {};
//       rows.forEach(r => {
//         m[r.period.toISOString().substring(0, 10)] = parseInt(r.cnt);
//       });
//       return m;
//     };

//     const byFacility = await db.query(`
//       SELECT h.facility_id, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.bhp_date <= $1::date
//         AND (h.last_work_date IS NULL OR h.last_work_date >= $1::date)
//         AND h.status::text NOT IN ('zwolniony','rezygnacja')
//         ${facFilter.replace(/\$3/g, '$2').replace(/\$4/g, '$3')}
//       GROUP BY h.facility_id
// `, [date_to, ...baseParams.slice(2)]);

//     const hiredByFacility = await db.query(`
//       SELECT h.facility_id, COUNT(DISTINCT h.worker_id) AS cnt
//       FROM worker_facility_history h
//       WHERE h.bhp_date BETWEEN $1::date AND $2::date
//         AND h.status::text NOT IN ('zwolniony','rezygnacja')
//         ${facFilter}
//       GROUP BY h.facility_id
// `, baseParams);

//     res.json({
//       ok: true,
//       data: {
//         hired: toMap(hired.rows),
//         fired: toMap(fired.rows),
//         moved: toMap(moved.rows),
//         urlop: toMap(urlop.rows),
//         l4: toMap(l4.rows),
//         total_on_date: parseInt(totalOnDate.rows[0].cnt),
//         rezygnacja: toMap(rezygnacja.rows),
//         rezygnacja_by_facility: Object.fromEntries(rezygnacjaByFacility.rows.map(r => [r.facility_id, parseInt(r.cnt)])),
//         total_by_facility: Object.fromEntries(byFacility.rows.map(r => [r.facility_id, parseInt(r.cnt)])),
//         fired_by_facility: Object.fromEntries(firedByFacility.rows.map(r => [r.facility_id, parseInt(r.cnt)])),
//         moved_by_facility: Object.fromEntries(movedByFacility.rows.map(r => [r.facility_id, parseInt(r.cnt)])),
//         hired_by_facility: Object.fromEntries(hiredByFacility.rows.map(r => [r.facility_id, parseInt(r.cnt)])),
//       }
//     });


//   } catch (err) {
//     console.error("Analytics chart error:", err.message);
//     console.error("Stack:", err.stack);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Analytics drill-down ──────────────────────────────────────

// router.get("/analytics/drill", requireAuth, async (req, res) => {
//   try {
//     const { facility_names, gran, months, date_from, date_to } = req.query;
//     if (!facility_names) return res.json({ ok: true, data: {} });

//     const names = facility_names.split(',');
//     const trunc = gran === 'week' ? 'week' : gran === 'day' ? 'day' : 'month';
//     const fmt = trunc === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';

//     // Будуємо фільтр діапазону
//     // Для bhp_date і last_work_date окремо
//     let bhpRangeFilter = '';
//     let lastRangeFilter = '';
//     const params = [names];

//     if (trunc === 'month' && months) {
//       // Мультивибір місяців
//       const monthList = months.split(',');
//       params.push(monthList);
//       bhpRangeFilter = `AND TO_CHAR(DATE_TRUNC('month', h.bhp_date), 'YYYY-MM') = ANY($${params.length})`;
//       lastRangeFilter = `AND TO_CHAR(DATE_TRUNC('month', h.last_work_date), 'YYYY-MM') = ANY($${params.length})`;
//     } else if (date_from && date_to) {
//       // Діапазон дат для днів/тижнів
//       params.push(date_from);
//       params.push(date_to);
//       bhpRangeFilter = `AND h.bhp_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
//       lastRangeFilter = `AND h.last_work_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
//     }

//     const [hiredRes, firedRes, movedRes, rezygnacjaRes] = await Promise.all([
//       // Прийняті — по bhp_date
//       db.query(`
//         SELECT TO_CHAR(DATE_TRUNC('${trunc}', h.bhp_date), '${fmt}') AS period,
//                COUNT(DISTINCT h.worker_id) AS cnt
//         FROM worker_facility_history h
//         JOIN facilities f ON f.id = h.facility_id
//         WHERE f.name = ANY($1) AND h.bhp_date IS NOT NULL
//           AND h.status::text NOT IN ('zwolniony','rezygnacja')
//           ${bhpRangeFilter}
//         GROUP BY DATE_TRUNC('${trunc}', h.bhp_date)
//         ORDER BY DATE_TRUNC('${trunc}', h.bhp_date)
//       `, params),
//       // Звільнені — по last_work_date
//       db.query(`
//         SELECT TO_CHAR(DATE_TRUNC('${trunc}', h.last_work_date), '${fmt}') AS period,
//                COUNT(DISTINCT h.worker_id) AS cnt
//         FROM worker_facility_history h
//         JOIN facilities f ON f.id = h.facility_id
//         WHERE f.name = ANY($1) AND h.last_work_date IS NOT NULL
//           AND h.status::text = 'zwolniony'
//           ${lastRangeFilter}
//         GROUP BY DATE_TRUNC('${trunc}', h.last_work_date)
//         ORDER BY DATE_TRUNC('${trunc}', h.last_work_date)
//       `, params),
//       // Перенесені — по last_work_date
//       db.query(`
//         SELECT TO_CHAR(DATE_TRUNC('${trunc}', h.last_work_date), '${fmt}') AS period,
//                COUNT(DISTINCT h.worker_id) AS cnt
//         FROM worker_facility_history h
//         JOIN facilities f ON f.id = h.facility_id
//         WHERE f.name = ANY($1) AND h.last_work_date IS NOT NULL
//           AND h.status::text = 'przeniesiony'
//           ${lastRangeFilter}
//         GROUP BY DATE_TRUNC('${trunc}', h.last_work_date)
//         ORDER BY DATE_TRUNC('${trunc}', h.last_work_date)
//       `, params),
//       // Rezygnacja — по last_work_date
//       db.query(`
//         SELECT TO_CHAR(DATE_TRUNC('${trunc}', h.last_work_date), '${fmt}') AS period,
//                COUNT(DISTINCT h.worker_id) AS cnt
//         FROM worker_facility_history h
//         JOIN facilities f ON f.id = h.facility_id
//         WHERE f.name = ANY($1) AND h.last_work_date IS NOT NULL
//           AND h.status::text = 'rezygnacja'
//           ${lastRangeFilter}
//         GROUP BY DATE_TRUNC('${trunc}', h.last_work_date)
//         ORDER BY DATE_TRUNC('${trunc}', h.last_work_date)
//       `, params),
//     ]);

//     const mMap = {};
//     const addToMap = (rows, key) => {
//       rows.forEach(r => {
//         if (!mMap[r.period]) mMap[r.period] = { total: 0, hired: 0, fired: 0, moved: 0, rezygnacja: 0 };
//         mMap[r.period][key] = parseInt(r.cnt);
//       });
//     };

//     addToMap(hiredRes.rows, 'hired');
//     addToMap(firedRes.rows, 'fired');
//     addToMap(movedRes.rows, 'moved');
//     addToMap(rezygnacjaRes.rows, 'rezygnacja');

//     Object.values(mMap).forEach(m => {
//       m.total = m.hired + m.fired + m.moved + m.rezygnacja;
//     });

//     res.json({ ok: true, data: mMap });
//   } catch (err) {
//     console.error('Drill error:', err.message);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// // ── Trigger reminders (тільки об'єкти координатора) ───────────
// router.post("/remind-missing", requireAuth, async (req, res) => {
//   try {
//     const allowedFacilities = await getFacilityFilter(req.coordinator);
//     res.json({ ok: true, status: "started" });

//     // null = адмін (усі об'єкти), масив = тільки об'єкти координатора
//     const { sendMissingReminders } = require("../bot/handlers");
//     // bot інстанс треба дістати — див. примітку нижче
//     await sendMissingReminders(req.app.get("bot"), allowedFacilities);
//   } catch (err) {
//     console.error("remind-missing error:", err.message);
//   }
// });
// // ── Tabele: download all as ZIP (місяць, scope координатора) ──
// router.get("/tabele/download-all", requireAuth, async (req, res) => {
//   try {
//     const fs = require("fs");
//     const { month } = req.query;
//     const m = month || new Date().toISOString().substring(0, 7);

//     const allowedFacilities = await getFacilityFilter(req.coordinator);

//     // Збираємо табелі за місяць у зоні координатора
//     const params = [m];
//     let facFilter = "";
//     if (allowedFacilities !== null) {
//       if (allowedFacilities.length === 0)
//         return res.status(404).json({ ok: false, error: "Brak obiektów" });
//       params.push(allowedFacilities);
//       facFilter = `AND t.facility_id = ANY($${params.length})`;
//     }

//     const rows = await db.query(
//       `SELECT t.file_path, t.file_number, w.full_name, w.login,
//               f.name AS facility_name
//        FROM timesheets t
//        JOIN workers w ON w.id = t.worker_id
//        JOIN facilities f ON f.id = t.facility_id
//        WHERE t.month = $1 ${facFilter}
//        ORDER BY f.name, w.full_name, t.file_number`,
//       params,
//     );

//     if (!rows.rows.length)
//       return res.status(404).json({ ok: false, error: "Brak tabel za ten miesiąc" });

//     // Готуємо архів
//     const [year, mm] = m.split("-");
//     res.setHeader("Content-Type", "application/zip");
//     res.setHeader(
//       "Content-Disposition",
//       `attachment; filename="tabele_${m}.zip"`,
//     );

//     const archive = archiver("zip", { zlib: { level: 6 } });
//     archive.on("error", (err) => {
//       console.error("ZIP error:", err.message);
//       try { res.status(500).end(); } catch (e) {}
//     });
//     archive.pipe(res);

//     const sanitize = (s) =>
//       String(s || "").replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").trim();

//     const usedNames = new Set();
//     for (const r of rows.rows) {
//       if (!fs.existsSync(r.file_path)) continue; // файл зник — пропускаємо
//       const ext = (r.file_path.split(".").pop() || "jpg").toLowerCase();

//       // Прізвище_Імя_Обєкт_МісяцьРік(.jpg), суфікс для повторних фото
//       let base = `${sanitize(r.full_name)}_${sanitize(r.facility_name)}_${mm}_${year}`;
//       let name = `${base}.${ext}`;
//       if (usedNames.has(name)) name = `${base}_${r.file_number}.${ext}`;
//       usedNames.add(name);

//       archive.file(r.file_path, { name });
//     }

//     await archive.finalize();
//   } catch (err) {
//     console.error("download-all error:", err.message);
//     if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
//   }
// });


// module.exports = router;
