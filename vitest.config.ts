import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)) } },
  test: { testTimeout: 20_000, hookTimeout: 20_000, server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } } },
});
