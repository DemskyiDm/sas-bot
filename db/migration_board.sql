-- ══════════════════════════════════════════════════════════════════════
--  «Pulpit kierownika» — зведена панель для керівника і операційного
--  директора. Нічого не пише в робочі таблиці, тільки читає.
--  Потрібні вже встановлені схеми reg (Region) і care (Rozmowy).
--
--  Запуск: psql -d sasdb -f db/migration_board.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS board;

-- Індекси для вибірок пульта (нічого не змінюють у даних)
CREATE INDEX IF NOT EXISTS hours_log_work_date_idx ON public.hours_log(work_date);
CREATE INDEX IF NOT EXISTS wfh_worker_idx          ON public.worker_facility_history(worker_id);
CREATE INDEX IF NOT EXISTS risk_daily_worker_idx   ON care.risk_daily(worker_id, day);
CREATE INDEX IF NOT EXISTS tasks_worker_idx        ON care.tasks(worker_id, created_at);

-- ── Працевлаштування в компанії («спел») ─────────────────────────────
-- Періоди з reg.v_periods (без rezygnacja і TEST) однієї людини, між якими
-- не більше 14 днів, склеюються в один спел: перехід на інший об'єкт або
-- повернення за два тижні — це не відхід з компанії. Після періоду зі статусом
-- «przeniesiony» чекаємо до 60 днів (новий об'єкт часто вноситься в таблиці пізніше).
--   start_*  — перший період (де людину прийняли)
--   end_*    — останній період (звідки пішла)
--   end_date — NULL, поки людина працює
-- Відхід = end_date заповнена і останній статус не «przeniesiony».
CREATE OR REPLACE VIEW board.v_spells AS
WITH p AS (
  SELECT v.worker_id, v.facility_id, v.site_key, v.status, v.bhp_date, v.last_work_date AS lwd
  FROM reg.v_periods v
  WHERE v.bhp_date <= care.today()
),
o AS (
  SELECT p.*,
         MAX(COALESCE(p.lwd, DATE 'infinity')) OVER (
           PARTITION BY p.worker_id ORDER BY p.bhp_date, COALESCE(p.lwd, DATE 'infinity')
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end,
         LAG(p.status) OVER (
           PARTITION BY p.worker_id ORDER BY p.bhp_date, COALESCE(p.lwd, DATE 'infinity')) AS prev_status
  FROM p
),
g AS (
  SELECT o.*,
         SUM(CASE WHEN o.prev_end IS NULL
                    OR o.bhp_date > o.prev_end + CASE WHEN o.prev_status = 'przeniesiony' THEN 60 ELSE 14 END
                  THEN 1 ELSE 0 END) OVER (
           PARTITION BY o.worker_id ORDER BY o.bhp_date, COALESCE(o.lwd, DATE 'infinity')
           ROWS UNBOUNDED PRECEDING) AS grp
  FROM o
)
SELECT g.worker_id,
       g.grp::int                                                                    AS spell_no,
       MIN(g.bhp_date)                                                               AS start_date,
       CASE WHEN BOOL_OR(g.lwd IS NULL) THEN NULL ELSE MAX(g.lwd) END               AS end_date,
       (ARRAY_AGG(g.facility_id ORDER BY g.bhp_date, g.facility_id))[1]              AS start_facility,
       (ARRAY_AGG(g.site_key    ORDER BY g.bhp_date, g.facility_id))[1]              AS start_site,
       (ARRAY_AGG(g.facility_id ORDER BY COALESCE(g.lwd, DATE 'infinity') DESC, g.bhp_date DESC))[1] AS end_facility,
       (ARRAY_AGG(g.site_key    ORDER BY COALESCE(g.lwd, DATE 'infinity') DESC, g.bhp_date DESC))[1] AS end_site,
       (ARRAY_AGG(g.status      ORDER BY COALESCE(g.lwd, DATE 'infinity') DESC, g.bhp_date DESC))[1] AS end_status,
       COUNT(*)::int                                                                 AS periods
FROM g
GROUP BY g.worker_id, g.grp;

-- ── Об'єкти в межах фільтра ──────────────────────────────────────────
-- p_region: NULL = усі, -1 = без регіону;  p_client: NULL = усі;  p_coord: NULL = усі.
-- Регіон і координатор — поточна прив'язка об'єкта (reg.site_owner, як у Region).
CREATE OR REPLACE FUNCTION board.sites(p_region INT, p_client TEXT, p_coord INT)
RETURNS TABLE (facility_id INT, site_key TEXT, region_id INT, coordinator_id INT, client_name TEXT)
LANGUAGE sql STABLE AS $$
  SELECT f.id, reg.site_key(f.group_name, f.name), o.region_id, o.coordinator_id, f.client_name
  FROM public.facilities f
  LEFT JOIN reg.site_owner o ON o.site_key = reg.site_key(f.group_name, f.name) AND o.valid_to IS NULL
  WHERE (p_region IS NULL OR (p_region = -1 AND o.region_id IS NULL) OR o.region_id = p_region)
    AND (p_client IS NULL OR f.client_name = p_client)
    AND (p_coord  IS NULL OR o.coordinator_id = p_coord)
$$;

COMMIT;
