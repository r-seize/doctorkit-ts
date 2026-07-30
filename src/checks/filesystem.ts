import * as fs from "node:fs";
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
