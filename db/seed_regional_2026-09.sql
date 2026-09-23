-- ══════════════════════════════════════════════════════════════════════
--  Початкове наповнення розділу Region — за таблицею «План/Факт серпень».
--  Запуск ПІСЛЯ migration_regional.sql. Ідемпотентно.
--
--  Об'єкти зі спільною відповідальністю (IDL Psary, Cainiao, ID ROKITNO)
--  залишені без координатора — призначити одного в розділі Region → Ustawienia.
--  Регіон «Warszawa» без регіонального — теж призначити там.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO reg.regions (name) VALUES
  ('Brychka'), ('Demski'), ('Drobakha'), ('Warszawa')
ON CONFLICT (name) DO NOTHING;

-- Регіональні координатори. Кілька на регіон — просто кілька рядків.
INSERT INTO reg.region_leads (region_id, coordinator_id)
SELECT r.id, c.id
FROM (VALUES
  ('Brychka',  '%denys%brychka%'),
  ('Demski',   '%dmytro%demsk%'),
  ('Drobakha', '%maksym%drobakha%')
) AS m(region, coord)
JOIN reg.regions r ON r.name = m.region
JOIN LATERAL (SELECT MIN(cc.id) AS id FROM public.coordinators cc
               WHERE cc.full_name ILIKE m.coord AND cc.is_active
              HAVING COUNT(*) = 1) c ON true
ON CONFLICT DO NOTHING;

WITH m(site_key, region, coord) AS (VALUES
  -- Brychka
  ('EkoOkna',                 'Brychka',  '%vas%vahin%'),
  ('Mieszko',                 'Brychka',  '%vas%vahin%'),
  ('SGB Jaroszowiec',         'Brychka',  '%vas%vahin%'),
  ('ANPACARS',                'Brychka',  '%vas%vahin%'),
  ('ANPACARS BĘDZIN',         'Brychka',  '%vas%vahin%'),
  ('IDL Psary',               'Brychka',  NULL),          -- Kardashov + Kozluk
  -- Demski
  ('ID WROCLAW',              'Demski',   '%andrii%hordiichuk%'),
  ('FIEGE STANOWICE',         'Demski',   '%andrii%hordiichuk%'),
  ('Id Logistics Tyniec APT', 'Demski',   '%andrii%hordiichuk%'),
  ('NOTINO',                  'Demski',   '%dmytro%tereshchenko%'),
  ('KLIMOR',                  'Demski',   '%dmytro%tereshchenko%'),
  ('HYDRO LODZ',              'Demski',   '%budiuk%maksym%'),
  ('DPD Lućmierz',            'Demski',   '%budiuk%maksym%'),
  ('HYDRO TRZCIANKA',         'Demski',   '%budiuk%maksym%'),
  -- без регіонального
  ('ID Konin Żagański',       NULL,       '%vladyslav%moroz%'),
  -- Drobakha
  ('Fiegie ZG',               'Drobakha', '%dmytro%volokh%'),
  ('Saint-Gobain',            'Drobakha', '%denys%davydov%'),   -- у таблиці «SGB Szczecin»
  ('Cainiao',                 'Drobakha', NULL),          -- Davydov + Volokh
  ('ID ROKITNO',              'Drobakha', NULL),          -- Davydov + Volokh
  ('Ceva Nowy Świat',         'Drobakha', '%andrii%obushenko%'),
  ('Ligentia',                'Drobakha', '%andrii%obushenko%'),
  ('Ceva Krężoły',            'Drobakha', '%oleksii%ikol%'),
  ('HULTAFORS',               'Drobakha', '%eduard%rychka%'),
  ('CEVA',                    'Drobakha', '%eduard%rychka%'),
  ('Lucky Union',             'Drobakha', '%eduard%rychka%'),
  ('Rhenus Goleniów',         'Drobakha', '%eduard%rychka%'),
  ('Fiege Goleniów',          'Drobakha', '%drobakha%'),
  ('Ceva Świebodzin',         'Drobakha', '%viktor%kushneruk%'),
  -- Warszawa
  ('ATS Display',             'Warszawa', '%andrii%boichenko%'),
  ('Fiege NDM',               'Warszawa', '%andrii%boichenko%'),
  ('Gerda Starachowice',      'Warszawa', '%andrii%boichenko%'),
  ('MAROPAK',                 'Warszawa', '%andrii%boichenko%'),
  ('IGP Operations PL',       'Warszawa', '%andrii%boichenko%'),
  ('SGB Pruszków',            'Warszawa', '%andrii%boichenko%'),
  ('Versal',                  'Warszawa', '%andrii%boichenko%'),
  ('WSIP',                    'Warszawa', '%andrii%boichenko%'),
  ('Cerrad Sas',              'Warszawa', '%andrii%boichenko%'),
  ('Domel',                   'Warszawa', '%andrii%boichenko%'),
  ('Marc Sas',                'Warszawa', '%andrii%boichenko%'), -- у таблиці «Marc-Th»
  ('Blachy Pruszyński',       'Warszawa', '%viacheslav%kozhedub%'),  -- разом з Punto
  ('G&G',                     'Warszawa', '%viacheslav%kozhedub%'),
  ('GERDA Sokołów',           'Warszawa', '%viacheslav%kozhedub%'),
  ('OLDAR',                   'Warszawa', '%viacheslav%kozhedub%'),
  ('Metler',                  'Warszawa', '%viacheslav%kozhedub%'),
  ('Acrion Produkcja',        'Warszawa', '%vladyslav%yanchuk%'),   -- так у group_name
  ('Action Wypędy',           'Warszawa', '%vladyslav%yanchuk%'),
  ('Action Zamienie',         'Warszawa', '%vladyslav%yanchuk%'),
  ('PolMlek',                 'Warszawa', '%vladyslav%yanchuk%'),
  ('ILS',                     'Warszawa', '%vladyslav%yanchuk%'),
  ('ILS UZ',                  'Warszawa', '%vladyslav%yanchuk%'),
  ('TRANS-TOK',               'Warszawa', '%vladyslav%yanchuk%')
)
INSERT INTO reg.site_owner (site_key, region_id, coordinator_id, valid_from)
SELECT m.site_key,
       (SELECT r.id FROM reg.regions r WHERE r.name = m.region),
       (SELECT MIN(c.id) FROM public.coordinators c          -- NULL, якщо збігів 0 або більше одного
         WHERE m.coord IS NOT NULL AND c.full_name ILIKE m.coord AND c.is_active
        HAVING COUNT(*) = 1),
       DATE '2026-01-01'
