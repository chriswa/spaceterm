import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The mobile web app. Served by the Spaceterm server's web gateway from
 * `out/mobile` (src/server/web-gateway.ts) — `npm run mobile:build`.
 *
 * It bundles the desktop renderer's components and shared code directly; the
 * `@` alias matches electron.vite.config.ts so those imports resolve the same
 * way in both builds.
 */
export default defineConfig({
  root: resolve(__dirname),
  base: './',
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, '../../out/mobile'),
    emptyOutDir: true,
    target: 'safari16'
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '../client/renderer/src')
    }
  },
  plugins: [react()]
})
