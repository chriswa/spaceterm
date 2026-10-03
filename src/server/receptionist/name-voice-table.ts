/**
 * The receptionist's roster: human names for agent surfaces, each fixed to one
 * English Kokoro (kokoro-82m) voice, so the user can say "tell Kevin…" and
 * always hear the same agent in the same voice.
 *
 * Ported from Voice Operator's NameVoiceTable.swift (deleted in voiceop
 * 548e981). The names are that app's curated, speech-to-text round-tripped
 * roster: every one has a `PHONETIC_KEY` entry in name-aliases.ts. Roughly
 * three names share each voice, so the name pool runs deep while the registry
 * can still give concurrent agents distinct voices (see name-registry.ts).
 *
 * Every name's gender matches its voice's gender; name-voice-table.test.ts
 * asserts it, so keep that test's gender lists in sync when adding names.
 *
 * Differences from the Swift table:
 * - `af_heart` is reserved for the receptionist itself (`RECEPTIONIST_VOICE`),
 *   so its names moved: Grace → af_sarah, Claire → af_sky (the two feminine
 *   voices that had only two names), Diana → af_kore.
 * - `af_nicole` stays blocked, as it was in Voice Operator, and is no longer
 *   served by the local speech service anyway.
 *
 * Voice ids were checked against the speech service's `GET /v1/voices`
 * (26 English voices, 2026-10-03).
 */

export type VoiceGender = 'masculine' | 'feminine'

/** A roster entry: a name and the Kokoro voice id it is always spoken in. */
export interface NamedVoice {
  readonly name: string
  readonly voice: string
  readonly gender: VoiceGender
}

/**
 * The receptionist's own voice. No agent is ever given it, so the receptionist
 * never sounds like one of the agents it is talking about. Its spoken name is
 * "Control", which is not in the roster either.
 */
export const RECEPTIONIST_VOICE = 'af_heart'

/** The receptionist's spoken name; rarely used. */
export const RECEPTIONIST_NAME = 'Control'

function voice(id: string, gender: VoiceGender, names: readonly string[]): NamedVoice[] {
  return names.map((name) => ({ name, voice: id, gender }))
}

/** Every name an agent surface can be given, in a fixed order. Names are unique. */
export const NAME_VOICE_TABLE: readonly NamedVoice[] = [
  // ── Feminine voices (American af_*, British bf_*) ──────────────────────
  // af_heart is RECEPTIONIST_VOICE; af_nicole is blocked.
  ...voice('af_bella', 'feminine', ['Chloe', 'Sadie', 'Heidi']),
  ...voice('bf_emma', 'feminine', ['Emma', 'Ivy', 'Jane']),
  ...voice('bf_alice', 'feminine', ['Fiona', 'Lucy', 'Maya']),
  ...voice('af_aoede', 'feminine', ['Hazel', 'Mia', 'Daphne']),
  ...voice('af_kore', 'feminine', ['Iris', 'Nora', 'Rose', 'Diana']),
  ...voice('af_jessica', 'feminine', ['Julia', 'Tessa', 'Beth']),
  ...voice('bf_lily', 'feminine', ['Lily', 'Laura', 'Wendy']),
  ...voice('af_alloy', 'feminine', ['Molly', 'Bella', 'Naomi']),
  ...voice('af_nova', 'feminine', ['Nina', 'Rita', 'Kate']),
  ...voice('bf_isabella', 'feminine', ['Olivia', 'Vivian', 'Dana']),
  ...voice('af_river', 'feminine', ['Penny', 'Ruth', 'Gemma']),
  ...voice('af_sarah', 'feminine', ['Rachel', 'Piper', 'Grace']),
  ...voice('af_sky', 'feminine', ['Stella', 'Zoe', 'Claire']),
  // ── Masculine voices (American am_*, British bm_*) ─────────────────────
  ...voice('am_adam', 'masculine', ['Oliver', 'Caleb', 'Isaac', 'Blake']),
  ...voice('am_michael', 'masculine', ['Jack', 'Evan', 'Grant', 'Kyle']),
  ...voice('bm_george', 'masculine', ['Henry', 'Luke', 'Wade', 'Harvey']),
  ...voice('am_liam', 'masculine', ['Leo', 'Leon', 'Oscar', 'George']),
  ...voice('am_echo', 'masculine', ['Max', 'Jonah', 'Roland', 'Bruno']),
  ...voice('am_onyx', 'masculine', ['Noah', 'Dean', 'Jake']),
  ...voice('am_eric', 'masculine', ['Ethan', 'Mark', 'Miles']),
  ...voice('am_puck', 'masculine', ['Lucas', 'Nathan', 'Ross']),
  ...voice('am_fenrir', 'masculine', ['Mason', 'Scott', 'Simon']),
  ...voice('bm_lewis', 'masculine', ['Logan', 'Vincent', 'Wesley']),
  ...voice('bm_daniel', 'masculine', ['Marcus', 'Wyatt', 'Nolan']),
  ...voice('bm_fable', 'masculine', ['Victor', 'Felix', 'Jasper']),
]

const BY_LOWER_NAME = new Map(NAME_VOICE_TABLE.map((e) => [e.name.toLowerCase(), e]))

/** The roster entry for a name, case-insensitively, or undefined if it isn't one. */
export function rosterEntry(name: string): NamedVoice | undefined {
  return BY_LOWER_NAME.get(name.toLowerCase())
}
