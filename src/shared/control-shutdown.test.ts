import { describe, expect, it } from 'vitest'
import { isControlShutdown, isControlStopTalking, wakeFreeShutdown } from './control-shutdown'

describe('isControlShutdown', () => {
  it('matches "Control, shutdown", however dictation writes it', () => {
    for (const text of ['Control, shutdown.', 'Control shut down', 'control. Shut down!', 'Control — shut-down', 'CONTROL, SHUTDOWN']) {
      expect(isControlShutdown(text), text).toBe(true)
    }
  })

  it('matches "shutdown" as the whole utterance, as said in the conversation window', () => {
    expect(isControlShutdown('Shutdown.')).toBe(true)
    expect(isControlShutdown('shut down')).toBe(true)
  })

  it('matches "let me turn this off", with or without "Control" before it', () => {
    for (const text of ['Let me turn this off.', 'let me turn this off', 'Lemme turn this off.', 'Control, let me turn this off.', 'Let me turn this off!']) {
      expect(isControlShutdown(text), text).toBe(true)
    }
  })

  it('never matches inside a longer request', () => {
    for (const text of [
      'Control, shut down the server.', 'Did Kevin shut down the build?', 'shutdown now', 'Control, shutdown, then tell Kevin', '',
      'Let me turn this off and on again.', 'let me turn this off for you', 'So let me turn this off.', 'Let me turn it off.',
    ]) {
      expect(isControlShutdown(text), text).toBe(false)
    }
  })

  it('needs a phrase, not just the wake word', () => {
    expect(isControlShutdown('Control.')).toBe(false)
    expect(isControlShutdown('Control, control.')).toBe(false)
  })
})

describe('wakeFreeShutdown', () => {
  it('is the whole phrase, said without "Control"', () => {
    expect(wakeFreeShutdown('Let me turn this off.')).toBe('whole')
    expect(wakeFreeShutdown('Lemme turn this off')).toBe('whole')
  })

  it('is a start of it from "let me" on, as the first second of it may be heard', () => {
    for (const heard of ['Let me', 'Let me turn', 'let me turn this', 'Lemme turn']) {
      expect(wakeFreeShutdown(heard), heard).toBe('start')
    }
  })

  it('is nothing else — not "shutdown", which needs "Control" first', () => {
    for (const heard of ['', 'Let', 'Control.', 'Shutdown.', 'Control, let me turn this off.', 'Let me think', 'Let us turn', 'Let me turn this off now', 'Please let me']) {
      expect(wakeFreeShutdown(heard), heard).toBeUndefined()
    }
  })
})

describe('isControlStopTalking', () => {
  it('matches "stop talking", "stop conversation" and "end conversation", with or without "Control"', () => {
    for (const text of [
      'Stop talking.', 'stop talking', 'Control, stop talking.', 'STOP TALKING!', 'Control — stop talking',
      'Stop conversation.', 'Control, stop conversation', 'Stop the conversation.',
      'End conversation.', 'Control, end conversation!', 'End the conversation.',
    ]) {
      expect(isControlStopTalking(text), text).toBe(true)
    }
  })

  it('never matches inside a longer request, nor "stop listening" or a shutdown', () => {
    for (const text of [
      'Tell Kevin to stop talking.', 'Stop talking to Kevin.', 'End conversation with Ruth.', 'Stop.', 'Control.', '',
      'Stop listening.', 'Control, shutdown.', 'Let me turn this off.', 'Conversation ended.',
    ]) {
      expect(isControlStopTalking(text), text).toBe(false)
    }
  })
})
