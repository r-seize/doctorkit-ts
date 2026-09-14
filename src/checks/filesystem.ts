import * as fs from "node:fs";
import * as os from "node:os";
import type { CheckFn, CheckResult } from "../types.js";

export function dirExistsCheck(path: string): CheckFn {
  return (): CheckResult => {
    try {
      const stat = fs.statSync(path);
      if (stat.isDirectory()) {
        return { status: "ok", message: `${path} exists` };
      }
      return { status: "fail", message: `${path} exists but is not a directory` };
    } catch {
      return {
        status: "fail",
        message: `${path} does not exist`,
        hint: `Run: mkdir -p ${path}`,
      };
    }
  };
}

export function fileExistsCheck(path: string): CheckFn {
  return (): CheckResult => {
    try {
      const stat = fs.statSync(path);
      if (stat.isFile()) {
        return { status: "ok", message: `${path} exists` };
      }
      return { status: "fail", message: `${path} exists but is not a file` };
    } catch {
      return { status: "fail", message: `${path} not found` };
    }
  };
}

export function writableCheck(path: string): CheckFn {
  return (): CheckResult => {
    if (!fs.existsSync(path)) {
      return {
        status: "fail",
        message: `${path} does not exist`,
        hint: `Run: mkdir -p ${path}`,
      };
    }
    try {
      fs.accessSync(path, fs.constants.W_OK);
      return { status: "ok", message: `${path} is writable` };
    } catch {
      return {
        status: "fail",
        message: `${path} is not writable`,
        hint: `Run: chmod u+w ${path}`,
      };
    }
  };
}

export function diskSpaceCheck(
  dirPath: string = os.homedir(),
  options: { minFreeGb?: number } = {},
): CheckFn {
  const minFreeGb = options.minFreeGb ?? 1;

  return (): CheckResult => {
    try {
      const stat = fs.statfsSync(dirPath);
      const freeGb = (stat.bavail * stat.bsize) / 1024 ** 3;
      if (freeGb < minFreeGb) {
        return {
          status: "fail",
          message: `${dirPath}: ${freeGb.toFixed(1)} GB free (minimum ${minFreeGb} GB required)`,
          hint: `Free up disk space on the volume containing ${dirPath}`,
        };
      }
      return { status: "ok", message: `${dirPath}: ${freeGb.toFixed(1)} GB free` };
    } catch (err) {
      return {
        status: "fail",
        message: `Cannot check disk space at ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
