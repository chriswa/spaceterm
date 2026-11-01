import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActionButtonShortcut, dictationShortcut, phoneAppFromXcconfig, toPlistXml, type ActionButtonShortcutDeps } from './action-button-shortcut'

const XCCONFIG = `// Your Apple signing identity\nDEVELOPMENT_TEAM = 7H2524M5TN\nPRODUCT_BUNDLE_IDENTIFIER = com.example.spaceterm // the app\n`

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function harness({ xcconfig = XCCONFIG as string | undefined, problem = undefined as string | undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-button-'))
  dirs.push(dir)
  const signed: string[] = []
  const deps: ActionButtonShortcutDeps = {
    readXcconfig: () => xcconfig,
    sign: async (input, output) => {
      signed.push(fs.readFileSync(input, 'utf8'))
      if (problem) return problem
      fs.writeFileSync(output, 'signed')
      return undefined
    },
    dir,
  }
  return { shortcut: new ActionButtonShortcut(deps, () => {}), signed }
}

describe('phoneAppFromXcconfig', () => {
  it('reads the bundle id and team, ignoring comments', () => {
    expect(phoneAppFromXcconfig(XCCONFIG)).toEqual({ bundleId: 'com.example.spaceterm', teamId: '7H2524M5TN' })
    expect(phoneAppFromXcconfig('DEVELOPMENT_TEAM = X\n')).toBeUndefined()
  })
})

describe('the shortcut', () => {
  it("gets the app's last dictation, copies it, and shows it", () => {
    const shortcut = dictationShortcut({ bundleId: 'com.example.spaceterm', teamId: 'TEAM' }) as { WFWorkflowActions: Array<{ WFWorkflowActionIdentifier: string; WFWorkflowActionParameters: Record<string, unknown> }> }
    const actions = shortcut.WFWorkflowActions
    expect(actions.map((a) => a.WFWorkflowActionIdentifier)).toEqual([
      'com.example.spaceterm.GetLastDictationIntent', 'is.workflow.actions.setclipboard', 'is.workflow.actions.notification',
    ])
    expect(actions[0].WFWorkflowActionParameters.AppIntentDescriptor).toMatchObject({ BundleIdentifier: 'com.example.spaceterm', TeamIdentifier: 'TEAM' })
    // Both later steps use the first one's output.
    const uuid = actions[0].WFWorkflowActionParameters.UUID
    expect(JSON.stringify(actions[1])).toContain(String(uuid))
    expect(JSON.stringify(actions[2])).toContain(String(uuid))
  })

  it('is written as an XML property list, escaped', () => {
    const xml = toPlistXml({ a: ['x & <y>', true, 3], b: {} })
    expect(xml).toContain('<key>a</key>')
    expect(xml).toContain('<string>x &amp; &lt;y&gt;</string>')
    expect(xml).toContain('<true/>')
    expect(xml).toContain('<integer>3</integer>')
    expect(xml).toContain('<dict/>')
  })
})

describe('ActionButtonShortcut', () => {
  it('signs once, and serves it only under its secret path', async () => {
    const h = harness()
    const first = await h.shortcut.prepare()
    const second = await h.shortcut.prepare()
    expect(h.signed).toHaveLength(1)
    expect(h.signed[0]).toContain('com.example.spaceterm.GetLastDictationIntent')
    expect(first).toEqual(second)
    if (!first.ok) throw new Error(first.message)
    expect(h.shortcut.downloadFile(first.urlPath)).toMatch(/\.shortcut$/)
    expect(h.shortcut.downloadFile(first.urlPath.replace(/action-button\/[^/]+/, 'action-button/guess'))).toBeNull()
    expect(h.shortcut.downloadFile('/install/x/manifest.plist')).toBeNull()
  })

  it('says why when there is no app to call, or signing fails', async () => {
    expect(await harness({ xcconfig: '' }).shortcut.prepare()).toMatchObject({ ok: false, message: expect.stringContaining('Local.xcconfig') })
    expect(await harness({ problem: 'not signed in to iCloud' }).shortcut.prepare()).toMatchObject({ ok: false, message: expect.stringContaining('not signed in to iCloud') })
  })
})
