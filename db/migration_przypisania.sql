-- ══════════════════════════════════════════════════════════════════════
--  Przypisania w jednym miejscu: Region → 👥 Przypisania
--
--  Jedno źródło prawdy (schemat reg):
--    reg.site_owner    — główny koordynator i region obiektu (z historią „od”) — jak było
--    reg.region_leads  — koordynatorzy regionalni regionu — jak było
--    reg.site_helpers  — NOWE: koordynatorzy pomocniczy obiektu (domyślnie tylko podgląd)
--
--  public.coordinator_facilities (dostęp w panelu głównym, bot) staje się tabelą WYLICZANĄ:
--    główny                 → wszystkie zakłady obiektu, edycja      (is_primary = true)
--    pomocniczy             → wszystkie zakłady obiektu, podgląd     (is_primary = can_edit)
--    regionalny             → zakłady obiektów swoich regionów, podgląd
--    nieaktywny koordynator → nic; obiekt w archiwum → nic
--  Przelicza ją reg.sync_access() — wywoływana triggerami po każdej zmianie przypisań,
--  zakładów, aktywności koordynatora, regionu lub archiwum. Ręczne wpisy do coordinator_facilities
--  są nadpisywane — przypisuje się tylko w Region → Przypisania.
--
--  Przejście (raz, przy pierwszym uruchomieniu):
--    • kopia obecnej tabeli → reg.coordinator_facilities_backup;
--    • każde przypisanie z panelu admina, które nie jest głównym z Regionu, staje się pomocniczym
--      Z PRAWEM EDYCJI i flagą „do sprawdzenia” — po instalacji nikt nie traci dostępu ani edycji.
--
--  Wymaga: db/migration_regional.sql, db/migration_archive.sql. Można uruchamiać wielokrotnie.
--  Całość w jednej transakcji: błąd w środku → nic się nie zmienia.
--  Uruchom RAZEM z podmianą plików aplikacji (stary panel admina pisze do coordinator_facilities
--  bezpośrednio — takie zmiany po migracji zostaną nadpisane przeliczeniem).
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
BEGIN
  IF to_regclass('reg.site_owner') IS NULL OR to_regclass('reg.region_leads') IS NULL THEN
    RAISE EXCEPTION 'Najpierw db/migration_regional.sql';
  END IF;
  IF to_regclass('reg.site_archive') IS NULL THEN
    RAISE EXCEPTION 'Najpierw db/migration_archive.sql';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS reg.migrations (
  name    TEXT PRIMARY KEY,
  done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note    TEXT
);

-- Koordynatorzy pomocniczy obiektu (obiekt = grupa z facilities.group_name, jak w Regionie)
CREATE TABLE IF NOT EXISTS reg.site_helpers (
  site_key       TEXT NOT NULL,
  coordinator_id INT  NOT NULL REFERENCES public.coordinators(id) ON DELETE CASCADE,
  can_edit       BOOLEAN NOT NULL DEFAULT false,   -- false = tylko podgląd
  review         BOOLEAN NOT NULL DEFAULT false,   -- przeniesione z panelu admina — do sprawdzenia
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT,
  PRIMARY KEY (site_key, coordinator_id)
);
CREATE INDEX IF NOT EXISTS site_helpers_coord_idx ON reg.site_helpers(coordinator_id);

