# doctorkit · TypeScript

> Health-check engine for CLI tools - declare checks, get structured diagnostics with zero dependencies.

**Also available in Python** -> [doctorkit-py](https://github.com/r-seize/doctorkit-py)

---

## Table of contents

- [What is doctorkit?](#what-is-doctorkit)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Check registration](#check-registration)
  - [Decorator-style vs programmatic](#decorator-style-vs-programmatic)
  - [Check options](#check-options)
  - [Return values](#return-values)
- [Running checks](#running-checks)
  - [Run options](#run-options)
  - [Filtering: only and skip](#filtering-only-and-skip)
  - [Dependency chains](#dependency-chains)
  - [Timeouts and retries](#timeouts-and-retries)
  - [Parallel execution (max_concurrency)](#parallel-execution-max_concurrency)
  - [Slow check detection](#slow-check-detection)
  - [Stop early: fail_fast and max_failures](#stop-early-fail_fast-and-max_failures)
  - [Global timeout](#global-timeout)
  - [File output](#file-output)
  - [Programmatic access: runDetailed()](#programmatic-access-rundetailed)
- [Output formats](#output-formats)
  - [Human output (default)](#human-output-default)
  - [Verbose mode](#verbose-mode)
  - [Quiet mode](#quiet-mode)
  - [JSON output](#json-output)
  - [JUnit XML output](#junit-xml-output)
- [Exit codes](#exit-codes)
- [Listing checks without running](#listing-checks-without-running)
- [Fix callbacks](#fix-callbacks)
- [Built-in check library](#built-in-check-library)
- [CLI: doctorkit init](#cli-doctorkit-init)
- [API reference](#api-reference)
- [Also available in Python](#also-available-in-python)

---

## What is doctorkit?

Every serious CLI eventually ships a `doctor` subcommand - a self-diagnostic that tells users exactly why something isn't working. The problem: every team reimplements the same mechanics from scratch.

**doctorkit** is that shared engine. You declare the checks; it handles everything else:

- Running checks grouped by tag with live terminal output
- Skipping downstream checks when a dependency fails (no point checking auth if the network is down)
- Per-check timeouts with configurable retries
- Parallel wave-based execution across independent checks
- Flagging checks that pass but take too long
- Emitting structured JSON or JUnit XML for CI pipelines
- Consistent exit codes (`0` ok, `1` fail, `2` exception in a check)
- Stopping early when a threshold of failures is reached

It ships **zero** domain checks and has **zero** runtime dependencies. It has no opinion about what your tool needs to verify - that's entirely up to you.

```
[network]
  [GOOD] network-reachable
  [GOOD] dns-lookup

[auth]
  [FAIL] api-key-set: ANTHROPIC_API_KEY is not set (12ms)
    -> Run: export ANTHROPIC_API_KEY=sk-ant-...
  [SKIPPED] api-key-format (depends on 'api-key-set' which failed)

[filesystem]
  [GOOD] config-dir
  [GOOD] tmp-writable

2 ok, 1 fail, 1 skipped - 347ms total
```

---

## Install

```bash
npm install doctorkit
# or
pnpm add doctorkit
# or
yarn add doctorkit
```

Requires Node.js >= 18. Zero runtime dependencies.

---

## Quick start

```typescript
import { Doctor } from "doctorkit";
import process from "node:process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const doctor = new Doctor();

// Check with tag, timeout, and a hint on failure
doctor.check("network-reachable", { tag: "network", timeout: 5 }, async () => {
  try {
    await dns.lookup("example.com");
    return { status: "ok", message: "internet reachable" };
  } catch (err) {
    return {
      status: "fail",
      message: `cannot reach internet: ${err}`,
      hint: "Check your network connection.",
    };
  }
});

// This check only runs if network-reachable passed
doctor.check("api-key-set", { tag: "auth", depends_on: ["network-reachable"] }, () => {
  const key = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (!key) {
    return {
      status: "fail",
      message: "ANTHROPIC_API_KEY is not set",
      hint: "Run: export ANTHROPIC_API_KEY=sk-ant-...",
    };
  }
  return { status: "ok", message: `API key found (${key.slice(0, 8)}...)` };
});

// warn does not fail the run (exit code stays 0)
doctor.check("config-dir", { tag: "filesystem", warn_only: true }, () => {
  const p = path.join(os.homedir(), ".config");
  if (!fs.existsSync(p))
    return { status: "fail", message: `${p} missing`, hint: `mkdir -p ${p}` };
  return { status: "ok", message: `${p} found` };
});

// Wire into your CLI - doctorkit never owns the CLI
const args = process.argv.slice(2);
doctor
  .run({
    json: args.includes("--json"),
    verbose: args.includes("--verbose"),
    quiet: args.includes("--quiet"),
    only: args.includes("--only") ? [args[args.indexOf("--only") + 1]] : undefined,
  })
  .then((code) => process.exit(code));
```

---

## How it works

1. You register checks with `doctor.check()` or `doctor.add()`. Each check has a name, a tag (group), optional dependencies, and a function that returns a status.
2. When you call `doctor.run()`, doctorkit topologically sorts the checks to respect their `depends_on` relationships, then executes them.
3. If a check's dependency has `fail`, `error`, or `skipped` status, the check is cascade-skipped automatically.
4. Results are printed live grouped by tag with colored symbols. At the end, a summary line shows counts and total duration.
5. The return value of `run()` is an integer exit code you can pass to `process.exit()`.

---

## Check registration

### Decorator-style vs programmatic

```typescript
// Style 1: inline (most common)
doctor.check("my-check", { tag: "network" }, async () => {
  return { status: "ok", message: "all good" };
});

// Style 2: without options (tag defaults to "general")
doctor.check("simple-check", () => {
  return { status: "ok", message: "ok" };
});

// Style 3: programmatic - useful in loops or dynamic registration
for (const port of [5432, 6379, 9200]) {
  doctor.add(`port-${port}`, () => checkPort(port), { tag: "deps" });
}
```

### Check options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tag` | `string` | `"general"` | Category for visual grouping and `only` filter |
| `depends_on` | `string[]` | `[]` | Check names that must not have failed before this one runs |
| `warn_only` | `boolean` | `false` | Downgrade a `fail` result to `warn` - exit code stays `0` |
| `timeout` | `number` | `5` | Seconds before the check is abandoned and recorded as `fail` |
| `retries` | `number` | `0` | Extra attempts on failure (0 = one attempt total) |
| `retry_delay` | `number` | `1` | Seconds to wait between retries |
| `slow_threshold_ms` | `number` | - | Flag this check as slow if it passes but takes longer than this many ms. Overrides any global threshold. |
| `fix` | `FixFn` | - | Optional repair function. Called automatically when `run({ fix: true })` and this check fails. See [Fix callbacks](#fix-callbacks). |

### Return values

A check function may return (sync or async):

| Return value | Recorded as |
|---|---|
| `{ status: "ok", message: "..." }` | ok |
| `{ status: "warn", message: "...", hint?: "..." }` | warn |
| `{ status: "fail", message: "...", hint?: "..." }` | fail |
| A string | ok, with that string as message |
| `void` / `undefined` | ok |
| Throws | error (exit code 2) |

The `hint` field appears indented below the check line - use it for actionable fix instructions.

---

## Running checks

### Run options

```typescript
const exitCode = await doctor.run({
  only: ["network", "auth"],      // run only these tags
  skip: ["slow-check"],           // skip these check names
  quiet: false,                   // summary only
  verbose: false,                 // full detail including durations
  json: false,                    // structured JSON output
  junit_xml: false,               // JUnit XML output (for CI)
  json_file: "results.json",      // also write JSON to this file
  junit_file: "results.xml",      // also write JUnit XML to this file
  fail_fast: false,               // stop after first failure
  max_failures: 3,                // stop after 3 cumulative failures
  slow_threshold_ms: 500,         // flag checks taking over 500ms
  global_timeout: 30,             // skip remaining after 30s wall-clock
  max_concurrency: 4,             // run up to 4 checks in parallel
  output: process.stdout,         // where to write (defaults to stdout)
});
```

### Filtering: only and skip

```typescript
// Run only the "network" and "auth" groups
await doctor.run({ only: ["network", "auth"] });

// Skip specific checks by name
await doctor.run({ skip: ["slow-check", "optional-check"] });
```

`only` matches the check's `tag`. `skip` matches the check's `name`. Both can be combined.

### Dependency chains

When check B declares `depends_on: ["a"]`, doctorkit:
1. Automatically runs A before B regardless of registration order.
2. Cascade-skips B (and anything depending on B) if A has status `fail`, `error`, or `skipped`.
3. Allows B to run normally if A has status `warn`.

```typescript
doctor.check("db-reachable", { tag: "database" }, checkDbConnectivity);

// Only runs if db-reachable passed
doctor.check("db-migrated", { tag: "database", depends_on: ["db-reachable"] }, checkMigrations);

// Only runs if both above passed
doctor.check("db-seeded", { tag: "database", depends_on: ["db-migrated"] }, checkSeedData);
```

Cycles are silently broken (the involved check still runs).

### Timeouts and retries

```typescript
doctor.check("flaky-api", {
  tag: "external",
  timeout: 10,       // fail if the check takes more than 10s
  retries: 3,        // retry up to 3 times on fail or exception
  retry_delay: 2,    // wait 2s between retries
}, async () => {
  const res = await fetch("https://api.example.com/health");
  if (!res.ok) return { status: "fail", message: `HTTP ${res.status}` };
  return { status: "ok", message: "API healthy" };
});
```

On timeout, the check is immediately recorded as `fail` (the timeout message says `timeout after Xs`). Each retry starts a fresh attempt; if any attempt returns `ok` or `warn`, the loop stops early.

### Parallel execution (max_concurrency)

By default, checks run sequentially. Set `max_concurrency` to run independent checks in parallel:

```typescript
await doctor.run({ max_concurrency: 8 });
```

doctorkit uses **wave-based DAG scheduling**:
- Wave 0: all checks with no dependencies
- Wave 1: checks whose dependencies are all in wave 0
- Wave N: checks whose dependencies are all in earlier waves

All checks within the same wave are independent and run concurrently. Waves are executed in order, so dependency constraints are always respected.

This is particularly useful when checks involve I/O: network calls, database pings, file-system probes.

### Slow check detection

Flag checks that pass but take too long:

```typescript
// Global threshold: any check taking over 500ms is flagged
await doctor.run({ slow_threshold_ms: 500 });

// Per-check override: takes precedence over the global threshold
doctor.check("cold-cache-query", {
  tag: "database",
  slow_threshold_ms: 2000,  // allow up to 2s for this one
}, async () => { ... });
```

Slow checks appear with `<- slow` and their duration even in non-verbose mode. The summary line includes a `slow` count.

### Stop early: fail_fast and max_failures

```typescript
// Stop after the very first failure
await doctor.run({ fail_fast: true });

// Stop after 3 cumulative failures/errors
await doctor.run({ max_failures: 3 });
```

After stopping, all remaining checks are recorded as `skipped` in the output. `fail_fast` is equivalent to `max_failures: 1`.

### Global timeout

Stop scheduling new checks once the total wall-clock time exceeds the budget:

```typescript
// If the run takes more than 30s, remaining unstarted checks are skipped
await doctor.run({ global_timeout: 30 });
```

The first check always runs regardless. Running checks are not interrupted - the timeout only prevents new checks from starting.

### File output

Write results to a file independently of what is printed to stdout:

```typescript
// Write JSON to a file - human output still goes to stdout
await doctor.run({ json_file: "results/checks.json" });

// Write JUnit XML to a file for CI artifact upload
await doctor.run({ junit_file: "test-results/doctorkit.xml" });

// Both files at once, human output on stdout
await doctor.run({ json_file: "results.json", junit_file: "results.xml" });

// json_file + json stdout output are independent
await doctor.run({ json: true, json_file: "results.json" });
```

`json_file` and `junit_file` are fully independent of the `json` and `junit_xml` stdout options. All combinations are valid.

### Programmatic access: runDetailed()

Use `runDetailed()` to get structured data from the run instead of just an exit code:

```typescript
import { Doctor } from "doctorkit";
import type { RunResult } from "doctorkit";

const result: RunResult = await doctor.runDetailed();

console.log(result.exit_code);     // 0, 1, or 2
console.log(result.summary.ok);    // count of passing checks
console.log(result.summary.fail);  // count of failed checks
console.log(result.total_ms);      // total wall-clock time in ms

for (const check of result.checks) {
  if (check.status === "fail") {
    console.log(`${check.name}: ${check.message}`);
  }
}

process.exit(result.exit_code);
```

Accepts exactly the same options as `run()`. Both produce identical output - the only difference is what they return.

---

## Output formats

### Human output (default)

Checks are printed grouped by tag as they complete. Each check line starts with a colored badge:

| Badge | Background | Meaning |
|-------|-----------|---------|
| `[GOOD]` | green | ok |
| `[WARN]` | yellow | warn |
| `[FAIL]` | red | fail |
| `[ERROR]` | magenta | unexpected exception in the check |
| `[SKIPPED]` | blue | skipped (cascade or early stop) |

Badges are colored only when writing to a TTY. In non-TTY mode (CI, pipes, redirects) the plain text label is used.

```
[network]
  [GOOD] network-reachable
  [FAIL] dns-lookup: NXDOMAIN (34ms)
    -> Check your /etc/resolv.conf

[auth]
  [SKIPPED] api-key-set (depends on 'dns-lookup' which failed)

1 ok, 1 fail, 1 skipped - 201ms total
```

### Verbose mode

`verbose: true` shows the message and duration for every check, not just failures. Exceptions include the full stack trace.

```
[network]
  [GOOD] network-reachable: internet reachable (45ms)
  [FAIL] dns-lookup: NXDOMAIN (34ms)
    -> Check your /etc/resolv.conf
    Error: getaddrinfo ENOTFOUND example.com
        at ...
```

### Quiet mode

`quiet: true` hides all check detail and prints only the summary line:

```
1 ok, 1 fail, 1 skipped - 201ms total
```

### JSON output

`json: true` emits a single JSON object. No human-readable output is produced.

```json
{
  "checks": [
    {
      "name": "api-key-set",
      "status": "fail",
      "message": "ANTHROPIC_API_KEY is not set",
      "hint": "Run: export ANTHROPIC_API_KEY=sk-ant-...",
      "tag": "auth",
      "duration_ms": 12.0,
      "is_slow": false,
      "fix_status": null,
      "fix_message": null
    }
  ],
  "summary": {
    "ok": 1,
    "warn": 0,
    "fail": 1,
    "skipped": 1,
    "slow": 0
  },
  "exit_code": 1
}
```

### JUnit XML output

`junit_xml: true` emits JUnit-compatible XML - readable by most CI systems (GitHub Actions, Jenkins, GitLab CI, etc.).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="auth" tests="2" failures="1" skipped="0" time="0.045">
    <testcase name="api-key-set" classname="auth" time="0.012">
      <failure message="ANTHROPIC_API_KEY is not set"/>
    </testcase>
    <testcase name="api-key-format" classname="auth" time="0.000">
      <skipped message="depends on 'api-key-set' which failed"/>
    </testcase>
  </testsuite>
</testsuites>
```

Checks are grouped into `<testsuite>` elements by tag. Skipped checks include the cascade reason. Failed checks include the message and traceback when available.

---

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All checks ok or warn |
| `1` | At least one check failed |
| `2` | At least one check threw an unexpected exception (bug in the check itself) |

---

## Listing checks without running

Inspect registered checks without executing them - useful for `--list` flags:

```typescript
const infos = doctor.listChecks();
// [
//   { name: "network-reachable", tag: "network", depends_on: [], timeout: 5, ... },
//   { name: "api-key-set", tag: "auth", depends_on: ["network-reachable"], ... },
// ]

for (const c of infos) {
  console.log(`${c.tag}/${c.name}`);
}
```

---

## Fix callbacks

Register a repair function alongside any check. When you call `doctor.run({ fix: true })`, doctorkit automatically runs the fix for every check that returned `fail` or threw an exception.

Fixes always run sequentially after the main check loop, regardless of `max_concurrency`. This keeps system modifications predictable and output unambiguous.

```typescript
import { Doctor } from "doctorkit";

const doctor = new Doctor();

doctor.check(
  "api-key-set",
  {
    tag: "auth",
    fix: () => ({ status: "fixed", message: "Opened .env for editing - paste your key and save" }),
  },
  () => {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) {
      return {
        status: "fail",
        message: "ANTHROPIC_API_KEY is not set",
        hint: "Run: export ANTHROPIC_API_KEY=sk-ant-...",
      };
    }
    return { status: "ok", message: "API key found" };
  },
);

const exitCode = await doctor.run({ fix: true });
```

Output when the check fails:

```
[auth]
  [FAIL] api-key-set: ANTHROPIC_API_KEY is not set (2ms)
    -> Run: export ANTHROPIC_API_KEY=sk-ant-...

1 fail - 5ms total

[fixes]
  [FIXED] api-key-set: Opened .env for editing - paste your key and save
```

Fix function return values (sync or async):

| Return value | Displayed as |
|---|---|
| `{ status: "fixed", message: "..." }` | `[FIXED]` - green background |
| `{ status: "fix_failed", message: "..." }` | `[FIX FAILED]` - red background |
| A string | `[FIXED]` with that string as message |
| `void` / `undefined` | `[FIXED]` |
| Throws | `[FIX ERROR]` - magenta background |

Fix functions do not affect the check's status or the run's exit code. The exit code always reflects the check results only.

In JSON mode (`json: true`), each check entry gains two additional fields:

```json
{
  "name": "api-key-set",
  "status": "fail",
  "fix_status": "fixed",
  "fix_message": "Opened .env for editing - paste your key and save",
  ...
}
```

`fix_status` and `fix_message` are `null` if no fix was attempted for that check.

The `has_fix` field on `CheckInfo` (returned by `listChecks()`) indicates whether a fix function is registered.

---

## Built-in check library

`doctorkit/checks` is an optional, zero-dependency library of ready-made check factories built entirely on Node.js built-in modules. Import only what you need - nothing is auto-imported when you `import { Doctor } from "doctorkit"`.

### network

```typescript
import { httpCheck, tcpCheck, dnsCheck } from "doctorkit/checks/network";
// or import everything: import { httpCheck, tcpCheck, dnsCheck } from "doctorkit/checks";

// HTTP HEAD request - verifies URL responds with expected status
doctor.check("api-health", { tag: "network" }, httpCheck("https://api.example.com/health"));
doctor.check("api-v2",     { tag: "network" }, httpCheck("https://api.example.com/v2", { expectedStatus: 401 }));

// TCP connection - verifies a port is open and accepting connections
doctor.check("postgres", { tag: "deps" }, tcpCheck("localhost", 5432));
doctor.check("redis",    { tag: "deps" }, tcpCheck("localhost", 6379, { timeout: 3 }));

// DNS resolution
doctor.check("dns-api", { tag: "network" }, dnsCheck("api.example.com"));
```

### env

```typescript
import { envCheck, envfileCheck, envfileVarsCheck } from "doctorkit/checks/env";

// Verify an env var is set, optionally matching a regex
doctor.check("api-key",        { tag: "env" }, envCheck("ANTHROPIC_API_KEY"));
doctor.check("api-key-format", { tag: "env" }, envCheck("ANTHROPIC_API_KEY", { pattern: /^sk-ant-.+/ }));

// Verify a .env file exists and is readable
doctor.check("dotenv", { tag: "env" }, envfileCheck(".env"));

// Verify all variables defined in .env.example are present in .env or process.env
doctor.check("env-vars", { tag: "env" }, envfileVarsCheck(".env.example", { envFile: ".env" }));
```

### filesystem

```typescript
import { dirExistsCheck, fileExistsCheck, writableCheck } from "doctorkit/checks/filesystem";

doctor.check("logs-dir",  { tag: "filesystem" }, dirExistsCheck("logs"));
doctor.check("config",    { tag: "filesystem" }, fileExistsCheck("config.yaml"));
doctor.check("tmp-write", { tag: "filesystem" }, writableCheck("/tmp"));
```

### process

```typescript
import { commandCheck } from "doctorkit/checks/process";

// Verify a command exists on PATH, optionally enforce a minimum version
doctor.check("node",   { tag: "tools" }, commandCheck("node",   { minVersion: "18.0" }));
doctor.check("docker", { tag: "tools" }, commandCheck("docker"));
doctor.check("git",    { tag: "tools" }, commandCheck("git",   { minVersion: "2.0" }));
```

`commandCheck` uses `which` / `where` to locate the command and `child_process.execFileSync` to read its version output. No external dependencies required.

---

## CLI: doctorkit init

`doctorkit init` scans a project directory, detects what it contains, and generates a ready-to-run `doctor.ts` with starter checks already wired up.

```bash
npm install doctorkit

# Scan current directory and write doctor.ts
npx doctorkit init

# Scan a specific directory
npx doctorkit init path/to/project
```

What it detects and generates:

| File found | Checks generated |
|---|---|
| `package.json` | `node` and `npm` command checks |
| `docker-compose.yml` / `Dockerfile` | `docker` command check |
| `.env.example` / `.env` | `envfileCheck` and per-variable `envCheck` for recognized variable names (e.g. `DATABASE_URL`, `API_KEY`, `REDIS_URL`) |

The generated `doctor.ts` is a starting point - open it and add the checks your project actually needs.

```bash
npx tsx doctor.ts           # run all checks
npx tsx doctor.ts --json    # JSON output for CI
```

---

## API reference

### `new Doctor()`

Creates a new, empty doctor instance. Each CLI command or test suite typically creates its own.

---

### `doctor.check(name, fn)`
### `doctor.check(name, options, fn)`

Registers a check function. See [Check options](#check-options) for all available options.

```typescript
// Minimal
doctor.check("my-check", () => { /* ... */ });

// With all options
doctor.check("my-check", {
  tag: "network",
  depends_on: ["other-check"],
  warn_only: false,
  timeout: 5,
  retries: 0,
  retry_delay: 1,
  slow_threshold_ms: 500,
}, async () => {
  return { status: "ok", message: "all good" };
});
```

---

### `doctor.add(name, fn, options?)`

Programmatic alternative - identical to `check` but takes the function as the second argument. Useful in loops.

```typescript
for (const port of [5432, 6379]) {
  doctor.add(`port-${port}`, () => checkPort(port), { tag: "database" });
}
```

---

### `doctor.listChecks() -> CheckInfo[]`

Returns metadata for all registered checks without running them.

---

### `await doctor.run(options?) -> number`

Executes all checks and returns an exit code. Full options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `only` | `string[]` | - | Run only checks whose `tag` is in this list |
| `skip` | `string[]` | - | Skip checks whose `name` is in this list |
| `quiet` | `boolean` | `false` | Print only the summary line |
| `verbose` | `boolean` | `false` | Show full detail on every check; errors include stack trace |
| `json` | `boolean` | `false` | Emit a JSON object instead of human output |
| `junit_xml` | `boolean` | `false` | Emit JUnit XML instead of human output |
| `fail_fast` | `boolean` | `false` | Stop after the first `fail` or `error` |
| `max_failures` | `number` | - | Stop after this many cumulative failures/errors |
| `slow_threshold_ms` | `number` | - | Flag passing checks that exceed this duration in ms |
| `global_timeout` | `number` | - | Stop scheduling new checks after this many seconds |
| `max_concurrency` | `number` | `1` | Maximum checks to run in parallel (wave-based) |
| `fix` | `boolean` | `false` | Run fix callbacks for failed checks after the main loop. See [Fix callbacks](#fix-callbacks). |
| `output` | `OutputStream` | `process.stdout` | Where to write output |
| `json_file` | `string` | - | Write JSON results to this file path, independently of stdout format |
| `junit_file` | `string` | - | Write JUnit XML to this file path, independently of stdout format |

---

### `await doctor.runDetailed(options?) -> RunResult`

Same as `run()` but returns a `RunResult` object instead of a bare exit code. Accepts the same options.

```typescript
import type { RunResult } from "doctorkit";

const result: RunResult = await doctor.runDetailed({ verbose: true });
process.exit(result.exit_code);
```

---

### `RunResult`

```typescript
interface RunResult {
  exit_code: number;
  summary: RunSummary;
  checks: CheckRecord[];
  total_ms: number;
}
```

---

### `RunSummary`

```typescript
interface RunSummary {
  ok: number;
  warn: number;
  fail: number;
  skipped: number;
  slow: number;
}
```

---

### `CheckRecord`

```typescript
interface CheckRecord {
  name: string;
  status: "ok" | "warn" | "fail" | "error" | "skipped";
  message: string;
  hint: string | undefined;
  tag: string;
  duration_ms: number;
  is_slow: boolean;
  skip_reason: string | undefined;
  fix_status: string | null;
  fix_message: string | null;
}
```

---

### `CheckResult`

```typescript
interface CheckResult {
  status: "ok" | "warn" | "fail";
  message: string;
  hint?: string;  // displayed on the next line for fail/warn
}
```

---

### `FixResult`

```typescript
import type { FixResult } from "doctorkit";

interface FixResult {
  status: "fixed" | "fix_failed";
  message: string;
}
```

Returned by fix functions. A thrown exception is automatically caught and recorded as `fix_error`.

---

### `CheckInfo`

Returned by `listChecks()`. Read-only object with all check metadata fields, including `has_fix: boolean` which is `true` when a fix function is registered for that check.

---

## Also available in Python

The Python implementation is spec-identical: same output format, same JSON structure, same exit codes, same API surface.

-> **[doctorkit-py - Python package](https://github.com/r-seize/doctorkit-py)**

```bash
pip install doctorkit
```


---

## License

BSD 2-Clause License