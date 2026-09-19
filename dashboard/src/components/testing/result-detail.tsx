import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Case, CaseResult } from '@/lib/testlab/types';
import { Markdown } from './markdown';

const SEVERITY: Record<string, 'destructive' | 'brand' | 'outline'> = {
  blocker: 'destructive',
  major: 'brand',
  minor: 'outline',
};

/**
 * What the case asked for, before anything that happened: the ask in the caller's
 * own words, and the one record the clinic says is right. Without it a failing row
 * is an opinion.
 */
function HowTested({ kase }: { kase: Case }) {
  const acceptable = kase.expected.acceptable;
  return (
    <div className="rounded-md border border-border/60 bg-background px-3 py-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">How this is tested</p>
      <p>{kase.summary}</p>
      {kase.origin && <p className="mt-1 text-xs text-muted-foreground">{kase.origin}</p>}
      <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Problem</dt>
        <dd>{kase.problem}</dd>
        <dt className="text-muted-foreground">Caller</dt>
        <dd>
          {kase.persona.name} · {kase.language} · from {kase.from_number ?? 'a withheld number'}
        </dd>
        <dt className="text-muted-foreground">Wants</dt>
        <dd>
          <ul className="list-inside list-disc">
            {kase.persona.objectives.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </dd>
        {kase.audio.background !== 'silence' && (
          <>
            <dt className="text-muted-foreground">Line</dt>
            <dd>
              {kase.audio.background.replace(/_/g, ' ')}
              {kase.audio.signal_to_noise_db === null ? '' : ` at ${kase.audio.signal_to_noise_db}dB SNR`}
            </dd>
          </>
        )}
        {kase.protected.length > 0 && (
          <>
            <dt className="text-muted-foreground">Must not say</dt>
            <dd>{kase.protected.join(', ')}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Counts as right</dt>
        <dd>
          {acceptable.map((variant, i) => (
            <div key={i} className="mb-1">
              {variant.note && <p className="text-muted-foreground">{variant.note}</p>}
              <pre className="overflow-x-auto text-xs">{JSON.stringify(variant.actions, null, 2)}</pre>
            </div>
          ))}
        </dd>
      </dl>
    </div>
  );
}

/** Everything that would otherwise mean reading a log: what was wanted, what happened, what to do. */
export function ResultDetail({ result, kase }: { result: CaseResult; kase?: Case }) {
  const call = result.call;
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 bg-muted/20 px-3 py-3 text-sm">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{call.caller === 'persona' ? 'Persona caller' : 'Scripted caller'}</span>
        <span>{call.behaviour.replace(/_/g, ' ')}</span>
        <span>{(call.vocabulary ?? 'plain').replace(/_/g, ' ')}</span>
        <span>{(call.call_ms / 1000).toFixed(1)}s</span>
        <span>{call.ms_to_first_audio === null ? 'no agent audio' : `${call.ms_to_first_audio}ms to first audio`}</span>
        <span>{call.frames_received} frames in</span>
        {call.wav_path && <span className="truncate">{call.wav_path}</span>}
      </div>

      {kase && <HowTested kase={kase} />}

      {result.summary && <Markdown className="text-sm">{result.summary}</Markdown>}

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
              {i.why && (
                <p className="mt-1 text-muted-foreground">
                  <span className="font-medium text-foreground">Why: </span>
                  {i.why}
                </p>
              )}
              {(i.evidence ?? []).length > 0 && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap">
                  {(i.evidence ?? []).join('\n')}
                </pre>
              )}
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

      {call.caller_prompt && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            What the caller agent was told to be
          </summary>
          <pre className="mt-1 overflow-x-auto rounded-md bg-background px-3 py-2 text-xs whitespace-pre-wrap">
            {call.caller_prompt}
          </pre>
        </details>
      )}
    </div>
  );
}
