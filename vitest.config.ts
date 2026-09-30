import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Temporal's native worker is happier in child processes than in worker threads.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
