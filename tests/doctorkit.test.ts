import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Doctor, type OutputStream } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CaptureStream extends OutputStream {
  readonly text: string;
}

function makeOut(): CaptureStream {
  const lines: string[] = [];
  return {
    isTTY: false,
    write(s: string) {
      lines.push(s);
      return true;
    },
    get text() {
      return lines.join("");
    },
  };
}

async function runJson(d: Doctor, opts: Parameters<Doctor["run"]>[0] = {}) {
  const out = makeOut();
  const code = await d.run({ json: true, output: out, ...opts });
  const data = JSON.parse(out.text);
  return { code, data };
}

async function runText(d: Doctor, opts: Parameters<Doctor["run"]>[0] = {}) {
  const out = makeOut();
  const code = await d.run({ output: out, ...opts });
  return { code, text: out.text };
}

// ---------------------------------------------------------------------------
// Basic statuses
// ---------------------------------------------------------------------------

describe("basic statuses", () => {
  it("ok check returns exit 0", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "all good" }));
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
    expect(data.checks[0].message).toBe("all good");
  });

  it("warn check returns exit 0", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "warn", message: "odd", hint: "check logs" }));
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("warn");
    expect(data.checks[0].hint).toBe("check logs");
    expect(data.summary.warn).toBe(1);
  });

  it("fail check returns exit 1", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "broken" }));
    const { code } = await runJson(d);
    expect(code).toBe(1);
  });

  it("exception returns exit 2", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => {
      throw new Error("oops");
    });
    const { code, data } = await runJson(d);
    expect(code).toBe(2);
    expect(data.checks[0].status).toBe("error");
    expect(data.checks[0].message).toContain("oops");
  });

  it("void return treated as ok", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => {});
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
  });

  it("string return treated as ok", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => "everything fine");
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].message).toBe("everything fine");
  });

  it("async check works", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: "ok" as const, message: "async ok" };
    });
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
  });

  it("warn does not appear in fail summary count", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "warn", message: "meh" }));
    const { data } = await runJson(d);
    expect(data.summary.fail).toBe(0);
    expect(data.summary.warn).toBe(1);
  });

  it("check without options arg works", async () => {
    const d = new Doctor();
    d.check("c", () => ({ status: "ok", message: "ok" }));
    const { code } = await runJson(d);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dependencies and cascade skip
// ---------------------------------------------------------------------------

describe("dependencies", () => {
  it("skips child when dep fails", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "fail", message: "dep failed" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { code, data } = await runJson(d);
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["dep"]).toBe("fail");
    expect(s["child"]).toBe("skipped");
    expect(code).toBe(1);
  });

  it("cascades skip transitively", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("b", { tag: "t", depends_on: ["a"] }, () => ({ status: "ok", message: "ok" }));
    d.check("c", { tag: "t", depends_on: ["b"] }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["a"]).toBe("fail");
    expect(s["b"]).toBe("skipped");
    expect(s["c"]).toBe("skipped");
  });

  it("does not skip on warn dependency", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "warn", message: "warn" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["child"]).toBe("ok");
  });

  it("reorders checks to respect dependency order", async () => {
    const order: string[] = [];
    const d = new Doctor();
    d.check("b", { tag: "t", depends_on: ["a"] }, () => { order.push("b"); return { status: "ok", message: "ok" }; });
    d.check("a", { tag: "t" }, () => { order.push("a"); return { status: "ok", message: "ok" }; });
    await runJson(d);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });

  it("skips child when dep errored", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => { throw new Error("crash"); });
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["dep"]).toBe("error");
    expect(s["child"]).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("timeout", () => {
  it("marks check as fail on timeout", async () => {
    const d = new Doctor();
    d.check("slow", { tag: "t", timeout: 0.1 }, () => new Promise(() => {}));
    const { code, data } = await runJson(d);
    expect(code).toBe(1);
    expect(data.checks[0].status).toBe("fail");
    expect(data.checks[0].message).toContain("timeout");
  });

  it("fast check does not time out", async () => {
    const d = new Doctor();
    d.check("fast", { tag: "t", timeout: 5 }, () => ({ status: "ok", message: "done" }));
    const { code } = await runJson(d);
    expect(code).toBe(0);
  });

  it("records duration >= timeout ms", async () => {
    const d = new Doctor();
    d.check("slow", { tag: "t", timeout: 0.1 }, () => new Promise(() => {}));
    const { data } = await runJson(d);
    expect(data.checks[0].duration_ms).toBeGreaterThanOrEqual(90);
  });
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe("retries", () => {
  it("succeeds on third attempt", async () => {
    const calls: number[] = [];
    const d = new Doctor();
    d.check("flaky", { tag: "t", retries: 2, retry_delay: 0 }, () => {
      calls.push(1);
      if (calls.length < 3) return { status: "fail" as const, message: "not yet" };
      return { status: "ok" as const, message: "finally" };
    });
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("stays fail when retries exhausted", async () => {
    const calls: number[] = [];
    const d = new Doctor();
    d.check("always-fail", { tag: "t", retries: 2, retry_delay: 0 }, () => {
      calls.push(1);
      return { status: "fail" as const, message: "nope" };
    });
    const { code, data } = await runJson(d);
    expect(code).toBe(1);
    expect(data.checks[0].status).toBe("fail");
    expect(calls).toHaveLength(3);
  });

  it("does not retry on ok", async () => {
    const calls: number[] = [];
    const d = new Doctor();
    d.check("fine", { tag: "t", retries: 2, retry_delay: 0 }, () => {
      calls.push(1);
      return { status: "ok" as const, message: "ok" };
    });
    await runJson(d);
    expect(calls).toHaveLength(1);
  });

  it("retries after exception and recovers", async () => {
    const calls: number[] = [];
    const d = new Doctor();
    d.check("crash-then-ok", { tag: "t", retries: 1, retry_delay: 0 }, () => {
      calls.push(1);
      if (calls.length === 1) throw new Error("first crash");
      return { status: "ok" as const, message: "recovered" };
    });
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filtering", () => {
  it("only filter keeps matching tags", async () => {
    const d = new Doctor();
    d.check("net", { tag: "network" }, () => ({ status: "ok", message: "ok" }));
    d.check("auth", { tag: "auth" }, () => ({ status: "fail", message: "fail" }));
    const { code, data } = await runJson(d, { only: ["network"] });
    expect(code).toBe(0);
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0].name).toBe("net");
  });

  it("skip filter removes named checks", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("b", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    const { code, data } = await runJson(d, { skip: ["b"] });
    expect(code).toBe(0);
    expect(data.checks).toHaveLength(1);
    expect(data.checks[0].name).toBe("a");
  });

  it("only with no match returns empty", async () => {
    const d = new Doctor();
    d.check("c", { tag: "network" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { only: ["auth"] });
    expect(data.checks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe("JSON output", () => {
  it("has correct shape", async () => {
    const d = new Doctor();
    d.check("net", { tag: "network" }, () => ({ status: "ok", message: "reachable" }));
    d.check("auth", { tag: "auth" }, () => ({ status: "fail", message: "missing key", hint: "set key" }));
    const { code, data } = await runJson(d);
    expect(data).toHaveProperty("checks");
    expect(data).toHaveProperty("summary");
    expect(data).toHaveProperty("exit_code");
    expect(data.exit_code).toBe(code);
    expect(data.exit_code).toBe(1);
    expect(data.summary.ok).toBe(1);
    expect(data.summary.fail).toBe(1);
    const auth = data.checks.find((c: { name: string }) => c.name === "auth");
    expect(auth.hint).toBe("set key");
    expect(auth.tag).toBe("auth");
    expect(typeof auth.duration_ms).toBe("number");
  });

  it("includes is_slow field", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    expect(data.checks[0]).toHaveProperty("is_slow");
    expect(data.checks[0].is_slow).toBe(false);
  });

  it("exit code 0", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.exit_code).toBe(0);
  });

  it("exit code 1", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "bad" }));
    const { code, data } = await runJson(d);
    expect(code).toBe(1);
    expect(data.exit_code).toBe(1);
  });

  it("exit code 2", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => { throw new Error("boom"); });
    const { code, data } = await runJson(d);
    expect(code).toBe(2);
    expect(data.exit_code).toBe(2);
  });

  it("skipped check appears in JSON", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["child"]).toBe("skipped");
    expect(data.summary.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// warn_only
// ---------------------------------------------------------------------------

describe("warn_only", () => {
  it("downgrades fail to warn", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", warn_only: true }, () => ({ status: "fail", message: "not critical" }));
    const { code, data } = await runJson(d);
    expect(data.checks[0].status).toBe("warn");
    expect(code).toBe(0);
  });

  it("keeps ok as ok", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", warn_only: true }, () => ({ status: "ok", message: "fine" }));
    const { code, data } = await runJson(d);
    expect(data.checks[0].status).toBe("ok");
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fail_fast
// ---------------------------------------------------------------------------

describe("fail_fast", () => {
  it("stops after first failure", async () => {
    const executed: string[] = [];
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => { executed.push("a"); return { status: "fail", message: "fail" }; });
    d.check("b", { tag: "t" }, () => { executed.push("b"); return { status: "ok", message: "ok" }; });
    d.check("c", { tag: "t" }, () => { executed.push("c"); return { status: "ok", message: "ok" }; });
    await runJson(d, { fail_fast: true });
    expect(executed).toContain("a");
    expect(executed).not.toContain("b");
    expect(executed).not.toContain("c");
  });

  it("marks unexecuted checks as skipped", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("b", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { fail_fast: true });
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["a"]).toBe("fail");
    expect(s["b"]).toBe("skipped");
  });

  it("skip reason mentions fail_fast", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("b", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { fail_fast: true });
    const b = data.checks.find((c: { name: string }) => c.name === "b");
    expect(b.status).toBe("skipped");
  });

  it("exit code 1 even when remaining checks are skipped", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("b", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { code } = await runJson(d, { fail_fast: true });
    expect(code).toBe(1);
  });

  it("stop on error (exit 2)", async () => {
    const executed: string[] = [];
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => { executed.push("a"); throw new Error("crash"); });
    d.check("b", { tag: "t" }, () => { executed.push("b"); return { status: "ok", message: "ok" }; });
    const { code } = await runJson(d, { fail_fast: true });
    expect(executed).not.toContain("b");
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// slow_threshold_ms
// ---------------------------------------------------------------------------

describe("slow_threshold_ms", () => {
  it("flags ok check as slow when global threshold exceeded", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok" as const, message: "ok" };
    });
    const { data } = await runJson(d, { slow_threshold_ms: 10 });
    expect(data.checks[0].is_slow).toBe(true);
    expect(data.summary.slow).toBe(1);
  });

  it("does not flag check below threshold", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { slow_threshold_ms: 10000 });
    expect(data.checks[0].is_slow).toBe(false);
    expect(data.summary.slow).toBe(0);
  });

  it("per-check threshold overrides global", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", slow_threshold_ms: 10000 }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok" as const, message: "ok" };
    });
    // global threshold would flag it, but per-check is more lenient
    const { data } = await runJson(d, { slow_threshold_ms: 1 });
    expect(data.checks[0].is_slow).toBe(false);
  });

  it("does not flag fail as slow", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "fail" as const, message: "fail" };
    });
    const { data } = await runJson(d, { slow_threshold_ms: 1 });
    expect(data.checks[0].is_slow).toBe(false);
  });

  it("slow check shown with duration in non-verbose text output", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok" as const, message: "ok" };
    });
    const { text } = await runText(d, { slow_threshold_ms: 10 });
    expect(text).toContain("slow");
    expect(text).toContain("ms");
  });
});

