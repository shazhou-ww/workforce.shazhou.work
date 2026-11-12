import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const worker = join(root, "apps", "worker");
const directory = join(worker, ".collection-performance-baseline");
const baseline = process.argv[2] ?? "fd026f3cffb81570cd5b45c3472d7e1a1b88e101";
const revision = execFileSync(
  "git",
  ["rev-parse", "--verify", `${baseline}^{commit}`],
  { cwd: root, encoding: "utf8" },
).trim();
const environment = {
  ...process.env,
  COLLECTION_BENCHMARK_BASELINE: revision,
  COLLECTION_BENCHMARK_OUTPUT: join(
    root,
    ".collection-performance-benchmark.json",
  ),
};
mkdirSync(directory);
try {
  const files = ["collection", "collection-store", "platform"];
  for (const name of files) {
    const source = execFileSync(
      "git",
      ["show", `${revision}:apps/worker/src/${name}.ts`],
      { cwd: root, encoding: "utf8" },
    ).replaceAll(/from "\.\/([^"]+)\.js"/g, (original, module) =>
      files.includes(module) ? original : `from "../src/${module}.js"`,
    );
    writeFileSync(join(directory, `${name}.ts`), source);
  }
  const command =
    "pnpm --filter @shazhou-work/workforce-worker exec vitest run test\\collection-benchmark.test.ts --config vitest.config.ts";
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", command],
          {
            cwd: root,
            stdio: "inherit",
            env: environment,
          },
        )
      : spawnSync(
          "pnpm",
          [
            "--filter",
            "@shazhou-work/workforce-worker",
            "exec",
            "vitest",
            "run",
            "test/collection-benchmark.test.ts",
            "--config",
            "vitest.config.ts",
          ],
          {
            cwd: root,
            stdio: "inherit",
            env: environment,
          },
        );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
