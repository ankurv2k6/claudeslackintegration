import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'hooks/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts',
        // http-server.ts contains bootstrap/lifecycle code (createServer, stopServer)
        // that requires actual socket binding - tested via integration tests
        'src/http-server.ts',
        // Hook entry points require real stdin - tested via integration
        'hooks/session-start.ts',
        'hooks/stop.ts',
        'hooks/session-end.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
