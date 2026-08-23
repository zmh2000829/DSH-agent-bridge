/** Shared identifiers for the Grok Build harness route. */

export const GROK_PRESET_ID = 'grok-build'
export const DEFAULT_GROK_MODEL = 'grok-4.6'
export const SESSION_ROUTE = '/grok-acp/session'
export const DEFAULT_DSH_PRESET = 'standard'

const GROK_EFFORTS = [
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
]

export const FALLBACK_GROK_MODELS = [
  { id: 'grok-4.6', name: 'Grok 4.6', efforts: GROK_EFFORTS },
  { id: 'grok-4.5', name: 'Grok 4.5', efforts: GROK_EFFORTS },
]

export function isGrokPreset(preset) {
  return preset === GROK_PRESET_ID
}
