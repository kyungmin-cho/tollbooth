import { z } from "zod";
export const eventTypes = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
] as const;
export const noticeSchema = z.strictObject({
  eventId: z.string().min(1).max(128),
  eventType: z.enum(eventTypes),
  resourceId: z.string().min(1).max(128),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.uuid().nullable(),
  orderId: z.string().max(128).nullable(),
  authorizationId: z.string().max(128).nullable(),
  captureId: z.string().max(128).nullable().default(null),
});
export type VerifiedNotice = z.infer<typeof noticeSchema>;

// Extract an identity only; never fetch an event-supplied link.
export function linkedCapture(links?: { rel: string; href: string }[]) {
  const href = links?.find((l) => l.rel === "up")?.href;
  return (
    href?.match(
      /^https:\/\/api(?:-m)?\.sandbox\.paypal\.com\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/,
    )?.[1] ?? null
  );
}
