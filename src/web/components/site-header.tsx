// Header composition from shadcn dashboard-01, adapted to the SPA.

import { MoreHorizontalIcon } from "lucide-react";
import { Brand } from "./brand";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Separator } from "./ui/separator";
import { SidebarTrigger } from "./ui/sidebar";
export function SiteHeader({
  simulated,
  onSignOut,
}: {
  simulated: boolean;
  onSignOut: () => void;
}) {
  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 lg:px-6">
      <div className="md:hidden">
        <Brand />
      </div>
      <SidebarTrigger />
      <Separator
        orientation="vertical"
        className="mx-2 hidden h-4 data-vertical:self-auto md:block"
      />
      <Badge variant="outline" className="environment max-md:order-last">
        {simulated ? "Simulated rehearsal" : "Sandbox · No real money"}
      </Badge>
      <div className="ml-auto flex items-center gap-2">
        {!simulated && (
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" aria-label="More navigation" />}
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<a href="/" />}>Buyer workspace</DropdownMenuItem>
            <DropdownMenuItem render={<a href="/judge" />}>Judge guide</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
