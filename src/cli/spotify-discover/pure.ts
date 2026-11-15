/**
 * The pure parts of spotify-discover: matching songs across services,
 * rejecting anything that might have vocals, and scoring fit to taste.
 * Everything here is a function of its arguments, so it is what the tests pin.
 */

export interface Features {
  tempo: number
  energy: number
  danceability: number
  valence: number
  acousticness: number
  loudness: number
  instrumentalness: number
  speechiness: number
}

export const FIT_FEATURES = ['tempo', 'energy', 'danceability', 'valence', 'acousticness', 'loudness'] as const
export type FitFeature = typeof FIT_FEATURES[number]

export interface Spread {
  median: number
  q1: number
  q3: number
}

/** Lower case, accents and punctuation gone, and the version words that do not change the recording dropped. */
export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[([](original mix|radio edit|extended mix|remaster(ed)?( \d{4})?|\d{4} remaster(ed)?|single version|album version)[)\]]/g, '')
    .replace(/ - (original mix|radio edit|extended mix|remaster(ed)?( \d{4})?|\d{4} remaster(ed)?|single version|album version)$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function normArtist(artist: string): string {
  return artist.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^the /, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** The key two services' copies of one song share: first artist and title, normalised. */
export function songKey(artist: string, title: string): string {
  return `${normArtist(artist)}|${normTitle(title)}`
}

/** Songs already heard, by every key a song may be known by. */
export class HeardSet {
  private readonly ids = new Set<string>()
  private readonly isrcs = new Set<string>()
  private readonly keys = new Set<string>()

  add(song: { id?: string; isrc?: string; artist?: string; title?: string }): void {
    if (song.id) this.ids.add(song.id)
    if (song.isrc) this.isrcs.add(song.isrc.toUpperCase())
    if (song.artist && song.title) this.keys.add(songKey(song.artist, song.title))
  }

  has(song: { id?: string; isrc?: string; artist?: string; title?: string }): boolean {
    return (!!song.id && this.ids.has(song.id)) ||
      (!!song.isrc && this.isrcs.has(song.isrc.toUpperCase())) ||
      (!!song.artist && !!song.title && this.keys.has(songKey(song.artist, song.title)))
  }

  get size(): number {
    return this.ids.size
  }
}

const TITLE_REJECTS: Array<[RegExp, string]> = [
  [/\b(feat|ft)\b\.?/i, 'features a guest (feat.)'],
  [/\bfeaturing\b/i, 'features a guest'],
  [/[([]\s*with\s/i, 'credits a guest (with …)'],
  [/\bvocals?\b/i, 'a vocal version'],
  [/\b(acapella|a cappella|sing ?along|karaoke|lyrics?)\b/i, 'a vocal version'],
]

/** Why a song's title says it has vocals, or undefined. */
export function titleReject(title: string): string | undefined {
  for (const [re, why] of TITLE_REJECTS) if (re.test(title)) return why
  return undefined
}

/** Tags that mean an artist sings or works with singers, and the weight (0–100, Last.fm's scale) at which one rejects. */
export const VOCAL_TAGS = [
  'vocal', 'vocals', 'female vocalists', 'female vocalist', 'male vocalists', 'male vocalist', 'vocal trance', 'vocal house',
  'singer-songwriter', 'singer songwriter', 'rap', 'hip-hop', 'hip hop', 'rnb', 'r&b', 'soul', 'pop', 'k-pop', 'indie pop', 'electropop',
]
export const VOCAL_TAG_WEIGHT = 20

/** Why an artist's tags say they sing, or undefined. Tags as Last.fm weights them, 0–100. */
export function tagReject(tags: Record<string, number>): string | undefined {
  for (const tag of VOCAL_TAGS) {
    const weight = tags[tag]
    if (weight !== undefined && weight >= VOCAL_TAG_WEIGHT) return `tagged "${tag}" (${weight})`
  }
  return undefined
}

export const MIN_INSTRUMENTALNESS = 0.8
export const MAX_SPEECHINESS = 0.08

/** Why ReccoBeats' features say the song has vocals, or undefined. Missing features pass here, and so must pass the audio check alone. */
export function featureReject(f: Features | undefined): string | undefined {
  if (!f) return undefined
  if (f.instrumentalness < MIN_INSTRUMENTALNESS) return `instrumentalness ${f.instrumentalness.toFixed(2)} < ${MIN_INSTRUMENTALNESS}`
  if (f.speechiness > MAX_SPEECHINESS) return `speechiness ${f.speechiness.toFixed(2)} > ${MAX_SPEECHINESS}`
  return undefined
}

/** What the audio check measured on a preview: the vocal stem's level against the whole mix, per second, in dB. */
export interface VocalMeasure {
  /** The loudest second of vocal stem, relative to the mix there. */
  maxDb: number
  /** The 90th percentile second. */
  p90Db: number
}

/**
 * Why the measured preview has vocals, or undefined. The threshold comes from
 * calibration on songs known to be instrumental and songs known to be sung.
 */
export function audioReject(m: VocalMeasure | undefined, thresholdDb: number): string | undefined {
  if (!m) return 'no preview to check'
  if (m.p90Db > thresholdDb) return `vocal stem at ${m.p90Db.toFixed(1)} dB (90th pct) > ${thresholdDb.toFixed(1)} dB`
  return undefined
}

/**
 * The threshold that best separates two calibration sets by a measure, as the
 * midpoint of the widest gap, with how many of each it gets right.
 */
export function calibrate(instrumental: number[], vocal: number[]): { threshold: number; instrumentalRight: number; vocalRight: number } {
  const all = [...instrumental, ...vocal].sort((a, b) => a - b)
  let best = { threshold: all[0] ?? 0, score: -1, instrumentalRight: 0, vocalRight: 0 }
  for (let i = 0; i < all.length - 1; i++) {
    const threshold = (all[i] + all[i + 1]) / 2
    const instrumentalRight = instrumental.filter((x) => x <= threshold).length
    const vocalRight = vocal.filter((x) => x > threshold).length
    // Strictness first: a sung song let through costs more than an instrumental one lost.
    const score = vocalRight * 2 + instrumentalRight
    if (score > best.score) best = { threshold, score, instrumentalRight, vocalRight }
  }
  return { threshold: best.threshold, instrumentalRight: best.instrumentalRight, vocalRight: best.vocalRight }
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function spread(values: number[]): Spread {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return { median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) }
}

/** 0–1: how close a song's features sit to the liked songs', each in units of the likes' interquartile range. */
export function featureFit(f: Features | undefined, profile: Record<FitFeature, Spread>): number | undefined {
  if (!f) return undefined
  let total = 0
  for (const name of FIT_FEATURES) {
    const s = profile[name]
    const iqr = Math.max(s.q3 - s.q1, name === 'tempo' ? 4 : name === 'loudness' ? 1 : 0.05)
    total += Math.min(3, Math.abs(f[name] - s.median) / iqr)
  }
  return 1 / (1 + total / FIT_FEATURES.length)
}

/** Cosine similarity of two weighted tag sets. */
export function tagSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [t, w] of Object.entries(a)) {
    na += w * w
    if (b[t]) dot += w * b[t]
  }
  for (const w of Object.values(b)) nb += w * w
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Overall fit, 0–1: tags weigh most, then features, then how many sources suggested it. Missing features count as middling. */
export function fitScore(tagSim: number, featFit: number | undefined, sources: number): number {
  return 0.5 * tagSim + 0.35 * (featFit ?? 0.4) + 0.15 * Math.min(1, Math.log2(1 + sources) / 3)
}

/** Keep at most `perArtist` songs per first artist, in the order given. */
export function capPerArtist<T extends { artist: string }>(songs: T[], perArtist: number): T[] {
  const seen = new Map<string, number>()
  return songs.filter((s) => {
    const k = normArtist(s.artist)
    const n = seen.get(k) ?? 0
    if (n >= perArtist) return false
    seen.set(k, n + 1)
    return true
  })
}
