import type { ToolName } from "../domain/contracts";
export const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export interface AiCall {
  name: ToolName;
  args: Record<string, unknown>;
  key: string;
  price: number;
}
export interface AiPlan {
  status: "PENDING" | "READY" | "FALLBACK";
  model: string;
  calls: AiCall[];
  reason?: string;
}
