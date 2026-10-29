// Перереєстрація вебхука Telegram із секретом: node set-webhook.js
// Адресу бере ту, що вже зареєстрована (getWebhookInfo), сертифікат — certs/public.pem (його віддає HTTPS-сервер),
// секрет — WEBHOOK_SECRET з .env. Telegram надсилатиме його в заголовку X-Telegram-Bot-Api-Secret-Token,
// index.js перевіряє заголовок. Порядок: секрет у .env → цей скрипт → рестарт index.
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const API = `https://api.telegram.org/bot${TOKEN}`;

async function main() {
  if (!TOKEN) throw new Error("немає BOT_TOKEN у .env");
  if (!SECRET || !/^[A-Za-z0-9_-]{16,256}$/.test(SECRET)) throw new Error("WEBHOOK_SECRET у .env: 16–256 символів A-Z a-z 0-9 _ -");
  const info = await (await fetch(`${API}/getWebhookInfo`)).json();
  const url = process.argv[2] || (info.result && info.result.url);
  if (!url) throw new Error("вебхук не зареєстрований — передайте адресу: node set-webhook.js https://host:8443/webhook");

  const fd = new FormData();
  fd.append("url", url);
  fd.append("secret_token", SECRET);
  if (info.result && info.result.max_connections) fd.append("max_connections", String(info.result.max_connections));
  const cert = path.join(__dirname, "certs", "public.pem");
  if (fs.existsSync(cert)) fd.append("certificate", new Blob([fs.readFileSync(cert)]), "public.pem");
  const r = await (await fetch(`${API}/setWebhook`, { method: "POST", body: fd })).json();
  console.log("setWebhook:", r.ok ? "ok" : r.description);
  const after = await (await fetch(`${API}/getWebhookInfo`)).json();
  const { url: _u, ...rest } = after.result || {};
  console.log("getWebhookInfo:", JSON.stringify(rest));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
