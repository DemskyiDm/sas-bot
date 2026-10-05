-- ══════════════════════════════════════════════════════════════════════
--  Анкета на старті (реєстрація в боті) — пілот на вибраних об'єктах
--
--  1) «Як ви дізналися про компанію?» — питання «Poleć znajomego» з каналами
--     (Facebook, Instagram, TikTok, Telegram, сайти вакансій, рекрутер…);
--     для друга / координатора — ім'я та прізвище, як і раніше.
--  2–5) анкета care «start»: зрозумілість умов, швидкість рекрутера,
--     житло як обіцяли, оцінка координатора (бачать лише регіональні й керівник).
--  Надсилає bot/referral.js одразу після першого питання; нагадування —
--  раз на день упродовж start_remind_days (2) днів.
--  Потрібні: migration_care.sql, migration_referral.sql. Повторний запуск безпечний.
-- ══════════════════════════════════════════════════════════════════════

-- ── Poleć znajomego: канали, пілот ────────────────────────────────────
ALTER TABLE ref.answers ADD COLUMN IF NOT EXISTS ext BOOLEAN NOT NULL DEFAULT false;   -- для цього прийому — розширена анкета
ALTER TABLE ref.answers DROP CONSTRAINT IF EXISTS answers_source_check;
ALTER TABLE ref.answers ADD CONSTRAINT answers_source_check
  CHECK (source IN ('friend','coord','recruit','other','facebook','instagram','tiktok','telegram','jobsite'));
INSERT INTO ref.settings (key, value) VALUES
  ('start_sites',       ''),    -- об'єкти пілоту: '' — ніде, '*' — усі, або JSON-масив site_key
  ('start_remind_days', '2')    -- нагадування анкети 2–5: раз на день, стільки днів після надсилання
ON CONFLICT (key) DO NOTHING;

