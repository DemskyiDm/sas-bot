-- ══════════════════════════════════════════════════════════════════════
--  Поточний період — з HRappka, таблиці — лише для порівняння (bot/hr_import.js, import_sheets.js)
--
--  hrz.sheet_periods — копія рядків таблиць (кожен імпорт таблиць перезаписує рядки свого об'єкта).
--     У worker_facility_history таблиці більше не пишуть: звідти лише порівняння й поділ
--     CAINIAO APT / APT 2, Dipico / Dipico 2, Action… (HRappka їх не розрізняє).
--  worker_facility_history.hr_state — стан HRappka, з якого записано період (NULL — період зі старих таблиць).
--  hrz.history_backup — знімок worker_facility_history перед першим записом з HRappka (один раз).
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_hr_current.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

CREATE SCHEMA IF NOT EXISTS hrz;

ALTER TABLE public.worker_facility_history ADD COLUMN IF NOT EXISTS hr_state TEXT;

DO $$
BEGIN
  IF to_regclass('hrz.history_backup') IS NULL THEN
    CREATE TABLE hrz.history_backup AS SELECT now() AS backup_at, h.* FROM public.worker_facility_history h;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hrz.sheet_periods (
  id             SERIAL PRIMARY KEY,
  facility_id    INT NOT NULL,                       -- об'єкт аркуша
  source_sheet   TEXT,
  passport       TEXT NOT NULL,                      -- як login у workers
  pesel          TEXT,
  full_name      TEXT,
  status         TEXT NOT NULL,                      -- статус таблиці (pracuje, zwolniony…)
  bhp_date       DATE,
  last_work_date DATE,
  stanowisko     TEXT,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrz_sheet_periods_fac_idx ON hrz.sheet_periods(facility_id);
CREATE INDEX IF NOT EXISTS hrz_sheet_periods_pass_idx ON hrz.sheet_periods(passport);

-- перший раз — з того, що таблиці вже записали в історію
INSERT INTO hrz.sheet_periods (facility_id, source_sheet, passport, pesel, full_name, status, bhp_date, last_work_date, stanowisko)
SELECT h.facility_id, h.source_sheet, w.login, w.pesel, w.full_name, h.status::text, h.bhp_date, h.last_work_date, h.stanowisko
  FROM public.worker_facility_history h JOIN public.workers w ON w.id = h.worker_id
 WHERE NOT EXISTS (SELECT 1 FROM hrz.sheet_periods) AND h.hr_state IS NULL AND w.login IS NOT NULL;

COMMIT;