// ---------------------------------------------------------------------------
// listChecks
// ---------------------------------------------------------------------------

describe("listChecks", () => {
  it("returns all registered check metadata", () => {
    const d = new Doctor();
    d.check("net", { tag: "network", timeout: 3, depends_on: ["x"] }, () => {});
    d.check("auth", { tag: "auth", warn_only: true }, () => {});
    const infos = d.listChecks();
    expect(infos).toHaveLength(2);
    const net = infos.find((i) => i.name === "net")!;
    expect(net.tag).toBe("network");
    expect(net.timeout).toBe(3);
    expect(net.depends_on).toEqual(["x"]);
    const auth = infos.find((i) => i.name === "auth")!;
    expect(auth.warn_only).toBe(true);
  });

  it("returns empty array when no checks registered", () => {
    const d = new Doctor();
    expect(d.listChecks()).toHaveLength(0);
  });

  it("returned list is a copy (mutations do not affect doctor)", () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => {});
    const infos = d.listChecks();
    infos[0].depends_on.push("injected");
    expect(d.listChecks()[0].depends_on).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

describe("human output", () => {
  it("verbose shows ok message", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "great message" }));
    const { text } = await runText(d, { verbose: true });
    expect(text).toContain("great message");
  });

  it("default compresses ok (no message)", async () => {
    const d = new Doctor();
    d.check("mycheck", { tag: "t" }, () => ({ status: "ok", message: "should be hidden" }));
    const { text } = await runText(d);
    expect(text).not.toContain("should be hidden");
    expect(text).toContain("mycheck");
  });

  it("quiet hides check detail", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "broken detail", hint: "fix it" }));
    const { text } = await runText(d, { quiet: true });
    expect(text).not.toContain("broken detail");
    expect(text).not.toContain("fix it");
  });

  it("quiet shows summary", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "bad" }));
    const { text } = await runText(d, { quiet: true });
    expect(text).toContain("fail");
  });

  it("hint visible on fail", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "no key", hint: "export KEY=..." }));
    const { text } = await runText(d, { verbose: true });
    expect(text).toContain("export KEY=...");
  });

  it("hint visible on warn", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "warn", message: "low", hint: "upgrade please" }));
    const { text } = await runText(d, { verbose: true });
    expect(text).toContain("upgrade please");
  });

  it("tag header appears in output", async () => {
    const d = new Doctor();
    d.check("c", { tag: "network" }, () => ({ status: "ok", message: "ok" }));
    const { text } = await runText(d);
    expect(text).toContain("network");
  });

  it("summary counts are correct", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("b", { tag: "t" }, () => ({ status: "warn", message: "warn" }));
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    const { text } = await runText(d);
    expect(text).toContain("1 ok");
    expect(text).toContain("1 warn");
    expect(text).toContain("1 fail");
  });

  it("verbose shows error stack", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => { throw new Error("boom details"); });
    const { text } = await runText(d, { verbose: true });
    expect(text).toContain("boom details");
  });

  it("slow count appears in summary", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok" as const, message: "ok" };
    });
    const { text } = await runText(d, { slow_threshold_ms: 10 });
    expect(text).toContain("slow");
  });
});

