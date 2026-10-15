-- ══════════════════════════════════════════════════════════════════════
--  Розділ «Wyjazdy / przyjazdy»: виїзди, приїзди, план набору.
--
--  Що тут:
--   • журнал змін таблиці worker_facility_history (коли запис / дата / статус
--     вперше з'явилися) — без нього не відрізнити «вписано до зведення» від «після»;
--   • виїзди і приїзди за період (правила — нижче, у функціях);
--   • план набору: координатор у неділю вводить, скільки людей набрати на 3 тижні;
--   • план виїздів тижня: фіксується в понеділок 00:00 (що було вписано на тиждень);
--   • щоденне зведення: що вже показано, щоб дописане пізніше пішло наступного дня;
--   • налаштування і список отримувачів.
--
--  Потрібна схема reg (розділ Region): reg.site_key, reg.site_owner, reg.regions.
--  Таблиці public не змінюються — додаються лише 2 індекси для пошуку за датами.
--  Запуск: psql -U postgres -d sasdb -f db/migration_flow.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS flow;

-- ── Налаштування ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);
INSERT INTO flow.settings (key, value, note) VALUES
  ('enabled',         '1',             '1 = зведення, нагадування і фіксація плану працюють'),
  ('summary_time',    '16:00',         'Час щоденного зведення (польський час)'),
  ('summary_days',    '1,2,3,4,5,6,7', 'Дні зведення: 1 = пн … 7 = нд'),
  ('pre_import_min',  '20',            'За скільки хвилин до зведення запустити імпорт таблиці (0 = не запускати)'),
  ('late_days',       '14',            'Скільки днів назад шукати дописані виїзди і приїзди'),
  ('skip_empty',      '1',             '1 = координатору не надсилати зведення, якщо на його об''єктах нічого не сталося'),
  ('auto_coords',     '1',             '1 = кожен координатор отримує зведення по своїх об''єктах і нагадування в неділю'),
  ('orders_remind',   '12:00,18:00',   'Нагадування в неділю про план набору'),
  ('orders_deadline', '20:00',         'До котрої в неділю ввести план набору (показується в нагадуванні)'),
  ('monday_time',     '09:00',         'Понеділок: хто не ввів план + план–факт минулого тижня')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION flow.setting(p_key TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT value FROM flow.settings WHERE key = p_key $$;

-- Сьогодні за польським часом (сервер може бути в іншому поясі)
CREATE OR REPLACE FUNCTION flow.today()
RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Europe/Warsaw')::date $$;

-- ── Журнал змін ───────────────────────────────────────────────────────
-- Дзеркало worker_facility_history: один рядок = рядок history (hid = його id).
-- *_at — коли поточне значення поля вперше побачили. baseline = рядок був
-- до запуску журналу (час його появи невідомий).
CREATE TABLE IF NOT EXISTS flow.rows (
  hid            INT PRIMARY KEY,
  worker_id      INT NOT NULL,
  facility_id    INT,
  site_key       TEXT,
  status         TEXT,
  bhp_date       DATE,
  last_work_date DATE,
  first_seen_at  TIMESTAMPTZ NOT NULL,
  baseline       BOOLEAN NOT NULL DEFAULT false,
  status_at      TIMESTAMPTZ,
  bhp_at         TIMESTAMPTZ,
  lwd_at         TIMESTAMPTZ,
  gone_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS flow_rows_worker_idx ON flow.rows(worker_id);

CREATE TABLE IF NOT EXISTS flow.changes (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  hid       INT NOT NULL,
  worker_id INT,
  site_key  TEXT,
  field     TEXT NOT NULL,          -- new | status | bhp | lwd | site | gone | back
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS flow_changes_at_idx  ON flow.changes(at);
CREATE INDEX IF NOT EXISTS flow_changes_hid_idx ON flow.changes(hid);

CREATE TABLE IF NOT EXISTS flow.capture_runs (
  at        TIMESTAMPTZ PRIMARY KEY DEFAULT clock_timestamp(),
  source    TEXT,
  new_rows  INT, changed INT, gone INT
);

-- Порівнює поточну history з дзеркалом і записує різницю.
-- Перший запуск лише запам'ятовує стан (baseline), змін не пише.
CREATE OR REPLACE FUNCTION flow.capture(p_source TEXT DEFAULT NULL)
RETURNS TABLE (new_rows INT, changed INT, gone INT) LANGUAGE plpgsql AS $$
DECLARE
  v_now   TIMESTAMPTZ := clock_timestamp();
  v_first BOOLEAN;
  n_new INT := 0; n_chg INT := 0; n_gone INT := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('flow.capture'));
  v_first := NOT EXISTS (SELECT 1 FROM flow.rows);

  DROP TABLE IF EXISTS pg_temp._flow_cur;
  CREATE TEMP TABLE _flow_cur ON COMMIT DROP AS
  SELECT h.id AS hid, h.worker_id, h.facility_id, reg.site_key(f.group_name, f.name) AS site_key,
         h.status::text AS status, h.bhp_date, h.last_work_date
    FROM public.worker_facility_history h
    JOIN public.facilities f ON f.id = h.facility_id;
  CREATE INDEX ON _flow_cur(hid);

  -- зміни полів (і повернення видаленого рядка)
  INSERT INTO flow.changes (at, hid, worker_id, site_key, field, old_value, new_value)
  SELECT v_now, c.hid, c.worker_id, c.site_key, x.field, x.o, x.n
    FROM _flow_cur c
    JOIN flow.rows r ON r.hid = c.hid
    CROSS JOIN LATERAL (VALUES
      ('status', r.status,                 c.status),
      ('bhp',    r.bhp_date::text,         c.bhp_date::text),
      ('lwd',    r.last_work_date::text,   c.last_work_date::text),
      ('site',   r.site_key,               c.site_key),
      ('back',   CASE WHEN r.gone_at IS NOT NULL THEN 'gone' END, NULL)
    ) AS x(field, o, n)
   WHERE (x.field <> 'back' AND x.o IS DISTINCT FROM x.n)
      OR (x.field = 'back' AND r.gone_at IS NOT NULL);

  UPDATE flow.rows r SET
         worker_id      = c.worker_id,
         facility_id    = c.facility_id,
         site_key       = c.site_key,
         status_at      = CASE WHEN r.status IS DISTINCT FROM c.status THEN v_now ELSE r.status_at END,
         bhp_at         = CASE WHEN r.bhp_date IS DISTINCT FROM c.bhp_date THEN v_now ELSE r.bhp_at END,
         lwd_at         = CASE WHEN r.last_work_date IS DISTINCT FROM c.last_work_date
                               THEN CASE WHEN c.last_work_date IS NULL THEN NULL ELSE v_now END
                               ELSE r.lwd_at END,
         status         = c.status,
         bhp_date       = c.bhp_date,
         last_work_date = c.last_work_date,
         gone_at        = NULL
    FROM _flow_cur c
   WHERE c.hid = r.hid
     AND (r.status IS DISTINCT FROM c.status OR r.bhp_date IS DISTINCT FROM c.bhp_date
          OR r.last_work_date IS DISTINCT FROM c.last_work_date OR r.site_key IS DISTINCT FROM c.site_key
          OR r.worker_id IS DISTINCT FROM c.worker_id OR r.facility_id IS DISTINCT FROM c.facility_id
          OR r.gone_at IS NOT NULL);
  GET DIAGNOSTICS n_chg = ROW_COUNT;

  -- нові рядки
  INSERT INTO flow.rows (hid, worker_id, facility_id, site_key, status, bhp_date, last_work_date,
                         first_seen_at, baseline, status_at, bhp_at, lwd_at)
  SELECT c.hid, c.worker_id, c.facility_id, c.site_key, c.status, c.bhp_date, c.last_work_date,
         v_now, v_first, v_now, v_now, CASE WHEN c.last_work_date IS NOT NULL THEN v_now END
    FROM _flow_cur c
   WHERE NOT EXISTS (SELECT 1 FROM flow.rows r WHERE r.hid = c.hid);
  GET DIAGNOSTICS n_new = ROW_COUNT;

  IF NOT v_first AND n_new > 0 THEN
    INSERT INTO flow.changes (at, hid, worker_id, site_key, field, old_value, new_value)
    SELECT v_now, r.hid, r.worker_id, r.site_key, 'new', NULL,
           concat_ws(' ', r.status, r.bhp_date::text, r.last_work_date::text)
      FROM flow.rows r WHERE r.first_seen_at = v_now AND NOT r.baseline;
  END IF;

  -- зниклі рядки (імпорт видалив)
  WITH g AS (
    UPDATE flow.rows r SET gone_at = v_now
     WHERE r.gone_at IS NULL AND NOT EXISTS (SELECT 1 FROM _flow_cur c WHERE c.hid = r.hid)
    RETURNING r.hid, r.worker_id, r.site_key, r.status, r.bhp_date, r.last_work_date
  )
  INSERT INTO flow.changes (at, hid, worker_id, site_key, field, old_value, new_value)
  SELECT v_now, g.hid, g.worker_id, g.site_key, 'gone',
         concat_ws(' ', g.status, g.bhp_date::text, g.last_work_date::text), NULL
    FROM g;
  GET DIAGNOSTICS n_gone = ROW_COUNT;

  INSERT INTO flow.capture_runs (at, source, new_rows, changed, gone) VALUES (v_now, p_source, n_new, n_chg, n_gone);
  DELETE FROM flow.capture_runs WHERE at < v_now - INTERVAL '30 days';

  new_rows := n_new; changed := n_chg; gone := n_gone;
  RETURN NEXT;
END $$;

-- ── Виїзди і приїзди ──────────────────────────────────────────────────
-- Рядки history з об'єктом, без тестових логінів
CREATE OR REPLACE VIEW flow.v_rows AS
SELECT h.id AS hid, h.worker_id, h.facility_id, reg.site_key(f.group_name, f.name) AS site_key,
       h.status::text AS status, h.bhp_date, h.last_work_date
  FROM public.worker_facility_history h
  JOIN public.facilities f ON f.id = h.facility_id
  JOIN public.workers w    ON w.id = h.worker_id
 WHERE COALESCE(w.login, '') NOT LIKE 'TEST_%';

-- Виїзд = останній робочий день (last_work_date) у періоді, будь-який статус, крім rezygnacja.
-- Не виїзд: новий період тієї ж людини на тому ж об'єкті почався до 14 днів після
-- (продовження / новий договір).
-- Переведення (is_transfer): статус przeniesiony або новий період на іншому об'єкті
-- почався до 14 днів після. Для об'єкта це виїзд, для компанії — ні.
CREATE OR REPLACE FUNCTION flow.departures(p_from DATE, p_to DATE)
RETURNS TABLE (hid INT, worker_id INT, site_key TEXT, facility_id INT, move_date DATE,
               status TEXT, bhp_date DATE, is_transfer BOOLEAN, to_site TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (d.worker_id, d.site_key, d.last_work_date)
         d.hid, d.worker_id, d.site_key, d.facility_id, d.last_work_date, d.status, d.bhp_date,
         (d.status = 'przeniesiony' OR nx.site_key IS NOT NULL), nx.site_key
    FROM flow.v_rows d
    LEFT JOIN LATERAL (
      SELECT n.site_key FROM flow.v_rows n
       WHERE n.worker_id = d.worker_id AND n.site_key <> d.site_key AND n.status <> 'rezygnacja'
         AND n.bhp_date IS NOT NULL AND n.bhp_date > COALESCE(d.bhp_date, DATE '1900-01-01')
         AND n.bhp_date <= d.last_work_date + 14
       ORDER BY n.bhp_date LIMIT 1
    ) nx ON true
   WHERE d.last_work_date BETWEEN p_from AND p_to
     AND d.status <> 'rezygnacja'
     AND (d.bhp_date IS NULL OR d.last_work_date >= d.bhp_date)
     AND NOT EXISTS (
       SELECT 1 FROM flow.v_rows n
        WHERE n.worker_id = d.worker_id AND n.site_key = d.site_key AND n.hid <> d.hid
          AND n.status <> 'rezygnacja' AND n.bhp_date IS NOT NULL
          AND n.bhp_date > COALESCE(d.bhp_date, DATE '1900-01-01')
          AND n.bhp_date <= d.last_work_date + 14)
   ORDER BY d.worker_id, d.site_key, d.last_work_date, d.hid DESC
$$;

-- Приїзд = перший день (bhp_date) у періоді. Усі статуси, rezygnacja теж
-- (= «не доїхав», у набір не йде), unknown = без статусу (ще не підтверджений).
-- Не приїзд: та сама людина вже працювала на цьому об'єкті до 14 днів перед тим.
-- kind = transfer: до цього працював на іншому об'єкті (закінчив до 14 днів тому,
-- після przeniesiony — до 60 днів; або період там ще не закритий, але свіжий чи з годинами
-- перед стартом) — для об'єкта це приїзд, але не набір.
CREATE OR REPLACE FUNCTION flow.arrivals(p_from DATE, p_to DATE)
RETURNS TABLE (hid INT, worker_id INT, site_key TEXT, facility_id INT, move_date DATE,
               status TEXT, last_work_date DATE, kind TEXT, from_site TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (a.worker_id, a.site_key, a.bhp_date)
         a.hid, a.worker_id, a.site_key, a.facility_id, a.bhp_date, a.status, a.last_work_date,
         CASE WHEN pv.site_key IS NOT NULL THEN 'transfer' ELSE 'new' END, pv.site_key
    FROM flow.v_rows a
    LEFT JOIN LATERAL (
      SELECT p.site_key FROM flow.v_rows p
       WHERE p.worker_id = a.worker_id AND p.site_key <> a.site_key AND p.status <> 'rezygnacja'
         AND p.bhp_date IS NOT NULL AND p.bhp_date < a.bhp_date
         AND (
              -- незакритий період деінде: переведення, лише якщо він свіжий (до 60 днів)
              -- або людина мала години за 14 днів перед стартом (старий незакритий рядок = новий найм)
              (p.last_work_date IS NULL
               AND (p.bhp_date >= a.bhp_date - 60
                    OR EXISTS (SELECT 1 FROM public.hours_log hl
                                WHERE hl.worker_id = a.worker_id
                                  AND hl.work_date BETWEEN a.bhp_date - 14 AND a.bhp_date - 1)))
              OR (p.last_work_date >= p.bhp_date
                  AND a.bhp_date - p.last_work_date <= CASE WHEN p.status = 'przeniesiony' THEN 60 ELSE 14 END))
       ORDER BY p.bhp_date DESC LIMIT 1
    ) pv ON true
   WHERE a.bhp_date BETWEEN p_from AND p_to
     AND NOT EXISTS (
       SELECT 1 FROM flow.v_rows p
        WHERE p.worker_id = a.worker_id AND p.site_key = a.site_key AND p.hid <> a.hid
          AND p.status <> 'rezygnacja' AND p.bhp_date IS NOT NULL AND p.bhp_date < a.bhp_date
          AND (p.last_work_date IS NULL OR p.last_work_date >= a.bhp_date - 14))
   ORDER BY a.worker_id, a.site_key, a.bhp_date, (a.status = 'rezygnacja'), a.hid DESC
$$;

-- Об'єкти: усі, де хтось працював за останні 90 днів, плюс прив'язані в Region
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
$$;

-- ── План набору (вводять координатори) ────────────────────────────────
-- Кожне збереження — новий рядок: видно, як змінювався план на той самий тиждень.
CREATE TABLE IF NOT EXISTS flow.orders (
  id         BIGSERIAL PRIMARY KEY,
  site_key   TEXT NOT NULL,
  week_start DATE NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  qty        INT  NOT NULL CHECK (qty >= 0 AND qty <= 999),
  entered_by INT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_orders_idx ON flow.orders(site_key, week_start, entered_at DESC);

-- Чинний план = останній введений
CREATE OR REPLACE VIEW flow.v_orders AS
SELECT DISTINCT ON (site_key, week_start) site_key, week_start, qty, entered_by, entered_at
  FROM flow.orders
 ORDER BY site_key, week_start, entered_at DESC, id DESC;

-- ── План виїздів тижня ────────────────────────────────────────────────
-- Що було вписано на тиждень у момент фіксації (пн 00:00). late = зафіксовано пізніше
-- (сервер не працював, або перший тиждень після встановлення).
CREATE TABLE IF NOT EXISTS flow.weeks (
  week_start DATE PRIMARY KEY,
  fixed_at   TIMESTAMPTZ NOT NULL,
  late       BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS flow.week_plan (
  week_start  DATE NOT NULL,
  worker_id   INT  NOT NULL,
  site_key    TEXT NOT NULL,
  hid         INT,
  move_date   DATE,
  is_transfer BOOLEAN,
  PRIMARY KEY (week_start, worker_id, site_key)
);

CREATE OR REPLACE FUNCTION flow.fix_week(p_week DATE, p_late BOOLEAN DEFAULT false)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  IF EXTRACT(ISODOW FROM p_week) <> 1 THEN RAISE EXCEPTION 'week must start on Monday: %', p_week; END IF;
  INSERT INTO flow.weeks (week_start, fixed_at, late) VALUES (p_week, now(), p_late)
  ON CONFLICT (week_start) DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  INSERT INTO flow.week_plan (week_start, worker_id, site_key, hid, move_date, is_transfer)
  SELECT p_week, d.worker_id, d.site_key, d.hid, d.move_date, d.is_transfer
    FROM flow.departures(p_week, p_week + 6) d
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ── Щоденне зведення ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flow.summaries (
  day     DATE PRIMARY KEY,
  made_at TIMESTAMPTZ NOT NULL,
  sent    INT NOT NULL DEFAULT 0,
  failed  INT NOT NULL DEFAULT 0
);
-- Що вже показано. Одна подія — один раз (PK). late = показано пізніше свого дня.
-- corrected_day — коли показали, що подію скасували / перенесли (corrected_to — нова дата).
CREATE TABLE IF NOT EXISTS flow.summary_items (
  kind          TEXT NOT NULL CHECK (kind IN ('out', 'in')),
  worker_id     INT  NOT NULL,
  site_key      TEXT NOT NULL,
  move_date     DATE NOT NULL,
  day           DATE NOT NULL,
  hid           INT,
  status        TEXT,
  late          BOOLEAN NOT NULL DEFAULT false,
  corrected_day DATE,
  corrected_to  DATE,
  PRIMARY KEY (kind, worker_id, site_key, move_date)
);
CREATE INDEX IF NOT EXISTS flow_summary_items_day_idx ON flow.summary_items(day);

-- Задачі планувальника: одна відправка на ключ, навіть після перезапуску pm2
CREATE TABLE IF NOT EXISTS flow.job_runs (
  job TEXT NOT NULL,
  key TEXT NOT NULL,
  at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job, key)
);

-- ── Отримувачі ────────────────────────────────────────────────────────
-- Координатор (Telegram з його картки) або чат за chat_id (група, інша людина).
-- scope: own — об'єкти координатора, region — регіон (region_id; для регіонального
-- без region_id — усі його регіони), all — уся компанія.
CREATE TABLE IF NOT EXISTS flow.recipients (
  id             SERIAL PRIMARY KEY,
  coordinator_id INT REFERENCES public.coordinators(id),
  chat_id        BIGINT,
  label          TEXT,
  scope          TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('own', 'region', 'all')),
  region_id      INT REFERENCES reg.regions(id),
  daily          BOOLEAN NOT NULL DEFAULT true,
  orders         BOOLEAN NOT NULL DEFAULT false,
  weekly         BOOLEAN NOT NULL DEFAULT true,
  lang           TEXT NOT NULL DEFAULT 'uk' CHECK (lang IN ('uk', 'ru', 'pl')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT,
  CHECK (coordinator_id IS NOT NULL OR chat_id IS NOT NULL)
);

-- Групи, куди додали бота (запам'ятовуються автоматично з вебхука)
CREATE TABLE IF NOT EXISTS flow.chats (
  chat_id    BIGINT PRIMARY KEY,
  title      TEXT,
  type       TEXT,
  is_member  BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Індекси для швидкого пошуку виїздів / приїздів за датою
CREATE INDEX IF NOT EXISTS wfh_lwd_idx ON public.worker_facility_history(last_work_date);
CREATE INDEX IF NOT EXISTS wfh_bhp_idx ON public.worker_facility_history(bhp_date);
CREATE INDEX IF NOT EXISTS wfh_worker_idx ON public.worker_facility_history(worker_id);

COMMIT;

-- Перший знімок журналу (baseline): з цього моменту видно, що і коли дописали
SELECT * FROM flow.capture('migration');
