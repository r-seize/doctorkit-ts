import * as fs from "node:fs";
import process from "node:process";
import type { CheckFn, CheckResult } from "../types.js";

export function envCheck(
  name: string,
  options: { pattern?: RegExp; hint?: string } = {},
): CheckFn {
  return (): CheckResult => {
    const value = process.env[name];
    if (value === undefined) {
      return {
        status: "fail",
        message: `${name} is not set`,
        hint: options.hint ?? `Run: export ${name}=<value>`,
      };
    }
    if (options.pattern && !options.pattern.test(value)) {
      return {
        status: "fail",
        message: `${name} does not match expected format`,
        hint: options.hint ?? `Expected pattern: ${options.pattern}`,
      };
    }
    return { status: "ok", message: `${name} is set` };
  };
}

export function envfileVarsCheck(
  examplePath: string = ".env.example",
  options: { envFile?: string } = {},
): CheckFn {
  const envFile = options.envFile ?? ".env";

  return (): CheckResult => {
    let exampleText: string;
    try {
      exampleText = fs.readFileSync(examplePath, "utf-8");
    } catch {
      return {
        status: "fail",
        message: `${examplePath} not found`,
        hint: `Create ${examplePath} listing the required variable names`,
      };
    }

    const required: string[] = [];
    for (const line of exampleText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const name = trimmed.split("=")[0].trim();
      if (name) required.push(name);
    }

    if (required.length === 0) {
      return { status: "ok", message: `${examplePath} has no variables` };
    }

    const defined = new Set<string>();
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const name = trimmed.split("=")[0].trim();
        if (name) defined.add(name);
      }
    }

    const missing = required.filter(
      (n) => !defined.has(n) && process.env[n] === undefined,
    );

    if (missing.length > 0) {
      return {
        status: "fail",
        message: `${missing.length} variable(s) missing: ${missing.join(", ")}`,
        hint: `Add the missing variables to ${envFile}`,
      };
    }
    return {
      status: "ok",
      message: `all ${required.length} variable(s) from ${examplePath} are set`,
    };
  };
}

export function envfileCheck(path: string = ".env"): CheckFn {
  return (): CheckResult => {
    try {
      fs.accessSync(path, fs.constants.R_OK);
      return { status: "ok", message: `${path} found and readable` };
    } catch {
      if (!fs.existsSync(path)) {
        return {
          status: "fail",
          message: `${path} not found`,
          hint: `Copy .env.example to ${path} and fill in the values`,
        };
      }
      return {
        status: "fail",
        message: `${path} is not readable`,
        hint: `Run: chmod 600 ${path}`,
      };
    }
  };
}
