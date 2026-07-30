import type { CheckDef, CheckResult, FixFn, FixResult, InternalFixResult, InternalResult } from "./types.js";

/**
 * Execute a single check with timeout and retry logic.
 * Returns an InternalResult - never throws.
 */
export async function runCheck(cd: CheckDef): Promise<InternalResult> {
  let last: InternalResult | null = null;

  for (let attempt = 0; attempt <= cd.retries; attempt++) {
    if (attempt > 0) {
      await sleep(cd.retry_delay * 1000);
    }

    const t0 = Date.now();
    let raw: CheckResult | string | void = undefined;
    let thrownError: unknown = null;

    try {
      raw = await Promise.race([
        Promise.resolve(cd.fn()),
        sleep(cd.timeout * 1000).then((): never => {
          throw new Error(`timeout after ${cd.timeout}s`);
        }),
      ]);
    } catch (err) {
      thrownError = err;
    }

    const elapsed = Date.now() - t0;
    const isTimeout =
      thrownError instanceof Error &&
      thrownError.message.startsWith("timeout after");

    if (isTimeout) {
      last = {
        name: cd.name,
        status: "fail",
        message: `timeout after ${cd.timeout}s`,
        hint: undefined,
        tag: cd.tag,
        duration_ms: elapsed,
        is_slow: false,
      };
      continue; // retry
    }

    if (thrownError !== null) {
      last = {
        name: cd.name,
        status: "error",
        message: `unexpected error: ${
          thrownError instanceof Error ? thrownError.message : String(thrownError)
        }`,
        hint: "This is a bug in the check itself, not in your environment.",
        tag: cd.tag,
        duration_ms: elapsed,
        is_slow: false,
        exc_stack:
          thrownError instanceof Error ? thrownError.stack : String(thrownError),
      };
      continue; // retry
    }

    const interim = normalise(cd, raw, elapsed);
    last = interim;
    if (interim.status === "ok" || interim.status === "warn") return interim;
    // fail -> retry if attempts remain
  }

  return last!;
}

/**
 * Execute a fix function. Returns an InternalFixResult - never throws.
 */
export async function runFix(fixFn: FixFn): Promise<InternalFixResult> {
  try {
    const raw = await Promise.resolve(fixFn());
    if (raw == null) return { status: "fixed", message: "fixed" };
    if (typeof raw === "string") return { status: "fixed", message: raw };
    const result = raw as FixResult;
    return { status: result.status, message: result.message };
  } catch (err) {
    return {
      status: "fix_error",
      message: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      exc_stack: err instanceof Error ? err.stack : String(err),
    };
  }
}

/**
 * Topological sort of checks: dependency-first, registration order preserved
 * within the same level. Cycles are silently skipped.
 */
export function topoSort(checks: CheckDef[]): CheckDef[] {
  const byName = new Map(checks.map((c) => [c.name, c]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const result: CheckDef[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (temp.has(name)) return; // cycle - skip
    const cd = byName.get(name);
    if (!cd) return;
    temp.add(name);
    for (const dep of cd.depends_on) visit(dep);
    temp.delete(name);
    visited.add(name);
    result.push(cd);
  }

  for (const c of checks) visit(c.name);
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group topo-sorted checks into parallel waves.
 * Wave 0 = no deps. Wave N = max(dep waves) + 1.
 * Checks within the same wave are independent and safe to run concurrently.
 */
export function computeWaves(checks: CheckDef[]): CheckDef[][] {
  if (checks.length === 0) return [];
  const byName = new Map(checks.map((c) => [c.name, c]));
  const waveOf = new Map<string, number>();
  const inProgress = new Set<string>();

  function getWave(name: string): number {
    if (waveOf.has(name)) return waveOf.get(name)!;
    if (inProgress.has(name)) return -1; // cycle guard
    const cd = byName.get(name);
    if (!cd) return -1; // external dep - treat as already satisfied
    inProgress.add(name);
    let w = 0;
    for (const dep of cd.depends_on) {
      const dw = getWave(dep);
      if (dw >= 0) w = Math.max(w, dw + 1);
    }
    inProgress.delete(name);
    waveOf.set(name, w);
    return w;
  }

  for (const c of checks) getWave(c.name);

  const maxWave = Math.max(...Array.from(waveOf.values()));
  const waves: CheckDef[][] = Array.from({ length: maxWave + 1 }, () => []);
  for (const c of checks) waves[waveOf.get(c.name)!].push(c);
  return waves;
}

/**
 * Run async tasks with bounded concurrency (work-stealing).
 * Returns results in the same order as `tasks`.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalise(
  cd: CheckDef,
  raw: CheckResult | string | void,
  elapsed: number,
): InternalResult {
  if (raw == null) {
    return {
      name: cd.name, status: "ok", message: "ok",
      hint: undefined, tag: cd.tag, duration_ms: elapsed, is_slow: false,
    };
  }
  if (typeof raw === "string") {
    return {
      name: cd.name, status: "ok", message: raw,
      hint: undefined, tag: cd.tag, duration_ms: elapsed, is_slow: false,
    };
  }
  return {
    name: cd.name,
    status: raw.status,
    message: raw.message,
    hint: raw.hint,
    tag: cd.tag,
    duration_ms: elapsed,
    is_slow: false,
  };
}
