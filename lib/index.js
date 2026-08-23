/** Grok Build ACP as a selectable root harness inside DeepSeek Harness Web. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { AcpHost } from './acp-connection.js'
import { DEFAULT_DSH_PRESET, GROK_PRESET_ID, isGrokPreset, SESSION_ROUTE } from './constants.js'
import { importFromDsh, unwrapService } from './dsh.js'
import { GrokAgentFactory } from './grok-agent.js'
import { HarnessRouterFactory } from './router.js'
import { sessionBlank } from './render.js'
import { parseSessionId, sessionHandler, snapshotFor } from './web-route.js'

const { resolveSessionPreset } = await importFromDsh('@deepseek-ai/dsh-agent-presets')
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const name = 'dsh-grok-acp'
export const inject = ['agents', 'agentPresets', 'sessions', 'sessionPersistence', 'subprocess', 'approval', 'commands']

export const Config = z.object({
  command: z.string().default(process.env.GROK_COMMAND || defaultGrokCommand()),
  args: z.array(z.string()).default(['agent', '--no-leader', 'stdio']),
  env: z.dict(z.string()).default({}),
  presetRoot: z.string().default(join(packageRoot, 'presets')),
  stateFile: z.string().default(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'grok-harness-sessions.json')),
  disposeGraceMs: z.number().default(6_000),
  idleDisposeMs: z.number().default(30_000),
  yoloMode: z.boolean().default(false),
  allowOutsideWorkspace: z.boolean().default(false),
})

export function apply(ctx, config) {
  const agents = unwrapService(ctx.agents)
  const originalSlot = agents.factory
  if (originalSlot?.target === undefined) {
    throw new Error('dsh-grok-acp requires the official DSH agent-loop to load first')
  }

  const host = new AcpHost(ctx, config)
  const grokFactory = new GrokAgentFactory(ctx, config, host)
  const router = new HarnessRouterFactory(ctx, originalSlot.target, grokFactory)
  agents.factory = { target: router }

  const presets = unwrapService(ctx.agentPresets)
  const originalRoots = presets.resolvedRoots
  const grokRoot = { path: resolve(config.presetRoot), trust: 'system' }
  if (existsSync(join(grokRoot.path, GROK_PRESET_ID, 'agent.cordis.yml'))) {
    const already = Array.isArray(originalRoots) && originalRoots.some(root => root.path === grokRoot.path)
    if (!already) presets.resolvedRoots = [grokRoot, ...(originalRoots ?? [])]
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: SESSION_ROUTE,
      handler: sessionHandler({
        read: async (sessionId) => readSnapshot(ctx, router, host, sessionId),
        write: async (input) => writeSnapshot(ctx, router, host, input),
      }),
    }), 'dsh-grok-acp: session route')
  })

  return async () => {
    if (agents.factory?.target === router) agents.factory = originalSlot
    if (presets.resolvedRoots?.[0]?.path === grokRoot.path) {
      presets.resolvedRoots = originalRoots
    }
    await router.dispose()
    await host.dispose()
  }
}

function defaultGrokCommand() {
  const home = process.env.HOME || homedir()
  const bundled = join(home, '.grok', 'bin', 'grok')
  return existsSync(bundled) ? bundled : 'grok'
}

function readSnapshot(ctx, router, host, rawId) {
  const sessionId = parseSessionId(rawId)
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`unknown session ${rawId}`)
  const resolvePreset = current => resolveSessionPreset(current) ?? current.header.agentPreset
  return snapshotFor(session, router, host, resolvePreset)
}

async function writeSnapshot(ctx, router, host, input) {
  if (input === null || typeof input !== 'object') throw new Error('invalid payload')
  const sessionId = parseSessionId(input.sessionId)
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error(`unknown session ${input.sessionId}`)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`no agent for session ${input.sessionId}`)
  if (input.harness !== undefined) {
    if (!sessionBlank(session)) throw new Error('会话开始后不能再切换 Harness')
    const harness = input.harness === 'grok-build' ? GROK_PRESET_ID : (router.lastDsh(sessionId) || DEFAULT_DSH_PRESET)
    if (isGrokPreset(harness) !== isGrokPreset(resolveSessionPreset(session) ?? session.header.agentPreset)) {
      const preset = await ctx.agentPresets.recompose(agent.ctx, harness)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      const record = router.recordFor(sessionId)
      if (record !== undefined) await record.transition
    }
  }
  if (input.preset !== undefined) {
    if (!sessionBlank(session)) throw new Error('会话开始后不能再切换 Agent 预设')
    if (typeof input.preset !== 'string' || isGrokPreset(input.preset)) {
      throw new Error('invalid DSH Agent preset')
    }
    const preset = await ctx.agentPresets.recompose(agent.ctx, input.preset)
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  }
  if (input.modelId !== undefined || input.effort !== undefined) {
    const record = router.recordFor(sessionId)
    const remote = record?.underlying.agent.remoteSessionId
    if (record?.mode !== GROK_PRESET_ID || remote === undefined) {
      throw new Error('只有 Grok Build 会话可以改模型和推理力度')
    }
    const value = input.modelId ?? input.effort
    await host.setConfigOption(remote, value, value)
    if (input.modelId !== undefined) {
      host.currentModelId = input.modelId
      record.underlying.agent.grokModel = input.modelId
    }
  }
  return readSnapshot(ctx, router, host, input.sessionId)
}
