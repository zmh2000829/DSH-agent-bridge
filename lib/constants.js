/** Shared identifiers for the Grok Build harness route. */

export const GROK_PRESET_ID = 'grok-build'
export const DEFAULT_GROK_MODEL = 'unknown'
export const SESSION_ROUTE = '/grok-acp/session'
export const DEFAULT_DSH_PRESET = 'standard'

export function isGrokPreset(preset) {
  return preset === GROK_PRESET_ID
}
