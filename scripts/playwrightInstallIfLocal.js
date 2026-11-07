// @ts-check
/**
 * Runs `playwright install --with-deps` only outside CI.
 * CI detection matches scripts/isCI.js (avoid `cmd || playwright` so failures don't trigger install).
 * Set SKIP_PLAYWRIGHT_INSTALL=1 to skip the download when installing deps.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Resolve the workspace-local bin directly instead of relying on PATH:
// outside package-manager hooks `node_modules/.bin` is not on PATH, and a bare
// `playwright` lookup can fail with a misleading EACCES (inaccessible macOS
// system PATH entries) rather than ENOENT.
const binDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".bin",
);
const isWindows = process.platform === "win32";
const playwrightBin = join(
  binDirectory,
  isWindows ? "playwright.cmd" : "playwright",
);

const result = spawnSync(
  // The shell needs an explicitly quoted command if the path contains spaces.
  isWindows ? `"${playwrightBin}"` : playwrightBin,
  ["install", "--with-deps"],
  {
    stdio: "inherit",
    env: process.env,
    // On Windows `playwright` is a .cmd shim, which spawnSync can't execute directly.
    shell: isWindows,
  },
);

if (result.error) {
  console.error(
    `[prepare] Failed to launch playwright: ${result.error.message}.
Verify that playwright is installed at ${playwrightBin}.`,
  );
}

process.exit(result.status ?? 1);
