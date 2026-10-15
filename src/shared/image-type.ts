/**
 * What a picture's bytes are, by their first bytes rather than a file name:
 * the formats both the Mac's and the phone's web views draw. Shared by the
 * `show_user_images` tool, which checks before it sends, and the server,
 * which checks again before it copies.
 */

export interface ImageType { ext: 'png' | 'jpg' | 'gif' | 'webp'; mime: string }

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to))
}

/** Undefined for anything but a PNG, JPEG, GIF or WebP. */
export function imageType(bytes: Uint8Array): ImageType | undefined {
  if (bytes.length >= 8 && PNG.every((byte, i) => bytes[i] === byte)) return { ext: 'png', mime: 'image/png' }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { ext: 'gif', mime: 'image/gif' }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return undefined
}
