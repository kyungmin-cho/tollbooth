import { useEffect, useState } from "react";
import { defaultPolicy, policyCheck, policySchema } from "../domain/policy";
import { demoSnapshot } from "../shared/demo";
import type { Snapshot } from "../shared/types";
import { AiPanel } from "./ai-panel";
import { api, errorText } from "./api";
import { Dialog } from "./components/consent-dialog";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Field, FieldLabel } from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Progress } from "./components/ui/progress";
import { Skeleton } from "./components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";
import { Textarea } from "./components/ui/textarea";
import { useSnapshot } from "./hooks";
import { finalStates, money, safeApproval, short, stateLabel } from "./state";
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="notice">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
export function Loading() {
  return (
    <Card className="card skeleton" role="status">
      <span className="sr-only">Loading authoritative state…</span>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </Card>
  );
}
function loadPolicy(id?: string) {
  try {
    return policySchema.parse(
      JSON.parse(localStorage.getItem(id ? "tb_policy:" + id : "tb_policy") ?? "null"),
    );
  } catch {
    return defaultPolicy;
  }
}
export function Landing() {
  const [budget, setBudget] = useState("5.00"),
    [policy, setPolicy] = useState(JSON.stringify(loadPolicy(), null, 2)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tools, setTools] = useState<
      {
        name: string;
        priceCents: number;
      }[]
    >([]);
  useEffect(() => {
    api<{
      tools: typeof tools;
    }>("/api/tools")
      .then((x) => setTools(x.tools))
      .catch((e) => setError(errorText(e)));
  }, []);
  async function open() {
    setError("");
    setBusy(true);
    try {
      if (!/^\d+\.\d{2}$/.test(budget))
        throw Error("Enter USD with exactly two decimal places (0.50–5.00).");
      const cents = Number(budget.replace(".", ""));
      if (cents < 50 || cents > 500) throw Error("Budget must be between USD 0.50 and USD 5.00.");
      let parsed;
      try {
        parsed = policySchema.parse(JSON.parse(policy));
      } catch {
        throw Error(
          "Policy must contain the four named fields with integer cents and an allowed merchant list.",
        );
      }
      policyCheck(20, cents, "tollbooth.demo", parsed);
      localStorage.setItem("tb_policy", JSON.stringify(parsed));
      const pending = JSON.parse(sessionStorage.getItem("tb_open") ?? "null") as {
        budget: number;
        key: string;
      } | null;
      const key = pending?.budget === cents ? pending.key : crypto.randomUUID();
      sessionStorage.setItem("tb_open", JSON.stringify({ budget: cents, key }));
      const s = await api<Snapshot>("/api/sessions", "POST", {
        budgetCents: cents,
        creationKey: key,
      });
      localStorage.setItem("tb_policy:" + s.sessionId, JSON.stringify(parsed));
      sessionStorage.removeItem("tb_open");
      location.assign("/run/" + s.sessionId);
    } catch (e) {
      setError(e instanceof Error && !("code" in e) ? e.message : errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="hero">
        <h1>Open a session</h1>

        <div className="actions">
          <Button render={<a href="/connect" />} className="w-fit">
            Connect AI →
          </Button>
          <a className="subtle-link" href="/run/rehearsal">
            Try a simulated rehearsal
          </a>
        </div>
      </section>
      <div className="two-col">
        <Card className="card">
          <h2>Tools</h2>
          {tools.length ? (
            tools.map((t) => (
              <div className="tool-row" key={t.name}>
                <div>
                  <strong>
                    {t.name === "market_lookup" ? "Market lookup" : "Landed cost estimate"}
                  </strong>
                  <p className="muted">
                    {t.name === "market_lookup"
                      ? "Compare demand for a product category."
                      : "Estimate a parcel’s shipping and duty."}
                  </p>
                </div>
                <strong>{money(t.priceCents)}</strong>
              </div>
            ))
          ) : (
            <p role="status">Loading tools…</p>
          )}
          <p className="muted">Synthetic data · not financial or customs advice.</p>
        </Card>
        <Card className="card">
          <h2>Spending policy</h2>
          <Field>
            <FieldLabel className="field">
              Session budget (USD)
              <Input
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </FieldLabel>
          </Field>
          <p className="muted">
            Per-call cap USD 0.50 · Ask above USD 0.30
            <br />
            Seller: tollbooth.demo
          </p>
          <details>
            <summary>Edit or import policy before opening</summary>
            <Field>
              <FieldLabel className="field">
                Policy JSON
                <Textarea rows={7} value={policy} onChange={(e) => setPolicy(e.target.value)} />
              </FieldLabel>
            </Field>
            <Field>
              <FieldLabel className="field">
                Import JSON file
                <Input
                  type="file"
                  accept="application/json,.json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f && f.size <= 8192) setPolicy(await f.text());
                    else setError("Choose a JSON policy smaller than 8 KiB.");
                  }}
                />
              </FieldLabel>
            </Field>
          </details>
          {error && <Notice>{error}</Notice>}
          <Button disabled={busy} onClick={() => void open()}>
            {busy ? "Opening…" : "Open session and review PayPal approval"}
          </Button>
          <p className="fine">
            Usage settles when you finish, after 15 idle minutes, or after 30 active minutes. Unused
            budget is not charged.
          </p>
        </Card>
      </div>
    </>
  );
}
export function Connect() {
  const [token, setToken] = useState<string>(),
    [expires, setExpires] = useState(0),
    [error, setError] = useState(""),
    [test, setTest] = useState("Waiting"),
    [copied, setCopied] = useState(false);
  return (
    <Card className="card narrow">
      <h1>Connect your AI host</h1>
      <p>Use built-in AI in your workspace, or connect an external host through MCP.</p>
      <ol className="steps">
        <li>Open a buyer session in this browser.</li>
        <li>Issue a one-hour scoped credential for your trusted adapter.</li>
        <li>Configure the endpoint and credential outside chat or model context.</li>
        <li>Ask your host to compare coffee demand and a USD 45 parcel to Korea and Japan.</li>
      </ol>
      <Field>
        <FieldLabel className="field">
          MCP endpoint
          <Input readOnly value={location.origin + "/mcp"} />
        </FieldLabel>
      </Field>
      <div className="actions">
        <Button
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(location.origin + "/mcp")}
        >
          Copy endpoint
        </Button>
        <Button
          onClick={async () => {
            try {
              const r = await api<{
                credential: string;
                expiresAt: number;
              }>("/api/client-access", "POST", { confirmed: true });
              setToken(r.credential);
              setExpires(r.expiresAt);
              setCopied(false);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          Issue access
        </Button>
      </div>
      {expires > 0 && (
        <div className="notice">
          Credential hidden · expires {new Date(expires).toLocaleTimeString()}
          <div className="actions">
            <Button
              disabled={!token}
              onClick={async () => {
                if (token) {
                  await navigator.clipboard.writeText(token);
                  setToken(undefined);
                  setCopied(true);
                }
              }}
            >
              {copied ? "Copied and hidden" : "Copy once"}
            </Button>
            <Button variant="outline" onClick={() => setToken(undefined)}>
              Hide
            </Button>
          </div>
        </div>
      )}
      <Button
        variant="outline"
        onClick={async () => {
          try {
            const r = await api<{
              tools: unknown[];
            }>("/api/tools");
            setTest(`${r.tools.length} tools discovered. Host connection is not verified.`);
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        Test catalog connection
      </Button>
      <p role="status">{test}</p>
      <details>
        <summary>Supported setup guide</summary>
        <p>
          The repository’s <code>src/client/adapter.ts</code> accepts the deployment origin, scoped
          token, and real human approval hooks. Restore the session ID from the workspace URL, keep
          a stable call key, and close explicitly. Disconnect does not settle a session. Never send
          the credential to an LLM.
        </p>
      </details>
      {error && <Notice>{error}</Notice>}
      <a href="/">Open a buyer workspace →</a>
    </Card>
  );
}
const calls = [
  {
    key: "browser-coffee",
    name: "market_lookup" as const,
    args: { category: "coffee" },
    label: "Look up coffee demand",
    price: 20,
  },
  {
    key: "browser-kr",
    name: "landed_cost" as const,
    args: { itemUsd: 45, destination: "KR" },
    label: "Estimate parcel to Korea",
    price: 35,
  },
  {
    key: "browser-jp",
    name: "landed_cost" as const,
    args: { itemUsd: 45, destination: "JP" },
    label: "Estimate parcel to Japan",
    price: 35,
  },
];
export function Buyer({ id, receipt = false }: { id: string; receipt?: boolean }) {
  return id === "rehearsal" ? (
    <Rehearsal receipt={receipt} />
  ) : (
    <LiveBuyer id={id} receipt={receipt} />
  );
}
function LiveBuyer({ id, receipt }: { id: string; receipt: boolean }) {
  const s = useSnapshot(id);
  return (
    <>
      {s.loading ? (
        <Loading />
      ) : s.snapshot ? (
        <Workspace
          snapshot={s.snapshot}
          accept={s.accept}
          refresh={s.refresh}
          updated={s.updated}
          receipt={receipt}
        />
      ) : (
        <Card className="card">
          <h1>Session access needed</h1>
          <p>Use the browser that opened this session. Session links do not transfer ownership.</p>
          <Button onClick={() => void s.refresh()}>Retry access</Button>
        </Card>
      )}
      {s.error && (
        <Notice>
          {s.error}{" "}
          <Button variant="outline" onClick={() => void s.refresh()}>
            Refresh status
          </Button>
        </Notice>
      )}
    </>
  );
}
function Rehearsal({ receipt }: { receipt: boolean }) {
  const [s, setS] = useState<Snapshot>(() => {
    try {
      return JSON.parse(localStorage.getItem("tb_demo") ?? "null") ?? demoSnapshot();
    } catch {
      return demoSnapshot();
    }
  });
  return (
    <>
      <Workspace
        snapshot={s}
        accept={(v) => {
          setS(v);
          localStorage.setItem("tb_demo", JSON.stringify(v));
        }}
        refresh={async () => {}}
        updated={Date.now()}
        receipt={receipt}
        simulated
      />
      <Button
        variant="outline"
        onClick={() => {
          setS(demoSnapshot());
          localStorage.removeItem("tb_demo");
        }}
      >
        Reset simulated rehearsal
      </Button>
    </>
  );
}
function Workspace({
  snapshot: s,
  accept,
  refresh,
  updated,
  receipt,
  simulated = false,
}: {
  snapshot: Snapshot;
  accept: (s: Snapshot) => void;
  refresh: () => Promise<void>;
  updated: number;
  receipt: boolean;
  simulated?: boolean;
}) {
  const [error, setError] = useState(""),
    [activity, setActivity] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState<number | null>(null),
    [closing, setClosing] = useState(false),
    [result, setResult] = useState<unknown>(),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const isFinal = finalStates.includes(s.state),
    authorized = Boolean(s.authorizationId) || simulated;
  const url = safeApproval(s.approvalUrl),
    deadline = authorized
      ? Math.min(s.idleDeadline ?? Infinity, s.hardDeadline ?? Infinity)
      : s.approvalDeadline;
  const append = (x: string) => setActivity((a) => [...a.slice(-19), x]);
  async function mutation(action: string) {
    setBusy(true);
    setError("");
    try {
      accept(await api<Snapshot>(`/api/sessions/${s.sessionId}/${action}`, "POST"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function execute(i: number, approved = false) {
    const c = calls[i],
      replay = s.ledger.some((x) => x.callKey === c.key);
    setError("");
    try {
      const p = loadPolicy(s.sessionId);
      const check = policyCheck(c.price, s.budgetCents, "tollbooth.demo", p);
      if (check.needsHuman && !approved && !replay) {
        setConsent(i);
        return;
      }
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setConsent(null);
    setBusy(true);
    try {
      if (simulated) {
        const used = s.usedCents + (replay ? 0 : c.price);
        accept({
          ...s,
          version: s.version + 1,
          usedCents: used,
          availableCents: 500 - used,
          ledger: replay ? s.ledger : [...s.ledger, { callKey: c.key, amountCents: c.price }],
        });
        setResult({ source: "Simulated synthetic fixture", tool: c.name });
      } else {
        const r = await api<{
          result: unknown;
          replayed: boolean;
        }>(`/api/sessions/${s.sessionId}/call`, "POST", {
          name: c.name,
          args: c.args,
          meta: {
            sessionId: s.sessionId,
            callKey: c.key,
            maxPriceCents: c.price,
            pricingVersion: "fixture-v1",
          },
        });
        setResult(r.result);
        await refresh();
      }
      append(
        replay
          ? "Replay returned the stored result · +USD 0.00"
          : `${c.label} completed · ${money(c.price)} accrued`,
      );
    } catch (e) {
      setError(errorText(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    setClosing(false);
    if (simulated) {
      accept({
        ...s,
        state: s.usedCents ? "CAPTURED" : "VOIDED",
        version: s.version + 1,
        capturedCents: s.usedCents,
        settlement: {
          kind: s.usedCents ? "CAPTURE" : "VOID",
          status: "SUCCEEDED",
          amountCents: s.usedCents,
          captureId: null,
          releaseEvidence: s.usedCents ? "FINAL_CAPTURE" : "VOIDED",
        },
      });
    } else await mutation("close");
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{receipt ? "Session receipt" : "Workspace"}</h1>
        </div>
      </div>
      <Alert className={`status-banner ${isFinal ? "confirmed" : ""}`} aria-live="polite">
        <strong>{stateLabel(s)}</strong>
        {s.state === "EXPIRED" && <a href="/">Open a new session</a>}
        <span>
          {s.reservedCents > 0
            ? "A call is still in progress. Settlement waits for it."
            : s.state === "MANUAL_REVIEW"
              ? "No new spending. The existing operation needs review."
              : s.state === "RECONCILING"
                ? "Checking the existing payment. Pending does not mean paid."
                : null}
        </span>
      </Alert>
      <div className="money-grid">
        {[
          [authorized ? "Approved limit" : "Requested limit", money(s.budgetCents)],
          ["Accrued usage", money(s.usedCents)],
          ["In progress", money(s.reservedCents)],
          ["Available", authorized ? money(s.availableCents) : "After approval"],
        ].map(([label, value]) => (
          <Card className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </Card>
        ))}
      </div>
      <div className="usage-progress">
        <Progress
          value={((s.usedCents + s.reservedCents) / s.budgetCents) * 100}
          aria-label={`Used ${money(s.usedCents)}, reserved ${money(s.reservedCents)}`}
        />
        <div
          className="reserved"
          style={{
            left: `${(s.usedCents / s.budgetCents) * 100}%`,
            width: `${(s.reservedCents / s.budgetCents) * 100}%`,
          }}
        />
      </div>
      {error && <Notice>{error}</Notice>}
      {!receipt && !simulated && <AiPanel snapshot={s} refresh={refresh} />}
      {receipt ? (
        <Card className="card narrow receipt">
          <h2>
            {s.state === "CAPTURED"
              ? "Captured once"
              : s.state === "VOIDED"
                ? "Authorization voided; captured USD 0.00"
                : "Settlement details"}
          </h2>
          <dl>
            <div>
              <dt>
                Successful usage ({s.ledger.length} {s.ledger.length === 1 ? "call" : "calls"})
              </dt>
              <dd>{money(s.usedCents)}</dd>
            </div>
            <div>
              <dt>Captured amount</dt>
              <dd>{isFinal ? money(s.capturedCents) : "Unconfirmed"}</dd>
            </div>
            <div>
              <dt>Unused authorized amount</dt>
              <dd>{authorized ? money(s.budgetCents - s.usedCents) : "No authorization"}</dd>
            </div>
            {s.authorizationId && (
              <div>
                <dt>Authorization reference</dt>
                <dd>{short(s.authorizationId)}</dd>
              </div>
            )}
            {s.state === "CAPTURED" && s.settlement?.captureId && (
              <div>
                <dt>Capture reference</dt>
                <dd>{short(s.settlement.captureId)}</dd>
              </div>
            )}
            {s.state === "VOIDED" && (
              <div>
                <dt>Void request reference</dt>
                <dd>{short(s.settlement?.requestReference)}</dd>
              </div>
            )}
            <div>
              <dt>Closure evidence</dt>
              <dd>{s.settlement?.releaseEvidence ?? "Not yet confirmed"}</dd>
            </div>
          </dl>
          <p className="muted">
            {isFinal
              ? "Unused amount was not charged. Payment-method hold updates may take time."
              : "Settlement is still being checked. No release or final amount is confirmed yet."}
          </p>
          <div className="actions">
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(
                  `${simulated ? "Simulated rehearsal" : "PayPal Sandbox"} receipt: ${stateLabel(s)}. Accrued ${money(s.usedCents)}. Captured ${isFinal ? money(s.capturedCents) : "unconfirmed"}. ${s.ledger.length} successful calls.`,
                )
              }
            >
              Copy receipt summary
            </Button>
            <a href={`/run/${s.sessionId}`}>Back to workspace</a>
          </div>
        </Card>
      ) : (
        <div className="workspace-grid">
          <Card className="card">
            <h2>Scripted tools</h2>
            <p className="muted">Synthetic data · fixed calls</p>
            {url && (
              <div className="approval">
                <h3>Approve a limit of {money(s.budgetCents)}</h3>
                <p>PayPal wallet approval creates a hold. You only accrue successful calls.</p>
                <Button
                  render={<a href={url} target="_blank" rel="noopener noreferrer" />}
                  className="w-fit"
                >
                  Approve with PayPal ↗
                </Button>

                <Button variant="outline" disabled={busy} onClick={() => void mutation("activate")}>
                  I've approved: check status
                </Button>
              </div>
            )}
            <div className="call-list">
              {calls.map((c, i) => (
                <Button
                  key={c.key}
                  variant="outline"
                  disabled={
                    busy || s.state !== "ACTIVE" || s.ledger.some((x) => x.callKey === c.key)
                  }
                  onClick={() => void execute(i)}
                >
                  {c.label} · {money(c.price)}
                </Button>
              ))}
            </div>
            {s.ledger.some((x) => x.callKey === calls[0].key) && (
              <Button variant="outline" disabled={busy} onClick={() => void execute(0)}>
                Replay coffee lookup · +USD 0.00
              </Button>
            )}
            <ul className="activity" aria-live="polite">
              {activity.length ? activity.map((a, i) => <li key={`${i}-${a}`}>{a}</li>) : null}
            </ul>
            {result !== undefined && (
              <details open>
                <summary>Synthetic tool result</summary>
                <pre>{JSON.stringify(result, null, 2)}</pre>
              </details>
            )}
          </Card>
          <Card className="card">
            <Ledger s={s} />
            {!isFinal && (
              <Button className="finish" disabled={busy} onClick={() => setClosing(true)}>
                {s.usedCents ? `Finish and settle ${money(s.usedCents)}` : "Close without usage"}
              </Button>
            )}
            <a className="subtle-link" href={`/receipts/${s.sessionId}`}>
              View session receipt →
            </a>
            <p className="fine">
              Session {short(s.sessionId)}
              <br />
              {Number.isFinite(deadline) && !isFinal
                ? `${authorized ? "Auto-close" : "Approval window"} in ${Math.max(0, Math.ceil((deadline - now) / 60000))} min`
                : null}
            </p>
          </Card>
        </div>
      )}
      {receipt && (
        <Card className="card">
          <Ledger s={s} />
        </Card>
      )}
      <div className="sync-line">
        <span>
          Last updated {updated ? new Date(updated).toLocaleTimeString() : "—"} · DO version{" "}
          {s.version}
        </span>
        <Button variant="outline" onClick={() => void refresh()}>
          Refresh status
        </Button>
      </div>
      <Dialog
        open={consent !== null}
        onOpenChange={(v) => {
          if (!v) setConsent(null);
        }}
        title="Allow this tool call?"
        description={
          consent === null
            ? ""
            : `${calls[consent].label} costs ${money(calls[consent].price)}, above your ask threshold. This consent applies only to this call.`
        }
      >
        <div className="actions">
          <Button
            onClick={() => {
              if (consent !== null) void execute(consent, true);
            }}
          >
            Allow this call
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setConsent(null);
              append("Call declined · no usage added");
            }}
          >
            Decline
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={closing}
        onOpenChange={setClosing}
        title="Finish this session?"
        description={`New calls will stop. ${s.usedCents ? `${money(s.usedCents)} of completed usage will settle once.` : "Any unused authorization will be voided."} In-progress work must resolve first.`}
      >
        <div className="actions">
          <Button onClick={() => void close()}>Confirm finish</Button>
          <Button variant="outline" onClick={() => setClosing(false)}>
            Keep working
          </Button>
        </div>
      </Dialog>
    </>
  );
}
function Ledger({ s }: { s: Snapshot }) {
  return (
    <>
      <h2>Session ledger</h2>
      <Table className="ledger">
        <TableCaption className="sr-only">Successful calls and accrued usage</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Tool</TableHead>
            <TableHead scope="col">Usage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.ledger.map((r, i) => (
            <TableRow key={r.callKey}>
              <TableCell>
                {i + 1}. {calls.find((c) => c.key === r.callKey)?.name ?? "Successful tool call"}
              </TableCell>
              <TableCell>{money(r.amountCents)}</TableCell>
            </TableRow>
          ))}
          {s.reservedCents > 0 && (
            <TableRow>
              <TableCell>Reserved · in progress</TableCell>
              <TableCell>{money(s.reservedCents)}</TableCell>
            </TableRow>
          )}
          {!s.ledger.length && !s.reservedCents && (
            <TableRow>
              <TableCell colSpan={2}>No successful calls yet.</TableCell>
            </TableRow>
          )}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableHead>Total accrued</TableHead>
            <TableCell>{money(s.usedCents)}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </>
  );
}
