import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const source = parseEnv(
  readFileSync(join(homedir(), ".config/paypal-hackathon/sandbox.env"), "utf8"),
);
if (source.PAYPAL_ENV && source.PAYPAL_ENV.toLowerCase() !== "sandbox")
  throw new Error("Sandbox configuration required");
const remote = process.argv.includes("--remote");
const destination = remote ? ".dev.vars.remote" : ".dev.vars";
const prior = existsSync(destination) ? parseEnv(readFileSync(destination, "utf8")) : {};
if (!source.PAYPAL_CLIENT_ID || !source.PAYPAL_CLIENT_SECRET)
  throw new Error("Missing sandbox app credentials");
const merchant = source.PAYPAL_MERCHANT_ID || prior.PAYPAL_MERCHANT_ID;
if (merchant && !/^[A-Z0-9]{13}$/.test(merchant)) throw new Error("Invalid merchant ID format");
if (Boolean(source.MERCHANT_ADMIN_TOKEN) !== Boolean(source.MERCHANT_COOKIE_SIGNING_KEY))
  throw new Error("Configure both merchant authentication keys together");
for (const name of ["MERCHANT_ADMIN_TOKEN", "MERCHANT_COOKIE_SIGNING_KEY"])
  if (source[name] && source[name].length < 32)
    throw new Error("Merchant authentication keys must have at least 32 characters");
const data = {
  PAYPAL_CLIENT_ID: source.PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: source.PAYPAL_CLIENT_SECRET,
  OWNER_TOKEN_SIGNING_KEY: prior.OWNER_TOKEN_SIGNING_KEY || randomBytes(48).toString("hex"),
  ...(merchant ? { PAYPAL_MERCHANT_ID: merchant } : {}),
  ...(source.MERCHANT_ADMIN_TOKEN
    ? {
        MERCHANT_ADMIN_TOKEN: source.MERCHANT_ADMIN_TOKEN,
        MERCHANT_COOKIE_SIGNING_KEY: source.MERCHANT_COOKIE_SIGNING_KEY,
      }
    : {}),
  ...(source.PAYPAL_WEBHOOK_ID ? { PAYPAL_WEBHOOK_ID: source.PAYPAL_WEBHOOK_ID } : {}),
};
writeFileSync(
  destination,
  Object.entries(data)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
chmodSync(destination, 0o600);
console.log(
  merchant
    ? remote
      ? "Remote runtime secrets prepared with a separate signing key. Upload through wrangler secret bulk."
      : "Runtime secrets prepared. Restart local Wrangler before sandbox preparation."
    : "Runtime secrets prepared; sandbox order creation is blocked until PAYPAL_MERCHANT_ID is provided.",
);
