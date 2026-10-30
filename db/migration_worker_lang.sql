-- db/migration_worker_lang.sql — workers.lang = мова, обрана працівником у боті (session_data->>'lang').
-- Раніше вибір мови писався лише в сесію, а workers.lang лишався 'uk' — штрафи, рішення про аванс / вихідний,
-- нагадування, розсилки (вони читають workers.lang) йшли українською і тим, хто обрав ru / pl / en.
-- Відтепер бот пише мову в обидва місця (bot/session.js, bot/handlers.js linkTelegram); тут — одноразове вирівнювання.
-- (можна повторно)
UPDATE workers
   SET lang = (session_data->>'lang')::worker_lang
 WHERE session_data->>'lang' IN ('uk', 'pl', 'en', 'ru')
   AND lang IS DISTINCT FROM (session_data->>'lang')::worker_lang;
