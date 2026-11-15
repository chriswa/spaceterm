/**
 * spotify-discover: a private Spotify playlist of strictly instrumental songs
 * that fit the user's taste, none of them already heard.
 *
 *   npm run spotify-discover -- profile    # Liked Songs → taste-profile.json (features, styles)
 *   npm run spotify-discover -- heard      # every song known heard → heard.json (best effort)
 *   npm run spotify-discover -- discover   # Last.fm + ListenBrainz suggestions, found on Spotify → candidates.json
 *   npm run spotify-discover -- analyse    # vocal checks and fit → verdicts.json (runs Demucs; calibrates first)
 *   npm run spotify-discover -- build      # the top songs into "Agent: Instrumental Discovery"
 *   npm run spotify-discover -- report     # report.md
 *   npm run spotify-discover -- all        # every step in order
 *
 * Everything lives in ~/.spaceterm/spotify-discovery/; every outside answer
 * is cached there, so a rerun is cheap. A song passes only if no check finds a
 * voice: its title, its artist's tags, ReccoBeats' features, and Demucs on its
 * 30-second Deezer preview, whose threshold is calibrated on known songs.
 */
import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { TasteStore } from '../../server/spotify/taste'
import { CachedHttp } from './http'
import {
  audioReject, calibrate, capPerArtist, featureFit, featureReject, FIT_FEATURES, fitScore, HeardSet, songKey, spread, tagReject,
  tagSimilarity, titleReject, type Features, type FitFeature, type Spread, type VocalMeasure,
} from './pure'
import { deezerByIsrc, deezerSearch, LastFm, ListenBrainz, reccoFeatures, SpotifyClient, type SpotifyTrack } from './sources'

const DIR = join(SOCKET_DIR, 'spotify-discovery')
const PREVIEWS = join(DIR, 'previews')
const PYTHON = join(process.env.HOME ?? '', '.venvs/music/bin/python')
const VOCALS_SCRIPT = join(__dirname, 'vocals.py')
export const PLAYLIST_NAME = 'Agent: Instrumental Discovery'
const PLAYLIST_SIZE = 200
const PER_ARTIST = 3

mkdirSync(PREVIEWS, { recursive: true })
const http = new CachedHttp(join(DIR, 'http-cache'))
const spotify = new SpotifyClient(http)
const lastfm = new LastFm(http)
const lb = new ListenBrainz(http)

const file = (name: string) => join(DIR, name)
function save(name: string, value: unknown): void {
  writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n')
}
function load<T>(name: string): T {
  if (!existsSync(file(name))) throw new Error(`${name} is missing: run the step that makes it first`)
  return JSON.parse(readFileSync(file(name), 'utf8')) as T
}
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts)

interface Song {
  id: string
  uri: string
  title: string
  artist: string
  artists: string[]
  isrc?: string
  durationMs: number
}

function toSong(t: SpotifyTrack): Song {
  return { id: t.id, uri: t.uri, title: t.name, artist: t.artists[0]?.name ?? '', artists: t.artists.map((a) => a.name), isrc: t.external_ids?.isrc, durationMs: t.duration_ms }
}

interface Profile {
  likes: number
  withFeatures: number
  instrumentalShare: number
  features: Record<FitFeature | 'instrumentalness' | 'speechiness', Spread>
  /** Style weights, summing to 1. */
  tags: Record<string, number>
  topArtists: { name: string; songs: number }[]
}

// ---------------------------------------------------------------- profile

/** Tags too broad or too personal to steer by. */
const IGNORED_TAGS = new Set(['seen live', 'favorites', 'favourite', 'favorite', 'electronic', 'electronica', 'dance', 'edm', 'instrumental', 'albums i own', 'under 2000 listeners'])

