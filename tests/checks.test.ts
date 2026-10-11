import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { envCheck, envfileCheck, envfileVarsCheck } from "../src/checks/env.js";
import { dirExistsCheck, fileExistsCheck, writableCheck, diskSpaceCheck, fileContentCheck } from "../src/checks/filesystem.js";
import { commandCheck, gitStatusCheck } from "../src/checks/process.js";
import { sslCertCheck, portAvailableCheck } from "../src/checks/network.js";
import * as net from "node:net";
import * as cp from "node:child_process";

// ---------------------------------------------------------------------------
// env checks
// ---------------------------------------------------------------------------

describe("envCheck", () => {
  const key = "__DOCTORKIT_TEST_VAR__";

  afterEach(() => {
    delete process.env[key];
  });

  it("ok when variable is set", () => {
    process.env[key] = "hello";
    const result = envCheck(key)();
    expect(result.status).toBe("ok");
    expect(result.message).toContain(key);
  });

  it("fail when variable is missing", () => {
    delete process.env[key];
    const result = envCheck(key)();
    expect(result.status).toBe("fail");
    expect(result.message).toContain(key);
  });

  it("ok when value matches pattern", () => {
    process.env[key] = "sk-ant-abc123";
    const result = envCheck(key, { pattern: /^sk-ant-.+/ })();
    expect(result.status).toBe("ok");
  });

  it("fail when value does not match pattern", () => {
    process.env[key] = "wrong";
    const result = envCheck(key, { pattern: /^sk-ant-.+/ })();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("format");
  });

  it("uses custom hint when variable is missing", () => {
    delete process.env[key];
    const result = envCheck(key, { hint: "custom hint" })();
    expect(result.hint).toBe("custom hint");
  });
});

describe("envfileCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok when file exists", () => {
    const f = path.join(tmpDir, ".env");
    fs.writeFileSync(f, "FOO=bar");
    const result = envfileCheck(f)();
    expect(result.status).toBe("ok");
  });

  it("fail when file is missing", () => {
    const result = envfileCheck(path.join(tmpDir, ".env"))();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
  });
});

describe("envfileVarsCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-envvars-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env["DATABASE_URL"];
    delete process.env["API_KEY"];
    delete process.env["MY_SECRET"];
    delete process.env["REAL_VAR"];
    delete process.env["PRESENT_VAR"];
    delete process.env["ABSENT_VAR"];
  });

  it("ok when all vars are defined in env file", () => {
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "DATABASE_URL=\nAPI_KEY=\n");
    const env = path.join(tmpDir, ".env");
    fs.writeFileSync(env, "DATABASE_URL=postgres://localhost\nAPI_KEY=secret\n");
    const result = envfileVarsCheck(example, { envFile: env })();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("2");
  });

  it("fail when a variable is missing", () => {
    delete process.env["API_KEY"];
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "API_KEY=\n");
    const env = path.join(tmpDir, ".env");
    fs.writeFileSync(env, "");
    const result = envfileVarsCheck(example, { envFile: env })();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("API_KEY");
  });

  it("ok when variable is set in process.env", () => {
    process.env["MY_SECRET"] = "value";
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "MY_SECRET=\n");
    const env = path.join(tmpDir, ".env");
    fs.writeFileSync(env, "");
    const result = envfileVarsCheck(example, { envFile: env })();
    expect(result.status).toBe("ok");
  });

  it("fail when example file does not exist", () => {
    const result = envfileVarsCheck(path.join(tmpDir, "missing.example"))();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
  });

  it("ok when example file has only comments and blank lines", () => {
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "# just a comment\n\n");
    const result = envfileVarsCheck(example)();
    expect(result.status).toBe("ok");
  });

  it("ignores comments and blank lines when parsing", () => {
    delete process.env["REAL_VAR"];
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "# comment\n\nREAL_VAR=x\n");
    const env = path.join(tmpDir, ".env");
    fs.writeFileSync(env, "REAL_VAR=value\n");
    const result = envfileVarsCheck(example, { envFile: env })();
    expect(result.status).toBe("ok");
  });

  it("fail when env file is absent and var not in process.env", () => {
    process.env["PRESENT_VAR"] = "yes";
    delete process.env["ABSENT_VAR"];
    const example = path.join(tmpDir, ".env.example");
    fs.writeFileSync(example, "PRESENT_VAR=\nABSENT_VAR=\n");
    const result = envfileVarsCheck(example, { envFile: path.join(tmpDir, "nonexistent.env") })();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ABSENT_VAR");
  });
});

// ---------------------------------------------------------------------------
// filesystem checks
// ---------------------------------------------------------------------------

describe("dirExistsCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok when directory exists", () => {
    const result = dirExistsCheck(tmpDir)();
    expect(result.status).toBe("ok");
  });

  it("fail when directory does not exist", () => {
    const result = dirExistsCheck(path.join(tmpDir, "nonexistent"))();
    expect(result.status).toBe("fail");
    expect(result.hint).toContain("mkdir");
  });

  it("fail when path is a file", () => {
    const f = path.join(tmpDir, "file.txt");
    fs.writeFileSync(f, "x");
    const result = dirExistsCheck(f)();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a directory");
  });
});

