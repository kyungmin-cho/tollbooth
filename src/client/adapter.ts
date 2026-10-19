import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Fault, PRICING_VERSION, quote, type ToolName } from "../domain/contracts";
import { defaultPolicy, policyCheck } from "../domain/policy";
import type { Snapshot } from "../shared/types";
export interface HumanHooks {
  approveCall: (price: number) => Promise<boolean>;
  approvePayment: (url: string) => Promise<void>;
}
export class TollboothClient {
  private client: Client;
  private session?: Snapshot;
  constructor(
    private origin: string,
    private token: string,
    private hooks: HumanHooks,
    private policy = defaultPolicy,
    private network: typeof fetch = fetch,
  ) {
    const u = new URL(origin);
    if (u.origin !== origin || !(u.protocol === "https:" || u.hostname === "127.0.0.1"))
      throw new Fault("UNTRUSTED_ORIGIN");
    this.client = new Client(
      { name: "tollbooth-local-adapter", version: "0.1.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
  }
  async connect(era: "modern" | "legacy" = "modern") {
    await this.client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", this.origin), {
        requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
        fetch: this.network,
      }),
      era === "legacy" ? { prior: { kind: "legacy" } } : undefined,
    );
    return this.client.listTools();
  }
  async rpc(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) {
    const result = (await this.client.callTool({
      name,
      arguments: args,
      ...(meta ? { _meta: { tollbooth: meta } } : {}),
    })) as CallToolResult;
    const data = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError)
      throw new Fault(
        typeof data?.code === "string" ? data.code : "TOOL_ERROR",
        typeof data?.status === "number" ? data.status : 400,
      );
    if (!data) throw new Fault("INVALID_RESPONSE");
    return data;
  }
  async restore(sessionId: string) {
    this.session = (await this.rpc("tollbooth_status", { sessionId })) as unknown as Snapshot;
    return this.session;
  }
  async call(name: ToolName, args: Record<string, unknown>, callKey: string, budget = 500) {
    const tool = quote(name);
    tool.schema.parse(args);
    const check = policyCheck(tool.priceCents, budget, "tollbooth.demo", this.policy);
    if (
      check.needsHuman &&
      !this.session?.ledger.some((entry) => entry.callKey === callKey) &&
      !(await this.hooks.approveCall(tool.priceCents))
    )
      throw new Fault("HUMAN_DECLINED");
    if (!this.session)
      this.session = (await this.rpc("tollbooth_open", {
        budgetCents: budget,
        creationKey: crypto.randomUUID(),
      })) as unknown as Snapshot;
    if (this.session.state === "APPROVAL_PENDING") {
      const url = new URL(this.session.approvalUrl ?? "");
      if (url.origin !== "https://www.sandbox.paypal.com")
        throw new Fault("UNTRUSTED_APPROVAL_URL");
      await this.hooks.approvePayment(url.href);
      const r = await this.network(
        `${this.origin}/api/sessions/${this.session.sessionId}/activate`,
        { method: "POST", headers: { Authorization: `Bearer ${this.token}` } },
      );
      this.session = (await r.json()) as Snapshot;
      if (!r.ok || this.session.state !== "ACTIVE") throw new Fault("AWAITING_BUYER_APPROVAL");
    }
    return this.rpc(name, args, {
      sessionId: this.session.sessionId,
      callKey,
      maxPriceCents: tool.priceCents,
      pricingVersion: PRICING_VERSION,
    });
  }
  async status() {
    if (!this.session) throw new Fault("NO_SESSION");
    return this.restore(this.session.sessionId);
  }
  async closeSession() {
    if (!this.session) throw new Fault("NO_SESSION");
    return this.rpc("tollbooth_close", { sessionId: this.session.sessionId });
  }
  async disconnect() {
    await this.client.close();
  }
}
