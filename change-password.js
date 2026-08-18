require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');

async function main() {
  const username = 'admin';              // кому міняємо
  const newPassword = 'Admin123@@@!!!';    // ← встав новий пароль

  // той самий алгоритм, що при створенні (salt:hmac-sha256)
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(newPassword).digest('hex');
  const stored = `${salt}:${hash}`;

  const res = await db.query(
    `UPDATE coordinator_auth
     SET password_hash = $1
     WHERE username = $2
     RETURNING coordinator_id, username`,
    [stored, username],
  );

  if (res.rowCount === 0) {
    console.error(`Користувача '${username}' не знайдено`);
    process.exit(1);
  }
  console.log(`Пароль оновлено для: ${res.rows[0].username} (coordinator_id=${res.rows[0].coordinator_id})`);
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });