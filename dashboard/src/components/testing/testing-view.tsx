import { FlaskConical } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState } from '@/components/calls/empty-state';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTestLab } from '@/hooks/use-testlab';
import { cn } from '@/lib/utils';
import { RunControls } from './run-controls';
import { RunPanel } from './run-panel';

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The test lab. Cases are generated against the same world the local Prosper
 * serves, so an expectation is a fact about that world rather than a fixture,
 * and every call here is a real one down the agent's own media socket.
 */
export function TestingView() {
  const lab = useTestLab();
  const cases = useMemo(() => new Map((lab.suite?.cases ?? []).map((c) => [c.id, c])), [lab.suite]);

  return (
    <div className="grid h-full grid-cols-[340px_1fr] gap-4 px-4 pb-4">
      <div className="flex min-h-0 flex-col gap-4">
        {lab.suite ? (
          <RunControls
            suite={lab.suite}
            busy={lab.running}
            generating={lab.generating}
            onRun={(req) => void lab.start(req)}
            onRegenerate={(req) => void lab.regenerate(req)}
          />
        ) : (
          <Card size="sm" className="gap-2 p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-40 w-full" />
          </Card>
        )}

        {lab.runs.length > 0 && (
          <Card size="sm" className="max-h-72 min-h-0 gap-0 overflow-y-auto py-2">
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">Earlier rounds</p>
            {lab.runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => lab.select(r.id)}
                title={`${r.behaviours.join(', ')} · ${r.vocabularies.join(', ')}`}
                className={cn(
                  'flex flex-col gap-0.5 px-3 py-1.5 text-left text-sm hover:bg-muted/40',
                  lab.run?.id === r.id && 'bg-muted/60',
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="font-mono text-xs">{r.id}</span>
                  <span className="text-xs text-muted-foreground">{r.mode}</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {r.passed} passed of {r.done}
                  </span>
                  {r.status === 'running' && <Badge variant="brand">live</Badge>}
                  {r.status === 'stopped' && <Badge variant="outline">stopped</Badge>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {when(r.started_at)} · {r.behaviours.join(', ')} · {r.vocabularies.join(', ')}
                </span>
              </button>
            ))}
          </Card>
        )}
      </div>

      {lab.run ? (
        <RunPanel
          run={lab.run}
          cases={cases}
          shipping={lab.suite?.shipping}
          onStop={(id) => void lab.stop(id)}
        />
      ) : (
        <Card size="sm" className="min-h-0">
          <EmptyState icon={FlaskConical} title={lab.error ? 'The test lab is not answering' : 'No run open'}>
            {lab.error ??
              'Pick the problems and the callers on the left. Every case is dialled down the agent\u2019s real media socket and graded against the local Prosper.'}
          </EmptyState>
        </Card>
      )}
    </div>
  );
}
