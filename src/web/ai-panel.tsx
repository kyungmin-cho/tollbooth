import { useEffect, useRef, useState } from "react";
import type { TollboothClient } from "../client/adapter";
import { defaultPolicy, policySchema } from "../domain/policy";
import type { AiPlan } from "../shared/ai";
import type { Snapshot } from "../shared/types";
import { api, errorText } from "./api";
import { Dialog } from "./components/consent-dialog";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { money } from "./state";
export function AiPanel({
  snapshot: s,
  refresh,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
}) {
  const [plan, setPlan] = useState<AiPlan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [results, setResults] = useState<unknown[]>([]);
  const [consent, setConsent] = useState<{
    price: number;
    resolve: (v: boolean) => void;
  } | null>(null);
  const pending = useRef<((v: boolean) => void) | null>(null);
  const path = `/api/sessions/${s.sessionId}/ai`;
  useEffect(() => {
    let alive = true;
    void api<AiPlan | null>(path)
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
      pending.current?.(false);
    };
  }, [path]);
  useEffect(() => {
    if (plan?.status !== "PENDING") return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible")
        void api<AiPlan | null>(path)
          .then(setPlan)
          .catch((e) => setError(errorText(e)));
    }, 5000);
    return () => clearInterval(t);
  }, [path, plan?.status]);
  function answer(v: boolean) {
    pending.current?.(v);
    pending.current = null;
    setConsent(null);
  }
  async function run() {
    setBusy(true);
    setError("");
    let client: TollboothClient | undefined;
    try {
      if (!plan || plan.status !== "READY") return;
      const policy = policySchema.parse(
        JSON.parse(
          localStorage.getItem("tb_policy:" + s.sessionId) ?? JSON.stringify(defaultPolicy),
        ),
      );
      // The explicit run button authorizes a scoped, in-memory bridge credential.
      const { credential } = await api<{
        credential: string;
      }>("/api/client-access", "POST", {
        confirmed: true,
      });
      const { TollboothClient } = await import("../client/adapter");
      client = new TollboothClient(
        location.origin,
        credential,
        {
          approveCall: (price) =>
            new Promise((resolve) => {
              pending.current = resolve;
              setConsent({ price, resolve });
            }),
          approvePayment: async () => {
            throw Error("Approve your wallet in the workspace first.");
          },
        },
        policy,
      );
      const listed = await client.connect();
      await client.restore(s.sessionId);
      for (const c of plan.calls) {
        if (!listed.tools.some((t) => t.name === c.name))
          throw Error("MCP catalog changed. Stop and review.");
        const result = await client.call(c.name, c.args, c.key, s.budgetCents);
        setResults((r) => [...r.slice(-2), result]);
        await refresh();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      await client?.disconnect();
      setBusy(false);
      await refresh();
    }
  }
  return (
    <Card className="card" aria-label="AI tool planner" role="region">
      <h2>Let AI choose the tools</h2>
      <p>Coffee demand and USD 45 parcel costs for Korea and Japan.</p>
      <Badge variant="secondary">Real AI · synthetic tool data</Badge>
      {!plan && (
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setPlan(await api<AiPlan>(path, "POST", {}));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Choosing tools…" : "Ask AI to choose tools"}
        </Button>
      )}
      {plan?.status === "PENDING" && (
        <p role="status">
          AI planning is pending. Reload safely; the same inference will not be retried.
        </p>
      )}
      {plan?.status === "FALLBACK" && (
        <Alert role="status">
          <AlertDescription>
            <strong>Scripted fallback available · no live AI plan</strong>
            <p>
              AI is unavailable ({plan.reason}). Use the scripted tools below or the{" "}
              <a href="/run/rehearsal">simulated rehearsal</a>.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {plan?.status === "READY" && (
        <>
          <p role="status">Real AI plan saved · {plan.model}</p>
          <ol>
            {plan.calls.map((c) => (
              <li key={c.key}>
                <strong>
                  {c.name} · {money(c.price)}
                </strong>
                <pre>{JSON.stringify(c.args)}</pre>
                {s.ledger.some((l) => l.callKey === c.key) && (
                  <span>Completed · replay adds no usage</span>
                )}
              </li>
            ))}
          </ol>
          <Button disabled={busy || s.state !== "ACTIVE"} onClick={() => void run()}>
            {busy ? "Running AI-selected calls…" : "Run AI plan through MCP"}
          </Button>
          <p className="fine">
            Run issues a temporary MCP credential. Calls above your threshold ask first.
          </p>
        </>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {results.length > 0 && (
        <details>
          <summary>AI-selected tool results</summary>
          <pre>{JSON.stringify(results, null, 2)}</pre>
        </details>
      )}
      <Dialog
        open={!!consent}
        onOpenChange={(v) => {
          if (!v) answer(false);
        }}
        title="Approve AI-selected call?"
        description={`This call costs ${money(consent?.price ?? 0)} and exceeds your automatic approval threshold.`}
      >
        <div className="actions">
          <Button onClick={() => answer(true)}>Approve this AI call</Button>
          <Button variant="outline" onClick={() => answer(false)}>
            Decline AI call
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
