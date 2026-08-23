/** Preset-aware multiplexer over the official DSH AgentLoop and Grok ACP. */

import { DEFAULT_DSH_PRESET, GROK_PRESET_ID, isGrokPreset } from './constants.js'
import { importFromDsh } from './dsh.js'
import { sessionBlank } from './render.js'

const { errorChain } = await importFromDsh('@deepseek-ai/dsh-llm')
const { resolveSessionPreset } = await importFromDsh('@deepseek-ai/dsh-agent-presets')

export class HarnessRouterFactory {
  constructor(ctx, dshFactory, grokFactory) {
    this.ctx = ctx
    this.dshFactory = dshFactory
    this.grokFactory = grokFactory
    this.records = new Map()
    this.lastDshPreset = new Map()
    this.disposed = false
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      const record = this.records.get(String(session.id))
      if (record === undefined) return
      const target = isGrokPreset(event.data.agentPreset) ? GROK_PRESET_ID : 'dsh'
      if (!isGrokPreset(event.data.agentPreset)) {
        this.lastDshPreset.set(String(session.id), event.data.agentPreset)
      }
      if (target === record.mode) return
      record.transition = record.transition.then(
        () => this.switchBlank(record, target, event.data.agentPreset),
        () => this.switchBlank(record, target, event.data.agentPreset),
      )
      void record.transition.catch(error => {
        this.ctx.logger.error(`dsh-grok-acp: failed to switch session ${session.id}: ${errorChain(error)}`)
      })
    })
  }

  modeForPreset(preset) {
    return isGrokPreset(preset) ? GROK_PRESET_ID : 'dsh'
  }

  factoryFor(mode) {
    return mode === GROK_PRESET_ID ? this.grokFactory : this.dshFactory
  }

  lastDsh(sessionId) {
    return this.lastDshPreset.get(String(sessionId)) ?? DEFAULT_DSH_PRESET
  }

  async createAgent(ownerCtx, options) {
    const preset = options.meta?.agentPreset
    const mode = this.modeForPreset(preset)
    if (preset !== undefined && !isGrokPreset(preset)) this.lastDshPreset.set(String(options.sessionId), preset)
    const underlying = await this.factoryFor(mode).createAgent(ownerCtx, options)
    return this.track(ownerCtx, options.sessionId, options.agentOptions ?? {}, mode, underlying)
  }

  async resume(ownerCtx, options) {
    const inspected = await this.ctx.sessionPersistence.inspect(options.resumeSessionId, options.signal)
    const preset = resolveSessionPreset({ header: inspected.meta, events: inspected.events })
    const mode = this.modeForPreset(preset)
    if (preset !== undefined && !isGrokPreset(preset)) this.lastDshPreset.set(String(options.resumeSessionId), preset)
    const underlying = await this.factoryFor(mode).resume(ownerCtx, options)
    return this.track(ownerCtx, options.resumeSessionId, options.agentOptions ?? {}, mode, underlying)
  }

  track(ownerCtx, sessionId, agentOptions, mode, underlying) {
    const key = String(sessionId)
    const record = {
      ownerCtx,
      sessionId,
      agentOptions,
      mode,
      underlying,
      transition: Promise.resolve(),
      disposed: false,
    }
    if (this.records.has(key)) throw new Error(`harness router already tracks session ${key}`)
    this.records.set(key, record)
    const dispose = async () => {
      if (record.disposed) return
      record.disposed = true
      await record.transition.catch(() => {})
      await record.underlying.dispose()
      this.records.delete(key)
    }
    return {
      get agent() { return record.underlying.agent },
      dispose,
    }
  }

  async switchBlank(record, mode, preset) {
    if (record.disposed || this.disposed || record.mode === mode) return
    if (!sessionBlank(record.underlying.agent.session)) {
      throw new Error(`cannot switch a started session from ${record.mode} to ${mode}`)
    }
    if (mode === GROK_PRESET_ID) {
      await this.grokFactory.host.ensureProcess()
    }
    await record.underlying.dispose()
    // resume() waits for the old same-id persistence lifecycle to retire and
    // acquires the persisted session without creating a competing identity.
    const spawn = async (target, mountPreset) => this.factoryFor(target).resume(record.ownerCtx, {
      resumeSessionId: record.sessionId,
      agentOptions: record.agentOptions,
      setup: async agentCtx => {
        await this.ctx.agentPresets.mount(agentCtx, mountPreset)
      },
    })
    try {
      record.underlying = await spawn(mode, preset)
      record.mode = mode
    } catch (error) {
      record.underlying = await spawn('dsh', this.lastDsh(record.sessionId))
      record.mode = 'dsh'
      throw error
    }
  }

  recordFor(sessionId) {
    return this.records.get(String(sessionId))
  }

  async dispose() {
    this.disposed = true
    await Promise.all([...this.records.values()].map(async record => {
      record.disposed = true
      await record.transition.catch(() => {})
      await record.underlying.dispose()
    }))
    this.records.clear()
    await this.grokFactory.dispose()
  }
}
