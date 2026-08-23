/** Per-session DSH model directory used by the Harness-aware model surfaces. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { DshModelCommandState } from './model-command.js'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface ModelDirectoryState extends DshModelCommandState {
  routable: boolean | null
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

interface SessionModels extends DshModelCommandState {
  current: ModelSelection
  routable: boolean
  failures: readonly { id: string; name: string; message: string }[]
}

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

interface ModelSessionsApi {
  models: (request: { sessionId: SessionIdOf }) => Promise<{ result: RpcResult<SessionModels> }>
  selectModel: (request: ModelSelection & { sessionId: SessionIdOf }) => Promise<{
    result: RpcResult<{ selected: ModelSelection }>
  }>
}

interface SnapshotStore<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  update: (mutate: (draft: T) => void) => void
}

function createSnapshotStore<T extends object>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: (mutate) => {
      const next = { ...snapshot }
      mutate(next)
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/** One session's DSH model catalog and selected route. */
export class ModelDirectory {
  readonly store = createSnapshotStore<ModelDirectoryState>({
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle',
    error: null,
  })

  private generation = 0
  private disposed = false

  constructor(
    private readonly sessions: ModelSessionsApi,
    private readonly sessionId: SessionIdOf,
    private readonly available: () => boolean,
  ) {}

  async load(): Promise<SessionModels> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    const { result } = await this.sessions.models({ sessionId: this.sessionId })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    if (!result.ok) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = `${result.error.code}: ${result.error.message}`
      })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.store.update((state) => {
      state.current = current
      state.routable = routable
      state.groups = groups
      state.failures = failures
      state.status = 'ready'
      state.error = null
    })
    return result.value
  }

  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'selecting'; state.error = null })
    const { result } = await this.sessions.selectModel({ sessionId: this.sessionId, ...selection })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = `${result.error.code}: ${result.error.message}`
      })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    this.store.update((state) => {
      state.current = result.value.selected
      state.routable = true
      state.status = 'ready'
      state.error = null
    })
  }

  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      state.current = null
      state.routable = null
      state.groups = []
      state.failures = []
      state.status = 'idle'
      state.error = null
    })
    if (this.available()) this.load().catch(() => undefined)
  }

  dispose(): void {
    this.disposed = true
  }

  private assertAvailable(): void {
    if (!this.available()) throw new Error('model selection is unavailable for addressed subagent sessions')
  }
}

interface SessionRuntimeFace {
  scope: (sessionId: SessionIdOf) => Context | undefined
  subagentAddress: (sessionId: SessionIdOf) => unknown
}

interface ConnectionFace {
  api: { sessions: ModelSessionsApi }
}

interface ConversationFace {
  blocks: { set: (sessionId: SessionIdOf, block: { reason: string } | undefined) => void }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Owns one DSH model directory for each live client session. */
export class ModelDirectoryResolver extends Service {
  static inject = ['connection', 'sessions', 'remote']

  private readonly directories = new Map<SessionIdOf, ModelDirectory>()

  constructor(ctx: Context, private readonly config: { blockReason: () => string }) {
    super(ctx, 'modelDirectories')
    ctx.on('connection/reset', () => {
      for (const directory of this.directories.values()) directory.resetConnected()
    })
    const refresh = (): void => {
      for (const directory of this.directories.values()) directory.load().catch(() => undefined)
    }
    ctx.remote.$on('llm/adapters-updated', refresh)
    ctx.remote.$on('settings/document-updated', refresh)
  }

  directoryFor(sessionId: SessionIdOf): ModelDirectory {
    const existing = this.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions = this.ctx.get('sessions') as SessionRuntimeFace
    const sessionScope = sessions.scope(sessionId)
    if (sessionScope === undefined) {
      throw new Error(`dsh-grok-acp: session "${String(sessionId)}" resolved no client scope`)
    }
    const connection = this.ctx.get('connection') as ConnectionFace
    const directory = new ModelDirectory(
      connection.api.sessions,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
    )
    this.directories.set(sessionId, directory)
    const conversation = this.ctx.get('conversation') as ConversationFace | undefined
    if (conversation !== undefined) {
      const publish = (): void => {
        conversation.blocks.set(
          sessionId,
          directory.store.getSnapshot().routable === false ? { reason: this.config.blockReason() } : undefined,
        )
      }
      publish()
      sessionScope.effect(() => {
        const stop = directory.store.subscribe(publish)
        return () => {
          stop()
          conversation.blocks.set(sessionId, undefined)
        }
      }, 'dsh-grok-acp model composer block')
    }
    sessionScope.effect(() => () => {
      directory.dispose()
      this.directories.delete(sessionId)
    }, 'dsh-grok-acp model directory')
    return directory
  }
}
