# Przypisania — все привязки в одном месте

**Где:** Region → **🔗 Przypisania** (только админ). Пункт «Przypisania» в админ-панели ведёт сюда.
Учётки, логины и пароли координаторов остаются в админ-панели → Koordynatorzy.

Раньше привязки были в двух местах: админ-панель (таблица `coordinator_facilities`) и Region → Ustawienia
(регион и ответственный объекта, региональные). Теперь одно место и одно правило доступа.

## Кто есть кто

| Роль | Где задаётся | Главная панель | Region, Wyjazdy, Rozmowy |
|---|---|---|---|
| **Главный** координатор объекта | Obiekty → «Główny koordynator» + дата «od» | видит и редактирует | отвечает за объект: показатели, премии, сводки Wyjazdy, разговоры |
| **Вспомогательный** ✎ edycja | Obiekty → «+ pomocniczy», переключатель ✎/👁 | видит и редактирует | — |
| **Вспомогательный** 👁 podgląd | то же | только видит | — |
| **Региональный** | Regiony → «+ dodaj koordynatora regionalnego» | видит весь свой регион, без редактирования | ведёт регион: доска, карточки, уведомления |
| **Админ** | админ-панель (is_admin) | всё | всё |

- **Объект** = группа по `facilities.group_name` (IDL Psary = APT + SAS + WELL). Главный и вспомогательный
  получают **все** заклады группы.
- **Редактирование** в главной панели: часы, напоминания, авансы, wolne, импорт графика, добавление и правка
  работников, настройки заклада. Без права редактирования панель отвечает «Tylko podgląd».
- Отчёт «кто не заполнил часы» (raport-godzin): «свои объекты» = объекты с правом редактирования.
- Wyjazdy, Rozmowy и вкладка Region «Moje obiekty» по-прежнему считаются только по **главному**.

## Вкладка Przypisania

1. **Баннеры сверху:**
   - «do sprawdzenia» — привязки, перенесённые из админ-панели (см. «Переход»);
   - объекты с неактивным главным — назначьте другого.
2. **Obiekty.**
   - Колонки: регион, главный с датой «od», вспомогательные, 📦 в архив.
   - Фильтры: поиск (объект или человек), координатор, «bez regionu», «bez głównego», «bez ludzi»,
     «do sprawdzenia», «nieaktywni».
   - Смена главного действует с даты. Дата — сегодня или раньше, будущую панель не примет: переназначайте
     в день передачи объекта. Новый главный сразу получает редактирование, прежний его теряет.
     Чтобы прежний остался помогать, добавьте его вспомогательным.
   - Новый главный автоматически убирается из вспомогательных этого объекта.
3. **Regiony** — региональные (можно несколько на регион), активность региона. Неактивный регион не даёт
   региональным доступа в главной панели.
4. **Koordynatorzy.**
   - Колонки: роль, логин, Telegram, где главный, где вспомогательный, где региональный,
     доступ в панели («z edycją / razem»).
   - Клик по имени показывает его объекты.
   - Кнопки «Dezaktywuj / Aktywuj».
5. **📦 Archiwum** — объекты, с которыми не работаем (описание — `docs/REGION.md`). В архиве ни у кого,
   кроме админа, доступа нет; «Przywróć» возвращает прежние привязки.

## Неактивный координатор

- не может войти: «Konto nieaktywne», открытые сессии закрываются сразу;
- нет доступа ни к одному объекту;
- не получает сообщений в Telegram: Region, Wyjazdy, Rozmowy, отчёт по часам. Срочные задачи Rozmowy
  по его объектам уходят региональному или админу;
- привязки сохраняются и возвращаются после «Aktywuj»;
- объекты, где он был главным, подсвечены красным («nieaktywny — przypisz innego»). Пока главный не сменён,
  объект числится за ним в Region и Rozmowy, поэтому назначьте нового;
- себя деактивировать нельзя. Новым главным или вспомогательным неактивного не назначить,
  но у уже назначенного можно сменить регион объекта и режим 👁/✎.

## Переход (миграция `db/migration_przypisania.sql`)

- Копия старой таблицы → `reg.coordinator_facilities_backup`.
- Главный объекта берётся из Region (`reg.site_owner`).
- Каждая привязка из админ-панели, которая не совпадает с главным, становится **вспомогательной с
  редактированием** и с флагом «do sprawdzenia». После установки никто не теряет доступ.
- После установки пройдите «do sprawdzenia»:
  - в строке объекта: ✓ — оставить редактирование, ✎ → 👁 — только просмотр, ✕ — убрать;
  - или сразу всех: «Wszystkim → tylko podgląd» / «Wszystkim zostaw edycję».
- Отчёт миграции (три таблицы в конце вывода):
  1. кто потерял доступ — должно быть пусто, кроме неактивных и архива;
  2. новый доступ — главный и вспомогательный получают всю группу объекта, региональный — просмотр региона;
  3. сводка.

## Как устроено (для разработчика)

- Источник правды:
  - `reg.site_owner` — главный и регион, с историей `valid_from` / `valid_to`;
  - `reg.site_helpers` — вспомогательные (`can_edit`, `review`);
  - `reg.region_leads`;
  - `reg.site_archive`;
  - `coordinators.is_active`.
- `public.coordinator_facilities` — **вычисляемая** таблица:
  - `reg.sync_access()` пересобирает её из представления `reg.v_access`;
  - `is_primary` = право редактирования;
  - пересчёт делают statement-триггеры на всех таблицах-источниках и на `facilities` (insert/delete/смена
    name, group_name).
- Ошибка пересчёта:
  - при изменении привязок или активности — отменяет всё изменение, панель покажет ошибку;
  - при изменении закладов (импорт) — только WARNING в логе Postgres, импорт не блокируется.
- Контрольный пересчёт раз в час (в :17) — `api/regional.js` → `syncAccess()`.
- **Писать в `coordinator_facilities` руками бесполезно** — следующий пересчёт перезапишет.
  Старые `POST/DELETE /admin/assignments` отвечают 410.
- API (всё `requireAdminOnly`, префикс `/api/regional`):
  - `GET /admin/assign`
  - `PUT /admin/sites`
  - `PUT|DELETE /admin/helpers`
  - `POST /admin/helpers/review`
  - `POST /admin/coordinators/:id/active`
- Права записи в главной панели:
  - `api/routes.js` → `getEditFacilityFilter`, `workerInEditScope`, `editDenied`;
  - `api/admin.js` → `canEditFacility`;
  - `index.js` → `PATCH /api/facility-settings/:id`.
- Откат (вернуть старую таблицу как была):
  ```sql
  DROP TRIGGER IF EXISTS sync_access ON reg.site_owner;  DROP TRIGGER IF EXISTS sync_access ON reg.site_helpers;
  DROP TRIGGER IF EXISTS sync_access ON reg.region_leads; DROP TRIGGER IF EXISTS sync_access ON reg.site_archive;
  DROP TRIGGER IF EXISTS sync_access ON reg.regions;
  DROP TRIGGER IF EXISTS reg_sync_access ON public.facilities; DROP TRIGGER IF EXISTS reg_sync_access ON public.coordinators;
  BEGIN;
  DELETE FROM public.coordinator_facilities;
  INSERT INTO public.coordinator_facilities (id, coordinator_id, facility_id, is_primary, assigned_at)
  SELECT id, coordinator_id, facility_id, is_primary, assigned_at FROM reg.coordinator_facilities_backup;
  COMMIT;
  ```
  Затем верните старые файлы приложения.
