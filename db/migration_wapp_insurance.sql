-- ══════════════════════════════════════════════════════════════════════
--  Згода на приватне медичне страхування — питання при відправці довідки студента з міні-застосунку
--  (api/wapp.js → POST /docs, обовʼязкове). Відповідь — у листі в офіс («Zgoda na ubezpieczenie») і тут.
--  Для полісу студентів (bot/student_policy.js) рахується остання відповідь: анкета HRappka або довідка — що пізніше.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_wapp_insurance.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE wapp.docs ADD COLUMN IF NOT EXISTS insurance TEXT CHECK (insurance IN ('TAK', 'NIE'));
