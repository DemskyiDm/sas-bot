-- ══════════════════════════════════════════════════════════════════════
--  Таблиця «Dokumenty pocztą 2026» (bot/docs_sheet.js): о 6:00 після перевірки підписів бот дописує
--  в аркуші BEZPOSREDNIO і PRZENIESIENIE паспорт, дати анкети й документів, програму лояльності,
--  відповідь про приватне страхування (лише порожні клітинки, світло-помаранчевим).
--
--  hrs.surveys.qid / answers — id анкети HRappka і потрібні відповіді: { insurance: TAK|NIE, loyalty: ZGODA|NIE }
--  hrs.sheet_issues          — рядки таблиці, для яких не знайшли працівника (у лист о 7:00); оновлюється щоразу
--  hrs.sheet_queue           — періоди, які імпорт HRappka додав і які почали працювати (Pracuje / Dotarł): бот дописує
--                              їх рядком в аркуш (done_at — коли; note: added | exists | status)
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_docs_sheet.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

ALTER TABLE hrs.surveys ADD COLUMN IF NOT EXISTS qid INT;
ALTER TABLE hrs.surveys ADD COLUMN IF NOT EXISTS answers JSONB;

CREATE TABLE IF NOT EXISTS hrs.sheet_issues (
  sheet     TEXT NOT NULL,
  row_no    INT NOT NULL,                 -- номер рядка в аркуші (як у Google, з 1)
  full_name TEXT,
  facility  TEXT,
  umowa_od  DATE,
  reason    TEXT NOT NULL,                -- not_found | ambiguous
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet, row_no)
);

CREATE TABLE IF NOT EXISTS hrs.sheet_queue (
  history_id INT PRIMARY KEY REFERENCES public.worker_facility_history(id) ON DELETE CASCADE,
  queued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ,
  sheet      TEXT,
  row_no     INT,                         -- номер рядка в аркуші (як у Google, з 1)
  note       TEXT
);

COMMIT;
