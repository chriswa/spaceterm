import { describe, it, expect } from 'vitest'
import { cssUrl } from './css-url'

describe('cssUrl', () => {
  it('quotes an inlined SVG, whose single-quoted attributes an unquoted url() cannot hold', () => {
    const svg = "data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%3e%3c/svg%3e"
    expect(cssUrl(svg)).toBe(`url("${svg}")`)
  })

  it('escapes what would end the quoted string', () => {
    expect(cssUrl('a"b\\c')).toBe('url("a\\"b\\\\c")')
    expect(cssUrl('a\nb')).toBe('url("a%0Ab")')
  })
})

describe('the renderer builds no CSS url() by hand', () => {
  it('routes every interpolated url() through cssUrl', async () => {
    const { readdirSync, readFileSync, statSync } = await import('fs')
    const { join, relative } = await import('path')
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.endsWith('css-url.ts')) {
          readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
            if (/url\(\$\{/.test(line)) offenders.push(`${relative(root, path)}:${i + 1}`)
          })
        }
      }
    }
    walk(join(root, 'src', 'client', 'renderer', 'src'))
    walk(join(root, 'src', 'mobile'))
    expect(offenders, 'use cssUrl() — an unquoted url() breaks on inlined SVGs in WebKit').toEqual([])
  })
})
