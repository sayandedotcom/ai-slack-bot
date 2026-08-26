import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * No `@vitejs/plugin-react`: these tests never need fast refresh, and the
 * plugin's current major wants a vite the workspace does not have. esbuild's
 * automatic JSX runtime is the whole transform the suite requires.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      { find: /^@workspace\/ui\/(.*)$/, replacement: `${here}../../packages/ui/src/$1` },
      { find: /^@\/(.*)$/, replacement: `${here}$1` },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
