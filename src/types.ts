/**
 * PatchPilot core types.
 *
 * An `IncidentEvent` is Sentry-shaped: it is what the capture middleware posts and what
 * the dashboard/agent code reads.
 */

export interface StackFrame {
  /** Path as it appeared in the stack, usually relative to the app folder. */
  filename: string;
  /** Absolute path when the middleware could resolve one. */
  abs_path?: string;
  /** Sentry's optional module name; reporters may leave it unset. */
  module?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
  in_app?: boolean;
}

export interface ExceptionValue {
  type: string;
  value: string;
  mechanism?: { type?: string; handled?: boolean; description?: string };
  stacktrace?: { frames: StackFrame[] };
}

export interface IncidentEventRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface Breadcrumb {
  timestamp?: string;
  category?: string;
  message?: string;
  level?: string;
  data?: Record<string, unknown>;
}

/** Sentry-shaped event. `exception.values[].stacktrace.frames` is oldest-first; the last frame threw. */
export interface IncidentEvent {
  event_id: string;
  timestamp: string;
  platform: string;
  level?: string;
  environment?: string;
  transaction?: string;
  fingerprint?: string[];
  tags?: Record<string, string>;
  request?: IncidentEventRequest;
  breadcrumbs?: Breadcrumb[];
  exception: { values: ExceptionValue[] };
  /** Free-form text for manual reports. */
  message?: string;
}

export type Stage =
  | "received"
  | "triage"
  | "reproduce"
  | "fix"
  | "validate"
  | "review"
  | "pr"
  | "done"
  | "needs_human"
  | "failed";

export interface Suspect {
  file: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  reason?: string;
  score?: number;
}

export interface TriageResult {
  rootCause: string;
  intendedBehavior: string;
  suspects: Suspect[];
  confidence: number;
  needsHuman: boolean;
  raw?: string;
}

export interface Reproduction {
  testFile: string;
  testName: string;
  lockedHash: string;
  verifiedFailing: boolean;
  failureSummary?: string;
}

export interface BaselineRun {
  ok: boolean;
  passed: number;
  failed: number;
  summary: string;
}

export interface HardCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Attempt {
  index: number;
  ok: boolean;
  escalated: boolean;
  reason?: string;
  diff?: string;
  files: string[];
  hardChecks: HardCheckResult[];
  reproTest?: { ok: boolean; summary: string };
  fullSuite?: { ok: boolean; passed: number; failed: number; summary: string };
  text?: string;
  usage?: UsageTotals;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface CriticReview {
  confidence: number;
  addressesRootCause: boolean;
  behaviorChangeOutsideCrashPath: boolean | string;
  risks: string[];
  openQuestion?: string;
  raw?: string;
}

export interface GuardrailBlock {
  ts: string;
  stage: Stage;
  tool: string;
  input: unknown;
  reason: string;
}

export interface TimelineEntry {
  ts: string;
  type: string;
  text: string;
  data?: unknown;
}

export interface StageEntry {
  stage: Stage;
  ts: string;
  note?: string;
}

export interface SandboxInfo {
  dir: string;
  cwd: string;
  branch: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costInr: number;
  byStage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; costInr: number }>;
}

export interface PrInfo {
  title: string;
  branch: string;
  body: string;
  url?: string;
  error?: string;
  opened: boolean;
}

export interface Incident {
  id: string;
  fingerprint: string;
  repo: string;
  title: string;
  exceptionType: string;
  exceptionValue: string;
  events: IncidentEvent[];
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  stage: Stage;
  stageHistory: StageEntry[];
  frames: StackFrame[];
  /** Extra context for manual bug reports. */
  description?: string;
  suspectFile?: string;
  sandbox?: SandboxInfo;
  triage?: TriageResult;
  reproduction?: Reproduction;
  baseline?: BaselineRun;
  attempts: Attempt[];
  review?: CriticReview;
  pr?: PrInfo;
  needsHumanReason?: string;
  error?: string;
  guardrailBlocks: GuardrailBlock[];
  usage: UsageTotals;
  timeline: TimelineEntry[];
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface AgentAnswer {
  text: string;
  usage: UsageTotals;
  status: string;
}

/** One entry of `patchpilot.config.json` → `repos`. Paths are absolute (posix). */
export interface RepoConfig {
  /** Repo root. */
  root: string;
  /** App folder inside the root; "" means the root itself. */
  subdir: string;
  /** argv of the test command, e.g. ["node", "--test"]. */
  testCommand: string[];
  /** Test folders, relative to the app folder. */
  testPaths: string[];
  /** Globs that agents must never write to. */
  protectedPaths: string[];
  maxDiffLines: number;
  maxDiffFiles: number;
  baseRef: string;
}

export interface TestRunResult {
  command: string;
  passed: number;
  failed: number;
  durationMs: number;
  summary: string;
  failures: string[];
  exitCode: number | null;
  ok: boolean;
  timedOut: boolean;
}
