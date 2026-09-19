import { FlaskConical } from 'lucide-react';
import { EmptyState } from '@/components/calls/empty-state';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTestLab } from '@/hooks/use-testlab';
import { cn } from '@/lib/utils';
import { RunControls } from './run-controls';
import { RunPanel } from './run-panel';

/**
 * The test lab. Cases are generated against the same world the local Prosper
 * serves, so an expectation is a fact about that world rather than a fixture,
 * and every call here is a real one down the agent's own media socket.
 */
export function TestingView() {
  const lab = useTestLab();

  return (
    <div className="grid h-full grid-cols-[340px_1fr] gap-4 px-4 pb-4">
      <div className="flex min-h-0 flex-col gap-4">
        {lab.suite ? (
          <RunControls suite={lab.suite} busy={lab.running} onRun={(req) => void lab.start(req)} />
        ) : (
          <Card size="sm" className="gap-2 p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-40 w-full" />
          </Card>
        )}

        {lab.runs.length > 0 && (
          <Card size="sm" className="max-h-56 min-h-0 gap-0 overflow-y-auto py-2">
            {lab.runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => lab.select(r.id)}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/40',
                  lab.run?.id === r.id && 'bg-muted/60',
                )}
              >
                <span className="font-mono text-xs">{r.id}</span>
                <span className="text-xs text-muted-foreground">{r.mode}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {r.passed}/{r.total}
                </span>
                {r.status === 'running' && <Badge variant="brand">live</Badge>}
              </button>
            ))}
          </Card>
        )}
      </div>

      {lab.run ? (
        <RunPanel run={lab.run} />
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
