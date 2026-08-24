import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  permissionOutcome,
  planTodos,
  renderToolOutput,
  sessionBlank,
  toAcpPrompt,
} from '../lib/render.js'
import { isGrokPreset } from '../lib/constants.js'
import {
  activityMeta,
  classifyActivityTool,
  createActivityState,
} from '../lib/activity.js'
import { GrokWebAgent } from '../lib/grok-agent.js'

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

describe('planTodos', () => {
  it('projects a whole ACP plan into the native DSH todo list', () => {
    assert.deepEqual(
      planTodos({ entries: [
        { status: 'completed', content: ' Read the docs ' },
        { status: 'in_progress', title: 'Run checks' },
        { status: 'unknown', content: 'Package app' },
        { status: 'pending', content: 'Package app' },
        { status: 'pending', content: '   ' },
      ] }),
      [
        { status: 'completed', content: 'Read the docs' },
        { status: 'in_progress', content: 'Run checks' },
        { status: 'pending', content: 'Package app' },
      ],
    )
  })

  it('keeps an empty plan as an explicit empty todo snapshot', () => {
    assert.deepEqual(planTodos({ entries: [] }), [])
  })
})

describe('GrokWebAgent plan projection', () => {
  it('logs the plan for the native todo panel without adding answer text', async () => {
    const events = []
    const agent = Object.create(GrokWebAgent.prototype)
    Object.assign(agent, {
      remoteSessionId: 'remote-1',
      active: {},
      session: {
        append(type, data) {
          events.push({ type, data })
          return { seq: events.length }
        },
      },
    })

    await agent.handleUpdate({
      sessionId: 'remote-1',
      update: {
        sessionUpdate: 'plan',
        entries: [
          { status: 'in_progress', content: 'Run checks' },
          { status: 'pending', content: 'Package app' },
        ],
      },
    })

    assert.deepEqual(events, [{
      type: 'todo/write',
      data: {
        todos: [
          { status: 'in_progress', content: 'Run checks' },
          { status: 'pending', content: 'Package app' },
        ],
      },
    }])
  })
})

describe('Grok activity groups', () => {
  it('classifies routine calls while keeping file mutations standalone', () => {
    assert.equal(classifyActivityTool({ kind: 'read', title: 'read_file · README.md' }), 'read')
    assert.equal(classifyActivityTool({ kind: 'execute', title: 'run_terminal_command · npm test' }), 'command')
    assert.equal(classifyActivityTool({ kind: 'search', title: 'grep · tool_call' }), 'search')
    assert.equal(classifyActivityTool({ kind: 'edit', title: 'apply_patch · README.md' }), 'edit')
  })

  it('logs routine calls as children and summarizes the whole turn', () => {
    const events = []
    const agent = Object.create(GrokWebAgent.prototype)
    agent.session = {
      append(type, data, options) {
        events.push({ type, data, options })
        return { seq: events.length }
      },
    }
    const active = {
      turn: 2,
      step: 1,
      toolNames: new Map(),
      activity: createActivityState(2, 1),
    }

    agent.ensureToolCall(active, {
      toolCallId: 'read-1', kind: 'read', title: 'read_file · README.md', rawInput: { path: 'README.md' },
    })
    agent.appendToolResult(active, 'read-1', 'contents', false, [])
    agent.ensureToolCall(active, {
      toolCallId: 'edit-1', kind: 'edit', title: 'apply_patch · README.md', rawInput: { path: 'README.md' },
    })
    agent.appendToolResult(active, 'edit-1', 'done', false, [{ path: 'README.md', oldText: 'a', newText: 'b' }])
    agent.closeActivity(active)

    assert.deepEqual(events.map(event => event.type), [
      'tool/call',
      'tool/code-dispatch-start',
      'tool/code-dispatch',
      'tool/call',
      'tool/result',
      'tool/result',
    ])
    assert.equal(events[0].data.name, 'grok_build_activity')
    assert.equal(events[1].data.rootCallId, 'grok-activity:2:1')
    assert.equal(events[3].data.name, 'apply_patch · README.md')
    assert.deepEqual(events[5].data.meta.grokActivity, {
      total: 2,
      failed: 0,
      counts: { read: 1, command: 0, search: 0, edit: 1, other: 0 },
    })
  })

  it('marks the group failed so the collapsed row cannot hide errors', () => {
    const activity = createActivityState(1, 1)
    activity.counts.command = 1
    activity.failed = 1
    assert.deepEqual(activityMeta(activity), {
      total: 1,
      failed: 1,
      counts: { read: 0, command: 1, search: 0, edit: 0, other: 0 },
    })
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
