// ── api/reports.js ────────────────────────────────────────────
// Окремий модуль для рапортів. Не чіпає існуючі routes.js / coordinator.js.
// Монтується в index.js:  app.use("/api", require("./api/reports"));

const express = require("express");
const router = express.Router();
const db = require("../db");

let sessions = {};
try {
  sessions = require("./admin").sessions || {};
} catch (e) {
  console.error("[reports] cannot load sessions from admin.js:", e.message);
}

// ── Auth: спочатку in-memory сесії, потім fallback на coordinator_sessions ──
async function requireAuth(req, res, next) {
  const token = req.headers["x-session"] || req.query.session;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  if (sessions[token]) {
    req.coordinator = sessions[token];
    return next();
  }

  try {
    const r = await db.query(
      `SELECT cs.coordinator_id, c.full_name, ca.username, ca.is_admin
       FROM coordinator_sessions cs
       JOIN coordinators c ON c.id = cs.coordinator_id
       LEFT JOIN coordinator_auth ca ON ca.coordinator_id = cs.coordinator_id
       WHERE cs.token = $1`,
      [token],
    );
    if (r.rows[0]) {
      req.coordinator = {
        coordinator_id: r.rows[0].coordinator_id,
        full_name: r.rows[0].full_name,
        username: r.rows[0].username,
        is_admin: r.rows[0].is_admin,
      };
      return next();
    }
  } catch (e) {
    // таблиці coordinator_sessions може не бути — це ок
  }

  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

async function getFacilityFilter(coordinator) {
  if (coordinator.is_admin) return null; // admin бачить усе
  const result = await db.query(
    `SELECT facility_id FROM coordinator_facilities WHERE coordinator_id = $1`,
    [coordinator.coordinator_id],
  );
  return result.rows.map((r) => r.facility_id);
}

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ── Список доступних рапортів (для меню в raporty.html) ──────
router.get("/reports", requireAuth, (req, res) => {
  res.json({
    ok: true,
    data: [
      {
        id: "koordynacja-nieobecnosc",
        name: "Koordynacja nieobecność",
        description:
          "Stan zatrudnienia, przyjęcia/zwolnienia, godziny, nieobecności i puste dni za okres",
      },
      // наступні рапорти додаємо сюди
    ],
  });
});

// ── Raport 1: Koordynacja nieobecność ────────────────────────
// GET /api/reports/koordynacja-nieobecnosc?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get(
  "/reports/koordynacja-nieobecnosc",
  requireAuth,
  async (req, res) => {
    try {
      const { from, to } = req.query;
      if (!isValidDate(from) || !isValidDate(to)) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid period (from/to)" });
      }
      if (from > to) {
        return res.status(400).json({ ok: false, error: "from > to" });
      }

      const allowedFacilities = await getFacilityFilter(req.coordinator);
      if (allowedFacilities !== null && allowedFacilities.length === 0) {
        return res.json({
          ok: true,
          data: {
            period: { from, to },
            facilities: [],
            absences: [],
            missing: [],
          },
        });
      }

      // $1 = from, $2 = to, $3 = allowed facility ids (або NULL)
      const params = [from, to, allowedFacilities];

      // ── Зведення по об'єктах ──────────────────────────────
      // active_end  — працюючі на кінець періоду
      // hired       — bhp_date у періоді
      // fired       — status='zwolniony' і last_work_date у періоді
      // hours       — сума годин, прив'язка до об'єкта через період у worker_facility_history
      const summarySql = `
        WITH scope AS (
          SELECT f.id, f.name, COALESCE(NULLIF(f.group_name, ''), 'Bez grupy') AS group_name
          FROM facilities f
          WHERE f.is_active = true
            AND ($3::int[] IS NULL OR f.id = ANY($3::int[]))
        ),
        active_end AS (
          -- Працюючі на кінець періоду — ЧИСТО ПО ДАТАХ:
          -- почав до кінця періоду включно, а закінчив ПІЗНІШЕ кінця періоду
          -- (або ще працює). Хто має last_work_date = останній день періоду —
          -- НЕ рахується (він уже закінчив).
          -- 'rezygnacja' виключаємо — ці люди так і не почали працювати.
          -- Один працівник = один об'єкт (останній період за bhp_date).
          SELECT t.facility_id, COUNT(*) AS cnt
          FROM (
            SELECT DISTINCT ON (wfh.worker_id) wfh.worker_id, wfh.facility_id
            FROM worker_facility_history wfh
            JOIN workers w ON w.id = wfh.worker_id
            WHERE wfh.status <> 'rezygnacja'
              AND wfh.bhp_date <= $2::date
              AND (wfh.last_work_date IS NULL OR wfh.last_work_date > $2::date)
              AND w.login NOT LIKE 'TEST_%'
            ORDER BY wfh.worker_id, wfh.bhp_date DESC
          ) t
          GROUP BY t.facility_id
        ),
        hired AS (
          SELECT wfh.facility_id, COUNT(DISTINCT wfh.worker_id) AS cnt
          FROM worker_facility_history wfh
          JOIN workers w ON w.id = wfh.worker_id
          WHERE wfh.status <> 'rezygnacja'
            AND wfh.bhp_date BETWEEN $1::date AND $2::date
            AND w.login NOT LIKE 'TEST_%'
          GROUP BY wfh.facility_id
        ),
        fired AS (
          -- Zwolniono — ПО ДАТІ: last_work_date потрапляє в період,
          -- незалежно від статусу (крім 'rezygnacja' — ті не працювали взагалі)
          SELECT wfh.facility_id, COUNT(DISTINCT wfh.worker_id) AS cnt
          FROM worker_facility_history wfh
          JOIN workers w ON w.id = wfh.worker_id
          WHERE wfh.status <> 'rezygnacja'
            AND wfh.last_work_date BETWEEN $1::date AND $2::date
            AND w.login NOT LIKE 'TEST_%'
          GROUP BY wfh.facility_id
        ),
        hrs AS (
          SELECT p.facility_id, SUM(h.hours) AS total
          FROM hours_log h
          JOIN workers w ON w.id = h.worker_id
          CROSS JOIN LATERAL (
            SELECT COALESCE(
              (SELECT wfh.facility_id
                 FROM worker_facility_history wfh
                WHERE wfh.worker_id = h.worker_id
                  AND h.work_date >= wfh.bhp_date
                  AND (wfh.last_work_date IS NULL OR h.work_date <= wfh.last_work_date)
                ORDER BY wfh.bhp_date DESC
                LIMIT 1),
              (SELECT vc.facility_id FROM v_worker_current vc WHERE vc.id = h.worker_id)
            ) AS facility_id
          ) p
          WHERE h.work_date BETWEEN $1::date AND $2::date
            AND h.hours IS NOT NULL
            AND w.login NOT LIKE 'TEST_%'
          GROUP BY p.facility_id
        ),
        -- години, що не потрапили в жоден активний об'єкт зі scope
        -- (нема періоду в history і немає current, або об'єкт неактивний).
        -- Показуємо тільки адміну ($3 IS NULL), щоб координатор не бачив чужих сум.
        unassigned AS (
          SELECT COALESCE(SUM(hr.total), 0) AS total
          FROM hrs hr
          WHERE $3::int[] IS NULL
            AND (hr.facility_id IS NULL
                 OR hr.facility_id NOT IN (SELECT id FROM scope))
        )
        SELECT * FROM (
          SELECT s.id AS facility_id, s.name AS facility_name, s.group_name,
                 COALESCE(a.cnt, 0)  AS active_end,
                 COALESCE(hi.cnt, 0) AS hired,
                 COALESCE(fi.cnt, 0) AS fired,
                 COALESCE(hr.total, 0) AS hours,
                 0 AS is_unassigned
          FROM scope s
          LEFT JOIN active_end a ON a.facility_id = s.id
          LEFT JOIN hired hi     ON hi.facility_id = s.id
          LEFT JOIN fired fi     ON fi.facility_id = s.id
          LEFT JOIN hrs hr       ON hr.facility_id = s.id
          UNION ALL
          SELECT NULL, '(Nieprzypisane / nieaktywne obiekty)', 'Poza obiektami',
                 0, 0, 0, u.total, 1
          FROM unassigned u
          WHERE u.total > 0
        ) t
        ORDER BY t.is_unassigned, t.group_name, t.facility_name
      `;

      // ── Неприсутності (всі, крім WZ — вихідний за графіком) ──
      const absSql = `
        SELECT w.id AS worker_id, w.full_name, w.login,
               p.facility_id, f.name AS facility_name,
               COALESCE(NULLIF(f.group_name, ''), 'Bez grupy') AS group_name,
               h.absence_type,
               COUNT(*)::int AS cnt,
               ARRAY_AGG(to_char(h.work_date, 'YYYY-MM-DD') ORDER BY h.work_date) AS days
        FROM hours_log h
        JOIN workers w ON w.id = h.worker_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(
            (SELECT wfh.facility_id
               FROM worker_facility_history wfh
              WHERE wfh.worker_id = h.worker_id
                AND h.work_date >= wfh.bhp_date
                AND (wfh.last_work_date IS NULL OR h.work_date <= wfh.last_work_date)
              ORDER BY wfh.bhp_date DESC
              LIMIT 1),
            (SELECT vc.facility_id FROM v_worker_current vc WHERE vc.id = h.worker_id)
          ) AS facility_id
        ) p
        JOIN facilities f ON f.id = p.facility_id
        WHERE h.work_date BETWEEN $1::date AND $2::date
          AND h.absence_type IS NOT NULL
          AND h.absence_type <> 'WZ'
          AND w.login NOT LIKE 'TEST_%'
          AND ($3::int[] IS NULL OR p.facility_id = ANY($3::int[]))
        GROUP BY w.id, w.full_name, w.login, p.facility_id, f.name, f.group_name, h.absence_type
        ORDER BY group_name, facility_name, w.full_name, h.absence_type
      `;

      // ── Пусті дні (bez godzin) ────────────────────────────
      // Дні періоду, коли працівник БУВ працевлаштований на об'єкті
      // (bhp_date <= день <= last_work_date, як workedOnDate), але в hours_log
      // немає ЖОДНОГО запису (ані годин, ані неприсутності).
      // Дні після сьогодні не рахуються (LEAST з CURRENT_DATE).
      const missingSql = `
        WITH days AS (
          SELECT d::date AS day
          FROM generate_series($1::date, LEAST($2::date, CURRENT_DATE), interval '1 day') AS d
        ),
        emp_days AS (
          -- DISTINCT прибирає дублі history-рядків одного періоду з різними статусами
          SELECT DISTINCT wfh.worker_id, wfh.facility_id, d.day
          FROM worker_facility_history wfh
          JOIN days d
            ON d.day >= wfh.bhp_date
           AND (wfh.last_work_date IS NULL OR d.day <= wfh.last_work_date)
          WHERE wfh.status <> 'rezygnacja'
            AND ($3::int[] IS NULL OR wfh.facility_id = ANY($3::int[]))
        )
        SELECT w.id AS worker_id, w.full_name, w.login,
               e.facility_id, f.name AS facility_name,
               COALESCE(NULLIF(f.group_name, ''), 'Bez grupy') AS group_name,
               COUNT(*)::int AS cnt,
               ARRAY_AGG(to_char(e.day, 'YYYY-MM-DD') ORDER BY e.day) AS days
        FROM emp_days e
        JOIN workers w ON w.id = e.worker_id
        JOIN facilities f ON f.id = e.facility_id
        LEFT JOIN hours_log h
          ON h.worker_id = e.worker_id AND h.work_date = e.day
        WHERE h.worker_id IS NULL
          AND w.login NOT LIKE 'TEST_%'
        GROUP BY w.id, w.full_name, w.login, e.facility_id, f.name, f.group_name
        ORDER BY group_name, facility_name, w.full_name
      `;

      const [summary, absences, missing] = await Promise.all([
        db.query(summarySql, params),
        db.query(absSql, params),
        db.query(missingSql, params),
      ]);

      res.json({
        ok: true,
        data: {
          period: { from, to },
          facilities: summary.rows.map((r) => ({
            ...r,
            active_end: parseInt(r.active_end),
            hired: parseInt(r.hired),
            fired: parseInt(r.fired),
            hours: parseFloat(r.hours),
          })),
          absences: absences.rows,
          missing: missing.rows,
        },
      });
    } catch (err) {
      console.error("[reports] koordynacja-nieobecnosc:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

module.exports = router;