import { z } from "zod";
import { Fault } from "../domain/contracts";

const encoder = new TextEncoder();
const claimsSchema = z.strictObject({
  owner: z.uuid(),
  exp: z.number().int(),
  aud: z.enum(["tollbooth-client", "tollbooth-operator"]),
  merchant: z.string().optional(),
  scopes: z.array(z.enum(["open", "read", "call", "close", "reconcile", "rebuild"])),
});
export type Claims = z.infer<typeof claimsSchema>;
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (x) =>
    x.charCodeAt(0),
  );
}
const cachedKeys = new Map<string, Promise<CryptoKey>>();
async function key(secret: string) {
  if (!secret || secret.length < 32) throw new Fault("AUTH_UNAVAILABLE", 503);
  if (cachedKeys.has(secret)) return cachedKeys.get(secret)!;
  if (cachedKeys.size >= 2) cachedKeys.clear();
  const imported = crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  cachedKeys.set(secret, imported);
  return imported;
}
export async function signAccess(claims: Claims, secret: string) {
  claimsSchema.parse(claims);
  const data = base64url(encoder.encode(JSON.stringify(claims)));
  return `${data}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(data))))}`;
}
export async function authenticate(request: Request, secret: string): Promise<Claims | undefined> {
  const header = request.headers.get("Authorization");
  if (!header) return;
  try {
    if (!header.startsWith("Bearer ")) throw new Error();
    const parts = header.slice(7).split(".");
    if (parts.length !== 2 || header.length > 4096) throw new Error();
    const [data, sig] = parts;
    if (!(await crypto.subtle.verify("HMAC", await key(secret), decode(sig), encoder.encode(data))))
      throw new Error();
    const c = claimsSchema.parse(JSON.parse(new TextDecoder().decode(decode(data))));
    if (c.exp <= Date.now() || c.exp > Date.now() + 3600000) throw new Error();
    return c;
  } catch {
    throw new Fault("UNAUTHENTICATED", 401);
  }
}
export function requireScope(c: Claims | undefined, scope: Claims["scopes"][number]) {
  if (!c) throw new Fault("UNAUTHENTICATED", 401);
  if (c.aud !== "tollbooth-client" || ["reconcile", "rebuild"].includes(scope))
    throw new Fault("FORBIDDEN", 403);
  if (!c.scopes.includes(scope)) throw new Fault("FORBIDDEN", 403);
  return c.owner;
}
export function requireOperator(
  c: Claims | undefined,
  merchant: string,
  scope: "read" | "reconcile" | "rebuild",
) {
  if (!c) throw new Fault("UNAUTHENTICATED", 401);
  if (c.aud !== "tollbooth-operator" || c.merchant !== merchant || !c.scopes.includes(scope))
    throw new Fault("FORBIDDEN", 403);
}
