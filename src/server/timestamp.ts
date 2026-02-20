/**
 * Returns the current time as an ISO 8601 string with local timezone offset.
 * Example: "2026-02-20T14:30:45.123-08:00"
 *
 * Used by hook log writing, status-line logging, and the state machine's
 * decision logger. Extracted here so both src/server/index.ts and
 * src/server/claude-state/ can share the same implementation.
 */
export function localISOTimestamp(): string {
  const now = new Date()
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return (
    now.getFullYear() +
    '-' + String(now.getMonth() + 1).padStart(2, '0') +
    '-' + String(now.getDate()).padStart(2, '0') +
    'T' + String(now.getHours()).padStart(2, '0') +
    ':' + String(now.getMinutes()).padStart(2, '0') +
    ':' + String(now.getSeconds()).padStart(2, '0') +
    '.' + String(now.getMilliseconds()).padStart(3, '0') +
    sign + hh + ':' + mm
  )
}
