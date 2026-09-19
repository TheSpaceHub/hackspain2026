import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchRun,
  fetchRuns,
  fetchSuite,
  regenerateSuite,
  startRun,
  stopRun,
  subscribeToRun,
} from '@/lib/testlab/client';
import type { Run, RunRequest, RunSummary, SuiteResponse } from '@/lib/testlab/types';

export interface TestLab {
  suite: SuiteResponse | null;
  /** Null while the lab has not been reached; the mock may simply not be running. */
  error: string | null;
  runs: RunSummary[];
  run: Run | null;
  running: boolean;
  select: (runId: string | null) => void;
  start: (req: RunRequest) => Promise<void>;
  stop: (runId: string) => Promise<void>;
  regenerate: (req: { seed?: number; random?: number }) => Promise<void>;
}

/** Results arrive one call at a time; re-reading the whole run keeps this honest and simple. */
const POLL_MS = 4_000;

export function useTestLab(): TestLab {
  const [suite, setSuite] = useState<SuiteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const selected = useRef<string | null>(null);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      setRuns(await fetchRuns());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const refreshRun = useCallback(async (id: string): Promise<void> => {
    try {
      const next = await fetchRun(id);
      if (selected.current === id) setRun(next);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchSuite(controller.signal)
      .then(setSuite)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(`the local Prosper is not answering (pnpm mock): ${String(err)}`);
      });
    void refreshRuns();
    return () => controller.abort();
  }, [refreshRuns]);

  const select = useCallback(
    (runId: string | null) => {
      selected.current = runId;
      setRun(null);
      if (runId) void refreshRun(runId);
    },
    [refreshRun],
  );

  // While a run is open and unfinished: the stream for progress, a poll for the
  // results themselves, which are too big to push on every call.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const id = run.id;
    const timer = setInterval(() => void refreshRun(id), POLL_MS);
    const stop = subscribeToRun(id, {
      onProgress: (done, total) => setRun((prev) => (prev && prev.id === id ? { ...prev, done, total } : prev)),
      onFinished: () => {
        void refreshRun(id);
        void refreshRuns();
      },
    });
    return () => {
      clearInterval(timer);
      stop();
    };
  }, [run, refreshRun, refreshRuns]);

  const start = useCallback(
    async (req: RunRequest) => {
      setError(null);
      try {
        const started = await startRun(req);
        selected.current = started.id;
        setRun(started);
        await refreshRuns();
      } catch (err) {
        setError(String(err));
      }
    },
    [refreshRuns],
  );

  const stop = useCallback(
    async (runId: string) => {
      try {
        await stopRun(runId);
        await refreshRun(runId);
      } catch (err) {
        setError(String(err));
      }
    },
    [refreshRun],
  );

  const regenerate = useCallback(async (req: { seed?: number; random?: number }) => {
    setError(null);
    try {
      setSuite(await regenerateSuite(req));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  return { suite, error, runs, run, regenerate, running: run?.status === 'running', select, start, stop };
}
