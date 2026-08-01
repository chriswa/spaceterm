import { defineConfig } from 'vitest/config'

/**
 * Three projects, split by what a suite needs rather than by where it lives.
 *
 * The server and shared suites are pure logic or dependency-injected classes
 * and run in `node`, which is what keeps a 700-test run under four seconds.
 * Renderer suites need a DOM before their first import, not because they
 * render anything, but because zustand stores read `localStorage` at module
 * scope — so importing a component at all requires a window.
 *
 * The `e2e` project launches the real Electron app under a virtual display and
 * is deliberately NOT part of `npm test` — it needs a ~100 MB binary download
 * and `xvfb-run`, and it is seconds per test rather than milliseconds. Run it
 * with `npm run test:e2e`, which fetches the binary first.
 *
 * `.test.ts` and `.test.tsx` are both discovered. A test next to the module it
 * covers still needs no registration.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', 'src/client/renderer/**', 'src/e2e/**'],
        },
      },
      {
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/client/renderer/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
          // Stubs for the browser APIs jsdom lacks but the renderer imports —
          // AudioContext, ResizeObserver, matchMedia. Each is there because a
          // real module reaches for it at construction time.
          setupFiles: ['src/client/renderer/src/testing/jsdom-setup.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['src/e2e/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          // Launching Electron, waiting for the daemon and the server socket,
          // and driving a real window is seconds, not milliseconds.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // One app at a time. Two Electron instances racing for the same
          // scratch home would each destroy the other's daemon sessions.
          fileParallelism: false,
        },
      },
    ],
  },
})
