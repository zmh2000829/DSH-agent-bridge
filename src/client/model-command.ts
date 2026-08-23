/** Pure model-command projection shared by the DSH and Grok command entries. */

export interface ModelCommandOption {
  id: string
  label: string
  detail?: string
  active?: boolean
}

export interface GrokModelCommandState {
  harness: 'dsh' | 'grok-build'
  grok: {
    model: string
    models: readonly { id: string; name: string }[]
  }
}

export interface DshModelCommandState {
  current: { provider: string; model: string; reasoningEffort?: string } | null
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      description?: string
      reasoning?: { defaultEffort?: string }
    }[]
  }[]
  failures?: readonly { id: string; name: string; message: string }[]
}

export type ModelCommandSelection =
  | { kind: 'grok'; modelId: string }
  | { kind: 'dsh'; selection: { provider: string; model: string; reasoningEffort?: string } }

function grokOptionId(modelId: string): string {
  return `grok:${modelId}`
}

function dshOptionId(providerId: string, modelId: string): string {
  return `dsh:${JSON.stringify([providerId, modelId])}`
}

/** Build the rows for the active Harness without mixing the other Harness's catalog. */
export function modelCommandOptions(
  state: GrokModelCommandState,
  dsh: DshModelCommandState | undefined,
): ModelCommandOption[] {
  if (state.harness === 'grok-build') {
    return state.grok.models.map(model => ({
      id: grokOptionId(model.id),
      label: model.name,
      detail: 'Grok Build',
      ...(model.id === state.grok.model ? { active: true } : {}),
    }))
  }
  if (dsh === undefined) return []
  const rows = dsh.groups.flatMap(group => group.models.map(model => ({
    id: dshOptionId(group.id, model.id),
    label: model.name,
    detail: model.description === undefined ? group.name : `${group.name} · ${model.description}`,
    ...(dsh.current?.provider === group.id && dsh.current.model === model.id ? { active: true } : {}),
  })))
  for (const failure of dsh.failures ?? []) {
    rows.push({ id: `failure:${failure.id}`, label: failure.name, detail: failure.message })
  }
  return rows
}

/** Resolve an option against a fresh Harness snapshot so stale cross-Harness picks fail closed. */
export function modelCommandSelection(
  optionId: string,
  state: GrokModelCommandState,
  dsh: DshModelCommandState | undefined,
): ModelCommandSelection | undefined {
  if (state.harness === 'grok-build') {
    const model = state.grok.models.find(candidate => grokOptionId(candidate.id) === optionId)
    return model === undefined ? undefined : { kind: 'grok', modelId: model.id }
  }
  if (dsh === undefined) return undefined
  for (const group of dsh.groups) {
    for (const model of group.models) {
      if (dshOptionId(group.id, model.id) !== optionId) continue
      const sameRoute = dsh.current?.provider === group.id && dsh.current.model === model.id
      const reasoningEffort = sameRoute
        ? dsh.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        kind: 'dsh',
        selection: {
          provider: group.id,
          model: model.id,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
      }
    }
  }
  return undefined
}
