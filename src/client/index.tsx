/** Composer harness switch and Grok / DSH model seat. */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InjectFace, PropsLocale, PropsRuntime, SessionIdOf, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  modelCommandOptions,
  modelCommandSelection,
  type DshModelCommandState,
  type ModelCommandOption,
} from './model-command.js'
import { ModelDirectoryResolver } from './model-directory.js'

const SESSION_PATH = '/grok-acp/session'
const STATUS_EVENT = 'dsh-grok-acp:status'
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const replacingSessions = new Set<string>()
const LOCALE_NS = 'dsh-grok-acp'

const en = {
  unavailable: 'Harness unavailable',
  harnessHint: 'Choose the execution engine for this session',
  harnessLocked: 'The harness cannot change after the session starts',
  presetHint: 'Agent preset for the DSH session about to start',
  presetMenu: 'Agent presets',
  grokModels: 'Grok Build models',
  noGrokModels: 'Grok Build did not report selectable models',
  reasoningEffort: 'Reasoning effort',
  dshModel: 'DSH model',
  chooseModel: 'Choose model',
  modelCommand: 'Select the model for the active Harness',
  modelUnavailable: 'Model selection is unavailable',
  staleModel: 'The model list changed; open the selector again',
  standardName: 'Standard mode',
  standardDescription: 'Full coding agent.',
  codeName: 'PTC mode',
  codeDescription: 'Combines multi-step operations through the Code Mode SDK.',
  minimalName: 'Minimal mode',
  minimalDescription: 'Persistent bash and file editing tools.',
  cordisName: 'Creator mode',
  cordisDescription: 'Creates custom agent presets.',
} as const

const zh: Record<keyof typeof en, string> = {
  unavailable: 'Harness 不可用',
  harnessHint: '选择本会话的执行引擎',
  harnessLocked: '会话开始后不能再切换 Harness',
  presetHint: '选择即将开始的 DSH 会话所用的 Agent 预设',
  presetMenu: 'Agent 预设',
  grokModels: 'Grok Build 模型',
  noGrokModels: 'Grok Build 未报告可选模型',
  reasoningEffort: '推理力度',
  dshModel: 'DSH 模型',
  chooseModel: '选择模型',
  modelCommand: '选择当前 Harness 使用的模型',
  modelUnavailable: '模型选择不可用',
  staleModel: '模型列表已变化，请重新打开选择器',
  standardName: '标准模式',
  standardDescription: '功能完整的编码 Agent。',
  codeName: 'PTC 模式',
  codeDescription: '通过 Code Mode SDK 组合多步操作。',
  minimalName: '极简模式',
  minimalDescription: '提供持久 Bash 和文件编辑工具。',
  cordisName: '创造模式',
  cordisDescription: '用于创建自定义 Agent preset。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Grok Build bridge controls. */
    'dsh-grok-acp': keyof typeof en
  }
}

type Translate = TranslateNS<typeof LOCALE_NS>
type DshPreset = HarnessSnapshot['dshPresets'][number]

const BUILTIN_PRESET_KEYS = {
  standard: ['standardName', 'standardDescription'],
  code: ['codeName', 'codeDescription'],
  minimal: ['minimalName', 'minimalDescription'],
  cordis: ['cordisName', 'cordisDescription'],
} as const

function presetCopy(preset: DshPreset, t: Translate): { name: string; description: string } {
  const keys = BUILTIN_PRESET_KEYS[preset.id as keyof typeof BUILTIN_PRESET_KEYS]
  return keys === undefined
    ? { name: preset.name, description: preset.description }
    : { name: t(keys[0]), description: t(keys[1]) }
}

interface GrokEffort {
  id: string
  label: string
}

interface GrokModel {
  id: string
  name: string
  effort?: string
  efforts: GrokEffort[]
}

interface HarnessSnapshot {
  sessionId: string
  harness: 'dsh' | 'grok-build'
  preset: string
  dshPreset: string
  blank: boolean
  running: boolean
  dshPresets: Array<{ id: string; name: string; description: string }>
  grok: {
    ready: boolean
    model: string
    models: GrokModel[]
    effort?: string
    commands: Array<{ name: string; description: string; hint?: string }>
  }
}

interface SessionListSnapshot {
  current?: string
  byId: Record<string, { id: string; blank: boolean; running?: boolean }>
}

interface SessionListStore {
  subscribe: (fn: () => void) => () => void
  getSnapshot: () => SessionListSnapshot
}

