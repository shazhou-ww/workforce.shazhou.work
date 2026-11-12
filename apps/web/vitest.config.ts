import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      include: [
        "src/ui.tsx",
        "src/app.tsx",
        "src/api.ts",
        "src/auth-page.tsx",
        "src/collection-control.tsx",
      ],
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    environment: "happy-dom",
    include: ["test/**/*.test.tsx"],
  },
});
