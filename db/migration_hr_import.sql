-- ══════════════════════════════════════════════════════════════════════
--  Імпорт людей з HRappka (bot/hr_import.js)
--
--  Дані людей — з HRappka, поділ на об'єкти / періоди (BHP) — як і раніше з таблиць.
--  hrz.people        — щоденний знімок усіх працівників HRappka (усі статуси).
--  workers.birth_date — дата народження з HRappka (birthDate).
--  workers.hr_employee_id — картка HRappka цієї людини. workers.pesel теж з HRappka (імпорт таблиць його більше не пише).
--
--  last_day — «Ostatni dzień pracy» (attrdef_id_58419): одне значення на людину, не на договір.
--  Після повернення там лишається старий день, тому до поточного періоду воно належить, лише якщо >= BHP.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_hr_import.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS hr_employee_id BIGINT;
CREATE INDEX IF NOT EXISTS workers_hr_employee_id_idx ON public.workers(hr_employee_id);

CREATE SCHEMA IF NOT EXISTS hrz;

CREATE TABLE IF NOT EXISTS hrz.people (
  hr_employee_id BIGINT PRIMARY KEY,                 -- id працівника в HRappka
  name           TEXT,                               -- «NAZWISKO IMIĘ»
  passport       TEXT,                               -- лише літери й цифри, великими
  pesel          TEXT,
  birth_date     DATE,
  citizenship    TEXT,
  state          TEXT,                               -- статус HRappka як є (Pracuje, Dotarł, Zwolniony…)
  last_day       DATE,                               -- attrdef_id_58419
  department     TEXT,                               -- відділ найновішого договору
  firm           TEXT,                               -- фірма найновішого договору (SAS LOGISTIC, APT EAST STAFF…)
  position       TEXT,                               -- посада найновішого договору (pl)
  contract_start DATE,
  contract_end   DATE,                               -- дата розірвання / скасування (не останній день роботи)
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrz_people_passport_idx ON hrz.people(passport);
CREATE INDEX IF NOT EXISTS hrz_people_pesel_idx ON hrz.people(pesel);

COMMIT;
