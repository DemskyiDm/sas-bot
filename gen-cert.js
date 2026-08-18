const selfsigned = require("selfsigned");
const fs = require("fs");
const path = require("path");

const IP = "77.237.28.248"; // твій статичний IP

async function main() {
  let pems = selfsigned.generate(
    [{ name: "commonName", value: IP }],
    {
      keySize: 2048,
      days: 3650,
      algorithm: "sha256",
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 7, ip: IP }] },
      ],
    }
  );

  // деякі версії повертають Promise
  if (pems && typeof pems.then === "function") {
    pems = await pems;
  }

  console.log("Returned keys:", Object.keys(pems));

  const key = pems.private || pems.key || pems.privateKey;
  const cert = pems.cert || pems.public || pems.certificate;

  if (!key || !cert) {
    console.error("Не вдалось дістати ключ/сертифікат з обʼєкта:", pems);
    process.exit(1);
  }

  const dir = path.join(__dirname, "certs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "private.key"), key);
  fs.writeFileSync(path.join(dir, "public.pem"), cert);
  console.log("Certs written to", dir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});