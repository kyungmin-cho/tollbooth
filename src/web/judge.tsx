import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
export function JudgeGuide() {
  return (
    <Card className="card narrow">
      <h1>Judge guide</h1>
      <p>
        <a href="/run/rehearsal">Open the simulated rehearsal</a> without credentials.
      </p>
      <Tabs defaultValue="sandbox">
        <TabsList aria-label="Demo mode">
          <TabsTrigger value="sandbox">Real sandbox</TabsTrigger>
          <TabsTrigger value="simulation">Simulation</TabsTrigger>
        </TabsList>
        <TabsContent value="sandbox" className="space-y-5">
          <Badge variant="secondary">Real AI · synthetic tool data</Badge>
          <ol className="steps">
            <li>
              Create your own <strong>Personal sandbox buyer</strong> in{" "}
              <a href="https://developer.paypal.com/sandbox-testing/accounts" rel="noreferrer">
                PayPal Developer → Sandbox Accounts
              </a>
              . Enter that account's password only on PayPal Sandbox.
            </li>
            <li>
              <a href="/">Open a session</a> for up to USD 5.00. Choose “Ask AI to choose tools.”
            </li>
            <li>
              Approve the wallet limit on PayPal, return to this browser, then check status.
              Approval is a hold, not a charge.
            </li>
            <li>
              Run the AI plan. Default policy asks before each USD 0.35 call. Decline to stop; retry
              keeps completed calls free.
            </li>
            <li>
              Finish: three successful calls capture USD 0.90 once. In a separate approved session,
              close without calls to test zero-use void.
            </li>
          </ol>
          <Separator />
          <p className="muted">
            Keep this browser’s cookies for receipt access. Pending or unknown settlement is
            unconfirmed. Closing the tab leaves the 15-minute idle / 30-minute hard deadline active.
          </p>
          <details>
            <summary>Limits and availability</summary>
            <p>
              AI: one planning round, three calls, 20 runs/day globally and three/owner. Orders:
              five/hour/owner and 100/day. Daily AI quota resets at 09:00 KST. Unavailable AI is
              labeled explicitly; scripted tools remain optional.
            </p>
          </details>
        </TabsContent>
        <TabsContent value="simulation" className="space-y-5">
          <Badge variant="secondary">Simulated · no AI or payment</Badge>
          <p>
            <a href="/run/rehearsal">Start rehearsal</a> or{" "}
            <a href="/demo/merchant">open the simulated merchant dashboard</a>.
          </p>
        </TabsContent>
      </Tabs>
    </Card>
  );
}
