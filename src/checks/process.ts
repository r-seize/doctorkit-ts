import * as cp from "node:child_process";
import type { CheckFn, CheckResult } from "../types.js";

export function commandCheck(
  cmd: string,
  options: { minVersion?: string; versionFlag?: string } = {},
): CheckFn {
  const versionFlag = options.versionFlag ?? "--version";

  return (): CheckResult => {
    const found = findCommand(cmd);
    if (!found) {
      return {
        status: "fail",
        message: `${cmd} not found on PATH`,
        hint: `Install ${cmd} and ensure it is on your PATH`,
      };
    }

    if (!options.minVersion) {
      return { status: "ok", message: `${cmd} found at ${found}` };
    }

    try {
      const raw = cp.execFileSync(cmd, [versionFlag], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }) as string;
      const firstLine = (raw + "").split("\n")[0];
      const version = extractVersion(firstLine);

      if (!version) {
        return { status: "warn", message: `${cmd} found but version unreadable: ${firstLine}` };
      }
      if (versionGte(version, options.minVersion)) {
        return { status: "ok", message: `${cmd} ${version}` };
      }
      return {
        status: "fail",
        message: `${cmd} ${version} is below minimum ${options.minVersion}`,
        hint: `Upgrade ${cmd} to ${options.minVersion} or higher`,
      };
    } catch (err) {
      return {
        status: "warn",
        message: `${cmd} found but version check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

function findCommand(cmd: string): string | null {
  try {
    const result = cp.execFileSync(
      process.platform === "win32" ? "where" : "which",
      [cmd],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ) as string;
    return result.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function extractVersion(text: string): string | null {
  const m = text.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

function versionGte(v: string, minimum: string): boolean {
  const parse = (s: string) => s.split(".").map(Number);
  const a = parse(v);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return true;
}
