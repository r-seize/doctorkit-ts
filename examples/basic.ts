/**
 * Example usage of doctorkit.
 *
 * Demonstrates:
 * - Built-in check factories (env, filesystem, process, network)
 * - Fix callbacks
 * - warn_only checks
 * - depends_on dependency chains
 *
 * Run:
 *   npx tsx examples/basic.ts
 *   npx tsx examples/basic.ts --json
 *   npx tsx examples/basic.ts --verbose
 *   npx tsx examples/basic.ts --only auth
 *   npx tsx examples/basic.ts --skip dns-lookup
 *   npx tsx examples/basic.ts --quiet
 *   npx tsx examples/basic.ts --fail-fast
 *   npx tsx examples/basic.ts --fix
 *   npx tsx examples/basic.ts --list
 */

import { Doctor } from "../src/index.js";
import { envCheck } from "../src/checks/env.js";
import { dirExistsCheck, writableCheck } from "../src/checks/filesystem.js";
import { dnsCheck, httpCheck } from "../src/checks/network.js";
import { commandCheck } from "../src/checks/process.js";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const doctor = new Doctor();

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

doctor.check(
  "network-reachable",
  { tag: "network", slow_threshold_ms: 2000 },
  httpCheck("https://example.com", { timeout: 5 }),
);

doctor.check(
  "dns-lookup",
  { tag: "network", depends_on: ["network-reachable"] },
  dnsCheck("api.anthropic.com"),
);

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

doctor.check(
  "api-key-set",
  { tag: "auth", depends_on: ["network-reachable"] },
  envCheck("ANTHROPIC_API_KEY", { hint: "Run: export ANTHROPIC_API_KEY=sk-ant-..." }),
);

doctor.check(
  "api-key-format",
  { tag: "auth", depends_on: ["api-key-set"], warn_only: true },
  envCheck("ANTHROPIC_API_KEY", { pattern: /^sk-ant-.+/ }),
);

// ---------------------------------------------------------------------------
// filesystem
// ---------------------------------------------------------------------------

const configDir = path.join(os.homedir(), ".config");

doctor.check(
  "config-dir",
  {
    tag: "filesystem",
    fix: () => {
      fs.mkdirSync(configDir, { recursive: true });
      return `created ${configDir}`;
    },
  },
  dirExistsCheck(configDir),
);

doctor.check(
  "tmp-writable",
  { tag: "filesystem" },
  writableCheck(os.tmpdir()),
);

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

doctor.check(
  "node",
  { tag: "tools" },
  commandCheck("node", { minVersion: "18.0" }),
);

doctor.check(
  "git",
  { tag: "tools" },
  commandCheck("git"),
);

// ---------------------------------------------------------------------------
// entry-point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string) {
  return args.includes(name);
}
function optList(name: string): string[] | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const vals = args.slice(i + 1).filter((a) => !a.startsWith("--"));
  return vals.length > 0 ? vals : undefined;
}

if (flag("--list")) {
  for (const info of doctor.listChecks()) {
    const deps = info.depends_on.length ? ` -> depends on ${info.depends_on.join(", ")}` : "";
    const fix = info.has_fix ? " [fixable]" : "";
    console.log(`  [${info.tag}] ${info.name}${deps}${fix}`);
  }
  process.exit(0);
}

doctor
  .run({
    json: flag("--json"),
    verbose: flag("--verbose"),
    quiet: flag("--quiet"),
    fail_fast: flag("--fail-fast"),
    fix: flag("--fix"),
    only: optList("--only"),
    skip: optList("--skip"),
  })
  .then((code) => process.exit(code));
