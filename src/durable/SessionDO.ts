import { DurableObject } from "cloudflare:workers";
import {
  type CallMeta,
  callMetaSchema,
  canonical,
  Fault,
  fixture,
  hash,
  PRICING_VERSION,
  quote,
  type ToolName,
} from "../domain/contracts";
import { type Capture, PayPal } from "../payments/paypal";
import type { Call, Operation, Registration, Session, Settlement, Snapshot } from "../shared/types";
import { noticeSchema, type VerifiedNotice } from "../shared/webhook";
import { readSigned, signBrowser } from "../worker/browser-auth";
import type { AppEnv } from "../worker/env";
import { retryDelay } from "./retry";
import { schema } from "./schema";

const terminal = ["CAPTURED", "VOIDED", "EXPIRED"];
export class SessionDO extends DurableObject<AppEnv> {
  private paypal: PayPal;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.paypal = new PayPal(env);
    ctx.storage.transactionSync(() => ctx.storage.sql.exec(schema));
  }
  private rows<T = Record<string, string | number | null>>(
    sql: string,
    ...values: (string | number | null)[]
  ): T[] {
    return this.ctx.storage.sql.exec(sql, ...values).toArray() as unknown as T[];
  }
  private one<T = Record<string, string | number | null>>(
    sql: string,
    ...values: (string | number | null)[]
  ): T | undefined {
    return this.rows<T>(sql, ...values)[0];
  }
  private session(): Session {
    const s = this.one<Session>("SELECT * FROM session");
    if (!s) throw new Fault("NOT_FOUND", 404);
    return s;
  }
  private owned(owner: string, id: string) {
    const s = this.session();
    if (s.owner_id !== owner || s.id !== id || s.merchant_id !== this.env.MERCHANT_ID)
      throw new Fault("NOT_FOUND", 404);
    return s;
  }
  private job(kind: string, due: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs(kind,due_at) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET due_at=min(due_at,excluded.due_at)",
      kind,
      due,
    );
  }
  private removeJob(kind: string) {
    this.ctx.storage.sql.exec("DELETE FROM jobs WHERE kind=?", kind);
  }
  private snapshot(): Snapshot {
    const s = this.session(),
      st = this.one<Settlement>("SELECT * FROM settlement");
    return {
      sessionId: s.id,
      state: s.state,
      version: s.version,
      budgetCents: s.budget_cents,
      usedCents: s.used_cents,
      reservedCents: s.reserved_cents,
      availableCents: s.budget_cents - s.used_cents - s.reserved_cents,
      capturedCents: s.state === "CAPTURED" ? (st?.amount_cents ?? 0) : 0,
      approvalUrl: s.state === "APPROVAL_PENDING" ? s.approval_url : null,
      orderId: s.order_id,
      authorizationId: s.authorization_id,
      authorizationStatus: s.authorization_status,
      approvalDeadline: s.approval_deadline,
      idleDeadline: s.idle_deadline,
      hardDeadline: s.hard_deadline,
      ledger: this.rows<{ callKey: string; amountCents: number }>(
        "SELECT call_key AS callKey,amount_cents AS amountCents FROM ledger ORDER BY seq",
      ),
      settlement: st
        ? {
            kind: st.kind,
            status: st.status,
            amountCents: st.amount_cents,
            captureId: st.capture_id,
            releaseEvidence: st.release_evidence,
            requestReference: st.request_id,
          }
        : null,
      errorCode: s.last_error_code,
      postSettlementIssue:
        this.one<{ post_settlement_issue: string }>(
          "SELECT post_settlement_issue FROM session_metadata",
        )?.post_settlement_issue ?? null,
    };
  }
  private changed() {
    this.ctx.storage.sql.exec("UPDATE session SET version=version+1");
    const v = this.snapshot();
    this.ctx.storage.sql.exec(
      "INSERT INTO outbox VALUES(?,?,?,NULL)",
      `${v.sessionId}:${v.version}`,
      v.version,
      JSON.stringify({
        ...v,
        approvalUrl: null,
        usage: this.rows(
          "SELECT l.call_key,l.amount_cents,l.committed_at,c.tool FROM ledger l JOIN calls c USING(call_key)",
        ),
        charge: this.one<Settlement>("SELECT * FROM settlement") ?? null,
      }),
    );
    this.job("PROJECTION", Date.now() + 5000);
  }
  private tx<T>(f: () => T): T {
    return this.ctx.storage.transactionSync(f);
  }
  // Serialize alarm reads/writes: a stale network continuation cannot move an earlier wakeup later.
  private async arm(watchdog = false) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const due = this.one<{ due: number }>("SELECT min(due_at) AS due FROM jobs")?.due;
      const now = Date.now();
      if (watchdog) {
        const old = await this.ctx.storage.getAlarm();
        await this.ctx.storage.setAlarm(Math.min(old ?? Infinity, due ?? Infinity, now + 60000));
      } else if (due != null) await this.ctx.storage.setAlarm(Math.max(now + 100, due));
      else await this.ctx.storage.deleteAlarm();
    });
  }
  async initialize(r: Registration) {
    if (r.merchant_id !== this.env.MERCHANT_ID || r.pricing_version !== PRICING_VERSION)
      throw new Fault("INVALID_INPUT", 400);
    this.tx(() => {
      const existing = this.one<Session>("SELECT * FROM session");
      if (existing) {
        this.owned(r.owner_id, r.session_id);
        if (existing.creation_hash !== r.creation_hash) throw new Fault("IDEMPOTENCY_CONFLICT");
        return;
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO session(singleton,id,owner_id,merchant_id,creation_hash,pricing_version,budget_cents,state,created_at,approval_deadline) VALUES(1,?,?,?,?,?,?,'CREATED',?,?)",
        r.session_id,
        r.owner_id,
        r.merchant_id,
        r.creation_hash,
        r.pricing_version,
        r.budget_cents,
        r.created_at,
        r.approval_deadline,
      );
      this.job("EXPIRY", r.approval_deadline);
      this.changed();
    });
    await this.arm(true);
    const s = this.session();
    if (
      s.state === "CREATED" &&
      !this.one("SELECT * FROM payment_operations WHERE kind=?", "CREATE_ORDER")
    ) {
      if (Date.now() >= s.approval_deadline) {
        this.tx(() => {
          this.ctx.storage.sql.exec("UPDATE session SET state='EXPIRED'");
          this.removeJob("EXPIRY");
          this.changed();
        });
      } else {
        const nonce = crypto.randomUUID();
        const callbackState = await signBrowser(
          {
            aud: "callback",
            owner: s.owner_id,
            session: s.id,
            csrf: nonce,
            exp: s.approval_deadline,
          },
          this.env.OWNER_TOKEN_SIGNING_KEY,
        );
        const payload = this.paypal.createPayload({ ...s, callbackState });
        const op = await this.prepare("CREATE_ORDER", payload, await hash(nonce));
        if (op)
          try {
            const result = await this.paypal.create(s, op.payload_json, op.request_id);
            this.tx(() => {
              if (!this.current("CREATE_ORDER", op.fence)) return;
              this.ctx.storage.sql.exec(
                "UPDATE payment_operations SET status='SUCCEEDED' WHERE kind='CREATE_ORDER'",
              );
              this.ctx.storage.sql.exec(
                "UPDATE session SET state='APPROVAL_PENDING',order_id=?,approval_url=?",
                result.id,
                result.url,
              );
              this.removeJob("PAYMENT_RECOVERY");
              this.changed();
            });
          } catch (error) {
            this.providerDelay(error);
            this.unknown("CREATE_ORDER");
          }
      }
    }
    await this.flush();
    await this.arm();
    return this.snapshot();
  }
  private async prepare(
    kind: string,
    payload: string,
    callbackHash?: string,
  ): Promise<Operation | undefined> {
    const digest = await hash(payload);
    return this.tx(() => {
      if (this.one("SELECT * FROM payment_operations WHERE kind=?", kind)) return;
      if (
        kind === "AUTHORIZE" &&
        (this.session().close_requested_at || Date.now() >= this.session().approval_deadline)
      )
        return;
      const now = Date.now();
      if (callbackHash)
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO callback_state VALUES(1,?,NULL)",
          callbackHash,
        );
      this.ctx.storage.sql.exec(
        "INSERT INTO payment_operations VALUES(?,?,?,?,'IN_FLIGHT',1,?,?)",
        kind,
        crypto.randomUUID(),
        payload,
        digest,
        now + 15000,
        now,
      );
      this.job("PAYMENT_RECOVERY", now + 15000);
      this.changed();
      return this.one<Operation>("SELECT * FROM payment_operations WHERE kind=?", kind);
    });
  }
  private current(kind: string, fence: number) {
    const op = this.one<Operation>("SELECT * FROM payment_operations WHERE kind=?", kind);
    return op?.fence === fence && op.status === "IN_FLIGHT";
  }
  private unknown(kind: string, review = false) {
    this.tx(() => {
      if (
        terminal.includes(this.session().state) ||
        (kind === "AUTHORIZE" && this.session().authorization_id)
      )
        return;
      this.ctx.storage.sql.exec(
        "UPDATE payment_operations SET status='UNKNOWN' WHERE kind=? AND status='IN_FLIGHT'",
        kind,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET state=?,last_error_code=?",
        review ? "MANUAL_REVIEW" : "RECONCILING",
        review ? "PAYMENT_REVIEW_REQUIRED" : "PAYMENT_RECONCILING",
      );
      this.removeJob("PAYMENT_RECOVERY");
      this.job("PAYMENT_RECOVERY", Math.max(Date.now() + 2000, this.cooldown()));
      this.changed();
    });
  }
  async callback(owner: string, id: string, state: string, orderToken: string, cancel: boolean) {
    const s = this.owned(owner, id);
    const row = this.one<{ nonce: string; consumed_at: number | null }>(
      "SELECT * FROM callback_state",
    );
    if (!row || row.consumed_at || Date.now() >= s.approval_deadline || orderToken !== s.order_id)
      throw new Fault("FORBIDDEN", 403);
    const bound = await readSigned(state, this.env.OWNER_TOKEN_SIGNING_KEY, "callback");
    if (
      !bound ||
      bound.owner !== owner ||
      bound.session !== id ||
      (await hash(bound.csrf)) !== row.nonce
    )
      throw new Fault("FORBIDDEN", 403);
    this.tx(() => {
      const current = this.one<{ consumed_at: number | null }>(
        "SELECT consumed_at FROM callback_state",
      );
      if (current?.consumed_at) throw new Fault("FORBIDDEN", 403);
      this.ctx.storage.sql.exec("UPDATE callback_state SET consumed_at=?", Date.now());
    });
    return cancel ? this.close(owner, id) : this.activate(owner, id);
  }
  async status(owner: string, id: string) {
    this.owned(owner, id);
    return this.snapshot();
  }
  async inspect(owner: string, id: string) {
    this.owned(owner, id);
    return {
      snapshot: this.snapshot(),
      operations: this.rows(
        "SELECT kind,request_id,payload_hash,status,fence,lease_until,first_sent_at FROM payment_operations",
      ),
      settlement:
        this.one(
          "SELECT kind,request_id,payload_hash,amount_cents,status,fence,lease_until,capture_id,release_evidence FROM settlement",
        ) ?? null,
      jobs: this.rows("SELECT kind,due_at,attempts FROM jobs ORDER BY due_at"),
      recovery: this.rows("SELECT * FROM recovery_state"),
      inbox: this.rows("SELECT outcome,count(*) AS count FROM webhook_inbox GROUP BY outcome"),
      pendingOutbox:
        this.one<{ count: number }>(
          "SELECT count(*) AS count FROM outbox WHERE delivered_at IS NULL",
        )?.count ?? 0,
    };
  }
  async activate(owner: string, id: string) {
    let s = this.owned(owner, id);
    if (s.state === "ACTIVE" || terminal.includes(s.state)) return this.snapshot();
    await this.arm(true);
    if (!s.order_id) return this.snapshot();
    try {
      const o = await this.paypal.order(s);
      s = this.session();
      if (o.purchase_units[0].payments?.authorizations?.length) {
        const a = this.paypal.validateAuthorization(o, s);
        this.acceptAuthorization(a);
      } else if (s.close_requested_at || Date.now() >= s.approval_deadline) {
        await this.expireApproval();
      } else if (o.status !== "APPROVED") throw new Fault("AWAITING_BUYER_APPROVAL", 409);
      else {
        const op = await this.prepare("AUTHORIZE", "{}");
        if (op) {
          this.tx(() => {
            this.ctx.storage.sql.exec("UPDATE session SET state='AUTHORIZING'");
            this.changed();
          });
          const a = await this.paypal.authorize(s, op.payload_json, op.request_id);
          if (this.current("AUTHORIZE", op.fence)) this.acceptAuthorization(a);
        }
      }
    } catch (e) {
      if (e instanceof Fault && e.code === "AWAITING_BUYER_APPROVAL") throw e;
      this.providerDelay(e);
      this.unknown("AUTHORIZE", e instanceof Fault && e.code === "PAYMENT_REVIEW_REQUIRED");
    }
    if (this.session().close_requested_at) await this.settle();
    await this.flush();
    await this.arm();
    return this.snapshot();
  }
  private acceptAuthorization(a: { id: string; status: string; expiration_time?: string }) {
    this.tx(() => {
      const s = this.session();
      if (s.authorization_id && s.authorization_id !== a.id)
        throw new Fault("PAYMENT_REVIEW_REQUIRED");
      if (terminal.includes(s.state) || s.authorization_id === a.id) return;
      const now = Date.now();
      const closing = s.close_requested_at !== null || now >= s.approval_deadline;
      this.ctx.storage.sql.exec(
        "UPDATE payment_operations SET status='SUCCEEDED' WHERE kind='AUTHORIZE'",
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET authorization_id=?,authorization_status=?,state=?,idle_deadline=?,hard_deadline=?,close_requested_at=?",
        a.id,
        a.status,
        closing ? "CLOSING" : "ACTIVE",
        now + 900000,
        Math.min(now + 1800000, Date.parse(a.expiration_time ?? "") - 60000),
        closing ? (s.close_requested_at ?? now) : null,
      );
      this.removeJob("PAYMENT_RECOVERY");
      this.removeJob("EXPIRY");
      this.ctx.storage.sql.exec("DELETE FROM recovery_state WHERE kind='PAYMENT_RECOVERY'");
      this.job(
        "EXPIRY",
        closing ? now : Math.min(now + 900000, Date.parse(a.expiration_time ?? "") - 60000),
      );
      this.changed();
    });
  }
  async call(
    owner: string,
    name: ToolName,
    args: unknown,
    meta: CallMeta,
  ): Promise<Record<string, unknown>> {
    callMetaSchema.parse(meta);
    this.owned(owner, meta.sessionId);
    const tool = quote(name);
    const parsed = tool.schema.parse(args);
    const encoded = canonical(parsed);
    if (new TextEncoder().encode(encoded).length > 8192) throw new Fault("INVALID_INPUT", 400);
    const digest = await hash(
      canonical({
        name,
        args: parsed,
        pricingVersion: meta.pricingVersion,
        price: tool.priceCents,
        max: meta.maxPriceCents,
      }),
    );
    await this.arm(true);
    const reservation = this.tx(() => {
      const s = this.owned(owner, meta.sessionId),
        old = this.one<Call>("SELECT * FROM calls WHERE call_key=?", meta.callKey);
      if (old) {
        if (old.input_hash !== digest) throw new Fault("IDEMPOTENCY_CONFLICT");
        if (old.state === "SUCCEEDED") return { replay: old };
        throw new Fault(old.state === "FAILED" ? "PREVIOUS_CALL_FAILED" : "CALL_IN_PROGRESS");
      }
      if (
        s.close_requested_at ||
        [
          "CLOSING",
          "SETTLING",
          "CAPTURED",
          "VOIDED",
          "EXPIRED",
          "RECONCILING",
          "MANUAL_REVIEW",
        ].includes(s.state)
      )
        throw new Fault("SESSION_CLOSING");
      if (s.state !== "ACTIVE") return { offer: true };
      if (Date.now() >= (s.idle_deadline ?? 0) || Date.now() >= (s.hard_deadline ?? 0))
        throw new Fault("SESSION_EXPIRED");
      if (meta.maxPriceCents < tool.priceCents) throw new Fault("PRICE_NOT_ACCEPTED");
      if (s.used_cents + s.reserved_cents + tool.priceCents > s.budget_cents)
        throw new Fault("BUDGET_EXHAUSTED", 402);
      const running =
        this.one<{ n: number }>(
          "SELECT count(*) AS n FROM calls WHERE state IN ('RUNNING','UNKNOWN')",
        )?.n ?? 0;
      const completed = this.one<{ n: number }>("SELECT count(*) AS n FROM ledger")?.n ?? 0;
      if (running >= 4 || completed + running >= 20) throw new Fault("CALL_LIMIT");
      this.ctx.storage.sql.exec(
        "INSERT INTO calls VALUES(?,?,?,?,?,'RUNNING',1,1,?,NULL,NULL,NULL)",
        meta.callKey,
        name,
        encoded,
        digest,
        tool.priceCents,
        Date.now() + 15000,
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET reserved_cents=reserved_cents+?",
        tool.priceCents,
      );
      this.job("CALL_RECOVERY", Date.now() + 15000);
      this.changed();
      return { call: this.one<Call>("SELECT * FROM calls WHERE call_key=?", meta.callKey) };
    });
    if (reservation.replay) return this.callResult(reservation.replay, true);
    if (reservation.offer)
      return {
        schemaVersion: 1,
        code: "PAYMENT_REQUIRED",
        status: 402,
        merchant: this.env.MERCHANT_ID,
        currency: "USD",
        priceCents: tool.priceCents,
        pricingVersion: PRICING_VERSION,
        ...this.snapshot(),
        nextAction: "OPEN_APPROVAL_URL",
        retryableAfter: "AUTHORIZATION_ACTIVE",
      };
    const c = reservation.call;
    if (!c) throw new Fault("INTERNAL_ERROR", 500);
    await this.execute(c);
    await this.flush();
    await this.arm();
    const completed = this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
    if (completed?.state !== "SUCCEEDED")
      throw new Fault(completed?.state === "FAILED" ? "TOOL_FAILED" : "CALL_IN_PROGRESS");
    return this.callResult(completed, false);
  }
  // Only deterministic, side-effect-free fixture tools are admitted by this spike.
  async executeFixture(name: ToolName, args: unknown): Promise<unknown> {
    return fixture(name, args);
  }
  private async execute(c: Call) {
    let result: string;
    try {
      result = JSON.stringify(
        await this.executeFixture(c.tool as ToolName, JSON.parse(c.canonical_args)),
      );
      if (new TextEncoder().encode(result).length > 16384) throw new Fault("RESULT_TOO_LARGE");
    } catch {
      this.tx(() => {
        const current = this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
        if (current?.state !== "RUNNING" || current.fence !== c.fence) return;
        this.ctx.storage.sql.exec(
          "UPDATE calls SET state='FAILED',error_code='TOOL_FAILED' WHERE call_key=?",
          c.call_key,
        );
        this.ctx.storage.sql.exec(
          "UPDATE session SET reserved_cents=reserved_cents-?",
          c.price_cents,
        );
        this.changed();
      });
      return;
    }
    const digest = await hash(result);
    // Finalization errors deliberately escape; successful execution must not be reclassified as failure.
    this.tx(() => {
      const current = this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
      if (current?.state !== "RUNNING" || current.fence !== c.fence) return;
      this.ctx.storage.sql.exec(
        "UPDATE calls SET state='SUCCEEDED',result_json=?,result_hash=? WHERE call_key=?",
        result,
        digest,
        c.call_key,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO ledger(call_key,amount_cents,result_hash,committed_at) VALUES(?,?,?,?)",
        c.call_key,
        c.price_cents,
        digest,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET reserved_cents=reserved_cents-?,used_cents=used_cents+?,idle_deadline=min(?,hard_deadline)",
        c.price_cents,
        c.price_cents,
        Date.now() + 900000,
      );
      if (this.session().used_cents === this.session().budget_cents) {
        this.ctx.storage.sql.exec(
          "UPDATE session SET state='CLOSING',close_requested_at=coalesce(close_requested_at,?)",
          Date.now(),
        );
        this.job("EXPIRY", Date.now());
      }
      this.changed();
    });
    if (this.session().close_requested_at) await this.settle();
  }
  private callResult(c: Call, replayed: boolean) {
    const s = this.snapshot();
    return {
      result: JSON.parse(c.result_json ?? "null") as unknown,
      callKey: c.call_key,
      accruedCents: c.price_cents,
      additionalAccruedCents: replayed ? 0 : c.price_cents,
      usedCents: s.usedCents,
      reservedCents: s.reservedCents,
      availableCents: s.availableCents,
      replayed,
    };
  }
  async close(owner: string, id: string) {
    this.owned(owner, id);
    await this.arm(true);
    this.tx(() => {
      const s = this.session();
      if (terminal.includes(s.state)) return;
      this.ctx.storage.sql.exec(
        "UPDATE session SET close_requested_at=coalesce(close_requested_at,?),state=CASE WHEN state='ACTIVE' THEN 'CLOSING' ELSE state END",
        Date.now(),
      );
      this.job("EXPIRY", Date.now());
      this.changed();
    });
    if (this.session().authorization_id) await this.settle();
    else await this.expireApproval();
    await this.flush();
    await this.arm();
    return this.snapshot();
  }
  private async settle() {
    const s = this.session();
    if (
      !s.close_requested_at ||
      !s.authorization_id ||
      s.reserved_cents > 0 ||
      terminal.includes(s.state)
    )
      return;
    await this.arm(true);
    const payload = s.used_cents ? this.paypal.capturePayload(s, s.used_cents) : "{}",
      digest = await hash(payload);
    const op = this.tx(() => {
      if (this.one("SELECT * FROM settlement")) return;
      const current = this.session();
      if (current.reserved_cents || current.used_cents !== s.used_cents)
        throw new Fault("SETTLEMENT_CONFLICT");
      const sum = this.one<{ n: number }>(
        "SELECT coalesce(sum(amount_cents),0) AS n FROM ledger",
      )?.n;
      if (sum !== s.used_cents) throw new Fault("LEDGER_MISMATCH");
      this.ctx.storage.sql.exec(
        "INSERT INTO settlement(singleton,kind,authorization_id,amount_cents,request_id,payload_json,payload_hash,status,fence,lease_until,first_sent_at) VALUES(1,?,?,?,?,?,?,'IN_FLIGHT',1,?,?)",
        s.used_cents ? "CAPTURE" : "VOID",
        s.authorization_id,
        s.used_cents,
        crypto.randomUUID(),
        payload,
        digest,
        Date.now() + 15000,
        Date.now(),
      );
      this.ctx.storage.sql.exec("UPDATE session SET state='SETTLING'");
      this.removeJob("EXPIRY");
      this.job("PAYMENT_RECOVERY", Date.now() + 15000);
      this.changed();
      return this.one<Settlement>("SELECT * FROM settlement");
    });
    if (!op) return;
    try {
      const authorization = await this.paypal.authorization(s.authorization_id);
      if (
        authorization.id !== s.authorization_id ||
        !centsEqual(authorization.amount.value, s.budget_cents)
      )
        throw new Fault("PAYMENT_REVIEW_REQUIRED");
      if (op.kind === "VOID" && ["EXPIRED", "VOIDED"].includes(authorization.status)) {
        await this.confirmVoid();
        return;
      }
      if (authorization.status !== "CREATED") throw new Fault("PAYMENT_REVIEW_REQUIRED");
      if (op.kind === "CAPTURE") {
        const c = await this.paypal.capture(s, op.payload_json, op.request_id);
        this.tx(() => {
          this.ctx.storage.sql.exec("UPDATE settlement SET capture_id=?", c.id);
          this.changed();
        });
        await this.confirmCapture(c);
      } else {
        await this.paypal.void(s, op.request_id);
        await this.confirmVoid();
      }
    } catch (e) {
      this.providerDelay(e);
      this.settlementUnknown(e instanceof Fault && e.code === "PAYMENT_REVIEW_REQUIRED");
    }
  }
  private settlementUnknown(review = false) {
    this.tx(() => {
      if (terminal.includes(this.session().state)) return;
      this.ctx.storage.sql.exec("UPDATE settlement SET status=?", review ? "REVIEW" : "UNKNOWN");
      this.ctx.storage.sql.exec(
        "UPDATE session SET state=?,last_error_code=?",
        review ? "MANUAL_REVIEW" : "RECONCILING",
        review ? "PAYMENT_REVIEW_REQUIRED" : "PAYMENT_RECONCILING",
      );
      this.removeJob("PAYMENT_RECOVERY");
      this.job("PAYMENT_RECOVERY", Math.max(Date.now() + 2000, this.cooldown()));
      this.changed();
    });
  }
  private async confirmCapture(initial?: Capture) {
    const s = this.session(),
      st = this.one<Settlement>("SELECT * FROM settlement");
    if (st?.kind !== "CAPTURE") throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const o = await this.paypal.order(s);
    const captures = o.purchase_units[0].payments?.captures ?? [];
    if (captures.length > 1) throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const id = st.capture_id ?? initial?.id ?? captures[0]?.id;
    if (!id) throw new Fault("PAYMENT_RECONCILING", 202);
    if (captures.length === 1 && captures[0].id !== id) throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const c = this.paypal.validateCapture(await this.paypal.captureDetail(id), s, st.amount_cents);
    const a = await this.paypal.authorization(s.authorization_id as string);
    if (a.id !== s.authorization_id || centsEqual(a.amount.value, s.budget_cents) === false)
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    if (c.status === "COMPLETED" && a.status === "CREATED")
      throw new Fault("PAYMENT_RECONCILING", 202);
    if (c.status === "COMPLETED" && a.status !== "CAPTURED")
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    this.tx(() => {
      if (terminal.includes(this.session().state)) return;
      this.ctx.storage.sql.exec(
        "UPDATE settlement SET capture_id=?,status=?,release_evidence=?",
        c.id,
        c.status === "COMPLETED" ? "SUCCEEDED" : "PENDING",
        c.status === "COMPLETED" ? "FINAL_CAPTURE" : "UNCONFIRMED",
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET state=?,authorization_status=?,last_error_code=NULL",
        c.status === "COMPLETED" ? "CAPTURED" : "RECONCILING",
        a.status,
      );
      if (c.status === "COMPLETED") this.removeJob("PAYMENT_RECOVERY");
      else this.job("PAYMENT_RECOVERY", Date.now() + 2000);
      this.changed();
    });
  }
  private retryJob(kind: string) {
    const now = Date.now();
    this.tx(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO recovery_state(kind,attempts,first_at) VALUES(?,0,?)",
        kind,
        now,
      );
      const row = this.one<{ attempts: number; first_at: number; review_checks: number }>(
        "SELECT * FROM recovery_state WHERE kind=?",
        kind,
      )!;
      const elapsed = now - row.first_at;
      this.removeJob(kind);
      if (kind === "PAYMENT_RECOVERY" && elapsed >= 1800000) {
        if (!terminal.includes(this.session().state) && this.session().state !== "MANUAL_REVIEW") {
          this.ctx.storage.sql.exec("UPDATE session SET state='MANUAL_REVIEW'");
          this.changed();
        }
        if (row.review_checks >= 24) return;
      }
      const next = Math.max(
        now + retryDelay(kind, row.attempts, elapsed),
        kind === "PROJECTION" ? 0 : this.cooldown(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE recovery_state SET attempts=attempts+1,review_checks=review_checks+?,next_at=? WHERE kind=?",
        kind === "PAYMENT_RECOVERY" && elapsed >= 1800000 ? 1 : 0,
        next,
        kind,
      );
      this.job(kind, next);
    });
  }
  private cooldown() {
    return this.one<{ until_at: number }>("SELECT until_at FROM provider_cooldown")?.until_at ?? 0;
  }
  private providerDelay(error: unknown) {
    if (error instanceof Fault && error.retryAfterMs > 0)
      this.ctx.storage.sql.exec(
        "INSERT INTO provider_cooldown VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET until_at=max(until_at,excluded.until_at)",
        Date.now() + error.retryAfterMs,
      );
  }
  private async confirmVoid() {
    const s = this.session();
    const a = await this.paypal.authorization(s.authorization_id as string);
    if (
      a.id !== s.authorization_id ||
      !centsEqual(a.amount.value, s.budget_cents) ||
      !["VOIDED", "EXPIRED"].includes(a.status)
    )
      throw new Fault("PAYMENT_RECONCILING", 202);
    this.tx(() => {
      this.ctx.storage.sql.exec(
        "UPDATE settlement SET status='SUCCEEDED',release_evidence=?",
        a.status === "EXPIRED" ? "EXPIRED" : "VOIDED",
      );
      this.ctx.storage.sql.exec(
        "UPDATE session SET state=?,authorization_status=?,last_error_code=NULL",
        a.status === "EXPIRED" ? "EXPIRED" : "VOIDED",
        a.status,
      );
      this.removeJob("PAYMENT_RECOVERY");
      this.removeJob("EXPIRY");
      this.changed();
    });
  }
  private async expireApproval() {
    const s = this.session();
    if (s.authorization_id) return this.settle();
    if (!s.order_id) {
      if (this.one("SELECT * FROM payment_operations WHERE status IN ('IN_FLIGHT','UNKNOWN')"))
        return;
      this.tx(() => {
        this.ctx.storage.sql.exec("UPDATE session SET state='EXPIRED'");
        this.removeJob("EXPIRY");
        this.changed();
      });
      return;
    }
    const o = await this.paypal.order(s);
    if (o.purchase_units[0].payments?.authorizations?.length) {
      this.acceptAuthorization(this.paypal.validateAuthorization(o, s));
      return this.settle();
    }
    if (
      this.one(
        "SELECT * FROM payment_operations WHERE kind='AUTHORIZE' AND status IN ('IN_FLIGHT','UNKNOWN')",
      )
    )
      return;
    this.tx(() => {
      this.ctx.storage.sql.exec("UPDATE session SET state='EXPIRED'");
      this.removeJob("EXPIRY");
      this.changed();
    });
  }
  // Explicit operator/webhook reconciliation performs provider GETs only.
  async reconcile(owner: string, id: string) {
    this.owned(owner, id);
    await this.arm(true);
    await this.readProvider();
    await this.flush();
    await this.arm();
    return this.snapshot();
  }
  async rebuildProjection(owner: string, id: string) {
    this.owned(owner, id);
    await this.arm(true);
    this.tx(() => this.changed());
    await this.flush();
    await this.arm();
    return this.snapshot();
  }
  private async readProvider() {
    if (this.cooldown() > Date.now()) throw new Fault("PAYMENT_RECONCILING", 202);
    const s = this.session();
    if (!s.order_id) return;
    const order = await this.paypal.order(s);
    if ((order.purchase_units[0].payments?.captures?.length ?? 0) > 1)
      throw new Fault("PAYMENT_REVIEW_REQUIRED");
    const st = this.one<Settlement>("SELECT * FROM settlement");
    if (st && !terminal.includes(s.state)) {
      if (st.kind === "CAPTURE") await this.confirmCapture();
      else await this.confirmVoid();
    } else if (
      !s.authorization_id &&
      !terminal.includes(s.state) &&
      order.purchase_units[0].payments?.authorizations?.length
    ) {
      this.acceptAuthorization(this.paypal.validateAuthorization(order, s));
    }
  }
  async receiveWebhook(input: VerifiedNotice) {
    const n = noticeSchema.parse(input);
    this.session();
    await this.arm(true);
    this.tx(() => {
      const prior = this.one<{ body_hash: string }>(
        "SELECT body_hash FROM webhook_inbox WHERE event_id=?",
        n.eventId,
      );
      if (prior && prior.body_hash !== n.bodyHash) {
        this.ctx.storage.sql.exec(
          "UPDATE webhook_inbox SET outcome='CONFLICT' WHERE event_id=?",
          n.eventId,
        );
        return;
      }
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO webhook_inbox VALUES(?,?,?,?,?,?,NULL,'PENDING')",
        n.eventId,
        n.eventType,
        n.resourceId,
        n.bodyHash,
        JSON.stringify(n),
        Date.now(),
      );
      this.job("WEBHOOK", Date.now());
    });
    await this.processWebhooks();
    await this.flush();
    await this.arm();
    return { accepted: true };
  }
  private async processWebhooks() {
    if (this.cooldown() > Date.now()) {
      if (this.one("SELECT 1 FROM webhook_inbox WHERE outcome='PENDING'"))
        this.job("WEBHOOK", this.cooldown());
      return;
    }
    const pending = this.rows<{ event_id: string; metadata_json: string }>(
      "SELECT event_id,metadata_json FROM webhook_inbox WHERE outcome='PENDING' ORDER BY received_at LIMIT 20",
    );
    for (const row of pending) {
      const n = noticeSchema.parse(JSON.parse(row.metadata_json));
      try {
        let s = this.session();
        if (n.sessionId && n.sessionId !== s.id) throw new Fault("PAYMENT_REVIEW_REQUIRED");
        const orderId = s.order_id ?? n.orderId;
        if (!orderId) throw new Fault("PAYMENT_RECONCILING", 202);
        const order = await this.paypal.order({ ...s, order_id: orderId });
        if (n.orderId && n.orderId !== order.id) throw new Fault("PAYMENT_REVIEW_REQUIRED");
        const units = order.purchase_units[0];
        if ((units.payments?.captures?.length ?? 0) > 1) throw new Fault("PAYMENT_REVIEW_REQUIRED");
        const resourceMatches = n.eventType.startsWith("CHECKOUT.ORDER.")
          ? n.resourceId === order.id
          : n.eventType.startsWith("PAYMENT.AUTHORIZATION.")
            ? units.payments?.authorizations?.some((a) => a.id === n.resourceId)
            : units.payments?.captures?.some((c) => c.id === (n.captureId ?? n.resourceId));
        if (!resourceMatches) throw new Fault("PAYMENT_RECONCILING", 202);
        if (
          n.authorizationId &&
          !units.payments?.authorizations?.some((a) => a.id === n.authorizationId)
        )
          throw new Fault("PAYMENT_REVIEW_REQUIRED");
        if (!s.order_id)
          this.tx(() => {
            if (this.session().order_id) return;
            this.ctx.storage.sql.exec(
              "UPDATE session SET order_id=?,state='APPROVAL_PENDING'",
              order.id,
            );
            this.ctx.storage.sql.exec(
              "UPDATE payment_operations SET status='SUCCEEDED' WHERE kind='CREATE_ORDER'",
            );
            this.changed();
          });
        s = this.session();
        if (["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(n.eventType)) {
          const st = this.one<Settlement>("SELECT * FROM settlement");
          const captureId = n.captureId ?? n.resourceId;
          if (st?.capture_id !== captureId) throw new Fault("PAYMENT_REVIEW_REQUIRED");
          const c = await this.paypal.captureDetail(captureId);
          if (
            c.supplementary_data?.related_ids?.order_id !== s.order_id ||
            c.supplementary_data.related_ids.authorization_id !== s.authorization_id
          )
            throw new Fault("PAYMENT_REVIEW_REQUIRED");
          this.tx(() => {
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO session_metadata VALUES(1,?)",
              n.eventType,
            );
            this.changed();
          });
        } else await this.readProvider();
        this.ctx.storage.sql.exec(
          "UPDATE webhook_inbox SET processed_at=?,outcome='APPLIED' WHERE event_id=? AND outcome='PENDING'",
          Date.now(),
          n.eventId,
        );
      } catch (error) {
        this.providerDelay(error);
        if (error instanceof Fault && error.code === "PAYMENT_REVIEW_REQUIRED")
          this.tx(() => {
            this.ctx.storage.sql.exec(
              "UPDATE webhook_inbox SET outcome='REVIEW' WHERE event_id=?",
              n.eventId,
            );
            this.ctx.storage.sql.exec(
              "INSERT OR REPLACE INTO session_metadata VALUES(1,'WEBHOOK_REVIEW')",
            );
            this.changed();
          });
      }
    }
    this.removeJob("WEBHOOK");
    if (this.one("SELECT 1 FROM webhook_inbox WHERE outcome='PENDING'")) this.retryJob("WEBHOOK");
  }
  async recover() {
    if (!this.one("SELECT * FROM session")) return;
    await this.arm(true);
    await this.processWebhooks();
    let s = this.session();
    for (const c of this.rows<Call>(
      "SELECT * FROM calls WHERE state IN ('RUNNING','UNKNOWN') AND lease_until<=?",
      Date.now(),
    )) {
      const live = this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
      if (
        !live ||
        !["RUNNING", "UNKNOWN"].includes(live.state) ||
        live.fence !== c.fence ||
        live.lease_until > Date.now()
      )
        continue;
      if (!["market_lookup", "landed_cost"].includes(c.tool)) {
        this.tx(() => {
          this.ctx.storage.sql.exec(
            "UPDATE calls SET state='UNKNOWN' WHERE call_key=?",
            c.call_key,
          );
          this.ctx.storage.sql.exec("UPDATE session SET state='MANUAL_REVIEW'");
          this.changed();
        });
        continue;
      }
      if (c.attempt >= 2) {
        this.tx(() => {
          this.ctx.storage.sql.exec(
            "UPDATE calls SET state='FAILED',error_code='RECOVERY_EXHAUSTED',fence=fence+1 WHERE call_key=?",
            c.call_key,
          );
          this.ctx.storage.sql.exec(
            "UPDATE session SET reserved_cents=reserved_cents-?",
            c.price_cents,
          );
          this.changed();
        });
        continue;
      }
      const claimed = this.tx(() => {
        const live = this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
        if (
          !live ||
          !["RUNNING", "UNKNOWN"].includes(live.state) ||
          live.fence !== c.fence ||
          live.lease_until > Date.now()
        )
          return;
        this.ctx.storage.sql.exec(
          "UPDATE calls SET state='RUNNING',attempt=attempt+1,fence=fence+1,lease_until=? WHERE call_key=?",
          Date.now() + 15000,
          c.call_key,
        );
        this.changed();
        return this.one<Call>("SELECT * FROM calls WHERE call_key=?", c.call_key);
      });
      if (claimed) await this.execute(claimed);
    }
    this.removeJob("CALL_RECOVERY");
    const next = this.one<{ due: number }>(
      "SELECT min(lease_until) AS due FROM calls WHERE state IN ('RUNNING','UNKNOWN')",
    )?.due;
    if (next) this.job("CALL_RECOVERY", Math.max(Date.now() + 60000, next));
    s = this.session();
    const retry = this.one<{ next_at: number; review_checks: number }>(
      "SELECT * FROM recovery_state WHERE kind='PAYMENT_RECOVERY'",
    );
    const canRead =
      this.cooldown() <= Date.now() &&
      (!retry || (retry.next_at <= Date.now() && retry.review_checks < 24));
    try {
      const st = this.one<Settlement>("SELECT * FROM settlement");
      if (canRead && st && !terminal.includes(s.state) && st.lease_until <= Date.now()) {
        if (st.kind === "CAPTURE") await this.confirmCapture();
        else await this.confirmVoid();
      } else if (canRead && !s.authorization_id && s.order_id && !terminal.includes(s.state)) {
        const pending = this.one<Operation>(
          "SELECT * FROM payment_operations WHERE kind='AUTHORIZE'",
        );
        if (pending && pending.lease_until <= Date.now()) {
          const o = await this.paypal.order(s);
          if (o.purchase_units[0].payments?.authorizations?.length)
            this.acceptAuthorization(this.paypal.validateAuthorization(o, s));
        }
      }
      s = this.session();
      if (
        canRead &&
        !terminal.includes(s.state) &&
        (s.close_requested_at ||
          Date.now() >=
            (s.authorization_id
              ? Math.min(s.idle_deadline ?? Infinity, s.hard_deadline ?? Infinity)
              : s.approval_deadline))
      ) {
        this.tx(() => {
          this.ctx.storage.sql.exec(
            "UPDATE session SET close_requested_at=coalesce(close_requested_at,?),state=CASE WHEN state='ACTIVE' THEN 'CLOSING' ELSE state END",
            Date.now(),
          );
          this.changed();
        });
        if (s.authorization_id) await this.settle();
        else await this.expireApproval();
      }
    } catch (e) {
      this.providerDelay(e);
      if (this.one("SELECT * FROM settlement"))
        this.settlementUnknown(e instanceof Fault && e.code === "PAYMENT_REVIEW_REQUIRED");
      else this.unknown("AUTHORIZE");
    }
    // Reconciliation only reads provider resources. Unknown CREATE without an ID needs operator review.
    s = this.session();
    if (["RECONCILING", "AUTHORIZING", "SETTLING", "CREATED", "MANUAL_REVIEW"].includes(s.state)) {
      const oldest =
        this.one<{ t: number }>(
          "SELECT min(first_sent_at) AS t FROM (SELECT first_sent_at FROM payment_operations WHERE status IN ('IN_FLIGHT','UNKNOWN') UNION ALL SELECT first_sent_at FROM settlement WHERE status<>'SUCCEEDED')",
        )?.t ?? Date.now();
      if (Date.now() - oldest > 1800000 && s.state !== "MANUAL_REVIEW")
        this.tx(() => {
          this.ctx.storage.sql.exec("UPDATE session SET state='MANUAL_REVIEW'");
          this.changed();
        });
      if (canRead) this.retryJob("PAYMENT_RECOVERY");
      else if (retry && retry.review_checks < 24) this.job("PAYMENT_RECOVERY", retry.next_at);
    }
    this.removeJob("EXPIRY");
    s = this.session();
    if (!terminal.includes(s.state) && s.state !== "MANUAL_REVIEW")
      this.job(
        "EXPIRY",
        Math.max(
          Date.now() + 30000,
          s.authorization_id
            ? Math.min(s.idle_deadline ?? Infinity, s.hard_deadline ?? Infinity)
            : s.approval_deadline,
        ),
      );
    await this.flush();
    await this.arm();
  }
  async alarm() {
    await this.recover();
  }
  async flush() {
    const out = this.one<{ event_id: string; session_version: number; snapshot_json: string }>(
      "SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY session_version DESC LIMIT 1",
    );
    if (!out) return;
    const v = JSON.parse(out.snapshot_json) as Snapshot & {
      usage?: { call_key: string; tool: string; amount_cents: number; committed_at: number }[];
      charge?: Settlement;
    };
    const due = terminal.includes(v.state) ? Number.MAX_SAFE_INTEGER : Date.now() + 300000;
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "INSERT INTO session_projection VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,state=excluded.state,used_cents=excluded.used_cents,reserved_cents=excluded.reserved_cents,captured_cents=excluded.captured_cents,snapshot_json=excluded.snapshot_json,projected_at=excluded.projected_at WHERE excluded.version>session_projection.version",
        ).bind(
          v.sessionId,
          v.version,
          v.state,
          v.usedCents,
          v.reservedCents,
          v.capturedCents,
          out.snapshot_json,
          Date.now(),
        ),
        this.env.DB.prepare(
          "UPDATE session_index SET mapping_version=?,recovery_due_at=?,order_id=?,authorization_id=? WHERE session_id=? AND mapping_version<?",
        ).bind(v.version, due, v.orderId, v.authorizationId, v.sessionId, v.version),
        ...(v.charge
          ? [
              this.env.DB.prepare(
                `INSERT INTO charge_projection VALUES(?,?,'sandbox',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,kind=excluded.kind,status=excluded.status,amount_cents=excluded.amount_cents,capture_id=excluded.capture_id,authorization_id=excluded.authorization_id,request_id=excluded.request_id,release_evidence=excluded.release_evidence,post_settlement_issue=excluded.post_settlement_issue,projected_at=excluded.projected_at WHERE excluded.version>charge_projection.version`,
              ).bind(
                v.sessionId,
                this.env.MERCHANT_ID,
                v.version,
                v.charge.kind,
                v.charge.status,
                v.charge.amount_cents,
                v.charge.capture_id,
                v.charge.authorization_id,
                v.charge.request_id,
                v.charge.release_evidence,
                v.postSettlementIssue ?? null,
                Date.now(),
              ),
            ]
          : []),
        ...(v.usage ?? []).map((row) =>
          this.env.DB.prepare("INSERT OR IGNORE INTO usage_projection VALUES(?,?,?,?,?)").bind(
            v.sessionId,
            row.call_key,
            row.tool,
            row.amount_cents,
            row.committed_at,
          ),
        ),
        this.env.DB.prepare("INSERT OR IGNORE INTO projection_receipts VALUES(?,?,?,?)").bind(
          out.event_id,
          v.sessionId,
          v.version,
          Date.now(),
        ),
      ]);
      this.tx(() => {
        this.ctx.storage.sql.exec(
          "UPDATE outbox SET delivered_at=? WHERE session_version<=?",
          Date.now(),
          out.session_version,
        );
        if (!this.one("SELECT * FROM outbox WHERE delivered_at IS NULL"))
          this.removeJob("PROJECTION");
      });
    } catch {
      this.retryJob("PROJECTION");
    }
  }
}
function centsEqual(value: string, expected: number) {
  return /^\d+\.\d{2}$/.test(value) && Number(value.replace(".", "")) === expected;
}
