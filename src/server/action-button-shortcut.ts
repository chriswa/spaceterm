import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * The iPhone's Action button shortcut for hands-free's "dictate …": made and
 * signed here, on the Mac, and added on the phone with one tap — the toolbar
 * sheet's button (ActionButtonSetupButton; src/mobile/action-button-setup.ts).
 *
 * iOS lets no app set the clipboard from the background, an App Intent run
 * by the Action button included (tried November 1 2026). A shortcut's own
 * Copy to Clipboard can. So the shortcut is two steps and a notification —
 * the app's Get Last Dictation (DictationIntents.swift), Copy to Clipboard,
 * and a notification saying what was copied — the shape of Wispr Flow's
 * "Quick Dictation to Clipboard", whose `.shortcut` this one's format is
 * copied from. Wispr hands out an iCloud link it built by hand; this one is
 * written here, the app's bundle id and team from `Local.xcconfig`, and
 * signed with `shortcuts sign --mode anyone`, without which iOS refuses to
 * import it.
 *
 * Served by the web gateway under a secret made at startup (`downloadFile`),
 * since Shortcuts fetches it without the page's token. Whether it has been
 * fetched since the phone asked (`fetchedSinceAsked`) tells the phone whether
 * Shortcuts' import link worked, or it should try Safari.
 */

export const SHORTCUT_NAME = 'Copy Last Dictation'

/** The iPhone app as Shortcuts names it. */
export interface PhoneApp {
  bundleId: string
  teamId: string
}

/** The app's identity from `Local.xcconfig` (install.sh's `xcconfig_value`). */
export function phoneAppFromXcconfig(text: string): PhoneApp | undefined {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*([^\\s/]+)`, 'm').exec(text)?.[1]
  const bundleId = value('PRODUCT_BUNDLE_IDENTIFIER')
  const teamId = value('DEVELOPMENT_TEAM')
  return bundleId && teamId ? { bundleId, teamId } : undefined
}

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist }

/** Fixed, so the same app always makes the same file, and it is signed once. */
const GET_UUID = '5E3A8C1D-7B2F-4E61-9C0A-D4F1B6A2E901'
const COPY_UUID = '5E3A8C1D-7B2F-4E61-9C0A-D4F1B6A2E902'
const NOTIFY_UUID = '5E3A8C1D-7B2F-4E61-9C0A-D4F1B6A2E903'

/** The shortcut, as the plist Shortcuts reads: Get Last Dictation → Copy to Clipboard → a notification. */
export function dictationShortcut(app: PhoneApp): Plist {
  const lastDictation = { OutputName: 'Last Dictation', OutputUUID: GET_UUID, Type: 'ActionOutput' }
  return {
    WFQuickActionSurfaces: [],
    WFWorkflowActions: [
      {
        WFWorkflowActionIdentifier: `${app.bundleId}.GetLastDictationIntent`,
        WFWorkflowActionParameters: {
          AppIntentDescriptor: { AppIntentIdentifier: 'GetLastDictationIntent', BundleIdentifier: app.bundleId, Name: 'Spaceterm', TeamIdentifier: app.teamId },
          UUID: GET_UUID,
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.setclipboard',
        WFWorkflowActionParameters: {
          UUID: COPY_UUID,
          WFInput: { Value: lastDictation, WFSerializationType: 'WFTextTokenAttachment' },
        },
      },
      {
        WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
        WFWorkflowActionParameters: {
          UUID: NOTIFY_UUID,
          WFNotificationActionTitle: 'Copied',
          WFNotificationActionSound: false,
          WFNotificationActionBody: {
            Value: { attachmentsByRange: { '{0, 1}': lastDictation }, string: '￼' },
            WFSerializationType: 'WFTextTokenString',
          },
        },
      },
    ],
    WFWorkflowClientVersion: '4046.0.2.1.102',
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: { WFWorkflowIconGlyphNumber: 61505, WFWorkflowIconStartColor: 463140863 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: ['WFStringContentItem'],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: [],
  }
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plistValue(value: Plist, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${escape(value)}</string>`
  if (typeof value === 'boolean') return `${indent}<${value}/>`
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>`
  const inner = indent + '\t'
  if (Array.isArray(value)) {
    return value.length ? `${indent}<array>\n${value.map((v) => plistValue(v, inner)).join('\n')}\n${indent}</array>` : `${indent}<array/>`
  }
  const entries = Object.entries(value).map(([k, v]) => `${inner}<key>${escape(k)}</key>\n${plistValue(v, inner)}`)
  return entries.length ? `${indent}<dict>\n${entries.join('\n')}\n${indent}</dict>` : `${indent}<dict/>`
}

/** An XML property list, which `shortcuts sign` takes as readily as a binary one. */
export function toPlistXml(value: Plist): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n${plistValue(value, '')}\n</plist>\n`
}

