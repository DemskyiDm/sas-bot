-- ══════════════════════════════════════════════════════════════════════
--  Badania lekarskie → ⚙️ Ustawienia (bot/office.js, api/tg.js, public/js/office.js)
--
--  tgc.med_coords   — кому з координаторів увімкнена панель «Badania lekarskie» (веб і мініпанель).
--                     Адмін / head і регіональні бачать панель завжди.
--  tgc.med_facility — для закладу (Przedsiębiorstwo): тип медогляду і адреса, що йдуть у лист і Excel
--                     (колонки «Typ badania» і «Adres» — однакові для всіх працівників закладу).
--  Змінюють адмін / head (усе) і регіональні (свої регіони).
--
--  Запуск: psql -U postgres -d sasdb -f db\migration_med_settings.sql   (можна повторно)
--  Без цієї міграції панель працює, як раніше: видна всім, тип — «badanie», адреса порожня.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS tgc;

CREATE TABLE IF NOT EXISTS tgc.med_coords (
  coordinator_id INT PRIMARY KEY REFERENCES public.coordinators(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  updated_by     INT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tgc.med_facility (
  facility_id INT PRIMARY KEY REFERENCES public.facilities(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'badanie' CHECK (kind IN ('badanie', 'badanie_sanepid')),
  address     TEXT,
  updated_by  INT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