async function profile(): Promise<void> {
  const liked = (await spotify.likedSongs()).map(toSong)
  log(`liked songs: ${liked.length}`)
  save('likes.json', liked)
  const features = await reccoFeatures(http, liked.map((s) => s.id))
  log(`ReccoBeats knew ${features.size} of them`)
  const fs = [...features.values()]
  const feat = Object.fromEntries([...FIT_FEATURES, 'instrumentalness', 'speechiness'].map((k) => [k, spread(fs.map((f) => f[k as keyof Features]))])) as Profile['features']
  const counts = new Map<string, number>()
  for (const s of liked) counts.set(s.artist, (counts.get(s.artist) ?? 0) + 1)
  const topArtists = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, songs]) => ({ name, songs }))
  const tagTotals: Record<string, number> = {}
  for (const { name, songs } of topArtists.slice(0, 80)) {
    const tags = await lastfm.artistTags(name)
    for (const [t, w] of Object.entries(tags)) {
      if (IGNORED_TAGS.has(t) || w < 10) continue
      tagTotals[t] = (tagTotals[t] ?? 0) + songs * w / 100
    }
  }
  const top = Object.entries(tagTotals).sort((a, b) => b[1] - a[1]).slice(0, 30)
  const sum = top.reduce((n, [, w]) => n + w, 0) || 1
  const p: Profile = {
    likes: liked.length,
    withFeatures: features.size,
    instrumentalShare: fs.length ? fs.filter((f) => f.instrumentalness >= 0.8).length / fs.length : 0,
    features: feat,
    tags: Object.fromEntries(top.map(([t, w]) => [t, Math.round((w / sum) * 1000) / 1000])),
    topArtists: topArtists.slice(0, 40),
  }
  save('taste-profile.json', p)
  save('likes-features.json', Object.fromEntries(features))
  log('profile:', JSON.stringify({ ...p, topArtists: p.topArtists.slice(0, 10) }, null, 1))
}

// ---------------------------------------------------------------- heard

interface HeardEntry { id?: string; isrc?: string; artist?: string; title?: string }

async function heard(): Promise<void> {
  const entries: HeardEntry[] = load<Song[]>('likes.json').map((s) => ({ id: s.id, isrc: s.isrc, artist: s.artist, title: s.title }))
  const me = await spotify.get<{ id: string }>('/me')
  const playlists = await spotify.all<{ id: string; name: string; owner: { id: string } }>('/me/playlists?limit=50')
  for (const pl of playlists) {
    if (pl.owner.id !== me?.id || pl.name === PLAYLIST_NAME) continue
    const items = await spotify.all<{ item?: SpotifyTrack; track?: SpotifyTrack }>(`/playlists/${pl.id}/items?limit=50`)
    for (const it of items) {
      const t = it.item ?? it.track
      if (t?.id) entries.push({ id: t.id, isrc: t.external_ids?.isrc, artist: t.artists[0]?.name, title: t.name })
    }
  }
  const recent = await spotify.get<{ items: { track: SpotifyTrack }[] }>('/me/player/recently-played?limit=50')
  for (const { track: t } of recent?.items ?? []) entries.push({ id: t.id, isrc: t.external_ids?.isrc, artist: t.artists[0]?.name, title: t.name })
  for (const r of new TasteStore().all()) {
    entries.push({ id: r.track.uri.split(':').pop(), artist: r.track.artists[0], title: r.track.name })
  }
  save('heard.json', entries)
  log(`heard: ${entries.length} entries from likes, ${playlists.length} playlists, recently played and the local logs`)
}

function heardSet(): HeardSet {
  const set = new HeardSet()
  for (const e of load<HeardEntry[]>('heard.json')) set.add(e)
  return set
}

// ---------------------------------------------------------------- discover

interface Suggestion { artist: string; title: string; score: number; sources: string[] }
interface Candidate extends Song { score: number; sources: string[] }

