import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

// Tests run inside the real Workers runtime (workerd via Miniflare), with the
// Durable Object, its SQLite storage, and the Workflow binding from
// wrangler.jsonc. No test calls Workers AI: the Workflow's LLM step is mocked.
export default defineConfig({
  plugins: [
    agents(), // decorator support for @callable(), same as vite.config.ts
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false
    })
  ],
  test: {
    include: ["test/**/*.test.ts"]
  }
});
