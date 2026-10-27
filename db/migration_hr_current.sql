-- ══════════════════════════════════════════════════════════════════════
--  Поточний період — з HRappka, таблиці — лише для порівняння (bot/hr_import.js, import_sheets.js)
--
--  hrz.sheet_periods — копія рядків таблиць (кожен імпорт таблиць перезаписує рядки свого об'єкта).
--     У worker_facility_history таблиці більше не пишуть: звідти лише порівняння й поділ
--     CAINIAO APT / APT 2, Dipico / Dipico 2, Action… (HRappka їх не розрізняє).
--  worker_facility_history.hr_state — стан HRappka, з якого записано період (NULL — період зі старих таблиць).
--  hrz.history_backup — знімок worker_facility_history перед першим записом з HRappka (один раз).
--  hrz.people_applied — HRappka, уже записана в базу (від неї рахуються зміни); hrz.runs — час останнього імпорту.
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

-- hrz.people_applied — HRappka, яку вже записали в базу: зміни рахуються від неї, а не від останнього знімка,
-- тож зміна, яку не вдалося записати (невідомий об'єкт, помилка), пробується знову при наступному імпорті
CREATE TABLE IF NOT EXISTS hrz.people_applied (LIKE hrz.people INCLUDING ALL);
INSERT INTO hrz.people_applied SELECT * FROM hrz.people WHERE NOT EXISTS (SELECT 1 FROM hrz.people_applied);

-- коли востаннє завершився імпорт: sheets — таблиці (на момент початку), hrappka — знімок HRappka
CREATE TABLE IF NOT EXISTS hrz.runs (
  kind TEXT PRIMARY KEY,
  at   TIMESTAMPTZ NOT NULL
);
INSERT INTO hrz.runs (kind, at) SELECT 'sheets', max(seen_at) FROM hrz.sheet_periods HAVING max(seen_at) IS NOT NULL ON CONFLICT (kind) DO NOTHING;
INSERT INTO hrz.runs (kind, at) SELECT 'hrappka', max(seen_at) FROM hrz.people HAVING max(seen_at) IS NOT NULL ON CONFLICT (kind) DO NOTHING;

-- перший раз — з того, що таблиці вже записали в історію
INSERT INTO hrz.sheet_periods (facility_id, source_sheet, passport, pesel, full_name, status, bhp_date, last_work_date, stanowisko)
SELECT h.facility_id, h.source_sheet, w.login, w.pesel, w.full_name, h.status::text, h.bhp_date, h.last_work_date, h.stanowisko
  FROM public.worker_facility_history h JOIN public.workers w ON w.id = h.worker_id
 WHERE NOT EXISTS (SELECT 1 FROM hrz.sheet_periods) AND h.hr_state IS NULL AND w.login IS NOT NULL;

COMMIT;
