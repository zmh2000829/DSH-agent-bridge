import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLIENT_OWNED_COMMANDS } from '../lib/preset-marker.js'
import { modelCommandOptions, modelCommandSelection } from '../src/client/model-command.ts'

const grok = {
  harness: 'grok-build',
  grok: {
    model: 'grok-4.6',
    models: [
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-code', name: 'Grok Code' },
    ],
  },
}

const dsh = {
  current: { provider: 'deepseek', model: 'deepseek-v4' },
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4', name: 'DeepSeek V4' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: { defaultEffort: 'high' } },
    ],
  }],
}

describe('Harness-aware model commands', () => {
  it('keeps both model command names on the client', () => {
    assert.equal(CLIENT_OWNED_COMMANDS.has('model'), true)
    assert.equal(CLIENT_OWNED_COMMANDS.has('models'), true)
  })

  it('shows only Grok models in a Grok session', () => {
    const options = modelCommandOptions(grok, dsh)
    assert.deepEqual(options.map(option => option.label), ['Grok 4.6', 'Grok Code'])
    assert.equal(modelCommandSelection(options[1].id, grok, dsh)?.kind, 'grok')
    assert.equal(modelCommandSelection(options[1].id, grok, dsh)?.modelId, 'grok-code')
  })

  it('shows only DSH models in a DSH session', () => {
    const state = { ...grok, harness: 'dsh' }
    const options = modelCommandOptions(state, dsh)
    assert.deepEqual(options.map(option => option.label), ['DeepSeek V4', 'DeepSeek V4 Pro'])
    assert.deepEqual(modelCommandSelection(options[1].id, state, dsh), {
      kind: 'dsh',
      selection: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    })
  })

  it('rejects a stale option after the Harness changes', () => {
    const grokOption = modelCommandOptions(grok, undefined)[0]
    assert.equal(modelCommandSelection(grokOption.id, { ...grok, harness: 'dsh' }, dsh), undefined)
  })
})
