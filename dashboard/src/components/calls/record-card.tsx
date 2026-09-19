import { TriangleAlert } from 'lucide-react';
import { Badge, BadgeDot } from '@/components/ui/badge';
import type { Call, Submission } from '@/lib/agent/model';
import { formatLatency } from '@/lib/format';
import { actionLabel, actionTone, isAccepted } from '@/lib/outcome';

/** The submission window is 30 s from the socket closing; how much of it we used. */
const WINDOW_MS = 30_000;

function StatusPill({ status }: { status: number }) {
  if (status === 200) return <Badge variant="secondary">200 accepted</Badge>;
  if (status === 409) return <Badge variant="secondary">409 duplicate</Badge>;
  if (status === 0) return <Badge variant="destructive">never sent</Badge>;
  const meaning: Record<number, string> = { 404: 'unknown call', 410: 'window closed', 422: 'malformed' };
  return <Badge variant="destructive">{`${status} ${meaning[status] ?? 'rejected'}`}</Badge>;
}

/** The body as sent, minus the call id every body carries. Nested objects flatten one level. */
function fieldsOf(body: unknown): [string, string][] {
  if (!body || typeof body !== 'object') return [];
  return Object.entries(body as Record<string, unknown>).flatMap(([k, v]): [string, string][] => {
    if (k === 'call_id') return [];
    if (v && typeof v === 'object') return fieldsOf(v).map(([ik, iv]) => [`${k}.${ik}`, iv]);
    return [[k, String(v)]];
  });
}

function SubmissionRow({ s }: { s: Submission }) {
  const fields = fieldsOf(s.body);
  return (
    <div className="space-y-3 rounded-lg border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isAccepted(s.status) ? actionTone(s.action) : 'destructive'}>
          <BadgeDot />
          {actionLabel(s.action)}
        </Badge>
        <code className="font-mono text-xs text-muted-foreground">POST /submit/{s.route}</code>
        <span className="ml-auto flex items-center gap-2">
          <StatusPill status={s.status} />
        </span>
      </div>
      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {s.error && (
        <p className="flex items-start gap-1.5 text-xs text-red-700">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {s.error}
        </p>
      )}
      <p className="tabular text-xs text-muted-foreground">
        {s.attempts ?? 1} {s.attempts === 1 || s.attempts === null ? 'attempt' : 'attempts'} · {formatLatency(s.durationMs)}
      </p>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-medium">
        {value}
        {hint && <span className="ml-1 font-normal text-muted-foreground">{hint}</span>}
      </dd>
    </div>
  );
}

export function RecordCard({ call }: { call: Call }) {
  const { decider, timings } = call;
  const windowMs = timings.closeToSubmittedMs;

  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 className="font-heading text-sm font-medium">What the agent recorded</h3>
        {decider.usedFloor && (
          <Badge variant="brand" title="The decider failed and the always-submit floor answered instead">
            Floor used
          </Badge>
        )}
      </header>

      <div className="space-y-5 p-4">
        {decider.notes && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Decider’s reasoning</p>
            <blockquote className="border-l-2 border-brand-300 pl-3 text-sm leading-relaxed">{decider.notes}</blockquote>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Metric label="Confidence" value={decider.confidence === null ? '—' : `${Math.round(decider.confidence * 100)}%`} />
          <Metric label="Decider" value={formatLatency(timings.deciderMs)} />
          <Metric label="Session start" value={formatLatency(timings.sessionStartMs)} />
          <Metric label="Close → submitted" value={formatLatency(windowMs)} hint={windowMs === null ? undefined : `of ${WINDOW_MS / 1000} s`} />
        </dl>

        <div className="space-y-2">
          {call.submissions.length === 0 && call.outcomes.length > 0 ? (
            // The list knows actions were sent; their bodies just are not loaded yet.
            <p className="text-sm text-muted-foreground">
              {call.outcomes.length} {call.outcomes.length === 1 ? 'submission' : 'submissions'} on record — loading details…
            </p>
          ) : call.submissions.length === 0 ? (
            <p className="flex items-center gap-1.5 text-sm text-red-700">
              <TriangleAlert className="size-4" />
              Nothing was submitted — always a failed case.
            </p>
          ) : (
            call.submissions.map((s) => <SubmissionRow key={s.seq} s={s} />)
          )}
        </div>

        {call.errors.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50/60 p-3">
            <p className="text-xs font-medium text-red-800">Errors during the call</p>
            <ul className="space-y-1 font-mono text-xs text-red-800">
              {call.errors.map((e, i) => (
                <li key={i} className="break-all">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        )}

        {decider.model && <p className="font-mono text-[11px] text-muted-foreground">decider · {decider.model}</p>}
      </div>
    </section>
  );
}
