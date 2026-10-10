import { describe, expect, it } from 'vitest'
import { parseAgentRef } from './agent-token'
import { CONTROL, isBlocking, parseReply, playedLengths, redactSpoken, renderSpeech, silencedIfQuiet, type Speaker } from './reply'

const KEVIN: Speaker = { name: 'Kevin', voice: 'am_michael' }
const resolveKevin = (handle: string): Speaker | undefined => handle === 'a1' ? KEVIN : undefined

describe('parseReply', () => {
  it('reads parts and tools', () => {
    const reply = parseReply('{"say":[{"from":"control","text":"Checking."}],"tools":[{"tool":"read","agent":"a1","search":"bananas"}]}')
    expect(reply.say).toEqual([{ from: CONTROL, text: 'Checking.' }])
    expect(reply.tools).toEqual([{ tool: 'read', agent: 'a1', search: 'bananas' }])
  })

  it('tolerates a code fence or preamble around the object', () => {
    expect(parseReply('Sure:\n```json\n{"say":[{"text":"Hi."}]}\n```').say).toEqual([{ from: CONTROL, text: 'Hi.' }])
  })

  it('reads go_quiet, which takes nothing', () => {
    expect(parseReply('{"say":[{"from":"control","text":"Going quiet."}],"tools":[{"tool":"go_quiet"}]}').tools).toEqual([{ tool: 'go_quiet' }])
  })

  it('reads a call written among the parts as one in "tools", in the order written', () => {
    const parsed = parseReply('{"say":[{"from":"control","text":"Sent."},{"tool":"send","agent":"a1","message":"m"}],"tools":[{"tool":"monitor","agent":"a2"}]}')
    expect(parsed).toEqual({
      say: [{ from: CONTROL, text: 'Sent.' }],
      tools: [{ tool: 'send', agent: 'a1', message: 'm' }, { tool: 'monitor', agent: 'a2' }],
    })
  })

  it('drops every word of a reply that goes quiet', () => {
    const quiet = silencedIfQuiet(parseReply('{"say":[{"from":"control","text":"Going quiet."},{"tool":"go_quiet"},{"from":"control","text":"Bye."}],"tools":[{"tool":"interrupt","agent":"a1"}]}'))
    expect(quiet).toEqual({ say: [], tools: [{ tool: 'go_quiet' }, { tool: 'interrupt', agent: 'a1' }] })
    const loud = parseReply('{"say":[{"from":"control","text":"Sent."}],"tools":[{"tool":"send","agent":"a1","message":"m"}]}')
    expect(silencedIfQuiet(loud)).toBe(loud)
  })

  it('treats missing say and tools as empty, and drops blank parts', () => {
    expect(parseReply('{"say":[{"from":"control","text":"  "}]}')).toEqual({ say: [], tools: [] })
  })

  it('rejects what it cannot use, with a reason', () => {
    expect(() => parseReply('no json here')).toThrow(/JSON object/)
    expect(() => parseReply('{"tools":[{"tool":"launch","agent":"a1"}]}')).toThrow(/unknown tool/)
    expect(() => parseReply('{"tools":[{"tool":"ask_agent","agent":"a1"}]}')).toThrow(/question/)
    expect(() => parseReply('{"tools":[{"tool":"read"}]}')).toThrow(/agent/)
  })

  it('answers a guessed tool with the real ones, not with the fields the guess lacks', () => {
    // The guesses Control made with no instructions to go on.
    expect(() => parseReply('{"tools":[{"name":"send_to_agent","input":{"agent":"a1","message":"hi"}}]}')).toThrow(/"tool" name, one of: [^]*\bsend\b/)
    expect(() => parseReply('{"tools":[{"tool":"Bash","input":{"command":"ls"}}]}')).toThrow(/unknown tool "Bash"; the tools are: [^]*\bspawn\b/)
    expect(() => parseReply('{"tools":[{"tool":"send","input":{"agent":"a1","message":"hi"}}]}')).toThrow(/beside "tool", not under "input"/)
  })

  it('takes an agent token, braces and all, wherever an agent goes', () => {
    const reply = parseReply('{"say":[{"from":"{Kevin:a1}","text":"Hi."}],"tools":[{"tool":"send","agent":"{Kevin:a1}","message":"m"},{"tool":"force_user_camera","target":"{a1}"}]}')
    expect(reply.say).toEqual([{ from: 'Kevin:a1', text: 'Hi.' }])
    expect(reply.tools).toEqual([{ tool: 'send', agent: 'Kevin:a1', message: 'm' }, { tool: 'force_user_camera', target: 'a1' }])
  })

  it('reads unarchive_agent, which takes an agent like archive_agent', () => {
    expect(parseReply('{"tools":[{"tool":"unarchive_agent","agent":"{Kevin:a1}"}]}').tools).toEqual([{ tool: 'unarchive_agent', agent: 'Kevin:a1' }])
    expect(() => parseReply('{"tools":[{"tool":"unarchive_agent"}]}')).toThrow('tool "unarchive_agent" needs an "agent"')
  })

  it('reads a name given in spawn, which needs a gender with it', () => {
    const spawn = (extra: string): string => `{"tools":[{"tool":"spawn","directory":"dir-x","title":"t","prompt":"p"${extra}}]}`
    expect(parseReply(spawn('')).tools).toEqual([{ tool: 'spawn', directory: 'dir-x', title: 't', prompt: 'p' }])
    expect(parseReply(spawn(',"name":"Bob","gender":"masculine"')).tools)
      .toEqual([{ tool: 'spawn', directory: 'dir-x', title: 't', prompt: 'p', name: { name: 'Bob', gender: 'masculine' } }])
    expect(() => parseReply(spawn(',"name":"Bob"'))).toThrow('"spawn" with a "name" needs a "gender" for it, "masculine" or "feminine"')
    expect(() => parseReply(spawn(',"name":"Bob","gender":"male"'))).toThrow(/"masculine" or "feminine"/)
    expect(() => parseReply(spawn(',"gender":"feminine"'))).toThrow('"spawn" has a "gender" but no "name"')
  })

  it('reads rename_agent: a title, a name with its gender, or both', () => {
    const rename = (extra: string): string => `{"tools":[{"tool":"rename_agent","agent":"{Kevin:a1}"${extra}}]}`
    expect(parseReply(rename(',"title":"water sim"')).tools).toEqual([{ tool: 'rename_agent', agent: 'Kevin:a1', title: 'water sim' }])
    expect(parseReply(rename(',"name":"Ruth","gender":"feminine"')).tools)
      .toEqual([{ tool: 'rename_agent', agent: 'Kevin:a1', name: { name: 'Ruth', gender: 'feminine' } }])
    expect(parseReply(rename(',"title":"t","name":"Ruth","gender":"feminine"')).tools)
      .toEqual([{ tool: 'rename_agent', agent: 'Kevin:a1', title: 't', name: { name: 'Ruth', gender: 'feminine' } }])
    expect(() => parseReply(rename(''))).toThrow('"rename_agent" needs a "title", a "name", or both')
    expect(() => parseReply(rename(',"name":"Ruth"'))).toThrow(/needs a "gender"/)
    expect(() => parseReply('{"tools":[{"tool":"rename_agent","title":"t"}]}')).toThrow('tool "rename_agent" needs an "agent"')
  })

  it('only read blocks the turn', () => {
    expect(isBlocking({ tool: 'read', agent: 'a1' })).toBe(true)
    expect(isBlocking({ tool: 'monitor', agent: 'a1' })).toBe(false)
    expect(isBlocking({ tool: 'ask_agent', agent: 'a1', question: 'q' })).toBe(false)
  })
})

