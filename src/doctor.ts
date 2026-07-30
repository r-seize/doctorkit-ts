import * as fs from "node:fs";
import process from "node:process";
import type {
  CheckDef,
  CheckFn,
  CheckInfo,
  CheckOptions,
  CheckRecord,
  FixFn,
  InternalResult,
  JsonOutput,
  OutputStream,
  RunOptions,
  RunResult,
  RunSummary,
} from "./types.js";
import { runCheck, runFix, topoSort, computeWaves, runWithConcurrency } from "./executor.js";
import {
  BOLD,
  CLEAR_LINE,
  COLORS,
  colorize,
  printFixSection,
  printResult,
  renderJunitXml,
} from "./renderer.js";

export class Doctor {
  private defs: CheckDef[] = [];

  // ------------------------------------------------------------------
  // Registration
  // ------------------------------------------------------------------

  /**
   * Register a check.
   *
   * @example
   * doctor.check("network-reachable", { tag: "network", timeout: 5 }, async () => {
   *   return { status: "ok", message: "internet reachable" };
   * });
   */
  check(name: string, fn: CheckFn): void;
  check(name: string, options: CheckOptions, fn: CheckFn): void;
  check(name: string, optionsOrFn: CheckOptions | CheckFn, fn?: CheckFn): void {
    let opts: CheckOptions = {};
    let checkFn: CheckFn;

    if (typeof optionsOrFn === "function") {
      checkFn = optionsOrFn;
    } else {
      opts = optionsOrFn;
      checkFn = fn!;
    }

    this.defs.push({
      name,
      fn: checkFn,
      tag: opts.tag ?? "general",
      depends_on: opts.depends_on ?? [],
      warn_only: opts.warn_only ?? false,
      timeout: opts.timeout ?? 5,
      retries: opts.retries ?? 0,
      retry_delay: opts.retry_delay ?? 1,
      slow_threshold_ms: opts.slow_threshold_ms,
      fix_fn: opts.fix,
    });
  }

  /**
   * Programmatic alternative to `check()` - takes the function before options.
   * Useful in loops or when check functions are dynamically generated.
   *
   * @example
   * for (const port of [5432, 6379]) {
   *   doctor.add(`port-${port}`, () => checkPort(port), { tag: "database" });
   * }
   */
  add(name: string, fn: CheckFn, options: CheckOptions = {}): void {
    this.defs.push({
      name,
      fn,
      tag: options.tag ?? "general",
      depends_on: options.depends_on ?? [],
      warn_only: options.warn_only ?? false,
      timeout: options.timeout ?? 5,
      retries: options.retries ?? 0,
      retry_delay: options.retry_delay ?? 1,
      slow_threshold_ms: options.slow_threshold_ms,
      fix_fn: options.fix,
    });
  }

  /**
   * Return metadata for all registered checks without executing them.
   *
   * Useful for `--list` flags in CLIs or introspection in tests.
   */
  listChecks(): CheckInfo[] {
    return this.defs.map((d) => ({
      name: d.name,
      tag: d.tag,
      depends_on: [...d.depends_on],
      warn_only: d.warn_only,
      timeout: d.timeout,
      retries: d.retries,
      retry_delay: d.retry_delay,
      slow_threshold_ms: d.slow_threshold_ms,
      has_fix: d.fix_fn != null,
    }));
  }

  // ------------------------------------------------------------------
  // Execution
  // ------------------------------------------------------------------

  /**
   * Execute all registered checks and print results.
   *
   * @returns Exit code: `0` = all ok/warn, `1` = at least one fail,
   *          `2` = at least one check threw an unexpected exception.
   */
  async run(options: RunOptions = {}): Promise<number> {
    const { exitCode } = await this._execute(options);
    return exitCode;
  }

