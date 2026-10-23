-- ══════════════════════════════════════════════════════════════════════
--  Zamówienia · Rekrutacja (api/rec.js, public/zamowienia.html)
--
--  rec.orders      — замовлення клієнта, яке вводить координатор: скільки людей, склад (чоловіки / жінки / пари
--                    або «без різниці»), дата BHP клієнта і наше оформлення (раніше на 1–2 робочі дні — rec.facility),
--                    посада, вимоги, текст листа клієнта. Статус: new → approved (головний рекрутер) → done / rejected / cancelled.
--                    «Є» (скільки вже набрано) не зберігається — рахується з worker_facility_history, стать — з PESEL.
--  rec.order_log   — історія: хто, коли, що зробив (створив, змінив, підтвердив, відхилив, запитав).
--  rec.facility    — для закладу: за скільки робочих днів до BHP наше оформлення (за замовчуванням 1);
--                    місця в житлі (Ч / Ж) — поки порожньо.
--  План набору (flow.orders) поки вводиться як раніше, паралельно.
--
--  Застосовується автоматично при старті сервера (db/migrate.js). Вручну: node db/migrate.js   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
SET client_encoding = 'UTF8';

BEGIN;

CREATE SCHEMA IF NOT EXISTS rec;

CREATE TABLE IF NOT EXISTS rec.facility (
  facility_id  INT PRIMARY KEY REFERENCES public.facilities(id) ON DELETE CASCADE,
  form_days    INT NOT NULL DEFAULT 1 CHECK (form_days BETWEEN 0 AND 5),
  beds_men     INT CHECK (beds_men >= 0),
  beds_women   INT CHECK (beds_women >= 0),
  updated_by   INT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rec.orders (
  id            BIGSERIAL PRIMARY KEY,
  facility_id   INT NOT NULL REFERENCES public.facilities(id),
  qty           INT NOT NULL CHECK (qty BETWEEN 1 AND 500),
  any_gender    BOOLEAN NOT NULL DEFAULT true,
  men           INT NOT NULL DEFAULT 0 CHECK (men >= 0),
  women         INT NOT NULL DEFAULT 0 CHECK (women >= 0),
  pairs         INT NOT NULL DEFAULT 0 CHECK (pairs >= 0),
  bhp_date      DATE NOT NULL,
  form_date     DATE NOT NULL,
  position      TEXT,
  requirements  TEXT,
  client_mail   TEXT,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'done', 'rejected', 'cancelled')),
  created_by    INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   INT,
  approved_at   TIMESTAMPTZ,
  note          TEXT,          -- причина відмови / питання до координатора
  notified_at   TIMESTAMPTZ    -- коли координатор отримав повідомлення про підтвердження
);
CREATE INDEX IF NOT EXISTS rec_orders_status_idx ON rec.orders(status, form_date);
CREATE INDEX IF NOT EXISTS rec_orders_facility_idx ON rec.orders(facility_id, bhp_date);

CREATE TABLE IF NOT EXISTS rec.order_log (
  id        BIGSERIAL PRIMARY KEY,
  order_id  BIGINT NOT NULL REFERENCES rec.orders(id) ON DELETE CASCADE,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  by_id     INT,
  action    TEXT NOT NULL,
  details   JSONB
);
CREATE INDEX IF NOT EXISTS rec_order_log_idx ON rec.order_log(order_id, at);

COMMIT;
