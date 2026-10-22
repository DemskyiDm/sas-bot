// Тести на справжній БД без змін у ній: одна транзакція з ROLLBACK наприкінці.
// Підміняє модуль db/index.js ДО того, як тести підключать bot/… і api/…; вкладені BEGIN / COMMIT / ROLLBACK
// модулів (bot/hr_sign.js, bot/office.js) перетворюються на SAVEPOINT у тій самій транзакції.
const path = require("path");
const root = path.join(__dirname, "..", "..");
require(path.join(root, "node_modules", "dotenv")).config({ path: path.join(root, ".env") });
const dbPath = require.resolve(path.join(root, "db"));
const real = require(dbPath);

let client = null;
let sp = 0;
const stack = [];
function q(text, params) {
  const t = String(text).trim();
  if (t === "BEGIN") { const n = `t${++sp}`; stack.push(n); return client.query(`SAVEPOINT ${n}`); }
  if (t === "COMMIT") { const n = stack.pop(); return n ? client.query(`RELEASE SAVEPOINT ${n}`) : Promise.resolve(); }
  if (t === "ROLLBACK") { const n = stack.pop(); return n ? client.query(`ROLLBACK TO SAVEPOINT ${n}`) : Promise.resolve(); }
  return client.query(text, params);
}
const fake = { query: q, pool: { connect: async () => ({ query: q, release() {} }), end: async () => {} } };

async function begin() {
  client = await real.pool.connect();
  await client.query("BEGIN");
  require.cache[dbPath].exports = fake;
  return fake;
}
async function end() {
  if (!client) return;
  await client.query("ROLLBACK");
  client.release();
  client = null;
  await real.pool.end();
}
// Перший рядок запиту або null
const one = async (sql, p) => (await q(sql, p)).rows[0] || null;

module.exports = { begin, end, q, one, root };