interface HostEnvelope {
  payload: { type: string; sessionId?: string }
}

interface SessionHostRuntime {
  handleHostEnvelope: (envelope: HostEnvelope) => void
}

interface ModelDirectoryFace {
  store: {
    getSnapshot: () => DshModelCommandState
    subscribe: (fn: () => void) => () => void
  }
  load: () => Promise<DshModelCommandState>
  select: (selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>
}

interface ModelDirectoriesFace {
  directoryFor: (sessionId: SessionIdOf) => ModelDirectoryFace
}

interface CommandSession {
  sessionId: SessionIdOf
}

interface CommandUiFace {
  register: (contribution: {
    name: string
    description: string
    available: (session: CommandSession) => boolean
    ui: {
      kind: 'popupSelect'
      options: (session: CommandSession) => Promise<ModelCommandOption[]>
      onSelect: (option: ModelCommandOption, session: CommandSession) => Promise<void>
    }
  }) => () => void
}

const font = 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)'
const wrap: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: font,
}

const group: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 28,
  padding: 2,
  borderRadius: 24,
  background: 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 7%, transparent))',
}

function optionStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    height: 24,
    padding: '0 10px',
    border: 0,
    borderRadius: 20,
    background: active ? 'var(--dsw-alias-bg-elevated, Canvas)' : 'transparent',
    color: 'var(--dsw-alias-label-primary, CanvasText)',
    boxShadow: active ? '0 0 0 1px var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent))' : 'none',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: '24px',
    opacity: disabled && !active ? 0.45 : 1,
  }
}

const trigger: CSSProperties = {
  appearance: 'none',
  height: 28,
  maxWidth: 220,
  padding: '0 8px',
  border: 0,
  borderRadius: 24,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, currentColor)',
  cursor: 'pointer',
  fontFamily: font,
  fontSize: 12,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const menu: CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 'calc(100% + 8px)',
  zIndex: 80,
  minWidth: 220,
  maxHeight: 280,
  overflow: 'auto',
  padding: 6,
  border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 14%, transparent))',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-elevated, Canvas)',
  boxShadow: '0 10px 32px rgba(0,0,0,.18)',
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

function menuItem(active: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'block',
    padding: '8px 10px',
    border: 0,
    borderRadius: 8,
    background: active ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: font,
    fontSize: 13,
  }
}

async function readStatus(sessionId: string): Promise<HarnessSnapshot | undefined> {
  const response = await fetch(`${SESSION_PATH}?sessionId=${encodeURIComponent(sessionId)}`)
  if (!response.ok) return undefined
  return await response.json() as HarnessSnapshot
}

