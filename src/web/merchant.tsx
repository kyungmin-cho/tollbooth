import { AllCommunityModule, type ColDef, themeQuartz } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useState } from "react";
import type { MerchantPage, MerchantRow } from "../shared/dashboard";
import type { Snapshot } from "../shared/types";
import { ApiError, api, errorText } from "./api";
import { Loading, Notice } from "./buyer";
import { AppSidebar } from "./components/app-sidebar";
import { HelpTip } from "./components/help-tip";
import { SectionCards } from "./components/section-cards";
import { SiteHeader } from "./components/site-header";
import { Alert } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "./components/ui/empty";
import { Field, FieldLabel } from "./components/ui/field";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { money, short, stateLabel } from "./state";

const theme = themeQuartz.withParams({
  fontFamily: "Inter, ui-sans-serif, system-ui",
  fontSize: 14,
  headerBackgroundColor: "#f5f7fa",
  accentColor: "#1959d1",
  borderColor: "#e3e7ed",
  rowHeight: 54,
  headerHeight: 48,
});
const date = (n: number) => new Date(n).toLocaleString();
export default function Merchant() {
  const path = location.pathname;
  if (path === "/merchant/login") return <Login />;
  return <MerchantShell />;
}
function Login() {
  const [secret, setSecret] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Card className="card narrow login">
      <h1>Merchant sign in</h1>

      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/api/merchant/login", "POST", { secret });
            setSecret("");
            location.assign("/merchant");
          } catch (err) {
            setError(errorText(err));
            setSecret("");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field>
          <FieldLabel className="field">
            Admin access secret
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </FieldLabel>
        </Field>
        {error && <Notice>{error}</Notice>}
        <Button disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <a href="/demo/merchant">Open simulated merchant dashboard →</a>
    </Card>
  );
}
function MerchantShell() {
  const [error, setError] = useState("");
  const simulated = location.pathname.startsWith("/demo/");
  const match = /^\/merchant\/sessions\/([^/]+)$/.exec(location.pathname);
  const tab = location.pathname.endsWith("charges")
    ? "charges"
    : location.pathname.endsWith("sessions")
      ? "sessions"
      : "overview";
  return (
    <SidebarProvider
      style={{ "--sidebar-width": "15rem", "--header-height": "4rem" } as React.CSSProperties}
    >
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <SiteHeader
          simulated={simulated}
          onSignOut={() =>
            void (async () => {
              try {
                await api("/api/merchant/logout", "POST");
                location.assign("/merchant/login");
              } catch (e) {
                setError(errorText(e));
              }
            })()
          }
        />
        <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
          {error && <Notice>{error}</Notice>}
          {match ? <Detail id={match[1]} /> : <Dashboard tab={tab} simulated={simulated} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
function Dashboard({ tab, simulated }: { tab: string; simulated: boolean }) {
  const [data, setData] = useState<MerchantPage>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [days, setDays] = useState("7"),
    [state, setState] = useState(""),
    [search, setSearch] = useState(""),
    [cursor, setCursor] = useState(""),
    [history, setHistory] = useState<string[]>([]),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    const q = new URLSearchParams({
      from: String(Date.now() - Number(days) * 86400000),
      state,
      search,
      cursor,
    });
    api<MerchantPage>(
      simulated
        ? "/api/demo/merchant"
        : `/api/merchant/${tab === "charges" ? "charges" : "sessions"}?${q}`,
    )
      .then((r) => {
        if (live) {
          setData(r);
          setError("");
        }
      })
      .catch((e) => {
        if (live) {
          setError(errorText(e));
          if (e instanceof ApiError && [401, 403].includes(e.status)) setData(undefined);
        }
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [tab, days, state, search, cursor, refresh, simulated]);
  const cols = useMemo<ColDef<MerchantRow>[]>(
    () =>
      tab === "charges"
        ? [
            {
              field: "projectedAt",
              headerName: "Verified / projected",
              valueFormatter: (p) => date(p.value),
              filter: "agDateColumnFilter",
              filterValueGetter: (p) => new Date(p.data?.projectedAt ?? 0),
            },
            {
              field: "sessionId",
              headerName: "Session",
              cellRenderer: ({ value }: { value: string }) =>
                simulated ? (
                  <span>{value}</span>
                ) : (
                  <a href={`/merchant/sessions/${value}`}>{short(value)}</a>
                ),
            },
            {
              field: "captureId",
              headerName: "Capture reference",
              valueFormatter: (p) => short(p.value),
            },
            { field: "kind", headerName: "Settlement kind" },
            { field: "status", headerName: "Provider confirmation" },
            {
              field: "amountCents",
              headerName: "Amount",
              valueFormatter: (p) => money(p.value ?? 0),
              filter: "agNumberColumnFilter",
            },
            { headerName: "Currency", valueGetter: () => "USD" },
            { field: "releaseEvidence", headerName: "Release evidence" },
          ]
        : [
            {
              field: "createdAt",
              headerName: "Created",
              valueFormatter: (p) => date(p.value),
              filter: "agDateColumnFilter",
              filterValueGetter: (p) => new Date(p.data?.createdAt ?? 0),
            },
            {
              field: "sessionId",
              headerName: "Session",
              cellRenderer: ({ value }: { value: string }) =>
                simulated ? (
                  <span>{value}</span>
                ) : (
                  <a
                    aria-label={`Open session ${short(value)}`}
                    href={`/merchant/sessions/${value}`}
                  >
                    {short(value)}
                  </a>
                ),
            },
            { headerName: "Mode", valueGetter: () => (simulated ? "Simulated" : "Sandbox") },
            { field: "state", headerName: "State" },
            ...(
              [
                ["budgetCents", "Budget"],
                ["usedCents", "Accrued"],
                ["reservedCents", "Reserved"],
                ["availableCents", "Available (projection)"],
                ["capturedCents", "Captured"],
              ] as const
            ).map(([field, headerName]) => ({
              field,
              headerName,
              valueFormatter: (p: { value: number }) => money(p.value),
              filter: "agNumberColumnFilter",
            })),
            { field: "calls", headerName: "Successful calls", filter: "agNumberColumnFilter" },
            {
              field: "projectedAt",
              headerName: "Last updated",
              valueFormatter: (p) => date(p.value),
            },
            { field: "errorCode", headerName: "Review reason" },
          ],
    [tab, simulated],
  );
  const reset = () => {
    setCursor("");
    setHistory([]);
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            {tab === "overview" ? "Merchant overview" : tab === "charges" ? "Charges" : "Sessions"}
          </h1>
        </div>
        <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
          Refresh dashboard
        </Button>
      </div>
      {error && (
        <Notice>
          {error} <a href="/merchant/login">Merchant sign in</a>
        </Notice>
      )}
      {data && (
        <>
          <SectionCards
            items={[
              { label: "Gross captured", value: money(data.summary.capturedCents) },
              { label: "Accrued usage", value: money(data.summary.usedCents) },
              { label: "Active sessions", value: data.summary.active },
              { label: "Needs review", value: data.summary.review },
            ]}
          />
        </>
      )}
      <Card className="card grid-card">
        <div className="filters">
          <Field>
            <FieldLabel htmlFor="date-filter">Date range</FieldLabel>
            <Select
              value={days}
              onValueChange={(value) => {
                setDays(value ?? "7");
                reset();
              }}
              items={[
                { value: "1", label: "Last 24 hours" },
                { value: "7", label: "Last 7 days" },
                { value: "30", label: "Last 30 days" },
              ]}
            >
              <SelectTrigger id="date-filter" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  { value: "1", label: "Last 24 hours" },
                  { value: "7", label: "Last 7 days" },
                  { value: "30", label: "Last 30 days" },
                ].map((x) => (
                  <SelectItem key={x.value} value={x.value}>
                    {x.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="state-filter">State</FieldLabel>
            <Select
              value={state || "ALL"}
              onValueChange={(value) => {
                setState(value === "ALL" ? "" : (value ?? ""));
                reset();
              }}
            >
              <SelectTrigger id="state-filter" className="w-full">
                <SelectValue>{state || "All states"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All states</SelectItem>
                {[
                  "ACTIVE",
                  "APPROVAL_PENDING",
                  "RECONCILING",
                  "CAPTURED",
                  "VOIDED",
                  "EXPIRED",
                  "MANUAL_REVIEW",
                ].map((x) => (
                  <SelectItem key={x} value={x}>
                    {x}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel className="field">
              Search session reference
              <Input
                value={search}
                maxLength={64}
                onChange={(e) => {
                  setSearch(e.target.value.replace(/[^a-zA-Z0-9-]/g, ""));
                  reset();
                }}
              />
            </FieldLabel>
          </Field>
        </div>
        <div className="grid-caption">
          <h2>{tab === "charges" ? "Payment records" : "Session records"}</h2>
          <HelpTip label="Grid scope">
            Grid filters and sorting apply to this page. Totals cover the selected period; gross
            excludes pending payments.
          </HelpTip>
        </div>
        {busy && <p role="status">Updating dashboard…</p>}
        {data && !data.rows.length && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No matching records.</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        <div className="grid-container" aria-label="Merchant records">
          <AgGridProvider modules={[AllCommunityModule]}>
            <AgGridReact<MerchantRow>
              theme={theme}
              rowData={data?.rows ?? []}
              columnDefs={cols}
              defaultColDef={{
                sortable: true,
                filter: "agTextColumnFilter",
                resizable: true,
                minWidth: 155,
              }}
              rowModelType="clientSide"
              suppressMultiSort
              animateRows={false}
              getRowId={(p) => p.data.sessionId}
            />
          </AgGridProvider>
        </div>
        <div className="pagination">
          <Button
            variant="outline"
            disabled={!history.length || busy || simulated}
            onClick={() => {
              setCursor(history.at(-1) ?? "");
              setHistory((a) => a.slice(0, -1));
            }}
          >
            Previous page
          </Button>
          <span>
            Page {history.length + 1} · {data?.rows.length ?? 0} records (up to 100)
          </span>
          <Button
            variant="outline"
            disabled={!data?.nextCursor || busy || simulated}
            onClick={() => {
              setHistory((a) => [...a, cursor]);
              setCursor(data?.nextCursor ?? "");
            }}
          >
            Next page
          </Button>
        </div>
        <p className="fine">Last queried {data ? date(data.at) : "—"}</p>
      </Card>
    </>
  );
}
interface DetailData {
  snapshot: Snapshot;
  projection: {
    version: number;
    projectedAt: number;
    state: string;
    usedCents: number;
    capturedCents: number;
  } | null;
  checkedAt: number;
  pendingOutbox: number;
  operations: {
    kind: string;
    status: string;
  }[];
  jobs: {
    kind: string;
    due_at: number;
  }[];
}
function Detail({ id }: { id: string }) {
  const [data, setData] = useState<DetailData>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load(reconcile = false) {
    setBusy(true);
    try {
      setData(
        await api<DetailData>(
          `/api/merchant/sessions/${id}${reconcile ? "/reconcile" : ""}`,
          reconcile ? "POST" : "GET",
        ),
      );
      setError("");
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && [401, 403].includes(e.status)) setData(undefined);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  if (!data)
    return (
      <>
        {error ? (
          <Notice>
            {error} <a href="/merchant/login">Sign in</a>
          </Notice>
        ) : (
          <Loading />
        )}
      </>
    );
  const s = data.snapshot,
    p = data.projection,
    lag = !p || p.version < s.version;
  return (
    <>
      <a href="/merchant/sessions">← All sessions</a>
      <div className="page-heading">
        <h1>Session {short(id)}</h1>
      </div>
      <Alert className="status-banner">
        <strong>{stateLabel(s)}</strong>
      </Alert>
      {lag && (
        <Notice>
          Dashboard updating. Projection version {p?.version ?? "missing"}; current version{" "}
          {s.version}.
        </Notice>
      )}
      {error && <Notice>{error}</Notice>}
      <div className="money-grid">
        {[
          ["Budget", s.budgetCents],
          ["Used", s.usedCents],
          ["Reserved", s.reservedCents],
          ["Captured", s.capturedCents],
        ].map(([k, v]) => (
          <Card className="metric" key={k}>
            <span>{k}</span>
            <strong>
              {k === "Captured" && ["RECONCILING", "SETTLING", "MANUAL_REVIEW"].includes(s.state)
                ? "Unconfirmed"
                : money(Number(v))}
            </strong>
          </Card>
        ))}
      </div>
      <Card className="card">
        <h2>Timeline and provider evidence</h2>
        <p>
          Authoritative status checked {date(data.checkedAt)}
          <br />
          Dashboard projected {p ? date(p.projectedAt) : "Not yet available"}
        </p>
        <ol className="steps">
          <li>Session opened</li>
          {s.authorizationId && <li>Authorization confirmed</li>}
          <li>
            {s.ledger.length} successful calls · {money(s.usedCents)} accrued
          </li>
          <li>
            {stateLabel(s)} · {s.settlement?.releaseEvidence ?? "No settlement yet"}
          </li>
        </ol>
        {s.state === "RECONCILING" && (
          <Notice>Payment unconfirmed. Checking the existing transaction.</Notice>
        )}
        <p>
          {s.reservedCents
            ? "Tool call unresolved. Settlement waits for its durable result."
            : data.pendingOutbox
              ? "Dashboard updating: durable projection deliveries are pending."
              : null}
        </p>
        {s.postSettlementIssue && (
          <Notice>
            Post-settlement review: {s.postSettlementIssue}. Captured gross remains historical.
          </Notice>
        )}
        <h3>Itemized usage</h3>
        <ul>
          {s.ledger.map((r, i) => (
            <li key={r.callKey}>
              Call {i + 1} · {money(r.amountCents)}
            </li>
          ))}
        </ul>
        <div className="actions">
          <Button disabled={busy} onClick={() => void load(true)}>
            Recheck provider status
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Refresh detail
          </Button>
        </div>
      </Card>
    </>
  );
}
