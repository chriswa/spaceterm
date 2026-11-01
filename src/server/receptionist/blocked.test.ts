import { describe, expect, it } from 'vitest'
import { blockedBrief, blockingPrompt, describeBlock, isBlocked } from './blocked'
import { renderBlocked, renderTurnBody, splitTurnBody } from './prompt'
import { asNodeId } from '../../shared/ids'

/** Molly's PermissionRequest hook payload on 2026-11-01, trimmed to the fields that matter. */
const MOLLY_PAYLOAD = {
  session_id: 'd6aa2495-111a-4ee6-ab32-3815a29d11fd',
  hook_event_name: 'PermissionRequest',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: { command: 'kill 30179 30158 30219; sleep 1; ps -p 30158,30179,30219 -o pid= ; rm -rf "$(cat $S/home-path)"; echo done' },
  permission_suggestions: [],
}

describe('blocked', () => {
  it('counts a permission, a question and a plan as blocked, and nothing else', () => {
    expect(['waiting_permission', 'waiting_question', 'waiting_plan'].every(state => isBlocked(state as never))).toBe(true)
    expect(['stopped', 'working', 'working_background', 'potential_error'].some(state => isBlocked(state as never))).toBe(false)
  })

  it('takes the tool call from a PermissionRequest payload', () => {
    expect(blockingPrompt(MOLLY_PAYLOAD)).toEqual({ tool: 'Bash', input: MOLLY_PAYLOAD.tool_input })
    expect(blockingPrompt({ hook_event_name: 'PermissionRequest' })).toBeUndefined()
    expect(blockingPrompt('nonsense')).toBeUndefined()
  })

  it('says what a permission request would run, or touch', () => {
    expect(describeBlock('waiting_permission', blockingPrompt(MOLLY_PAYLOAD)))
      .toBe('it asks permission to use Bash: running `kill 30179 30158 30219; sleep 1; ps -p 30158,30179,30219 -o pid= ; rm -rf "$(cat $S/home-path)"; echo done`')
    expect(describeBlock('waiting_permission', { tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }))
      .toBe('it asks permission to use Bash: Run the tests, by running `npm test`')
    expect(describeBlock('waiting_permission', { tool: 'Edit', input: { file_path: '/etc/hosts', old_string: 'a', new_string: 'b' } }))
      .toBe('it asks permission to use Edit: /etc/hosts')
    expect(describeBlock('waiting_permission', { tool: 'mcp__github__merge', input: { pr: 12 } }))
      .toBe('it asks permission to use mcp__github__merge: {"pr":12}')
    // After a server restart, nothing is known of it but its kind.
    expect(describeBlock('waiting_permission', undefined)).toBe('it asks permission to use a tool')
  })

  it('keeps a long command to a speakable length', () => {
    const described = describeBlock('waiting_permission', { tool: 'Bash', input: { command: 'x'.repeat(5_000) } })
    expect(described.length).toBeLessThan(500)
    expect(described).toContain('…')
  })

  it('gives a question with its options, and a plan', () => {
    const question = { tool: 'AskUserQuestion', input: { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres', description: 'the usual' }, { label: 'SQLite' }] }] } }
    expect(describeBlock('waiting_question', question)).toBe(
      'it asks the user a question. The agent is asking the user to decide:\n\nQuestion (DB): Which database?\n- Postgres: the usual\n- SQLite')
    expect(describeBlock('waiting_plan', { tool: 'ExitPlanMode', input: { plan: 'Add a hook.' } }))
      .toBe('it wants the user to approve its plan. Plan\n\nAdd a hook.')
    expect(describeBlock('waiting_question', undefined)).toBe('it asks the user a question')
  })

  it('names each blocked agent in a few words on the turn, with how long it has waited', () => {
    const now = Date.UTC(2026, 10, 1, 21, 30)
    const line = renderBlocked([
      { nodeId: asNodeId('a'), token: '{Molly:coral-moose}', state: 'waiting_permission', prompt: blockingPrompt(MOLLY_PAYLOAD), since: now - 11 * 60_000 },
      { nodeId: asNodeId('b'), token: '{Ethan:polar-cliff}', state: 'waiting_question' },
    ], now)
    expect(line).toBe('WAITING ON THE USER (each blocked until they answer it): {Molly:coral-moose} for permission to use Bash, since 11 minutes ago; {Ethan:polar-cliff} with a question.')
    expect(blockedBrief('waiting_plan', undefined)).toBe('for approval of its plan')
  })

  it('keeps the line out of the words the transcript shows the user said', () => {
    const blocked = [{ nodeId: asNodeId('a'), token: '{Molly:coral-moose}', state: 'waiting_permission' as const }]
    const body = renderTurnBody([], 'where can I eat?', undefined, undefined, 2, ['{Ethan:polar-cliff}'], undefined, blocked)
    expect(body).toContain('WAITING ON THE USER')
    expect(splitTurnBody(body)?.heard).toBe('where can I eat?')
  })
})
