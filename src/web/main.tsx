import { MenuIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { Buyer, Connect, Landing, Loading } from "./buyer";
import { Brand } from "./components/brand";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "./components/ui/sheet";
import { TooltipProvider } from "./components/ui/tooltip";
import { JudgeGuide } from "./judge";
import "./style.css";

const Merchant = lazy(() => import("./merchant"));
const nav = (
  <>
    <a href="/judge">Judge guide</a>
    <a href="/connect">Connect AI</a>
    <a href="/merchant">Merchant</a>
  </>
);
function App() {
  const path = location.pathname,
    buyer = /^\/(run|receipts)\/([^/]+)$/.exec(path);
  const merchant = path.startsWith("/merchant") || path === "/demo/merchant";
  const dashboard = merchant && path !== "/merchant/login";
  return (
    <TooltipProvider>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {!dashboard && (
        <header className="site-header">
          <Brand />
          <nav className="desktop-nav" aria-label="Main navigation">
            {nav}
          </nav>
          <Sheet>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="mobile-nav"
                  aria-label="Open navigation"
                />
              }
            >
              <MenuIcon />
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <nav className="sheet-nav">{nav}</nav>
            </SheetContent>
          </Sheet>
          <Badge variant="outline" className="environment">
            {path.includes("rehearsal")
              ? "Simulated · no AI or payment"
              : "Sandbox · No real money"}
          </Badge>
        </header>
      )}
      <main id="main" className={dashboard ? "merchant-page" : "page"}>
        <Suspense fallback={<Loading />}>
          {merchant ? (
            <Merchant />
          ) : buyer ? (
            <Buyer id={decodeURIComponent(buyer[2])} receipt={buyer[1] === "receipts"} />
          ) : path === "/judge" ? (
            <JudgeGuide />
          ) : path === "/connect" ? (
            <Connect />
          ) : path === "/" ? (
            <Landing />
          ) : (
            <section>
              <h1>Page not found</h1>
              <a href="/">Return to Tollbooth</a>
            </section>
          )}
        </Suspense>
      </main>
    </TooltipProvider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
