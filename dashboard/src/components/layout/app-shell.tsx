import type { LucideIcon } from 'lucide-react';
import { CalendarDays, FlaskConical, Globe, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { useNow } from '@/hooks/use-now';
import { formatClock, formatDay } from '@/lib/format';

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  /** Something is happening here right now. */
  pulse?: boolean;
}

interface AppShellProps {
  nav: NavItem[];
  active: string;
  onNavigate: (id: string) => void;
  title: string;
  /** The clinic API the agent is wired to, from its /health. */
  clinicApi: string | null;
  children: ReactNode;
}

function Pulse() {
  return (
    <span className="relative flex size-2">
      <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/60" />
      <span className="relative size-2 rounded-full bg-brand-500" />
    </span>
  );
}

function Brand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<div />} className="hover:bg-transparent active:bg-transparent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-brand-500 text-white">
            <Phone className="size-4" />
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">El Turno</span>
            <span className="truncate text-xs text-muted-foreground">Agent console</span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Which clinic the agent submits to. Worth having in sight at all times: a test run
 * against the real board leaves real records.
 */
function ClinicApi({ url }: { url: string | null }) {
  const local = !!url && /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);
  const host = url ? url.replace(/^https?:\/\//, '') : 'unknown';
  const name = url ? (local ? 'Local mock' : 'Prosper') : '—';
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" render={<div />} tooltip={`Clinic API · ${name}`} className="hover:bg-transparent active:bg-transparent">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg border">
            {local ? <FlaskConical className="size-4" /> : <Globe className="size-4" />}
          </div>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground" title={url ?? undefined}>
              {host}
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebar({ nav, active, onNavigate, clinicApi }: Pick<AppShellProps, 'nav' | 'active' | 'onNavigate' | 'clinicApi'>) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Brand />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Console</SidebarGroupLabel>
          <SidebarMenu>
            {nav.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton tooltip={item.label} isActive={item.id === active} onClick={() => onNavigate(item.id)}>
                  <item.icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
                {item.count !== undefined && (
                  <SidebarMenuBadge className="gap-1.5">
                    {item.pulse && <Pulse />}
                    {item.count}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarGroupLabel>Clinic API</SidebarGroupLabel>
        <ClinicApi url={clinicApi} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function Header({ title }: { title: string }) {
  const now = useNow(1_000);
  const iso = new Date(now).toISOString();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>El Turno</BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground" title="Clinic time, Europe/Madrid">
        <CalendarDays className="size-4" />
        <span>{formatDay(iso, now)}</span>
        <span className="tabular text-foreground">{formatClock(iso, true)}</span>
      </div>
    </header>
  );
}

export function AppShell({ nav, active, onNavigate, title, clinicApi, children }: AppShellProps) {
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar nav={nav} active={active} onNavigate={onNavigate} clinicApi={clinicApi} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <Header title={title} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
