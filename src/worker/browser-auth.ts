import { z } from "zod";
import { Fault, hash } from "../domain/contracts";
import type { AppEnv } from "./env";

const enc = new TextEncoder();
const cookieSchema = z.object({
  aud: z.enum(["visitor", "merchant", "callback"]),
  owner: z.uuid(),
  exp: z.number(),
  csrf: z.string(),
  merchant: z.string().optional(),
  session: z.uuid().optional(),
  version: z.string().optional(),
});
export type BrowserClaims = z.infer<typeof cookieSchema>;
const keys = new Map<string, Promise<CryptoKey>>();
function key(secret: string) {
  if (!secret || secret.length < 32) throw new Fault("AUTH_UNAVAILABLE", 503);
  if (!keys.has(secret)) {
    if (keys.size >= 4) keys.clear();
    keys.set(
      secret,
      crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]),
    );
  }
  return keys.get(secret)!;
}
function b64(a: Uint8Array) {
  return btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(s: string) {
  return Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
export async function signBrowser(c: BrowserClaims, secret: string) {
  const data = b64(enc.encode(JSON.stringify(c)));
  return (
    data +
    "." +
    b64(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(data))))
  );
}
export async function readSigned(
  token: string | undefined,
  secret: string,
  aud: BrowserClaims["aud"],
) {
  if (!token || token.length > 4096) return;
  try {
    const [data, sig, extra] = token.split(".");
    if (
      extra ||
      !(await crypto.subtle.verify("HMAC", await key(secret), bytes(sig), enc.encode(data)))
    )
      return;
    const c = cookieSchema.parse(JSON.parse(new TextDecoder().decode(bytes(data))));
    if (c.aud === aud && c.exp > Date.now()) return c;
  } catch {
    /* No credential details leave this boundary. */
  }
}
export function cookieValue(request: Request, name: string) {
  return request.headers
    .get("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
}
export function cookie(name: string, token: string, age: number, env: AppEnv, strict = false) {
  return `${name}=${token}; Path=/; HttpOnly; ${new URL(env.APP_ORIGIN).protocol === "https:" ? "Secure; " : ""}SameSite=${strict ? "Strict" : "Lax"}; Max-Age=${age}`;
}
export function originProof(request: Request, env: AppEnv) {
  if (request.headers.get("Origin") !== env.APP_ORIGIN) throw new Fault("FORBIDDEN", 403);
}
export function csrfProof(request: Request, env: AppEnv, c?: BrowserClaims) {
  originProof(request, env);
  if (!c || request.headers.get("X-CSRF-Token") !== c.csrf) throw new Fault("FORBIDDEN", 403);
}
export async function visitor(request: Request, env: AppEnv) {
  return readSigned(cookieValue(request, "tb_owner"), env.OWNER_TOKEN_SIGNING_KEY, "visitor");
}
export async function merchant(request: Request, env: AppEnv) {
  const c = await readSigned(
    cookieValue(request, "tb_merchant"),
    env.MERCHANT_COOKIE_SIGNING_KEY ?? "",
    "merchant",
  );
  if (
    !c ||
    c.merchant !== env.MERCHANT_ID ||
    !env.MERCHANT_ADMIN_TOKEN ||
    c.version !== (await hash(env.MERCHANT_ADMIN_TOKEN))
  )
    throw new Fault("UNAUTHENTICATED", 401);
  return c;
}
export async function secretMatches(given: string, expected: string) {
  const [a, b] = await Promise.all(
    [given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))),
  );
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
