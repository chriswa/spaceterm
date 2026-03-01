import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve('src/client/main/index.ts') },
      rollupOptions: {
        // Dynamic import() of ESM-only native modules must be explicitly externalized
        // so rollup doesn't bundle them as code-split chunks (which breaks native addon
        // resolution via import.meta.url / createRequire).
        external: ['@echogarden/macos-native-tts']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('src/client/preload/index.ts') } }
  },
  renderer: {
    root: 'src/client/renderer',
    build: {
      rollupOptions: {
        input: resolve('src/client/renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/client/renderer/src')
      }
    },
    plugins: [react()]
  }
})