// ---------------------------------------------------------------------------
// max_failures
// ---------------------------------------------------------------------------

describe("max_failures", () => {
  it("stops after max_failures failures", async () => {
    const executed: string[] = [];
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => { executed.push("a"); return { status: "fail", message: "fail" }; });
    d.check("b", { tag: "t" }, () => { executed.push("b"); return { status: "fail", message: "fail" }; });
    d.check("c", { tag: "t" }, () => { executed.push("c"); return { status: "ok", message: "ok" }; });
    await runJson(d, { max_failures: 2 });
    expect(executed).toContain("a");
    expect(executed).toContain("b");
    expect(executed).not.toContain("c");
  });

  it("max_failures=1 behaves like fail_fast", async () => {
    const executed: string[] = [];
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => { executed.push("a"); return { status: "fail", message: "fail" }; });
    d.check("b", { tag: "t" }, () => { executed.push("b"); return { status: "ok", message: "ok" }; });
    await runJson(d, { max_failures: 1 });
    expect(executed).toContain("a");
    expect(executed).not.toContain("b");
  });

  it("remaining checks marked as skipped", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("b", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { max_failures: 1 });
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["b"]).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// global_timeout
// ---------------------------------------------------------------------------

describe("global_timeout", () => {
  it("skips checks when global timeout exceeded", async () => {
    const d = new Doctor();
    d.check("slow", { tag: "t" }, () => new Promise((r) => setTimeout(() => r({ status: "ok" as const, message: "ok" }), 50)));
    d.check("second", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { global_timeout: 0.01 });
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["slow"]).toBe("ok");
    expect(s["second"]).toBe("skipped");
  });

  it("first check always runs", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { global_timeout: 0 });
    expect(data.checks[0].status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// parallel execution (max_concurrency)
// ---------------------------------------------------------------------------

describe("max_concurrency", () => {
  it("all checks pass in parallel", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("b", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { code, data } = await runJson(d, { max_concurrency: 3 });
    expect(code).toBe(0);
    expect(data.checks).toHaveLength(3);
    expect(data.checks.every((c: { status: string }) => c.status === "ok")).toBe(true);
  });

  it("dependency order respected in parallel mode", async () => {
    const order: string[] = [];
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => { order.push("dep"); return { status: "ok", message: "ok" }; });
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => { order.push("child"); return { status: "ok", message: "ok" }; });
    const { code } = await runJson(d, { max_concurrency: 4 });
    expect(code).toBe(0);
    expect(order.indexOf("dep")).toBeLessThan(order.indexOf("child"));
  });

  it("cascade skip works in parallel mode", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d, { max_concurrency: 4 });
    const s = Object.fromEntries(data.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(s["child"]).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// JUnit XML output
// ---------------------------------------------------------------------------

describe("junit_xml", () => {
  async function runJunit(d: Doctor, opts: Parameters<Doctor["run"]>[0] = {}) {
    const out = makeOut();
    const code = await d.run({ junit_xml: true, output: out, ...opts });
    return { code, xml: out.text };
  }

  it("produces valid XML with testsuites root", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const { xml } = await runJunit(d);
    expect(xml).toContain("<testsuites>");
    expect(xml).toContain("</testsuites>");
  });

  it("ok check produces testcase with no failure", async () => {
    const d = new Doctor();
    d.check("my-check", { tag: "network" }, () => ({ status: "ok", message: "ok" }));
    const { xml } = await runJunit(d);
    expect(xml).toContain('name="my-check"');
    expect(xml).not.toContain("<failure");
  });

  it("fail check produces failure element", async () => {
    const d = new Doctor();
    d.check("broken", { tag: "t" }, () => ({ status: "fail", message: "something wrong" }));
    const { xml } = await runJunit(d);
    expect(xml).toContain("<failure");
    expect(xml).toContain("something wrong");
  });

  it("skipped check produces skipped element", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const { xml } = await runJunit(d);
    expect(xml).toContain("<skipped");
  });

  it("exit code still correct", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "bad" }));
    const { code } = await runJunit(d);
    expect(code).toBe(1);
  });

  it("groups by tag into testsuite elements", async () => {
    const d = new Doctor();
    d.check("a", { tag: "network" }, () => ({ status: "ok", message: "ok" }));
    d.check("b", { tag: "auth" }, () => ({ status: "ok", message: "ok" }));
    const { xml } = await runJunit(d);
    expect(xml).toContain('name="network"');
    expect(xml).toContain('name="auth"');
  });

  it("xml escapes special characters in messages", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: 'bad <value> & "quoted"' }));
    const { xml } = await runJunit(d);
    expect(xml).toContain("&lt;value&gt;");
    expect(xml).toContain("&amp;");
  });
});

