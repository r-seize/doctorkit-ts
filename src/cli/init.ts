import * as fs from "node:fs";
import * as path from "node:path";

const MARKERS: Array<[string, string]> = [
  ["package.json",        "node"],
  ["pyproject.toml",      "python"],
  ["setup.py",            "python"],
  ["requirements.txt",    "python"],
  ["Pipfile",             "python"],
  ["docker-compose.yml",  "docker"],
  ["docker-compose.yaml", "docker"],
  ["Dockerfile",          "docker"],
  [".env.example",        "dotenv"],
  [".env",                "dotenv"],
];

const KNOWN_ENV_VARS = new Set([
  "DATABASE_URL", "DB_URL", "POSTGRES_URL",
  "REDIS_URL",
  "SECRET_KEY", "API_KEY", "API_SECRET",
  "SMTP_HOST", "MAIL_HOST",
  "S3_BUCKET", "AWS_ACCESS_KEY_ID",
]);

export function cmdInit(directory: string = "."): void {
  const root = path.resolve(directory);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Error: ${directory} is not a directory`);
    process.exit(1);
  }

  const target = path.join(root, "doctor.ts");
  if (fs.existsSync(target)) {
    console.log(`doctor.ts already exists in ${root} - skipping`);
    return;
  }

  const { detected, envVars } = scan(root);
  const content = generate(detected, envVars);
  fs.writeFileSync(target, content, "utf-8");
  console.log(`Generated ${target}`);
  console.log("Run it with: npx tsx doctor.ts");
}

function scan(root: string): { detected: Set<string>; envVars: string[] } {
  const detected = new Set<string>();
  for (const [name, kind] of MARKERS) {
    if (fs.existsSync(path.join(root, name))) detected.add(kind);
  }

  const envVars: string[] = [];
  for (const candidate of [".env.example", ".env"]) {
    const envFile = path.join(root, candidate);
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const name = trimmed.split("=")[0].trim();
      if (KNOWN_ENV_VARS.has(name.toUpperCase())) envVars.push(name);
    }
    break;
  }

  return { detected, envVars };
}

function generate(detected: Set<string>, envVars: string[]): string {
  const lines: string[] = ['import { Doctor } from "doctorkit";'];

  const needsEnv = detected.has("dotenv") || envVars.length > 0;
  if (needsEnv) {
    lines.push('import { envCheck, envfileCheck } from "doctorkit/checks/env";');
  }
  if (detected.has("node") || detected.has("docker")) {
    lines.push('import { httpCheck, tcpCheck } from "doctorkit/checks/network";');
  }
  lines.push('import { dirExistsCheck, writableCheck } from "doctorkit/checks/filesystem";');
  lines.push('import { commandCheck } from "doctorkit/checks/process";');

  lines.push("", "const doctor = new Doctor();", "");

  if (needsEnv) {
    lines.push(`doctor.check("dotenv", { tag: "env" }, envfileCheck(".env"));`);
    for (const v of envVars) {
      lines.push(`doctor.check("${v}", { tag: "env" }, envCheck("${v}"));`);
    }
    lines.push("");
  }

  const tools: Array<[string, string, string | null]> = [];
  if (detected.has("node")) {
    tools.push(["node", "node", "18.0"], ["npm", "npm", null]);
  }
  if (detected.has("docker")) {
    tools.push(["docker", "docker", null]);
  }

  if (tools.length > 0) {
    for (const [name, cmd, minVer] of tools) {
      if (minVer) {
        lines.push(
          `doctor.check("${name}", { tag: "tools" }, commandCheck("${cmd}", { minVersion: "${minVer}" }));`,
        );
      } else {
        lines.push(`doctor.check("${name}", { tag: "tools" }, commandCheck("${cmd}"));`);
      }
    }
    lines.push("");
  }

  lines.push("doctor.run().then(process.exit);", "");
  return lines.join("\n");
}
