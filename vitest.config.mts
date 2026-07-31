import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Everything currently under test is pure logic or a dependency-injected
    // class — no DOM. When component tests arrive they should go in a second
    // project with environment: 'jsdom' rather than making jsdom the default,
    // since the server suites far outnumber the renderer ones.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
