import { describe, expect, it } from 'vitest'
import {
  audioReject, calibrate, capPerArtist, featureFit, featureReject, fitScore, HeardSet, normTitle, songKey, spread, tagReject, tagSimilarity, titleReject,
  type Features,
} from './pure'

const FEATURES: Features = { tempo: 128, energy: 0.86, danceability: 0.6, valence: 0.4, acousticness: 0, loudness: -6.5, instrumentalness: 0.9, speechiness: 0.05 }

describe('spotify-discover pure parts', () => {
  it('matches one song across services despite version words, case, accents and punctuation', () => {
    expect(normTitle('Strobe (Original Mix)')).toBe('strobe')
    expect(normTitle('Strobe - Radio Edit')).toBe('strobe')
    expect(songKey('The Glitch Mob', 'Fortune Days')).toBe(songKey('glitch mob', 'FORTUNE DAYS'))
    expect(songKey('RÜFÜS DU SOL', 'Innerbloom')).toBe(songKey('Rufus Du Sol', 'innerbloom'))
    // A remix is a different recording.
    expect(normTitle('Strobe (Feed Me Remix)')).not.toBe('strobe')
  })

  it('knows a song as heard by Spotify ID, ISRC, or artist and title', () => {
    const heard = new HeardSet()
    heard.add({ id: 'abc', isrc: 'gbum71029604', artist: 'Chipzel', title: 'Focus' })
    expect(heard.has({ id: 'abc' })).toBe(true)
    expect(heard.has({ isrc: 'GBUM71029604' })).toBe(true)
    expect(heard.has({ artist: 'chipzel', title: 'Focus (Original Mix)' })).toBe(true)
    expect(heard.has({ id: 'zzz', artist: 'Chipzel', title: 'Spectra' })).toBe(false)
  })

  it('rejects titles that credit a singer or a vocal version', () => {
    for (const title of ['Levels (feat. Etta James)', 'Clarity ft. Foxes', 'Song Featuring Someone', 'Ghost (with Halsey)', 'Opus (Vocal Mix)', 'Track - Acapella']) {
      expect(titleReject(title), title).toBeDefined()
    }
    for (const title of ['Strobe', 'Feather', 'Opus (Extended Mix)', 'Within Reach']) expect(titleReject(title), title).toBeUndefined()
  })

  it('rejects artists strongly tagged as singers, not ones only lightly so', () => {
    expect(tagReject({ 'female vocalists': 60, house: 100 })).toContain('female vocalists')
    expect(tagReject({ chiptune: 100, pop: 12 })).toBeUndefined()
  })

  it('rejects features that say voice, and lets missing features through to the audio check', () => {
    expect(featureReject({ ...FEATURES, instrumentalness: 0.5 })).toContain('instrumentalness')
    expect(featureReject({ ...FEATURES, speechiness: 0.2 })).toContain('speechiness')
    expect(featureReject(FEATURES)).toBeUndefined()
    expect(featureReject(undefined)).toBeUndefined()
  })

  it('rejects a song with no preview to check, or one whose vocal stem is over the threshold', () => {
    expect(audioReject(undefined, -20)).toBe('no preview to check')
    expect(audioReject({ maxDb: -10, p90Db: -12 }, -20)).toContain('vocal stem')
    expect(audioReject({ maxDb: -15, p90Db: -25 }, -20)).toBeUndefined()
  })

  it('calibrates the threshold between instrumental and sung songs, favouring catching every sung one', () => {
    const c = calibrate([-30, -28, -26, -24], [-10, -8, -6])
    expect(c.threshold).toBeGreaterThan(-24)
    expect(c.threshold).toBeLessThan(-10)
    expect(c).toMatchObject({ instrumentalRight: 4, vocalRight: 3 })
    // Overlap: a sung song at -25 should be caught even at the cost of an instrumental one.
    const overlap = calibrate([-30, -28, -24], [-25, -8])
    expect(overlap.vocalRight).toBe(2)
  })

  it('scores songs near the liked songs higher, and tags weigh most', () => {
    const profile = {
      tempo: spread([124, 128, 132]), energy: spread([0.7, 0.86, 0.94]), danceability: spread([0.5, 0.6, 0.7]),
      valence: spread([0.25, 0.4, 0.6]), acousticness: spread([0, 0, 0.03]), loudness: spread([-8, -6.5, -5]),
    }
    const near = featureFit(FEATURES, profile)!
    const far = featureFit({ ...FEATURES, tempo: 80, energy: 0.2, acousticness: 0.9, loudness: -18 }, profile)!
    expect(near).toBeGreaterThan(far)
    expect(tagSimilarity({ chiptune: 100 }, { chiptune: 0.5, synthwave: 0.5 })).toBeGreaterThan(tagSimilarity({ jazz: 100 }, { chiptune: 0.5 }))
    expect(fitScore(1, 0.2, 1)).toBeGreaterThan(fitScore(0, 1, 1))
  })

  it('keeps at most a few songs per artist, best first', () => {
    const songs = [{ artist: 'A', n: 1 }, { artist: 'a', n: 2 }, { artist: 'B', n: 3 }, { artist: 'A', n: 4 }]
    expect(capPerArtist(songs, 2).map((s) => s.n)).toEqual([1, 2, 3])
  })
})
