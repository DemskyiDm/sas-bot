-- ══════════════════════════════════════════════════════════════════════
--  Архів об'єктів: з об'єктами, з якими більше не працюємо.
--
--  Об'єкт в архіві:
--   • Wyjazdy / przyjazdy — немає в списках, плані набору, зведеннях і нагадуваннях;
--   • Region — немає на дошці (і в історії тижнів), не відкриваються червоні картки,
--     відкриті картки закриваються («archived»);
--   • Tablica (zarząd) — не входить у показники;
--   • Rozmowy — працівники об'єкта не потрапляють у ризик, розмови й анкети;
--   • Poleć znajomego — новим не надсилається стартовий пакет.
--  Прив'язка до регіону / координатора закривається (запам'ятовується для відновлення).
--  Дані (графіки, history, відповіді) не видаляються: «Przywróć» повертає все як було.
--
--  Керування: Region → Ustawienia → «📦 Archiwum obiektów» (адміністратор).
--  Потрібні: migration_regional.sql, migration_flow.sql, migration_care.sql, migration_board.sql.
--  Повторний запуск безпечний.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS reg.site_archive (
  site_key            TEXT PRIMARY KEY,
  archived_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_by         INT,
  note                TEXT,
  prev_region_id      INT,          -- прив'язка до архівування — для «Przywróć»
  prev_coordinator_id INT
);

CREATE OR REPLACE FUNCTION reg.archived(p_site TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM reg.site_archive a WHERE a.site_key = p_site)
$$;

-- ── Wyjazdy: об'єкти без архівних ────────────────────────────────────
CREATE OR REPLACE FUNCTION flow.sites()
RETURNS TABLE (site_key TEXT, region_id INT, region_name TEXT, coordinator_id INT, coordinator_name TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT DISTINCT v.site_key FROM flow.v_rows v
     WHERE v.status <> 'rezygnacja' AND v.bhp_date IS NOT NULL
       AND (v.last_work_date IS NULL OR v.last_work_date >= flow.today() - 90)
    UNION
    SELECT o.site_key FROM reg.site_owner o WHERE o.valid_to IS NULL
  )
  SELECT s.site_key, o.region_id, rg.name, o.coordinator_id, c.full_name
    FROM s
    LEFT JOIN reg.site_owner o ON o.site_key = s.site_key AND o.valid_to IS NULL
    LEFT JOIN reg.regions rg ON rg.id = o.region_id
    LEFT JOIN public.coordinators c ON c.id = o.coordinator_id
   WHERE NOT reg.archived(s.site_key)
$$;

-- ── Rozmowy: працівники архівних об'єктів — не «активні» ─────────────
CREATE OR REPLACE FUNCTION care.active_on(p_day DATE)
RETURNS TABLE (worker_id INT, facility_id INT, bhp_date DATE, last_work_date DATE, site_key TEXT)
LANGUAGE sql STABLE AS $$
SELECT DISTINCT ON (h.worker_id)
       h.worker_id, h.facility_id, h.bhp_date, h.last_work_date,
       reg.site_key(f.group_name, f.name)
FROM public.worker_facility_history h
JOIN public.facilities f ON f.id = h.facility_id
JOIN public.workers w    ON w.id = h.worker_id
WHERE h.status::text IN ('pracuje','urlop')
  AND h.bhp_date IS NOT NULL AND h.bhp_date <= p_day
  AND (h.last_work_date IS NULL OR h.last_work_date >= p_day)
  AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
  AND NOT reg.archived(reg.site_key(f.group_name, f.name))
ORDER BY h.worker_id, h.bhp_date DESC
$$;

-- ── Tablica: об'єкти без архівних ────────────────────────────────────
CREATE OR REPLACE FUNCTION board.sites(p_region INT, p_client TEXT, p_coord INT)
RETURNS TABLE (facility_id INT, site_key TEXT, region_id INT, coordinator_id INT, client_name TEXT)
LANGUAGE sql STABLE AS $$
  SELECT f.id, reg.site_key(f.group_name, f.name), o.region_id, o.coordinator_id, f.client_name
  FROM public.facilities f
  LEFT JOIN reg.site_owner o ON o.site_key = reg.site_key(f.group_name, f.name) AND o.valid_to IS NULL
  WHERE (p_region IS NULL OR (p_region = -1 AND o.region_id IS NULL) OR o.region_id = p_region)
    AND (p_client IS NULL OR f.client_name = p_client)
    AND (p_coord  IS NULL OR o.coordinator_id = p_coord)
    AND NOT reg.archived(reg.site_key(f.group_name, f.name))
$$;

-- ── Region: дошка й історія тижнів без архівних ──────────────────────
CREATE OR REPLACE VIEW reg.v_snap AS
SELECT s.week_end, s.site_key,
       CASE WHEN s.week_end = m.w AND cur.id IS NOT NULL THEN cur.region_id      ELSE s.region_id      END AS region_id,
       CASE WHEN s.week_end = m.w AND cur.id IS NOT NULL THEN cur.coordinator_id ELSE s.coordinator_id END AS coordinator_id,
       s.window_days, s.headcount_start, s.headcount_end, s.headcount_avg, s.departures, s.rotation,
       s.ret_possible, s.ret_achieved, s.retention, s.abs_nn, s.abs_base, s.absence,
       s.st_rot, s.st_ret, s.st_abs, s.raw_status, s.status, s.nonred_streak, s.red_weeks,
       s.params, s.computed_at, s.computed_by
FROM reg.rag_snapshots s
CROSS JOIN (SELECT MAX(week_end) AS w FROM reg.rag_snapshots) m
LEFT JOIN reg.site_owner cur ON cur.site_key = s.site_key AND cur.valid_to IS NULL
WHERE NOT reg.archived(s.site_key);

-- Червона картка для архівного об'єкта не відкривається (reg.take_snapshot без змін)
CREATE OR REPLACE FUNCTION reg.skip_archived_card()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF reg.archived(NEW.site_key) THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS red_cards_skip_archived ON reg.red_cards;
CREATE TRIGGER red_cards_skip_archived BEFORE INSERT ON reg.red_cards
  FOR EACH ROW EXECUTE FUNCTION reg.skip_archived_card();

COMMIT;
