/** DSH Agent whose turns are driven by Grok Build over ACP. */

import { DEFAULT_GROK_MODEL, GROK_PRESET_ID } from './constants.js'
import {
  GROK_ACTIVITY_TOOL,
  activityFallback,
  activityMeta,
  classifyActivityTool,
  createActivityState,
} from './activity.js'
import { CLIENT_OWNED_COMMANDS, WEB_COMMANDS } from './preset-marker.js'
import { importFromDsh } from './dsh.js'
import {
  renderBilling,
  renderContext,
  planTodos,
  renderSessionInfo,
  renderToolOutput,
  toAcpPrompt,
} from './render.js'

const {
  Inbox,
  agentEvents,
  emitAgentEvent,
} = await importFromDsh('@deepseek-ai/dsh-agent')
const {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
} = await importFromDsh('@deepseek-ai/dsh-llm')
const { createScope } = await importFromDsh('@deepseek-ai/dsh-scope')
const { SessionPreparation } = await importFromDsh('@deepseek-ai/dsh-session')

export class GrokWebAgent {
  constructor(hostCtx, id, options, session) {
    this.id = id
    this.options = options
    this.session = session
    this.dispatch = agentEvents(hostCtx, this)
    this.inbox = new Inbox(session, {
      inserted: message => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: message => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    })
    this.scope = createScope(hostCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.phase = { kind: 'idle' }
    this.idle = Promise.resolve()
    this.active = undefined
    this.host = undefined
    this.remoteSessionId = undefined
    this.hostGeneration = undefined
    this.lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.sessionInfo = undefined
    this.availableCommands = []
    this.grokModel = DEFAULT_GROK_MODEL
  }

  get status() {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  attachHost(host, remoteSessionId, generation) {
    this.host = host
    this.remoteSessionId = remoteSessionId
    this.hostGeneration = generation
  }

  async runWebCommand(name, rawInput) {
    const host = this.host
    if (host === undefined) {
      return { kind: 'error', text: 'Grok ACP session is unavailable' }
    }
    if (name === 'home' || name === 'welcome') {
      return {
        kind: 'success',
        text: '你正在 DSH Web 中。点击左上角 “+” 新建会话，并在输入框左侧选择 Grok Build。',
      }
    }
    let remoteSessionId
    try {
      remoteSessionId = await host.ensureAgentSession(this)
    } catch (error) {
      return { kind: 'error', text: errorChain(error) }
    }
    if (name === 'usage' || name === 'cost' || name === 'uasge') {
      try {
        const response = await host.extMethod('_x.ai/billing', {})
        return { kind: 'success', text: renderBilling(response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'btw') {
      const question = rawInput.trim()
      if (question.length === 0) return { kind: 'error', text: '用法：/btw <问题>' }
      try {
        const response = await host.extMethod('_x.ai/btw', { sessionId: remoteSessionId, question })
        const answer = response?.result?.answer ?? response?.answer
        return typeof answer === 'string'
          ? { kind: 'success', text: answer }
          : { kind: 'error', text: 'Grok Build 没有返回 BTW 回答' }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'context') {
      try {
        const response = await host.extMethod('_x.ai/session/info', { sessionId: remoteSessionId })
        return { kind: 'success', text: renderContext(response?.result ?? response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'session-info' || name === 'status' || name === 'info') {
      try {
        const response = await host.extMethod('_x.ai/session/info', { sessionId: remoteSessionId })
        return { kind: 'success', text: renderSessionInfo(response?.result ?? response) }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    if (name === 'model' || name === 'models' || name === 'effort') {
      const value = rawInput.trim()
      if (value.length === 0) {
        return {
          kind: 'success',
          text: name === 'model' || name === 'models'
            ? `当前模型：${this.options.model ?? host.currentModelId}\n可选：${(host.models ?? []).map(model => model.modelId ?? model.id).join(', ')}`
            : '用法：/effort low|medium|high|xhigh',
        }
      }
      try {
        await host.setConfigOption(remoteSessionId, value, value)
        if (name === 'model' || name === 'models') this.grokModel = value
        return { kind: 'success', text: `已切换为 ${value}` }
      } catch (error) {
        return { kind: 'error', text: errorChain(error) }
      }
    }
    const line = `/${name}${rawInput.length > 0 && !rawInput.startsWith(' ') ? ' ' : ''}${rawInput}`
    this.followup(createUserMessage({
      content: [{ type: 'text', text: line }],
      source: { kind: 'user' },
    }))
    return { kind: 'success' }
  }

  send(message, target, wakeup) {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    this.inbox.append(wakingAfterAbort ? 'next-turn' : target, message)
    if (!wakeup) return
    if (this.phase.kind === 'idle') this.wake()
    else if (this.phase.kind === 'maintenance' || wakingAfterAbort) this.phase.wakeRequested = true
  }

  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-turn', true) }
  inject(message) { this.send(message, 'next-step', false) }

  cancel(cause, options = {}) {
    if (!options.keepInbox) this.inbox.clear()
    if (this.phase.kind === 'idle') return
    this.phase.wakeRequested = false
    this.phase.abort.abort(cause)
    if (this.remoteSessionId !== undefined) {
      void this.host?.cancel({ sessionId: this.remoteSessionId })
    }
  }

  async whenIdle() {
    let activity
    do {
      await (activity = this.idle)
    } while (activity !== this.idle)
  }

  runMaintenance(task) {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const phase = { kind: 'maintenance', abort: new AbortController(), wakeRequested: false }
    this.phase = phase
    const result = task(phase.abort.signal)
    this.idle = result.then(() => {}, () => {}).finally(() => {
      this.phase = { kind: 'idle' }
      if (phase.wakeRequested && this.inbox.nextTurn.length > 0) this.wake()
    })
    return result
  }

  wake() {
    const abort = new AbortController()
    this.phase = { kind: 'running', abort, wakeRequested: false }
    this.dispatch.emit('agent/status', { status: 'running' })
    this.idle = this.drain(abort)
  }

  async drain(initial) {
    let abort = initial
    try {
      while (true) {
        await this.drive(abort.signal)
        if (this.inbox.nextTurn.length === 0) return
        abort = new AbortController()
        this.phase = { kind: 'running', abort, wakeRequested: false }
      }
    } finally {
      this.phase = { kind: 'idle' }
      this.dispatch.emit('agent/status', { status: 'idle' })
    }
  }

  async drive(signal) {
    while (this.inbox.nextTurn.length > 0) {
      const turn = ++this.lastTurn
      const step = 1
      let reason = { kind: 'completed' }
      this.session.append('turn/start', { turn })
      try {
        this.session.append('step/start', { turn, step })
        const messages = this.inbox.claim('next-turn', turn)
        for (const message of messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        const active = {
          turn,
          step,
          text: '',
          reasoning: '',
          textStarted: false,
          reasoningStarted: false,
          textIndex: undefined,
          reasoningIndex: undefined,
          nextBlockIndex: 0,
          chunkSeqs: [],
          assistantCommitted: false,
          toolNames: new Map(),
          activity: createActivityState(turn, step),
        }
        this.active = active
        signal.throwIfAborted()
        if (this.host === undefined) {
          throw new Error('Grok ACP session is unavailable')
        }
        this.remoteSessionId = await this.host.ensureAgentSession(this)
        const prompt = messages.flatMap(message => toAcpPrompt(message.content))
        if (prompt.length === 0) prompt.push({ type: 'text', text: '' })
        const response = await this.host.prompt({ sessionId: this.remoteSessionId, prompt })
        signal.throwIfAborted()
        this.commitAssistant(active, false)
        this.closeDanglingTools(active, 'Grok ended the turn without a terminal tool update')
        this.closeActivity(active)
        if (response.stopReason === 'max_tokens') reason = { kind: 'max-tokens' }
        else if (response.stopReason === 'cancelled') reason = { kind: 'interrupted' }
        else if (response.stopReason === 'refusal') reason = { kind: 'error', error: { message: 'Grok refused the request', code: 'GROK_REFUSAL' } }
      } catch (error) {
        if (this.active !== undefined) {
          this.commitAssistant(this.active, true)
          this.closeDanglingTools(this.active, signal.aborted ? 'Grok turn cancelled' : errorChain(error))
          this.closeActivity(this.active)
        }
        reason = signal.aborted
          ? { kind: 'aborted', reason: signal.reason }
          : { kind: 'error', error: { message: errorChain(error), code: 'GROK_ACP_ERROR' } }
        this.dispatch.emit('agent/error', { turn, step, error })
      } finally {
        this.active = undefined
        this.session.append('step/end', { turn, step })
        this.session.append('turn/end', { turn, reason })
      }
      if (signal.aborted) return
    }
  }

  closeAssistantBlocks(active) {
    if (active.reasoningIndex !== undefined && active.reasoningStarted) {
      active.chunkSeqs.push(this.session.append('assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-end', index: active.reasoningIndex, block: { type: 'reasoning', text: active.reasoning } },
      }).seq)
      active.reasoningStarted = false
    }
    if (active.textIndex !== undefined && active.textStarted) {
      active.chunkSeqs.push(this.session.append('assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-end', index: active.textIndex, block: { type: 'text', text: active.text } },
      }).seq)
      active.textStarted = false
    }
  }

  commitAssistant(active, interrupted) {
    if (active.assistantCommitted) return
    this.closeAssistantBlocks(active)
    const content = []
    if (active.reasoning.length > 0) content.push({ type: 'reasoning', text: active.reasoning })
    if (active.text.length > 0) content.push({ type: 'text', text: active.text })
    if (content.length > 0) {
      this.session.append('assistant/message', {
        turn: active.turn,
        step: active.step,
        message: createAssistantMessage({
          content,
          source: { provider: 'grok-build', model: this.grokModel ?? DEFAULT_GROK_MODEL },
        }),
        ...(interrupted ? { interrupted: true } : {}),
      }, { surfaceOp: 'append', sourceEventSeqs: active.chunkSeqs })
    }
    active.assistantCommitted = true
  }

  closeDanglingTools(active, message) {
    for (const [wireId] of active.toolNames) {
      this.appendToolResult(active, wireId, message, true, [])
    }
  }

  handleUpdate(params) {
    if (params.sessionId !== this.remoteSessionId) return Promise.resolve()
    const update = params.update
    if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.availableCommands = update.availableCommands
      registerGrokCommands(this, update.availableCommands)
      this.ctx.commands?.notifyChange?.()
    }
    if (update?.sessionUpdate === 'session_info_update') this.sessionInfo = update
    if (update?.sessionUpdate === 'model_changed' && typeof update.currentModelId === 'string') {
      this.grokModel = update.currentModelId
    }
    const active = this.active
    if (active === undefined) return Promise.resolve()
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.appendTextDelta(active, 'text', update.content.text)
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      this.appendTextDelta(active, 'reasoning', update.content.text)
    } else if (update.sessionUpdate === 'tool_call') {
      this.ensureToolCall(active, update)
    } else if (update.sessionUpdate === 'tool_call_update') {
      this.ensureToolCall(active, update)
      if (update.status === 'completed' || update.status === 'failed') {
        const rendered = renderToolOutput(update)
        this.appendToolResult(active, update.toolCallId, rendered.text, update.status === 'failed', rendered.diffs)
      }
    } else if (update.sessionUpdate === 'plan') {
      this.session.append('todo/write', { todos: planTodos(update) })
    }
    return Promise.resolve()
  }

  handleExt(method, params) {
    if (method.includes('models') && typeof params?.currentModelId === 'string') {
      this.grokModel = params.currentModelId
    }
  }

  appendTextDelta(active, kind, text) {
    const isReasoning = kind === 'reasoning'
    const indexKey = isReasoning ? 'reasoningIndex' : 'textIndex'
    const startedKey = isReasoning ? 'reasoningStarted' : 'textStarted'
    const blockType = isReasoning ? 'reasoning' : 'text'
    const deltaType = isReasoning ? 'reasoning-delta' : 'text-delta'
    const index = active[indexKey] ?? active.nextBlockIndex++
    if (!active[startedKey]) {
      active[startedKey] = true
      active[indexKey] = index
      active.chunkSeqs.push(this.session.append('assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-start', index, blockType },
      }).seq)
    }
    active[kind] += text
    active.chunkSeqs.push(this.session.append('assistant/chunk', {
      turn: active.turn,
      step: active.step,
      chunk: { type: deltaType, index, text },
    }).seq)
  }

  ensureToolCall(active, update) {
    const id = update.toolCallId
    if (id === undefined || active.toolNames.has(id)) return
    const name = update.title ?? update.kind ?? 'tool'
    const category = classifyActivityTool(update)
    const args = update.rawInput ?? {}
    const standalone = category === 'edit'
    const descriptor = { name, category, args, standalone }
    active.toolNames.set(id, descriptor)
    this.openActivity(active)
    active.activity.counts[category] += 1
    if (standalone) {
      this.session.append('tool/call', {
        turn: active.turn,
        step: active.step,
        callId: CallId(id),
        name,
        arguments: JSON.stringify(args),
      })
      return
    }
    this.session.append('tool/code-dispatch-start', {
      rootCallId: CallId(active.activity.callId),
      parentCallId: CallId(active.activity.callId),
      subCallId: CallId(id),
      name,
      arguments: args,
    })
  }

  appendToolResult(active, wireId, text, isError, diffs) {
    const descriptor = active.toolNames.get(wireId)
    if (descriptor === undefined) return
    active.toolNames.delete(wireId)
    if (isError) active.activity.failed += 1
    if (!descriptor.standalone) {
      this.session.append('tool/code-dispatch', {
        rootCallId: CallId(active.activity.callId),
        parentCallId: CallId(active.activity.callId),
        subCallId: CallId(wireId),
        name: descriptor.name,
        arguments: descriptor.args,
        isError,
        content: text.length === 0 ? [] : [{ type: 'text', text }],
      })
      if (diffs.length > 0) {
        const diffCallId = `${wireId}:diff`
        this.session.append('tool/call', {
          turn: active.turn,
          step: active.step,
          callId: CallId(diffCallId),
          name: 'edit',
          arguments: JSON.stringify({ paths: diffs.map(diff => diff.path) }),
        })
        this.session.append('tool/result', {
          turn: active.turn,
          step: active.step,
          message: createToolResultMessage({
            callId: CallId(diffCallId),
            content: [],
            isError: false,
          }),
          meta: { diffs },
        }, { surfaceOp: 'append' })
      }
      return
    }
    this.session.append('tool/result', {
      turn: active.turn,
      step: active.step,
      message: createToolResultMessage({
        callId: CallId(wireId),
        content: text.length === 0 ? [] : [{ type: 'text', text }],
        isError,
      }),
      ...(diffs.length === 0 ? {} : { meta: { diffs } }),
    }, { surfaceOp: 'append' })
  }

  openActivity(active) {
    if (active.activity.opened) return
    active.activity.opened = true
    this.session.append('tool/call', {
      turn: active.turn,
      step: active.step,
      callId: CallId(active.activity.callId),
      name: GROK_ACTIVITY_TOOL,
      arguments: '{}',
    })
  }

  closeActivity(active) {
    if (!active.activity.opened || active.activity.closed) return
    active.activity.closed = true
    const meta = activityMeta(active.activity)
    this.session.append('tool/result', {
      turn: active.turn,
      step: active.step,
      message: createToolResultMessage({
        callId: CallId(active.activity.callId),
        content: [{ type: 'text', text: activityFallback(meta) }],
        isError: meta.failed > 0,
      }),
      meta: { grokActivity: meta },
    }, { surfaceOp: 'append' })
  }
}

export class GrokAgentFactory {
  constructor(ctx, config, host) {
    this.ctx = ctx
    this.config = config
    this.host = host
    this.handles = new Set()
  }

  async createAgent(ownerCtx, options) {
    const opened = await this.host.openSession(String(options.sessionId), options.meta?.cwd)
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      meta: options.meta,
    }))
    try {
      return await this.finish(ownerCtx, preparation, options.agentOptions ?? {}, options.setup, opened, 'startup')
    } catch (error) {
      await this.host.closeSession(String(options.sessionId), opened.remoteSessionId)
      throw error
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  async resume(ownerCtx, options) {
    const preparation = await this.ctx.sessionPersistence.prepare(options.resumeSessionId, options.signal)
    try {
      const opened = await this.host.openSession(
        String(options.resumeSessionId),
        preparation.session.header.cwd,
        this.host.mapping.get(String(options.resumeSessionId)),
      )
      try {
        return await this.finish(ownerCtx, preparation, options.agentOptions ?? {}, options.setup, opened, 'resume')
      } catch (error) {
        await this.host.closeSession(String(options.resumeSessionId), opened.remoteSessionId)
        throw error
      }
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  async finish(ownerCtx, preparation, agentOptions, setup, opened, source) {
    // Keep the DSH provider/model on Agent.options. The Web composer blocks
    // input when session.models reports the current provider as unroutable;
    // Grok Build is not a DSH LLM adapter, so labeling the agent as
    // grok-build makes the textarea read-only. Grok's own model lives on the
    // ACP session and the composer harness control.
    const agent = new GrokWebAgent(this.ctx, preparation.session.id, {
      ...agentOptions,
    }, preparation.session)
    agent.grokModel = this.host.currentModelId ?? DEFAULT_GROK_MODEL
    this.host.bindAgent(opened.remoteSessionId, agent)
    const commit = await setup?.(agent.ctx)
    commit?.commit()
    if (this.ctx.agentPresets.composedPreset(agent.ctx) !== GROK_PRESET_ID) {
      await this.ctx.agentPresets.mount(agent.ctx, GROK_PRESET_ID)
    }
    registerGrokCommands(agent, this.host.commands)
    let detachSession
    let detachAgent
    let disposing
    let unfollowOwner = () => {}
    const localId = String(agent.id)
    const dispose = (ownerTriggered = false) => (disposing ??= (async () => {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
      await this.host.closeSession(localId, opened.remoteSessionId)
      await agent.scope.dispose()
      detachAgent?.()
      detachSession?.()
      this.handles.delete(dispose)
      if (!ownerTriggered) await unfollowOwner()
    })())
    this.handles.add(dispose)
    try {
      unfollowOwner = ownerCtx.effect(
        () => () => disposing === undefined ? dispose(true) : undefined,
        `grok-acp.lifecycle(${agent.id})`,
      )
      detachSession = agent.ctx.sessions.enter(agent.session)
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(agent.session)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      this.ctx.commands?.notifyChange?.()
      return { agent, dispose: () => dispose() }
    } catch (error) {
      await dispose()
      throw error
    }
  }

  async dispose() {
    await Promise.all([...this.handles].map(dispose => dispose()))
  }
}

function registerGrokCommands(agent, extra = []) {
  const commands = agent.ctx.commands
  if (commands === undefined) return
  for (const command of [...WEB_COMMANDS, ...extra]) {
    if (typeof command?.name !== 'string' || CLIENT_OWNED_COMMANDS.has(command.name)) continue
    try {
      commands.register({
        name: command.name,
        description: command.description || command.name,
        ...(command.input?.hint ? { input: { hint: command.input.hint } } : {}),
        handler: invocation => invocation.agent.runWebCommand(command.name, invocation.rawInput),
      })
    } catch {
      // A standing grok-build mount may already own the name on a parent layer.
    }
  }
}
