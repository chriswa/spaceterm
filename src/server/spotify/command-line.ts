/**
 * The words Control's one `spotify` tool takes, as a command line:
 * `play --on phone`, `volume 40`, `--help`.
 *
 * One tool with a command line, rather than a tool per command, keeps
 * Control's own tool list short: it learns the commands by calling
 * `spotify --help`, so a new command (playlists, say) is a row in
 * spotify/index.ts's table and a line of help, never another tool in the
 * prompt.
 */

/** Split a command line into words. Single or double quotes keep spaces in one word: `play --on "Kitchen speaker"`. */
export function splitWords(line: string): string[] {
  const words: string[] = []
  let word: string | undefined
  let quote: '"' | "'" | undefined
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      word ??= ''
    } else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else {
      word = (word ?? '') + ch
    }
  }
  if (quote) throw new Error(`a ${quote} quote is not closed`)
  if (word !== undefined) words.push(word)
  return words
}

export interface ParsedLine {
  /** The words that are not options, in order: the command's name, then its arguments. */
  positional: string[]
  /** `--name value` and `--name=value`; a flag with no value, such as `--help`, maps to true. */
  options: Map<string, string | true>
}

/** Options that never take a value, so the word after one is left as a positional. */
const FLAGS = new Set(['help'])

/** `-h` is `--help`. Throws on an option it cannot read, with why. */
export function parseWords(words: readonly string[]): ParsedLine {
  const positional: string[] = []
  const options = new Map<string, string | true>()
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '-h') {
      options.set('help', true)
      continue
    }
    if (!word.startsWith('--') || word === '--') {
      positional.push(word)
      continue
    }
    const eq = word.indexOf('=')
    const name = word.slice(2, eq < 0 ? undefined : eq)
    if (!name) throw new Error(`"${word}" is not an option`)
    if (eq >= 0) options.set(name, word.slice(eq + 1))
    else if (FLAGS.has(name)) options.set(name, true)
    else {
      const value = words[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value, such as --${name} phone`)
      options.set(name, value)
      i++
    }
  }
  return { positional, options }
}
