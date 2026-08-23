/** Same-origin HTTP bridge for the composer harness picker. */

import { SessionId } from './session-id.js'
import { DEFAULT_DSH_PRESET, FALLBACK_GROK_MODELS, GROK_PRESET_ID, isGrokPreset, SESSION_ROUTE } from './constants.js'
import { CLIENT_OWNED_COMMANDS, WEB_COMMANDS } from './preset-marker.js'
import { sessionBlank } from './render.js'

export { SESSION_ROUTE }

export function isTrustedRequest(request, requireOrigin) {
  const rawHost = singleHeader(request.headers, 'host')
  if (rawHost === undefined) return false
  let host
  try {
    host = new URL(`http://${rawHost}`)
  } catch {
    return false
  }
  if (!loopback(host.hostname) || singleHeader(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = singleHeader(request.headers, 'origin')
  if (origin === undefined) return !requireOrigin
  try {
    return new URL(origin).host === host.host
  } catch {
    return false
  }
}

export function sessionHandler(api) {
  return async (request, response) => {
    if (request.method === 'GET') {
      if (!isTrustedRequest(request, false)) return forbidden(response)
      const url = new URL(request.url ?? SESSION_ROUTE, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return json(response, 400, { error: 'sessionId is required' })
      try {
        return json(response, 200, await api.read(sessionId))
      } catch (error) {
        return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
      return
    }
    if (!isTrustedRequest(request, true)) return forbidden(response)
    if (singleHeader(request.headers, 'content-type')?.split(';', 1)[0] !== 'application/json') {
      return json(response, 415, { error: 'content-type must be application/json' })
    }
    let input
    try {
      input = JSON.parse(await readBody(request))
    } catch {
      return json(response, 400, { error: 'invalid JSON' })
    }
    try {
      return json(response, 200, await api.write(input))
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

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

function singleHeader(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function loopback(hostname) {
  const value = hostname.toLocaleLowerCase('en-US')
  if (value === 'localhost' || value.endsWith('.localhost') || value === '[::1]') return true
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part))
}

function forbidden(response) {
  json(response, 403, { error: 'forbidden' })
}

function json(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
