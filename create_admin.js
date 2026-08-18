require('dotenv').config();
const crypto = require('crypto');
const db = require('./db');

async function main() {
  const password = process.env.ADMIN_PASSWORD;   // from .env (ADMIN_PASSWORD), never in code
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  const stored = `${salt}:${hash}`;

  const coord = await db.query(
    `INSERT INTO coordinators (full_name, email, role)
     VALUES ('Dmytro Demski', 'd.demskyi@saslogistic.pl', 'head')
     RETURNING id`
  );
  const coordId = coord.rows[0].id;

  await db.query(
    `INSERT INTO coordinator_auth (coordinator_id, username, password_hash, is_admin)
     VALUES ($1, 'admin', $2, true)
     ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
    [coordId, stored]
  );

 // console.log('Done! Login: admin / Password: from .env');
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });