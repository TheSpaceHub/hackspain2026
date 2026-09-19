import { Check, ChevronDown, FlaskConical, Globe, Hospital, Phone, Unplug } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  /** Why the last switch failed; shown in red next to the pill. */
  switchError?: string | null;
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
      <span className="hidden text-sm font-semibold tracking-tight sm:inline">Agent la L</span>
    </div>
  );
}

/** Underlined tabs: the active one in ink with a 2px rule on the header's bottom edge. */
function Tabs({ nav, active, onNavigate }: Pick<AppShellProps, 'nav' | 'active' | 'onNavigate'>) {
  return (
    <nav className="no-scrollbar flex h-full min-w-0 items-stretch gap-1 overflow-x-auto">
      {nav.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative flex shrink-0 items-center gap-2 px-3 text-sm whitespace-nowrap transition-colors',
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

const MODE_HINT: Record<AgentMode, string> = {
  live: 'New calls book into the real clinic',
  simulation: 'Nothing reaches Prosper',
};

/**
 * Which world the agent submits to. Worth having in sight at all times: a test run
 * against the real board leaves real records. The pill opens a menu of the two
 * clinics; picking one moves new calls there, calls already open finish where they started.
 */
function ModePill({
  mode,
  url,
  onMode,
  switching,
  switchError,
}: {
  mode: ConsoleMode;
  url: string | null;
  onMode?: (mode: AgentMode) => void;
  switching: boolean;
  switchError?: string | null;
}) {
  const Icon = MODE_ICON[mode];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const classes = cn(
    'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
    MODE_PILL[mode],
  );
  if (!onMode || (mode !== 'live' && mode !== 'simulation')) {
    return (
      <span className={classes} title={url ? `Clinic API · ${url}` : 'The agent did not answer /health'}>
        <Icon className="size-3.5" />
        {MODE_LABEL[mode]}
      </span>
    );
  }
  const options: AgentMode[] = ['live', 'simulation'];
  return (
    <span ref={root} className="relative flex items-center gap-2">
      {switchError && (
        <span className="text-xs text-destructive" title={switchError}>
          Switch failed
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(classes, 'cursor-pointer transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-60')}
        title={url ? `Clinic API · ${url}` : undefined}
      >
        <Icon className="size-3.5" />
        {switching ? 'Switching…' : MODE_LABEL[mode]}
        <ChevronDown className={cn('size-3 opacity-60 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map((option) => {
            const OptionIcon = MODE_ICON[option];
            const selected = option === mode;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onMode(option);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                  selected && 'font-medium',
                )}
              >
                <OptionIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="flex-1">
                  {MODE_LABEL[option]}
                  <span className="block text-xs font-normal text-muted-foreground">{MODE_HINT[option]}</span>
                </span>
                {selected && <Check className="mt-0.5 size-3.5 shrink-0" />}
              </button>
            );
          })}
          <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
            Calls already open finish where they started.
          </p>
        </div>
      )}
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

export function AppShell({ nav, active, onNavigate, clinicApi, mode, onMode, switching, switchError, children }: AppShellProps) {
  useEffect(() => {
    document.title = mode === 'simulation' ? '[SIM] Agent la L' : mode === 'live' ? '[LIVE] Agent la L' : 'Agent la L';
  }, [mode]);
  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4 sm:gap-6">
        <Brand />
        <Tabs nav={nav} active={active} onNavigate={onNavigate} />
        <div className="ml-auto flex shrink-0 items-center gap-4 text-sm text-muted-foreground">
          <ModePill mode={mode} url={clinicApi} onMode={onMode} switching={switching} switchError={switchError} />
          {/* The console is a desktop tool; on a phone, the clock gives way to the tabs. */}
          <span className="hidden h-4 w-px bg-border md:block" />
          <span className="hidden md:contents">
            <Clock />
          </span>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
