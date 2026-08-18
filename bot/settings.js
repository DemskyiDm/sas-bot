const db = require("../db");

const cache = new Map();

async function getSettingsByWorker(workerId) {
  const res = await db.query(
    `
    SELECT fs.*, w.facility_id
    FROM workers w
    JOIN facility_settings fs ON fs.facility_id = w.facility_id
    WHERE w.id = $1
  `,
    [workerId],
  );

  const data = res.rows[0];
  return data;
}

async function getSettingsByFacility(facilityId) {
  const key = parseInt(facilityId);
 /* console.log(
    `[settings] getSettingsByFacility key=${key} cached=${cache.has(key)}`,
  );*/

  if (cache.has(key)) {
    //console.log(`[settings] returning CACHED:`, cache.get(key));
    return cache.get(key); // ← return тільки якщо є в кеші
  }

  const res = await db.query(
    `SELECT * FROM facility_settings WHERE facility_id = $1`,
    [key],
  );
  //console.log(`[settings] DB result:`, res.rows[0]);

  const data = res.rows[0];
  if (data) {
    cache.set(key, data);
    setTimeout(() => cache.delete(key), 30000);
  }
  return data;
}

function clearCacheForFacility(facilityId) {
  cache.delete(parseInt(facilityId)); // ✅ завжди число
}

async function updateSettings(facilityId, body) {
  await db.query(
    `
    UPDATE facility_settings SET
      enable_advances = $1,
      enable_wolne = $2,
      days_keyboard = $3,
      reminders_enabled = $4,
      reminder_time = $5,
      updated_at = NOW()
    WHERE facility_id = $6
  `,
    [
      body.enable_advances,
      body.enable_wolne,
      body.days_keyboard,
      body.reminders_enabled,
      body.reminder_time,
      facilityId,
    ],
  );

  cache.clear();
}

function clearCache() {
  cache.clear();
}

module.exports = {
  getSettingsByWorker,
  getSettingsByFacility,
  clearCacheForFacility,
  clearCache,
};