async function discover(): Promise<void> {
  const p = load<Profile>('taste-profile.json')
  const likes = load<Song[]>('likes.json')
  const suggestions = new Map<string, Suggestion>()
  const add = (artist: string, title: string, score: number, source: string) => {
    if (!artist || !title) return
    const k = songKey(artist, title)
    const s = suggestions.get(k) ?? { artist, title, score: 0, sources: [] }
    s.score += score
    if (!s.sources.includes(source)) s.sources.push(source)
    suggestions.set(k, s)
  }

  // Artists like the liked ones, and their best-known songs.
  const similar = new Map<string, number>()
  for (const { name, songs } of p.topArtists) {
    for (const a of await lastfm.similarArtists(name, 30)) similar.set(a.name, (similar.get(a.name) ?? 0) + a.match * Math.log2(1 + songs))
  }
  for (const { name } of p.topArtists.slice(0, 20)) similar.set(name, (similar.get(name) ?? 0) + 1)
  const artists = [...similar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 180)
  log(`similar artists: ${similar.size}, taking ${artists.length}`)
  for (const [name, weight] of artists) {
    for (const t of await lastfm.artistTopTracks(name, 8)) add(t.artist, t.title, Math.min(2, weight), 'lastfm-similar-artist')
  }

  // Songs like liked songs, from across the likes.
  const step = Math.max(1, Math.floor(likes.length / 90))
  for (let i = 0; i < likes.length; i += step) {
    for (const t of await lastfm.similarTracks(likes[i].artist, likes[i].title, 25)) add(t.artist, t.title, 1 + t.match, 'lastfm-similar-track')
  }

  // The styles themselves.
  const tags = Object.keys(p.tags).slice(0, 10)
  for (const tag of tags) {
    for (const t of await lastfm.tagTopTracks(tag, 100)) add(t.artist, t.title, 0.8 * (p.tags[tag] * 10), `lastfm-tag:${tag}`)
  }
  for (const tag of tags.slice(0, 6)) {
    for (const mode of ['easy', 'medium'] as const) {
      for (const t of await lb.radio(`tag:(${tag})`, mode)) add(t.artist, t.title, 1, `lb-radio-tag:${tag}`)
    }
  }
  for (const { name } of p.topArtists.slice(0, 12)) {
    for (const t of await lb.radio(`artist:(${name})`, 'easy')) add(t.artist, t.title, 1, 'lb-radio-artist')
  }
  log(`suggestions: ${suggestions.size}`)

  // Found on Spotify, best first; heard songs and title rejects are not looked up at all.
  const heardSongs = heardSet()
  const ranked = [...suggestions.values()]
    .filter((s) => !heardSongs.has({ artist: s.artist, title: s.title }) && !titleReject(s.title))
    .sort((a, b) => b.score * b.sources.length - a.score * a.sources.length)
    .slice(0, 2800)
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let n = 0
  for (const s of ranked) {
    if (++n % 200 === 0) log(`resolving on Spotify: ${n}/${ranked.length}, found ${candidates.length}`)
    const t = await spotify.find(s.artist, s.title)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    const song = toSong(t)
    if (heardSongs.has(song)) continue
    candidates.push({ ...song, score: s.score, sources: s.sources })
  }
  save('candidates.json', candidates)
  log(`candidates on Spotify, unheard: ${candidates.length}`)
}

// ---------------------------------------------------------------- analyse

interface Verdict extends Candidate {
  features?: Features
  tagSim: number
  featFit?: number
  fit: number
  reject?: string
  vocals?: VocalMeasure
}

