-- ══════════════════════════════════════════════════════════════════════
--  v_worker_current — «поточний заклад» працівника: не брати rezygnacja / закінчений запис,
--  якщо є інший, що триває.
--
--  Було: просто запис з найпізнішим BHP. Працівник повернувся з відрядження (Notino → CEVA → Notino):
--  у CEVA BHP 08.09.2026 rezygnacja, у Notino BHP 15.05.2026 pracuje → поточним рахувався CEVA.
--  Наслідки: координатор Notino не міг правити години (403), бот вважав працівника звільненим
--  (аванси / вихідні заблоковані), години у звітах ішли на CEVA.
--
--  Стало (порядок вибору):
--    1) не rezygnacja раніше за rezygnacja (rezygnacja — лише коли нічого іншого немає);
--    2) запис, що триває (last_work_date порожня або ≥ сьогодні), раніше за закінчений;
--    3) далі як було — найпізніший BHP.
--  Колонки ті самі — код не міняється. Можна запускати повторно.
-- ══════════════════════════════════════════════════════════════════════

-- КРОК 1 (тільки читання). Кого зачепить: поточний заклад / статус до і після
WITH nowy AS (
  SELECT DISTINCT ON (w.id) w.id, h.facility_id, h.status::text AS status
    FROM workers w
    JOIN worker_facility_history h ON h.worker_id = w.id
   ORDER BY w.id,
            (h.status::text = 'rezygnacja'),
            (h.last_work_date IS NOT NULL AND h.last_work_date < CURRENT_DATE),
            h.bhp_date DESC NULLS LAST
)
SELECT w.full_name AS pracownik, w.login,
       fo.name AS bylo, o.status AS status_bylo,
       fn.name AS bedzie, n.status AS status_bedzie
  FROM v_worker_current o
  JOIN nowy n          ON n.id = o.id
  JOIN workers w       ON w.id = o.id
  LEFT JOIN facilities fo ON fo.id = o.facility_id
  LEFT JOIN facilities fn ON fn.id = n.facility_id
 WHERE o.facility_id IS DISTINCT FROM n.facility_id OR o.status IS DISTINCT FROM n.status
 ORDER BY fn.name, w.full_name;

-- КРОК 2. Зміна вʼю
BEGIN;
DO $$
DECLARE cols TEXT;
BEGIN
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_worker_current';
  IF cols IS DISTINCT FROM 'id,login,full_name,telegram_chat_id,facility_id,status,bhp_date,last_work_date' THEN
    RAISE EXCEPTION 'v_worker_current має інші колонки (%) — нічого не змінено. Надішліть результат: SELECT pg_get_viewdef(''v_worker_current'', true);', cols;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_worker_current AS
SELECT DISTINCT ON (w.id)
       w.id, w.login, w.full_name, w.telegram_chat_id,
       h.facility_id, h.status::text AS status, h.bhp_date, h.last_work_date
  FROM workers w
  JOIN worker_facility_history h ON h.worker_id = w.id
 ORDER BY w.id,
          (h.status::text = 'rezygnacja'),                                     -- rezygnacja — в останню чергу
          (h.last_work_date IS NOT NULL AND h.last_work_date < CURRENT_DATE),  -- закінчені — після тих, що тривають
          h.bhp_date DESC NULLS LAST;                                          -- далі як було
COMMIT;

-- КРОК 3. Перевірка на прикладі
SELECT v.full_name, f.name AS zaklad, v.status, v.bhp_date, v.last_work_date
  FROM v_worker_current v JOIN facilities f ON f.id = v.facility_id
 WHERE v.full_name ILIKE 'DYSKO%';
