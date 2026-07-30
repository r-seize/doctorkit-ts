import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { cmdInit } from "../src/cli/init.js";

// ---------------------------------------------------------------------------
// cmdInit
// ---------------------------------------------------------------------------

describe("cmdInit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctorkit-cli-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates doctor.ts in an empty directory", () => {
    cmdInit(tmpDir);
    const target = path.join(tmpDir, "doctor.ts");
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain('import { Doctor } from "doctorkit"');
    expect(content).toContain("const doctor = new Doctor()");
  });

  it("skips generation when doctor.ts already exists", () => {
    const target = path.join(tmpDir, "doctor.ts");
    fs.writeFileSync(target, "// existing");
    cmdInit(tmpDir);
    expect(fs.readFileSync(target, "utf-8")).toBe("// existing");
  });

  it("detects node project from package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    cmdInit(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "doctor.ts"), "utf-8");
    expect(content).toContain("commandCheck");
    expect(content).toContain('"node"');
    expect(content).toContain("18.0");
  });

  it("detects dotenv from .env.example and includes known vars", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".env.example"),
      "DATABASE_URL=postgres://localhost/db\nUNKNOWN=x\n",
    );
    cmdInit(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "doctor.ts"), "utf-8");
    expect(content).toContain("envfileCheck");
    expect(content).toContain("DATABASE_URL");
    expect(content).not.toContain("UNKNOWN");
  });

  it("detects docker from docker-compose.yml", () => {
    fs.writeFileSync(path.join(tmpDir, "docker-compose.yml"), "version: '3'");
    cmdInit(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "doctor.ts"), "utf-8");
    expect(content).toContain("docker");
  });

  it("always includes filesystem and process imports", () => {
    cmdInit(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "doctor.ts"), "utf-8");
    expect(content).toContain("dirExistsCheck");
    expect(content).toContain("commandCheck");
  });

  it("output ends with doctor.run().then(process.exit)", () => {
    cmdInit(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "doctor.ts"), "utf-8");
    expect(content).toContain("doctor.run().then(process.exit)");
  });
});
