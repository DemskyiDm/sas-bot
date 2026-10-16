-- ══════════════════════════════════════════════════════════════════════
--  Telegram для координаторів: мініпанель (кнопка «Panel» у боті), вхід без пароля,
--  ранкова зведення, рішення по авансах і вихідних кнопками, план набору, пошук картки.
--  Код: bot/coord.js, api/tg.js, public/tg/.
--  Можна запускати повторно.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS tgc;

-- Одноразові коди привʼязки Telegram до акаунта координатора (панель → «Telegram» → посилання на бота)
CREATE TABLE IF NOT EXISTS tgc.link_codes (
  code           TEXT PRIMARY KEY,
  coordinator_id INT  NOT NULL REFERENCES public.coordinators(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at        TIMESTAMPTZ,
  chat_id        BIGINT
);

-- Налаштування координатора в Telegram
CREATE TABLE IF NOT EXISTS tgc.prefs (
  coordinator_id INT PRIMARY KEY REFERENCES public.coordinators(id) ON DELETE CASCADE,
  lang           TEXT NOT NULL DEFAULT 'uk' CHECK (lang IN ('uk', 'ru')),
  digest         BOOLEAN NOT NULL DEFAULT true,   -- ранкова зведення
  notify         BOOLEAN NOT NULL DEFAULT true,   -- нові заявки на аванс і вихідні з кнопками
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Надіслані повідомлення із заявками: щоб після рішення (у боті чи в панелі) оновити їх у всіх координаторів
CREATE TABLE IF NOT EXISTS tgc.msgs (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT   NOT NULL CHECK (kind IN ('adv', 'dof')),
  ref_id     INT    NOT NULL,
  chat_id    BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tgc_msgs_ref_idx ON tgc.msgs (kind, ref_id);

-- Короткий стан діалогу (план набору: який обʼєкт зараз питаємо; пакет заявок «схвалити всі»)
CREATE TABLE IF NOT EXISTS tgc.state (
  chat_id    BIGINT PRIMARY KEY,
  data       JSONB  NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Розсилки «один раз»: ранкова зведення на день, щоб перезапуск pm2 не дублював
CREATE TABLE IF NOT EXISTS tgc.job_runs (
  job TEXT NOT NULL,
  key TEXT NOT NULL,
  at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job, key)
);

COMMIT;

-- Перевірка: хто з координаторів уже має Telegram (кнопка «Panel» зʼявиться в них після перезапуску)
SELECT c.full_name, c.telegram_chat_id IS NOT NULL AS telegram, COALESCE(p.lang, 'uk') AS lang
  FROM public.coordinators c LEFT JOIN tgc.prefs p ON p.coordinator_id = c.id
 WHERE COALESCE(c.is_active, true)
 ORDER BY 2 DESC, 1;