// ---------------------------------------------------------------------------
// Fix callbacks
// ---------------------------------------------------------------------------

describe("fix callbacks", () => {
  it("fix runs on failed check", async () => {
    const fixed: boolean[] = [];
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => { fixed.push(true); return { status: "fixed", message: "repaired" }; } }, () => ({ status: "fail", message: "broken" }));
    const { data } = await runJson(d, { fix: true });
    expect(fixed).toHaveLength(1);
    expect(data.checks[0].fix_status).toBe("fixed");
    expect(data.checks[0].fix_message).toBe("repaired");
  });

  it("fix not called on ok check", async () => {
    const called: boolean[] = [];
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => { called.push(true); } }, () => ({ status: "ok", message: "fine" }));
    await runJson(d, { fix: true });
    expect(called).toHaveLength(0);
  });

  it("fix not called when fix option is false", async () => {
    const called: boolean[] = [];
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => { called.push(true); } }, () => ({ status: "fail", message: "fail" }));
    await runJson(d, { fix: false });
    expect(called).toHaveLength(0);
  });

  it("fix_failed status propagated", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => ({ status: "fix_failed", message: "could not repair" }) }, () => ({ status: "fail", message: "broken" }));
    const { data } = await runJson(d, { fix: true });
    expect(data.checks[0].fix_status).toBe("fix_failed");
    expect(data.checks[0].fix_message).toBe("could not repair");
  });

  it("fix_error on thrown exception", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => { throw new Error("fix blew up"); } }, () => ({ status: "fail", message: "broken" }));
    const { data } = await runJson(d, { fix: true });
    expect(data.checks[0].fix_status).toBe("fix_error");
    expect(data.checks[0].fix_message).toContain("fix blew up");
  });

  it("string return treated as fixed", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => "exported the key" }, () => ({ status: "fail", message: "missing key" }));
    const { data } = await runJson(d, { fix: true });
    expect(data.checks[0].fix_status).toBe("fixed");
    expect(data.checks[0].fix_message).toBe("exported the key");
  });

  it("null fix_status when no fix fn", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "broken" }));
    const { data } = await runJson(d, { fix: true });
    expect(data.checks[0].fix_status).toBeNull();
    expect(data.checks[0].fix_message).toBeNull();
  });

  it("fix section appears in human output", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => ({ status: "fixed", message: "patched it" }) }, () => ({ status: "fail", message: "broken" }));
    const { text } = await runText(d, { fix: true });
    expect(text).toContain("[fixes]");
    expect(text).toContain("[FIXED]");
    expect(text).toContain("patched it");
  });

  it("fix section absent when no failures", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => ({ status: "fixed", message: "not needed" }) }, () => ({ status: "ok", message: "all good" }));
    const { text } = await runText(d, { fix: true });
    expect(text).not.toContain("[fixes]");
  });

  it("has_fix reflected in listChecks", () => {
    const d = new Doctor();
    d.check("with-fix", { tag: "t", fix: () => {} }, () => {});
    d.check("without-fix", { tag: "t" }, () => {});
    const infos = Object.fromEntries(d.listChecks().map((i) => [i.name, i]));
    expect(infos["with-fix"].has_fix).toBe(true);
    expect(infos["without-fix"].has_fix).toBe(false);
  });

  it("fix runs on error checks too", async () => {
    const fixed: boolean[] = [];
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => { fixed.push(true); return { status: "fixed", message: "cleaned up" }; } }, () => { throw new Error("crash"); });
    const { data } = await runJson(d, { fix: true });
    expect(fixed).toHaveLength(1);
    expect(data.checks[0].fix_status).toBe("fixed");
  });

  it("async fix function works", async () => {
    const d = new Doctor();
    d.check("c", {
      tag: "t",
      fix: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { status: "fixed", message: "async fixed" };
      },
    }, () => ({ status: "fail", message: "broken" }));
    const { data } = await runJson(d, { fix: true });
    expect(data.checks[0].fix_status).toBe("fixed");
    expect(data.checks[0].fix_message).toBe("async fixed");
  });
});

