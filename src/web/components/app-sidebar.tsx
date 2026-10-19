// shadcn sidebar-07: icon collapse, mobile Sheet, header/content/footer and rail.
import {
  BookOpenIcon,
  CreditCardIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  ListIcon,
} from "lucide-react";
import { Brand } from "./brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "./ui/sidebar";

const links = [
  { title: "Overview", url: "/merchant", icon: LayoutDashboardIcon },
  { title: "Sessions", url: "/merchant/sessions", icon: ListIcon },
  { title: "Charges", url: "/merchant/charges", icon: CreditCardIcon },
];
export function AppSidebar() {
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Merchant navigation">
              {links.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    render={<a href={item.url} />}
                    tooltip={item.title}
                    isActive={location.pathname === item.url}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/demo/merchant" />} tooltip="Simulated example">
              <FlaskConicalIcon />
              <span>Simulated example</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="/judge" />} tooltip="Judge guide">
              <BookOpenIcon />
              <span>Judge guide</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
