// The renderer's view of the contextBridge. The shape itself lives in
// src/shared/api.ts so that preload (tsconfig.node.json) and the renderer
// (tsconfig.web.json) type-check against the same declaration — see the header
// comment there for why this file used to restate it and how the copies drifted.
//
// Keep this file a thin re-declaration. Anything added here rather than in
// shared/api.ts is invisible to preload and will drift again.
import type { Api } from '../../../shared/api'

declare global {
  interface Window {
    api: Api
  }
}
