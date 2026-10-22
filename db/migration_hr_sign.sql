-- ══════════════════════════════════════════════════════════════════════
--  Підписи документів у HRappka (bot/hr_sign.js, api/hr_sign.js, Pracownicy → «Dokumenty»)
--
--  hrs.docs    — документи на підпис працівника з HRappka (таблиця EMPLOYEE_ATTACHMENT_FULL, eSignature SEND / SIGN):
--                SEND — надіслано, не підписано; SIGN — підписано. Тільки ті, що мають підпис (сканів паспорта тощо немає).
--  hrs.surveys — анкети працівника (QUESTIONNAIRE_ANSWER): SENT / FILLED; рахуються разом з документами.
--  hrs.checks  — коли й з яким результатом перевіряли працівника (щоб не смикати HRappka частіше ніж раз на хвилину
--                і щоб знати «у HRappka документів немає»).
--  Перевіряються працівники з BHP від 15.10.2026 (HR_SIGN_FROM): щодня о 6:00 — ті, хто ще не підписав усе;
--  у панелі — кнопка «Sprawdź podpisy». HRappka питаємо за паспортом (workers.login), не всю базу.
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_hr_sign.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

CREATE SCHEMA IF NOT EXISTS hrs;

CREATE TABLE IF NOT EXISTS hrs.docs (
  hr_doc_id      BIGINT PRIMARY KEY,                 -- id вкладення в HRappka
  worker_id      INT REFERENCES public.workers(id) ON DELETE CASCADE,
  hr_employee_id BIGINT,
  passport       TEXT,
  display_name   TEXT,
  hr_created_at  TIMESTAMP,                          -- creationTime з HRappka (час Варшави)
  status         TEXT NOT NULL CHECK (status IN ('SEND', 'SIGN')),
  signed_seen_at TIMESTAMPTZ,                        -- коли вперше побачили SIGN
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrs_docs_worker_idx ON hrs.docs(worker_id);

CREATE TABLE IF NOT EXISTS hrs.checks (
  worker_id  INT PRIMARY KEY REFERENCES public.workers(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  found      BOOLEAN NOT NULL,                       -- чи знайшовся працівник з документами в HRappka
  error      TEXT
);
-- id працівника в HRappka (анкети HRappka віддає лише за ним, по одному працівнику)
ALTER TABLE hrs.checks ADD COLUMN IF NOT EXISTS hr_employee_id BIGINT;

-- Анкети (QUESTIONNAIRE_ANSWER): SENT — надіслано, не заповнено; FILLED — заповнено (filled_at).
-- Рахуються разом з документами (те саме вікно ±10 днів від BHP, повторна — лише остання).
CREATE TABLE IF NOT EXISTS hrs.surveys (
  hr_answer_id   BIGINT PRIMARY KEY,
  worker_id      INT REFERENCES public.workers(id) ON DELETE CASCADE,
  hr_employee_id BIGINT,
  name           TEXT,
  state          TEXT NOT NULL,
  hr_created_at  TIMESTAMP,
  filled_at      TIMESTAMP,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hrs_surveys_worker_idx ON hrs.surveys(worker_id);

COMMIT;
