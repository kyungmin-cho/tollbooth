import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type CallMeta, PRICING_VERSION } from "../src/domain/contracts";
import { openSession, sessionStub } from "../src/worker/service";
import { paypalFake } from "./fixtures/paypal";
export async function setup(budget = 500, active = true) {
  const payment = paypalFake(),
    owner = crypto.randomUUID();
  const session = await openSession(env, owner, {
    budgetCents: budget,
    creationKey: crypto.randomUUID(),
  });
  const stub = sessionStub(env, session.sessionId);
  if (active) {
    payment.approved = true;
    await stub.activate(owner, session.sessionId);
  }
  const meta = (key: string = crypto.randomUUID()): CallMeta => ({
    sessionId: session.sessionId,
    callKey: key,
    maxPriceCents: 50,
    pricingVersion: PRICING_VERSION,
  });
  return { payment, owner, session, stub, meta };
}
export async function due(stub: ReturnType<typeof sessionStub>) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE settlement SET lease_until=0");
    state.storage.sql.exec("UPDATE payment_operations SET lease_until=0");
    state.storage.sql.exec("UPDATE recovery_state SET next_at=0");
  });
}

export function plain(value: PromiseLike<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    value.then(resolve, reject);
  });
}