-- ── Анкета care «start» ──────────────────────────────────────────────
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('start', 0, 'Старт (реєстрація в боті)', '{"uk": "📝 Ще 4 коротких питання — менше хвилини.\n\nВідповіді бачить тільки команда координації SAS Logistic. Координатор не бачить, хто і як його оцінив.", "ru": "📝 Ещё 4 коротких вопроса — меньше минуты.\n\nОтветы видит только команда координации SAS Logistic. Координатор не видит, кто и как его оценил.", "pl": "📝 Jeszcze 4 krótkie pytania — mniej niż minuta.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic. Koordynator nie widzi, kto i jak go ocenił.", "en": "📝 4 more short questions — less than a minute.\n\nOnly the SAS Logistic coordination team sees your answers. Your coordinator does not see who rated them or how."}'::jsonb, 0) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('start', 1, 'clarity5', '{"uk": "📋 Наскільки зрозуміло вам пояснили умови роботи до приїзду (ставка, години, житло, дорога)? Від 1 до 5", "ru": "📋 Насколько понятно вам объяснили условия работы до приезда (ставка, часы, жильё, дорога)? От 1 до 5", "pl": "📋 Jak jasno wyjaśniono Ci warunki pracy przed przyjazdem (stawka, godziny, mieszkanie, dojazd)? Od 1 do 5", "en": "📋 How clearly were the job conditions explained before you arrived (pay, hours, housing, travel)? From 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": null}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": null}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": null}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('start', 2, 'recruit5', '{"uk": "⏱ Як швидко ви отримували інформацію та відповіді від рекрутера? 1 — дуже довго, 5 — дуже швидко", "ru": "⏱ Как быстро вы получали информацию и ответы от рекрутера? 1 — очень долго, 5 — очень быстро", "pl": "⏱ Jak szybko dostawałeś informacje i odpowiedzi od rekrutera? 1 — bardzo długo, 5 — bardzo szybko", "en": "⏱ How quickly did you get information and answers from the recruiter? 1 — very slowly, 5 — very fast"}'::jsonb, '[{"c": "1", "t": {"uk": "1 🐢", "ru": "1 🐢", "pl": "1 🐢", "en": "1 🐢"}, "f": null}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": null}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": null}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 ⚡", "ru": "5 ⚡", "pl": "5 ⚡", "en": "5 ⚡"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('start', 3, 'housing_promise', '{"uk": "🏠 Чи умови проживання такі, як вам обіцяли?", "ru": "🏠 Условия проживания такие, как вам обещали?", "pl": "🏠 Czy warunki zakwaterowania są takie, jak Ci obiecano?", "en": "🏠 Are the housing conditions what you were promised?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так, як обіцяли", "ru": "✅ Да, как обещали", "pl": "✅ Tak, jak obiecano", "en": "✅ Yes, as promised"}, "f": null}, {"c": "mostly", "t": {"uk": "🤔 Здебільшого так", "ru": "🤔 В основном да", "pl": "🤔 W większości tak", "en": "🤔 Mostly yes"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні, сильно відрізняються", "ru": "❌ Нет, сильно отличаются", "pl": "❌ Nie, bardzo się różnią", "en": "❌ No, very different"}, "f": "high"}, {"c": "own", "t": {"uk": "🏡 Маю своє житло", "ru": "🏡 У меня своё жильё", "pl": "🏡 Mam własne mieszkanie", "en": "🏡 I have my own housing"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('start', 4, 'coord_start5', '{"uk": "📞 Як ви оцінюєте роботу координатора? Від 1 до 5", "ru": "📞 Как вы оцениваете работу координатора? От 1 до 5", "pl": "📞 Jak oceniasz pracę koordynatora? Od 1 do 5", "en": "📞 How do you rate your coordinator''s work? From 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": null}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": null}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": null}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'manager') ON CONFLICT (survey_code, code) DO NOTHING;

-- «start» не плануємо за стажем — її надсилає бот при реєстрації
CREATE OR REPLACE FUNCTION care.plan_day(p_day DATE)
RETURNS TABLE (surveys INT, exits INT, assessments INT) LANGUAGE plpgsql AS $$
DECLARE v_s INT; v_e INT; v_a INT;
BEGIN
  -- анкети за стажем: день d_offset, з запасом survey_catchup_days
  INSERT INTO care.survey_sends (survey_code, worker_id, bhp_date, facility_id, site_key, coordinator_id,
                                 region_id, planned_for, status, lang)
  SELECT sv.code, a.worker_id, a.bhp_date, a.facility_id, a.site_key, o.coordinator_id, o.region_id, p_day,
         CASE WHEN w.telegram_chat_id IS NULL THEN 'no_telegram' ELSE 'planned' END, w.lang::text
  FROM care.active_on(p_day) a
  JOIN public.workers w ON w.id = a.worker_id
  JOIN care.surveys sv ON sv.is_active AND sv.day_offset IS NOT NULL AND sv.code <> 'start'   -- «start» надсилає бот при реєстрації
  LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
  WHERE (p_day - a.bhp_date) BETWEEN sv.day_offset AND sv.day_offset + care.setting('survey_catchup_days')::int
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, survey_code, bhp_date) DO NOTHING;
  GET DIAGNOSTICS v_s = ROW_COUNT;

  -- анкета при звільненні: останній день за 3 дні, звільнений або rezygnacja (не переведений)
  INSERT INTO care.survey_sends (survey_code, worker_id, bhp_date, facility_id, site_key, coordinator_id,
                                 region_id, planned_for, status, lang)
  SELECT sv.code, h.worker_id, h.bhp_date, h.facility_id, reg.site_key(f.group_name, f.name),
         o.coordinator_id, o.region_id, p_day,
         CASE WHEN w.telegram_chat_id IS NULL THEN 'no_telegram' ELSE 'planned' END, w.lang::text
  FROM public.worker_facility_history h
  JOIN public.facilities f ON f.id = h.facility_id
  JOIN public.workers w ON w.id = h.worker_id
  JOIN care.surveys sv ON sv.is_active AND sv.day_offset IS NULL
  LEFT JOIN reg.site_owner o ON o.site_key = reg.site_key(f.group_name, f.name) AND o.valid_to IS NULL
  WHERE h.status::text IN ('zwolniony','rezygnacja') AND h.bhp_date IS NOT NULL
    AND h.last_work_date BETWEEN p_day - 3 AND p_day
    AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
    AND NOT EXISTS (SELECT 1 FROM care.active_on(p_day) x WHERE x.worker_id = h.worker_id)
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, survey_code, bhp_date) DO NOTHING;
  GET DIAGNOSTICS v_e = ROW_COUNT;

  -- оцінки «як вливається»
  INSERT INTO care.assessments (worker_id, bhp_date, day_mark, coordinator_id, site_key)
  SELECT a.worker_id, a.bhp_date, m.d, o.coordinator_id, a.site_key
  FROM care.active_on(p_day) a
  CROSS JOIN (VALUES (care.setting('assess_day_1')::int), (care.setting('assess_day_2')::int)) m(d)
  LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
  WHERE (p_day - a.bhp_date) BETWEEN m.d AND m.d + 2
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, bhp_date, day_mark) DO NOTHING;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  -- анкети без відповіді закриваються
  UPDATE care.survey_sends SET status = 'expired'
   WHERE status = 'sent' AND sent_at < now() - make_interval(days => care.setting('survey_expire_days')::int);
  UPDATE care.survey_sends SET status = 'expired'
   WHERE status = 'planned' AND planned_for < p_day - 1;

  RETURN QUERY SELECT v_s, v_e, v_a;
END $$;
