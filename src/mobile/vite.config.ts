import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nativeVersion } from './ios/native-version.mjs'
import { hoverOnly } from './hover-only'

/**
 * Each build's id, compiled into the page and published beside it in
 * `build.json` with the native app's current version. A page whose id no
 * longer matches is running an older build than the server has; see
 * update-check.ts.
 */
const buildId = Date.now().toString(36)

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
  define: { __MOBILE_BUILD_ID__: JSON.stringify(buildId) },
  // A touch leaves :hover stuck on whatever it touched; see hover-only.ts.
  css: { postcss: { plugins: [hoverOnly()] } },
  plugins: [
    react(),
    {
      name: 'spaceterm-build-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build.json',
          source: JSON.stringify({ web: buildId, native: nativeVersion() })
        })
      }
    }
  ]
})
