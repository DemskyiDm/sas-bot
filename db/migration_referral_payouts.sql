-- ══════════════════════════════════════════════════════════════════════
--  «Poleć znajomego» — нарахування премій за місяць
--  (можна повторно)
--
--  Правила (bot/referral_pay.js):
--   • привів працівник: йому 400 зл, коли новий пропрацював 30 днів, і 200 зл — 60 днів;
--     координатору того, хто привів, — по 100 зл за кожен із цих місяців;
--   • привів координатор: йому 200 зл за перші 30 днів, за другий місяць — нічого;
--   • дні календарні від BHP включно, перерва ≤ 14 днів і переведення стаж не переривають;
--   • 4-го числа (авто або кнопкою) — список місяця: усі, у кого 30-й / 60-й день
--     до останнього дня попереднього місяця включно і ще не нарахований
--     (зіставлення підтвердили пізніше — потрапляє в наступний список);
--   • нараховане зафіксоване: заднім числом не змінюється.
-- ══════════════════════════════════════════════════════════════════════

-- Запуски: один на місяць (period = 'YYYY-MM' — місяць списку, стан на 1-ше число)
CREATE TABLE IF NOT EXISTS ref.payout_runs (
  period    TEXT PRIMARY KEY CHECK (period ~ '^\d{4}-\d{2}$'),
  cutoff    DATE NOT NULL,                -- останній день попереднього місяця
  run_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_by    INT,                          -- NULL — автоматично
  n         INT NOT NULL DEFAULT 0
);

-- Премії: один рядок = один новий працівник × один етап (1 / 2 виплата)
CREATE TABLE IF NOT EXISTS ref.payouts (
  id                 SERIAL PRIMARY KEY,
  period             TEXT NOT NULL REFERENCES ref.payout_runs(period),
  answer_id          INT  NOT NULL REFERENCES ref.answers(id),
  stage              INT  NOT NULL CHECK (stage IN (1, 2)),
  kind               TEXT NOT NULL CHECK (kind IN ('friend', 'coord')),   -- хто привів
  due_date           DATE NOT NULL,           -- 30-й / 60-й день
  -- новий працівник (знімок)
  worker_id          INT  NOT NULL,
  worker_name        TEXT,
  worker_site        TEXT,
  bhp_date           DATE NOT NULL,
  -- хто привів (працівник) — знімок
  referrer_worker_id INT,
  referrer_name      TEXT,
  referrer_site      TEXT,
  -- координатор, що отримує премію (координатор полецаючого або сам полецаючий-координатор)
  coordinator_id     INT,
  coordinator_name   TEXT,
  region_name        TEXT,
  worker_amount      NUMERIC(10,2),           -- премія працівнику, що привів
  coord_amount       NUMERIC(10,2),           -- премія координатору
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (answer_id, stage)
);
CREATE INDEX IF NOT EXISTS ref_payouts_period_idx ON ref.payouts(period);

INSERT INTO ref.settings (key, value) VALUES
  ('pay_friend_1', '400'),        -- працівнику: перші 30 днів
  ('pay_friend_2', '200'),        -- працівнику: 60 днів
  ('pay_coord_month', '100'),     -- координатору того, хто привів: за кожен місяць
  ('pay_coord_ref', '200'),       -- координатору, який привів сам: перші 30 днів
  ('pay_day', '4'),               -- якого числа нараховувати автоматично
  ('pay_from', '2026-10-01')      -- 30-й / 60-й день не раніше цієї дати (перший список — 11.2026)
ON CONFLICT (key) DO NOTHING;
