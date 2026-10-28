-- ══════════════════════════════════════════════════════════════════════
--  Статус do_zatrudnienia — стан HRappka «Do zatrudnienia (=Harmonogram)» (bot/hr_import.js): людина в графіку, ще не працює.
--  Як працюючий ніде не рахується; у Wyjazdy й Opieka — як «bez statusu» (приїзд ще не підтверджено).
--  Хто в цьому стані понад 30 днів — лист щопонеділка о 5:00. Відлік — менша з дат: остання зміна картки в HRappka
--  (lastUpdateTimeSystem; але HRappka щоночі сама оновлює більшість карток) і коли імпорт уперше побачив людину в цьому стані
--  (hrz.state_since — для всіх станів; хто вже був у стані до появи таблиці — від першого імпорту).
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_do_zatrudnienia.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
ALTER TYPE public.worker_status ADD VALUE IF NOT EXISTS 'do_zatrudnienia';

CREATE TABLE IF NOT EXISTS hrz.state_since (
  hr_employee_id BIGINT PRIMARY KEY,
  state          TEXT NOT NULL,
  since          DATE NOT NULL          -- з якого дня імпорт бачить людину в цьому стані
);
