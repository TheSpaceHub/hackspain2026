import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { CaseResult } from '@/lib/testlab/types';

const SEVERITY: Record<string, 'destructive' | 'brand' | 'outline'> = {
  blocker: 'destructive',
  major: 'brand',
  minor: 'outline',
};

/** Everything that would otherwise mean reading a log: what was wanted, what happened, what to do. */
export function ResultDetail({ result }: { result: CaseResult }) {
  const call = result.call;
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/20 px-3 py-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{call.caller === 'persona' ? 'Persona caller' : 'Scripted caller'}</span>
        <span>{call.behaviour.replace(/_/g, ' ')}</span>
        <span>{(call.call_ms / 1000).toFixed(1)}s</span>
        <span>{call.ms_to_first_audio === null ? 'no agent audio' : `${call.ms_to_first_audio}ms to first audio`}</span>
        <span>{call.frames_received} frames in</span>
        {call.wav_path && <span className="truncate">{call.wav_path}</span>}
      </div>

      {result.summary && <p className="text-sm">{result.summary}</p>}

      {result.grade.misses.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Missed</p>
          <ul className="list-inside list-disc text-sm text-destructive">
            {result.grade.misses.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {result.leaked.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Said out loud that it should not have</p>
          <p className="text-sm text-destructive">{result.leaked.join(', ')}</p>
        </div>
      )}

      {result.insights.length > 0 && (
        <div className="flex flex-col gap-2">
          {result.insights.map((i, n) => (
            <div key={`${i.code}-${n}`} className="rounded-md border border-border/60 bg-background px-3 py-2">
              <div className="flex items-center gap-2">
                <Badge variant={SEVERITY[i.severity] ?? 'outline'}>{i.severity}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{i.code}</span>
              </div>
              <p className="mt-1">{i.detail}</p>
              <p className="mt-1 text-muted-foreground">{i.suggestion}</p>
            </div>
          ))}
        </div>
      )}

      {call.transcript.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Transcript</p>
          <ul className="flex flex-col gap-1">
            {call.transcript.map((t, i) => (
              <li key={`${t.at}-${i}`} className="flex gap-2">
                <span
                  className={cn(
                    'w-16 shrink-0 text-xs',
                    t.role === 'assistant' ? 'text-brand-700' : 'text-muted-foreground',
                  )}
                >
                  {t.role === 'assistant' ? 'agent' : 'caller'}
                </span>
                <span className="min-w-0">{t.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.actions.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Submitted</p>
          <pre className="overflow-x-auto rounded-md bg-background px-3 py-2 text-xs">
            {JSON.stringify(result.actions, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
