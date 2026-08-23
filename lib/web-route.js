/** Same-origin HTTP bridge for the composer harness picker. */

import { SessionId } from './session-id.js'
import { DEFAULT_DSH_PRESET, FALLBACK_GROK_MODELS, GROK_PRESET_ID, isGrokPreset, SESSION_ROUTE } from './constants.js'
import { CLIENT_OWNED_COMMANDS, WEB_COMMANDS } from './preset-marker.js'
import { sessionBlank } from './render.js'
export { isTrustedRequest, sessionHandler } from './http-route.js'

export { SESSION_ROUTE }

export function snapshotFor(session, router, host, resolvePreset) {
  const preset = resolvePreset(session) ?? DEFAULT_DSH_PRESET
  const grok = isGrokPreset(preset)
  const record = router.recordFor(session.id)
  return {
    sessionId: String(session.id),
    harness: grok ? 'grok-build' : 'dsh',
    preset,
    dshPreset: grok ? router.lastDsh(session.id) : preset,
    blank: sessionBlank(session),
    running: record?.underlying.agent.status === 'running',
    grok: {
      ready: host.process !== undefined,
      model: record?.underlying.agent.grokModel ?? host.currentModelId,
      models: grokModelRows(host),
      effort: currentGrokEffort(host),
      commands: grok ? grokCommandRows(host) : [],
    },
  }
}

export function parseSessionId(value) {
  return SessionId(String(value))
}

function grokModelRows(host) {
  const rows = (host.models ?? []).map((model) => {
    const id = model.modelId ?? model.id
    if (typeof id !== 'string') return undefined
    const meta = model._meta ?? {}
    const efforts = Array.isArray(meta.reasoningEfforts)
      ? meta.reasoningEfforts.map(effort => ({
        id: String(effort.id ?? effort.value ?? ''),
        label: String(effort.label ?? effort.id ?? effort.value ?? ''),
      })).filter(effort => effort.id.length > 0)
      : []
    return {
      id,
      name: model.name ?? id,
      effort: typeof meta.reasoningEffort === 'string' ? meta.reasoningEffort : undefined,
      efforts,
    }
  }).filter(model => model !== undefined)
  return rows.length > 0 ? rows : FALLBACK_GROK_MODELS
}

function currentGrokEffort(host) {
  const current = grokModelRows(host).find(model => model.id === host.currentModelId)
  return current?.effort
}

function grokCommandRows(host) {
  const fromAgent = Array.isArray(host.commands) ? host.commands : []
  const names = new Set()
  const rows = []
  for (const command of [...WEB_COMMANDS, ...fromAgent]) {
    if (typeof command?.name !== 'string' || CLIENT_OWNED_COMMANDS.has(command.name) || names.has(command.name)) continue
    names.add(command.name)
    rows.push({
      name: command.name,
      description: command.description ?? '',
      hint: command.input?.hint,
    })
  }
  return rows
}
