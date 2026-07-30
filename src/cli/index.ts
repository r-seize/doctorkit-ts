#!/usr/bin/env node
import { cmdInit } from "./init.js";

const [, , command = "init", ...rest] = process.argv;

switch (command) {
  case "init":
    cmdInit(rest[0] ?? ".");
    break;
  case "-h":
  case "--help":
    console.log("doctorkit <command> [args]");
    console.log("");
    console.log("Commands:");
    console.log("  init [path]   Scan a project and generate a starter doctor.ts.");
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run: doctorkit --help");
    process.exit(1);
}