// ---------------------------------------------------------------------------
// add() programmatic API
// ---------------------------------------------------------------------------

describe("add()", () => {
  it("registers a check identically to check()", async () => {
    const d = new Doctor();
    d.add("c", () => ({ status: "ok", message: "via add" }), { tag: "t" });
    const { code, data } = await runJson(d);
    expect(code).toBe(0);
    expect(data.checks[0].status).toBe("ok");
    expect(data.checks[0].message).toBe("via add");
  });

  it("works without options (defaults to tag general)", async () => {
    const d = new Doctor();
    d.add("c", () => ({ status: "ok", message: "ok" }));
    const { data } = await runJson(d);
    expect(data.checks[0].tag).toBe("general");
  });

  it("supports fix_fn via options.fix", async () => {
    const fixed: boolean[] = [];
    const d = new Doctor();
    d.add("c", () => ({ status: "fail", message: "broken" }), {
      tag: "t",
      fix: () => { fixed.push(true); return { status: "fixed", message: "repaired" }; },
    });
    const { data } = await runJson(d, { fix: true });
    expect(fixed).toHaveLength(1);
    expect(data.checks[0].fix_status).toBe("fixed");
  });

  it("add appears in listChecks", () => {
    const d = new Doctor();
    d.add("my-check", () => {}, { tag: "t" });
    const infos = d.listChecks();
    expect(infos[0].name).toBe("my-check");
    expect(infos[0].tag).toBe("t");
  });
});

