-- ══════════════════════════════════════════════════════════════════════
--  Розділ «Region» — регіональні координатори, RAG-статус об'єктів,
--  червоні картки. Все в окремій схемі reg (public не змінюється).
--
--  Об'єкт (site) = група facilities за facilities.group_name
--  (IDL Psary = ID Psary APT + SAS + WELL). Без group_name — за name.
--
--  Запуск: psql -d sasdb -f db/migration_regional.sql
--  Ідемпотентно: можна запускати повторно.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS reg;

-- ── Довідники ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reg.regions (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Регіональні координатори регіону. Їх може бути кілька на один регіон.
CREATE TABLE IF NOT EXISTS reg.region_leads (
  region_id      INT NOT NULL REFERENCES reg.regions(id) ON DELETE CASCADE,
  coordinator_id INT NOT NULL REFERENCES public.coordinators(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT,
  PRIMARY KEY (region_id, coordinator_id)
);
CREATE INDEX IF NOT EXISTS region_leads_coord_idx ON reg.region_leads(coordinator_id);

-- Перехід зі старої схеми (один координатор у колонці regions):
-- переносимо його в region_leads і прибираємо колонку.
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'reg' AND table_name = 'regions'
                AND column_name = 'regional_coordinator_id') THEN
    INSERT INTO reg.region_leads (region_id, coordinator_id)
    SELECT id, regional_coordinator_id FROM reg.regions WHERE regional_coordinator_id IS NOT NULL
    ON CONFLICT DO NOTHING;
    ALTER TABLE reg.regions DROP COLUMN regional_coordinator_id;
  END IF;
END
$mig$;

-- Хто відповідає за об'єкт і до якого регіону він належить — з датами.
-- Поточний запис: valid_to IS NULL. При зміні: старий закривається,
-- новий відкривається — історичні тижні рахуються за старою прив'язкою.
CREATE TABLE IF NOT EXISTS reg.site_owner (
  id             SERIAL PRIMARY KEY,
  site_key       TEXT NOT NULL,
  region_id      INT REFERENCES reg.regions(id),
  coordinator_id INT REFERENCES public.coordinators(id),
  valid_from     DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS site_owner_current_uq
  ON reg.site_owner(site_key) WHERE valid_to IS NULL;

-- Пороги і параметри. Змінюються в розділі без правки коду.
CREATE TABLE IF NOT EXISTS reg.settings (
  key        TEXT PRIMARY KEY,
  value      NUMERIC NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);
INSERT INTO reg.settings (key, value, note) VALUES
  ('window_days',            28,   'Вікно розрахунку, днів'),
  ('small_site_headcount',   10,   'Об''єкт менший за це — вважається малим'),
  ('small_site_window_days', 91,   'Вікно для малих об''єктів, днів'),
  ('rot_green_max',          0.12, 'Ротація (у перерахунку на 28 днів): зелений до'),
  ('rot_amber_max',          0.25, 'Ротація: жовтий до, вище — червоний'),
  ('ret_days_1',             30,   'Поріг стажу 1, днів'),
  ('ret_weight_1',           1,    'Вага порогу 1'),
  ('ret_days_2',             80,   'Поріг стажу 2, днів'),
  ('ret_weight_2',           4,    'Вага порогу 2'),
  ('ret_green_min',          0.75, 'Дожиття: зелений від'),
  ('ret_amber_min',          0.40, 'Дожиття: жовтий від, нижче — червоний'),
  ('ret_min_weight',         8,    'Мінімум можливих ваг (≈2 людини на порозі 80 днів), інакше критерій не рахується'),
  ('abs_green_max',          0.03, 'Абсенція NN: зелений до'),
  ('abs_amber_max',          0.06, 'Абсенція NN: жовтий до, вище — червоний'),
  ('abs_enabled',            0,    '1 = абсенція входить у статус, 0 = тільки показується (увімкнути після перевірки даних NN)'),
  ('abs_min_days',           50,   'Мінімум людино-днів, інакше критерій не рахується'),
  ('exit_red_weeks',         2,    'Скільки тижнів поспіль нижче порогу, щоб вийти з червоного'),
  ('card_due_workdays',      3,    'Робочих днів на заповнення картки'),
  ('escalate_red_weeks',     6,    'Ескалація, якщо об''єкт червоний стільки тижнів поспіль')
ON CONFLICT (key) DO NOTHING;

-- Структурні випадки (клієнт закриває об'єкт, ріже замовлення).
-- Ставить тільки адмін. Об'єкт стає сірим і не йде в показники.
CREATE TABLE IF NOT EXISTS reg.site_flags (
  id         SERIAL PRIMARY KEY,
  site_key   TEXT NOT NULL,
  flag       TEXT NOT NULL DEFAULT 'structural' CHECK (flag IN ('structural')),
  date_from  DATE NOT NULL,
  date_to    DATE,
  note       TEXT,
  created_by INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_to IS NULL OR date_to >= date_from)
);

-- Закритий список причин для червоних карток
CREATE TABLE IF NOT EXISTS reg.reasons (
  code  TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort  INT NOT NULL DEFAULT 0
);
INSERT INTO reg.reasons (code, label, sort) VALUES
  ('pay',        'Wynagrodzenie / stawka',             1),
  ('housing',    'Zakwaterowanie',                     2),
  ('transport',  'Transport',                          3),
  ('conditions', 'Warunki pracy u klienta',            4),
  ('schedule',   'Grafik / liczba godzin',             5),
  ('legal',      'Legalizacja / dokumenty',            6),
  ('recruit',    'Rekrutacja — niedopasowanie ludzi',  7),
  ('coord',      'Praca koordynatora',                 8),
  ('client',     'Redukcja / sezon po stronie klienta',9),
  ('other',      'Inne',                               99)
ON CONFLICT (code) DO NOTHING;

-- ── Тижневі знімки ────────────────────────────────────────────────────
-- Один рядок = об'єкт за тиждень, що закінчується в неділю week_end.
-- Після запису не перераховується автоматично: історія не «пливе».
CREATE TABLE IF NOT EXISTS reg.rag_snapshots (
  week_end        DATE NOT NULL,
  site_key        TEXT NOT NULL,
  region_id       INT,
  coordinator_id  INT,
  window_days     INT NOT NULL,
  headcount_start INT NOT NULL,
  headcount_end   INT NOT NULL,
  headcount_avg   NUMERIC NOT NULL,
  departures      INT NOT NULL,
  rotation        NUMERIC,
  ret_possible    INT NOT NULL,
  ret_achieved    INT NOT NULL,
  retention       NUMERIC,
  abs_nn          INT NOT NULL,
  abs_base        INT NOT NULL,
  absence         NUMERIC,
  st_rot          CHAR(1),
  st_ret          CHAR(1),
  st_abs          CHAR(1),
  raw_status      CHAR(1) NOT NULL,   -- G/A/R, S = структурний, N = немає даних
  status          CHAR(1) NOT NULL,   -- після правила виходу з червоного
  nonred_streak   INT NOT NULL DEFAULT 0,
  red_weeks       INT NOT NULL DEFAULT 0,
  params          JSONB,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  computed_by     INT,
  PRIMARY KEY (week_end, site_key)
);
CREATE INDEX IF NOT EXISTS rag_snapshots_region_idx ON reg.rag_snapshots(region_id, week_end);

-- ── Червоні картки ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reg.red_cards (
  id                   SERIAL PRIMARY KEY,
  site_key             TEXT NOT NULL,
  region_id            INT,
  opened_week          DATE NOT NULL,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at               TIMESTAMPTZ NOT NULL,
  reason_code          TEXT REFERENCES reg.reasons(code),
  reason_note          TEXT,
  action_plan          TEXT,
  action_due           DATE,
  owner_coordinator_id INT REFERENCES public.coordinators(id),
  filled_at            TIMESTAMPTZ,
  filled_by            INT,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  closed_at            TIMESTAMPTZ,
  closed_week          DATE,
  close_reason         TEXT,
  reminded_at          TIMESTAMPTZ,
  escalated_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS red_cards_one_active
  ON reg.red_cards(site_key) WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS reg.card_notes (
  id                SERIAL PRIMARY KEY,
  card_id           INT NOT NULL REFERENCES reg.red_cards(id) ON DELETE CASCADE,
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_coordinator_id INT,
  text              TEXT NOT NULL
);

-- ── Функції ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reg.site_key(p_group TEXT, p_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(NULLIF(btrim(p_group), ''), btrim(p_name))
$$;

CREATE OR REPLACE FUNCTION reg.setting(p_key TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT value FROM reg.settings WHERE key = p_key
$$;

-- +N робочих днів (пн–пт), свята не враховуються
CREATE OR REPLACE FUNCTION reg.add_workdays(p_from TIMESTAMPTZ, p_days INT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d TIMESTAMPTZ := p_from; n INT := 0;
BEGIN
  WHILE n < p_days LOOP
    d := d + INTERVAL '1 day';
    IF EXTRACT(ISODOW FROM d) < 6 THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;

-- Періоди роботи, очищені: без rezygnacja, без TEST, без перевернутих дат,
-- дублікати одного періоду (worker + site + bhp) — один рядок.
CREATE OR REPLACE VIEW reg.v_periods AS
SELECT DISTINCT ON (h.worker_id, reg.site_key(f.group_name, f.name), h.bhp_date)
       h.worker_id,
       h.facility_id,
       reg.site_key(f.group_name, f.name) AS site_key,
       h.status::text AS status,
       h.bhp_date,
       h.last_work_date
FROM public.worker_facility_history h
JOIN public.facilities f ON f.id = h.facility_id
JOIN public.workers w    ON w.id = h.worker_id
WHERE h.bhp_date IS NOT NULL
  AND h.status::text <> 'rezygnacja'
  AND w.login NOT LIKE 'TEST_%'
  AND (h.last_work_date IS NULL OR h.last_work_date >= h.bhp_date)
ORDER BY h.worker_id, reg.site_key(f.group_name, f.name), h.bhp_date,
         h.imported_at DESC NULLS LAST, h.last_work_date DESC NULLS FIRST, h.id DESC;

-- Сирий RAG на дату p_asof (кінець вікна). Параметризовано датою:
-- той самий код рахує і поточний тиждень, і історію.
CREATE OR REPLACE FUNCTION reg.rag_raw(p_asof DATE)
RETURNS TABLE (
  site_key TEXT, window_days INT,
  headcount_start INT, headcount_end INT, headcount_avg NUMERIC,
  departures INT, rotation NUMERIC,
  ret_possible INT, ret_achieved INT, retention NUMERIC,
  abs_nn INT, abs_base INT, absence NUMERIC,
  st_rot CHAR(1), st_ret CHAR(1), st_abs CHAR(1), raw_status CHAR(1)
) LANGUAGE sql STABLE AS $$
WITH prm AS (
  SELECT reg.setting('window_days')::int            AS wd,
         reg.setting('small_site_window_days')::int AS swd,
         reg.setting('small_site_headcount')        AS small_hc,
         reg.setting('rot_green_max') AS rot_g, reg.setting('rot_amber_max') AS rot_a,
         reg.setting('ret_days_1')::int AS k1, reg.setting('ret_weight_1')::int AS w1,
         reg.setting('ret_days_2')::int AS k2, reg.setting('ret_weight_2')::int AS w2,
         reg.setting('ret_green_min') AS ret_g, reg.setting('ret_amber_min') AS ret_a,
         reg.setting('ret_min_weight') AS ret_min,
         reg.setting('abs_green_max') AS abs_g, reg.setting('abs_amber_max') AS abs_a,
         reg.setting('abs_min_days') AS abs_min,
         COALESCE(reg.setting('abs_enabled'), 1) AS abs_on
),
win AS (
  SELECT prm.wd AS days FROM prm
  UNION SELECT prm.swd FROM prm
),
p AS (SELECT * FROM reg.v_periods WHERE bhp_date <= p_asof),
-- чисельність на початок і кінець вікна, звільнення у вікні
hc AS (
  SELECT p.site_key, win.days,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.bhp_date <= p_asof - win.days
             AND (p.last_work_date IS NULL OR p.last_work_date > p_asof - win.days)) AS hc_start,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.last_work_date IS NULL OR p.last_work_date > p_asof) AS hc_end,
         COUNT(DISTINCT p.worker_id) FILTER (
           WHERE p.last_work_date >  p_asof - win.days
             AND p.last_work_date <= p_asof
             AND p.status <> 'przeniesiony') AS dep
  FROM p CROSS JOIN win
  GROUP BY p.site_key, win.days
),
-- дожиття: пороги, що випали у вікно; зараховано, якщо людина в кадрі на кінець
ret AS (
  SELECT p.site_key, win.days,
         SUM(t.w) AS possible,
         SUM(t.w) FILTER (WHERE p.last_work_date IS NULL OR p.last_work_date > p_asof) AS achieved
  FROM p CROSS JOIN win CROSS JOIN prm
  CROSS JOIN LATERAL (VALUES (prm.k1, prm.w1), (prm.k2, prm.w2)) AS t(k, w)
  WHERE p.status <> 'przeniesiony'
    AND p.bhp_date + t.k >  p_asof - win.days
    AND p.bhp_date + t.k <= p_asof
  GROUP BY p.site_key, win.days
),
-- абсенція: дні з годинами + NN/UN/L4/URL; NN = без причини
day_site AS (
  SELECT DISTINCT ON (hl.worker_id, hl.work_date)
         hl.worker_id, hl.work_date, p.site_key,
         (hl.hours IS NOT NULL AND hl.hours > 0)      AS worked,
         hl.absence_type::text                        AS abs
  FROM public.hours_log hl
  JOIN p ON p.worker_id = hl.worker_id
        AND hl.work_date >= p.bhp_date
        AND (p.last_work_date IS NULL OR hl.work_date <= p.last_work_date)
  WHERE hl.work_date >  p_asof - (SELECT MAX(days) FROM win)
    AND hl.work_date <= p_asof
  ORDER BY hl.worker_id, hl.work_date, p.bhp_date DESC
),
ab AS (
  SELECT d.site_key, win.days,
         COUNT(*) FILTER (WHERE d.abs = 'NN') AS nn,
         COUNT(*) FILTER (WHERE d.worked OR d.abs IN ('NN','UN','L4','URL')) AS base
  FROM day_site d CROSS JOIN win
  WHERE d.work_date > p_asof - win.days
  GROUP BY d.site_key, win.days
),
m AS (
  SELECT hc.site_key, hc.days,
         hc.hc_start::int, hc.hc_end::int,
         (hc.hc_start + hc.hc_end) / 2.0 AS hc_avg,
         hc.dep::int,
         COALESCE(ret.possible, 0)::int AS possible,
         COALESCE(ret.achieved, 0)::int AS achieved,
         COALESCE(ab.nn, 0)::int AS nn,
         COALESCE(ab.base, 0)::int AS base
  FROM hc
  LEFT JOIN ret ON ret.site_key = hc.site_key AND ret.days = hc.days
  LEFT JOIN ab  ON ab.site_key  = hc.site_key AND ab.days  = hc.days
  WHERE hc.hc_start > 0 OR hc.hc_end > 0 OR hc.dep > 0
),
-- малий об'єкт (за основним вікном) → беремо довше вікно
pick AS (
  SELECT m.*
  FROM m CROSS JOIN prm
  WHERE m.days = CASE
          WHEN (SELECT m2.hc_avg FROM m m2 WHERE m2.site_key = m.site_key AND m2.days = prm.wd) < prm.small_hc
          THEN prm.swd ELSE prm.wd END
),
st AS (
  SELECT pick.*,
         CASE WHEN pick.hc_avg > 0
              THEN pick.dep / pick.hc_avg * prm.wd::numeric / pick.days END AS rot,
         CASE WHEN pick.possible > 0 THEN pick.achieved::numeric / pick.possible END AS ret_v,
         CASE WHEN pick.base > 0 THEN pick.nn::numeric / pick.base END AS abs_v,
         prm.*
  FROM pick CROSS JOIN prm
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
                          AND fl.date_from <= p_asof
                          AND (fl.date_to IS NULL OR fl.date_to >= p_asof)) THEN 'S'
          WHEN 'R' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'R'
          WHEN 'A' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'A'
          WHEN 'G' IN (st2.s_rot, st2.s_ret, st2.s_abs) THEN 'G'
          ELSE 'N' END)::char(1)
FROM st2
$$;

-- Тижневий знімок: сирий статус → правило виходу з червоного →
-- прив'язка до регіону на дату → червоні картки.
-- p_manage_cards = false для догрузки історії (картки не створюються).
CREATE OR REPLACE FUNCTION reg.take_snapshot(p_week_end DATE, p_by INT DEFAULT NULL,
                                             p_manage_cards BOOLEAN DEFAULT true)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_exit INT := reg.setting('exit_red_weeks')::int;
  v_due  INT := reg.setting('card_due_workdays')::int;
  v_params JSONB := (SELECT jsonb_object_agg(key, value) FROM reg.settings);
  v_n INT;
BEGIN
  IF EXTRACT(ISODOW FROM p_week_end) <> 7 THEN
    RAISE EXCEPTION 'week_end має бути неділею: %', p_week_end;
  END IF;

  INSERT INTO reg.rag_snapshots AS s (
    week_end, site_key, region_id, coordinator_id, window_days,
    headcount_start, headcount_end, headcount_avg, departures, rotation,
    ret_possible, ret_achieved, retention, abs_nn, abs_base, absence,
    st_rot, st_ret, st_abs, raw_status, status, nonred_streak, red_weeks,
    params, computed_at, computed_by)
  SELECT p_week_end, r.site_key, o.region_id, o.coordinator_id, r.window_days,
         r.headcount_start, r.headcount_end, r.headcount_avg, r.departures, r.rotation,
         r.ret_possible, r.ret_achieved, r.retention, r.abs_nn, r.abs_base, r.absence,
         r.st_rot, r.st_ret, r.st_abs, r.raw_status,
         x.status, x.nonred, CASE WHEN x.status = 'R' THEN COALESCE(prev.red_weeks, 0) + 1 ELSE 0 END,
         v_params, now(), p_by
  FROM reg.rag_raw(p_week_end) r
  LEFT JOIN reg.rag_snapshots prev
         ON prev.site_key = r.site_key AND prev.week_end = p_week_end - 7
  LEFT JOIN LATERAL (
    SELECT so.region_id, so.coordinator_id FROM reg.site_owner so
    WHERE so.site_key = r.site_key AND so.valid_from <= p_week_end
      AND (so.valid_to IS NULL OR so.valid_to >= p_week_end)
    ORDER BY so.valid_from DESC, so.id DESC LIMIT 1) o ON true
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.raw_status IN ('G','A') THEN COALESCE(prev.nonred_streak, 0) + 1 ELSE 0 END AS nonred
  ) n
  CROSS JOIN LATERAL (
    SELECT n.nonred,
      CASE
        WHEN r.raw_status = 'R' THEN 'R'
        WHEN r.raw_status IN ('S','N') THEN r.raw_status
        WHEN prev.status = 'R' AND n.nonred < v_exit THEN 'R'
        ELSE r.raw_status
      END AS status
  ) x
  ON CONFLICT (week_end, site_key) DO UPDATE SET
    region_id = EXCLUDED.region_id, coordinator_id = EXCLUDED.coordinator_id,
    window_days = EXCLUDED.window_days,
    headcount_start = EXCLUDED.headcount_start, headcount_end = EXCLUDED.headcount_end,
    headcount_avg = EXCLUDED.headcount_avg, departures = EXCLUDED.departures,
    rotation = EXCLUDED.rotation, ret_possible = EXCLUDED.ret_possible,
    ret_achieved = EXCLUDED.ret_achieved, retention = EXCLUDED.retention,
    abs_nn = EXCLUDED.abs_nn, abs_base = EXCLUDED.abs_base, absence = EXCLUDED.absence,
    st_rot = EXCLUDED.st_rot, st_ret = EXCLUDED.st_ret, st_abs = EXCLUDED.st_abs,
    raw_status = EXCLUDED.raw_status, status = EXCLUDED.status,
    nonred_streak = EXCLUDED.nonred_streak, red_weeks = EXCLUDED.red_weeks,
    params = EXCLUDED.params, computed_at = now(), computed_by = EXCLUDED.computed_by;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- рядки попередніх перерахунків, яких цього разу немає (об'єкт зник) — прибрати
  DELETE FROM reg.rag_snapshots s
  WHERE s.week_end = p_week_end
    AND s.site_key NOT IN (SELECT r.site_key FROM reg.rag_raw(p_week_end) r);

  IF p_manage_cards THEN
    -- закрити картки об'єктів, що вийшли з червоного
    UPDATE reg.red_cards c
       SET status = 'closed', closed_at = now(), closed_week = p_week_end,
           close_reason = CASE WHEN s.status = 'S' THEN 'structural' ELSE 'left_red' END
      FROM reg.rag_snapshots s
     WHERE s.week_end = p_week_end AND s.site_key = c.site_key
       AND c.status <> 'closed' AND s.status <> 'R';

    -- нова картка для кожного червоного об'єкта без активної картки
    INSERT INTO reg.red_cards (site_key, region_id, opened_week, opened_at, due_at)
    SELECT s.site_key, s.region_id, p_week_end, now(), reg.add_workdays(now(), v_due)
      FROM reg.rag_snapshots s
     WHERE s.week_end = p_week_end AND s.status = 'R'
       AND NOT EXISTS (SELECT 1 FROM reg.red_cards c
                        WHERE c.site_key = s.site_key AND c.status <> 'closed');
  END IF;

  RETURN v_n;
END $$;

-- Знімки для показу. Для НАЙСВІЖІШОГО тижня регіон і координатор беруться
-- з поточних прив'язок (site_owner, valid_to IS NULL): призначив — одразу видно.
-- Старші тижні показують прив'язку, що діяла на той тиждень.
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
LEFT JOIN reg.site_owner cur ON cur.site_key = s.site_key AND cur.valid_to IS NULL;

COMMIT;
