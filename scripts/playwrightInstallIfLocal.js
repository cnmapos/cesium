// @ts-check
/**
 * Runs `playwright install --with-deps` only outside CI.
 * CI detection matches scripts/isCI.js (avoid `cmd || playwright` so failures don't trigger install).
 * Set SKIP_PLAYWRIGHT_INSTALL=1 to skip the download when installing deps.
 */
import { spawnSync } from "node:child_process";

const { env } = process;
const isCI = !!(env.CI !== "false" && env.CI);

if (isCI) {
  process.exit(0);
}

const skip =
  env.SKIP_PLAYWRIGHT_INSTALL === "1" || env.SKIP_PLAYWRIGHT_INSTALL === "true";
if (skip) {
  process.exit(0);
}

console.log(
  "[prepare] Installing Playwright browsers for local dev (set SKIP_PLAYWRIGHT_INSTALL=1 to skip)…",
);

const result = spawnSync("playwright", ["install", "--with-deps"], {
  stdio: "inherit",
  env: process.env,
  // On Windows `playwright` is a .cmd shim, which spawnSync can't execute directly.
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
