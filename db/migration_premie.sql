-- ══════════════════════════════════════════════════════════════════════
--  Premie koordynatorów — премія координаторам: блок А (доживання) + блок Б (ядро)
--  (можна повторно)
--
--  Модель — як у Excel «Model_premiowy_prog80_v4» (kpi/10):
--   • блок А: пороги стажу 30 / 80 днів з вагами 1 / 3, що випали на місяць; зараховано, якщо людина
--     того дня ще працює. Виконання = набрані ваги ÷ можливі → шкала → % від ліміту блоку А;
--   • блок Б: частка людей зі стажем ≥ 80 днів серед тих, хто працює на кінець місяця → шкала → % від ліміту Б;
--   • премія = MIN(А + Б, максимум); обидва блоки × k-t координатора;
--   • не рахуються статуси rezygnacja / przeniesiony / unknown / do_zatrudnienia і звільнення з причинами
--     зі списку (Редукция, Лимит 18 месяцев, Переход напрямую); стаж після переведення — з дати переведення.
--  Логіка — bot/premie.js, API — api/premie.js, сторінка — public/premie.html. Опис — docs/PREMIE.md.
--
--  prm.params       — параметри моделі; діють з місяця valid_from до наступного набору
--  prm.month_coords — учасники місяця: основа розрахунку (свої об'єкти / регіон / «як у X») і k-t;
--                     місяць без власного списку успадковує останній попередній
--  prm.exclusions   — ручні виключення працівників: на місяць або назавжди (month IS NULL)
--  prm.access       — доступ координаторів і регіональних (адмін і head — завжди повний)
--  prm.runs         — затверджені місяці: знімок параметрів і повного розрахунку
--  prm.log          — журнал змін
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

CREATE SCHEMA IF NOT EXISTS prm;

CREATE TABLE IF NOT EXISTS prm.params (
  valid_from TEXT PRIMARY KEY CHECK (valid_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);

CREATE TABLE IF NOT EXISTS prm.month_coords (
  month          TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  coordinator_id INT  NOT NULL REFERENCES public.coordinators(id) ON DELETE CASCADE,
  basis          TEXT NOT NULL DEFAULT 'own' CHECK (basis IN ('own', 'region', 'as')),
  as_id          INT REFERENCES public.coordinators(id) ON DELETE SET NULL,   -- basis = 'as': чий результат бере
  kt             NUMERIC(4,2) NOT NULL DEFAULT 1 CHECK (kt >= 0 AND kt <= 2),
  note           TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INT,
  PRIMARY KEY (month, coordinator_id)
);

CREATE TABLE IF NOT EXISTS prm.exclusions (
  id         SERIAL PRIMARY KEY,
  worker_id  INT NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  month      TEXT CHECK (month IS NULL OR month ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- NULL — назавжди
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INT,
  removed_at TIMESTAMPTZ,
  removed_by INT
);
CREATE INDEX IF NOT EXISTS prm_exclusions_worker_idx ON prm.exclusions(worker_id) WHERE removed_at IS NULL;

-- own — своя премія; people — + люди (хто зарахований і чому ні); excl — + виключення працівників
CREATE TABLE IF NOT EXISTS prm.access (
  coordinator_id INT PRIMARY KEY REFERENCES public.coordinators(id) ON DELETE CASCADE,
  level          TEXT NOT NULL CHECK (level IN ('own', 'people', 'excl')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INT
);

CREATE TABLE IF NOT EXISTS prm.runs (
  month       TEXT PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status      TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'paid')),
  result      JSONB NOT NULL,                 -- розрахунок на момент затвердження (параметри, учасники, об'єкти, люди)
  total       NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by INT,
  paid_at     TIMESTAMPTZ,
  paid_by     INT,
  notified_at TIMESTAMPTZ,                    -- коли учасникам надіслано результат у Telegram
  notified_n  INT
);

CREATE TABLE IF NOT EXISTS prm.log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_id   INT,
  action  TEXT NOT NULL,
  month   TEXT,
  details JSONB
);
CREATE INDEX IF NOT EXISTS prm_log_at_idx ON prm.log(at DESC);

CREATE TABLE IF NOT EXISTS prm.settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO prm.settings (key, value) VALUES
  ('notify_tg', '0')              -- після затвердження надіслати кожному учаснику його премію в Telegram
ON CONFLICT (key) DO NOTHING;

-- Параметри з Excel (вересень 2026). Бонуси «понад ліміт» (250 / 200) у модель не входять.
INSERT INTO prm.params (valid_from, data) VALUES ('2026-09', '{
  "base_rate": 6500,
  "max_bonus": 2500,
  "limit_a": 1600,
  "limit_b": 900,
  "thresholds": [{"days": 30, "weight": 1}, {"days": 80, "weight": 3}],
  "scale_a": [{"from": 0.95, "pct": 1}, {"from": 0.87, "pct": 0.8}, {"from": 0.8, "pct": 0.6}, {"from": 0.6, "pct": 0.4}],
  "core_days": 80,
  "scale_b": [{"from": 0.8, "pct": 1}, {"from": 0.7, "pct": 0.9}, {"from": 0.6, "pct": 0.85}, {"from": 0.55, "pct": 0.7}, {"from": 0.4, "pct": 0.2}],
  "penalty": {"enabled": false, "amount": -50, "from_days": 8, "to_days": 15},
  "exit_status": "zwolniony",
  "excluded_statuses": ["rezygnacja", "przeniesiony", "unknown", "do_zatrudnienia"],
  "ignored_reasons": ["Редукция", "Лимит 18 месяцев", "Переход напрямую"]
}'::jsonb)
ON CONFLICT (valid_from) DO NOTHING;

-- Учасники місяця і k-t задаються в панелі (👥 Koordynatorzy); місяць без списку успадковує попередній.
