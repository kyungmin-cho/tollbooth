import { expect, it } from "vitest";
import {
  budgetSchema,
  canonical,
  cents,
  money,
  openSchema,
  safeError,
} from "../../src/domain/contracts";
import { defaultPolicy, policyCheck, policySchema } from "../../src/domain/policy";

it("T03 integer cents: twenty seven-cent entries total 140 without drift", () => {
  let used = 0;
  for (let i = 0; i < 20; i++) used += cents("0.07");
  expect(used).toBe(140);
  expect(money(used)).toBe("1.40");
});
it.each([0, -1, 49, 501, 1.5, NaN, Infinity])(
  "T11-T17 budget %s is rejected before admission",
  (value) => expect(budgetSchema.safeParse(value).success).toBe(false),
);
it("T25 rejects prepaid before storage", () =>
  expect(
    openSchema.safeParse({ budgetCents: 500, creationKey: "key", mode: "prepaid" }).success,
  ).toBe(false));
it("T31 arbitrary upstream text is redacted", () =>
  expect(JSON.stringify(safeError(new Error("private-token")))).not.toContain("private-token"));
it("T32 human threshold is strict greater-than", () =>
  expect(policyCheck(35, 500, "tollbooth.demo").needsHuman).toBe(true));
it("T33 equal threshold needs no extra approval", () =>
  expect(policyCheck(30, 500, "tollbooth.demo").needsHuman).toBe(false));
it("T34 human consent cannot override hard per-call cap", () =>
  expect(() => policyCheck(51, 500, "tollbooth.demo")).toThrow("PER_CALL_CAP_EXCEEDED"));
it("T35 session cap", () =>
  expect(() => policyCheck(20, 501, "tollbooth.demo")).toThrow("SESSION_CAP_EXCEEDED"));
it("T36 merchant allowlist", () =>
  expect(() => policyCheck(20, 500, "foreign")).toThrow("MERCHANT_NOT_ALLOWED"));
it("T37 negative quote", () =>
  expect(() => policyCheck(-1, 500, "tollbooth.demo")).toThrow("INVALID_QUOTE"));
it("T38 strict policy", () =>
  expect(policySchema.safeParse({ ...defaultPolicy, unknown: true }).success).toBe(false));
it("canonical key order is stable, arrays preserve order", () => {
  expect(canonical({ b: 1, a: { z: 2, y: 3 } })).toBe(canonical({ a: { y: 3, z: 2 }, b: 1 }));
  expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
});
