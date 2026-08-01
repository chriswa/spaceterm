import { defineConfig } from 'vitest/config'

/**
 * Two projects, split by what a suite needs rather than by where it lives.
 *
 * The server and shared suites are pure logic or dependency-injected classes
 * and run in `node`, which is what keeps a 700-test run under four seconds.
 * Renderer suites need a DOM before their first import, not because they
 * render anything, but because zustand stores read `localStorage` at module
 * scope — so importing a component at all requires a window.
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
          exclude: ['**/node_modules/**', 'src/client/renderer/**'],
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
    ],
  },
})
