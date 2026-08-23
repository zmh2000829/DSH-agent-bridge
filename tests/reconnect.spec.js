import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpHost } from '../lib/acp-connection.js'

async function withHost(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-reconnect-'))
  const host = new AcpHost({}, {
    stateFile: join(root, 'sessions.json'),
    allowOutsideWorkspace: false,
  })
  try {
    await run(host)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function agent(generation) {
  return {
    id: 'local-1',
    hostGeneration: generation,
    remoteSessionId: 'remote-old',
    session: { header: { cwd: '/workspace' } },
    attachHost(host, remoteSessionId, nextGeneration) {
      this.host = host
      this.remoteSessionId = remoteSessionId
      this.hostGeneration = nextGeneration
    },
  }
}

describe('AcpHost session recovery', () => {
  it('keeps a session attached to the current process generation', async () => {
    await withHost(async (host) => {
      host.process = {}
      host.generation = 2
      const current = agent(2)
      assert.equal(await host.ensureAgentSession(current), 'remote-old')
    })
  })

  it('coalesces concurrent reconnects after the process changes', async () => {
    await withHost(async (host) => {
      host.process = {}
      host.generation = 2
      const stale = agent(1)
      let opens = 0
      host.openSession = async () => {
        opens += 1
        await Promise.resolve()
        return { remoteSessionId: 'remote-new' }
      }

      assert.deepEqual(
        await Promise.all([host.ensureAgentSession(stale), host.ensureAgentSession(stale)]),
        ['remote-new', 'remote-new'],
      )
      assert.equal(opens, 1)
      assert.equal(stale.remoteSessionId, 'remote-new')
      assert.equal(stale.hostGeneration, 2)
    })
  })
})
