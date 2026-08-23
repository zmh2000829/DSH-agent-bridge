import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  permissionOutcome,
  renderPlan,
  renderToolOutput,
  sessionBlank,
  toAcpPrompt,
} from '../lib/render.js'
import { isGrokPreset } from '../lib/constants.js'

describe('toAcpPrompt', () => {
  it('keeps text and flattens images', () => {
    assert.deepEqual(
      toAcpPrompt([
        { type: 'text', text: 'hello' },
        { type: 'image', attachment: { id: '1' } },
        { type: 'reasoning', text: 'secret' },
      ]),
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '[image attached]' },
      ],
    )
  })
})

describe('permissionOutcome', () => {
  const options = [
    { optionId: 'allow-1', kind: 'allow_once' },
    { optionId: 'deny-1', kind: 'reject_once' },
  ]

  it('maps DSH allow to allow_once', () => {
    assert.deepEqual(permissionOutcome('allowed-once', options), {
      outcome: { outcome: 'selected', optionId: 'allow-1' },
    })
  })

  it('maps DSH reject to reject_once instead of cancelling', () => {
    assert.deepEqual(permissionOutcome('rejected', options), {
      outcome: { outcome: 'selected', optionId: 'deny-1' },
    })
  })

  it('cancels when the user dismisses the prompt', () => {
    assert.deepEqual(permissionOutcome('cancelled', options), {
      outcome: { outcome: 'cancelled' },
    })
  })
})

describe('renderToolOutput', () => {
  it('collects diffs and text', () => {
    const rendered = renderToolOutput({
      content: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: 'a.txt', oldText: 'a', newText: 'b' },
      ],
    })
    assert.equal(rendered.text.includes('ok'), true)
    assert.equal(rendered.diffs[0].path, 'a.txt')
  })
})

describe('renderPlan', () => {
  it('formats entries', () => {
    assert.equal(
      renderPlan({ entries: [{ status: 'completed', content: 'one' }] }),
      '- [completed] one',
    )
  })
})

describe('session helpers', () => {
  it('treats only grok-build as the Grok harness', () => {
    assert.equal(isGrokPreset('grok-build'), true)
    assert.equal(isGrokPreset('standard'), false)
  })

  it('treats a session without turns as blank', () => {
    assert.equal(sessionBlank({ events: [] }), true)
    assert.equal(sessionBlank({ events: [{ type: 'turn/start' }] }), false)
  })
})
