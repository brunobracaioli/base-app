import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/app-config/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: [
        'src/modules/*/domain/**/*.ts',
        'src/modules/*/domain/**/*.tsx',
        'src/modules/*/features/*/application/**/*.ts',
        'src/modules/*/features/*/application/**/*.tsx',
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        perFile: true,
        statements: 80,
      },
    },
  },
});