FROM m
ON CONFLICT (site_key) WHERE valid_to IS NULL DO NOTHING;

-- Структурний випадок (клієнт згортає об'єкт) — розкоментувати, якщо підтверджено:
-- INSERT INTO reg.site_flags (site_key, flag, date_from, note)
-- VALUES ('G&G', 'structural', DATE '2026-08-01', 'Klient ogranicza zamówienie');

COMMIT;

-- Перевірка: регіональні координатори регіонів
SELECT r.name AS region, COALESCE(string_agg(c.full_name, ', ' ORDER BY c.full_name), '— brak —') AS koordynatorzy_regionalni
FROM reg.regions r
LEFT JOIN reg.region_leads rl ON rl.region_id = r.id
LEFT JOIN public.coordinators c ON c.id = rl.coordinator_id
GROUP BY r.name ORDER BY r.name;

-- Перевірка: хто за що відповідає (переглянути очима!)
SELECT rg.name AS region, so.site_key AS obiekt, COALESCE(c.full_name, '— brak —') AS koordynator
FROM reg.site_owner so
LEFT JOIN reg.regions rg ON rg.id = so.region_id
LEFT JOIN public.coordinators c ON c.id = so.coordinator_id
WHERE so.valid_to IS NULL
ORDER BY rg.name NULLS LAST, c.full_name NULLS FIRST, so.site_key;

-- Перевірка: об'єкти з сіду, яких немає серед facilities (помилка в назві)
SELECT so.site_key AS "brak takiego obiektu w facilities"
FROM reg.site_owner so
WHERE so.valid_to IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.facilities f WHERE reg.site_key(f.group_name, f.name) = so.site_key);

-- Перевірка: об'єкти з людьми, які ще ні за ким не закріплені
SELECT p.site_key AS "obiekt bez przypisania", COUNT(DISTINCT p.worker_id) AS pracownicy
FROM reg.v_periods p
WHERE p.last_work_date IS NULL
  AND NOT EXISTS (SELECT 1 FROM reg.site_owner so WHERE so.site_key = p.site_key AND so.valid_to IS NULL)
GROUP BY p.site_key ORDER BY 2 DESC;