-- ── Przejście: kopia + przeniesienie przypisań z panelu admina (tylko raz) ──
DO $$
DECLARE n INT;
BEGIN
  IF EXISTS (SELECT 1 FROM reg.migrations WHERE name = 'przypisania_import') THEN
    RETURN;
  END IF;
  CREATE TABLE IF NOT EXISTS reg.coordinator_facilities_backup AS
    SELECT cf.*, now() AS backed_up_at FROM public.coordinator_facilities cf;

  INSERT INTO reg.site_helpers (site_key, coordinator_id, can_edit, review)
  SELECT DISTINCT reg.site_key(f.group_name, f.name), cf.coordinator_id, true, true
    FROM public.coordinator_facilities cf
    JOIN public.facilities f   ON f.id = cf.facility_id
    JOIN public.coordinators c ON c.id = cf.coordinator_id
   WHERE reg.site_key(f.group_name, f.name) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM reg.site_owner so
                      WHERE so.site_key = reg.site_key(f.group_name, f.name)
                        AND so.valid_to IS NULL AND so.coordinator_id = cf.coordinator_id)
  ON CONFLICT (site_key, coordinator_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO reg.migrations (name, note)
  VALUES ('przypisania_import', n || ' przypisań z panelu admina → pomocniczy z edycją, do sprawdzenia');
END $$;

-- ── Dostęp wyliczony ze źródła prawdy ─────────────────────────────────
CREATE OR REPLACE VIEW reg.v_access AS
WITH fac AS (
  SELECT f.id AS facility_id, reg.site_key(f.group_name, f.name) AS site_key FROM public.facilities f
), src AS (
  SELECT so.coordinator_id, so.site_key, true AS can_edit, 'main'::text AS kind
    FROM reg.site_owner so
   WHERE so.valid_to IS NULL AND so.coordinator_id IS NOT NULL
  UNION ALL
  SELECT h.coordinator_id, h.site_key, h.can_edit, 'helper'
    FROM reg.site_helpers h
  UNION ALL
  SELECT rl.coordinator_id, so.site_key, false, 'lead'
    FROM reg.site_owner so
    JOIN reg.regions rg       ON rg.id = so.region_id AND rg.is_active
    JOIN reg.region_leads rl  ON rl.region_id = so.region_id
   WHERE so.valid_to IS NULL
)
SELECT s.coordinator_id, fac.facility_id,
       bool_or(s.can_edit) AS can_edit,
       array_agg(DISTINCT s.kind ORDER BY s.kind) AS kinds
  FROM src s
  JOIN fac ON fac.site_key = s.site_key
  JOIN public.coordinators c ON c.id = s.coordinator_id AND COALESCE(c.is_active, true)
 WHERE NOT EXISTS (SELECT 1 FROM reg.site_archive a WHERE a.site_key = s.site_key)
 GROUP BY s.coordinator_id, fac.facility_id;

-- Przelicza public.coordinator_facilities; zwraca liczbę zmienionych wierszy
CREATE OR REPLACE FUNCTION reg.sync_access() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT := 0; m INT;
BEGIN
  PERFORM pg_advisory_xact_lock(470211);          -- dwa równoległe przeliczenia nie dublują wierszy
  DELETE FROM public.coordinator_facilities a
   USING public.coordinator_facilities b
   WHERE a.coordinator_id = b.coordinator_id AND a.facility_id = b.facility_id AND a.id > b.id;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  DELETE FROM public.coordinator_facilities cf
   WHERE cf.coordinator_id IS NULL OR cf.facility_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM reg.v_access v
                      WHERE v.coordinator_id = cf.coordinator_id AND v.facility_id = cf.facility_id);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  UPDATE public.coordinator_facilities cf SET is_primary = v.can_edit
    FROM reg.v_access v
   WHERE v.coordinator_id = cf.coordinator_id AND v.facility_id = cf.facility_id
     AND cf.is_primary IS DISTINCT FROM v.can_edit;
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  INSERT INTO public.coordinator_facilities (coordinator_id, facility_id, is_primary)
  SELECT v.coordinator_id, v.facility_id, v.can_edit
    FROM reg.v_access v
   WHERE NOT EXISTS (SELECT 1 FROM public.coordinator_facilities cf
                      WHERE cf.coordinator_id = v.coordinator_id AND cf.facility_id = v.facility_id);
  GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END $$;

