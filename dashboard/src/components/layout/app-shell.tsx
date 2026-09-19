import { FlaskConical, Globe, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNow } from '@/hooks/use-now';
import { formatClock, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface NavItem {
  id: string;
  label: string;
  count?: number;
  /** Something is happening here right now. */
  pulse?: boolean;
}

interface AppShellProps {
  nav: NavItem[];
  active: string;
  onNavigate: (id: string) => void;
  /** The clinic API the agent is wired to, from its /health. */
  clinicApi: string | null;
  children: ReactNode;
}

function Pulse() {
  return (
    <span className="relative flex size-1.5">
      <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/60" />
      <span className="relative size-1.5 rounded-full bg-brand-500" />
    </span>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-brand-500 text-white">
        <Phone className="size-3.5" />
      </div>
      <span className="text-sm font-semibold tracking-tight">Agent la L</span>
    </div>
  );
}

/** Underlined tabs: the active one in ink with a 2px rule on the header's bottom edge. */
function Tabs({ nav, active, onNavigate }: Pick<AppShellProps, 'nav' | 'active' | 'onNavigate'>) {
  return (
    <nav className="flex h-full items-stretch gap-1">
      {nav.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative flex items-center gap-2 px-3 text-sm transition-colors',
              'after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors',
              isActive
                ? 'font-medium text-foreground after:bg-foreground'
                : 'text-muted-foreground after:bg-transparent hover:text-foreground',
            )}
          >
            {item.label}
            {!!item.count && (
              <span
                className={cn(
                  'tabular flex h-5 min-w-5 items-center justify-center gap-1 rounded-full px-1.5 text-xs',
                  item.pulse ? 'bg-brand-600/10 text-brand-700' : 'bg-muted text-muted-foreground',
                )}
              >
                {item.pulse && <Pulse />}
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * Which clinic the agent submits to. Worth having in sight at all times: a test run
 * against the real board leaves real records.
 */
function ClinicApi({ url }: { url: string | null }) {
  const local = !!url && /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url);
  const Icon = local ? FlaskConical : Globe;
  return (
    <span className="flex items-center gap-1.5" title={url ? `Clinic API · ${url}` : 'Clinic API unknown'}>
      <Icon className="size-4" />
      {url ? (local ? 'Local mock' : 'Prosper') : '—'}
    </span>
  );
}

function Clock() {
  const now = useNow(1_000);
  const iso = new Date(now).toISOString();
  return (
    <span className="flex items-center gap-1.5" title="Clinic time, Europe/Madrid">
      {formatDay(iso, now)}
      <span className="tabular text-foreground">{formatClock(iso, true)}</span>
    </span>
  );
}

export function AppShell({ nav, active, onNavigate, clinicApi, children }: AppShellProps) {
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <Brand />
        <Tabs nav={nav} active={active} onNavigate={onNavigate} />
        <div className="ml-auto flex items-center gap-4 text-sm text-muted-foreground">
          <ClinicApi url={clinicApi} />
          <span className="h-4 w-px bg-border" />
          <Clock />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
