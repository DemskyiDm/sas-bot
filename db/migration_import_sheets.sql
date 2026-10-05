-- ============================================================
-- Імпорт з усіх видимих аркушів: прив'язка аркуш → об'єкт
-- Запустити ОДИН раз перед заміною import_sheets.js.
-- Повторний запуск безпечний (нічого не перезаписує).
-- ============================================================
-- import_sheet_map — який аркуш (таблиця + gid) у який об'єкт імпортується.
-- Прив'язка за gid, а не за назвою: перейменування аркуша не змінює
-- ні об'єкт, ні його назву в панелі.
--
--   origin  legacy — з колишнього списку SOURCES (назви об'єктів як були)
--           auto   — новий аркуш, знайдений імпортом
--           manual — прив'язано вручну
--   state   active   — імпортується
--           hidden   — аркуш прихований, не імпортується
--           excluded — у назві «zwolni…», не імпортується
--           missing  — аркуш видалено з таблиці
--           held     — новий аркуш, ще не імпортується (причина в note)
--           conflict — об'єкт уже імпортується з іншого аркуша
--   disabled = true — ніколи не імпортувати цей аркуш (вручну)

CREATE TABLE IF NOT EXISTS import_sheet_map (
  ss_id         text        NOT NULL,
  sheet_id      bigint      NOT NULL,
  facility_id   int         REFERENCES facilities(id) ON DELETE SET NULL,
  source_name   text        NOT NULL,
  sheet_title   text,
  origin        text        NOT NULL DEFAULT 'auto',
  state         text        NOT NULL DEFAULT 'active',
  note          text,
  disabled      boolean     NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  facility_created_at timestamptz,
  PRIMARY KEY (ss_id, sheet_id)
);
CREATE INDEX IF NOT EXISTS import_sheet_map_fac_idx ON import_sheet_map(facility_id);

-- Колишній список SOURCES → прив'язки.
-- Об'єкт шукається так само, як шукав старий імпорт: за назвою без
-- урахування регістру. Якщо таких кілька — той, куди імпорт писав останнім.
-- Якщо об'єкта ще немає, facility_id = NULL: імпорт створить його
-- з назвою зі списку (як і раніше), а не з назви аркуша.
WITH src(ss_id, sheet_id, name) AS (VALUES
  ('1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4', 1892808234, 'Ceva Nowy Świat APT'),
  ('1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4', 1609709378, 'Ceva Nowy Świat Well'),
  ('1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4', 1752399154, 'CEVA ŚWIEBODZIN APT'),
  ('1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c', 1672298586, 'ID Psary APT'),
  ('1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c', 0, 'ID Psary SAS'),
  ('1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c', 1438986598, 'ID Psary WELL'),
  ('1GlvMO24782bKn4InZiXpcIiAVejIDxCncOuDLQ-rH0c', 1238085682, 'Hydro Chrzanów SAS'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 1158031380, 'METLER Dipico'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 1407856830, 'Punto Pruszyński APT'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 0, 'G&G APT'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 157070482, 'G&G Well'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 1672298586, 'Blachy Pruszyński APT'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 1302818157, 'Gerda Sokołów APT'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 481903758, 'Oldar Agencja Work'),
  ('1ZFqUlu_C69RkY9BQDa-cutDvFEZGk8iCJjmBdaV1ZxI', 255214619, 'Aleksandra Dębska Oldar WP'),
  ('1xgOv39j82OHsGvhR53Y_IuYEN-S9KrIcLsDXvFN4fVA', 1892808234, 'Ceva Krężoły APT'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1609709378, 'Action Wypędy SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 2128388755, 'Action Zamienie SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1416932837, 'Action Zamienie SAS EAST BRIDGE'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1653950425, 'Action Zamienie Przejęcie SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 2048237816, 'Action Production SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 852139785, 'ILS UZ'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1351989642, 'ILS Błonie SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 734840239, 'Inter Cars SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1407856830, 'PolMlek SAS'),
  ('1gVEcQZY40SlnMVm3laSjuNpYk0lo8LR6Q1Ke0LQ8mKU', 1657737296, 'Trans-Tok APT'),
  ('1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4', 1335952904, 'Ligentia APT'),
  ('1UfQpf6u8lt8FXP5AXUGNwHCrvG7Y0A4wcwC3DXQg8U4', 314279664, 'Ligentia Well'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 1324296168, 'Anpacars Sosnowiec SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 738760745, 'ANPACARS BĘDZIN SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 698091925, 'MIESZKO Services SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 366286180, 'Mieszko SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 1462112214, 'Mieszko APT'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 842318862, 'MIESZKO SERVICES APT'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 0, 'SGB JAROSZOWIEC SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 527726318, 'EkoOkna SAS'),
  ('193DcijqLFqxNy5tM8BFTi5Zx6HX2QrutrpOgWxwLzM4', 377920864, 'EkoOkna Well'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 630359828, 'Fiege Goleniów Well'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 409362818, 'Rhenus Gol WELL'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 1302818157, 'CEVA APT'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 1407856830, 'CEVA Dipico'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 881937903, 'HULTAFORS WELL'),
  ('1I3Vy5zTs0DxPcH3Hq11bWjVROAiviFWUBRYWLZGw8cw', 972884639, 'Lucky Union APT'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 0, 'Id Log Rokitno SAS'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 1672298586, 'Id Log Rokitno APT'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 1407856830, 'Id Log Rokitno Well'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 1163529905, 'CAINIAO APT'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 2027894673, 'CAINIAO APT 2'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 1302818157, 'CAINIAO Dipico'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 2005234934, 'CAINIAO Dipico 2'),
  ('1CCHYKaAuFF45MoyTZAOBACjY2Vgf6PFrP9ceqalSHKM', 618124367, 'Saint-Gobain SAS'),
  ('1yYaSyo96Z96H8CGHkVWvKglTFim-nC489vK2gxV-3T8', 1228811347, 'Fiege ZG Well'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 159117149, 'IGP Operations PL APT'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 1871902412, 'IGP Operations PL SAS'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 996353161, 'Fiege NDM Well'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 1887777352, 'Gerda Starachowice APT'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 1247873024, 'Versal APT'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 2037649012, 'MAROPAK SAS'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 658536579, 'Wsip Dipico'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 1017133597, 'Domel SAS'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 938923789, 'ATS Display APT'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 1114876791, 'SGB Pruszków SAS'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 606490412, 'Cerrad Sas'),
  ('13T5x8UzXSyv322qT8O2GJvwNYR7dxtpuI2-F8AG8pYw', 856011641, 'Marc Sas'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 0, 'Id Logistics Wro SAS'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 710429418, 'ID Krajków SAS'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 1672298586, 'Id Logistics Wro APT'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 1407856830, 'Id Logistics Wro Well'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 1692725338, 'Id Logistics Tyniec APT'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 749697850, 'Id Logistics Tyniec WELL'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 1609709378, 'DSV Dipico'),
  ('1WF6mDo07x53SKYOgF0hvwQLDccueNKctZNYRFoXrlWs', 2077894048, 'Fiege Logistics Stanowice Well'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 0, 'Hydro Łódź'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1672298586, 'Hydro Łódź Well'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 138437422, 'Klimor APT'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1407856830, 'Hydro Trzcianka'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1302818157, 'Hydro Trzcianka Well'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1609709378, 'DPD Lućmierz SAS'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1477908858, 'Notino Well'),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1883894702, 'Partners Lowicz SAS '),
  ('1bgWR1bYJUXk5zoTXKPRjfV050oYJ9ha9cTNQvchHoIQ', 1622778445, 'CEVA Piotrków Trybunalski well'),
  ('1UHwrLJyb6P2Zc4j1ibC8Vif7uLR2_0tiYGHXpApsp_A', 1228811347, 'ID Konin Żagański Well'),
  ('1UHwrLJyb6P2Zc4j1ibC8Vif7uLR2_0tiYGHXpApsp_A', 224713029, 'ID Konin Żagański SAS')
),
pick AS (
  SELECT DISTINCT ON (s.ss_id, s.sheet_id)
         s.ss_id, s.sheet_id, s.name, f.id AS facility_id
    FROM src s
    LEFT JOIN facilities f ON lower(f.name) = lower(s.name)
    LEFT JOIN LATERAL (
      SELECT max(h.imported_at) AS last_imp
        FROM worker_facility_history h
       WHERE h.facility_id = f.id
    ) li ON true
   ORDER BY s.ss_id, s.sheet_id, li.last_imp DESC NULLS LAST, f.id DESC
)
INSERT INTO import_sheet_map (ss_id, sheet_id, facility_id, source_name, origin, state)
SELECT ss_id, sheet_id, facility_id, name, 'legacy', 'active'
  FROM pick
ON CONFLICT (ss_id, sheet_id) DO NOTHING;

-- Перевірка: що прив'язалося (facility_id порожній = об'єкт буде створено
-- з назвою зі списку при першому імпорті).
SELECT m.source_name, m.sheet_id, m.facility_id, f.name AS facility
  FROM import_sheet_map m
  LEFT JOIN facilities f ON f.id = m.facility_id
 WHERE m.origin = 'legacy'
 ORDER BY m.facility_id NULLS FIRST, m.source_name;
