import { Fault, hash } from "../domain/contracts";
import type { AppEnv } from "./env";

// Fixed windows use the existing Free D1 counter table. Store only digests, never IPs.
// Count attempts (including denied attempts), not payments. Financial idempotency is separate.
export async function rateLimit(
  env: AppEnv,
  action: string,
  subjects: string[],
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const window = Math.floor(now / windowMs);
  const expires = (window + 1) * windowMs;
  const keys = await Promise.all(subjects.map((s) => hash(`${action}:${window}:${s}`)));
  const results = await env.DB.batch<{ attempts?: number }>([
    env.DB.prepare(
      "DELETE FROM login_attempts WHERE bucket IN (SELECT bucket FROM login_attempts WHERE expires_at<=? LIMIT 100)",
    ).bind(now),
    ...keys.map((key) =>
      env.DB.prepare(
        "INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=MIN(attempts+1,?) RETURNING attempts",
      ).bind(key, expires, limit + 1),
    ),
  ]);
  if (results.slice(1).some((r) => Number(r.results[0]?.attempts ?? limit + 1) > limit))
    throw new Fault("RATE_LIMITED", 429, expires - now);
}
export function requestSubjects(request: Request, owner: string) {
  // CF overwrites this header at the edge. Local runtime shares the fallback bucket.
  return [`ip:${request.headers.get("CF-Connecting-IP") ?? "local"}`, `owner:${owner}`];
}