/** Well-known sung dance songs, for calibrating the audio check alongside any sung likes. */
const KNOWN_VOCAL = [
  ['Avicii', 'Wake Me Up'], ['Zedd', 'Clarity'], ['Calvin Harris', 'Summer'], ['Kygo', 'Firestone'], ['David Guetta', 'Titanium'],
  ['Disclosure', 'Latch'], ['ODESZA', 'Say My Name'], ['Flume', 'Never Be Like You'], ['ILLENIUM', 'Good Things Fall Apart'],
  ['Porter Robinson', 'Language'], ['Above & Beyond', 'Sun & Moon'], ['deadmau5', "Ghosts 'n' Stuff"], ['RÜFÜS DU SOL', 'Innerbloom'],
  ['Swedish House Mafia', "Don't You Worry Child"], ['Martin Garrix', 'Scared To Be Lonely'], ['Daft Punk', 'One More Time'],
  ['The Chainsmokers', 'Closer'], ['CHVRCHES', 'The Mother We Share'], ['Lane 8', 'Fingerprint'], ['Gryffin', 'Tie Me Down'],
]

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr.slice(-400) || err.message}`))
      else resolve(stdout)
    })
  })
}

/** Demucs measures, cached by Spotify ID; a song with no preview is recorded as such. */
async function measure(songs: Song[]): Promise<Map<string, VocalMeasure | null>> {
  const cachePath = file('vocals.json')
  const cache: Record<string, VocalMeasure | null> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {}
  const jobs: { id: string; wav: string }[] = []
  for (const s of songs) {
    if (s.id in cache) continue
    const wav = join(PREVIEWS, `${s.id}.wav`)
    if (!existsSync(wav)) {
      const dz = (s.isrc ? await deezerByIsrc(http, s.isrc) : undefined) ?? await deezerSearch(http, s.artist, s.title)
      if (!dz?.preview) { cache[s.id] = null; continue }
      const res = await fetch(dz.preview)
      if (!res.ok) { cache[s.id] = null; continue }
      const mp3 = join(PREVIEWS, `${s.id}.mp3`)
      writeFileSync(mp3, Buffer.from(await res.arrayBuffer()))
      try {
        await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', '-c', '2', mp3, wav], 60_000)
      } catch {
        cache[s.id] = null
        continue
      }
    }
    jobs.push({ id: s.id, wav })
  }
  for (let i = 0; i < jobs.length; i += 60) {
    const batch = jobs.slice(i, i + 60)
    const jobsFile = join(DIR, 'vocal-jobs.json')
    writeFileSync(jobsFile, JSON.stringify(batch))
    log(`Demucs: ${i + batch.length}/${jobs.length}`)
    const out = await run(PYTHON, ['-I', VOCALS_SCRIPT, jobsFile], 60 * 60_000)
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const r = JSON.parse(line) as { id: string; maxDb?: number; p90Db?: number; error?: string }
      cache[r.id] = r.error || r.p90Db === undefined ? null : { maxDb: r.maxDb ?? r.p90Db, p90Db: r.p90Db }
    }
    writeFileSync(cachePath, JSON.stringify(cache))
  }
  writeFileSync(cachePath, JSON.stringify(cache))
  return new Map(songs.map((s) => [s.id, cache[s.id] ?? null]))
}

interface Calibration {
  thresholdDb: number
  instrumental: { song: string; p90Db: number }[]
  vocal: { song: string; p90Db: number }[]
  instrumentalRight: number
  vocalRight: number
}

async function calibration(): Promise<Calibration> {
  if (existsSync(file('calibration.json'))) return load<Calibration>('calibration.json')
  const likes = load<Song[]>('likes.json')
  const lf = load<Record<string, Features>>('likes-features.json')
  const inst = likes.filter((s) => (lf[s.id]?.instrumentalness ?? 0) >= 0.9 && (lf[s.id]?.speechiness ?? 1) <= 0.06 && !titleReject(s.title))
  const instPick = inst.filter((_, i) => i % Math.max(1, Math.floor(inst.length / 24)) === 0).slice(0, 24)
  const vocalLikes = likes.filter((s) => lf[s.id] && lf[s.id].instrumentalness < 0.05).slice(0, 10)
  const vocalKnown: Song[] = []
  for (const [a, t] of KNOWN_VOCAL) {
    const found = await spotify.find(a, t)
    if (found) vocalKnown.push(toSong(found))
  }
  const vocalPick = [...vocalLikes, ...vocalKnown].slice(0, 24)
  const m = await measure([...instPick, ...vocalPick])
  const name = (s: Song) => `${s.artist} – ${s.title}`
  const instrumental = instPick.filter((s) => m.get(s.id)).map((s) => ({ song: name(s), p90Db: m.get(s.id)!.p90Db }))
  const vocal = vocalPick.filter((s) => m.get(s.id)).map((s) => ({ song: name(s), p90Db: m.get(s.id)!.p90Db }))
  const c = calibrate(instrumental.map((x) => x.p90Db), vocal.map((x) => x.p90Db))
  const result: Calibration = { thresholdDb: c.threshold, instrumental, vocal, instrumentalRight: c.instrumentalRight, vocalRight: c.vocalRight }
  save('calibration.json', result)
  log(`calibration: threshold ${c.threshold.toFixed(1)} dB; instrumental ${c.instrumentalRight}/${instrumental.length} right, sung ${c.vocalRight}/${vocal.length} right`)
  return result
}

async function analyse(): Promise<void> {
  const p = load<Profile>('taste-profile.json')
  const candidates = load<Candidate[]>('candidates.json')
  const taste = new TasteStore()
  const features = await reccoFeatures(http, candidates.map((c) => c.id))
  log(`ReccoBeats knew ${features.size} of ${candidates.length} candidates`)
  const verdicts: Verdict[] = []
  for (const c of candidates) {
    const tags = await lastfm.artistTags(c.artist)
    const f = features.get(c.id)
    const featFit = featureFit(f, p.features)
    const tagSim = tagSimilarity(tags, p.tags)
    const reject = taste.isBlocked(c.uri) ? 'blocked by the user'
      : titleReject(c.title) ?? tagReject(tags) ?? featureReject(f)
    verdicts.push({ ...c, features: f, tagSim, featFit, fit: fitScore(tagSim, featFit, c.sources.length), reject })
  }
  const cal = await calibration()
  // The audio check runs on the best-fitting songs that passed everything else, until enough pass it too.
  const passing = capPerArtist(verdicts.filter((v) => !v.reject).sort((a, b) => b.fit - a.fit), PER_ARTIST)
  let passed = 0
  for (let i = 0; i < passing.length && passed < PLAYLIST_SIZE + 30; i += 50) {
    const batch = passing.slice(i, i + 50)
    const m = await measure(batch)
    for (const v of batch) {
      v.vocals = m.get(v.id) ?? undefined
      v.reject = audioReject(v.vocals, cal.thresholdDb)
      if (!v.reject) passed++
    }
    log(`audio checked ${Math.min(i + 50, passing.length)}, passed ${passed}`)
  }
  for (const v of verdicts) if (!v.reject && !v.vocals) v.reject = 'not audio-checked (enough songs passed before it)'
  save('verdicts.json', verdicts.sort((a, b) => b.fit - a.fit))
  log(`verdicts: ${verdicts.filter((v) => !v.reject).length} pass every check`)
}

// ---------------------------------------------------------------- build

async function build(): Promise<void> {
  const verdicts = load<Verdict[]>('verdicts.json')
  const chosen = capPerArtist(verdicts.filter((v) => !v.reject), PER_ARTIST).slice(0, PLAYLIST_SIZE)
  const me = await spotify.get<{ id: string }>('/me')
  const playlists = await spotify.all<{ id: string; name: string; owner: { id: string } }>('/me/playlists?limit=50')
  let id = playlists.find((pl) => pl.name === PLAYLIST_NAME && pl.owner.id === me?.id)?.id
  const description = `Strictly instrumental songs picked for you by an agent from your Liked Songs' styles; none heard before. Built ${new Date().toISOString().slice(0, 10)}.`
  if (!id) {
    const created = await spotify.send<{ id: string }>('POST', '/me/playlists', { name: PLAYLIST_NAME, public: false, description })
    id = created?.id
    if (!id) throw new Error('Spotify did not create the playlist')
    log(`created playlist ${id}`)
  } else {
    await spotify.send('PUT', `/playlists/${id}`, { description })
  }
  const uris = chosen.map((v) => v.uri)
  // Replace the whole list with the first hundred, then add the rest.
  await spotify.send('PUT', `/playlists/${id}/items`, { uris: uris.slice(0, 100) })
  for (let i = 100; i < uris.length; i += 100) await spotify.send('POST', `/playlists/${id}/items`, { uris: uris.slice(i, i + 100) })
  save('playlist.json', { id, name: PLAYLIST_NAME, builtAt: new Date().toISOString(), songs: chosen.map((v) => ({ uri: v.uri, artist: v.artist, title: v.title, fit: v.fit })) })
  log(`playlist "${PLAYLIST_NAME}": ${uris.length} songs`)
}

