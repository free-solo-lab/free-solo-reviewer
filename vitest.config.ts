import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Fixtures and assertions are Russian; running in Russian also checks the Russian catalog.
    env: { REVIEW_LANGUAGE: 'ru' },
    setupFiles: ['tests/setup.ts'],
  },
});
