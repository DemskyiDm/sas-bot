# Region і Pulpit kierownika: період «від–до» та регіональні координатори

## Встановлення
1. Скопіювати файли з архіву в `C:\sas-bot` із заміною:
   - `db/migration_period.sql` — новий;
   - `api/regional.js`, `public/region.html`, `public/js/region.js`;
   - `api/board.js`, `public/zarzad.html`, `public/js/zarzad.js`;
   - `docs/REGION.md`, `docs/PULPIT.md`.
2. Виконати (можна повторно, дані не змінює):
   `psql -U postgres -d sasdb -f db/migration_period.sql`
3. `pm2 restart index` (або як називається процес).

## Що змінилося
- **Region:** перемикач «Tydzień / Okres od–do». У режимі періоду статус кожного об'єкта рахується за весь період:
  - ті самі пороги;
  - ротація перерахована на 28 днів;
  - «Tyg. czerw. w okresie» — скільки тижневих перерахунків у періоді були червоними;
  - вкладка «Koordynatorzy» теж рахується за період.
- **Pulpit:** «Tydzień / 4 tygodnie / Od–do». «13 tygodni» прибрано — такий період задається через «від–до».
- **Pulpit:** регіональні координатори беруться з Region → Ustawienia:
  - показані в списку регіонів і в світлофорі;
  - новий блок «🧭 Regiony i koordynatorzy regionalni» — показники по кожному регіону з підсумком.

`okres.patch` — ті самі зміни у форматі diff, для перевірки.
