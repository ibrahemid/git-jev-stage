import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "git-jev-stage": "src/cli/main.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["@typesafe-ai/sdk"],
    removeNodeProtocol: false,
    clean: true,
    dts: false,
    sourcemap: false,
  },
  {
    entry: { index: "src/index.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "node22",
    removeNodeProtocol: false,
    clean: false,
    dts: true,
    sourcemap: false,
  },
]);
