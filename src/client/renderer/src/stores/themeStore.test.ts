import { describe, it, expect } from 'vitest'
import { migrateThemeId } from './themeStore'
import { themes } from '../lib/theme/themes'

/**
 * `Theme.id` is persisted to `localStorage`, and `resolveTheme` answers an
 * unknown id with the default rather than throwing — which is right for a mod
 * theme whose mod has not registered yet, and is exactly what makes renaming a
 * *built-in* theme dangerous: the user is quietly moved back to the default and
 * nothing anywhere reports it.
 *
 * So the rename table is the thing under test, not the store.
 */
describe('theme id migration', () => {
  it('carries the renamed grid theme over to concentric', () => {
    expect(migrateThemeId('grid')).toBe('concentric')
  })

  it('leaves every other id alone', () => {
    // Including ids this repo has never heard of: a mod theme must survive.
    for (const id of ['default', 'nebula', 'concentric', 'some-mod:theme', '']) {
      expect(migrateThemeId(id), id).toBe(id)
    }
  })

  it('maps onto a theme that actually exists', () => {
    // The failure this is really for: renaming twice and leaving the table
    // pointing at the intermediate name, which resolves to the default again.
    const ids = new Set(themes().map((t) => t.id))
    expect(ids.has(migrateThemeId('grid'))).toBe(true)
  })
})
