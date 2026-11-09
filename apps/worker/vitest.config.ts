import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare.ts", import.meta.url),
      ),
      "cloudflare:workflows": fileURLToPath(
        new URL("./test/cloudflare.ts", import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
