import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

export default defineConfig({
  ...viteConfig,
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
    clearMocks: true,
    restoreMocks: true,
  },
});
