-- ══════════════════════════════════════════════════════════════════════
--  ⚠️ Kary / штрафи (bot/fines.js, api/tg.js, public/js/fines.js, мініпанель public/tg/)
--
--  fin.types — типи штрафів: назва PL (лист / Excel / панель), UK і RU (мініпанель, повідомлення працівнику),
--              сума за замовчуванням (NULL — вписати вручну), порядок, активний. Змінює адмін / head (панель → Kary → Typy kar).
--  fin.fines — виписані штрафи. type_name / amount — знімок на момент виписки (зміна типу старих не чіпає).
--              Скасований — cancelled_at (рядок лишається для історії).
--  Надіслане в офіс — tgc.office_items (kind 'fin'), як аванси й медогляд; адресати — tgc.mail_recipients (kind 'fin').
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_fines.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS fin;

CREATE TABLE IF NOT EXISTS fin.types (
  id         SERIAL PRIMARY KEY,
  name_pl    TEXT NOT NULL,
  name_uk    TEXT,
  name_ru    TEXT,
  amount     NUMERIC(10, 2) CHECK (amount IS NULL OR amount > 0),
  sort       INT  NOT NULL DEFAULT 100,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  updated_by INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Початковий список — лише в порожню таблицю (повторний запуск не дублює і не перезаписує зміни адміна)
INSERT INTO fin.types (name_pl, name_uk, name_ru, amount, sort)
SELECT * FROM (VALUES
  ('Absencja',                                  'Прогул',                                'Прогул',                         500::numeric, 10),
  ('Zerwanie umowy bez okresu wypowiedzenia',   'Розірвання договору без відпрацювання', 'Разрыв договора без отработки', 1500,         20),
  ('Alkohol',                                   'Алкоголь',                              'Алкоголь',                       500,          30),
  ('Naprawa mieszkania',                        'Ремонт житла',                          'Ремонт жилья',                   NULL,         40),
  ('Sprzątanie mieszkania',                     'Прибирання житла',                      'Уборка жилья',                   220,          50),
  ('Bonifikata za mieszkanie',                  'Bonifikata za mieszkanie',              'Bonifikata za mieszkanie',       900,          60),
  ('Za kartę',                                  'За карту',                              'За карту',                       1000,         70),
  ('Szkolenie UDT',                             'Навчання UDT',                          'Обучение UDT',                   2000,         80),
  ('RCP',                                       'RCP',                                   'RCP',                            50,           90)
) AS v(name_pl, name_uk, name_ru, amount, sort)
WHERE NOT EXISTS (SELECT 1 FROM fin.types);

CREATE TABLE IF NOT EXISTS fin.fines (
  id            BIGSERIAL PRIMARY KEY,
  worker_id     INT NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  facility_id   INT REFERENCES public.facilities(id) ON DELETE SET NULL,   -- де працював у момент виписки
  type_id       INT REFERENCES fin.types(id) ON DELETE SET NULL,
  type_name     TEXT NOT NULL,                                            -- назва PL на момент виписки
  amount        NUMERIC(10, 2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
  fine_date     DATE NOT NULL,
  note          TEXT,
  created_by    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    INT,
  updated_at    TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  cancelled_by  INT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS fin_fines_worker_idx   ON fin.fines(worker_id);
CREATE INDEX IF NOT EXISTS fin_fines_date_idx     ON fin.fines(fine_date);
CREATE INDEX IF NOT EXISTS fin_fines_facility_idx ON fin.fines(facility_id);

-- кому надсилав штрафи минулого разу (як mail_last / mail_last_med)
ALTER TABLE tgc.prefs ADD COLUMN IF NOT EXISTS mail_last_fin TEXT[];

COMMIT;