async function writeStatus(payload: Record<string, unknown>): Promise<HarnessSnapshot> {
  const response = await fetch(SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json() as HarnessSnapshot & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  window.dispatchEvent(new CustomEvent<HarnessSnapshot>(STATUS_EVENT, { detail: body }))
  return body
}

function installReplacementFrameFilter(service: unknown): () => void {
  if (typeof service !== 'object' || service === null) return () => undefined
  const serviceRecord = service as Record<PropertyKey, unknown>
  const candidate = serviceRecord[CORDIS_ORIGINAL] ?? service
  if (typeof candidate !== 'object' || candidate === null) return () => undefined
  const runtime = candidate as Partial<SessionHostRuntime>
  const original = runtime.handleHostEnvelope
  if (typeof original !== 'function') return () => undefined
  const filtered = function (this: SessionHostRuntime, envelope: HostEnvelope): void {
    const frame = envelope.payload
    const sessionId = frame.sessionId
    if (sessionId !== undefined && replacingSessions.has(sessionId)) {
      if (frame.type === 'host/session-removed') return
      if (frame.type === 'host/session-added') replacingSessions.delete(sessionId)
    }
    original.call(this, envelope)
  }
  runtime.handleHostEnvelope = filtered
  return () => {
    if (runtime.handleHostEnvelope === filtered) runtime.handleHostEnvelope = original
  }
}

function finishReplacement(sessionId: string): void {
  window.setTimeout(() => { replacingSessions.delete(sessionId) }, 5_000)
}

function useHarness(sessionId: string | undefined, session?: { running?: boolean; blank?: boolean }) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>()
  const [error, setError] = useState<string>()
  const load = async (): Promise<void> => {
    if (sessionId === undefined) return
    try {
      const next = await readStatus(sessionId)
      if (next !== undefined) setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  useEffect(() => { void load() }, [sessionId, session?.running, session?.blank])
  useEffect(() => {
    const update = (event: Event): void => {
      const next = (event as CustomEvent<HarnessSnapshot>).detail
      if (next.sessionId === sessionId) setSnapshot(next)
    }
    window.addEventListener(STATUS_EVENT, update)
    return () => { window.removeEventListener(STATUS_EVENT, update) }
  }, [sessionId])
  return { snapshot, setSnapshot, error, setError, load }
}

interface HarnessPickerInjected {
  clearComposerBlock?: (sessionId: string) => void
}

type HarnessPickerProps = PropsRuntime<'conversation.input.left'>
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<HarnessPickerInjected>

function HarnessPicker({
  sessionId, session, clearComposerBlock, t,
}: HarnessPickerProps) {
  const { snapshot, setSnapshot, error, setError } = useHarness(sessionId, session)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (snapshot?.harness !== 'grok-build') return
    clearComposerBlock?.(sessionId)
  }, [clearComposerBlock, sessionId, snapshot?.harness])

  if (snapshot === undefined) {
    return error ? <span title={error} style={{ opacity: 0.5, fontSize: 12 }}>{t('unavailable')}</span> : null
  }

  const locked = saving || snapshot.running || !snapshot.blank
  const grok = snapshot.harness === 'grok-build'

  const select = async (harness: 'dsh' | 'grok-build'): Promise<void> => {
    if (harness === snapshot.harness || locked) return
    setSaving(true)
    replacingSessions.add(sessionId)
    try {
      setSnapshot(await writeStatus({ sessionId, harness }))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      finishReplacement(sessionId)
      setSaving(false)
    }
  }

  return (
    <div style={wrap} title={locked && !snapshot.blank ? t('harnessLocked') : t('harnessHint')}>
      <div role="group" aria-label="Harness" style={group}>
        <button type="button" aria-pressed={!grok} disabled={locked} style={optionStyle(!grok, locked)} onClick={() => { void select('dsh') }}>
          DSH
        </button>
        <button type="button" aria-pressed={grok} disabled={locked} style={optionStyle(grok, locked)} onClick={() => { void select('grok-build') }}>
          Grok Build
        </button>
      </div>
      {error && <span title={error} style={{ color: '#c94848', fontSize: 12 }}>!</span>}
    </div>
  )
}

interface HeroAgentPresetInjected {
  sessions: SessionListStore
}

type HeroAgentPresetProps = PropsRuntime<'conversation.hero.agentPreset'>
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<HeroAgentPresetInjected>