describe('renderSpeech', () => {
  it('names placeholders and introduces an agent in its own voice', () => {
    const parts = renderSpeech([
      { from: CONTROL, text: '{a1} is on the water simulation.' },
      { from: 'a1', text: 'The solver is done.' },
    ], resolveKevin, 'af_heart')
    expect(parts).toEqual([
      { text: 'Kevin is on the water simulation.', voice: 'af_heart' },
      { text: 'Kevin here. The solver is done.', voice: 'am_michael' },
    ])
  })

  it('introduces an agent once when it is quoted twice in a row, and again after someone else speaks', () => {
    const parts = renderSpeech([
      { from: 'a1', text: 'First.' },
      { from: 'a1', text: 'Second.' },
      { from: CONTROL, text: 'Meanwhile.' },
      { from: 'a1', text: 'Third.' },
    ], resolveKevin, 'af_heart')
    expect(parts.map(part => part.text)).toEqual(['Kevin here. First.', 'Second.', 'Meanwhile.', 'Kevin here. Third.'])
  })

  it('does not introduce an agent twice when the model wrote the introduction itself', () => {
    const [part] = renderSpeech([{ from: 'a1', text: 'Kevin here. Done.' }], resolveKevin, 'af_heart')
    expect(part.text).toBe('Kevin here. Done.')
  })

  it('never lends an agent voice to a part from an unknown handle', () => {
    const [part] = renderSpeech([{ from: 'zz', text: 'Hello.' }], resolveKevin, 'af_heart')
    expect(part.voice).toBe('af_heart')
    expect(part.text).toBe('Hello.')
  })

  it('speaks an unresolvable placeholder as "an agent", not as its handle', () => {
    const [part] = renderSpeech([{ from: CONTROL, text: '{zz} stopped.' }], resolveKevin, 'af_heart')
    expect(part.text).toBe('an agent stopped.')
  })
})

