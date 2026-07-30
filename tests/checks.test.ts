import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { envCheck, envfileCheck, envfileVarsCheck } from "../src/checks/env.js";
import { dirExistsCheck, fileExistsCheck, writableCheck } from "../src/checks/filesystem.js";
import { commandCheck } from "../src/checks/process.js";

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
// process checks
// ---------------------------------------------------------------------------

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
