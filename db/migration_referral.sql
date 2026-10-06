-- ══════════════════════════════════════════════════════════════════════
--  Розділ «Poleć znajomego» (Приведи друга)
--  Новий працівник у боті відповідає, хто його привів: друг-працівник,
--  координатор, рекрутація або інше. Для друга / координатора вписує ім'я.
--  Панель: зіставлення з базою, рейтинг, джерела, бонус, Excel.
--  Захист: історія Telegram-ID входів працівника; з Telegram координатора
--  відповідь не приймається.
--  Повторний запуск безпечний.
-- ══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS ref;

CREATE OR REPLACE FUNCTION ref.today() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Europe/Warsaw')::date
$$;

-- ── Налаштування ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ref.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);
INSERT INTO ref.settings (key, value) VALUES
  ('enabled',        '1'),      -- бот питає нових
  ('visible_coords', '0'),      -- координатори бачать розділ (свої об'єкти, лише перегляд)
  ('window_days',    '5'),      -- відповісти можна до BHP + N днів включно
  ('remind_max',     '3'),      -- нагадувань (по одному на день)
  ('remind_time',    '10:00'),  -- з якої години йдуть нагадування (перше питання — одразу при вході в бот)
  ('bonus_days',     '30'),     -- бонус за друга: новий пропрацював N днів
  ('bonus_amount',   ''),       -- сума бонусу, зл (для Excel), порожньо — не показувати
  ('start_date',     to_char((now() AT TIME ZONE 'Europe/Warsaw')::date - 5, 'YYYY-MM-DD'))  -- з якої дати BHP питаємо (за замовч. 5 днів до встановлення)
ON CONFLICT (key) DO NOTHING;

-- ── Нові працевлаштування ─────────────────────────────────────────────
-- Новий = період без rezygnacja, без TEST, і перед ним немає періоду цієї
-- людини, що закінчився менше ніж за 14 днів (переведення, продовження).
CREATE OR REPLACE VIEW ref.v_hires AS
SELECT DISTINCT ON (h.worker_id, h.bhp_date)
       h.worker_id, h.facility_id, h.bhp_date, h.status::text AS status,
       f.name AS facility_name,
       COALESCE(NULLIF(btrim(f.group_name), ''), btrim(f.name)) AS site_key
  FROM public.worker_facility_history h
  JOIN public.workers w    ON w.id = h.worker_id
  JOIN public.facilities f ON f.id = h.facility_id
 WHERE h.bhp_date IS NOT NULL
   AND h.status::text <> 'rezygnacja'
   AND w.login NOT LIKE 'TEST_%'
   AND (h.last_work_date IS NULL OR h.last_work_date >= h.bhp_date)
   AND NOT EXISTS (
         SELECT 1 FROM public.worker_facility_history p
          WHERE p.worker_id = h.worker_id AND p.id <> h.id
            AND p.status::text <> 'rezygnacja'
            AND p.bhp_date < h.bhp_date
            AND (p.last_work_date IS NULL OR p.last_work_date >= h.bhp_date - 14))
 ORDER BY h.worker_id, h.bhp_date, h.imported_at DESC NULLS LAST, h.id DESC;

-- ── Відповіді ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ref.answers (
  id               SERIAL PRIMARY KEY,
  worker_id        INT  NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  bhp_date         DATE NOT NULL,
  facility_id      INT  REFERENCES public.facilities(id) ON DELETE SET NULL,
  -- sent → (await_name) → answered | expired
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','answered','expired')),
  source           TEXT CHECK (source IN ('friend','coord','recruit','other')),
  referrer_text    TEXT,            -- ім'я, як вписав працівник
  answered_at      TIMESTAMPTZ,
  answered_chat_id BIGINT,
  answered_tg_user BIGINT,
  manual_by        INT,             -- внесено в панелі адміністратором
  -- хто чекає на текст (ім'я)
  await_name       BOOLEAN NOT NULL DEFAULT false,
  sent_chat_id     BIGINT,
  lang             TEXT,
  first_sent_at    TIMESTAMPTZ,
  last_sent_at     TIMESTAMPTZ,
  sends            INT NOT NULL DEFAULT 0,      -- 1 перше + нагадування
  blocked_attempts INT NOT NULL DEFAULT 0,      -- спроби з Telegram координатора
  -- зіставлення
  match_state      TEXT NOT NULL DEFAULT 'none' CHECK (match_state IN ('none','confirmed','not_found')),
  match_worker_id  INT REFERENCES public.workers(id) ON DELETE SET NULL,
  match_coordinator_id INT REFERENCES public.coordinators(id) ON DELETE SET NULL,
  match_by         INT,
  match_at         TIMESTAMPTZ,
  -- бонус
  bonus_paid_at    DATE,
  bonus_paid_by    INT,
  bonus_note       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, bhp_date)
);
-- v2: окремий лічильник нагадувань, вибір «друг/координатор» до вписання імені
--     не стирає попередню відповідь, остання спроба надсилання (раз на день)
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS pending_source TEXT CHECK (pending_source IN ('friend','coord'));
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS reminders      INT NOT NULL DEFAULT 0;
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS last_try_at    TIMESTAMPTZ;
-- v3: пілот анкети на старті — канали «як дізналися» (див. migration_start_survey.sql)
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS ext BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ref.answers DROP CONSTRAINT IF EXISTS answers_source_check;
ALTER TABLE ref.answers ADD CONSTRAINT answers_source_check
  CHECK (source IN ('friend','coord','recruit','other','facebook','instagram','tiktok','telegram','jobsite'));
INSERT INTO ref.settings (key, value) VALUES ('start_sites', ''), ('start_remind_days', '2') ON CONFLICT (key) DO NOTHING;
-- v4: обов'язкове питання всім новим «На скільки ви приїхали?» (після «хто привів»)
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS stay_plan TEXT CHECK (stay_plan IN ('m1','m2','m3','m6','more'));
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS stay_at   TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ref_answers_bhp_idx   ON ref.answers(bhp_date);
CREATE INDEX IF NOT EXISTS ref_answers_await_idx ON ref.answers(sent_chat_id) WHERE await_name;
CREATE INDEX IF NOT EXISTS ref_answers_match_idx ON ref.answers(match_worker_id);

-- Імпорт табеля може виправити дату BHP відкритого періоду. Тоді відповідь
-- переноситься на нову дату (та сама людина, різниця ≤ 14 днів, старої дати
-- в графіку вже немає). Викликає бот: при вході і кожні 5 хвилин.
CREATE OR REPLACE FUNCTION ref.relink() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  WITH cand AS (
    SELECT DISTINCT ON (a.id) a.id, h.bhp_date, h.facility_id
      FROM ref.answers a
      JOIN ref.v_hires h ON h.worker_id = a.worker_id
                        AND h.bhp_date <> a.bhp_date
                        AND abs(h.bhp_date - a.bhp_date) <= 14
     WHERE NOT EXISTS (SELECT 1 FROM ref.v_hires x WHERE x.worker_id = a.worker_id AND x.bhp_date = a.bhp_date)
       AND NOT EXISTS (SELECT 1 FROM ref.answers b WHERE b.worker_id = a.worker_id AND b.bhp_date = h.bhp_date)
     ORDER BY a.id, abs(h.bhp_date - a.bhp_date))
  UPDATE ref.answers a SET bhp_date = c.bhp_date, facility_id = c.facility_id, updated_at = now()
    FROM cand c WHERE c.id = a.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ── Історія Telegram-ID ───────────────────────────────────────────────
-- event: login — увійшов у бот під ID працівника;
--        answer — відповів на анкету;
--        blocked — спроба відповісти з Telegram координатора.
CREATE TABLE IF NOT EXISTS ref.tg_log (
  id            BIGSERIAL PRIMARY KEY,
  worker_id     INT NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  chat_id       BIGINT NOT NULL,
  tg_user_id    BIGINT,
  tg_username   TEXT,
  tg_name       TEXT,
  event         TEXT NOT NULL CHECK (event IN ('login','answer','blocked')),
  coordinator_id INT,               -- якщо chat належить координатору
  answer_id     INT REFERENCES ref.answers(id) ON DELETE SET NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ref_tg_log_worker_idx ON ref.tg_log(worker_id, at);
CREATE INDEX IF NOT EXISTS ref_tg_log_chat_idx   ON ref.tg_log(chat_id);

-- Унікальні Telegram-ID працівника: коли вперше / востаннє, скільки разів
CREATE OR REPLACE VIEW ref.v_tg_ids AS
SELECT worker_id, chat_id,
       max(tg_user_id) AS tg_user_id, max(tg_username) AS tg_username, max(tg_name) AS tg_name,
       min(at) AS first_at, max(at) AS last_at,
       count(*) FILTER (WHERE event = 'login')   AS logins,
       count(*) FILTER (WHERE event = 'blocked') AS blocked,
       max(coordinator_id) AS coordinator_id
  FROM ref.tg_log
 GROUP BY worker_id, chat_id;

-- Telegram, з якого входили під кількома працівниками
CREATE OR REPLACE VIEW ref.v_shared_chats AS
SELECT chat_id, count(DISTINCT worker_id) AS workers, max(at) AS last_at,
       max(coordinator_id) AS coordinator_id
  FROM ref.tg_log
 GROUP BY chat_id
HAVING count(DISTINCT worker_id) > 1;
