-- ══════════════════════════════════════════════════════════════════════
--  Номер полісу приватного медичного страхування студентів (bot/student_policy.js).
--  Один номер на всіх на місяць; month — перше число місяця, на який поліс. Вводить координатор у боті
--  (STUDENT_POLICY_COORD), історія за всі місяці лишається.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_student_policy.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS wapp;
CREATE TABLE IF NOT EXISTS wapp.student_policy (
  month          DATE PRIMARY KEY,
  number         TEXT NOT NULL,
  coordinator_id INT,
  entered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
