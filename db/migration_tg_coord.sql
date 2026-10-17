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

-- зріз у мініпанелі: own — свої обʼєкти, region — регіон, all — уся фірма (додано в другій версії)
ALTER TABLE tgc.prefs ADD COLUMN IF NOT EXISTS scope TEXT CHECK (scope IN ('own', 'region', 'all'));

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

-- ── «Відправити в офіс» (аванси листом через Microsoft 365) ─────────────────
-- Адресати: coordinator_id NULL — спільні (додає адмін, бачать усі), інакше — свої координатора
CREATE TABLE IF NOT EXISTS tgc.mail_recipients (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL,
  name           TEXT,
  coordinator_id INT REFERENCES public.coordinators(id) ON DELETE CASCADE,
  created_by     INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tgc_mail_recipients_uq ON tgc.mail_recipients (lower(email), COALESCE(coordinator_id, 0));
ALTER TABLE tgc.prefs ADD COLUMN IF NOT EXISTS mail_last TEXT[];   -- кому надсилав минулого разу

-- Надіслані листи і що в них було (status: sent / error — помилка теж записується, для історії)
CREATE TABLE IF NOT EXISTS tgc.office_mails (
  id       SERIAL PRIMARY KEY,
  kind     TEXT NOT NULL DEFAULT 'adv',
  sent_by  INT,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  mail_to  TEXT[] NOT NULL,
  mail_cc  TEXT[],
  subject  TEXT,
  items    INT,
  total    NUMERIC,
  status   TEXT NOT NULL CHECK (status IN ('sent', 'error')),
  error    TEXT
);
CREATE TABLE IF NOT EXISTS tgc.office_items (
  mail_id INT NOT NULL REFERENCES tgc.office_mails(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  ref_id  INT NOT NULL,
  PRIMARY KEY (mail_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS tgc_office_items_ref_idx ON tgc.office_items (kind, ref_id);

COMMIT;

-- Перевірка: хто з координаторів уже має Telegram (кнопка «Panel» зʼявиться в них після перезапуску)
SELECT c.full_name, c.telegram_chat_id IS NOT NULL AS telegram, COALESCE(p.lang, 'uk') AS lang
  FROM public.coordinators c LEFT JOIN tgc.prefs p ON p.coordinator_id = c.id
 WHERE COALESCE(c.is_active, true)
 ORDER BY 2 DESC, 1;
