// ---------------------------------------------------------------------------
// Public types - exported from index.ts
// ---------------------------------------------------------------------------

export type CheckStatus = "ok" | "warn" | "fail" | "skipped" | "error";
export type FixStatus = "fixed" | "fix_failed";

/** Value returned by a check function. */
export interface CheckResult {
  status: CheckStatus;
  message: string;
  hint?: string;
}

/** Value returned by a fix function. */
export interface FixResult {
  status: FixStatus;
  message: string;
}

/** A fix function registered alongside a check. */
export type FixFn = () => FixResult | Promise<FixResult> | string | void | Promise<string | void>;

/** Options passed when registering a check. */
export interface CheckOptions {
  /** Category for visual grouping and `only` filtering. Default: "general". */
  tag?: string;
  /** Names of checks that must not have failed before this one runs. */
  depends_on?: string[];
  /** Downgrade a `fail` result to `warn` (exit code stays 0). */
  warn_only?: boolean;
  /** Seconds before the check is abandoned as `fail`. Default: 5. */
  timeout?: number;
  /** Extra attempts on failure (0 = one attempt total). Default: 0. */
  retries?: number;
  /** Seconds between retry attempts. Default: 1. */
  retry_delay?: number;
  /**
   * Flag this check as "slow" if it passes but takes longer than this many ms.
   * Overrides any global threshold set in `run()`.
   */
  slow_threshold_ms?: number;
  /** Optional repair function. Run automatically when `run({ fix: true })` is set and this check fails. */
  fix?: FixFn;
}

/** Read-only metadata returned by `Doctor.listChecks()`. */
export interface CheckInfo {
  name: string;
  tag: string;
  depends_on: string[];
  warn_only: boolean;
  timeout: number;
  retries: number;
  retry_delay: number;
  slow_threshold_ms: number | undefined;
  has_fix: boolean;
}

/** Minimal writable stream - compatible with `process.stdout`. */
export interface OutputStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
}

/** Options passed to `doctor.run()`. */
export interface RunOptions {
  /** Run fix callbacks for all failed checks after the main loop. */
  fix?: boolean;
  /** Run only checks whose tag is in this list. */
  only?: string[];
  /** Skip checks whose name is in this list. */
  skip?: string[];
  /** Print only the final summary line. */
  quiet?: boolean;
  /** Show all checks with full message and duration. Errors include stack trace. */
  verbose?: boolean;
  /** Emit a JSON object instead of human-readable output. */
  json?: boolean;
  /** Emit JUnit XML instead of human-readable output. */
  junit_xml?: boolean;
  /** Stop after the first `fail` or `error` and mark remaining checks as `skipped`. */
  fail_fast?: boolean;
  /** Stop after this many cumulative failures/errors. */
  max_failures?: number;
  /**
   * Global slow-check threshold in ms. An `ok` check whose duration exceeds
   * this value is flagged as slow. Per-check `slow_threshold_ms` takes precedence.
   */
  slow_threshold_ms?: number;
  /**
   * Stop scheduling new checks once total elapsed seconds exceeds this value.
   * The first check always runs; subsequent checks are skipped when the budget
   * is exhausted.
   */
  global_timeout?: number;
  /**
   * Maximum number of checks to run in parallel (default 1 = sequential).
   * Uses wave-based DAG scheduling to respect dependencies.
   */
  max_concurrency?: number;
  /** Where to write output. Default: `process.stdout`. */
  output?: OutputStream;
  /** Write the JSON payload to this file in addition to stdout output. */
  json_file?: string;
  /** Write the JUnit XML to this file in addition to stdout output. */
  junit_file?: string;
}

/** Summary counts from a completed run. */
export interface RunSummary {
  ok: number;
  warn: number;
  fail: number;
  skipped: number;
  slow: number;
}

/** Public result for a single check, returned by `runDetailed()`. */
export interface CheckRecord {
  name: string;
  status: CheckStatus;
  message: string;
  hint: string | undefined;
  tag: string;
  duration_ms: number;
  is_slow: boolean;
  skip_reason: string | undefined;
  fix_status: string | null;
  fix_message: string | null;
}

/** Rich return value from `runDetailed()`. */
export interface RunResult {
  exit_code: number;
  summary: RunSummary;
  checks: CheckRecord[];
  total_ms: number;
}

/** JSON output structure - stable, designed for CI consumption. */
export interface JsonOutput {
  checks: Array<{
    name: string;
    status: CheckStatus;
    message: string;
    hint: string | null;
    tag: string;
    duration_ms: number;
    is_slow: boolean;
    fix_status: string | null;
    fix_message: string | null;
  }>;
  summary: { ok: number; warn: number; fail: number; skipped: number; slow: number };
  exit_code: number;
}

// ---------------------------------------------------------------------------
// Internal types - NOT exported from index.ts
// ---------------------------------------------------------------------------

export type CheckFn = () =>
  | CheckResult
  | Promise<CheckResult>
  | string
  | void
  | Promise<string | void>;

export interface CheckDef {
  name: string;
  fn: CheckFn;
  tag: string;
  depends_on: string[];
  warn_only: boolean;
  timeout: number;
  retries: number;
  retry_delay: number;
  slow_threshold_ms: number | undefined;
  fix_fn: FixFn | undefined;
}

export interface InternalFixResult {
  status: "fixed" | "fix_failed" | "fix_error";
  message: string;
  exc_stack?: string;
}

export interface InternalResult {
  name: string;
  status: CheckStatus;
  message: string;
  hint: string | undefined;
  tag: string;
  duration_ms: number;
  skip_reason?: string;
  is_slow: boolean;
  /** Populated only when status is "error". */
  exc_stack?: string;
  fix_result?: InternalFixResult;
}