function HeroAgentPresetSeat({ sessions, t }: HeroAgentPresetProps) {
  const list = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot)
  const sessionId = list.current
  const session = sessionId === undefined ? undefined : list.byId[sessionId]
  const { snapshot, setSnapshot, error, setError } = useHarness(sessionId, session)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (snapshot === undefined || snapshot.harness === 'grok-build') return null
  const current = snapshot.dshPresets.find(preset => preset.id === snapshot.preset)
  const label = current === undefined ? snapshot.preset : presetCopy(current, t).name

  const select = async (preset: string): Promise<void> => {
    if (sessionId === undefined || saving || preset === snapshot.preset) return
    setOpen(false)
    setSaving(true)
    try {
      setSnapshot(await writeStatus({ sessionId, preset }))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={rootRef} style={wrap}>
      <button
        type="button"
        disabled={saving}
        style={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title={error ?? t('presetHint')}
        onClick={() => { setOpen(value => !value) }}
      >
        {label} ⌄
      </button>
      {open && (
        <div role="menu" aria-label={t('presetMenu')} style={{ ...menu, right: 'auto', left: 0, bottom: 'auto', top: 'calc(100% + 8px)' }}>
          {snapshot.dshPresets.map((preset) => {
            const copy = presetCopy(preset, t)
            return (
              <button
                key={preset.id}
                type="button"
                role="menuitem"
                style={menuItem(preset.id === snapshot.preset)}
                onClick={() => { void select(preset.id) }}
              >
                <span style={{ display: 'block', fontWeight: 600 }}>{copy.name}</span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 11, opacity: 0.6 }}>{copy.description}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function GrokModelSeat({
  sessionId, locked, snapshot, onChange, t,
}: {
  sessionId: string
  locked: boolean
  snapshot: HarnessSnapshot
  onChange: (snapshot: HarnessSnapshot) => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const models = snapshot.grok.models
  const current = models.find(model => model.id === snapshot.grok.model) ?? models[0]
  const label = current?.name ?? (snapshot.grok.model === 'unknown' ? 'Grok Build' : snapshot.grok.model)
  const effort = snapshot.grok.effort ?? current?.effort
  const triggerLabel = effort ? `${label} · ${effort}` : label
  const efforts = current?.efforts ?? []

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  const choose = async (payload: Record<string, unknown>): Promise<void> => {
    setOpen(false)
    setSaving(true)
    try {
      onChange(await writeStatus({ sessionId, ...payload }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={rootRef} style={{ ...wrap, justifyContent: 'flex-end' }}>
      <button type="button" disabled={locked || saving} style={trigger} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {triggerLabel}
      </button>
      {open && (
        <div role="listbox" aria-label={t('grokModels')} style={menu}>
          <div style={{ padding: '4px 10px 6px', fontSize: 11, opacity: 0.55 }}>{t('grokModels')}</div>
          {models.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, opacity: 0.6 }}>{t('noGrokModels')}</div>}
          {models.map(model => (
            <button key={model.id} type="button" role="option" aria-selected={model.id === snapshot.grok.model} style={menuItem(model.id === snapshot.grok.model)} onClick={() => { void choose({ modelId: model.id }) }}>
              {model.name}
            </button>
          ))}
          {efforts.length > 0 && <div style={{ padding: '8px 10px 6px', fontSize: 11, opacity: 0.55 }}>{t('reasoningEffort')}</div>}
          {efforts.map(item => (
            <button key={item.id} type="button" role="option" aria-selected={item.id === effort} style={menuItem(item.id === effort)} onClick={() => { void choose({ effort: item.id }) }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DshModelSeat({
  locked, directory, load, select, t,
}: {
  locked: boolean
  directory?: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current: { provider: string; model: string; reasoningEffort?: string } | null; groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } }
  load?: () => void
  select?: (selection: { provider: string; model: string }) => Promise<boolean>
  t: Translate
}) {
  const state = useSyncExternalStore(
    directory === undefined ? () => () => undefined : fn => directory.subscribe(fn),
    () => directory?.getSnapshot() ?? { current: null, groups: [] },
  )
  const [open, setOpen] = useState(false)
  useEffect(() => { load?.() }, [load])
  const current = state.groups.flatMap(group => group.models.map(model => ({ group, model }))).find(row => row.group.id === state.current?.provider && row.model.id === state.current?.model)
  const label = current?.model.name ?? state.current?.model ?? t('chooseModel')
  return (
    <div style={{ ...wrap, justifyContent: 'flex-end' }}>
      <button type="button" disabled={locked} style={trigger} aria-haspopup="listbox" aria-expanded={open} onClick={() => { setOpen(value => !value); load?.() }}>
        {label}
      </button>
      {open && (
        <div role="listbox" aria-label={t('dshModel')} style={menu}>
          {state.groups.flatMap(group => group.models.map(model => (
            <button
              key={`${group.id}/${model.id}`}
              type="button"
              role="option"
              aria-selected={group.id === state.current?.provider && model.id === state.current?.model}
              style={menuItem(group.id === state.current?.provider && model.id === state.current?.model)}
              onClick={() => {
                setOpen(false)
                void select?.({ provider: group.id, model: model.id })
              }}
            >
              <span style={{ display: 'block' }}>{model.name}</span>
              <span style={{ display: 'block', fontSize: 11, opacity: 0.55 }}>{group.name}</span>
            </button>
          )))}
        </div>
      )}
    </div>
  )
}

function ComposerModelSeat(props: {
  sessionId: string
  locked: boolean
  useSession: (select: (state: { running: boolean; blank: boolean }) => unknown) => unknown
  directory?: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current: { provider: string; model: string; reasoningEffort?: string } | null; groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } }
  loadDsh?: () => void
  selectDsh?: (selection: { provider: string; model: string }) => Promise<boolean>
  t: Translate
}) {
  const running = Boolean(props.useSession(state => state.running))
  const blank = Boolean(props.useSession(state => state.blank))
  const { snapshot, setSnapshot } = useHarness(props.sessionId, { running, blank })
  if (snapshot === undefined) return null
  if (snapshot.harness === 'grok-build') {
    return <GrokModelSeat sessionId={props.sessionId} locked={props.locked} snapshot={snapshot} onChange={setSnapshot} t={props.t} />
  }
  return <DshModelSeat locked={props.locked} directory={props.directory} load={props.loadDsh} select={props.selectDsh} t={props.t} />
}

export const inject = ['slots', 'locale', 'commandUi', 'connection', 'sessions', 'remote']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-grok-acp locale dictionaries')
  const t = ctx.locale.bind(LOCALE_NS) as Translate
  ctx.plugin(ModelDirectoryResolver, { blockReason: () => t('modelUnavailable') })
  ctx.inject(['sessions'], (scope: Context) => {
    const sessions = scope.get('sessions')
    scope.effect(() => installReplacementFrameFilter(sessions), 'dsh-grok-acp session replacement frames')
  })

  ctx.slots.inject('conversation.hero.agentPreset', () => {
    const sessions = ctx.get('sessions') as { list: SessionListStore } | undefined
    if (sessions === undefined) return () => undefined
    return ctx.slots.register({
      name: 'conversation.hero.agentPreset',
      priority: -1,
      locale: LOCALE_NS,
      inject: (): HeroAgentPresetInjected => ({ sessions: sessions.list }),
    }, HeroAgentPresetSeat)
  })

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'grok-acp-harness',
    order: 10,
    label: 'Harness',
    locale: LOCALE_NS,
    inject: (): HarnessPickerInjected => ({
      clearComposerBlock(id: string) {
        const conversation = ctx.get('conversation') as { blocks: { set: (sessionId: string, block: undefined) => void } } | undefined
        conversation?.blocks.set(id, undefined)
      },
    }),
  }, HarnessPicker))

  ctx.inject(['modelDirectories'], (scope: Context) => {
    const models = (scope as Context & {
      modelDirectories: {
        directoryFor: (id: string) => {
          store: { subscribe: (fn: () => void) => () => void; getSnapshot: () => { current: { provider: string; model: string } | null; groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> } }
          load: () => Promise<unknown>
          select: (selection: { provider: string; model: string }) => Promise<unknown>
        }
      }
    }).modelDirectories
    scope.slots.inject('conversation.input.model', () => {
      try {
        return scope.slots.register({
          name: 'conversation.input.model',
          // Lowest priority wins a single seat. ui-model-selection occupies 0.
          priority: -1,
          inject: (sessionId: string) => {
            const directory = models.directoryFor(sessionId)
            return {
              directory: directory.store,
              loadDsh: () => { directory.load().catch(() => undefined) },
              selectDsh: (selection: { provider: string; model: string }) => directory.select(selection).then(() => true, () => false),
              t,
            }
          },
        }, ComposerModelSeat)
      } catch (error) {
        console.error('dsh-grok-acp: conversation.input.model already occupied', error)
        return () => undefined
      }
    })
  })

  ctx.inject(['commandUi', 'modelDirectories', 'sessions'], (scope: Context) => {
    const command = scope.get('commandUi') as CommandUiFace
    const models = scope.get('modelDirectories') as ModelDirectoriesFace
    const sessions = scope.get('sessions') as { subagentAddress: (sessionId: SessionIdOf) => unknown }
    const contribution = (name: 'model' | 'models') => ({
      name,
      description: t('modelCommand'),
      available: (session: CommandSession) => sessions.subagentAddress(session.sessionId) === undefined,
      ui: {
        kind: 'popupSelect' as const,
        options: async (session: CommandSession): Promise<ModelCommandOption[]> => {
          const snapshot = await readStatus(session.sessionId)
          if (snapshot === undefined) throw new Error(t('unavailable'))
          const dsh = snapshot.harness === 'dsh'
            ? await models.directoryFor(session.sessionId).load()
            : undefined
          return modelCommandOptions(snapshot, dsh)
        },
        onSelect: async (option: ModelCommandOption, session: CommandSession): Promise<void> => {
          const snapshot = await readStatus(session.sessionId)
          if (snapshot === undefined) throw new Error(t('unavailable'))
          const directory = snapshot.harness === 'dsh' ? models.directoryFor(session.sessionId) : undefined
          const selection = modelCommandSelection(option.id, snapshot, directory?.store.getSnapshot())
          if (selection === undefined) throw new Error(t('staleModel'))
          if (selection.kind === 'grok') {
            await writeStatus({ sessionId: session.sessionId, modelId: selection.modelId })
          } else {
            await directory?.select(selection.selection)
          }
        },
      },
    })
    scope.effect(() => command.register(contribution('model')), 'dsh-grok-acp /model contribution')
    scope.effect(() => command.register(contribution('models')), 'dsh-grok-acp /models contribution')
  })
}
