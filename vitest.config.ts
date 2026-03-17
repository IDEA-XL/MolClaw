import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'container/agent-runner/test/**/*.test.ts',
    ],
  },
});
