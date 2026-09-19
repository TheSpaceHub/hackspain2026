import { Server } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agentHost, agentOrigin, setAgentOrigin, type AgentMode } from '@/lib/agent/origin';

function OriginForm({ mode, autoFocus }: { mode: AgentMode; autoFocus?: boolean }) {
  const [value, setValue] = useState(agentOrigin(mode));
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (value.trim()) setAgentOrigin(mode, value);
  };
  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://xyz.trycloudflare.com"
        aria-label={`${mode} agent URL`}
        autoFocus={autoFocus}
        className="font-mono text-xs"
      />
      <Button type="submit" disabled={!value.trim()}>
        Connect
      </Button>
    </form>
  );
}

/** A deployed console that has not been told where this mode's agent is. */
export function ConnectAgent({ mode }: { mode: AgentMode }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1">
          <h1 className="font-heading text-lg font-medium">Connect to your {mode} agent</h1>
          <p className="text-sm text-muted-foreground">
            Paste this mode's public agent URL — the tunnel Prosper dials. This browser remembers it, and a link with{' '}
            <code className="font-mono text-xs">?agent=…</code> sets it for the selected mode.
          </p>
        </div>
        <OriginForm mode={mode} autoFocus />
      </div>
    </div>
  );
}

/** Which agent a deployed console reads, and a way to point this mode at another one. */
export function AgentOriginControl({ mode }: { mode: AgentMode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-56 items-center gap-1.5 hover:text-foreground"
        title={`Agent · ${agentOrigin(mode)}`}
      >
        <Server className="size-4 shrink-0" />
        <span className="truncate font-mono text-xs">{agentHost(mode)}</span>
      </button>
      {open && (
        <div className="absolute top-8 right-0 z-50 w-96 rounded-lg border bg-popover p-3 shadow-md">
          <p className="mb-2 text-xs text-muted-foreground">{mode} agent URL — the tunnel Prosper dials</p>
          <OriginForm mode={mode} autoFocus />
        </div>
      )}
    </div>
  );
}
