-- ══════════════════════════════════════════════════════════════════════
--  Region: показники за довільний період «від–до».
--  Та сама логіка, що reg.rag_raw (тижневий знімок), але вікно = вибраний
--  період, без правила виходу з червоного і без довшого вікна для малих
--  об'єктів. Ротація перерахована «на 28 днів», щоб пороги були ті самі.
--
--  Запуск: psql -d sasdb -f db/migration_period.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE OR REPLACE FUNCTION reg.rag_period(p_from DATE, p_to DATE)
RETURNS TABLE (
  site_key TEXT, window_days INT,
  headcount_start INT, headcount_end INT, headcount_avg NUMERIC,
  departures INT, rotation NUMERIC,
  ret_possible INT, ret_achieved INT, retention NUMERIC,
  abs_nn INT, abs_base INT, absence NUMERIC,
  st_rot CHAR(1), st_ret CHAR(1), st_abs CHAR(1), raw_status CHAR(1)
) LANGUAGE sql STABLE AS $$
WITH prm AS (
  SELECT (p_to - p_from + 1)::int                  AS days,
         reg.setting('window_days')::int           AS wd,
         reg.setting('rot_green_max') AS rot_g, reg.setting('rot_amber_max') AS rot_a,
         reg.setting('ret_days_1')::int AS k1, reg.setting('ret_weight_1')::int AS w1,
         reg.setting('ret_days_2')::int AS k2, reg.setting('ret_weight_2')::int AS w2,
         reg.setting('ret_green_min') AS ret_g, reg.setting('ret_amber_min') AS ret_a,
         reg.setting('ret_min_weight') AS ret_min,
         reg.setting('abs_green_max') AS abs_g, reg.setting('abs_amber_max') AS abs_a,
         reg.setting('abs_min_days') AS abs_min,
         COALESCE(reg.setting('abs_enabled'), 1) AS abs_on
),
p AS (SELECT * FROM reg.v_periods WHERE bhp_date <= p_to),
hc AS (
  SELECT p.site_key,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.bhp_date <= p_from - 1
             AND (p.last_work_date IS NULL OR p.last_work_date > p_from - 1)) AS hc_start,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.last_work_date IS NULL OR p.last_work_date > p_to) AS hc_end,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.last_work_date >= p_from AND p.last_work_date <= p_to
             AND p.status <> 'przeniesiony') AS dep
  FROM p GROUP BY p.site_key
),
ret AS (
  SELECT p.site_key,
         SUM(t.w) AS possible,
         SUM(t.w) FILTER (WHERE p.last_work_date IS NULL OR p.last_work_date > p_to) AS achieved
  FROM p CROSS JOIN prm
  CROSS JOIN LATERAL (VALUES (prm.k1, prm.w1), (prm.k2, prm.w2)) AS t(k, w)
  WHERE p.status <> 'przeniesiony'
    AND p.bhp_date + t.k >= p_from
    AND p.bhp_date + t.k <= p_to
  GROUP BY p.site_key
),
day_site AS (
  SELECT DISTINCT ON (hl.worker_id, hl.work_date)
         hl.worker_id, hl.work_date, p.site_key,
         (hl.hours IS NOT NULL AND hl.hours > 0) AS worked,
         hl.absence_type::text                   AS abs
  FROM public.hours_log hl
  JOIN p ON p.worker_id = hl.worker_id
        AND hl.work_date >= p.bhp_date
        AND (p.last_work_date IS NULL OR hl.work_date <= p.last_work_date)
  WHERE hl.work_date >= p_from AND hl.work_date <= p_to
  ORDER BY hl.worker_id, hl.work_date, p.bhp_date DESC
),
ab AS (
  SELECT d.site_key,
         COUNT(*) FILTER (WHERE d.abs = 'NN') AS nn,
         COUNT(*) FILTER (WHERE d.worked OR d.abs IN ('NN','UN','L4','URL')) AS base
  FROM day_site d GROUP BY d.site_key
),
m AS (
  SELECT hc.site_key, hc.hc_start::int, hc.hc_end::int,
         (hc.hc_start + hc.hc_end) / 2.0 AS hc_avg, hc.dep::int,
         COALESCE(ret.possible, 0)::int AS possible, COALESCE(ret.achieved, 0)::int AS achieved,
         COALESCE(ab.nn, 0)::int AS nn, COALESCE(ab.base, 0)::int AS base
  FROM hc
  LEFT JOIN ret ON ret.site_key = hc.site_key
  LEFT JOIN ab  ON ab.site_key  = hc.site_key
  WHERE hc.hc_start > 0 OR hc.hc_end > 0 OR hc.dep > 0
),
st AS (
  SELECT m.*,
         CASE WHEN m.hc_avg > 0 THEN m.dep / m.hc_avg * prm.wd::numeric / prm.days END AS rot,
         CASE WHEN m.possible > 0 THEN m.achieved::numeric / m.possible END AS ret_v,
         CASE WHEN m.base > 0 THEN m.nn::numeric / m.base END AS abs_v,
         prm.*
  FROM m CROSS JOIN prm
),
st2 AS (
  SELECT st.*,
    CASE WHEN st.rot IS NULL THEN NULL
         WHEN st.rot <= st.rot_g THEN 'G' WHEN st.rot <= st.rot_a THEN 'A' ELSE 'R' END AS s_rot,
    CASE WHEN st.possible < st.ret_min THEN NULL
         WHEN st.ret_v >= st.ret_g THEN 'G' WHEN st.ret_v >= st.ret_a THEN 'A' ELSE 'R' END AS s_ret,
    CASE WHEN st.abs_on = 0 OR st.base < st.abs_min THEN NULL
         WHEN st.abs_v <= st.abs_g THEN 'G' WHEN st.abs_v <= st.abs_a THEN 'A' ELSE 'R' END AS s_abs
  FROM st
)
SELECT st2.site_key, st2.days, st2.hc_start, st2.hc_end, round(st2.hc_avg, 1),
       st2.dep, round(st2.rot, 4),
       st2.possible, st2.achieved, round(st2.ret_v, 4),
       st2.nn, st2.base, round(st2.abs_v, 4),
       st2.s_rot::char(1), st2.s_ret::char(1), st2.s_abs::char(1),
       (CASE
          WHEN EXISTS (SELECT 1 FROM reg.site_flags fl
                        WHERE fl.site_key = st2.site_key AND fl.flag = 'structural'
                          AND fl.date_from <= p_to
                          AND (fl.date_to IS NULL OR fl.date_to >= p_to)) THEN 'S'
          WHEN 'R' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'R'
          WHEN 'A' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'A'
          WHEN 'G' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'G'
          ELSE 'N' END)::char(1)
FROM st2
$$;

COMMIT;