-- Trigger. Zmiana przypisań / aktywności koordynatora: błąd przeliczenia cofa całą zmianę (panel pokaże błąd) —
-- dostęp nigdy nie rozjedzie się z Przypisaniami po cichu. Zmiana zakładów (import z arkusza): błąd nie blokuje
-- importu — tylko ostrzeżenie w logu Postgresa; dostęp poprawi kontrolne przeliczenie co godzinę (api/regional.js).
CREATE OR REPLACE FUNCTION reg.trg_sync_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'facilities' THEN
    BEGIN
      PERFORM reg.sync_access();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'reg.sync_access: %', SQLERRM;
    END;
  ELSE
    PERFORM reg.sync_access();
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS sync_access ON reg.site_owner;
CREATE TRIGGER sync_access AFTER INSERT OR UPDATE OR DELETE ON reg.site_owner
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS sync_access ON reg.site_helpers;
CREATE TRIGGER sync_access AFTER INSERT OR UPDATE OR DELETE ON reg.site_helpers
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS sync_access ON reg.region_leads;
CREATE TRIGGER sync_access AFTER INSERT OR UPDATE OR DELETE ON reg.region_leads
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS sync_access ON reg.site_archive;
CREATE TRIGGER sync_access AFTER INSERT OR UPDATE OR DELETE ON reg.site_archive
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS sync_access ON reg.regions;
CREATE TRIGGER sync_access AFTER UPDATE OF is_active OR DELETE ON reg.regions
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS reg_sync_access ON public.facilities;
CREATE TRIGGER reg_sync_access AFTER INSERT OR DELETE OR UPDATE OF name, group_name ON public.facilities
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();
DROP TRIGGER IF EXISTS reg_sync_access ON public.coordinators;
CREATE TRIGGER reg_sync_access AFTER UPDATE OF is_active ON public.coordinators
  FOR EACH STATEMENT EXECUTE PROCEDURE reg.trg_sync_access();

SELECT reg.sync_access() AS zmienione_wiersze_dostepu;

COMMIT;

-- ── Raport przejścia ──────────────────────────────────────────────────
-- 1) Kto STRACIŁ dostęp do zakładu względem kopii (powinno być pusto, poza nieaktywnymi i archiwum)
SELECT c.full_name AS koordynator, f.name AS zaklad,
       CASE WHEN NOT COALESCE(c.is_active, true) THEN 'nieaktywny koordynator'
            WHEN EXISTS (SELECT 1 FROM reg.site_archive a WHERE a.site_key = reg.site_key(f.group_name, f.name)) THEN 'obiekt w archiwum'
            ELSE 'SPRAWDŹ' END AS powod
  FROM (SELECT DISTINCT coordinator_id, facility_id FROM reg.coordinator_facilities_backup) b
  JOIN public.coordinators c ON c.id = b.coordinator_id
  JOIN public.facilities f   ON f.id = b.facility_id
 WHERE NOT EXISTS (SELECT 1 FROM public.coordinator_facilities cf
                    WHERE cf.coordinator_id = b.coordinator_id AND cf.facility_id = b.facility_id)
 ORDER BY 3 DESC, 1, 2;

-- 2) Nowy dostęp, którego nie było w panelu admina: główny i pomocniczy dostają całą grupę obiektu
--    (np. APT + SAS + WELL), regionalny — podgląd obiektów swojego regionu
SELECT c.full_name AS koordynator, f.name AS zaklad,
       CASE WHEN cf.is_primary THEN 'edycja' ELSE 'podgląd' END AS dostep,
       array_to_string(v.kinds, ', ') AS skad
  FROM public.coordinator_facilities cf
  JOIN public.coordinators c ON c.id = cf.coordinator_id
  JOIN public.facilities f   ON f.id = cf.facility_id
  JOIN reg.v_access v        ON v.coordinator_id = cf.coordinator_id AND v.facility_id = cf.facility_id
 WHERE NOT EXISTS (SELECT 1 FROM reg.coordinator_facilities_backup b
                    WHERE b.coordinator_id = cf.coordinator_id AND b.facility_id = cf.facility_id)
 ORDER BY 1, 2;

-- 3) Podsumowanie
SELECT (SELECT count(*) FROM reg.coordinator_facilities_backup)                         AS przed_wierszy,
       (SELECT count(*) FROM public.coordinator_facilities)                              AS po_wierszy,
       (SELECT count(*) FROM public.coordinator_facilities WHERE is_primary)            AS po_z_edycja,
       (SELECT count(*) FROM reg.site_helpers)                                           AS pomocniczy,
       (SELECT count(*) FROM reg.site_helpers WHERE review)                              AS do_sprawdzenia;
