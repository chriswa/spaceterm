import { speechStatus, type SpeechBackend } from './voice-operator'

/**
 * What the phone hears while an over-the-air install goes through: fixed words,
 * spoken on the phone straight through Voice Operator — not Control, which
 * would choose its own words, and might be busy or off.
 *
 * iOS tells nobody when its install dialog is up or answered, but it says so
 * by what it fetches (mobile-install.ts, `DownloadStage`): the manifest to
 * draw the dialog, the app once Install is pressed. Then the app must go:
 * iOS installs the download only once the running app has ended, and this
 * one stays running in the background for its microphone. So once the words
 * are said, the phone is told to quit — an app cannot relaunch itself, so the
 * words say to open it again.
 */

export type DownloadStage = 'asking' | 'installing'

export const INSTALL_WORDS: Record<DownloadStage, string> = {
  asking: 'The Spaceterm update is waiting for you. Tap Install.',
  installing: 'Installing. Spaceterm is closing now. Open it again from your home screen in a few seconds.',
}

/** The words are cut short past this, and the app quits anyway: an install must not wait on speech. */
export const SPEECH_LIMIT_MS = 20_000

/** A phone the download was offered to. */
export interface InstallingPhone {
  label: string
  /** Where its speech plays: Voice Operator on the phone, or nobody when its speaker is down. */
  speech: SpeechBackend
  /** Tell the app to end itself (`mobile-app-quit`); false when its page cannot. */
  quit(): boolean
}

export interface InstallAnnouncerDeps {
  log(message: string): void
  now?(): number
}

/** Say what a stage needs, on each phone; once Install is pressed, then have the app quit. */
export async function announceInstallStage(stage: DownloadStage, phones: InstallingPhone[], deps: InstallAnnouncerDeps): Promise<void> {
  await Promise.all(phones.map(async (phone) => {
    const heard = await speakAndWait(phone.speech, INSTALL_WORDS[stage], deps.now ?? Date.now)
    deps.log(`[mobile-install] ${phone.label}: "${stage}" words ${heard}`)
    if (stage !== 'installing') return
    deps.log(phone.quit()
      ? `[mobile-install] ${phone.label}: told the app to quit, so iOS installs the download`
      : `[mobile-install] ${phone.label}: its page cannot quit the app; the user has to close it`)
  }))
}

/** Speak `text` and wait for it to end, or `SPEECH_LIMIT_MS`; says how it went, for the log. */
export async function speakAndWait(speech: SpeechBackend, text: string, now: () => number): Promise<string> {
  const deadline = now() + SPEECH_LIMIT_MS
  const job = speechStatus(await speech.speak(text))
  if (!job) return 'not spoken: no speaker'
  let cursor = job.version
  while (now() < deadline) {
    const wait = Math.max(1, Math.min(25, Math.ceil((deadline - now()) / 1000)))
    const status = speechStatus(await speech.status(job.id, { wait, ...(cursor === undefined ? {} : { since: cursor }) }, undefined, (wait + 5) * 1000))
    if (!status) return 'lost track of'
    if (status.state !== 'in_progress') return status.state
    // A service that ignores `since` would spin here without the pause.
    if (status.version === undefined || status.version === cursor) await new Promise((r) => setTimeout(r, 500))
    cursor = status.version
  }
  return 'cut off by the time limit'
}
