import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/checks/index.ts",
    "src/checks/network.ts",
    "src/checks/env.ts",
    "src/checks/filesystem.ts",
    "src/checks/process.ts",
    "src/cli/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
