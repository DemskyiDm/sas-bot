-- ══════════════════════════════════════════════════════════════════════
--  Wyjazdy / przyjazdy: форма відправки (текст або картинка) і темп набору.
--  Можна запускати повторно.
-- ══════════════════════════════════════════════════════════════════════

-- Форма для кожного отримувача: text — повідомлення як раніше, image — картинка-таблиця
ALTER TABLE flow.recipients ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'text';
DO $$
BEGIN
  ALTER TABLE flow.recipients ADD CONSTRAINT recipients_format_chk CHECK (format IN ('text', 'image'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO flow.settings (key, value, note) VALUES
  ('coord_format', 'text',
   'Форма зведення для координаторів, які отримують його автоматично: text = повідомлення, image = картинка-таблиця'),
  ('pace', '20,40,60,80,100',
   'Темп набору: скільки % плану тижня має бути набрано до кінця пн, вт, ср, чт, пт (сб і нд — 100%). Менше — обʼєкт червоний')
ON CONFLICT (key) DO NOTHING;