describe('renderSpeech: each agent named once', () => {
  const AGENTS: Record<string, Speaker> = {
    'royal-anchor': { name: 'Naomi', voice: 'af_kore' },
    'keen-iguana': { name: 'Tessa', voice: 'bf_emma' },
    'swift-hammer': KEVIN,
  }
  // As the receptionist resolves: the handle decides, whatever name is written in front of it.
  const resolve = (ref: string): Speaker | undefined => AGENTS[parseAgentRef(ref).key]
    ?? Object.values(AGENTS).find(agent => agent.name.toLowerCase() === ref.toLowerCase())
  const speak = (text: string): string => renderSpeech([{ from: CONTROL, text }], resolve, 'af_heart')[0].text

  it('speaks a full token as the name alone, and a stale name in it as the real one', () => {
    expect(speak('{Naomi:royal-anchor} looked into it.')).toBe('Naomi looked into it.')
    expect(speak('{Nora:royal-anchor} looked into it.')).toBe('Naomi looked into it.')
    expect(speak('{Naomi} and {royal-anchor} are one agent.')).toBe('Naomi and Naomi are one agent.')
  })

  // Each of these was spoken in Control's own voice with the name twice (Control's transcript, 2026-10-04).
  it.each([
    ['{royal-anchor}, Naomi, looked into the Voice Operator death when you tapped white.', 'Naomi looked into the Voice Operator death when you tapped white.'],
    ['Next for {keen-iguana}, Tessa, is finishing the self-interruption wiring.', 'Next for Tessa is finishing the self-interruption wiring.'],
    ["I'm fairly sure that other agent is {royal-anchor}, Naomi, the one fixing the Control button.", "I'm fairly sure that other agent is Naomi the one fixing the Control button."],
  ])('drops the name written beside a token as an aside: %s', (written, heard) => {
    expect(speak(written)).toBe(heard)
  })

  it.each([
    ['{Naomi:royal-anchor}, Naomi, looked into it.', 'Naomi looked into it.'],
    ['Kevin {swift-hammer} finished.', 'Kevin finished.'],
    ['Kevin, {swift-hammer}, finished.', 'Kevin finished.'],
    ['{swift-hammer} Kevin finished.', 'Kevin finished.'],
    ['{swift-hammer}, Kevin.', 'Kevin.'],
    ['{swift-hammer} kevin finished.', 'Kevin finished.'],
    ["{royal-anchor}, Naomi's fix is in.", "Naomi's fix is in."],
    ['{Kevin} {swift-hammer} finished.', 'Kevin finished.'],
    // A comma that was not setting the name off stays: it belongs to the sentence.
    ['{swift-hammer} Kevin, then Tessa.', 'Kevin, then Tessa.'],
  ])('collapses the same name repeated beside a token: %s', (written, heard) => {
    expect(speak(written)).toBe(heard)
  })

  it.each([
    ['{swift-hammer}, Tessa and Naomi are done.', 'Kevin, Tessa and Naomi are done.'],
    ['{swift-hammer}, {keen-iguana} and {royal-anchor} are done.', 'Kevin, Tessa and Naomi are done.'],
    ['{swift-hammer} finished, so Kevin can rest.', 'Kevin finished, so Kevin can rest.'],
    ['{swift-hammer} told Kevinson.', 'Kevin told Kevinson.'],
    ['Ask {swift-hammer} what Kevin meant.', 'Ask Kevin what Kevin meant.'],
    ['{unknown-agent}, Kevin, is here.', 'an agent, Kevin, is here.'],
  ])('leaves anything else beside a token as written: %s', (written, heard) => {
    expect(speak(written)).toBe(heard)
  })

  it('collapses in an agent\'s own part too, after its introduction', () => {
    const [part] = renderSpeech([{ from: 'Kevin:swift-hammer', text: 'I asked {keen-iguana}, Tessa, about it.' }], resolve, 'af_heart')
    expect(part.text).toBe('Kevin here. I asked Tessa about it.')
  })
})

describe('redactSpoken', () => {
  const parts = [
    { text: 'Kevin is done.', voice: 'af_heart' },
    { text: 'Kevin here. The solver works now.', voice: 'am_michael' },
  ]

  it('keeps everything when all of it was heard', () => {
    expect(redactSpoken(parts, 1_000)).toEqual(parts)
  })

  it('offsets into the single-space join, cutting inside the second part', () => {
    const intoSecond = parts[0].text.length + 1 + 'Kevin here. The sol'.length
    const kept = redactSpoken(parts, intoSecond)
    expect(kept).toHaveLength(2)
    expect(kept[0]).toEqual(parts[0])
    expect(kept[1].text).toBe('Kevin here. The *INTERRUPTED*')
  })

  it('drops parts after the cut entirely', () => {
    const kept = redactSpoken(parts, 6)
    expect(kept).toHaveLength(1)
    expect(kept[0].text).toMatch(/INTERRUPTED/)
  })
})

describe('playedLengths', () => {
  const parts = [{ text: 'Kevin is done.' }, { text: 'Kevin here. The solver works.' }, { text: 'Ada here.' }]
  const second = parts[0].text.length + 1

  it('runs through the word being said, and leaves the parts not yet reached at none', () => {
    expect(playedLengths(parts, second + 'Kevin'.length)).toEqual([14, 5, 0])
    expect(playedLengths(parts, second + 'Kevin here. The so'.length)).toEqual([14, 'Kevin here. The solver'.length, 0])
  })

  it('lights nothing before the voice starts', () => {
    expect(playedLengths(parts, 0)).toEqual([0, 0, 0])
  })
})
