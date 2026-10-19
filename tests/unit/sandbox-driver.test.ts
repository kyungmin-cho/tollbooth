import { expect, it } from "vitest";
import {
  assertEvidenceOrigin,
  assertUsdAmount,
  diagnosticCode,
  fixtureConsentFlag,
  needsCallConsent,
  preparedRunMode,
  requireAiReady,
  sandboxTarget,
} from "../../scripts/e2e-sandbox/support";
import { safeError } from "../../src/domain/contracts";

const deployedOrigin = "https://tollbooth.arcsolve.workers.dev";
it("sandbox target permits loopback HTTP or only the configured HTTPS deployment", () => {
  expect(sandboxTarget("http://127.0.0.1:8787", deployedOrigin)).toBe("local");
  expect(sandboxTarget("http://localhost:8787", deployedOrigin)).toBe("local");
  expect(sandboxTarget(deployedOrigin, deployedOrigin)).toBe("remote");
  for (const value of [
    "https://evil.example",
    "http://tollbooth.arcsolve.workers.dev",
    `${deployedOrigin}/`,
    `${deployedOrigin}?secret=x`,
    "https://user:password@tollbooth.arcsolve.workers.dev",
  ])
    expect(() => sandboxTarget(value, deployedOrigin)).toThrow();
});
it("evidence cannot cross origins and legacy evidence stays local", () => {
  assertEvidenceOrigin(undefined, "http://127.0.0.1:8787", false);
  assertEvidenceOrigin(deployedOrigin, deployedOrigin, true);
  expect(() => assertEvidenceOrigin(undefined, deployedOrigin, true)).toThrow();
  expect(() => assertEvidenceOrigin("http://127.0.0.1:8787", deployedOrigin, true)).toThrow();
  expect(() => assertEvidenceOrigin(deployedOrigin, "http://127.0.0.1:8787", false)).toThrow();
});

it("sandbox verification accepts order breakdown without changing the exact USD total", () => {
  assertUsdAmount({ currency_code: "USD", value: "5.00" }, 500);
  assertUsdAmount({ currency_code: "USD", value: "0.90" }, 90);
  // Synthetic reproduction of the additional field returned by both live orders.
  assertUsdAmount(
    {
      currency_code: "USD",
      value: "5.00",
      breakdown: { item_total: { currency_code: "USD", value: "5.00" } },
    },
    500,
  );
});
it.each([
  null,
  [],
  {},
  { currency_code: "EUR", value: "5.00" },
  { currency_code: "USD", value: "4.99" },
  { currency_code: "USD", value: 5 },
  { currency_code: "USD", value: "5.0" },
  { currency_code: "USD", value: "5.001" },
  {
    currency_code: "USD",
    value: "4.99",
    breakdown: { item_total: { currency_code: "USD", value: "5.00" } },
  },
])("sandbox verification rejects invalid or different monetary totals %#", (amount) => {
  expect(() => assertUsdAmount(amount, 500)).toThrow();
});

it("configuration error survives RPC prototype loss as a public 503", () =>
  expect(safeError(new Error("PAYMENT_CONFIG_REQUIRED"))).toEqual({
    code: "PAYMENT_CONFIG_REQUIRED",
    status: 503,
  }));
it("driver preserves allowlisted error code but hides assertion and upstream values", () => {
  expect(diagnosticCode(new Error("PAYMENT_CONFIG_REQUIRED"))).toBe("PAYMENT_CONFIG_REQUIRED");
  const error = new Error("sensitive-comparison-value");
  error.name = "AssertionError";
  expect(diagnosticCode(error)).toBe("ACCEPTANCE_ASSERTION_FAILED");
  expect(diagnosticCode(new Error("sensitive-provider-data"))).toBe("REQUEST_FAILED");
});
it("noninteractive fixture consent is opt-in and does not consent to wallet approval", () => {
  expect(fixtureConsentFlag(["--resume"])).toBe(false);
  expect(fixtureConsentFlag(["--resume", "--approve-fixture-calls"])).toBe(true);
  for (const mode of ["--prepare", "--verify", "--zero-use"])
    expect(() => fixtureConsentFlag(["--resume", mode, "--approve-fixture-calls"])).toThrow(
      "INVALID_CONSENT_MODE",
    );
  expect(needsCallConsent(35, "kr", [], false)).toBe(true);
  expect(needsCallConsent(35, "kr", [], true)).toBe(false);
  expect(needsCallConsent(20, "coffee", [], false)).toBe(false);
  expect(needsCallConsent(35, "kr", [{ callKey: "kr" }], false)).toBe(false);
});

it("resume polls authoritative activation without resending activate or masking terminal failure", async () => {
  const { awaitEvidence, requireActive } = await import("../../scripts/e2e-sandbox/support");
  const states = ["AUTHORIZING", "RECONCILING", "ACTIVE"];
  let reads = 0;
  const result = await awaitEvidence(async () => requireActive({ state: states[reads++] }), {
    sleep: async () => {},
  });
  expect(result.state).toBe("ACTIVE");
  expect(reads).toBe(3);
  await expect(
    awaitEvidence(async () => requireActive({ state: "MANUAL_REVIEW" }), { sleep: async () => {} }),
  ).rejects.toThrow();
});
it("provider visibility retry is bounded and never retries a wrong amount assertion", async () => {
  const { awaitEvidence, EvidencePending, assertUsdAmount } = await import(
    "../../scripts/e2e-sandbox/support"
  );
  let n = 0;
  expect(
    await awaitEvidence(
      async () => {
        if (++n < 3) throw new EvidencePending();
        return "verified";
      },
      { sleep: async () => {} },
    ),
  ).toBe("verified");
  n = 0;
  await expect(
    awaitEvidence(
      async () => {
        n++;
        throw new EvidencePending();
      },
      { attempts: 3, sleep: async () => {} },
    ),
  ).rejects.toThrow("EVIDENCE_NOT_READY");
  expect(n).toBe(3);
  n = 0;
  await expect(
    awaitEvidence(
      async () => {
        n++;
        assertUsdAmount({ currency_code: "USD", value: "0.91" }, 90);
      },
      { sleep: async () => {} },
    ),
  ).rejects.toThrow();
  expect(n).toBe(1);
});

it.each([
  null,
  { status: "PENDING", calls: [] },
  { status: "FALLBACK", calls: [] },
  { status: "READY", calls: [] },
])("AI resume never substitutes fixed calls for an unavailable plan %j", (plan) => {
  expect(() => requireAiReady(plan)).toThrow();
});
it("AI resume accepts only a saved complete plan", () => {
  const plan = { status: "READY", calls: [1, 2, 3] };
  expect(requireAiReady(plan)).toBe(plan);
});

it("preparation permits explicit terminal AI fallback but never pending or silent substitution", () => {
  expect(preparedRunMode("READY", false)).toBe("ai");
  expect(preparedRunMode("FALLBACK", true)).toBe("scripted");
  expect(() => preparedRunMode("FALLBACK", false)).toThrow();
  for (const state of ["PENDING", "INVALID", ""])
    expect(() => preparedRunMode(state, true)).toThrow();
});
