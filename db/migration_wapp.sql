-- ══════════════════════════════════════════════════════════════════════
--  Міні-застосунок працівника в Telegram (public/tgw/, api/wapp.js, bot/student.js)
--
--  wapp.docs    — документи, які працівник надіслав в офіс: довідка студента, паспорт, карта побиту, інше.
--                 Одна відправка = один PDF (фото сторінок збираються в PDF на сервері, bot/pdf.js).
--                 Файл — uploads/worker_docs/<login>/… (не в репозиторії). mailed_* — лист в офіс (WORKER_DOCS_EMAIL).
--  wapp.student — статус студента: один рядок на працівника. source: app (довідка з міні-застосунку),
--                 hrappka (пізніше — синхронізація), panel. reminded_for / expired_for — щоб нагадування
--                 «довідка закінчується / закінчилась» ішло один раз на кожну дату.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_wapp.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

CREATE SCHEMA IF NOT EXISTS wapp;

CREATE TABLE IF NOT EXISTS wapp.docs (
  id           SERIAL PRIMARY KEY,
  worker_id    INTEGER NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  kinds        TEXT[] NOT NULL,                 -- {student} | {passport,karta} | {other} …
  pages        INTEGER NOT NULL,
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  valid_until  DATE,                            -- довідка студента: дійсна до
  school       TEXT,
  mailed_to    TEXT,
  mailed_at    TIMESTAMPTZ,
  mail_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS docs_worker_idx ON wapp.docs (worker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wapp.student (
  worker_id    INTEGER PRIMARY KEY REFERENCES public.workers(id) ON DELETE CASCADE,
  is_student   BOOLEAN NOT NULL DEFAULT true,
  valid_until  DATE,
  school       TEXT,
  source       TEXT NOT NULL DEFAULT 'app',      -- app | hrappka | panel
  doc_id       INTEGER REFERENCES wapp.docs(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'sent',     -- sent | accepted | rejected
  note         TEXT,
  reminded_for DATE,
  expired_for  DATE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_valid_idx ON wapp.student (valid_until);

COMMIT;
