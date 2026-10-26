// Застосунок працівника в Telegram: години, аванс, вихідні, довідка студента, документи (фото → один PDF).
// Вхід: кожен запит несе Telegram.WebApp.initData (заголовок x-tg-init) → api/wapp.js перевіряє підпис і знаходить
// працівника, який увійшов у бот з цього Telegram. Мови — як у боті: uk / ru / pl / en.
// Адреси: #home, #hours, #adv, #dof, #student, #docs. Відкрито не з Telegram з ?demo — тестові дані без сервера.
"use strict";

const TGW = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : null;
const DEMO = !TGW && /[?&]demo\b/.test(location.search);
const MAXPX = 2000;           // довша сторона фото перед відправкою
const JPEG_Q = 0.85;

const L = {
  uk: {
    back: "Назад", retry: "Спробувати ще раз", home: "На головну",
    months: ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"],
    wd: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"],
    wdl: ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "Пʼятниця", "Субота"],
    hi: (n) => `Вітаю, ${n}`,
    h_unit: "год за місяць", tabel: "Табель",
    miss: (d) => `Не заповнено: ${d}`, miss_more: (n) => `і ще ${n}`, fill: "Заповнити", all_filled: "Усі дні заповнено",
    t_hours: "Години", t_adv: "Аванс", t_dof: "Вихідний",
    sec_docs: "Документи в офіс", st_title: "Довідка студента", dc_title: "Паспорт / карта побиту",
    st_state: { none: "Ще не надіслано", active: (d) => `Діє до ${d}`, expiring: (d) => `Закінчується ${d}`, expired: (d) => `Закінчилась ${d}`, unknown: "Студент · без дати" },
    dc_last: (d) => `Надіслано ${d}`, dc_none: "Надіслати фото документів",
    sec_req: "Мої заявки", req_none: "Заявок ще немає", adv_item: (z) => `Аванс · ${z} zł`, dof_item: (d) => `Вихідний · ${d}`,
    st: { pending: "На розгляді", approved: "Підтверджено", rejected: "Відхилено", paid: "Виплачено" },
    // години
    total: (h) => `Разом ${h} год`, lg_h: "години", lg_abs: "відсутність", lg_miss: "не заповнено",
    how_many: "скільки годин?", other: "Інше", other_ph: "напр. 7.5 або 7:30", abs_or: "Або код відсутності",
    codes: { WZ: "за графіком", DWZ: "від фірми", UN: "виправдана", URL: "відпустка", L4: "лікарняний", NN: "без причини" },
    pick_day: "Оберіть день у календарі.", ro_out: "У цей день ви не працювали на обʼєкті.", ro_old: "Цей день уже не можна змінити — зверніться до координатора.",
    ro_future: "Цей день ще не настав.", save_h: (d, v) => `Зберегти · ${d} · ${v}`, save: "Зберегти", saved: "Збережено",
    h_val: (h) => `${h} год`,
    // аванс
    adv_title: "Аванс", adv_sum: "Сума авансу", pay: (d) => `Виплата у пʼятницю, ${d}`, pay_s: "Якщо заявку підтвердить координатор",
    adv_one: "Одна заявка за раз. Координатор розгляне її найближчим часом.", adv_btn: (z) => `Замовити аванс · ${z} zł`,
    adv_pending: "Ваша заявка вже на розгляді.", adv_ok: (d) => `Заявку прийнято. Виплата у пʼятницю ${d}.`,
    adv_off: "Аванси на вашому обʼєкті вимкнені.", hist: "Історія", dismissed: "Ви більше не працюєте — заявки недоступні.",
    // вихідні
    dof_title: "Вихідний", dof_hint: (n) => `Оберіть дні — можна кілька. Найближчі ${n} дні замовити не можна, лише заздалегідь.`,
    dof_hint2: (n) => `Оберіть дні на ${n} днів уперед — можна кілька.`,
    lg_sel: "обрано", lg_ok: "підтверджено", lg_wait: "на розгляді", lg_no: "недоступно",
    picked: (n) => `Обрано: ${n}`, dof_btn: (n) => `Підтвердити · ${n} дн.`, dof_none: "Не обрано жодного дня.",
    dof_ok: "Заявку прийнято.", dof_rej: (d, n) => `Відхилено: ${d}. Вихідний на найближчі ${n} дні — лише заздалегідь.`,
    dof_off: "Вихідні на вашому обʼєкті замовляються не через застосунок.",
    // студент
    st_cur: { active: "Чинна довідка в офісі", expiring: "Довідка скоро закінчується", expired: "Довідка закінчилась", unknown: "Ви студент — дата довідки невідома", none: "Довідки в офісі ще немає" },
    st_sent: (d) => `Надіслано ${d}`, st_until: (d) => `діє до ${d}`,
    st_new: "Нова довідка", scan: "Сфотографувати", file: "Файл або PDF", add_page: "Ще сторінка",
    valid: "Дійсна до", school: "Навчальний заклад", optional: "Необовʼязково",
    st_hint: "Довідку треба оновлювати щосеместру. Бот нагадає за 14 днів до кінця терміну.",
    send_office: "Надіслати в офіс", need_pages: "Додайте фото або файл довідки.", need_valid: "Вкажіть, до якої дати дійсна довідка.",
    pages_n: (n) => `${n} стор.`,
    // документи
    dc_q: "Що надсилаєте? Можна кілька — вийде один PDF.",
    kinds: { passport: "Паспорт", karta: "Карта побиту", other: "Інший документ" },
    kinds_s: { passport: "Сторінка з фото", karta: "Обидві сторони", other: "Віза, PESEL, заява…" },
    slots: { passport: ["Сторінка з фото"], karta: ["Лицьова сторона", "Зворотна сторона"], other: ["Сторінка 1"] },
    page_n: (n) => `Сторінка ${n}`, quality: "Якість", color: "Колір", bw: "Ч/Б",
    confirm_ok: "Документи чинні, фото чіткі й читабельні", need_kind: "Оберіть документ.", need_all: (k) => `Додайте всі сторінки: ${k}`,
    need_check: "Підтвердьте, що фото чіткі.", pdf_n: (n) => `Буде один PDF · ${n} стор.`, uploading: "Фото ще завантажуються…",
    rotate: "Повернути", remove: "Видалити",
    done_t: "Надіслано в офіс", done_mail: "Офіс отримав лист з PDF.", done_saved: "Документ збережено — офіс побачить його в панелі.",
    to_chat: "Зберегти PDF у чат собі", to_chat_ok: "PDF надіслано вам у чат з ботом",
    // помилки
    e_title: "Не вдалося відкрити", e_not_linked: "Спочатку увійдіть у бот: напишіть боту свій ID, потім відкрийте застосунок знову.",
    e_bad_init: "Не вдалося перевірити вхід Telegram. Закрийте застосунок і відкрийте знову кнопкою в чаті з ботом.",
    e_not_enabled: "Застосунок поки що доступний не всім — користуйтесь кнопками бота.",
    e_outside: "Застосунок відкривається кнопкою «Застосунок» у чаті з ботом.",
    err: {
      net: "Немає звʼязку з сервером. Спробуйте ще раз.", server: "Помилка сервера. Спробуйте пізніше.",
      bad_date: "Цей день не можна змінити.", bad_hours: "Години — від 0,25 до 16. Якщо не працювали — оберіть код.", bad_code: "Невідомий код.",
      outside_period: "У цей день ви не працювали на обʼєкті — запис не збережено.",
      disabled: "На вашому обʼєкті це вимкнено.", dismissed: "Ви більше не працюєте — заявки недоступні.", pending: "Ваша заявка вже на розгляді.",
      no_days: "Не обрано жодного дня.", taken: "На ці дні заявка вже є.", too_big: "Файл завеликий (до 12 МБ).", bad_type: "Потрібне фото або PDF.",
      bad_valid_until: "Дата «дійсна до» — не раніше сьогодні.", bad_pages: "Додайте сторінки.", pages_gone: "Фото застаріли — додайте їх знову.",
      one_pdf: "PDF можна надіслати лише один, без фото.", send_failed: "Не вдалося надіслати.", not_found: "Не знайдено.",
    },
  },
  ru: {
    back: "Назад", retry: "Попробовать ещё раз", home: "На главную",
    months: ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"],
    wd: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    wdl: ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"],
    hi: (n) => `Здравствуйте, ${n}`,
    h_unit: "ч за месяц", tabel: "Табель",
    miss: (d) => `Не заполнено: ${d}`, miss_more: (n) => `и ещё ${n}`, fill: "Заполнить", all_filled: "Все дни заполнены",
    t_hours: "Часы", t_adv: "Аванс", t_dof: "Выходной",
    sec_docs: "Документы в офис", st_title: "Справка студента", dc_title: "Паспорт / карта побыту",
    st_state: { none: "Ещё не отправлена", active: (d) => `Действует до ${d}`, expiring: (d) => `Заканчивается ${d}`, expired: (d) => `Закончилась ${d}`, unknown: "Студент · без даты" },
    dc_last: (d) => `Отправлено ${d}`, dc_none: "Отправить фото документов",
    sec_req: "Мои заявки", req_none: "Заявок пока нет", adv_item: (z) => `Аванс · ${z} zł`, dof_item: (d) => `Выходной · ${d}`,
    st: { pending: "На рассмотрении", approved: "Одобрено", rejected: "Отклонено", paid: "Выплачено" },
    total: (h) => `Всего ${h} ч`, lg_h: "часы", lg_abs: "отсутствие", lg_miss: "не заполнено",
    how_many: "сколько часов?", other: "Другое", other_ph: "напр. 7.5 или 7:30", abs_or: "Или код отсутствия",
    codes: { WZ: "по графику", DWZ: "от фирмы", UN: "уважительная", URL: "отпуск", L4: "больничный", NN: "без причины" },
    pick_day: "Выберите день в календаре.", ro_out: "В этот день вы не работали на объекте.", ro_old: "Этот день уже нельзя изменить — обратитесь к координатору.",
    ro_future: "Этот день ещё не наступил.", save_h: (d, v) => `Сохранить · ${d} · ${v}`, save: "Сохранить", saved: "Сохранено",
    h_val: (h) => `${h} ч`,
    adv_title: "Аванс", adv_sum: "Сумма аванса", pay: (d) => `Выплата в пятницу, ${d}`, pay_s: "Если заявку одобрит координатор",
    adv_one: "Одна заявка за раз. Координатор рассмотрит её в ближайшее время.", adv_btn: (z) => `Заказать аванс · ${z} zł`,
    adv_pending: "Ваша заявка уже на рассмотрении.", adv_ok: (d) => `Заявка принята. Выплата в пятницу ${d}.`,
    adv_off: "Авансы на вашем объекте отключены.", hist: "История", dismissed: "Вы больше не работаете — заявки недоступны.",
    dof_title: "Выходной", dof_hint: (n) => `Выберите дни — можно несколько. Ближайшие ${n} дня заказать нельзя, только заранее.`,
    dof_hint2: (n) => `Выберите дни на ${n} дней вперёд — можно несколько.`,
    lg_sel: "выбрано", lg_ok: "одобрено", lg_wait: "на рассмотрении", lg_no: "недоступно",
    picked: (n) => `Выбрано: ${n}`, dof_btn: (n) => `Подтвердить · ${n} дн.`, dof_none: "Не выбран ни один день.",
    dof_ok: "Заявка принята.", dof_rej: (d, n) => `Отклонено: ${d}. Выходной на ближайшие ${n} дня — только заранее.`,
    dof_off: "Выходные на вашем объекте заказываются не через приложение.",
    st_cur: { active: "Действующая справка в офисе", expiring: "Справка скоро закончится", expired: "Справка закончилась", unknown: "Вы студент — дата справки неизвестна", none: "Справки в офисе ещё нет" },
    st_sent: (d) => `Отправлено ${d}`, st_until: (d) => `действует до ${d}`,
    st_new: "Новая справка", scan: "Сфотографировать", file: "Файл или PDF", add_page: "Ещё страница",
    valid: "Действует до", school: "Учебное заведение", optional: "Необязательно",
    st_hint: "Справку нужно обновлять каждый семестр. Бот напомнит за 14 дней до конца срока.",
    send_office: "Отправить в офис", need_pages: "Добавьте фото или файл справки.", need_valid: "Укажите, до какой даты действует справка.",
    pages_n: (n) => `${n} стр.`,
    dc_q: "Что отправляете? Можно несколько — получится один PDF.",
    kinds: { passport: "Паспорт", karta: "Карта побыту", other: "Другой документ" },
    kinds_s: { passport: "Страница с фото", karta: "Обе стороны", other: "Виза, PESEL, заявление…" },
    slots: { passport: ["Страница с фото"], karta: ["Лицевая сторона", "Обратная сторона"], other: ["Страница 1"] },
    page_n: (n) => `Страница ${n}`, quality: "Качество", color: "Цвет", bw: "Ч/Б",
    confirm_ok: "Документы действительны, фото чёткие и читаемые", need_kind: "Выберите документ.", need_all: (k) => `Добавьте все страницы: ${k}`,
    need_check: "Подтвердите, что фото чёткие.", pdf_n: (n) => `Будет один PDF · ${n} стр.`, uploading: "Фото ещё загружаются…",
    rotate: "Повернуть", remove: "Удалить",
    done_t: "Отправлено в офис", done_mail: "Офис получил письмо с PDF.", done_saved: "Документ сохранён — офис увидит его в панели.",
    to_chat: "Сохранить PDF в чат себе", to_chat_ok: "PDF отправлен вам в чат с ботом",
    e_title: "Не удалось открыть", e_not_linked: "Сначала войдите в бот: напишите боту свой ID, затем откройте приложение снова.",
    e_bad_init: "Не удалось проверить вход Telegram. Закройте приложение и откройте снова кнопкой в чате с ботом.",
    e_not_enabled: "Приложение пока доступно не всем — пользуйтесь кнопками бота.",
    e_outside: "Приложение открывается кнопкой «Приложение» в чате с ботом.",
    err: {
      net: "Нет связи с сервером. Попробуйте ещё раз.", server: "Ошибка сервера. Попробуйте позже.",
      bad_date: "Этот день нельзя изменить.", bad_hours: "Часы — от 0,25 до 16. Если не работали — выберите код.", bad_code: "Неизвестный код.",
      outside_period: "В этот день вы не работали на объекте — запись не сохранена.",
      disabled: "На вашем объекте это отключено.", dismissed: "Вы больше не работаете — заявки недоступны.", pending: "Ваша заявка уже на рассмотрении.",
      no_days: "Не выбран ни один день.", taken: "На эти дни заявка уже есть.", too_big: "Файл слишком большой (до 12 МБ).", bad_type: "Нужно фото или PDF.",
      bad_valid_until: "Дата «действует до» — не раньше сегодня.", bad_pages: "Добавьте страницы.", pages_gone: "Фото устарели — добавьте их снова.",
      one_pdf: "PDF можно отправить только один, без фото.", send_failed: "Не удалось отправить.", not_found: "Не найдено.",
    },
  },
  pl: {
    back: "Wstecz", retry: "Spróbuj ponownie", home: "Na główną",
    months: ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"],
    wd: ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"],
    wdl: ["Niedziela", "Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek", "Sobota"],
    hi: (n) => `Cześć, ${n}`,
    h_unit: "godz. w miesiącu", tabel: "Grafik",
    miss: (d) => `Nie wpisano: ${d}`, miss_more: (n) => `i jeszcze ${n}`, fill: "Uzupełnij", all_filled: "Wszystkie dni uzupełnione",
    t_hours: "Godziny", t_adv: "Zaliczka", t_dof: "Wolne",
    sec_docs: "Dokumenty do biura", st_title: "Zaświadczenie studenta", dc_title: "Paszport / karta pobytu",
    st_state: { none: "Jeszcze nie wysłano", active: (d) => `Ważne do ${d}`, expiring: (d) => `Wygasa ${d}`, expired: (d) => `Wygasło ${d}`, unknown: "Student · bez daty" },
    dc_last: (d) => `Wysłano ${d}`, dc_none: "Wyślij zdjęcia dokumentów",
    sec_req: "Moje wnioski", req_none: "Brak wniosków", adv_item: (z) => `Zaliczka · ${z} zł`, dof_item: (d) => `Wolne · ${d}`,
    st: { pending: "W trakcie", approved: "Zatwierdzono", rejected: "Odrzucono", paid: "Wypłacono" },
    total: (h) => `Razem ${h} godz.`, lg_h: "godziny", lg_abs: "nieobecność", lg_miss: "nie wpisano",
    how_many: "ile godzin?", other: "Inne", other_ph: "np. 7.5 lub 7:30", abs_or: "Albo kod nieobecności",
    codes: { WZ: "wg grafiku", DWZ: "od firmy", UN: "usprawiedliwiona", URL: "urlop", L4: "chorobowe", NN: "bez przyczyny" },
    pick_day: "Wybierz dzień w kalendarzu.", ro_out: "W tym dniu nie pracowałeś na obiekcie.", ro_old: "Tego dnia nie można już zmienić — zwróć się do koordynatora.",
    ro_future: "Ten dzień jeszcze nie nadszedł.", save_h: (d, v) => `Zapisz · ${d} · ${v}`, save: "Zapisz", saved: "Zapisano",
    h_val: (h) => `${h} godz.`,
    adv_title: "Zaliczka", adv_sum: "Kwota zaliczki", pay: (d) => `Wypłata w piątek, ${d}`, pay_s: "Jeśli koordynator zatwierdzi wniosek",
    adv_one: "Jeden wniosek naraz. Koordynator rozpatrzy go wkrótce.", adv_btn: (z) => `Zamów zaliczkę · ${z} zł`,
    adv_pending: "Twój wniosek jest już rozpatrywany.", adv_ok: (d) => `Wniosek przyjęty. Wypłata w piątek ${d}.`,
    adv_off: "Zaliczki na Twoim obiekcie są wyłączone.", hist: "Historia", dismissed: "Już nie pracujesz — wnioski są niedostępne.",
    dof_title: "Wolne", dof_hint: (n) => `Wybierz dni — można kilka. Najbliższych ${n} dni nie można zamówić, tylko z wyprzedzeniem.`,
    dof_hint2: (n) => `Wybierz dni na ${n} dni naprzód — można kilka.`,
    lg_sel: "wybrano", lg_ok: "zatwierdzono", lg_wait: "w trakcie", lg_no: "niedostępne",
    picked: (n) => `Wybrano: ${n}`, dof_btn: (n) => `Potwierdź · ${n} dn.`, dof_none: "Nie wybrano żadnego dnia.",
    dof_ok: "Wniosek przyjęty.", dof_rej: (d, n) => `Odrzucono: ${d}. Wolne na najbliższe ${n} dni — tylko z wyprzedzeniem.`,
    dof_off: "Wolne na Twoim obiekcie zamawia się inaczej niż przez aplikację.",
    st_cur: { active: "Ważne zaświadczenie w biurze", expiring: "Zaświadczenie wkrótce wygaśnie", expired: "Zaświadczenie wygasło", unknown: "Jesteś studentem — data zaświadczenia nieznana", none: "Biuro nie ma jeszcze zaświadczenia" },
    st_sent: (d) => `Wysłano ${d}`, st_until: (d) => `ważne do ${d}`,
    st_new: "Nowe zaświadczenie", scan: "Zrób zdjęcie", file: "Plik lub PDF", add_page: "Kolejna strona",
    valid: "Ważne do", school: "Uczelnia / szkoła", optional: "Opcjonalnie",
    st_hint: "Zaświadczenie trzeba odnawiać co semestr. Bot przypomni 14 dni przed końcem ważności.",
    send_office: "Wyślij do biura", need_pages: "Dodaj zdjęcie lub plik zaświadczenia.", need_valid: "Podaj, do kiedy zaświadczenie jest ważne.",
    pages_n: (n) => `${n} str.`,
    dc_q: "Co wysyłasz? Można kilka — powstanie jeden PDF.",
    kinds: { passport: "Paszport", karta: "Karta pobytu", other: "Inny dokument" },
    kinds_s: { passport: "Strona ze zdjęciem", karta: "Obie strony", other: "Wiza, PESEL, wniosek…" },
    slots: { passport: ["Strona ze zdjęciem"], karta: ["Przód", "Tył"], other: ["Strona 1"] },
    page_n: (n) => `Strona ${n}`, quality: "Jakość", color: "Kolor", bw: "Cz/B",
    confirm_ok: "Dokumenty są ważne, zdjęcia ostre i czytelne", need_kind: "Wybierz dokument.", need_all: (k) => `Dodaj wszystkie strony: ${k}`,
    need_check: "Potwierdź, że zdjęcia są czytelne.", pdf_n: (n) => `Jeden PDF · ${n} str.`, uploading: "Zdjęcia jeszcze się wysyłają…",
    rotate: "Obróć", remove: "Usuń",
    done_t: "Wysłano do biura", done_mail: "Biuro dostało maila z PDF.", done_saved: "Dokument zapisany — biuro zobaczy go w panelu.",
    to_chat: "Zapisz PDF w czacie", to_chat_ok: "PDF wysłany na czat z botem",
    e_title: "Nie udało się otworzyć", e_not_linked: "Najpierw zaloguj się w bocie: wpisz swój ID, potem otwórz aplikację ponownie.",
    e_bad_init: "Nie udało się sprawdzić logowania Telegram. Zamknij aplikację i otwórz ponownie przyciskiem w czacie z botem.",
    e_not_enabled: "Aplikacja nie jest jeszcze dostępna dla wszystkich — korzystaj z przycisków bota.",
    e_outside: "Aplikację otwiera się przyciskiem „Aplikacja” w czacie z botem.",
    err: {
      net: "Brak połączenia z serwerem. Spróbuj ponownie.", server: "Błąd serwera. Spróbuj później.",
      bad_date: "Tego dnia nie można zmienić.", bad_hours: "Godziny — od 0,25 do 16. Jeśli nie pracowałeś — wybierz kod.", bad_code: "Nieznany kod.",
      outside_period: "W tym dniu nie pracowałeś na obiekcie — nie zapisano.",
      disabled: "Na Twoim obiekcie jest to wyłączone.", dismissed: "Już nie pracujesz — wnioski są niedostępne.", pending: "Twój wniosek jest już rozpatrywany.",
      no_days: "Nie wybrano żadnego dnia.", taken: "Na te dni wniosek już jest.", too_big: "Plik za duży (do 12 MB).", bad_type: "Potrzebne zdjęcie lub PDF.",
      bad_valid_until: "Data „ważne do” — nie wcześniej niż dziś.", bad_pages: "Dodaj strony.", pages_gone: "Zdjęcia wygasły — dodaj je ponownie.",
      one_pdf: "Można wysłać tylko jeden PDF, bez zdjęć.", send_failed: "Nie udało się wysłać.", not_found: "Nie znaleziono.",
    },
  },
  en: {
    back: "Back", retry: "Try again", home: "Home",
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    wd: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
    wdl: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    hi: (n) => `Hello, ${n}`,
    h_unit: "hours this month", tabel: "Timesheet",
    miss: (d) => `Not filled: ${d}`, miss_more: (n) => `and ${n} more`, fill: "Fill in", all_filled: "All days filled in",
    t_hours: "Hours", t_adv: "Advance", t_dof: "Day off",
    sec_docs: "Documents to the office", st_title: "Student certificate", dc_title: "Passport / residence card",
    st_state: { none: "Not sent yet", active: (d) => `Valid until ${d}`, expiring: (d) => `Expires ${d}`, expired: (d) => `Expired ${d}`, unknown: "Student · no date" },
    dc_last: (d) => `Sent ${d}`, dc_none: "Send photos of documents",
    sec_req: "My requests", req_none: "No requests yet", adv_item: (z) => `Advance · ${z} zł`, dof_item: (d) => `Day off · ${d}`,
    st: { pending: "Pending", approved: "Approved", rejected: "Rejected", paid: "Paid" },
    total: (h) => `Total ${h} h`, lg_h: "hours", lg_abs: "absence", lg_miss: "not filled",
    how_many: "how many hours?", other: "Other", other_ph: "e.g. 7.5 or 7:30", abs_or: "Or an absence code",
    codes: { WZ: "scheduled off", DWZ: "company off", UN: "excused", URL: "leave", L4: "sick leave", NN: "unexcused" },
    pick_day: "Pick a day in the calendar.", ro_out: "You did not work at the site on this day.", ro_old: "This day can no longer be changed — ask your coordinator.",
    ro_future: "This day has not come yet.", save_h: (d, v) => `Save · ${d} · ${v}`, save: "Save", saved: "Saved",
    h_val: (h) => `${h} h`,
    adv_title: "Advance", adv_sum: "Advance amount", pay: (d) => `Paid on Friday, ${d}`, pay_s: "If your coordinator approves the request",
    adv_one: "One request at a time. Your coordinator will review it soon.", adv_btn: (z) => `Request advance · ${z} zł`,
    adv_pending: "Your request is already pending.", adv_ok: (d) => `Request received. Paid on Friday ${d}.`,
    adv_off: "Advances are turned off at your site.", hist: "History", dismissed: "You no longer work here — requests are unavailable.",
    dof_title: "Day off", dof_hint: (n) => `Pick days — several are fine. The next ${n} days can't be requested, only in advance.`,
    dof_hint2: (n) => `Pick days up to ${n} days ahead — several are fine.`,
    lg_sel: "selected", lg_ok: "approved", lg_wait: "pending", lg_no: "unavailable",
    picked: (n) => `Selected: ${n}`, dof_btn: (n) => `Confirm · ${n} d.`, dof_none: "No days selected.",
    dof_ok: "Request received.", dof_rej: (d, n) => `Rejected: ${d}. Days off within the next ${n} days — only in advance.`,
    dof_off: "Days off at your site are not requested in the app.",
    st_cur: { active: "Valid certificate at the office", expiring: "Your certificate expires soon", expired: "Your certificate has expired", unknown: "You are a student — certificate date unknown", none: "The office has no certificate yet" },
    st_sent: (d) => `Sent ${d}`, st_until: (d) => `valid until ${d}`,
    st_new: "New certificate", scan: "Take a photo", file: "File or PDF", add_page: "Another page",
    valid: "Valid until", school: "School / university", optional: "Optional",
    st_hint: "Renew the certificate every semester. The bot will remind you 14 days before it expires.",
    send_office: "Send to the office", need_pages: "Add a photo or file of the certificate.", need_valid: "Enter the date the certificate is valid until.",
    pages_n: (n) => `${n} p.`,
    dc_q: "What are you sending? Several are fine — it becomes one PDF.",
    kinds: { passport: "Passport", karta: "Residence card", other: "Other document" },
    kinds_s: { passport: "Photo page", karta: "Both sides", other: "Visa, PESEL, application…" },
    slots: { passport: ["Photo page"], karta: ["Front", "Back"], other: ["Page 1"] },
    page_n: (n) => `Page ${n}`, quality: "Quality", color: "Colour", bw: "B/W",
    confirm_ok: "Documents are valid, photos are sharp and readable", need_kind: "Choose a document.", need_all: (k) => `Add all pages: ${k}`,
    need_check: "Confirm the photos are readable.", pdf_n: (n) => `One PDF · ${n} p.`, uploading: "Photos are still uploading…",
    rotate: "Rotate", remove: "Remove",
    done_t: "Sent to the office", done_mail: "The office received an e-mail with the PDF.", done_saved: "Document saved — the office will see it in the panel.",
    to_chat: "Save the PDF to my chat", to_chat_ok: "PDF sent to your chat with the bot",
    e_title: "Could not open", e_not_linked: "Log in to the bot first: send your ID to the bot, then open the app again.",
    e_bad_init: "Could not verify the Telegram login. Close the app and open it again with the button in the bot chat.",
    e_not_enabled: "The app is not available to everyone yet — use the bot buttons.",
    e_outside: "Open the app with the “App” button in the chat with the bot.",
    err: {
      net: "No connection to the server. Try again.", server: "Server error. Try later.",
      bad_date: "This day can't be changed.", bad_hours: "Hours — from 0.25 to 16. If you did not work — choose a code.", bad_code: "Unknown code.",
      outside_period: "You did not work at the site on this day — not saved.",
      disabled: "This is turned off at your site.", dismissed: "You no longer work here — requests are unavailable.", pending: "Your request is already pending.",
      no_days: "No days selected.", taken: "There is already a request for these days.", too_big: "File too big (up to 12 MB).", bad_type: "A photo or PDF is needed.",
      bad_valid_until: "“Valid until” can't be before today.", bad_pages: "Add pages.", pages_gone: "Photos expired — add them again.",
      one_pdf: "Only one PDF can be sent, without photos.", send_failed: "Could not send.", not_found: "Not found.",
    },
  },
};

