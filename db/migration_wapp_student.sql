-- ══════════════════════════════════════════════════════════════════════
--  Статус студента з HRappka (bot/student.js → syncHr, викликає bot/hr_import.js після кожного імпорту).
--  «Student od» (attrdef_id_61654) і «Student do» (attrdef_id_61655) → wapp.student.valid_from / valid_until.
--  hr_from / hr_until — що востаннє бачили в HRappka: дати міняємо, лише коли змінились саме там,
--  тож довідка, надіслана з міні-застосунку (status = sent), не губиться до перевірки в офісі.
--  reminded_at — коли востаннє нагадали «донесіть нову довідку» (щотижня за 45 днів до кінця).
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_wapp_student.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE wapp.student ADD COLUMN IF NOT EXISTS valid_from  DATE;
ALTER TABLE wapp.student ADD COLUMN IF NOT EXISTS hr_from     DATE;
ALTER TABLE wapp.student ADD COLUMN IF NOT EXISTS hr_until    DATE;
ALTER TABLE wapp.student ADD COLUMN IF NOT EXISTS reminded_at DATE;
