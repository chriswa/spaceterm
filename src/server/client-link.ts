/**
 * Somewhere to write one client's protocol lines: the Unix socket for Electron,
 * a WebSocket for the mobile web app (see web-gateway.ts). Everything past the
 * transport treats the two identically.
 */
export interface ClientLink {
  write(text: string): void
}
