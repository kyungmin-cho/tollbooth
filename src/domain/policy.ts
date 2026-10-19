import { z } from "zod";
import defaults from "../../policies/default.json";
import { Fault } from "./contracts";
export const policySchema = z.strictObject({
  perCallCapCents: z.number().int().nonnegative(),
  sessionCapCents: z.number().int().nonnegative(),
  humanApprovalAboveCents: z.number().int().nonnegative(),
  allowedMerchants: z.array(z.string()).min(1),
});
export const defaultPolicy = policySchema.parse(defaults);
export function policyCheck(
  price: number,
  budget: number,
  merchant: string,
  policy = defaultPolicy,
) {
  policySchema.parse(policy);
  if (!Number.isSafeInteger(price) || price < 0) throw new Fault("INVALID_QUOTE", 400);
  if (!policy.allowedMerchants.includes(merchant)) throw new Fault("MERCHANT_NOT_ALLOWED", 403);
  if (!Number.isSafeInteger(budget) || budget > policy.sessionCapCents || budget < 50)
    throw new Fault("SESSION_CAP_EXCEEDED", 400);
  if (price > policy.perCallCapCents) throw new Fault("PER_CALL_CAP_EXCEEDED", 400);
  return { needsHuman: price > policy.humanApprovalAboveCents };
}
