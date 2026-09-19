/** The test lab's wire shapes, as the mock serves them on /__testlab. */

export interface Problem {
  id: string;
  number: number;
  title: string;
  weight: number;
  summary: string;
  cases: number;
}

export interface Persona {
  name: string;
  voice: 'male' | 'female';
  description: string;
  data: Record<string, string>;
  objectives: string[];
  turn_cap: number;
}

export interface Case {
  id: string;
  problem_id: string;
  problem: string;
  title: string;
  summary: string;
  /** Where this case came from and how its expectation was arrived at. */
  origin: string;
  language: string;
  from_number: string | null;
  persona: Persona;
  caller_prompt: string;
  script: string[];
  audio: { background: string; signal_to_noise_db: number | null };
  protected: string[];
  burst: number;
  expected: { acceptable: { actions: Record<string, unknown>[]; note?: string }[] };
}

export interface Behaviour {
  id: string;
  label: string;
  description: string;
  instructions: string;
  wpm: number;
  lead_ms: number;
  barge_in: boolean;
  gain: number;
}

export interface Vocabulary {
  id: string;
  label: string;
  description: string;
  instructions: string;
}

/** Which suite is loaded, and the seed the random asks came out of. */
export interface Generation {
  source: 'real' | 'generated';
  seed: number;
  random: number;
}

export interface SuiteResponse {
  problems: Problem[];
  cases: Case[];
  behaviours: Behaviour[];
  vocabularies: Vocabulary[];
  generation: Generation;
  /** The model behind the persona callers, or null when there is none and scripts are used. */
  persona_caller: string | null;
}

export interface Insight {
  code: string;
  severity: 'blocker' | 'major' | 'minor';
  detail: string;
  suggestion: string;
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface CaseResult {
  case_id: string;
  problem_id: string;
  title: string;
  behaviour: string;
  vocabulary: string;
  copy: number;
  pass: boolean;
  grade: { pass: boolean; misses: string[]; variant: number };
  actions: Record<string, unknown>[];
  leaked: string[];
  insights: Insight[];
  summary?: string;
  call: {
    call_id: string;
    from_number: string | null;
    ok: boolean;
    error?: string;
    frames_received: number;
    ms_to_first_audio: number | null;
    caller: 'script' | 'persona';
    behaviour: string;
    vocabulary: string;
    caller_prompt: string | null;
    caller_turns: string[];
    transcript: Turn[];
    wav_path: string | null;
    call_ms: number;
  };
}

export interface IssueDraft {
  problem_id: string;
  title: string;
  body: string;
  labels: string[];
  failing: string[];
}

export interface RunSummary {
  id: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  mode: 'script' | 'persona';
  behaviours: string[];
  vocabularies: string[];
  concurrency: number;
  started_at: string;
  finished_at: string | null;
  total: number;
  done: number;
  passed: number;
  stopping: boolean;
  error: string | null;
}

export interface FixPlan {
  problem_id: string;
  branch: string;
  plan: string;
}

export interface Run extends RunSummary {
  cases: { case_id: string; problem_id: string; title: string; copies: number; behaviour: string; vocabulary: string }[];
  results: CaseResult[];
  issues: IssueDraft[];
}

export interface RunRequest {
  case_ids?: string[];
  problem_ids?: string[];
  behaviours?: string[];
  vocabularies?: string[];
  mode?: 'script' | 'persona';
  concurrency?: number;
}
