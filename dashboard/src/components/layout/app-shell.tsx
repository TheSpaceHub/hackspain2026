import { FlaskConical, Globe, Hospital, Phone, Unplug } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useNow } from '@/hooks/use-now';
import { formatClock, formatDay } from '@/lib/format';
import { MODE_LABEL, type ConsoleMode } from '@/lib/mode';
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
  mode: ConsoleMode;
  /** A shared clinic (sim/) answers on /__sim — shown when the agent is not using it. */
  simRunning: boolean;
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

const MODE_ICON = { live: Globe, simulation: Hospital, mock: FlaskConical, unknown: Unplug } as const;

const MODE_PILL: Record<ConsoleMode, string> = {
  live: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  simulation: 'border-violet-600/40 bg-violet-500/10 text-violet-800 dark:text-violet-300',
  mock: 'border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  unknown: 'border-border bg-muted text-muted-foreground',
};

/**
 * Which world the agent submits to. Worth having in sight at all times: a test run
 * against the real board leaves real records.
 */
function ModePill({ mode, url }: { mode: ConsoleMode; url: string | null }) {
  const Icon = MODE_ICON[mode];
  return (
    <span
      className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide', MODE_PILL[mode])}
      title={url ? `Clinic API · ${url}` : 'The agent did not answer /health'}
    >
      <Icon className="size-3.5" />
      {MODE_LABEL[mode]}
    </span>
  );
}

/** A strip under the header for the two states that must never be confused. */
function ModeBanner({ mode, url, simRunning }: { mode: ConsoleMode; url: string | null; simRunning: boolean }) {
  if (mode === 'simulation') {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-violet-600/30 bg-violet-500/10 px-4 py-1 text-xs text-violet-900 dark:text-violet-200">
        <Hospital className="size-3.5" />
        <b className="font-semibold">Simulation.</b> Calls book into the shared local clinic ({url}) — nothing here reaches Prosper. Reset it from the
        Clinic tab.
      </div>
    );
  }
  if (mode === 'live') {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-emerald-600/30 bg-emerald-500/10 px-4 py-1 text-xs text-emerald-900 dark:text-emerald-200">
        <Globe className="size-3.5" />
        <b className="font-semibold">Live.</b> Calls book into the real clinic ({url}).
        {simRunning && (
          <span className="text-emerald-900/70 dark:text-emerald-200/70">
            A sim is running on this machine but the agent is not using it — start the agent with <code className="font-mono">pnpm start:sim</code>.
          </span>
        )}
      </div>
    );
  }
  return null;
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

export function AppShell({ nav, active, onNavigate, clinicApi, mode, simRunning, children }: AppShellProps) {
  useEffect(() => {
    document.title = mode === 'simulation' ? '[SIM] Agent la L' : mode === 'live' ? '[LIVE] Agent la L' : 'Agent la L';
  }, [mode]);
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <Brand />
        <Tabs nav={nav} active={active} onNavigate={onNavigate} />
        <div className="ml-auto flex items-center gap-4 text-sm text-muted-foreground">
          <ModePill mode={mode} url={clinicApi} />
          <span className="h-4 w-px bg-border" />
          <Clock />
        </div>
      </header>
      <ModeBanner mode={mode} url={clinicApi} simRunning={simRunning} />
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
