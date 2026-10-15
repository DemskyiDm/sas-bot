-- ══════════════════════════════════════════════════════════════════════
--  Сверка медосмотров: кого не было в таблице «badania lekarskie».
--  Одна строка = работник + дата BHP. Открытая (resolved_on IS NULL) —
--  человека всё ещё нет в таблице. Закрывается, когда:
--    sheet   — появился в таблице;
--    gone    — период пропал из базы (rezygnacja / перенос BHP / удалён);
--    expired — BHP вышла за окно MED_CHECK_DAYS.
--
--  Запуск: psql -d sasdb -f db/migration_medcheck.sql
--  Идемпотентно: можно запускать повторно.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS med_check_missing (
  worker_id    INT  NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  bhp_date     DATE NOT NULL,
  facility_id  INT,
  first_seen   DATE NOT NULL,   -- первая сверка, где человека не было в таблице
  last_seen    DATE NOT NULL,   -- последняя сверка, где его ещё не было
  resolved_on  DATE,            -- сверка, на которой закрыли
  resolved_how TEXT CHECK (resolved_how IN ('sheet', 'gone', 'expired')),
  PRIMARY KEY (worker_id, bhp_date)
);

CREATE INDEX IF NOT EXISTS med_check_missing_open_idx
  ON med_check_missing (resolved_on);

COMMIT;