const CODES = ["WZ", "DWZ", "UN", "URL", "L4", "NN"];
const CODE_LBL = { WZ: "DW", DWZ: "DWZ", UN: "UN", URL: "URL", L4: "L4", NN: "NN" };
const KINDS = ["passport", "karta", "other"];
const CHIPS = { whole: [6, 8, 10, 11, 12], quarter: [7.75, 8.75, 9.75, 10.75, 11.75], both: [8, 8.75, 10, 11, 11.75] };

const ST = {
  lang: "uk", me: null, view: "home",
  hours: { ym: null, data: null, sel: null, val: null, other: "" },
  dof: { sel: new Set() },
  stud: { pages: [], valid: "", school: "" },
  docs: { kinds: new Set(), pages: { passport: [], karta: [], other: [] }, bw: false, ok: false },
  done: null, pick: null, busy: false,
};
const T = () => L[ST.lang] || L.uk;

// ── Допоміжне ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const warsawToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date());
const today = () => (ST.me && ST.me.today) || warsawToday();
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const addMonths = (ym, n) => { const d = new Date(`${ym}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const dd = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const ddY = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const fmtH = (h) => { const n = Math.round(Number(h) * 100) / 100; return String(n).replace(".", ST.lang === "en" ? "." : ","); };
const isoOf = (ts) => (ts ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date(ts)) : "");
const monthTitle = (ym) => `${T().months[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const inPeriods = (ps, iso) => (ps || []).some((p) => p.from <= iso && (!p.to || p.to >= iso));
const cap = (s) => String(s || "").toLowerCase().replace(/(^|[\s-])(\S)/g, (m, a, b) => a + b.toUpperCase());
function firstName(full) {
  const p = String(full || "").trim().split(/\s+/);
  return cap(p.length > 1 ? p[1] : p[0] || "");
}
const initials = (full) => String(full || "").trim().split(/\s+/).slice(0, 2).map((x) => x[0] || "").join("").toUpperCase();
const errText = (code) => T().err[code] || T().err.server;

const I = {
  chev: `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  left: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`,
  right: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
  clock: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  card: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20M16 15h2"/></svg>`,
  cal: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  calx: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M10 14l4 4M14 14l-4 4"/></svg>`,
  cap: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>`,
  id: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.8-1.5 5.2-1.5 6 0M15 10h3M15 14h3"/></svg>`,
  warn: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`,
  ok: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>`,
  info: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>`,
  scan: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>`,
  file: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15l3-3 3 3"/></svg>`,
  rot: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  x: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  sent: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.5 3 3 6-7"/></svg>`,
};

function toast(text, bad) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (bad ? " bad" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  haptic(bad ? "error" : "success");
}
function haptic(kind) {
  try { if (TGW && TGW.HapticFeedback) TGW.HapticFeedback.notificationOccurred(kind); } catch (e) { /* старий клієнт */ }
}
function bar(html) {
  $("bar").innerHTML = html || "";
  $("bar").hidden = !html;
  document.body.classList.toggle("has-bar", !!html);
}

// ── Сервер ──────────────────────────────────────────────────────────────
async function api(path, o) {
  o = o || {};
  if (DEMO) return demoApi(path, o);
  const h = { "x-tg-init": TGW ? TGW.initData : "" };
  let body = o.body;
  if (o.raw) h["Content-Type"] = o.type;
  else if (body !== undefined) { h["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  try {
    const r = await fetch("/api/wapp" + path, { method: o.method || (body !== undefined ? "POST" : "GET"), headers: h, body });
    return await r.json().catch(() => ({ ok: false, error: r.status === 413 ? "too_big" : "server" }));
  } catch (e) {
    return { ok: false, error: "net" };
  }
}

// ── Старт ───────────────────────────────────────────────────────────────
function hashRoute() {
  const raw = (location.hash || "").replace(/^#/, "");
  return raw.replace(/(^|[#&?])tgWebApp[\s\S]*$/, "").split("&")[0] || "";
}
function onBack() {
  if (ST.done) { ST.done = null; return go("home"); }
  if (ST.view !== "home") go("home");
}
async function boot() {
  const first = hashRoute();
  let dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (TGW) {
    try {
      TGW.ready();
      TGW.expand();
      dark = TGW.colorScheme === "dark";
      TGW.setHeaderColor("secondary_bg_color");
      TGW.setBackgroundColor("secondary_bg_color");
      TGW.onEvent("themeChanged", () => { document.documentElement.dataset.theme = TGW.colorScheme === "dark" ? "dark" : "light"; });
    } catch (e) { /* старий клієнт */ }
    try { TGW.BackButton.onClick(onBack); } catch (e) { /* без кнопки «Назад» */ }
    try { history.replaceState(null, "", location.pathname + location.search + "#" + (first || "home")); } catch (e) { /* не страшно */ }
    const code = TGW.initDataUnsafe && TGW.initDataUnsafe.user && TGW.initDataUnsafe.user.language_code;
    ST.lang = L[String(code || "").slice(0, 2)] ? String(code).slice(0, 2) : "uk";
  } else if (DEMO) {
    const m = /[?&]lang=(uk|ru|pl|en)\b/.exec(location.search);
    if (m) ST.lang = m[1];
  }
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (!TGW && !DEMO) return showError("outside");
  const r = await api("/me");
  if (!r.ok) return showError(r.error);
  setMe(r);
  window.addEventListener("hashchange", route);
  $("camIn").addEventListener("change", (e) => onFiles(e.target));
  $("fileIn").addEventListener("change", (e) => onFiles(e.target));
  route();
}
function setMe(r) {
  ST.me = r;
  if (L[r.lang] && !(DEMO && /[?&]lang=/.test(location.search))) ST.lang = r.lang;
  document.documentElement.lang = ST.lang;
}
async function refreshMe() {
  const r = await api("/me");
  if (r.ok) setMe(r);
}
function showError(code) {
  const t = T();
  bar("");
  const d = { not_linked: t.e_not_linked, not_enabled: t.e_not_enabled, bad_init: t.e_bad_init, outside: t.e_outside }[code] || errText(code);
  $("view").innerHTML = `<div class="msg"><b>${esc(code === "outside" ? "SAS Praca" : t.e_title)}</b><p>${esc(d)}</p>
    ${code === "outside" ? "" : `<button class="btn sec" style="max-width:260px" onclick="location.reload()">${esc(t.retry)}</button>`}</div>`;
}

// ── Маршрути ────────────────────────────────────────────────────────────
function go(v) {
  if (hashRoute() === v) route(); else location.hash = "#" + v;
}
function route() {
  const v = hashRoute();
  const view = ["home", "hours", "adv", "dof", "student", "docs"].includes(v) ? v : "home";
  if (view !== ST.view) ST.done = null;
  ST.view = view;
  if (TGW) { try { if (view === "home" && !ST.done) TGW.BackButton.hide(); else TGW.BackButton.show(); } catch (e) { /* старий клієнт */ } }
  window.scrollTo(0, 0);
  if (ST.done) return renderDone();
  if (view === "hours") return renderHours(true);
  if (view === "adv") return renderAdv();
  if (view === "dof") { ST.dof.sel = new Set(); return renderDof(); }
  if (view === "student") return renderStudent();
  if (view === "docs") return renderDocs();
  return renderHome();
}
const loading = () => { $("view").innerHTML = `<div class="center"><div class="spin" aria-hidden="true"></div></div>`; };

// ── Головна ─────────────────────────────────────────────────────────────
async function renderHome() {
  bar("");
  await refreshMe();
  const t = T(), m = ST.me, w = m.worker;
  const miss = m.month.missing;
  const missTxt = miss.slice(0, 4).map(dd).join(", ") + (miss.length > 4 ? ` ${t.miss_more(miss.length - 4)}` : "");
  const st = m.student || { state: "none" };
  const stTxt = typeof t.st_state[st.state] === "function" ? t.st_state[st.state](ddY(st.valid_until)) : t.st_state[st.state];
  const stCls = { active: "ok", expiring: "warn", expired: "bad" }[st.state] || "";
  const lastDoc = (m.docs || []).find((d) => !d.kinds.includes("student"));
  const reqs = [];
  for (const a of m.advance.history.slice(0, 3)) reqs.push({ t: t.adv_item(m.advance.amount), s: a.status, at: a.date, sub: ddY(a.date) });
  for (const d of m.dayoff.history.slice(0, 3)) reqs.push({ t: t.dof_item(d.days.map(dd).join(", ")), s: d.status, at: d.days[0] || "" , sub: "" });
  const month = today().slice(0, 7);
  const tiles = [
    { v: "hours", ic: I.clock, c: "blue", l: t.t_hours, on: true },
    { v: "adv", ic: I.card, c: "green", l: t.t_adv, on: m.advance.enabled },
    { v: "dof", ic: I.calx, c: "violet", l: t.t_dof, on: m.dayoff.enabled },
  ];
  $("view").innerHTML = `
    <div class="hello"><div class="ava" aria-hidden="true">${esc(initials(w.name))}</div>
      <div><b>${esc(t.hi(firstName(w.name)))}</b><span class="muted">ID ${esc(w.login)}${w.facility ? ` · ${esc(w.facility)}` : ""}</span></div></div>
    <section class="card">
      <div class="mrow"><span class="muted">${esc(monthTitle(month))}</span><a href="#hours" style="font-size:14px;font-weight:500;text-decoration:none">${esc(t.tabel)}</a></div>
      <div class="big"><b>${esc(fmtH(m.month.total))}</b><span>${esc(t.h_unit)}</span></div>
      ${miss.length
        ? `<button class="alert warn" onclick="go('hours')">${I.warn}<span class="t">${esc(t.miss(missTxt))}</span><span class="a">${esc(t.fill)}</span></button>`
        : `<div class="alert ok">${I.ok}<span class="t">${esc(t.all_filled)}</span></div>`}
    </section>
    <div class="tiles">${tiles.map((x) => `<button class="tile" onclick="go('${x.v}')" ${x.on ? "" : "disabled"}>
      <span class="ib ${x.c}">${x.ic}</span><span>${esc(x.l)}</span></button>`).join("")}</div>
    <section class="card flush">
      <h2 class="sec-t">${esc(t.sec_docs)}</h2>
      <button class="li" onclick="go('student')">${I.cap}<span class="l"><b>${esc(t.st_title)}</b><small class="${stCls}">${esc(stTxt)}</small></span>${I.chev}</button>
      <button class="li" onclick="go('docs')">${I.id}<span class="l"><b>${esc(t.dc_title)}</b><small>${esc(lastDoc ? t.dc_last(ddY(isoOf(lastDoc.created_at))) : t.dc_none)}</small></span>${I.chev}</button>
    </section>
    <section class="card flush" style="padding-bottom:6px">
      <h2 class="sec-t">${esc(t.sec_req)}</h2>
      ${reqs.length ? reqs.map((x) => `<div class="req"><span class="l"><span>${esc(x.t)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</span>
        <span class="pill ${esc(x.s)}">${esc(t.st[x.s] || x.s)}</span></div>`).join("") : `<div class="empty">${esc(t.req_none)}</div>`}
    </section>`;
}

// ── Години ──────────────────────────────────────────────────────────────
async function renderHours(reset) {
  const h = ST.hours;
  if (reset) { h.ym = today().slice(0, 7); h.sel = null; h.val = null; }
  if (!h.data || h.data.month !== h.ym || reset) {
    loading();
    bar("");
    const r = await api(`/hours?month=${h.ym}`);
    if (!r.ok) return showError(r.error);
    h.data = r;
    if (!h.sel) pickDefaultDay();
  }
  drawHours();
}
function dayInfo(iso) {
  const d = ST.hours.data;
  const rec = d.days[iso];
  const inP = inPeriods(d.periods, iso);
  const edit = inP && iso >= d.edit.from && iso <= d.edit.to;
  return { rec, inP, edit, future: iso > d.edit.to, old: iso < d.edit.from };
}
function pickDefaultDay() {
  const h = ST.hours, d = h.data;
  const t0 = today();
  const last = `${h.ym}-${String(new Date(Date.UTC(Number(h.ym.slice(0, 4)), Number(h.ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  for (let x = `${h.ym}-01`; x <= last && x < t0; x = addDays(x, 1)) {
    const i = dayInfo(x);
    if (i.edit && !i.rec) return selectDay(x, true);
  }
  if (h.ym === t0.slice(0, 7) && dayInfo(t0).edit) return selectDay(t0, true);
  h.sel = null;
}
function selectDay(iso, quiet) {
  const h = ST.hours;
  h.sel = iso;
  const rec = h.data.days[iso];
  h.val = rec ? (rec.abs ? { abs: rec.abs } : { h: rec.h }) : null;
  h.other = rec && rec.h != null && !(CHIPS[h.data.hours_format] || CHIPS.whole).includes(rec.h) ? fmtH(rec.h) : "";
  if (!quiet) drawHours();
}
function drawHours() {
  const t = T(), h = ST.hours, d = h.data;
  const ym = h.ym;
  const first = `${ym}-01`;
  const days = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  const lead = (dow(first) + 6) % 7;
  const t0 = today();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<span class="day blank" aria-hidden="true"></span>`);
  for (let n = 1; n <= days; n++) {
    const iso = `${ym}-${String(n).padStart(2, "0")}`;
    const i = dayInfo(iso);
    const cls = ["day"];
    let v = "";
    if (i.rec && i.rec.abs) { cls.push("abs"); v = CODE_LBL[i.rec.abs] || i.rec.abs; }
    else if (i.rec) { cls.push("h"); v = fmtH(i.rec.h); }
    else if (i.inP && iso < t0) { cls.push("miss"); v = "—"; }
    if (!i.inP || i.future) cls.push("off");
    if (iso === t0) cls.push("today");
    if (iso === h.sel) cls.push("sel");
    const label = `${dd(iso)}${v ? " " + v : ""}`;
    cells.push(`<button class="${cls.join(" ")}" onclick="selectDay('${iso}')" aria-label="${esc(label)}" aria-pressed="${iso === h.sel}">
      <span class="n">${n}</span><span class="v">${esc(v)}</span></button>`);
  }
  const canPrev = ym > d.min_month, canNext = ym < t0.slice(0, 7);
  const sel = h.sel ? dayInfo(h.sel) : null;
  let panel;
  if (!h.sel) panel = `<p class="note">${I.info}<span>${esc(t.pick_day)}</span></p>`;
  else if (!sel.edit) {
    const why = !sel.inP ? t.ro_out : sel.future ? t.ro_future : t.ro_old;
    panel = `<div class="dayttl"><b>${esc(t.wdl[dow(h.sel)])}, ${esc(dd(h.sel))}</b></div><p class="note">${I.info}<span>${esc(why)}</span></p>`;
  } else {
    const chips = CHIPS[d.hours_format] || CHIPS.whole;
    const v = h.val || {};
    const otherOn = v.h != null && !chips.includes(v.h);
    panel = `<div class="dayttl"><b>${esc(t.wdl[dow(h.sel)])}, ${esc(dd(h.sel))}</b><span class="muted">${esc(t.how_many)}</span></div>
      <div class="chips">${chips.map((c) => `<button class="chip ${v.h === c ? "on" : ""}" onclick="setVal({h:${c}})">${esc(fmtH(c))}</button>`).join("")}</div>
      <label class="fld"><span>${esc(t.other)}</span>
        <input id="hOther" class="inp" inputmode="decimal" autocomplete="off" placeholder="${esc(t.other_ph)}" value="${esc(otherOn ? fmtH(v.h) : h.other)}" oninput="onOther(this.value)" /></label>
      <span class="muted">${esc(t.abs_or)}</span>
      <div class="codes">${CODES.map((c) => `<button class="code ${v.abs === c ? "on" : ""}" onclick="setVal({abs:'${c}'})"><b>${CODE_LBL[c]}</b><small>${esc(t.codes[c])}</small></button>`).join("")}</div>`;
  }
  $("view").innerHTML = `
    <section class="card" style="padding:12px 12px 14px;gap:10px">
      <div class="calhead">
        <button class="nav" onclick="shiftMonth(-1)" ${canPrev ? "" : "disabled"} aria-label="${esc(t.back)}">${I.left}</button>
        <div class="c"><b>${esc(monthTitle(ym))}</b><span class="muted">${esc(t.total(fmtH(d.total)))}</span></div>
        <button class="nav" onclick="shiftMonth(1)" ${canNext ? "" : "disabled"} aria-label="›">${I.right}</button>
      </div>
      <div class="cal">${t.wd.map((x) => `<span class="wd">${esc(x)}</span>`).join("")}${cells.join("")}</div>
      <div class="legend"><span><i style="background:var(--blue-bg)"></i>${esc(t.lg_h)}</span><span><i style="background:var(--soft2)"></i>${esc(t.lg_abs)}</span>
        <span><i style="box-shadow:inset 0 0 0 1.5px var(--amber-line)"></i>${esc(t.lg_miss)}</span></div>
    </section>
    <section class="card">${panel}</section>`;
  drawHoursBar();
}
function valText(v) {
  if (!v) return "";
  return v.abs ? CODE_LBL[v.abs] : T().h_val(fmtH(v.h));
}
function drawHoursBar() {
  const t = T(), h = ST.hours;
  const sel = h.sel ? dayInfo(h.sel) : null;
  if (!sel || !sel.edit) return bar("");
  const ok = !!h.val && (h.val.abs || (h.val.h > 0 && h.val.h <= h.data.hours_max));
  bar(`<button class="btn" onclick="saveHours()" ${ok && !ST.busy ? "" : "disabled"}>${esc(ok ? t.save_h(dd(h.sel), valText(h.val)) : t.save)}</button>`);
}
function setVal(v) {
  ST.hours.val = v;
  ST.hours.other = "";
  drawHours();
}
function parseHours(s) {
  s = String(s || "").trim();
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (m) return Math.round((Number(m[1]) + Number(m[2]) / 60) * 100) / 100;
  const n = Number(s.replace(",", "."));
  return s && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function onOther(s) {
  const h = ST.hours;
  h.other = s;
  const n = parseHours(s);
  h.val = n != null && n > 0 ? { h: n } : null;
  document.querySelectorAll(".chip.on, .code.on").forEach((el) => el.classList.remove("on"));
  drawHoursBar();
}
async function shiftMonth(n) {
  const h = ST.hours;
  h.ym = addMonths(h.ym, n);
  h.sel = null;
  h.val = null;
  await renderHours(false);
}
async function saveHours() {
  const h = ST.hours, t = T();
  if (!h.sel || !h.val || ST.busy) return;
  if (h.val.h != null && !(h.val.h > 0 && h.val.h <= h.data.hours_max)) return toast(t.err.bad_hours, true);
  ST.busy = true;
  drawHoursBar();
  const r = await api("/hours", { body: { date: h.sel, ...(h.val.abs ? { abs: h.val.abs } : { hours: h.val.h }) } });
  ST.busy = false;
  if (!r.ok) { drawHoursBar(); return toast(errText(r.error), true); }
  toast(`${t.saved}: ${dd(h.sel)} · ${valText(h.val)}`);
  h.data.days[h.sel] = h.val.abs ? { abs: h.val.abs } : { h: h.val.h };
  const fresh = await api(`/hours?month=${h.ym}`);
  if (fresh.ok) h.data = fresh;
  pickDefaultDay();
  drawHours();
}

// ── Аванс ───────────────────────────────────────────────────────────────
function renderAdv() {
  const t = T(), a = ST.me.advance, w = ST.me.worker;
  const block = !a.enabled ? t.adv_off : w.dismissed ? t.dismissed : a.pending ? t.adv_pending : "";
  $("view").innerHTML = `
    <section class="card"><div class="amount"><span class="muted">${esc(t.adv_sum)}</span><b>${esc(a.amount)}<small>zł</small></b></div></section>
    <section class="card flush">
      <div class="li" style="cursor:default">${I.cal}<span class="l"><b>${esc(t.pay(dd(a.pay_date)))}</b><small>${esc(t.pay_s)}</small></span></div>
    </section>
    ${block ? `<div class="banner warn">${I.info}<span class="l"><b>${esc(block)}</b></span></div>` : ""}
    <section class="card flush" style="padding-bottom:6px">
      <h2 class="sec-t">${esc(t.hist)}</h2>
      ${a.history.length ? a.history.map((x) => `<div class="req"><span class="l"><span>${esc(a.amount)} zł</span><small>${esc(ddY(x.date))}${x.note && x.status === "rejected" ? ` · ${esc(x.note)}` : ""}</small></span>
        <span class="pill ${esc(x.status)}">${esc(t.st[x.status] || x.status)}</span></div>`).join("") : `<div class="empty">${esc(t.req_none)}</div>`}
    </section>`;
  bar(`<span class="muted">${esc(t.adv_one)}</span><button class="btn" onclick="sendAdv()" ${block || ST.busy ? "disabled" : ""}>${esc(t.adv_btn(a.amount))}</button>`);
}
async function sendAdv() {
  if (ST.busy) return;
  ST.busy = true;
  renderAdv();
  const r = await api("/advance", { body: {} });
  ST.busy = false;
  if (!r.ok) { toast(errText(r.error), true); await refreshMe(); return renderAdv(); }
  toast(T().adv_ok(dd(r.pay_date)));
  await refreshMe();
  renderAdv();
}

// ── Вихідні ─────────────────────────────────────────────────────────────
function renderDof() {
  const t = T(), o = ST.me.dayoff, w = ST.me.worker;
  const t0 = today();
  const firstD = addDays(t0, 1), lastD = addDays(t0, o.horizon);
  const start = addDays(firstD, -((dow(firstD) + 6) % 7));
  const end = addDays(lastD, (7 - dow(lastD)) % 7);
  const near = new Set(o.near || []);
  const cells = [];
  for (let x = start; x <= end; x = addDays(x, 1)) {
    const cls = ["day"];
    const n = Number(x.slice(8, 10));
    const label = n === 1 || x === start ? `${n}.${x.slice(5, 7)}` : String(n);
    let can = false;
    if (x < firstD || x > lastD) cls.push("off");
    else if (near.has(x)) cls.push("near");
    else if (o.taken[x] === "approved") cls.push("ok");
    else if (o.taken[x] === "pending") cls.push("wait");
    else { can = true; if (ST.dof.sel.has(x)) cls.push("dsel"); }
    if (x === t0) cls.push("today");
    cells.push(`<button class="${cls.join(" ")}" ${can ? `onclick="toggleDof('${x}')" aria-pressed="${ST.dof.sel.has(x)}"` : `disabled aria-disabled="true"`} aria-label="${esc(dd(x))}">
      <span class="n">${esc(label)}</span><span class="v"></span></button>`);
  }
  const block = !o.enabled ? t.dof_off : w.dismissed ? t.dismissed : "";
  const sel = [...ST.dof.sel].sort();
  const months = [...new Set([firstD.slice(0, 7), lastD.slice(0, 7)])].map(monthTitle).join(" – ");
  $("view").innerHTML = `
    <p class="lead">${esc(near.size ? t.dof_hint(o.min_days) : t.dof_hint2(o.horizon))}</p>
    ${block ? `<div class="banner warn">${I.info}<span class="l"><b>${esc(block)}</b></span></div>` : ""}
    <section class="card" style="padding:12px 12px 14px;gap:10px">
      <div class="calhead" style="justify-content:center;min-height:32px"><b>${esc(months)}</b></div>
      <div class="cal">${t.wd.map((x) => `<span class="wd">${esc(x)}</span>`).join("")}${cells.join("")}</div>
      <div class="legend"><span><i style="background:var(--violet)"></i>${esc(t.lg_sel)}</span><span><i style="background:var(--green-bg)"></i>${esc(t.lg_ok)}</span>
        <span><i style="box-shadow:inset 0 0 0 1.5px var(--violet)"></i>${esc(t.lg_wait)}</span><span><i style="background:var(--soft2)"></i>${esc(t.lg_no)}</span></div>
    </section>
    ${sel.length ? `<section class="card"><span class="muted" style="font-weight:600;text-transform:uppercase;letter-spacing:.04em">${esc(t.picked(sel.length))}</span>
      <div style="display:flex;flex-wrap:wrap;gap:8px">${sel.map((x) => `<span class="pill" style="background:var(--violet-bg);color:var(--violet-t);font-size:14px;padding:6px 10px">${esc(t.wd[(dow(x) + 6) % 7])} ${esc(dd(x))}</span>`).join("")}</div></section>` : ""}
    <section class="card flush" style="padding-bottom:6px">
      <h2 class="sec-t">${esc(t.hist)}</h2>
      ${o.history.length ? o.history.map((x) => `<div class="req"><span class="l"><span>${esc(x.days.map(dd).join(", "))}</span>${x.note && x.status === "rejected" ? `<small>${esc(x.note)}</small>` : ""}</span>
        <span class="pill ${esc(x.status)}">${esc(t.st[x.status] || x.status)}</span></div>`).join("") : `<div class="empty">${esc(t.req_none)}</div>`}
    </section>`;
  bar(block ? "" : `<button class="btn" onclick="sendDof()" ${sel.length && !ST.busy ? "" : "disabled"}>${esc(sel.length ? t.dof_btn(sel.length) : t.dof_none)}</button>`);
}
function toggleDof(x) {
  if (ST.dof.sel.has(x)) ST.dof.sel.delete(x); else ST.dof.sel.add(x);
  renderDof();
}
async function sendDof() {
  const t = T();
  const dates = [...ST.dof.sel].sort();
  if (!dates.length || ST.busy) return;
  ST.busy = true;
  renderDof();
  const r = await api("/dayoff", { body: { dates } });
  ST.busy = false;
  if (!r.ok) { toast(errText(r.error), true); return renderDof(); }
  ST.dof.sel = new Set();
  if (r.rejected && r.rejected.length) toast(t.dof_rej(r.rejected.map(dd).join(", "), r.min_days), !r.accepted.length);
  else toast(t.dof_ok);
  await refreshMe();
  renderDof();
}

// ── Фото сторінок ───────────────────────────────────────────────────────
let PKEY = 0;
function newPage(file, kind) {
  return { key: ++PKEY, file, kind, rot: 0, id: null, state: "up", url: null, type: kind, name: file.name || "", size: file.size || 0 };
}
async function loadImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* нижче — через <img> */ }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
// Ч/Б: яскравість, розтягнута між 2-м і 98-м процентилями (фон світлішає, текст темнішає)
function toBw(g, w, h) {
  const im = g.getImageData(0, 0, w, h), px = im.data;
  const hist = new Uint32Array(256);
  const Y = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const y = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8; Y[j] = y; hist[y]++; }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) { const y = Math.max(0, Math.min(255, (Y[j] - lo) * k)); px[i] = px[i + 1] = px[i + 2] = y; }
  g.putImageData(im, 0, 0);
}
async function makeJpeg(file, rot, bw) {
  const img = await loadImage(file);
  const k = Math.min(1, MAXPX / Math.max(img.width, img.height));
  const w = Math.round(img.width * k), h = Math.round(img.height * k);
  const r = ((rot % 360) + 360) % 360;
  const c = document.createElement("canvas");
  c.width = r % 180 ? h : w;
  c.height = r % 180 ? w : h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2);
  g.rotate((r * Math.PI) / 180);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (bw) toBw(g, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", JPEG_Q));
}
async function uploadPage(p, bw) {
  p.state = "up";
  p.id = null;
  try {
    let blob = p.file, type = "application/pdf";
    if (p.type !== "pdf") {
      blob = await makeJpeg(p.file, p.rot, bw);
      type = "image/jpeg";
      if (p.url) URL.revokeObjectURL(p.url);
      p.url = URL.createObjectURL(blob);
    }
    redraw();
    const r = await api("/pages", { raw: true, type, body: blob });
    if (!r.ok) { p.state = "err"; toast(errText(r.error), true); }
    else { p.id = r.id; p.state = "ok"; p.size = blob.size; }
  } catch (e) {
    p.state = "err";
    toast(errText("bad_type"), true);
  }
  redraw();
}
const redraw = () => { if (ST.view === "student" && !ST.done) renderStudent(); else if (ST.view === "docs" && !ST.done) renderDocs(); };

// Куди піде наступне фото: { where: "student" } або { where: "docs", kind, idx }
function pick(where, kind, idx, fromFile) {
  ST.pick = { where, kind, idx };
  const el = fromFile ? $("fileIn") : $("camIn");
  el.value = "";
  el.click();
}
function onFiles(input) {
  const files = [...(input.files || [])];
  input.value = "";
  const p0 = ST.pick;
  if (!files.length || !p0) return;
  const f = files[0];
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
  if (f.size > 12 * 1024 * 1024 && isPdf) return toast(errText("too_big"), true);
  const p = newPage(f, isPdf ? "pdf" : "jpg");
  if (p0.where === "student") {
    // PDF — лише один, без фото; фото — до 10 сторінок
    if (isPdf) ST.stud.pages = [p];
    else { ST.stud.pages = ST.stud.pages.filter((x) => x.type !== "pdf"); ST.stud.pages.push(p); }
    uploadPage(p, false);
  } else {
    if (isPdf) return toast(errText("bad_type"), true);
    const arr = ST.docs.pages[p0.kind];
    if (p0.idx < arr.length) arr[p0.idx] = p; else arr.push(p);
    uploadPage(p, ST.docs.bw);
  }
  renderView();
}
const renderView = () => (ST.view === "student" ? renderStudent() : renderDocs());
function pageOf(where, kind, idx) { return where === "student" ? ST.stud.pages[idx] : ST.docs.pages[kind][idx]; }
function rotatePage(where, kind, idx) {
  const p = pageOf(where, kind, idx);
  if (!p || p.type === "pdf" || p.state === "up") return;
  p.rot = (p.rot + 90) % 360;
  uploadPage(p, where === "docs" && ST.docs.bw);
}
function removePage(where, kind, idx) {
  const arr = where === "student" ? ST.stud.pages : ST.docs.pages[kind];
  const p = arr[idx];
  if (p && p.url) URL.revokeObjectURL(p.url);
  arr.splice(idx, 1);
  renderView();
}
function shotHtml(p, where, kind, idx, label) {
  const t = T();
  const args = `'${where}','${kind || ""}',${idx}`;
  if (p.type === "pdf") {
    return `<div class="filebox"><span class="pdf">PDF</span><span class="l"><b>${esc(p.name || "PDF")}</b><small class="muted">${p.state === "up" ? esc(t.uploading) : `${Math.max(1, Math.round(p.size / 1024))} KB`}</small></span>
      <button class="x" onclick="removePage(${args})" aria-label="${esc(t.remove)}">${I.x}</button></div>`;
  }
  const badge = p.state === "up" ? `<span class="st"><span class="spin" style="width:20px;height:20px;border-width:2px"></span></span>`
    : p.state === "err" ? `<span class="st pill rejected">!</span>` : "";
  return `<div class="slot">${label ? `<span>${esc(label)}</span>` : ""}<div class="shot">${p.url ? `<img src="${p.url}" alt="${esc(label || "")}" />` : ""}${badge}
    <span class="acts"><button class="mini" onclick="rotatePage(${args})" aria-label="${esc(t.rotate)}">${I.rot}</button>
    <button class="mini" onclick="removePage(${args})" aria-label="${esc(t.remove)}">${I.x}</button></span></div></div>`;
}
function addHtml(where, kind, idx, label, text) {
  return `<div class="slot">${label ? `<span>${esc(label)}</span>` : ""}<button class="add" onclick="pick('${where}','${kind || ""}',${idx})">${I.scan}<span>${esc(text)}</span></button></div>`;
}

// ── Довідка студента ────────────────────────────────────────────────────
function renderStudent() {
  const t = T(), s = ST.stud, st = ST.me.student || { state: "none" };
  const cls = { active: "ok", expiring: "warn", expired: "bad" }[st.state] || "none";
  const sub = [st.doc_at ? t.st_sent(ddY(isoOf(st.doc_at))) : "", st.valid_until ? t.st_until(ddY(st.valid_until)) : ""].filter(Boolean).join(" · ");
  const isPdf = s.pages.length === 1 && s.pages[0].type === "pdf";
  const imgs = isPdf ? "" : s.pages.map((p, i) => shotHtml(p, "student", "", i, t.page_n(i + 1))).join("");
  if (!s.valid) s.valid = "";
  $("view").innerHTML = `
    <div class="banner ${cls}">${st.state === "none" ? I.cap : st.state === "active" ? I.ok : I.warn}
      <span class="l"><b>${esc(t.st_cur[st.state] || t.st_cur.none)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</span></div>
    <section class="card">
      <b style="font-size:17px">${esc(t.st_new)}</b>
      ${isPdf ? shotHtml(s.pages[0], "student", "", 0) : imgs ? `<div class="slots">${imgs}</div>` : ""}
      <div class="slots">
        <button class="add" style="height:92px;border-color:var(--blue-t);background:var(--blue-bg);color:var(--blue-t)" onclick="pick('student','',${s.pages.length})">${I.scan}<span>${esc(s.pages.length && !isPdf ? t.add_page : t.scan)}</span></button>
        <button class="add" style="height:92px;color:var(--text)" onclick="pick('student','',${s.pages.length},true)">${I.file}<span>${esc(t.file)}</span></button>
      </div>
      <div class="grid2">
        <label class="fld"><span>${esc(t.valid)}</span><input class="inp" type="date" min="${today()}" value="${esc(s.valid)}" onchange="ST.stud.valid=this.value;drawStudentBar()" /></label>
        <label class="fld"><span>${esc(t.school)}</span><input class="inp" placeholder="${esc(t.optional)}" value="${esc(s.school)}" oninput="ST.stud.school=this.value" /></label>
      </div>
    </section>
    <p class="note">${I.info}<span>${esc(t.st_hint)}</span></p>`;
  drawStudentBar();
}
function drawStudentBar() {
  const t = T(), s = ST.stud;
  const up = s.pages.some((p) => p.state === "up");
  const why = !s.pages.length ? t.need_pages : up ? t.uploading : !s.valid ? t.need_valid : "";
  bar(`${why ? `<span class="muted">${esc(why)}</span>` : ""}<button class="btn" onclick="sendStudent()" ${why || ST.busy ? "disabled" : ""}>${esc(t.send_office)}</button>`);
}
async function sendStudent() {
  const s = ST.stud;
  if (ST.busy || !s.pages.length || !s.valid) return;
  if (s.pages.some((p) => p.state !== "ok")) return toast(T().uploading, true);
  ST.busy = true;
  drawStudentBar();
  const r = await api("/docs", { body: { kinds: ["student"], pages: s.pages.map((p) => p.id), valid_until: s.valid, school: s.school } });
  ST.busy = false;
  if (!r.ok) { drawStudentBar(); return toast(errText(r.error), true); }
  ST.stud = { pages: [], valid: "", school: "" };
  await refreshMe();
  ST.done = r;
  renderDone();
}

// ── Паспорт / карта побиту / інше ───────────────────────────────────────
function docsNeed() {
  const d = ST.docs, t = T();
  const missing = [];
  let n = 0;
  for (const k of KINDS) {
    if (!d.kinds.has(k)) continue;
    const need = t.slots[k].length;
    const got = d.pages[k].length;
    n += got;
    if (got < need) missing.push(t.kinds[k]);
  }
  return { missing, n };
}
function renderDocs() {
  const t = T(), d = ST.docs;
  $("view").innerHTML = `
    <p class="lead">${esc(t.dc_q)}</p>
    ${KINDS.map((k) => {
      const on = d.kinds.has(k);
      const need = t.slots[k].length, pages = d.pages[k];
      const extra = k !== "karta";   // паспорт / інше — можна більше сторінок
      const slots = [];
      for (let i = 0; i < Math.max(need, pages.length); i++) {
        const label = t.slots[k][i] || t.page_n(i + 1);
        slots.push(pages[i] ? shotHtml(pages[i], "docs", k, i, label) : addHtml("docs", k, i, label, t.scan));
      }
      if (extra && pages.length >= need) slots.push(addHtml("docs", k, pages.length, t.page_n(pages.length + 1), t.add_page));
      return `<section class="card kind ${on ? "on" : ""}">
        <label class="top"><input type="checkbox" ${on ? "checked" : ""} onchange="toggleKind('${k}', this.checked)" />
          <span class="l"><b>${esc(t.kinds[k])}</b><span class="muted">${esc(t.kinds_s[k])}</span></span>
          ${on ? `<span class="pill ${pages.length >= need ? "ok" : "pending"}">${Math.min(pages.length, 99)} / ${need}</span>` : ""}</label>
        ${on ? `<div class="slots">${slots.join("")}</div>` : ""}
      </section>`;
    }).join("")}
    <section class="card" style="padding:4px 16px;gap:0">
      <div class="row"><span>${esc(t.quality)}</span><div class="seg" role="group" aria-label="${esc(t.quality)}">
        <button class="${d.bw ? "" : "on"}" onclick="setBw(false)" aria-pressed="${!d.bw}">${esc(t.color)}</button>
        <button class="${d.bw ? "on" : ""}" onclick="setBw(true)" aria-pressed="${d.bw}">${esc(t.bw)}</button></div></div>
      <label class="check" style="border-top:1px solid var(--line)"><input type="checkbox" ${d.ok ? "checked" : ""} onchange="ST.docs.ok=this.checked;drawDocsBar()" /><span>${esc(t.confirm_ok)}</span></label>
    </section>`;
  drawDocsBar();
}
function drawDocsBar() {
  const t = T(), d = ST.docs;
  const { missing, n } = docsNeed();
  const up = KINDS.some((k) => d.kinds.has(k) && d.pages[k].some((p) => p.state === "up"));
  const why = !d.kinds.size ? t.need_kind : missing.length ? t.need_all(missing.join(", ")) : up ? t.uploading : !d.ok ? t.need_check : "";
  bar(`<span class="muted ${why && d.kinds.size ? "warn" : ""}">${esc(why || t.pdf_n(n))}</span>
    <button class="btn" onclick="sendDocs()" ${why || ST.busy ? "disabled" : ""}>${esc(t.send_office)}</button>`);
}
function toggleKind(k, on) {
  if (on) ST.docs.kinds.add(k); else ST.docs.kinds.delete(k);
  renderDocs();
}
function setBw(bw) {
  const d = ST.docs;
  if (d.bw === bw) return;
  d.bw = bw;
  for (const k of KINDS) for (const p of d.pages[k]) uploadPage(p, bw);
  renderDocs();
}
async function sendDocs() {
  const d = ST.docs;
  const kinds = KINDS.filter((k) => d.kinds.has(k));
  const pages = kinds.flatMap((k) => d.pages[k]);
  if (ST.busy || !kinds.length || docsNeed().missing.length || !d.ok) return;
  if (pages.some((p) => p.state !== "ok")) return toast(T().uploading, true);
  ST.busy = true;
  drawDocsBar();
  const r = await api("/docs", { body: { kinds, pages: pages.map((p) => p.id) } });
  ST.busy = false;
  if (!r.ok) { drawDocsBar(); return toast(errText(r.error), true); }
  ST.docs = { kinds: new Set(), pages: { passport: [], karta: [], other: [] }, bw: d.bw, ok: false };
  await refreshMe();
  ST.done = r;
  renderDone();
}

// ── Надіслано ───────────────────────────────────────────────────────────
function renderDone() {
  const t = T(), r = ST.done;
  if (TGW) { try { TGW.BackButton.show(); } catch (e) { /* старий клієнт */ } }
  $("view").innerHTML = `<section class="card"><div class="done">${I.sent}<b>${esc(t.done_t)}</b>
    <span class="muted">${esc(t.pages_n(r.pages))} · ${esc(r.mailed ? t.done_mail : t.done_saved)}</span></div></section>`;
  bar(`<button class="btn sec" onclick="toChat(${Number(r.id)})">${esc(t.to_chat)}</button><button class="btn ghost" onclick="onBack()">${esc(t.home)}</button>`);
}
async function toChat(id) {
  const r = await api(`/docs/${id}/chat`, { body: {} });
  if (!r.ok) return toast(errText(r.error), true);
  toast(T().to_chat_ok);
}

// ── Демо (відкрито не з Telegram, ?demo): тестові дані без сервера ─────────
function demoApi(path, o) {
  const wait = (x) => new Promise((res) => setTimeout(() => res(x), 250));
  const t0 = warsawToday();
  const D = demoApi.db || (demoApi.db = (() => {
    const ym = t0.slice(0, 7);
    const days = {};
    const lastFill = addDays(t0, -4);
    for (let x = `${addMonths(ym, -1)}-01`; x <= lastFill; x = addDays(x, 1)) {
      const wd = dow(x);
      days[x] = wd === 0 || wd === 6 ? { abs: "WZ" } : { h: x.endsWith("09") ? 10 : 12 };
    }
    return { days, adv: [{ id: 1, date: addDays(t0, -10), status: "approved", note: null }], dof: [{ id: 1, days: [addDays(t0, 6)], status: "approved", note: null }], docs: [], student: null };
  })());
  const monthSum = (ym) => Object.entries(D.days).filter(([k, v]) => k.startsWith(ym) && v.h).reduce((s, [, v]) => s + v.h, 0);
  if (path === "/me") {
    const from = t0.slice(0, 8) + "01";
    const missing = [];
    for (let x = from; x < t0; x = addDays(x, 1)) if (!D.days[x]) missing.push(x);
    const taken = {};
    for (const r of D.dof) for (const d of r.days) taken[d] = r.status;
    const st = D.student;
    return wait({
      ok: true, today: t0, lang: ST.lang,
      worker: { id: 1, name: "KOWALENKO OLEKSANDR", login: "10234", facility: "Hydro Łódź SAS", status: "pracuje", dismissed: false },
      month: { total: monthSum(t0.slice(0, 7)), missing },
      advance: { enabled: true, amount: 300, pay_date: addDays(t0, [5, 4, 10, 9, 8, 7, 6][dow(t0)]), pending: D.adv.some((x) => x.status === "pending"), history: D.adv },
      dayoff: { enabled: true, horizon: 14, min_days: 3, near: [1, 2, 3].map((n) => addDays(t0, n)), taken, history: D.dof },
      student: st ? { ...st, state: st.valid_until < addDays(t0, 14) ? "expiring" : "active" } : { state: "none" },
      docs: D.docs, office: { email: true },
    });
  }
  if (path.startsWith("/hours?")) {
    const ym = /month=(\d{4}-\d{2})/.exec(path)[1];
    const days = {};
    for (const [k, v] of Object.entries(D.days)) if (k.startsWith(ym)) days[k] = v;
    return wait({ ok: true, today: t0, month: ym, min_month: addMonths(t0.slice(0, 7), -3), days, total: monthSum(ym),
      periods: [{ from: `${addMonths(t0.slice(0, 7), -2)}-03`, to: null }], edit: { from: `${addMonths(t0.slice(0, 7), -1)}-01`, to: addDays(t0, 1) },
      hours_format: "whole", hours_max: 16, codes: CODES });
  }
  if (path === "/hours") { D.days[o.body.date] = o.body.abs ? { abs: o.body.abs } : { h: o.body.hours }; return wait({ ok: true }); }
  if (path === "/advance") {
    if (D.adv.some((x) => x.status === "pending")) return wait({ ok: false, error: "pending" });
    D.adv.unshift({ id: D.adv.length + 1, date: t0, status: "pending", note: null });
    return wait({ ok: true, pay_date: addDays(t0, [5, 4, 10, 9, 8, 7, 6][dow(t0)]) });
  }
  if (path === "/dayoff") {
    const near = new Set([1, 2, 3].map((n) => addDays(t0, n)));
    const rej = o.body.dates.filter((x) => near.has(x)), acc = o.body.dates.filter((x) => !near.has(x));
    if (acc.length) D.dof.unshift({ id: D.dof.length + 1, days: acc, status: "pending", note: null });
    return wait({ ok: true, accepted: acc, rejected: rej, min_days: 3 });
  }
  if (path === "/pages") return wait({ ok: true, id: Math.random().toString(16).slice(2, 18).padEnd(16, "0") });
  if (path === "/docs") {
    const id = D.docs.length + 1;
    D.docs.unshift({ id, kinds: o.body.kinds, pages: o.body.pages.length, created_at: new Date().toISOString(), mailed: true });
    if (o.body.kinds.includes("student")) D.student = { is_student: true, valid_until: o.body.valid_until, doc_at: new Date().toISOString() };
    return wait({ ok: true, id, pages: o.body.pages.length, mailed: true });
  }
  if (/^\/docs\/\d+\/chat$/.test(path)) return wait({ ok: true });
  return wait({ ok: false, error: "not_found" });
}

boot();