  /**
   * Execute all registered checks and return structured results.
   *
   * Accepts the same options as `run()`. The return value gives programmatic
   * access to every check result, summary counts, and the exit code - without
   * having to capture and parse stdout.
   */
  async runDetailed(options: RunOptions = {}): Promise<RunResult> {
    const { exitCode, allResults, totalMs } = await this._execute(options);

    const summary: RunSummary = {
      ok: allResults.filter((r) => r.status === "ok").length,
      warn: allResults.filter((r) => r.status === "warn").length,
      fail: allResults.filter((r) => r.status === "fail" || r.status === "error").length,
      skipped: allResults.filter((r) => r.status === "skipped").length,
      slow: allResults.filter((r) => r.is_slow).length,
    };

    const checks: CheckRecord[] = allResults.map((r) => ({
      name: r.name,
      status: r.status,
      message: r.message,
      hint: r.hint,
      tag: r.tag,
      duration_ms: r.duration_ms,
      is_slow: r.is_slow,
      skip_reason: r.skip_reason,
      fix_status: r.fix_result?.status ?? null,
      fix_message: r.fix_result?.message ?? null,
    }));

    return { exit_code: exitCode, summary, checks, total_ms: totalMs };
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private async _execute(options: RunOptions): Promise<{
    exitCode: number;
    allResults: InternalResult[];
    totalMs: number;
  }> {
    const out: OutputStream = options.output ?? process.stdout;
    const maxConcurrency = options.max_concurrency ?? 1;
    const useColor =
      !options.json && !options.junit_xml && Boolean(out.isTTY);
    const useSpinner = useColor && !options.quiet && maxConcurrency === 1;

    const writeln = (s: string) => out.write(s + "\n");

    let checks = [...this.defs];
    if (options.only) {
      const onlySet = new Set(options.only);
      checks = checks.filter((c) => onlySet.has(c.tag));
    }
    if (options.skip) {
      const skipSet = new Set(options.skip);
      checks = checks.filter((c) => !skipSet.has(c.name));
    }
    checks = topoSort(checks);

    const waves =
      maxConcurrency > 1 ? computeWaves(checks) : checks.map((c) => [c]);

    const done = new Map<string, InternalResult>();
    const allResults: InternalResult[] = [];
    let errorOccurred = false;
    let currentTag: string | null = null;
    let stoppedEarly = false;
    let failCount = 0;
    const t0Total = Date.now();

    for (const wave of waves) {
      const toRun: CheckDef[] = [];
      const skipReasonMap = new Map<string, string>();

      for (const cd of wave) {
        let skipReason: string | undefined;

        if (stoppedEarly) {
          skipReason = "fail_fast: stopped after first failure";
        } else if (
          options.global_timeout != null &&
          allResults.length > 0 &&
          (Date.now() - t0Total) / 1000 > options.global_timeout
        ) {
          skipReason = "global timeout exceeded";
        } else {
          for (const dep of cd.depends_on) {
            const depResult = done.get(dep);
            if (!depResult) continue;
            if (depResult.status === "fail" || depResult.status === "error") {
              skipReason = `depends on '${dep}' which failed`;
              break;
            }
            if (depResult.status === "skipped") {
              skipReason = `depends on '${dep}' which was skipped`;
              break;
            }
          }
        }

        if (skipReason) {
          skipReasonMap.set(cd.name, skipReason);
        } else {
          toRun.push(cd);
        }
      }

      const runResultMap = new Map<string, InternalResult>();

      if (maxConcurrency > 1 && toRun.length > 1) {
        const tasks = toRun.map((cd) => () => runCheck(cd));
        const results = await runWithConcurrency(tasks, maxConcurrency);
        toRun.forEach((cd, i) => runResultMap.set(cd.name, results[i]));
      } else {
        for (const cd of toRun) {
          if (useSpinner) out.write(`  ⟳ ${cd.name}: running...`);
          const r = await runCheck(cd);
          if (useSpinner) out.write(CLEAR_LINE);
          runResultMap.set(cd.name, r);
        }
      }

      for (const cd of wave) {
        let r: InternalResult;

        if (skipReasonMap.has(cd.name)) {
          r = {
            name: cd.name,
            status: "skipped",
            message: "",
            hint: undefined,
            tag: cd.tag,
            duration_ms: 0,
            skip_reason: skipReasonMap.get(cd.name),
            is_slow: false,
          };
        } else {
          r = runResultMap.get(cd.name)!;
          if (r.status === "error") errorOccurred = true;
          if (cd.warn_only && r.status === "fail") r = { ...r, status: "warn" };

          const threshold = cd.slow_threshold_ms ?? options.slow_threshold_ms;
          if (threshold != null && r.status === "ok" && r.duration_ms > threshold) {
            r = { ...r, is_slow: true };
          }

          if (r.status === "fail" || r.status === "error") {
            failCount++;
            if (
              options.fail_fast ||
              (options.max_failures != null && failCount >= options.max_failures)
            ) {
              stoppedEarly = true;
            }
          }
        }

        done.set(cd.name, r);
        allResults.push(r);

        if (!options.json && !options.junit_xml && !options.quiet) {
          if (cd.tag !== currentTag) {
            currentTag = cd.tag;
            writeln("\n" + colorize(`[${currentTag}]`, useColor, BOLD));
          }
          printResult(r, { verbose: options.verbose ?? false, useColor, writeln });
        }
      }
    }

    const totalMs = Date.now() - t0Total;

    const okN = allResults.filter((r) => r.status === "ok").length;
    const warnN = allResults.filter((r) => r.status === "warn").length;
    const failN = allResults.filter(
      (r) => r.status === "fail" || r.status === "error",
    ).length;
    const skipN = allResults.filter((r) => r.status === "skipped").length;
    const slowN = allResults.filter((r) => r.is_slow).length;

    const exitCode = errorOccurred ? 2 : failN > 0 ? 1 : 0;

    const defByName = new Map(checks.map((c) => [c.name, c]));

    if (options.fix) {
      for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i];
        if (r.status !== "fail" && r.status !== "error") continue;
        const cd = defByName.get(r.name);
        if (!cd?.fix_fn) continue;
        const fr = await runFix(cd.fix_fn);
        allResults[i] = { ...r, fix_result: fr };
      }
    }

