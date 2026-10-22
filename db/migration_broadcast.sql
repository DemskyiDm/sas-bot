-- ══════════════════════════════════════════════════════════════════════
--  Rekrutacja → 📣 Wysyłka wiadomości: розсилка працівникам через бота (api/broadcast.js, public/wysylka.html)
--
--  bc.messages   — одна розсилка: текст (і переклади), кому (audience), хто і коли
--  bc.deliveries — кому саме: по рядку на працівника з Telegram; статус доставки
--                  queued → sent | failed | blocked (заблокував бота) | cancelled
--  Відправляє черга в api/broadcast.js (schedule): переживає перезапуск сервера — недоставлені лишаються queued.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_broadcast.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS bc;

CREATE TABLE IF NOT EXISTS bc.messages (
  id             BIGSERIAL PRIMARY KEY,
  body           TEXT  NOT NULL,                       -- основний текст
  texts          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- переклади { "uk": "...", "ru": "...", "pl": "..." } — за мовою працівника
  audience       JSONB NOT NULL,                       -- { mode, ids, since } — як обрано в панелі
  audience_label TEXT,                                 -- «Pracujący: Notino, CEVA» — для історії
  status         TEXT  NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done', 'cancelled')),
  created_by     INT REFERENCES public.coordinators(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bc.deliveries (
  message_id BIGINT NOT NULL REFERENCES bc.messages(id) ON DELETE CASCADE,
  worker_id  INT    NOT NULL,
  chat_id    BIGINT NOT NULL,
  lang       TEXT,
  status     TEXT   NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'blocked', 'cancelled')),
  error      TEXT,
  sent_at    TIMESTAMPTZ,
  PRIMARY KEY (message_id, worker_id)
);
CREATE INDEX IF NOT EXISTS bc_deliveries_queued_idx ON bc.deliveries(message_id) WHERE status = 'queued';

COMMIT;