// ---------------------------------------------------------------------------
// runDetailed()
// ---------------------------------------------------------------------------

describe("runDetailed()", () => {
  it("returns exit_code, summary, checks, total_ms", async () => {
    const d = new Doctor();
    d.check("a", { tag: "t" }, () => ({ status: "ok", message: "good" }));
    d.check("b", { tag: "t" }, () => ({ status: "fail", message: "bad" }));
    const result = await d.runDetailed({ output: { write: () => true } });
    expect(result.exit_code).toBe(1);
    expect(result.summary.ok).toBe(1);
    expect(result.summary.fail).toBe(1);
    expect(result.checks).toHaveLength(2);
    expect(typeof result.total_ms).toBe("number");
  });

  it("checks contain all fields", async () => {
    const d = new Doctor();
    d.check("c", { tag: "mygroup" }, () => ({ status: "ok", message: "fine" }));
    const result = await d.runDetailed({ output: { write: () => true } });
    const rec = result.checks[0];
    expect(rec.name).toBe("c");
    expect(rec.tag).toBe("mygroup");
    expect(rec.status).toBe("ok");
    expect(rec.message).toBe("fine");
    expect(rec.is_slow).toBe(false);
    expect(rec.fix_status).toBeNull();
    expect(rec.fix_message).toBeNull();
  });

  it("skip_reason populated for cascade-skipped checks", async () => {
    const d = new Doctor();
    d.check("dep", { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    d.check("child", { tag: "t", depends_on: ["dep"] }, () => ({ status: "ok", message: "ok" }));
    const result = await d.runDetailed({ output: { write: () => true } });
    const child = result.checks.find((c) => c.name === "child")!;
    expect(child.status).toBe("skipped");
    expect(child.skip_reason).toContain("dep");
  });

  it("fix_status populated when fix=true", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => ({ status: "fixed", message: "done" }) },
      () => ({ status: "fail", message: "broken" }));
    const result = await d.runDetailed({ fix: true, output: { write: () => true } });
    expect(result.checks[0].fix_status).toBe("fixed");
    expect(result.checks[0].fix_message).toBe("done");
  });

  it("summary counts match actual results", async () => {
    const d = new Doctor();
    d.check("ok1", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("ok2", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    d.check("w",   { tag: "t" }, () => ({ status: "warn", message: "warn" }));
    d.check("f",   { tag: "t" }, () => ({ status: "fail", message: "fail" }));
    const result = await d.runDetailed({ output: { write: () => true } });
    expect(result.summary.ok).toBe(2);
    expect(result.summary.warn).toBe(1);
    expect(result.summary.fail).toBe(1);
    expect(result.summary.skipped).toBe(0);
    expect(result.exit_code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// file output (json_file, junit_file)
// ---------------------------------------------------------------------------

describe("file output", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-file-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("json_file writes valid JSON and stdout shows human output", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const filePath = path.join(tmpDir, "results.json");
    const out = { write: () => true };
    await d.run({ json_file: filePath, output: out });
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(json.checks[0].name).toBe("c");
    expect(json.exit_code).toBe(0);
  });

  it("json_file works alongside json=true (both get JSON)", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "fail", message: "bad" }));
    const filePath = path.join(tmpDir, "results.json");
    const out = { write: () => true };
    await d.run({ json: true, json_file: filePath, output: out });
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(json.exit_code).toBe(1);
  });

  it("junit_file writes valid XML", async () => {
    const d = new Doctor();
    d.check("c", { tag: "suite" }, () => ({ status: "fail", message: "broken" }));
    const filePath = path.join(tmpDir, "results.xml");
    const out = { write: () => true };
    await d.run({ junit_file: filePath, output: out });
    const xml = fs.readFileSync(filePath, "utf-8");
    expect(xml).toContain("<testsuites>");
    expect(xml).toContain('name="suite"');
    expect(xml).toContain("<failure");
  });

  it("json_file and junit_file can both be written in one run", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t" }, () => ({ status: "ok", message: "ok" }));
    const jsonPath = path.join(tmpDir, "r.json");
    const xmlPath = path.join(tmpDir, "r.xml");
    await d.run({ json_file: jsonPath, junit_file: xmlPath, output: { write: () => true } });
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(xmlPath)).toBe(true);
  });

  it("file output includes fix fields", async () => {
    const d = new Doctor();
    d.check("c", { tag: "t", fix: () => "repaired" },
      () => ({ status: "fail", message: "broken" }));
    const filePath = path.join(tmpDir, "results.json");
    await d.run({ fix: true, json_file: filePath, output: { write: () => true } });
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(json.checks[0].fix_status).toBe("fixed");
    expect(json.checks[0].fix_message).toBe("repaired");
  });
});
