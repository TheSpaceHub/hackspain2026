import { ArrowLeftRight, FlaskConical, Globe, Hospital, Phone, Unplug } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { useNow } from '@/hooks/use-now';
import { formatClock, formatDay } from '@/lib/format';
import type { AgentMode } from '@/lib/agent/stats';
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
  /** Flip the agent between the real clinic and the sim. Absent on agents that cannot. */
  onMode?: (mode: AgentMode) => void;
  switching: boolean;
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
 * against the real board leaves real records. Click to switch: new calls go to the
 * other clinic, calls already open finish where they started.
 */
function ModePill({
  mode,
  url,
  onMode,
  switching,
}: {
  mode: ConsoleMode;
  url: string | null;
  onMode?: (mode: AgentMode) => void;
  switching: boolean;
}) {
  const Icon = MODE_ICON[mode];
  const next: AgentMode | null = mode === 'simulation' ? 'live' : mode === 'live' ? 'simulation' : null;
  const classes = cn(
    'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
    MODE_PILL[mode],
  );
  if (!onMode || !next) {
    return (
      <span className={classes} title={url ? `Clinic API · ${url}` : 'The agent did not answer /health'}>
        <Icon className="size-3.5" />
        {MODE_LABEL[mode]}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onMode(next)}
      disabled={switching}
      className={cn(classes, 'group cursor-pointer transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-60')}
      title={`New calls book into ${url}${mode === 'simulation' ? ' — nothing reaches Prosper' : ' — the real clinic'}.\nClick to switch to ${MODE_LABEL[next]}; calls already open finish where they started.`}
    >
      <Icon className="size-3.5" />
      {switching ? 'Switching…' : MODE_LABEL[mode]}
      <ArrowLeftRight className="size-3 opacity-50 group-hover:opacity-100" />
    </button>
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

export function AppShell({ nav, active, onNavigate, clinicApi, mode, onMode, switching, children }: AppShellProps) {
  useEffect(() => {
    document.title = mode === 'simulation' ? '[SIM] Agent la L' : mode === 'live' ? '[LIVE] Agent la L' : 'Agent la L';
  }, [mode]);
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-6 border-b px-4">
        <Brand />
        <Tabs nav={nav} active={active} onNavigate={onNavigate} />
        <div className="ml-auto flex items-center gap-4 text-sm text-muted-foreground">
          <ModePill mode={mode} url={clinicApi} onMode={onMode} switching={switching} />
          <span className="h-4 w-px bg-border" />
          <Clock />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
