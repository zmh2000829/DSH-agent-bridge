/** One shared Grok ACP stdio process serving every Grok-backed DSH session. */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { SessionMapping } from './mapping.js'
import { permissionOutcome } from './render.js'
import { DEFAULT_GROK_MODEL } from './constants.js'
import { importFromDsh } from './dsh.js'
import { resolveWorkspacePath } from './workspace-path.js'

const { CallId } = await importFromDsh('@deepseek-ai/dsh-llm')

export function grokChildEnv(extra = {}) {
  const home = process.env.HOME || homedir()
  const path = [`${home}/.grok/bin`, process.env.PATH].filter(Boolean).join(':')
  return {
    HOME: home,
    USER: process.env.USER,
    PATH: path,
    LANG: process.env.LANG,
    TERM: 'dumb',
    ...(process.env.XAI_API_KEY ? { XAI_API_KEY: process.env.XAI_API_KEY } : {}),
    ...extra,
  }
}

class AcpProcess {
  constructor(child, makeClient, disposeGraceMs) {
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('dsh-grok-acp: subprocess dropped a piped ACP stream')
    }
    this.child = child
    this.disposeGraceMs = disposeGraceMs
    this.disposal = undefined
    this.conn = new ClientSideConnection(
      makeClient,
      ndJsonStream(
        NodeWritable.toWeb(child.stdin),
        NodeReadable.toWeb(child.stdout),
      ),
    )
  }

  dispose() {
    return (this.disposal ??= (async () => {
      this.child.stdin?.end()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.disposeGraceMs)
      try {
        if (await this.child.waitForExit(controller.signal)) return
      } finally {
        clearTimeout(timer)
      }
      this.child.terminate()
      await this.child.waitForExit()
    })())
  }
}

