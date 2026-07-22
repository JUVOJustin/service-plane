import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    benchmark: {
      include: ['src/**/*.bench.ts'],
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
