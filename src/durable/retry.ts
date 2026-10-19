// Durable counters, not platform retry counters, bound independent recovery.
export function retryDelay(
  kind: string,
  attempts: number,
  elapsed: number,
  jitter = Math.random(),
) {
  const base =
    kind === "PROJECTION"
      ? elapsed >= 86400000
        ? 3600000
        : Math.min(300000, 5000 * 2 ** Math.min(attempts, 6))
      : elapsed >= 1800000
        ? 3600000
        : ([2000, 4000, 8000, 16000, 30000, 60000][attempts] ?? 300000);
  return Math.ceil(base * (1 + Math.max(0, Math.min(jitter, 1)) * 0.1));
}
