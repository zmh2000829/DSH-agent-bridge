/** Resolve the host-access grant selected for one DSH session. */

/**
 * Read DSH's authoritative sandbox override, with the permission preset as a
 * fallback for older or partial session logs.
 */
export function sessionHasFullAccess(session) {
  const events = session?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'sandbox/mode') {
      return event.data?.mode === 'danger-full-access'
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'permission/preset') {
      return event.data?.preset === 'danger-full-access'
    }
  }
  return false
}