    // Build JSON payload always - needed for file output even when json=false.
    const payload: JsonOutput = {
      checks: allResults.map((r) => ({
        name: r.name,
        status: r.status,
        message: r.message,
        hint: r.hint ?? null,
        tag: r.tag,
        duration_ms: Math.round(r.duration_ms * 10) / 10,
        is_slow: r.is_slow,
        fix_status: r.fix_result?.status ?? null,
        fix_message: r.fix_result?.message ?? null,
      })),
      summary: { ok: okN, warn: warnN, fail: failN, skipped: skipN, slow: slowN },
      exit_code: exitCode,
    };

    if (options.junit_xml) {
      writeln(renderJunitXml(allResults));
    } else if (options.json) {
      writeln(JSON.stringify(payload, null, 2));
    } else {
      const parts: string[] = [];
      if (okN) parts.push(colorize(`${okN} ok`, useColor, COLORS.ok));
      if (warnN) parts.push(colorize(`${warnN} warn`, useColor, COLORS.warn));
      if (failN) parts.push(colorize(`${failN} fail`, useColor, COLORS.fail));
      if (skipN) parts.push(colorize(`${skipN} skipped`, useColor, COLORS.skipped));
      if (slowN) parts.push(colorize(`${slowN} slow`, useColor, COLORS.warn));
      writeln(`\n${parts.join(", ")} - ${totalMs}ms total`);
      if (options.fix) {
        printFixSection(allResults, { useColor, writeln });
      }
    }

    // File output - additive, independent of stdout format.
    if (options.json_file) {
      fs.writeFileSync(options.json_file, JSON.stringify(payload, null, 2), "utf-8");
    }
    if (options.junit_file) {
      fs.writeFileSync(options.junit_file, renderJunitXml(allResults), "utf-8");
    }

    return { exitCode, allResults, totalMs };
  }
}
