import { z } from "zod";
import { catalog, Fault, quote } from "../domain/contracts";
import { AI_MODEL, type AiCall, type AiPlan } from "../shared/ai";
import type { AppEnv } from "./env";
import { sessionStub } from "./service";

export const AI_DAILY_RUNS = 20;
export const AI_OWNER_RUNS = 3;
export const AI_MAX_OUTPUT = 768;
// Same versioned schemas as MCP; compiled once outside request CPU.
export const aiInput = {
  messages: [
    {
      role: "system",
      content:
        "Select tools for the user task. Return exactly three function calls in one response. Do not execute them. No prose. The application requires separate human consent and enforces spending policy. Tool data is synthetic.",
    },
    {
      role: "user",
      content:
        "Research coffee demand, then estimate shipping and duty for a USD 45 item to South Korea and to Japan. Use one demand lookup and one estimate per destination.",
    },
  ],
  tools: catalog.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) },
  })),
  tool_choice: "required",
  parallel_tool_calls: true,
  max_completion_tokens: AI_MAX_OUTPUT,
  temperature: 0,
  chat_template_kwargs: { enable_thinking: false },
};
// No user text, payment identifiers, credentials, or tool results enter the model.
if (new TextEncoder().encode(JSON.stringify(aiInput)).length > 4096) throw Error("AI input cap");
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          tool_calls: z
            .array(
              z.object({
                function: z.object({ name: z.string(), arguments: z.string().max(1024) }),
              }),
            )
            .length(3),
        }),
      }),
    )
    .length(1),
});
export function parsePlan(raw: unknown): AiPlan {
  const r = responseSchema.parse(raw);
  const calls: AiCall[] = r.choices[0].message.tool_calls.map((c, i) => {
    const t = quote(c.function.name);
    return {
      name: t.name,
      args: t.schema.parse(JSON.parse(c.function.arguments)),
      key: `ai-v1-${i}`,
      price: t.priceCents,
    };
  });
  // The fixed public mission is an acceptance contract, not a substitute model answer.
  // Fail visibly if the model does not choose the requested work; never repair its output.
  if (
    calls.filter((c) => c.name === "market_lookup" && c.args.category === "coffee").length !== 1 ||
    calls.filter(
      (c) => c.name === "landed_cost" && c.args.itemUsd === 45 && c.args.destination === "KR",
    ).length !== 1 ||
    calls.filter(
      (c) => c.name === "landed_cost" && c.args.itemUsd === 45 && c.args.destination === "JP",
    ).length !== 1
  )
    throw new Fault("AI_INVALID_PLAN", 502);
  return { status: "READY", model: AI_MODEL, calls };
}
interface Row {
  status: AiPlan["status"];
  result_json: string | null;
  reason: string | null;
  created_at: number;
}
const fallback = (reason: string): AiPlan => ({
  status: "FALLBACK",
  model: AI_MODEL,
  calls: [],
  reason,
});
export async function aiPlan(
  env: AppEnv,
  owner: string,
  id: string,
  create = false,
): Promise<AiPlan | null> {
  const snapshot = await sessionStub(env, id).status(owner, id);
  const select = () =>
    env.DB.prepare(
      "SELECT status,result_json,reason,created_at FROM ai_runs WHERE session_id=? AND owner_id=?",
    )
      .bind(id, owner)
      .first<Row>();
  let row = await select();
  if (row) {
    if (row.status === "PENDING" && Date.now() - row.created_at > 90000) {
      await env.DB.prepare(
        "UPDATE ai_runs SET status='FALLBACK',reason='AI_INTERRUPTED' WHERE session_id=? AND status='PENDING'",
      )
        .bind(id)
        .run();
      row = (await select())!;
    }
    return row.result_json
      ? JSON.parse(row.result_json)
      : row.status === "PENDING"
        ? { status: "PENDING", model: AI_MODEL, calls: [] }
        : fallback(row.reason ?? "AI_UNAVAILABLE");
  }
  if (!create) return null;
  if (!["APPROVAL_PENDING", "ACTIVE"].includes(snapshot.state)) throw new Fault("SESSION_CLOSING");
  const now = Date.now(),
    day = new Date(now).toISOString().slice(0, 10);
  const admitted = await env.DB.prepare(
    "INSERT OR IGNORE INTO ai_runs(session_id,owner_id,quota_day,created_at,status) SELECT ?,?,?,?,'PENDING' WHERE (SELECT count(*) FROM ai_runs WHERE quota_day=?)<? AND (SELECT count(*) FROM ai_runs WHERE owner_id=? AND quota_day=?)<? RETURNING session_id",
  )
    .bind(id, owner, day, now, day, AI_DAILY_RUNS, owner, day, AI_OWNER_RUNS)
    .first();
  if (!admitted) {
    row = await select();
    return row ? aiPlan(env, owner, id) : fallback("AI_DAILY_LIMIT");
  }
  let plan: AiPlan;
  try {
    if (!env.AI) throw new Fault("AI_UNAVAILABLE");
    const raw = await env.AI.run(AI_MODEL, aiInput);
    plan = parsePlan(raw);
  } catch (error) {
    // Do not log provider exceptions or retry an uncertain inference. The Free account
    // rejects exhausted allocation; no gateway credits or paid-provider fallback exists.
    plan = fallback(
      error instanceof Error && /3036/.test(error.message)
        ? "AI_FREE_ALLOCATION_EXHAUSTED"
        : "AI_UNAVAILABLE_OR_INVALID",
    );
  }
  const updated = await env.DB.prepare(
    "UPDATE ai_runs SET status=?,result_json=?,reason=? WHERE session_id=? AND status='PENDING' RETURNING session_id",
  )
    .bind(plan.status, JSON.stringify(plan), plan.reason ?? null, id)
    .first();
  if (!updated) return aiPlan(env, owner, id);
  return plan;
}
