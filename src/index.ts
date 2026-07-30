/**
 * doctorkit - health-check engine for CLI tools.
 *
 * @example
 * import { Doctor } from "doctorkit";
 *
 * const doctor = new Doctor();
 *
 * doctor.check("network-reachable", { tag: "network", timeout: 5 }, async () => {
 *   // ...
 *   return { status: "ok", message: "internet reachable" };
 * });
 *
 * const exitCode = await doctor.run({ verbose: true });
 * process.exit(exitCode);
 */

export type {
  CheckStatus,
  CheckResult,
  FixStatus,
  FixResult,
  FixFn,
  CheckOptions,
  CheckInfo,
  OutputStream,
  RunOptions,
  RunSummary,
  CheckRecord,
  RunResult,
  JsonOutput,
} from "./types.js";

export { Doctor } from "./doctor.js";