export interface ActionButtonShortcutDeps {
  /** `Local.xcconfig`'s text, or undefined when there is none. */
  readXcconfig(): string | undefined
  /** Sign `input` into `output` for anyone to import; resolves with what went wrong, or undefined. */
  sign(input: string, output: string): Promise<string | undefined>
  /** Where the signed shortcut is kept, one per version of it. */
  dir: string
  now(): number
}

export function realActionButtonShortcutDeps(repoRoot: string, dir: string): ActionButtonShortcutDeps {
  return {
    readXcconfig: () => {
      try { return fs.readFileSync(path.join(repoRoot, 'src', 'mobile', 'ios', 'Local.xcconfig'), 'utf8') } catch { return undefined }
    },
    sign: (input, output) => new Promise((resolve) => {
      const child = spawn('/usr/bin/shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] })
      let said = ''
      child.stdout.on('data', (d) => { said += d })
      child.stderr.on('data', (d) => { said += d })
      child.on('error', (err) => resolve(err.message))
      child.on('exit', (code) => resolve(code === 0 && fs.existsSync(output) ? undefined : said.trim() || `shortcuts sign exited ${code}`))
    }),
    dir,
    now: () => Date.now(),
  }
}

export type ShortcutOutcome = { ok: true; urlPath: string } | { ok: false; message: string }

const FILE_NAME = `${SHORTCUT_NAME.replace(/ /g, '-')}.shortcut`

export class ActionButtonShortcut {
  private readonly secret = randomBytes(16).toString('hex')
  private signed: string | undefined
  private fetchedAt = -Infinity
  private askedAt = Infinity

  constructor(private readonly deps: ActionButtonShortcutDeps, private readonly log: (message: string) => void) {}

  /** The signed shortcut, made if it is not already: its path on the web gateway. */
  async prepare(): Promise<ShortcutOutcome> {
    const xcconfig = this.deps.readXcconfig()
    const app = xcconfig === undefined ? undefined : phoneAppFromXcconfig(xcconfig)
    if (!app) return { ok: false, message: 'The iPhone app has no bundle id and team in src/mobile/ios/Local.xcconfig, so there is no app for the shortcut to call.' }
    const xml = toPlistXml(dictationShortcut(app))
    const version = createHash('sha256').update(xml).digest('hex').slice(0, 16)
    const signed = path.join(this.deps.dir, `${version}.shortcut`)
    if (!fs.existsSync(signed)) {
      fs.mkdirSync(this.deps.dir, { recursive: true })
      const unsigned = path.join(this.deps.dir, `${version}.unsigned.shortcut`)
      fs.writeFileSync(unsigned, xml)
      this.log(`[action-button] signing the shortcut for ${app.bundleId}`)
      const problem = await this.deps.sign(unsigned, signed)
      fs.rmSync(unsigned, { force: true })
      if (problem) return { ok: false, message: `The Mac could not sign the shortcut: ${problem}` }
    }
    this.signed = signed
    this.askedAt = this.deps.now()
    return { ok: true, urlPath: `/action-button/${this.secret}/${FILE_NAME}` }
  }

  /** The web gateway's file for `urlPath`, if it is the shortcut; a fetch is noted. */
  downloadFile(urlPath: string): string | null {
    const match = /^\/action-button\/([^/]+)\/([^/?]+)$/.exec(urlPath.split('?')[0])
    if (!match || match[1] !== this.secret || match[2] !== FILE_NAME || !this.signed) return null
    this.fetchedAt = this.deps.now()
    this.log('[action-button] the shortcut was fetched')
    return this.signed
  }

  /** Whether the shortcut has been fetched since it was last asked for: the import link worked. */
  fetchedSinceAsked(): boolean {
    return this.fetchedAt >= this.askedAt
  }
}
