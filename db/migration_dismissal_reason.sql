-- ══════════════════════════════════════════════════════════════════════
--  Причина звільнення з HRappka (bot/hr_reason.js)
--
--  У HRappka причина («Przyczyna zwolnienia 2.0», attrdef_id_75731) — одна на працівника, не на договір:
--  при поверненні / переведенні вона лишається старою або затирається, історії значень HRappka не віддає.
--  Тому щодня знімаємо всіх працівників HRappka і записуємо, КОЛИ причина змінилася (hrz.reason_log),
--  а причину кладемо в рядок періоду history — вона належить періоду, якщо змінилася після його BHP
--  і не пізніше 10 днів після останнього дня (і до старту наступного періоду).
--
--  worker_facility_history:
--    przyczyna_zwolnienia — текст з HRappka або «przeniesienie» (статус przeniesiony);
--    przyczyna_zrodlo     — hrappka | auto;
--    przyczyna_at         — коли записали; перше значення не перезаписуємо (крім auto, якщо статус виправили на zwolniony);
--    przyczyna_problem    — чому не вдалося (not_found / next_period / stale / empty) — для звіту в Telegram.
--  hrz.employees  — останній знімок HRappka (id, паспорт, PESEL, статус, причина).
--  hrz.reason_log — зміни причини: baseline = значення з першого знімка (невідомо, коли внесене).
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_dismissal_reason.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE public.worker_facility_history ADD COLUMN IF NOT EXISTS przyczyna_zwolnienia TEXT;
ALTER TABLE public.worker_facility_history ADD COLUMN IF NOT EXISTS przyczyna_zrodlo TEXT;
ALTER TABLE public.worker_facility_history ADD COLUMN IF NOT EXISTS przyczyna_at TIMESTAMPTZ;
ALTER TABLE public.worker_facility_history ADD COLUMN IF NOT EXISTS przyczyna_problem TEXT;

CREATE SCHEMA IF NOT EXISTS hrz;

CREATE TABLE IF NOT EXISTS hrz.employees (
  hr_employee_id BIGINT PRIMARY KEY,                 -- id працівника в HRappka
  passport       TEXT,                               -- без пробілів, великими
  pesel          TEXT,
  state          TEXT,
  reason         TEXT,
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrz_employees_passport_idx ON hrz.employees(passport);
CREATE INDEX IF NOT EXISTS hrz_employees_pesel_idx ON hrz.employees(pesel);

CREATE TABLE IF NOT EXISTS hrz.reason_log (
  id             BIGSERIAL PRIMARY KEY,
  hr_employee_id BIGINT NOT NULL,
  reason         TEXT,                               -- NULL — причину стерли
  baseline       BOOLEAN NOT NULL DEFAULT false,     -- з першого знімка: коли внесли — невідомо
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrz_reason_log_emp_idx ON hrz.reason_log(hr_employee_id, seen_at);

COMMIT;