export class AcpHost {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.mapping = new SessionMapping(config.stateFile)
    this.process = undefined
    this.starting = undefined
    this.agents = new Map()
    this.capabilities = undefined
    this.models = []
    this.currentModelId = DEFAULT_GROK_MODEL
    this.commands = []
    this.idleTimer = undefined
    this.generation = 0
    this.reconnections = new WeakMap()
  }

  bindAgent(remoteSessionId, agent) {
    for (const [boundId, boundAgent] of this.agents) {
      if (boundAgent === agent) this.agents.delete(boundId)
    }
    this.agents.set(remoteSessionId, agent)
    agent.attachHost(this, remoteSessionId, this.generation)
  }

  unbindAgent(remoteSessionId) {
    this.agents.delete(remoteSessionId)
    if (this.agents.size === 0) this.scheduleIdleDispose()
  }

  async ensureProcess() {
    if (this.process !== undefined) return this.process
    if (this.starting !== undefined) return this.starting
    this.starting = this.startProcess().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async startProcess() {
    this.clearIdleDispose()
    const child = this.ctx.subprocess.spawn({
      argv: [this.config.command, ...this.config.args],
      cwd: process.cwd(),
      env: grokChildEnv(this.config.env),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: this.config.disposeGraceMs,
    })
    const processHandle = new AcpProcess(child, () => ({
      sessionUpdate: params => this.handleUpdate(params),
      requestPermission: params => this.requestPermission(params),
      readTextFile: params => this.readTextFile(params),
      writeTextFile: params => this.writeTextFile(params),
      extMethod: (method, params) => this.handleExt(method, params, false),
      extNotification: (method, params) => this.handleExt(method, params, true),
    }), this.config.disposeGraceMs)
    try {
      const initialized = await processHandle.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'dsh-grok-acp', version: '0.2.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      })
      this.capabilities = initialized.agentCapabilities
      this.ingestInitialize(initialized)
      const methods = initialized.authMethods ?? []
      const cached = methods.find(method => method.id === 'cached_token') ?? methods[0]
      if (cached !== undefined) {
        try {
          await processHandle.conn.authenticate({ methodId: cached.id })
        } catch (error) {
          this.ctx.logger.warn(`dsh-grok-acp: authenticate(${cached.id}) failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      this.generation += 1
      this.process = processHandle
      child.done.catch(() => {}).finally(() => {
        if (this.process !== processHandle) return
        this.process = undefined
        this.capabilities = undefined
      })
      return processHandle
    } catch (error) {
      await processHandle.dispose()
      throw error
    }
  }

  ingestInitialize(initialized) {
    const meta = initialized._meta ?? {}
    const modelState = meta.modelState ?? {}
    if (typeof modelState.currentModelId === 'string') this.currentModelId = modelState.currentModelId
    if (Array.isArray(modelState.availableModels)) this.models = modelState.availableModels
    if (Array.isArray(meta.availableCommands)) this.commands = meta.availableCommands
  }

  async openSession(localId, cwd, resumeId) {
    if (cwd === undefined || !isAbsolute(cwd)) throw new Error('Grok Build requires an absolute session cwd')
    const processHandle = await this.ensureProcess()
    const mapped = resumeId ?? this.mapping.get(localId)
    const capabilities = this.capabilities ?? {}
    const sessionCaps = capabilities.sessionCapabilities ?? {}
    let remoteSessionId
    let session
    if (mapped !== undefined && sessionCaps.resume !== undefined) {
      try {
        session = await processHandle.conn.resumeSession({ sessionId: mapped, cwd, mcpServers: [] })
        remoteSessionId = mapped
      } catch (error) {
        this.ctx.logger.warn(`dsh-grok-acp: resume ${mapped} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (remoteSessionId === undefined && mapped !== undefined && capabilities.loadSession) {
      try {
        session = await processHandle.conn.loadSession({ sessionId: mapped, cwd, mcpServers: [] })
        remoteSessionId = mapped
      } catch (error) {
        this.ctx.logger.warn(`dsh-grok-acp: load ${mapped} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (remoteSessionId === undefined) {
      session = await processHandle.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: this.config.yoloMode ? { yoloMode: true } : {},
      })
      remoteSessionId = session.sessionId
    }
    this.mapping.set(localId, remoteSessionId)
    this.ingestSession(session)
    this.clearIdleDispose()
    return { processHandle, remoteSessionId, session }
  }

  async ensureAgentSession(agent) {
    if (
      this.process !== undefined
      && agent.hostGeneration === this.generation
      && typeof agent.remoteSessionId === 'string'
    ) {
      return agent.remoteSessionId
    }
    const pending = this.reconnections.get(agent)
    if (pending !== undefined) return pending
    const reconnecting = this.reconnectAgent(agent).finally(() => {
      this.reconnections.delete(agent)
    })
    this.reconnections.set(agent, reconnecting)
    return reconnecting
  }

  async reconnectAgent(agent) {
    const localId = String(agent.id)
    const opened = await this.openSession(localId, agent.session.header.cwd, this.mapping.get(localId))
    this.bindAgent(opened.remoteSessionId, agent)
    return opened.remoteSessionId
  }

  ingestSession(session) {
    if (session === undefined || session === null) return
    if (typeof session.models?.currentModelId === 'string') this.currentModelId = session.models.currentModelId
    if (Array.isArray(session.models?.availableModels)) this.models = session.models.availableModels
    const options = session._meta?.['x.ai/sessionConfig']?.options
    if (Array.isArray(options)) {
      const selectedModel = options.find(option => option.category === 'model' && option.selected)
      if (typeof selectedModel?.id === 'string') this.currentModelId = selectedModel.id
    }
  }

  async closeSession(localId, remoteSessionId) {
    this.unbindAgent(remoteSessionId)
    const conn = this.process?.conn
    if (conn === undefined || remoteSessionId === undefined) return
    try {
      if (this.capabilities?.sessionCapabilities?.close !== undefined) {
        await conn.closeSession({ sessionId: remoteSessionId })
      }
    } catch {
      // The child may already be gone.
    }
  }

  handleUpdate(params) {
    this.applyGlobalUpdate(params)
    const agent = this.agents.get(params.sessionId)
    return agent?.handleUpdate(params) ?? Promise.resolve()
  }

  applyGlobalUpdate(params) {
    const update = params.update
    if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.commands = update.availableCommands
    }
    if (update?.sessionUpdate === 'model_changed' && typeof update.currentModelId === 'string') {
      this.currentModelId = update.currentModelId
    }
  }

  async handleExt(method, params, notification) {
    const modelId = params?.currentModelId ?? params?.modelId
    if (typeof modelId === 'string' && method.includes('models')) this.currentModelId = modelId
    if (Array.isArray(params?.availableModels)) this.models = params.availableModels
    if (Array.isArray(params?.availableCommands)) this.commands = params.availableCommands
    if (typeof params?.sessionId === 'string') {
      const agent = this.agents.get(params.sessionId)
      agent?.handleExt?.(method, params)
    }
    return notification ? undefined : {}
  }

  async requestPermission(params) {
    const agent = this.agents.get(params.sessionId)
    if (agent === undefined) return { outcome: { outcome: 'cancelled' } }
    try {
      const outcome = await this.ctx.approval.request({
        agent,
        toolName: params.toolCall?.title || 'Grok Build',
        callId: CallId(params.toolCall?.toolCallId ?? 'grok-permission'),
      })
      return permissionOutcome(outcome, params.options)
    } catch (error) {
      this.ctx.logger.warn(`dsh-grok-acp: permission prompt failed: ${error instanceof Error ? error.message : String(error)}`)
      return { outcome: { outcome: 'cancelled' } }
    }
  }

  async readTextFile(params) {
    const path = await this.resolveFilePath(params.path, params.sessionId, 'read')
    const content = await readFile(path, 'utf8')
    if (params.line === undefined && params.limit === undefined) return { content }
    const lines = content.split('\n')
    const start = Math.max((params.line ?? 1) - 1, 0)
    const slice = params.limit === undefined ? lines.slice(start) : lines.slice(start, start + params.limit)
    return { content: slice.join('\n') }
  }

  async writeTextFile(params) {
    const path = await this.resolveFilePath(params.path, params.sessionId, 'write')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, params.content ?? '', 'utf8')
    return {}
  }

  async resolveFilePath(path, sessionId, operation) {
    const cwd = this.agents.get(sessionId)?.session?.header?.cwd
    return resolveWorkspacePath(path, cwd, operation, this.config.allowOutsideWorkspace)
  }

  async setConfigOption(remoteSessionId, configId, value) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    return conn.setSessionConfigOption({ sessionId: remoteSessionId, configId, value })
  }

  extMethod(method, params) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    return conn.extMethod(method, params)
  }

  prompt(params) {
    const conn = this.process?.conn
    if (conn === undefined) throw new Error('Grok ACP is not running')
    return conn.prompt(params)
  }

  cancel(params) {
    const conn = this.process?.conn
    if (conn === undefined) return Promise.resolve()
    return conn.cancel(params).catch(() => {})
  }

  scheduleIdleDispose() {
    this.clearIdleDispose()
    const idleMs = this.config.idleDisposeMs
    if (!idleMs || idleMs <= 0) return
    this.idleTimer = setTimeout(() => {
      if (this.agents.size === 0) void this.disposeProcess()
    }, idleMs)
  }

  clearIdleDispose() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  async disposeProcess() {
    const processHandle = this.process
    this.process = undefined
    this.capabilities = undefined
    if (processHandle !== undefined) await processHandle.dispose()
  }

  async dispose() {
    this.clearIdleDispose()
    this.agents.clear()
    await this.disposeProcess()
  }
}
