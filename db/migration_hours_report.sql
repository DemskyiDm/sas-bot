-- ══════════════════════════════════════════════════════════════════════
--  Звіт координаторам «хто не заповнив години» (раніше — жорстко о 17:00 в index.js).
--  Налаштування в панелі: Raport godzin. Схема hrep, public не змінюється.
--  Можна запускати повторно.
-- ══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS hrep;

CREATE TABLE IF NOT EXISTS hrep.settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);
INSERT INTO hrep.settings (key, value, note) VALUES
  ('enabled',       '1',             '1 = звіт надсилається'),
  ('time',          '17:00',         'Час звіту (польський час)'),
  ('days',          '1,2,3,4,5,6,7', 'Дні: 1 = пн … 7 = нд'),
  ('yesterday_msg', '1',             '1 = повідомлення «хто не заповнив учора»'),
  ('month_msg',     '1',             '1 = повідомлення «пропуски з початку місяця» (до вчора, без сьогодні)')
ON CONFLICT (key) DO NOTHING;

-- Винятки й зміна охоплення для конкретного координатора. Немає рядка — за замовчуванням:
-- надсилати; роль head — уся фірма, інші — свої обʼєкти (coordinator_facilities), як було.
CREATE TABLE IF NOT EXISTS hrep.recipients (
  coordinator_id INT PRIMARY KEY REFERENCES public.coordinators(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  scope          TEXT CHECK (scope IN ('own', 'region', 'all')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INT
);

-- Один звіт на день: перезапуск pm2 не надсилає вдруге
CREATE TABLE IF NOT EXISTS hrep.runs (
  day         DATE PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sent        INT,
  failed      INT,
  skipped     INT
);