// ---------------------------------------------------------------- report

function report(): void {
  const p = load<Profile>('taste-profile.json')
  const cands = load<Candidate[]>('candidates.json')
  const verdicts = load<Verdict[]>('verdicts.json')
  const cal = load<Calibration>('calibration.json')
  const pl = existsSync(file('playlist.json')) ? load<{ songs: unknown[] }>('playlist.json') : undefined
  const reasons = new Map<string, number>()
  for (const v of verdicts) {
    if (!v.reject) continue
    const r = v.reject.replace(/[\d.]+/g, '#').replace(/"[^"]*"/g, '"…"')
    reasons.set(r, (reasons.get(r) ?? 0) + 1)
  }
  const f = p.features
  const fmt = (s: Spread, d = 2) => `${s.median.toFixed(d)} (middle half ${s.q1.toFixed(d)}–${s.q3.toFixed(d)})`
  const lines = [
    `# ${PLAYLIST_NAME}: report`, '', `Built ${new Date().toISOString()}.`, '',
    '## Taste profile (from Liked Songs)', '',
    `- ${p.likes} liked songs; ReccoBeats had features for ${p.withFeatures}. ${(p.instrumentalShare * 100).toFixed(0)}% of those score as instrumental (≥ 0.8).`,
    `- Tempo ${fmt(f.tempo, 0)} BPM; energy ${fmt(f.energy)}; danceability ${fmt(f.danceability)}; valence ${fmt(f.valence)}; acousticness ${fmt(f.acousticness)}; loudness ${fmt(f.loudness, 1)} dB; instrumentalness ${fmt(f.instrumentalness)}; speechiness ${fmt(f.speechiness)}.`,
    `- Styles: ${Object.entries(p.tags).slice(0, 12).map(([t, w]) => `${t} ${(w * 100).toFixed(0)}%`).join(', ')}.`,
    `- Most-liked artists: ${p.topArtists.slice(0, 12).map((a) => `${a.name} (${a.songs})`).join(', ')}.`, '',
    '## Counts', '',
    `- Candidates found on Spotify and not heard: ${cands.length}.`,
    `- Passed every check: ${verdicts.filter((v) => !v.reject).length}; in the playlist: ${pl?.songs.length ?? 0}.`,
    '- Rejected, by reason:', ...[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([r, n]) => `  - ${n}: ${r}`), '',
    '## Vocal check calibration (Demucs on 30-second Deezer previews)', '',
    `- Threshold: vocal stem's 90th-percentile second at ${cal.thresholdDb.toFixed(1)} dB relative to the mix.`,
    `- Instrumental likes kept: ${cal.instrumentalRight}/${cal.instrumental.length}; sung songs caught: ${cal.vocalRight}/${cal.vocal.length}.`,
    ...cal.vocal.filter((v) => v.p90Db <= cal.thresholdDb).map((v) => `  - missed (sung, below threshold): ${v.song} at ${v.p90Db.toFixed(1)} dB`),
    ...cal.instrumental.filter((v) => v.p90Db > cal.thresholdDb).map((v) => `  - lost (instrumental like, above threshold): ${v.song} at ${v.p90Db.toFixed(1)} dB`), '',
    '## Known weaknesses', '',
    '- "Heard" is best effort: Spotify gives no full listening history, only Liked Songs, your own playlists, the last 50 plays and what Spaceterm has logged since today.',
    '- The audio check hears only a 30-second preview, so a voice elsewhere in a song can slip through. ReccoBeats and artist tags cover the whole song but are coarser.',
    '- Demucs lets some synth leads into its vocal stem, so a few instrumentals are lost to keep the sung ones out.', '',
    '## Next refinement', '',
    '- Likes, dislikes and listens of this playlist\'s songs (spotify-taste.jsonl, spotify-listens.jsonl) become training signal: liked songs pull the feature centroid and style weights toward them; disliked ones push away, and a disliked song that slipped the vocal check moves the threshold.',
    '- Rerun: `npm run spotify-discover -- all` (cached answers make it quick); delete calibration.json to recalibrate.',
  ]
  writeFileSync(file('report.md'), lines.join('\n') + '\n')
  log(`report: ${file('report.md')}`)
}

const STEPS: Record<string, () => Promise<void> | void> = { profile, heard, discover, analyse, build, report }

async function main(): Promise<void> {
  const step = process.argv[2] ?? 'all'
  const started = Date.now()
  const order = step === 'all' ? Object.keys(STEPS) : [step]
  for (const name of order) {
    const fn = STEPS[name]
    if (!fn) throw new Error(`no step "${name}"; steps: ${Object.keys(STEPS).join(', ')}, all`)
    log(`== ${name}`)
    await fn()
  }
  log(`done in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${http.requests} requests, ${http.hits} answered from cache`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