describe("fileExistsCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok when file exists", () => {
    const f = path.join(tmpDir, "file.txt");
    fs.writeFileSync(f, "x");
    const result = fileExistsCheck(f)();
    expect(result.status).toBe("ok");
  });

  it("fail when file is missing", () => {
    const result = fileExistsCheck(path.join(tmpDir, "missing.txt"))();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
  });

  it("fail when path is a directory", () => {
    const result = fileExistsCheck(tmpDir)();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not a file");
  });
});

describe("writableCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok when directory is writable", () => {
    const result = writableCheck(tmpDir)();
    expect(result.status).toBe("ok");
  });

  it("fail when path does not exist", () => {
    const result = writableCheck(path.join(tmpDir, "nonexistent"))();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("does not exist");
  });
});

// ---------------------------------------------------------------------------
// diskSpaceCheck
// ---------------------------------------------------------------------------

describe("diskSpaceCheck", () => {
  it("ok with default path and 0 min free GB (always passes)", async () => {
    const result = await diskSpaceCheck(os.tmpdir(), { minFreeGb: 0 })();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("GB free");
  });

  it("fail when minFreeGb is impossibly high", async () => {
    const result = await diskSpaceCheck(os.tmpdir(), { minFreeGb: 9_999_999 })();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("minimum");
    expect(result.hint).toContain("disk space");
  });

  it("fail on non-existent path", async () => {
    const result = await diskSpaceCheck("/nonexistent/path/xyz")();
    expect(result.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// fileContentCheck
// ---------------------------------------------------------------------------

describe("fileContentCheck", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-fc-")), "a.txt");
    fs.writeFileSync(tmpFile, "hello world\nversion: 1.2.3\n");
  });

  afterEach(() => {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("ok when the pattern matches (default shouldMatch: true)", () => {
    const result = fileContentCheck(tmpFile, /version: \d+\.\d+\.\d+/)();
    expect(result.status).toBe("ok");
  });

  it("fail when the pattern does not match", () => {
    const result = fileContentCheck(tmpFile, /nonexistent-pattern/)();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("does not contain");
  });

  it("ok when shouldMatch: false and pattern is absent", () => {
    const result = fileContentCheck(tmpFile, /forbidden/, { shouldMatch: false })();
    expect(result.status).toBe("ok");
  });

  it("fail when shouldMatch: false and pattern is present", () => {
    const result = fileContentCheck(tmpFile, /hello/, { shouldMatch: false })();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("forbidden");
  });

  it("fail when the file does not exist", () => {
    const result = fileContentCheck("/nonexistent/path/xyz", /a/)();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("Cannot read");
  });
});

// ---------------------------------------------------------------------------
// sslCertCheck
// ---------------------------------------------------------------------------

describe("sslCertCheck", () => {
  it("returns a CheckFn (function)", () => {
    const fn = sslCertCheck("example.com");
    expect(typeof fn).toBe("function");
  });

  it("fails gracefully on invalid hostname", async () => {
    const result = await sslCertCheck("__invalid_host_that_does_not_exist__.example")();
    expect(result.status).toBe("fail");
  }, 15000);
});

// ---------------------------------------------------------------------------
// portAvailableCheck
// ---------------------------------------------------------------------------

describe("portAvailableCheck", () => {
  it("ok on a free port", async () => {
    const result = await portAvailableCheck(58391)();
    expect(result.status).toBe("ok");
    expect(result.message).toContain("available");
  });

  it("fail when the port is already bound", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(58392, "0.0.0.0", resolve));
    try {
      const result = await portAvailableCheck(58392)();
      expect(result.status).toBe("fail");
      expect(result.message).toContain("already in use");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// process checks
// ---------------------------------------------------------------------------

describe("gitStatusCheck", () => {
  it("returns a CheckFn (function)", () => {
    expect(typeof gitStatusCheck()).toBe("function");
  });

  it("ok on a clean repo", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-git-"));
    try {
      cp.execFileSync("git", ["init", "-q"], { cwd: tmpDir });
      cp.execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: tmpDir });
      cp.execFileSync("git", ["config", "user.name", "test"], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello");
      cp.execFileSync("git", ["add", "."], { cwd: tmpDir });
      cp.execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmpDir });

      const result = gitStatusCheck({ cwd: tmpDir })();
      expect(result.status).toBe("ok");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fail when there are uncommitted changes", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-git-"));
    try {
      cp.execFileSync("git", ["init", "-q"], { cwd: tmpDir });
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello");

      const result = gitStatusCheck({ cwd: tmpDir })();
      expect(result.status).toBe("fail");
      expect(result.message).toContain("uncommitted change");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fail when not a git repository", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-nogit-"));
    try {
      const result = gitStatusCheck({ cwd: tmpDir })();
      expect(result.status).toBe("fail");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("commandCheck", () => {
  it("ok when command exists on PATH", () => {
    const result = commandCheck("node")();
    expect(result.status).toBe("ok");
  });

  it("fail when command is not found", () => {
    const result = commandCheck("__nonexistent_cmd_xyz__")();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found on PATH");
  });

  it("ok when min version is satisfied", () => {
    const result = commandCheck("node", { minVersion: "1.0" })();
    expect(result.status).toBe("ok");
  });

  it("fail or warn when min version is too high", () => {
    const result = commandCheck("node", { minVersion: "99999.0" })();
    expect(["fail", "warn"]).toContain(result.status);
  });
});
